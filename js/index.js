/* jshint browser: true, browserify: true */
var cache = {},
    guidCounter = 1,
    dataKey = 'data'  + (new Date).getTime();
 
(function () {
  'use strict';
  global.jQuery = require("jquery")
  require('jquery-ui');
  var avsc = require('avsc'),
      buffer = require('buffer'),
      $ = require('jquery');
  window.avsc = avsc;
  $( function() {

    var outputErrorElement = $('#encoded-error'),
        inputErrorElement = $('#decoded-error'),
        encodedValidElement = $('#output-valid'),
        decodedValidElement = $('#input-valid'),
        schemaErrorElement = $('#schema-error'),
        schemaValidElement = $('#schema-valid'),
        schemaSelect = $('#schema-template'),
        schemaElement = document.getElementById('schema'),
        inputElement = $('#input'),
        outputElement = $('#output'),
        body = document.getElementsByTagName('body')[0],
        arrayKeyPattern = /(\d+)/g,
        queryPattern = /[?&#]+([\w]+)=([^&#]*)/g,
        reservedKeysPattern = /-[a-z]+-/g,
        whitespacePattern = /[\s]+/g,
        typingTimer,
        eventObj = Event,
        doneTypingInterval = 500; // wait for some time before processing user input.
    
    window.reverseIndexMap = [];  

    eventObj.on('schema-changed', function() {
      runPreservingCursorPosition( 'schema', validateSchema);
    }).on('input-changed', function() {
      runPreservingCursorPosition( 'input' , function () {
        var rawInput = $.trim($(inputElement).text());        
        try {
          // Wrap key values in <span>.
          setInputText(rawInput);
          eventObj.trigger('re-instrument');
          
        } catch (err) {
          eventObj.trigger('invalid-input', err);
        }
      });
      encode();
    }).on('output-changed', function() {
      runPreservingCursorPosition('output', function() {
        var rawOutput = $.trim($(outputElement).text());
      });
      decode();
    }).on('valid-schema', function() {
      hideError(schemaErrorElement, schemaValidElement);
    }).on('invalid-schema', function (message) {
      showError(schemaErrorElement, message);
    }).on('valid-input', function () { 
      hideError(inputErrorElement, decodedValidElement);
    }).on('invalid-input', function(message) {
      showError(inputErrorElement, message);
    }).on('valid-output', function () { 
      hideError(outputErrorElement, encodedValidElement);
    }).on('invalid-output', function(message) {
      showError(outputErrorElement, message);
    }).on('update-layout', function() {
      if (window.type) {
        $('.-help-column-').each(function(i, element) {
          $(element).addClass('-hidden-');
        });
        $('.-to-hide-').each(function (i, element) {
          $(element).removeClass('-hidden-');
        });
      }
    }).on('reset-layout', function() {
      $('.-help-column-').each(function(i, element) {
        $(element).removeClass('-hidden-');
      });
      $('.-to-hide-').each(function (i, element) {
        $(element).addClass('-hidden-');
      });
      $(schemaElement).text("");
    }).on('schema-loaded', function(rawSchema) {
      var s = location.search.split('schema=')[1];
      s = s != undefined ? decodeURIComponent(s) : undefined;
      if (!s || s != rawSchema) {
        var newUrl = updateQueryStringParameter(location.href, 'schema', rawSchema);
        // Use this so that it doesn't reload the page, but that also means that you need to manually
        // load the schema from url
        window.history.pushState({}, 'AVSC', newUrl);
        populateFromQuery();
        eventObj.trigger('update-layout');
      }
    }).on('re-instrument', function() {
      window.instrumented = instrumentObject(window.type, readInput());
      window.reverseIndexMap = computeReverseIndex(window.instrumented);
    }).on('update-url', function(data) {
      var state = {};
      var newUrl = location.href;
      for (var key in data) {
        newUrl = updateQueryStringParameter(newUrl, key, data[key]);
      }
      // Use this so that it doesn't reload the page, but that also means that you need to manually
      // load the schema from url
      window.history.pushState(state, 'AVSC', newUrl);

    });

    schemaSelect.on('change', function() {
      loadTemplate(this.value);
    });

       
    /* When pasting something into an editable div, it 
     * pastes all the html styles with it too, which need to be cleaned up.
     * copied from: 
     * http://stackoverflow.com/questions/2176861/javascript-get-clipboard-data-on-paste-event-cross-browser */

    $('[contenteditable]').on('paste',function(e) {
      e.preventDefault();
      //TODO: Find out why sometimes it triggers 'input-changed' twice.
      var text = (e.originalEvent || e).clipboardData.getData('text/plain');
      window.document.execCommand('insertText', false, text);
      if(e.target.id === 'schema') {
        if(updateContent(schemaElement)) {
          eventObj.trigger('schema-changed');
          generateRandom();
        };
      }
    });

    $('#schema').on('keyup', function() {

      clearTimeout(typingTimer);
      typingTimer = setTimeout(function () {
        if(updateContent(schemaElement)) {
          eventObj.trigger('schema-changed');
        }
      }, doneTypingInterval);
    }).on('keydown', function() {
      clearTimeout(typingTimer);
    }).on('click', function(event) {
      if($(this).hasClass('-placeholder-')) {
        $(this).text('');
        $(this).removeClass('-placeholder-');
      }
    }).bind('DOMSubtreeModified', function() {
      if($(this).hasClass('-placeholder-')) {
        $(this).removeClass('-placeholder-');
      }
    });

    $('#input').on('paste keyup', function(event) {
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function() {
        if(updateContent(inputElement)) {
          eventObj.trigger('input-changed');
        };
      }, doneTypingInterval);
    }).on('keydown', function() {
      clearTimeout(typingTimer);
    }).on('mouseover', 'span', function(event) {
      if (window.instrumented) {
         /* It's important to clear it when the mouse moves from one span to another with the same parent,
           * to clear out the parent being highlighted. */
        clearHighlights();

        /*Will also automatically highlight all nested children.*/
        highlight($(this)); 

        /*So that the parent won't be highlighted (because we are using mouseover and not mouseenter)*/
        event.stopPropagation(); 

        var path = getPath($(this));
        var position = findPositionOf(path);
        highlight(position); 
      } else 
        console.log("No instrumented type found");
    }).on('mouseleave', 'span', function(event) {
      clearHighlights();
    });

    $('#output').on('paste keyup', function(event) {
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function() {
        if(updateContent(outputElement)) {
          eventObj.trigger('output-changed');
        };
      }, doneTypingInterval);
    }).on('mouseover', 'div', function(event) {
      if (window.reverseIndexMap) {
        clearHighlights();
        event.stopPropagation();
        
        var path = getPath(this);

        //The .find() and .children() methods are similar, 
        //except that the latter only travels a single level down the DOM tree.
        var inputCandidates = $(inputElement).find('.' + path.join(' .'));

        // Go through all input candidates and make sure the `full path` matches 
        // (and in the same order) and then find its position to be highlighted.

        $.each(inputCandidates, (function(idx, e) { 
          var cs = getPath(e);
          if (arraysEqual(cs, path)) {
            highlight($(e)); // highlight input
            var p = getPath(e); // find path
            var position = findPositionOf(p); // find the indexes in the output
            highlight(position); // highlight them in output
          }
        }));
      }
    }).on('mouseleave', 'div', function (event) { 
      clearHighlights(); 
    }).on('keydown', function(event) {
      clearTimeout(typingTimer);
    });

    $('#random').click(function () {   
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function() {
        generateRandom();
      }, doneTypingInterval);
      return false;
    });

    $("#reset").click(function() {
      eventObj.trigger('update-url', {'schema' : '' , 'record' : ''});
      eventObj.trigger('reset-layout');
      window.type = undefined;      
      return false;
    });

    function populateFromQuery() {
      var s = readQueryValue(location.href, 'schema');
      if(!!s) {
        s = decodeURIComponent(s);
        $(schemaElement).text(s);
        eventObj.trigger('schema-changed');
      }
      
      var record = readQueryValue(location.href, 'record');
      if(!!record) {
        record = decodeURIComponent(record);
        decode(record);
        setOutputText(record);
      }

      if (!!s && !record) {
        generateRandom();
      }
    }
    
    /**
    * Will save cursor position inside element `elemId` before running callback function f,
    * and restores it after f is finished. 
    */ 
    function runPreservingCursorPosition(elementId, f) {
     //Get current position.
      if (window.getSelection().rangeCount) {

        var range = window.getSelection().getRangeAt(0);
        var el = document.getElementById(elementId);
        var position = getCharacterOffsetWithin(range, el);
        f();
        setCharacterOffsetWithin(range, el, position);
      } else {
        f();
      }
    } 
    /*
    * When the input text changes, the whole text is replaced with new <span> elements,
    * and the previous cursor position will be lost. 
    *
    * This function will go through all the child elements of `node` and sets the
    * caret to the `position`th character.
    */ 

    function setCharacterOffsetWithin(range, node, position) {
      var treeWalker = document.createTreeWalker(
          node,
          NodeFilter.SHOW_TEXT
      );
      var charCount = 0, foundRange = false;
      while (treeWalker.nextNode() && !foundRange) {
          if (charCount + treeWalker.currentNode.length < position)
            charCount += treeWalker.currentNode.length;
          else {
            var newRange = document.createRange();
            newRange.setStart(treeWalker.currentNode, position - charCount);
            newRange.setEnd(treeWalker.currentNode, position - charCount);
            newRange.collapse(true);

            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(newRange);
            foundRange = true;
          }
      }
    }
    
    /**
    * From: http://jsfiddle.net/timdown/2YcaX/
    * http://stackoverflow.com/questions/4767848/get-caret-cursor-position-in-contenteditable-area-containing-html-content
    */
    function getCharacterOffsetWithin(range, node) {
      var treeWalker = document.createTreeWalker(
          node,
          NodeFilter.SHOW_TEXT,
          function(node) {
              var nodeRange = document.createRange();
              nodeRange.selectNode(node);
              return nodeRange.compareBoundaryPoints(Range.END_TO_END, range) < 1 ?
                  NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          },
          false
      );
      var charCount = 0;
      while (treeWalker.nextNode()) {
          charCount += treeWalker.currentNode.length;
      }
      if (range.startContainer.nodeType == Node.TEXT_NODE) { 
          charCount += range.startOffset;
      }
      return charCount;
    }

    /* Get full path of an element based on its css class attributes. (both inherited 
     * or direct)*/
    function getPath(element) {
      var cs = [];
      /* We can't just read the .attr() parameter, because we need the 
       * class properties of the parents too.*/
      $(element)
        .parentsUntil($('.-textbox-'))
        .andSelf()
        .each(function() {
          if(this.className) {
            /* This should be a concat because the result of split is already an array */
            cs = cs.concat($.trim(this.className.replace(reservedKeysPattern,''))
                            .split(' '));
          }
      });
      return cs;
    }

    /**
    * find the start and end index of an entry in its encoded representation
    * using the instrumented type already loaded in window.instrumented.
    *
    */
    function findPositionOf(path) {
      var current = window.instrumented;
      path.forEach(function(entry) {
        var arrayKey = arrayKeyPattern.exec(entry);
        var nextKey = arrayKey ? arrayKey[1] : entry + '_'; // getting the first captured group from regex result if a match was found.
        if (nextKey in current.value) {
          current = current.value[nextKey];
        }
      });
      return current;
    }

    /*
    * Find all spans that have the same class, and highlights them,
    * so if a key is selected, its value will be also highlighted, and vice versa.  
    */
    function highlightAllMatching(classesString) {
      var rawClasses = classesString[0] == ' ' ? classesString : ' ' + classesString;
      rawClasses = rawClasses.replace(/ /g, ' .');
      $(rawClasses).each( function(i) {
        highlight($(this));
      });
    }

    /**
    * Add -highlight- to the input element class, 
    * or highlight entries between 'start' and 'end' in the output text.
    */
    function highlight(input) {
      if (input.start !== undefined && input.end !== undefined){
        outputElement.children('div').each(function( index ) {
          if (index >= input.start && index < input.end) {
            highlight($(this));
          }
        });
      } else {
        input.addClass('-highlight-');
      }
    }

    function addClassToOutputWithRange(cls, start, end) {
      outputElement.children('span').each(function( index ) {
        if (index >= start && index < end) {
          $(this).addClass(cls);
        }
      });
      for (var i = start; i < end; i++) {
        if (reverseIndexMap[i]) {
          reverseIndexMap[i].push(cls);
        } else {
          reverseIndexMap[i] = [cls];
        }
      }
    }
    

    /**
    * Remove `highlight` from all spans. 
    */
    function clearHighlights() {
      $('span').removeClass('-highlight-');
      $('div').removeClass('-highlight-');
    }

    /**
    * set the input box's text to inputStr, 
    * where all key, values are wrapped in <span> elements
    * with the 'path' set as the span class. 
    */
    function setInputText(inputStr) {
      var input = JSON.parse(inputStr);
      var stringified = stringify(input, 1); 
      inputElement.html(stringified);
    }

    /**
    * Set the output box's text to outputStr where each byte is wrapped in <span>
    * elements and each line contains 8 bytes.
    */ 

    function setOutputText(outputStr) { 
      var res = '';
      var str = outputStr.replace(/\s+/g, '');
      var i, len;
      for (i =0, len = str.length; i < len; i += 2){
        res += createDiv(window.reverseIndexMap[i/2], str[i] + str[i + 1] + '&nbsp;');
      }
      outputElement.html(res);
    }

    /**
    * Similar to JSON.stringify, but will wrap each key and value 
    * with <span> tags. 
    * Does a DFS over the obj, to propagate the parent keys to each 
    * child element to be set in the span's class attribute.
    * @param obj The object to stringify
    * @param depth Current indention level.
    */
    function stringify(obj, depth) {

      var res = '';
      if ( obj == null ) {
        return createDiv('-null-', 'null');
      }
      if (typeof obj === 'number') {
        return  createDiv('-number-', obj + '');
      }
      if (typeof obj === 'boolean') {
        return createDiv('-boolean-', obj + '');
      }
      if (typeof obj === 'string') {
        // Calling json.stringify here to handle the fixed types.
        // I have no idea why just printing them doesn't work.
        return createDiv('-string-', JSON.stringify(obj));
      }
      var comma = false;
      if (obj instanceof Array) {
        res += '[<br/>';
        $.each(obj, function(index, value) {
          if (comma) res += ',<br/>';
          // Use '-' as a special character, which can not exist in schema keys 
          // but is a valid character for css class.
          res += createSpan(index , indent(depth) + stringify(value, depth + 1));
          comma = true;
        });
        res += '<br/>' + indent(depth - 1) + ']';
        return res;
      } 
      res += '{<br/>';
      comma = false;
      $.each(obj, function(key, value) {
        if (comma) res += ',<br/>';
        res += createSpan(key, indent(depth) + '"' + key + '": ' + stringify(value, depth + 1));
        comma = true;
      });
      res += '<br/>' + indent(depth - 1) + '}';
      return res;
    }

    function createSpan(cl, str) {
      return '<span class="' + cl + '">' + str + '</span>'; 
    }

    function createDiv(cl, str) {
      return '<div class="-inline- ' + cl + '">' + str + '</div>';
    }
    function indent(depth) { 
      var res = '';
      for (var i = 0 ; i < 2 * depth; i++) res += ' ';
      return res;
    }

    function validateSchema() {
      window.type = null;
      try {
        var schemaJson = readSchemaFromInput();
        var schemaStr = JSON.stringify(schemaJson, null, 2); 
        $(schemaElement).text(schemaStr);
        window.type = avsc.parse(schemaJson);
        eventObj.trigger('valid-schema');
        eventObj.trigger('update-layout');
        eventObj.trigger('update-url', {'schema':schemaStr});
      } catch (err) {
        eventObj.trigger('invalid-schema', err);
      }
    }
    function generateRandom() {
      if (window.type) {
        var random = window.type.random();
        var randomStr = window.type.toString(random);
        setInputText(randomStr);
        eventObj.trigger('input-changed');
      }
    }

    /**
    * Read the input as text from inputElement.
    * Instrument it and update window.instrumented.
    * Encode it and set the outputElement's text to the encoded data
    */   
    function encode() {
      if (window.type) {
        try {
          var input = readInput();
          var output = window.type.toBuffer(input);
          var outputStr = output.toString('hex');
          setOutputText(outputStr);
          eventObj.trigger('update-url', {'record' : outputStr});
          eventObj.trigger('valid-output');
          eventObj.trigger('valid-input');
        }catch(err) {
          eventObj.trigger('invalid-input', err);
        }
      }
    }

    function decode(rawInput) {
      if (window.type) {
        try {
          var input = rawInput ? readBuffer(rawInput) : readBuffer();
          var decoded = window.type.fromBuffer(input);
          var decodedStr = window.type.toString(decoded);
          setInputText(decodedStr);
          eventObj.trigger('re-instrument');
          eventObj.trigger('valid-input');
          eventObj.trigger('valid-output');
        }catch(err) {
          eventObj.trigger('invalid-output', err);
        }
      }
    }

    function showError(errorElem, msg) {
      errorElem.text(msg);
      errorElem.removeClass('-hidden-');
    };

    function hideError(errorElem, validElem) {
      errorElem.text("");
      errorElem.addClass('-hidden-');
      validElem.show('slow').delay(500).hide('slow');
    }
    
    function clearText(element) {
      element.text('');
    }
    /* If the schema is pasted with proper json formats, simply json.parse wouldn't work.*/
    function readSchemaFromInput() {
      var trimmedInput = $.trim($('#schema').text()).replace(/\s/g, "");
      return JSON.parse(trimmedInput);
    }

    function readInput() {
      var rawInput = $.trim($(inputElement).text());
      if(!!window.type) {
        return window.type.fromString(rawInput);
      } else {
        return JSON.parse(rawInput);
      }
    }
    /*Used for decoding.
    *Read the text represented as space-seperated hex numbers in elementId
    *and construct a Buffer object*/
    function readBuffer(str) {
      var rawInput = str || $.trim(outputElement.text());
      var hexArray = rawInput.split(/[\s,]+/);
      var i;
      var size = hexArray.length;
      var buffer = [];
      for (i =0; i < size; i++){
        buffer.push(new Buffer(hexArray[i], 'hex'));
      }
      return Buffer.concat(buffer);
    }

    /**
     * Will update the old value of the element to the new one, 
     * and returns true if the content changed. 
    */
    function  updateContent(element) {
      var newText = $.trim($(element).text()).replace(/\s+/g, '');
      if (!element.data) {
        element.data = {};
      }
      if (!element.data['oldValue'] || 
          element.data['oldValue'] != newText) {
        element.data['oldValue'] =  newText;
        return true;
      }
      return false;
    }

    function instrument(schema) {
      if (schema instanceof avsc.types.Type) {
        schema = schema.getSchema();
      }
      var refs = [];
      return avsc.parse(schema, {typeHook: hook});

      function hook(schema, opts) {
        if (~refs.indexOf(schema)) {
          return;
        }
        refs.push(schema);

        if (schema.type === 'record') {
          schema.fields.forEach(function (f) { 
            f['default'] = undefined;
            f['name'] = f['name'] == undefined ? undefined : f['name'] + '_';
          });
        }

        var name = schema.name || schema.type;
        if (name) {
          schema.name = 'r' + Math.random().toString(36).substr(2, 6);
        }
        var wrappedSchema = {
          name: name == undefined ? 'r' + Math.random().toString(36).substr(2, 6) : name + '_',
          namespace: schema.namespace,
          type: 'record',
          fields: [{name: 'value', type: schema}]
        };
        refs.push(wrappedSchema);

        var type = avsc.parse(wrappedSchema, opts);
        var read = type._read;
        type._read = function (tap) {
          var pos = tap.pos;
          var obj = read.call(type, tap);
          obj.start = pos;
          obj.end = tap.pos;
          return obj;
        };
        return type;
      }
    }

    /**
     * Convenience method to instrument a single object.
     * 
     * @param type {Type} The type to be instrumented.
     * @param obj {Object} A valid instance of `type`.
     * 
     * Returns an representation of `obj` with start and end markers.
     * 
     */
    function instrumentObject(type, obj) {
      return instrument(type).fromBuffer(type.toBuffer(obj));
    }

    /**
     * Creates an array of size buffer.length, 
     * where each index will contain a string representing
     * the path in the input record corresponding to this byte.
     */
    function computeReverseIndex(obj) {
      if (!obj) {
        return;
      }
      // initialize an array with all empty elements;
      var size = obj.end;
      var res = Array.apply(null, Array(size))
                     .map(String.prototype.valueOf,"");
      assignLabels('', obj, res);
      return res;
    }

    function assignLabels(key, node, res) {
      if (node.hasOwnProperty('start') && node.hasOwnProperty('end')) {
        appendLabel(node.start, node.end, key, res);
      }
      var valueNode = node.value;
      if (valueNode) {
        for (var child in valueNode) {
          if (valueNode.hasOwnProperty(child)) {
            assignLabels(child, valueNode[child], res);
          }
        }
      }
    }

    function appendLabel(start, end, label, arr) {
      var length = label.length;
      if (label[length - 1] == '_')
        label = label.substr(0, length - 1);  
      for (var i = start; i < end; i++) {
        arr[i] += ' ' + label; 
      }
    }

    function loadTemplate(name) { 
      if (name != '') {
        var p = '../schemas/' + name + '.avsc';
        $.ajax({
            url: p,
            success: function(data){
            eventObj.trigger('schema-loaded', data);
          }
        });
      }
    }

    /**
    * http://stackoverflow.com/a/6021027/2070194
    */
    function updateQueryStringParameter(uri, k1, v1, k2, v2) {
      var val1 = v1.replace(whitespacePattern, ''); // Remove whitespaces
      var re = new RegExp("([?&])" + k1 + "=.*?(&|$)", "i");
      var separator = uri.indexOf('?') !== -1 ? "&" : "?";
      var res;
      if (uri.match(re)) {
        res = uri.replace(re, '$1' + k1 + "=" + val1 + '$2');
      } else {
        res = uri + separator + k1 + "=" + val1;
      }
      if (!!k2) {
        return updateQueryStringParameter(res, k2, v2);
      }
      return res;
    }

    function readQueryValue(uri, key) {
      var query = {};
      var m;
      do {
        m = queryPattern.exec(uri);
        if (m) {
          query[m[1]] = m[2];
        }
      } while (m);

      return query[key];
    }

    function arraysEqual(a1, a2) {
      if(a1.length !== a2.length) { return false; }
      for (var i = 0; i < a1.length; i++ ) {
        if (a1[i] !== a2[i]) { return false; }
      }
      return true;
    }
    populateFromQuery();
 });
})();

/* Get the associated data of `elem` from the global cache.
 * (Will create a new entry in cache the first time called for an `elem`.)
*/

var Event = {
  on: function(event, callback) {
    this.hasOwnProperty('events') || (this.events = {});
    this.events.hasOwnProperty(event) || (this.events[event] = []);
    this.events[event].push(callback);
    return this;
  },
  trigger: function(event) {
    var tail = Array.prototype.slice.call(arguments, 1),
        callbacks = this.events[event];
    for (var i = 0, l = callbacks.length; i < l ; i++) {
      callbacks[i].apply(this, tail); // To pass parameters to calback not as an array, but as individual function arguments.  
    }
  }
};

