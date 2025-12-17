/*! xlsx.js (C) 2013-present SheetJS -- http://sheetjs.com */
/*! shim.js (C) 2013-present SheetJS -- http://sheetjs.com */
/* ES3/5 Compatibility shims and other utilities for older browsers. */

// From https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/keys
if(!Object.keys) Object.keys = (function() {
  var hasOwnProperty = Object.prototype.hasOwnProperty,
      hasDontEnumBug = !({toString: null}).propertyIsEnumerable('toString'),
      dontEnums = [
        'toString',
        'toLocaleString',
        'valueOf',
        'hasOwnProperty',
        'isPrototypeOf',
        'propertyIsEnumerable',
        'constructor'
      ],
      dontEnumsLength = dontEnums.length;

  return function(obj) {
    if(typeof obj !== 'object' && typeof obj !== 'function' || obj === null) throw new TypeError('Object.keys called on non-object');

    var result = [];

    for(var prop in obj) if(hasOwnProperty.call(obj, prop)) result.push(prop);

    if(hasDontEnumBug)
      for(var i=0; i < dontEnumsLength; ++i)
        if(hasOwnProperty.call(obj, dontEnums[i])) result.push(dontEnums[i]);
    return result;
  };
})();

if(!String.prototype.trim) String.prototype.trim = function() {
  var s = this.replace(/^\s+/, '');
  for(var i = s.length - 1; i >=0 ; --i) if(!s.charAt(i).match(/^\s/)) return s.slice(0,i+1);
  return "";
};

if(!Array.prototype.forEach) Array.prototype.forEach = function(cb) {
  var len = (this.length>>>0), self = (arguments[1]||void 0);
  for(var i=0; i<len; ++i) if(i in this) self ? cb.call(self, this[i], i, this) : cb(this[i], i, this);
};

if(!Array.prototype.map) Array.prototype.map = function(cb) {
  var len = (this.length>>>0), self = (arguments[1]||void 0), A = new Array(len);
  for(var i=0; i<len; ++i) if(i in this) A[i] = self ? cb.call(self, this[i], i, this) : cb(this[i], i, this);
  return A;
};

if(!Array.prototype.indexOf) Array.prototype.indexOf = function(needle) {
  var len = (this.length>>>0), i = ((arguments[1]|0)||0);
  for(i<0 && (i+=len)<0 && (i=0); i<len; ++i) if(this[i] === needle) return i;
  return -1;
};

if(!Array.prototype.lastIndexOf) Array.prototype.lastIndexOf = function(needle) {
  var len = (this.length>>>0), i = len - 1;
  for(; i>=0; --i) if(this[i] === needle) return i;
  return -1;
};

if(!Array.isArray) Array.isArray = function(obj) { return Object.prototype.toString.call(obj) === "[object Array]"; };

if(!Date.prototype.toISOString) Date.prototype.toISOString = (function() {
  function p(n,i) { return ('0000000' + n).slice(-(i||2)); }

  return function _toISOString() {
    var y = this.getUTCFullYear(), yr = "";
    if(y>9999)   yr = '+' + p( y, 6);
    else if(y<0) yr = '-' + p(-y, 6);
    else         yr =       p( y, 4);

    return [
      yr, p(this.getUTCMonth()+1), p(this.getUTCDate())
    ].join('-') + 'T' + [
      p(this.getUTCHours()), p(this.getUTCMinutes()), p(this.getUTCSeconds())
    ].join(':') + '.' + p(this.getUTCMilliseconds(),3) + 'Z';
  };
}());

if(typeof ArrayBuffer !== 'undefined' && !ArrayBuffer.prototype.slice) ArrayBuffer.prototype.slice = function(start, end) {
  if(start == null) start = 0;
  if(start < 0) { start += this.byteLength; if(start < 0) start = 0; }
  if(start >= this.byteLength) return new Uint8Array(0);
  if(end == null) end = this.byteLength;
  if(end < 0) { end += this.byteLength; if(end < 0) end = 0; }
  if(end > this.byteLength) end = this.byteLength;
  if(start > end) return new Uint8Array(0);
  var out = new ArrayBuffer(end - start);
  var view = new Uint8Array(out);
  var data = new Uint8Array(this, start, end - start)
  /* IE10 should have Uint8Array#set */
  if(view.set) view.set(data); else while(start <= --end) view[end - start] = data[end];
  return out;
};
if(typeof Uint8Array !== 'undefined' && !Uint8Array.prototype.slice) Uint8Array.prototype.slice = function(start, end) {
  if(start == null) start = 0;
  if(start < 0) { start += this.length; if(start < 0) start = 0; }
  if(start >= this.length) return new Uint8Array(0);
  if(end == null) end = this.length;
  if(end < 0) { end += this.length; if(end < 0) end = 0; }
  if(end > this.length) end = this.length;
  if(start > end) return new Uint8Array(0);
  var out = new Uint8Array(end - start);
  while(start <= --end) out[end - start] = this[end];
  return out;
};

// VBScript + ActiveX fallback for IE5+
var IE_SaveFile = (function() { try {
  if(typeof IE_SaveFile_Impl == "undefined") document.write([
'<script type="text/vbscript" language="vbscript">',
'IE_GetProfileAndPath_Key = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\\"',
'Function IE_GetProfileAndPath(key): Set wshell = CreateObject("WScript.Shell"): IE_GetProfileAndPath = wshell.RegRead(IE_GetProfileAndPath_Key & key): IE_GetProfileAndPath = wshell.ExpandEnvironmentStrings("%USERPROFILE%") & "!" & IE_GetProfileAndPath: End Function',
'Function IE_SaveFile_Impl(FileName, payload): Dim data, plen, i, bit: data = CStr(payload): plen = Len(data): Set fso = CreateObject("Scripting.FileSystemObject"): fso.CreateTextFile FileName, True: Set f = fso.GetFile(FileName): Set stream = f.OpenAsTextStream(2, 0): For i = 1 To plen Step 3: bit = Mid(data, i, 2): stream.write Chr(CLng("&h" & bit)): Next: stream.Close: IE_SaveFile_Impl = True: End Function',
'|/script>'.replace("|","<")
  ].join("\r\n"));
  if(typeof IE_SaveFile_Impl == "undefined") return void 0;
  var IE_GetPath = (function() {
    var DDP1 = "";
    try { DDP1 = IE_GetProfileAndPath("{374DE290-123F-4565-9164-39C4925E467B}"); } catch(e) { try { DDP1 = IE_GetProfileAndPath("Personal"); } catch(e) { try { DDP1 = IE_GetProfileAndPath("Desktop"); } catch(e) { throw e; }}}
    var o = DDP1.split("!");
    DDP = o[1].replace("%USERPROFILE%", o[0]);
    return function(path) { return DDP + "\\" + path; };
  })();
  function fix_data(data) {
    var out = [];
    var T = typeof data == "string";
    for(var i = 0; i < data.length; ++i) out.push(("00"+(T ? data.charCodeAt(i) : data[i]).toString(16)).slice(-2));
    var o = out.join("|");
    return o;
  }
  return function(data, filename) { return IE_SaveFile_Impl(IE_GetPath(filename), fix_data(data)); };
} catch(e) { return void 0; }})();
var IE_LoadFile = (function() { try {
  if(typeof IE_LoadFile_Impl == "undefined") document.write([
'<script type="text/vbscript" language="vbscript">',
'Function IE_LoadFile_Impl(FileName): Dim out(), plen, i, cc: Set fso = CreateObject("Scripting.FileSystemObject"): Set f = fso.GetFile(FileName): Set stream = f.OpenAsTextStream(1, 0): plen = f.Size: ReDim out(plen): For i = 1 To plen Step 1: cc = Hex(Asc(stream.read(1))): If Len(cc) < 2 Then: cc = "0" & cc: End If: out(i) = cc: Next: IE_LoadFile_Impl = Join(out,""): End Function',
'|/script>'.replace("|","<")
  ].join("\r\n"));
  if(typeof IE_LoadFile_Impl == "undefined") return void 0;
  function fix_data(data) {
    var out = [];
    for(var i = 0; i < data.length; i+=2) out.push(String.fromCharCode(parseInt(data.slice(i, i+2), 16)));
    var o = out.join("");
    return o;
  }
  return function(filename) { return fix_data(IE_LoadFile_Impl(filename)); };
} catch(e) { return void 0; }})();

// getComputedStyle polyfill from https://gist.github.com/8HNHoFtE/5891086
if(typeof window !== 'undefined' && typeof window.getComputedStyle !== 'function') {
  window.getComputedStyle = function(e,t){return this.el=e,this.getPropertyValue=function(t){var n=/(\-([a-z]){1})/g;return t=="float"&&(t="styleFloat"),n.test(t)&&(t=t.replace(n,function(){return arguments[2].toUpperCase()})),e.currentStyle[t]?e.currentStyle[t]:null},this}
}
var DO_NOT_EXPORT_CODEPAGE = true;
/*! xlsx.js (C) 2013-present SheetJS -- http://sheetjs.com */
/* vim: set ts=2: */
/*exported XLSX */
/*global global, exports, module, require:false, process:false, Buffer:false, ArrayBuffer:false, DataView:false, Deno:false, Set:false, Float32Array:false */
var XLSX = {};
function make_xlsx_lib(XLSX){
XLSX.version = '0.20.3';
var current_codepage = 1200, current_ansi = 1252;
/*global cptable:true, window */
var $cptable;

var VALID_ANSI = [ 874, 932, 936, 949, 950, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258, 10000 ];
/* ECMA-376 Part I 18.4.1 charset to codepage mapping */
var CS2CP = ({
	0:    1252, /* ANSI */
	1:   65001, /* DEFAULT */
	2:   65001, /* SYMBOL */
	77:  10000, /* MAC */
	128:   932, /* SHIFTJIS */
	129:   949, /* HANGUL */
	130:  1361, /* JOHAB */
	134:   936, /* GB2312 */
	136:   950, /* CHINESEBIG5 */
	161:  1253, /* GREEK */
	162:  1254, /* TURKISH */
	163:  1258, /* VIETNAMESE */
	177:  1255, /* HEBREW */
	178:  1256, /* ARABIC */
	186:  1257, /* BALTIC */
	204:  1251, /* RUSSIAN */
	222:   874, /* THAI */
	238:  1250, /* EASTEUROPE */
	255:  1252, /* OEM */
	69:   6969  /* MISC */
});

var set_ansi = function(cp) { if(VALID_ANSI.indexOf(cp) == -1) return; current_ansi = CS2CP[0] = cp; };
function reset_ansi() { set_ansi(1252); }

var set_cp = function(cp) { current_codepage = cp; set_ansi(cp); };
function reset_cp() { set_cp(1200); reset_ansi(); }

function char_codes(data) { var o = []; for(var i = 0, len = data.length; i < len; ++i) o[i] = data.charCodeAt(i); return o; }

function utf16leread(data) {
	var o = [];
	for(var i = 0; i < (data.length>>1); ++i) o[i] = String.fromCharCode(data.charCodeAt(2*i) + (data.charCodeAt(2*i+1)<<8));
	return o.join("");
}
function utf16lereadu(data) {
	var o = [];
	for(var i = 0; i < (data.length>>1); ++i) o[i] = String.fromCharCode(data[2*i] + (data[2*i+1]<<8));
	return o.join("");
}
function utf16beread(data) {
	var o = [];
	for(var i = 0; i < (data.length>>1); ++i) o[i] = String.fromCharCode(data.charCodeAt(2*i+1) + (data.charCodeAt(2*i)<<8));
	return o.join("");
}

var debom = function(data) {
	var c1 = data.charCodeAt(0), c2 = data.charCodeAt(1);
	if(c1 == 0xFF && c2 == 0xFE) return utf16leread(data.slice(2));
	if(c1 == 0xFE && c2 == 0xFF) return utf16beread(data.slice(2));
	if(c1 == 0xFEFF) return data.slice(1);
	return data;
};

var _getchar = function _gc1(x) { return String.fromCharCode(x); };
var _getansi = function _ga1(x) { return String.fromCharCode(x); };

function set_cptable(cptable) {
	$cptable = cptable;
	set_cp = function(cp) { current_codepage = cp; set_ansi(cp); };
	debom = function(data) {
		if(data.charCodeAt(0) === 0xFF && data.charCodeAt(1) === 0xFE) { return $cptable.utils.decode(1200, char_codes(data.slice(2))); }
		return data;
	};
	_getchar = function _gc2(x) {
		if(current_codepage === 1200) return String.fromCharCode(x);
		return $cptable.utils.decode(current_codepage, [x&255,x>>8])[0];
	};
	_getansi = function _ga2(x) {
		return $cptable.utils.decode(current_ansi, [x])[0];
	};
	cpdoit();
}
var DENSE = null;
var DIF_XL = true;
var Base64_map = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
function Base64_encode(input) {
  var o = "";
  var c1 = 0, c2 = 0, c3 = 0, e1 = 0, e2 = 0, e3 = 0, e4 = 0;
  for (var i = 0; i < input.length; ) {
    c1 = input.charCodeAt(i++);
    e1 = c1 >> 2;
    c2 = input.charCodeAt(i++);
    e2 = (c1 & 3) << 4 | c2 >> 4;
    c3 = input.charCodeAt(i++);
    e3 = (c2 & 15) << 2 | c3 >> 6;
    e4 = c3 & 63;
    if (isNaN(c2)) {
      e3 = e4 = 64;
    } else if (isNaN(c3)) {
      e4 = 64;
    }
    o += Base64_map.charAt(e1) + Base64_map.charAt(e2) + Base64_map.charAt(e3) + Base64_map.charAt(e4);
  }
  return o;
}
function Base64_encode_pass(input) {
  var o = "";
  var c1 = 0, c2 = 0, c3 = 0, e1 = 0, e2 = 0, e3 = 0, e4 = 0;
  for (var i = 0; i < input.length; ) {
    c1 = input.charCodeAt(i++);
    if (c1 > 255)
      c1 = 95;
    e1 = c1 >> 2;
    c2 = input.charCodeAt(i++);
    if (c2 > 255)
      c2 = 95;
    e2 = (c1 & 3) << 4 | c2 >> 4;
    c3 = input.charCodeAt(i++);
    if (c3 > 255)
      c3 = 95;
    e3 = (c2 & 15) << 2 | c3 >> 6;
    e4 = c3 & 63;
    if (isNaN(c2)) {
      e3 = e4 = 64;
    } else if (isNaN(c3)) {
      e4 = 64;
    }
    o += Base64_map.charAt(e1) + Base64_map.charAt(e2) + Base64_map.charAt(e3) + Base64_map.charAt(e4);
  }
  return o;
}
function Base64_encode_arr(input) {
  var o = "";
  var c1 = 0, c2 = 0, c3 = 0, e1 = 0, e2 = 0, e3 = 0, e4 = 0;
  for (var i = 0; i < input.length; ) {
    c1 = input[i++];
    e1 = c1 >> 2;
    c2 = input[i++];
    e2 = (c1 & 3) << 4 | c2 >> 4;
    c3 = input[i++];
    e3 = (c2 & 15) << 2 | c3 >> 6;
    e4 = c3 & 63;
    if (isNaN(c2)) {
      e3 = e4 = 64;
    } else if (isNaN(c3)) {
      e4 = 64;
    }
    o += Base64_map.charAt(e1) + Base64_map.charAt(e2) + Base64_map.charAt(e3) + Base64_map.charAt(e4);
  }
  return o;
}
function Base64_decode(input) {
  var o = "";
  var c1 = 0, c2 = 0, c3 = 0, e1 = 0, e2 = 0, e3 = 0, e4 = 0;
  if (input.slice(0, 5) == "data:") {
    var i = input.slice(0, 1024).indexOf(";base64,");
    if (i > -1)
      input = input.slice(i + 8);
  }
  input = input.replace(/[^\w\+\/\=]/g, "");
  for (var i = 0; i < input.length; ) {
    e1 = Base64_map.indexOf(input.charAt(i++));
    e2 = Base64_map.indexOf(input.charAt(i++));
    c1 = e1 << 2 | e2 >> 4;
    o += String.fromCharCode(c1);
    e3 = Base64_map.indexOf(input.charAt(i++));
    c2 = (e2 & 15) << 4 | e3 >> 2;
    if (e3 !== 64) {
      o += String.fromCharCode(c2);
    }
    e4 = Base64_map.indexOf(input.charAt(i++));
    c3 = (e3 & 3) << 6 | e4;
    if (e4 !== 64) {
      o += String.fromCharCode(c3);
    }
  }
  return o;
}
var has_buf = (function() { return typeof Buffer !== 'undefined' && typeof undefined !== 'undefined' && typeof ({}) !== 'undefined' && !!({}).node; })();

var Buffer_from = (function() {
	if(typeof Buffer !== 'undefined') {
		var nbfs = !Buffer.from;
		if(!nbfs) try { Buffer.from("foo", "utf8"); } catch(e) { nbfs = true; }
		return nbfs ? function(buf, enc) { return (enc) ? new Buffer(buf, enc) : new Buffer(buf); } : Buffer.from.bind(Buffer);
	}
	return function() {};
})();
var buf_utf16le = (function() {
	if(typeof Buffer === 'undefined') return false;
	var x = Buffer_from([65,0]);
	if(!x) return false;
	var o = x.toString("utf16le");
	return o.length == 1;
})();


function new_raw_buf(len) {
	/* jshint -W056 */
	if(has_buf) return Buffer.alloc ? Buffer.alloc(len) : new Buffer(len);
	return typeof Uint8Array != "undefined" ? new Uint8Array(len) : new Array(len);
	/* jshint +W056 */
}

function new_unsafe_buf(len) {
	/* jshint -W056 */
	if(has_buf) return Buffer.allocUnsafe ? Buffer.allocUnsafe(len) : new Buffer(len);
	return typeof Uint8Array != "undefined" ? new Uint8Array(len) : new Array(len);
	/* jshint +W056 */
}

var s2a = function s2a(s) {
	if(has_buf) return Buffer_from(s, "binary");
	return s.split("").map(function(x){ return x.charCodeAt(0) & 0xff; });
};

function s2ab(s) {
	if(typeof ArrayBuffer === 'undefined') return s2a(s);
	var buf = new ArrayBuffer(s.length), view = new Uint8Array(buf);
	for (var i=0; i!=s.length; ++i) view[i] = s.charCodeAt(i) & 0xFF;
	return buf;
}

function a2s(data) {
	if(Array.isArray(data)) return data.map(function(c) { return String.fromCharCode(c); }).join("");
	var o = []; for(var i = 0; i < data.length; ++i) o[i] = String.fromCharCode(data[i]); return o.join("");
}

function a2u(data) {
	if(typeof Uint8Array === 'undefined') throw new Error("Unsupported");
	return new Uint8Array(data);
}

function ab2a(data) {
	if(typeof ArrayBuffer == 'undefined') throw new Error("Unsupported");
	if(data instanceof ArrayBuffer) return ab2a(new Uint8Array(data));
var o = new Array(data.length);
	for(var i = 0; i < data.length; ++i) o[i] = data[i];
	return o;
}

var bconcat = has_buf ? function(bufs) { return Buffer.concat(bufs.map(function(buf) { return Buffer.isBuffer(buf) ? buf : Buffer_from(buf); })); } : function(bufs) {
	if(typeof Uint8Array !== "undefined") {
		var i = 0, maxlen = 0;
		for(i = 0; i < bufs.length; ++i) maxlen += bufs[i].length;
		var o = new Uint8Array(maxlen);
		var len = 0;
		for(i = 0, maxlen = 0; i < bufs.length; maxlen += len, ++i) {
			len = bufs[i].length;
			if(bufs[i] instanceof Uint8Array) o.set(bufs[i], maxlen);
			else if(typeof bufs[i] == "string") o.set(new Uint8Array(s2a(bufs[i])), maxlen);
			else o.set(new Uint8Array(bufs[i]), maxlen);
		}
		return o;
	}
	return [].concat.apply([], bufs.map(function(buf) { return Array.isArray(buf) ? buf : [].slice.call(buf); }));
};

function utf8decode(content) {
	var out = [], widx = 0, L = content.length + 250;
	var o = new_raw_buf(content.length + 255);
	for(var ridx = 0; ridx < content.length; ++ridx) {
		var c = content.charCodeAt(ridx);
		if(c < 0x80) o[widx++] = c;
		else if(c < 0x800) {
			o[widx++] = (192|((c>>6)&31));
			o[widx++] = (128|(c&63));
		} else if(c >= 0xD800 && c < 0xE000) {
			c = (c&1023)+64;
			var d = content.charCodeAt(++ridx)&1023;
			o[widx++] = (240|((c>>8)&7));
			o[widx++] = (128|((c>>2)&63));
			o[widx++] = (128|((d>>6)&15)|((c&3)<<4));
			o[widx++] = (128|(d&63));
		} else {
			o[widx++] = (224|((c>>12)&15));
			o[widx++] = (128|((c>>6)&63));
			o[widx++] = (128|(c&63));
		}
		if(widx > L) {
			out.push(o.slice(0, widx));
			widx = 0;
			o = new_raw_buf(65535);
			L = 65530;
		}
	}
	out.push(o.slice(0, widx));
	return bconcat(out);
}

var chr0 = /\u0000/g, chr1 = /[\u0001-\u0006]/g;
/* ssf.js (C) 2013-present SheetJS -- http://sheetjs.com */
/*jshint -W041 */
function _strrev(x) { var o = "", i = x.length-1; while(i>=0) o += x.charAt(i--); return o; }
function pad0(v,d){var t=""+v; return t.length>=d?t:fill('0',d-t.length)+t;}
function pad_(v,d){var t=""+v;return t.length>=d?t:fill(' ',d-t.length)+t;}
function rpad_(v,d){var t=""+v; return t.length>=d?t:t+fill(' ',d-t.length);}
function pad0r1(v,d){var t=""+Math.round(v); return t.length>=d?t:fill('0',d-t.length)+t;}
function pad0r2(v,d){var t=""+v; return t.length>=d?t:fill('0',d-t.length)+t;}
var p2_32 = Math.pow(2,32);
function pad0r(v,d){if(v>p2_32||v<-p2_32) return pad0r1(v,d); var i = Math.round(v); return pad0r2(i,d); }
/* yes, in 2022 this is still faster than string compare */
function SSF_isgeneral(s, i) { i = i || 0; return s.length >= 7 + i && (s.charCodeAt(i)|32) === 103 && (s.charCodeAt(i+1)|32) === 101 && (s.charCodeAt(i+2)|32) === 110 && (s.charCodeAt(i+3)|32) === 101 && (s.charCodeAt(i+4)|32) === 114 && (s.charCodeAt(i+5)|32) === 97 && (s.charCodeAt(i+6)|32) === 108; }
var days = [
	['Sun', 'Sunday'],
	['Mon', 'Monday'],
	['Tue', 'Tuesday'],
	['Wed', 'Wednesday'],
	['Thu', 'Thursday'],
	['Fri', 'Friday'],
	['Sat', 'Saturday']
];
var months = [
	['J', 'Jan', 'January'],
	['F', 'Feb', 'February'],
	['M', 'Mar', 'March'],
	['A', 'Apr', 'April'],
	['M', 'May', 'May'],
	['J', 'Jun', 'June'],
	['J', 'Jul', 'July'],
	['A', 'Aug', 'August'],
	['S', 'Sep', 'September'],
	['O', 'Oct', 'October'],
	['N', 'Nov', 'November'],
	['D', 'Dec', 'December']
];
function SSF_init_table(t) {
	if(!t) t = {};
	t[0]=  'General';
	t[1]=  '0';
	t[2]=  '0.00';
	t[3]=  '#,##0';
	t[4]=  '#,##0.00';
	t[9]=  '0%';
	t[10]= '0.00%';
	t[11]= '0.00E+00';
	t[12]= '# ?/?';
	t[13]= '# ??/??';
	t[14]= 'm/d/yy';
	t[15]= 'd-mmm-yy';
	t[16]= 'd-mmm';
	t[17]= 'mmm-yy';
	t[18]= 'h:mm AM/PM';
	t[19]= 'h:mm:ss AM/PM';
	t[20]= 'h:mm';
	t[21]= 'h:mm:ss';
	t[22]= 'm/d/yy h:mm';
	t[37]= '#,##0 ;(#,##0)';
	t[38]= '#,##0 ;[Red](#,##0)';
	t[39]= '#,##0.00;(#,##0.00)';
	t[40]= '#,##0.00;[Red](#,##0.00)';
	t[45]= 'mm:ss';
	t[46]= '[h]:mm:ss';
	t[47]= 'mmss.0';
	t[48]= '##0.0E+0';
	t[49]= '@';
	t[56]= '"上午/下午 "hh"時"mm"分"ss"秒 "';
	return t;
}
/* repeated to satiate webpack */
var table_fmt = {
	0:  'General',
	1:  '0',
	2:  '0.00',
	3:  '#,##0',
	4:  '#,##0.00',
	9:  '0%',
	10: '0.00%',
	11: '0.00E+00',
	12: '# ?/?',
	13: '# ??/??',
	14: 'm/d/yy',
	15: 'd-mmm-yy',
	16: 'd-mmm',
	17: 'mmm-yy',
	18: 'h:mm AM/PM',
	19: 'h:mm:ss AM/PM',
	20: 'h:mm',
	21: 'h:mm:ss',
	22: 'm/d/yy h:mm',
	37: '#,##0 ;(#,##0)',
	38: '#,##0 ;[Red](#,##0)',
	39: '#,##0.00;(#,##0.00)',
	40: '#,##0.00;[Red](#,##0.00)',
	45: 'mm:ss',
	46: '[h]:mm:ss',
	47: 'mmss.0',
	48: '##0.0E+0',
	49: '@',
	56: '"上午/下午 "hh"時"mm"分"ss"秒 "'
};

/* Defaults determined by systematically testing in Excel 2019 */

/* These formats appear to default to other formats in the table */
var SSF_default_map = {
	5:  37, 6:  38, 7:  39, 8:  40,         //  5 -> 37 ...  8 -> 40

	23:  0, 24:  0, 25:  0, 26:  0,         // 23 ->  0 ... 26 ->  0

	27: 14, 28: 14, 29: 14, 30: 14, 31: 14, // 27 -> 14 ... 31 -> 14

	50: 14, 51: 14, 52: 14, 53: 14, 54: 14, // 50 -> 14 ... 58 -> 14
	55: 14, 56: 14, 57: 14, 58: 14,
	59:  1, 60:  2, 61:  3, 62:  4,         // 59 ->  1 ... 62 ->  4

	67:  9, 68: 10,                         // 67 ->  9 ... 68 -> 10
	69: 12, 70: 13, 71: 14,                 // 69 -> 12 ... 71 -> 14
	72: 14, 73: 15, 74: 16, 75: 17,         // 72 -> 14 ... 75 -> 17
	76: 20, 77: 21, 78: 22,                 // 76 -> 20 ... 78 -> 22
	79: 45, 80: 46, 81: 47,                 // 79 -> 45 ... 81 -> 47
	82: 0                                   // 82 ->  0 ... 65536 -> 0 (omitted)
};


/* These formats technically refer to Accounting formats with no equivalent */
var SSF_default_str = {
	//  5 -- Currency,   0 decimal, black negative
	5:  '"$"#,##0_);\\("$"#,##0\\)',
	63: '"$"#,##0_);\\("$"#,##0\\)',

	//  6 -- Currency,   0 decimal, red   negative
	6:  '"$"#,##0_);[Red]\\("$"#,##0\\)',
	64: '"$"#,##0_);[Red]\\("$"#,##0\\)',

	//  7 -- Currency,   2 decimal, black negative
	7:  '"$"#,##0.00_);\\("$"#,##0.00\\)',
	65: '"$"#,##0.00_);\\("$"#,##0.00\\)',

	//  8 -- Currency,   2 decimal, red   negative
	8:  '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
	66: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',

	// 41 -- Accounting, 0 decimal, No Symbol
	41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',

	// 42 -- Accounting, 0 decimal, $  Symbol
	42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',

	// 43 -- Accounting, 2 decimal, No Symbol
	43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',

	// 44 -- Accounting, 2 decimal, $  Symbol
	44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)'
};

function SSF_frac(x, D, mixed) {
	var sgn = x < 0 ? -1 : 1;
	var B = x * sgn;
	var P_2 = 0, P_1 = 1, P = 0;
	var Q_2 = 1, Q_1 = 0, Q = 0;
	var A = Math.floor(B);
	while(Q_1 < D) {
		A = Math.floor(B);
		P = A * P_1 + P_2;
		Q = A * Q_1 + Q_2;
		if((B - A) < 0.00000005) break;
		B = 1 / (B - A);
		P_2 = P_1; P_1 = P;
		Q_2 = Q_1; Q_1 = Q;
	}
	if(Q > D) { if(Q_1 > D) { Q = Q_2; P = P_2; } else { Q = Q_1; P = P_1; } }
	if(!mixed) return [0, sgn * P, Q];
	var q = Math.floor(sgn * P/Q);
	return [q, sgn*P - q*Q, Q];
}
function SSF_normalize_xl_unsafe(v) {
	var s = v.toPrecision(16);
	if(s.indexOf("e") > -1) {
		var m = s.slice(0, s.indexOf("e"));
		m = m.indexOf(".") > -1 ? m.slice(0, (m.slice(0,2) == "0." ? 17 : 16)) : (m.slice(0,15) + fill("0", m.length - 15));
		return m + s.slice(s.indexOf("e"));
	}
	var n = s.indexOf(".") > -1 ? s.slice(0, (s.slice(0,2) == "0." ? 17 : 16)) : (s.slice(0,15) + fill("0", s.length - 15));
	return Number(n);
}

function SSF_parse_date_code(v,opts,b2) {
	if(v > 2958465 || v < 0) return null;
	v = SSF_normalize_xl_unsafe(v);
	var date = (v|0), time = Math.floor(86400 * (v - date)), dow=0;
	var dout=[];
	var out={D:date, T:time, u:86400*(v-date)-time,y:0,m:0,d:0,H:0,M:0,S:0,q:0};
	if(Math.abs(out.u) < 1e-6) out.u = 0;
	if(opts && opts.date1904) date += 1462;
	if(out.u > 0.9999) {
		out.u = 0;
		if(++time == 86400) { out.T = time = 0; ++date; ++out.D; }
	}
	if(date === 60) {dout = b2 ? [1317,10,29] : [1900,2,29]; dow=3;}
	else if(date === 0) {dout = b2 ? [1317,8,29] : [1900,1,0]; dow=6;}
	else {
		if(date > 60) --date;
		/* 1 = Jan 1 1900 in Gregorian */
		var d = new Date(1900, 0, 1);
		d.setDate(d.getDate() + date - 1);
		dout = [d.getFullYear(), d.getMonth()+1,d.getDate()];
		dow = d.getDay();
		if(date < 60) dow = (dow + 6) % 7;
		if(b2) dow = SSF_fix_hijri(d, dout);
	}
	out.y = dout[0]; out.m = dout[1]; out.d = dout[2];
	out.S = time % 60; time = Math.floor(time / 60);
	out.M = time % 60; time = Math.floor(time / 60);
	out.H = time;
	out.q = dow;
	return out;
}
/* ECMA-376 18.8.30 numFmt*/
/* Note: `toPrecision` uses standard form when prec > E and E >= -6 */
/* exponent >= -9 and <= 9 */
function SSF_strip_decimal(o) {
	return (o.indexOf(".") == -1) ? o : o.replace(/(?:\.0*|(\.\d*[1-9])0+)$/, "$1");
}

/* General Exponential always shows 2 digits exp and trims the mantissa */
function SSF_normalize_exp(o) {
	if(o.indexOf("E") == -1) return o;
	return o.replace(/(?:\.0*|(\.\d*[1-9])0+)[Ee]/,"$1E").replace(/(E[+-])(\d)$/,"$10$2");
}

/* exponent >= -9 and <= 9 */
function SSF_small_exp(v) {
	var w = (v<0?12:11);
	var o = SSF_strip_decimal(v.toFixed(12)); if(o.length <= w) return o;
	o = v.toPrecision(10); if(o.length <= w) return o;
	return v.toExponential(5);
}

/* exponent >= 11 or <= -10 likely exponential */
function SSF_large_exp(v) {
	var o = SSF_strip_decimal(v.toFixed(11));
	return (o.length > (v<0?12:11) || o === "0" || o === "-0") ? v.toPrecision(6) : o;
}

function SSF_general_num(v) {
	if(!isFinite(v)) return isNaN(v) ? "#NUM!" : "#DIV/0!";
	var V = Math.floor(Math.log(Math.abs(v))*Math.LOG10E), o;

	if(V >= -4 && V <= -1) o = v.toPrecision(10+V);
	else if(Math.abs(V) <= 9) o = SSF_small_exp(v);
	else if(V === 10) o = v.toFixed(10).substr(0,12);
	else o = SSF_large_exp(v);

	return SSF_strip_decimal(SSF_normalize_exp(o.toUpperCase()));
}


/*
	"General" rules:
	- text is passed through ("@")
	- booleans are rendered as TRUE/FALSE
	- "up to 11 characters" displayed for numbers
	- Default date format (code 14) used for Dates

	The longest 32-bit integer text is "-2147483648", exactly 11 chars
	TODO: technically the display depends on the width of the cell
*/
function SSF_general(v, opts) {
	switch(typeof v) {
		case 'string': return v;
		case 'boolean': return v ? "TRUE" : "FALSE";
		case 'number': return (v|0) === v ? v.toString(10) : SSF_general_num(v);
		case 'undefined': return "";
		case 'object':
			if(v == null) return "";
			if(v instanceof Date) return SSF_format(14, datenum(v, opts && opts.date1904), opts);
	}
	throw new Error("unsupported value in General format: " + v);
}

function SSF_fix_hijri(date, o) {
  /* TODO: properly adjust y/m/d and  */
  o[0] -= 581;
  var dow = date.getDay();
  if(date < 60) dow = (dow + 6) % 7;
  return dow;
}
//var THAI_DIGITS = "\u0E50\u0E51\u0E52\u0E53\u0E54\u0E55\u0E56\u0E57\u0E58\u0E59".split("");
function SSF_write_date(type, fmt, val, ss0) {
	var o="", ss=0, tt=0, y = val.y, out, outl = 0;
	switch(type) {
		case 98: /* 'b' buddhist year */
			y = val.y + 543;
			/* falls through */
		case 121: /* 'y' year */
		switch(fmt.length) {
			case 1: case 2: out = y % 100; outl = 2; break;
			default: out = y % 10000; outl = 4; break;
		} break;
		case 109: /* 'm' month */
		switch(fmt.length) {
			case 1: case 2: out = val.m; outl = fmt.length; break;
			case 3: return months[val.m-1][1];
			case 5: return months[val.m-1][0];
			default: return months[val.m-1][2];
		} break;
		case 100: /* 'd' day */
		switch(fmt.length) {
			case 1: case 2: out = val.d; outl = fmt.length; break;
			case 3: return days[val.q][0];
			default: return days[val.q][1];
		} break;
		case 104: /* 'h' 12-hour */
		switch(fmt.length) {
			case 1: case 2: out = 1+(val.H+11)%12; outl = fmt.length; break;
			default: throw 'bad hour format: ' + fmt;
		} break;
		case 72: /* 'H' 24-hour */
		switch(fmt.length) {
			case 1: case 2: out = val.H; outl = fmt.length; break;
			default: throw 'bad hour format: ' + fmt;
		} break;
		case 77: /* 'M' minutes */
		switch(fmt.length) {
			case 1: case 2: out = val.M; outl = fmt.length; break;
			default: throw 'bad minute format: ' + fmt;
		} break;
		case 115: /* 's' seconds */
			if(fmt != 's' && fmt != 'ss' && fmt != '.0' && fmt != '.00' && fmt != '.000') throw 'bad second format: ' + fmt;
			if(val.u === 0 && (fmt == "s" || fmt == "ss")) return pad0(val.S, fmt.length);
if(ss0 >= 2) tt = ss0 === 3 ? 1000 : 100;
			else tt = ss0 === 1 ? 10 : 1;
			ss = Math.round((tt)*(val.S + val.u));
			if(ss >= 60*tt) ss = 0;
			if(fmt === 's') return ss === 0 ? "0" : ""+ss/tt;
			o = pad0(ss,2 + ss0);
			if(fmt === 'ss') return o.substr(0,2);
			return "." + o.substr(2,fmt.length-1);
		case 90: /* 'Z' absolute time */
		switch(fmt) {
			case '[h]': case '[hh]': out = val.D*24+val.H; break;
			case '[m]': case '[mm]': out = (val.D*24+val.H)*60+val.M; break;
			case '[s]': case '[ss]': out = ((val.D*24+val.H)*60+val.M)*60+(ss0 == 0 ? Math.round(val.S+val.u) : val.S); break;
			default: throw 'bad abstime format: ' + fmt;
		} outl = fmt.length === 3 ? 1 : 2; break;
		case 101: /* 'e' era */
			out = y; outl = 1; break;
	}
	var outstr = outl > 0 ? pad0(out, outl) : "";
	return outstr;
}


/*jshint -W086 */
/*jshint +W086 */
function commaify(s) {
	var w = 3;
	if(s.length <= w) return s;
	var j = (s.length % w), o = s.substr(0,j);
	for(; j!=s.length; j+=w) o+=(o.length > 0 ? "," : "") + s.substr(j,w);
	return o;
}
var pct1 = /%/g;
function write_num_pct(type, fmt, val){
	var sfmt = fmt.replace(pct1,""), mul = fmt.length - sfmt.length;
	return write_num(type, sfmt, val * Math.pow(10,2*mul)) + fill("%",mul);
}

function write_num_cm(type, fmt, val){
	var idx = fmt.length - 1;
	while(fmt.charCodeAt(idx-1) === 44) --idx;
	return write_num(type, fmt.substr(0,idx), val / Math.pow(10,3*(fmt.length-idx)));
}

function write_num_exp(fmt, val){
	var o;
	var idx = fmt.indexOf("E") - fmt.indexOf(".") - 1;
	if(fmt.match(/^#+0.0E\+0$/)) {
		if(val == 0) return "0.0E+0";
		else if(val < 0) return "-" + write_num_exp(fmt, -val);
		var period = fmt.indexOf("."); if(period === -1) period=fmt.indexOf('E');
		var ee = Math.floor(Math.log(val)*Math.LOG10E)%period;
		if(ee < 0) ee += period;
		o = (val/Math.pow(10,ee)).toPrecision(idx+1+(period+ee)%period);
		if(o.indexOf("e") === -1) {
			var fakee = Math.floor(Math.log(val)*Math.LOG10E);
			if(o.indexOf(".") === -1) o = o.charAt(0) + "." + o.substr(1) + "E+" + (fakee - o.length+ee);
			else o += "E+" + (fakee - ee);
			while(o.substr(0,2) === "0.") {
				o = o.charAt(0) + o.substr(2,period) + "." + o.substr(2+period);
				o = o.replace(/^0+([1-9])/,"$1").replace(/^0+\./,"0.");
			}
			o = o.replace(/\+-/,"-");
		}
		o = o.replace(/^([+-]?)(\d*)\.(\d*)[Ee]/,function($$,$1,$2,$3) { return $1 + $2 + $3.substr(0,(period+ee)%period) + "." + $3.substr(ee) + "E"; });
	} else o = val.toExponential(idx);
	if(fmt.match(/E\+00$/) && o.match(/e[+-]\d$/)) o = o.substr(0,o.length-1) + "0" + o.charAt(o.length-1);
	if(fmt.match(/E\-/) && o.match(/e\+/)) o = o.replace(/e\+/,"e");
	return o.replace("e","E");
}
var frac1 = /# (\?+)( ?)\/( ?)(\d+)/;
function write_num_f1(r, aval, sign) {
	var den = parseInt(r[4],10), rr = Math.round(aval * den), base = Math.floor(rr/den);
	var myn = (rr - base*den), myd = den;
	return sign + (base === 0 ? "" : ""+base) + " " + (myn === 0 ? fill(" ", r[1].length + 1 + r[4].length) : pad_(myn,r[1].length) + r[2] + "/" + r[3] + pad0(myd,r[4].length));
}
function write_num_f2(r, aval, sign) {
	return sign + (aval === 0 ? "" : ""+aval) + fill(" ", r[1].length + 2 + r[4].length);
}
var dec1 = /^#*0*\.([0#]+)/;
var closeparen = /\)[^)]*[0#]/;
var phone = /\(###\) ###\\?-####/;
function hashq(str) {
	var o = "", cc;
	for(var i = 0; i != str.length; ++i) switch((cc=str.charCodeAt(i))) {
		case 35: break;
		case 63: o+= " "; break;
		case 48: o+= "0"; break;
		default: o+= String.fromCharCode(cc);
	}
	return o;
}
function rnd(val, d) { var dd = Math.pow(10,d); return ""+(Math.round(val * dd)/dd); }
function dec(val, d) {
	var _frac = val - Math.floor(val), dd = Math.pow(10,d);
	if (d < ('' + Math.round(_frac * dd)).length) return 0;
	return Math.round(_frac * dd);
}
function carry(val, d) {
	if (d < ('' + Math.round((val-Math.floor(val))*Math.pow(10,d))).length) {
		return 1;
	}
	return 0;
}
function flr(val) {
	if(val < 2147483647 && val > -2147483648) return ""+(val >= 0 ? (val|0) : (val-1|0));
	return ""+Math.floor(val);
}
function write_num_flt(type, fmt, val) {
	if(type.charCodeAt(0) === 40 && !fmt.match(closeparen)) {
		var ffmt = fmt.replace(/\( */,"").replace(/ \)/,"").replace(/\)/,"");
		if(val >= 0) return write_num_flt('n', ffmt, val);
		return '(' + write_num_flt('n', ffmt, -val) + ')';
	}
	if(fmt.charCodeAt(fmt.length - 1) === 44) return write_num_cm(type, fmt, val);
	if(fmt.indexOf('%') !== -1) return write_num_pct(type, fmt, val);
	if(fmt.indexOf('E') !== -1) return write_num_exp(fmt, val);
	if(fmt.charCodeAt(0) === 36) return "$"+write_num_flt(type,fmt.substr(fmt.charAt(1)==' '?2:1),val);
	var o;
	var r, ri, ff, aval = Math.abs(val), sign = val < 0 ? "-" : "";
	if(fmt.match(/^00+$/)) return sign + pad0r(aval,fmt.length);
	if(fmt.match(/^[#?]+$/)) {
		o = pad0r(val,0); if(o === "0") o = "";
		return o.length > fmt.length ? o : hashq(fmt.substr(0,fmt.length-o.length)) + o;
	}
	if((r = fmt.match(frac1))) return write_num_f1(r, aval, sign);
	if(fmt.match(/^#+0+$/)) return sign + pad0r(aval,fmt.length - fmt.indexOf("0"));
	if((r = fmt.match(dec1))) {
		o = rnd(val, r[1].length).replace(/^([^\.]+)$/,"$1."+hashq(r[1])).replace(/\.$/,"."+hashq(r[1])).replace(/\.(\d*)$/,function($$, $1) { return "." + $1 + fill("0", hashq(r[1]).length-$1.length); });
		return fmt.indexOf("0.") !== -1 ? o : o.replace(/^0\./,".");
	}
	fmt = fmt.replace(/^#+([0.])/, "$1");
	if((r = fmt.match(/^(0*)\.(#*)$/))) {
		return sign + rnd(aval, r[2].length).replace(/\.(\d*[1-9])0*$/,".$1").replace(/^(-?\d*)$/,"$1.").replace(/^0\./,r[1].length?"0.":".");
	}
	if((r = fmt.match(/^#{1,3},##0(\.?)$/))) return sign + commaify(pad0r(aval,0));
	if((r = fmt.match(/^#,##0\.([#0]*0)$/))) {
		return val < 0 ? "-" + write_num_flt(type, fmt, -val) : commaify(""+(Math.floor(val) + carry(val, r[1].length))) + "." + pad0(dec(val, r[1].length),r[1].length);
	}
	if((r = fmt.match(/^#,#*,#0/))) return write_num_flt(type,fmt.replace(/^#,#*,/,""),val);
	if((r = fmt.match(/^([0#]+)(\\?-([0#]+))+$/))) {
		o = _strrev(write_num_flt(type, fmt.replace(/[\\-]/g,""), val));
		ri = 0;
		return _strrev(_strrev(fmt.replace(/\\/g,"")).replace(/[0#]/g,function(x){return ri<o.length?o.charAt(ri++):x==='0'?'0':"";}));
	}
	if(fmt.match(phone)) {
		o = write_num_flt(type, "##########", val);
		return "(" + o.substr(0,3) + ") " + o.substr(3, 3) + "-" + o.substr(6);
	}
	var oa = "";
	if((r = fmt.match(/^([#0?]+)( ?)\/( ?)([#0?]+)/))) {
		ri = Math.min(r[4].length,7);
		ff = SSF_frac(aval, Math.pow(10,ri)-1, false);
		o = "" + sign;
		oa = write_num("n", r[1], ff[1]);
		if(oa.charAt(oa.length-1) == " ") oa = oa.substr(0,oa.length-1) + "0";
		o += oa + r[2] + "/" + r[3];
		oa = rpad_(ff[2],ri);
		if(oa.length < r[4].length) oa = hashq(r[4].substr(r[4].length-oa.length)) + oa;
		o += oa;
		return o;
	}
	if((r = fmt.match(/^# ([#0?]+)( ?)\/( ?)([#0?]+)/))) {
		ri = Math.min(Math.max(r[1].length, r[4].length),7);
		ff = SSF_frac(aval, Math.pow(10,ri)-1, true);
		return sign + (ff[0]||(ff[1] ? "" : "0")) + " " + (ff[1] ? pad_(ff[1],ri) + r[2] + "/" + r[3] + rpad_(ff[2],ri): fill(" ", 2*ri+1 + r[2].length + r[3].length));
	}
	if((r = fmt.match(/^[#0?]+$/))) {
		o = pad0r(val, 0);
		if(fmt.length <= o.length) return o;
		return hashq(fmt.substr(0,fmt.length-o.length)) + o;
	}
	if((r = fmt.match(/^([#0?]+)\.([#0]+)$/))) {
		o = "" + val.toFixed(Math.min(r[2].length,10)).replace(/([^0])0+$/,"$1");
		ri = o.indexOf(".");
		var lres = fmt.indexOf(".") - ri, rres = fmt.length - o.length - lres;
		return hashq(fmt.substr(0,lres) + o + fmt.substr(fmt.length-rres));
	}
	if((r = fmt.match(/^00,000\.([#0]*0)$/))) {
		ri = dec(val, r[1].length);
		return val < 0 ? "-" + write_num_flt(type, fmt, -val) : commaify(flr(val)).replace(/^\d,\d{3}$/,"0$&").replace(/^\d*$/,function($$) { return "00," + ($$.length < 3 ? pad0(0,3-$$.length) : "") + $$; }) + "." + pad0(ri,r[1].length);
	}
	switch(fmt) {
		case "###,##0.00": return write_num_flt(type, "#,##0.00", val);
		case "###,###":
		case "##,###":
		case "#,###": var x = commaify(pad0r(aval,0)); return x !== "0" ? sign + x : "";
		case "###,###.00": return write_num_flt(type, "###,##0.00",val).replace(/^0\./,".");
		case "#,###.00": return write_num_flt(type, "#,##0.00",val).replace(/^0\./,".");
		default:
	}
	throw new Error("unsupported format |" + fmt + "|");
}
function write_num_cm2(type, fmt, val){
	var idx = fmt.length - 1;
	while(fmt.charCodeAt(idx-1) === 44) --idx;
	return write_num(type, fmt.substr(0,idx), val / Math.pow(10,3*(fmt.length-idx)));
}
function write_num_pct2(type, fmt, val){
	var sfmt = fmt.replace(pct1,""), mul = fmt.length - sfmt.length;
	return write_num(type, sfmt, val * Math.pow(10,2*mul)) + fill("%",mul);
}
function write_num_exp2(fmt, val){
	var o;
	var idx = fmt.indexOf("E") - fmt.indexOf(".") - 1;
	if(fmt.match(/^#+0.0E\+0$/)) {
		if(val == 0) return "0.0E+0";
		else if(val < 0) return "-" + write_num_exp2(fmt, -val);
		var period = fmt.indexOf("."); if(period === -1) period=fmt.indexOf('E');
		var ee = Math.floor(Math.log(val)*Math.LOG10E)%period;
		if(ee < 0) ee += period;
		o = (val/Math.pow(10,ee)).toPrecision(idx+1+(period+ee)%period);
		if(!o.match(/[Ee]/)) {
			var fakee = Math.floor(Math.log(val)*Math.LOG10E);
			if(o.indexOf(".") === -1) o = o.charAt(0) + "." + o.substr(1) + "E+" + (fakee - o.length+ee);
			else o += "E+" + (fakee - ee);
			o = o.replace(/\+-/,"-");
		}
		o = o.replace(/^([+-]?)(\d*)\.(\d*)[Ee]/,function($$,$1,$2,$3) { return $1 + $2 + $3.substr(0,(period+ee)%period) + "." + $3.substr(ee) + "E"; });
	} else o = val.toExponential(idx);
	if(fmt.match(/E\+00$/) && o.match(/e[+-]\d$/)) o = o.substr(0,o.length-1) + "0" + o.charAt(o.length-1);
	if(fmt.match(/E\-/) && o.match(/e\+/)) o = o.replace(/e\+/,"e");
	return o.replace("e","E");
}
function write_num_int(type, fmt, val) {
	if(type.charCodeAt(0) === 40 && !fmt.match(closeparen)) {
		var ffmt = fmt.replace(/\( */,"").replace(/ \)/,"").replace(/\)/,"");
		if(val >= 0) return write_num_int('n', ffmt, val);
		return '(' + write_num_int('n', ffmt, -val) + ')';
	}
	if(fmt.charCodeAt(fmt.length - 1) === 44) return write_num_cm2(type, fmt, val);
	if(fmt.indexOf('%') !== -1) return write_num_pct2(type, fmt, val);
	if(fmt.indexOf('E') !== -1) return write_num_exp2(fmt, val);
	if(fmt.charCodeAt(0) === 36) return "$"+write_num_int(type,fmt.substr(fmt.charAt(1)==' '?2:1),val);
	var o;
	var r, ri, ff, aval = Math.abs(val), sign = val < 0 ? "-" : "";
	if(fmt.match(/^00+$/)) return sign + pad0(aval,fmt.length);
	if(fmt.match(/^[#?]+$/)) {
		o = (""+val); if(val === 0) o = "";
		return o.length > fmt.length ? o : hashq(fmt.substr(0,fmt.length-o.length)) + o;
	}
	if((r = fmt.match(frac1))) return write_num_f2(r, aval, sign);
	if(fmt.match(/^#+0+$/)) return sign + pad0(aval,fmt.length - fmt.indexOf("0"));
	if((r = fmt.match(dec1))) {
o = (""+val).replace(/^([^\.]+)$/,"$1."+hashq(r[1])).replace(/\.$/,"."+hashq(r[1]));
		o = o.replace(/\.(\d*)$/,function($$, $1) {
return "." + $1 + fill("0", hashq(r[1]).length-$1.length); });
		return fmt.indexOf("0.") !== -1 ? o : o.replace(/^0\./,".");
	}
	fmt = fmt.replace(/^#+([0.])/, "$1");
	if((r = fmt.match(/^(0*)\.(#*)$/))) {
		return sign + (""+aval).replace(/\.(\d*[1-9])0*$/,".$1").replace(/^(-?\d*)$/,"$1.").replace(/^0\./,r[1].length?"0.":".");
	}
	if((r = fmt.match(/^#{1,3},##0(\.?)$/))) return sign + commaify((""+aval));
	if((r = fmt.match(/^#,##0\.([#0]*0)$/))) {
		return val < 0 ? "-" + write_num_int(type, fmt, -val) : commaify((""+val)) + "." + fill('0',r[1].length);
	}
	if((r = fmt.match(/^#,#*,#0/))) return write_num_int(type,fmt.replace(/^#,#*,/,""),val);
	if((r = fmt.match(/^([0#]+)(\\?-([0#]+))+$/))) {
		o = _strrev(write_num_int(type, fmt.replace(/[\\-]/g,""), val));
		ri = 0;
		return _strrev(_strrev(fmt.replace(/\\/g,"")).replace(/[0#]/g,function(x){return ri<o.length?o.charAt(ri++):x==='0'?'0':"";}));
	}
	if(fmt.match(phone)) {
		o = write_num_int(type, "##########", val);
		return "(" + o.substr(0,3) + ") " + o.substr(3, 3) + "-" + o.substr(6);
	}
	var oa = "";
	if((r = fmt.match(/^([#0?]+)( ?)\/( ?)([#0?]+)/))) {
		ri = Math.min(r[4].length,7);
		ff = SSF_frac(aval, Math.pow(10,ri)-1, false);
		o = "" + sign;
		oa = write_num("n", r[1], ff[1]);
		if(oa.charAt(oa.length-1) == " ") oa = oa.substr(0,oa.length-1) + "0";
		o += oa + r[2] + "/" + r[3];
		oa = rpad_(ff[2],ri);
		if(oa.length < r[4].length) oa = hashq(r[4].substr(r[4].length-oa.length)) + oa;
		o += oa;
		return o;
	}
	if((r = fmt.match(/^# ([#0?]+)( ?)\/( ?)([#0?]+)/))) {
		ri = Math.min(Math.max(r[1].length, r[4].length),7);
		ff = SSF_frac(aval, Math.pow(10,ri)-1, true);
		return sign + (ff[0]||(ff[1] ? "" : "0")) + " " + (ff[1] ? pad_(ff[1],ri) + r[2] + "/" + r[3] + rpad_(ff[2],ri): fill(" ", 2*ri+1 + r[2].length + r[3].length));
	}
	if((r = fmt.match(/^[#0?]+$/))) {
		o = "" + val;
		if(fmt.length <= o.length) return o;
		return hashq(fmt.substr(0,fmt.length-o.length)) + o;
	}
	if((r = fmt.match(/^([#0]+)\.([#0]+)$/))) {
		o = "" + val.toFixed(Math.min(r[2].length,10)).replace(/([^0])0+$/,"$1");
		ri = o.indexOf(".");
		var lres = fmt.indexOf(".") - ri, rres = fmt.length - o.length - lres;
		return hashq(fmt.substr(0,lres) + o + fmt.substr(fmt.length-rres));
	}
	if((r = fmt.match(/^00,000\.([#0]*0)$/))) {
		return val < 0 ? "-" + write_num_int(type, fmt, -val) : commaify(""+val).replace(/^\d,\d{3}$/,"0$&").replace(/^\d*$/,function($$) { return "00," + ($$.length < 3 ? pad0(0,3-$$.length) : "") + $$; }) + "." + pad0(0,r[1].length);
	}
	switch(fmt) {
		case "###,###":
		case "##,###":
		case "#,###": var x = commaify(""+aval); return x !== "0" ? sign + x : "";
		default:
			if(fmt.match(/\.[0#?]*$/)) return write_num_int(type, fmt.slice(0,fmt.lastIndexOf(".")), val) + hashq(fmt.slice(fmt.lastIndexOf(".")));
	}
	throw new Error("unsupported format |" + fmt + "|");
}
function write_num(type, fmt, val) {
	return (val|0) === val ? write_num_int(type, fmt, val) : write_num_flt(type, fmt, val);
}
function SSF_split_fmt(fmt) {
	var out = [];
	var in_str = false/*, cc*/;
	for(var i = 0, j = 0; i < fmt.length; ++i) switch((/*cc=*/fmt.charCodeAt(i))) {
		case 34: /* '"' */
			in_str = !in_str; break;
		case 95: case 42: case 92: /* '_' '*' '\\' */
			++i; break;
		case 59: /* ';' */
			out[out.length] = fmt.substr(j,i-j);
			j = i+1;
	}
	out[out.length] = fmt.substr(j);
	if(in_str === true) throw new Error("Format |" + fmt + "| unterminated string ");
	return out;
}

var SSF_abstime = /\[[HhMmSs\u0E0A\u0E19\u0E17]*\]/;
function fmt_is_date(fmt) {
	var i = 0, /*cc = 0,*/ c = "", o = "";
	while(i < fmt.length) {
		switch((c = fmt.charAt(i))) {
			case 'G': if(SSF_isgeneral(fmt, i)) i+= 6; i++; break;
			case '"': for(;(/*cc=*/fmt.charCodeAt(++i)) !== 34 && i < fmt.length;){/*empty*/} ++i; break;
			case '\\': i+=2; break;
			case '_': i+=2; break;
			case '@': ++i; break;
			case 'B': case 'b':
				if(fmt.charAt(i+1) === "1" || fmt.charAt(i+1) === "2") return true;
				/* falls through */
			case 'M': case 'D': case 'Y': case 'H': case 'S': case 'E':
				/* falls through */
			case 'm': case 'd': case 'y': case 'h': case 's': case 'e': case 'g': return true;
			case 'A': case 'a': case '上':
				if(fmt.substr(i, 3).toUpperCase() === "A/P") return true;
				if(fmt.substr(i, 5).toUpperCase() === "AM/PM") return true;
				if(fmt.substr(i, 5).toUpperCase() === "上午/下午") return true;
				++i; break;
			case '[':
				o = c;
				while(fmt.charAt(i++) !== ']' && i < fmt.length) o += fmt.charAt(i);
				if(o.match(SSF_abstime)) return true;
				break;
			case '.':
				/* falls through */
			case '0': case '#':
				while(i < fmt.length && ("0#?.,E+-%".indexOf(c=fmt.charAt(++i)) > -1 || (c=='\\' && fmt.charAt(i+1) == "-" && "0#".indexOf(fmt.charAt(i+2))>-1))){/* empty */}
				break;
			case '?': while(fmt.charAt(++i) === c){/* empty */} break;
			case '*': ++i; if(fmt.charAt(i) == ' ' || fmt.charAt(i) == '*') ++i; break;
			case '(': case ')': ++i; break;
			case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
				while(i < fmt.length && "0123456789".indexOf(fmt.charAt(++i)) > -1){/* empty */} break;
			case ' ': ++i; break;
			default: ++i; break;
		}
	}
	return false;
}

function eval_fmt(fmt, v, opts, flen) {
	var out = [], o = "", i = 0, c = "", lst='t', dt, j, cc;
	var hr='H';
	/* Tokenize */
	while(i < fmt.length) {
		switch((c = fmt.charAt(i))) {
			case 'G': /* General */
				if(!SSF_isgeneral(fmt, i)) throw new Error('unrecognized character ' + c + ' in ' +fmt);
				out[out.length] = {t:'G', v:'General'}; i+=7; break;
			case '"': /* Literal text */
				for(o="";(cc=fmt.charCodeAt(++i)) !== 34 && i < fmt.length;) o += String.fromCharCode(cc);
				out[out.length] = {t:'t', v:o}; ++i; break;
			case '\\': var w = fmt.charAt(++i), t = (w === "(" || w === ")") ? w : 't';
				out[out.length] = {t:t, v:w}; ++i; break;
			case '_': out[out.length] = {t:'t', v:" "}; i+=2; break;
			case '@': /* Text Placeholder */
				out[out.length] = {t:'T', v:v}; ++i; break;
			case 'B': case 'b':
				if(fmt.charAt(i+1) === "1" || fmt.charAt(i+1) === "2") {
					if(dt==null) { dt=SSF_parse_date_code(v, opts, fmt.charAt(i+1) === "2"); if(dt==null) return ""; }
					out[out.length] = {t:'X', v:fmt.substr(i,2)}; lst = c; i+=2; break;
				}
				/* falls through */
			case 'M': case 'D': case 'Y': case 'H': case 'S': case 'E':
				c = c.toLowerCase();
				/* falls through */
			case 'm': case 'd': case 'y': case 'h': case 's': case 'e': case 'g':
				if(v < 0) return "";
				if(dt==null) { dt=SSF_parse_date_code(v, opts); if(dt==null) return ""; }
				o = c; while(++i < fmt.length && fmt.charAt(i).toLowerCase() === c) o+=c;
				if(c === 'm' && lst.toLowerCase() === 'h') c = 'M';
				if(c === 'h') c = hr;
				out[out.length] = {t:c, v:o}; lst = c; break;
			case 'A': case 'a': case '上':
				var q={t:c, v:c};
				if(dt==null) dt=SSF_parse_date_code(v, opts);
				if(fmt.substr(i, 3).toUpperCase() === "A/P") { if(dt!=null) q.v = dt.H >= 12 ? fmt.charAt(i+2) : c; q.t = 'T'; hr='h';i+=3;}
				else if(fmt.substr(i,5).toUpperCase() === "AM/PM") { if(dt!=null) q.v = dt.H >= 12 ? "PM" : "AM"; q.t = 'T'; i+=5; hr='h'; }
				else if(fmt.substr(i,5).toUpperCase() === "上午/下午") { if(dt!=null) q.v = dt.H >= 12 ? "下午" : "上午"; q.t = 'T'; i+=5; hr='h'; }
				else { q.t = "t"; ++i; }
				if(dt==null && q.t === 'T') return "";
				out[out.length] = q; lst = c; break;
			case '[':
				o = c;
				while(fmt.charAt(i++) !== ']' && i < fmt.length) o += fmt.charAt(i);
				if(o.slice(-1) !== ']') throw 'unterminated "[" block: |' + o + '|';
				if(o.match(SSF_abstime)) {
					if(dt==null) { dt=SSF_parse_date_code(v, opts); if(dt==null) return ""; }
					out[out.length] = {t:'Z', v:o.toLowerCase()};
					lst = o.charAt(1);
				} else if(o.indexOf("$") > -1) {
					o = (o.match(/\$([^-\[\]]*)/)||[])[1]||"$";
					if(!fmt_is_date(fmt)) out[out.length] = {t:'t',v:o};
				}
				break;
			/* Numbers */
			case '.':
				if(dt != null) {
					o = c; while(++i < fmt.length && (c=fmt.charAt(i)) === "0") o += c;
					out[out.length] = {t:'s', v:o}; break;
				}
				/* falls through */
			case '0': case '#':
				o = c; while(++i < fmt.length && "0#?.,E+-%".indexOf(c=fmt.charAt(i)) > -1) o += c;
				out[out.length] = {t:'n', v:o}; break;
			case '?':
				o = c; while(fmt.charAt(++i) === c) o+=c;
				out[out.length] = {t:c, v:o}; lst = c; break;
			case '*': ++i; if(fmt.charAt(i) == ' ' || fmt.charAt(i) == '*') ++i; break; // **
			case '(': case ')': out[out.length] = {t:(flen===1?'t':c), v:c}; ++i; break;
			case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
				o = c; while(i < fmt.length && "0123456789".indexOf(fmt.charAt(++i)) > -1) o+=fmt.charAt(i);
				out[out.length] = {t:'D', v:o}; break;
			case ' ': out[out.length] = {t:c, v:c}; ++i; break;
			case '$': out[out.length] = {t:'t', v:'$'}; ++i; break;
			default:
				if(",$-+/():!^&'~{}<>=€acfijklopqrtuvwxzP".indexOf(c) === -1) throw new Error('unrecognized character ' + c + ' in ' + fmt);
				out[out.length] = {t:'t', v:c}; ++i; break;
		}
	}

	/* Scan for date/time parts */
	var bt = 0, ss0 = 0, ssm;
	for(i=out.length-1, lst='t'; i >= 0; --i) {
		switch(out[i].t) {
			case 'h': case 'H': out[i].t = hr; lst='h'; if(bt < 1) bt = 1; break;
			case 's':
				if((ssm=out[i].v.match(/\.0+$/))) { ss0=Math.max(ss0,ssm[0].length-1); bt = 4;}
				if(bt < 3) bt = 3;
			/* falls through */
			case 'd': case 'y': case 'e': lst=out[i].t; break;
			case 'M': lst=out[i].t; if(bt < 2) bt = 2; break;
			case 'm': if(lst === 's') { out[i].t = 'M'; if(bt < 2) bt = 2; } break;
			case 'X': /*if(out[i].v === "B2");*/
				break;
			case 'Z':
				if(bt < 1 && out[i].v.match(/[Hh]/)) bt = 1;
				if(bt < 2 && out[i].v.match(/[Mm]/)) bt = 2;
				if(bt < 3 && out[i].v.match(/[Ss]/)) bt = 3;
		}
	}

	/* time rounding depends on presence of minute / second / usec fields */
	var _dt;
	switch(bt) {
		case 0: break;
		case 1:
		case 2:
		case 3:
			if(dt.u >= 0.5) { dt.u = 0; ++dt.S; }
			if(dt.S >=  60) { dt.S = 0; ++dt.M; }
			if(dt.M >=  60) { dt.M = 0; ++dt.H; }
			if(dt.H >=  24) { dt.H = 0; ++dt.D; _dt = SSF_parse_date_code(dt.D); _dt.u = dt.u; _dt.S = dt.S; _dt.M = dt.M; _dt.H = dt.H; dt = _dt; }
			break;
		case 4:
			switch(ss0) {
				case 1: dt.u = Math.round(dt.u * 10)/10; break;
				case 2: dt.u = Math.round(dt.u * 100)/100; break;
				case 3: dt.u = Math.round(dt.u * 1000)/1000; break;
			}
			if(dt.u >=   1) { dt.u = 0; ++dt.S; }
			if(dt.S >=  60) { dt.S = 0; ++dt.M; }
			if(dt.M >=  60) { dt.M = 0; ++dt.H; }
			if(dt.H >=  24) { dt.H = 0; ++dt.D; _dt = SSF_parse_date_code(dt.D); _dt.u = dt.u; _dt.S = dt.S; _dt.M = dt.M; _dt.H = dt.H; dt = _dt; }
			break;
	}

	/* replace fields */
	var nstr = "", jj;
	for(i=0; i < out.length; ++i) {
		switch(out[i].t) {
			case 't': case 'T': case ' ': case 'D': break;
			case 'X': out[i].v = ""; out[i].t = ";"; break;
			case 'd': case 'm': case 'y': case 'h': case 'H': case 'M': case 's': case 'e': case 'b': case 'Z':
out[i].v = SSF_write_date(out[i].t.charCodeAt(0), out[i].v, dt, ss0);
				out[i].t = 't'; break;
			case 'n': case '?':
				jj = i+1;
				while(out[jj] != null && (
					(c=out[jj].t) === "?" || c === "D" ||
					((c === " " || c === "t") && out[jj+1] != null && (out[jj+1].t === '?' || out[jj+1].t === "t" && out[jj+1].v === '/')) ||
					(out[i].t === '(' && (c === ' ' || c === 'n' || c === ')')) ||
					(c === 't' && (out[jj].v === '/' || out[jj].v === ' ' && out[jj+1] != null && out[jj+1].t == '?'))
				)) {
					out[i].v += out[jj].v;
					out[jj] = {v:"", t:";"}; ++jj;
				}
				nstr += out[i].v;
				i = jj-1; break;
			case 'G': out[i].t = 't'; out[i].v = SSF_general(v,opts); break;
		}
	}
	var vv = "", myv, ostr;
	if(nstr.length > 0) {
		if(nstr.charCodeAt(0) == 40) /* '(' */ {
			myv = (v<0&&nstr.charCodeAt(0) === 45 ? -v : v);
			ostr = write_num('n', nstr, myv);
		} else {
			myv = (v<0 && flen > 1 ? -v : v);
			ostr = write_num('n', nstr, myv);
			if(myv < 0 && out[0] && out[0].t == 't') {
				ostr = ostr.substr(1);
				out[0].v = "-" + out[0].v;
			}
		}
		jj=ostr.length-1;
		var decpt = out.length;
		for(i=0; i < out.length; ++i) if(out[i] != null && out[i].t != 't' && out[i].v.indexOf(".") > -1) { decpt = i; break; }
		var lasti=out.length;
		if(decpt === out.length && ostr.indexOf("E") === -1) {
			for(i=out.length-1; i>= 0;--i) {
				if(out[i] == null || 'n?'.indexOf(out[i].t) === -1) continue;
				if(jj>=out[i].v.length-1) { jj -= out[i].v.length; out[i].v = ostr.substr(jj+1, out[i].v.length); }
				else if(jj < 0) out[i].v = "";
				else { out[i].v = ostr.substr(0, jj+1); jj = -1; }
				out[i].t = 't';
				lasti = i;
			}
			if(jj>=0 && lasti<out.length) out[lasti].v = ostr.substr(0,jj+1) + out[lasti].v;
		}
		else if(decpt !== out.length && ostr.indexOf("E") === -1) {
			jj = ostr.indexOf(".")-1;
			for(i=decpt; i>= 0; --i) {
				if(out[i] == null || 'n?'.indexOf(out[i].t) === -1) continue;
				j=out[i].v.indexOf(".")>-1&&i===decpt?out[i].v.indexOf(".")-1:out[i].v.length-1;
				vv = out[i].v.substr(j+1);
				for(; j>=0; --j) {
					if(jj>=0 && (out[i].v.charAt(j) === "0" || out[i].v.charAt(j) === "#")) vv = ostr.charAt(jj--) + vv;
				}
				out[i].v = vv;
				out[i].t = 't';
				lasti = i;
			}
			if(jj>=0 && lasti<out.length) out[lasti].v = ostr.substr(0,jj+1) + out[lasti].v;
			jj = ostr.indexOf(".")+1;
			for(i=decpt; i<out.length; ++i) {
				if(out[i] == null || ('n?('.indexOf(out[i].t) === -1 && i !== decpt)) continue;
				j=out[i].v.indexOf(".")>-1&&i===decpt?out[i].v.indexOf(".")+1:0;
				vv = out[i].v.substr(0,j);
				for(; j<out[i].v.length; ++j) {
					if(jj<ostr.length) vv += ostr.charAt(jj++);
				}
				out[i].v = vv;
				out[i].t = 't';
				lasti = i;
			}
		}
	}
	for(i=0; i<out.length; ++i) if(out[i] != null && 'n?'.indexOf(out[i].t)>-1) {
		myv = (flen >1 && v < 0 && i>0 && out[i-1].v === "-" ? -v:v);
		out[i].v = write_num(out[i].t, out[i].v, myv);
		out[i].t = 't';
	}
	var retval = "";
	for(i=0; i !== out.length; ++i) if(out[i] != null) retval += out[i].v;
	return retval;
}

var cfregex2 = /\[(=|>[=]?|<[>=]?)(-?\d+(?:\.\d*)?)\]/;
function chkcond(v, rr) {
	if(rr == null) return false;
	var thresh = parseFloat(rr[2]);
	switch(rr[1]) {
		case "=":  if(v == thresh) return true; break;
		case ">":  if(v >  thresh) return true; break;
		case "<":  if(v <  thresh) return true; break;
		case "<>": if(v != thresh) return true; break;
		case ">=": if(v >= thresh) return true; break;
		case "<=": if(v <= thresh) return true; break;
	}
	return false;
}
function choose_fmt(f, v) {
	var fmt = SSF_split_fmt(f);
	var l = fmt.length, lat = fmt[l-1].indexOf("@");
	if(l<4 && lat>-1) --l;
	if(fmt.length > 4) throw new Error("cannot find right format for |" + fmt.join("|") + "|");
	if(typeof v !== "number") return [4, fmt.length === 4 || lat>-1?fmt[fmt.length-1]:"@"];
	/* NOTE: most spreadsheet software do not support NaN or infinities */
	if(typeof v === "number" && !isFinite(v)) v = 0;
	switch(fmt.length) {
		case 1: fmt = lat>-1 ? ["General", "General", "General", fmt[0]] : [fmt[0], fmt[0], fmt[0], "@"]; break;
		case 2: fmt = lat>-1 ? [fmt[0], fmt[0], fmt[0], fmt[1]] : [fmt[0], fmt[1], fmt[0], "@"]; break;
		case 3: fmt = lat>-1 ? [fmt[0], fmt[1], fmt[0], fmt[2]] : [fmt[0], fmt[1], fmt[2], "@"]; break;
		case 4: break;
	}
	var ff = v > 0 ? fmt[0] : v < 0 ? fmt[1] : fmt[2];
	if(fmt[0].indexOf("[") === -1 && fmt[1].indexOf("[") === -1) return [l, ff];
	if(fmt[0].match(/\[[=<>]/) != null || fmt[1].match(/\[[=<>]/) != null) {
		var m1 = fmt[0].match(cfregex2);
		var m2 = fmt[1].match(cfregex2);
		return chkcond(v, m1) ? [l, fmt[0]] : chkcond(v, m2) ? [l, fmt[1]] : [l, fmt[m1 != null && m2 != null ? 2 : 1]];
	}
	return [l, ff];
}
function SSF_format(fmt,v,o) {
	if(o == null) o = {};
	var sfmt = "";
	switch(typeof fmt) {
		case "string":
			if(fmt == "m/d/yy" && o.dateNF) sfmt = o.dateNF;
			else sfmt = fmt;
			break;
		case "number":
			if(fmt == 14 && o.dateNF) sfmt = o.dateNF;
			else sfmt = (o.table != null ? (o.table) : table_fmt)[fmt];
			if(sfmt == null) sfmt = (o.table && o.table[SSF_default_map[fmt]]) || table_fmt[SSF_default_map[fmt]];
			if(sfmt == null) sfmt = SSF_default_str[fmt] || "General";
			break;
	}
	if(SSF_isgeneral(sfmt,0)) return SSF_general(v, o);
	if(v instanceof Date) v = datenum(v, o.date1904);
	var f = choose_fmt(sfmt, v);
	if(SSF_isgeneral(f[1])) return SSF_general(v, o);
	if(v === true) v = "TRUE"; else if(v === false) v = "FALSE";
	else if(v === "" || v == null) return "";
	else if(isNaN(v) && f[1].indexOf("0") > -1) return "#NUM!";
	else if(!isFinite(v) && f[1].indexOf("0") > -1) return "#DIV/0!";
	return eval_fmt(f[1], v, o, f[0]);
}
function SSF_load(fmt, idx) {
	if(typeof idx != 'number') {
		idx = +idx || -1;
for(var i = 0; i < 0x0188; ++i) {
if(table_fmt[i] == undefined) { if(idx < 0) idx = i; continue; }
			if(table_fmt[i] == fmt) { idx = i; break; }
		}
if(idx < 0) idx = 0x187;
	}
table_fmt[idx] = fmt;
	return idx;
}
function SSF_load_table(tbl) {
	for(var i=0; i!=0x0188; ++i)
		if(tbl[i] !== undefined) SSF_load(tbl[i], i);
}

function make_ssf() {
	table_fmt = SSF_init_table();
}

var SSF = {
	format: SSF_format,
	load: SSF_load,
	_table: table_fmt,
	load_table: SSF_load_table,
	parse_date_code: SSF_parse_date_code,
	is_date: fmt_is_date,
	get_table: function get_table() { return SSF._table = table_fmt; }
};

var SSFImplicit/*{[number]:string}*/ = ({
	"5": '"$"#,##0_);\\("$"#,##0\\)',
	"6": '"$"#,##0_);[Red]\\("$"#,##0\\)',
	"7": '"$"#,##0.00_);\\("$"#,##0.00\\)',
	"8": '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
	"23": 'General', "24": 'General', "25": 'General', "26": 'General',
	"27": 'm/d/yy', "28": 'm/d/yy', "29": 'm/d/yy', "30": 'm/d/yy', "31": 'm/d/yy',
	"32": 'h:mm:ss', "33": 'h:mm:ss', "34": 'h:mm:ss', "35": 'h:mm:ss',
	"36": 'm/d/yy',
	"41": '_(* #,##0_);_(* \(#,##0\);_(* "-"_);_(@_)',
	"42": '_("$"* #,##0_);_("$"* \(#,##0\);_("$"* "-"_);_(@_)',
	"43": '_(* #,##0.00_);_(* \(#,##0.00\);_(* "-"??_);_(@_)',
	"44": '_("$"* #,##0.00_);_("$"* \(#,##0.00\);_("$"* "-"??_);_(@_)',
	"50": 'm/d/yy', "51": 'm/d/yy', "52": 'm/d/yy', "53": 'm/d/yy', "54": 'm/d/yy',
	"55": 'm/d/yy', "56": 'm/d/yy', "57": 'm/d/yy', "58": 'm/d/yy',
	"59": '0',
	"60": '0.00',
	"61": '#,##0',
	"62": '#,##0.00',
	"63": '"$"#,##0_);\\("$"#,##0\\)',
	"64": '"$"#,##0_);[Red]\\("$"#,##0\\)',
	"65": '"$"#,##0.00_);\\("$"#,##0.00\\)',
	"66": '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
	"67": '0%',
	"68": '0.00%',
	"69": '# ?/?',
	"70": '# ??/??',
	"71": 'm/d/yy',
	"72": 'm/d/yy',
	"73": 'd-mmm-yy',
	"74": 'd-mmm',
	"75": 'mmm-yy',
	"76": 'h:mm',
	"77": 'h:mm:ss',
	"78": 'm/d/yy h:mm',
	"79": 'mm:ss',
	"80": '[h]:mm:ss',
	"81": 'mmss.0'
});

/* dateNF parse TODO: move to SSF */
var dateNFregex = /[dD]+|[mM]+|[yYeE]+|[Hh]+|[Ss]+/g;
function dateNF_regex(dateNF) {
	var fmt = typeof dateNF == "number" ? table_fmt[dateNF] : dateNF;
	fmt = fmt.replace(dateNFregex, "(\\d+)");
	dateNFregex.lastIndex = 0;
	return new RegExp("^" + fmt + "$");
}
function dateNF_fix(str, dateNF, match) {
	var Y = -1, m = -1, d = -1, H = -1, M = -1, S = -1;
	(dateNF.match(dateNFregex)||[]).forEach(function(n, i) {
		var v = parseInt(match[i+1], 10);
		switch(n.toLowerCase().charAt(0)) {
			case 'y': Y = v; break; case 'd': d = v; break;
			case 'h': H = v; break; case 's': S = v; break;
			case 'm': if(H >= 0) M = v; else m = v; break;
		}
	});
	dateNFregex.lastIndex = 0;
	if(S >= 0 && M == -1 && m >= 0) { M = m; m = -1; }
	var datestr = (("" + (Y>=0?Y: new Date().getFullYear())).slice(-4) + "-" + ("00" + (m>=1?m:1)).slice(-2) + "-" + ("00" + (d>=1?d:1)).slice(-2));
	if(datestr.length == 7) datestr = "0" + datestr;
	if(datestr.length == 8) datestr = "20" + datestr;
	var timestr = (("00" + (H>=0?H:0)).slice(-2) + ":" + ("00" + (M>=0?M:0)).slice(-2) + ":" + ("00" + (S>=0?S:0)).slice(-2));
	if(H == -1 && M == -1 && S == -1) return datestr;
	if(Y == -1 && m == -1 && d == -1) return timestr;
	return datestr + "T" + timestr;
}

/* table of bad formats written by third-party tools */
var bad_formats = {
	"d.m": "d\\.m" // Issue #2571 Google Sheets writes invalid format 'd.m', correct format is 'd"."m' or 'd\\.m'
};

function SSF__load(fmt, idx) {
	return SSF_load(bad_formats[fmt] || fmt, idx);
}

/* cfb.js (C) 2013-present SheetJS -- http://sheetjs.com */
/* vim: set ts=2: */
/*jshint eqnull:true */
/*exported CFB */
/*global Uint8Array:false, Uint16Array:false */

/* crc32.js (C) 2014-present SheetJS -- http://sheetjs.com */
/* vim: set ts=2: */
/*exported CRC32 */
var CRC32 = (function() {
var CRC32 = {};
CRC32.version = '1.2.0';
/*global Int32Array */
function signed_crc_table() {
	var c = 0, table = new Array(256);

	for(var n =0; n != 256; ++n){
		c = n;
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		table[n] = c;
	}

	return typeof Int32Array !== 'undefined' ? new Int32Array(table) : table;
}

var T0 = signed_crc_table();
function slice_by_16_tables(T) {
	var c = 0, v = 0, n = 0, table = typeof Int32Array !== 'undefined' ? new Int32Array(4096) : new Array(4096) ;

	for(n = 0; n != 256; ++n) table[n] = T[n];
	for(n = 0; n != 256; ++n) {
		v = T[n];
		for(c = 256 + n; c < 4096; c += 256) v = table[c] = (v >>> 8) ^ T[v & 0xFF];
	}
	var out = [];
	for(n = 1; n != 16; ++n) out[n - 1] = typeof Int32Array !== 'undefined' && typeof table.subarray == "function" ? table.subarray(n * 256, n * 256 + 256) : table.slice(n * 256, n * 256 + 256);
	return out;
}
var TT = slice_by_16_tables(T0);
var T1 = TT[0],  T2 = TT[1],  T3 = TT[2],  T4 = TT[3],  T5 = TT[4];
var T6 = TT[5],  T7 = TT[6],  T8 = TT[7],  T9 = TT[8],  Ta = TT[9];
var Tb = TT[10], Tc = TT[11], Td = TT[12], Te = TT[13], Tf = TT[14];
function crc32_bstr(bstr, seed) {
	var C = seed ^ -1;
	for(var i = 0, L = bstr.length; i < L;) C = (C>>>8) ^ T0[(C^bstr.charCodeAt(i++))&0xFF];
	return ~C;
}

function crc32_buf(B, seed) {
	var C = seed ^ -1, L = B.length - 15, i = 0;
	for(; i < L;) C =
		Tf[B[i++] ^ (C & 255)] ^
		Te[B[i++] ^ ((C >> 8) & 255)] ^
		Td[B[i++] ^ ((C >> 16) & 255)] ^
		Tc[B[i++] ^ (C >>> 24)] ^
		Tb[B[i++]] ^ Ta[B[i++]] ^ T9[B[i++]] ^ T8[B[i++]] ^
		T7[B[i++]] ^ T6[B[i++]] ^ T5[B[i++]] ^ T4[B[i++]] ^
		T3[B[i++]] ^ T2[B[i++]] ^ T1[B[i++]] ^ T0[B[i++]];
	L += 15;
	while(i < L) C = (C>>>8) ^ T0[(C^B[i++])&0xFF];
	return ~C;
}

function crc32_str(str, seed) {
	var C = seed ^ -1;
	for(var i = 0, L = str.length, c = 0, d = 0; i < L;) {
		c = str.charCodeAt(i++);
		if(c < 0x80) {
			C = (C>>>8) ^ T0[(C^c)&0xFF];
		} else if(c < 0x800) {
			C = (C>>>8) ^ T0[(C ^ (192|((c>>6)&31)))&0xFF];
			C = (C>>>8) ^ T0[(C ^ (128|(c&63)))&0xFF];
		} else if(c >= 0xD800 && c < 0xE000) {
			c = (c&1023)+64; d = str.charCodeAt(i++)&1023;
			C = (C>>>8) ^ T0[(C ^ (240|((c>>8)&7)))&0xFF];
			C = (C>>>8) ^ T0[(C ^ (128|((c>>2)&63)))&0xFF];
			C = (C>>>8) ^ T0[(C ^ (128|((d>>6)&15)|((c&3)<<4)))&0xFF];
			C = (C>>>8) ^ T0[(C ^ (128|(d&63)))&0xFF];
		} else {
			C = (C>>>8) ^ T0[(C ^ (224|((c>>12)&15)))&0xFF];
			C = (C>>>8) ^ T0[(C ^ (128|((c>>6)&63)))&0xFF];
			C = (C>>>8) ^ T0[(C ^ (128|(c&63)))&0xFF];
		}
	}
	return ~C;
}
CRC32.table = T0;
CRC32.bstr = crc32_bstr;
CRC32.buf = crc32_buf;
CRC32.str = crc32_str;
return CRC32;
})();
/* [MS-CFB] v20171201 */
var CFB = (function _CFB(){
var exports = {};
exports.version = '1.2.2';
/* [MS-CFB] 2.6.4 */
function namecmp(l, r) {
	var L = l.split("/"), R = r.split("/");
	for(var i = 0, c = 0, Z = Math.min(L.length, R.length); i < Z; ++i) {
		if((c = L[i].length - R[i].length)) return c;
		if(L[i] != R[i]) return L[i] < R[i] ? -1 : 1;
	}
	return L.length - R.length;
}
function dirname(p) {
	if(p.charAt(p.length - 1) == "/") return (p.slice(0,-1).indexOf("/") === -1) ? p : dirname(p.slice(0, -1));
	var c = p.lastIndexOf("/");
	return (c === -1) ? p : p.slice(0, c+1);
}

function filename(p) {
	if(p.charAt(p.length - 1) == "/") return filename(p.slice(0, -1));
	var c = p.lastIndexOf("/");
	return (c === -1) ? p : p.slice(c+1);
}
/* -------------------------------------------------------------------------- */
/* DOS Date format:
   high|YYYYYYYm.mmmddddd.HHHHHMMM.MMMSSSSS|low
   add 1980 to stored year
   stored second should be doubled
*/

/* write JS date to buf as a DOS date */
function write_dos_date(buf, date) {
	if(typeof date === "string") date = new Date(date);
	var hms = date.getHours();
	hms = hms << 6 | date.getMinutes();
	hms = hms << 5 | (date.getSeconds()>>>1);
	buf.write_shift(2, hms);
	var ymd = (date.getFullYear() - 1980);
	ymd = ymd << 4 | (date.getMonth()+1);
	ymd = ymd << 5 | date.getDate();
	buf.write_shift(2, ymd);
}

/* read four bytes from buf and interpret as a DOS date */
function parse_dos_date(buf) {
	var hms = buf.read_shift(2) & 0xFFFF;
	var ymd = buf.read_shift(2) & 0xFFFF;
	var val = new Date();
	var d = ymd & 0x1F; ymd >>>= 5;
	var m = ymd & 0x0F; ymd >>>= 4;
	val.setMilliseconds(0);
	val.setFullYear(ymd + 1980);
	val.setMonth(m-1);
	val.setDate(d);
	var S = hms & 0x1F; hms >>>= 5;
	var M = hms & 0x3F; hms >>>= 6;
	val.setHours(hms);
	val.setMinutes(M);
	val.setSeconds(S<<1);
	return val;
}
function parse_extra_field(blob) {
	prep_blob(blob, 0);
	var o = {};
	var flags = 0;
	while(blob.l <= blob.length - 4) {
		var type = blob.read_shift(2);
		var sz = blob.read_shift(2), tgt = blob.l + sz;
		var p = {};
		switch(type) {
			/* UNIX-style Timestamps */
			case 0x5455: {
				flags = blob.read_shift(1);
				if(flags & 1) p.mtime = blob.read_shift(4);
				/* for some reason, CD flag corresponds to LFH */
				if(sz > 5) {
					if(flags & 2) p.atime = blob.read_shift(4);
					if(flags & 4) p.ctime = blob.read_shift(4);
				}
				if(p.mtime) p.mt = new Date(p.mtime*1000);
			} break;
			/* ZIP64 Extended Information Field */
			case 0x0001: {
				var sz1 = blob.read_shift(4), sz2 = blob.read_shift(4);
				p.usz = (sz2 * Math.pow(2,32) + sz1);
				sz1 = blob.read_shift(4); sz2 = blob.read_shift(4);
				p.csz = (sz2 * Math.pow(2,32) + sz1);
				// NOTE: volume fields are skipped
			} break;
		}
		blob.l = tgt;
		o[type] = p;
	}
	return o;
}
var fs;
function get_fs() { return fs || (fs = _fs); }
function parse(file, options) {
if(file[0] == 0x50 && file[1] == 0x4b) return parse_zip(file, options);
if((file[0] | 0x20) == 0x6d && (file[1]|0x20) == 0x69) return parse_mad(file, options);
if(file.length < 512) throw new Error("CFB file size " + file.length + " < 512");
var mver = 3;
var ssz = 512;
var nmfs = 0; // number of mini FAT sectors
var difat_sec_cnt = 0;
var dir_start = 0;
var minifat_start = 0;
var difat_start = 0;

var fat_addrs = []; // locations of FAT sectors

/* [MS-CFB] 2.2 Compound File Header */
var blob = file.slice(0,512);
prep_blob(blob, 0);

/* major version */
var mv = check_get_mver(blob);
mver = mv[0];
switch(mver) {
	case 3: ssz = 512; break; case 4: ssz = 4096; break;
	case 0: if(mv[1] == 0) return parse_zip(file, options);
	/* falls through */
	default: throw new Error("Major Version: Expected 3 or 4 saw " + mver);
}

/* reprocess header */
if(ssz !== 512) { blob = file.slice(0,ssz); prep_blob(blob, 28 /* blob.l */); }
/* Save header for final object */
var header = file.slice(0,ssz);

check_shifts(blob, mver);

// Number of Directory Sectors
var dir_cnt = blob.read_shift(4, 'i');
if(mver === 3 && dir_cnt !== 0) throw new Error('# Directory Sectors: Expected 0 saw ' + dir_cnt);

// Number of FAT Sectors
blob.l += 4;

// First Directory Sector Location
dir_start = blob.read_shift(4, 'i');

// Transaction Signature
blob.l += 4;

// Mini Stream Cutoff Size
blob.chk('00100000', 'Mini Stream Cutoff Size: ');

// First Mini FAT Sector Location
minifat_start = blob.read_shift(4, 'i');

// Number of Mini FAT Sectors
nmfs = blob.read_shift(4, 'i');

// First DIFAT sector location
difat_start = blob.read_shift(4, 'i');

// Number of DIFAT Sectors
difat_sec_cnt = blob.read_shift(4, 'i');

// Grab FAT Sector Locations
for(var q = -1, j = 0; j < 109; ++j) { /* 109 = (512 - blob.l)>>>2; */
	q = blob.read_shift(4, 'i');
	if(q<0) break;
	fat_addrs[j] = q;
}

/** Break the file up into sectors */
var sectors = sectorify(file, ssz);

sleuth_fat(difat_start, difat_sec_cnt, sectors, ssz, fat_addrs);

/** Chains */
var sector_list = make_sector_list(sectors, dir_start, fat_addrs, ssz);

if(dir_start < sector_list.length) sector_list[dir_start].name = "!Directory";
if(nmfs > 0 && minifat_start !== ENDOFCHAIN) sector_list[minifat_start].name = "!MiniFAT";
sector_list[fat_addrs[0]].name = "!FAT";
sector_list.fat_addrs = fat_addrs;
sector_list.ssz = ssz;

/* [MS-CFB] 2.6.1 Compound File Directory Entry */
var files = {}, Paths = [], FileIndex = [], FullPaths = [];
read_directory(dir_start, sector_list, sectors, Paths, nmfs, files, FileIndex, minifat_start);

build_full_paths(FileIndex, FullPaths, Paths);
Paths.shift();

var o = {
	FileIndex: FileIndex,
	FullPaths: FullPaths
};

// $FlowIgnore
if(options && options.raw) o.raw = {header: header, sectors: sectors};
return o;
} // parse

/* [MS-CFB] 2.2 Compound File Header -- read up to major version */
function check_get_mver(blob) {
	if(blob[blob.l] == 0x50 && blob[blob.l + 1] == 0x4b) return [0, 0];
	// header signature 8
	blob.chk(HEADER_SIGNATURE, 'Header Signature: ');

	// clsid 16
	//blob.chk(HEADER_CLSID, 'CLSID: ');
	blob.l += 16;

	// minor version 2
	var mver = blob.read_shift(2, 'u');

	return [blob.read_shift(2,'u'), mver];
}
function check_shifts(blob, mver) {
	var shift = 0x09;

	// Byte Order
	//blob.chk('feff', 'Byte Order: '); // note: some writers put 0xffff
	blob.l += 2;

	// Sector Shift
	switch((shift = blob.read_shift(2))) {
		case 0x09: if(mver != 3) throw new Error('Sector Shift: Expected 9 saw ' + shift); break;
		case 0x0c: if(mver != 4) throw new Error('Sector Shift: Expected 12 saw ' + shift); break;
		default: throw new Error('Sector Shift: Expected 9 or 12 saw ' + shift);
	}

	// Mini Sector Shift
	blob.chk('0600', 'Mini Sector Shift: ');

	// Reserved
	blob.chk('000000000000', 'Reserved: ');
}

/** Break the file up into sectors */
function sectorify(file, ssz) {
	var nsectors = Math.ceil(file.length/ssz)-1;
	var sectors = [];
	for(var i=1; i < nsectors; ++i) sectors[i-1] = file.slice(i*ssz,(i+1)*ssz);
	sectors[nsectors-1] = file.slice(nsectors*ssz);
	return sectors;
}

/* [MS-CFB] 2.6.4 Red-Black Tree */
function build_full_paths(FI, FP, Paths) {
	var i = 0, L = 0, R = 0, C = 0, j = 0, pl = Paths.length;
	var dad = [], q = [];

	for(; i < pl; ++i) { dad[i]=q[i]=i; FP[i]=Paths[i]; }

	for(; j < q.length; ++j) {
		i = q[j];
		L = FI[i].L; R = FI[i].R; C = FI[i].C;
		if(dad[i] === i) {
			if(L !== -1 /*NOSTREAM*/ && dad[L] !== L) dad[i] = dad[L];
			if(R !== -1 && dad[R] !== R) dad[i] = dad[R];
		}
		if(C !== -1 /*NOSTREAM*/) dad[C] = i;
		if(L !== -1 && i != dad[i]) { dad[L] = dad[i]; if(q.lastIndexOf(L) < j) q.push(L); }
		if(R !== -1 && i != dad[i]) { dad[R] = dad[i]; if(q.lastIndexOf(R) < j) q.push(R); }
	}
	for(i=1; i < pl; ++i) if(dad[i] === i) {
		if(R !== -1 /*NOSTREAM*/ && dad[R] !== R) dad[i] = dad[R];
		else if(L !== -1 && dad[L] !== L) dad[i] = dad[L];
	}

	for(i=1; i < pl; ++i) {
		if(FI[i].type === 0 /* unknown */) continue;
		j = i;
		if(j != dad[j]) do {
			j = dad[j];
			FP[i] = FP[j] + "/" + FP[i];
		} while (j !== 0 && -1 !== dad[j] && j != dad[j]);
		dad[i] = -1;
	}

	FP[0] += "/";
	for(i=1; i < pl; ++i) {
		if(FI[i].type !== 2 /* stream */) FP[i] += "/";
	}
}

function get_mfat_entry(entry, payload, mini) {
	var start = entry.start, size = entry.size;
	//return (payload.slice(start*MSSZ, start*MSSZ + size));
	var o = [];
	var idx = start;
	while(mini && size > 0 && idx >= 0) {
		o.push(payload.slice(idx * MSSZ, idx * MSSZ + MSSZ));
		size -= MSSZ;
		idx = __readInt32LE(mini, idx * 4);
	}
	if(o.length === 0) return (new_buf(0));
	return (bconcat(o).slice(0, entry.size));
}

/** Chase down the rest of the DIFAT chain to build a comprehensive list
    DIFAT chains by storing the next sector number as the last 32 bits */
function sleuth_fat(idx, cnt, sectors, ssz, fat_addrs) {
	var q = ENDOFCHAIN;
	if(idx === ENDOFCHAIN) {
		if(cnt !== 0) throw new Error("DIFAT chain shorter than expected");
	} else if(idx !== -1 /*FREESECT*/) {
		var sector = sectors[idx], m = (ssz>>>2)-1;
		if(!sector) return;
		for(var i = 0; i < m; ++i) {
			if((q = __readInt32LE(sector,i*4)) === ENDOFCHAIN) break;
			fat_addrs.push(q);
		}
		if(cnt >= 1) sleuth_fat(__readInt32LE(sector,ssz-4),cnt - 1, sectors, ssz, fat_addrs);
	}
}

/** Follow the linked list of sectors for a given starting point */
function get_sector_list(sectors, start, fat_addrs, ssz, chkd) {
	var buf = [], buf_chain = [];
	if(!chkd) chkd = [];
	var modulus = ssz - 1, j = 0, jj = 0;
	for(j=start; j>=0;) {
		chkd[j] = true;
		buf[buf.length] = j;
		buf_chain.push(sectors[j]);
		var addr = fat_addrs[Math.floor(j*4/ssz)];
		jj = ((j*4) & modulus);
		if(ssz < 4 + jj) throw new Error("FAT boundary crossed: " + j + " 4 "+ssz);
		if(!sectors[addr]) break;
		j = __readInt32LE(sectors[addr], jj);
	}
	return {nodes: buf, data:__toBuffer([buf_chain])};
}

/** Chase down the sector linked lists */
function make_sector_list(sectors, dir_start, fat_addrs, ssz) {
	var sl = sectors.length, sector_list = ([]);
	var chkd = [], buf = [], buf_chain = [];
	var modulus = ssz - 1, i=0, j=0, k=0, jj=0;
	for(i=0; i < sl; ++i) {
		buf = ([]);
		k = (i + dir_start); if(k >= sl) k-=sl;
		if(chkd[k]) continue;
		buf_chain = [];
		var seen = [];
		for(j=k; j>=0;) {
			seen[j] = true;
			chkd[j] = true;
			buf[buf.length] = j;
			buf_chain.push(sectors[j]);
			var addr = fat_addrs[Math.floor(j*4/ssz)];
			jj = ((j*4) & modulus);
			if(ssz < 4 + jj) throw new Error("FAT boundary crossed: " + j + " 4 "+ssz);
			if(!sectors[addr]) break;
			j = __readInt32LE(sectors[addr], jj);
			if(seen[j]) break;
		}
		sector_list[k] = ({nodes: buf, data:__toBuffer([buf_chain])});
	}
	return sector_list;
}

/* [MS-CFB] 2.6.1 Compound File Directory Entry */
function read_directory(dir_start, sector_list, sectors, Paths, nmfs, files, FileIndex, mini) {
	var minifat_store = 0, pl = (Paths.length?2:0);
	var sector = sector_list[dir_start].data;
	var i = 0, namelen = 0, name;
	for(; i < sector.length; i+= 128) {
		var blob = sector.slice(i, i+128);
		prep_blob(blob, 64);
		namelen = blob.read_shift(2);
		name = __utf16le(blob,0,namelen-pl);
		Paths.push(name);
		var o = ({
			name:  name,
			type:  blob.read_shift(1),
			color: blob.read_shift(1),
			L:     blob.read_shift(4, 'i'),
			R:     blob.read_shift(4, 'i'),
			C:     blob.read_shift(4, 'i'),
			clsid: blob.read_shift(16),
			state: blob.read_shift(4, 'i'),
			start: 0,
			size: 0
		});
		var ctime = blob.read_shift(2) + blob.read_shift(2) + blob.read_shift(2) + blob.read_shift(2);
		if(ctime !== 0) o.ct = read_date(blob, blob.l-8);
		var mtime = blob.read_shift(2) + blob.read_shift(2) + blob.read_shift(2) + blob.read_shift(2);
		if(mtime !== 0) o.mt = read_date(blob, blob.l-8);
		o.start = blob.read_shift(4, 'i');
		o.size = blob.read_shift(4, 'i');
		if(o.size < 0 && o.start < 0) { o.size = o.type = 0; o.start = ENDOFCHAIN; o.name = ""; }
		if(o.type === 5) { /* root */
			minifat_store = o.start;
			if(nmfs > 0 && minifat_store !== ENDOFCHAIN) sector_list[minifat_store].name = "!StreamData";
			/*minifat_size = o.size;*/
		} else if(o.size >= 4096 /* MSCSZ */) {
			o.storage = 'fat';
			if(sector_list[o.start] === undefined) sector_list[o.start] = get_sector_list(sectors, o.start, sector_list.fat_addrs, sector_list.ssz);
			sector_list[o.start].name = o.name;
			o.content = (sector_list[o.start].data.slice(0,o.size));
		} else {
			o.storage = 'minifat';
			if(o.size < 0) o.size = 0;
			else if(minifat_store !== ENDOFCHAIN && o.start !== ENDOFCHAIN && sector_list[minifat_store]) {
				o.content = get_mfat_entry(o, sector_list[minifat_store].data, (sector_list[mini]||{}).data);
			}
		}
		if(o.content) prep_blob(o.content, 0);
		files[name] = o;
		FileIndex.push(o);
	}
}

function read_date(blob, offset) {
	return new Date(( ( (__readUInt32LE(blob,offset+4)/1e7)*Math.pow(2,32)+__readUInt32LE(blob,offset)/1e7 ) - 11644473600)*1000);
}

function read_file(filename, options) {
	get_fs();
	return parse(fs.readFileSync(filename), options);
}

function read(blob, options) {
	var type = options && options.type;
	if(!type) {
		if(has_buf && Buffer.isBuffer(blob)) type = "buffer";
	}
	switch(type || "base64") {
		case "file": return read_file(blob, options);
		case "base64": return parse(s2a(Base64_decode(blob)), options);
		case "binary": return parse(s2a(blob), options);
	}
	return parse(blob, options);
}

function init_cfb(cfb, opts) {
	var o = opts || {}, root = o.root || "Root Entry";
	if(!cfb.FullPaths) cfb.FullPaths = [];
	if(!cfb.FileIndex) cfb.FileIndex = [];
	if(cfb.FullPaths.length !== cfb.FileIndex.length) throw new Error("inconsistent CFB structure");
	if(cfb.FullPaths.length === 0) {
		cfb.FullPaths[0] = root + "/";
		cfb.FileIndex[0] = ({ name: root, type: 5 });
	}
	if(o.CLSID) cfb.FileIndex[0].clsid = o.CLSID;
	seed_cfb(cfb);
}
function seed_cfb(cfb) {
	var nm = "\u0001Sh33tJ5";
	if(CFB.find(cfb, "/" + nm)) return;
	var p = new_buf(4); p[0] = 55; p[1] = p[3] = 50; p[2] = 54;
	cfb.FileIndex.push(({ name: nm, type: 2, content:p, size:4, L:69, R:69, C:69 }));
	cfb.FullPaths.push(cfb.FullPaths[0] + nm);
	rebuild_cfb(cfb);
}
function rebuild_cfb(cfb, f) {
	init_cfb(cfb);
	var gc = false, s = false;
	for(var i = cfb.FullPaths.length - 1; i >= 0; --i) {
		var _file = cfb.FileIndex[i];
		switch(_file.type) {
			case 0:
				if(s) gc = true;
				else { cfb.FileIndex.pop(); cfb.FullPaths.pop(); }
				break;
			case 1: case 2: case 5:
				s = true;
				if(isNaN(_file.R * _file.L * _file.C)) gc = true;
				if(_file.R > -1 && _file.L > -1 && _file.R == _file.L) gc = true;
				break;
			default: gc = true; break;
		}
	}
	if(!gc && !f) return;

	var now = new Date(1987, 1, 19), j = 0;
	// Track which names exist
	var fullPaths = Object.create ? Object.create(null) : {};
	var data = [];
	for(i = 0; i < cfb.FullPaths.length; ++i) {
		fullPaths[cfb.FullPaths[i]] = true;
		if(cfb.FileIndex[i].type === 0) continue;
		data.push([cfb.FullPaths[i], cfb.FileIndex[i]]);
	}
	for(i = 0; i < data.length; ++i) {
		var dad = dirname(data[i][0]);
		s = fullPaths[dad];
		while(!s) {
			while(dirname(dad) && !fullPaths[dirname(dad)]) dad = dirname(dad);

			data.push([dad, ({
				name: filename(dad).replace("/",""),
				type: 1,
				clsid: HEADER_CLSID,
				ct: now, mt: now,
				content: null
			})]);

			// Add name to set
			fullPaths[dad] = true;

			dad = dirname(data[i][0]);
			s = fullPaths[dad];
		}
	}

	data.sort(function(x,y) { return namecmp(x[0], y[0]); });
	cfb.FullPaths = []; cfb.FileIndex = [];
	for(i = 0; i < data.length; ++i) { cfb.FullPaths[i] = data[i][0]; cfb.FileIndex[i] = data[i][1]; }
	for(i = 0; i < data.length; ++i) {
		var elt = cfb.FileIndex[i];
		var nm = cfb.FullPaths[i];

		elt.name =  filename(nm).replace("/","");
		elt.L = elt.R = elt.C = -(elt.color = 1);
		elt.size = elt.content ? elt.content.length : 0;
		elt.start = 0;
		elt.clsid = (elt.clsid || HEADER_CLSID);
		if(i === 0) {
			elt.C = data.length > 1 ? 1 : -1;
			elt.size = 0;
			elt.type = 5;
		} else if(nm.slice(-1) == "/") {
			for(j=i+1;j < data.length; ++j) if(dirname(cfb.FullPaths[j])==nm) break;
			elt.C = j >= data.length ? -1 : j;
			for(j=i+1;j < data.length; ++j) if(dirname(cfb.FullPaths[j])==dirname(nm)) break;
			elt.R = j >= data.length ? -1 : j;
			elt.type = 1;
		} else {
			if(dirname(cfb.FullPaths[i+1]||"") == dirname(nm)) elt.R = i + 1;
			elt.type = 2;
		}
	}

}

function _write(cfb, options) {
	var _opts = options || {};
	/* MAD is order-sensitive, skip rebuild and sort */
	if(_opts.fileType == 'mad') return write_mad(cfb, _opts);
	rebuild_cfb(cfb);
	switch(_opts.fileType) {
		case 'zip': return write_zip(cfb, _opts);
		//case 'mad': return write_mad(cfb, _opts);
	}
	var L = (function(cfb){
		var mini_size = 0, fat_size = 0;
		for(var i = 0; i < cfb.FileIndex.length; ++i) {
			var file = cfb.FileIndex[i];
			if(!file.content) continue;
			var flen = file.content.length;
			if(flen > 0){
				if(flen < 0x1000) mini_size += (flen + 0x3F) >> 6;
				else fat_size += (flen + 0x01FF) >> 9;
			}
		}
		var dir_cnt = (cfb.FullPaths.length +3) >> 2;
		var mini_cnt = (mini_size + 7) >> 3;
		var mfat_cnt = (mini_size + 0x7F) >> 7;
		var fat_base = mini_cnt + fat_size + dir_cnt + mfat_cnt;
		var fat_cnt = (fat_base + 0x7F) >> 7;
		var difat_cnt = fat_cnt <= 109 ? 0 : Math.ceil((fat_cnt-109)/0x7F);
		while(((fat_base + fat_cnt + difat_cnt + 0x7F) >> 7) > fat_cnt) difat_cnt = ++fat_cnt <= 109 ? 0 : Math.ceil((fat_cnt-109)/0x7F);
		var L =  [1, difat_cnt, fat_cnt, mfat_cnt, dir_cnt, fat_size, mini_size, 0];
		cfb.FileIndex[0].size = mini_size << 6;
		L[7] = (cfb.FileIndex[0].start=L[0]+L[1]+L[2]+L[3]+L[4]+L[5])+((L[6]+7) >> 3);
		return L;
	})(cfb);
	var o = new_buf(L[7] << 9);
	var i = 0, T = 0;
	{
		for(i = 0; i < 8; ++i) o.write_shift(1, HEADER_SIG[i]);
		for(i = 0; i < 8; ++i) o.write_shift(2, 0);
		o.write_shift(2, 0x003E);
		o.write_shift(2, 0x0003);
		o.write_shift(2, 0xFFFE);
		o.write_shift(2, 0x0009);
		o.write_shift(2, 0x0006);
		for(i = 0; i < 3; ++i) o.write_shift(2, 0);
		o.write_shift(4, 0);
		o.write_shift(4, L[2]);
		o.write_shift(4, L[0] + L[1] + L[2] + L[3] - 1);
		o.write_shift(4, 0);
		o.write_shift(4, 1<<12);
		o.write_shift(4, L[3] ? L[0] + L[1] + L[2] - 1: ENDOFCHAIN);
		o.write_shift(4, L[3]);
		o.write_shift(-4, L[1] ? L[0] - 1: ENDOFCHAIN);
		o.write_shift(4, L[1]);
		for(i = 0; i < 109; ++i) o.write_shift(-4, i < L[2] ? L[1] + i : -1);
	}
	if(L[1]) {
		for(T = 0; T < L[1]; ++T) {
			for(; i < 236 + T * 127; ++i) o.write_shift(-4, i < L[2] ? L[1] + i : -1);
			o.write_shift(-4, T === L[1] - 1 ? ENDOFCHAIN : T + 1);
		}
	}
	var chainit = function(w) {
		for(T += w; i<T-1; ++i) o.write_shift(-4, i+1);
		if(w) { ++i; o.write_shift(-4, ENDOFCHAIN); }
	};
	T = i = 0;
	for(T+=L[1]; i<T; ++i) o.write_shift(-4, consts.DIFSECT);
	for(T+=L[2]; i<T; ++i) o.write_shift(-4, consts.FATSECT);
	chainit(L[3]);
	chainit(L[4]);
	var j = 0, flen = 0;
	var file = cfb.FileIndex[0];
	for(; j < cfb.FileIndex.length; ++j) {
		file = cfb.FileIndex[j];
		if(!file.content) continue;
flen = file.content.length;
		if(flen < 0x1000) continue;
		file.start = T;
		chainit((flen + 0x01FF) >> 9);
	}
	chainit((L[6] + 7) >> 3);
	while(o.l & 0x1FF) o.write_shift(-4, consts.ENDOFCHAIN);
	T = i = 0;
	for(j = 0; j < cfb.FileIndex.length; ++j) {
		file = cfb.FileIndex[j];
		if(!file.content) continue;
flen = file.content.length;
		if(!flen || flen >= 0x1000) continue;
		file.start = T;
		chainit((flen + 0x3F) >> 6);
	}
	while(o.l & 0x1FF) o.write_shift(-4, consts.ENDOFCHAIN);
	for(i = 0; i < L[4]<<2; ++i) {
		var nm = cfb.FullPaths[i];
		if(!nm || nm.length === 0) {
			for(j = 0; j < 17; ++j) o.write_shift(4, 0);
			for(j = 0; j < 3; ++j) o.write_shift(4, -1);
			for(j = 0; j < 12; ++j) o.write_shift(4, 0);
			continue;
		}
		file = cfb.FileIndex[i];
		if(i === 0) file.start = file.size ? file.start - 1 : ENDOFCHAIN;
		var _nm = (i === 0 && _opts.root) || file.name;
		if(_nm.length > 31) {
			console.error("Name " + _nm + " will be truncated to " + _nm.slice(0,31));
			_nm = _nm.slice(0, 31);
		}
		flen = 2*(_nm.length+1);
		o.write_shift(64, _nm, "utf16le");
		o.write_shift(2, flen);
		o.write_shift(1, file.type);
		o.write_shift(1, file.color);
		o.write_shift(-4, file.L);
		o.write_shift(-4, file.R);
		o.write_shift(-4, file.C);
		if(!file.clsid) for(j = 0; j < 4; ++j) o.write_shift(4, 0);
		else o.write_shift(16, file.clsid, "hex");
		o.write_shift(4, file.state || 0);
		o.write_shift(4, 0); o.write_shift(4, 0);
		o.write_shift(4, 0); o.write_shift(4, 0);
		o.write_shift(4, file.start);
		o.write_shift(4, file.size); o.write_shift(4, 0);
	}
	for(i = 1; i < cfb.FileIndex.length; ++i) {
		file = cfb.FileIndex[i];
if(file.size >= 0x1000) {
			o.l = (file.start+1) << 9;
			if (has_buf && Buffer.isBuffer(file.content)) {
				file.content.copy(o, o.l, 0, file.size);
				// o is a 0-filled Buffer so just set next offset
				o.l += (file.size + 511) & -512;
			} else {
				for(j = 0; j < file.size; ++j) o.write_shift(1, file.content[j]);
				for(; j & 0x1FF; ++j) o.write_shift(1, 0);
			}
		}
	}
	for(i = 1; i < cfb.FileIndex.length; ++i) {
		file = cfb.FileIndex[i];
if(file.size > 0 && file.size < 0x1000) {
			if (has_buf && Buffer.isBuffer(file.content)) {
				file.content.copy(o, o.l, 0, file.size);
				// o is a 0-filled Buffer so just set next offset
				o.l += (file.size + 63) & -64;
			} else {
				for(j = 0; j < file.size; ++j) o.write_shift(1, file.content[j]);
				for(; j & 0x3F; ++j) o.write_shift(1, 0);
			}
		}
	}
	if (has_buf) {
		o.l = o.length;
	} else {
		// When using Buffer, already 0-filled
		while(o.l < o.length) o.write_shift(1, 0);
	}
	return o;
}
/* [MS-CFB] 2.6.4 (Unicode 3.0.1 case conversion) */
function find(cfb, path) {
	var UCFullPaths = cfb.FullPaths.map(function(x) { return x.toUpperCase(); });
	var UCPaths = UCFullPaths.map(function(x) { var y = x.split("/"); return y[y.length - (x.slice(-1) == "/" ? 2 : 1)]; });
	var k = false;
	if(path.charCodeAt(0) === 47 /* "/" */) { k = true; path = UCFullPaths[0].slice(0, -1) + path; }
	else k = path.indexOf("/") !== -1;
	var UCPath = path.toUpperCase();
	var w = k === true ? UCFullPaths.indexOf(UCPath) : UCPaths.indexOf(UCPath);
	if(w !== -1) return cfb.FileIndex[w];

	var m = !UCPath.match(chr1);
	UCPath = UCPath.replace(chr0,'');
	if(m) UCPath = UCPath.replace(chr1,'!');
	for(w = 0; w < UCFullPaths.length; ++w) {
		if((m ? UCFullPaths[w].replace(chr1,'!') : UCFullPaths[w]).replace(chr0,'') == UCPath) return cfb.FileIndex[w];
		if((m ? UCPaths[w].replace(chr1,'!') : UCPaths[w]).replace(chr0,'') == UCPath) return cfb.FileIndex[w];
	}
	return null;
}
/** CFB Constants */
var MSSZ = 64; /* Mini Sector Size = 1<<6 */
//var MSCSZ = 4096; /* Mini Stream Cutoff Size */
/* 2.1 Compound File Sector Numbers and Types */
var ENDOFCHAIN = -2;
/* 2.2 Compound File Header */
var HEADER_SIGNATURE = 'd0cf11e0a1b11ae1';
var HEADER_SIG = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
var HEADER_CLSID = '00000000000000000000000000000000';
var consts = {
	/* 2.1 Compund File Sector Numbers and Types */
	MAXREGSECT: -6,
	DIFSECT: -4,
	FATSECT: -3,
	ENDOFCHAIN: ENDOFCHAIN,
	FREESECT: -1,
	/* 2.2 Compound File Header */
	HEADER_SIGNATURE: HEADER_SIGNATURE,
	HEADER_MINOR_VERSION: '3e00',
	MAXREGSID: -6,
	NOSTREAM: -1,
	HEADER_CLSID: HEADER_CLSID,
	/* 2.6.1 Compound File Directory Entry */
	EntryTypes: ['unknown','storage','stream','lockbytes','property','root']
};

function write_file(cfb, filename, options) {
	get_fs();
	var o = _write(cfb, options);
fs.writeFileSync(filename, o);
}

function a2s(o) {
	var out = new Array(o.length);
	for(var i = 0; i < o.length; ++i) out[i] = String.fromCharCode(o[i]);
	return out.join("");
}

function write(cfb, options) {
	var o = _write(cfb, options);
	switch(options && options.type || "buffer") {
		case "file": get_fs(); fs.writeFileSync(options.filename, (o)); return o;
		case "binary": return typeof o == "string" ? o : a2s(o);
		case "base64": return Base64_encode(typeof o == "string" ? o : a2s(o));
		case "buffer": if(has_buf) return Buffer.isBuffer(o) ? o : Buffer_from(o);
			/* falls through */
		case "array": return typeof o == "string" ? s2a(o) : o;
	}
	return o;
}
/* node < 8.1 zlib does not expose bytesRead, so default to pure JS */
var _zlib;
function use_zlib(zlib) { try {
	var InflateRaw = zlib.InflateRaw;
	var InflRaw = new InflateRaw();
	InflRaw._processChunk(new Uint8Array([3, 0]), InflRaw._finishFlushFlag);
	if(InflRaw.bytesRead) _zlib = zlib;
	else throw new Error("zlib does not expose bytesRead");
} catch(e) {console.error("cannot use native zlib: " + (e.message || e)); } }

function _inflateRawSync(payload, usz) {
	if(!_zlib) return _inflate(payload, usz);
	var InflateRaw = _zlib.InflateRaw;
	var InflRaw = new InflateRaw();
	var out = InflRaw._processChunk(payload.slice(payload.l), InflRaw._finishFlushFlag);
	payload.l += InflRaw.bytesRead;
	return out;
}

function _deflateRawSync(payload) {
	return _zlib ? _zlib.deflateRawSync(payload) : _deflate(payload);
}
var CLEN_ORDER = [ 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 ];

/*  LEN_ID = [ 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 284, 285 ]; */
var LEN_LN = [   3,   4,   5,   6,   7,   8,   9,  10,  11,  13 , 15,  17,  19,  23,  27,  31,  35,  43,  51,  59,  67,  83,  99, 115, 131, 163, 195, 227, 258 ];

/*  DST_ID = [  0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13,  14,  15,  16,  17,  18,  19,   20,   21,   22,   23,   24,   25,   26,    27,    28,    29 ]; */
var DST_LN = [  1,  2,  3,  4,  5,  7,  9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577 ];

function bit_swap_8(n) { var t = (((((n<<1)|(n<<11)) & 0x22110) | (((n<<5)|(n<<15)) & 0x88440))); return ((t>>16) | (t>>8) |t)&0xFF; }

var use_typed_arrays = typeof Uint8Array !== 'undefined';

var bitswap8 = use_typed_arrays ? new Uint8Array(1<<8) : [];
for(var q = 0; q < (1<<8); ++q) bitswap8[q] = bit_swap_8(q);

function bit_swap_n(n, b) {
	var rev = bitswap8[n & 0xFF];
	if(b <= 8) return rev >>> (8-b);
	rev = (rev << 8) | bitswap8[(n>>8)&0xFF];
	if(b <= 16) return rev >>> (16-b);
	rev = (rev << 8) | bitswap8[(n>>16)&0xFF];
	return rev >>> (24-b);
}

/* helpers for unaligned bit reads */
function read_bits_2(buf, bl) { var w = (bl&7), h = (bl>>>3); return ((buf[h]|(w <= 6 ? 0 : buf[h+1]<<8))>>>w)& 0x03; }
function read_bits_3(buf, bl) { var w = (bl&7), h = (bl>>>3); return ((buf[h]|(w <= 5 ? 0 : buf[h+1]<<8))>>>w)& 0x07; }
function read_bits_4(buf, bl) { var w = (bl&7), h = (bl>>>3); return ((buf[h]|(w <= 4 ? 0 : buf[h+1]<<8))>>>w)& 0x0F; }
function read_bits_5(buf, bl) { var w = (bl&7), h = (bl>>>3); return ((buf[h]|(w <= 3 ? 0 : buf[h+1]<<8))>>>w)& 0x1F; }
function read_bits_7(buf, bl) { var w = (bl&7), h = (bl>>>3); return ((buf[h]|(w <= 1 ? 0 : buf[h+1]<<8))>>>w)& 0x7F; }

/* works up to n = 3 * 8 + 1 = 25 */
function read_bits_n(buf, bl, n) {
	var w = (bl&7), h = (bl>>>3), f = ((1<<n)-1);
	var v = buf[h] >>> w;
	if(n < 8 - w) return v & f;
	v |= buf[h+1]<<(8-w);
	if(n < 16 - w) return v & f;
	v |= buf[h+2]<<(16-w);
	if(n < 24 - w) return v & f;
	v |= buf[h+3]<<(24-w);
	return v & f;
}

/* helpers for unaligned bit writes */
function write_bits_3(buf, bl, v) { var w = bl & 7, h = bl >>> 3;
	if(w <= 5) buf[h] |= (v & 7) << w;
	else {
		buf[h] |= (v << w) & 0xFF;
		buf[h+1] = (v&7) >> (8-w);
	}
	return bl + 3;
}

function write_bits_1(buf, bl, v) {
	var w = bl & 7, h = bl >>> 3;
	v = (v&1) << w;
	buf[h] |= v;
	return bl + 1;
}
function write_bits_8(buf, bl, v) {
	var w = bl & 7, h = bl >>> 3;
	v <<= w;
	buf[h] |=  v & 0xFF; v >>>= 8;
	buf[h+1] = v;
	return bl + 8;
}
function write_bits_16(buf, bl, v) {
	var w = bl & 7, h = bl >>> 3;
	v <<= w;
	buf[h] |=  v & 0xFF; v >>>= 8;
	buf[h+1] = v & 0xFF;
	buf[h+2] = v >>> 8;
	return bl + 16;
}

/* until ArrayBuffer#realloc is a thing, fake a realloc */
function realloc(b, sz) {
	var L = b.length, M = 2*L > sz ? 2*L : sz + 5, i = 0;
	if(L >= sz) return b;
	if(has_buf) {
		var o = new_unsafe_buf(M);
		// $FlowIgnore
		if(b.copy) b.copy(o);
		else for(; i < b.length; ++i) o[i] = b[i];
		return o;
	} else if(use_typed_arrays) {
		var a = new Uint8Array(M);
		if(a.set) a.set(b);
		else for(; i < L; ++i) a[i] = b[i];
		return a;
	}
	b.length = M;
	return b;
}

/* zero-filled arrays for older browsers */
function zero_fill_array(n) {
	var o = new Array(n);
	for(var i = 0; i < n; ++i) o[i] = 0;
	return o;
}

/* build tree (used for literals and lengths) */
function build_tree(clens, cmap, MAX) {
	var maxlen = 1, w = 0, i = 0, j = 0, ccode = 0, L = clens.length;

	var bl_count  = use_typed_arrays ? new Uint16Array(32) : zero_fill_array(32);
	for(i = 0; i < 32; ++i) bl_count[i] = 0;

	for(i = L; i < MAX; ++i) clens[i] = 0;
	L = clens.length;

	var ctree = use_typed_arrays ? new Uint16Array(L) : zero_fill_array(L); // []

	/* build code tree */
	for(i = 0; i < L; ++i) {
		bl_count[(w = clens[i])]++;
		if(maxlen < w) maxlen = w;
		ctree[i] = 0;
	}
	bl_count[0] = 0;
	for(i = 1; i <= maxlen; ++i) bl_count[i+16] = (ccode = (ccode + bl_count[i-1])<<1);
	for(i = 0; i < L; ++i) {
		ccode = clens[i];
		if(ccode != 0) ctree[i] = bl_count[ccode+16]++;
	}

	/* cmap[maxlen + 4 bits] = (off&15) + (lit<<4) reverse mapping */
	var cleni = 0;
	for(i = 0; i < L; ++i) {
		cleni = clens[i];
		if(cleni != 0) {
			ccode = bit_swap_n(ctree[i], maxlen)>>(maxlen-cleni);
			for(j = (1<<(maxlen + 4 - cleni)) - 1; j>=0; --j)
				cmap[ccode|(j<<cleni)] = (cleni&15) | (i<<4);
		}
	}
	return maxlen;
}

/* Fixed Huffman */
var fix_lmap = use_typed_arrays ? new Uint16Array(512) : zero_fill_array(512);
var fix_dmap = use_typed_arrays ? new Uint16Array(32)  : zero_fill_array(32);
if(!use_typed_arrays) {
	for(var i = 0; i < 512; ++i) fix_lmap[i] = 0;
	for(i = 0; i < 32; ++i) fix_dmap[i] = 0;
}
(function() {
	var dlens = [];
	var i = 0;
	for(;i<32; i++) dlens.push(5);
	build_tree(dlens, fix_dmap, 32);

	var clens = [];
	i = 0;
	for(; i<=143; i++) clens.push(8);
	for(; i<=255; i++) clens.push(9);
	for(; i<=279; i++) clens.push(7);
	for(; i<=287; i++) clens.push(8);
	build_tree(clens, fix_lmap, 288);
})();var _deflateRaw = (function _deflateRawIIFE() {
	var DST_LN_RE = use_typed_arrays ? new Uint8Array(0x8000) : [];
	var j = 0, k = 0;
	for(; j < DST_LN.length - 1; ++j) {
		for(; k < DST_LN[j+1]; ++k) DST_LN_RE[k] = j;
	}
	for(;k < 32768; ++k) DST_LN_RE[k] = 29;

	var LEN_LN_RE = use_typed_arrays ? new Uint8Array(0x103) : [];
	for(j = 0, k = 0; j < LEN_LN.length - 1; ++j) {
		for(; k < LEN_LN[j+1]; ++k) LEN_LN_RE[k] = j;
	}

	function write_stored(data, out) {
		var boff = 0;
		while(boff < data.length) {
			var L = Math.min(0xFFFF, data.length - boff);
			var h = boff + L == data.length;
			out.write_shift(1, +h);
			out.write_shift(2, L);
			out.write_shift(2, (~L) & 0xFFFF);
			while(L-- > 0) out[out.l++] = data[boff++];
		}
		return out.l;
	}

	/* Fixed Huffman */
	function write_huff_fixed(data, out) {
		var bl = 0;
		var boff = 0;
		var addrs = use_typed_arrays ? new Uint16Array(0x8000) : [];
		while(boff < data.length) {
			var L = /* data.length - boff; */ Math.min(0xFFFF, data.length - boff);

			/* write a stored block for short data */
			if(L < 10) {
				bl = write_bits_3(out, bl, +!!(boff + L == data.length)); // jshint ignore:line
				if(bl & 7) bl += 8 - (bl & 7);
				out.l = (bl / 8) | 0;
				out.write_shift(2, L);
				out.write_shift(2, (~L) & 0xFFFF);
				while(L-- > 0) out[out.l++] = data[boff++];
				bl = out.l * 8;
				continue;
			}

			bl = write_bits_3(out, bl, +!!(boff + L == data.length) + 2); // jshint ignore:line
			var hash = 0;
			while(L-- > 0) {
				var d = data[boff];
				hash = ((hash << 5) ^ d) & 0x7FFF;

				var match = -1, mlen = 0;

				if((match = addrs[hash])) {
					match |= boff & ~0x7FFF;
					if(match > boff) match -= 0x8000;
					if(match < boff) while(data[match + mlen] == data[boff + mlen] && mlen < 250) ++mlen;
				}

				if(mlen > 2) {
					/* Copy Token  */
					d = LEN_LN_RE[mlen];
					if(d <= 22) bl = write_bits_8(out, bl, bitswap8[d+1]>>1) - 1;
					else {
						write_bits_8(out, bl, 3);
						bl += 5;
						write_bits_8(out, bl, bitswap8[d-23]>>5);
						bl += 3;
					}
					var len_eb = (d < 8) ? 0 : ((d - 4)>>2);
					if(len_eb > 0) {
						write_bits_16(out, bl, mlen - LEN_LN[d]);
						bl += len_eb;
					}

					d = DST_LN_RE[boff - match];
					bl = write_bits_8(out, bl, bitswap8[d]>>3);
					bl -= 3;

					var dst_eb = d < 4 ? 0 : (d-2)>>1;
					if(dst_eb > 0) {
						write_bits_16(out, bl, boff - match - DST_LN[d]);
						bl += dst_eb;
					}
					for(var q = 0; q < mlen; ++q) {
						addrs[hash] = boff & 0x7FFF;
						hash = ((hash << 5) ^ data[boff]) & 0x7FFF;
						++boff;
					}
					L-= mlen - 1;
				} else {
					/* Literal Token */
					if(d <= 143) d = d + 48;
					else bl = write_bits_1(out, bl, 1);
					bl = write_bits_8(out, bl, bitswap8[d]);
					addrs[hash] = boff & 0x7FFF;
					++boff;
				}
			}

			bl = write_bits_8(out, bl, 0) - 1;
		}
		out.l = ((bl + 7)/8)|0;
		return out.l;
	}
	return function _deflateRaw(data, out) {
		if(data.length < 8) return write_stored(data, out);
		return write_huff_fixed(data, out);
	};
})();

function _deflate(data) {
	var buf = new_buf(50+Math.floor(data.length*1.1));
	var off = _deflateRaw(data, buf);
	return buf.slice(0, off);
}
/* modified inflate function also moves original read head */

var dyn_lmap = use_typed_arrays ? new Uint16Array(32768) : zero_fill_array(32768);
var dyn_dmap = use_typed_arrays ? new Uint16Array(32768) : zero_fill_array(32768);
var dyn_cmap = use_typed_arrays ? new Uint16Array(128)   : zero_fill_array(128);
var dyn_len_1 = 1, dyn_len_2 = 1;

/* 5.5.3 Expanding Huffman Codes */
function dyn(data, boff) {
	/* nomenclature from RFC1951 refers to bit values; these are offset by the implicit constant */
	var _HLIT = read_bits_5(data, boff) + 257; boff += 5;
	var _HDIST = read_bits_5(data, boff) + 1; boff += 5;
	var _HCLEN = read_bits_4(data, boff) + 4; boff += 4;
	var w = 0;

	/* grab and store code lengths */
	var clens = use_typed_arrays ? new Uint8Array(19) : zero_fill_array(19);
	var ctree = [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ];
	var maxlen = 1;
	var bl_count =  use_typed_arrays ? new Uint8Array(8) : zero_fill_array(8);
	var next_code = use_typed_arrays ? new Uint8Array(8) : zero_fill_array(8);
	var L = clens.length; /* 19 */
	for(var i = 0; i < _HCLEN; ++i) {
		clens[CLEN_ORDER[i]] = w = read_bits_3(data, boff);
		if(maxlen < w) maxlen = w;
		bl_count[w]++;
		boff += 3;
	}

	/* build code tree */
	var ccode = 0;
	bl_count[0] = 0;
	for(i = 1; i <= maxlen; ++i) next_code[i] = ccode = (ccode + bl_count[i-1])<<1;
	for(i = 0; i < L; ++i) if((ccode = clens[i]) != 0) ctree[i] = next_code[ccode]++;
	/* cmap[7 bits from stream] = (off&7) + (lit<<3) */
	var cleni = 0;
	for(i = 0; i < L; ++i) {
		cleni = clens[i];
		if(cleni != 0) {
			ccode = bitswap8[ctree[i]]>>(8-cleni);
			for(var j = (1<<(7-cleni))-1; j>=0; --j) dyn_cmap[ccode|(j<<cleni)] = (cleni&7) | (i<<3);
		}
	}

	/* read literal and dist codes at once */
	var hcodes = [];
	maxlen = 1;
	for(; hcodes.length < _HLIT + _HDIST;) {
		ccode = dyn_cmap[read_bits_7(data, boff)];
		boff += ccode & 7;
		switch((ccode >>>= 3)) {
			case 16:
				w = 3 + read_bits_2(data, boff); boff += 2;
				ccode = hcodes[hcodes.length - 1];
				while(w-- > 0) hcodes.push(ccode);
				break;
			case 17:
				w = 3 + read_bits_3(data, boff); boff += 3;
				while(w-- > 0) hcodes.push(0);
				break;
			case 18:
				w = 11 + read_bits_7(data, boff); boff += 7;
				while(w -- > 0) hcodes.push(0);
				break;
			default:
				hcodes.push(ccode);
				if(maxlen < ccode) maxlen = ccode;
				break;
		}
	}

	/* build literal / length trees */
	var h1 = hcodes.slice(0, _HLIT), h2 = hcodes.slice(_HLIT);
	for(i = _HLIT; i < 286; ++i) h1[i] = 0;
	for(i = _HDIST; i < 30; ++i) h2[i] = 0;
	dyn_len_1 = build_tree(h1, dyn_lmap, 286);
	dyn_len_2 = build_tree(h2, dyn_dmap, 30);
	return boff;
}

/* return [ data, bytesRead ] */
function inflate(data, usz) {
	/* shortcircuit for empty buffer [0x03, 0x00] */
	if(data[0] == 3 && !(data[1] & 0x3)) { return [new_raw_buf(usz), 2]; }

	/* bit offset */
	var boff = 0;

	/* header includes final bit and type bits */
	var header = 0;

	var outbuf = new_unsafe_buf(usz ? usz : (1<<18));
	var woff = 0;
	var OL = outbuf.length>>>0;
	var max_len_1 = 0, max_len_2 = 0;

	while((header&1) == 0) {
		header = read_bits_3(data, boff); boff += 3;
		if((header >>> 1) == 0) {
			/* Stored block */
			if(boff & 7) boff += 8 - (boff&7);
			/* 2 bytes sz, 2 bytes bit inverse */
			var sz = data[boff>>>3] | data[(boff>>>3)+1]<<8;
			boff += 32;
			/* push sz bytes */
			if(sz > 0) {
				if(!usz && OL < woff + sz) { outbuf = realloc(outbuf, woff + sz); OL = outbuf.length; }
				while(sz-- > 0) { outbuf[woff++] = data[boff>>>3]; boff += 8; }
			}
			continue;
		} else if((header >> 1) == 1) {
			/* Fixed Huffman */
			max_len_1 = 9; max_len_2 = 5;
		} else {
			/* Dynamic Huffman */
			boff = dyn(data, boff);
			max_len_1 = dyn_len_1; max_len_2 = dyn_len_2;
		}
		for(;;) { // while(true) is apparently out of vogue in modern JS circles
			if(!usz && (OL < woff + 32767)) { outbuf = realloc(outbuf, woff + 32767); OL = outbuf.length; }
			/* ingest code and move read head */
			var bits = read_bits_n(data, boff, max_len_1);
			var code = (header>>>1) == 1 ? fix_lmap[bits] : dyn_lmap[bits];
			boff += code & 15; code >>>= 4;
			/* 0-255 are literals, 256 is end of block token, 257+ are copy tokens */
			if(((code>>>8)&0xFF) === 0) outbuf[woff++] = code;
			else if(code == 256) break;
			else {
				code -= 257;
				var len_eb = (code < 8) ? 0 : ((code-4)>>2); if(len_eb > 5) len_eb = 0;
				var tgt = woff + LEN_LN[code];
				/* length extra bits */
				if(len_eb > 0) {
					tgt += read_bits_n(data, boff, len_eb);
					boff += len_eb;
				}

				/* dist code */
				bits = read_bits_n(data, boff, max_len_2);
				code = (header>>>1) == 1 ? fix_dmap[bits] : dyn_dmap[bits];
				boff += code & 15; code >>>= 4;
				var dst_eb = (code < 4 ? 0 : (code-2)>>1);
				var dst = DST_LN[code];
				/* dist extra bits */
				if(dst_eb > 0) {
					dst += read_bits_n(data, boff, dst_eb);
					boff += dst_eb;
				}

				/* in the common case, manual byte copy is faster than TA set / Buffer copy */
				if(!usz && OL < tgt) { outbuf = realloc(outbuf, tgt + 100); OL = outbuf.length; }
				while(woff < tgt) { outbuf[woff] = outbuf[woff - dst]; ++woff; }
			}
		}
	}
	if(usz) return [outbuf, (boff+7)>>>3];
	return [outbuf.slice(0, woff), (boff+7)>>>3];
}

function _inflate(payload, usz) {
	var data = payload.slice(payload.l||0);
	var out = inflate(data, usz);
	payload.l += out[1];
	return out[0];
}

function warn_or_throw(wrn, msg) {
	if(wrn) { if(typeof console !== 'undefined') console.error(msg); }
	else throw new Error(msg);
}

function parse_zip(file, options) {
	var blob = file;
	prep_blob(blob, 0);

	var FileIndex = [], FullPaths = [];
	var o = {
		FileIndex: FileIndex,
		FullPaths: FullPaths
	};
	init_cfb(o, { root: options.root });

	/* find end of central directory, start just after signature */
	var i = blob.length - 4;
	while((blob[i] != 0x50 || blob[i+1] != 0x4b || blob[i+2] != 0x05 || blob[i+3] != 0x06) && i >= 0) --i;
	blob.l = i + 4;

	/* parse end of central directory */
	blob.l += 4;
	var fcnt = blob.read_shift(2);
	blob.l += 6;
	var start_cd = blob.read_shift(4);

	/* parse central directory */
	blob.l = start_cd;

	for(i = 0; i < fcnt; ++i) {
		/* trust local file header instead of CD entry */
		blob.l += 20;
		var csz = blob.read_shift(4);
		var usz = blob.read_shift(4);
		var namelen = blob.read_shift(2);
		var efsz = blob.read_shift(2);
		var fcsz = blob.read_shift(2);
		blob.l += 8;
		var offset = blob.read_shift(4);
		var EF = parse_extra_field(blob.slice(blob.l+namelen, blob.l+namelen+efsz));
		blob.l += namelen + efsz + fcsz;

		var L = blob.l;
		blob.l = offset + 4;
		/* ZIP64 lengths */
		if(EF && EF[0x0001]) {
			if((EF[0x0001]||{}).usz) usz = EF[0x0001].usz;
			if((EF[0x0001]||{}).csz) csz = EF[0x0001].csz;
		}
		parse_local_file(blob, csz, usz, o, EF);
		blob.l = L;
	}

	return o;
}


/* head starts just after local file header signature */
function parse_local_file(blob, csz, usz, o, EF) {
	/* [local file header] */
	blob.l += 2;
	var flags = blob.read_shift(2);
	var meth = blob.read_shift(2);
	var date = parse_dos_date(blob);

	if(flags & 0x2041) throw new Error("Unsupported ZIP encryption");
	var crc32 = blob.read_shift(4);
	var _csz = blob.read_shift(4);
	var _usz = blob.read_shift(4);

	var namelen = blob.read_shift(2);
	var efsz = blob.read_shift(2);

	// TODO: flags & (1<<11) // UTF8
	var name = ""; for(var i = 0; i < namelen; ++i) name += String.fromCharCode(blob[blob.l++]);
	if(efsz) {
		var ef = parse_extra_field(blob.slice(blob.l, blob.l + efsz));
		if((ef[0x5455]||{}).mt) date = ef[0x5455].mt;
		if((ef[0x0001]||{}).usz) _usz = ef[0x0001].usz;
		if((ef[0x0001]||{}).csz) _csz = ef[0x0001].csz;
		if(EF) {
			if((EF[0x5455]||{}).mt) date = EF[0x5455].mt;
			if((EF[0x0001]||{}).usz) _usz = EF[0x0001].usz;
			if((EF[0x0001]||{}).csz) _csz = EF[0x0001].csz;
		}
	}
	blob.l += efsz;

	/* [encryption header] */

	/* [file data] */
	var data = blob.slice(blob.l, blob.l + _csz);
	switch(meth) {
		case 8: data = _inflateRawSync(blob, _usz); break;
		case 0: blob.l += _csz; break; // TODO: scan for magic number
		default: throw new Error("Unsupported ZIP Compression method " + meth);
	}

	/* [data descriptor] */
	var wrn = false;
	if(flags & 8) {
		crc32 = blob.read_shift(4);
		if(crc32 == 0x08074b50) { crc32 = blob.read_shift(4); wrn = true; }
		_csz = blob.read_shift(4);
		_usz = blob.read_shift(4);
	}

	if(_csz != csz) warn_or_throw(wrn, "Bad compressed size: " + csz + " != " + _csz);
	if(_usz != usz) warn_or_throw(wrn, "Bad uncompressed size: " + usz + " != " + _usz);
	//var _crc32 = CRC32.buf(data, 0);
	//if((crc32>>0) != (_crc32>>0)) warn_or_throw(wrn, "Bad CRC32 checksum: " + crc32 + " != " + _crc32);
	cfb_add(o, name, data, {unsafe: true, mt: date});
}
function write_zip(cfb, options) {
	var _opts = options || {};
	var out = [], cdirs = [];
	var o = new_buf(1);
	var method = (_opts.compression ? 8 : 0), flags = 0;
	var desc = false;
	if(desc) flags |= 8;
	var i = 0, j = 0;

	var start_cd = 0, fcnt = 0;
	var root = cfb.FullPaths[0], fp = root, fi = cfb.FileIndex[0];
	var crcs = [];
	var sz_cd = 0;

	for(i = 1; i < cfb.FullPaths.length; ++i) {
		fp = cfb.FullPaths[i].slice(root.length); fi = cfb.FileIndex[i];
		if(!fi.size || !fi.content || (Array.isArray(fi.content) && fi.content.length == 0) || fp == "\u0001Sh33tJ5") continue;
		var start = start_cd;


		/* TODO: CP437 filename */
		var namebuf = new_buf(fp.length);
		for(j = 0; j < fp.length; ++j) namebuf.write_shift(1, fp.charCodeAt(j) & 0x7F);
		namebuf = namebuf.slice(0, namebuf.l);
		crcs[fcnt] = typeof fi.content == "string" ? CRC32.bstr(fi.content, 0) : CRC32.buf(fi.content, 0);

		var outbuf = typeof fi.content == "string" ? s2a(fi.content) : fi.content;
		if(method == 8) outbuf = _deflateRawSync(outbuf);

		/* local file header */
		o = new_buf(30);
		o.write_shift(4, 0x04034b50);
		o.write_shift(2, 20);
		o.write_shift(2, flags);
		o.write_shift(2, method);
		/* TODO: last mod file time/date */
		if(fi.mt) write_dos_date(o, fi.mt);
		else o.write_shift(4, 0);
		o.write_shift(-4, (flags & 8) ? 0 : crcs[fcnt]);
		o.write_shift(4,  (flags & 8) ? 0 : outbuf.length);
		o.write_shift(4,  (flags & 8) ? 0 : fi.content.length);
		o.write_shift(2, namebuf.length);
		o.write_shift(2, 0);

		start_cd += o.length;
		out.push(o);
		start_cd += namebuf.length;
		out.push(namebuf);

		/* TODO: extra fields? */

		/* TODO: encryption header ? */

		start_cd += outbuf.length;
		out.push(outbuf);

		/* data descriptor */
		if(flags & 8) {
			o = new_buf(12);
			o.write_shift(-4, crcs[fcnt]);
			o.write_shift(4, outbuf.length);
			o.write_shift(4, fi.content.length);
			start_cd += o.l;
			out.push(o);
		}

		/* central directory */
		o = new_buf(46);
		o.write_shift(4, 0x02014b50);
		o.write_shift(2, 0);
		o.write_shift(2, 20);
		o.write_shift(2, flags);
		o.write_shift(2, method);
		o.write_shift(4, 0); /* TODO: last mod file time/date */
		o.write_shift(-4, crcs[fcnt]);

		o.write_shift(4, outbuf.length);
		o.write_shift(4, fi.content.length);
		o.write_shift(2, namebuf.length);
		o.write_shift(2, 0);
		o.write_shift(2, 0);
		o.write_shift(2, 0);
		o.write_shift(2, 0);
		o.write_shift(4, 0);
		o.write_shift(4, start);

		sz_cd += o.l;
		cdirs.push(o);
		sz_cd += namebuf.length;
		cdirs.push(namebuf);
		++fcnt;
	}

	/* end of central directory */
	o = new_buf(22);
	o.write_shift(4, 0x06054b50);
	o.write_shift(2, 0);
	o.write_shift(2, 0);
	o.write_shift(2, fcnt);
	o.write_shift(2, fcnt);
	o.write_shift(4, sz_cd);
	o.write_shift(4, start_cd);
	o.write_shift(2, 0);

	return bconcat(([bconcat((out)), bconcat(cdirs), o]));
}
var ContentTypeMap = ({
	"htm": "text/html",
	"xml": "text/xml",

	"gif": "image/gif",
	"jpg": "image/jpeg",
	"png": "image/png",

	"mso": "application/x-mso",
	"thmx": "application/vnd.ms-officetheme",
	"sh33tj5": "application/octet-stream"
});

function get_content_type(fi, fp) {
	if(fi.ctype) return fi.ctype;

	var ext = fi.name || "", m = ext.match(/\.([^\.]+)$/);
	if(m && ContentTypeMap[m[1]]) return ContentTypeMap[m[1]];

	if(fp) {
		m = (ext = fp).match(/[\.\\]([^\.\\])+$/);
		if(m && ContentTypeMap[m[1]]) return ContentTypeMap[m[1]];
	}

	return "application/octet-stream";
}

/* 76 character chunks TODO: intertwine encoding */
function write_base64_76(bstr) {
	var data = Base64_encode(bstr);
	var o = [];
	for(var i = 0; i < data.length; i+= 76) o.push(data.slice(i, i+76));
	return o.join("\r\n") + "\r\n";
}

/*
Rules for QP:
	- escape =## applies for all non-display characters and literal "="
	- space or tab at end of line must be encoded
	- \r\n newlines can be preserved, but bare \r and \n must be escaped
	- lines must not exceed 76 characters, use soft breaks =\r\n

TODO: Some files from word appear to write line extensions with bare equals:

```
<table class=3DMsoTableGrid border=3D1 cellspacing=3D0 cellpadding=3D0 width=
="70%"
```
*/
function write_quoted_printable(text) {
	var encoded = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7E-\xFF=]/g, function(c) {
		var w = c.charCodeAt(0).toString(16).toUpperCase();
		return "=" + (w.length == 1 ? "0" + w : w);
	});

	encoded = encoded.replace(/ $/mg, "=20").replace(/\t$/mg, "=09");

	if(encoded.charAt(0) == "\n") encoded = "=0D" + encoded.slice(1);
	encoded = encoded.replace(/\r(?!\n)/mg, "=0D").replace(/\n\n/mg, "\n=0A").replace(/([^\r\n])\n/mg, "$1=0A");

	var o = [], split = encoded.split("\r\n");
	for(var si = 0; si < split.length; ++si) {
		var str = split[si];
		if(str.length == 0) { o.push(""); continue; }
		for(var i = 0; i < str.length;) {
			var end = 76;
			var tmp = str.slice(i, i + end);
			if(tmp.charAt(end - 1) == "=") end --;
			else if(tmp.charAt(end - 2) == "=") end -= 2;
			else if(tmp.charAt(end - 3) == "=") end -= 3;
			tmp = str.slice(i, i + end);
			i += end;
			if(i < str.length) tmp += "=";
			o.push(tmp);
		}
	}

	return o.join("\r\n");
}
function parse_quoted_printable(data) {
	var o = [];

	/* unify long lines */
	for(var di = 0; di < data.length; ++di) {
		var line = data[di];
		while(di <= data.length && line.charAt(line.length - 1) == "=") line = line.slice(0, line.length - 1) + data[++di];
		o.push(line);
	}

	/* decode */
	for(var oi = 0; oi < o.length; ++oi) o[oi] = o[oi].replace(/[=][0-9A-Fa-f]{2}/g, function($$) { return String.fromCharCode(parseInt($$.slice(1), 16)); });
	return s2a(o.join("\r\n"));
}


function parse_mime(cfb, data, root) {
	var fname = "", cte = "", ctype = "", fdata;
	var di = 0;
	for(;di < 10; ++di) {
		var line = data[di];
		if(!line || line.match(/^\s*$/)) break;
		var m = line.match(/^([^:]*?):\s*([^\s].*)$/);
		if(m) switch(m[1].toLowerCase()) {
			case "content-location": fname = m[2].trim(); break;
			case "content-type": ctype = m[2].trim(); break;
			case "content-transfer-encoding": cte = m[2].trim(); break;
		}
	}
	++di;
	switch(cte.toLowerCase()) {
		case 'base64': fdata = s2a(Base64_decode(data.slice(di).join(""))); break;
		case 'quoted-printable': fdata = parse_quoted_printable(data.slice(di)); break;
		default: throw new Error("Unsupported Content-Transfer-Encoding " + cte);
	}
	var file = cfb_add(cfb, fname.slice(root.length), fdata, {unsafe: true});
	if(ctype) file.ctype = ctype;
}

function parse_mad(file, options) {
	if(a2s(file.slice(0,13)).toLowerCase() != "mime-version:") throw new Error("Unsupported MAD header");
	var root = (options && options.root || "");
	// $FlowIgnore
	var data = (has_buf && Buffer.isBuffer(file) ? file.toString("binary") : a2s(file)).split("\r\n");
	var di = 0, row = "";

	/* if root is not specified, scan for the common prefix */
	for(di = 0; di < data.length; ++di) {
		row = data[di];
		if(!/^Content-Location:/i.test(row)) continue;
		row = row.slice(row.indexOf("file"));
		if(!root) root = row.slice(0, row.lastIndexOf("/") + 1);
		if(row.slice(0, root.length) == root) continue;
		while(root.length > 0) {
			root = root.slice(0, root.length - 1);
			root = root.slice(0, root.lastIndexOf("/") + 1);
			if(row.slice(0,root.length) == root) break;
		}
	}

	var mboundary = (data[1] || "").match(/boundary="(.*?)"/);
	if(!mboundary) throw new Error("MAD cannot find boundary");
	var boundary = "--" + (mboundary[1] || "");

	var FileIndex = [], FullPaths = [];
	var o = {
		FileIndex: FileIndex,
		FullPaths: FullPaths
	};
	init_cfb(o);
	var start_di, fcnt = 0;
	for(di = 0; di < data.length; ++di) {
		var line = data[di];
		if(line !== boundary && line !== boundary + "--") continue;
		if(fcnt++) parse_mime(o, data.slice(start_di, di), root);
		start_di = di;
	}
	return o;
}

function write_mad(cfb, options) {
	var opts = options || {};
	var boundary = opts.boundary || "SheetJS";
	boundary = '------=' + boundary;

	var out = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="' + boundary.slice(2) + '"',
		'',
		'',
		''
	];

	var root = cfb.FullPaths[0], fp = root, fi = cfb.FileIndex[0];
	for(var i = 1; i < cfb.FullPaths.length; ++i) {
		fp = cfb.FullPaths[i].slice(root.length);
		fi = cfb.FileIndex[i];
		if(!fi.size || !fi.content || fp == "\u0001Sh33tJ5") continue;

		/* Normalize filename */
		fp = fp.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7E-\xFF]/g, function(c) {
			return "_x" + c.charCodeAt(0).toString(16) + "_";
		}).replace(/[\u0080-\uFFFF]/g, function(u) {
			return "_u" + u.charCodeAt(0).toString(16) + "_";
		});

		/* Extract content as binary string */
		var ca = fi.content;
		// $FlowIgnore
		var cstr = has_buf && Buffer.isBuffer(ca) ? ca.toString("binary") : a2s(ca);

		/* 4/5 of first 1024 chars ascii -> quoted printable, else base64 */
		var dispcnt = 0, L = Math.min(1024, cstr.length), cc = 0;
		for(var csl = 0; csl <= L; ++csl) if((cc=cstr.charCodeAt(csl)) >= 0x20 && cc < 0x80) ++dispcnt;
		var qp = dispcnt >= L * 4 / 5;

		out.push(boundary);
		out.push('Content-Location: ' + (opts.root || 'file:///C:/SheetJS/') + fp);
		out.push('Content-Transfer-Encoding: ' + (qp ? 'quoted-printable' : 'base64'));
		out.push('Content-Type: ' + get_content_type(fi, fp));
		out.push('');

		out.push(qp ? write_quoted_printable(cstr) : write_base64_76(cstr));
	}
	out.push(boundary + '--\r\n');
	return out.join("\r\n");
}
function cfb_new(opts) {
	var o = ({});
	init_cfb(o, opts);
	return o;
}

function cfb_add(cfb, name, content, opts) {
	var unsafe = opts && opts.unsafe;
	if(!unsafe) init_cfb(cfb);
	var file = !unsafe && CFB.find(cfb, name);
	if(!file) {
		var fpath = cfb.FullPaths[0];
		if(name.slice(0, fpath.length) == fpath) fpath = name;
		else {
			if(fpath.slice(-1) != "/") fpath += "/";
			fpath = (fpath + name).replace("//","/");
		}
		file = ({name: filename(name), type: 2});
		cfb.FileIndex.push(file);
		cfb.FullPaths.push(fpath);
		if(!unsafe) CFB.utils.cfb_gc(cfb);
	}
file.content = (content);
	file.size = content ? content.length : 0;
	if(opts) {
		if(opts.CLSID) file.clsid = opts.CLSID;
		if(opts.mt) file.mt = opts.mt;
		if(opts.ct) file.ct = opts.ct;
	}
	return file;
}

function cfb_del(cfb, name) {
	init_cfb(cfb);
	var file = CFB.find(cfb, name);
	if(file) for(var j = 0; j < cfb.FileIndex.length; ++j) if(cfb.FileIndex[j] == file) {
		cfb.FileIndex.splice(j, 1);
		cfb.FullPaths.splice(j, 1);
		return true;
	}
	return false;
}

function cfb_mov(cfb, old_name, new_name) {
	init_cfb(cfb);
	var file = CFB.find(cfb, old_name);
	if(file) for(var j = 0; j < cfb.FileIndex.length; ++j) if(cfb.FileIndex[j] == file) {
		cfb.FileIndex[j].name = filename(new_name);
		cfb.FullPaths[j] = new_name;
		return true;
	}
	return false;
}

function cfb_gc(cfb) { rebuild_cfb(cfb, true); }

exports.find = find;
exports.read = read;
exports.parse = parse;
exports.write = write;
exports.writeFile = write_file;
exports.utils = {
	cfb_new: cfb_new,
	cfb_add: cfb_add,
	cfb_del: cfb_del,
	cfb_mov: cfb_mov,
	cfb_gc: cfb_gc,
	ReadShift: ReadShift,
	CheckField: CheckField,
	prep_blob: prep_blob,
	bconcat: bconcat,
	use_zlib: use_zlib,
	_deflateRaw: _deflate,
	_inflateRaw: _inflate,
	consts: consts
};

return exports;
})();

var _fs;
function set_fs(fs) { _fs = fs; }

/* normalize data for blob ctor */
function blobify(data) {
	if(typeof data === "string") return s2ab(data);
	if(Array.isArray(data)) return a2u(data);
	return data;
}
/* write or download file */
function write_dl(fname, payload, enc) {
	/*global IE_SaveFile, Blob, navigator, saveAs, document, File, chrome */
	if(typeof _fs !== 'undefined' && _fs.writeFileSync) return enc ? _fs.writeFileSync(fname, payload, enc) : _fs.writeFileSync(fname, payload);
	if(typeof Deno !== 'undefined') {
		/* in this spot, it's safe to assume typed arrays and TextEncoder/TextDecoder exist */
		if(enc && typeof payload == "string") switch(enc) {
			case "utf8": payload = new TextEncoder(enc).encode(payload); break;
			case "binary": payload = s2ab(payload); break;
			/* TODO: binary equivalent */
			default: throw new Error("Unsupported encoding " + enc);
		}
		return Deno.writeFileSync(fname, payload);
	}
	var data = (enc == "utf8") ? utf8write(payload) : payload;
if(typeof IE_SaveFile !== 'undefined') return IE_SaveFile(data, fname);
	if(typeof Blob !== 'undefined') {
		var blob = new Blob([blobify(data)], {type:"application/octet-stream"});
if(typeof navigator !== 'undefined' && navigator.msSaveBlob) return navigator.msSaveBlob(blob, fname);
if(typeof saveAs !== 'undefined') return saveAs(blob, fname);
		if(typeof URL !== 'undefined' && typeof document !== 'undefined' && document.createElement && URL.createObjectURL) {
			var url = URL.createObjectURL(blob);
if(typeof chrome === 'object' && typeof (chrome.downloads||{}).download == "function") {
				if(URL.revokeObjectURL && typeof setTimeout !== 'undefined') setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
				return chrome.downloads.download({ url: url, filename: fname, saveAs: true });
			}
			var a = document.createElement("a");
			if(a.download != null) {
a.download = fname; a.href = url; document.body.appendChild(a); a.click();
document.body.removeChild(a);
				if(URL.revokeObjectURL && typeof setTimeout !== 'undefined') setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
				return url;
			}
		} else if(typeof URL !== 'undefined' && !URL.createObjectURL && typeof chrome === 'object') {
			/* manifest v3 extensions -- no URL.createObjectURL */
			var b64 = "data:application/octet-stream;base64," + Base64_encode_arr(new Uint8Array(blobify(data)));
			return chrome.downloads.download({ url: b64, filename: fname, saveAs: true });
		}
	}
	// $FlowIgnore
	if(typeof $ !== 'undefined' && typeof File !== 'undefined' && typeof Folder !== 'undefined') try { // extendscript
		// $FlowIgnore
		var out = File(fname); out.open("w"); out.encoding = "binary";
		if(Array.isArray(payload)) payload = a2s(payload);
		out.write(payload); out.close(); return payload;
	} catch(e) { if(!e.message || e.message.indexOf("onstruct") == -1) throw e; }
	throw new Error("cannot save file " + fname);
}

/* read binary data from file */
function read_binary(path) {
	if(typeof _fs !== 'undefined') return _fs.readFileSync(path);
	if(typeof Deno !== 'undefined') return Deno.readFileSync(path);
	// $FlowIgnore
	if(typeof $ !== 'undefined' && typeof File !== 'undefined' && typeof Folder !== 'undefined') try { // extendscript
		// $FlowIgnore
		var infile = File(path); infile.open("r"); infile.encoding = "binary";
		var data = infile.read(); infile.close();
		return data;
	} catch(e) { if(!e.message || e.message.indexOf("onstruct") == -1) throw e; }
	throw new Error("Cannot access file " + path);
}
function keys(o) {
	var ks = Object.keys(o), o2 = [];
	for(var i = 0; i < ks.length; ++i) if(Object.prototype.hasOwnProperty.call(o, ks[i])) o2.push(ks[i]);
	return o2;
}

function evert_key(obj, key) {
	var o = ([]), K = keys(obj);
	for(var i = 0; i !== K.length; ++i) if(o[obj[K[i]][key]] == null) o[obj[K[i]][key]] = K[i];
	return o;
}

function evert(obj) {
	var o = ([]), K = keys(obj);
	for(var i = 0; i !== K.length; ++i) o[obj[K[i]]] = K[i];
	return o;
}

function evert_num(obj) {
	var o = ([]), K = keys(obj);
	for(var i = 0; i !== K.length; ++i) o[obj[K[i]]] = parseInt(K[i],10);
	return o;
}

function evert_arr(obj) {
	var o = ([]), K = keys(obj);
	for(var i = 0; i !== K.length; ++i) {
		if(o[obj[K[i]]] == null) o[obj[K[i]]] = [];
		o[obj[K[i]]].push(K[i]);
	}
	return o;
}

var dnthresh  = Date.UTC(1899, 11, 30, 0, 0, 0); // -2209161600000
var dnthresh1 = Date.UTC(1899, 11, 31, 0, 0, 0); // -2209075200000
var dnthresh2 = Date.UTC(1904, 0, 1, 0, 0, 0); // -2209075200000
function datenum(v, date1904) {
	var epoch = v.getTime();
	var res = (epoch - dnthresh) / (24 * 60 * 60 * 1000);
	if(date1904) { res -= 1462; return res < -1402 ? res - 1 : res; }
	return res < 60 ? res - 1 : res;
}
function numdate(v) {
	if(v >= 60 && v < 61) return v;
	var out = new Date();
	out.setTime((v>60 ? v : (v+1)) * 24 * 60 * 60 * 1000 + dnthresh);
	return out;
}

/* ISO 8601 Duration */
function parse_isodur(s) {
	var sec = 0, mt = 0, time = false;
	var m = s.match(/P([0-9\.]+Y)?([0-9\.]+M)?([0-9\.]+D)?T([0-9\.]+H)?([0-9\.]+M)?([0-9\.]+S)?/);
	if(!m) throw new Error("|" + s + "| is not an ISO8601 Duration");
	for(var i = 1; i != m.length; ++i) {
		if(!m[i]) continue;
		mt = 1;
		if(i > 3) time = true;
		switch(m[i].slice(m[i].length-1)) {
			case 'Y':
				throw new Error("Unsupported ISO Duration Field: " + m[i].slice(m[i].length-1));
			case 'D': mt *= 24;
				/* falls through */
			case 'H': mt *= 60;
				/* falls through */
			case 'M':
				if(!time) throw new Error("Unsupported ISO Duration Field: M");
				else mt *= 60;
				/* falls through */
			case 'S': break;
		}
		sec += mt * parseInt(m[i], 10);
	}
	return sec;
}

/* Blame https://bugs.chromium.org/p/v8/issues/detail?id=7863 for the regexide */
var pdre1 = /^(\d+):(\d+)(:\d+)?(\.\d+)?$/; // HH:MM[:SS[.UUU]]
var pdre2 = /^(\d+)-(\d+)-(\d+)$/; // YYYY-mm-dd
var pdre3 = /^(\d+)-(\d+)-(\d+)[T ](\d+):(\d+)(:\d+)?(\.\d+)?$/; // YYYY-mm-dd(T or space)HH:MM[:SS[.UUU]], sans "Z"
/* parses a date string as a UTC date */
function parseDate(str, date1904) {
	if(str instanceof Date) return str;
	var m = str.match(pdre1);
	if(m) return new Date((date1904 ? dnthresh2 : dnthresh1) + ((parseInt(m[1], 10)*60 + parseInt(m[2], 10))*60 + (m[3] ? parseInt(m[3].slice(1), 10) : 0))*1000 + (m[4] ? parseInt((m[4]+"000").slice(1,4), 10) : 0));
	m = str.match(pdre2);
	if(m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], 0, 0, 0, 0));
	/* TODO: 1900-02-29T00:00:00.000 should return a flag to treat as a date code (affects xlml) */
	m = str.match(pdre3);
	if(m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], ((m[6] && parseInt(m[6].slice(1), 10))|| 0), ((m[7] && parseInt((m[7] + "0000").slice(1,4), 10))||0)));
	var d = new Date(str);
	return d;
}

function cc2str(arr, debomit) {
	if(has_buf && Buffer.isBuffer(arr)) {
		if(debomit && buf_utf16le) {
			// TODO: temporary patch
			if(arr[0] == 0xFF && arr[1] == 0xFE) return utf8write(arr.slice(2).toString("utf16le"));
			if(arr[1] == 0xFE && arr[2] == 0xFF) return utf8write(utf16beread(arr.slice(2).toString("binary")));
		}
		return arr.toString("binary");
	}

	if(typeof TextDecoder !== "undefined") try {
		if(debomit) {
			if(arr[0] == 0xFF && arr[1] == 0xFE) return utf8write(new TextDecoder("utf-16le").decode(arr.slice(2)));
			if(arr[0] == 0xFE && arr[1] == 0xFF) return utf8write(new TextDecoder("utf-16be").decode(arr.slice(2)));
		}
		var rev = {
			"\u20ac": "\x80", "\u201a": "\x82", "\u0192": "\x83", "\u201e": "\x84",
			"\u2026": "\x85", "\u2020": "\x86", "\u2021": "\x87", "\u02c6": "\x88",
			"\u2030": "\x89", "\u0160": "\x8a", "\u2039": "\x8b", "\u0152": "\x8c",
			"\u017d": "\x8e", "\u2018": "\x91", "\u2019": "\x92", "\u201c": "\x93",
			"\u201d": "\x94", "\u2022": "\x95", "\u2013": "\x96", "\u2014": "\x97",
			"\u02dc": "\x98", "\u2122": "\x99", "\u0161": "\x9a", "\u203a": "\x9b",
			"\u0153": "\x9c", "\u017e": "\x9e", "\u0178": "\x9f"
		};
		if(Array.isArray(arr)) arr = new Uint8Array(arr);
		return new TextDecoder("latin1").decode(arr).replace(/[€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, function(c) { return rev[c] || c; });
	} catch(e) {}

	var o = [], i = 0;
	// this cascade is for the browsers and runtimes of antiquity (and for modern runtimes that lack TextEncoder)
	try {
		for(i = 0; i < arr.length - 65536; i+=65536) o.push(String.fromCharCode.apply(0, arr.slice(i, i + 65536)));
		o.push(String.fromCharCode.apply(0, arr.slice(i)));
	} catch(e) { try {
			for(; i < arr.length - 16384; i+=16384) o.push(String.fromCharCode.apply(0, arr.slice(i, i + 16384)));
			o.push(String.fromCharCode.apply(0, arr.slice(i)));
		} catch(e) {
			for(; i != arr.length; ++i) o.push(String.fromCharCode(arr[i]));
		}
	}
	return o.join("");
}

function dup(o) {
	if(typeof JSON != 'undefined' && !Array.isArray(o)) return JSON.parse(JSON.stringify(o));
	if(typeof o != 'object' || o == null) return o;
	if(o instanceof Date) return new Date(o.getTime());
	var out = {};
	for(var k in o) if(Object.prototype.hasOwnProperty.call(o, k)) out[k] = dup(o[k]);
	return out;
}

function fill(c,l) { var o = ""; while(o.length < l) o+=c; return o; }

/* TODO: stress test */
function fuzzynum(s) {
	var v = Number(s);
	if(!isNaN(v)) return isFinite(v) ? v : NaN;
	if(!/\d/.test(s)) return v;
	var wt = 1;
	var ss = s.replace(/([\d]),([\d])/g,"$1$2").replace(/[$]/g,"").replace(/[%]/g, function() { wt *= 100; return "";});
	if(!isNaN(v = Number(ss))) return v / wt;
	ss = ss.replace(/[(]([^()]*)[)]/,function($$, $1) { wt = -wt; return $1;});
	if(!isNaN(v = Number(ss))) return v / wt;
	return v;
}

/* NOTE: Chrome rejects bare times like 1:23 PM */
var FDRE1 = /^(0?\d|1[0-2])(?:|:([0-5]?\d)(?:|(\.\d+)(?:|:([0-5]?\d))|:([0-5]?\d)(|\.\d+)))\s+([ap])m?$/;
var FDRE2 = /^([01]?\d|2[0-3])(?:|:([0-5]?\d)(?:|(\.\d+)(?:|:([0-5]?\d))|:([0-5]?\d)(|\.\d+)))$/;
var FDISO = /^(\d+)-(\d+)-(\d+)[T ](\d+):(\d+)(:\d+)(\.\d+)?[Z]?$/; // YYYY-mm-dd(T or space)HH:MM:SS[.UUU][Z]

/* TODO: 1904 adjustment */
var utc_append_works = new Date("6/9/69 00:00 UTC").valueOf() == -17798400000;
function fuzzytime1(M)  {
	if(!M[2]) return new Date(Date.UTC(1899,11,31,(+M[1]%12) + (M[7] == "p" ? 12 : 0), 0, 0, 0));
	if(M[3]) {
			if(M[4]) return new Date(Date.UTC(1899,11,31,(+M[1]%12) + (M[7] == "p" ? 12 : 0), +M[2], +M[4], parseFloat(M[3])*1000));
			else return new Date(Date.UTC(1899,11,31,(M[7] == "p" ? 12 : 0), +M[1], +M[2], parseFloat(M[3])*1000));
	}
	else if(M[5]) return new Date(Date.UTC(1899,11,31, (+M[1]%12) + (M[7] == "p" ? 12 : 0), +M[2], +M[5], M[6] ? parseFloat(M[6]) * 1000 : 0));
	else return new Date(Date.UTC(1899,11,31,(+M[1]%12) + (M[7] == "p" ? 12 : 0), +M[2], 0, 0));
}
function fuzzytime2(M)  {
	if(!M[2]) return new Date(Date.UTC(1899,11,31,+M[1], 0, 0, 0));
	if(M[3]) {
			if(M[4]) return new Date(Date.UTC(1899,11,31,+M[1], +M[2], +M[4], parseFloat(M[3])*1000));
			else return new Date(Date.UTC(1899,11,31,0, +M[1], +M[2], parseFloat(M[3])*1000));
	}
	else if(M[5]) return new Date(Date.UTC(1899,11,31, +M[1], +M[2], +M[5], M[6] ? parseFloat(M[6]) * 1000 : 0));
	else return new Date(Date.UTC(1899,11,31,+M[1], +M[2], 0, 0));
}
var lower_months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function fuzzydate(s) {
	// See issue 2863 -- this is technically not supported in Excel but is otherwise useful
	if(FDISO.test(s)) return s.indexOf("Z") == -1 ? local_to_utc(new Date(s)) : new Date(s);
	var lower = s.toLowerCase();
	var lnos = lower.replace(/\s+/g, " ").trim();
	var M = lnos.match(FDRE1);
	if(M) return fuzzytime1(M);
	M = lnos.match(FDRE2);
	if(M) return fuzzytime2(M);
	M = lnos.match(pdre3);
	if(M) return new Date(Date.UTC(+M[1], +M[2]-1, +M[3], +M[4], +M[5], ((M[6] && parseInt(M[6].slice(1), 10))|| 0), ((M[7] && parseInt((M[7] + "0000").slice(1,4), 10))||0)));
	var o = new Date(utc_append_works && s.indexOf("UTC") == -1 ? s + " UTC": s), n = new Date(NaN);
	var y = o.getYear(), m = o.getMonth(), d = o.getDate();
	if(isNaN(d)) return n;
	if(lower.match(/jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/)) {
		lower = lower.replace(/[^a-z]/g,"").replace(/([^a-z]|^)[ap]m?([^a-z]|$)/,"");
		if(lower.length > 3 && lower_months.indexOf(lower) == -1) return n;
	} else if(lower.replace(/[ap]m?/, "").match(/[a-z]/)) return n;
	if(y < 0 || y > 8099 || s.match(/[^-0-9:,\/\\\ ]/)) return n;
	return o;
}

var split_regex = (function() {
	var safe_split_regex = "abacaba".split(/(:?b)/i).length == 5;
	return function split_regex(str, re, def) {
		if(safe_split_regex || typeof re == "string") return str.split(re);
		var p = str.split(re), o = [p[0]];
		for(var i = 1; i < p.length; ++i) { o.push(def); o.push(p[i]); }
		return o;
	};
})();

function utc_to_local(utc) {
	return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds(), utc.getUTCMilliseconds());
}
function local_to_utc(local) {
	return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds()));
}

function remove_doctype(str) {
	var preamble = str.slice(0, 1024);
	var si = preamble.indexOf("<!DOCTYPE");
	if(si == -1) return str;
	var m = str.match(/<[\w]/);
	if(!m) return str;
	return str.slice(0, si) + str.slice(m.index);
}

/* str.match(/<!--[\s\S]*?-->/g) --> str_match_ng(str, "<!--", "-->") */
function str_match_ng(str, s, e) {
  var out = [];

  var si = str.indexOf(s);
  while(si > -1) {
    var ei = str.indexOf(e, si + s.length);
		if(ei == -1) break;

		out.push(str.slice(si, ei + e.length));
		si = str.indexOf(s, ei + e.length);
	}

  return out.length > 0 ? out : null;
}

/* str.replace(/<!--[\s\S]*?-->/g, "") --> str_remove_ng(str, "<!--", "-->") */
function str_remove_ng(str, s, e) {
  var out = [], last = 0;

  var si = str.indexOf(s);
	if(si == -1) return str;
  while(si > -1) {
		out.push(str.slice(last, si));
    var ei = str.indexOf(e, si + s.length);
		if(ei == -1) break;

		if((si = str.indexOf(s, (last = ei + e.length))) == -1) out.push(str.slice(last));
	}

  return out.join("");
}

/* str.match(/<tag\b[^>]*?>([\s\S]*?)</tag>/) --> str_match_xml(str, "tag") */
var xml_boundary = { " ": 1, "\t": 1, "\r": 1, "\n": 1, ">": 1 };
function str_match_xml(str, tag) {
	var si = str.indexOf('<' + tag), w = tag.length + 1, L = str.length;
	while(si >= 0 && si <= L - w && !xml_boundary[str.charAt(si + w)]) si = str.indexOf('<' + tag, si+1);
	if(si === -1) return null;
	var sf = str.indexOf(">", si + tag.length);
	if(sf === -1) return null;
	var et = "</" + tag + ">";
	var ei = str.indexOf(et, sf);
	if(ei == -1) return null;
	return [str.slice(si, ei + et.length), str.slice(sf + 1, ei)];
}

/* str.match(/<(?:\w+:)?tag\b[^<>]*?>([\s\S]*?)<\/(?:\w+:)?tag>/) --> str_match_xml(str, "tag") */
var str_match_xml_ns = (function() {
	var str_match_xml_ns_cache = {};
	return function str_match_xml_ns(str, tag) {
		var res = str_match_xml_ns_cache[tag];
		if(!res) str_match_xml_ns_cache[tag] = res = [
			new RegExp('<(?:\\w+:)?'+tag+'\\b[^<>]*>', "g"),
			new RegExp('</(?:\\w+:)?'+tag+'>', "g")
		];
		res[0].lastIndex = res[1].lastIndex = 0;
		var m = res[0].exec(str);
		if(!m) return null;
		var si = m.index;
		var sf = res[0].lastIndex;
		res[1].lastIndex = res[0].lastIndex;
		m = res[1].exec(str);
		if(!m) return null;
		var ei = m.index;
		var ef = res[1].lastIndex;
		return [str.slice(si, ef), str.slice(sf, ei)];
	};
})();

/* str.match(/<(?:\w+:)?tag\b[^<>]*?>([\s\S]*?)<\/(?:\w+:)?tag>/g) --> str_match_xml_ns_g(str, "tag") */
var str_match_xml_ns_g = (function() {
	var str_match_xml_ns_cache = {};
	return function str_match_xml_ns(str, tag) {
		var out = [];
		var res = str_match_xml_ns_cache[tag];
		if(!res) str_match_xml_ns_cache[tag] = res = [
			new RegExp('<(?:\\w+:)?'+tag+'\\b[^<>]*>', "g"),
			new RegExp('</(?:\\w+:)?'+tag+'>', "g")
		];
		res[0].lastIndex = res[1].lastIndex = 0;
		var m;
		while((m = res[0].exec(str))) {
			var si = m.index;
			res[1].lastIndex = res[0].lastIndex;
			m = res[1].exec(str);
			if(!m) return null;
			var ef = res[1].lastIndex;
			out.push(str.slice(si, ef));
			res[0].lastIndex = res[1].lastIndex;
		}
		return out.length == 0 ? null : out;
	};
})();
var str_remove_xml_ns_g = (function() {
	var str_remove_xml_ns_cache = {};
	return function str_remove_xml_ns_g(str, tag) {
		var out = [];
		var res = str_remove_xml_ns_cache[tag];
		if(!res) str_remove_xml_ns_cache[tag] = res = [
			new RegExp('<(?:\\w+:)?'+tag+'\\b[^<>]*>', "g"),
			new RegExp('</(?:\\w+:)?'+tag+'>', "g")
		];
		res[0].lastIndex = res[1].lastIndex = 0;
		var m;
		var si = 0, ef = 0;
		while((m = res[0].exec(str))) {
			si = m.index;
			out.push(str.slice(ef, si));
			ef = si;
			res[1].lastIndex = res[0].lastIndex;
			m = res[1].exec(str);
			if(!m) return null;
			ef = res[1].lastIndex;
			res[0].lastIndex = res[1].lastIndex;
		}
		out.push(str.slice(ef));
		return out.length == 0 ? "" : out.join("");
	};
})();

/* str.match(/<(?:\w+:)?tag\b[^>]*?>([\s\S]*?)<\/(?:\w+:)?tag>/gi) --> str_match_xml_ns_ig(str, "tag") */
var str_match_xml_ig = (function() {
	var str_match_xml_ns_cache = {};
	return function str_match_xml_ns(str, tag) {
		var out = [];
		var res = str_match_xml_ns_cache[tag];
		if(!res) str_match_xml_ns_cache[tag] = res = [
			new RegExp('<'+tag+'\\b[^<>]*>', "ig"),
			new RegExp('</'+tag+'>', "ig")
		];
		res[0].lastIndex = res[1].lastIndex = 0;
		var m;
		while((m = res[0].exec(str))) {
			var si = m.index;
			res[1].lastIndex = res[0].lastIndex;
			m = res[1].exec(str);
			if(!m) return null;
			var ef = res[1].lastIndex;
			out.push(str.slice(si, ef));
			res[0].lastIndex = res[1].lastIndex;
		}
		return out.length == 0 ? null : out;
	};
})();
function getdatastr(data) {
	if(!data) return null;
	if(data.content && data.type) return cc2str(data.content, true);
	if(data.data) return debom(data.data);
	if(data.asNodeBuffer && has_buf) return debom(data.asNodeBuffer().toString('binary'));
	if(data.asBinary) return debom(data.asBinary());
	if(data._data && data._data.getContent) return debom(cc2str(Array.prototype.slice.call(data._data.getContent(),0)));
	return null;
}

function getdatabin(data) {
	if(!data) return null;
	if(data.data) return char_codes(data.data);
	if(data.asNodeBuffer && has_buf) return data.asNodeBuffer();
	if(data._data && data._data.getContent) {
		var o = data._data.getContent();
		if(typeof o == "string") return char_codes(o);
		return Array.prototype.slice.call(o);
	}
	if(data.content && data.type) return data.content;
	return null;
}

function getdata(data) { return (data && data.name.slice(-4) === ".bin") ? getdatabin(data) : getdatastr(data); }

/* Part 2 Section 10.1.2 "Mapping Content Types" Names are case-insensitive */
/* OASIS does not comment on filename case sensitivity */
function safegetzipfile(zip, file) {
	var k = zip.FullPaths || keys(zip.files);
	var f = file.toLowerCase().replace(/[\/]/g, '\\'), g = f.replace(/\\/g,'\/');
	for(var i=0; i<k.length; ++i) {
		var n = k[i].replace(/^Root Entry[\/]/,"").toLowerCase();
		if(f == n || g == n) return zip.files ? zip.files[k[i]] : zip.FileIndex[i];
	}
	return null;
}

function getzipfile(zip, file) {
	var o = safegetzipfile(zip, file);
	if(o == null) throw new Error("Cannot find file " + file + " in zip");
	return o;
}

function getzipdata(zip, file, safe) {
	if(!safe) return getdata(getzipfile(zip, file));
	if(!file) return null;
	try { return getzipdata(zip, file); } catch(e) { return null; }
}

function getzipstr(zip, file, safe) {
	if(!safe) return getdatastr(getzipfile(zip, file));
	if(!file) return null;
	try { return getzipstr(zip, file); } catch(e) { return null; }
}

function getzipbin(zip, file, safe) {
	if(!safe) return getdatabin(getzipfile(zip, file));
	if(!file) return null;
	try { return getzipbin(zip, file); } catch(e) { return null; }
}

function zipentries(zip) {
	var k = zip.FullPaths || keys(zip.files), o = [];
	for(var i = 0; i < k.length; ++i) if(k[i].slice(-1) != '/') o.push(k[i].replace(/^Root Entry[\/]/, ""));
	return o.sort();
}

function zip_add_file(zip, path, content) {
	if(zip.FullPaths) {
		if(Array.isArray(content) && typeof content[0] == "string") {
			content = content.join("");
		}
		if(typeof content == "string") {
			var res;
			if(has_buf) res = Buffer_from(content);
			/* TODO: investigate performance in Edge 13 */
			//else if(typeof TextEncoder !== "undefined") res = new TextEncoder().encode(content);
			else res = utf8decode(content);
			return CFB.utils.cfb_add(zip, path, res);
		}
		CFB.utils.cfb_add(zip, path, content);
	}
	else zip.file(path, content);
}

function zip_new() { return CFB.utils.cfb_new(); }

function zip_read(d, o) {
	switch(o.type) {
		case "base64": return CFB.read(d, { type: "base64" });
		case "binary": return CFB.read(d, { type: "binary" });
		case "buffer": case "array": return CFB.read(d, { type: "buffer" });
	}
	throw new Error("Unrecognized type " + o.type);
}

function resolve_path(path, base) {
	if(path.charAt(0) == "/") return path.slice(1);
	var result = base.split('/');
	if(base.slice(-1) != "/") result.pop(); // folder path
	var target = path.split('/');
	while (target.length !== 0) {
		var step = target.shift();
		if (step === '..') result.pop();
		else if (step !== '.') result.push(step);
	}
	return result.join('/');
}
var XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
var attregexg=/\s([^"\s?>\/]+)\s*=\s*((?:")([^"]*)(?:")|(?:')([^']*)(?:')|([^'">\s]+))/g;
var tagregex1=/<[\/\?]?[a-zA-Z0-9:_-]+(?:\s+[^"\s?<>\/]+\s*=\s*(?:"[^"]*"|'[^']*'|[^'"<>\s=]+))*\s*[\/\?]?>/mg, tagregex2 = /<[^<>]*>/g;
var tagregex = XML_HEADER.match(tagregex1) ? tagregex1 : tagregex2;
var nsregex=/<\w*:/, nsregex2 = /<(\/?)\w+:/;
function parsexmltag(tag, skip_root, skip_LC) {
	var z = ({});
	var eq = 0, c = 0;
	for(; eq !== tag.length; ++eq) if((c = tag.charCodeAt(eq)) === 32 || c === 10 || c === 13) break;
	if(!skip_root) z[0] = tag.slice(0, eq);
	if(eq === tag.length) return z;
	var m = tag.match(attregexg), j=0, v="", i=0, q="", cc="", quot = 1;
	if(m) for(i = 0; i != m.length; ++i) {
		cc = m[i].slice(1);
		for(c=0; c != cc.length; ++c) if(cc.charCodeAt(c) === 61) break;
		q = cc.slice(0,c).trim();
		while(cc.charCodeAt(c+1) == 32) ++c;
		quot = ((eq=cc.charCodeAt(c+1)) == 34 || eq == 39) ? 1 : 0;
		v = cc.slice(c+1+quot, cc.length-quot);
		for(j=0;j!=q.length;++j) if(q.charCodeAt(j) === 58) break;
		if(j===q.length) {
			if(q.indexOf("_") > 0) q = q.slice(0, q.indexOf("_")); // from ods
			z[q] = v;
			if(!skip_LC) z[q.toLowerCase()] = v;
		}
		else {
			var k = (j===5 && q.slice(0,5)==="xmlns"?"xmlns":"")+q.slice(j+1);
			if(z[k] && q.slice(j-3,j) == "ext") continue; // from ods
			z[k] = v;
			if(!skip_LC) z[k.toLowerCase()] = v;
		}
	}
	return z;
}
function parsexmltagraw(tag, skip_root, skip_LC) {
	var z = ({});
	var eq = 0, c = 0;
	for(; eq !== tag.length; ++eq) if((c = tag.charCodeAt(eq)) === 32 || c === 10 || c === 13) break;
	if(!skip_root) z[0] = tag.slice(0, eq);
	if(eq === tag.length) return z;
	var m = tag.match(attregexg), j=0, v="", i=0, q="", cc="", quot = 1;
	if(m) for(i = 0; i != m.length; ++i) {
		cc = m[i].slice(1);
		for(c=0; c != cc.length; ++c) if(cc.charCodeAt(c) === 61) break;
		q = cc.slice(0,c).trim();
		while(cc.charCodeAt(c+1) == 32) ++c;
		quot = ((eq=cc.charCodeAt(c+1)) == 34 || eq == 39) ? 1 : 0;
		v = cc.slice(c+1+quot, cc.length-quot);
		if(q.indexOf("_") > 0) q = q.slice(0, q.indexOf("_")); // from ods
		z[q] = v;
		if(!skip_LC) z[q.toLowerCase()] = v;
	}
	return z;
}
function strip_ns(x) { return x.replace(nsregex2, "<$1"); }

var encodings = {
	'&quot;': '"',
	'&apos;': "'",
	'&gt;': '>',
	'&lt;': '<',
	'&amp;': '&'
};
var rencoding = evert(encodings);
//var rencstr = "&<>'\"".split("");

// TODO: CP remap (need to read file version to determine OS)
var unescapexml = (function() {
	/* 22.4.2.4 bstr (Basic String) */
	var encregex = /&(?:quot|apos|gt|lt|amp|#x?([\da-fA-F]+));/ig, coderegex = /_x([\da-fA-F]{4})_/ig;
	function raw_unescapexml(text) {
		var s = text + '', i = s.indexOf("<![CDATA[");
		if(i == -1) return s.replace(encregex, function($$, $1) { return encodings[$$]||String.fromCharCode(parseInt($1,$$.indexOf("x")>-1?16:10))||$$; }).replace(coderegex,function(m,c) {return String.fromCharCode(parseInt(c,16));});
		var j = s.indexOf("]]>");
		return raw_unescapexml(s.slice(0, i)) + s.slice(i+9,j) + raw_unescapexml(s.slice(j+3));
	}
	return function unescapexml(text, xlsx) {
		var out = raw_unescapexml(text);
		return xlsx ? out.replace(/\r\n/g, "\n") : out;
	};
})();

var decregex=/[&<>'"]/g, charegex = /[\u0000-\u0008\u000b-\u001f\uFFFE-\uFFFF]/g;
function escapexml(text){
	var s = text + '';
	return s.replace(decregex, function(y) { return rencoding[y]; }).replace(charegex,function(s) { return "_x" + ("000"+s.charCodeAt(0).toString(16)).slice(-4) + "_";});
}
function escapexmltag(text){ return escapexml(text).replace(/ /g,"_x0020_"); }

var htmlcharegex = /[\u0000-\u001f]/g;
function escapehtml(text){
	var s = text + '';
	return s.replace(decregex, function(y) { return rencoding[y]; }).replace(/\n/g, "<br/>").replace(htmlcharegex,function(s) { return "&#x" + ("000"+s.charCodeAt(0).toString(16)).slice(-4) + ";"; });
}

function escapexlml(text){
	var s = text + '';
	return s.replace(decregex, function(y) { return rencoding[y]; }).replace(htmlcharegex,function(s) { return "&#x" + (s.charCodeAt(0).toString(16)).toUpperCase() + ";"; });
}

/* TODO: handle codepages */
var xlml_fixstr = (function() {
	var entregex = /&#(\d+);/g;
	function entrepl($$,$1) { return String.fromCharCode(parseInt($1,10)); }
	return function xlml_fixstr(str) { return str.replace(entregex,entrepl); };
})();
function xlml_unfixstr(str) { return str.replace(/(\r\n|[\r\n])/g,"\&#10;"); }

/* note: xsd:boolean valid values: true / 1 / false / 0 */
function parsexmlbool(value) {
	switch(value) {
		case 1: case true:  case '1': case 'true':  return true;
		case 0: case false: case '0': case 'false': return false;
		//default: throw new Error("Invalid xsd:boolean " + value);
	}
	return false;
}

function utf8reada(orig) {
	var out = "", i = 0, c = 0, d = 0, e = 0, f = 0, w = 0;
	while (i < orig.length) {
		c = orig.charCodeAt(i++);
		if (c < 128) { out += String.fromCharCode(c); continue; }
		d = orig.charCodeAt(i++);
		if (c>191 && c<224) { f = ((c & 31) << 6); f |= (d & 63); out += String.fromCharCode(f); continue; }
		e = orig.charCodeAt(i++);
		if (c < 240) { out += String.fromCharCode(((c & 15) << 12) | ((d & 63) << 6) | (e & 63)); continue; }
		f = orig.charCodeAt(i++);
		w = (((c & 7) << 18) | ((d & 63) << 12) | ((e & 63) << 6) | (f & 63))-65536;
		out += String.fromCharCode(0xD800 + ((w>>>10)&1023));
		out += String.fromCharCode(0xDC00 + (w&1023));
	}
	return out;
}

function utf8readb(data) {
	var out = new_raw_buf(2*data.length), w, i, j = 1, k = 0, ww=0, c;
	for(i = 0; i < data.length; i+=j) {
		j = 1;
		if((c=data.charCodeAt(i)) < 128) w = c;
		else if(c < 224) { w = (c&31)*64+(data.charCodeAt(i+1)&63); j=2; }
		else if(c < 240) { w=(c&15)*4096+(data.charCodeAt(i+1)&63)*64+(data.charCodeAt(i+2)&63); j=3; }
		else { j = 4;
			w = (c & 7)*262144+(data.charCodeAt(i+1)&63)*4096+(data.charCodeAt(i+2)&63)*64+(data.charCodeAt(i+3)&63);
			w -= 65536; ww = 0xD800 + ((w>>>10)&1023); w = 0xDC00 + (w&1023);
		}
		if(ww !== 0) { out[k++] = ww&255; out[k++] = ww>>>8; ww = 0; }
		out[k++] = w%256; out[k++] = w>>>8;
	}
	return out.slice(0,k).toString('ucs2');
}

function utf8readc(data) { return Buffer_from(data, 'binary').toString('utf8'); }

var utf8corpus = "foo bar baz\u00e2\u0098\u0083\u00f0\u009f\u008d\u00a3";
var utf8read = has_buf && (utf8readc(utf8corpus) == utf8reada(utf8corpus) && utf8readc || utf8readb(utf8corpus) == utf8reada(utf8corpus) && utf8readb) || utf8reada;

var utf8write = has_buf ? function(data) { return Buffer_from(data, 'utf8').toString("binary"); } : function(orig) {
	var out = [], i = 0, c = 0, d = 0;
	while(i < orig.length) {
		c = orig.charCodeAt(i++);
		switch(true) {
			case c < 128: out.push(String.fromCharCode(c)); break;
			case c < 2048:
				out.push(String.fromCharCode(192 + (c >> 6)));
				out.push(String.fromCharCode(128 + (c & 63)));
				break;
			case c >= 55296 && c < 57344:
				c -= 55296; d = orig.charCodeAt(i++) - 56320 + (c<<10);
				out.push(String.fromCharCode(240 + ((d >>18) & 7)));
				out.push(String.fromCharCode(144 + ((d >>12) & 63)));
				out.push(String.fromCharCode(128 + ((d >> 6) & 63)));
				out.push(String.fromCharCode(128 + (d & 63)));
				break;
			default:
				out.push(String.fromCharCode(224 + (c >> 12)));
				out.push(String.fromCharCode(128 + ((c >> 6) & 63)));
				out.push(String.fromCharCode(128 + (c & 63)));
		}
	}
	return out.join("");
};

var htmldecode = (function() {
	var entities = [
		['nbsp', ' '], ['middot', '·'],
		['quot', '"'], ['apos', "'"], ['gt',   '>'], ['lt',   '<'], ['amp',  '&']
	].map(function(x) { return [new RegExp('&' + x[0] + ';', "ig"), x[1]]; });
	return function htmldecode(str) {
		var o = str
				// Remove new lines and spaces from start of content
				.replace(/^[\t\n\r ]+/, "")
				// Remove new lines and spaces from end of content
				.replace(/(^|[^\t\n\r ])[\t\n\r ]+$/,"$1")
				// Added line which removes any white space characters after and before html tags
				.replace(/>\s+/g,">").replace(/\b\s+</g,"<")
				// Replace remaining new lines and spaces with space
				.replace(/[\t\n\r ]+/g, " ")
				// Replace <br> tags with new lines
				.replace(/<\s*[bB][rR]\s*\/?>/g,"\n")
				// Strip HTML elements
				.replace(/<[^<>]*>/g,"");
		for(var i = 0; i < entities.length; ++i) o = o.replace(entities[i][0], entities[i][1]);
		return o;
	};
})();

var vtvregex = /<\/?(?:vt:)?variant>/g, vtmregex = /<(?:vt:)([^<"'>]*)>([\s\S]*)</;
function parseVector(data, opts) {
	var h = parsexmltag(data);

	var matches = str_match_xml_ns_g(data, h.baseType)||[];
	var res = [];
	if(matches.length != h.size) {
		if(opts.WTF) throw new Error("unexpected vector length " + matches.length + " != " + h.size);
		return res;
	}
	matches.forEach(function(x) {
		var v = x.replace(vtvregex,"").match(vtmregex);
		if(v) res.push({v:utf8read(v[2]), t:v[1]});
	});
	return res;
}

var wtregex = /(^\s|\s$|\n)/;
function writetag(f,g) { return '<' + f + (g.match(wtregex)?' xml:space="preserve"' : "") + '>' + g + '</' + f + '>'; }

function wxt_helper(h) { return keys(h).map(function(k) { return " " + k + '="' + h[k] + '"';}).join(""); }
function writextag(f,g,h) { return '<' + f + ((h != null) ? wxt_helper(h) : "") + ((g != null) ? (g.match(wtregex)?' xml:space="preserve"' : "") + '>' + g + '</' + f : "/") + '>';}

function write_w3cdtf(d, t) { try { return d.toISOString().replace(/\.\d*/,""); } catch(e) { if(t) throw e; } return ""; }

function write_vt(s, xlsx) {
	switch(typeof s) {
		case 'string':
			var o = writextag('vt:lpwstr', escapexml(s));
			if(xlsx) o = o.replace(/&quot;/g, "_x0022_");
			return o;
		case 'number': return writextag((s|0)==s?'vt:i4':'vt:r8', escapexml(String(s)));
		case 'boolean': return writextag('vt:bool',s?'true':'false');
	}
	if(s instanceof Date) return writextag('vt:filetime', write_w3cdtf(s));
	throw new Error("Unable to serialize " + s);
}

function xlml_normalize(d) {
	if(has_buf && Buffer.isBuffer(d)) return d.toString('utf8');
	if(typeof d === 'string') return d;
	/* duktape */
	if(typeof Uint8Array !== 'undefined' && d instanceof Uint8Array) return utf8read(a2s(ab2a(d)));
	throw new Error("Bad input format: expected Buffer or string");
}
/* UOS uses CJK in tags, ODS uses invalid XML */
var xlmlregex = /<([\/]?)([^\s?><!\/:"]*:|)([^\s?<>:\/"]+)(?:\s+[^<>=?"'\s]+="[^"]*?")*\s*[\/]?>/mg;

var XMLNS = ({
	CORE_PROPS: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
	CUST_PROPS: "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties",
	EXT_PROPS: "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
	CT: 'http://schemas.openxmlformats.org/package/2006/content-types',
	RELS: 'http://schemas.openxmlformats.org/package/2006/relationships',
	TCMNT: 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments',
	'dc': 'http://purl.org/dc/elements/1.1/',
	'dcterms': 'http://purl.org/dc/terms/',
	'dcmitype': 'http://purl.org/dc/dcmitype/',
	'mx': 'http://schemas.microsoft.com/office/mac/excel/2008/main',
	'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'sjs': 'http://schemas.openxmlformats.org/package/2006/sheetjs/core-properties',
	'vt': 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes',
	'xsi': 'http://www.w3.org/2001/XMLSchema-instance',
	'xsd': 'http://www.w3.org/2001/XMLSchema'
});

var XMLNS_main = [
	'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
	'http://purl.oclc.org/ooxml/spreadsheetml/main',
	'http://schemas.microsoft.com/office/excel/2006/main',
	'http://schemas.microsoft.com/office/excel/2006/2'
];

var XLMLNS = ({
	'o':    'urn:schemas-microsoft-com:office:office',
	'x':    'urn:schemas-microsoft-com:office:excel',
	'ss':   'urn:schemas-microsoft-com:office:spreadsheet',
	'dt':   'uuid:C2F41010-65B3-11d1-A29F-00AA00C14882',
	'mv':   'http://macVmlSchemaUri',
	'v':    'urn:schemas-microsoft-com:vml',
	'html': 'http://www.w3.org/TR/REC-html40'
});
function read_double_le(b, idx) {
	var s = 1 - 2 * (b[idx + 7] >>> 7);
	var e = ((b[idx + 7] & 0x7f) << 4) + ((b[idx + 6] >>> 4) & 0x0f);
	var m = (b[idx+6]&0x0f);
	for(var i = 5; i >= 0; --i) m = m * 256 + b[idx + i];
	if(e == 0x7ff) return m == 0 ? (s * Infinity) : NaN;
	if(e == 0) e = -1022;
	else { e -= 1023; m += Math.pow(2,52); }
	return s * Math.pow(2, e - 52) * m;
}

function write_double_le(b, v, idx) {
	var bs = ((((v < 0) || (1/v == -Infinity)) ? 1 : 0) << 7), e = 0, m = 0;
	var av = bs ? (-v) : v;
	if(!isFinite(av)) { e = 0x7ff; m = isNaN(v) ? 0x6969 : 0; }
	else if(av == 0) e = m = 0;
	else {
		e = Math.floor(Math.log(av) / Math.LN2);
		m = av * Math.pow(2, 52 - e);
		if((e <= -1023) && (!isFinite(m) || (m < Math.pow(2,52)))) { e = -1022; }
		else { m -= Math.pow(2,52); e+=1023; }
	}
	for(var i = 0; i <= 5; ++i, m/=256) b[idx + i] = m & 0xff;
	b[idx + 6] = ((e & 0x0f) << 4) | (m & 0xf);
	b[idx + 7] = (e >> 4) | bs;
}

var ___toBuffer = function(bufs) { var x=[],w=10240; for(var i=0;i<bufs[0].length;++i) if(bufs[0][i]) for(var j=0,L=bufs[0][i].length;j<L;j+=w) x.push.apply(x, bufs[0][i].slice(j,j+w)); return x; };
var __toBuffer = has_buf ? function(bufs) { return (bufs[0].length > 0 && Buffer.isBuffer(bufs[0][0])) ? Buffer.concat(bufs[0].map(function(x) { return Buffer.isBuffer(x) ? x : Buffer_from(x); })) : ___toBuffer(bufs);} : ___toBuffer;

var ___utf16le = function(b,s,e) { var ss=[]; for(var i=s; i<e; i+=2) ss.push(String.fromCharCode(__readUInt16LE(b,i))); return ss.join("").replace(chr0,''); };
var __utf16le = has_buf ? function(b,s,e) { if(!Buffer.isBuffer(b) || !buf_utf16le) return ___utf16le(b,s,e); return b.toString('utf16le',s,e).replace(chr0,'')/*.replace(chr1,'!')*/; } : ___utf16le;

var ___hexlify = function(b,s,l) { var ss=[]; for(var i=s; i<s+l; ++i) ss.push(("0" + b[i].toString(16)).slice(-2)); return ss.join(""); };
var __hexlify = has_buf ? function(b,s,l) { return Buffer.isBuffer(b) ? b.toString('hex',s,s+l) : ___hexlify(b,s,l); } : ___hexlify;

var ___utf8 = function(b,s,e) { var ss=[]; for(var i=s; i<e; i++) ss.push(String.fromCharCode(__readUInt8(b,i))); return ss.join(""); };
var __utf8 = has_buf ? function utf8_b(b, s, e) { return (Buffer.isBuffer(b)) ? b.toString('utf8',s,e) : ___utf8(b,s,e); } : ___utf8;

var ___lpstr = function(b,i) { var len = __readUInt32LE(b,i); return len > 0 ? __utf8(b, i+4,i+4+len-1) : "";};
var __lpstr = ___lpstr;

var ___cpstr = function(b,i) { var len = __readUInt32LE(b,i); return len > 0 ? __utf8(b, i+4,i+4+len-1) : "";};
var __cpstr = ___cpstr;

var ___lpwstr = function(b,i) { var len = 2*__readUInt32LE(b,i); return len > 0 ? __utf8(b, i+4,i+4+len-1) : "";};
var __lpwstr = ___lpwstr;

var ___lpp4 = function lpp4_(b,i) { var len = __readUInt32LE(b,i); return len > 0 ? __utf16le(b, i+4,i+4+len) : "";};
var __lpp4 = ___lpp4;

var ___8lpp4 = function(b,i) { var len = __readUInt32LE(b,i); return len > 0 ? __utf8(b, i+4,i+4+len) : "";};
var __8lpp4 = ___8lpp4;

var ___double = function(b, idx) { return read_double_le(b, idx);};
var __double = ___double;

var is_buf = function is_buf_a(a) { return Array.isArray(a) || (typeof Uint8Array !== "undefined" && a instanceof Uint8Array); };

if(has_buf) {
	__lpstr = function lpstr_b(b, i) { if(!Buffer.isBuffer(b)) return ___lpstr(b, i); var len = b.readUInt32LE(i); return len > 0 ? b.toString('utf8',i+4,i+4+len-1) : "";};
	__cpstr = function cpstr_b(b, i) { if(!Buffer.isBuffer(b)) return ___cpstr(b, i); var len = b.readUInt32LE(i); return len > 0 ? b.toString('utf8',i+4,i+4+len-1) : "";};
	__lpwstr = function lpwstr_b(b, i) { if(!Buffer.isBuffer(b) || !buf_utf16le) return ___lpwstr(b, i); var len = 2*b.readUInt32LE(i); return b.toString('utf16le',i+4,i+4+len-1);};
	__lpp4 = function lpp4_b(b, i) { if(!Buffer.isBuffer(b) || !buf_utf16le) return ___lpp4(b, i); var len = b.readUInt32LE(i); return b.toString('utf16le',i+4,i+4+len);};
	__8lpp4 = function lpp4_8b(b, i) { if(!Buffer.isBuffer(b)) return ___8lpp4(b, i); var len = b.readUInt32LE(i); return b.toString('utf8',i+4,i+4+len);};
	__double = function double_(b, i) { if(Buffer.isBuffer(b)) return b.readDoubleLE(i); return ___double(b,i); };
	is_buf = function is_buf_b(a) { return Buffer.isBuffer(a) || Array.isArray(a) || (typeof Uint8Array !== "undefined" && a instanceof Uint8Array); };
}

/* from js-xls */
function cpdoit() {
	__utf16le = function(b,s,e) { return $cptable.utils.decode(1200, b.slice(s,e)).replace(chr0, ''); };
	__utf8 = function(b,s,e) { return $cptable.utils.decode(65001, b.slice(s,e)); };
	__lpstr = function(b,i) { var len = __readUInt32LE(b,i); return len > 0 ? $cptable.utils.decode(current_ansi, b.slice(i+4, i+4+len-1)) : "";};
	__cpstr = function(b,i) { var len = __readUInt32LE(b,i); return len > 0 ? $cptable.utils.decode(current_codepage, b.slice(i+4, i+4+len-1)) : "";};
	__lpwstr = function(b,i) { var len = 2*__readUInt32LE(b,i); return len > 0 ? $cptable.utils.decode(1200, b.slice(i+4,i+4+len-1)) : "";};
	__lpp4 = function(b,i) { var len = __readUInt32LE(b,i); return len > 0 ? $cptable.utils.decode(1200, b.slice(i+4,i+4+len)) : "";};
	__8lpp4 = function(b,i) { var len = __readUInt32LE(b,i); return len > 0 ? $cptable.utils.decode(65001, b.slice(i+4,i+4+len)) : "";};
}
if(typeof $cptable !== 'undefined') cpdoit();

var __readUInt8 = function(b, idx) { return b[idx]; };
var __readUInt16LE = function(b, idx) { return (b[idx+1]*(1<<8))+b[idx]; };
var __readInt16LE = function(b, idx) { var u = (b[idx+1]*(1<<8))+b[idx]; return (u < 0x8000) ? u : ((0xffff - u + 1) * -1); };
var __readUInt32LE = function(b, idx) { return b[idx+3]*(1<<24)+(b[idx+2]<<16)+(b[idx+1]<<8)+b[idx]; };
var __readInt32LE = function(b, idx) { return (b[idx+3]<<24)|(b[idx+2]<<16)|(b[idx+1]<<8)|b[idx]; };
var __readInt32BE = function(b, idx) { return (b[idx]<<24)|(b[idx+1]<<16)|(b[idx+2]<<8)|b[idx+3]; };

function ReadShift(size, t) {
	var o="", oI, oR, oo=[], w, vv, i, loc;
	switch(t) {
		case 'dbcs':
			loc = this.l;
			if(has_buf && Buffer.isBuffer(this)  && buf_utf16le) o = this.slice(this.l, this.l+2*size).toString("utf16le");
			else for(i = 0; i < size; ++i) { o+=String.fromCharCode(__readUInt16LE(this, loc)); loc+=2; }
			size *= 2;
			break;

		case 'utf8': o = __utf8(this, this.l, this.l + size); break;
		case 'utf16le': size *= 2; o = __utf16le(this, this.l, this.l + size); break;

		case 'wstr':
			if(typeof $cptable !== 'undefined') o = $cptable.utils.decode(current_codepage, this.slice(this.l, this.l+2*size));
			else return ReadShift.call(this, size, 'dbcs');
			size = 2 * size; break;

		/* [MS-OLEDS] 2.1.4 LengthPrefixedAnsiString */
		case 'lpstr-ansi': o = __lpstr(this, this.l); size = 4 + __readUInt32LE(this, this.l); break;
		case 'lpstr-cp': o = __cpstr(this, this.l); size = 4 + __readUInt32LE(this, this.l); break;
		/* [MS-OLEDS] 2.1.5 LengthPrefixedUnicodeString */
		case 'lpwstr': o = __lpwstr(this, this.l); size = 4 + 2 * __readUInt32LE(this, this.l); break;
		/* [MS-OFFCRYPTO] 2.1.2 Length-Prefixed Padded Unicode String (UNICODE-LP-P4) */
		case 'lpp4': size = 4 +  __readUInt32LE(this, this.l); o = __lpp4(this, this.l); if(size & 0x02) size += 2; break;
		/* [MS-OFFCRYPTO] 2.1.3 Length-Prefixed UTF-8 String (UTF-8-LP-P4) */
		case '8lpp4': size = 4 +  __readUInt32LE(this, this.l); o = __8lpp4(this, this.l); if(size & 0x03) size += 4 - (size & 0x03); break;

		case 'cstr': size = 0; o = "";
			while((w=__readUInt8(this, this.l + size++))!==0) oo.push(_getchar(w));
			o = oo.join(""); break;
		case '_wstr': size = 0; o = "";
			while((w=__readUInt16LE(this,this.l +size))!==0){oo.push(_getchar(w));size+=2;}
			size+=2; o = oo.join(""); break;

		/* sbcs and dbcs support continue records in the SST way TODO codepages */
		case 'dbcs-cont': o = ""; loc = this.l;
			for(i = 0; i < size; ++i) {
				if(this.lens && this.lens.indexOf(loc) !== -1) {
					w = __readUInt8(this, loc);
					this.l = loc + 1;
					vv = ReadShift.call(this, size-i, w ? 'dbcs-cont' : 'sbcs-cont');
					return oo.join("") + vv;
				}
				oo.push(_getchar(__readUInt16LE(this, loc)));
				loc+=2;
			} o = oo.join(""); size *= 2; break;

		case 'cpstr':
			if(typeof $cptable !== 'undefined') {
				o = $cptable.utils.decode(current_codepage, this.slice(this.l, this.l + size));
				break;
			}
		/* falls through */
		case 'sbcs-cont': o = ""; loc = this.l;
			for(i = 0; i != size; ++i) {
				if(this.lens && this.lens.indexOf(loc) !== -1) {
					w = __readUInt8(this, loc);
					this.l = loc + 1;
					vv = ReadShift.call(this, size-i, w ? 'dbcs-cont' : 'sbcs-cont');
					return oo.join("") + vv;
				}
				oo.push(_getchar(__readUInt8(this, loc)));
				loc+=1;
			} o = oo.join(""); break;

		default:
	switch(size) {
		case 1: oI = __readUInt8(this, this.l); this.l++; return oI;
		case 2: oI = (t === 'i' ? __readInt16LE : __readUInt16LE)(this, this.l); this.l += 2; return oI;
		case 4: case -4:
			if(t === 'i' || ((this[this.l+3] & 0x80)===0)) { oI = ((size > 0) ? __readInt32LE : __readInt32BE)(this, this.l); this.l += 4; return oI; }
			else { oR = __readUInt32LE(this, this.l); this.l += 4; } return oR;
		case 8: case -8:
			if(t === 'f') {
				if(size == 8) oR = __double(this, this.l);
				else oR = __double([this[this.l+7],this[this.l+6],this[this.l+5],this[this.l+4],this[this.l+3],this[this.l+2],this[this.l+1],this[this.l+0]], 0);
				this.l += 8; return oR;
			} else size = 8;
		/* falls through */
		case 16: o = __hexlify(this, this.l, size); break;
	}}
	this.l+=size; return o;
}

var __writeUInt32LE = function(b, val, idx) { b[idx] = (val & 0xFF); b[idx+1] = ((val >>> 8) & 0xFF); b[idx+2] = ((val >>> 16) & 0xFF); b[idx+3] = ((val >>> 24) & 0xFF); };
var __writeInt32LE  = function(b, val, idx) { b[idx] = (val & 0xFF); b[idx+1] = ((val >> 8) & 0xFF); b[idx+2] = ((val >> 16) & 0xFF); b[idx+3] = ((val >> 24) & 0xFF); };
var __writeUInt16LE = function(b, val, idx) { b[idx] = (val & 0xFF); b[idx+1] = ((val >>> 8) & 0xFF); };

function WriteShift(t, val, f) {
	var size = 0, i = 0;
	if(f === 'dbcs') {
for(i = 0; i != val.length; ++i) __writeUInt16LE(this, val.charCodeAt(i), this.l + 2 * i);
		size = 2 * val.length;
	} else if(f === 'sbcs' || f == 'cpstr') {
		if(typeof $cptable !== 'undefined' && current_ansi == 874) {
			/* TODO: use tables directly, don't encode */
for(i = 0; i != val.length; ++i) {
				var cpp = $cptable.utils.encode(current_ansi, val.charAt(i));
				this[this.l + i] = cpp[0];
			}
			size = val.length;
		} else if(typeof $cptable !== 'undefined' && f == 'cpstr') {
			cpp = $cptable.utils.encode(current_codepage, val);
			/* replace null bytes with _ when relevant */
      if(cpp.length == val.length) for(i = 0; i < val.length; ++i) if(cpp[i] == 0 && val.charCodeAt(i) != 0) cpp[i] = 0x5F;
      if(cpp.length == 2 * val.length) for(i = 0; i < val.length; ++i) if(cpp[2*i] == 0 && cpp[2*i+1] == 0 && val.charCodeAt(i) != 0) cpp[2*i] = 0x5F;
			for(i = 0; i < cpp.length; ++i) this[this.l + i] = cpp[i];
			size = cpp.length;
		} else {
val = val.replace(/[^\x00-\x7F]/g, "_");
for(i = 0; i != val.length; ++i) this[this.l + i] = (val.charCodeAt(i) & 0xFF);
			size = val.length;
		}
	} else if(f === 'hex') {
		for(; i < t; ++i) {
this[this.l++] = (parseInt(val.slice(2*i, 2*i+2), 16)||0);
		} return this;
	} else if(f === 'utf16le') {
var end = Math.min(this.l + t, this.length);
			for(i = 0; i < Math.min(val.length, t); ++i) {
				var cc = val.charCodeAt(i);
				this[this.l++] = (cc & 0xff);
				this[this.l++] = (cc >> 8);
			}
			while(this.l < end) this[this.l++] = 0;
			return this;
	} else  switch(t) {
		case  1: size = 1; this[this.l] = val&0xFF; break;
		case  2: size = 2; this[this.l] = val&0xFF; val >>>= 8; this[this.l+1] = val&0xFF; break;
		case  3: size = 3; this[this.l] = val&0xFF; val >>>= 8; this[this.l+1] = val&0xFF; val >>>= 8; this[this.l+2] = val&0xFF; break;
		case  4: size = 4; __writeUInt32LE(this, val, this.l); break;
		case  8: size = 8; if(f === 'f') { write_double_le(this, val, this.l); break; }
		/* falls through */
		case 16: break;
		case -4: size = 4; __writeInt32LE(this, val, this.l); break;
	}
	this.l += size; return this;
}

function CheckField(hexstr, fld) {
	var m = __hexlify(this,this.l,hexstr.length>>1);
	if(m !== hexstr) throw new Error(fld + 'Expected ' + hexstr + ' saw ' + m);
	this.l += hexstr.length>>1;
}

function prep_blob(blob, pos) {
	blob.l = pos;
	blob.read_shift = ReadShift;
	blob.chk = CheckField;
	blob.write_shift = WriteShift;
}

function parsenoop(blob, length) { blob.l += length; }

function new_buf(sz) {
	var o = new_raw_buf(sz);
	prep_blob(o, 0);
	return o;
}

/* [MS-XLSB] 2.1.4 Record */
function recordhopper(data, cb, opts) {
	if(!data) return;
	var tmpbyte, cntbyte, length;
	prep_blob(data, data.l || 0);
	var L = data.length, RT = 0, tgt = 0;
	while(data.l < L) {
		RT = data.read_shift(1);
		if(RT & 0x80) RT = (RT & 0x7F) + ((data.read_shift(1) & 0x7F)<<7);
		var R = XLSBRecordEnum[RT] || XLSBRecordEnum[0xFFFF];
		tmpbyte = data.read_shift(1);
		length = tmpbyte & 0x7F;
		for(cntbyte = 1; cntbyte <4 && (tmpbyte & 0x80); ++cntbyte) length += ((tmpbyte = data.read_shift(1)) & 0x7F)<<(7*cntbyte);
		tgt = data.l + length;
		var d = R.f && R.f(data, length, opts);
		data.l = tgt;
		if(cb(d, R, RT)) return;
	}
}

/* control buffer usage for fixed-length buffers */
function buf_array() {
	var bufs = [], blksz = has_buf ? 16384 : 2048;
	var has_buf_copy = has_buf && (typeof new_buf(blksz).copy == "function");
	var newblk = function ba_newblk(sz) {
		var o = (new_buf(sz));
		prep_blob(o, 0);
		return o;
	};

	var curbuf = newblk(blksz);

	var endbuf = function ba_endbuf() {
		if(!curbuf) return;
		// workaround for new Buffer(3).slice(0,0) bug in bun 0.1.3
		if(curbuf.l) {
			if(curbuf.length > curbuf.l) { curbuf = curbuf.slice(0, curbuf.l); curbuf.l = curbuf.length; }
			if(curbuf.length > 0) bufs.push(curbuf);
		}
		curbuf = null;
	};

	var next = function ba_next(sz) {
		if(curbuf && (sz < (curbuf.length - curbuf.l))) return curbuf;
		endbuf();
		return (curbuf = newblk(Math.max(sz+1, blksz)));
	};

	var end = function ba_end() {
		endbuf();
		return bconcat(bufs);
	};
	var end2 = function() {
		endbuf(); return bufs;
	};

	var push = function ba_push(buf) {
		endbuf(); curbuf = buf; if(curbuf.l == null) curbuf.l = curbuf.length; next(blksz);
	};

	return ({ next:next, push:push, end:end, _bufs:bufs, end2:end2 });
}

function write_record(ba, type, payload, length) {
	var t = +type, l;
	if(isNaN(t)) return; // TODO: throw something here?
	if(!length) length = XLSBRecordEnum[t].p || (payload||[]).length || 0;
	l = 1 + (t >= 0x80 ? 1 : 0) + 1/* + length*/;
	if(length >= 0x80) ++l; if(length >= 0x4000) ++l; if(length >= 0x200000) ++l;
	var o = ba.next(l);
	if(t <= 0x7F) o.write_shift(1, t);
	else {
		o.write_shift(1, (t & 0x7F) + 0x80);
		o.write_shift(1, (t >> 7));
	}
	for(var i = 0; i != 4; ++i) {
		if(length >= 0x80) { o.write_shift(1, (length & 0x7F)+0x80); length >>= 7; }
		else { o.write_shift(1, length); break; }
	}
	if(length > 0 && is_buf(payload)) ba.push(payload);
}
/* XLS ranges enforced */
function shift_cell_xls(cell, tgt, opts) {
	var out = dup(cell);
	if(tgt.s) {
		if(out.cRel) out.c += tgt.s.c;
		if(out.rRel) out.r += tgt.s.r;
	} else {
		if(out.cRel) out.c += tgt.c;
		if(out.rRel) out.r += tgt.r;
	}
	if(!opts || opts.biff < 12) {
		while(out.c >= 0x100) out.c -= 0x100;
		while(out.r >= 0x10000) out.r -= 0x10000;
	}
	return out;
}

function shift_range_xls(cell, range, opts) {
	var out = dup(cell);
	out.s = shift_cell_xls(out.s, range.s, opts);
	out.e = shift_cell_xls(out.e, range.s, opts);
	return out;
}

function encode_cell_xls(c, biff) {
	if(c.cRel && c.c < 0) { c = dup(c); while(c.c < 0) c.c += (biff > 8) ? 0x4000 : 0x100; }
	if(c.rRel && c.r < 0) { c = dup(c); while(c.r < 0) c.r += (biff > 8) ? 0x100000 : ((biff > 5) ? 0x10000 : 0x4000); }
	var s = encode_cell(c);
	if(!c.cRel && c.cRel != null) s = fix_col(s);
	if(!c.rRel && c.rRel != null) s = fix_row(s);
	return s;
}

function encode_range_xls(r, opts) {
	if(r.s.r == 0 && !r.s.rRel) {
		if(r.e.r == (opts.biff >= 12 ? 0xFFFFF : (opts.biff >= 8 ? 0x10000 : 0x4000)) && !r.e.rRel) {
			return (r.s.cRel ? "" : "$") + encode_col(r.s.c) + ":" + (r.e.cRel ? "" : "$") + encode_col(r.e.c);
		}
	}
	if(r.s.c == 0 && !r.s.cRel) {
		if(r.e.c == (opts.biff >= 12 ? 0x3FFF : 0xFF) && !r.e.cRel) {
			return (r.s.rRel ? "" : "$") + encode_row(r.s.r) + ":" + (r.e.rRel ? "" : "$") + encode_row(r.e.r);
		}
	}
	return encode_cell_xls(r.s, opts.biff) + ":" + encode_cell_xls(r.e, opts.biff);
}
if(typeof cptable !== 'undefined') set_cptable(cptable);
else if(typeof module !== "undefined" && typeof require !== 'undefined') {
	set_cptable(undefined);
}
function decode_row(rowstr) { return parseInt(unfix_row(rowstr),10) - 1; }
function encode_row(row) { return "" + (row + 1); }
function fix_row(cstr) { return cstr.replace(/([A-Z]|^)(\d+)$/,"$1$$$2"); }
function unfix_row(cstr) { return cstr.replace(/\$(\d+)$/,"$1"); }

function decode_col(colstr) { var c = unfix_col(colstr), d = 0, i = 0; for(; i !== c.length; ++i) d = 26*d + c.charCodeAt(i) - 64; return d - 1; }
function encode_col(col) { if(col < 0) throw new Error("invalid column " + col); var s=""; for(++col; col; col=Math.floor((col-1)/26)) s = String.fromCharCode(((col-1)%26) + 65) + s; return s; }
function fix_col(cstr) { return cstr.replace(/^([A-Z])/,"$$$1"); }
function unfix_col(cstr) { return cstr.replace(/^\$([A-Z])/,"$1"); }

function split_cell(cstr) { return cstr.replace(/(\$?[A-Z]*)(\$?\d*)/,"$1,$2").split(","); }
function decode_cell(cstr) {
	var R = 0, C = 0;
	for(var i = 0; i < cstr.length; ++i) {
		var cc = cstr.charCodeAt(i);
		if(cc >= 48 && cc <= 57) R = 10 * R + (cc - 48);
		else if(cc >= 65 && cc <= 90) C = 26 * C + (cc - 64);
	}
	return { c: C - 1, r:R - 1 };
}
function encode_cell(cell) {
	var col = cell.c + 1;
	var s="";
	for(; col; col=((col-1)/26)|0) s = String.fromCharCode(((col-1)%26) + 65) + s;
	return s + (cell.r + 1);
}
function decode_range(range) {
	var idx = range.indexOf(":");
	if(idx == -1) return { s: decode_cell(range), e: decode_cell(range) };
	return { s: decode_cell(range.slice(0, idx)), e: decode_cell(range.slice(idx + 1)) };
}
function encode_range(cs,ce) {
	if(typeof ce === 'undefined' || typeof ce === 'number') {
return encode_range(cs.s, cs.e);
	}
if(typeof cs !== 'string') cs = encode_cell((cs));
	if(typeof ce !== 'string') ce = encode_cell((ce));
return cs == ce ? cs : cs + ":" + ce;
}
function fix_range(a1) {
	var s = decode_range(a1);
	return "$" + encode_col(s.s.c) + "$" + encode_row(s.s.r) + ":$" + encode_col(s.e.c) + "$" + encode_row(s.e.r);
}

// List of invalid characters needs to be tested further
function formula_quote_sheet_name(sname, opts) {
	if(!sname && !(opts && opts.biff <= 5 && opts.biff >= 2)) throw new Error("empty sheet name");
	if (/[^\w\u4E00-\u9FFF\u3040-\u30FF]/.test(sname)) return "'" + sname.replace(/'/g, "''") + "'";
	return sname;
}

function safe_decode_range(range) {
	var o = {s:{c:0,r:0},e:{c:0,r:0}};
	var idx = 0, i = 0, cc = 0;
	var len = range.length;
	for(idx = 0; i < len; ++i) {
		if((cc=range.charCodeAt(i)-64) < 1 || cc > 26) break;
		idx = 26*idx + cc;
	}
	o.s.c = --idx;

	for(idx = 0; i < len; ++i) {
		if((cc=range.charCodeAt(i)-48) < 0 || cc > 9) break;
		idx = 10*idx + cc;
	}
	o.s.r = --idx;

	if(i === len || cc != 10) { o.e.c=o.s.c; o.e.r=o.s.r; return o; }
	++i;

	for(idx = 0; i != len; ++i) {
		if((cc=range.charCodeAt(i)-64) < 1 || cc > 26) break;
		idx = 26*idx + cc;
	}
	o.e.c = --idx;

	for(idx = 0; i != len; ++i) {
		if((cc=range.charCodeAt(i)-48) < 0 || cc > 9) break;
		idx = 10*idx + cc;
	}
	o.e.r = --idx;
	return o;
}

function safe_format_cell(cell, v) {
	var q = (cell.t == 'd' && v instanceof Date);
	if(cell.z != null) try { return (cell.w = SSF_format(cell.z, q ? datenum(v) : v)); } catch(e) { }
	try { return (cell.w = SSF_format((cell.XF||{}).numFmtId||(q ? 14 : 0),  q ? datenum(v) : v)); } catch(e) { return ''+v; }
}

function format_cell(cell, v, o) {
	if(cell == null || cell.t == null || cell.t == 'z') return "";
	if(cell.w !== undefined) return cell.w;
	if(cell.t == 'd' && !cell.z && o && o.dateNF) cell.z = o.dateNF;
	if(cell.t == "e") return BErr[cell.v] || cell.v;
	if(v == undefined) return safe_format_cell(cell, cell.v);
	return safe_format_cell(cell, v);
}

function sheet_to_workbook(sheet, opts) {
	var n = opts && opts.sheet ? opts.sheet : "Sheet1";
	var sheets = {}; sheets[n] = sheet;
	return { SheetNames: [n], Sheets: sheets };
}

function sheet_new(opts) {
	var out = {};
	var o = opts || {};
	if(o.dense) out["!data"] = [];
	return out;
}

function sheet_add_aoa(_ws, data, opts) {
	var o = opts || {};
	var dense = _ws ? (_ws["!data"] != null) : o.dense;
	if(DENSE != null && dense == null) dense = DENSE;
	var ws = _ws || (dense ? ({"!data": []}) : ({}));
	if(dense && !ws["!data"]) ws["!data"] = [];
	var _R = 0, _C = 0;
	if(ws && o.origin != null) {
		if(typeof o.origin == 'number') _R = o.origin;
		else {
			var _origin = typeof o.origin == "string" ? decode_cell(o.origin) : o.origin;
			_R = _origin.r; _C = _origin.c;
		}
	}
	var range = ({s: {c:10000000, r:10000000}, e: {c:0, r:0}});
	if(ws["!ref"]){
		var _range = safe_decode_range(ws['!ref']);
		range.s.c = _range.s.c;
		range.s.r = _range.s.r;
		range.e.c = Math.max(range.e.c, _range.e.c);
		range.e.r = Math.max(range.e.r, _range.e.r);
		if(_R == -1) range.e.r = _R = (ws["!ref"] ? _range.e.r + 1 : 0);
	} else {
		range.s.c = range.e.c = range.s.r = range.e.r = 0;
	}
	var row = [], seen = false;
	for(var R = 0; R != data.length; ++R) {
		if(!data[R]) continue;
		if(!Array.isArray(data[R])) throw new Error("aoa_to_sheet expects an array of arrays");
		var __R = _R + R;
		if(dense) {
			if(!ws["!data"][__R]) ws["!data"][__R] = [];
			row = ws["!data"][__R];
		}
		var data_R = data[R];
		for(var C = 0; C != data_R.length; ++C) {
			if(typeof data_R[C] === 'undefined') continue;
			var cell = ({v: data_R[C], t:"" });
			var __C = _C + C;
			if(range.s.r > __R) range.s.r = __R;
			if(range.s.c > __C) range.s.c = __C;
			if(range.e.r < __R) range.e.r = __R;
			if(range.e.c < __C) range.e.c = __C;
			seen = true;
			if(data_R[C] && typeof data_R[C] === 'object' && !Array.isArray(data_R[C]) && !(data_R[C] instanceof Date)) cell = data_R[C];
			else {
				if(Array.isArray(cell.v)) { cell.f = data_R[C][1]; cell.v = cell.v[0]; }
				if(cell.v === null) {
					if(cell.f) cell.t = 'n';
					else if(o.nullError) { cell.t = 'e'; cell.v = 0; }
					else if(!o.sheetStubs) continue;
					else cell.t = 'z';
				}
				else if(typeof cell.v === 'number') {
					if(isFinite(cell.v)) cell.t = 'n';
					else if(isNaN(cell.v)) { cell.t = 'e'; cell.v = 0x0F; /* #VALUE! */ }
					else { cell.t = 'e'; cell.v = 0x07;  }
				}
				else if(typeof cell.v === 'boolean') cell.t = 'b';
				else if(cell.v instanceof Date) {
					cell.z = o.dateNF || table_fmt[14];
					if(!o.UTC) cell.v = local_to_utc(cell.v);
					if(o.cellDates) { cell.t = 'd'; cell.w = SSF_format(cell.z, datenum(cell.v, o.date1904)); }
					else { cell.t = 'n'; cell.v = datenum(cell.v, o.date1904); cell.w = SSF_format(cell.z, cell.v); }
				}
				else cell.t = 's';
			}
			if(dense) {
				if(row[__C] && row[__C].z) cell.z = row[__C].z;
				row[__C] = cell;
			} else {
				var cell_ref = encode_col(__C) + (__R + 1);
				if(ws[cell_ref] && ws[cell_ref].z) cell.z = ws[cell_ref].z;
				ws[cell_ref] = cell;
			}
		}
	}
	if(seen && range.s.c < 10400000) ws['!ref'] = encode_range(range);
	return ws;
}
function aoa_to_sheet(data, opts) { return sheet_add_aoa(null, data, opts); }
function parse_Int32LE(data) {
	return data.read_shift(4, 'i');
}
function write_UInt32LE(x, o) {
	if (!o) o = new_buf(4);
	o.write_shift(4, x);
	return o;
}

/* [MS-XLSB] 2.5.168 */
function parse_XLWideString(data) {
	var cchCharacters = data.read_shift(4);
	return cchCharacters === 0 ? "" : data.read_shift(cchCharacters, 'dbcs');
}
function write_XLWideString(data, o) {
	var _null = false; if (o == null) { _null = true; o = new_buf(4 + 2 * data.length); }
	o.write_shift(4, data.length);
	if (data.length > 0) o.write_shift(0, data, 'dbcs');
	return _null ? o.slice(0, o.l) : o;
}

/* [MS-XLSB] 2.5.91 */
//function parse_LPWideString(data) {
//	var cchCharacters = data.read_shift(2);
//	return cchCharacters === 0 ? "" : data.read_shift(cchCharacters, "utf16le");
//}

/* [MS-XLSB] 2.5.143 */
function parse_StrRun(data) {
	return { ich: data.read_shift(2), ifnt: data.read_shift(2) };
}
function write_StrRun(run, o) {
	if (!o) o = new_buf(4);
	o.write_shift(2, run.ich || 0);
	o.write_shift(2, run.ifnt || 0);
	return o;
}

/* [MS-XLSB] 2.5.121 */
function parse_RichStr(data, length) {
	var start = data.l;
	var flags = data.read_shift(1);
	var str = parse_XLWideString(data);
	var rgsStrRun = [];
	var z = ({ t: str, h: str });
	if ((flags & 1) !== 0) { /* fRichStr */
		/* TODO: formatted string */
		var dwSizeStrRun = data.read_shift(4);
		for (var i = 0; i != dwSizeStrRun; ++i) rgsStrRun.push(parse_StrRun(data));
		z.r = rgsStrRun;
	}
	else z.r = [{ ich: 0, ifnt: 0 }];
	//if((flags & 2) !== 0) { /* fExtStr */
	//	/* TODO: phonetic string */
	//}
	data.l = start + length;
	return z;
}
function write_RichStr(str, o) {
	/* TODO: formatted string */
	var _null = false; if (o == null) { _null = true; o = new_buf(15 + 4 * str.t.length); }
	o.write_shift(1, 0);
	write_XLWideString(str.t, o);
	return _null ? o.slice(0, o.l) : o;
}
/* [MS-XLSB] 2.4.328 BrtCommentText (RichStr w/1 run) */
var parse_BrtCommentText = parse_RichStr;
function write_BrtCommentText(str, o) {
	/* TODO: formatted string */
	var _null = false; if (o == null) { _null = true; o = new_buf(23 + 4 * str.t.length); }
	o.write_shift(1, 1);
	write_XLWideString(str.t, o);
	o.write_shift(4, 1);
	write_StrRun({ ich: 0, ifnt: 0 }, o);
	return _null ? o.slice(0, o.l) : o;
}

/* [MS-XLSB] 2.5.9 */
function parse_XLSBCell(data) {
	var col = data.read_shift(4);
	var iStyleRef = data.read_shift(2);
	iStyleRef += data.read_shift(1) << 16;
	data.l++; //var fPhShow = data.read_shift(1);
	return { c: col, iStyleRef: iStyleRef };
}
function write_XLSBCell(cell, o) {
	if (o == null) o = new_buf(8);
	o.write_shift(-4, cell.c);
	o.write_shift(3, cell.iStyleRef || cell.s);
	o.write_shift(1, 0); /* fPhShow */
	return o;
}

/* Short XLSB Cell does not include column */
function parse_XLSBShortCell(data) {
	var iStyleRef = data.read_shift(2);
	iStyleRef += data.read_shift(1) <<16;
	data.l++; //var fPhShow = data.read_shift(1);
	return { c:-1, iStyleRef: iStyleRef };
}
function write_XLSBShortCell(cell, o) {
	if(o == null) o = new_buf(4);
	o.write_shift(3, cell.iStyleRef || cell.s);
	o.write_shift(1, 0); /* fPhShow */
	return o;
}

/* [MS-XLSB] 2.5.21 */
var parse_XLSBCodeName = parse_XLWideString;
var write_XLSBCodeName = write_XLWideString;

/* [MS-XLSB] 2.5.166 */
function parse_XLNullableWideString(data) {
	var cchCharacters = data.read_shift(4);
	return cchCharacters === 0 || cchCharacters === 0xFFFFFFFF ? "" : data.read_shift(cchCharacters, 'dbcs');
}
function write_XLNullableWideString(data, o) {
	var _null = false; if (o == null) { _null = true; o = new_buf(127); }
	o.write_shift(4, data.length > 0 ? data.length : 0xFFFFFFFF);
	if (data.length > 0) o.write_shift(0, data, 'dbcs');
	return _null ? o.slice(0, o.l) : o;
}

/* [MS-XLSB] 2.5.165 */
var parse_XLNameWideString = parse_XLWideString;
//var write_XLNameWideString = write_XLWideString;

/* [MS-XLSB] 2.5.114 */
var parse_RelID = parse_XLNullableWideString;
var write_RelID = write_XLNullableWideString;


/* [MS-XLS] 2.5.217 ; [MS-XLSB] 2.5.122 */
function parse_RkNumber(data) {
	var b = data.slice(data.l, data.l + 4);
	var fX100 = (b[0] & 1), fInt = (b[0] & 2);
	data.l += 4;
	var RK = fInt === 0 ? __double([0, 0, 0, 0, (b[0] & 0xFC), b[1], b[2], b[3]], 0) : __readInt32LE(b, 0) >> 2;
	return fX100 ? (RK / 100) : RK;
}
function write_RkNumber(data, o) {
	if (o == null) o = new_buf(4);
	var fX100 = 0, fInt = 0, d100 = data * 100;
	if ((data == (data | 0)) && (data >= -(1 << 29)) && (data < (1 << 29))) { fInt = 1; }
	else if ((d100 == (d100 | 0)) && (d100 >= -(1 << 29)) && (d100 < (1 << 29))) { fInt = 1; fX100 = 1; }
	if (fInt) o.write_shift(-4, ((fX100 ? d100 : data) << 2) + (fX100 + 2));
	else throw new Error("unsupported RkNumber " + data); // TODO
}


/* [MS-XLSB] 2.5.117 RfX */
function parse_RfX(data ) {
	var cell = ({ s: {}, e: {} });
	cell.s.r = data.read_shift(4);
	cell.e.r = data.read_shift(4);
	cell.s.c = data.read_shift(4);
	cell.e.c = data.read_shift(4);
	return cell;
}
function write_RfX(r, o) {
	if (!o) o = new_buf(16);
	o.write_shift(4, r.s.r);
	o.write_shift(4, r.e.r);
	o.write_shift(4, r.s.c);
	o.write_shift(4, r.e.c);
	return o;
}

/* [MS-XLSB] 2.5.153 UncheckedRfX */
var parse_UncheckedRfX = parse_RfX;
var write_UncheckedRfX = write_RfX;

/* [MS-XLSB] 2.5.155 UncheckedSqRfX */
//function parse_UncheckedSqRfX(data) {
//	var cnt = data.read_shift(4);
//	var out = [];
//	for(var i = 0; i < cnt; ++i) {
//		var rng = parse_UncheckedRfX(data);
//		out.push(encode_range(rng));
//	}
//	return out.join(",");
//}
//function write_UncheckedSqRfX(sqrfx) {
//	var parts = sqrfx.split(/\s*,\s*/);
//	var o = new_buf(4); o.write_shift(4, parts.length);
//	var out = [o];
//	parts.forEach(function(rng) {
//		out.push(write_UncheckedRfX(safe_decode_range(rng)));
//	});
//	return bconcat(out);
//}

/* [MS-XLS] 2.5.342 ; [MS-XLSB] 2.5.171 */
/* TODO: error checking, NaN and Infinity values are not valid Xnum */
function parse_Xnum(data) {
	if(data.length - data.l < 8) throw "XLS Xnum Buffer underflow";
	return data.read_shift(8, 'f');
}
function write_Xnum(data, o) { return (o || new_buf(8)).write_shift(8, data, 'f'); }

/* [MS-XLSB] 2.4.324 BrtColor */
function parse_BrtColor(data) {
	var out = {};
	var d = data.read_shift(1);

	//var fValidRGB = d & 1;
	var xColorType = d >>> 1;

	var index = data.read_shift(1);
	var nTS = data.read_shift(2, 'i');
	var bR = data.read_shift(1);
	var bG = data.read_shift(1);
	var bB = data.read_shift(1);
	data.l++; //var bAlpha = data.read_shift(1);

	switch (xColorType) {
		case 0: out.auto = 1; break;
		case 1:
			out.index = index;
			var icv = XLSIcv[index];
			/* automatic pseudo index 81 */
			if (icv) out.rgb = rgb2Hex(icv);
			break;
		case 2:
			/* if(!fValidRGB) throw new Error("invalid"); */
			out.rgb = rgb2Hex([bR, bG, bB]);
			break;
		case 3: out.theme = index; break;
	}
	if (nTS != 0) out.tint = nTS > 0 ? nTS / 32767 : nTS / 32768;

	return out;
}
function write_BrtColor(color, o) {
	if (!o) o = new_buf(8);
	if (!color || color.auto) { o.write_shift(4, 0); o.write_shift(4, 0); return o; }
	if (color.index != null) {
		o.write_shift(1, 0x02);
		o.write_shift(1, color.index);
	} else if (color.theme != null) {
		o.write_shift(1, 0x06);
		o.write_shift(1, color.theme);
	} else {
		o.write_shift(1, 0x05);
		o.write_shift(1, 0);
	}
	var nTS = color.tint || 0;
	if (nTS > 0) nTS *= 32767;
	else if (nTS < 0) nTS *= 32768;
	o.write_shift(2, nTS);
	if (!color.rgb || color.theme != null) {
		o.write_shift(2, 0);
		o.write_shift(1, 0);
		o.write_shift(1, 0);
	} else {
		var rgb = (color.rgb || 'FFFFFF');
		if (typeof rgb == 'number') rgb = ("000000" + rgb.toString(16)).slice(-6);
		o.write_shift(1, parseInt(rgb.slice(0, 2), 16));
		o.write_shift(1, parseInt(rgb.slice(2, 4), 16));
		o.write_shift(1, parseInt(rgb.slice(4, 6), 16));
		o.write_shift(1, 0xFF);
	}
	return o;
}

/* [MS-XLSB] 2.5.52 */
function parse_FontFlags(data) {
	var d = data.read_shift(1);
	data.l++;
	var out = {
		fBold: d & 0x01,
		fItalic: d & 0x02,
		fUnderline: d & 0x04,
		fStrikeout: d & 0x08,
		fOutline: d & 0x10,
		fShadow: d & 0x20,
		fCondense: d & 0x40,
		fExtend: d & 0x80
	};
	return out;
}
function write_FontFlags(font, o) {
	if (!o) o = new_buf(2);
	var grbit =
		(font.italic ? 0x02 : 0) |
		(font.strike ? 0x08 : 0) |
		(font.outline ? 0x10 : 0) |
		(font.shadow ? 0x20 : 0) |
		(font.condense ? 0x40 : 0) |
		(font.extend ? 0x80 : 0);
	o.write_shift(1, grbit);
	o.write_shift(1, 0);
	return o;
}

/* [MS-OLEDS] 2.3.1 and 2.3.2 */
function parse_ClipboardFormatOrString(o, w) {
	// $FlowIgnore
	var ClipFmt = { 2: "BITMAP", 3: "METAFILEPICT", 8: "DIB", 14: "ENHMETAFILE" };
	var m = o.read_shift(4);
	switch (m) {
		case 0x00000000: return "";
		case 0xffffffff: case 0xfffffffe: return ClipFmt[o.read_shift(4)] || "";
	}
	if (m > 0x190) throw new Error("Unsupported Clipboard: " + m.toString(16));
	o.l -= 4;
	return o.read_shift(0, w == 1 ? "lpstr" : "lpwstr");
}
function parse_ClipboardFormatOrAnsiString(o) { return parse_ClipboardFormatOrString(o, 1); }
function parse_ClipboardFormatOrUnicodeString(o) { return parse_ClipboardFormatOrString(o, 2); }

/* [MS-OLEPS] 2.2 PropertyType */
// Note: some tree shakers cannot handle VT_VECTOR | $CONST, hence extra vars
//var VT_EMPTY    = 0x0000;
//var VT_NULL     = 0x0001;
var VT_I2       = 0x0002;
var VT_I4       = 0x0003;
//var VT_R4       = 0x0004;
//var VT_R8       = 0x0005;
//var VT_CY       = 0x0006;
//var VT_DATE     = 0x0007;
//var VT_BSTR     = 0x0008;
//var VT_ERROR    = 0x000A;
var VT_BOOL     = 0x000B;
var VT_VARIANT  = 0x000C;
//var VT_DECIMAL  = 0x000E;
//var VT_I1       = 0x0010;
//var VT_UI1      = 0x0011;
//var VT_UI2      = 0x0012;
var VT_UI4      = 0x0013;
//var VT_I8       = 0x0014;
//var VT_UI8      = 0x0015;
//var VT_INT      = 0x0016;
//var VT_UINT     = 0x0017;
//var VT_LPSTR    = 0x001E;
//var VT_LPWSTR   = 0x001F;
var VT_FILETIME = 0x0040;
var VT_BLOB     = 0x0041;
//var VT_STREAM   = 0x0042;
//var VT_STORAGE  = 0x0043;
//var VT_STREAMED_Object  = 0x0044;
//var VT_STORED_Object    = 0x0045;
//var VT_BLOB_Object      = 0x0046;
var VT_CF       = 0x0047;
//var VT_CLSID    = 0x0048;
//var VT_VERSIONED_STREAM = 0x0049;
//var VT_VECTOR   = 0x1000;
var VT_VECTOR_VARIANT = 0x100C;
var VT_VECTOR_LPSTR   = 0x101E;
//var VT_ARRAY    = 0x2000;

var VT_STRING   = 0x0050; // 2.3.3.1.11 VtString
var VT_USTR     = 0x0051; // 2.3.3.1.12 VtUnalignedString
var VT_CUSTOM   = [VT_STRING, VT_USTR];

/* [MS-OSHARED] 2.3.3.2.2.1 Document Summary Information PIDDSI */
var DocSummaryPIDDSI = {
	0x01: { n: 'CodePage', t: VT_I2 },
	0x02: { n: 'Category', t: VT_STRING },
	0x03: { n: 'PresentationFormat', t: VT_STRING },
	0x04: { n: 'ByteCount', t: VT_I4 },
	0x05: { n: 'LineCount', t: VT_I4 },
	0x06: { n: 'ParagraphCount', t: VT_I4 },
	0x07: { n: 'SlideCount', t: VT_I4 },
	0x08: { n: 'NoteCount', t: VT_I4 },
	0x09: { n: 'HiddenCount', t: VT_I4 },
	0x0a: { n: 'MultimediaClipCount', t: VT_I4 },
	0x0b: { n: 'ScaleCrop', t: VT_BOOL },
	0x0c: { n: 'HeadingPairs', t: VT_VECTOR_VARIANT /* VT_VECTOR | VT_VARIANT */ },
	0x0d: { n: 'TitlesOfParts', t: VT_VECTOR_LPSTR /* VT_VECTOR | VT_LPSTR */ },
	0x0e: { n: 'Manager', t: VT_STRING },
	0x0f: { n: 'Company', t: VT_STRING },
	0x10: { n: 'LinksUpToDate', t: VT_BOOL },
	0x11: { n: 'CharacterCount', t: VT_I4 },
	0x13: { n: 'SharedDoc', t: VT_BOOL },
	0x16: { n: 'HyperlinksChanged', t: VT_BOOL },
	0x17: { n: 'AppVersion', t: VT_I4, p: 'version' },
	0x18: { n: 'DigSig', t: VT_BLOB },
	0x1A: { n: 'ContentType', t: VT_STRING },
	0x1B: { n: 'ContentStatus', t: VT_STRING },
	0x1C: { n: 'Language', t: VT_STRING },
	0x1D: { n: 'Version', t: VT_STRING },
	0xFF: {},
	/* [MS-OLEPS] 2.18 */
	0x80000000: { n: 'Locale', t: VT_UI4 },
	0x80000003: { n: 'Behavior', t: VT_UI4 },
	0x72627262: {}
};

/* [MS-OSHARED] 2.3.3.2.1.1 Summary Information Property Set PIDSI */
var SummaryPIDSI = {
	0x01: { n: 'CodePage', t: VT_I2 },
	0x02: { n: 'Title', t: VT_STRING },
	0x03: { n: 'Subject', t: VT_STRING },
	0x04: { n: 'Author', t: VT_STRING },
	0x05: { n: 'Keywords', t: VT_STRING },
	0x06: { n: 'Comments', t: VT_STRING },
	0x07: { n: 'Template', t: VT_STRING },
	0x08: { n: 'LastAuthor', t: VT_STRING },
	0x09: { n: 'RevNumber', t: VT_STRING },
	0x0A: { n: 'EditTime', t: VT_FILETIME },
	0x0B: { n: 'LastPrinted', t: VT_FILETIME },
	0x0C: { n: 'CreatedDate', t: VT_FILETIME },
	0x0D: { n: 'ModifiedDate', t: VT_FILETIME },
	0x0E: { n: 'PageCount', t: VT_I4 },
	0x0F: { n: 'WordCount', t: VT_I4 },
	0x10: { n: 'CharCount', t: VT_I4 },
	0x11: { n: 'Thumbnail', t: VT_CF },
	0x12: { n: 'Application', t: VT_STRING },
	0x13: { n: 'DocSecurity', t: VT_I4 },
	0xFF: {},
	/* [MS-OLEPS] 2.18 */
	0x80000000: { n: 'Locale', t: VT_UI4 },
	0x80000003: { n: 'Behavior', t: VT_UI4 },
	0x72627262: {}
};

/* [MS-XLS] 2.4.63 Country/Region codes */
var CountryEnum = {
	0x0001: "US", // United States
	0x0002: "CA", // Canada
	0x0003: "", // Latin America (except Brazil)
	0x0007: "RU", // Russia
	0x0014: "EG", // Egypt
	0x001E: "GR", // Greece
	0x001F: "NL", // Netherlands
	0x0020: "BE", // Belgium
	0x0021: "FR", // France
	0x0022: "ES", // Spain
	0x0024: "HU", // Hungary
	0x0027: "IT", // Italy
	0x0029: "CH", // Switzerland
	0x002B: "AT", // Austria
	0x002C: "GB", // United Kingdom
	0x002D: "DK", // Denmark
	0x002E: "SE", // Sweden
	0x002F: "NO", // Norway
	0x0030: "PL", // Poland
	0x0031: "DE", // Germany
	0x0034: "MX", // Mexico
	0x0037: "BR", // Brazil
	0x003d: "AU", // Australia
	0x0040: "NZ", // New Zealand
	0x0042: "TH", // Thailand
	0x0051: "JP", // Japan
	0x0052: "KR", // Korea
	0x0054: "VN", // Viet Nam
	0x0056: "CN", // China
	0x005A: "TR", // Turkey
	0x0069: "JS", // Ramastan
	0x00D5: "DZ", // Algeria
	0x00D8: "MA", // Morocco
	0x00DA: "LY", // Libya
	0x015F: "PT", // Portugal
	0x0162: "IS", // Iceland
	0x0166: "FI", // Finland
	0x01A4: "CZ", // Czech Republic
	0x0376: "TW", // Taiwan
	0x03C1: "LB", // Lebanon
	0x03C2: "JO", // Jordan
	0x03C3: "SY", // Syria
	0x03C4: "IQ", // Iraq
	0x03C5: "KW", // Kuwait
	0x03C6: "SA", // Saudi Arabia
	0x03CB: "AE", // United Arab Emirates
	0x03CC: "IL", // Israel
	0x03CE: "QA", // Qatar
	0x03D5: "IR", // Iran
	0xFFFF: "US"  // United States
};

/* [MS-XLS] 2.5.127 */
var XLSFillPattern = [
	null,
	'solid',
	'mediumGray',
	'darkGray',
	'lightGray',
	'darkHorizontal',
	'darkVertical',
	'darkDown',
	'darkUp',
	'darkGrid',
	'darkTrellis',
	'lightHorizontal',
	'lightVertical',
	'lightDown',
	'lightUp',
	'lightGrid',
	'lightTrellis',
	'gray125',
	'gray0625'
];

function rgbify(arr) { return arr.map(function(x) { return [(x>>16)&255,(x>>8)&255,x&255]; }); }

/* [MS-XLS] 2.5.161 */
/* [MS-XLSB] 2.5.75 Icv */
var _XLSIcv =  rgbify([
	/* Color Constants */
	0x000000,
	0xFFFFFF,
	0xFF0000,
	0x00FF00,
	0x0000FF,
	0xFFFF00,
	0xFF00FF,
	0x00FFFF,

	/* Overridable Defaults */
	0x000000,
	0xFFFFFF,
	0xFF0000,
	0x00FF00,
	0x0000FF,
	0xFFFF00,
	0xFF00FF,
	0x00FFFF,

	0x800000,
	0x008000,
	0x000080,
	0x808000,
	0x800080,
	0x008080,
	0xC0C0C0,
	0x808080,
	0x9999FF,
	0x993366,
	0xFFFFCC,
	0xCCFFFF,
	0x660066,
	0xFF8080,
	0x0066CC,
	0xCCCCFF,

	0x000080,
	0xFF00FF,
	0xFFFF00,
	0x00FFFF,
	0x800080,
	0x800000,
	0x008080,
	0x0000FF,
	0x00CCFF,
	0xCCFFFF,
	0xCCFFCC,
	0xFFFF99,
	0x99CCFF,
	0xFF99CC,
	0xCC99FF,
	0xFFCC99,

	0x3366FF,
	0x33CCCC,
	0x99CC00,
	0xFFCC00,
	0xFF9900,
	0xFF6600,
	0x666699,
	0x969696,
	0x003366,
	0x339966,
	0x003300,
	0x333300,
	0x993300,
	0x993366,
	0x333399,
	0x333333,

	/* Other entries to appease BIFF8/12 */
	0x000000, /* 0x40 icvForeground ?? */
	0xFFFFFF, /* 0x41 icvBackground ?? */
	0x000000, /* 0x42 icvFrame ?? */
	0x000000, /* 0x43 icv3D ?? */
	0x000000, /* 0x44 icv3DText ?? */
	0x000000, /* 0x45 icv3DHilite ?? */
	0x000000, /* 0x46 icv3DShadow ?? */
	0x000000, /* 0x47 icvHilite ?? */
	0x000000, /* 0x48 icvCtlText ?? */
	0x000000, /* 0x49 icvCtlScrl ?? */
	0x000000, /* 0x4A icvCtlInv ?? */
	0x000000, /* 0x4B icvCtlBody ?? */
	0x000000, /* 0x4C icvCtlFrame ?? */
	0x000000, /* 0x4D icvCtlFore ?? */
	0x000000, /* 0x4E icvCtlBack ?? */
	0x000000, /* 0x4F icvCtlNeutral */
	0x000000, /* 0x50 icvInfoBk ?? */
	0x000000 /* 0x51 icvInfoText ?? */
]);
var XLSIcv = dup(_XLSIcv);

/* [MS-XLSB] 2.5.97.2 */
var BErr = {
	0x00: "#NULL!",
	0x07: "#DIV/0!",
	0x0F: "#VALUE!",
	0x17: "#REF!",
	0x1D: "#NAME?",
	0x24: "#NUM!",
	0x2A: "#N/A",
	0x2B: "#GETTING_DATA",
	0xFF: "#WTF?"
};
//var RBErr = evert_num(BErr);
var RBErr = {
	"#NULL!":        0x00,
	"#DIV/0!":       0x07,
	"#VALUE!":       0x0F,
	"#REF!":         0x17,
	"#NAME?":        0x1D,
	"#NUM!":         0x24,
	"#N/A":          0x2A,
	"#GETTING_DATA": 0x2B,
	"#WTF?":         0xFF
};

var XLSLblBuiltIn = [
	"_xlnm.Consolidate_Area",
	"_xlnm.Auto_Open",
	"_xlnm.Auto_Close",
	"_xlnm.Extract",
	"_xlnm.Database",
	"_xlnm.Criteria",
	"_xlnm.Print_Area",
	"_xlnm.Print_Titles",
	"_xlnm.Recorder",
	"_xlnm.Data_Form",
	"_xlnm.Auto_Activate",
	"_xlnm.Auto_Deactivate",
	"_xlnm.Sheet_Title",
	"_xlnm._FilterDatabase"
];

/* Parts enumerated in OPC spec, MS-XLSB and MS-XLSX */
/* 12.3 Part Summary <SpreadsheetML> */
/* 14.2 Part Summary <DrawingML> */
/* [MS-XLSX] 2.1 Part Enumerations ; [MS-XLSB] 2.1.7 Part Enumeration */
var ct2type/*{[string]:string}*/ = ({
	/* Workbook */
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml": "workbooks",
	"application/vnd.ms-excel.sheet.macroEnabled.main+xml": "workbooks",
	"application/vnd.ms-excel.sheet.binary.macroEnabled.main": "workbooks",
	"application/vnd.ms-excel.addin.macroEnabled.main+xml": "workbooks",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml": "workbooks",

	/* Worksheet */
	"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml": "sheets",
	"application/vnd.ms-excel.worksheet": "sheets",
	"application/vnd.ms-excel.binIndexWs": "TODO", /* Binary Index */

	/* Chartsheet */
	"application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml": "charts",
	"application/vnd.ms-excel.chartsheet": "charts",

	/* Macrosheet */
	"application/vnd.ms-excel.macrosheet+xml": "macros",
	"application/vnd.ms-excel.macrosheet": "macros",
	"application/vnd.ms-excel.intlmacrosheet": "TODO",
	"application/vnd.ms-excel.binIndexMs": "TODO", /* Binary Index */

	/* Dialogsheet */
	"application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml": "dialogs",
	"application/vnd.ms-excel.dialogsheet": "dialogs",

	/* Shared Strings */
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml": "strs",
	"application/vnd.ms-excel.sharedStrings": "strs",

	/* Styles */
	"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml": "styles",
	"application/vnd.ms-excel.styles": "styles",

	/* File Properties */
	"application/vnd.openxmlformats-package.core-properties+xml": "coreprops",
	"application/vnd.openxmlformats-officedocument.custom-properties+xml": "custprops",
	"application/vnd.openxmlformats-officedocument.extended-properties+xml": "extprops",

	/* Custom Data Properties */
	"application/vnd.openxmlformats-officedocument.customXmlProperties+xml": "TODO",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.customProperty": "TODO",

	/* Comments */
	"application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml": "comments",
	"application/vnd.ms-excel.comments": "comments",
	"application/vnd.ms-excel.threadedcomments+xml": "threadedcomments",
	"application/vnd.ms-excel.person+xml": "people",

	/* Metadata (Stock/Geography and Dynamic Array) */
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml": "metadata",
	"application/vnd.ms-excel.sheetMetadata": "metadata",

	/* PivotTable */
	"application/vnd.ms-excel.pivotTable": "TODO",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml": "TODO",

	/* Chart Objects */
	"application/vnd.openxmlformats-officedocument.drawingml.chart+xml": "TODO",

	/* Chart Colors */
	"application/vnd.ms-office.chartcolorstyle+xml": "TODO",

	/* Chart Style */
	"application/vnd.ms-office.chartstyle+xml": "TODO",

	/* Chart Advanced */
	"application/vnd.ms-office.chartex+xml": "TODO",

	/* Calculation Chain */
	"application/vnd.ms-excel.calcChain": "calcchains",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml": "calcchains",

	/* Printer Settings */
	"application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings": "TODO",

	/* ActiveX */
	"application/vnd.ms-office.activeX": "TODO",
	"application/vnd.ms-office.activeX+xml": "TODO",

	/* Custom Toolbars */
	"application/vnd.ms-excel.attachedToolbars": "TODO",

	/* External Data Connections */
	"application/vnd.ms-excel.connections": "TODO",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml": "TODO",

	/* External Links */
	"application/vnd.ms-excel.externalLink": "links",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml": "links",

	/* PivotCache */
	"application/vnd.ms-excel.pivotCacheDefinition": "TODO",
	"application/vnd.ms-excel.pivotCacheRecords": "TODO",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml": "TODO",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml": "TODO",

	/* Query Table */
	"application/vnd.ms-excel.queryTable": "TODO",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.queryTable+xml": "TODO",

	/* Shared Workbook */
	"application/vnd.ms-excel.userNames": "TODO",
	"application/vnd.ms-excel.revisionHeaders": "TODO",
	"application/vnd.ms-excel.revisionLog": "TODO",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.revisionHeaders+xml": "TODO",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.revisionLog+xml": "TODO",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.userNames+xml": "TODO",

	/* Single Cell Table */
	"application/vnd.ms-excel.tableSingleCells": "TODO",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.tableSingleCells+xml": "TODO",

	/* Slicer */
	"application/vnd.ms-excel.slicer": "TODO",
	"application/vnd.ms-excel.slicerCache": "TODO",
	"application/vnd.ms-excel.slicer+xml": "TODO",
	"application/vnd.ms-excel.slicerCache+xml": "TODO",

	/* Sort Map */
	"application/vnd.ms-excel.wsSortMap": "TODO",

	/* Table */
	"application/vnd.ms-excel.table": "TODO",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml": "TODO",

	/* Themes */
	"application/vnd.openxmlformats-officedocument.theme+xml": "themes",

	/* Theme Override */
	"application/vnd.openxmlformats-officedocument.themeOverride+xml": "TODO",

	/* Timeline */
	"application/vnd.ms-excel.Timeline+xml": "TODO", /* verify */
	"application/vnd.ms-excel.TimelineCache+xml": "TODO", /* verify */

	/* VBA */
	"application/vnd.ms-office.vbaProject": "vba",
	"application/vnd.ms-office.vbaProjectSignature": "TODO",

	/* Volatile Dependencies */
	"application/vnd.ms-office.volatileDependencies": "TODO",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.volatileDependencies+xml": "TODO",

	/* Control Properties */
	"application/vnd.ms-excel.controlproperties+xml": "TODO",

	/* Data Model */
	"application/vnd.openxmlformats-officedocument.model+data": "TODO",

	/* Survey */
	"application/vnd.ms-excel.Survey+xml": "TODO",

	/* Drawing */
	"application/vnd.openxmlformats-officedocument.drawing+xml": "drawings",
	"application/vnd.openxmlformats-officedocument.drawingml.chartshapes+xml": "TODO",
	"application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml": "TODO",
	"application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml": "TODO",
	"application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml": "TODO",
	"application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml": "TODO",

	/* VML */
	"application/vnd.openxmlformats-officedocument.vmlDrawing": "TODO",

	"application/vnd.openxmlformats-package.relationships+xml": "rels",
	"application/vnd.openxmlformats-officedocument.oleObject": "TODO",

	/* Image */
	"image/png": "TODO",

	"sheet": "js"
});

var CT_LIST = {
	workbooks: {
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
		xlsm: "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
		xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.main",
		xlam: "application/vnd.ms-excel.addin.macroEnabled.main+xml",
		xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml"
	},
	strs: { /* Shared Strings */
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
		xlsb: "application/vnd.ms-excel.sharedStrings"
	},
	comments: { /* Comments */
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml",
		xlsb: "application/vnd.ms-excel.comments"
	},
	sheets: { /* Worksheet */
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
		xlsb: "application/vnd.ms-excel.worksheet"
	},
	charts: { /* Chartsheet */
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml",
		xlsb: "application/vnd.ms-excel.chartsheet"
	},
	dialogs: { /* Dialogsheet */
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml",
		xlsb: "application/vnd.ms-excel.dialogsheet"
	},
	macros: { /* Macrosheet (Excel 4.0 Macros) */
		xlsx: "application/vnd.ms-excel.macrosheet+xml",
		xlsb: "application/vnd.ms-excel.macrosheet"
	},
	metadata: { /* Metadata (Stock/Geography and Dynamic Array) */
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml",
		xlsb: "application/vnd.ms-excel.sheetMetadata"
	},
	styles: { /* Styles */
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
		xlsb: "application/vnd.ms-excel.styles"
	}
};

function new_ct() {
	return ({
		workbooks:[], sheets:[], charts:[], dialogs:[], macros:[],
		rels:[], strs:[], comments:[], threadedcomments:[], links:[],
		coreprops:[], extprops:[], custprops:[], themes:[], styles:[],
		calcchains:[], vba: [], drawings: [], metadata: [], people:[],
		TODO:[], xmlns: "" });
}

function parse_ct(data) {
	var ct = new_ct();
	if(!data || !data.match) return ct;
	var ctext = {};
	(data.match(tagregex)||[]).forEach(function(x) {
		var y = parsexmltag(x);
		switch(y[0].replace(nsregex,"<")) {
			case '<?xml': break;
			case '<Types': ct.xmlns = y['xmlns' + (y[0].match(/<(\w+):/)||["",""])[1] ]; break;
			case '<Default': ctext[y.Extension.toLowerCase()] = y.ContentType; break;
			case '<Override':
				if(ct[ct2type[y.ContentType]] !== undefined) ct[ct2type[y.ContentType]].push(y.PartName);
				break;
		}
	});
	if(ct.xmlns !== XMLNS.CT) throw new Error("Unknown Namespace: " + ct.xmlns);
	ct.calcchain = ct.calcchains.length > 0 ? ct.calcchains[0] : "";
	ct.sst = ct.strs.length > 0 ? ct.strs[0] : "";
	ct.style = ct.styles.length > 0 ? ct.styles[0] : "";
	ct.defaults = ctext;
	delete ct.calcchains;
	return ct;
}

function write_ct(ct, opts, raw) {
	var type2ct/*{[string]:Array<string>}*/ = evert_arr(ct2type);

	var o = [], v;

	if(!raw) {
		o[o.length] = (XML_HEADER);
		o[o.length] = writextag('Types', null, {
			'xmlns': XMLNS.CT,
			'xmlns:xsd': XMLNS.xsd,
			'xmlns:xsi': XMLNS.xsi
		});
		o = o.concat([
			['xml', 'application/xml'],
			['bin', 'application/vnd.ms-excel.sheet.binary.macroEnabled.main'],
			['vml', 'application/vnd.openxmlformats-officedocument.vmlDrawing'],
			['data', 'application/vnd.openxmlformats-officedocument.model+data'],
			/* from test files */
			['bmp', 'image/bmp'],
			['png', 'image/png'],
			['gif', 'image/gif'],
			['emf', 'image/x-emf'],
			['wmf', 'image/x-wmf'],
			['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
			['tif', 'image/tiff'], ['tiff', 'image/tiff'],
			['pdf', 'application/pdf'],
			['rels', 'application/vnd.openxmlformats-package.relationships+xml']
		].map(function(x) {
			return writextag('Default', null, {'Extension':x[0], 'ContentType': x[1]});
		}));
	}

	/* only write first instance */
	var f1 = function(w) {
		if(ct[w] && ct[w].length > 0) {
			v = ct[w][0];
			o[o.length] = (writextag('Override', null, {
				'PartName': (v[0] == '/' ? "":"/") + v,
				'ContentType': CT_LIST[w][opts.bookType] || CT_LIST[w]['xlsx']
			}));
		}
	};

	/* book type-specific */
	var f2 = function(w) {
		(ct[w]||[]).forEach(function(v) {
			o[o.length] = (writextag('Override', null, {
				'PartName': (v[0] == '/' ? "":"/") + v,
				'ContentType': CT_LIST[w][opts.bookType] || CT_LIST[w]['xlsx']
			}));
		});
	};

	/* standard type */
	var f3 = function(t) {
		(ct[t]||[]).forEach(function(v) {
			o[o.length] = (writextag('Override', null, {
				'PartName': (v[0] == '/' ? "":"/") + v,
				'ContentType': type2ct[t][0]
			}));
		});
	};

	f1('workbooks');
	f2('sheets');
	f2('charts');
	f3('themes');
	['strs', 'styles'].forEach(f1);
	['coreprops', 'extprops', 'custprops'].forEach(f3);
	f3('vba');
	f3('comments');
	f3('threadedcomments');
	f3('drawings');
	f2('metadata');
	f3('people');
	if(!raw && o.length>2){ o[o.length] = ('</Types>'); o[1]=o[1].replace("/>",">"); }
	return o.join("");
}
/* 9.3 Relationships */
var RELS = ({
	WB: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
	SHEET: "http://sheetjs.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
	HLINK: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
	VML: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing",
	XPATH: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath",
	XMISS: "http://schemas.microsoft.com/office/2006/relationships/xlExternalLinkPath/xlPathMissing",
	XLINK: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink",
	CXML: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml",
	CXMLP: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps",
	CMNT: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
	CORE_PROPS: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
	EXT_PROPS: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
	CUST_PROPS: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties',
	SST: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings",
	STY: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
	THEME: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
	CHART: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart",
	CHARTEX: "http://schemas.microsoft.com/office/2014/relationships/chartEx",
	CS: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet",
	WS: [
		"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
		"http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet"
	],
	DS: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/dialogsheet",
	MS: "http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet",
	IMG: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
	DRAW: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
	XLMETA: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata",
	TCMNT: "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment",
	PEOPLE: "http://schemas.microsoft.com/office/2017/10/relationships/person",
	CONN: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/connections",
	VBA: "http://schemas.microsoft.com/office/2006/relationships/vbaProject"
});

/* 9.3.3 Representing Relationships */
function get_rels_path(file) {
	var n = file.lastIndexOf("/");
	return file.slice(0,n+1) + '_rels/' + file.slice(n+1) + ".rels";
}

function parse_rels(data, currentFilePath) {
	var rels = {"!id":{}};
	if (!data) return rels;
	if (currentFilePath.charAt(0) !== '/') {
		currentFilePath = '/'+currentFilePath;
	}
	var hash = {};

	(data.match(tagregex)||[]).forEach(function(x) {
		var y = parsexmltag(x);
		/* 9.3.2.2 OPC_Relationships */
		if (y[0] === '<Relationship') {
			var rel = {}; rel.Type = y.Type; rel.Target = unescapexml(y.Target); rel.Id = y.Id; if(y.TargetMode) rel.TargetMode = y.TargetMode;
			var canonictarget = y.TargetMode === 'External' ? y.Target : resolve_path(y.Target, currentFilePath);
			rels[canonictarget] = rel;
			hash[y.Id] = rel;
		}
	});
	rels["!id"] = hash;
	return rels;
}


/* TODO */
function write_rels(rels) {
	var o = [XML_HEADER, writextag('Relationships', null, {
		//'xmlns:ns0': XMLNS.RELS,
		'xmlns': XMLNS.RELS
	})];
	keys(rels['!id']).forEach(function(rid) {
		o[o.length] = (writextag('Relationship', null, rels['!id'][rid]));
	});
	if(o.length>2){ o[o.length] = ('</Relationships>'); o[1]=o[1].replace("/>",">"); }
	return o.join("");
}

function add_rels(rels, rId, f, type, relobj, targetmode) {
	if(!relobj) relobj = {};
	if(!rels['!id']) rels['!id'] = {};
	if(!rels['!idx']) rels['!idx'] = 1;
	if(rId < 0) for(rId = rels['!idx']; rels['!id']['rId' + rId]; ++rId){/* empty */}
	rels['!idx'] = rId + 1;
	relobj.Id = 'rId' + rId;
	relobj.Type = type;
	relobj.Target = f;
	if(targetmode) relobj.TargetMode = targetmode;
	else if([RELS.HLINK, RELS.XPATH, RELS.XMISS].indexOf(relobj.Type) > -1) relobj.TargetMode = "External";
	if(rels['!id'][relobj.Id]) throw new Error("Cannot rewrite rId " + rId);
	rels['!id'][relobj.Id] = relobj;
	rels[('/' + relobj.Target).replace("//","/")] = relobj;
	return rId;
}
var CT_ODS = "application/vnd.oasis.opendocument.spreadsheet";
function parse_manifest(d, opts) {
  var str = xlml_normalize(d);
  var Rn;
  var FEtag;
  while (Rn = xlmlregex.exec(str))
    switch (Rn[3]) {
      case "manifest":
        break;
      case "file-entry":
        FEtag = parsexmltag(Rn[0], false);
        if (FEtag.path == "/" && FEtag.type !== CT_ODS)
          throw new Error("This OpenDocument is not a spreadsheet");
        break;
      case "encryption-data":
      case "algorithm":
      case "start-key-generation":
      case "key-derivation":
        throw new Error("Unsupported ODS Encryption");
      default:
        if (opts && opts.WTF)
          throw Rn;
    }
}
function write_manifest(manifest) {
  var o = [XML_HEADER];
  o.push('<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">\n');
  o.push('  <manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>\n');
  for (var i = 0; i < manifest.length; ++i)
    o.push('  <manifest:file-entry manifest:full-path="' + manifest[i][0] + '" manifest:media-type="' + manifest[i][1] + '"/>\n');
  o.push("</manifest:manifest>");
  return o.join("");
}
function write_rdf_type(file, res, tag) {
  return [
    '  <rdf:Description rdf:about="' + file + '">\n',
    '    <rdf:type rdf:resource="http://docs.oasis-open.org/ns/office/1.2/meta/' + (tag || "odf") + "#" + res + '"/>\n',
    "  </rdf:Description>\n"
  ].join("");
}
function write_rdf_has(base, file) {
  return [
    '  <rdf:Description rdf:about="' + base + '">\n',
    '    <ns0:hasPart xmlns:ns0="http://docs.oasis-open.org/ns/office/1.2/meta/pkg#" rdf:resource="' + file + '"/>\n',
    "  </rdf:Description>\n"
  ].join("");
}
function write_rdf(rdf) {
  var o = [XML_HEADER];
  o.push('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n');
  for (var i = 0; i != rdf.length; ++i) {
    o.push(write_rdf_type(rdf[i][0], rdf[i][1]));
    o.push(write_rdf_has("", rdf[i][0]));
  }
  o.push(write_rdf_type("", "Document", "pkg"));
  o.push("</rdf:RDF>");
  return o.join("");
}
function write_meta_ods(wb, opts) {
  return '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2"><office:meta><meta:generator>SheetJS ' + XLSX.version + "</meta:generator></office:meta></office:document-meta>";
}
/* ECMA-376 Part II 11.1 Core Properties Part */
/* [MS-OSHARED] 2.3.3.2.[1-2].1 (PIDSI/PIDDSI) */
var CORE_PROPS = [
	["cp:category", "Category"],
	["cp:contentStatus", "ContentStatus"],
	["cp:keywords", "Keywords"],
	["cp:lastModifiedBy", "LastAuthor"],
	["cp:lastPrinted", "LastPrinted"],
	["cp:revision", "RevNumber"],
	["cp:version", "Version"],
	["dc:creator", "Author"],
	["dc:description", "Comments"],
	["dc:identifier", "Identifier"],
	["dc:language", "Language"],
	["dc:subject", "Subject"],
	["dc:title", "Title"],
	["dcterms:created", "CreatedDate", 'date'],
	["dcterms:modified", "ModifiedDate", 'date']
];

function parse_core_props(data) {
	var p = {};
	data = utf8read(data);

	for(var i = 0; i < CORE_PROPS.length; ++i) {
		var f = CORE_PROPS[i], cur = str_match_xml(data, f[0]);
		if(cur != null && cur.length > 0) p[f[1]] = unescapexml(cur[1]);
		if(f[2] === 'date' && p[f[1]]) p[f[1]] = parseDate(p[f[1]]);
	}

	return p;
}

function cp_doit(f, g, h, o, p) {
	if(p[f] != null || g == null || g === "") return;
	p[f] = g;
	g = escapexml(g);
	o[o.length] = (h ? writextag(f,g,h) : writetag(f,g));
}

function write_core_props(cp, _opts) {
	var opts = _opts || {};
	var o = [XML_HEADER, writextag('cp:coreProperties', null, {
		//'xmlns': XMLNS.CORE_PROPS,
		'xmlns:cp': XMLNS.CORE_PROPS,
		'xmlns:dc': XMLNS.dc,
		'xmlns:dcterms': XMLNS.dcterms,
		'xmlns:dcmitype': XMLNS.dcmitype,
		'xmlns:xsi': XMLNS.xsi
	})], p = {};
	if(!cp && !opts.Props) return o.join("");

	if(cp) {
		if(cp.CreatedDate != null) cp_doit("dcterms:created", typeof cp.CreatedDate === "string" ? cp.CreatedDate : write_w3cdtf(cp.CreatedDate, opts.WTF), {"xsi:type":"dcterms:W3CDTF"}, o, p);
		if(cp.ModifiedDate != null) cp_doit("dcterms:modified", typeof cp.ModifiedDate === "string" ? cp.ModifiedDate : write_w3cdtf(cp.ModifiedDate, opts.WTF), {"xsi:type":"dcterms:W3CDTF"}, o, p);
	}

	for(var i = 0; i != CORE_PROPS.length; ++i) {
		var f = CORE_PROPS[i];
		var v = opts.Props && opts.Props[f[1]] != null ? opts.Props[f[1]] : cp ? cp[f[1]] : null;
		if(v === true) v = "1";
		else if(v === false) v = "0";
		else if(typeof v == "number") v = String(v);
		if(v != null) cp_doit(f[0], v, null, o, p);
	}
	if(o.length>2){ o[o.length] = ('</cp:coreProperties>'); o[1]=o[1].replace("/>",">"); }
	return o.join("");
}
/* 15.2.12.3 Extended File Properties Part */
/* [MS-OSHARED] 2.3.3.2.[1-2].1 (PIDSI/PIDDSI) */
var EXT_PROPS = [
	["Application", "Application", "string"],
	["AppVersion", "AppVersion", "string"],
	["Company", "Company", "string"],
	["DocSecurity", "DocSecurity", "string"],
	["Manager", "Manager", "string"],
	["HyperlinksChanged", "HyperlinksChanged", "bool"],
	["SharedDoc", "SharedDoc", "bool"],
	["LinksUpToDate", "LinksUpToDate", "bool"],
	["ScaleCrop", "ScaleCrop", "bool"],
	["HeadingPairs", "HeadingPairs", "raw"],
	["TitlesOfParts", "TitlesOfParts", "raw"]
];

var PseudoPropsPairs = [
	"Worksheets",  "SheetNames",
	"NamedRanges", "DefinedNames",
	"Chartsheets", "ChartNames"
];
function load_props_pairs(HP, TOP, props, opts) {
	var v = [];
	if(typeof HP == "string") v = parseVector(HP, opts);
	else for(var j = 0; j < HP.length; ++j) v = v.concat(HP[j].map(function(hp) { return {v:hp}; }));
	var parts = (typeof TOP == "string") ? parseVector(TOP, opts).map(function (x) { return x.v; }) : TOP;
	var idx = 0, len = 0;
	if(parts.length > 0) for(var i = 0; i !== v.length; i += 2) {
		len = +(v[i+1].v);
		switch(v[i].v) {
			case "Worksheets":
			case "工作表":
			case "Листы":
			case "أوراق العمل":
			case "ワークシート":
			case "גליונות עבודה":
			case "Arbeitsblätter":
			case "Çalışma Sayfaları":
			case "Feuilles de calcul":
			case "Fogli di lavoro":
			case "Folhas de cálculo":
			case "Planilhas":
			case "Regneark":
			case "Hojas de cálculo":
			case "Werkbladen":
				props.Worksheets = len;
				props.SheetNames = parts.slice(idx, idx + len);
				break;

			case "Named Ranges":
			case "Rangos con nombre":
			case "名前付き一覧":
			case "Benannte Bereiche":
			case "Navngivne områder":
				props.NamedRanges = len;
				props.DefinedNames = parts.slice(idx, idx + len);
				break;

			case "Charts":
			case "Diagramme":
				props.Chartsheets = len;
				props.ChartNames = parts.slice(idx, idx + len);
				break;
		}
		idx += len;
	}
}

function parse_ext_props(data, p, opts) {
	var q = {}; if(!p) p = {};
	data = utf8read(data);

	EXT_PROPS.forEach(function(f) {
		var xml = (str_match_xml_ns(data, f[0])||[])[1];
		switch(f[2]) {
			case "string": if(xml) p[f[1]] = unescapexml(xml); break;
			case "bool": p[f[1]] = xml === "true"; break;
			case "raw":
				var cur = str_match_xml(data, f[0]);
				if(cur && cur.length > 0) q[f[1]] = cur[1];
				break;
		}
	});

	if(q.HeadingPairs && q.TitlesOfParts) load_props_pairs(q.HeadingPairs, q.TitlesOfParts, p, opts);

	return p;
}

function write_ext_props(cp) {
	var o = [], W = writextag;
	if(!cp) cp = {};
	cp.Application = "SheetJS";
	o[o.length] = (XML_HEADER);
	o[o.length] = (writextag('Properties', null, {
		'xmlns': XMLNS.EXT_PROPS,
		'xmlns:vt': XMLNS.vt
	}));

	EXT_PROPS.forEach(function(f) {
		if(cp[f[1]] === undefined) return;
		var v;
		switch(f[2]) {
			case 'string': v = escapexml(String(cp[f[1]])); break;
			case 'bool': v = cp[f[1]] ? 'true' : 'false'; break;
		}
		if(v !== undefined) o[o.length] = (W(f[0], v));
	});

	/* TODO: HeadingPairs, TitlesOfParts */
	o[o.length] = (W('HeadingPairs', W('vt:vector', W('vt:variant', '<vt:lpstr>Worksheets</vt:lpstr>')+W('vt:variant', W('vt:i4', String(cp.Worksheets))), {size:2, baseType:"variant"})));
	o[o.length] = (W('TitlesOfParts', W('vt:vector', cp.SheetNames.map(function(s) { return "<vt:lpstr>" + escapexml(s) + "</vt:lpstr>"; }).join(""), {size: cp.Worksheets, baseType:"lpstr"})));
	if(o.length>2){ o[o.length] = ('</Properties>'); o[1]=o[1].replace("/>",">"); }
	return o.join("");
}
/* 15.2.12.2 Custom File Properties Part */
var custregex = /<[^<>]+>[^<]*/g;
function parse_cust_props(data, opts) {
	var p = {}, name = "";
	var m = data.match(custregex);
	if(m) for(var i = 0; i != m.length; ++i) {
		var x = m[i], y = parsexmltag(x);
		switch(strip_ns(y[0])) {
			case '<?xml': break;
			case '<Properties': break;
			case '<property': name = unescapexml(y.name); break;
			case '</property>': name = null; break;
			default: if (x.indexOf('<vt:') === 0) {
				var toks = x.split('>');
				var type = toks[0].slice(4), text = toks[1];
				/* 22.4.2.32 (CT_Variant). Omit the binary types from 22.4 (Variant Types) */
				switch(type) {
					case 'lpstr': case 'bstr': case 'lpwstr':
						p[name] = unescapexml(text);
						break;
					case 'bool':
						p[name] = parsexmlbool(text);
						break;
					case 'i1': case 'i2': case 'i4': case 'i8': case 'int': case 'uint':
						p[name] = parseInt(text, 10);
						break;
					case 'r4': case 'r8': case 'decimal':
						p[name] = parseFloat(text);
						break;
					case 'filetime': case 'date':
						p[name] = parseDate(text);
						break;
					case 'cy': case 'error':
						p[name] = unescapexml(text);
						break;
					default:
						if(type.slice(-1) == '/') break;
						if(opts.WTF && typeof console !== 'undefined') console.warn('Unexpected', x, type, toks);
				}
			} else if(x.slice(0,2) === "</") {/* empty */
			} else if(opts.WTF) throw new Error(x);
		}
	}
	return p;
}

function write_cust_props(cp) {
	var o = [XML_HEADER, writextag('Properties', null, {
		'xmlns': XMLNS.CUST_PROPS,
		'xmlns:vt': XMLNS.vt
	})];
	if(!cp) return o.join("");
	var pid = 1;
	keys(cp).forEach(function custprop(k) { ++pid;
		o[o.length] = (writextag('property', write_vt(cp[k], true), {
			'fmtid': '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}',
			'pid': pid,
			'name': escapexml(k)
		}));
	});
	if(o.length>2){ o[o.length] = '</Properties>'; o[1]=o[1].replace("/>",">"); }
	return o.join("");
}
/* Common Name -> XLML Name */
var XLMLDocPropsMap = {
	Title: 'Title',
	Subject: 'Subject',
	Author: 'Author',
	Keywords: 'Keywords',
	Comments: 'Description',
	LastAuthor: 'LastAuthor',
	RevNumber: 'Revision',
	Application: 'AppName',
	/* TotalTime: 'TotalTime', */
	LastPrinted: 'LastPrinted',
	CreatedDate: 'Created',
	ModifiedDate: 'LastSaved',
	/* Pages */
	/* Words */
	/* Characters */
	Category: 'Category',
	/* PresentationFormat */
	Manager: 'Manager',
	Company: 'Company',
	/* Guid */
	/* HyperlinkBase */
	/* Bytes */
	/* Lines */
	/* Paragraphs */
	/* CharactersWithSpaces */
	AppVersion: 'Version',

	ContentStatus: 'ContentStatus', /* NOTE: missing from schema */
	Identifier: 'Identifier', /* NOTE: missing from schema */
	Language: 'Language' /* NOTE: missing from schema */
};
var evert_XLMLDPM;

function xlml_set_prop(Props, tag, val) {
	if(!evert_XLMLDPM) evert_XLMLDPM = evert(XLMLDocPropsMap);
	tag = evert_XLMLDPM[tag] || tag;
	Props[tag] = val;
}

function xlml_write_docprops(Props, opts) {
	var o = [];
	keys(XLMLDocPropsMap).map(function(m) {
		for(var i = 0; i < CORE_PROPS.length; ++i) if(CORE_PROPS[i][1] == m) return CORE_PROPS[i];
		for(i = 0; i < EXT_PROPS.length; ++i) if(EXT_PROPS[i][1] == m) return EXT_PROPS[i];
		throw m;
	}).forEach(function(p) {
		if(Props[p[1]] == null) return;
		var m = opts && opts.Props && opts.Props[p[1]] != null ? opts.Props[p[1]] : Props[p[1]];
		switch(p[2]) {
			case 'date': m = new Date(m).toISOString().replace(/\.\d*Z/,"Z"); break;
		}
		if(typeof m == 'number') m = String(m);
		else if(m === true || m === false) { m = m ? "1" : "0"; }
		else if(m instanceof Date) m = new Date(m).toISOString().replace(/\.\d*Z/,"");
		o.push(writetag(XLMLDocPropsMap[p[1]] || p[1], m));
	});
	return writextag('DocumentProperties', o.join(""), {xmlns:XLMLNS.o });
}
function xlml_write_custprops(Props, Custprops) {
	var BLACKLIST = ["Worksheets","SheetNames"];
	var T = 'CustomDocumentProperties';
	var o = [];
	if(Props) keys(Props).forEach(function(k) {
if(!Object.prototype.hasOwnProperty.call(Props, k)) return;
		for(var i = 0; i < CORE_PROPS.length; ++i) if(k == CORE_PROPS[i][1]) return;
		for(i = 0; i < EXT_PROPS.length; ++i) if(k == EXT_PROPS[i][1]) return;
		for(i = 0; i < BLACKLIST.length; ++i) if(k == BLACKLIST[i]) return;

		var m = Props[k];
		var t = "string";
		if(typeof m == 'number') { t = "float"; m = String(m); }
		else if(m === true || m === false) { t = "boolean"; m = m ? "1" : "0"; }
		else m = String(m);
		o.push(writextag(escapexmltag(k), m, {"dt:dt":t}));
	});
	if(Custprops) keys(Custprops).forEach(function(k) {
if(!Object.prototype.hasOwnProperty.call(Custprops, k)) return;
		if(Props && Object.prototype.hasOwnProperty.call(Props, k)) return;
		var m = Custprops[k];
		var t = "string";
		if(typeof m == 'number') { t = "float"; m = String(m); }
		else if(m === true || m === false) { t = "boolean"; m = m ? "1" : "0"; }
		else if(m instanceof Date) { t = "dateTime.tz"; m = m.toISOString(); }
		else m = String(m);
		o.push(writextag(escapexmltag(k), m, {"dt:dt":t}));
	});
	return '<' + T + ' xmlns="' + XLMLNS.o + '">' + o.join("") + '</' + T + '>';
}
/* [MS-DTYP] 2.3.3 FILETIME */
/* [MS-OLEDS] 2.1.3 FILETIME (Packet Version) */
/* [MS-OLEPS] 2.8 FILETIME (Packet Version) */
function parse_FILETIME(blob) {
	var dwLowDateTime = blob.read_shift(4), dwHighDateTime = blob.read_shift(4);
	return new Date(((dwHighDateTime/1e7*Math.pow(2,32) + dwLowDateTime/1e7) - 11644473600)*1000).toISOString().replace(/\.000/,"");
}
function write_FILETIME(time) {
	var date = (typeof time == "string") ? new Date(Date.parse(time)) : time;
	var t = date.getTime() / 1000 + 11644473600;
	var l = t % Math.pow(2,32), h = (t - l) / Math.pow(2,32);
	l *= 1e7; h *= 1e7;
	var w = (l / Math.pow(2,32)) | 0;
	if(w > 0) { l = l % Math.pow(2,32); h += w; }
	var o = new_buf(8); o.write_shift(4, l); o.write_shift(4, h); return o;
}

/* [MS-OSHARED] 2.3.3.1.4 Lpstr */
function parse_lpstr(blob, type, pad) {
	var start = blob.l;
	var str = blob.read_shift(0, 'lpstr-cp');
	if(pad) while((blob.l - start) & 3) ++blob.l;
	return str;
}

/* [MS-OSHARED] 2.3.3.1.6 Lpwstr */
function parse_lpwstr(blob, type, pad) {
	var str = blob.read_shift(0, 'lpwstr');
	if(pad) blob.l += (4 - ((str.length+1) & 3)) & 3;
	return str;
}


/* [MS-OSHARED] 2.3.3.1.11 VtString */
/* [MS-OSHARED] 2.3.3.1.12 VtUnalignedString */
function parse_VtStringBase(blob, stringType, pad) {
	if(stringType === 0x1F /*VT_LPWSTR*/) return parse_lpwstr(blob);
	return parse_lpstr(blob, stringType, pad);
}

function parse_VtString(blob, t, pad) { return parse_VtStringBase(blob, t, pad === false ? 0: 4); }
function parse_VtUnalignedString(blob, t) { if(!t) throw new Error("VtUnalignedString must have positive length"); return parse_VtStringBase(blob, t, 0); }

/* [MS-OSHARED] 2.3.3.1.7 VtVecLpwstrValue */
function parse_VtVecLpwstrValue(blob) {
	var length = blob.read_shift(4);
	var ret = [];
	for(var i = 0; i != length; ++i) {
		var start = blob.l;
		ret[i] = blob.read_shift(0, 'lpwstr').replace(chr0,'');
		if((blob.l - start) & 0x02) blob.l += 2;
	}
	return ret;
}

/* [MS-OSHARED] 2.3.3.1.9 VtVecUnalignedLpstrValue */
function parse_VtVecUnalignedLpstrValue(blob) {
	var length = blob.read_shift(4);
	var ret = [];
	for(var i = 0; i != length; ++i) ret[i] = blob.read_shift(0, 'lpstr-cp').replace(chr0,'');
	return ret;
}


/* [MS-OSHARED] 2.3.3.1.13 VtHeadingPair */
function parse_VtHeadingPair(blob) {
	var start = blob.l;
	var headingString = parse_TypedPropertyValue(blob, VT_USTR);
	if(blob[blob.l] == 0x00 && blob[blob.l+1] == 0x00 && ((blob.l - start) & 0x02)) blob.l += 2;
	var headerParts = parse_TypedPropertyValue(blob, VT_I4);
	return [headingString, headerParts];
}

/* [MS-OSHARED] 2.3.3.1.14 VtVecHeadingPairValue */
function parse_VtVecHeadingPairValue(blob) {
	var cElements = blob.read_shift(4);
	var out = [];
	for(var i = 0; i < cElements / 2; ++i) out.push(parse_VtHeadingPair(blob));
	return out;
}

/* [MS-OLEPS] 2.18.1 Dictionary (uses 2.17, 2.16) */
function parse_dictionary(blob,CodePage) {
	var cnt = blob.read_shift(4);
	var dict = ({});
	for(var j = 0; j != cnt; ++j) {
		var pid = blob.read_shift(4);
		var len = blob.read_shift(4);
		dict[pid] = blob.read_shift(len, (CodePage === 0x4B0 ?'utf16le':'utf8')).replace(chr0,'').replace(chr1,'!');
		if(CodePage === 0x4B0 && (len % 2)) blob.l += 2;
	}
	if(blob.l & 3) blob.l = (blob.l>>2+1)<<2;
	return dict;
}

/* [MS-OLEPS] 2.9 BLOB */
function parse_BLOB(blob) {
	var size = blob.read_shift(4);
	var bytes = blob.slice(blob.l,blob.l+size);
	blob.l += size;
	if((size & 3) > 0) blob.l += (4 - (size & 3)) & 3;
	return bytes;
}

/* [MS-OLEPS] 2.11 ClipboardData */
function parse_ClipboardData(blob) {
	// TODO
	var o = {};
	o.Size = blob.read_shift(4);
	//o.Format = blob.read_shift(4);
	blob.l += o.Size + 3 - (o.Size - 1) % 4;
	return o;
}

/* [MS-OLEPS] 2.15 TypedPropertyValue */
function parse_TypedPropertyValue(blob, type, _opts) {
	var t = blob.read_shift(2), ret, opts = _opts||{};
	blob.l += 2;
	if(type !== VT_VARIANT)
	if(t !== type && VT_CUSTOM.indexOf(type)===-1 && !((type & 0xFFFE) == 0x101E && (t & 0xFFFE) == 0x101E)) throw new Error('Expected type ' + type + ' saw ' + t);
	switch(type === VT_VARIANT ? t : type) {
		case 0x02 /*VT_I2*/: ret = blob.read_shift(2, 'i'); if(!opts.raw) blob.l += 2; return ret;
		case 0x03 /*VT_I4*/: ret = blob.read_shift(4, 'i'); return ret;
		case 0x0B /*VT_BOOL*/: return blob.read_shift(4) !== 0x0;
		case 0x13 /*VT_UI4*/: ret = blob.read_shift(4); return ret;
		case 0x1E /*VT_LPSTR*/: blob.l += 4; val = parse_VtString(blob, blob[blob.l-4]).replace(/(^|[^\u0000])\u0000+$/,"$1"); break;
		case 0x1F /*VT_LPWSTR*/: blob.l += 4; val = parse_VtString(blob, blob[blob.l-4]).replace(/(^|[^\u0000])\u0000+$/,"$1"); break;
		case 0x40 /*VT_FILETIME*/: return parse_FILETIME(blob);
		case 0x41 /*VT_BLOB*/: return parse_BLOB(blob);
		case 0x47 /*VT_CF*/: return parse_ClipboardData(blob);
		case 0x50 /*VT_STRING*/: return parse_VtString(blob, t, !opts.raw).replace(chr0,'');
		case 0x51 /*VT_USTR*/: return parse_VtUnalignedString(blob, t/*, 4*/).replace(chr0,'');
		case 0x100C /*VT_VECTOR|VT_VARIANT*/: return parse_VtVecHeadingPairValue(blob);
		case 0x101E /*VT_VECTOR|VT_LPSTR*/:
		case 0x101F /*VT_VECTOR|VT_LPWSTR*/:
			return t == 0x101F ? parse_VtVecLpwstrValue(blob) : parse_VtVecUnalignedLpstrValue(blob);
		default: throw new Error("TypedPropertyValue unrecognized type " + type + " " + t);
	}
}
function write_TypedPropertyValue(type, value) {
	var o = new_buf(4), p = new_buf(4);
	o.write_shift(4, type == 0x50 ? 0x1F : type);
	switch(type) {
		case 0x03 /*VT_I4*/: p.write_shift(-4, value); break;
		case 0x05 /*VT_I4*/: p = new_buf(8); p.write_shift(8, value, 'f'); break;
		case 0x0B /*VT_BOOL*/: p.write_shift(4, value ? 0x01 : 0x00); break;
		case 0x40 /*VT_FILETIME*/:  p = write_FILETIME(value); break;
		case 0x1F /*VT_LPWSTR*/:
		case 0x50 /*VT_STRING*/:
p = new_buf(4 + 2 * (value.length + 1) + (value.length % 2 ? 0 : 2));
			p.write_shift(4, value.length + 1);
			p.write_shift(0, value, "dbcs");
			while(p.l != p.length) p.write_shift(1, 0);
			break;
		default: throw new Error("TypedPropertyValue unrecognized type " + type + " " + value);
	}
	return bconcat([o, p]);
}

/* [MS-OLEPS] 2.20 PropertySet */
function parse_PropertySet(blob, PIDSI) {
	var start_addr = blob.l;
	var size = blob.read_shift(4);
	var NumProps = blob.read_shift(4);
	var Props = [], i = 0;
	var CodePage = 0;
	var Dictionary = -1, DictObj = ({});
	for(i = 0; i != NumProps; ++i) {
		var PropID = blob.read_shift(4);
		var Offset = blob.read_shift(4);
		Props[i] = [PropID, Offset + start_addr];
	}
	Props.sort(function(x,y) { return x[1] - y[1]; });
	var PropH = {};
	for(i = 0; i != NumProps; ++i) {
		if(blob.l !== Props[i][1]) {
			var fail = true;
			if(i>0 && PIDSI) switch(PIDSI[Props[i-1][0]].t) {
				case 0x02 /*VT_I2*/: if(blob.l+2 === Props[i][1]) { blob.l+=2; fail = false; } break;
				case 0x50 /*VT_STRING*/: if(blob.l <= Props[i][1]) { blob.l=Props[i][1]; fail = false; } break;
				case 0x100C /*VT_VECTOR|VT_VARIANT*/: if(blob.l <= Props[i][1]) { blob.l=Props[i][1]; fail = false; } break;
			}
			if((!PIDSI||i==0) && blob.l <= Props[i][1]) { fail=false; blob.l = Props[i][1]; }
			if(fail) throw new Error("Read Error: Expected address " + Props[i][1] + ' at ' + blob.l + ' :' + i);
		}
		if(PIDSI) {
			if(Props[i][0] == 0 && Props.length > i+1 && Props[i][1] == Props[i+1][1]) continue; // R9
			var piddsi = PIDSI[Props[i][0]];
			PropH[piddsi.n] = parse_TypedPropertyValue(blob, piddsi.t, {raw:true});
			if(piddsi.p === 'version') PropH[piddsi.n] = String(PropH[piddsi.n] >> 16) + "." + ("0000" + String(PropH[piddsi.n] & 0xFFFF)).slice(-4);
			if(piddsi.n == "CodePage") switch(PropH[piddsi.n]) {
				case 0: PropH[piddsi.n] = 1252;
					/* falls through */
				case 874:
				case 932:
				case 936:
				case 949:
				case 950:
				case 1250:
				case 1251:
				case 1253:
				case 1254:
				case 1255:
				case 1256:
				case 1257:
				case 1258:
				case 10000:
				case 1200:
				case 1201:
				case 1252:
				case 65000: case -536:
				case 65001: case -535:
					set_cp(CodePage = (PropH[piddsi.n]>>>0) & 0xFFFF); break;
				default: throw new Error("Unsupported CodePage: " + PropH[piddsi.n]);
			}
		} else {
			if(Props[i][0] === 0x1) {
				CodePage = PropH.CodePage = (parse_TypedPropertyValue(blob, VT_I2));
				set_cp(CodePage);
				if(Dictionary !== -1) {
					var oldpos = blob.l;
					blob.l = Props[Dictionary][1];
					DictObj = parse_dictionary(blob,CodePage);
					blob.l = oldpos;
				}
			} else if(Props[i][0] === 0) {
				if(CodePage === 0) { Dictionary = i; blob.l = Props[i+1][1]; continue; }
				DictObj = parse_dictionary(blob,CodePage);
			} else {
				var name = DictObj[Props[i][0]];
				var val;
				/* [MS-OSHARED] 2.3.3.2.3.1.2 + PROPVARIANT */
				switch(blob[blob.l]) {
					case 0x41 /*VT_BLOB*/: blob.l += 4; val = parse_BLOB(blob); break;
					case 0x1E /*VT_LPSTR*/: blob.l += 4; val = parse_VtString(blob, blob[blob.l-4]).replace(/(^|[^\u0000])\u0000+$/,"$1"); break;
					case 0x1F /*VT_LPWSTR*/: blob.l += 4; val = parse_VtString(blob, blob[blob.l-4]).replace(/(^|[^\u0000])\u0000+$/,"$1"); break;
					case 0x03 /*VT_I4*/: blob.l += 4; val = blob.read_shift(4, 'i'); break;
					case 0x13 /*VT_UI4*/: blob.l += 4; val = blob.read_shift(4); break;
					case 0x05 /*VT_R8*/: blob.l += 4; val = blob.read_shift(8, 'f'); break;
					case 0x0B /*VT_BOOL*/: blob.l += 4; val = parsebool(blob, 4); break;
					case 0x40 /*VT_FILETIME*/: blob.l += 4; val = parseDate(parse_FILETIME(blob)); break;
					default: throw new Error("unparsed value: " + blob[blob.l]);
				}
				PropH[name] = val;
			}
		}
	}
	blob.l = start_addr + size; /* step ahead to skip padding */
	return PropH;
}
var XLSPSSkip = [ "CodePage", "Thumbnail", "_PID_LINKBASE", "_PID_HLINKS", "SystemIdentifier", "FMTID" ];
function guess_property_type(val) {
	switch(typeof val) {
		case "boolean": return 0x0B;
		case "number": return ((val|0)==val) ? 0x03 : 0x05;
		case "string": return 0x1F;
		case "object": if(val instanceof Date) return 0x40; break;
	}
	return -1;
}
function write_PropertySet(entries, RE, PIDSI) {
	var hdr = new_buf(8), piao = [], prop = [];
	var sz = 8, i = 0;

	var pr = new_buf(8), pio = new_buf(8);
	pr.write_shift(4, 0x0002);
	pr.write_shift(4, 0x04B0);
	pio.write_shift(4, 0x0001);
	prop.push(pr); piao.push(pio);
	sz += 8 + pr.length;

	if(!RE) {
		pio = new_buf(8);
		pio.write_shift(4, 0);
		piao.unshift(pio);

		var bufs = [new_buf(4)];
		bufs[0].write_shift(4, entries.length);
		for(i = 0; i < entries.length; ++i) {
			var value = entries[i][0];
			pr = new_buf(4 + 4 + 2 * (value.length + 1) + (value.length % 2 ? 0 : 2));
			pr.write_shift(4, i+2);
			pr.write_shift(4, value.length + 1);
			pr.write_shift(0, value, "dbcs");
			while(pr.l != pr.length) pr.write_shift(1, 0);
			bufs.push(pr);
		}
		pr = bconcat(bufs);
		prop.unshift(pr);
		sz += 8 + pr.length;
	}

	for(i = 0; i < entries.length; ++i) {
		if(RE && !RE[entries[i][0]]) continue;
		if(XLSPSSkip.indexOf(entries[i][0]) > -1 || PseudoPropsPairs.indexOf(entries[i][0]) > -1) continue;
		if(entries[i][1] == null) continue;

		var val = entries[i][1], idx = 0;
		if(RE) {
			idx = +RE[entries[i][0]];
			var pinfo = (PIDSI)[idx];
			if(pinfo.p == "version" && typeof val == "string") {
var arr = val.split(".");
				val = ((+arr[0])<<16) + ((+arr[1])||0);
			}
			pr = write_TypedPropertyValue(pinfo.t, val);
		} else {
			var T = guess_property_type(val);
			if(T == -1) { T = 0x1F; val = String(val); }
			pr = write_TypedPropertyValue(T, val);
		}
		prop.push(pr);

		pio = new_buf(8);
		pio.write_shift(4, !RE ? 2+i : idx);
		piao.push(pio);

		sz += 8 + pr.length;
	}

	var w = 8 * (prop.length + 1);
	for(i = 0; i < prop.length; ++i) { piao[i].write_shift(4, w); w += prop[i].length; }
	hdr.write_shift(4, sz);
	hdr.write_shift(4, prop.length);
	return bconcat([hdr].concat(piao).concat(prop));
}

/* [MS-OLEPS] 2.21 PropertySetStream */
function parse_PropertySetStream(file, PIDSI, clsid) {
	var blob = file.content;
	if(!blob) return ({});
	prep_blob(blob, 0);

	var NumSets, FMTID0, FMTID1, Offset0, Offset1 = 0;
	blob.chk('feff', 'Byte Order: ');

	/*var vers = */blob.read_shift(2); // TODO: check version
	var SystemIdentifier = blob.read_shift(4);
	var CLSID = blob.read_shift(16);
	if(CLSID !== CFB.utils.consts.HEADER_CLSID && CLSID !== clsid) throw new Error("Bad PropertySet CLSID " + CLSID);
	NumSets = blob.read_shift(4);
	if(NumSets !== 1 && NumSets !== 2) throw new Error("Unrecognized #Sets: " + NumSets);
	FMTID0 = blob.read_shift(16); Offset0 = blob.read_shift(4);

	if(NumSets === 1 && Offset0 !== blob.l) throw new Error("Length mismatch: " + Offset0 + " !== " + blob.l);
	else if(NumSets === 2) { FMTID1 = blob.read_shift(16); Offset1 = blob.read_shift(4); }
	var PSet0 = parse_PropertySet(blob, PIDSI);

	var rval = ({ SystemIdentifier: SystemIdentifier });
	for(var y in PSet0) rval[y] = PSet0[y];
	//rval.blob = blob;
	rval.FMTID = FMTID0;
	//rval.PSet0 = PSet0;
	if(NumSets === 1) return rval;
	if(Offset1 - blob.l == 2) blob.l += 2;
	if(blob.l !== Offset1) throw new Error("Length mismatch 2: " + blob.l + " !== " + Offset1);
	var PSet1;
	try { PSet1 = parse_PropertySet(blob, null); } catch(e) {/* empty */}
	for(y in PSet1) rval[y] = PSet1[y];
	rval.FMTID = [FMTID0, FMTID1]; // TODO: verify FMTID0/1
	return rval;
}
function write_PropertySetStream(entries, clsid, RE, PIDSI, entries2, clsid2) {
	var hdr = new_buf(entries2 ? 68 : 48);
	var bufs = [hdr];
	hdr.write_shift(2, 0xFFFE);
	hdr.write_shift(2, 0x0000); /* TODO: type 1 props */
	hdr.write_shift(4, 0x32363237);
	hdr.write_shift(16, CFB.utils.consts.HEADER_CLSID, "hex");
	hdr.write_shift(4, (entries2 ? 2 : 1));
	hdr.write_shift(16, clsid, "hex");
	hdr.write_shift(4, (entries2 ? 68 : 48));
	var ps0 = write_PropertySet(entries, RE, PIDSI);
	bufs.push(ps0);

	if(entries2) {
		var ps1 = write_PropertySet(entries2, null, null);
		hdr.write_shift(16, clsid2, "hex");
		hdr.write_shift(4, 68 + ps0.length);
		bufs.push(ps1);
	}
	return bconcat(bufs);
}

function parsenoop2(blob, length) { blob.read_shift(length); return null; }
function writezeroes(n, o) { if(!o) o=new_buf(n); for(var j=0; j<n; ++j) o.write_shift(1, 0); return o; }

function parslurp(blob, length, cb) {
	var arr = [], target = blob.l + length;
	while(blob.l < target) arr.push(cb(blob, target - blob.l));
	if(target !== blob.l) throw new Error("Slurp error");
	return arr;
}

function parsebool(blob, length) { return blob.read_shift(length) === 0x1; }
function writebool(v, o) { if(!o) o=new_buf(2); o.write_shift(2, +!!v); return o; }

function parseuint16(blob) { return blob.read_shift(2, 'u'); }
function writeuint16(v, o) { if(!o) o=new_buf(2); o.write_shift(2, v); return o; }
function parseuint16a(blob, length) { return parslurp(blob,length,parseuint16);}

/* --- 2.5 Structures --- */

/* [MS-XLS] 2.5.10 Bes (boolean or error) */
function parse_Bes(blob) {
	var v = blob.read_shift(1), t = blob.read_shift(1);
	return t === 0x01 ? v : v === 0x01;
}
function write_Bes(v, t, o) {
	if(!o) o = new_buf(2);
	o.write_shift(1, ((t == 'e') ? +v : +!!v));
	o.write_shift(1, ((t == 'e') ? 1 : 0));
	return o;
}

/* [MS-XLS] 2.5.240 ShortXLUnicodeString */
function parse_ShortXLUnicodeString(blob, length, opts) {
	var cch = blob.read_shift(opts && opts.biff >= 12 ? 2 : 1);
	var encoding = 'sbcs-cont';
	var cp = current_codepage;
	if(opts && opts.biff >= 8) current_codepage = 1200;
	if(!opts || opts.biff == 8 ) {
		var fHighByte = blob.read_shift(1);
		if(fHighByte) { encoding = 'dbcs-cont'; }
	} else if(opts.biff == 12) {
		encoding = 'wstr';
	}
	if(opts.biff >= 2 && opts.biff <= 5) encoding = 'cpstr';
	var o = cch ? blob.read_shift(cch, encoding) : "";
	current_codepage = cp;
	return o;
}

/* 2.5.293 XLUnicodeRichExtendedString */
function parse_XLUnicodeRichExtendedString(blob) {
	var cp = current_codepage;
	current_codepage = 1200;
	var cch = blob.read_shift(2), flags = blob.read_shift(1);
	var /*fHighByte = flags & 0x1,*/ fExtSt = flags & 0x4, fRichSt = flags & 0x8;
	var width = 1 + (flags & 0x1); // 0x0 -> utf8, 0x1 -> dbcs
	var cRun = 0, cbExtRst;
	var z = {};
	if(fRichSt) cRun = blob.read_shift(2);
	if(fExtSt) cbExtRst = blob.read_shift(4);
	var encoding = width == 2 ? 'dbcs-cont' : 'sbcs-cont';
	var msg = cch === 0 ? "" : blob.read_shift(cch, encoding);
	if(fRichSt) blob.l += 4 * cRun; //TODO: parse this
	if(fExtSt) blob.l += cbExtRst; //TODO: parse this
	z.t = msg;
	if(!fRichSt) { z.raw = "<t>" + z.t + "</t>"; z.r = z.t; }
	current_codepage = cp;
	return z;
}
function write_XLUnicodeRichExtendedString(xlstr) {
	var str = (xlstr.t||""), nfmts = 1;

	var hdr = new_buf(3 + (nfmts > 1 ? 2 : 0));
	hdr.write_shift(2, str.length);
	hdr.write_shift(1, (nfmts > 1 ? 0x08 : 0x00) | 0x01);
	if(nfmts > 1) hdr.write_shift(2, nfmts);

	var otext = new_buf(2 * str.length);
	otext.write_shift(2 * str.length, str, 'utf16le');

	var out = [hdr, otext];

	return bconcat(out);
}

/* 2.5.296 XLUnicodeStringNoCch */
function parse_XLUnicodeStringNoCch(blob, cch, opts) {
	var retval;
	if(opts) {
		if(opts.biff >= 2 && opts.biff <= 5) return blob.read_shift(cch, 'cpstr');
		if(opts.biff >= 12) return blob.read_shift(cch, 'dbcs-cont');
	}
	var fHighByte = blob.read_shift(1);
	if(fHighByte===0) { retval = blob.read_shift(cch, 'sbcs-cont'); }
	else { retval = blob.read_shift(cch, 'dbcs-cont'); }
	return retval;
}

/* 2.5.294 XLUnicodeString */
function parse_XLUnicodeString(blob, length, opts) {
	var cch = blob.read_shift(opts && opts.biff == 2 ? 1 : 2);
	if(cch === 0) { blob.l++; return ""; }
	return parse_XLUnicodeStringNoCch(blob, cch, opts);
}
/* BIFF5 override */
function parse_XLUnicodeString2(blob, length, opts) {
	if(opts.biff > 5) return parse_XLUnicodeString(blob, length, opts);
	var cch = blob.read_shift(1);
	if(cch === 0) { blob.l++; return ""; }
	return blob.read_shift(cch, (opts.biff <= 4 || !blob.lens ) ? 'cpstr' : 'sbcs-cont');
}
/* TODO: BIFF5 and lower, codepage awareness */
function write_XLUnicodeString(str, opts, o) {
	if(!o) o = new_buf(3 + 2 * str.length);
	o.write_shift(2, str.length);
	o.write_shift(1, 1);
	o.write_shift(31, str, 'utf16le');
	return o;
}

/* [MS-XLS] 2.5.61 ControlInfo */
function parse_ControlInfo(blob) {
	var flags = blob.read_shift(1);
	blob.l++;
	var accel = blob.read_shift(2);
	blob.l += 2;
	return [flags, accel];
}

/* [MS-OSHARED] 2.3.7.6 URLMoniker TODO: flags */
function parse_URLMoniker(blob) {
	var len = blob.read_shift(4), start = blob.l;
	var extra = false;
	if(len > 24) {
		/* look ahead */
		blob.l += len - 24;
		if(blob.read_shift(16) === "795881f43b1d7f48af2c825dc4852763") extra = true;
		blob.l = start;
	}
	var url = blob.read_shift((extra?len-24:len)>>1, 'utf16le').replace(chr0,"");
	if(extra) blob.l += 24;
	return url;
}

/* [MS-OSHARED] 2.3.7.8 FileMoniker TODO: all fields */
function parse_FileMoniker(blob) {
	var cAnti = blob.read_shift(2);
	var preamble = ""; while(cAnti-- > 0) preamble += "../";
	var ansiPath = blob.read_shift(0, 'lpstr-ansi');
	blob.l += 2; //var endServer = blob.read_shift(2);
	if(blob.read_shift(2) != 0xDEAD) throw new Error("Bad FileMoniker");
	var sz = blob.read_shift(4);
	if(sz === 0) return preamble + ansiPath.replace(/\\/g,"/");
	var bytes = blob.read_shift(4);
	if(blob.read_shift(2) != 3) throw new Error("Bad FileMoniker");
	var unicodePath = blob.read_shift(bytes>>1, 'utf16le').replace(chr0,"");
	return preamble + unicodePath;
}

/* [MS-OSHARED] 2.3.7.2 HyperlinkMoniker TODO: all the monikers */
function parse_HyperlinkMoniker(blob, length) {
	var clsid = blob.read_shift(16); length -= 16;
	switch(clsid) {
		case "e0c9ea79f9bace118c8200aa004ba90b": return parse_URLMoniker(blob, length);
		case "0303000000000000c000000000000046": return parse_FileMoniker(blob, length);
		default: throw new Error("Unsupported Moniker " + clsid);
	}
}

/* [MS-OSHARED] 2.3.7.9 HyperlinkString */
function parse_HyperlinkString(blob) {
	var len = blob.read_shift(4);
	var o = len > 0 ? blob.read_shift(len, 'utf16le').replace(chr0, "") : "";
	return o;
}
function write_HyperlinkString(str, o) {
	if(!o) o = new_buf(6 + str.length * 2);
	o.write_shift(4, 1 + str.length);
	for(var i = 0; i < str.length; ++i) o.write_shift(2, str.charCodeAt(i));
	o.write_shift(2, 0);
	return o;
}

/* [MS-OSHARED] 2.3.7.1 Hyperlink Object */
function parse_Hyperlink(blob, length) {
	var end = blob.l + length;
	var sVer = blob.read_shift(4);
	if(sVer !== 2) throw new Error("Unrecognized streamVersion: " + sVer);
	var flags = blob.read_shift(2);
	blob.l += 2;
	var displayName, targetFrameName, moniker, oleMoniker, Loc="", guid, fileTime;
	if(flags & 0x0010) displayName = parse_HyperlinkString(blob, end - blob.l);
	if(flags & 0x0080) targetFrameName = parse_HyperlinkString(blob, end - blob.l);
	if((flags & 0x0101) === 0x0101) moniker = parse_HyperlinkString(blob, end - blob.l);
	if((flags & 0x0101) === 0x0001) oleMoniker = parse_HyperlinkMoniker(blob, end - blob.l);
	if(flags & 0x0008) Loc = parse_HyperlinkString(blob, end - blob.l);
	if(flags & 0x0020) guid = blob.read_shift(16);
	if(flags & 0x0040) fileTime = parse_FILETIME(blob/*, 8*/);
	blob.l = end;
	var target = targetFrameName||moniker||oleMoniker||"";
	if(target && Loc) target+="#"+Loc;
	if(!target) target = "#" + Loc;
	if((flags & 0x0002) && target.charAt(0) == "/" && target.charAt(1) != "/") target = "file://" + target;
	var out = ({Target:target});
	if(guid) out.guid = guid;
	if(fileTime) out.time = fileTime;
	if(displayName) out.Tooltip = displayName;
	return out;
}
function write_Hyperlink(hl) {
	var out = new_buf(512), i = 0;
	var Target = hl.Target;
	if(Target.slice(0,7) == "file://") Target = Target.slice(7);
	var hashidx = Target.indexOf("#");
	var F = hashidx > -1 ? 0x1f : 0x17;
	switch(Target.charAt(0)) { case "#": F=0x1c; break; case ".": F&=~2; break; }
	out.write_shift(4,2); out.write_shift(4, F);
	var data = [8,6815827,6619237,4849780,83]; for(i = 0; i < data.length; ++i) out.write_shift(4, data[i]);
	if(F == 0x1C) {
		Target = Target.slice(1);
		write_HyperlinkString(Target, out);
	} else if(F & 0x02) {
		data = "e0 c9 ea 79 f9 ba ce 11 8c 82 00 aa 00 4b a9 0b".split(" ");
		for(i = 0; i < data.length; ++i) out.write_shift(1, parseInt(data[i], 16));
		var Pretarget = hashidx > -1 ? Target.slice(0, hashidx) : Target;
		out.write_shift(4, 2*(Pretarget.length + 1));
		for(i = 0; i < Pretarget.length; ++i) out.write_shift(2, Pretarget.charCodeAt(i));
		out.write_shift(2, 0);
		if(F & 0x08) write_HyperlinkString(hashidx > -1 ? Target.slice(hashidx+1): "", out);
	} else {
		data = "03 03 00 00 00 00 00 00 c0 00 00 00 00 00 00 46".split(" ");
		for(i = 0; i < data.length; ++i) out.write_shift(1, parseInt(data[i], 16));
		var P = 0;
		while(Target.slice(P*3,P*3+3)=="../"||Target.slice(P*3,P*3+3)=="..\\") ++P;
		out.write_shift(2, P);
		out.write_shift(4, Target.length - 3 * P + 1);
		for(i = 0; i < Target.length - 3 * P; ++i) out.write_shift(1, Target.charCodeAt(i + 3 * P) & 0xFF);
		out.write_shift(1, 0);
		out.write_shift(2, 0xFFFF);
		out.write_shift(2, 0xDEAD);
		for(i = 0; i < 6; ++i) out.write_shift(4, 0);
	}
	return out.slice(0, out.l);
}

/* 2.5.178 LongRGBA */
function parse_LongRGBA(blob) { var r = blob.read_shift(1), g = blob.read_shift(1), b = blob.read_shift(1), a = blob.read_shift(1); return [r,g,b,a]; }

/* 2.5.177 LongRGB */
function parse_LongRGB(blob, length) { var x = parse_LongRGBA(blob, length); x[3] = 0; return x; }


/* [MS-XLS] 2.5.19 */
function parse_XLSCell(blob, length, opts) {
	var rw = blob.read_shift(2); // 0-indexed
	var col = blob.read_shift(2);
	var ret = ({r:rw, c:col, ixfe:0});
	if(opts && opts.biff == 2 || length == 7) {
		/* TODO: pass back flags */
		var flags = blob.read_shift(1);
		ret.ixfe = flags & 0x3F;
		blob.l += 2;
		/*
		var ifntifmt = blob.read_shift(1);
		var ifmt = ifntifmt & 0x3f, ifnt = ifntifmt >> 6;
		var flags3 = blob.read_shift(1);
		*/
	} else ret.ixfe = blob.read_shift(2);
	return ret;
}
function write_XLSCell(R, C, ixfe, o) {
	if(!o) o = new_buf(6);
	o.write_shift(2, R);
	o.write_shift(2, C);
	o.write_shift(2, ixfe||0);
	return o;
}

/* [MS-XLS] 2.5.134 */
function parse_frtHeader(blob) {
	var rt = blob.read_shift(2);
	var flags = blob.read_shift(2); // TODO: parse these flags
	blob.l += 8;
	return {type: rt, flags: flags};
}



function parse_OptXLUnicodeString(blob, length, opts) { return length === 0 ? "" : parse_XLUnicodeString2(blob, length, opts); }

/* [MS-XLS] 2.5.344 */
function parse_XTI(blob, length, opts) {
	var w = opts.biff > 8 ? 4 : 2;
	var iSupBook = blob.read_shift(w), itabFirst = blob.read_shift(w,'i'), itabLast = blob.read_shift(w,'i');
	return [iSupBook, itabFirst, itabLast];
}

/* [MS-XLS] 2.5.218 */
function parse_RkRec(blob) {
	var ixfe = blob.read_shift(2);
	var RK = parse_RkNumber(blob);
	return [ixfe, RK];
}

/* [MS-XLS] 2.5.1 */
function parse_AddinUdf(blob, length, opts) {
	blob.l += 4; length -= 4;
	var l = blob.l + length;
	var udfName = parse_ShortXLUnicodeString(blob, length, opts);
	var cb = blob.read_shift(2);
	l -= blob.l;
	if(cb !== l) throw new Error("Malformed AddinUdf: padding = " + l + " != " + cb);
	blob.l += cb;
	return udfName;
}

/* [MS-XLS] 2.5.209 TODO: Check sizes */
function parse_Ref8U(blob) {
	var rwFirst = blob.read_shift(2);
	var rwLast = blob.read_shift(2);
	var colFirst = blob.read_shift(2);
	var colLast = blob.read_shift(2);
	return {s:{c:colFirst, r:rwFirst}, e:{c:colLast,r:rwLast}};
}
function write_Ref8U(r, o) {
	if(!o) o = new_buf(8);
	o.write_shift(2, r.s.r);
	o.write_shift(2, r.e.r);
	o.write_shift(2, r.s.c);
	o.write_shift(2, r.e.c);
	return o;
}

/* [MS-XLS] 2.5.211 */
function parse_RefU(blob) {
	var rwFirst = blob.read_shift(2);
	var rwLast = blob.read_shift(2);
	var colFirst = blob.read_shift(1);
	var colLast = blob.read_shift(1);
	return {s:{c:colFirst, r:rwFirst}, e:{c:colLast,r:rwLast}};
}

/* [MS-XLS] 2.5.207 */
var parse_Ref = parse_RefU;

/* [MS-XLS] 2.5.143 */
function parse_FtCmo(blob) {
	blob.l += 4;
	var ot = blob.read_shift(2);
	var id = blob.read_shift(2);
	var flags = blob.read_shift(2);
	blob.l+=12;
	return [id, ot, flags];
}

/* [MS-XLS] 2.5.149 */
function parse_FtNts(blob) {
	var out = {};
	blob.l += 4;
	blob.l += 16; // GUID TODO
	out.fSharedNote = blob.read_shift(2);
	blob.l += 4;
	return out;
}

/* [MS-XLS] 2.5.142 */
function parse_FtCf(blob) {
	var out = {};
	blob.l += 4;
	blob.cf = blob.read_shift(2);
	return out;
}

/* [MS-XLS] 2.5.140 - 2.5.154 and friends */
function parse_FtSkip(blob) { blob.l += 2; blob.l += blob.read_shift(2); }
var FtTab = {
	0x00: parse_FtSkip,      /* FtEnd */
	0x04: parse_FtSkip,      /* FtMacro */
	0x05: parse_FtSkip,      /* FtButton */
	0x06: parse_FtSkip,      /* FtGmo */
	0x07: parse_FtCf,        /* FtCf */
	0x08: parse_FtSkip,      /* FtPioGrbit */
	0x09: parse_FtSkip,      /* FtPictFmla */
	0x0A: parse_FtSkip,      /* FtCbls */
	0x0B: parse_FtSkip,      /* FtRbo */
	0x0C: parse_FtSkip,      /* FtSbs */
	0x0D: parse_FtNts,       /* FtNts */
	0x0E: parse_FtSkip,      /* FtSbsFmla */
	0x0F: parse_FtSkip,      /* FtGboData */
	0x10: parse_FtSkip,      /* FtEdoData */
	0x11: parse_FtSkip,      /* FtRboData */
	0x12: parse_FtSkip,      /* FtCblsData */
	0x13: parse_FtSkip,      /* FtLbsData */
	0x14: parse_FtSkip,      /* FtCblsFmla */
	0x15: parse_FtCmo
};
function parse_FtArray(blob, length) {
	var tgt = blob.l + length;
	var fts = [];
	while(blob.l < tgt) {
		var ft = blob.read_shift(2);
		blob.l-=2;
		try {
			fts[ft] = FtTab[ft](blob, tgt - blob.l);
		} catch(e) { blob.l = tgt; return fts; }
	}
	if(blob.l != tgt) blob.l = tgt; //throw new Error("bad Object Ft-sequence");
	return fts;
}

/* --- 2.4 Records --- */

/* [MS-XLS] 2.4.21 */
function parse_BOF(blob, length) {
	var o = {BIFFVer:0, dt:0};
	o.BIFFVer = blob.read_shift(2); length -= 2;
	if(length >= 2) { o.dt = blob.read_shift(2); blob.l -= 2; }
	switch(o.BIFFVer) {
		case 0x0600: /* BIFF8 */
		case 0x0500: /* BIFF5 */
		case 0x0400: /* BIFF4 */
		case 0x0300: /* BIFF3 */
		case 0x0200: /* BIFF2 */
		case 0x0002: case 0x0007: /* BIFF2 */
			break;
		default: if(length > 6) throw new Error("Unexpected BIFF Ver " + o.BIFFVer);
	}

	blob.read_shift(length);
	return o;
}
function write_BOF(wb, t, o) {
	var h = 0x0600, w = 16;
	switch(o.bookType) {
		case 'biff8': break;
		case 'biff5': h = 0x0500; w = 8; break;
		case 'biff4': h = 0x0004; w = 6; break;
		case 'biff3': h = 0x0003; w = 6; break;
		case 'biff2': h = 0x0002; w = 4; break;
		case 'xla': break;
		default: throw new Error("unsupported BIFF version");
	}
	var out = new_buf(w);
	out.write_shift(2, h);
	out.write_shift(2, t);
	if(w > 4) out.write_shift(2, 0x7262);
	if(w > 6) out.write_shift(2, 0x07CD);
	if(w > 8) {
		out.write_shift(2, 0xC009);
		out.write_shift(2, 0x0001);
		out.write_shift(2, 0x0706);
		out.write_shift(2, 0x0000);
	}
	return out;
}


/* [MS-XLS] 2.4.146 */
function parse_InterfaceHdr(blob, length) {
	if(length === 0) return 0x04b0;
	if((blob.read_shift(2))!==0x04b0){/* empty */}
	return 0x04b0;
}


/* [MS-XLS] 2.4.349 */
function parse_WriteAccess(blob, length, opts) {
	if(opts.enc) { blob.l += length; return ""; }
	var l = blob.l;
	// TODO: make sure XLUnicodeString doesnt overrun
	var UserName = parse_XLUnicodeString2(blob, 0, opts);
	blob.read_shift(length + l - blob.l);
	return UserName;
}
function write_WriteAccess(s, opts) {
	var b8 = !opts || opts.biff == 8;
	var o = new_buf(b8 ? 112 : 54);
	o.write_shift(opts.biff == 8 ? 2 : 1, 7);
	if(b8) o.write_shift(1, 0);
	o.write_shift(4, 0x33336853);
	o.write_shift(4, (0x00534A74 | (b8 ? 0 : 0x20000000)));
	while(o.l < o.length) o.write_shift(1, (b8 ? 0 : 32));
	return o;
}

/* [MS-XLS] 2.4.351 */
function parse_WsBool(blob, length, opts) {
	var flags = opts && opts.biff == 8 || length == 2 ? blob.read_shift(2) : (blob.l += length, 0);
	return { fDialog: flags & 0x10, fBelow: flags & 0x40, fRight: flags & 0x80 };
}

/* [MS-XLS] 2.4.28 */
function parse_BoundSheet8(blob, length, opts) {
	var name = "";
	if(opts.biff == 4) {
		name = parse_ShortXLUnicodeString(blob, 0, opts);
		if(name.length === 0) name = "Sheet1";
		return { name:name };
	}
	var pos = blob.read_shift(4);
	var hidden = blob.read_shift(1) & 0x03;
	var dt = blob.read_shift(1);
	switch(dt) {
		case 0: dt = 'Worksheet'; break;
		case 1: dt = 'Macrosheet'; break;
		case 2: dt = 'Chartsheet'; break;
		case 6: dt = 'VBAModule'; break;
	}
	name = parse_ShortXLUnicodeString(blob, 0, opts);
	if(name.length === 0) name = "Sheet1";
	return { pos:pos, hs:hidden, dt:dt, name:name };
}
function write_BoundSheet8(data, opts) {
	var w = (!opts || opts.biff >= 8 ? 2 : 1);
	var o = new_buf(8 + w * data.name.length);
	o.write_shift(4, data.pos);
	o.write_shift(1, data.hs || 0);
	o.write_shift(1, data.dt);
	o.write_shift(1, data.name.length);
	if(opts.biff >= 8) o.write_shift(1, 1);
	o.write_shift(w * data.name.length, data.name, opts.biff < 8 ? 'sbcs' : 'utf16le');
	var out = o.slice(0, o.l);
	out.l = o.l; return out;
}

/* [MS-XLS] 2.4.265 TODO */
function parse_SST(blob, length) {
	var end = blob.l + length;
	var cnt = blob.read_shift(4);
	var ucnt = blob.read_shift(4);
	var strs = ([]);
	for(var i = 0; i != ucnt && blob.l < end; ++i) {
		strs.push(parse_XLUnicodeRichExtendedString(blob));
	}
	strs.Count = cnt; strs.Unique = ucnt;
	return strs;
}
function write_SST(sst, opts) {
	var header = new_buf(8);
	header.write_shift(4, sst.Count);
	header.write_shift(4, sst.Unique);
	var strs = [];
	for(var j = 0; j < sst.length; ++j) strs[j] = write_XLUnicodeRichExtendedString(sst[j], opts);
	var o = bconcat([header].concat(strs));
o.parts = [header.length].concat(strs.map(function(str) { return str.length; }));
	return o;
}

/* [MS-XLS] 2.4.107 */
function parse_ExtSST(blob, length) {
	var extsst = {};
	extsst.dsst = blob.read_shift(2);
	blob.l += length-2;
	return extsst;
}


/* [MS-XLS] 2.4.221 TODO: check BIFF2-4 */
function parse_Row(blob) {
	var z = ({});
	z.r = blob.read_shift(2);
	z.c = blob.read_shift(2);
	z.cnt = blob.read_shift(2) - z.c;
	var miyRw = blob.read_shift(2);
	blob.l += 4; // reserved(2), unused(2)
	var flags = blob.read_shift(1); // various flags
	blob.l += 3; // reserved(8), ixfe(12), flags(4)
	if(flags & 0x07) z.level = flags & 0x07;
	// collapsed: flags & 0x10
	if(flags & 0x20) z.hidden = true;
	if(flags & 0x40) z.hpt = miyRw / 20;
	return z;
}


/* [MS-XLS] 2.4.125 */
function parse_ForceFullCalculation(blob) {
	var header = parse_frtHeader(blob);
	if(header.type != 0x08A3) throw new Error("Invalid Future Record " + header.type);
	var fullcalc = blob.read_shift(4);
	return fullcalc !== 0x0;
}





/* [MS-XLS] 2.4.215 rt */
function parse_RecalcId(blob) {
	blob.read_shift(2);
	return blob.read_shift(4);
}

/* [MS-XLS] 2.4.87 */
function parse_DefaultRowHeight(blob, length, opts) {
	var f = 0;
	if(!(opts && opts.biff == 2)) {
		f = blob.read_shift(2);
	}
	var miyRw = blob.read_shift(2);
	if((opts && opts.biff == 2)) {
		f = 1 - (miyRw >> 15); miyRw &= 0x7fff;
	}
	var fl = {Unsynced:f&1,DyZero:(f&2)>>1,ExAsc:(f&4)>>2,ExDsc:(f&8)>>3};
	return [fl, miyRw];
}

/* [MS-XLS] 2.4.345 TODO */
function parse_Window1(blob) {
	var xWn = blob.read_shift(2), yWn = blob.read_shift(2), dxWn = blob.read_shift(2), dyWn = blob.read_shift(2);
	var flags = blob.read_shift(2), iTabCur = blob.read_shift(2), iTabFirst = blob.read_shift(2);
	var ctabSel = blob.read_shift(2), wTabRatio = blob.read_shift(2);
	return { Pos: [xWn, yWn], Dim: [dxWn, dyWn], Flags: flags, CurTab: iTabCur,
		FirstTab: iTabFirst, Selected: ctabSel, TabRatio: wTabRatio };
}
function write_Window1() {
	var o = new_buf(18);
	o.write_shift(2, 0);
	o.write_shift(2, 0);
	o.write_shift(2, 0x7260);
	o.write_shift(2, 0x44c0);
	o.write_shift(2, 0x38);
	o.write_shift(2, 0);
	o.write_shift(2, 0);
	o.write_shift(2, 1);
	o.write_shift(2, 0x01f4);
	return o;
}
/* [MS-XLS] 2.4.346 TODO */
function parse_Window2(blob, length, opts) {
	if(opts && opts.biff >= 2 && opts.biff < 5) return {};
	var f = blob.read_shift(2);
	return { RTL: f & 0x40 };
}
function write_Window2(view) {
	var o = new_buf(18), f = 0x6b6;
	if(view && view.RTL) f |= 0x40;
	o.write_shift(2, f);
	o.write_shift(4, 0);
	o.write_shift(4, 64);
	o.write_shift(4, 0);
	o.write_shift(4, 0);
	return o;
}

/* [MS-XLS] 2.4.189 TODO */
function parse_Pane(/*blob, length, opts*/) {
}

/* [MS-XLS] 2.4.122 TODO */
function parse_Font(blob, length, opts) {
	var o = {
		dyHeight: blob.read_shift(2),
		fl: blob.read_shift(2)
	};
	switch((opts && opts.biff) || 8) {
		case 2: break;
		case 3: case 4: blob.l += 2; break;
		default: blob.l += 10; break;
	}
	o.name = parse_ShortXLUnicodeString(blob, 0, opts);
	return o;
}
function write_Font(data, opts) {
	var name = data.name || "Arial";
	var b5 = (opts && (opts.biff == 5)), w = (b5 ? (15 + name.length) : (16 + 2 * name.length));
	var o = new_buf(w);
	o.write_shift(2, (data.sz || 12) * 20);
	o.write_shift(4, 0);
	o.write_shift(2, 400);
	o.write_shift(4, 0);
	o.write_shift(2, 0);
	o.write_shift(1, name.length);
	if(!b5) o.write_shift(1, 1);
	o.write_shift((b5 ? 1 : 2) * name.length, name, (b5 ? "sbcs" : "utf16le"));
	return o;
}

/* [MS-XLS] 2.4.149 */
function parse_LabelSst(blob, length, opts) {
	var cell = parse_XLSCell(blob, length, opts);
	cell.isst = blob.read_shift(4);
	return cell;
}
function write_LabelSst(R, C, v, os ) {
	var o = new_buf(10);
	write_XLSCell(R, C, os, o);
	o.write_shift(4, v);
	return o;
}

/* [MS-XLS] 2.4.148 */
function parse_Label(blob, length, opts) {
	if(opts.biffguess && opts.biff == 2) opts.biff = 5;
	var target = blob.l + length;
	var cell = parse_XLSCell(blob, length, opts);
	var str = parse_XLUnicodeString(blob, target - blob.l, opts);
	cell.val = str;
	return cell;
}
function write_Label(R, C, v, os, opts) {
	var b8 = !opts || opts.biff == 8;
	var o = new_buf(6 + 2 + (+b8) + (1 + b8) * v.length);
	write_XLSCell(R, C, os, o);
	o.write_shift(2, v.length);
	if(b8) o.write_shift(1, 1);
	o.write_shift((1 + b8) * v.length, v, b8 ? 'utf16le' : 'sbcs');
	return o;
}


/* [MS-XLS] 2.4.126 Number Formats */
function parse_Format(blob, length, opts) {
	var numFmtId = blob.read_shift(2);
	var fmtstr = parse_XLUnicodeString2(blob, 0, opts);
	return [numFmtId, fmtstr];
}
function write_Format(i, f, opts, o) {
	var b5 = (opts && (opts.biff == 5));
	if(!o) o = new_buf(b5 ? (3 + f.length) : (5 + 2 * f.length));
	o.write_shift(2, i);
	o.write_shift((b5 ? 1 : 2), f.length);
	if(!b5) o.write_shift(1, 1);
	o.write_shift((b5 ? 1 : 2) * f.length, f, (b5 ? 'sbcs' : 'utf16le'));
	var out = (o.length > o.l) ? o.slice(0, o.l) : o;
	if(out.l == null) out.l = out.length;
	return out;
}
var parse_BIFF2Format = parse_XLUnicodeString2;
function write_BIFF2Format(f) {
	var o = new_buf(1 + f.length);
	o.write_shift(1, f.length);
	o.write_shift(f.length, f, "sbcs");
	return o;
}
function write_BIFF4Format(f) {
	var o = new_buf(3 + f.length);
	o.l += 2;
	o.write_shift(1, f.length);
	o.write_shift(f.length, f, "sbcs");
	return o;
}

/* [MS-XLS] 2.4.90 */
function parse_Dimensions(blob, length, opts) {
	var end = blob.l + length;
	var w = opts.biff == 8 || !opts.biff ? 4 : 2;
	var r = blob.read_shift(w), R = blob.read_shift(w);
	var c = blob.read_shift(2), C = blob.read_shift(2);
	blob.l = end;
	return {s: {r:r, c:c}, e: {r:R, c:C}};
}
function write_Dimensions(range, opts) {
	var w = opts.biff == 8 || !opts.biff ? 4 : 2;
	var o = new_buf(2*w + 6);
	o.write_shift(w, range.s.r);
	o.write_shift(w, range.e.r + 1);
	o.write_shift(2, range.s.c);
	o.write_shift(2, range.e.c + 1);
	o.write_shift(2, 0);
	return o;
}

/* [MS-XLS] 2.4.220 */
function parse_RK(blob) {
	var rw = blob.read_shift(2), col = blob.read_shift(2);
	var rkrec = parse_RkRec(blob);
	return {r:rw, c:col, ixfe:rkrec[0], rknum:rkrec[1]};
}

/* [MS-XLS] 2.4.175 */
function parse_MulRk(blob, length) {
	var target = blob.l + length - 2;
	var rw = blob.read_shift(2), col = blob.read_shift(2);
	var rkrecs = [];
	while(blob.l < target) rkrecs.push(parse_RkRec(blob));
	if(blob.l !== target) throw new Error("MulRK read error");
	var lastcol = blob.read_shift(2);
	if(rkrecs.length != lastcol - col + 1) throw new Error("MulRK length mismatch");
	return {r:rw, c:col, C:lastcol, rkrec:rkrecs};
}
/* [MS-XLS] 2.4.174 */
function parse_MulBlank(blob, length) {
	var target = blob.l + length - 2;
	var rw = blob.read_shift(2), col = blob.read_shift(2);
	var ixfes = [];
	while(blob.l < target) ixfes.push(blob.read_shift(2));
	if(blob.l !== target) throw new Error("MulBlank read error");
	var lastcol = blob.read_shift(2);
	if(ixfes.length != lastcol - col + 1) throw new Error("MulBlank length mismatch");
	return {r:rw, c:col, C:lastcol, ixfe:ixfes};
}

/* [MS-XLS] 2.5.20 2.5.249 TODO: interpret values here */
function parse_CellStyleXF(blob, length, style, opts) {
	var o = {};
	var a = blob.read_shift(4), b = blob.read_shift(4);
	var c = blob.read_shift(4), d = blob.read_shift(2);
	o.patternType = XLSFillPattern[c >> 26];

	if(!opts.cellStyles) return o;
	o.alc = a & 0x07;
	o.fWrap = (a >> 3) & 0x01;
	o.alcV = (a >> 4) & 0x07;
	o.fJustLast = (a >> 7) & 0x01;
	o.trot = (a >> 8) & 0xFF;
	o.cIndent = (a >> 16) & 0x0F;
	o.fShrinkToFit = (a >> 20) & 0x01;
	o.iReadOrder = (a >> 22) & 0x02;
	o.fAtrNum = (a >> 26) & 0x01;
	o.fAtrFnt = (a >> 27) & 0x01;
	o.fAtrAlc = (a >> 28) & 0x01;
	o.fAtrBdr = (a >> 29) & 0x01;
	o.fAtrPat = (a >> 30) & 0x01;
	o.fAtrProt = (a >> 31) & 0x01;

	o.dgLeft = b & 0x0F;
	o.dgRight = (b >> 4) & 0x0F;
	o.dgTop = (b >> 8) & 0x0F;
	o.dgBottom = (b >> 12) & 0x0F;
	o.icvLeft = (b >> 16) & 0x7F;
	o.icvRight = (b >> 23) & 0x7F;
	o.grbitDiag = (b >> 30) & 0x03;

	o.icvTop = c & 0x7F;
	o.icvBottom = (c >> 7) & 0x7F;
	o.icvDiag = (c >> 14) & 0x7F;
	o.dgDiag = (c >> 21) & 0x0F;

	o.icvFore = d & 0x7F;
	o.icvBack = (d >> 7) & 0x7F;
	o.fsxButton = (d >> 14) & 0x01;
	return o;
}
//function parse_CellXF(blob, length, opts) {return parse_CellStyleXF(blob,length,0, opts);}
//function parse_StyleXF(blob, length, opts) {return parse_CellStyleXF(blob,length,1, opts);}

/* [MS-XLS] 2.4.353 TODO: actually do this right */
function parse_XF(blob, length, opts) {
	var o = {};
	o.ifnt = blob.read_shift(2); o.numFmtId = blob.read_shift(2); o.flags = blob.read_shift(2);
	o.fStyle = (o.flags >> 2) & 0x01;
	length -= 6;
	o.data = parse_CellStyleXF(blob, length, o.fStyle, opts);
	return o;
}
function write_XF(data, ixfeP, opts, o) {
	var b5 = (opts && (opts.biff == 5));
	if(!o) o = new_buf(b5 ? 16 : 20);
	o.write_shift(2, 0);
	if(data.style) {
		o.write_shift(2, (data.numFmtId||0));
		o.write_shift(2, 0xFFF4);
	} else {
		o.write_shift(2, (data.numFmtId||0));
		o.write_shift(2, (ixfeP<<4));
	}
	var f = 0;
	if(data.numFmtId > 0 && b5) f |= 0x0400;
	o.write_shift(4, f);
	o.write_shift(4, 0);
	if(!b5) o.write_shift(4, 0);
	o.write_shift(2, 0);
	return o;
}
function parse_BIFF2XF(blob) {
	var o = {};
	o.ifnt = blob.read_shift(1); blob.l++; o.flags = blob.read_shift(1);
	o.numFmtId = o.flags & 0x3F; o.flags>>=6;
	o.fStyle = 0;
	o.data = {}; // TODO
	return o;
}
function write_BIFF2XF(xf) {
	var o = new_buf(4);
	o.l+=2;
	o.write_shift(1, xf.numFmtId);
	o.l++;
	return o;
}
function write_BIFF3XF(xf) {
	var o = new_buf(12);
	o.l++;
	o.write_shift(1, xf.numFmtId);
	o.l += 10;
	return o;
}
/* TODO: check other fields */
var write_BIFF4XF = write_BIFF3XF;
function parse_BIFF3XF(blob) {
	var o = {};
	o.ifnt = blob.read_shift(1); o.numFmtId = blob.read_shift(1); o.flags = blob.read_shift(2);
	o.fStyle = (o.flags >> 2) & 0x01;
	o.data = {}; // TODO
	return o;
}
function parse_BIFF4XF(blob) {
	var o = {};
	o.ifnt = blob.read_shift(1); o.numFmtId = blob.read_shift(1); o.flags = blob.read_shift(2);
	o.fStyle = (o.flags >> 2) & 0x01;
	o.data = {}; // TODO
	return o;
}

/* [MS-XLS] 2.4.134 */
function parse_Guts(blob) {
	blob.l += 4;
	var out = [blob.read_shift(2), blob.read_shift(2)];
	if(out[0] !== 0) out[0]--;
	if(out[1] !== 0) out[1]--;
	if(out[0] > 7 || out[1] > 7) throw new Error("Bad Gutters: " + out.join("|"));
	return out;
}
function write_Guts(guts) {
	var o = new_buf(8);
	o.write_shift(4, 0);
	o.write_shift(2, guts[0] ? guts[0] + 1 : 0);
	o.write_shift(2, guts[1] ? guts[1] + 1 : 0);
	return o;
}

/* [MS-XLS] 2.4.24 */
function parse_BoolErr(blob, length, opts) {
	var cell = parse_XLSCell(blob, 6, opts);
	var val = parse_Bes(blob, 2);
	cell.val = val;
	cell.t = (val === true || val === false) ? 'b' : 'e';
	return cell;
}
function write_BoolErr(R, C, v, os, opts, t) {
	var o = new_buf(8);
	write_XLSCell(R, C, os, o);
	write_Bes(v, t, o);
	return o;
}

/* [MS-XLS] 2.4.180 Number */
function parse_Number(blob, length, opts) {
	if(opts.biffguess && opts.biff == 2) opts.biff = 5;
	var cell = parse_XLSCell(blob, 6, opts);
	var xnum = parse_Xnum(blob, 8);
	cell.val = xnum;
	return cell;
}
function write_Number(R, C, v, os) {
	var o = new_buf(14);
	write_XLSCell(R, C, os, o);
	write_Xnum(v, o);
	return o;
}

var parse_XLHeaderFooter = parse_OptXLUnicodeString; // TODO: parse 2.4.136

/* [MS-XLS] 2.4.271 */
function parse_SupBook(blob, length, opts) {
	var end = blob.l + length;
	var ctab = blob.read_shift(2);
	var cch = blob.read_shift(2);
	opts.sbcch = cch;
	if(cch == 0x0401 || cch == 0x3A01) return [cch, ctab];
	if(cch < 0x01 || cch >0xff) throw new Error("Unexpected SupBook type: "+cch);
	var virtPath = parse_XLUnicodeStringNoCch(blob, cch);
	/* TODO: 2.5.277 Virtual Path */
	var rgst = [];
	while(end > blob.l) rgst.push(parse_XLUnicodeString(blob));
	return [cch, ctab, virtPath, rgst];
}

/* [MS-XLS] 2.4.105 TODO */
function parse_ExternName(blob, length, opts) {
	var flags = blob.read_shift(2);
	var body;
	var o = ({
		fBuiltIn: flags & 0x01,
		fWantAdvise: (flags >>> 1) & 0x01,
		fWantPict: (flags >>> 2) & 0x01,
		fOle: (flags >>> 3) & 0x01,
		fOleLink: (flags >>> 4) & 0x01,
		cf: (flags >>> 5) & 0x3FF,
		fIcon: flags >>> 15 & 0x01
	});
	if(opts.sbcch === 0x3A01) body = parse_AddinUdf(blob, length-2, opts);
	//else throw new Error("unsupported SupBook cch: " + opts.sbcch);
	o.body = body || blob.read_shift(length-2);
	if(typeof body === "string") o.Name = body;
	return o;
}

/* [MS-XLS] 2.4.150 TODO */
function parse_Lbl(blob, length, opts) {
	var target = blob.l + length;
	var flags = blob.read_shift(2);
	var chKey = blob.read_shift(1);
	var cch = blob.read_shift(1);
	var cce = blob.read_shift(opts && opts.biff == 2 ? 1 : 2);
	var itab = 0;
	if(!opts || opts.biff >= 5) {
		if(opts.biff != 5) blob.l += 2;
		itab = blob.read_shift(2);
		if(opts.biff == 5) blob.l += 2;
		blob.l += 4;
	}
	var name = parse_XLUnicodeStringNoCch(blob, cch, opts);
	if(flags & 0x20) name = XLSLblBuiltIn[name.charCodeAt(0)];
	var npflen = target - blob.l; if(opts && opts.biff == 2) --npflen;
	/*jshint -W018 */
	var rgce = (target == blob.l || cce === 0 || !(npflen > 0)) ? [] : parse_NameParsedFormula(blob, npflen, opts, cce);
	/*jshint +W018 */
	return {
		chKey: chKey,
		Name: name,
		itab: itab,
		rgce: rgce
	};
}

/* [MS-XLS] 2.4.106 TODO: legacy record filename encoding */
function parse_ExternSheet(blob, length, opts) {
	if(opts.biff < 8) return parse_BIFF5ExternSheet(blob, length, opts);
	/* see issue 2907 */
	if(!(opts.biff > 8) && (length == blob[blob.l] + (blob[blob.l+1] == 0x03 ? 1 : 0) + 1)) return parse_BIFF5ExternSheet(blob, length, opts);
	var o = [], target = blob.l + length, len = blob.read_shift(opts.biff > 8 ? 4 : 2);
	while(len-- !== 0) o.push(parse_XTI(blob, opts.biff > 8 ? 12 : 6, opts));
		// [iSupBook, itabFirst, itabLast];
	if(blob.l != target) throw new Error("Bad ExternSheet: " + blob.l + " != " + target);
	return o;
}
function parse_BIFF5ExternSheet(blob, length, opts) {
	if(blob[blob.l + 1] == 0x03) blob[blob.l]++;
	var o = parse_ShortXLUnicodeString(blob, length, opts);
	return o.charCodeAt(0) == 0x03 ? o.slice(1) : o;
}

/* [MS-XLS] 2.4.176 TODO: check older biff */
function parse_NameCmt(blob, length, opts) {
	if(opts.biff < 8) { blob.l += length; return; }
	var cchName = blob.read_shift(2);
	var cchComment = blob.read_shift(2);
	var name = parse_XLUnicodeStringNoCch(blob, cchName, opts);
	var comment = parse_XLUnicodeStringNoCch(blob, cchComment, opts);
	return [name, comment];
}

/* [MS-XLS] 2.4.260 */
function parse_ShrFmla(blob, length, opts) {
	var ref = parse_RefU(blob, 6);
	blob.l++;
	var cUse = blob.read_shift(1);
	length -= 8;
	return [parse_SharedParsedFormula(blob, length, opts), cUse, ref];
}

/* [MS-XLS] 2.4.4 TODO */
function parse_Array(blob, length, opts) {
	var ref = parse_Ref(blob, 6);
	/* TODO: fAlwaysCalc */
	switch(opts.biff) {
		case 2: blob.l ++; length -= 7; break;
		case 3: case 4: blob.l += 2; length -= 8; break;
		default: blob.l += 6; length -= 12;
	}
	return [ref, parse_ArrayParsedFormula(blob, length, opts, ref)];
}

/* [MS-XLS] 2.4.173 */
function parse_MTRSettings(blob) {
	var fMTREnabled = blob.read_shift(4) !== 0x00;
	var fUserSetThreadCount = blob.read_shift(4) !== 0x00;
	var cUserThreadCount = blob.read_shift(4);
	return [fMTREnabled, fUserSetThreadCount, cUserThreadCount];
}

/* [MS-XLS] 2.5.186 */
function parse_NoteSh(blob, length, opts) {
	var row = blob.read_shift(2), col = blob.read_shift(2);
	var flags = blob.read_shift(2), idObj = blob.read_shift(2);
	var stAuthor = parse_XLUnicodeString2(blob, 0, opts);
	return [{r:row,c:col}, stAuthor, idObj, flags];
}

/* [MS-XLS] 2.4.179 */
function parse_Note(blob, length, opts) {
	if(opts && (opts.biff < 8)) {
		var row = blob.read_shift(2), col = blob.read_shift(2);
		if(row == 0xFFFF || row == -1) return; // TODO: test continuation
		var cch = blob.read_shift(2);
		var cmnt = blob.read_shift(Math.min(cch,2048), 'cpstr');
		return [{r:row, c:col}, cmnt];
	}
	/* TODO: Support revisions */
	return parse_NoteSh(blob, length, opts);
}
function write_NOTE_BIFF2(text, R, C, len/*?:number*/) {
	var o = new_buf(6 + (len || text.length));
	o.write_shift(2, R);
	o.write_shift(2, C);
	o.write_shift(2, len || text.length);
	o.write_shift(text.length, text, "sbcs");
	return o;
}

/* [MS-XLS] 2.4.168 */
function parse_MergeCells(blob, length) {
	var merges = [];
	var cmcs = blob.read_shift(2);
	while (cmcs--) merges.push(parse_Ref8U(blob,length));
	return merges;
}
function write_MergeCells(merges) {
	var o = new_buf(2 + merges.length * 8);
	o.write_shift(2, merges.length);
	for(var i = 0; i < merges.length; ++i) write_Ref8U(merges[i], o);
	return o;
}

/* [MS-XLS] 2.4.181 TODO: parse all the things! */
function parse_Obj(blob, length, opts) {
	if(opts && opts.biff < 8) return parse_BIFF5Obj(blob, length, opts);
	var cmo = parse_FtCmo(blob, 22); // id, ot, flags
	var fts = parse_FtArray(blob, length-22, cmo[1]);
	return { cmo: cmo, ft:fts };
}
/* from older spec */
var parse_BIFF5OT = {
0x08: function(blob, length) {
	var tgt = blob.l + length;
	blob.l += 10; // todo
	var cf = blob.read_shift(2);
	blob.l += 4;
	blob.l += 2; //var cbPictFmla = blob.read_shift(2);
	blob.l += 2;
	blob.l += 2; //var grbit = blob.read_shift(2);
	blob.l += 4;
	var cchName = blob.read_shift(1);
	blob.l += cchName; // TODO: stName
	blob.l = tgt; // TODO: fmla
	return { fmt:cf };
}
};

function parse_BIFF5Obj(blob, length, opts) {
	blob.l += 4; //var cnt = blob.read_shift(4);
	var ot = blob.read_shift(2);
	var id = blob.read_shift(2);
	var grbit = blob.read_shift(2);
	blob.l += 2; //var colL = blob.read_shift(2);
	blob.l += 2; //var dxL = blob.read_shift(2);
	blob.l += 2; //var rwT = blob.read_shift(2);
	blob.l += 2; //var dyT = blob.read_shift(2);
	blob.l += 2; //var colR = blob.read_shift(2);
	blob.l += 2; //var dxR = blob.read_shift(2);
	blob.l += 2; //var rwB = blob.read_shift(2);
	blob.l += 2; //var dyB = blob.read_shift(2);
	blob.l += 2; //var cbMacro = blob.read_shift(2);
	blob.l += 6;
	length -= 36;
	var fts = [];
	fts.push((parse_BIFF5OT[ot]||parsenoop)(blob, length, opts));
	return { cmo: [id, ot, grbit], ft:fts };
}

/* [MS-XLS] 2.4.329 TODO: parse properly */
function parse_TxO(blob, length, opts) {
	var s = blob.l;
	var texts = "";
try {
	blob.l += 4;
	var ot = (opts.lastobj||{cmo:[0,0]}).cmo[1];
	var controlInfo; // eslint-disable-line no-unused-vars
	if([0,5,7,11,12,14].indexOf(ot) == -1) blob.l += 6;
	else controlInfo = parse_ControlInfo(blob, 6, opts); // eslint-disable-line no-unused-vars
	var cchText = blob.read_shift(2);
	/*var cbRuns = */blob.read_shift(2);
	/*var ifntEmpty = */parseuint16(blob, 2);
	var len = blob.read_shift(2);
	blob.l += len;
	//var fmla = parse_ObjFmla(blob, s + length - blob.l);

	for(var i = 1; i < blob.lens.length-1; ++i) {
		if(blob.l-s != blob.lens[i]) throw new Error("TxO: bad continue record");
		var hdr = blob[blob.l];
		var t = parse_XLUnicodeStringNoCch(blob, blob.lens[i+1]-blob.lens[i]-1);
		texts += t;
		if(texts.length >= (hdr ? cchText : 2*cchText)) break;
	}
	if(texts.length !== cchText && texts.length !== cchText*2) {
		throw new Error("cchText: " + cchText + " != " + texts.length);
	}

	blob.l = s + length;
	/* [MS-XLS] 2.5.272 TxORuns */
//	var rgTxoRuns = [];
//	for(var j = 0; j != cbRuns/8-1; ++j) blob.l += 8;
//	var cchText2 = blob.read_shift(2);
//	if(cchText2 !== cchText) throw new Error("TxOLastRun mismatch: " + cchText2 + " " + cchText);
//	blob.l += 6;
//	if(s + length != blob.l) throw new Error("TxO " + (s + length) + ", at " + blob.l);
	return { t: texts };
} catch(e) { blob.l = s + length; return { t: texts }; }
}

/* [MS-XLS] 2.4.140 */
function parse_HLink(blob, length) {
	var ref = parse_Ref8U(blob, 8);
	blob.l += 16; /* CLSID */
	var hlink = parse_Hyperlink(blob, length-24);
	return [ref, hlink];
}
function write_HLink(hl) {
	var O = new_buf(24);
	var ref = decode_cell(hl[0]);
	O.write_shift(2, ref.r); O.write_shift(2, ref.r);
	O.write_shift(2, ref.c); O.write_shift(2, ref.c);
	var clsid = "d0 c9 ea 79 f9 ba ce 11 8c 82 00 aa 00 4b a9 0b".split(" ");
	for(var i = 0; i < 16; ++i) O.write_shift(1, parseInt(clsid[i], 16));
	return bconcat([O, write_Hyperlink(hl[1])]);
}


/* [MS-XLS] 2.4.141 */
function parse_HLinkTooltip(blob, length) {
	blob.read_shift(2);
	var ref = parse_Ref8U(blob, 8);
	var wzTooltip = blob.read_shift((length-10)/2, 'dbcs-cont');
	wzTooltip = wzTooltip.replace(chr0,"");
	return [ref, wzTooltip];
}
function write_HLinkTooltip(hl) {
	var TT = hl[1].Tooltip;
	var O = new_buf(10 + 2 * (TT.length + 1));
	O.write_shift(2, 0x0800);
	var ref = decode_cell(hl[0]);
	O.write_shift(2, ref.r); O.write_shift(2, ref.r);
	O.write_shift(2, ref.c); O.write_shift(2, ref.c);
	for(var i = 0; i < TT.length; ++i) O.write_shift(2, TT.charCodeAt(i));
	O.write_shift(2, 0);
	return O;
}

/* [MS-XLS] 2.4.63 */
function parse_Country(blob) {
	var o = [0,0], d;
	d = blob.read_shift(2); o[0] = CountryEnum[d] || d;
	d = blob.read_shift(2); o[1] = CountryEnum[d] || d;
	return o;
}
function write_Country(o) {
	if(!o) o = new_buf(4);
	o.write_shift(2, 0x01);
	o.write_shift(2, 0x01);
	return o;
}

/* [MS-XLS] 2.4.50 ClrtClient */
function parse_ClrtClient(blob) {
	var ccv = blob.read_shift(2);
	var o = [];
	while(ccv-->0) o.push(parse_LongRGB(blob, 8));
	return o;
}

/* [MS-XLS] 2.4.188 */
function parse_Palette(blob) {
	var ccv = blob.read_shift(2);
	var o = [];
	while(ccv-->0) o.push(parse_LongRGB(blob, 8));
	return o;
}

/* [MS-XLS] 2.4.354 */
function parse_XFCRC(blob) {
	blob.l += 2;
	var o = {cxfs:0, crc:0};
	o.cxfs = blob.read_shift(2);
	o.crc = blob.read_shift(4);
	return o;
}

/* [MS-XLS] 2.4.53 TODO: parse flags */
/* [MS-XLSB] 2.4.323 TODO: parse flags */
function parse_ColInfo(blob, length, opts) {
	if(!opts.cellStyles) return parsenoop(blob, length);
	var w = opts && opts.biff >= 12 ? 4 : 2;
	var colFirst = blob.read_shift(w);
	var colLast = blob.read_shift(w);
	var coldx = blob.read_shift(w);
	var ixfe = blob.read_shift(w);
	var flags = blob.read_shift(2);
	if(w == 2) blob.l += 2;
	var o = ({s:colFirst, e:colLast, w:coldx, ixfe:ixfe, flags:flags});
	if(opts.biff >= 5 || !opts.biff) o.level = (flags >> 8) & 0x7;
	return o;
}
function write_ColInfo(col, idx) {
	var o = new_buf(12);
	o.write_shift(2, idx);
	o.write_shift(2, idx);
	o.write_shift(2, col.width * 256);
	o.write_shift(2, 0);
	var f = 0;
	if(col.hidden) f |= 1;
	o.write_shift(1, f);
	f = col.level || 0;
	o.write_shift(1, f);
	o.write_shift(2, 0);
	return o;
}

/* [MS-XLS] 2.4.257 */
function parse_Setup(blob, length) {
	var o = {};
	if(length < 32) return o;
	blob.l += 16;
	o.header = parse_Xnum(blob, 8);
	o.footer = parse_Xnum(blob, 8);
	blob.l += 2;
	return o;
}

/* [MS-XLS] 2.4.261 */
function parse_ShtProps(blob, length, opts) {
	var def = {area:false};
	if(opts.biff != 5) { blob.l += length; return def; }
	var d = blob.read_shift(1); blob.l += 3;
	if((d & 0x10)) def.area = true;
	return def;
}

/* [MS-XLS] 2.4.241 */
function write_RRTabId(n) {
	var out = new_buf(2 * n);
	for(var i = 0; i < n; ++i) out.write_shift(2, i+1);
	return out;
}

var parse_Blank = parse_XLSCell; /* [MS-XLS] 2.4.20 Just the cell */
var parse_Scl = parseuint16a; /* [MS-XLS] 2.4.247 num, den */
var parse_String = parse_XLUnicodeString; /* [MS-XLS] 2.4.268 */

/* --- Specific to versions before BIFF8 --- */
function parse_ImData(blob) {
	var cf = blob.read_shift(2);
	var env = blob.read_shift(2);
	var lcb = blob.read_shift(4);
	var o = {fmt:cf, env:env, len:lcb, data:blob.slice(blob.l,blob.l+lcb)};
	blob.l += lcb;
	return o;
}

function write_BIFF2Cell(out, r, c, ixfe, ifmt) {
	if(!out) out = new_buf(7);
	out.write_shift(2, r);
	out.write_shift(2, c);
	out.write_shift(1, ixfe||0/* & 0x3F */);
	out.write_shift(1, ifmt||0/* & 0x3F */);
	out.write_shift(1, 0);
	return out;
}

/* BIFF2_??? where ??? is the name from [XLS] */
function parse_BIFF2STR(blob, length, opts) {
	if(opts.biffguess && opts.biff == 5) opts.biff = 2;
	var cell = parse_XLSCell(blob, 7, opts);
	var str = parse_XLUnicodeString2(blob, length-7, opts);
	cell.t = 'str';
	cell.val = str;
	return cell;
}

function parse_BIFF2NUM(blob, length, opts) {
	var cell = parse_XLSCell(blob, 7, opts);
	var num = parse_Xnum(blob, 8);
	cell.t = 'n';
	cell.val = num;
	return cell;
}
function write_BIFF2NUM(r, c, val, ixfe, ifmt) {
	var out = new_buf(15);
	write_BIFF2Cell(out, r, c, ixfe||0, ifmt||0);
	out.write_shift(8, val, 'f');
	return out;
}

function parse_BIFF2INT(blob, length, opts) {
	var cell = parse_XLSCell(blob, 7, opts);
	var num = blob.read_shift(2);
	cell.t = 'n';
	cell.val = num;
	return cell;
}
function write_BIFF2INT(r, c, val, ixfe, ifmt) {
	var out = new_buf(9);
	write_BIFF2Cell(out, r, c, ixfe||0, ifmt||0);
	out.write_shift(2, val);
	return out;
}

function parse_BIFF2STRING(blob) {
	var cch = blob.read_shift(1);
	if(cch === 0) { blob.l++; return ""; }
	return blob.read_shift(cch, 'sbcs-cont');
}

function parse_BIFF2BOOLERR(blob, length, opts) {
	var bestart = blob.l + 7;
	var cell = parse_XLSCell(blob, 6, opts);
	blob.l = bestart;
	var val = parse_Bes(blob, 2);
	cell.val = val;
	cell.t = (val === true || val === false) ? 'b' : 'e';
	return cell;
}

/* TODO: convert to BIFF8 font struct */
function parse_BIFF2FONTXTRA(blob, length) {
	blob.l += 6; // unknown
	blob.l += 2; // font weight "bls"
	blob.l += 1; // charset
	blob.l += 3; // unknown
	blob.l += 1; // font family
	blob.l += length - 13;
}

/* TODO: parse rich text runs */
function parse_RString(blob, length, opts) {
	var end = blob.l + length;
	var cell = parse_XLSCell(blob, 6, opts);
	var cch = blob.read_shift(2);
	var str = parse_XLUnicodeStringNoCch(blob, cch, opts);
	blob.l = end;
	cell.t = 'str';
	cell.val = str;
	return cell;
}

function parse_BIFF4SheetInfo(blob) {
	var flags = blob.read_shift(4);
	var cch = blob.read_shift(1), name = blob.read_shift(cch, "sbcs");
	if(name.length === 0) name = "Sheet1";
	return { flags: flags, name:name };
}var DBF_SUPPORTED_VERSIONS = [0x02, 0x03, 0x30, 0x31, 0x83, 0x8B, 0x8C, 0xF5];
var DBF = (function() {
var dbf_codepage_map = {
	/* Code Pages Supported by Visual FoxPro */
	0x01:   437,           0x02:   850,
	0x03:  1252,           0x04: 10000,
	0x64:   852,           0x65:   866,
	0x66:   865,           0x67:   861,
	0x68:   895,           0x69:   620,
	0x6A:   737,           0x6B:   857,
	0x78:   950,           0x79:   949,
	0x7A:   936,           0x7B:   932,
	0x7C:   874,           0x7D:  1255,
	0x7E:  1256,           0x96: 10007,
	0x97: 10029,           0x98: 10006,
	0xC8:  1250,           0xC9:  1251,
	0xCA:  1254,           0xCB:  1253,

	/* shapefile DBF extension */
	0x00: 20127,           0x08:   865,
	0x09:   437,           0x0A:   850,
	0x0B:   437,           0x0D:   437,
	0x0E:   850,           0x0F:   437,
	0x10:   850,           0x11:   437,
	0x12:   850,           0x13:   932,
	0x14:   850,           0x15:   437,
	0x16:   850,           0x17:   865,
	0x18:   437,           0x19:   437,
	0x1A:   850,           0x1B:   437,
	0x1C:   863,           0x1D:   850,
	0x1F:   852,           0x22:   852,
	0x23:   852,           0x24:   860,
	0x25:   850,           0x26:   866,
	0x37:   850,           0x40:   852,
	0x4D:   936,           0x4E:   949,
	0x4F:   950,           0x50:   874,
	0x57:  1252,           0x58:  1252,
	0x59:  1252,           0x6C:   863,
	0x86:   737,           0x87:   852,
	0x88:   857,           0xCC:  1257,

	0xFF: 16969
};
var dbf_reverse_map = evert({
	0x01:   437,           0x02:   850,
	0x03:  1252,           0x04: 10000,
	0x64:   852,           0x65:   866,
	0x66:   865,           0x67:   861,
	0x68:   895,           0x69:   620,
	0x6A:   737,           0x6B:   857,
	0x78:   950,           0x79:   949,
	0x7A:   936,           0x7B:   932,
	0x7C:   874,           0x7D:  1255,
	0x7E:  1256,           0x96: 10007,
	0x97: 10029,           0x98: 10006,
	0xC8:  1250,           0xC9:  1251,
	0xCA:  1254,           0xCB:  1253,
	0x00: 20127
});
/* TODO: find an actual specification */
function dbf_to_aoa(buf, opts) {
	var out = [];
	var d = (new_raw_buf(1));
	switch(opts.type) {
		case 'base64': d = s2a(Base64_decode(buf)); break;
		case 'binary': d = s2a(buf); break;
		case 'buffer':
		case 'array': d = buf; break;
	}
	prep_blob(d, 0);

	/* header */
	var ft = d.read_shift(1);
	var memo = !!(ft & 0x88);
	var vfp = false, l7 = false;
	switch(ft) {
		case 0x02: break; // dBASE II
		case 0x03: break; // dBASE III
		case 0x30: vfp = true; memo = true; break; // VFP
		case 0x31: vfp = true; memo = true; break; // VFP with autoincrement
		// 0x43 dBASE IV SQL table files
		// 0x63 dBASE IV SQL system files
		case 0x83: break; // dBASE III with memo
		case 0x8B: break; // dBASE IV with memo
		case 0x8C: l7 = true; break; // dBASE Level 7 with memo
		// case 0xCB dBASE IV SQL table files with memo
		case 0xF5: break; // FoxPro 2.x with memo
		// case 0xFB FoxBASE
		default: throw new Error("DBF Unsupported Version: " + ft.toString(16));
	}

	var nrow = 0, fpos = 0x0209;
	if(ft == 0x02) nrow = d.read_shift(2);
	d.l += 3; // dBASE II stores DDMMYY date, others use YYMMDD
	if(ft != 0x02) nrow = d.read_shift(4);
	if(nrow > 1048576) nrow = 1e6;

	if(ft != 0x02) fpos = d.read_shift(2); // header length
	var rlen = d.read_shift(2); // record length

	var /*flags = 0,*/ current_cp = opts.codepage || 1252;
	if(ft != 0x02) { // 20 reserved bytes
		d.l+=16;
		/*flags = */d.read_shift(1);
		//if(memo && ((flags & 0x02) === 0)) throw new Error("DBF Flags " + flags.toString(16) + " ft " + ft.toString(16));

		/* codepage present in FoxPro and dBASE Level 7 */
		if(d[d.l] !== 0) current_cp = dbf_codepage_map[d[d.l]];
		d.l+=1;

		d.l+=2;
	}
	if(l7) d.l += 36; // Level 7: 32 byte "Language driver name", 4 byte reserved

var fields = [], field = ({});
	var hend = Math.min(d.length, (ft == 0x02 ? 0x209 : (fpos - 10 - (vfp ? 264 : 0))));
	var ww = l7 ? 32 : 11;
	while(d.l < hend && d[d.l] != 0x0d) {
		field = ({});
		field.name = (typeof $cptable !== "undefined" ? $cptable.utils.decode(current_cp, d.slice(d.l, d.l+ww)) : a2s(d.slice(d.l, d.l + ww))).replace(/[\u0000\r\n][\S\s]*$/g,"");
		d.l += ww;
		field.type = String.fromCharCode(d.read_shift(1));
		if(ft != 0x02 && !l7) field.offset = d.read_shift(4);
		field.len = d.read_shift(1);
		if(ft == 0x02) field.offset = d.read_shift(2);
		field.dec = d.read_shift(1);
		if(field.name.length) fields.push(field);
		if(ft != 0x02) d.l += l7 ? 13 : 14;
		switch(field.type) {
			case 'B': // Double (VFP) / Binary (dBASE L7)
				if((!vfp || field.len != 8) && opts.WTF) console.log('Skipping ' + field.name + ':' + field.type);
				break;
			case 'G': // General (FoxPro and dBASE L7)
			case 'P': // Picture (FoxPro and dBASE L7)
				if(opts.WTF) console.log('Skipping ' + field.name + ':' + field.type);
				break;
			case '+': // Autoincrement (dBASE L7 only)
			case '0': // _NullFlags (VFP only)
			case '@': // Timestamp (dBASE L7 only)
			case 'C': // Character (dBASE II)
			case 'D': // Date (dBASE III)
			case 'F': // Float (dBASE IV)
			case 'I': // Long (VFP and dBASE L7)
			case 'L': // Logical (dBASE II)
			case 'M': // Memo (dBASE III)
			case 'N': // Number (dBASE II)
			case 'O': // Double (dBASE L7 only)
			case 'T': // Datetime (VFP only)
			case 'Y': // Currency (VFP only)
				break;
			default: throw new Error('Unknown Field Type: ' + field.type);
		}
	}

	if(d[d.l] !== 0x0D) d.l = fpos-1;
	if(d.read_shift(1) !== 0x0D) throw new Error("DBF Terminator not found " + d.l + " " + d[d.l]);
	d.l = fpos;

	/* data */
	var R = 0, C = 0;
	out[0] = [];
	for(C = 0; C != fields.length; ++C) out[0][C] = fields[C].name;
	while(nrow-- > 0) {
		if(d[d.l] === 0x2A) {
			// TODO: record marked as deleted -- create a hidden row?
			d.l+=rlen;
			continue;
		}
		++d.l;
		out[++R] = []; C = 0;
		for(C = 0; C != fields.length; ++C) {
			var dd = d.slice(d.l, d.l+fields[C].len); d.l+=fields[C].len;
			prep_blob(dd, 0);
			var s = typeof $cptable !== "undefined" ? $cptable.utils.decode(current_cp, dd) : a2s(dd);
			switch(fields[C].type) {
				case 'C':
					// NOTE: it is conventional to write '  /  /  ' for empty dates
					if(s.trim().length) out[R][C] = s.replace(/([^\s])\s+$/,"$1");
					break;
				case 'D':
					if(s.length === 8) {
						out[R][C] = new Date(Date.UTC(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8), 0, 0, 0, 0));
						if(!(opts && opts.UTC)) { out[R][C] = utc_to_local(out[R][C]); }
					}
					else out[R][C] = s;
					break;
				case 'F': out[R][C] = parseFloat(s.trim()); break;
				case '+': case 'I': out[R][C] = l7 ? dd.read_shift(-4, 'i') ^ 0x80000000 : dd.read_shift(4, 'i'); break;
				case 'L': switch(s.trim().toUpperCase()) {
					case 'Y': case 'T': out[R][C] = true; break;
					case 'N': case 'F': out[R][C] = false; break;
					case '': case '\x00': case '?': break;
					default: throw new Error("DBF Unrecognized L:|" + s + "|");
					} break;
				case 'M': /* TODO: handle memo files */
					if(!memo) throw new Error("DBF Unexpected MEMO for type " + ft.toString(16));
					out[R][C] = "##MEMO##" + (l7 ? parseInt(s.trim(), 10): dd.read_shift(4));
					break;
				case 'N':
					s = s.replace(/\u0000/g,"").trim();
					// NOTE: dBASE II interprets "  .  " as 0
					if(s && s != ".") out[R][C] = +s || 0; break;
				case '@':
					// NOTE: dBASE specs appear to be incorrect
					out[R][C] = new Date(dd.read_shift(-8, 'f') - 0x388317533400);
					break;
				case 'T': {
					var hi = dd.read_shift(4), lo = dd.read_shift(4);
					if(hi == 0 && lo == 0) break;
					out[R][C] = new Date((hi - 0x253D8C) * 0x5265C00 + lo);
					if(!(opts && opts.UTC)) out[R][C] = utc_to_local(out[R][C]);
				} break;
				case 'Y': out[R][C] = dd.read_shift(4,'i')/1e4 + (dd.read_shift(4, 'i')/1e4)*Math.pow(2,32); break;
				case 'O': out[R][C] = -dd.read_shift(-8, 'f'); break;
				case 'B': if(vfp && fields[C].len == 8) { out[R][C] = dd.read_shift(8,'f'); break; }
					/* falls through */
				case 'G': case 'P': dd.l += fields[C].len; break;
				case '0':
					if(fields[C].name === '_NullFlags') break;
					/* falls through */
				default: throw new Error("DBF Unsupported data type " + fields[C].type);
			}
		}
	}
	if(ft != 0x02) if(d.l < d.length && d[d.l++] != 0x1A) throw new Error("DBF EOF Marker missing " + (d.l-1) + " of " + d.length + " " + d[d.l-1].toString(16));
	if(opts && opts.sheetRows) out = out.slice(0, opts.sheetRows);
	opts.DBF = fields;
	return out;
}

function dbf_to_sheet(buf, opts) {
	var o = opts || {};
	if(!o.dateNF) o.dateNF = "yyyymmdd";
	var ws = aoa_to_sheet(dbf_to_aoa(buf, o), o);
	ws["!cols"] = o.DBF.map(function(field) { return {
		wch: field.len,
		DBF: field
	};});
	delete o.DBF;
	return ws;
}

function dbf_to_workbook(buf, opts) {
	try {
		var o = sheet_to_workbook(dbf_to_sheet(buf, opts), opts);
		o.bookType = "dbf";
		return o;
	} catch(e) { if(opts && opts.WTF) throw e; }
	return ({SheetNames:[],Sheets:{}});
}

var _RLEN = { 'B': 8, 'C': 250, 'L': 1, 'D': 8, '?': 0, '': 0 };
function sheet_to_dbf(ws, opts) {
	if(!ws["!ref"]) throw new Error("Cannot export empty sheet to DBF");
	var o = opts || {};
	var old_cp = current_codepage;
	if(+o.codepage >= 0) set_cp(+o.codepage);
	if(o.type == "string") throw new Error("Cannot write DBF to JS string");
	var ba = buf_array();
	var aoa = sheet_to_json(ws, {header:1, raw:true, cellDates:true});
	var headers = aoa[0], data = aoa.slice(1), cols = ws["!cols"] || [];
	var i = 0, j = 0, hcnt = 0, rlen = 1;
	for(i = 0; i < headers.length; ++i) {
		if(((cols[i]||{}).DBF||{}).name) { headers[i] = cols[i].DBF.name; ++hcnt; continue; }
		if(headers[i] == null) continue;
		++hcnt;
		if(typeof headers[i] === 'number') headers[i] = headers[i].toString(10);
		if(typeof headers[i] !== 'string') throw new Error("DBF Invalid column name " + headers[i] + " |" + (typeof headers[i]) + "|");
		if(headers.indexOf(headers[i]) !== i) for(j=0; j<1024;++j)
			if(headers.indexOf(headers[i] + "_" + j) == -1) { headers[i] += "_" + j; break; }
	}
	var range = safe_decode_range(ws['!ref']);
	var coltypes = [];
	var colwidths = [];
	var coldecimals = [];
	for(i = 0; i <= range.e.c - range.s.c; ++i) {
		var guess = '', _guess = '', maxlen = 0;
		var col = [];
		for(j=0; j < data.length; ++j) {
			if(data[j][i] != null) col.push(data[j][i]);
		}
		if(col.length == 0 || headers[i] == null) { coltypes[i] = '?'; continue; }
		for(j = 0; j < col.length; ++j) {
			switch(typeof col[j]) {
				/* TODO: check if L2 compat is desired */
				case 'number': _guess = 'B'; break;
				case 'string': _guess = 'C'; break;
				case 'boolean': _guess = 'L'; break;
				case 'object': _guess = col[j] instanceof Date ? 'D' : 'C'; break;
				default: _guess = 'C';
			}
			/* TODO: cache the values instead of encoding twice */
			maxlen = Math.max(maxlen, (typeof $cptable !== "undefined" && typeof col[j] == "string" ? $cptable.utils.encode(current_ansi, col[j]): String(col[j])).length);
			guess = guess && guess != _guess ? 'C' : _guess;
			//if(guess == 'C') break;
		}
		if(maxlen > 250) maxlen = 250;
		_guess = ((cols[i]||{}).DBF||{}).type;
		/* TODO: more fine grained control over DBF type resolution */
		if(_guess == 'C') {
			if(cols[i].DBF.len > maxlen) maxlen = cols[i].DBF.len;
		}
		if(guess == 'B' && _guess == 'N') {
			guess = 'N';
			coldecimals[i] = cols[i].DBF.dec;
			maxlen = cols[i].DBF.len;
		}
		colwidths[i] = guess == 'C' || _guess == 'N' ? maxlen : (_RLEN[guess] || 0);
		rlen += colwidths[i];
		coltypes[i] = guess;
	}

	var h = ba.next(32);
	h.write_shift(4, 0x13021130);
	h.write_shift(4, data.length);
	h.write_shift(2, 296 + 32 * hcnt);
	h.write_shift(2, rlen);
	for(i=0; i < 4; ++i) h.write_shift(4, 0);
	var cp = +dbf_reverse_map[current_codepage] || 0x03;
	h.write_shift(4, 0x00000000 | (cp<<8));
	if(dbf_codepage_map[cp] != +o.codepage) {
		if(o.codepage) console.error("DBF Unsupported codepage " + current_codepage + ", using 1252");
		current_codepage = 1252;
	}

	for(i = 0, j = 0; i < headers.length; ++i) {
		if(headers[i] == null) continue;
		var hf = ba.next(32);
		/* TODO: test how applications handle non-ASCII field names */
		var _f = (headers[i].slice(-10) + "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00").slice(0, 11);
		hf.write_shift(1, _f, "sbcs");
		hf.write_shift(1, coltypes[i] == '?' ? 'C' : coltypes[i], "sbcs");
		hf.write_shift(4, j);
		hf.write_shift(1, colwidths[i] || _RLEN[coltypes[i]] || 0);
		hf.write_shift(1, coldecimals[i] || 0);
		hf.write_shift(1, 0x02);
		hf.write_shift(4, 0);
		hf.write_shift(1, 0);
		hf.write_shift(4, 0);
		hf.write_shift(4, 0);
		j += (colwidths[i] || _RLEN[coltypes[i]] || 0);
	}

	var hb = ba.next(264);
	hb.write_shift(4, 0x0000000D);
	for(i=0; i < 65;++i) hb.write_shift(4, 0x00000000);
	for(i=0; i < data.length; ++i) {
		var rout = ba.next(rlen);
		rout.write_shift(1, 0);
		for(j=0; j<headers.length; ++j) {
			if(headers[j] == null) continue;
			switch(coltypes[j]) {
				case 'L': rout.write_shift(1, data[i][j] == null ? 0x3F : data[i][j] ? 0x54 : 0x46); break;
				case 'B': rout.write_shift(8, data[i][j]||0, 'f'); break;
				case 'N':
					var _n = "0";
					if(typeof data[i][j] == "number") _n = data[i][j].toFixed(coldecimals[j]||0);
					if(_n.length > colwidths[j]) _n = _n.slice(0, colwidths[j]); // addresses decimal > width
					for(hcnt=0; hcnt < colwidths[j]-_n.length; ++hcnt) rout.write_shift(1, 0x20);
					rout.write_shift(1, _n, "sbcs");
					break;
				case 'D':
					if(!data[i][j]) rout.write_shift(8, "00000000", "sbcs");
					else {
						rout.write_shift(4, ("0000"+data[i][j].getFullYear()).slice(-4), "sbcs");
						rout.write_shift(2, ("00"+(data[i][j].getMonth()+1)).slice(-2), "sbcs");
						rout.write_shift(2, ("00"+data[i][j].getDate()).slice(-2), "sbcs");
					} break;
				case 'C':
					var _l = rout.l;
					var _s = String(data[i][j] != null ? data[i][j] : "").slice(0, colwidths[j]);
					rout.write_shift(1, _s, "cpstr");
					_l += colwidths[j] - rout.l;
					for(hcnt=0; hcnt < _l; ++hcnt) rout.write_shift(1, 0x20); break;
			}
		}
		// data
	}
	current_codepage = old_cp;
	ba.next(1).write_shift(1, 0x1A);
	return ba.end();
}
	return {
		to_workbook: dbf_to_workbook,
		to_sheet: dbf_to_sheet,
		from_sheet: sheet_to_dbf
	};
})();

var SYLK = (function() {
	/* TODO: stress test sequences */
	var sylk_escapes = ({
		AA:'À', BA:'Á', CA:'Â', DA:195, HA:'Ä', JA:197,
		AE:'È', BE:'É', CE:'Ê',         HE:'Ë',
		AI:'Ì', BI:'Í', CI:'Î',         HI:'Ï',
		AO:'Ò', BO:'Ó', CO:'Ô', DO:213, HO:'Ö',
		AU:'Ù', BU:'Ú', CU:'Û',         HU:'Ü',
		Aa:'à', Ba:'á', Ca:'â', Da:227, Ha:'ä', Ja:229,
		Ae:'è', Be:'é', Ce:'ê',         He:'ë',
		Ai:'ì', Bi:'í', Ci:'î',         Hi:'ï',
		Ao:'ò', Bo:'ó', Co:'ô', Do:245, Ho:'ö',
		Au:'ù', Bu:'ú', Cu:'û',         Hu:'ü',
		KC:'Ç', Kc:'ç', q:'æ',  z:'œ',  a:'Æ',  j:'Œ',
		DN:209, Dn:241, Hy:255,
		S:169,  c:170,  R:174,  "B ":180,
		0:176,  1:177,  2:178,
		3:179,  5:181,  6:182,
		7:183,  Q:185,  k:186,  b:208,  i:216,  l:222,  s:240,  y:248,
		"!":161, '"':162, "#":163, "(":164, "%":165, "'":167, "H ":168,
		"+":171, ";":187, "<":188, "=":189, ">":190, "?":191, "{":223
	});
	var sylk_char_regex = new RegExp("\u001BN(" + keys(sylk_escapes).join("|").replace(/\|\|\|/, "|\\||").replace(/([?()+])/g,"\\$1").replace("{", "\\{") + "|\\|)", "gm");
	try {
		sylk_char_regex = new RegExp("\u001BN(" + keys(sylk_escapes).join("|").replace(/\|\|\|/, "|\\||").replace(/([?()+])/g,"\\$1") + "|\\|)", "gm");
	} catch(e) {}
	var sylk_char_fn = function(_, $1){ var o = sylk_escapes[$1]; return typeof o == "number" ? _getansi(o) : o; };
	var decode_sylk_char = function($$, $1, $2) { var newcc = (($1.charCodeAt(0) - 0x20)<<4) | ($2.charCodeAt(0) - 0x30); return newcc == 59 ? $$ : _getansi(newcc); };
	sylk_escapes["|"] = 254;
	/* TODO: evert the escape map */
	var encode_sylk_str = function($$) { return $$.replace(/\n/g, "\x1b :").replace(/\r/g, "\x1b ="); };
	/* https://oss.sheetjs.com/notes/sylk/ for more details */
	function sylk_to_aoa(d, opts) {
		switch(opts.type) {
			case 'base64': return sylk_to_aoa_str(Base64_decode(d), opts);
			case 'binary': return sylk_to_aoa_str(d, opts);
			case 'buffer': return sylk_to_aoa_str(has_buf && Buffer.isBuffer(d) ? d.toString('binary') : a2s(d), opts);
			case 'array': return sylk_to_aoa_str(cc2str(d), opts);
		}
		throw new Error("Unrecognized type " + opts.type);
	}
	function sylk_to_aoa_str(str, opts) {
		var records = str.split(/[\n\r]+/), R = -1, C = -1, ri = 0, rj = 0, arr = [];
		var formats = [];
		var next_cell_format = null;
		var sht = {}, rowinfo = [], colinfo = [], cw = [];
		var Mval = 0, j;
		var wb = { Workbook: { WBProps: {}, Names: [] } };
		if(+opts.codepage >= 0) set_cp(+opts.codepage);
		for (; ri !== records.length; ++ri) {
			Mval = 0;
			var rstr=records[ri].trim().replace(/\x1B([\x20-\x2F])([\x30-\x3F])/g, decode_sylk_char).replace(sylk_char_regex, sylk_char_fn);
			var record=rstr.replace(/;;/g, "\u0000").split(";").map(function(x) { return x.replace(/\u0000/g, ";"); });
			var RT=record[0], val;
			if(rstr.length > 0) switch(RT) {
			case 'ID': break; /* header */
			case 'E': break; /* EOF */
			case 'B': break; /* dimensions */
			case 'O': /* workbook options */
			for(rj=1; rj<record.length; ++rj) switch(record[rj].charAt(0)) {
				case 'V': {
					var d1904 = parseInt(record[rj].slice(1), 10);
					// NOTE: it is technically an error if d1904 >= 5 or < 0
					if(d1904 >= 1 && d1904 <= 4) wb.Workbook.WBProps.date1904 = true;
				} break;
			} break;
			case 'W': break; /* window */
			case 'P':
				switch(record[1].charAt(0)){
					case 'P': formats.push(rstr.slice(3).replace(/;;/g, ";")); break;
				} break;
			case 'NN': { /* defined name */
				var nn = {Sheet: 0};
				for(rj=1; rj<record.length; ++rj) switch(record[rj].charAt(0)) {
					case 'N': nn.Name = record[rj].slice(1); break;
					case 'E': nn.Ref = (opts && opts.sheet || "Sheet1") + "!" + rc_to_a1(record[rj].slice(1)); break;
				}
				wb.Workbook.Names.push(nn);
			} break;
			// case 'NE': // ??
			// case 'NU': // ??
			case 'C': /* cell */
			var C_seen_K = false, C_seen_X = false, C_seen_S = false, C_seen_E = false, _R = -1, _C = -1, formula = "", cell_t = "z";
			var cmnt = "";
			for(rj=1; rj<record.length; ++rj) switch(record[rj].charAt(0)) {
				case 'A': cmnt = record[rj].slice(1); break; // TODO: comment
				case 'X': C = parseInt(record[rj].slice(1), 10)-1; C_seen_X = true; break;
				case 'Y':
					R = parseInt(record[rj].slice(1), 10)-1; if(!C_seen_X) C = 0;
					for(j = arr.length; j <= R; ++j) arr[j] = [];
					break;
				case 'K':
					val = record[rj].slice(1);
					if(val.charAt(0) === '"') { val = val.slice(1,val.length - 1); cell_t = "s"; }
					else if(val === 'TRUE' || val === 'FALSE') { val = val === 'TRUE'; cell_t = "b"; }
					else if(val.charAt(0) == "#" && RBErr[val] != null) { cell_t = "e"; val = RBErr[val]; }
					else if(!isNaN(fuzzynum(val))) {
						val = fuzzynum(val); cell_t = "n";
						if(next_cell_format !== null && fmt_is_date(next_cell_format) && opts.cellDates) {
							val = numdate(wb.Workbook.WBProps.date1904 ? val + 1462 : val); cell_t = typeof val == "number" ? "n" : "d";
						}
					}
					if(typeof $cptable !== 'undefined' && typeof val == "string" && ((opts||{}).type != "string") && (opts||{}).codepage) val = $cptable.utils.decode(opts.codepage, val);
					C_seen_K = true;
					break;
				case 'E':
					C_seen_E = true;
					formula = rc_to_a1(record[rj].slice(1), {r:R,c:C});
					break;
				case 'S':
					C_seen_S = true;
					break;
				case 'G': break; // unknown
				case 'R': _R = parseInt(record[rj].slice(1), 10)-1; break;
				case 'C': _C = parseInt(record[rj].slice(1), 10)-1; break;
				// case 'P': // ??
				// case 'D': // ??
				default: if(opts && opts.WTF) throw new Error("SYLK bad record " + rstr);
			}
			if(C_seen_K) {
				if(!arr[R][C]) arr[R][C] = { t: cell_t, v: val };
				else { arr[R][C].t = cell_t; arr[R][C].v = val; }
				if(next_cell_format) arr[R][C].z = next_cell_format;
				if(opts.cellText !== false && next_cell_format) arr[R][C].w = SSF_format(arr[R][C].z, arr[R][C].v, { date1904: wb.Workbook.WBProps.date1904 });
				next_cell_format = null;
			}
			if(C_seen_S) {
				if(C_seen_E) throw new Error("SYLK shared formula cannot have own formula");
				var shrbase = _R > -1 && arr[_R][_C];
				if(!shrbase || !shrbase[1]) throw new Error("SYLK shared formula cannot find base");
				formula = shift_formula_str(shrbase[1], {r: R - _R, c: C - _C});
			}
			if(formula) {
				if(!arr[R][C]) arr[R][C] = { t: 'n', f: formula };
				else arr[R][C].f = formula;
			}
			if(cmnt) {
				if(!arr[R][C]) arr[R][C] = { t: 'z' };
				arr[R][C].c = [{a:"SheetJSYLK", t: cmnt}];
			}
			break;
			case 'F': /* Format */
			var F_seen = 0;
			for(rj=1; rj<record.length; ++rj) switch(record[rj].charAt(0)) {
				case 'X': C = parseInt(record[rj].slice(1), 10)-1; ++F_seen; break;
				case 'Y':
					R = parseInt(record[rj].slice(1), 10)-1; /*C = 0;*/
					for(j = arr.length; j <= R; ++j) arr[j] = [];
					break;
				case 'M': Mval = parseInt(record[rj].slice(1), 10) / 20; break;
				case 'F': break; /* ??? */
				case 'G': break; /* hide grid */
				case 'P':
					next_cell_format = formats[parseInt(record[rj].slice(1), 10)];
					break;
				case 'S': break; /* cell style */
				case 'D': break; /* column */
				case 'N': break; /* font */
				case 'W':
					cw = record[rj].slice(1).split(" ");
					for(j = parseInt(cw[0], 10); j <= parseInt(cw[1], 10); ++j) {
						Mval = parseInt(cw[2], 10);
						colinfo[j-1] = Mval === 0 ? {hidden:true}: {wch:Mval};
					} break;
				case 'C': /* default column format */
					C = parseInt(record[rj].slice(1), 10)-1;
					if(!colinfo[C]) colinfo[C] = {};
					break;
				case 'R': /* row properties */
					R = parseInt(record[rj].slice(1), 10)-1;
					if(!rowinfo[R]) rowinfo[R] = {};
					if(Mval > 0) { rowinfo[R].hpt = Mval; rowinfo[R].hpx = pt2px(Mval); }
					else if(Mval === 0) rowinfo[R].hidden = true;
					break;
				// case 'K': // ??
				// case 'E': // ??
				default: if(opts && opts.WTF) throw new Error("SYLK bad record " + rstr);
			}
			if(F_seen < 1) next_cell_format = null; break;
			default: if(opts && opts.WTF) throw new Error("SYLK bad record " + rstr);
			}
		}
		if(rowinfo.length > 0) sht['!rows'] = rowinfo;
		if(colinfo.length > 0) sht['!cols'] = colinfo;
		colinfo.forEach(function(col) { process_col(col); });
		if(opts && opts.sheetRows) arr = arr.slice(0, opts.sheetRows);
		return [arr, sht, wb];
	}

	function sylk_to_workbook(d, opts) {
		var aoasht = sylk_to_aoa(d, opts);
		var aoa = aoasht[0], ws = aoasht[1], wb = aoasht[2];
		var _opts = dup(opts); _opts.date1904 = (((wb||{}).Workbook || {}).WBProps || {}).date1904;
		var o = aoa_to_sheet(aoa, _opts);
		keys(ws).forEach(function(k) { o[k] = ws[k]; });
		var outwb = sheet_to_workbook(o, opts);
		keys(wb).forEach(function(k) { outwb[k] = wb[k]; });
		outwb.bookType = "sylk";
		return outwb;
	}

	function write_ws_cell_sylk(cell, ws, R, C, opts, date1904) {
		var o = "C;Y" + (R+1) + ";X" + (C+1) + ";K";
		switch(cell.t) {
			case 'n':
				o += isFinite(cell.v) ? (cell.v||0) : BErr[isNaN(cell.v) ? 0x24 : 0x07];
				if(cell.f && !cell.F) o += ";E" + a1_to_rc(cell.f, {r:R, c:C}); break;
			case 'b': o += cell.v ? "TRUE" : "FALSE"; break;
			case 'e': o += cell.w || BErr[cell.v] || cell.v; break;
			case 'd': o += datenum(parseDate(cell.v, date1904), date1904); break;
			case 's': o += '"' + (cell.v == null ? "" : String(cell.v)).replace(/"/g,"").replace(/;/g, ";;") + '"'; break;
		}
		return o;
	}

	function write_ws_cmnt_sylk(cmnt, R, C) {
		var o = "C;Y" + (R+1) + ";X" + (C+1) + ";A";
		/* TODO: max length? */
		o += encode_sylk_str(cmnt.map(function(c) { return c.t; }).join(""));
		return o;
	}

	function write_ws_cols_sylk(out, cols) {
		cols.forEach(function(col, i) {
			var rec = "F;W" + (i+1) + " " + (i+1) + " ";
			if(col.hidden) rec += "0";
			else {
				if(typeof col.width == 'number' && !col.wpx) col.wpx = width2px(col.width);
				if(typeof col.wpx == 'number' && !col.wch) col.wch = px2char(col.wpx);
				if(typeof col.wch == 'number') rec += Math.round(col.wch);
			}
			if(rec.charAt(rec.length - 1) != " ") out.push(rec);
		});
	}

	function write_ws_rows_sylk(out, rows) {
		rows.forEach(function(row, i) {
			var rec = "F;";
			if(row.hidden) rec += "M0;";
			else if(row.hpt) rec += "M" + 20 * row.hpt + ";";
			else if(row.hpx) rec += "M" + 20 * px2pt(row.hpx) + ";";
			if(rec.length > 2) out.push(rec + "R" + (i+1));
		});
	}

	function sheet_to_sylk(ws, opts, wb) {
		if(!opts) opts = {}; opts._formats = ["General"];
		/* TODO: codepage */
		var preamble = ["ID;PSheetJS;N;E"], o = [];
		var r = safe_decode_range(ws['!ref']||"A1"), cell;
		var dense = ws["!data"] != null;
		var RS = "\r\n";
		var d1904 = (((wb||{}).Workbook||{}).WBProps||{}).date1904;

		var _lastfmt = "General";
		preamble.push("P;PGeneral");
		/* Excel has been inconsistent in comment placement */
		var R = r.s.r, C = r.s.c, p = [];
		if(ws["!ref"]) for(R = r.s.r; R <= r.e.r; ++R) {
			if(dense && !ws["!data"][R]) continue;
			p = [];
			for(C = r.s.c; C <= r.e.c; ++C) {
				cell = dense ? ws["!data"][R][C] : ws[encode_col(C) + encode_row(R)];
				if(!cell || !cell.c) continue;
				p.push(write_ws_cmnt_sylk(cell.c, R, C));
			}
			if(p.length) o.push(p.join(RS));
		}
		if(ws["!ref"]) for(R = r.s.r; R <= r.e.r; ++R) {
			if(dense && !ws["!data"][R]) continue;
			p = [];
			for(C = r.s.c; C <= r.e.c; ++C) {
				cell = dense ? ws["!data"][R][C] : ws[encode_col(C) + encode_row(R)];
				if(!cell || (cell.v == null && (!cell.f || cell.F))) continue;
				if((cell.z||(cell.t == "d" ? table_fmt[14] : "General")) != _lastfmt) {
					var ifmt = opts._formats.indexOf(cell.z);
					if(ifmt == -1) { opts._formats.push(cell.z); ifmt = opts._formats.length - 1; preamble.push("P;P" + cell.z.replace(/;/g, ";;")); }
					p.push("F;P" + ifmt + ";Y" + (R+1) + ";X" + (C+1));
				}
				p.push(write_ws_cell_sylk(cell, ws, R, C, opts, d1904));
			}
			o.push(p.join(RS));
		}

		preamble.push("F;P0;DG0G8;M255");
		if(ws['!cols']) write_ws_cols_sylk(preamble, ws['!cols']);
		if(ws['!rows']) write_ws_rows_sylk(preamble, ws['!rows']);

		if(ws["!ref"]) preamble.push("B;Y" + (r.e.r - r.s.r + 1) + ";X" + (r.e.c - r.s.c + 1) + ";D" + [r.s.c,r.s.r,r.e.c,r.e.r].join(" "));
		preamble.push("O;L;D;B" + (d1904 ? ";V4" : "") + ";K47;G100 0.001");

		delete opts._formats;
		return preamble.join(RS) + RS + o.join(RS) + RS + "E" + RS;
	}

	return {
		to_workbook: sylk_to_workbook,
		from_sheet: sheet_to_sylk
	};
})();

var DIF = (function() {
	function dif_to_aoa(d, opts) {
		switch(opts.type) {
			case 'base64': return dif_to_aoa_str(Base64_decode(d), opts);
			case 'binary': return dif_to_aoa_str(d, opts);
			case 'buffer': return dif_to_aoa_str(has_buf && Buffer.isBuffer(d) ? d.toString('binary') : a2s(d), opts);
			case 'array': return dif_to_aoa_str(cc2str(d), opts);
		}
		throw new Error("Unrecognized type " + opts.type);
	}
	function dif_to_aoa_str(str, opts) {
		var records = str.split('\n'), R = -1, C = -1, ri = 0, arr = [];
		for (; ri !== records.length; ++ri) {
			if (records[ri].trim() === 'BOT') { arr[++R] = []; C = 0; continue; }
			if (R < 0) continue;
			var metadata = records[ri].trim().split(",");
			var type = metadata[0], value = metadata[1];
			++ri;
			var data = records[ri] || "";
			while(((data.match(/["]/g)||[]).length & 1) && ri < records.length - 1) data += "\n" + records[++ri];
			data = data.trim();
			switch (+type) {
				case -1:
					if (data === 'BOT') { arr[++R] = []; C = 0; continue; }
					else if (data !== 'EOD') throw new Error("Unrecognized DIF special command " + data);
					break;
				case 0:
					if(data === 'TRUE') arr[R][C] = true;
					else if(data === 'FALSE') arr[R][C] = false;
					else if(!isNaN(fuzzynum(value))) arr[R][C] = fuzzynum(value);
					else if(!isNaN(fuzzydate(value).getDate())) {
						arr[R][C] = parseDate(value);
						if(!(opts && opts.UTC)) { arr[R][C] = utc_to_local(arr[R][C]); }
					}
					else arr[R][C] = value;
					++C; break;
				case 1:
					data = data.slice(1,data.length-1);
					data = data.replace(/""/g, '"');
					if(DIF_XL && data && data.match(/^=".*"$/)) data = data.slice(2, -1);
					arr[R][C++] = data !== '' ? data : null;
					break;
			}
			if (data === 'EOD') break;
		}
		if(opts && opts.sheetRows) arr = arr.slice(0, opts.sheetRows);
		return arr;
	}

	function dif_to_sheet(str, opts) { return aoa_to_sheet(dif_to_aoa(str, opts), opts); }
	function dif_to_workbook(str, opts) {
		var o = sheet_to_workbook(dif_to_sheet(str, opts), opts);
		o.bookType = "dif";
		return o;
	}

	function make_value(v, s) { return "0," + String(v) + "\r\n" + s; }
	function make_value_str(s) { return "1,0\r\n\"" + s.replace(/"/g,'""') + '"'; }
	function sheet_to_dif(ws) {
		var _DIF_XL = DIF_XL;
		if(!ws["!ref"]) throw new Error("Cannot export empty sheet to DIF");
		var r = safe_decode_range(ws['!ref']);
		var dense = ws["!data"] != null;
		var o = [
			"TABLE\r\n0,1\r\n\"sheetjs\"\r\n",
			"VECTORS\r\n0," + (r.e.r - r.s.r + 1) + "\r\n\"\"\r\n",
			"TUPLES\r\n0," + (r.e.c - r.s.c + 1) + "\r\n\"\"\r\n",
			"DATA\r\n0,0\r\n\"\"\r\n"
		];
		for(var R = r.s.r; R <= r.e.r; ++R) {
			var row = dense ? ws["!data"][R] : [];
			var p = "-1,0\r\nBOT\r\n";
			for(var C = r.s.c; C <= r.e.c; ++C) {
				var cell = dense ? (row && row[C]) : ws[encode_cell({r:R,c:C})];
				if(cell == null) { p +=("1,0\r\n\"\"\r\n"); continue;}
				switch(cell.t) {
					case 'n':
						if(_DIF_XL) {
							if(cell.w != null) p +=("0," + cell.w + "\r\nV");
							else if(cell.v != null) p +=(make_value(cell.v, "V")); // TODO: should this call SSF_format?
							else if(cell.f != null && !cell.F) p +=(make_value_str("=" + cell.f));
							else p +=("1,0\r\n\"\"");
						} else {
							if(cell.v == null) p +=("1,0\r\n\"\"");
							else p +=(make_value(cell.v, "V"));
						}
						break;
					case 'b':
						p +=(cell.v ? make_value(1, "TRUE") : make_value(0, "FALSE"));
						break;
					case 's':
						p +=(make_value_str((!_DIF_XL || isNaN(+cell.v)) ? cell.v : '="' + cell.v + '"'));
						break;
					case 'd':
						if(!cell.w) cell.w = SSF_format(cell.z || table_fmt[14], datenum(parseDate(cell.v)));
						if(_DIF_XL) p +=(make_value(cell.w, "V"));
						else p +=(make_value_str(cell.w));
						break;
					default: p +=("1,0\r\n\"\"");
				}
				p += "\r\n";
			}
			o.push(p);
		}
		return o.join("") + "-1,0\r\nEOD";
	}
	return {
		to_workbook: dif_to_workbook,
		to_sheet: dif_to_sheet,
		from_sheet: sheet_to_dif
	};
})();

var ETH = (function() {
	function decode(s) { return s.replace(/\\b/g,"\\").replace(/\\c/g,":").replace(/\\n/g,"\n"); }
	function encode(s) { return s.replace(/\\/g, "\\b").replace(/:/g, "\\c").replace(/\n/g,"\\n"); }

	function eth_to_aoa(str, opts) {
		var records = str.split('\n'), R = -1, C = -1, ri = 0, arr = [];
		for (; ri !== records.length; ++ri) {
			var record = records[ri].trim().split(":");
			if(record[0] !== 'cell') continue;
			var addr = decode_cell(record[1]);
			if(arr.length <= addr.r) for(R = arr.length; R <= addr.r; ++R) if(!arr[R]) arr[R] = [];
			R = addr.r; C = addr.c;
			switch(record[2]) {
				case 't': arr[R][C] = decode(record[3]); break;
				case 'v': arr[R][C] = +record[3]; break;
				case 'vtf': var _f = record[record.length - 1];
					/* falls through */
				case 'vtc':
					switch(record[3]) {
						case 'nl': arr[R][C] = +record[4] ? true : false; break;
						default: arr[R][C] = record[record.length-1].charAt(0) == "#" ? ({t: "e", v: RBErr[record[record.length-1]] }) : +record[4]; break;
					}
					if(record[2] == 'vtf') arr[R][C] = [arr[R][C], _f];
			}
		}
		if(opts && opts.sheetRows) arr = arr.slice(0, opts.sheetRows);
		return arr;
	}

	function eth_to_sheet(d, opts) { return aoa_to_sheet(eth_to_aoa(d, opts), opts); }
	function eth_to_workbook(d, opts) { return sheet_to_workbook(eth_to_sheet(d, opts), opts); }

	var header = [
		"socialcalc:version:1.5",
		"MIME-Version: 1.0",
		"Content-Type: multipart/mixed; boundary=SocialCalcSpreadsheetControlSave"
	].join("\n");

	var sep = [
		"--SocialCalcSpreadsheetControlSave",
		"Content-type: text/plain; charset=UTF-8"
	].join("\n") + "\n";

	/* TODO: the other parts */
	var meta = [
		"# SocialCalc Spreadsheet Control Save",
		"part:sheet"
	].join("\n");

	var end = "--SocialCalcSpreadsheetControlSave--";

	function sheet_to_eth_data(ws) {
		if(!ws || !ws['!ref']) return "";
		var o = [], oo = [], cell, coord = "";
		var r = decode_range(ws['!ref']);
		var dense = ws["!data"] != null;
		for(var R = r.s.r; R <= r.e.r; ++R) {
			for(var C = r.s.c; C <= r.e.c; ++C) {
				coord = encode_cell({r:R,c:C});
				cell = dense ? (ws["!data"][R]||[])[C] : ws[coord];
				if(!cell || cell.v == null || cell.t === 'z') continue;
				oo = ["cell", coord, 't'];
				switch(cell.t) {
					case 's': oo.push(encode(cell.v)); break;
					case 'b':
						oo[2] = 'vt'+(cell.f?'f':'c'); oo[3]='nl'; oo[4]=cell.v?"1":"0";
						oo[5] = encode(cell.f||(cell.v?'TRUE':'FALSE'));
						break;
					case 'd':
						var t = datenum(parseDate(cell.v));
						oo[2] = 'vtc'; oo[3] = 'nd'; oo[4] = ""+t;
						oo[5] = cell.w || SSF_format(cell.z || table_fmt[14], t);
						break;
					case 'n':
						if(isFinite(cell.v)) {
							if(!cell.f) { oo[2]='v'; oo[3]=cell.v; }
							else { oo[2]='vtf'; oo[3]='n'; oo[4]=cell.v; oo[5]=encode(cell.f); }
						} else {
							oo[2] = 'vt' + (cell.f ? 'f' : 'c');
							oo[3] = "e" + BErr[isNaN(cell.v) ? 0x24 : 0x07];
							oo[4] = "0";
							oo[5] = cell.f || oo[3].slice(1);
							oo[6] = "e";
							oo[7] = oo[3].slice(1);
						}
						break;
					case 'e': continue;
				}
				o.push(oo.join(":"));
			}
		}
		o.push("sheet:c:" + (r.e.c-r.s.c+1) + ":r:" + (r.e.r-r.s.r+1) + ":tvf:1");
		o.push("valueformat:1:text-wiki");
		//o.push("copiedfrom:" + ws['!ref']); // clipboard only
		return o.join("\n");
	}

	function sheet_to_eth(ws) {
		return [header, sep, meta, sep, sheet_to_eth_data(ws), end].join("\n");
		// return ["version:1.5", sheet_to_eth_data(ws)].join("\n"); // clipboard form
	}

	return {
		to_workbook: eth_to_workbook,
		to_sheet: eth_to_sheet,
		from_sheet: sheet_to_eth
	};
})();

var PRN = (function() {
	function set_text_arr(data, arr, R, C, o) {
		if(o.raw) arr[R][C] = data;
		else if(data === ""){/* empty */}
		else if(data === 'TRUE') arr[R][C] = true;
		else if(data === 'FALSE') arr[R][C] = false;
		else if(!isNaN(fuzzynum(data))) arr[R][C] = fuzzynum(data);
		else if(!isNaN(fuzzydate(data).getDate())) arr[R][C] = parseDate(data);
		else if(data.charCodeAt(0) == 35 /* # */ && RBErr[data] != null) arr[R][C] = ({ t: 'e', v: RBErr[data], w: data });
		else arr[R][C] = data;
	}

	function prn_to_aoa_str(f, opts) {
		var o = opts || {};
		var arr = ([]);
		if(!f || f.length === 0) return arr;
		var lines = f.split(/[\r\n]/);
		var L = lines.length - 1;
		while(L >= 0 && lines[L].length === 0) --L;
		var start = 10, idx = 0;
		var R = 0;
		for(; R <= L; ++R) {
			idx = lines[R].indexOf(" ");
			if(idx == -1) idx = lines[R].length; else idx++;
			start = Math.max(start, idx);
		}
		for(R = 0; R <= L; ++R) {
			arr[R] = [];
			/* TODO: confirm that widths are always 10 */
			var C = 0;
			set_text_arr(lines[R].slice(0, start).trim(), arr, R, C, o);
			for(C = 1; C <= (lines[R].length - start)/10 + 1; ++C)
				set_text_arr(lines[R].slice(start+(C-1)*10,start+C*10).trim(),arr,R,C,o);
		}
		if(o.sheetRows) arr = arr.slice(0, o.sheetRows);
		return arr;
	}

	// List of accepted CSV separators
	var guess_seps = {
		0x2C: ',',
		0x09: "\t",
		0x3B: ';',
		0x7C: '|'
	};

	// CSV separator weights to be used in case of equal numbers
	var guess_sep_weights = {
		0x2C: 3,
		0x09: 2,
		0x3B: 1,
		0x7C: 0
	};

	function guess_sep(str) {
		var cnt = {}, instr = false, end = 0, cc = 0;
		for(;end < str.length;++end) {
			if((cc=str.charCodeAt(end)) == 0x22) instr = !instr;
			else if(!instr && cc in guess_seps) cnt[cc] = (cnt[cc]||0)+1;
		}

		cc = [];
		for(end in cnt) if ( Object.prototype.hasOwnProperty.call(cnt, end) ) {
			cc.push([ cnt[end], end ]);
		}

		if ( !cc.length ) {
			cnt = guess_sep_weights;
			for(end in cnt) if ( Object.prototype.hasOwnProperty.call(cnt, end) ) {
				cc.push([ cnt[end], end ]);
			}
		}

		cc.sort(function(a, b) { return a[0] - b[0] || guess_sep_weights[a[1]] - guess_sep_weights[b[1]]; });

		return guess_seps[cc.pop()[1]] || 0x2C;
	}

	function dsv_to_sheet_str(str, opts) {
		var o = opts || {};
		var sep = "";
		if(DENSE != null && o.dense == null) o.dense = DENSE;
		var ws = ({});
		if(o.dense) ws["!data"] = [];
		var range = ({s: {c:0, r:0}, e: {c:0, r:0}});

		if(str.slice(0,4) == "sep=") {
			// If the line ends in \r\n
			if(str.charCodeAt(5) == 13 && str.charCodeAt(6) == 10 ) {
				sep = str.charAt(4); str = str.slice(7);
			}
			// If line ends in \r OR \n
			else if(str.charCodeAt(5) == 13 || str.charCodeAt(5) == 10 ) {
				sep = str.charAt(4); str = str.slice(6);
			}
			else sep = guess_sep(str.slice(0,1024));
		}
		else if(o && o.FS) sep = o.FS;
		else sep = guess_sep(str.slice(0,1024));
		var R = 0, C = 0, v = 0;
		var start = 0, end = 0, sepcc = sep.charCodeAt(0), instr = false, cc=0, startcc=str.charCodeAt(0);
		var _re = o.dateNF != null ? dateNF_regex(o.dateNF) : null;
		function finish_cell() {
			/* TODO: fuzzy parsers should pass back assumed number format */
			var s = str.slice(start, end); if(s.slice(-1) == "\r") s = s.slice(0, -1);
			var cell = ({});
			if(s.charAt(0) == '"' && s.charAt(s.length - 1) == '"') s = s.slice(1,-1).replace(/""/g,'"');
			if(o.cellText !== false) cell.w = s;
			if(s.length === 0) cell.t = 'z';
			else if(o.raw) { cell.t = 's'; cell.v = s; }
			else if(s.trim().length === 0) { cell.t = 's'; cell.v = s; }
			else if(s.charCodeAt(0) == 0x3D) {
				if(s.charCodeAt(1) == 0x22 && s.charCodeAt(s.length - 1) == 0x22) { cell.t = 's'; cell.v = s.slice(2,-1).replace(/""/g,'"'); }
				else if(fuzzyfmla(s)) { cell.t = 's'; cell.f = s.slice(1); cell.v = s; }
				else { cell.t = 's'; cell.v = s; } }
			else if(s == "TRUE") { cell.t = 'b'; cell.v = true; }
			else if(s == "FALSE") { cell.t = 'b'; cell.v = false; }
			else if(!isNaN(v = fuzzynum(s))) { cell.t = 'n'; cell.v = v; }
			else if(!isNaN((v = fuzzydate(s)).getDate()) || _re && s.match(_re)) {
				cell.z = o.dateNF || table_fmt[14];
				if(_re && s.match(_re)){ var news=dateNF_fix(s, o.dateNF, (s.match(_re)||[])); v = parseDate(news); if(o && o.UTC === false) v = utc_to_local(v); }
				else if(o && o.UTC === false) v = utc_to_local(v);
				else if(o.cellText !== false && o.dateNF) cell.w = SSF_format(cell.z, v);
				if(o.cellDates) { cell.t = 'd'; cell.v = v; }
				else { cell.t = 'n'; cell.v = datenum(v); }
				if(!o.cellNF) delete cell.z;
			} else if(s.charCodeAt(0) == 35 /* # */ && RBErr[s] != null) {
				cell.t = 'e'; cell.w = s; cell.v = RBErr[s];
			} else {
				cell.t = 's';
				cell.v = s;
			}
			if(cell.t == 'z'){}
			else if(o.dense) { if(!ws["!data"][R]) ws["!data"][R] = []; ws["!data"][R][C] = cell; }
			else ws[encode_cell({c:C,r:R})] = cell;
			start = end+1; startcc = str.charCodeAt(start);
			if(range.e.c < C) range.e.c = C;
			if(range.e.r < R) range.e.r = R;
			if(cc == sepcc) ++C; else { C = 0; ++R; if(o.sheetRows && o.sheetRows <= R) return true; }
		}
		outer: for(;end < str.length;++end) switch((cc=str.charCodeAt(end))) {
			case 0x22: if(startcc === 0x22) instr = !instr; break;
			case 0x0d:
				if(instr) break;
				if(str.charCodeAt(end+1) == 0x0a) ++end;
				/* falls through */
			case sepcc: case 0x0a: if(!instr && finish_cell()) break outer; break;
			default: break;
		}
		if(end - start > 0) finish_cell();

		ws['!ref'] = encode_range(range);
		return ws;
	}

	function prn_to_sheet_str(str, opts) {
		if(!(opts && opts.PRN)) return dsv_to_sheet_str(str, opts);
		if(opts.FS) return dsv_to_sheet_str(str, opts);
		if(str.slice(0,4) == "sep=") return dsv_to_sheet_str(str, opts);
		if(str.indexOf("\t") >= 0 || str.indexOf(",") >= 0 || str.indexOf(";") >= 0) return dsv_to_sheet_str(str, opts);
		return aoa_to_sheet(prn_to_aoa_str(str, opts), opts);
	}

	function prn_to_sheet(d, opts) {
		var str = "", bytes = opts.type == 'string' ? [0,0,0,0] : firstbyte(d, opts);
		switch(opts.type) {
			case 'base64': str = Base64_decode(d); break;
			case 'binary': str = d; break;
			case 'buffer':
				if(opts.codepage == 65001) str = d.toString('utf8'); // TODO: test if buf
				else if(opts.codepage && typeof $cptable !== 'undefined') str = $cptable.utils.decode(opts.codepage, d);
				else str = has_buf && Buffer.isBuffer(d) ? d.toString('binary') : a2s(d);
				break;
			case 'array': str = cc2str(d); break;
			case 'string': str = d; break;
			default: throw new Error("Unrecognized type " + opts.type);
		}
		if(bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) str = utf8read(str.slice(3));
		else if(opts.type != 'string' && opts.type != 'buffer' && opts.codepage == 65001) str = utf8read(str);
		else if((opts.type == 'binary') && typeof $cptable !== 'undefined' && opts.codepage)  str = $cptable.utils.decode(opts.codepage, $cptable.utils.encode(28591,str));
		if(str.slice(0,19) == "socialcalc:version:") return ETH.to_sheet(opts.type == 'string' ? str : utf8read(str), opts);
		return prn_to_sheet_str(str, opts);
	}

	function prn_to_workbook(d, opts) { return sheet_to_workbook(prn_to_sheet(d, opts), opts); }

	function sheet_to_prn(ws) {
		var o = [];
		if(!ws["!ref"]) return "";
		var r = safe_decode_range(ws['!ref']), cell;
		var dense = ws["!data"] != null;
		for(var R = r.s.r; R <= r.e.r; ++R) {
			var oo = [];
			for(var C = r.s.c; C <= r.e.c; ++C) {
				var coord = encode_cell({r:R,c:C});
				cell = dense ? (ws["!data"][R]||[])[C] : ws[coord];
				if(!cell || cell.v == null) { oo.push("          "); continue; }
				var w = (cell.w || (format_cell(cell), cell.w) || "").slice(0,10);
				while(w.length < 10) w += " ";
				oo.push(w + (C === 0 ? " " : ""));
			}
			o.push(oo.join(""));
		}
		return o.join("\n");
	}

	return {
		to_workbook: prn_to_workbook,
		to_sheet: prn_to_sheet,
		from_sheet: sheet_to_prn
	};
})();

/* Excel defaults to SYLK but warns if data is not valid */
function read_wb_ID(d, opts) {
	var o = opts || {}, OLD_WTF = !!o.WTF; o.WTF = true;
	try {
		var out = SYLK.to_workbook(d, o);
		o.WTF = OLD_WTF;
		return out;
	} catch(e) {
		o.WTF = OLD_WTF;
		if((e.message.indexOf("SYLK bad record ID") == -1) && OLD_WTF) throw e;
		return PRN.to_workbook(d, opts);
	}
}

var WK_ = (function() {
	function lotushopper(data, cb, opts) {
		if(!data) return;
		prep_blob(data, data.l || 0);
		var Enum = opts.Enum || WK1Enum;
		while(data.l < data.length) {
			var RT = data.read_shift(2);
			var R = Enum[RT] || Enum[0xFFFF];
			var length = data.read_shift(2);
			var tgt = data.l + length;
			var d = R.f && R.f(data, length, opts);
			data.l = tgt;
			if(cb(d, R, RT)) return;
		}
	}

	function lotus_to_workbook(d, opts) {
		switch(opts.type) {
			case 'base64': return lotus_to_workbook_buf(s2a(Base64_decode(d)), opts);
			case 'binary': return lotus_to_workbook_buf(s2a(d), opts);
			case 'buffer':
			case 'array': return lotus_to_workbook_buf(d, opts);
		}
		throw "Unsupported type " + opts.type;
	}

	/* NOTE: this list intentionally starts at 1 */
	var LOTUS_DATE_FMTS = [
		"mmmm",
		"dd-mmm-yyyy",
		"dd-mmm",
		"mmm-yyyy",
		"@", // "text"?
		"mm/dd",
		"hh:mm:ss AM/PM", // 7
		"hh:mm AM/PM",
		"mm/dd/yyyy",
		"mm/dd",
		"hh:mm:ss",
		"hh:mm" // 12
	];

	function lotus_to_workbook_buf(d, opts) {
		if(!d) return d;
		var o = opts || {};
		if(DENSE != null && o.dense == null) o.dense = DENSE;
		var s = ({}), n = "Sheet1", next_n = "", sidx = 0;
		var sheets = {}, snames = [], realnames = [], sdata = [];
		if(o.dense) sdata = s["!data"] = [];

		var refguess = {s: {r:0, c:0}, e: {r:0, c:0} };
		var sheetRows = o.sheetRows || 0;
		var lastcell = {};

		if(d[4] == 0x51 && d[5] == 0x50 && d[6] == 0x57) return qpw_to_workbook_buf(d, opts);
		if(d[2] == 0x00) {
			if(d[3] == 0x08 || d[3] == 0x09) {
				if(d.length >= 16 && d[14] == 0x05 && d[15] === 0x6c) throw new Error("Unsupported Works 3 for Mac file");
			}
		}

		if(d[2] == 0x02) {
			o.Enum = WK1Enum;
			lotushopper(d, function(val, R, RT) { switch(RT) {
				case 0x00: /* BOF */
					o.vers = val;
					if(val >= 0x1000) o.qpro = true;
					break;
				case 0xFF: /* BOF (works 3+) */
					o.vers = val;
					o.works = true;
					break;
				case 0x06: refguess = val; break; /* RANGE */
				case 0xCC: if(val) next_n = val; break; /* SHEETNAMECS */
				case 0xDE: next_n = val; break; /* SHEETNAMELP */
				case 0x0F: /* LABEL */
				case 0x33: /* STRING */
					if((!o.qpro && !o.works || RT == 0x33) && val[1].v.charCodeAt(0) < 0x30) val[1].v = val[1].v.slice(1);
					if(o.works || o.works2) val[1].v = val[1].v.replace(/\r\n/g, "\n");
					/* falls through */
				case 0x0D: /* INTEGER */
				case 0x0E: /* NUMBER */
				case 0x10: /* FORMULA */
					/* TODO: actual translation of the format code */
					if((val[2] & 0x70) == 0x70 && (val[2] & 0x0F) > 1 && (val[2] & 0x0F) < 15) {
						val[1].z = o.dateNF || LOTUS_DATE_FMTS[(val[2] & 0x0F)-1] || table_fmt[14];
						if(o.cellDates) { val[1].v = numdate(val[1].v); val[1].t = typeof val[1].v == "number" ? 'n' : 'd'; }
					}

					if(o.qpro) {
						if(val[3] > sidx) {
							s["!ref"] = encode_range(refguess);
							sheets[n] = s;
							snames.push(n);
							s = ({}); if(o.dense) sdata = s["!data"] = [];
							refguess = {s: {r:0, c:0}, e: {r:0, c:0} };
							sidx = val[3]; n = next_n || "Sheet" + (sidx + 1); next_n = "";
						}
					}

					var tmpcell = o.dense ? (sdata[val[0].r]||[])[val[0].c] : s[encode_cell(val[0])];
					if(tmpcell) {
						tmpcell.t = val[1].t; tmpcell.v = val[1].v;
						if(val[1].z != null) tmpcell.z = val[1].z;
						if(val[1].f != null) tmpcell.f = val[1].f;
						lastcell = tmpcell;
						break;
					}
					if(o.dense) {
						if(!sdata[val[0].r]) sdata[val[0].r] = [];
						sdata[val[0].r][val[0].c] = val[1];
					} else s[encode_cell(val[0])] = val[1];
					lastcell = val[1];
					break;
				case 0x5405: o.works2 = true; break;
				case 0x5402: {
					/* TODO: enumerate all extended number formats */
					if(val == 0x14a1) {
						lastcell.z = "hh:mm:ss";
						if(o.cellDates && lastcell.t == "n") {
							lastcell.v = numdate(lastcell.v); lastcell.t = typeof lastcell.v == "number" ? 'n' : 'd';
						}
					}
				} break;
			}}, o);
		} else if(d[2] == 0x1A || d[2] == 0x0E) {
			o.Enum = WK3Enum;
			if(d[2] == 0x0E) { o.qpro = true; d.l = 0; }
			lotushopper(d, function(val, R, RT) { switch(RT) {
				case 0xCC: n = val; break; /* SHEETNAMECS */
				case 0x16: /* LABEL16 */
					if(val[1].v.charCodeAt(0) < 0x30) val[1].v = val[1].v.slice(1);
					// TODO: R9 appears to encode control codes this way -- verify against other versions
					val[1].v = val[1].v.replace(/\x0F./g, function($$) { return String.fromCharCode($$.charCodeAt(1) - 0x20); }).replace(/\r\n/g, "\n");
					/* falls through */
				case 0x17: /* NUMBER17 */
				case 0x18: /* NUMBER18 */
				case 0x19: /* FORMULA19 */
				case 0x25: /* NUMBER25 */
				case 0x27: /* NUMBER27 */
				case 0x28: /* FORMULA28 */
					if(val[3] > sidx) {
						s["!ref"] = encode_range(refguess);
						sheets[n] = s;
						snames.push(n);
						s = ({}); if(o.dense) sdata = s["!data"] = [];
						refguess = {s: {r:0, c:0}, e: {r:0, c:0} };
						sidx = val[3]; n = "Sheet" + (sidx + 1);
					}
					if(sheetRows > 0 && val[0].r >= sheetRows) break;
					if(o.dense) {
						if(!sdata[val[0].r]) sdata[val[0].r] = [];
						sdata[val[0].r][val[0].c] = val[1];
					} else s[encode_cell(val[0])] = val[1];
					if(refguess.e.c < val[0].c) refguess.e.c = val[0].c;
					if(refguess.e.r < val[0].r) refguess.e.r = val[0].r;
					break;
				case 0x1B: /* XFORMAT */
					if(val[0x36b0]) realnames[val[0x36b0][0]] = val[0x36b0][1];
					break;
				case 0x0601: /* SHEETINFOQP */
					realnames[val[0]] = val[1]; if(val[0] == sidx) n = val[1]; break;
				default: break;
			}}, o);
		} else throw new Error("Unrecognized LOTUS BOF " + d[2]);
		s["!ref"] = encode_range(refguess);
		sheets[next_n || n] = s;
		snames.push(next_n || n);
		if(!realnames.length) return { SheetNames: snames, Sheets: sheets };
		var osheets = {}, rnames = [];
		/* TODO: verify no collisions */
		for(var i = 0; i < realnames.length; ++i) if(sheets[snames[i]]) {
			rnames.push(realnames[i] || snames[i]);
			osheets[realnames[i]] = sheets[realnames[i]] || sheets[snames[i]];
		} else {
			rnames.push(realnames[i]);
			osheets[realnames[i]] = ({ "!ref": "A1" });
		}
		return { SheetNames: rnames, Sheets: osheets };
	}

	function sheet_to_wk1(ws, opts) {
		var o = opts || {};
		if(+o.codepage >= 0) set_cp(+o.codepage);
		if(o.type == "string") throw new Error("Cannot write WK1 to JS string");
		var ba = buf_array();
		if(!ws["!ref"]) throw new Error("Cannot export empty sheet to WK1");
		var range = safe_decode_range(ws["!ref"]);
		var dense = ws["!data"] != null;
		var cols = [];

		write_biff_rec(ba, 0x00, write_BOF_WK1(0x0406));
		write_biff_rec(ba, 0x06, write_RANGE(range));
		var max_R = Math.min(range.e.r, 8191);
		for(var C = range.s.c; C <= range.e.c; ++C) cols[C] = encode_col(C);
		for(var R = range.s.r; R <= max_R; ++R) {
			var rr = encode_row(R);
			for(C = range.s.c; C <= range.e.c; ++C) {
				var cell = dense ? (ws["!data"][R]||[])[C] : ws[cols[C] + rr];
				if(!cell || cell.t == "z") continue;
				/* TODO: formula records */
				switch(cell.t) {
				case "n":
					if((cell.v|0)==cell.v && cell.v >= -32768 && cell.v <= 32767) write_biff_rec(ba, 0x0d, write_INTEGER(R, C, cell));
					else write_biff_rec(ba, 0x0e, write_NUMBER(R, C, cell));
					break;
				case "d":
					var dc = datenum(cell.v);
					if((dc|0)==dc && dc >= -32768 && dc <= 32767) write_biff_rec(ba, 0x0d, write_INTEGER(R, C, {t:"n", v:dc, z:cell.z || table_fmt[14]}));
					else write_biff_rec(ba, 0x0e, write_NUMBER(R, C, {t:"n", v:dc, z:cell.z || table_fmt[14]}));
					break;
				default:
					var str = format_cell(cell);
					write_biff_rec(ba, 0x0F, write_LABEL(R, C, str.slice(0, 239)));
				}
			}
		}

		write_biff_rec(ba, 0x01);
		return ba.end();
	}

	function book_to_wk3(wb, opts) {
		var o = opts || {};
		if(+o.codepage >= 0) set_cp(+o.codepage);
		if(o.type == "string") throw new Error("Cannot write WK3 to JS string");
		var ba = buf_array();

		write_biff_rec(ba, 0x00, write_BOF_WK3(wb));

		for(var i = 0, cnt = 0; i < wb.SheetNames.length; ++i) if((wb.Sheets[wb.SheetNames[i]] || {})["!ref"]) write_biff_rec(ba, 0x1b, write_XFORMAT_SHEETNAME(wb.SheetNames[i], cnt++));

		var wsidx = 0;
		for(i = 0; i < wb.SheetNames.length; ++i) {
			var ws = wb.Sheets[wb.SheetNames[i]];
			if(!ws || !ws["!ref"]) continue;
			var range = safe_decode_range(ws["!ref"]);
			var dense = ws["!data"] != null;
			var cols = [];
			var max_R = Math.min(range.e.r, 8191);
			for(var R = range.s.r; R <= max_R; ++R) {
				var rr = encode_row(R);
				for(var C = range.s.c; C <= range.e.c; ++C) {
					if(R === range.s.r) cols[C] = encode_col(C);
					var ref = cols[C] + rr;
					var cell = dense ? (ws["!data"][R]||[])[C] : ws[ref];
					if(!cell || cell.t == "z") continue;
					/* TODO: FORMULA19 NUMBER18 records */
					if(cell.t == "n") {
						write_biff_rec(ba, 0x17, write_NUMBER_17(R, C, wsidx, cell.v));
					} else {
						var str = format_cell(cell);
						/* TODO: max len? */
						write_biff_rec(ba, 0x16, write_LABEL_16(R, C, wsidx, str.slice(0, 239)));
					}
				}
			}
			++wsidx;
		}

		write_biff_rec(ba, 0x01);
		return ba.end();
	}


	function write_BOF_WK1(v) {
		var out = new_buf(2);
		out.write_shift(2, v);
		return out;
	}

	function write_BOF_WK3(wb) {
		var out = new_buf(26);
		out.write_shift(2, 0x1000);
		out.write_shift(2, 0x0004);
		out.write_shift(4, 0x0000);
		var rows = 0, cols = 0, wscnt = 0;
		for(var i = 0; i < wb.SheetNames.length; ++i) {
			var name = wb.SheetNames[i];
			var ws = wb.Sheets[name];
			if(!ws || !ws["!ref"]) continue;
			++wscnt;
			var range = decode_range(ws["!ref"]);
			if(rows < range.e.r) rows = range.e.r;
			if(cols < range.e.c) cols = range.e.c;
		}
		if(rows > 8191) rows = 8191;
		out.write_shift(2, rows);
		out.write_shift(1, wscnt);
		out.write_shift(1, cols);
		out.write_shift(2, 0x00);
		out.write_shift(2, 0x00);
		out.write_shift(1, 0x01);
		out.write_shift(1, 0x02);
		out.write_shift(4, 0);
		out.write_shift(4, 0);
		return out;
	}

	function parse_RANGE(blob, length, opts) {
		var o = {s:{c:0,r:0},e:{c:0,r:0}};
		if(length == 8 && opts.qpro) {
			o.s.c = blob.read_shift(1);
			blob.l++;
			o.s.r = blob.read_shift(2);
			o.e.c = blob.read_shift(1);
			blob.l++;
			o.e.r = blob.read_shift(2);
			return o;
		}
		o.s.c = blob.read_shift(2);
		o.s.r = blob.read_shift(2);
		if(length == 12 && opts.qpro) blob.l += 2;
		o.e.c = blob.read_shift(2);
		o.e.r = blob.read_shift(2);
		if(length == 12 && opts.qpro) blob.l += 2;
		if(o.s.c == 0xFFFF) o.s.c = o.e.c = o.s.r = o.e.r = 0;
		return o;
	}
	function write_RANGE(range) {
		var out = new_buf(8);
		out.write_shift(2, range.s.c);
		out.write_shift(2, range.s.r);
		out.write_shift(2, range.e.c);
		out.write_shift(2, range.e.r);
		return out;
	}

	function parse_cell(blob, length, opts) {
		var o = [{c:0,r:0}, {t:'n',v:0}, 0, 0];
		if(opts.qpro && opts.vers != 0x5120) {
			o[0].c = blob.read_shift(1);
			o[3] = blob.read_shift(1);
			o[0].r = blob.read_shift(2);
			blob.l+=2;
		} else if(opts.works) { // TODO: verify with more complex works3-4 examples
			o[0].c = blob.read_shift(2); o[0].r = blob.read_shift(2);
			o[2] = blob.read_shift(2);
		} else {
			o[2] = blob.read_shift(1);
			o[0].c = blob.read_shift(2); o[0].r = blob.read_shift(2);
		}
		return o;
	}

	function get_wk1_fmt(cell) {
		/* TODO: some fuzzy matching on the number format */
		if(cell.z && fmt_is_date(cell.z)) {
			return 0xf0 | (LOTUS_DATE_FMTS.indexOf(cell.z) + 1 || 2);
		}
		return 0xFF;
	}
	function parse_LABEL(blob, length, opts) {
		var tgt = blob.l + length;
		var o = parse_cell(blob, length, opts);
		o[1].t = 's';
		if((opts.vers & 0xFFFE) == 0x5120) { // WQ1 / WQ2
			blob.l++;
			var len = blob.read_shift(1);
			o[1].v = blob.read_shift(len, 'utf8');
			return o;
		}
		if(opts.qpro) blob.l++;
		o[1].v = blob.read_shift(tgt - blob.l, 'cstr');
		return o;
	}
	function write_LABEL(R, C, s) {
		/* TODO: encoding */
		var o = new_buf(7 + s.length);
		o.write_shift(1, 0xFF);
		o.write_shift(2, C);
		o.write_shift(2, R);
		o.write_shift(1, 0x27); // ??
		for(var i = 0; i < o.length; ++i) {
			var cc = s.charCodeAt(i);
			o.write_shift(1, cc >= 0x80 ? 0x5F : cc);
		}
		o.write_shift(1, 0);
		return o;
	}
	function parse_STRING(blob, length, opts) {
		var tgt = blob.l + length;
		var o = parse_cell(blob, length, opts);
		o[1].t = 's';
		if(opts.vers == 0x5120) {
			var len = blob.read_shift(1);
			o[1].v = blob.read_shift(len, 'utf8');
			return o;
		}
		o[1].v = blob.read_shift(tgt - blob.l, 'cstr');
		return o;
	}

	function parse_INTEGER(blob, length, opts) {
		var o = parse_cell(blob, length, opts);
		o[1].v = blob.read_shift(2, 'i');
		return o;
	}
	function write_INTEGER(R, C, cell) {
		var o = new_buf(7);
		o.write_shift(1, get_wk1_fmt(cell));
		o.write_shift(2, C);
		o.write_shift(2, R);
		o.write_shift(2, cell.v, 'i');
		return o;
	}

	function parse_NUMBER(blob, length, opts) {
		var o = parse_cell(blob, length, opts);
		o[1].v = blob.read_shift(8, 'f');
		return o;
	}
	function write_NUMBER(R, C, cell) {
		var o = new_buf(13);
		o.write_shift(1, get_wk1_fmt(cell));
		o.write_shift(2, C);
		o.write_shift(2, R);
		o.write_shift(8, cell.v, 'f');
		return o;
	}

	function parse_FORMULA(blob, length, opts) {
		var tgt = blob.l + length;
		var o = parse_cell(blob, length, opts);
		/* TODO: formula */
		o[1].v = blob.read_shift(8, 'f');
		if(opts.qpro) blob.l = tgt;
		else {
			var flen = blob.read_shift(2);
			wk1_fmla_to_csf(blob.slice(blob.l, blob.l + flen), o);
			blob.l += flen;
		}
		return o;
	}

	function wk1_parse_rc(B, V, col) {
		var rel = V & 0x8000;
		V &= ~0x8000;
		V = (rel ? B : 0) + ((V >= 0x2000) ? V - 0x4000 : V);
		return (rel ? "" : "$") + (col ? encode_col(V) : encode_row(V));
	}
	/* var oprec = [
		8, 8, 8, 8, 8, 8, 8, 8, 6, 4, 4, 5, 5, 7, 3, 3,
		3, 3, 3, 3, 1, 1, 2, 6, 8, 8, 8, 8, 8, 8, 8, 8
	]; */
	/* TODO: flesh out */
	var FuncTab = {
		0x1F: ["NA", 0],
		// 0x20: ["ERR", 0],
		0x21: ["ABS", 1],
		0x22: ["TRUNC", 1],
		0x23: ["SQRT", 1],
		0x24: ["LOG", 1],
		0x25: ["LN", 1],
		0x26: ["PI", 0],
		0x27: ["SIN", 1],
		0x28: ["COS", 1],
		0x29: ["TAN", 1],
		0x2A: ["ATAN2", 2],
		0x2B: ["ATAN", 1],
		0x2C: ["ASIN", 1],
		0x2D: ["ACOS", 1],
		0x2E: ["EXP", 1],
		0x2F: ["MOD", 2],
		// 0x30
		0x31: ["ISNA", 1],
		0x32: ["ISERR", 1],
		0x33: ["FALSE", 0],
		0x34: ["TRUE", 0],
		0x35: ["RAND", 0],
		0x36: ["DATE", 3],
		// 0x37 NOW
		// 0x38 PMT
		// 0x39 PV
		// 0x3A FV
		// 0x3B IF
		// 0x3C DAY
		// 0x3D MONTH
		// 0x3E YEAR
		0x3F: ["ROUND", 2],
		0x40: ["TIME", 3],
		// 0x41 HOUR
		// 0x42 MINUTE
		// 0x43 SECOND
		0x44: ["ISNUMBER", 1],
		0x45: ["ISTEXT", 1],
		0x46: ["LEN", 1],
		0x47: ["VALUE", 1],
		// 0x48: ["FIXED", ?? 1],
		0x49: ["MID", 3],
		0x4A: ["CHAR", 1],
		// 0x4B
		// 0x4C FIND
		// 0x4D DATEVALUE
		// 0x4E TIMEVALUE
		// 0x4F CELL
		0x50: ["SUM", 69],
		0x51: ["AVERAGEA", 69],
		0x52: ["COUNTA", 69],
		0x53: ["MINA", 69],
		0x54: ["MAXA", 69],
		// 0x55 VLOOKUP
		// 0x56 NPV
		// 0x57 VAR
		// 0x58 STD
		// 0x59 IRR
		// 0x5A HLOOKUP
		// 0x5B DSUM
		// 0x5C DAVERAGE
		// 0x5D DCOUNTA
		// 0x5E DMIN
		// 0x5F DMAX
		// 0x60 DVARP
		// 0x61 DSTDEVP
		// 0x62 INDEX
		// 0x63 COLS
		// 0x64 ROWS
		// 0x65 REPEAT
		0x66: ["UPPER", 1],
		0x67: ["LOWER", 1],
		// 0x68 LEFT
		// 0x69 RIGHT
		// 0x6A REPLACE
		0x6B: ["PROPER", 1],
		// 0x6C CELL
		0x6D: ["TRIM", 1],
		// 0x6E CLEAN
		0x6F: ["T", 1]
		// 0x70 V
	};
	var BinOpTab = [
		  "",   "",   "",   "",   "",   "",   "",   "", // eslint-disable-line no-mixed-spaces-and-tabs
		  "",  "+",  "-",  "*",  "/",  "^",  "=", "<>", // eslint-disable-line no-mixed-spaces-and-tabs
		"<=", ">=",  "<",  ">",   "",   "",   "",   "", // eslint-disable-line no-mixed-spaces-and-tabs
		 "&",   "",   "",   "",   "",   "",   "",   ""  // eslint-disable-line no-mixed-spaces-and-tabs
	];

	function wk1_fmla_to_csf(blob, o) {
		prep_blob(blob, 0);
		var out = [], argc = 0, R = "", C = "", argL = "", argR = "";
		while(blob.l < blob.length) {
			var cc = blob[blob.l++];
			switch(cc) {
				case 0x00: out.push(blob.read_shift(8, 'f')); break;
				case 0x01: {
					C = wk1_parse_rc(o[0].c, blob.read_shift(2), true);
					R = wk1_parse_rc(o[0].r, blob.read_shift(2), false);
					out.push(C + R);
				} break;
				case 0x02: {
					var c = wk1_parse_rc(o[0].c, blob.read_shift(2), true);
					var r = wk1_parse_rc(o[0].r, blob.read_shift(2), false);
					C = wk1_parse_rc(o[0].c, blob.read_shift(2), true);
					R = wk1_parse_rc(o[0].r, blob.read_shift(2), false);
					out.push(c + r + ":" + C + R);
				} break;
				case 0x03:
					if(blob.l < blob.length) { console.error("WK1 premature formula end"); return; }
					break;
				case 0x04: out.push("(" + out.pop() + ")"); break;
				case 0x05: out.push(blob.read_shift(2)); break;
				case 0x06: {
					/* TODO: text encoding */
					var Z = ""; while((cc = blob[blob.l++])) Z += String.fromCharCode(cc);
					out.push('"' + Z.replace(/"/g, '""') + '"');
				} break;

				case 0x08: out.push("-" + out.pop()); break;
				case 0x17: out.push("+" + out.pop()); break;
				case 0x16: out.push("NOT(" + out.pop() + ")"); break;

				case 0x14: case 0x15: {
					argR = out.pop(); argL = out.pop();
					out.push(["AND", "OR"][cc - 0x14] + "(" + argL + "," + argR + ")");
				} break;

				default:
					if(cc < 0x20 && BinOpTab[cc]) {
						argR = out.pop(); argL = out.pop();
						out.push(argL + BinOpTab[cc] + argR);
					} else if(FuncTab[cc]) {
						argc = FuncTab[cc][1];
						if(argc == 69) argc = blob[blob.l++];
						if(argc > out.length) { console.error("WK1 bad formula parse 0x" + cc.toString(16) + ":|" + out.join("|") + "|"); return; }
						var args = out.slice(-argc);
						out.length -= argc;
						out.push(FuncTab[cc][0] + "(" + args.join(",") + ")");
					}
					else if(cc <= 0x07) return console.error("WK1 invalid opcode " + cc.toString(16));
					else if(cc <= 0x18) return console.error("WK1 unsupported op " + cc.toString(16));
					else if(cc <= 0x1E) return console.error("WK1 invalid opcode " + cc.toString(16));
					else if(cc <= 0x73) return console.error("WK1 unsupported function opcode " + cc.toString(16));
					// possible future functions ??
					else return console.error("WK1 unrecognized opcode " + cc.toString(16));
			}
		}
		if(out.length == 1) o[1].f = "" + out[0];
		else console.error("WK1 bad formula parse |" + out.join("|") + "|");
	}

	function parse_cell_3(blob) {
		var o = [{c:0,r:0}, {t:'n',v:0}, 0];
		o[0].r = blob.read_shift(2); o[3] = blob[blob.l++]; o[0].c = blob[blob.l++];
		return o;
	}

	function parse_LABEL_16(blob, length) {
		var o = parse_cell_3(blob, length);
		o[1].t = 's';
		o[1].v = blob.read_shift(length - 4, 'cstr');
		return o;
	}
	function write_LABEL_16(R, C, wsidx, s) {
		/* TODO: encoding */
		var o = new_buf(6 + s.length);
		o.write_shift(2, R);
		o.write_shift(1, wsidx);
		o.write_shift(1, C);
		o.write_shift(1, 0x27);
		for(var i = 0; i < s.length; ++i) {
			var cc = s.charCodeAt(i);
			o.write_shift(1, cc >= 0x80 ? 0x5F : cc);
		}
		o.write_shift(1, 0);
		return o;
	}

	function parse_NUMBER_18(blob, length) {
		var o = parse_cell_3(blob, length);
		o[1].v = blob.read_shift(2);
		var v = o[1].v >> 1;
		if(o[1].v & 0x1) {
			switch(v & 0x07) {
				case 0: v = (v >> 3) * 5000; break;
				case 1: v = (v >> 3) * 500; break;
				case 2: v = (v >> 3) / 20; break;
				case 3: v = (v >> 3) / 200; break;
				case 4: v = (v >> 3) / 2000; break;
				case 5: v = (v >> 3) / 20000; break;
				case 6: v = (v >> 3) / 16; break;
				case 7: v = (v >> 3) / 64; break;
			}
		}
		o[1].v = v;
		return o;
	}

	function parse_NUMBER_17(blob, length) {
		var o = parse_cell_3(blob, length);
		var v1 = blob.read_shift(4);
		var v2 = blob.read_shift(4);
		var e = blob.read_shift(2);
		if(e == 0xFFFF) {
			if(v1 === 0 && v2 === 0xC0000000) { o[1].t = "e"; o[1].v = 0x0F; } // ERR -> #VALUE!
			else if(v1 === 0 && v2 === 0xD0000000) { o[1].t = "e"; o[1].v = 0x2A; } // NA -> #N/A
			else o[1].v = 0;
			return o;
		}
		var s = e & 0x8000; e = (e&0x7FFF) - 16446;
		o[1].v = (1 - s*2) * (v2 * Math.pow(2, e+32) + v1 * Math.pow(2, e));
		return o;
	}
	function write_NUMBER_17(R, C, wsidx, v) {
		var o = new_buf(14);
		o.write_shift(2, R);
		o.write_shift(1, wsidx);
		o.write_shift(1, C);
		if(v == 0) {
			o.write_shift(4, 0);
			o.write_shift(4, 0);
			o.write_shift(2, 0xFFFF);
			return o;
		}
		var s = 0, e = 0, v1 = 0, v2 = 0;
		if(v < 0) { s = 1; v = -v; }
		e = Math.log2(v) | 0;
		v /= Math.pow(2, e-31);
		v2 = (v)>>>0;
		if((v2&0x80000000) == 0) { v/=2; ++e; v2 = v >>> 0; }
		v -= v2;
		v2 |= 0x80000000;
		v2 >>>= 0;
		v *= Math.pow(2, 32);
		v1 = v>>>0;
		o.write_shift(4, v1);
		o.write_shift(4, v2);
		e += 0x3FFF + (s ? 0x8000 : 0);
		o.write_shift(2, e);
		return o;
	}

	function parse_FORMULA_19(blob, length) {
		var o = parse_NUMBER_17(blob, 14);
		blob.l += length - 14; /* TODO: WK3 formula */
		return o;
	}

	function parse_NUMBER_25(blob, length) {
		var o = parse_cell_3(blob, length);
		var v1 = blob.read_shift(4);
		o[1].v = v1 >> 6;
		return o;
	}

	function parse_NUMBER_27(blob, length) {
		var o = parse_cell_3(blob, length);
		var v1 = blob.read_shift(8,'f');
		o[1].v = v1;
		return o;
	}

	function parse_FORMULA_28(blob, length) {
		var o = parse_NUMBER_27(blob, 12);
		blob.l += length - 12; /* TODO: formula */
		return o;
	}

	function parse_SHEETNAMECS(blob, length) {
		return blob[blob.l + length - 1] == 0 ? blob.read_shift(length, 'cstr') : "";
	}

	function parse_SHEETNAMELP(blob, length) {
		var len = blob[blob.l++];
		if(len > length - 1) len = length - 1;
		var o = ""; while(o.length < len) o += String.fromCharCode(blob[blob.l++]);
		return o;
	}

	function parse_SHEETINFOQP(blob, length, opts) {
		if(!opts.qpro || length < 21) return;
		var id = blob.read_shift(1);
		blob.l += 17;
		blob.l += 1; //var len = blob.read_shift(1);
		blob.l += 2;
		var nm = blob.read_shift(length - 21, 'cstr');
		return [id, nm];
	}

	function parse_XFORMAT(blob, length) {
		var o = {}, tgt = blob.l + length;
		while(blob.l < tgt) {
			var dt = blob.read_shift(2);
			if(dt == 0x36b0) {
				o[dt] = [0, ""];
				o[dt][0] = blob.read_shift(2);
				while(blob[blob.l]) { o[dt][1] += String.fromCharCode(blob[blob.l]); blob.l++; } blob.l++;
			}
			// TODO: 0x3a99 ??
		}
		return o;
	}
	function write_XFORMAT_SHEETNAME(name, wsidx) {
		var out = new_buf(5 + name.length);
		out.write_shift(2, 0x36b0);
		out.write_shift(2, wsidx);
		for(var i = 0; i < name.length; ++i) {
			var cc = name.charCodeAt(i);
			out[out.l++] = cc > 0x7F ? 0x5F : cc;
		}
		out[out.l++] = 0;
		return out;
	}

	var WK1Enum = {
		0x0000: { n:"BOF", f:parseuint16 },
		0x0001: { n:"EOF" },
		0x0002: { n:"CALCMODE" },
		0x0003: { n:"CALCORDER" },
		0x0004: { n:"SPLIT" },
		0x0005: { n:"SYNC" },
		0x0006: { n:"RANGE", f:parse_RANGE },
		0x0007: { n:"WINDOW1" },
		0x0008: { n:"COLW1" },
		0x0009: { n:"WINTWO" },
		0x000A: { n:"COLW2" },
		0x000B: { n:"NAME" },
		0x000C: { n:"BLANK" },
		0x000D: { n:"INTEGER", f:parse_INTEGER },
		0x000E: { n:"NUMBER", f:parse_NUMBER },
		0x000F: { n:"LABEL", f:parse_LABEL },
		0x0010: { n:"FORMULA", f:parse_FORMULA },
		0x0018: { n:"TABLE" },
		0x0019: { n:"ORANGE" },
		0x001A: { n:"PRANGE" },
		0x001B: { n:"SRANGE" },
		0x001C: { n:"FRANGE" },
		0x001D: { n:"KRANGE1" },
		0x0020: { n:"HRANGE" },
		0x0023: { n:"KRANGE2" },
		0x0024: { n:"PROTEC" },
		0x0025: { n:"FOOTER" },
		0x0026: { n:"HEADER" },
		0x0027: { n:"SETUP" },
		0x0028: { n:"MARGINS" },
		0x0029: { n:"LABELFMT" },
		0x002A: { n:"TITLES" },
		0x002B: { n:"SHEETJS" },
		0x002D: { n:"GRAPH" },
		0x002E: { n:"NGRAPH" },
		0x002F: { n:"CALCCOUNT" },
		0x0030: { n:"UNFORMATTED" },
		0x0031: { n:"CURSORW12" },
		0x0032: { n:"WINDOW" },
		0x0033: { n:"STRING", f:parse_STRING },
		0x0037: { n:"PASSWORD" },
		0x0038: { n:"LOCKED" },
		0x003C: { n:"QUERY" },
		0x003D: { n:"QUERYNAME" },
		0x003E: { n:"PRINT" },
		0x003F: { n:"PRINTNAME" },
		0x0040: { n:"GRAPH2" },
		0x0041: { n:"GRAPHNAME" },
		0x0042: { n:"ZOOM" },
		0x0043: { n:"SYMSPLIT" },
		0x0044: { n:"NSROWS" },
		0x0045: { n:"NSCOLS" },
		0x0046: { n:"RULER" },
		0x0047: { n:"NNAME" },
		0x0048: { n:"ACOMM" },
		0x0049: { n:"AMACRO" },
		0x004A: { n:"PARSE" },
		// 0x0064
		0x0066: { n:"PRANGES??" },
		0x0067: { n:"RRANGES??" },
		0x0068: { n:"FNAME??" },
		0x0069: { n:"MRANGES??" },
		// 0x0096
		// 0x0099
		// 0x009A
		// 0x009B
		// 0x009C
		// 0x00C0
		// 0x00C7
		// 0x00C9
		0x00CC: { n:"SHEETNAMECS", f:parse_SHEETNAMECS },
		// 0x00CD
		0x00DE: { n:"SHEETNAMELP", f:parse_SHEETNAMELP },
		0x00FF: { n:"BOF", f:parseuint16 },
		0x5402: { n:"WKSNF", f:parseuint16 },
		0xFFFF: { n:"" }
	};

	var WK3Enum = {
		0x0000: { n:"BOF" },
		0x0001: { n:"EOF" },
		0x0002: { n:"PASSWORD" },
		0x0003: { n:"CALCSET" },
		0x0004: { n:"WINDOWSET" },
		0x0005: { n:"SHEETCELLPTR" },
		0x0006: { n:"SHEETLAYOUT" },
		0x0007: { n:"COLUMNWIDTH" },
		0x0008: { n:"HIDDENCOLUMN" },
		0x0009: { n:"USERRANGE" },
		0x000A: { n:"SYSTEMRANGE" },
		0x000B: { n:"ZEROFORCE" },
		0x000C: { n:"SORTKEYDIR" },
		0x000D: { n:"FILESEAL" },
		0x000E: { n:"DATAFILLNUMS" },
		0x000F: { n:"PRINTMAIN" },
		0x0010: { n:"PRINTSTRING" },
		0x0011: { n:"GRAPHMAIN" },
		0x0012: { n:"GRAPHSTRING" },
		0x0013: { n:"??" },
		0x0014: { n:"ERRCELL" },
		0x0015: { n:"NACELL" },
		0x0016: { n:"LABEL16", f:parse_LABEL_16},
		0x0017: { n:"NUMBER17", f:parse_NUMBER_17 },
		0x0018: { n:"NUMBER18", f:parse_NUMBER_18 },
		0x0019: { n:"FORMULA19", f:parse_FORMULA_19},
		0x001A: { n:"FORMULA1A" },
		0x001B: { n:"XFORMAT", f:parse_XFORMAT },
		0x001C: { n:"DTLABELMISC" },
		0x001D: { n:"DTLABELCELL" },
		0x001E: { n:"GRAPHWINDOW" },
		0x001F: { n:"CPA" },
		0x0020: { n:"LPLAUTO" },
		0x0021: { n:"QUERY" },
		0x0022: { n:"HIDDENSHEET" },
		0x0023: { n:"??" },
		0x0025: { n:"NUMBER25", f:parse_NUMBER_25 },
		0x0026: { n:"??" },
		0x0027: { n:"NUMBER27", f:parse_NUMBER_27 },
		0x0028: { n:"FORMULA28", f:parse_FORMULA_28 },
		0x008E: { n:"??" },
		0x0093: { n:"??" },
		0x0096: { n:"??" },
		0x0097: { n:"??" },
		0x0098: { n:"??" },
		0x0099: { n:"??" },
		0x009A: { n:"??" },
		0x009B: { n:"??" },
		0x009C: { n:"??" },
		0x00A3: { n:"??" },
		0x00AE: { n:"??" },
		0x00AF: { n:"??" },
		0x00B0: { n:"??" },
		0x00B1: { n:"??" },
		0x00B8: { n:"??" },
		0x00B9: { n:"??" },
		0x00BA: { n:"??" },
		0x00BB: { n:"??" },
		0x00BC: { n:"??" },
		0x00C3: { n:"??" },
		0x00C9: { n:"??" },
		0x00CC: { n:"SHEETNAMECS", f:parse_SHEETNAMECS },
		0x00CD: { n:"??" },
		0x00CE: { n:"??" },
		0x00CF: { n:"??" },
		0x00D0: { n:"??" },
		0x0100: { n:"??" },
		0x0103: { n:"??" },
		0x0104: { n:"??" },
		0x0105: { n:"??" },
		0x0106: { n:"??" },
		0x0107: { n:"??" },
		0x0109: { n:"??" },
		0x010A: { n:"??" },
		0x010B: { n:"??" },
		0x010C: { n:"??" },
		0x010E: { n:"??" },
		0x010F: { n:"??" },
		0x0180: { n:"??" },
		0x0185: { n:"??" },
		0x0186: { n:"??" },
		0x0189: { n:"??" },
		0x018C: { n:"??" },
		0x0200: { n:"??" },
		0x0202: { n:"??" },
		0x0201: { n:"??" },
		0x0204: { n:"??" },
		0x0205: { n:"??" },
		0x0280: { n:"??" },
		0x0281: { n:"??" },
		0x0282: { n:"??" },
		0x0283: { n:"??" },
		0x0284: { n:"??" },
		0x0285: { n:"??" },
		0x0286: { n:"??" },
		0x0287: { n:"??" },
		0x0288: { n:"??" },
		0x0292: { n:"??" },
		0x0293: { n:"??" },
		0x0294: { n:"??" },
		0x0295: { n:"??" },
		0x0296: { n:"??" },
		0x0299: { n:"??" },
		0x029A: { n:"??" },
		0x0300: { n:"??" },
		0x0304: { n:"??" },
		0x0601: { n:"SHEETINFOQP", f:parse_SHEETINFOQP },
		0x0640: { n:"??" },
		0x0642: { n:"??" },
		0x0701: { n:"??" },
		0x0702: { n:"??" },
		0x0703: { n:"??" },
		0x0704: { n:"??" },
		0x0780: { n:"??" },
		0x0800: { n:"??" },
		0x0801: { n:"??" },
		0x0804: { n:"??" },
		0x0A80: { n:"??" },
		0x2AF6: { n:"??" },
		0x3231: { n:"??" },
		0x6E49: { n:"??" },
		0x6F44: { n:"??" },
		0xFFFF: { n:"" }
	};

	/* TODO: fill out and verify this table across QP versions */
	var QPWNFTable = {
		0x05: "dd-mmm-yy",
		0x06: "dd-mmm",
		0x07: "mmm-yy",
		0x08: "mm/dd/yy", // Long Date Intl
		0x0A: "hh:mm:ss AM/PM",
		0x0B: "hh:mm AM/PM",
		0x0E: "dd-mmm-yyyy",
		0x0F: "mmm-yyyy",

		/* It is suspected that the the low nybble specifies decimal places */
		0x0022: "0.00",
		0x0032: "0.00;[Red]0.00",
		0x0042: "0.00;\(0.00\)",
		0x0052: "0.00;[Red]\(0.00\)",
		0x00A2: '"$"#,##0.00;\\("$"#,##0.00\\)',
		0x0120: '0%',
		0x0130: '0E+00',
		0x0140: '# ?/?'
	};

	function parse_qpw_str(p) {
		var cch = p.read_shift(2);
		var flags = p.read_shift(1);
		/* TODO: find examples with nonzero flags */
		if(flags != 0) throw "unsupported QPW string type " + flags.toString(16);
		return p.read_shift(cch, "sbcs-cont");
	}

	/* QPW uses a different set of record types */
	function qpw_to_workbook_buf(d, opts) {
		prep_blob(d, 0);
		var o = opts || {};
		if(DENSE != null && o.dense == null) o.dense = DENSE;
		var s = ({}); if(o.dense) s["!data"] = [];
		var SST = [], sname = "", formulae = [];
		var range = {s:{r:-1,c:-1}, e:{r:-1,c:-1}};
		var cnt = 0, type = 0, C = 0, R = 0;
		var wb = { SheetNames: [], Sheets: {} };
		var FMTS = [];
		outer: while(d.l < d.length) {
			var RT = d.read_shift(2), length = d.read_shift(2);
			var p = d.slice(d.l, d.l + length);
			prep_blob(p, 0);
			switch(RT) {
				case 0x01: /* BOF */
					if(p.read_shift(4) != 0x39575051) throw "Bad QPW9 BOF!";
					break;
				case 0x02: /* EOF */ break outer;

				case 0x08: /* NF */ break; // TODO: this is tied to custom number formats

				case 0x0A: /* FORMATS */ {
					var fcnt = p.read_shift(4);
					var step = ((p.length - p.l)/ fcnt)|0;
					for(var ifmt = 0; ifmt < fcnt; ++ifmt) {
						var end = p.l + step;
						var fmt = {};
						p.l += 2;
						fmt.numFmtId = p.read_shift(2);
						if(QPWNFTable[fmt.numFmtId]) fmt.z = QPWNFTable[fmt.numFmtId];
						p.l = end;
						FMTS.push(fmt);
					}
				} break;

				/* TODO: The behavior here should be consistent with Numbers: QP Notebook ~ .TN.SheetArchive, QP Sheet ~ .TST.TableModelArchive */
				case 0x0401: /* BON */ break;
				case 0x0402: /* EON */ /* TODO: backfill missing sheets based on BON cnt */ break;

				case 0x0407: { /* SST */
					p.l += 12;
					while(p.l < p.length) {
						cnt = p.read_shift(2);
						type = p.read_shift(1);
						SST.push(p.read_shift(cnt, 'cstr'));
					}
				} break;
				case 0x0408: { /* FORMULAE */
					//p.l += 12;
					//while(p.l < p.length) {
					//	cnt = p.read_shift(2);
					//	formulae.push(p.slice(p.l, p.l + cnt + 1)); p.l += cnt + 1;
					//}
				} break;

				case 0x0601: { /* BOS */
					var sidx = p.read_shift(2);
					s = ({}); if(o.dense) s["!data"] = [];
					range.s.c = p.read_shift(2);
					range.e.c = p.read_shift(2);
					range.s.r = p.read_shift(4);
					range.e.r = p.read_shift(4);
					p.l += 4;
					if(p.l + 2 < p.length) {
						cnt = p.read_shift(2);
						type = p.read_shift(1);
						sname = cnt == 0 ? "" : p.read_shift(cnt, 'cstr');
					}
					if(!sname) sname = encode_col(sidx);
					/* TODO: backfill empty sheets */
				} break;
				case 0x0602: { /* EOS */
					/* NOTE: QP valid range A1:IV1000000 */
					if(range.s.c > 0xFF || range.s.r > 999999) break;
					if(range.e.c < range.s.c) range.e.c = range.s.c;
					if(range.e.r < range.s.r) range.e.r = range.s.r;
					s["!ref"] = encode_range(range);
					book_append_sheet(wb, s, sname); // TODO: a barrel roll
				} break;

				case 0x0A01: { /* COL (like XLS Row, modulo the layout transposition) */
					C = p.read_shift(2);
					if(range.e.c < C) range.e.c = C;
					if(range.s.c > C) range.s.c = C;
					R = p.read_shift(4);
					if(range.s.r > R) range.s.r = R;
					R = p.read_shift(4);
					if(range.e.r < R) range.e.r = R;
				} break;

				case 0x0C01: { /* MulCells (like XLS MulRK, but takes advantage of common column data patterns) */
					R = p.read_shift(4), cnt = p.read_shift(4);
					if(range.s.r > R) range.s.r = R;
					if(range.e.r < R + cnt - 1) range.e.r = R + cnt - 1;
					var CC = encode_col(C);
					while(p.l < p.length) {
						var cell = { t: "z" };
						var flags = p.read_shift(1), fmtidx = -1;
						if(flags & 0x80) fmtidx = p.read_shift(2);
						var mul = (flags & 0x40) ? p.read_shift(2) - 1: 0;
						switch(flags & 0x1F) {
							case 0: break;
							case 1: break;
							case 2: cell = { t: "n", v: p.read_shift(2) }; break;
							case 3: cell = { t: "n", v: p.read_shift(2, 'i') }; break;
							case 4: cell = { t: "n", v: parse_RkNumber(p) }; break;
							case 5: cell = { t: "n", v: p.read_shift(8, 'f') }; break;
							case 7: cell = { t: "s", v: SST[type = p.read_shift(4) - 1] }; break;
							case 8:
								cell = { t: "n", v: p.read_shift(8, 'f') };
								p.l += 2; /* cell.f = formulae[p.read_shift(4)]; */ p.l += 4;
								if(isNaN(cell.v)) cell = { t: "e", v: 0x0F }; // #VALUE!
								break;
							default: throw "Unrecognized QPW cell type " + (flags & 0x1F);
						}
						if(fmtidx != -1 && (FMTS[fmtidx - 1]||{}).z) cell.z = FMTS[fmtidx-1].z;
						var delta = 0;
						if(flags & 0x20) switch(flags & 0x1F) {
							case 2: delta = p.read_shift(2); break;
							case 3: delta = p.read_shift(2, 'i'); break;
							case 7: delta = p.read_shift(2); break;
							default: throw "Unsupported delta for QPW cell type " + (flags & 0x1F);
						}
						if(!(!o.sheetStubs && cell.t == "z")) {
							var newcell = dup(cell);
							if(cell.t == "n" && cell.z && fmt_is_date(cell.z) && o.cellDates) {
								newcell.v = numdate(cell.v); newcell.t = typeof newcell.v == "number" ? 'n' : 'd';
							}
							if(s["!data"] != null) {
								if(!s["!data"][R]) s["!data"][R] = [];
								s["!data"][R][C] = newcell;
							} else s[CC + encode_row(R)] = newcell;
						}
						++R; --cnt;
						while(mul-- > 0 && cnt >= 0) {
							if(flags & 0x20) switch(flags & 0x1F) {
								case 2: cell = { t: "n", v: (cell.v + delta) & 0xFFFF }; break;
								case 3: cell = { t: "n", v: (cell.v + delta) & 0xFFFF }; if(cell.v > 0x7FFF) cell.v -= 0x10000; break;
								case 7: cell = { t: "s", v: SST[type = (type + delta) >>> 0] }; break;
								default: throw "Cannot apply delta for QPW cell type " + (flags & 0x1F);
							} else switch(flags & 0x1F) {
								case 1: cell = { t: "z" }; break;
								case 2: cell = { t: "n", v: p.read_shift(2) }; break;
								case 7: cell = { t: "s", v: SST[type = p.read_shift(4) - 1] }; break;
								default: throw "Cannot apply repeat for QPW cell type " + (flags & 0x1F);
							}
							if(fmtidx != -1);
							if(!(!o.sheetStubs && cell.t == "z")) {
								if(s["!data"] != null) {
									if(!s["!data"][R]) s["!data"][R] = [];
									s["!data"][R][C] = cell;
								} else s[CC + encode_row(R)] = cell;
							}
							++R; --cnt;
						}
					}
				} break;

				case 0x0C02: { /* String (result of string formula expression) */
					C = p.read_shift(2);
					R = p.read_shift(4);
					var str = parse_qpw_str(p);
					/* TODO: QP10 record has an additional unknown character after the string */
					if(s["!data"] != null) {
						if(!s["!data"][R]) s["!data"][R] = [];
						s["!data"][R][C] = { t:"s", v:str };
					} else s[encode_col(C) + encode_row(R)] = { t:"s", v:str };
				} break;

				default: break;
			}
			d.l += length;
		}
		return wb;
	}

	return {
		sheet_to_wk1: sheet_to_wk1,
		book_to_wk3: book_to_wk3,
		to_workbook: lotus_to_workbook
	};
})();
/* 18.4.7 rPr CT_RPrElt */
function parse_rpr(rpr) {
	var font = {}, m = rpr.match(tagregex), i = 0;
	var pass = false;
	if(m) for(;i!=m.length; ++i) {
		var y = parsexmltag(m[i]);
		switch(y[0].replace(/<\w*:/g,"<")) {
			/* 18.8.12 condense CT_BooleanProperty */
			/* ** not required . */
			case '<condense': break;
			/* 18.8.17 extend CT_BooleanProperty */
			/* ** not required . */
			case '<extend': break;
			/* 18.8.36 shadow CT_BooleanProperty */
			/* ** not required . */
			case '<shadow':
				if(!y.val) break;
				/* falls through */
			case '<shadow>':
			case '<shadow/>': font.shadow = 1; break;
			case '</shadow>': break;

			/* 18.4.1 charset CT_IntProperty TODO */
			case '<charset':
				if(y.val == '1') break;
				font.cp = CS2CP[parseInt(y.val, 10)];
				break;

			/* 18.4.2 outline CT_BooleanProperty TODO */
			case '<outline':
				if(!y.val) break;
				/* falls through */
			case '<outline>':
			case '<outline/>': font.outline = 1; break;
			case '</outline>': break;

			/* 18.4.5 rFont CT_FontName */
			case '<rFont': font.name = y.val; break;

			/* 18.4.11 sz CT_FontSize */
			case '<sz': font.sz = y.val; break;

			/* 18.4.10 strike CT_BooleanProperty */
			case '<strike':
				if(!y.val) break;
				/* falls through */
			case '<strike>':
			case '<strike/>': font.strike = 1; break;
			case '</strike>': break;

			/* 18.4.13 u CT_UnderlineProperty */
			case '<u':
				if(!y.val) break;
				switch(y.val) {
					case 'double': font.uval = "double"; break;
					case 'singleAccounting': font.uval = "single-accounting"; break;
					case 'doubleAccounting': font.uval = "double-accounting"; break;
				}
				/* falls through */
			case '<u>':
			case '<u/>': font.u = 1; break;
			case '</u>': break;

			/* 18.8.2 b */
			case '<b':
				if(y.val == '0') break;
				/* falls through */
			case '<b>':
			case '<b/>': font.b = 1; break;
			case '</b>': break;

			/* 18.8.26 i */
			case '<i':
				if(y.val == '0') break;
				/* falls through */
			case '<i>':
			case '<i/>': font.i = 1; break;
			case '</i>': break;

			/* 18.3.1.15 color CT_Color TODO: tint, theme, auto, indexed */
			case '<color':
				if(y.rgb) font.color = y.rgb.slice(2,8);
				break;
			case '<color>': case '<color/>': case '</color>': break;

			/* 18.8.18 family ST_FontFamily */
			case '<family': font.family = y.val; break;
			case '<family>': case '<family/>': case '</family>': break;

			/* 18.4.14 vertAlign CT_VerticalAlignFontProperty TODO */
			case '<vertAlign': font.valign = y.val; break;
			case '<vertAlign>': case '<vertAlign/>': case '</vertAlign>': break;

			/* 18.8.35 scheme CT_FontScheme TODO */
			case '<scheme': break;
			case '<scheme>': case '<scheme/>': case '</scheme>': break;

			/* 18.2.10 extLst CT_ExtensionList ? */
			case '<extLst': case '<extLst>': case '</extLst>': break;
			case '<ext': pass = true; break;
			case '</ext>': pass = false; break;
			default:
				if(y[0].charCodeAt(1) !== 47 && !pass) throw new Error('Unrecognized rich format ' + y[0]);
		}
	}
	return font;
}

var parse_rs = (function() {
	/* 18.4.4 r CT_RElt */
	function parse_r(r) {
		/* 18.4.12 t ST_Xstring */
		var t = str_match_xml_ns(r, "t")/*, cp = 65001*/;
		if(!t) return {t:"s", v:""};

		var o = ({t:'s', v:unescapexml(t[1])});
		var rpr = str_match_xml_ns(r, "rPr");
		if(rpr) o.s = parse_rpr(rpr[1]);
		return o;
	}
	var rregex = /<(?:\w+:)?r>/g, rend = /<\/(?:\w+:)?r>/;
	return function parse_rs(rs) {
		return rs.replace(rregex,"").split(rend).map(parse_r).filter(function(r) { return r.v; });
	};
})();


/* Parse a list of <r> tags */
var rs_to_html = (function parse_rs_factory() {
	var nlregex = /(\r\n|\n)/g;
	function parse_rpr2(font, intro, outro) {
		var style = [];

		if(font.u) style.push("text-decoration: underline;");
		if(font.uval) style.push("text-underline-style:" + font.uval + ";");
		if(font.sz) style.push("font-size:" + font.sz + "pt;");
		if(font.outline) style.push("text-effect: outline;");
		if(font.shadow) style.push("text-shadow: auto;");
		intro.push('<span style="' + style.join("") + '">');

		if(font.b) { intro.push("<b>"); outro.push("</b>"); }
		if(font.i) { intro.push("<i>"); outro.push("</i>"); }
		if(font.strike) { intro.push("<s>"); outro.push("</s>"); }

		var align = font.valign || "";
		if(align == "superscript" || align == "super") align = "sup";
		else if(align == "subscript") align = "sub";
		if(align != "") { intro.push("<" + align + ">"); outro.push("</" + align + ">"); }

		outro.push("</span>");
		return font;
	}

	/* 18.4.4 r CT_RElt */
	function r_to_html(r) {
		var terms = [[],r.v,[]];
		if(!r.v) return "";

		if(r.s) parse_rpr2(r.s, terms[0], terms[2]);

		return terms[0].join("") + terms[1].replace(nlregex,'<br/>') + terms[2].join("");
	}

	return function parse_rs(rs) {
		return rs.map(r_to_html).join("");
	};
})();

/* 18.4.8 si CT_Rst */
var sitregex = /<(?:\w+:)?t\b[^<>]*>([^<]*)<\/(?:\w+:)?t>/g, sirregex = /<(?:\w+:)?r\b[^<>]*>/;
function parse_si(x, opts) {
	var html = opts ? opts.cellHTML : true;
	var z = {};
	if(!x) return { t: "" };
	//var y;
	/* 18.4.12 t ST_Xstring (Plaintext String) */
	// TODO: is whitespace actually valid here?
	if(x.match(/^\s*<(?:\w+:)?t[^>]*>/)) {
		z.t = unescapexml(utf8read(x.slice(x.indexOf(">")+1).split(/<\/(?:\w+:)?t>/)[0]||""), true);
		z.r = utf8read(x);
		if(html) z.h = escapehtml(z.t);
	}
	/* 18.4.4 r CT_RElt (Rich Text Run) */
	else if((/*y = */x.match(sirregex))) {
		z.r = utf8read(x);
		z.t = unescapexml(utf8read((str_remove_xml_ns_g(x, "rPh").match(sitregex)||[]).join("").replace(tagregex,"")), true);
		if(html) z.h = rs_to_html(parse_rs(z.r));
	}
	/* 18.4.3 phoneticPr CT_PhoneticPr (TODO: needed for Asian support) */
	/* 18.4.6 rPh CT_PhoneticRun (TODO: needed for Asian support) */
	return z;
}

/* 18.4 Shared String Table */
var sstr1 = /<(?:\w+:)?(?:si|sstItem)>/g;
var sstr2 = /<\/(?:\w+:)?(?:si|sstItem)>/;
function parse_sst_xml(data, opts) {
	var s = ([]), ss = "";
	if(!data) return s;
	/* 18.4.9 sst CT_Sst */
	var sst = str_match_xml_ns(data, "sst");
	if(sst) {
		ss = sst[1].replace(sstr1,"").split(sstr2);
		for(var i = 0; i != ss.length; ++i) {
			var o = parse_si(ss[i].trim(), opts);
			if(o != null) s[s.length] = o;
		}
		sst = parsexmltag(sst[0].slice(0, sst[0].indexOf(">"))); s.Count = sst.count; s.Unique = sst.uniqueCount;
	}
	return s;
}

var straywsregex = /^\s|\s$|[\t\n\r]/;
function write_sst_xml(sst, opts) {
	if(!opts.bookSST) return "";
	var o = [XML_HEADER];
	o[o.length] = (writextag('sst', null, {
		xmlns: XMLNS_main[0],
		count: sst.Count,
		uniqueCount: sst.Unique
	}));
	for(var i = 0; i != sst.length; ++i) { if(sst[i] == null) continue;
		var s = sst[i];
		var sitag = "<si>";
		if(s.r) sitag += s.r;
		else {
			sitag += "<t";
			if(!s.t) s.t = "";
			if(typeof s.t !== "string") s.t = String(s.t);
			if(s.t.match(straywsregex)) sitag += ' xml:space="preserve"';
			sitag += ">" + escapexml(s.t) + "</t>";
		}
		sitag += "</si>";
		o[o.length] = (sitag);
	}
	if(o.length>2){ o[o.length] = ('</sst>'); o[1]=o[1].replace("/>",">"); }
	return o.join("");
}
/* [MS-XLSB] 2.4.221 BrtBeginSst */
function parse_BrtBeginSst(data) {
	return [data.read_shift(4), data.read_shift(4)];
}

/* [MS-XLSB] 2.1.7.45 Shared Strings */
function parse_sst_bin(data, opts) {
	var s = ([]);
	var pass = false;
	recordhopper(data, function hopper_sst(val, R, RT) {
		switch(RT) {
			case 0x009F: /* BrtBeginSst */
				s.Count = val[0]; s.Unique = val[1]; break;
			case 0x0013: /* BrtSSTItem */
				s.push(val); break;
			case 0x00A0: /* BrtEndSst */
				return true;

			case 0x0023: /* BrtFRTBegin */
				pass = true; break;
			case 0x0024: /* BrtFRTEnd */
				pass = false; break;

			default:
				if(R.T){}
				if(!pass || opts.WTF) throw new Error("Unexpected record 0x" + RT.toString(16));
		}
	});
	return s;
}

function write_BrtBeginSst(sst, o) {
	if(!o) o = new_buf(8);
	o.write_shift(4, sst.Count);
	o.write_shift(4, sst.Unique);
	return o;
}

var write_BrtSSTItem = write_RichStr;

function write_sst_bin(sst) {
	var ba = buf_array();
	write_record(ba, 0x009F /* BrtBeginSst */, write_BrtBeginSst(sst));
	for(var i = 0; i < sst.length; ++i) write_record(ba, 0x0013 /* BrtSSTItem */, write_BrtSSTItem(sst[i]));
	/* FRTSST */
	write_record(ba, 0x00A0 /* BrtEndSst */);
	return ba.end();
}
function _JS2ANSI(str) {
	if(typeof $cptable !== 'undefined') return $cptable.utils.encode(current_ansi, str);
	var o = [], oo = str.split("");
	for(var i = 0; i < oo.length; ++i) o[i] = oo[i].charCodeAt(0);
	return o;
}

/* [MS-OFFCRYPTO] 2.1.4 Version */
function parse_CRYPTOVersion(blob, length) {
	var o = {};
	o.Major = blob.read_shift(2);
	o.Minor = blob.read_shift(2);
if(length >= 4) blob.l += length - 4;
	return o;
}

/* [MS-OFFCRYPTO] 2.1.5 DataSpaceVersionInfo */
function parse_DataSpaceVersionInfo(blob) {
	var o = {};
	o.id = blob.read_shift(0, 'lpp4');
	o.R = parse_CRYPTOVersion(blob, 4);
	o.U = parse_CRYPTOVersion(blob, 4);
	o.W = parse_CRYPTOVersion(blob, 4);
	return o;
}

/* [MS-OFFCRYPTO] 2.1.6.1 DataSpaceMapEntry Structure */
function parse_DataSpaceMapEntry(blob) {
	var len = blob.read_shift(4);
	var end = blob.l + len - 4;
	var o = {};
	var cnt = blob.read_shift(4);
	var comps = [];
	/* [MS-OFFCRYPTO] 2.1.6.2 DataSpaceReferenceComponent Structure */
	while(cnt-- > 0) comps.push({ t: blob.read_shift(4), v: blob.read_shift(0, 'lpp4') });
	o.name = blob.read_shift(0, 'lpp4');
	o.comps = comps;
	if(blob.l != end) throw new Error("Bad DataSpaceMapEntry: " + blob.l + " != " + end);
	return o;
}

/* [MS-OFFCRYPTO] 2.1.6 DataSpaceMap */
function parse_DataSpaceMap(blob) {
	var o = [];
	blob.l += 4; // must be 0x8
	var cnt = blob.read_shift(4);
	while(cnt-- > 0) o.push(parse_DataSpaceMapEntry(blob));
	return o;
}

/* [MS-OFFCRYPTO] 2.1.7 DataSpaceDefinition */
function parse_DataSpaceDefinition(blob) {
	var o = [];
	blob.l += 4; // must be 0x8
	var cnt = blob.read_shift(4);
	while(cnt-- > 0) o.push(blob.read_shift(0, 'lpp4'));
	return o;
}

/* [MS-OFFCRYPTO] 2.1.8 DataSpaceDefinition */
function parse_TransformInfoHeader(blob) {
	var o = {};
	/*var len = */blob.read_shift(4);
	blob.l += 4; // must be 0x1
	o.id = blob.read_shift(0, 'lpp4');
	o.name = blob.read_shift(0, 'lpp4');
	o.R = parse_CRYPTOVersion(blob, 4);
	o.U = parse_CRYPTOVersion(blob, 4);
	o.W = parse_CRYPTOVersion(blob, 4);
	return o;
}

function parse_Primary(blob) {
	/* [MS-OFFCRYPTO] 2.2.6 IRMDSTransformInfo */
	var hdr = parse_TransformInfoHeader(blob);
	/* [MS-OFFCRYPTO] 2.1.9 EncryptionTransformInfo */
	hdr.ename = blob.read_shift(0, '8lpp4');
	hdr.blksz = blob.read_shift(4);
	hdr.cmode = blob.read_shift(4);
	if(blob.read_shift(4) != 0x04) throw new Error("Bad !Primary record");
	return hdr;
}

/* [MS-OFFCRYPTO] 2.3.2 Encryption Header */
function parse_EncryptionHeader(blob, length) {
	var tgt = blob.l + length;
	var o = {};
	o.Flags = (blob.read_shift(4) & 0x3F);
	blob.l += 4;
	o.AlgID = blob.read_shift(4);
	var valid = false;
	switch(o.AlgID) {
		case 0x660E: case 0x660F: case 0x6610: valid = (o.Flags == 0x24); break;
		case 0x6801: valid = (o.Flags == 0x04); break;
		case 0: valid = (o.Flags == 0x10 || o.Flags == 0x04 || o.Flags == 0x24); break;
		default: throw 'Unrecognized encryption algorithm: ' + o.AlgID;
	}
	if(!valid) throw new Error("Encryption Flags/AlgID mismatch");
	o.AlgIDHash = blob.read_shift(4);
	o.KeySize = blob.read_shift(4);
	o.ProviderType = blob.read_shift(4);
	blob.l += 8;
	o.CSPName = blob.read_shift((tgt-blob.l)>>1, 'utf16le');
	blob.l = tgt;
	return o;
}

/* [MS-OFFCRYPTO] 2.3.3 Encryption Verifier */
function parse_EncryptionVerifier(blob, length) {
	var o = {}, tgt = blob.l + length;
	blob.l += 4; // SaltSize must be 0x10
	o.Salt = blob.slice(blob.l, blob.l+16); blob.l += 16;
	o.Verifier = blob.slice(blob.l, blob.l+16); blob.l += 16;
	/*var sz = */blob.read_shift(4);
	o.VerifierHash = blob.slice(blob.l, tgt); blob.l = tgt;
	return o;
}

/* [MS-OFFCRYPTO] 2.3.4.* EncryptionInfo Stream */
function parse_EncryptionInfo(blob) {
	var vers = parse_CRYPTOVersion(blob);
	switch(vers.Minor) {
		case 0x02: return [vers.Minor, parse_EncInfoStd(blob, vers)];
		case 0x03: return [vers.Minor, parse_EncInfoExt(blob, vers)];
		case 0x04: return [vers.Minor, parse_EncInfoAgl(blob, vers)];
	}
	throw new Error("ECMA-376 Encrypted file unrecognized Version: " + vers.Minor);
}

/* [MS-OFFCRYPTO] 2.3.4.5  EncryptionInfo Stream (Standard Encryption) */
function parse_EncInfoStd(blob) {
	var flags = blob.read_shift(4);
	if((flags & 0x3F) != 0x24) throw new Error("EncryptionInfo mismatch");
	var sz = blob.read_shift(4);
	//var tgt = blob.l + sz;
	var hdr = parse_EncryptionHeader(blob, sz);
	var verifier = parse_EncryptionVerifier(blob, blob.length - blob.l);
	return { t:"Std", h:hdr, v:verifier };
}
/* [MS-OFFCRYPTO] 2.3.4.6  EncryptionInfo Stream (Extensible Encryption) */
function parse_EncInfoExt() { throw new Error("File is password-protected: ECMA-376 Extensible"); }
/* [MS-OFFCRYPTO] 2.3.4.10 EncryptionInfo Stream (Agile Encryption) */
function parse_EncInfoAgl(blob) {
	var KeyData = ["saltSize","blockSize","keyBits","hashSize","cipherAlgorithm","cipherChaining","hashAlgorithm","saltValue"];
	blob.l+=4;
	var xml = blob.read_shift(blob.length - blob.l, 'utf8');
	var o = {};
	xml.replace(tagregex, function xml_agile(x) {
		var y = parsexmltag(x);
		switch(strip_ns(y[0])) {
			case '<?xml': break;
			case '<encryption': case '</encryption>': break;
			case '<keyData': KeyData.forEach(function(k) { o[k] = y[k]; }); break;
			case '<dataIntegrity': o.encryptedHmacKey = y.encryptedHmacKey; o.encryptedHmacValue = y.encryptedHmacValue; break;
			case '<keyEncryptors>': case '<keyEncryptors': o.encs = []; break;
			case '</keyEncryptors>': break;

			case '<keyEncryptor': o.uri = y.uri; break;
			case '</keyEncryptor>': break;
			case '<encryptedKey': o.encs.push(y); break;
			default: throw y[0];
		}
	});
	return o;
}

/* [MS-OFFCRYPTO] 2.3.5.1 RC4 CryptoAPI Encryption Header */
function parse_RC4CryptoHeader(blob, length) {
	var o = {};
	var vers = o.EncryptionVersionInfo = parse_CRYPTOVersion(blob, 4); length -= 4;
	if(vers.Minor != 2) throw new Error('unrecognized minor version code: ' + vers.Minor);
	if(vers.Major > 4 || vers.Major < 2) throw new Error('unrecognized major version code: ' + vers.Major);
	o.Flags = blob.read_shift(4); length -= 4;
	var sz = blob.read_shift(4); length -= 4;
	o.EncryptionHeader = parse_EncryptionHeader(blob, sz); length -= sz;
	o.EncryptionVerifier = parse_EncryptionVerifier(blob, length);
	return o;
}
/* [MS-OFFCRYPTO] 2.3.6.1 RC4 Encryption Header */
function parse_RC4Header(blob) {
	var o = {};
	var vers = o.EncryptionVersionInfo = parse_CRYPTOVersion(blob, 4);
	if(vers.Major != 1 || vers.Minor != 1) throw 'unrecognized version code ' + vers.Major + ' : ' + vers.Minor;
	o.Salt = blob.read_shift(16);
	o.EncryptedVerifier = blob.read_shift(16);
	o.EncryptedVerifierHash = blob.read_shift(16);
	return o;
}

/* [MS-OFFCRYPTO] 2.3.7.1 Binary Document Password Verifier Derivation */
function crypto_CreatePasswordVerifier_Method1(Password) {
	var Verifier = 0x0000, PasswordArray;
	var PasswordDecoded = _JS2ANSI(Password);
	var len = PasswordDecoded.length + 1, i, PasswordByte;
	var Intermediate1, Intermediate2, Intermediate3;
	PasswordArray = new_raw_buf(len);
	PasswordArray[0] = PasswordDecoded.length;
	for(i = 1; i != len; ++i) PasswordArray[i] = PasswordDecoded[i-1];
	for(i = len-1; i >= 0; --i) {
		PasswordByte = PasswordArray[i];
		Intermediate1 = ((Verifier & 0x4000) === 0x0000) ? 0 : 1;
		Intermediate2 = (Verifier << 1) & 0x7FFF;
		Intermediate3 = Intermediate1 | Intermediate2;
		Verifier = Intermediate3 ^ PasswordByte;
	}
	return Verifier ^ 0xCE4B;
}

/* [MS-OFFCRYPTO] 2.3.7.2 Binary Document XOR Array Initialization */
var crypto_CreateXorArray_Method1 = (function() {
	var PadArray = [0xBB, 0xFF, 0xFF, 0xBA, 0xFF, 0xFF, 0xB9, 0x80, 0x00, 0xBE, 0x0F, 0x00, 0xBF, 0x0F, 0x00];
	var InitialCode = [0xE1F0, 0x1D0F, 0xCC9C, 0x84C0, 0x110C, 0x0E10, 0xF1CE, 0x313E, 0x1872, 0xE139, 0xD40F, 0x84F9, 0x280C, 0xA96A, 0x4EC3];
	var XorMatrix = [0xAEFC, 0x4DD9, 0x9BB2, 0x2745, 0x4E8A, 0x9D14, 0x2A09, 0x7B61, 0xF6C2, 0xFDA5, 0xEB6B, 0xC6F7, 0x9DCF, 0x2BBF, 0x4563, 0x8AC6, 0x05AD, 0x0B5A, 0x16B4, 0x2D68, 0x5AD0, 0x0375, 0x06EA, 0x0DD4, 0x1BA8, 0x3750, 0x6EA0, 0xDD40, 0xD849, 0xA0B3, 0x5147, 0xA28E, 0x553D, 0xAA7A, 0x44D5, 0x6F45, 0xDE8A, 0xAD35, 0x4A4B, 0x9496, 0x390D, 0x721A, 0xEB23, 0xC667, 0x9CEF, 0x29FF, 0x53FE, 0xA7FC, 0x5FD9, 0x47D3, 0x8FA6, 0x0F6D, 0x1EDA, 0x3DB4, 0x7B68, 0xF6D0, 0xB861, 0x60E3, 0xC1C6, 0x93AD, 0x377B, 0x6EF6, 0xDDEC, 0x45A0, 0x8B40, 0x06A1, 0x0D42, 0x1A84, 0x3508, 0x6A10, 0xAA51, 0x4483, 0x8906, 0x022D, 0x045A, 0x08B4, 0x1168, 0x76B4, 0xED68, 0xCAF1, 0x85C3, 0x1BA7, 0x374E, 0x6E9C, 0x3730, 0x6E60, 0xDCC0, 0xA9A1, 0x4363, 0x86C6, 0x1DAD, 0x3331, 0x6662, 0xCCC4, 0x89A9, 0x0373, 0x06E6, 0x0DCC, 0x1021, 0x2042, 0x4084, 0x8108, 0x1231, 0x2462, 0x48C4];
	var Ror = function(Byte) { return ((Byte/2) | (Byte*128)) & 0xFF; };
	var XorRor = function(byte1, byte2) { return Ror(byte1 ^ byte2); };
	var CreateXorKey_Method1 = function(Password) {
		var XorKey = InitialCode[Password.length - 1];
		var CurrentElement = 0x68;
		for(var i = Password.length-1; i >= 0; --i) {
			var Char = Password[i];
			for(var j = 0; j != 7; ++j) {
				if(Char & 0x40) XorKey ^= XorMatrix[CurrentElement];
				Char *= 2; --CurrentElement;
			}
		}
		return XorKey;
	};
	return function(password) {
		var Password = _JS2ANSI(password);
		var XorKey = CreateXorKey_Method1(Password);
		var Index = Password.length;
		var ObfuscationArray = new_raw_buf(16);
		for(var i = 0; i != 16; ++i) ObfuscationArray[i] = 0x00;
		var Temp, PasswordLastChar, PadIndex;
		if((Index & 1) === 1) {
			Temp = XorKey >> 8;
			ObfuscationArray[Index] = XorRor(PadArray[0], Temp);
			--Index;
			Temp = XorKey & 0xFF;
			PasswordLastChar = Password[Password.length - 1];
			ObfuscationArray[Index] = XorRor(PasswordLastChar, Temp);
		}
		while(Index > 0) {
			--Index;
			Temp = XorKey >> 8;
			ObfuscationArray[Index] = XorRor(Password[Index], Temp);
			--Index;
			Temp = XorKey & 0xFF;
			ObfuscationArray[Index] = XorRor(Password[Index], Temp);
		}
		Index = 15;
		PadIndex = 15 - Password.length;
		while(PadIndex > 0) {
			Temp = XorKey >> 8;
			ObfuscationArray[Index] = XorRor(PadArray[PadIndex], Temp);
			--Index;
			--PadIndex;
			Temp = XorKey & 0xFF;
			ObfuscationArray[Index] = XorRor(Password[Index], Temp);
			--Index;
			--PadIndex;
		}
		return ObfuscationArray;
	};
})();

/* [MS-OFFCRYPTO] 2.3.7.3 Binary Document XOR Data Transformation Method 1 */
var crypto_DecryptData_Method1 = function(password, Data, XorArrayIndex, XorArray, O) {
	/* If XorArray is set, use it; if O is not set, make changes in-place */
	if(!O) O = Data;
	if(!XorArray) XorArray = crypto_CreateXorArray_Method1(password);
	var Index, Value;
	for(Index = 0; Index != Data.length; ++Index) {
		Value = Data[Index];
		Value ^= XorArray[XorArrayIndex];
		Value = ((Value>>5) | (Value<<3)) & 0xFF;
		O[Index] = Value;
		++XorArrayIndex;
	}
	return [O, XorArrayIndex, XorArray];
};

var crypto_MakeXorDecryptor = function(password) {
	var XorArrayIndex = 0, XorArray = crypto_CreateXorArray_Method1(password);
	return function(Data) {
		var O = crypto_DecryptData_Method1("", Data, XorArrayIndex, XorArray);
		XorArrayIndex = O[1];
		return O[0];
	};
};

/* 2.5.343 */
function parse_XORObfuscation(blob, length, opts, out) {
	var o = ({ key: parseuint16(blob), verificationBytes: parseuint16(blob) });
	if(opts.password) o.verifier = crypto_CreatePasswordVerifier_Method1(opts.password);
	out.valid = o.verificationBytes === o.verifier;
	if(out.valid) out.insitu = crypto_MakeXorDecryptor(opts.password);
	return o;
}

/* 2.4.117 */
function parse_FilePassHeader(blob, length, oo) {
	var o = oo || {}; o.Info = blob.read_shift(2); blob.l -= 2;
	if(o.Info === 1) o.Data = parse_RC4Header(blob, length);
	else o.Data = parse_RC4CryptoHeader(blob, length);
	return o;
}
function parse_FilePass(blob, length, opts) {
	var o = ({ Type: opts.biff >= 8 ? blob.read_shift(2) : 0 }); /* wEncryptionType */
	if(o.Type) parse_FilePassHeader(blob, length-2, o);
	else parse_XORObfuscation(blob, opts.biff >= 8 ? length : length - 2, opts, o);
	return o;
}


function rtf_to_sheet(d, opts) {
  switch (opts.type) {
    case "base64":
      return rtf_to_sheet_str(Base64_decode(d), opts);
    case "binary":
      return rtf_to_sheet_str(d, opts);
    case "buffer":
      return rtf_to_sheet_str(has_buf && Buffer.isBuffer(d) ? d.toString("binary") : a2s(d), opts);
    case "array":
      return rtf_to_sheet_str(cc2str(d), opts);
  }
  throw new Error("Unrecognized type " + opts.type);
}
function rtf_to_sheet_str(str, opts) {
  var o = opts || {};
  var ws = {};
  var dense = o.dense;
  if (dense)
    ws["!data"] = [];
  var rows = str_match_ng(str, "\\trowd", "\\row");
  if (!rows)
    throw new Error("RTF missing table");
  var range = { s: { c: 0, r: 0 }, e: { c: 0, r: rows.length - 1 } };
  var row = [];
  rows.forEach(function(rowtf, R) {
    if (dense)
      row = ws["!data"][R] = [];
    var rtfre = /\\[\w\-]+\b/g;
    var last_index = 0;
    var res;
    var C = -1;
    var payload = [];
    while ((res = rtfre.exec(rowtf)) != null) {
      var data = rowtf.slice(last_index, rtfre.lastIndex - res[0].length);
      if (data.charCodeAt(0) == 32)
        data = data.slice(1);
      if (data.length)
        payload.push(data);
      switch (res[0]) {
        case "\\cell":
          ++C;
          if (payload.length) {
            var cell = { v: payload.join(""), t: "s" };
            if (cell.v == "TRUE" || cell.v == "FALSE") {
              cell.v = cell.v == "TRUE";
              cell.t = "b";
            } else if (!isNaN(fuzzynum(cell.v))) {
              cell.t = "n";
              if (o.cellText !== false)
                cell.w = cell.v;
              cell.v = fuzzynum(cell.v);
            } else if (RBErr[cell.v] != null) {
              cell.t = "e";
              cell.w = cell.v;
              cell.v = RBErr[cell.v];
            }
            if (dense)
              row[C] = cell;
            else
              ws[encode_cell({ r: R, c: C })] = cell;
          }
          payload = [];
          break;
        case "\\par":
          payload.push("\n");
          break;
      }
      last_index = rtfre.lastIndex;
    }
    if (C > range.e.c)
      range.e.c = C;
  });
  ws["!ref"] = encode_range(range);
  return ws;
}
function rtf_to_workbook(d, opts) {
  var wb = sheet_to_workbook(rtf_to_sheet(d, opts), opts);
  wb.bookType = "rtf";
  return wb;
}
function sheet_to_rtf(ws, opts) {
  var o = ["{\\rtf1\\ansi"];
  if (!ws["!ref"])
    return o[0] + "}";
  var r = safe_decode_range(ws["!ref"]), cell;
  var dense = ws["!data"] != null, row = [];
  for (var R = r.s.r; R <= r.e.r; ++R) {
    o.push("\\trowd\\trautofit1");
    for (var C = r.s.c; C <= r.e.c; ++C)
      o.push("\\cellx" + (C + 1));
    o.push("\\pard\\intbl");
    if (dense)
      row = ws["!data"][R] || [];
    for (C = r.s.c; C <= r.e.c; ++C) {
      var coord = encode_cell({ r: R, c: C });
      cell = dense ? row[C] : ws[coord];
      if (!cell || cell.v == null && (!cell.f || cell.F)) {
        o.push(" \\cell");
        continue;
      }
      o.push(" " + (cell.w || (format_cell(cell), cell.w) || "").replace(/[\r\n]/g, "\\par "));
      o.push("\\cell");
    }
    o.push("\\pard\\intbl\\row");
  }
  return o.join("") + "}";
}
function hex2RGB(h) {
	var o = h.slice(h[0]==="#"?1:0).slice(0,6);
	return [parseInt(o.slice(0,2),16),parseInt(o.slice(2,4),16),parseInt(o.slice(4,6),16)];
}
function rgb2Hex(rgb) {
	for(var i=0,o=1; i!=3; ++i) o = o*256 + (rgb[i]>255?255:rgb[i]<0?0:rgb[i]);
	return o.toString(16).toUpperCase().slice(1);
}

function rgb2HSL(rgb) {
	var R = rgb[0]/255, G = rgb[1]/255, B=rgb[2]/255;
	var M = Math.max(R, G, B), m = Math.min(R, G, B), C = M - m;
	if(C === 0) return [0, 0, R];

	var H6 = 0, S = 0, L2 = (M + m);
	S = C / (L2 > 1 ? 2 - L2 : L2);
	switch(M){
		case R: H6 = ((G - B) / C + 6)%6; break;
		case G: H6 = ((B - R) / C + 2); break;
		case B: H6 = ((R - G) / C + 4); break;
	}
	return [H6 / 6, S, L2 / 2];
}

function hsl2RGB(hsl){
	var H = hsl[0], S = hsl[1], L = hsl[2];
	var C = S * 2 * (L < 0.5 ? L : 1 - L), m = L - C/2;
	var rgb = [m,m,m], h6 = 6*H;

	var X;
	if(S !== 0) switch(h6|0) {
		case 0: case 6: X = C * h6; rgb[0] += C; rgb[1] += X; break;
		case 1: X = C * (2 - h6);   rgb[0] += X; rgb[1] += C; break;
		case 2: X = C * (h6 - 2);   rgb[1] += C; rgb[2] += X; break;
		case 3: X = C * (4 - h6);   rgb[1] += X; rgb[2] += C; break;
		case 4: X = C * (h6 - 4);   rgb[2] += C; rgb[0] += X; break;
		case 5: X = C * (6 - h6);   rgb[2] += X; rgb[0] += C; break;
	}
	for(var i = 0; i != 3; ++i) rgb[i] = Math.round(rgb[i]*255);
	return rgb;
}

/* 18.8.3 bgColor tint algorithm */
function rgb_tint(hex, tint) {
	if(tint === 0) return hex;
	var hsl = rgb2HSL(hex2RGB(hex));
	if (tint < 0) hsl[2] = hsl[2] * (1 + tint);
	else hsl[2] = 1 - (1 - hsl[2]) * (1 - tint);
	return rgb2Hex(hsl2RGB(hsl));
}

/* 18.3.1.13 width calculations */
/* [MS-OI29500] 2.1.595 Column Width & Formatting */
var DEF_MDW = 6, MAX_MDW = 15, MIN_MDW = 1, MDW = DEF_MDW;
function width2px(width) { return Math.floor(( width + (Math.round(128/MDW))/256 )* MDW ); }
function px2char(px) { return (Math.floor((px - 5)/MDW * 100 + 0.5))/100; }
function char2width(chr) { return (Math.round((chr * MDW + 5)/MDW*256))/256; }
//function px2char_(px) { return (((px - 5)/MDW * 100 + 0.5))/100; }
//function char2width_(chr) { return (((chr * MDW + 5)/MDW*256))/256; }
function cycle_width(collw) { return char2width(px2char(width2px(collw))); }
/* XLSX/XLSB/XLS specify width in units of MDW */
function find_mdw_colw(collw) {
	var delta = Math.abs(collw - cycle_width(collw)), _MDW = MDW;
	if(delta > 0.005) for(MDW=MIN_MDW; MDW<MAX_MDW; ++MDW) if(Math.abs(collw - cycle_width(collw)) <= delta) { delta = Math.abs(collw - cycle_width(collw)); _MDW = MDW; }
	MDW = _MDW;
}
/* XLML specifies width in terms of pixels */
/*function find_mdw_wpx(wpx) {
	var delta = Infinity, guess = 0, _MDW = MIN_MDW;
	for(MDW=MIN_MDW; MDW<MAX_MDW; ++MDW) {
		guess = char2width_(px2char_(wpx))*256;
		guess = (guess) % 1;
		if(guess > 0.5) guess--;
		if(Math.abs(guess) < delta) { delta = Math.abs(guess); _MDW = MDW; }
	}
	MDW = _MDW;
}*/

function process_col(coll) {
	if(coll.width) {
		coll.wpx = width2px(coll.width);
		coll.wch = px2char(coll.wpx);
		coll.MDW = MDW;
	} else if(coll.wpx) {
		coll.wch = px2char(coll.wpx);
		coll.width = char2width(coll.wch);
		coll.MDW = MDW;
	} else if(typeof coll.wch == 'number') {
		coll.width = char2width(coll.wch);
		coll.wpx = width2px(coll.width);
		coll.MDW = MDW;
	}
	if(coll.customWidth) delete coll.customWidth;
}

var DEF_PPI = 96, PPI = DEF_PPI;
function px2pt(px) { return px * 96 / PPI; }
function pt2px(pt) { return pt * PPI / 96; }

/* [MS-EXSPXML3] 2.4.54 ST_enmPattern */
var XLMLPatternTypeMap = {
	"None": "none",
	"Solid": "solid",
	"Gray50": "mediumGray",
	"Gray75": "darkGray",
	"Gray25": "lightGray",
	"HorzStripe": "darkHorizontal",
	"VertStripe": "darkVertical",
	"ReverseDiagStripe": "darkDown",
	"DiagStripe": "darkUp",
	"DiagCross": "darkGrid",
	"ThickDiagCross": "darkTrellis",
	"ThinHorzStripe": "lightHorizontal",
	"ThinVertStripe": "lightVertical",
	"ThinReverseDiagStripe": "lightDown",
	"ThinHorzCross": "lightGrid"
};

/* 18.8.5 borders CT_Borders */
function parse_borders(t, styles, themes, opts) {
	styles.Borders = [];
	var border = {};
	var pass = false;
	(t.match(tagregex)||[]).forEach(function(x) {
		var y = parsexmltag(x);
		switch(strip_ns(y[0])) {
			case '<borders': case '<borders>': case '</borders>': break;

			/* 18.8.4 border CT_Border */
			case '<border': case '<border>': case '<border/>':
				border = {};
				if(y.diagonalUp) border.diagonalUp = parsexmlbool(y.diagonalUp);
				if(y.diagonalDown) border.diagonalDown = parsexmlbool(y.diagonalDown);
				styles.Borders.push(border);
				break;
			case '</border>': break;

			/* note: not in spec, appears to be CT_BorderPr */
			case '<left/>': break;
			case '<left': case '<left>': break;
			case '</left>': break;

			/* note: not in spec, appears to be CT_BorderPr */
			case '<right/>': break;
			case '<right': case '<right>': break;
			case '</right>': break;

			/* 18.8.43 top CT_BorderPr */
			case '<top/>': break;
			case '<top': case '<top>': break;
			case '</top>': break;

			/* 18.8.6 bottom CT_BorderPr */
			case '<bottom/>': break;
			case '<bottom': case '<bottom>': break;
			case '</bottom>': break;

			/* 18.8.13 diagonal CT_BorderPr */
			case '<diagonal': case '<diagonal>': case '<diagonal/>': break;
			case '</diagonal>': break;

			/* 18.8.25 horizontal CT_BorderPr */
			case '<horizontal': case '<horizontal>': case '<horizontal/>': break;
			case '</horizontal>': break;

			/* 18.8.44 vertical CT_BorderPr */
			case '<vertical': case '<vertical>': case '<vertical/>': break;
			case '</vertical>': break;

			/* 18.8.37 start CT_BorderPr */
			case '<start': case '<start>': case '<start/>': break;
			case '</start>': break;

			/* 18.8.16 end CT_BorderPr */
			case '<end': case '<end>': case '<end/>': break;
			case '</end>': break;

			/* 18.8.? color CT_Color */
			case '<color': case '<color>':
				break;
			case '<color/>': case '</color>': break;

			/* 18.2.10 extLst CT_ExtensionList ? */
			case '<extLst': case '<extLst>': case '</extLst>': break;
			case '<ext': pass = true; break;
			case '</ext>': pass = false; break;
			default: if(opts && opts.WTF) {
				if(!pass) throw new Error('unrecognized ' + y[0] + ' in borders');
			}
		}
	});
}

/* 18.8.21 fills CT_Fills */
function parse_fills(t, styles, themes, opts) {
	styles.Fills = [];
	var fill = {};
	var pass = false;
	(t.match(tagregex)||[]).forEach(function(x) {
		var y = parsexmltag(x);
		switch(strip_ns(y[0])) {
			case '<fills': case '<fills>': case '</fills>': break;

			/* 18.8.20 fill CT_Fill */
			case '<fill>': case '<fill': case '<fill/>':
				fill = {}; styles.Fills.push(fill); break;
			case '</fill>': break;

			/* 18.8.24 gradientFill CT_GradientFill */
			case '<gradientFill>': break;
			case '<gradientFill':
			case '</gradientFill>': styles.Fills.push(fill); fill = {}; break;

			/* 18.8.32 patternFill CT_PatternFill */
			case '<patternFill': case '<patternFill>':
				if(y.patternType) fill.patternType = y.patternType;
				break;
			case '<patternFill/>': case '</patternFill>': break;

			/* 18.8.3 bgColor CT_Color */
			case '<bgColor':
				if(!fill.bgColor) fill.bgColor = {};
				if(y.indexed) fill.bgColor.indexed = parseInt(y.indexed, 10);
				if(y.theme) fill.bgColor.theme = parseInt(y.theme, 10);
				if(y.tint) fill.bgColor.tint = parseFloat(y.tint);
				/* Excel uses ARGB strings */
				if(y.rgb) fill.bgColor.rgb = y.rgb.slice(-6);
				break;
			case '<bgColor/>': case '</bgColor>': break;

			/* 18.8.19 fgColor CT_Color */
			case '<fgColor':
				if(!fill.fgColor) fill.fgColor = {};
				if(y.theme) fill.fgColor.theme = parseInt(y.theme, 10);
				if(y.tint) fill.fgColor.tint = parseFloat(y.tint);
				/* Excel uses ARGB strings */
				if(y.rgb != null) fill.fgColor.rgb = y.rgb.slice(-6);
				break;
			case '<fgColor/>': case '</fgColor>': break;

			/* 18.8.38 stop CT_GradientStop */
			case '<stop': case '<stop/>': break;
			case '</stop>': break;

			/* 18.8.? color CT_Color */
			case '<color': case '<color/>': break;
			case '</color>': break;

			/* 18.2.10 extLst CT_ExtensionList ? */
			case '<extLst': case '<extLst>': case '</extLst>': break;
			case '<ext': pass = true; break;
			case '</ext>': pass = false; break;
			default: if(opts && opts.WTF) {
				if(!pass) throw new Error('unrecognized ' + y[0] + ' in fills');
			}
		}
	});
}

/* 18.8.23 fonts CT_Fonts */
function parse_fonts(t, styles, themes, opts) {
	styles.Fonts = [];
	var font = {};
	var pass = false;
	(t.match(tagregex)||[]).forEach(function(x) {
		var y = parsexmltag(x);
		switch(strip_ns(y[0])) {
			case '<fonts': case '<fonts>': case '</fonts>': break;

			/* 18.8.22 font CT_Font */
			case '<font': case '<font>': break;
			case '</font>': case '<font/>':
				styles.Fonts.push(font);
				font = {};
				break;

			/* 18.8.29 name CT_FontName */
			case '<name': if(y.val) font.name = utf8read(y.val); break;
			case '<name/>': case '</name>': break;

			/* 18.8.2  b CT_BooleanProperty */
			case '<b': font.bold = y.val ? parsexmlbool(y.val) : 1; break;
			case '<b/>': font.bold = 1; break;
			case '</b>': case '</b': break;

			/* 18.8.26 i CT_BooleanProperty */
			case '<i': font.italic = y.val ? parsexmlbool(y.val) : 1; break;
			case '<i/>': font.italic = 1; break;
			case '</i>': case '</i': break;

			/* 18.4.13 u CT_UnderlineProperty */
			case '<u':
				switch(y.val) {
					case "none": font.underline = 0x00; break;
					case "single": font.underline = 0x01; break;
					case "double": font.underline = 0x02; break;
					case "singleAccounting": font.underline = 0x21; break;
					case "doubleAccounting": font.underline = 0x22; break;
				} break;
			case '<u/>': font.underline = 1; break;
			case '</u>': case '</u': break;

			/* 18.4.10 strike CT_BooleanProperty */
			case '<strike': font.strike = y.val ? parsexmlbool(y.val) : 1; break;
			case '<strike/>': font.strike = 1; break;
			case '</strike>': case '</strike': break;

			/* 18.4.2  outline CT_BooleanProperty */
			case '<outline': font.outline = y.val ? parsexmlbool(y.val) : 1; break;
			case '<outline/>': font.outline = 1; break;
			case '</outline>': case '</outline': break;

			/* 18.8.36 shadow CT_BooleanProperty */
			case '<shadow': font.shadow = y.val ? parsexmlbool(y.val) : 1; break;
			case '<shadow/>': font.shadow = 1; break;
			case '</shadow>': case '</shadow': break;

			/* 18.8.12 condense CT_BooleanProperty */
			case '<condense': font.condense = y.val ? parsexmlbool(y.val) : 1; break;
			case '<condense/>': font.condense = 1; break;
			case '</condense>': case '</condense': break;

			/* 18.8.17 extend CT_BooleanProperty */
			case '<extend': font.extend = y.val ? parsexmlbool(y.val) : 1; break;
			case '<extend/>': font.extend = 1; break;
			case '</extend>': case '</extend': break;

			/* 18.4.11 sz CT_FontSize */
			case '<sz': if(y.val) font.sz = +y.val; break;
			case '<sz/>': case '</sz>': case '</sz': break;

			/* 18.4.14 vertAlign CT_VerticalAlignFontProperty */
			case '<vertAlign': if(y.val) font.vertAlign = y.val; break;
			case '<vertAlign/>': case '</vertAlign>': case '</vertAlign': break;

			/* 18.8.18 family CT_FontFamily */
			case '<family': if(y.val) font.family = parseInt(y.val,10); break;
			case '<family/>': case '</family>': case '</family': break;

			/* 18.8.35 scheme CT_FontScheme */
			case '<scheme': if(y.val) font.scheme = y.val; break;
			case '<scheme/>': case '</scheme>': case '</scheme': break;

			/* 18.4.1 charset CT_IntProperty */
			case '<charset':
				if(y.val == '1') break;
				y.codepage = CS2CP[parseInt(y.val, 10)];
				break;
			case '<charset/>': case '</charset>': case '</charset': break;

			/* 18.?.? color CT_Color */
			case '<color':
				if(!font.color) font.color = {};
				if(y.auto) font.color.auto = parsexmlbool(y.auto);

				if(y.rgb) font.color.rgb = y.rgb.slice(-6);
				else if(y.indexed) {
					font.color.index = parseInt(y.indexed, 10);
					var icv = XLSIcv[font.color.index];
					if(font.color.index == 81) icv = XLSIcv[1];
					if(!icv) icv = XLSIcv[1]; //throw new Error(x); // note: 206 is valid
					font.color.rgb = icv[0].toString(16) + icv[1].toString(16) + icv[2].toString(16);
				} else if(y.theme) {
					font.color.theme = parseInt(y.theme, 10);
					if(y.tint) font.color.tint = parseFloat(y.tint);
					if(y.theme && themes.themeElements && themes.themeElements.clrScheme) {
						font.color.rgb = rgb_tint(themes.themeElements.clrScheme[font.color.theme].rgb, font.color.tint || 0);
					}
				}

				break;
			case '<color/>': case '</color>': case '</color': break;

			/* note: sometimes mc:AlternateContent appears bare */
			case '<AlternateContent': pass = true; break;
			case '</AlternateContent>': case '</AlternateContent': pass = false; break;

			/* 18.2.10 extLst CT_ExtensionList ? */
			case '<extLst': case '<extLst>': case '</extLst>': break;
			case '<ext': pass = true; break;
			case '</ext>': pass = false; break;
			default: if(opts && opts.WTF) {
				if(!pass) throw new Error('unrecognized ' + y[0] + ' in fonts');
			}
		}
	});
}

/* 18.8.31 numFmts CT_NumFmts */
function parse_numFmts(t, styles, opts) {
	styles.NumberFmt = [];
	var k/*Array<number>*/ = (keys(table_fmt));
	for(var i=0; i < k.length; ++i) styles.NumberFmt[k[i]] = table_fmt[k[i]];
	var m = t.match(tagregex);
	if(!m) return;
	for(i=0; i < m.length; ++i) {
		var y = parsexmltag(m[i]);
		switch(strip_ns(y[0])) {
			case '<numFmts': case '</numFmts>': case '<numFmts/>': case '<numFmts>': break;
			case '<numFmt': {
				var f=unescapexml(utf8read(y.formatCode)), j=parseInt(y.numFmtId,10);
				styles.NumberFmt[j] = f;
				if(j>0) {
					if(j > 0x188) {
						for(j = 0x188; j > 0x3c; --j) if(styles.NumberFmt[j] == null) break;
						styles.NumberFmt[j] = f;
					}
					SSF__load(f,j);
				}
			} break;
			case '</numFmt>': break;
			default: if(opts.WTF) throw new Error('unrecognized ' + y[0] + ' in numFmts');
		}
	}
}

function write_numFmts(NF) {
	var o = ["<numFmts>"];
	[[5,8],[23,26],[41,44],[/*63*/50,/*66],[164,*/392]].forEach(function(r) {
		for(var i = r[0]; i <= r[1]; ++i) if(NF[i] != null) o[o.length] = (writextag('numFmt',null,{numFmtId:i,formatCode:escapexml(NF[i])}));
	});
	if(o.length === 1) return "";
	o[o.length] = ("</numFmts>");
	o[0] = writextag('numFmts', null, { count:o.length-2 }).replace("/>", ">");
	return o.join("");
}

/* 18.8.10 cellXfs CT_CellXfs */
var cellXF_uint = [ "numFmtId", "fillId", "fontId", "borderId", "xfId" ];
var cellXF_bool = [ "applyAlignment", "applyBorder", "applyFill", "applyFont", "applyNumberFormat", "applyProtection", "pivotButton", "quotePrefix" ];
function parse_cellXfs(t, styles, opts) {
	styles.CellXf = [];
	var xf;
	var pass = false;
	(t.match(tagregex)||[]).forEach(function(x) {
		var y = parsexmltag(x), i = 0;
		switch(strip_ns(y[0])) {
			case '<cellXfs': case '<cellXfs>': case '<cellXfs/>': case '</cellXfs>': break;

			/* 18.8.45 xf CT_Xf */
			case '<xf': case '<xf/>': case '<xf>':
				xf = y;
				delete xf[0];
				for(i = 0; i < cellXF_uint.length; ++i) if(xf[cellXF_uint[i]])
					xf[cellXF_uint[i]] = parseInt(xf[cellXF_uint[i]], 10);
				for(i = 0; i < cellXF_bool.length; ++i) if(xf[cellXF_bool[i]])
					xf[cellXF_bool[i]] = parsexmlbool(xf[cellXF_bool[i]]);
				if(styles.NumberFmt && xf.numFmtId > 0x188) {
					for(i = 0x188; i > 0x3c; --i) if(styles.NumberFmt[xf.numFmtId] == styles.NumberFmt[i]) { xf.numFmtId = i; break; }
				}
				styles.CellXf.push(xf); break;
			case '</xf>': break;

			/* 18.8.1 alignment CT_CellAlignment */
			case '<alignment': case '<alignment/>': case '<alignment>':
				var alignment = {};
				if(y.vertical) alignment.vertical = y.vertical;
				if(y.horizontal) alignment.horizontal = y.horizontal;
				if(y.textRotation != null) alignment.textRotation = y.textRotation;
				if(y.indent) alignment.indent = y.indent;
				if(y.wrapText) alignment.wrapText = parsexmlbool(y.wrapText);
				xf.alignment = alignment;
				break;
			case '</alignment>': break;

			/* 18.8.33 protection CT_CellProtection */
			case '<protection': case '<protection>':
				break;
			case '</protection>': case '<protection/>': break;

			/* note: sometimes mc:AlternateContent appears bare */
			case '<AlternateContent': case '<AlternateContent>': pass = true; break;
			case '</AlternateContent>': pass = false; break;

			/* 18.2.10 extLst CT_ExtensionList ? */
			case '<extLst': case '<extLst>': case '</extLst>': break;
			case '<ext': pass = true; break;
			case '</ext>': pass = false; break;
			default: if(opts && opts.WTF) {
				if(!pass) throw new Error('unrecognized ' + y[0] + ' in cellXfs');
			}
		}
	});
}

function write_cellXfs(cellXfs) {
	var o = [];
	o[o.length] = (writextag('cellXfs',null));
	cellXfs.forEach(function(c) {
		o[o.length] = (writextag('xf', null, c));
	});
	o[o.length] = ("</cellXfs>");
	if(o.length === 2) return "";
	o[0] = writextag('cellXfs',null, {count:o.length-2}).replace("/>",">");
	return o.join("");
}

/* 18.8 Styles CT_Stylesheet*/
var parse_sty_xml= (function make_pstyx() {

return function parse_sty_xml(data, themes, opts) {
	var styles = {};
	if(!data) return styles;
	data = remove_doctype(str_remove_ng(data, "<!--", "-->"));
	/* 18.8.39 styleSheet CT_Stylesheet */
	var t;

	/* 18.8.31 numFmts CT_NumFmts ? */
	if((t=str_match_xml_ns(data, "numFmts"))) parse_numFmts(t[0], styles, opts);

	/* 18.8.23 fonts CT_Fonts ? */
	if((t=str_match_xml_ns(data, "fonts"))) parse_fonts(t[0], styles, themes, opts);

	/* 18.8.21 fills CT_Fills ? */
	if((t=str_match_xml_ns(data, "fills"))) parse_fills(t[0], styles, themes, opts);

	/* 18.8.5  borders CT_Borders ? */
	if((t=str_match_xml_ns(data, "borders"))) parse_borders(t[0], styles, themes, opts);

	/* 18.8.9  cellStyleXfs CT_CellStyleXfs ? */
	/* 18.8.8  cellStyles CT_CellStyles ? */

	/* 18.8.10 cellXfs CT_CellXfs ? */
	if((t=str_match_xml_ns(data, "cellXfs"))) parse_cellXfs(t[0], styles, opts);

	/* 18.8.15 dxfs CT_Dxfs ? */
	/* 18.8.42 tableStyles CT_TableStyles ? */
	/* 18.8.11 colors CT_Colors ? */
	/* 18.2.10 extLst CT_ExtensionList ? */

	return styles;
};
})();

function write_sty_xml(wb, opts) {
	var o = [XML_HEADER, writextag('styleSheet', null, {
		'xmlns': XMLNS_main[0],
		'xmlns:vt': XMLNS.vt
	})], w;
	if(wb.SSF && (w = write_numFmts(wb.SSF)) != null) o[o.length] = w;
	o[o.length] = ('<fonts count="1"><font><sz val="12"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>');
	o[o.length] = ('<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>');
	o[o.length] = ('<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>');
	o[o.length] = ('<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>');
	if((w = write_cellXfs(opts.cellXfs))) o[o.length] = (w);
	o[o.length] = ('<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>');
	o[o.length] = ('<dxfs count="0"/>');
	o[o.length] = ('<tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleMedium4"/>');

	if(o.length>2){ o[o.length] = ('</styleSheet>'); o[1]=o[1].replace("/>",">"); }
	return o.join("");
}
/* [MS-XLSB] 2.4.657 BrtFmt */
function parse_BrtFmt(data, length) {
	var numFmtId = data.read_shift(2);
	var stFmtCode = parse_XLWideString(data,length-2);
	return [numFmtId, stFmtCode];
}
function write_BrtFmt(i, f, o) {
	if(!o) o = new_buf(6 + 4 * f.length);
	o.write_shift(2, i);
	write_XLWideString(f, o);
	var out = (o.length > o.l) ? o.slice(0, o.l) : o;
	if(o.l == null) o.l = o.length;
	return out;
}

/* [MS-XLSB] 2.4.659 BrtFont TODO */
function parse_BrtFont(data, length, opts) {
	var out = ({});

	out.sz = data.read_shift(2) / 20;

	var grbit = parse_FontFlags(data, 2, opts);
	if(grbit.fItalic) out.italic = 1;
	if(grbit.fCondense) out.condense = 1;
	if(grbit.fExtend) out.extend = 1;
	if(grbit.fShadow) out.shadow = 1;
	if(grbit.fOutline) out.outline = 1;
	if(grbit.fStrikeout) out.strike = 1;

	var bls = data.read_shift(2);
	if(bls === 0x02BC) out.bold = 1;

	switch(data.read_shift(2)) {
		/* case 0: out.vertAlign = "baseline"; break; */
		case 1: out.vertAlign = "superscript"; break;
		case 2: out.vertAlign = "subscript"; break;
	}

	var underline = data.read_shift(1);
	if(underline != 0) out.underline = underline;

	var family = data.read_shift(1);
	if(family > 0) out.family = family;

	var bCharSet = data.read_shift(1);
	if(bCharSet > 0) out.charset = bCharSet;

	data.l++;
	out.color = parse_BrtColor(data, 8);

	switch(data.read_shift(1)) {
		/* case 0: out.scheme = "none": break; */
		case 1: out.scheme = "major"; break;
		case 2: out.scheme = "minor"; break;
	}

	out.name = parse_XLWideString(data, length - 21);

	return out;
}
function write_BrtFont(font, o) {
	if(!o) o = new_buf(25+4*32);
	o.write_shift(2, font.sz * 20);
	write_FontFlags(font, o);
	o.write_shift(2, font.bold ? 0x02BC : 0x0190);
	var sss = 0;
	if(font.vertAlign == "superscript") sss = 1;
	else if(font.vertAlign == "subscript") sss = 2;
	o.write_shift(2, sss);
	o.write_shift(1, font.underline || 0);
	o.write_shift(1, font.family || 0);
	o.write_shift(1, font.charset || 0);
	o.write_shift(1, 0);
	write_BrtColor(font.color, o);
	var scheme = 0;
	if(font.scheme == "major") scheme = 1;
	if(font.scheme == "minor") scheme = 2;
	o.write_shift(1, scheme);
	write_XLWideString(font.name, o);
	return o.length > o.l ? o.slice(0, o.l) : o;
}

/* [MS-XLSB] 2.4.650 BrtFill */
var XLSBFillPTNames = [
	"none",
	"solid",
	"mediumGray",
	"darkGray",
	"lightGray",
	"darkHorizontal",
	"darkVertical",
	"darkDown",
	"darkUp",
	"darkGrid",
	"darkTrellis",
	"lightHorizontal",
	"lightVertical",
	"lightDown",
	"lightUp",
	"lightGrid",
	"lightTrellis",
	"gray125",
	"gray0625"
];
var rev_XLSBFillPTNames;
/* TODO: gradient fill representation */
var parse_BrtFill = parsenoop;
function write_BrtFill(fill, o) {
	if(!o) o = new_buf(4*3 + 8*7 + 16*1);
	if(!rev_XLSBFillPTNames) rev_XLSBFillPTNames = (evert(XLSBFillPTNames));
	var fls = rev_XLSBFillPTNames[fill.patternType];
	if(fls == null) fls = 0x28;
	o.write_shift(4, fls);
	var j = 0;
	if(fls != 0x28) {
		/* TODO: custom FG Color */
		write_BrtColor({auto:1}, o);
		/* TODO: custom BG Color */
		write_BrtColor({auto:1}, o);

		for(; j < 12; ++j) o.write_shift(4, 0);
	} else {
		for(; j < 4; ++j) o.write_shift(4, 0);

		for(; j < 12; ++j) o.write_shift(4, 0); /* TODO */
		/* iGradientType */
		/* xnumDegree */
		/* xnumFillToLeft */
		/* xnumFillToRight */
		/* xnumFillToTop */
		/* xnumFillToBottom */
		/* cNumStop */
		/* xfillGradientStop */
	}
	return o.length > o.l ? o.slice(0, o.l) : o;
}

/* [MS-XLSB] 2.4.824 BrtXF */
function parse_BrtXF(data, length) {
	var tgt = data.l + length;
	var ixfeParent = data.read_shift(2);
	var ifmt = data.read_shift(2);
	data.l = tgt;
	return {ixfe:ixfeParent, numFmtId:ifmt };
}
function write_BrtXF(data, ixfeP, o) {
	if(!o) o = new_buf(16);
	o.write_shift(2, ixfeP||0);
	o.write_shift(2, data.numFmtId||0);
	o.write_shift(2, 0); /* iFont */
	o.write_shift(2, 0); /* iFill */
	o.write_shift(2, 0); /* ixBorder */
	o.write_shift(1, 0); /* trot */
	o.write_shift(1, 0); /* indent */
	var flow = 0;
	o.write_shift(1, flow); /* flags */
	o.write_shift(1, 0); /* flags */
	o.write_shift(1, 0); /* xfGrbitAtr */
	o.write_shift(1, 0);
	return o;
}

/* [MS-XLSB] 2.5.4 Blxf TODO */
function write_Blxf(data, o) {
	if(!o) o = new_buf(10);
	o.write_shift(1, 0); /* dg */
	o.write_shift(1, 0);
	o.write_shift(4, 0); /* color */
	o.write_shift(4, 0); /* color */
	return o;
}
/* [MS-XLSB] 2.4.302 BrtBorder TODO */
var parse_BrtBorder = parsenoop;
function write_BrtBorder(border, o) {
	if(!o) o = new_buf(51);
	o.write_shift(1, 0); /* diagonal */
	write_Blxf(null, o); /* top */
	write_Blxf(null, o); /* bottom */
	write_Blxf(null, o); /* left */
	write_Blxf(null, o); /* right */
	write_Blxf(null, o); /* diag */
	return o.length > o.l ? o.slice(0, o.l) : o;
}

/* [MS-XLSB] 2.4.763 BrtStyle TODO */
function write_BrtStyle(style, o) {
	if(!o) o = new_buf(12+4*10);
	o.write_shift(4, style.xfId);
	o.write_shift(2, 1);
	o.write_shift(1, +style.builtinId);
	o.write_shift(1, 0); /* iLevel */
	write_XLNullableWideString(style.name || "", o);
	return o.length > o.l ? o.slice(0, o.l) : o;
}

/* [MS-XLSB] 2.4.272 BrtBeginTableStyles */
function write_BrtBeginTableStyles(cnt, defTableStyle, defPivotStyle) {
	var o = new_buf(4+256*2*4);
	o.write_shift(4, cnt);
	write_XLNullableWideString(defTableStyle, o);
	write_XLNullableWideString(defPivotStyle, o);
	return o.length > o.l ? o.slice(0, o.l) : o;
}

/* [MS-XLSB] 2.1.7.50 Styles */
function parse_sty_bin(data, themes, opts) {
	var styles = {};
	styles.NumberFmt = ([]);
	for(var y in table_fmt) styles.NumberFmt[y] = table_fmt[y];

	styles.CellXf = [];
	styles.Fonts = [];
	var state = [];
	var pass = false;
	recordhopper(data, function hopper_sty(val, R, RT) {
		switch(RT) {
			case 0x002C: /* BrtFmt */
				styles.NumberFmt[val[0]] = val[1]; SSF__load(val[1], val[0]);
				break;
			case 0x002B: /* BrtFont */
				styles.Fonts.push(val);
				if(val.color.theme != null && themes && themes.themeElements && themes.themeElements.clrScheme) {
					val.color.rgb = rgb_tint(themes.themeElements.clrScheme[val.color.theme].rgb, val.color.tint || 0);
				}
				break;
			case 0x0401: /* BrtKnownFonts */ break;
			case 0x002D: /* BrtFill */
				break;
			case 0x002E: /* BrtBorder */
				break;
			case 0x002F: /* BrtXF */
				if(state[state.length - 1] == 0x0269 /* BrtBeginCellXFs */) {
					styles.CellXf.push(val);
				}
				break;
			case 0x0030: /* BrtStyle */
			case 0x01FB: /* BrtDXF */
			case 0x023C: /* BrtMRUColor */
			case 0x01DB: /* BrtIndexedColor */
				break;

			case 0x0493: /* BrtDXF14 */
			case 0x0836: /* BrtDXF15 */
			case 0x046A: /* BrtSlicerStyleElement */
			case 0x0200: /* BrtTableStyleElement */
			case 0x082F: /* BrtTimelineStyleElement */
			case 0x0C00: /* BrtUid */
				break;

			case 0x0023: /* BrtFRTBegin */
				pass = true; break;
			case 0x0024: /* BrtFRTEnd */
				pass = false; break;
			case 0x0025: /* BrtACBegin */
				state.push(RT); pass = true; break;
			case 0x0026: /* BrtACEnd */
				state.pop(); pass = false; break;

			default:
				if(R.T > 0) state.push(RT);
				else if(R.T < 0) state.pop();
				else if(!pass || (opts.WTF && state[state.length-1] != 0x0025 /* BrtACBegin */)) throw new Error("Unexpected record 0x" + RT.toString(16));
		}
	});
	return styles;
}

function write_FMTS_bin(ba, NF) {
	if(!NF) return;
	var cnt = 0;
	[[5,8],[23,26],[41,44],[/*63*/50,/*66],[164,*/392]].forEach(function(r) {
for(var i = r[0]; i <= r[1]; ++i) if(NF[i] != null) ++cnt;
	});

	if(cnt == 0) return;
	write_record(ba, 0x0267 /* BrtBeginFmts */, write_UInt32LE(cnt));
	[[5,8],[23,26],[41,44],[/*63*/50,/*66],[164,*/392]].forEach(function(r) {
for(var i = r[0]; i <= r[1]; ++i) if(NF[i] != null) write_record(ba, 0x002C /* BrtFmt */, write_BrtFmt(i, NF[i]));
	});
	write_record(ba, 0x0268 /* BrtEndFmts */);
}

function write_FONTS_bin(ba) {
	var cnt = 1;

	if(cnt == 0) return;
	write_record(ba, 0x0263 /* BrtBeginFonts */, write_UInt32LE(cnt));
	write_record(ba, 0x002B /* BrtFont */, write_BrtFont({
		sz:12,
		color: {theme:1},
		name: "Calibri",
		family: 2,
		scheme: "minor"
	}));
	/* 1*65491BrtFont [ACFONTS] */
	write_record(ba, 0x0264 /* BrtEndFonts */);
}

function write_FILLS_bin(ba) {
	var cnt = 2;

	if(cnt == 0) return;
	write_record(ba, 0x025B /* BrtBeginFills */, write_UInt32LE(cnt));
	write_record(ba, 0x002D /* BrtFill */, write_BrtFill({patternType:"none"}));
	write_record(ba, 0x002D /* BrtFill */, write_BrtFill({patternType:"gray125"}));
	/* 1*65431BrtFill */
	write_record(ba, 0x025C /* BrtEndFills */);
}

function write_BORDERS_bin(ba) {
	var cnt = 1;

	if(cnt == 0) return;
	write_record(ba, 0x0265 /* BrtBeginBorders */, write_UInt32LE(cnt));
	write_record(ba, 0x002E /* BrtBorder */, write_BrtBorder({}));
	/* 1*65430BrtBorder */
	write_record(ba, 0x0266 /* BrtEndBorders */);
}

function write_CELLSTYLEXFS_bin(ba) {
	var cnt = 1;
	write_record(ba, 0x0272 /* BrtBeginCellStyleXFs */, write_UInt32LE(cnt));
	write_record(ba, 0x002F /* BrtXF */, write_BrtXF({
		numFmtId: 0,
		fontId:   0,
		fillId:   0,
		borderId: 0
	}, 0xFFFF));
	/* 1*65430(BrtXF *FRT) */
	write_record(ba, 0x0273 /* BrtEndCellStyleXFs */);
}

function write_CELLXFS_bin(ba, data) {
	write_record(ba, 0x0269 /* BrtBeginCellXFs */, write_UInt32LE(data.length));
	data.forEach(function(c) { write_record(ba, 0x002F /* BrtXF */, write_BrtXF(c,0)); });
	/* 1*65430(BrtXF *FRT) */
	write_record(ba, 0x026A /* BrtEndCellXFs */);
}

function write_STYLES_bin(ba) {
	var cnt = 1;

	write_record(ba, 0x026B /* BrtBeginStyles */, write_UInt32LE(cnt));
	write_record(ba, 0x0030 /* BrtStyle */, write_BrtStyle({
		xfId:0,
		builtinId:0,
		name:"Normal"
	}));
	/* 1*65430(BrtStyle *FRT) */
	write_record(ba, 0x026C /* BrtEndStyles */);
}

function write_DXFS_bin(ba) {
	var cnt = 0;

	write_record(ba, 0x01F9 /* BrtBeginDXFs */, write_UInt32LE(cnt));
	/* *2147483647(BrtDXF *FRT) */
	write_record(ba, 0x01FA /* BrtEndDXFs */);
}

function write_TABLESTYLES_bin(ba) {
	var cnt = 0;

	write_record(ba, 0x01FC /* BrtBeginTableStyles */, write_BrtBeginTableStyles(cnt, "TableStyleMedium9", "PivotStyleMedium4"));
	/* *TABLESTYLE */
	write_record(ba, 0x01FD /* BrtEndTableStyles */);
}

function write_COLORPALETTE_bin() {
	return;
	/* BrtBeginColorPalette [INDEXEDCOLORS] [MRUCOLORS] BrtEndColorPalette */
}

/* [MS-XLSB] 2.1.7.50 Styles */
function write_sty_bin(wb, opts) {
	var ba = buf_array();
	write_record(ba, 0x0116 /* BrtBeginStyleSheet */);
	write_FMTS_bin(ba, wb.SSF);
	write_FONTS_bin(ba, wb);
	write_FILLS_bin(ba, wb);
	write_BORDERS_bin(ba, wb);
	write_CELLSTYLEXFS_bin(ba, wb);
	write_CELLXFS_bin(ba, opts.cellXfs);
	write_STYLES_bin(ba, wb);
	write_DXFS_bin(ba, wb);
	write_TABLESTYLES_bin(ba, wb);
	write_COLORPALETTE_bin(ba, wb);
	/* FRTSTYLESHEET*/
	write_record(ba, 0x0117 /* BrtEndStyleSheet */);
	return ba.end();
}
/* Even though theme layout is dk1 lt1 dk2 lt2, true order is lt1 dk1 lt2 dk2 */
var XLSXThemeClrScheme = [
	'</a:lt1>', '</a:dk1>', '</a:lt2>', '</a:dk2>',
	'</a:accent1>', '</a:accent2>', '</a:accent3>',
	'</a:accent4>', '</a:accent5>', '</a:accent6>',
	'</a:hlink>', '</a:folHlink>'
];
/* 20.1.6.2 clrScheme CT_ColorScheme */
function parse_clrScheme(t, themes, opts) {
	themes.themeElements.clrScheme = [];
	var color = {};
	(t[0].match(tagregex)||[]).forEach(function(x) {
		var y = parsexmltag(x);
		switch(y[0]) {
			/* 20.1.6.2 clrScheme (Color Scheme) CT_ColorScheme */
			case '<a:clrScheme': case '</a:clrScheme>': break;

			/* 20.1.2.3.32 srgbClr CT_SRgbColor */
			case '<a:srgbClr':
				color.rgb = y.val; break;
			case '</a:srgbClr>': break;

			/* 20.1.2.3.33 sysClr CT_SystemColor */
			case '<a:sysClr':
				color.rgb = y.lastClr; break;
			case '</a:sysClr>': break;

			/* 20.1.4.1.1 accent1 (Accent 1) */
			/* 20.1.4.1.2 accent2 (Accent 2) */
			/* 20.1.4.1.3 accent3 (Accent 3) */
			/* 20.1.4.1.4 accent4 (Accent 4) */
			/* 20.1.4.1.5 accent5 (Accent 5) */
			/* 20.1.4.1.6 accent6 (Accent 6) */
			/* 20.1.4.1.9 dk1 (Dark 1) */
			/* 20.1.4.1.10 dk2 (Dark 2) */
			/* 20.1.4.1.15 folHlink (Followed Hyperlink) */
			/* 20.1.4.1.19 hlink (Hyperlink) */
			/* 20.1.4.1.22 lt1 (Light 1) */
			/* 20.1.4.1.23 lt2 (Light 2) */
			case '</a:dk1>':
			case '</a:lt1>':
			case '<a:dk1>':
			case '<a:lt1>':
			case '<a:dk2>': case '</a:dk2>':
			case '<a:lt2>': case '</a:lt2>':
			case '<a:accent1>': case '</a:accent1>':
			case '<a:accent2>': case '</a:accent2>':
			case '<a:accent3>': case '</a:accent3>':
			case '<a:accent4>': case '</a:accent4>':
			case '<a:accent5>': case '</a:accent5>':
			case '<a:accent6>': case '</a:accent6>':
			case '<a:hlink>': case '</a:hlink>':
			case '<a:folHlink>': case '</a:folHlink>':
				if (y[0].charAt(1) === '/') {
					themes.themeElements.clrScheme[XLSXThemeClrScheme.indexOf(y[0])] = color;
					color = {};
				} else {
					color.name = y[0].slice(3, y[0].length - 1);
				}
				break;

			default: if(opts && opts.WTF) throw new Error('Unrecognized ' + y[0] + ' in clrScheme');
		}
	});
}

/* 20.1.4.1.18 fontScheme CT_FontScheme */
function parse_fontScheme() { }

/* 20.1.4.1.15 fmtScheme CT_StyleMatrix */
function parse_fmtScheme() { }

/* 20.1.6.10 themeElements CT_BaseStyles */
function parse_themeElements(data, themes, opts) {
	themes.themeElements = {};

	var t;

	/* clrScheme CT_ColorScheme */
	if(!(t=str_match_xml(data, "a:clrScheme"))) throw new Error('clrScheme not found in themeElements');
	parse_clrScheme(t, themes, opts);

	/* fontScheme CT_FontScheme */
	if(!(t=str_match_xml(data, "a:fontScheme"))) throw new Error('fontScheme not found in themeElements');
	parse_fontScheme(t, themes, opts);

	/* fmtScheme CT_StyleMatrix */
	if(!(t=str_match_xml(data, "a:fmtScheme"))) throw new Error('fmtScheme not found in themeElements');
	parse_fmtScheme(t, themes, opts);
}

/* 14.2.7 Theme Part */
function parse_theme_xml(data, opts) {
	/* 20.1.6.9 theme CT_OfficeStyleSheet */
	if(!data || data.length === 0) data = write_theme();

	var t;
	var themes = {};

	/* themeElements CT_BaseStyles */
	if(!(t=str_match_xml(data, "a:themeElements"))) throw new Error('themeElements not found in theme');
	parse_themeElements(t[0], themes, opts);
	themes.raw = data;
	return themes;
}

function write_theme(Themes, opts) {
	if(opts && opts.themeXLSX) return opts.themeXLSX;
	if(Themes && typeof Themes.raw == "string") return Themes.raw;
	var o = [XML_HEADER];
	o[o.length] = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">';
	o[o.length] =  '<a:themeElements>';

	o[o.length] =   '<a:clrScheme name="Office">';
	o[o.length] =    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>';
	o[o.length] =    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>';
	o[o.length] =    '<a:dk2><a:srgbClr val="1F497D"/></a:dk2>';
	o[o.length] =    '<a:lt2><a:srgbClr val="EEECE1"/></a:lt2>';
	o[o.length] =    '<a:accent1><a:srgbClr val="4F81BD"/></a:accent1>';
	o[o.length] =    '<a:accent2><a:srgbClr val="C0504D"/></a:accent2>';
	o[o.length] =    '<a:accent3><a:srgbClr val="9BBB59"/></a:accent3>';
	o[o.length] =    '<a:accent4><a:srgbClr val="8064A2"/></a:accent4>';
	o[o.length] =    '<a:accent5><a:srgbClr val="4BACC6"/></a:accent5>';
	o[o.length] =    '<a:accent6><a:srgbClr val="F79646"/></a:accent6>';
	o[o.length] =    '<a:hlink><a:srgbClr val="0000FF"/></a:hlink>';
	o[o.length] =    '<a:folHlink><a:srgbClr val="800080"/></a:folHlink>';
	o[o.length] =   '</a:clrScheme>';

	o[o.length] =   '<a:fontScheme name="Office">';
	o[o.length] =    '<a:majorFont>';
	o[o.length] =     '<a:latin typeface="Cambria"/>';
	o[o.length] =     '<a:ea typeface=""/>';
	o[o.length] =     '<a:cs typeface=""/>';
	o[o.length] =     '<a:font script="Jpan" typeface="ＭＳ Ｐゴシック"/>';
	o[o.length] =     '<a:font script="Hang" typeface="맑은 고딕"/>';
	o[o.length] =     '<a:font script="Hans" typeface="宋体"/>';
	o[o.length] =     '<a:font script="Hant" typeface="新細明體"/>';
	o[o.length] =     '<a:font script="Arab" typeface="Times New Roman"/>';
	o[o.length] =     '<a:font script="Hebr" typeface="Times New Roman"/>';
	o[o.length] =     '<a:font script="Thai" typeface="Tahoma"/>';
	o[o.length] =     '<a:font script="Ethi" typeface="Nyala"/>';
	o[o.length] =     '<a:font script="Beng" typeface="Vrinda"/>';
	o[o.length] =     '<a:font script="Gujr" typeface="Shruti"/>';
	o[o.length] =     '<a:font script="Khmr" typeface="MoolBoran"/>';
	o[o.length] =     '<a:font script="Knda" typeface="Tunga"/>';
	o[o.length] =     '<a:font script="Guru" typeface="Raavi"/>';
	o[o.length] =     '<a:font script="Cans" typeface="Euphemia"/>';
	o[o.length] =     '<a:font script="Cher" typeface="Plantagenet Cherokee"/>';
	o[o.length] =     '<a:font script="Yiii" typeface="Microsoft Yi Baiti"/>';
	o[o.length] =     '<a:font script="Tibt" typeface="Microsoft Himalaya"/>';
	o[o.length] =     '<a:font script="Thaa" typeface="MV Boli"/>';
	o[o.length] =     '<a:font script="Deva" typeface="Mangal"/>';
	o[o.length] =     '<a:font script="Telu" typeface="Gautami"/>';
	o[o.length] =     '<a:font script="Taml" typeface="Latha"/>';
	o[o.length] =     '<a:font script="Syrc" typeface="Estrangelo Edessa"/>';
	o[o.length] =     '<a:font script="Orya" typeface="Kalinga"/>';
	o[o.length] =     '<a:font script="Mlym" typeface="Kartika"/>';
	o[o.length] =     '<a:font script="Laoo" typeface="DokChampa"/>';
	o[o.length] =     '<a:font script="Sinh" typeface="Iskoola Pota"/>';
	o[o.length] =     '<a:font script="Mong" typeface="Mongolian Baiti"/>';
	o[o.length] =     '<a:font script="Viet" typeface="Times New Roman"/>';
	o[o.length] =     '<a:font script="Uigh" typeface="Microsoft Uighur"/>';
	o[o.length] =     '<a:font script="Geor" typeface="Sylfaen"/>';
	o[o.length] =    '</a:majorFont>';
	o[o.length] =    '<a:minorFont>';
	o[o.length] =     '<a:latin typeface="Calibri"/>';
	o[o.length] =     '<a:ea typeface=""/>';
	o[o.length] =     '<a:cs typeface=""/>';
	o[o.length] =     '<a:font script="Jpan" typeface="ＭＳ Ｐゴシック"/>';
	o[o.length] =     '<a:font script="Hang" typeface="맑은 고딕"/>';
	o[o.length] =     '<a:font script="Hans" typeface="宋体"/>';
	o[o.length] =     '<a:font script="Hant" typeface="新細明體"/>';
	o[o.length] =     '<a:font script="Arab" typeface="Arial"/>';
	o[o.length] =     '<a:font script="Hebr" typeface="Arial"/>';
	o[o.length] =     '<a:font script="Thai" typeface="Tahoma"/>';
	o[o.length] =     '<a:font script="Ethi" typeface="Nyala"/>';
	o[o.length] =     '<a:font script="Beng" typeface="Vrinda"/>';
	o[o.length] =     '<a:font script="Gujr" typeface="Shruti"/>';
	o[o.length] =     '<a:font script="Khmr" typeface="DaunPenh"/>';
	o[o.length] =     '<a:font script="Knda" typeface="Tunga"/>';
	o[o.length] =     '<a:font script="Guru" typeface="Raavi"/>';
	o[o.length] =     '<a:font script="Cans" typeface="Euphemia"/>';
	o[o.length] =     '<a:font script="Cher" typeface="Plantagenet Cherokee"/>';
	o[o.length] =     '<a:font script="Yiii" typeface="Microsoft Yi Baiti"/>';
	o[o.length] =     '<a:font script="Tibt" typeface="Microsoft Himalaya"/>';
	o[o.length] =     '<a:font script="Thaa" typeface="MV Boli"/>';
	o[o.length] =     '<a:font script="Deva" typeface="Mangal"/>';
	o[o.length] =     '<a:font script="Telu" typeface="Gautami"/>';
	o[o.length] =     '<a:font script="Taml" typeface="Latha"/>';
	o[o.length] =     '<a:font script="Syrc" typeface="Estrangelo Edessa"/>';
	o[o.length] =     '<a:font script="Orya" typeface="Kalinga"/>';
	o[o.length] =     '<a:font script="Mlym" typeface="Kartika"/>';
	o[o.length] =     '<a:font script="Laoo" typeface="DokChampa"/>';
	o[o.length] =     '<a:font script="Sinh" typeface="Iskoola Pota"/>';
	o[o.length] =     '<a:font script="Mong" typeface="Mongolian Baiti"/>';
	o[o.length] =     '<a:font script="Viet" typeface="Arial"/>';
	o[o.length] =     '<a:font script="Uigh" typeface="Microsoft Uighur"/>';
	o[o.length] =     '<a:font script="Geor" typeface="Sylfaen"/>';
	o[o.length] =    '</a:minorFont>';
	o[o.length] =   '</a:fontScheme>';

	o[o.length] =   '<a:fmtScheme name="Office">';
	o[o.length] =    '<a:fillStyleLst>';
	o[o.length] =     '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
	o[o.length] =     '<a:gradFill rotWithShape="1">';
	o[o.length] =      '<a:gsLst>';
	o[o.length] =       '<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:gs>';
	o[o.length] =       '<a:gs pos="35000"><a:schemeClr val="phClr"><a:tint val="37000"/><a:satMod val="300000"/></a:schemeClr></a:gs>';
	o[o.length] =       '<a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="15000"/><a:satMod val="350000"/></a:schemeClr></a:gs>';
	o[o.length] =      '</a:gsLst>';
	o[o.length] =      '<a:lin ang="16200000" scaled="1"/>';
	o[o.length] =     '</a:gradFill>';
	o[o.length] =     '<a:gradFill rotWithShape="1">';
	o[o.length] =      '<a:gsLst>';
	o[o.length] =       '<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="100000"/><a:shade val="100000"/><a:satMod val="130000"/></a:schemeClr></a:gs>';
	o[o.length] =       '<a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="50000"/><a:shade val="100000"/><a:satMod val="350000"/></a:schemeClr></a:gs>';
	o[o.length] =      '</a:gsLst>';
	o[o.length] =      '<a:lin ang="16200000" scaled="0"/>';
	o[o.length] =     '</a:gradFill>';
	o[o.length] =    '</a:fillStyleLst>';
	o[o.length] =    '<a:lnStyleLst>';
	o[o.length] =     '<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"><a:shade val="95000"/><a:satMod val="105000"/></a:schemeClr></a:solidFill><a:prstDash val="solid"/></a:ln>';
	o[o.length] =     '<a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>';
	o[o.length] =     '<a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>';
	o[o.length] =    '</a:lnStyleLst>';
	o[o.length] =    '<a:effectStyleLst>';
	o[o.length] =     '<a:effectStyle>';
	o[o.length] =      '<a:effectLst>';
	o[o.length] =       '<a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw>';
	o[o.length] =      '</a:effectLst>';
	o[o.length] =     '</a:effectStyle>';
	o[o.length] =     '<a:effectStyle>';
	o[o.length] =      '<a:effectLst>';
	o[o.length] =       '<a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw>';
	o[o.length] =      '</a:effectLst>';
	o[o.length] =     '</a:effectStyle>';
	o[o.length] =     '<a:effectStyle>';
	o[o.length] =      '<a:effectLst>';
	o[o.length] =       '<a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw>';
	o[o.length] =      '</a:effectLst>';
	o[o.length] =      '<a:scene3d><a:camera prst="orthographicFront"><a:rot lat="0" lon="0" rev="0"/></a:camera><a:lightRig rig="threePt" dir="t"><a:rot lat="0" lon="0" rev="1200000"/></a:lightRig></a:scene3d>';
	o[o.length] =      '<a:sp3d><a:bevelT w="63500" h="25400"/></a:sp3d>';
	o[o.length] =     '</a:effectStyle>';
	o[o.length] =    '</a:effectStyleLst>';
	o[o.length] =    '<a:bgFillStyleLst>';
	o[o.length] =     '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
	o[o.length] =     '<a:gradFill rotWithShape="1">';
	o[o.length] =      '<a:gsLst>';
	o[o.length] =       '<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="40000"/><a:satMod val="350000"/></a:schemeClr></a:gs>';
	o[o.length] =       '<a:gs pos="40000"><a:schemeClr val="phClr"><a:tint val="45000"/><a:shade val="99000"/><a:satMod val="350000"/></a:schemeClr></a:gs>';
	o[o.length] =       '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="20000"/><a:satMod val="255000"/></a:schemeClr></a:gs>';
	o[o.length] =      '</a:gsLst>';
	o[o.length] =      '<a:path path="circle"><a:fillToRect l="50000" t="-80000" r="50000" b="180000"/></a:path>';
	o[o.length] =     '</a:gradFill>';
	o[o.length] =     '<a:gradFill rotWithShape="1">';
	o[o.length] =      '<a:gsLst>';
	o[o.length] =       '<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="80000"/><a:satMod val="300000"/></a:schemeClr></a:gs>';
	o[o.length] =       '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="30000"/><a:satMod val="200000"/></a:schemeClr></a:gs>';
	o[o.length] =      '</a:gsLst>';
	o[o.length] =      '<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>';
	o[o.length] =     '</a:gradFill>';
	o[o.length] =    '</a:bgFillStyleLst>';
	o[o.length] =   '</a:fmtScheme>';
	o[o.length] =  '</a:themeElements>';

	o[o.length] =  '<a:objectDefaults>';
	o[o.length] =   '<a:spDef>';
	o[o.length] =    '<a:spPr/><a:bodyPr/><a:lstStyle/><a:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="3"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="2"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></a:style>';
	o[o.length] =   '</a:spDef>';
	o[o.length] =   '<a:lnDef>';
	o[o.length] =    '<a:spPr/><a:bodyPr/><a:lstStyle/><a:style><a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="1"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></a:style>';
	o[o.length] =   '</a:lnDef>';
	o[o.length] =  '</a:objectDefaults>';
	o[o.length] =  '<a:extraClrSchemeLst/>';
	o[o.length] = '</a:theme>';
	return o.join("");
}
/* [MS-XLS] 2.4.326 TODO: payload is a zip file */
function parse_Theme(blob, length, opts) {
	var end = blob.l + length;
	var dwThemeVersion = blob.read_shift(4);
	if(dwThemeVersion === 124226) return;
	if(!opts.cellStyles) { blob.l = end; return; }
	var data = blob.slice(blob.l);
	blob.l = end;
	var zip; try { zip = zip_read(data, {type: "array"}); } catch(e) { return; }
	var themeXML = getzipstr(zip, "theme/theme/theme1.xml", true);
	if(!themeXML) return;
	return parse_theme_xml(themeXML, opts);
}

/* 2.5.49 */
function parse_ColorTheme(blob) { return blob.read_shift(4); }

/* 2.5.155 */
function parse_FullColorExt(blob) {
	var o = {};
	o.xclrType = blob.read_shift(2);
	o.nTintShade = blob.read_shift(2);
	switch(o.xclrType) {
		case 0: blob.l += 4; break;
		case 1: o.xclrValue = parse_IcvXF(blob, 4); break;
		case 2: o.xclrValue = parse_LongRGBA(blob, 4); break;
		case 3: o.xclrValue = parse_ColorTheme(blob, 4); break;
		case 4: blob.l += 4; break;
	}
	blob.l += 8;
	return o;
}

/* 2.5.164 TODO: read 7 bits*/
function parse_IcvXF(blob, length) {
	return parsenoop(blob, length);
}

/* 2.5.280 */
function parse_XFExtGradient(blob, length) {
	return parsenoop(blob, length);
}

/* [MS-XLS] 2.5.108 */
function parse_ExtProp(blob) {
	var extType = blob.read_shift(2);
	var cb = blob.read_shift(2) - 4;
	var o = [extType];
	switch(extType) {
		case 0x04: case 0x05: case 0x07: case 0x08:
		case 0x09: case 0x0A: case 0x0B: case 0x0D:
			o[1] = parse_FullColorExt(blob, cb); break;
		case 0x06: o[1] = parse_XFExtGradient(blob, cb); break;
		case 0x0E: case 0x0F: o[1] = blob.read_shift(cb === 1 ? 1 : 2); break;
		default: throw new Error("Unrecognized ExtProp type: " + extType + " " + cb);
	}
	return o;
}

/* 2.4.355 */
function parse_XFExt(blob, length) {
	var end = blob.l + length;
	blob.l += 2;
	var ixfe = blob.read_shift(2);
	blob.l += 2;
	var cexts = blob.read_shift(2);
	var ext = [];
	while(cexts-- > 0) ext.push(parse_ExtProp(blob, end-blob.l));
	return {ixfe:ixfe, ext:ext};
}

/* xf is an XF, see parse_XFExt for xfext */
function update_xfext(xf, xfext) {
	xfext.forEach(function(xfe) {
		switch(xfe[0]) { /* 2.5.108 extPropData */
			case 0x04: break; /* foreground color */
			case 0x05: break; /* background color */
			case 0x06: break; /* gradient fill */
			case 0x07: break; /* top cell border color */
			case 0x08: break; /* bottom cell border color */
			case 0x09: break; /* left cell border color */
			case 0x0a: break; /* right cell border color */
			case 0x0b: break; /* diagonal cell border color */
			case 0x0d: /* text color */
				break;
			case 0x0e: break; /* font scheme */
			case 0x0f: break; /* indentation level */
		}
	});
}

function parse_BrtMdtinfo(data, length) {
  return {
    flags: data.read_shift(4),
    version: data.read_shift(4),
    name: parse_XLWideString(data, length - 8)
  };
}
function write_BrtMdtinfo(data) {
  var o = new_buf(12 + 2 * data.name.length);
  o.write_shift(4, data.flags);
  o.write_shift(4, data.version);
  write_XLWideString(data.name, o);
  return o.slice(0, o.l);
}
function parse_BrtMdb(data) {
  var out = [];
  var cnt = data.read_shift(4);
  while (cnt-- > 0)
    out.push([data.read_shift(4), data.read_shift(4)]);
  return out;
}
function write_BrtMdb(mdb) {
  var o = new_buf(4 + 8 * mdb.length);
  o.write_shift(4, mdb.length);
  for (var i = 0; i < mdb.length; ++i) {
    o.write_shift(4, mdb[i][0]);
    o.write_shift(4, mdb[i][1]);
  }
  return o;
}
function write_BrtBeginEsfmd(cnt, name) {
  var o = new_buf(8 + 2 * name.length);
  o.write_shift(4, cnt);
  write_XLWideString(name, o);
  return o.slice(0, o.l);
}
function parse_BrtBeginEsmdb(data) {
  data.l += 4;
  return data.read_shift(4) != 0;
}
function write_BrtBeginEsmdb(cnt, cm) {
  var o = new_buf(8);
  o.write_shift(4, cnt);
  o.write_shift(4, cm ? 1 : 0);
  return o;
}
function parse_xlmeta_bin(data, name, _opts) {
  var out = { Types: [], Cell: [], Value: [] };
  var opts = _opts || {};
  var state = [];
  var pass = false;
  var metatype = 2;
  recordhopper(data, function(val, R, RT) {
    switch (RT) {
      case 335:
        out.Types.push({ name: val.name });
        break;
      case 51:
        val.forEach(function(r) {
          if (metatype == 1)
            out.Cell.push({ type: out.Types[r[0] - 1].name, index: r[1] });
          else if (metatype == 0)
            out.Value.push({ type: out.Types[r[0] - 1].name, index: r[1] });
        });
        break;
      case 337:
        metatype = val ? 1 : 0;
        break;
      case 338:
        metatype = 2;
        break;
      case 35:
        state.push(RT);
        pass = true;
        break;
      case 36:
        state.pop();
        pass = false;
        break;
      default:
        if (R.T) {
        } else if (!pass || opts.WTF && state[state.length - 1] != 35)
          throw new Error("Unexpected record 0x" + RT.toString(16));
    }
  });
  return out;
}
function write_xlmeta_bin() {
  var ba = buf_array();
  write_record(ba, 332);
  write_record(ba, 334, write_UInt32LE(1));
  write_record(ba, 335, write_BrtMdtinfo({
    name: "XLDAPR",
    version: 12e4,
    flags: 3496657072
  }));
  write_record(ba, 336);
  write_record(ba, 339, write_BrtBeginEsfmd(1, "XLDAPR"));
  write_record(ba, 52);
  write_record(ba, 35, write_UInt32LE(514));
  write_record(ba, 4096, write_UInt32LE(0));
  write_record(ba, 4097, writeuint16(1));
  write_record(ba, 36);
  write_record(ba, 53);
  write_record(ba, 340);
  write_record(ba, 337, write_BrtBeginEsmdb(1, true));
  write_record(ba, 51, write_BrtMdb([[1, 0]]));
  write_record(ba, 338);
  write_record(ba, 333);
  return ba.end();
}
function parse_xlmeta_xml(data, name, opts) {
  var out = { Types: [], Cell: [], Value: [] };
  if (!data)
    return out;
  var pass = false;
  var metatype = 2;
  var lastmeta;
  data.replace(tagregex, function(x) {
    var y = parsexmltag(x);
    switch (strip_ns(y[0])) {
      case "<?xml":
        break;
      case "<metadata":
      case "</metadata>":
        break;
      case "<metadataTypes":
      case "</metadataTypes>":
        break;
      case "<metadataType":
        out.Types.push({ name: y.name });
        break;
      case "</metadataType>":
        break;
      case "<futureMetadata":
        for (var j = 0; j < out.Types.length; ++j)
          if (out.Types[j].name == y.name)
            lastmeta = out.Types[j];
        break;
      case "</futureMetadata>":
        break;
      case "<bk>":
        break;
      case "</bk>":
        break;
      case "<rc":
        if (metatype == 1)
          out.Cell.push({ type: out.Types[y.t - 1].name, index: +y.v });
        else if (metatype == 0)
          out.Value.push({ type: out.Types[y.t - 1].name, index: +y.v });
        break;
      case "</rc>":
        break;
      case "<cellMetadata":
        metatype = 1;
        break;
      case "</cellMetadata>":
        metatype = 2;
        break;
      case "<valueMetadata":
        metatype = 0;
        break;
      case "</valueMetadata>":
        metatype = 2;
        break;
      case "<extLst":
      case "<extLst>":
      case "</extLst>":
      case "<extLst/>":
        break;
      case "<ext":
        pass = true;
        break;
      case "</ext>":
        pass = false;
        break;
      case "<rvb":
        if (!lastmeta)
          break;
        if (!lastmeta.offsets)
          lastmeta.offsets = [];
        lastmeta.offsets.push(+y.i);
        break;
      default:
        if (!pass && (opts == null ? void 0 : opts.WTF))
          throw new Error("unrecognized " + y[0] + " in metadata");
    }
    return x;
  });
  return out;
}
function write_xlmeta_xml() {
  var o = [XML_HEADER];
  o.push('<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray">\n  <metadataTypes count="1">\n    <metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/>\n  </metadataTypes>\n  <futureMetadata name="XLDAPR" count="1">\n    <bk>\n      <extLst>\n        <ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}">\n          <xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/>\n        </ext>\n      </extLst>\n    </bk>\n  </futureMetadata>\n  <cellMetadata count="1">\n    <bk>\n      <rc t="1" v="0"/>\n    </bk>\n  </cellMetadata>\n</metadata>');
  return o.join("");
}
/* 18.6 Calculation Chain */
function parse_cc_xml(data) {
	var d = [];
	if(!data) return d;
	var i = 1;
	(data.match(tagregex)||[]).forEach(function(x) {
		var y = parsexmltag(x);
		switch(y[0]) {
			case '<?xml': break;
			/* 18.6.2  calcChain CT_CalcChain 1 */
			case '<calcChain': case '<calcChain>': case '</calcChain>': break;
			/* 18.6.1  c CT_CalcCell 1 */
			case '<c': delete y[0]; if(y.i) i = y.i; else y.i = i; d.push(y); break;
		}
	});
	return d;
}

//function write_cc_xml(data, opts) { }

/* [MS-XLSB] 2.6.4.1 */
function parse_BrtCalcChainItem$(data) {
	var out = {};
	out.i = data.read_shift(4);
	var cell = {};
	cell.r = data.read_shift(4);
	cell.c = data.read_shift(4);
	out.r = encode_cell(cell);
	var flags = data.read_shift(1);
	if(flags & 0x2) out.l = '1';
	if(flags & 0x8) out.a = '1';
	return out;
}

/* 18.6 Calculation Chain */
function parse_cc_bin(data, name, opts) {
	var out = [];
	var pass = false;
	recordhopper(data, function hopper_cc(val, R, RT) {
		switch(RT) {
			case 0x003F: /* 'BrtCalcChainItem$' */
				out.push(val); break;

			default:
				if(R.T){/* empty */}
				else if(!pass || opts.WTF) throw new Error("Unexpected record 0x" + RT.toString(16));
		}
	});
	return out;
}

//function write_cc_bin(data, opts) { }
/* 18.14 Supplementary Workbook Data */
function parse_xlink_xml() {
	//var opts = _opts || {};
	//if(opts.WTF) throw "XLSX External Link";
}

/* [MS-XLSB] 2.1.7.25 External Link */
function parse_xlink_bin(data, rel, name, _opts) {
	if(!data) return data;
	var opts = _opts || {};

	var pass = false, end = false;

	recordhopper(data, function xlink_parse(val, R, RT) {
		if(end) return;
		switch(RT) {
			case 0x0167: /* 'BrtSupTabs' */
			case 0x016B: /* 'BrtExternTableStart' */
			case 0x016C: /* 'BrtExternTableEnd' */
			case 0x016E: /* 'BrtExternRowHdr' */
			case 0x016F: /* 'BrtExternCellBlank' */
			case 0x0170: /* 'BrtExternCellReal' */
			case 0x0171: /* 'BrtExternCellBool' */
			case 0x0172: /* 'BrtExternCellError' */
			case 0x0173: /* 'BrtExternCellString' */
			case 0x01D8: /* 'BrtExternValueMeta' */
			case 0x0241: /* 'BrtSupNameStart' */
			case 0x0242: /* 'BrtSupNameValueStart' */
			case 0x0243: /* 'BrtSupNameValueEnd' */
			case 0x0244: /* 'BrtSupNameNum' */
			case 0x0245: /* 'BrtSupNameErr' */
			case 0x0246: /* 'BrtSupNameSt' */
			case 0x0247: /* 'BrtSupNameNil' */
			case 0x0248: /* 'BrtSupNameBool' */
			case 0x0249: /* 'BrtSupNameFmla' */
			case 0x024A: /* 'BrtSupNameBits' */
			case 0x024B: /* 'BrtSupNameEnd' */
				break;

			case 0x0023: /* 'BrtFRTBegin' */
				pass = true; break;
			case 0x0024: /* 'BrtFRTEnd' */
				pass = false; break;

			default:
				if(R.T){/* empty */}
				else if(!pass || opts.WTF) throw new Error("Unexpected record 0x" + RT.toString(16));
		}
	}, opts);
}
/* 20.5 DrawingML - SpreadsheetML Drawing */
/* 20.5.2.35 wsDr CT_Drawing */
function parse_drawing(data, rels) {
	if(!data) return "??";
	/*
	  Chartsheet Drawing:
	   - 20.5.2.35 wsDr CT_Drawing
	    - 20.5.2.1  absoluteAnchor CT_AbsoluteAnchor
	     - 20.5.2.16 graphicFrame CT_GraphicalObjectFrame
	      - 20.1.2.2.16 graphic CT_GraphicalObject
	       - 20.1.2.2.17 graphicData CT_GraphicalObjectData
          - chart reference
	   the actual type is based on the URI of the graphicData
		TODO: handle embedded charts and other types of graphics
	*/
	var id = (data.match(/<c:chart [^<>]*r:id="([^<>"]*)"/)||["",""])[1];

	return rels['!id'][id].Target;
}

/* L.5.5.2 SpreadsheetML Comments + VML Schema */
function parse_vml(data, sheet, comments) {
	var cidx = 0;
	(str_match_xml_ns_g(data, "shape")||[]).forEach(function(m) {
		var type = "";
		var hidden = true;
		var aidx = -1;
		var R = -1, C = -1;
		m.replace(tagregex, function(x, idx) {
			var y = parsexmltag(x);
			switch(strip_ns(y[0])) {
				case '<ClientData': if(y.ObjectType) type = y.ObjectType; break;

				case '<Visible': case '<Visible/>': hidden = false; break;

				case '<Row': case '<Row>': aidx = idx + x.length; break;
				case '</Row>': R = +m.slice(aidx, idx).trim(); break;

				case '<Column': case '<Column>': aidx = idx + x.length; break;
				case '</Column>': C = +m.slice(aidx, idx).trim(); break;
			}
			return "";
		});
		switch(type) {
		case 'Note':
			var cell = ws_get_cell_stub(sheet, ((R>=0 && C>=0) ? encode_cell({r:R,c:C}) : comments[cidx].ref));
			if(cell.c) {
				cell.c.hidden = hidden;
			}
			++cidx;
			break;
		}

	});
}


/* comment boxes */
function write_vml(rId, comments, ws) {
	var csize = [21600, 21600];
	/* L.5.2.1.2 Path Attribute */
	var bbox = ["m0,0l0",csize[1],csize[0],csize[1],csize[0],"0xe"].join(",");
	var o = [
		writextag("xml", null, { 'xmlns:v': XLMLNS.v, 'xmlns:o': XLMLNS.o, 'xmlns:x': XLMLNS.x, 'xmlns:mv': XLMLNS.mv }).replace(/\/>/,">"),
		writextag("o:shapelayout", writextag("o:idmap", null, {'v:ext':"edit", 'data':rId}), {'v:ext':"edit"})
	];

	var _shapeid = 65536 * rId;

	var _comments = comments || [];
	if(_comments.length > 0) o.push(writextag("v:shapetype", [
		writextag("v:stroke", null, {joinstyle:"miter"}),
		writextag("v:path", null, {gradientshapeok:"t", 'o:connecttype':"rect"})
	].join(""), {id:"_x0000_t202", coordsize:csize.join(","), 'o:spt':202, path:bbox}));

	_comments.forEach(function(x) { ++_shapeid; o.push(write_vml_comment(x, _shapeid)); });
	o.push('</xml>');
	return o.join("");
}

function write_vml_comment(x, _shapeid, ws) {
	var c = decode_cell(x[0]);
	var fillopts = {'color2':"#BEFF82", 'type':"gradient"};
	if(fillopts.type == "gradient") fillopts.angle = "-180";
	var fillparm = fillopts.type == "gradient" ? writextag("o:fill", null, {type:"gradientUnscaled", 'v:ext':"view"}) : null;
	var fillxml = writextag('v:fill', fillparm, fillopts);

	var shadata = ({on:"t", 'obscured':"t"});

	return [
	'<v:shape' + wxt_helper({
		id:'_x0000_s' + _shapeid,
		type:"#_x0000_t202",
		style:"position:absolute; margin-left:80pt;margin-top:5pt;width:104pt;height:64pt;z-index:10" + (x[1].hidden ? ";visibility:hidden" : "") ,
		fillcolor:"#ECFAD4",
		strokecolor:"#edeaa1"
	}) + '>',
		fillxml,
		writextag("v:shadow", null, shadata),
		writextag("v:path", null, {'o:connecttype':"none"}),
		'<v:textbox><div style="text-align:left"></div></v:textbox>',
		'<x:ClientData ObjectType="Note">',
			'<x:MoveWithCells/>',
			'<x:SizeWithCells/>',
			/* Part 4 19.4.2.3 Anchor (Anchor) */
			writetag('x:Anchor', [c.c+1, 0, c.r+1, 0, c.c+3, 20, c.r+5, 20].join(",")),
			writetag('x:AutoFill', "False"),
			writetag('x:Row', String(c.r)),
			writetag('x:Column', String(c.c)),
			x[1].hidden ? '' : '<x:Visible/>',
		'</x:ClientData>',
	'</v:shape>'
	].join("");
}
function sheet_insert_comments(sheet, comments, threaded, people) {
	var dense = sheet["!data"] != null;
	var cell;
	comments.forEach(function(comment) {
		var r = decode_cell(comment.ref);
		if(r.r < 0 || r.c < 0) return;
		if(dense) {
			if(!sheet["!data"][r.r]) sheet["!data"][r.r] = [];
			cell = sheet["!data"][r.r][r.c];
		} else cell = sheet[comment.ref];
		if (!cell) {
			cell = ({t:"z"});
			if(dense) sheet["!data"][r.r][r.c] = cell;
			else sheet[comment.ref] = cell;
			var range = safe_decode_range(sheet["!ref"]||"BDWGO1000001:A1");
			if(range.s.r > r.r) range.s.r = r.r;
			if(range.e.r < r.r) range.e.r = r.r;
			if(range.s.c > r.c) range.s.c = r.c;
			if(range.e.c < r.c) range.e.c = r.c;
			var encoded = encode_range(range);
			sheet["!ref"] = encoded;
		}

		if (!cell.c) cell.c = [];
		var o = ({a: comment.author, t: comment.t, r: comment.r, T: threaded});
		if(comment.h) o.h = comment.h;

		/* threaded comments always override */
		for(var i = cell.c.length - 1; i >= 0; --i) {
			if(!threaded && cell.c[i].T) return;
			if(threaded && !cell.c[i].T) cell.c.splice(i, 1);
		}
		if(threaded && people) for(i = 0; i < people.length; ++i) {
			if(o.a == people[i].id) { o.a = people[i].name || o.a; break; }
		}
		cell.c.push(o);
	});
}
/* 18.7 Comments */
function parse_comments_xml(data, opts) {
	/* 18.7.6 CT_Comments */
	if(data.match(/<(?:\w+:)?comments *\/>/)) return [];
	var authors = [];
	var commentList = [];
	var authtag = str_match_xml_ns(data, "authors");
	if(authtag && authtag[1]) authtag[1].split(/<\/\w*:?author>/).forEach(function(x) {
		if(x === "" || x.trim() === "") return;
		var a = x.match(/<(?:\w+:)?author[^<>]*>(.*)/);
		if(a) authors.push(a[1]);
	});
	var cmnttag = str_match_xml_ns(data, "commentList");
	if(cmnttag && cmnttag[1]) cmnttag[1].split(/<\/\w*:?comment>/).forEach(function(x) {
		if(x === "" || x.trim() === "") return;
		var cm = x.match(/<(?:\w+:)?comment[^<>]*>/);
		if(!cm) return;
		var y = parsexmltag(cm[0]);
		var comment = ({ author: y.authorId && authors[y.authorId] || "sheetjsghost", ref: y.ref, guid: y.guid });
		var cell = decode_cell(y.ref);
		if(opts.sheetRows && opts.sheetRows <= cell.r) return;
		var textMatch = str_match_xml_ns(x, "text");
		var rt = !!textMatch && !!textMatch[1] && parse_si(textMatch[1]) || {r:"",t:"",h:""};
		comment.r = rt.r;
		if(rt.r == "<t></t>") rt.t = rt.h = "";
		comment.t = (rt.t||"").replace(/\r\n/g,"\n").replace(/\r/g,"\n");
		if(opts.cellHTML) comment.h = rt.h;
		commentList.push(comment);
	});
	return commentList;
}

function write_comments_xml(data) {
	var o = [XML_HEADER, writextag('comments', null, { 'xmlns': XMLNS_main[0] })];

	var iauthor = [];
	o.push("<authors>");
	data.forEach(function(x) { x[1].forEach(function(w) { var a = escapexml(w.a);
		if(iauthor.indexOf(a) == -1) {
			iauthor.push(a);
			o.push("<author>" + a + "</author>");
		}
		if(w.T && w.ID && iauthor.indexOf("tc=" + w.ID) == -1) {
			iauthor.push("tc=" + w.ID);
			o.push("<author>" + "tc=" + w.ID + "</author>");
		}
	}); });
	if(iauthor.length == 0) { iauthor.push("SheetJ5"); o.push("<author>SheetJ5</author>"); }
	o.push("</authors>");
	o.push("<commentList>");
	data.forEach(function(d) {
		/* 18.7.3 CT_Comment */
		var lastauthor = 0, ts = [], tcnt = 0;
		if(d[1][0] && d[1][0].T && d[1][0].ID) lastauthor = iauthor.indexOf("tc=" + d[1][0].ID);
		d[1].forEach(function(c) {
			if(c.a) lastauthor = iauthor.indexOf(escapexml(c.a));
			if(c.T) ++tcnt;
			ts.push(c.t == null ? "" : escapexml(c.t));
		});
		if(tcnt === 0) {
			d[1].forEach(function(c) {
				o.push('<comment ref="' + d[0] + '" authorId="' + iauthor.indexOf(escapexml(c.a)) + '"><text>');
				o.push(writetag("t", c.t == null ? "" : escapexml(c.t)));
				o.push('</text></comment>');
			});
		} else {
			if(d[1][0] && d[1][0].T && d[1][0].ID) lastauthor = iauthor.indexOf("tc=" + d[1][0].ID);
			/* based on Threaded Comments -> Comments projection */
			o.push('<comment ref="' + d[0] + '" authorId="' + lastauthor + '"><text>');
			var t = "Comment:\n    " + (ts[0]) + "\n";
			for(var i = 1; i < ts.length; ++i) t += "Reply:\n    " + ts[i] + "\n";
			o.push(writetag("t", escapexml(t)));
			o.push('</text></comment>');
		}
	});
	o.push("</commentList>");
	if(o.length>2) { o[o.length] = ('</comments>'); o[1]=o[1].replace("/>",">"); }
	return o.join("");
}

/* [MS-XLSX] 2.1.17 */
function parse_tcmnt_xml(data, opts) {
	var out = [];
	var pass = false, comment = {}, tidx = 0;
	data.replace(tagregex, function xml_tcmnt(x, idx) {
		var y = parsexmltag(x);
		switch(strip_ns(y[0])) {
			case '<?xml': break;

			/* 2.6.207 ThreadedComments CT_ThreadedComments */
			case '<ThreadedComments': break;
			case '</ThreadedComments>': break;

			/* 2.6.205 threadedComment CT_ThreadedComment */
			case '<threadedComment': comment = {author: y.personId, guid: y.id, ref: y.ref, T: 1}; break;
			case '</threadedComment>': if(comment.t != null) out.push(comment); break;

			case '<text>': case '<text': tidx = idx + x.length; break;
			case '</text>': comment.t = data.slice(tidx, idx).replace(/\r\n/g, "\n").replace(/\r/g, "\n"); break;

			/* 2.6.206 mentions CT_ThreadedCommentMentions TODO */
			case '<mentions': case '<mentions>': pass = true; break;
			case '</mentions>': pass = false; break;

			/* 2.6.202 mention CT_Mention TODO */

			/* 18.2.10 extLst CT_ExtensionList ? */
			case '<extLst': case '<extLst>': case '</extLst>': case '<extLst/>': break;
			/* 18.2.7  ext CT_Extension + */
			case '<ext': pass=true; break;
			case '</ext>': pass=false; break;

			default: if(!pass && opts.WTF) throw new Error('unrecognized ' + y[0] + ' in threaded comments');
		}
		return x;
	});
	return out;
}

function write_tcmnt_xml(comments, people, opts) {
	var o = [XML_HEADER, writextag('ThreadedComments', null, { 'xmlns': XMLNS.TCMNT }).replace(/[\/]>/, ">")];
	comments.forEach(function(carr) {
		var rootid = "";
		(carr[1] || []).forEach(function(c, idx) {
			if(!c.T) { delete c.ID; return; }
			if(c.a && people.indexOf(c.a) == -1) people.push(c.a);
			var tcopts = {
				ref: carr[0],
				id: "{54EE7951-7262-4200-6969-" + ("000000000000" + opts.tcid++).slice(-12) + "}"
			};
			if(idx == 0) rootid = tcopts.id;
			else tcopts.parentId = rootid;
			c.ID = tcopts.id;
			if(c.a) tcopts.personId = "{54EE7950-7262-4200-6969-" + ("000000000000" + people.indexOf(c.a)).slice(-12) + "}";
			o.push(writextag('threadedComment', writetag('text', c.t||""), tcopts));
		});
	});
	o.push('</ThreadedComments>');
	return o.join("");
}

/* [MS-XLSX] 2.1.18 */
function parse_people_xml(data, opts) {
	var out = [];
	var pass = false;
	data.replace(tagregex, function xml_tcmnt(x) {
		var y = parsexmltag(x);
		switch(strip_ns(y[0])) {
			case '<?xml': break;

			/* 2.4.85 personList CT_PersonList */
			case '<personList': break;
			case '</personList>': break;

			/* 2.6.203 person CT_Person TODO: providers */
			case '<person': out.push({name: y.displayname, id: y.id }); break;
			case '</person>': break;

			/* 18.2.10 extLst CT_ExtensionList ? */
			case '<extLst': case '<extLst>': case '</extLst>': case '<extLst/>': break;
			/* 18.2.7  ext CT_Extension + */
			case '<ext': pass=true; break;
			case '</ext>': pass=false; break;

			default: if(!pass && opts.WTF) throw new Error('unrecognized ' + y[0] + ' in threaded comments');
		}
		return x;
	});
	return out;
}
function write_people_xml(people/*, opts*/) {
	var o = [XML_HEADER, writextag('personList', null, {
		'xmlns': XMLNS.TCMNT,
		'xmlns:x': XMLNS_main[0]
	}).replace(/[\/]>/, ">")];
	people.forEach(function(person, idx) {
		o.push(writextag('person', null, {
			displayName: person,
			id: "{54EE7950-7262-4200-6969-" + ("000000000000" + idx).slice(-12) + "}",
			userId: person,
			providerId: "None"
		}));
	});
	o.push("</personList>");
	return o.join("");
}
/* [MS-XLSB] 2.4.28 BrtBeginComment */
function parse_BrtBeginComment(data) {
	var out = {};
	out.iauthor = data.read_shift(4);
	var rfx = parse_UncheckedRfX(data, 16);
	out.rfx = rfx.s;
	out.ref = encode_cell(rfx.s);
	data.l += 16; /*var guid = parse_GUID(data); */
	return out;
}
function write_BrtBeginComment(data, o) {
	if(o == null) o = new_buf(36);
	o.write_shift(4, data[1].iauthor);
	write_UncheckedRfX((data[0]), o);
	o.write_shift(4, 0);
	o.write_shift(4, 0);
	o.write_shift(4, 0);
	o.write_shift(4, 0);
	return o;
}

/* [MS-XLSB] 2.4.327 BrtCommentAuthor */
var parse_BrtCommentAuthor = parse_XLWideString;
function write_BrtCommentAuthor(data) { return write_XLWideString(data.slice(0, 54)); }

/* [MS-XLSB] 2.1.7.8 Comments */
function parse_comments_bin(data, opts) {
	var out = [];
	var authors = [];
	var c = {};
	var pass = false;
	recordhopper(data, function hopper_cmnt(val, R, RT) {
		switch(RT) {
			case 0x0278: /* 'BrtCommentAuthor' */
				authors.push(val); break;
			case 0x027B: /* 'BrtBeginComment' */
				c = val; break;
			case 0x027D: /* 'BrtCommentText' */
				c.t = val.t; c.h = val.h; c.r = val.r; break;
			case 0x027C: /* 'BrtEndComment' */
				c.author = authors[c.iauthor];
				delete (c).iauthor;
				if(opts.sheetRows && c.rfx && opts.sheetRows <= c.rfx.r) break;
				if(!c.t) c.t = "";
				delete c.rfx; out.push(c); break;

			case 0x0C00: /* 'BrtUid' */
				break;

			case 0x0023: /* 'BrtFRTBegin' */
				pass = true; break;
			case 0x0024: /* 'BrtFRTEnd' */
				pass = false; break;
			case 0x0025: /* 'BrtACBegin' */ break;
			case 0x0026: /* 'BrtACEnd' */ break;


			default:
				if(R.T){/* empty */}
				else if(!pass || opts.WTF) throw new Error("Unexpected record 0x" + RT.toString(16));
		}
	});
	return out;
}

function write_comments_bin(data) {
	var ba = buf_array();
	var iauthor = [];
	write_record(ba, 0x0274 /* BrtBeginComments */);

	write_record(ba, 0x0276 /* BrtBeginCommentAuthors */);
	data.forEach(function(comment) {
		comment[1].forEach(function(c) {
			if(iauthor.indexOf(c.a) > -1) return;
			iauthor.push(c.a.slice(0,54));
			write_record(ba, 0x0278 /* BrtCommentAuthor */, write_BrtCommentAuthor(c.a));
			if(c.T && c.ID && iauthor.indexOf("tc=" + c.ID) == -1) {
				iauthor.push("tc=" + c.ID);
				write_record(ba, 0x0278 /* BrtCommentAuthor */, write_BrtCommentAuthor("tc=" + c.ID));
			}
		});
	});
	write_record(ba, 0x0277 /* BrtEndCommentAuthors */);

	write_record(ba, 0x0279 /* BrtBeginCommentList */);
	data.forEach(function(comment) {
		comment[1].forEach(function(c) {
			var _ia = -1;
			if(c.ID) _ia = iauthor.indexOf("tc=" + c.ID);
			if(_ia == -1 && comment[1][0].T && comment[1][0].ID) _ia = iauthor.indexOf("tc=" + comment[1][0].ID);
			if(_ia == -1) _ia = iauthor.indexOf(c.a);
			c.iauthor = _ia;
			var range = {s:decode_cell(comment[0]),e:decode_cell(comment[0])};
			write_record(ba, 0x027B /* BrtBeginComment */, write_BrtBeginComment([range, c]));
			if(c.t && c.t.length > 0) write_record(ba, 0x027D /* BrtCommentText */, write_BrtCommentText(c));
			write_record(ba, 0x027C /* BrtEndComment */);
			delete c.iauthor;
		});
	});
	write_record(ba, 0x027A /* BrtEndCommentList */);

	write_record(ba, 0x0275 /* BrtEndComments */);
	return ba.end();
}
var CT_VBA = "application/vnd.ms-office.vbaProject";
function make_vba_xls(cfb) {
  var newcfb = CFB.utils.cfb_new({ root: "R" });
  cfb.FullPaths.forEach(function(p, i) {
    if (p.slice(-1) === "/" || !p.match(/_VBA_PROJECT_CUR/))
      return;
    var newpath = p.replace(/^[^\/]*/, "R").replace(/\/_VBA_PROJECT_CUR\u0000*/, "");
    CFB.utils.cfb_add(newcfb, newpath, cfb.FileIndex[i].content);
  });
  return CFB.write(newcfb);
}
function fill_vba_xls(cfb, vba) {
  vba.FullPaths.forEach(function(p, i) {
    if (i == 0)
      return;
    var newpath = p.replace(/^[\/]*[^\/]*[\/]/, "/_VBA_PROJECT_CUR/");
    if (newpath.slice(-1) !== "/")
      CFB.utils.cfb_add(cfb, newpath, vba.FileIndex[i].content);
  });
}
var VBAFMTS = ["xlsb", "xlsm", "xlam", "biff8", "xla"];
/* macro and dialog sheet stubs */
function parse_ds_bin() { return {'!type':'dialog'}; }
function parse_ds_xml() { return {'!type':'dialog'}; }
function parse_ms_bin() { return {'!type':'macro'}; }
function parse_ms_xml() { return {'!type':'macro'}; }
/* TODO: it will be useful to parse the function str */
var rc_to_a1 = (function(){
	var rcregex = /(^|[^A-Za-z_])R(\[?-?\d+\]|[1-9]\d*|)C(\[?-?\d+\]|[1-9]\d*|)(?![A-Za-z0-9_])/g;
	var rcbase = ({r:0,c:0});
	function rcfunc($$,$1,$2,$3) {
		var cRel = false, rRel = false;

		if($2.length == 0) rRel = true;
		else if($2.charAt(0) == "[") { rRel = true; $2 = $2.slice(1, -1); }

		if($3.length == 0) cRel = true;
		else if($3.charAt(0) == "[") { cRel = true; $3 = $3.slice(1, -1); }

		var R = $2.length>0?parseInt($2,10)|0:0, C = $3.length>0?parseInt($3,10)|0:0;

		if(cRel) C += rcbase.c; else --C;
		if(rRel) R += rcbase.r; else --R;
		return $1 + (cRel ? "" : "$") + encode_col(C) + (rRel ? "" : "$") + encode_row(R);
	}
	return function rc_to_a1(fstr, base) {
		rcbase = base;
		return fstr.replace(rcregex, rcfunc);
	};
})();

var crefregex = /(^|[^._A-Z0-9])(\$?)([A-Z]{1,2}|[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D])(\$?)(\d{1,7})(?![_.\(A-Za-z0-9])/g;
try {
	crefregex = /(^|[^._A-Z0-9])([$]?)([A-Z]{1,2}|[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D])([$]?)(10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5})(?![_.\(A-Za-z0-9])/g;
}catch(e){}
var a1_to_rc = (function(){
	return function a1_to_rc(fstr, base) {
		return fstr.replace(crefregex, function($0, $1, $2, $3, $4, $5) {
			var c = decode_col($3) - ($2 ? 0 : base.c);
			var r = decode_row($5) - ($4 ? 0 : base.r);
			var R = $4 == "$" ? (r+1) : (r == 0 ? "" : "[" + r + "]");
			var C = $2 == "$" ? (c+1) : (c == 0 ? "" : "[" + c + "]");
			return $1 + "R" + R + "C" + C;
		});
	};
})();

/* no defined name can collide with a valid cell address A1:XFD1048576 ... except LOG10! */
function shift_formula_str(f, delta) {
	return f.replace(crefregex, function($0, $1, $2, $3, $4, $5) {
		return $1+($2=="$" ? $2+$3 : encode_col(decode_col($3)+delta.c))+($4=="$" ? $4+$5 : encode_row(decode_row($5) + delta.r));
	});
}

function shift_formula_xlsx(f, range, cell) {
	var r = decode_range(range), s = r.s, c = decode_cell(cell);
	var delta = {r:c.r - s.r, c:c.c - s.c};
	return shift_formula_str(f, delta);
}

/* TODO: parse formula */
function fuzzyfmla(f) {
	if(f.length == 1) return false;
	return true;
}

function _xlfn(f) {
	return f.replace(/_xlfn\./g,"");
}
function parseread1(blob) { blob.l+=1; return; }

/* [MS-XLS] 2.5.51 */
function parse_ColRelU(blob, length) {
	var c = blob.read_shift(length == 1 ? 1 : 2);
	return [c & 0x3FFF, (c >> 14) & 1, (c >> 15) & 1];
}

/* [MS-XLS] 2.5.198.105 ; [MS-XLSB] 2.5.97.89 */
function parse_RgceArea(blob, length, opts) {
	var w = 2;
	if(opts) {
		if(opts.biff >= 2 && opts.biff <= 5) return parse_RgceArea_BIFF2(blob, length, opts);
		else if(opts.biff == 12) w = 4;
	}
	var r=blob.read_shift(w), R=blob.read_shift(w);
	var c=parse_ColRelU(blob, 2);
	var C=parse_ColRelU(blob, 2);
	return { s:{r:r, c:c[0], cRel:c[1], rRel:c[2]}, e:{r:R, c:C[0], cRel:C[1], rRel:C[2]} };
}
/* BIFF 2-5 encodes flags in the row field */
function parse_RgceArea_BIFF2(blob) {
	var r=parse_ColRelU(blob, 2), R=parse_ColRelU(blob, 2);
	var c=blob.read_shift(1);
	var C=blob.read_shift(1);
	return { s:{r:r[0], c:c, cRel:r[1], rRel:r[2]}, e:{r:R[0], c:C, cRel:R[1], rRel:R[2]} };
}

/* [MS-XLS] 2.5.198.105 ; [MS-XLSB] 2.5.97.90 */
function parse_RgceAreaRel(blob, length, opts) {
	if(opts.biff < 8) return parse_RgceArea_BIFF2(blob, length, opts);
	var r=blob.read_shift(opts.biff == 12 ? 4 : 2), R=blob.read_shift(opts.biff == 12 ? 4 : 2);
	var c=parse_ColRelU(blob, 2);
	var C=parse_ColRelU(blob, 2);
	return { s:{r:r, c:c[0], cRel:c[1], rRel:c[2]}, e:{r:R, c:C[0], cRel:C[1], rRel:C[2]} };
}

/* [MS-XLS] 2.5.198.109 ; [MS-XLSB] 2.5.97.91 */
function parse_RgceLoc(blob, length, opts) {
	if(opts && opts.biff >= 2 && opts.biff <= 5) return parse_RgceLoc_BIFF2(blob, length, opts);
	var r = blob.read_shift(opts && opts.biff == 12 ? 4 : 2);
	var c = parse_ColRelU(blob, 2);
	return {r:r, c:c[0], cRel:c[1], rRel:c[2]};
}
function parse_RgceLoc_BIFF2(blob) {
	var r = parse_ColRelU(blob, 2);
	var c = blob.read_shift(1);
	return {r:r[0], c:c, cRel:r[1], rRel:r[2]};
}

/* [MS-XLS] 2.5.198.107, 2.5.47 */
function parse_RgceElfLoc(blob) {
	var r = blob.read_shift(2);
	var c = blob.read_shift(2);
	return {r:r, c:c & 0xFF, fQuoted:!!(c & 0x4000), cRel:c>>15, rRel:c>>15 };
}

/* [MS-XLS] 2.5.198.111 ; [MS-XLSB] 2.5.97.92 TODO */
function parse_RgceLocRel(blob, length, opts) {
	var biff = opts && opts.biff ? opts.biff : 8;
	if(biff >= 2 && biff <= 5) return parse_RgceLocRel_BIFF2(blob, length, opts);
	var r = blob.read_shift(biff >= 12 ? 4 : 2);
	var cl = blob.read_shift(2);
	var cRel = (cl & 0x4000) >> 14, rRel = (cl & 0x8000) >> 15;
	cl &= 0x3FFF;
	if(rRel == 1) while(r > 0x7FFFF) r -= 0x100000;
	if(cRel == 1) while(cl > 0x1FFF) cl = cl - 0x4000;
	return {r:r,c:cl,cRel:cRel,rRel:rRel};
}
function parse_RgceLocRel_BIFF2(blob) {
	var rl = blob.read_shift(2);
	var c = blob.read_shift(1);
	var rRel = (rl & 0x8000) >> 15, cRel = (rl & 0x4000) >> 14;
	rl &= 0x3FFF;
	if(rRel == 1 && rl >= 0x2000) rl = rl - 0x4000;
	if(cRel == 1 && c >= 0x80) c = c - 0x100;
	return {r:rl,c:c,cRel:cRel,rRel:rRel};
}

/* [MS-XLS] 2.5.198.27 ; [MS-XLSB] 2.5.97.18 */
function parse_PtgArea(blob, length, opts) {
	var type = (blob[blob.l++] & 0x60) >> 5;
	var area = parse_RgceArea(blob, opts.biff >= 2 && opts.biff <= 5 ? 6 : 8, opts);
	return [type, area];
}

/* [MS-XLS] 2.5.198.28 ; [MS-XLSB] 2.5.97.19 */
function parse_PtgArea3d(blob, length, opts) {
	var type = (blob[blob.l++] & 0x60) >> 5;
	var ixti = blob.read_shift(2, 'i');
	var w = 8;
	if(opts) switch(opts.biff) {
		case 5: blob.l += 12; w = 6; break;
		case 12: w = 12; break;
	}
	var area = parse_RgceArea(blob, w, opts);
	return [type, ixti, area];
}

/* [MS-XLS] 2.5.198.29 ; [MS-XLSB] 2.5.97.20 */
function parse_PtgAreaErr(blob, length, opts) {
	var type = (blob[blob.l++] & 0x60) >> 5;
	blob.l += opts && (opts.biff > 8) ? 12 : (opts.biff < 8 ? 6 : 8);
	return [type];
}
/* [MS-XLS] 2.5.198.30 ; [MS-XLSB] 2.5.97.21 */
function parse_PtgAreaErr3d(blob, length, opts) {
	var type = (blob[blob.l++] & 0x60) >> 5;
	var ixti = blob.read_shift(2);
	var w = 8;
	if(opts) switch(opts.biff) {
		case 5: blob.l += 12; w = 6; break;
		case 12: w = 12; break;
	}
	blob.l += w;
	return [type, ixti];
}

/* [MS-XLS] 2.5.198.31 ; [MS-XLSB] 2.5.97.22 */
function parse_PtgAreaN(blob, length, opts) {
	var type = (blob[blob.l++] & 0x60) >> 5;
	var area = parse_RgceAreaRel(blob, length - 1, opts);
	return [type, area];
}

/* [MS-XLS] 2.5.198.32 ; [MS-XLSB] 2.5.97.23 */
function parse_PtgArray(blob, length, opts) {
	var type = (blob[blob.l++] & 0x60) >> 5;
	blob.l += opts.biff == 2 ? 6 : opts.biff == 12 ? 14 : 7;
	return [type];
}

/* [MS-XLS] 2.5.198.33 ; [MS-XLSB] 2.5.97.24 */
function parse_PtgAttrBaxcel(blob) {
	var bitSemi = blob[blob.l+1] & 0x01; /* 1 = volatile */
	var bitBaxcel = 1;
	blob.l += 4;
	return [bitSemi, bitBaxcel];
}

/* [MS-XLS] 2.5.198.34 ; [MS-XLSB] 2.5.97.25 */
function parse_PtgAttrChoose(blob, length, opts) {
	blob.l +=2;
	var offset = blob.read_shift(opts && opts.biff == 2 ? 1 : 2);
	var o = [];
	/* offset is 1 less than the number of elements */
	for(var i = 0; i <= offset; ++i) o.push(blob.read_shift(opts && opts.biff == 2 ? 1 : 2));
	return o;
}

/* [MS-XLS] 2.5.198.35 ; [MS-XLSB] 2.5.97.26 */
function parse_PtgAttrGoto(blob, length, opts) {
	var bitGoto = (blob[blob.l+1] & 0xFF) ? 1 : 0;
	blob.l += 2;
	return [bitGoto, blob.read_shift(opts && opts.biff == 2 ? 1 : 2)];
}

/* [MS-XLS] 2.5.198.36 ; [MS-XLSB] 2.5.97.27 */
function parse_PtgAttrIf(blob, length, opts) {
	var bitIf = (blob[blob.l+1] & 0xFF) ? 1 : 0;
	blob.l += 2;
	return [bitIf, blob.read_shift(opts && opts.biff == 2 ? 1 : 2)];
}

/* [MS-XLSB] 2.5.97.28 */
function parse_PtgAttrIfError(blob) {
	var bitIf = (blob[blob.l+1] & 0xFF) ? 1 : 0;
	blob.l += 2;
	return [bitIf, blob.read_shift(2)];
}

/* [MS-XLS] 2.5.198.37 ; [MS-XLSB] 2.5.97.29 */
function parse_PtgAttrSemi(blob, length, opts) {
	var bitSemi = (blob[blob.l+1] & 0xFF) ? 1 : 0;
	blob.l += opts && opts.biff == 2 ? 3 : 4;
	return [bitSemi];
}

/* [MS-XLS] 2.5.198.40 ; [MS-XLSB] 2.5.97.32 */
function parse_PtgAttrSpaceType(blob) {
	var type = blob.read_shift(1), cch = blob.read_shift(1);
	return [type, cch];
}

/* [MS-XLS] 2.5.198.38 ; [MS-XLSB] 2.5.97.30 */
function parse_PtgAttrSpace(blob) {
	blob.read_shift(2);
	return parse_PtgAttrSpaceType(blob, 2);
}

/* [MS-XLS] 2.5.198.39 ; [MS-XLSB] 2.5.97.31 */
function parse_PtgAttrSpaceSemi(blob) {
	blob.read_shift(2);
	return parse_PtgAttrSpaceType(blob, 2);
}

/* [MS-XLS] 2.5.198.84 ; [MS-XLSB] 2.5.97.68 TODO */
function parse_PtgRef(blob, length, opts) {
	//var ptg = blob[blob.l] & 0x1F;
	var type = (blob[blob.l] & 0x60)>>5;
	blob.l += 1;
	var loc = parse_RgceLoc(blob, 0, opts);
	return [type, loc];
}

/* [MS-XLS] 2.5.198.88 ; [MS-XLSB] 2.5.97.72 TODO */
function parse_PtgRefN(blob, length, opts) {
	var type = (blob[blob.l] & 0x60)>>5;
	blob.l += 1;
	var loc = parse_RgceLocRel(blob, 0, opts);
	return [type, loc];
}

/* [MS-XLS] 2.5.198.85 ; [MS-XLSB] 2.5.97.69 TODO */
function parse_PtgRef3d(blob, length, opts) {
	var type = (blob[blob.l] & 0x60)>>5;
	blob.l += 1;
	var ixti = blob.read_shift(2); // XtiIndex
	if(opts && opts.biff == 5) blob.l += 12;
	var loc = parse_RgceLoc(blob, 0, opts); // TODO: or RgceLocRel
	return [type, ixti, loc];
}


/* [MS-XLS] 2.5.198.62 ; [MS-XLSB] 2.5.97.45 TODO */
function parse_PtgFunc(blob, length, opts) {
	//var ptg = blob[blob.l] & 0x1F;
	var type = (blob[blob.l] & 0x60)>>5;
	blob.l += 1;
	var iftab = blob.read_shift(opts && opts.biff <= 3 ? 1 : 2);
	return [FtabArgc[iftab], Ftab[iftab], type];
}
/* [MS-XLS] 2.5.198.63 ; [MS-XLSB] 2.5.97.46 TODO */
function parse_PtgFuncVar(blob, length, opts) {
	var type = blob[blob.l++];
	var cparams = blob.read_shift(1), tab = opts && opts.biff <= 3 ? [(type == 0x58 ? -1 : 0), blob.read_shift(1)]: parsetab(blob);
	return [cparams, (tab[0] === 0 ? Ftab : Cetab)[tab[1]]];
}

function parsetab(blob) {
	return [blob[blob.l+1]>>7, blob.read_shift(2) & 0x7FFF];
}

/* [MS-XLS] 2.5.198.41 ; [MS-XLSB] 2.5.97.33 */
function parse_PtgAttrSum(blob, length, opts) {
	blob.l += opts && opts.biff == 2 ? 3 : 4; return;
}

/* [MS-XLS] 2.5.198.58 ; [MS-XLSB] 2.5.97.40 */
function parse_PtgExp(blob, length, opts) {
	blob.l++;
	if(opts && opts.biff == 12) return [blob.read_shift(4, 'i'), 0];
	var row = blob.read_shift(2);
	var col = blob.read_shift(opts && opts.biff == 2 ? 1 : 2);
	return [row, col];
}

/* [MS-XLS] 2.5.198.57 ; [MS-XLSB] 2.5.97.39 */
function parse_PtgErr(blob) { blob.l++; return BErr[blob.read_shift(1)]; }

/* [MS-XLS] 2.5.198.66 ; [MS-XLSB] 2.5.97.49 */
function parse_PtgInt(blob) { blob.l++; return blob.read_shift(2); }

/* [MS-XLS] 2.5.198.42 ; [MS-XLSB] 2.5.97.34 */
function parse_PtgBool(blob) { blob.l++; return blob.read_shift(1)!==0;}

/* [MS-XLS] 2.5.198.79 ; [MS-XLSB] 2.5.97.63 */
function parse_PtgNum(blob) { blob.l++; return parse_Xnum(blob, 8); }

/* [MS-XLS] 2.5.198.89 ; [MS-XLSB] 2.5.97.74 */
function parse_PtgStr(blob, length, opts) { blob.l++; return parse_ShortXLUnicodeString(blob, length-1, opts); }

/* [MS-XLS] 2.5.192.112 + 2.5.192.11{3,4,5,6,7} */
/* [MS-XLSB] 2.5.97.93 + 2.5.97.9{4,5,6,7} */
function parse_SerAr(blob, biff) {
	var val = [blob.read_shift(1)];
	if(biff == 12) switch(val[0]) {
		case 0x02: val[0] = 0x04; break; /* SerBool */
		case 0x04: val[0] = 0x10; break; /* SerErr */
		case 0x00: val[0] = 0x01; break; /* SerNum */
		case 0x01: val[0] = 0x02; break; /* SerStr */
	}
	switch(val[0]) {
		case 0x04: /* SerBool -- boolean */
			val[1] = parsebool(blob, 1) ? 'TRUE' : 'FALSE';
			if(biff != 12) blob.l += 7; break;
		case 0x25: /* appears to be an alias */
		case 0x10: /* SerErr -- error */
			val[1] = BErr[blob[blob.l]];
			blob.l += ((biff == 12) ? 4 : 8); break;
		case 0x00: /* SerNil -- honestly, I'm not sure how to reproduce this */
			blob.l += 8; break;
		case 0x01: /* SerNum -- Xnum */
			val[1] = parse_Xnum(blob, 8); break;
		case 0x02: /* SerStr -- XLUnicodeString (<256 chars) */
			val[1] = parse_XLUnicodeString2(blob, 0, {biff:biff > 0 && biff < 8 ? 2 : biff}); break;
		default: throw new Error("Bad SerAr: " + val[0]); /* Unreachable */
	}
	return val;
}

/* [MS-XLS] 2.5.198.61 ; [MS-XLSB] 2.5.97.44 */
function parse_PtgExtraMem(blob, cce, opts) {
	var count = blob.read_shift((opts.biff == 12) ? 4 : 2);
	var out = [];
	for(var i = 0; i != count; ++i) out.push(((opts.biff == 12) ? parse_UncheckedRfX : parse_Ref8U)(blob, 8));
	return out;
}

/* [MS-XLS] 2.5.198.59 ; [MS-XLSB] 2.5.97.41 */
function parse_PtgExtraArray(blob, length, opts) {
	var rows = 0, cols = 0;
	if(opts.biff == 12) {
		rows = blob.read_shift(4); // DRw
		cols = blob.read_shift(4); // DCol
	} else {
		cols = 1 + blob.read_shift(1); //DColByteU
		rows = 1 + blob.read_shift(2); //DRw
	}
	if(opts.biff >= 2 && opts.biff < 8) { --rows; if(--cols == 0) cols = 0x100; }
	// $FlowIgnore
	for(var i = 0, o = []; i != rows && (o[i] = []); ++i)
		for(var j = 0; j != cols; ++j) o[i][j] = parse_SerAr(blob, opts.biff);
	return o;
}

/* [MS-XLS] 2.5.198.76 ; [MS-XLSB] 2.5.97.60 */
function parse_PtgName(blob, length, opts) {
	var type = (blob.read_shift(1) >>> 5) & 0x03;
	var w = (!opts || (opts.biff >= 8)) ? 4 : 2;
	var nameindex = blob.read_shift(w);
	switch(opts.biff) {
		case 2: blob.l += 5; break;
		case 3: case 4: blob.l += 8; break;
		case 5: blob.l += 12; break;
	}
	return [type, 0, nameindex];
}

/* [MS-XLS] 2.5.198.77 ; [MS-XLSB] 2.5.97.61 */
function parse_PtgNameX(blob, length, opts) {
	if(opts.biff == 5) return parse_PtgNameX_BIFF5(blob, length, opts);
	var type = (blob.read_shift(1) >>> 5) & 0x03;
	var ixti = blob.read_shift(2); // XtiIndex
	var nameindex = blob.read_shift(4);
	return [type, ixti, nameindex];
}
function parse_PtgNameX_BIFF5(blob) {
	var type = (blob.read_shift(1) >>> 5) & 0x03;
	var ixti = blob.read_shift(2, 'i'); // XtiIndex
	blob.l += 8;
	var nameindex = blob.read_shift(2);
	blob.l += 12;
	return [type, ixti, nameindex];
}

/* [MS-XLS] 2.5.198.70 ; [MS-XLSB] 2.5.97.54 */
function parse_PtgMemArea(blob, length, opts) {
	var type = (blob.read_shift(1) >>> 5) & 0x03;
	blob.l += (opts && opts.biff == 2 ? 3 : 4);
	var cce = blob.read_shift(opts && opts.biff == 2 ? 1 : 2);
	return [type, cce];
}

/* [MS-XLS] 2.5.198.72 ; [MS-XLSB] 2.5.97.56 */
function parse_PtgMemFunc(blob, length, opts) {
	var type = (blob.read_shift(1) >>> 5) & 0x03;
	var cce = blob.read_shift(opts && opts.biff == 2 ? 1 : 2);
	return [type, cce];
}


/* [MS-XLS] 2.5.198.86 ; [MS-XLSB] 2.5.97.69 */
function parse_PtgRefErr(blob, length, opts) {
	var type = (blob.read_shift(1) >>> 5) & 0x03;
	blob.l += 4;
	if(opts.biff < 8) blob.l--;
	if(opts.biff == 12) blob.l += 2;
	return [type];
}

/* [MS-XLS] 2.5.198.87 ; [MS-XLSB] 2.5.97.71 */
function parse_PtgRefErr3d(blob, length, opts) {
	var type = (blob[blob.l++] & 0x60) >> 5;
	var ixti = blob.read_shift(2);
	var w = 4;
	if(opts) switch(opts.biff) {
		case 5: w = 15; break;
		case 12: w = 6; break;
	}
	blob.l += w;
	return [type, ixti];
}

/* [MS-XLS] 2.5.198.71 ; [MS-XLSB] 2.5.97.55 */
var parse_PtgMemErr = parsenoop;
/* [MS-XLS] 2.5.198.73  ; [MS-XLSB] 2.5.97.57 */
var parse_PtgMemNoMem = parsenoop;
/* [MS-XLS] 2.5.198.92 */
var parse_PtgTbl = parsenoop;

function parse_PtgElfLoc(blob, length, opts) {
	blob.l += 2;
	return [parse_RgceElfLoc(blob, 4, opts)];
}
function parse_PtgElfNoop(blob) {
	blob.l += 6;
	return [];
}
/* [MS-XLS] 2.5.198.46 */
var parse_PtgElfCol = parse_PtgElfLoc;
/* [MS-XLS] 2.5.198.47 */
var parse_PtgElfColS = parse_PtgElfNoop;
/* [MS-XLS] 2.5.198.48 */
var parse_PtgElfColSV = parse_PtgElfNoop;
/* [MS-XLS] 2.5.198.49 */
var parse_PtgElfColV = parse_PtgElfLoc;
/* [MS-XLS] 2.5.198.50 */
function parse_PtgElfLel(blob) {
	blob.l += 2;
	return [parseuint16(blob), blob.read_shift(2) & 0x01];
}
/* [MS-XLS] 2.5.198.51 */
var parse_PtgElfRadical = parse_PtgElfLoc;
/* [MS-XLS] 2.5.198.52 */
var parse_PtgElfRadicalLel = parse_PtgElfLel;
/* [MS-XLS] 2.5.198.53 */
var parse_PtgElfRadicalS = parse_PtgElfNoop;
/* [MS-XLS] 2.5.198.54 */
var parse_PtgElfRw = parse_PtgElfLoc;
/* [MS-XLS] 2.5.198.55 */
var parse_PtgElfRwV = parse_PtgElfLoc;

/* [MS-XLSB] 2.5.97.52 TODO */
var PtgListRT = [
	"Data",
	"All",
	"Headers",
	"??",
	"?Data2",
	"??",
	"?DataHeaders",
	"??",
	"Totals",
	"??",
	"??",
	"??",
	"?DataTotals",
	"??",
	"??",
	"??",
	"?Current"
];
function parse_PtgList(blob) {
	blob.l += 2;
	var ixti = blob.read_shift(2);
	var flags = blob.read_shift(2);
	var idx = blob.read_shift(4);
	var c = blob.read_shift(2);
	var C = blob.read_shift(2);
	var rt = PtgListRT[(flags >> 2) & 0x1F];
	return {ixti: ixti, coltype:(flags&0x3), rt:rt, idx:idx, c:c, C:C};
}
/* [MS-XLS] 2.5.198.91 ; [MS-XLSB] 2.5.97.76 */
function parse_PtgSxName(blob) {
	blob.l += 2;
	return [blob.read_shift(4)];
}

/* [XLS] old spec */
function parse_PtgSheet(blob, length, opts) {
	blob.l += 5;
	blob.l += 2;
	blob.l += (opts.biff == 2 ? 1 : 4);
	return ["PTGSHEET"];
}
function parse_PtgEndSheet(blob, length, opts) {
	blob.l += (opts.biff == 2 ? 4 : 5);
	return ["PTGENDSHEET"];
}
function parse_PtgMemAreaN(blob) {
	var type = (blob.read_shift(1) >>> 5) & 0x03;
	var cce = blob.read_shift(2);
	return [type, cce];
}
function parse_PtgMemNoMemN(blob) {
	var type = (blob.read_shift(1) >>> 5) & 0x03;
	var cce = blob.read_shift(2);
	return [type, cce];
}
function parse_PtgAttrNoop(blob) {
	blob.l += 4;
	return [0, 0];
}

/* [MS-XLS] 2.5.198.25 ; [MS-XLSB] 2.5.97.16 */
var PtgTypes = {
	0x01: { n:'PtgExp', f:parse_PtgExp },
	0x02: { n:'PtgTbl', f:parse_PtgTbl },
	0x03: { n:'PtgAdd', f:parseread1 },
	0x04: { n:'PtgSub', f:parseread1 },
	0x05: { n:'PtgMul', f:parseread1 },
	0x06: { n:'PtgDiv', f:parseread1 },
	0x07: { n:'PtgPower', f:parseread1 },
	0x08: { n:'PtgConcat', f:parseread1 },
	0x09: { n:'PtgLt', f:parseread1 },
	0x0A: { n:'PtgLe', f:parseread1 },
	0x0B: { n:'PtgEq', f:parseread1 },
	0x0C: { n:'PtgGe', f:parseread1 },
	0x0D: { n:'PtgGt', f:parseread1 },
	0x0E: { n:'PtgNe', f:parseread1 },
	0x0F: { n:'PtgIsect', f:parseread1 },
	0x10: { n:'PtgUnion', f:parseread1 },
	0x11: { n:'PtgRange', f:parseread1 },
	0x12: { n:'PtgUplus', f:parseread1 },
	0x13: { n:'PtgUminus', f:parseread1 },
	0x14: { n:'PtgPercent', f:parseread1 },
	0x15: { n:'PtgParen', f:parseread1 },
	0x16: { n:'PtgMissArg', f:parseread1 },
	0x17: { n:'PtgStr', f:parse_PtgStr },
	0x1A: { n:'PtgSheet', f:parse_PtgSheet },
	0x1B: { n:'PtgEndSheet', f:parse_PtgEndSheet },
	0x1C: { n:'PtgErr', f:parse_PtgErr },
	0x1D: { n:'PtgBool', f:parse_PtgBool },
	0x1E: { n:'PtgInt', f:parse_PtgInt },
	0x1F: { n:'PtgNum', f:parse_PtgNum },
	0x20: { n:'PtgArray', f:parse_PtgArray },
	0x21: { n:'PtgFunc', f:parse_PtgFunc },
	0x22: { n:'PtgFuncVar', f:parse_PtgFuncVar },
	0x23: { n:'PtgName', f:parse_PtgName },
	0x24: { n:'PtgRef', f:parse_PtgRef },
	0x25: { n:'PtgArea', f:parse_PtgArea },
	0x26: { n:'PtgMemArea', f:parse_PtgMemArea },
	0x27: { n:'PtgMemErr', f:parse_PtgMemErr },
	0x28: { n:'PtgMemNoMem', f:parse_PtgMemNoMem },
	0x29: { n:'PtgMemFunc', f:parse_PtgMemFunc },
	0x2A: { n:'PtgRefErr', f:parse_PtgRefErr },
	0x2B: { n:'PtgAreaErr', f:parse_PtgAreaErr },
	0x2C: { n:'PtgRefN', f:parse_PtgRefN },
	0x2D: { n:'PtgAreaN', f:parse_PtgAreaN },
	0x2E: { n:'PtgMemAreaN', f:parse_PtgMemAreaN },
	0x2F: { n:'PtgMemNoMemN', f:parse_PtgMemNoMemN },
	0x39: { n:'PtgNameX', f:parse_PtgNameX },
	0x3A: { n:'PtgRef3d', f:parse_PtgRef3d },
	0x3B: { n:'PtgArea3d', f:parse_PtgArea3d },
	0x3C: { n:'PtgRefErr3d', f:parse_PtgRefErr3d },
	0x3D: { n:'PtgAreaErr3d', f:parse_PtgAreaErr3d },
	0xFF: {}
};
/* These are duplicated in the PtgTypes table */
var PtgDupes = {
	0x40: 0x20, 0x60: 0x20,
	0x41: 0x21, 0x61: 0x21,
	0x42: 0x22, 0x62: 0x22,
	0x43: 0x23, 0x63: 0x23,
	0x44: 0x24, 0x64: 0x24,
	0x45: 0x25, 0x65: 0x25,
	0x46: 0x26, 0x66: 0x26,
	0x47: 0x27, 0x67: 0x27,
	0x48: 0x28, 0x68: 0x28,
	0x49: 0x29, 0x69: 0x29,
	0x4A: 0x2A, 0x6A: 0x2A,
	0x4B: 0x2B, 0x6B: 0x2B,
	0x4C: 0x2C, 0x6C: 0x2C,
	0x4D: 0x2D, 0x6D: 0x2D,
	0x4E: 0x2E, 0x6E: 0x2E,
	0x4F: 0x2F, 0x6F: 0x2F,
	0x58: 0x22, 0x78: 0x22,
	0x59: 0x39, 0x79: 0x39,
	0x5A: 0x3A, 0x7A: 0x3A,
	0x5B: 0x3B, 0x7B: 0x3B,
	0x5C: 0x3C, 0x7C: 0x3C,
	0x5D: 0x3D, 0x7D: 0x3D
};

var Ptg18 = {
	0x01: { n:'PtgElfLel', f:parse_PtgElfLel },
	0x02: { n:'PtgElfRw', f:parse_PtgElfRw },
	0x03: { n:'PtgElfCol', f:parse_PtgElfCol },
	0x06: { n:'PtgElfRwV', f:parse_PtgElfRwV },
	0x07: { n:'PtgElfColV', f:parse_PtgElfColV },
	0x0A: { n:'PtgElfRadical', f:parse_PtgElfRadical },
	0x0B: { n:'PtgElfRadicalS', f:parse_PtgElfRadicalS },
	0x0D: { n:'PtgElfColS', f:parse_PtgElfColS },
	0x0F: { n:'PtgElfColSV', f:parse_PtgElfColSV },
	0x10: { n:'PtgElfRadicalLel', f:parse_PtgElfRadicalLel },
	0x19: { n:'PtgList', f:parse_PtgList },
	0x1D: { n:'PtgSxName', f:parse_PtgSxName },
	0xFF: {}
};
var Ptg19 = {
	0x00: { n:'PtgAttrNoop', f:parse_PtgAttrNoop },
	0x01: { n:'PtgAttrSemi', f:parse_PtgAttrSemi },
	0x02: { n:'PtgAttrIf', f:parse_PtgAttrIf },
	0x04: { n:'PtgAttrChoose', f:parse_PtgAttrChoose },
	0x08: { n:'PtgAttrGoto', f:parse_PtgAttrGoto },
	0x10: { n:'PtgAttrSum', f:parse_PtgAttrSum },
	0x20: { n:'PtgAttrBaxcel', f:parse_PtgAttrBaxcel },
	0x21: { n:'PtgAttrBaxcel', f:parse_PtgAttrBaxcel },
	0x40: { n:'PtgAttrSpace', f:parse_PtgAttrSpace },
	0x41: { n:'PtgAttrSpaceSemi', f:parse_PtgAttrSpaceSemi },
	0x80: { n:'PtgAttrIfError', f:parse_PtgAttrIfError },
	0xFF: {}
};

/* [MS-XLS] 2.5.198.103 ; [MS-XLSB] 2.5.97.87 */
function parse_RgbExtra(blob, length, rgce, opts) {
	if(opts.biff < 8) return parsenoop(blob, length);
	var target = blob.l + length;
	var o = [];
	for(var i = 0; i !== rgce.length; ++i) {
		switch(rgce[i][0]) {
			case 'PtgArray': /* PtgArray -> PtgExtraArray */
				rgce[i][1] = parse_PtgExtraArray(blob, 0, opts);
				o.push(rgce[i][1]);
				break;
			case 'PtgMemArea': /* PtgMemArea -> PtgExtraMem */
				rgce[i][2] = parse_PtgExtraMem(blob, rgce[i][1], opts);
				o.push(rgce[i][2]);
				break;
			case 'PtgExp': /* PtgExp -> PtgExtraCol */
				if(opts && opts.biff == 12) {
					rgce[i][1][1] = blob.read_shift(4);
					o.push(rgce[i][1]);
				} break;
			case 'PtgList': /* TODO: PtgList -> PtgExtraList */
			case 'PtgElfRadicalS': /* TODO: PtgElfRadicalS -> PtgExtraElf */
			case 'PtgElfColS': /* TODO: PtgElfColS -> PtgExtraElf */
			case 'PtgElfColSV': /* TODO: PtgElfColSV -> PtgExtraElf */
				throw "Unsupported " + rgce[i][0];
			default: break;
		}
	}
	length = target - blob.l;
	/* note: this is technically an error but Excel disregards */
	//if(target !== blob.l && blob.l !== target - length) throw new Error(target + " != " + blob.l);
	if(length !== 0) o.push(parsenoop(blob, length));
	return o;
}

/* [MS-XLS] 2.5.198.104 ; [MS-XLSB] 2.5.97.88 */
function parse_Rgce(blob, length, opts) {
	var target = blob.l + length;
	var R, id, ptgs = [];
	while(target != blob.l) {
		length = target - blob.l;
		id = blob[blob.l];
		R = PtgTypes[id] || PtgTypes[PtgDupes[id]];
		if(id === 0x18 || id === 0x19) R = (id === 0x18 ? Ptg18 : Ptg19)[blob[blob.l + 1]];
		if(!R || !R.f) { /*ptgs.push*/(parsenoop(blob, length)); }
		else { ptgs.push([R.n, R.f(blob, length, opts)]); }
	}
	return ptgs;
}

function stringify_array(f) {
	var o = [];
	for(var i = 0; i < f.length; ++i) {
		var x = f[i], r = [];
		for(var j = 0; j < x.length; ++j) {
			var y = x[j];
			if(y) switch(y[0]) {
				// TODO: handle embedded quotes
				case 0x02:
r.push('"' + y[1].replace(/"/g,'""') + '"'); break;
				default: r.push(y[1]);
			} else r.push("");
		}
		o.push(r.join(","));
	}
	return o.join(";");
}

/* [MS-XLS] 2.2.2 ; [MS-XLSB] 2.2.2 TODO */
var PtgBinOp = {
	PtgAdd: "+",
	PtgConcat: "&",
	PtgDiv: "/",
	PtgEq: "=",
	PtgGe: ">=",
	PtgGt: ">",
	PtgLe: "<=",
	PtgLt: "<",
	PtgMul: "*",
	PtgNe: "<>",
	PtgPower: "^",
	PtgSub: "-"
};

// TODO: explore space
function make_3d_range(start, end) {
	var s = start.lastIndexOf("!"), e = end.lastIndexOf("!");
	if(s == -1 && e == -1) return start + ":" + end;
	if(s > 0 && e > 0 && start.slice(0, s).toLowerCase() == end.slice(0, e).toLowerCase()) return start + ":" + end.slice(e+1);
	console.error("Cannot hydrate range", start, end);
	return start + ":" + end;
}

function get_ixti_raw(supbooks, ixti, opts) {
	if(!supbooks) return "SH33TJSERR0";
	if(opts.biff > 8 && (!supbooks.XTI || !supbooks.XTI[ixti])) return supbooks.SheetNames[ixti];
	if(!supbooks.XTI) return "SH33TJSERR6";
	var XTI = supbooks.XTI[ixti];
	if(opts.biff < 8) {
		if(ixti > 10000) ixti-= 65536;
		if(ixti < 0) ixti = -ixti;
		return ixti == 0 ? "" : supbooks.XTI[ixti - 1];
	}
	if(!XTI) return "SH33TJSERR1";
	var o = "";
	if(opts.biff > 8) switch(supbooks[XTI[0]][0]) {
		case 0x0165: /* 'BrtSupSelf' */
			o = XTI[1] == -1 ? "#REF" : supbooks.SheetNames[XTI[1]];
			return XTI[1] == XTI[2] ? o : o + ":" + supbooks.SheetNames[XTI[2]];
		case 0x0166: /* 'BrtSupSame' */
			if(opts.SID != null) return supbooks.SheetNames[opts.SID];
			return "SH33TJSSAME" + supbooks[XTI[0]][0];
		case 0x0163: /* 'BrtSupBookSrc' */
			/* falls through */
		default: return "SH33TJSSRC" + supbooks[XTI[0]][0];
	}
	switch(supbooks[XTI[0]][0][0]) {
		case 0x0401:
			o = XTI[1] == -1 ? "#REF" : (supbooks.SheetNames[XTI[1]] || "SH33TJSERR3");
			return XTI[1] == XTI[2] ? o : o + ":" + supbooks.SheetNames[XTI[2]];
		case 0x3A01: return supbooks[XTI[0]].slice(1).map(function(name) { return name.Name; }).join(";;"); //return "SH33TJSERR8";
		default:
			if(!supbooks[XTI[0]][0][3]) return "SH33TJSERR2";
			o = XTI[1] == -1 ? "#REF" : (supbooks[XTI[0]][0][3][XTI[1]] || "SH33TJSERR4");
			return XTI[1] == XTI[2] ? o : o + ":" + supbooks[XTI[0]][0][3][XTI[2]];
	}
}
function get_ixti(supbooks, ixti, opts) {
	var ixtiraw = get_ixti_raw(supbooks, ixti, opts);
	return ixtiraw == "#REF" ? ixtiraw : formula_quote_sheet_name(ixtiraw, opts);
}
function stringify_formula(formula/*Array<any>*/, range, cell, supbooks, opts) {
	var biff = (opts && opts.biff) || 8;
	var _range = /*range != null ? range :*/ {s:{c:0, r:0},e:{c:0, r:0}};
	var stack = [], e1, e2,  c, ixti=0, nameidx=0, r, sname="";
	if(!formula[0] || !formula[0][0]) return "";
	var last_sp = -1, sp = "";
	for(var ff = 0, fflen = formula[0].length; ff < fflen; ++ff) {
		var f = formula[0][ff];
		switch(f[0]) {
			case 'PtgUminus': /* [MS-XLS] 2.5.198.93 */
				stack.push("-" + stack.pop()); break;
			case 'PtgUplus': /* [MS-XLS] 2.5.198.95 */
				stack.push("+" + stack.pop()); break;
			case 'PtgPercent': /* [MS-XLS] 2.5.198.81 */
				stack.push(stack.pop() + "%"); break;

			case 'PtgAdd':    /* [MS-XLS] 2.5.198.26 */
			case 'PtgConcat': /* [MS-XLS] 2.5.198.43 */
			case 'PtgDiv':    /* [MS-XLS] 2.5.198.45 */
			case 'PtgEq':     /* [MS-XLS] 2.5.198.56 */
			case 'PtgGe':     /* [MS-XLS] 2.5.198.64 */
			case 'PtgGt':     /* [MS-XLS] 2.5.198.65 */
			case 'PtgLe':     /* [MS-XLS] 2.5.198.68 */
			case 'PtgLt':     /* [MS-XLS] 2.5.198.69 */
			case 'PtgMul':    /* [MS-XLS] 2.5.198.75 */
			case 'PtgNe':     /* [MS-XLS] 2.5.198.78 */
			case 'PtgPower':  /* [MS-XLS] 2.5.198.82 */
			case 'PtgSub':    /* [MS-XLS] 2.5.198.90 */
				e1 = stack.pop(); e2 = stack.pop();
				if(last_sp >= 0) {
					switch(formula[0][last_sp][1][0]) {
						case 0:
							// $FlowIgnore
							sp = fill(" ", formula[0][last_sp][1][1]); break;
						case 1:
							// $FlowIgnore
							sp = fill("\r", formula[0][last_sp][1][1]); break;
						default:
							sp = "";
							// $FlowIgnore
							if(opts.WTF) throw new Error("Unexpected PtgAttrSpaceType " + formula[0][last_sp][1][0]);
					}
					e2 = e2 + sp;
					last_sp = -1;
				}
				stack.push(e2+PtgBinOp[f[0]]+e1);
				break;

			case 'PtgIsect': /* [MS-XLS] 2.5.198.67 */
				e1 = stack.pop(); e2 = stack.pop();
				stack.push(e2+" "+e1);
				break;
			case 'PtgUnion': /* [MS-XLS] 2.5.198.94 */
				e1 = stack.pop(); e2 = stack.pop();
				stack.push(e2+","+e1);
				break;
			case 'PtgRange': /* [MS-XLS] 2.5.198.83 */
				e1 = stack.pop(); e2 = stack.pop();
				stack.push(make_3d_range(e2,e1));
				break;

			case 'PtgAttrChoose': /* [MS-XLS] 2.5.198.34 */
				break;
			case 'PtgAttrGoto': /* [MS-XLS] 2.5.198.35 */
				break;
			case 'PtgAttrIf': /* [MS-XLS] 2.5.198.36 */
				break;
			case 'PtgAttrIfError': /* [MS-XLSB] 2.5.97.28 */
				break;


			case 'PtgRef': /* [MS-XLS] 2.5.198.84 */
c = shift_cell_xls((f[1][1]), _range, opts);
				stack.push(encode_cell_xls(c, biff));
				break;
			case 'PtgRefN': /* [MS-XLS] 2.5.198.88 */
c = cell ? shift_cell_xls((f[1][1]), cell, opts) : (f[1][1]);
				stack.push(encode_cell_xls(c, biff));
				break;
			case 'PtgRef3d': /* [MS-XLS] 2.5.198.85 */
ixti = f[1][1]; c = shift_cell_xls((f[1][2]), _range, opts);
				sname = get_ixti(supbooks, ixti, opts);
				var w = sname; /* IE9 fails on defined names */ // eslint-disable-line no-unused-vars
				stack.push(sname + "!" + encode_cell_xls(c, biff));
				break;

			case 'PtgFunc': /* [MS-XLS] 2.5.198.62 */
			case 'PtgFuncVar': /* [MS-XLS] 2.5.198.63 */
				/* f[1] = [argc, func, type] */
				var argc = (f[1][0]), func = (f[1][1]);
				if(!argc) argc = 0;
				argc &= 0x7F;
				var args = argc == 0 ? [] : stack.slice(-argc);
				stack.length -= argc;
				if(func === 'User') func = args.shift();
				stack.push(func + "(" + args.join(",") + ")");
				break;

			case 'PtgBool': /* [MS-XLS] 2.5.198.42 */
				stack.push(f[1] ? "TRUE" : "FALSE"); break;
			case 'PtgInt': /* [MS-XLS] 2.5.198.66 */
				stack.push(f[1]); break;
			case 'PtgNum': /* [MS-XLS] 2.5.198.79 TODO: precision? */
				stack.push(String(f[1])); break;
			case 'PtgStr': /* [MS-XLS] 2.5.198.89 */
				// $FlowIgnore
				stack.push('"' + f[1].replace(/"/g, '""') + '"'); break;
			case 'PtgErr': /* [MS-XLS] 2.5.198.57 */
				stack.push(f[1]); break;
			case 'PtgAreaN': /* [MS-XLS] 2.5.198.31 TODO */
r = shift_range_xls(f[1][1], cell ? {s:cell} : _range, opts);
				stack.push(encode_range_xls((r), opts));
				break;
			case 'PtgArea': /* [MS-XLS] 2.5.198.27 TODO: fixed points */
r = shift_range_xls(f[1][1], _range, opts);
				stack.push(encode_range_xls((r), opts));
				break;
			case 'PtgArea3d': /* [MS-XLS] 2.5.198.28 TODO */
ixti = f[1][1]; r = f[1][2];
				sname = get_ixti(supbooks, ixti, opts);
				stack.push(sname + "!" + encode_range_xls((r), opts));
				break;
			case 'PtgAttrSum': /* [MS-XLS] 2.5.198.41 */
				stack.push("SUM(" + stack.pop() + ")");
				break;

			case 'PtgAttrBaxcel': /* [MS-XLS] 2.5.198.33 */
			case 'PtgAttrSemi': /* [MS-XLS] 2.5.198.37 */
				break;

			case 'PtgName': /* [MS-XLS] 2.5.198.76 ; [MS-XLSB] 2.5.97.60 TODO: revisions */
				/* f[1] = type, 0, nameindex */
				nameidx = (f[1][2]);
				var lbl = (supbooks.names||[])[nameidx-1] || (supbooks[0]||[])[nameidx];
				var name = lbl ? lbl.Name : "SH33TJSNAME" + String(nameidx);
				/* [MS-XLSB] 2.5.97.10 Ftab -- last verified 20220204 */
				if(name && name.slice(0,6) == "_xlfn." && !opts.xlfn) name = name.slice(6);
				stack.push(name);
				break;

			case 'PtgNameX': /* [MS-XLS] 2.5.198.77 ; [MS-XLSB] 2.5.97.61 TODO: revisions */
				/* f[1] = type, ixti, nameindex */
				var bookidx = (f[1][1]); nameidx = (f[1][2]); var externbook;
				/* TODO: Properly handle missing values -- this should be using get_ixti_raw primarily */
				if(opts.biff <= 5) {
					if(bookidx < 0) bookidx = -bookidx;
					if(supbooks[bookidx]) externbook = supbooks[bookidx][nameidx];
				} else {
					var o = "";
					if(((supbooks[bookidx]||[])[0]||[])[0] == 0x3A01){/* empty */}
					else if(((supbooks[bookidx]||[])[0]||[])[0] == 0x0401){
						if(supbooks[bookidx][nameidx] && supbooks[bookidx][nameidx].itab > 0) {
							o = supbooks.SheetNames[supbooks[bookidx][nameidx].itab-1] + "!";
						}
					}
					else o = supbooks.SheetNames[nameidx-1]+ "!";
					if(supbooks[bookidx] && supbooks[bookidx][nameidx]) o += supbooks[bookidx][nameidx].Name;
					else if(supbooks[0] && supbooks[0][nameidx]) o += supbooks[0][nameidx].Name;
					else {
						var ixtidata = (get_ixti_raw(supbooks, bookidx, opts)||"").split(";;");
						if(ixtidata[nameidx - 1]) o = ixtidata[nameidx - 1]; // TODO: confirm this is correct
						else o += "SH33TJSERRX";
					}
					stack.push(o);
					break;
				}
				if(!externbook) externbook = {Name: "SH33TJSERRY"};
				stack.push(externbook.Name);
				break;

			case 'PtgParen': /* [MS-XLS] 2.5.198.80 */
				var lp = '(', rp = ')';
				if(last_sp >= 0) {
					sp = "";
					switch(formula[0][last_sp][1][0]) {
						// $FlowIgnore
						case 2: lp = fill(" ", formula[0][last_sp][1][1]) + lp; break;
						// $FlowIgnore
						case 3: lp = fill("\r", formula[0][last_sp][1][1]) + lp; break;
						// $FlowIgnore
						case 4: rp = fill(" ", formula[0][last_sp][1][1]) + rp; break;
						// $FlowIgnore
						case 5: rp = fill("\r", formula[0][last_sp][1][1]) + rp; break;
						default:
							// $FlowIgnore
							if(opts.WTF) throw new Error("Unexpected PtgAttrSpaceType " + formula[0][last_sp][1][0]);
					}
					last_sp = -1;
				}
				stack.push(lp + stack.pop() + rp); break;

			case 'PtgRefErr': /* [MS-XLS] 2.5.198.86 */
				stack.push('#REF!'); break;

			case 'PtgRefErr3d': /* [MS-XLS] 2.5.198.87 */
				stack.push('#REF!'); break;

			case 'PtgExp': /* [MS-XLS] 2.5.198.58 TODO */
				c = {c:(f[1][1]),r:(f[1][0])};
				var q = ({c: cell.c, r:cell.r});
				if(supbooks.sharedf[encode_cell(c)]) {
					var parsedf = (supbooks.sharedf[encode_cell(c)]);
					stack.push(stringify_formula(parsedf, _range, q, supbooks, opts));
				} else {
					var fnd = false;
					for(e1=0;e1!=supbooks.arrayf.length; ++e1) {
						/* TODO: should be something like range_has */
						e2 = supbooks.arrayf[e1];
						if(c.c < e2[0].s.c || c.c > e2[0].e.c) continue;
						if(c.r < e2[0].s.r || c.r > e2[0].e.r) continue;
						stack.push(stringify_formula(e2[1], _range, q, supbooks, opts));
						fnd = true;
						break;
					}
					if(!fnd) stack.push(f[1]);
				}
				break;

			case 'PtgArray': /* [MS-XLS] 2.5.198.32 TODO */
				stack.push("{" + stringify_array(f[1]) + "}");
				break;

			case 'PtgMemArea': /* [MS-XLS] 2.5.198.70 TODO: confirm this is a non-display */
				//stack.push("(" + f[2].map(encode_range).join(",") + ")");
				break;

			case 'PtgAttrSpace': /* [MS-XLS] 2.5.198.38 */
			case 'PtgAttrSpaceSemi': /* [MS-XLS] 2.5.198.39 */
				last_sp = ff;
				break;

			case 'PtgTbl': /* [MS-XLS] 2.5.198.92 TODO */
				break;

			case 'PtgMemErr': /* [MS-XLS] 2.5.198.71 */
				break;

			case 'PtgMissArg': /* [MS-XLS] 2.5.198.74 */
				stack.push("");
				break;

			case 'PtgAreaErr': /* [MS-XLS] 2.5.198.29 */
				stack.push("#REF!"); break;

			case 'PtgAreaErr3d': /* [MS-XLS] 2.5.198.30 */
				stack.push("#REF!"); break;

			case 'PtgList': /* [MS-XLSB] 2.5.97.52 */
				// $FlowIgnore
				stack.push("Table" + f[1].idx + "[#" + f[1].rt + "]");
				break;

			case 'PtgMemAreaN':
			case 'PtgMemNoMemN':
			case 'PtgAttrNoop':
			case 'PtgSheet':
			case 'PtgEndSheet':
				break;

			case 'PtgMemFunc': /* [MS-XLS] 2.5.198.72 TODO */
				break;
			case 'PtgMemNoMem': /* [MS-XLS] 2.5.198.73 TODO */
				break;

			case 'PtgElfCol': /* [MS-XLS] 2.5.198.46 */
			case 'PtgElfColS': /* [MS-XLS] 2.5.198.47 */
			case 'PtgElfColSV': /* [MS-XLS] 2.5.198.48 */
			case 'PtgElfColV': /* [MS-XLS] 2.5.198.49 */
			case 'PtgElfLel': /* [MS-XLS] 2.5.198.50 */
			case 'PtgElfRadical': /* [MS-XLS] 2.5.198.51 */
			case 'PtgElfRadicalLel': /* [MS-XLS] 2.5.198.52 */
			case 'PtgElfRadicalS': /* [MS-XLS] 2.5.198.53 */
			case 'PtgElfRw': /* [MS-XLS] 2.5.198.54 */
			case 'PtgElfRwV': /* [MS-XLS] 2.5.198.55 */
				throw new Error("Unsupported ELFs");

			case 'PtgSxName': /* [MS-XLS] 2.5.198.91 TODO -- find a test case */
				throw new Error('Unrecognized Formula Token: ' + String(f));
			default: throw new Error('Unrecognized Formula Token: ' + String(f));
		}
		var PtgNonDisp = ['PtgAttrSpace', 'PtgAttrSpaceSemi', 'PtgAttrGoto'];
		if(opts.biff != 3) if(last_sp >= 0 && PtgNonDisp.indexOf(formula[0][ff][0]) == -1) {
			f = formula[0][last_sp];
			var _left = true;
			switch(f[1][0]) {
				/* note: some bad XLSB files omit the PtgParen */
				case 4: _left = false;
				/* falls through */
				case 0:
					// $FlowIgnore
					sp = fill(" ", f[1][1]); break;
				case 5: _left = false;
				/* falls through */
				case 1:
					// $FlowIgnore
					sp = fill("\r", f[1][1]); break;
				default:
					sp = "";
					// $FlowIgnore
					if(opts.WTF) throw new Error("Unexpected PtgAttrSpaceType " + f[1][0]);
			}
			stack.push((_left ? sp : "") + stack.pop() + (_left ? "" : sp));
			last_sp = -1;
		}
	}
	if(stack.length > 1 && opts.WTF) throw new Error("bad formula stack");
	if(stack[0] == "TRUE") return true; if(stack[0] == "FALSE") return false;
	return stack[0];
}

/* [MS-XLS] 2.5.198.1 TODO */
function parse_ArrayParsedFormula(blob, length, opts) {
	var target = blob.l + length, len = opts.biff == 2 ? 1 : 2;
	var rgcb, cce = blob.read_shift(len); // length of rgce
	if(cce == 0xFFFF) return [[],parsenoop(blob, length-2)];
	var rgce = parse_Rgce(blob, cce, opts);
	if(length !== cce + len) rgcb = parse_RgbExtra(blob, length - cce - len, rgce, opts);
	blob.l = target;
	return [rgce, rgcb];
}

/* [MS-XLS] 2.5.198.3 TODO */
function parse_XLSCellParsedFormula(blob, length, opts) {
	var target = blob.l + length, len = opts.biff == 2 ? 1 : 2;
	var rgcb, cce = blob.read_shift(len); // length of rgce
	if(cce == 0xFFFF) return [[],parsenoop(blob, length-2)];
	var rgce = parse_Rgce(blob, cce, opts);
	if(length !== cce + len) rgcb = parse_RgbExtra(blob, length - cce - len, rgce, opts);
	blob.l = target;
	return [rgce, rgcb];
}

/* [MS-XLS] 2.5.198.21 */
function parse_NameParsedFormula(blob, length, opts, cce) {
	var target = blob.l + length;
	var rgce = parse_Rgce(blob, cce, opts);
	var rgcb;
	if(target !== blob.l) rgcb = parse_RgbExtra(blob, target - blob.l, rgce, opts);
	return [rgce, rgcb];
}

/* [MS-XLS] 2.5.198.118 TODO */
function parse_SharedParsedFormula(blob, length, opts) {
	var target = blob.l + length;
	var rgcb, cce = blob.read_shift(2); // length of rgce
	var rgce = parse_Rgce(blob, cce, opts);
	if(cce == 0xFFFF) return [[],parsenoop(blob, length-2)];
	if(length !== cce + 2) rgcb = parse_RgbExtra(blob, target - cce - 2, rgce, opts);
	return [rgce, rgcb];
}

/* [MS-XLS] 2.5.133 TODO: how to emit empty strings? */
function parse_FormulaValue(blob) {
	var b;
	if(__readUInt16LE(blob,blob.l + 6) !== 0xFFFF) return [parse_Xnum(blob),'n'];
	switch(blob[blob.l]) {
		case 0x00: blob.l += 8; return ["String", 's'];
		case 0x01: b = blob[blob.l+2] === 0x1; blob.l += 8; return [b,'b'];
		case 0x02: b = blob[blob.l+2]; blob.l += 8; return [b,'e'];
		case 0x03: blob.l += 8; return ["",'s'];
	}
	return [];
}
function write_FormulaValue(value) {
	if(value == null) {
		// Blank String Value
		var o = new_buf(8);
		o.write_shift(1, 0x03);
		o.write_shift(1, 0);
		o.write_shift(2, 0);
		o.write_shift(2, 0);
		o.write_shift(2, 0xFFFF);
		return o;
	} else if(typeof value == "number") return write_Xnum(value);
	return write_Xnum(0);
}

/* [MS-XLS] 2.4.127 TODO */
function parse_Formula(blob, length, opts) {
	var end = blob.l + length;
	var cell = parse_XLSCell(blob, 6, opts);
	var val = parse_FormulaValue(blob,8);
	var flags = blob.read_shift(1);
	if(opts.biff != 2) {
		blob.read_shift(1);
		if(opts.biff >= 5) {
			/*var chn = */blob.read_shift(4);
		}
	}
	var cbf = parse_XLSCellParsedFormula(blob, end - blob.l, opts);
	return {cell:cell, val:val[0], formula:cbf, shared: (flags >> 3) & 1, tt:val[1]};
}
function write_Formula(cell, R, C, opts, os) {
	// Cell
	var o1 = write_XLSCell(R, C, os);

	// FormulaValue
	var o2 = write_FormulaValue(cell.v);

	// flags + cache
	var o3 = new_buf(6);
	var flags = 0x01 | 0x20;
	o3.write_shift(2, flags);
	o3.write_shift(4, 0);

	// CellParsedFormula
	var bf = new_buf(cell.bf.length);
	for(var i = 0; i < cell.bf.length; ++i) bf[i] = cell.bf[i];

	var out = bconcat([o1, o2, o3, bf]);
	return out;
}


/* XLSB Parsed Formula records have the same shape */
function parse_XLSBParsedFormula(data, length, opts) {
	var cce = data.read_shift(4);
	var rgce = parse_Rgce(data, cce, opts);
	var cb = data.read_shift(4);
	var rgcb = cb > 0 ? parse_RgbExtra(data, cb, rgce, opts) : null;
	return [rgce, rgcb];
}

/* [MS-XLSB] 2.5.97.1 ArrayParsedFormula */
var parse_XLSBArrayParsedFormula = parse_XLSBParsedFormula;
/* [MS-XLSB] 2.5.97.4 CellParsedFormula */
var parse_XLSBCellParsedFormula = parse_XLSBParsedFormula;
/* [MS-XLSB] 2.5.97.8 DVParsedFormula */
//var parse_XLSBDVParsedFormula = parse_XLSBParsedFormula;
/* [MS-XLSB] 2.5.97.9 FRTParsedFormula */
//var parse_XLSBFRTParsedFormula = parse_XLSBParsedFormula2;
/* [MS-XLSB] 2.5.97.12 NameParsedFormula */
var parse_XLSBNameParsedFormula = parse_XLSBParsedFormula;
/* [MS-XLSB] 2.5.97.98 SharedParsedFormula */
var parse_XLSBSharedParsedFormula = parse_XLSBParsedFormula;

/* Writes a PtgNum or PtgInt */
function write_XLSBFormulaNum(val) {
	if((val | 0) == val && val < Math.pow(2,16) && val >= 0) {
		var oint = new_buf(11);
		oint.write_shift(4, 3);
		oint.write_shift(1, 0x1e);
		oint.write_shift(2, val);
		oint.write_shift(4, 0);
		return oint;
	}

	var num = new_buf(17);
	num.write_shift(4, 11);
	num.write_shift(1, 0x1f);
	num.write_shift(8, val);
	num.write_shift(4, 0);
	return num;
}
/* Writes a PtgErr */
function write_XLSBFormulaErr(val) {
	var oint = new_buf(10);
	oint.write_shift(4, 2);
	oint.write_shift(1, 0x1C);
	oint.write_shift(1, val);
	oint.write_shift(4, 0);
	return oint;
}
/* Writes a PtgBool */
function write_XLSBFormulaBool(val) {
	var oint = new_buf(10);
	oint.write_shift(4, 2);
	oint.write_shift(1, 0x1D);
	oint.write_shift(1, val?1:0);
	oint.write_shift(4, 0);
	return oint;
}

/* Writes a PtgStr */
function write_XLSBFormulaStr(val) {
	var preamble = new_buf(7);
	preamble.write_shift(4, 3 + 2 * val.length);
	preamble.write_shift(1, 0x17);
	preamble.write_shift(2, val.length);

	var body = new_buf(2 * val.length);
	body.write_shift(2 * val.length, val, "utf16le");

	var postamble = new_buf(4);
	postamble.write_shift(4, 0);

	return bconcat([preamble, body, postamble]);
}

/* Writes a PtgRef */
function write_XLSBFormulaRef(str) {
	var cell = decode_cell(str);
	var out = new_buf(15);
	out.write_shift(4, 7);
	out.write_shift(1, 0x04 | ((1)<<5));
	out.write_shift(4, cell.r);
	out.write_shift(2, cell.c | ((str.charAt(0) == "$" ? 0 : 1)<<14) | ((str.match(/\$\d/) ? 0 : 1)<<15)); // <== ColRelShort
	out.write_shift(4, 0);

	return out;
}

/* Writes a PtgRef3d */
function write_XLSBFormulaRef3D(str, wb) {
	var lastbang = str.lastIndexOf("!");
	var sname = str.slice(0, lastbang);
	str = str.slice(lastbang+1);
	var cell = decode_cell(str);
	if(sname.charAt(0) == "'") sname = sname.slice(1, -1).replace(/''/g, "'");

	var out = new_buf(17);
	out.write_shift(4, 9);
	out.write_shift(1, 0x1A | ((1)<<5));
	out.write_shift(2, 2 + wb.SheetNames.map(function(n) { return n.toLowerCase(); }).indexOf(sname.toLowerCase()));
	out.write_shift(4, cell.r);
	out.write_shift(2, cell.c | ((str.charAt(0) == "$" ? 0 : 1)<<14) | ((str.match(/\$\d/) ? 0 : 1)<<15)); // <== ColRelShort
	out.write_shift(4, 0);

	return out;
}

/* Writes a PtgRefErr3d */
function write_XLSBFormulaRefErr3D(str, wb) {
	var lastbang = str.lastIndexOf("!");
	var sname = str.slice(0, lastbang);
	str = str.slice(lastbang+1);
	if(sname.charAt(0) == "'") sname = sname.slice(1, -1).replace(/''/g, "'");

	var out = new_buf(17);
	out.write_shift(4, 9);
	out.write_shift(1, 0x1C | ((1)<<5));
	out.write_shift(2, 2 + wb.SheetNames.map(function(n) { return n.toLowerCase(); }).indexOf(sname.toLowerCase()));
	out.write_shift(4, 0);
	out.write_shift(2, 0); // <== ColRelShort
	out.write_shift(4, 0);

	return out;
}

/* Writes a single sheet range [PtgRef PtgRef PtgRange] */
function write_XLSBFormulaRange(_str) {
	var parts = _str.split(":"), str = parts[0];

	var out = new_buf(23);
	out.write_shift(4, 15);

	/* start cell */
	str = parts[0]; var cell = decode_cell(str);
	out.write_shift(1, 0x04 | ((1)<<5));
	out.write_shift(4, cell.r);
	out.write_shift(2, cell.c | ((str.charAt(0) == "$" ? 0 : 1)<<14) | ((str.match(/\$\d/) ? 0 : 1)<<15)); // <== ColRelShort
	out.write_shift(4, 0);

	/* end cell */
	str = parts[1]; cell = decode_cell(str);
	out.write_shift(1, 0x04 | ((1)<<5));
	out.write_shift(4, cell.r);
	out.write_shift(2, cell.c | ((str.charAt(0) == "$" ? 0 : 1)<<14) | ((str.match(/\$\d/) ? 0 : 1)<<15)); // <== ColRelShort
	out.write_shift(4, 0);

	/* PtgRange */
	out.write_shift(1, 0x11);

	out.write_shift(4, 0);

	return out;
}

/* Writes a range with explicit sheet name [PtgRef3D PtgRef3D PtgRange] */
function write_XLSBFormulaRangeWS(_str, wb) {
	var lastbang = _str.lastIndexOf("!");
	var sname = _str.slice(0, lastbang);
	_str = _str.slice(lastbang+1);
	if(sname.charAt(0) == "'") sname = sname.slice(1, -1).replace(/''/g, "'");
	var parts = _str.split(":");

	var out = new_buf(27);
	out.write_shift(4, 19);

	/* start cell */
	var str = parts[0], cell = decode_cell(str);
	out.write_shift(1, 0x1A | ((1)<<5));
	out.write_shift(2, 2 + wb.SheetNames.map(function(n) { return n.toLowerCase(); }).indexOf(sname.toLowerCase()));
	out.write_shift(4, cell.r);
	out.write_shift(2, cell.c | ((str.charAt(0) == "$" ? 0 : 1)<<14) | ((str.match(/\$\d/) ? 0 : 1)<<15)); // <== ColRelShort

	/* end cell */
	str = parts[1]; cell = decode_cell(str);
	out.write_shift(1, 0x1A | ((1)<<5));
	out.write_shift(2, 2 + wb.SheetNames.map(function(n) { return n.toLowerCase(); }).indexOf(sname.toLowerCase()));
	out.write_shift(4, cell.r);
	out.write_shift(2, cell.c | ((str.charAt(0) == "$" ? 0 : 1)<<14) | ((str.match(/\$\d/) ? 0 : 1)<<15)); // <== ColRelShort

	/* PtgRange */
	out.write_shift(1, 0x11);

	out.write_shift(4, 0);

	return out;
}

/* Writes a range with explicit sheet name [PtgArea3d] */
function write_XLSBFormulaArea3D(_str, wb) {
	var lastbang = _str.lastIndexOf("!");
	var sname = _str.slice(0, lastbang);
	_str = _str.slice(lastbang+1);
	if(sname.charAt(0) == "'") sname = sname.slice(1, -1).replace(/''/g, "'");
	var range = decode_range(_str);

	var out = new_buf(23);
	out.write_shift(4, 15);

	out.write_shift(1, 0x1B | ((1)<<5));
	out.write_shift(2, 2 + wb.SheetNames.map(function(n) { return n.toLowerCase(); }).indexOf(sname.toLowerCase()));
	out.write_shift(4, range.s.r);
	out.write_shift(4, range.e.r);
	out.write_shift(2, range.s.c);
	out.write_shift(2, range.e.c);

	out.write_shift(4, 0);

	return out;
}


/* General Formula */
function write_XLSBFormula(val, wb) {
	if(typeof val == "number") return write_XLSBFormulaNum(val);
	if(typeof val == "boolean") return write_XLSBFormulaBool(val);
	if(/^#(DIV\/0!|GETTING_DATA|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!)$/.test(val)) return write_XLSBFormulaErr(+RBErr[val]);
	if(val.match(/^\$?(?:[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D]|[A-Z]{1,2})\$?(?:10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5})$/)) return write_XLSBFormulaRef(val);
	if(val.match(/^\$?(?:[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D]|[A-Z]{1,2})\$?(?:10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5}):\$?(?:[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D]|[A-Z]{1,2})\$?(?:10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5})$/)) return write_XLSBFormulaRange(val);
	if(val.match(/^#REF!\$?(?:[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D]|[A-Z]{1,2})\$?(?:10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5}):\$?(?:[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D]|[A-Z]{1,2})\$?(?:10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5})$/)) return write_XLSBFormulaArea3D(val, wb);
	if(val.match(/^(?:'[^\\\/?*\[\]:]*'|[^'][^\\\/?*\[\]:'`~!@#$%^()\-=+{}|;,<.>]*)!\$?(?:[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D]|[A-Z]{1,2})\$?(?:10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5})$/)) return write_XLSBFormulaRef3D(val, wb);
	if(val.match(/^(?:'[^\\\/?*\[\]:]*'|[^'][^\\\/?*\[\]:'`~!@#$%^()\-=+{}|;,<.>]*)!\$?(?:[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D]|[A-Z]{1,2})\$?(?:10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5}):\$?(?:[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D]|[A-Z]{1,2})\$?(?:10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5})$/)) return write_XLSBFormulaRangeWS(val, wb);
	if(/^(?:'[^\\\/?*\[\]:]*'|[^'][^\\\/?*\[\]:'`~!@#$%^()\-=+{}|;,<.>]*)!#REF!$/.test(val)) return write_XLSBFormulaRefErr3D(val, wb);
	if(/^".*"$/.test(val)) return write_XLSBFormulaStr(val);
	if(/^[+-]\d+$/.test(val)) return write_XLSBFormulaNum(parseInt(val, 10));
	throw "Formula |" + val + "| not supported for XLSB";
}
var write_XLSBNameParsedFormula = write_XLSBFormula;
var Cetab = {
  0: "BEEP",
  1: "OPEN",
  2: "OPEN.LINKS",
  3: "CLOSE.ALL",
  4: "SAVE",
  5: "SAVE.AS",
  6: "FILE.DELETE",
  7: "PAGE.SETUP",
  8: "PRINT",
  9: "PRINTER.SETUP",
  10: "QUIT",
  11: "NEW.WINDOW",
  12: "ARRANGE.ALL",
  13: "WINDOW.SIZE",
  14: "WINDOW.MOVE",
  15: "FULL",
  16: "CLOSE",
  17: "RUN",
  22: "SET.PRINT.AREA",
  23: "SET.PRINT.TITLES",
  24: "SET.PAGE.BREAK",
  25: "REMOVE.PAGE.BREAK",
  26: "FONT",
  27: "DISPLAY",
  28: "PROTECT.DOCUMENT",
  29: "PRECISION",
  30: "A1.R1C1",
  31: "CALCULATE.NOW",
  32: "CALCULATION",
  34: "DATA.FIND",
  35: "EXTRACT",
  36: "DATA.DELETE",
  37: "SET.DATABASE",
  38: "SET.CRITERIA",
  39: "SORT",
  40: "DATA.SERIES",
  41: "TABLE",
  42: "FORMAT.NUMBER",
  43: "ALIGNMENT",
  44: "STYLE",
  45: "BORDER",
  46: "CELL.PROTECTION",
  47: "COLUMN.WIDTH",
  48: "UNDO",
  49: "CUT",
  50: "COPY",
  51: "PASTE",
  52: "CLEAR",
  53: "PASTE.SPECIAL",
  54: "EDIT.DELETE",
  55: "INSERT",
  56: "FILL.RIGHT",
  57: "FILL.DOWN",
  61: "DEFINE.NAME",
  62: "CREATE.NAMES",
  63: "FORMULA.GOTO",
  64: "FORMULA.FIND",
  65: "SELECT.LAST.CELL",
  66: "SHOW.ACTIVE.CELL",
  67: "GALLERY.AREA",
  68: "GALLERY.BAR",
  69: "GALLERY.COLUMN",
  70: "GALLERY.LINE",
  71: "GALLERY.PIE",
  72: "GALLERY.SCATTER",
  73: "COMBINATION",
  74: "PREFERRED",
  75: "ADD.OVERLAY",
  76: "GRIDLINES",
  77: "SET.PREFERRED",
  78: "AXES",
  79: "LEGEND",
  80: "ATTACH.TEXT",
  81: "ADD.ARROW",
  82: "SELECT.CHART",
  83: "SELECT.PLOT.AREA",
  84: "PATTERNS",
  85: "MAIN.CHART",
  86: "OVERLAY",
  87: "SCALE",
  88: "FORMAT.LEGEND",
  89: "FORMAT.TEXT",
  90: "EDIT.REPEAT",
  91: "PARSE",
  92: "JUSTIFY",
  93: "HIDE",
  94: "UNHIDE",
  95: "WORKSPACE",
  96: "FORMULA",
  97: "FORMULA.FILL",
  98: "FORMULA.ARRAY",
  99: "DATA.FIND.NEXT",
  100: "DATA.FIND.PREV",
  101: "FORMULA.FIND.NEXT",
  102: "FORMULA.FIND.PREV",
  103: "ACTIVATE",
  104: "ACTIVATE.NEXT",
  105: "ACTIVATE.PREV",
  106: "UNLOCKED.NEXT",
  107: "UNLOCKED.PREV",
  108: "COPY.PICTURE",
  109: "SELECT",
  110: "DELETE.NAME",
  111: "DELETE.FORMAT",
  112: "VLINE",
  113: "HLINE",
  114: "VPAGE",
  115: "HPAGE",
  116: "VSCROLL",
  117: "HSCROLL",
  118: "ALERT",
  119: "NEW",
  120: "CANCEL.COPY",
  121: "SHOW.CLIPBOARD",
  122: "MESSAGE",
  124: "PASTE.LINK",
  125: "APP.ACTIVATE",
  126: "DELETE.ARROW",
  127: "ROW.HEIGHT",
  128: "FORMAT.MOVE",
  129: "FORMAT.SIZE",
  130: "FORMULA.REPLACE",
  131: "SEND.KEYS",
  132: "SELECT.SPECIAL",
  133: "APPLY.NAMES",
  134: "REPLACE.FONT",
  135: "FREEZE.PANES",
  136: "SHOW.INFO",
  137: "SPLIT",
  138: "ON.WINDOW",
  139: "ON.DATA",
  140: "DISABLE.INPUT",
  142: "OUTLINE",
  143: "LIST.NAMES",
  144: "FILE.CLOSE",
  145: "SAVE.WORKBOOK",
  146: "DATA.FORM",
  147: "COPY.CHART",
  148: "ON.TIME",
  149: "WAIT",
  150: "FORMAT.FONT",
  151: "FILL.UP",
  152: "FILL.LEFT",
  153: "DELETE.OVERLAY",
  155: "SHORT.MENUS",
  159: "SET.UPDATE.STATUS",
  161: "COLOR.PALETTE",
  162: "DELETE.STYLE",
  163: "WINDOW.RESTORE",
  164: "WINDOW.MAXIMIZE",
  166: "CHANGE.LINK",
  167: "CALCULATE.DOCUMENT",
  168: "ON.KEY",
  169: "APP.RESTORE",
  170: "APP.MOVE",
  171: "APP.SIZE",
  172: "APP.MINIMIZE",
  173: "APP.MAXIMIZE",
  174: "BRING.TO.FRONT",
  175: "SEND.TO.BACK",
  185: "MAIN.CHART.TYPE",
  186: "OVERLAY.CHART.TYPE",
  187: "SELECT.END",
  188: "OPEN.MAIL",
  189: "SEND.MAIL",
  190: "STANDARD.FONT",
  191: "CONSOLIDATE",
  192: "SORT.SPECIAL",
  193: "GALLERY.3D.AREA",
  194: "GALLERY.3D.COLUMN",
  195: "GALLERY.3D.LINE",
  196: "GALLERY.3D.PIE",
  197: "VIEW.3D",
  198: "GOAL.SEEK",
  199: "WORKGROUP",
  200: "FILL.GROUP",
  201: "UPDATE.LINK",
  202: "PROMOTE",
  203: "DEMOTE",
  204: "SHOW.DETAIL",
  206: "UNGROUP",
  207: "OBJECT.PROPERTIES",
  208: "SAVE.NEW.OBJECT",
  209: "SHARE",
  210: "SHARE.NAME",
  211: "DUPLICATE",
  212: "APPLY.STYLE",
  213: "ASSIGN.TO.OBJECT",
  214: "OBJECT.PROTECTION",
  215: "HIDE.OBJECT",
  216: "SET.EXTRACT",
  217: "CREATE.PUBLISHER",
  218: "SUBSCRIBE.TO",
  219: "ATTRIBUTES",
  220: "SHOW.TOOLBAR",
  222: "PRINT.PREVIEW",
  223: "EDIT.COLOR",
  224: "SHOW.LEVELS",
  225: "FORMAT.MAIN",
  226: "FORMAT.OVERLAY",
  227: "ON.RECALC",
  228: "EDIT.SERIES",
  229: "DEFINE.STYLE",
  240: "LINE.PRINT",
  243: "ENTER.DATA",
  249: "GALLERY.RADAR",
  250: "MERGE.STYLES",
  251: "EDITION.OPTIONS",
  252: "PASTE.PICTURE",
  253: "PASTE.PICTURE.LINK",
  254: "SPELLING",
  256: "ZOOM",
  259: "INSERT.OBJECT",
  260: "WINDOW.MINIMIZE",
  265: "SOUND.NOTE",
  266: "SOUND.PLAY",
  267: "FORMAT.SHAPE",
  268: "EXTEND.POLYGON",
  269: "FORMAT.AUTO",
  272: "GALLERY.3D.BAR",
  273: "GALLERY.3D.SURFACE",
  274: "FILL.AUTO",
  276: "CUSTOMIZE.TOOLBAR",
  277: "ADD.TOOL",
  278: "EDIT.OBJECT",
  279: "ON.DOUBLECLICK",
  280: "ON.ENTRY",
  281: "WORKBOOK.ADD",
  282: "WORKBOOK.MOVE",
  283: "WORKBOOK.COPY",
  284: "WORKBOOK.OPTIONS",
  285: "SAVE.WORKSPACE",
  288: "CHART.WIZARD",
  289: "DELETE.TOOL",
  290: "MOVE.TOOL",
  291: "WORKBOOK.SELECT",
  292: "WORKBOOK.ACTIVATE",
  293: "ASSIGN.TO.TOOL",
  295: "COPY.TOOL",
  296: "RESET.TOOL",
  297: "CONSTRAIN.NUMERIC",
  298: "PASTE.TOOL",
  302: "WORKBOOK.NEW",
  305: "SCENARIO.CELLS",
  306: "SCENARIO.DELETE",
  307: "SCENARIO.ADD",
  308: "SCENARIO.EDIT",
  309: "SCENARIO.SHOW",
  310: "SCENARIO.SHOW.NEXT",
  311: "SCENARIO.SUMMARY",
  312: "PIVOT.TABLE.WIZARD",
  313: "PIVOT.FIELD.PROPERTIES",
  314: "PIVOT.FIELD",
  315: "PIVOT.ITEM",
  316: "PIVOT.ADD.FIELDS",
  318: "OPTIONS.CALCULATION",
  319: "OPTIONS.EDIT",
  320: "OPTIONS.VIEW",
  321: "ADDIN.MANAGER",
  322: "MENU.EDITOR",
  323: "ATTACH.TOOLBARS",
  324: "VBAActivate",
  325: "OPTIONS.CHART",
  328: "VBA.INSERT.FILE",
  330: "VBA.PROCEDURE.DEFINITION",
  336: "ROUTING.SLIP",
  338: "ROUTE.DOCUMENT",
  339: "MAIL.LOGON",
  342: "INSERT.PICTURE",
  343: "EDIT.TOOL",
  344: "GALLERY.DOUGHNUT",
  350: "CHART.TREND",
  352: "PIVOT.ITEM.PROPERTIES",
  354: "WORKBOOK.INSERT",
  355: "OPTIONS.TRANSITION",
  356: "OPTIONS.GENERAL",
  370: "FILTER.ADVANCED",
  373: "MAIL.ADD.MAILER",
  374: "MAIL.DELETE.MAILER",
  375: "MAIL.REPLY",
  376: "MAIL.REPLY.ALL",
  377: "MAIL.FORWARD",
  378: "MAIL.NEXT.LETTER",
  379: "DATA.LABEL",
  380: "INSERT.TITLE",
  381: "FONT.PROPERTIES",
  382: "MACRO.OPTIONS",
  383: "WORKBOOK.HIDE",
  384: "WORKBOOK.UNHIDE",
  385: "WORKBOOK.DELETE",
  386: "WORKBOOK.NAME",
  388: "GALLERY.CUSTOM",
  390: "ADD.CHART.AUTOFORMAT",
  391: "DELETE.CHART.AUTOFORMAT",
  392: "CHART.ADD.DATA",
  393: "AUTO.OUTLINE",
  394: "TAB.ORDER",
  395: "SHOW.DIALOG",
  396: "SELECT.ALL",
  397: "UNGROUP.SHEETS",
  398: "SUBTOTAL.CREATE",
  399: "SUBTOTAL.REMOVE",
  400: "RENAME.OBJECT",
  412: "WORKBOOK.SCROLL",
  413: "WORKBOOK.NEXT",
  414: "WORKBOOK.PREV",
  415: "WORKBOOK.TAB.SPLIT",
  416: "FULL.SCREEN",
  417: "WORKBOOK.PROTECT",
  420: "SCROLLBAR.PROPERTIES",
  421: "PIVOT.SHOW.PAGES",
  422: "TEXT.TO.COLUMNS",
  423: "FORMAT.CHARTTYPE",
  424: "LINK.FORMAT",
  425: "TRACER.DISPLAY",
  430: "TRACER.NAVIGATE",
  431: "TRACER.CLEAR",
  432: "TRACER.ERROR",
  433: "PIVOT.FIELD.GROUP",
  434: "PIVOT.FIELD.UNGROUP",
  435: "CHECKBOX.PROPERTIES",
  436: "LABEL.PROPERTIES",
  437: "LISTBOX.PROPERTIES",
  438: "EDITBOX.PROPERTIES",
  439: "PIVOT.REFRESH",
  440: "LINK.COMBO",
  441: "OPEN.TEXT",
  442: "HIDE.DIALOG",
  443: "SET.DIALOG.FOCUS",
  444: "ENABLE.OBJECT",
  445: "PUSHBUTTON.PROPERTIES",
  446: "SET.DIALOG.DEFAULT",
  447: "FILTER",
  448: "FILTER.SHOW.ALL",
  449: "CLEAR.OUTLINE",
  450: "FUNCTION.WIZARD",
  451: "ADD.LIST.ITEM",
  452: "SET.LIST.ITEM",
  453: "REMOVE.LIST.ITEM",
  454: "SELECT.LIST.ITEM",
  455: "SET.CONTROL.VALUE",
  456: "SAVE.COPY.AS",
  458: "OPTIONS.LISTS.ADD",
  459: "OPTIONS.LISTS.DELETE",
  460: "SERIES.AXES",
  461: "SERIES.X",
  462: "SERIES.Y",
  463: "ERRORBAR.X",
  464: "ERRORBAR.Y",
  465: "FORMAT.CHART",
  466: "SERIES.ORDER",
  467: "MAIL.LOGOFF",
  468: "CLEAR.ROUTING.SLIP",
  469: "APP.ACTIVATE.MICROSOFT",
  470: "MAIL.EDIT.MAILER",
  471: "ON.SHEET",
  472: "STANDARD.WIDTH",
  473: "SCENARIO.MERGE",
  474: "SUMMARY.INFO",
  475: "FIND.FILE",
  476: "ACTIVE.CELL.FONT",
  477: "ENABLE.TIPWIZARD",
  478: "VBA.MAKE.ADDIN",
  480: "INSERTDATATABLE",
  481: "WORKGROUP.OPTIONS",
  482: "MAIL.SEND.MAILER",
  485: "AUTOCORRECT",
  489: "POST.DOCUMENT",
  491: "PICKLIST",
  493: "VIEW.SHOW",
  494: "VIEW.DEFINE",
  495: "VIEW.DELETE",
  509: "SHEET.BACKGROUND",
  510: "INSERT.MAP.OBJECT",
  511: "OPTIONS.MENONO",
  517: "MSOCHECKS",
  518: "NORMAL",
  519: "LAYOUT",
  520: "RM.PRINT.AREA",
  521: "CLEAR.PRINT.AREA",
  522: "ADD.PRINT.AREA",
  523: "MOVE.BRK",
  545: "HIDECURR.NOTE",
  546: "HIDEALL.NOTES",
  547: "DELETE.NOTE",
  548: "TRAVERSE.NOTES",
  549: "ACTIVATE.NOTES",
  620: "PROTECT.REVISIONS",
  621: "UNPROTECT.REVISIONS",
  647: "OPTIONS.ME",
  653: "WEB.PUBLISH",
  667: "NEWWEBQUERY",
  673: "PIVOT.TABLE.CHART",
  753: "OPTIONS.SAVE",
  755: "OPTIONS.SPELL",
  808: "HIDEALL.INKANNOTS"
};
var Ftab = {
  0: "COUNT",
  1: "IF",
  2: "ISNA",
  3: "ISERROR",
  4: "SUM",
  5: "AVERAGE",
  6: "MIN",
  7: "MAX",
  8: "ROW",
  9: "COLUMN",
  10: "NA",
  11: "NPV",
  12: "STDEV",
  13: "DOLLAR",
  14: "FIXED",
  15: "SIN",
  16: "COS",
  17: "TAN",
  18: "ATAN",
  19: "PI",
  20: "SQRT",
  21: "EXP",
  22: "LN",
  23: "LOG10",
  24: "ABS",
  25: "INT",
  26: "SIGN",
  27: "ROUND",
  28: "LOOKUP",
  29: "INDEX",
  30: "REPT",
  31: "MID",
  32: "LEN",
  33: "VALUE",
  34: "TRUE",
  35: "FALSE",
  36: "AND",
  37: "OR",
  38: "NOT",
  39: "MOD",
  40: "DCOUNT",
  41: "DSUM",
  42: "DAVERAGE",
  43: "DMIN",
  44: "DMAX",
  45: "DSTDEV",
  46: "VAR",
  47: "DVAR",
  48: "TEXT",
  49: "LINEST",
  50: "TREND",
  51: "LOGEST",
  52: "GROWTH",
  53: "GOTO",
  54: "HALT",
  55: "RETURN",
  56: "PV",
  57: "FV",
  58: "NPER",
  59: "PMT",
  60: "RATE",
  61: "MIRR",
  62: "IRR",
  63: "RAND",
  64: "MATCH",
  65: "DATE",
  66: "TIME",
  67: "DAY",
  68: "MONTH",
  69: "YEAR",
  70: "WEEKDAY",
  71: "HOUR",
  72: "MINUTE",
  73: "SECOND",
  74: "NOW",
  75: "AREAS",
  76: "ROWS",
  77: "COLUMNS",
  78: "OFFSET",
  79: "ABSREF",
  80: "RELREF",
  81: "ARGUMENT",
  82: "SEARCH",
  83: "TRANSPOSE",
  84: "ERROR",
  85: "STEP",
  86: "TYPE",
  87: "ECHO",
  88: "SET.NAME",
  89: "CALLER",
  90: "DEREF",
  91: "WINDOWS",
  92: "SERIES",
  93: "DOCUMENTS",
  94: "ACTIVE.CELL",
  95: "SELECTION",
  96: "RESULT",
  97: "ATAN2",
  98: "ASIN",
  99: "ACOS",
  100: "CHOOSE",
  101: "HLOOKUP",
  102: "VLOOKUP",
  103: "LINKS",
  104: "INPUT",
  105: "ISREF",
  106: "GET.FORMULA",
  107: "GET.NAME",
  108: "SET.VALUE",
  109: "LOG",
  110: "EXEC",
  111: "CHAR",
  112: "LOWER",
  113: "UPPER",
  114: "PROPER",
  115: "LEFT",
  116: "RIGHT",
  117: "EXACT",
  118: "TRIM",
  119: "REPLACE",
  120: "SUBSTITUTE",
  121: "CODE",
  122: "NAMES",
  123: "DIRECTORY",
  124: "FIND",
  125: "CELL",
  126: "ISERR",
  127: "ISTEXT",
  128: "ISNUMBER",
  129: "ISBLANK",
  130: "T",
  131: "N",
  132: "FOPEN",
  133: "FCLOSE",
  134: "FSIZE",
  135: "FREADLN",
  136: "FREAD",
  137: "FWRITELN",
  138: "FWRITE",
  139: "FPOS",
  140: "DATEVALUE",
  141: "TIMEVALUE",
  142: "SLN",
  143: "SYD",
  144: "DDB",
  145: "GET.DEF",
  146: "REFTEXT",
  147: "TEXTREF",
  148: "INDIRECT",
  149: "REGISTER",
  150: "CALL",
  151: "ADD.BAR",
  152: "ADD.MENU",
  153: "ADD.COMMAND",
  154: "ENABLE.COMMAND",
  155: "CHECK.COMMAND",
  156: "RENAME.COMMAND",
  157: "SHOW.BAR",
  158: "DELETE.MENU",
  159: "DELETE.COMMAND",
  160: "GET.CHART.ITEM",
  161: "DIALOG.BOX",
  162: "CLEAN",
  163: "MDETERM",
  164: "MINVERSE",
  165: "MMULT",
  166: "FILES",
  167: "IPMT",
  168: "PPMT",
  169: "COUNTA",
  170: "CANCEL.KEY",
  171: "FOR",
  172: "WHILE",
  173: "BREAK",
  174: "NEXT",
  175: "INITIATE",
  176: "REQUEST",
  177: "POKE",
  178: "EXECUTE",
  179: "TERMINATE",
  180: "RESTART",
  181: "HELP",
  182: "GET.BAR",
  183: "PRODUCT",
  184: "FACT",
  185: "GET.CELL",
  186: "GET.WORKSPACE",
  187: "GET.WINDOW",
  188: "GET.DOCUMENT",
  189: "DPRODUCT",
  190: "ISNONTEXT",
  191: "GET.NOTE",
  192: "NOTE",
  193: "STDEVP",
  194: "VARP",
  195: "DSTDEVP",
  196: "DVARP",
  197: "TRUNC",
  198: "ISLOGICAL",
  199: "DCOUNTA",
  200: "DELETE.BAR",
  201: "UNREGISTER",
  204: "USDOLLAR",
  205: "FINDB",
  206: "SEARCHB",
  207: "REPLACEB",
  208: "LEFTB",
  209: "RIGHTB",
  210: "MIDB",
  211: "LENB",
  212: "ROUNDUP",
  213: "ROUNDDOWN",
  214: "ASC",
  215: "DBCS",
  216: "RANK",
  219: "ADDRESS",
  220: "DAYS360",
  221: "TODAY",
  222: "VDB",
  223: "ELSE",
  224: "ELSE.IF",
  225: "END.IF",
  226: "FOR.CELL",
  227: "MEDIAN",
  228: "SUMPRODUCT",
  229: "SINH",
  230: "COSH",
  231: "TANH",
  232: "ASINH",
  233: "ACOSH",
  234: "ATANH",
  235: "DGET",
  236: "CREATE.OBJECT",
  237: "VOLATILE",
  238: "LAST.ERROR",
  239: "CUSTOM.UNDO",
  240: "CUSTOM.REPEAT",
  241: "FORMULA.CONVERT",
  242: "GET.LINK.INFO",
  243: "TEXT.BOX",
  244: "INFO",
  245: "GROUP",
  246: "GET.OBJECT",
  247: "DB",
  248: "PAUSE",
  251: "RESUME",
  252: "FREQUENCY",
  253: "ADD.TOOLBAR",
  254: "DELETE.TOOLBAR",
  255: "User",
  256: "RESET.TOOLBAR",
  257: "EVALUATE",
  258: "GET.TOOLBAR",
  259: "GET.TOOL",
  260: "SPELLING.CHECK",
  261: "ERROR.TYPE",
  262: "APP.TITLE",
  263: "WINDOW.TITLE",
  264: "SAVE.TOOLBAR",
  265: "ENABLE.TOOL",
  266: "PRESS.TOOL",
  267: "REGISTER.ID",
  268: "GET.WORKBOOK",
  269: "AVEDEV",
  270: "BETADIST",
  271: "GAMMALN",
  272: "BETAINV",
  273: "BINOMDIST",
  274: "CHIDIST",
  275: "CHIINV",
  276: "COMBIN",
  277: "CONFIDENCE",
  278: "CRITBINOM",
  279: "EVEN",
  280: "EXPONDIST",
  281: "FDIST",
  282: "FINV",
  283: "FISHER",
  284: "FISHERINV",
  285: "FLOOR",
  286: "GAMMADIST",
  287: "GAMMAINV",
  288: "CEILING",
  289: "HYPGEOMDIST",
  290: "LOGNORMDIST",
  291: "LOGINV",
  292: "NEGBINOMDIST",
  293: "NORMDIST",
  294: "NORMSDIST",
  295: "NORMINV",
  296: "NORMSINV",
  297: "STANDARDIZE",
  298: "ODD",
  299: "PERMUT",
  300: "POISSON",
  301: "TDIST",
  302: "WEIBULL",
  303: "SUMXMY2",
  304: "SUMX2MY2",
  305: "SUMX2PY2",
  306: "CHITEST",
  307: "CORREL",
  308: "COVAR",
  309: "FORECAST",
  310: "FTEST",
  311: "INTERCEPT",
  312: "PEARSON",
  313: "RSQ",
  314: "STEYX",
  315: "SLOPE",
  316: "TTEST",
  317: "PROB",
  318: "DEVSQ",
  319: "GEOMEAN",
  320: "HARMEAN",
  321: "SUMSQ",
  322: "KURT",
  323: "SKEW",
  324: "ZTEST",
  325: "LARGE",
  326: "SMALL",
  327: "QUARTILE",
  328: "PERCENTILE",
  329: "PERCENTRANK",
  330: "MODE",
  331: "TRIMMEAN",
  332: "TINV",
  334: "MOVIE.COMMAND",
  335: "GET.MOVIE",
  336: "CONCATENATE",
  337: "POWER",
  338: "PIVOT.ADD.DATA",
  339: "GET.PIVOT.TABLE",
  340: "GET.PIVOT.FIELD",
  341: "GET.PIVOT.ITEM",
  342: "RADIANS",
  343: "DEGREES",
  344: "SUBTOTAL",
  345: "SUMIF",
  346: "COUNTIF",
  347: "COUNTBLANK",
  348: "SCENARIO.GET",
  349: "OPTIONS.LISTS.GET",
  350: "ISPMT",
  351: "DATEDIF",
  352: "DATESTRING",
  353: "NUMBERSTRING",
  354: "ROMAN",
  355: "OPEN.DIALOG",
  356: "SAVE.DIALOG",
  357: "VIEW.GET",
  358: "GETPIVOTDATA",
  359: "HYPERLINK",
  360: "PHONETIC",
  361: "AVERAGEA",
  362: "MAXA",
  363: "MINA",
  364: "STDEVPA",
  365: "VARPA",
  366: "STDEVA",
  367: "VARA",
  368: "BAHTTEXT",
  369: "THAIDAYOFWEEK",
  370: "THAIDIGIT",
  371: "THAIMONTHOFYEAR",
  372: "THAINUMSOUND",
  373: "THAINUMSTRING",
  374: "THAISTRINGLENGTH",
  375: "ISTHAIDIGIT",
  376: "ROUNDBAHTDOWN",
  377: "ROUNDBAHTUP",
  378: "THAIYEAR",
  379: "RTD",
  380: "CUBEVALUE",
  381: "CUBEMEMBER",
  382: "CUBEMEMBERPROPERTY",
  383: "CUBERANKEDMEMBER",
  384: "HEX2BIN",
  385: "HEX2DEC",
  386: "HEX2OCT",
  387: "DEC2BIN",
  388: "DEC2HEX",
  389: "DEC2OCT",
  390: "OCT2BIN",
  391: "OCT2HEX",
  392: "OCT2DEC",
  393: "BIN2DEC",
  394: "BIN2OCT",
  395: "BIN2HEX",
  396: "IMSUB",
  397: "IMDIV",
  398: "IMPOWER",
  399: "IMABS",
  400: "IMSQRT",
  401: "IMLN",
  402: "IMLOG2",
  403: "IMLOG10",
  404: "IMSIN",
  405: "IMCOS",
  406: "IMEXP",
  407: "IMARGUMENT",
  408: "IMCONJUGATE",
  409: "IMAGINARY",
  410: "IMREAL",
  411: "COMPLEX",
  412: "IMSUM",
  413: "IMPRODUCT",
  414: "SERIESSUM",
  415: "FACTDOUBLE",
  416: "SQRTPI",
  417: "QUOTIENT",
  418: "DELTA",
  419: "GESTEP",
  420: "ISEVEN",
  421: "ISODD",
  422: "MROUND",
  423: "ERF",
  424: "ERFC",
  425: "BESSELJ",
  426: "BESSELK",
  427: "BESSELY",
  428: "BESSELI",
  429: "XIRR",
  430: "XNPV",
  431: "PRICEMAT",
  432: "YIELDMAT",
  433: "INTRATE",
  434: "RECEIVED",
  435: "DISC",
  436: "PRICEDISC",
  437: "YIELDDISC",
  438: "TBILLEQ",
  439: "TBILLPRICE",
  440: "TBILLYIELD",
  441: "PRICE",
  442: "YIELD",
  443: "DOLLARDE",
  444: "DOLLARFR",
  445: "NOMINAL",
  446: "EFFECT",
  447: "CUMPRINC",
  448: "CUMIPMT",
  449: "EDATE",
  450: "EOMONTH",
  451: "YEARFRAC",
  452: "COUPDAYBS",
  453: "COUPDAYS",
  454: "COUPDAYSNC",
  455: "COUPNCD",
  456: "COUPNUM",
  457: "COUPPCD",
  458: "DURATION",
  459: "MDURATION",
  460: "ODDLPRICE",
  461: "ODDLYIELD",
  462: "ODDFPRICE",
  463: "ODDFYIELD",
  464: "RANDBETWEEN",
  465: "WEEKNUM",
  466: "AMORDEGRC",
  467: "AMORLINC",
  468: "CONVERT",
  724: "SHEETJS",
  469: "ACCRINT",
  470: "ACCRINTM",
  471: "WORKDAY",
  472: "NETWORKDAYS",
  473: "GCD",
  474: "MULTINOMIAL",
  475: "LCM",
  476: "FVSCHEDULE",
  477: "CUBEKPIMEMBER",
  478: "CUBESET",
  479: "CUBESETCOUNT",
  480: "IFERROR",
  481: "COUNTIFS",
  482: "SUMIFS",
  483: "AVERAGEIF",
  484: "AVERAGEIFS"
};
var FtabArgc = {
  2: 1,
  3: 1,
  10: 0,
  15: 1,
  16: 1,
  17: 1,
  18: 1,
  19: 0,
  20: 1,
  21: 1,
  22: 1,
  23: 1,
  24: 1,
  25: 1,
  26: 1,
  27: 2,
  30: 2,
  31: 3,
  32: 1,
  33: 1,
  34: 0,
  35: 0,
  38: 1,
  39: 2,
  40: 3,
  41: 3,
  42: 3,
  43: 3,
  44: 3,
  45: 3,
  47: 3,
  48: 2,
  53: 1,
  61: 3,
  63: 0,
  65: 3,
  66: 3,
  67: 1,
  68: 1,
  69: 1,
  70: 1,
  71: 1,
  72: 1,
  73: 1,
  74: 0,
  75: 1,
  76: 1,
  77: 1,
  79: 2,
  80: 2,
  83: 1,
  85: 0,
  86: 1,
  89: 0,
  90: 1,
  94: 0,
  95: 0,
  97: 2,
  98: 1,
  99: 1,
  101: 3,
  102: 3,
  105: 1,
  106: 1,
  108: 2,
  111: 1,
  112: 1,
  113: 1,
  114: 1,
  117: 2,
  118: 1,
  119: 4,
  121: 1,
  126: 1,
  127: 1,
  128: 1,
  129: 1,
  130: 1,
  131: 1,
  133: 1,
  134: 1,
  135: 1,
  136: 2,
  137: 2,
  138: 2,
  140: 1,
  141: 1,
  142: 3,
  143: 4,
  144: 4,
  161: 1,
  162: 1,
  163: 1,
  164: 1,
  165: 2,
  172: 1,
  175: 2,
  176: 2,
  177: 3,
  178: 2,
  179: 1,
  184: 1,
  186: 1,
  189: 3,
  190: 1,
  195: 3,
  196: 3,
  197: 1,
  198: 1,
  199: 3,
  201: 1,
  207: 4,
  210: 3,
  211: 1,
  212: 2,
  213: 2,
  214: 1,
  215: 1,
  225: 0,
  229: 1,
  230: 1,
  231: 1,
  232: 1,
  233: 1,
  234: 1,
  235: 3,
  244: 1,
  247: 4,
  252: 2,
  257: 1,
  261: 1,
  271: 1,
  273: 4,
  274: 2,
  275: 2,
  276: 2,
  277: 3,
  278: 3,
  279: 1,
  280: 3,
  281: 3,
  282: 3,
  283: 1,
  284: 1,
  285: 2,
  286: 4,
  287: 3,
  288: 2,
  289: 4,
  290: 3,
  291: 3,
  292: 3,
  293: 4,
  294: 1,
  295: 3,
  296: 1,
  297: 3,
  298: 1,
  299: 2,
  300: 3,
  301: 3,
  302: 4,
  303: 2,
  304: 2,
  305: 2,
  306: 2,
  307: 2,
  308: 2,
  309: 3,
  310: 2,
  311: 2,
  312: 2,
  313: 2,
  314: 2,
  315: 2,
  316: 4,
  325: 2,
  326: 2,
  327: 2,
  328: 2,
  331: 2,
  332: 2,
  337: 2,
  342: 1,
  343: 1,
  346: 2,
  347: 1,
  350: 4,
  351: 3,
  352: 1,
  353: 2,
  360: 1,
  368: 1,
  369: 1,
  370: 1,
  371: 1,
  372: 1,
  373: 1,
  374: 1,
  375: 1,
  376: 1,
  377: 1,
  378: 1,
  382: 3,
  385: 1,
  392: 1,
  393: 1,
  396: 2,
  397: 2,
  398: 2,
  399: 1,
  400: 1,
  401: 1,
  402: 1,
  403: 1,
  404: 1,
  405: 1,
  406: 1,
  407: 1,
  408: 1,
  409: 1,
  410: 1,
  414: 4,
  415: 1,
  416: 1,
  417: 2,
  420: 1,
  421: 1,
  422: 2,
  424: 1,
  425: 2,
  426: 2,
  427: 2,
  428: 2,
  430: 3,
  438: 3,
  439: 3,
  440: 3,
  443: 2,
  444: 2,
  445: 2,
  446: 2,
  447: 6,
  448: 6,
  449: 2,
  450: 2,
  464: 2,
  468: 3,
  476: 2,
  479: 1,
  480: 2,
  65535: 0
};
/* Part 3 TODO: actually parse formulae */
function ods_to_csf_formula(f) {
	if(f.slice(0,3) == "of:") f = f.slice(3);
	/* 5.2 Basic Expressions */
	if(f.charCodeAt(0) == 61) {
		f = f.slice(1);
		if(f.charCodeAt(0) == 61) f = f.slice(1);
	}
	f = f.replace(/COM\.MICROSOFT\./g, "");
	/* Part 3 Section 5.8 References */
	f = f.replace(/\[((?:\.[A-Z]+[0-9]+)(?::\.[A-Z]+[0-9]+)?)\]/g, function($$, $1) { return $1.replace(/\./g,""); });
	f = f.replace(/\$'([^']|'')+'/g, function($$) { return $$.slice(1); });
	f = f.replace(/\$([^\]\. #$]+)/g, function($$, $1) { return ($1).match(/^([A-Z]{1,2}|[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D])?(10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5})?$/) ? $$ : $1; });
	/* TODO: something other than this */
	f = f.replace(/\[.(#[A-Z]*[?!])\]/g, "$1");
	return f.replace(/[;~]/g,",").replace(/\|/g,";");
}

function csf_to_ods_formula(f) {
	var o = "of:=" + f.replace(crefregex, "$1[.$2$3$4$5]").replace(/\]:\[/g,":");
	/* TODO: something other than this */
	return o.replace(/;/g, "|").replace(/,/g,";");
}

function ods_to_csf_3D(r) {
	r = r.replace(/\$'([^']|'')+'/g, function($$) { return $$.slice(1); });
	r = r.replace(/\$([^\]\. #$]+)/g, function($$, $1) { return ($1).match(/^([A-Z]{1,2}|[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D])?(10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5})?$/) ? $$ : $1; });
	var a = r.split(":");
	var s = a[0].split(".")[0];
	return [s, a[0].split(".")[1] + (a.length > 1 ? (":" + (a[1].split(".")[1] || a[1].split(".")[0])) : "")];
}

function csf_to_ods_3D(r) {
	return r.replace(/!/,".").replace(/:/, ":.");
}

var strs = {}; // shared strings
var _ssfopts = {}; // spreadsheet formatting options


/*global Map */
var browser_has_Map = typeof Map !== 'undefined';

function get_sst_id(sst, str, rev) {
	var i = 0, len = sst.length;
	if(rev) {
		if(browser_has_Map ? rev.has(str) : Object.prototype.hasOwnProperty.call(rev, str)) {
			var revarr = browser_has_Map ? rev.get(str) : rev[str];
			for(; i < revarr.length; ++i) {
				if(sst[revarr[i]].t === str) { sst.Count ++; return revarr[i]; }
			}
		}
	} else for(; i < len; ++i) {
		if(sst[i].t === str) { sst.Count ++; return i; }
	}
	sst[len] = ({t:str}); sst.Count ++; sst.Unique ++;
	if(rev) {
		if(browser_has_Map) {
			if(!rev.has(str)) rev.set(str, []);
			rev.get(str).push(len);
		} else {
			if(!Object.prototype.hasOwnProperty.call(rev, str)) rev[str] = [];
			rev[str].push(len);
		}
	}
	return len;
}

function col_obj_w(C, col) {
	var p = ({min:C+1,max:C+1});
	/* wch (chars), wpx (pixels) */
	var wch = -1;
	if(col.MDW) MDW = col.MDW;
	if(col.width != null) p.customWidth = 1;
	else if(col.wpx != null) wch = px2char(col.wpx);
	else if(col.wch != null) wch = col.wch;
	if(wch > -1) { p.width = char2width(wch); p.customWidth = 1; }
	else if(col.width != null) p.width = col.width;
	if(col.hidden) p.hidden = true;
	if(col.level != null) { p.outlineLevel = p.level = col.level; }
	return p;
}

function default_margins(margins, mode) {
	if(!margins) return;
	var defs = [0.7, 0.7, 0.75, 0.75, 0.3, 0.3];
	if(mode == 'xlml') defs = [1, 1, 1, 1, 0.5, 0.5];
	if(margins.left   == null) margins.left   = defs[0];
	if(margins.right  == null) margins.right  = defs[1];
	if(margins.top    == null) margins.top    = defs[2];
	if(margins.bottom == null) margins.bottom = defs[3];
	if(margins.header == null) margins.header = defs[4];
	if(margins.footer == null) margins.footer = defs[5];
}

function get_cell_style(styles, cell, opts) {
	var z = opts.revssf[cell.z != null ? cell.z : "General"];
	var i = 0x3c, len = styles.length;
	if(z == null && opts.ssf) {
		for(; i < 0x188; ++i) if(opts.ssf[i] == null) {
			SSF__load(cell.z, i);
			// $FlowIgnore
			opts.ssf[i] = cell.z;
			opts.revssf[cell.z] = z = i;
			break;
		}
	}
	for(i = 0; i != len; ++i) if(styles[i].numFmtId === z) return i;
	styles[len] = {
		numFmtId:z,
		fontId:0,
		fillId:0,
		borderId:0,
		xfId:0,
		applyNumberFormat:1
	};
	return len;
}

function safe_format(p, fmtid, fillid, opts, themes, styles, date1904) {
	try {
		if(opts.cellNF) p.z = table_fmt[fmtid];
	} catch(e) { if(opts.WTF) throw e; }
	if(p.t === 'z' && !opts.cellStyles) return;
	if(p.t === 'd' && typeof p.v === 'string') p.v = parseDate(p.v);
	if((!opts || opts.cellText !== false) && p.t !== 'z') try {
		if(table_fmt[fmtid] == null) SSF__load(SSFImplicit[fmtid] || "General", fmtid);
		if(p.t === 'e') p.w = p.w || BErr[p.v];
		else if(fmtid === 0) {
			if(p.t === 'n') {
				if((p.v|0) === p.v) p.w = p.v.toString(10);
				else p.w = SSF_general_num(p.v);
			}
			else if(p.t === 'd') {
				var dd = datenum(p.v, !!date1904);
				if((dd|0) === dd) p.w = dd.toString(10);
				else p.w = SSF_general_num(dd);
			}
			else if(p.v === undefined) return "";
			else p.w = SSF_general(p.v,_ssfopts);
		}
		else if(p.t === 'd') p.w = SSF_format(fmtid,datenum(p.v, !!date1904),_ssfopts);
		else p.w = SSF_format(fmtid,p.v,_ssfopts);
	} catch(e) { if(opts.WTF) throw e; }
	if(!opts.cellStyles) return;
	if(fillid != null) try {
		p.s = styles.Fills[fillid];
		if (p.s.fgColor && p.s.fgColor.theme && !p.s.fgColor.rgb) {
			p.s.fgColor.rgb = rgb_tint(themes.themeElements.clrScheme[p.s.fgColor.theme].rgb, p.s.fgColor.tint || 0);
			if(opts.WTF) p.s.fgColor.raw_rgb = themes.themeElements.clrScheme[p.s.fgColor.theme].rgb;
		}
		if (p.s.bgColor && p.s.bgColor.theme) {
			p.s.bgColor.rgb = rgb_tint(themes.themeElements.clrScheme[p.s.bgColor.theme].rgb, p.s.bgColor.tint || 0);
			if(opts.WTF) p.s.bgColor.raw_rgb = themes.themeElements.clrScheme[p.s.bgColor.theme].rgb;
		}
	} catch(e) { if(opts.WTF && styles.Fills) throw e; }
}

function check_ws(ws, sname, i) {
	if(ws && ws['!ref']) {
		var range = safe_decode_range(ws['!ref']);
		if(range.e.c < range.s.c || range.e.r < range.s.r) throw new Error("Bad range (" + i + "): " + ws['!ref']);
	}
}
function parse_ws_xml_dim(ws, s) {
	var d = safe_decode_range(s);
	if(d.s.r<=d.e.r && d.s.c<=d.e.c && d.s.r>=0 && d.s.c>=0) ws["!ref"] = encode_range(d);
}
var mergecregex = /<(?:\w+:)?mergeCell ref=["'][A-Z0-9:]+['"]\s*[\/]?>/g;
var hlinkregex = /<(?:\w+:)?hyperlink [^<>]*>/mg;
var dimregex = /"(\w*:\w*)"/;
var colregex = /<(?:\w+:)?col\b[^<>]*[\/]?>/g;
var afregex = /<(?:\w+:)?autoFilter[^>]*/g;
var marginregex= /<(?:\w+:)?pageMargins[^<>]*\/>/g;
var sheetprregex = /<(?:\w+:)?sheetPr\b[^<>]*?\/>/;

/* 18.3 Worksheets */
function parse_ws_xml(data, opts, idx, rels, wb, themes, styles) {
	if(!data) return data;
	if(!rels) rels = {'!id':{}};
	if(DENSE != null && opts.dense == null) opts.dense = DENSE;

	/* 18.3.1.99 worksheet CT_Worksheet */
	var s = ({}); if(opts.dense) s["!data"] = [];
	var refguess = ({s: {r:2000000, c:2000000}, e: {r:0, c:0} });

	var data1 = "", data2 = "";
	var mtch = str_match_xml_ns(data, "sheetData");
	if(mtch) {
		data1 = data.slice(0, mtch.index);
		data2 = data.slice(mtch.index + mtch[0].length);
	} else data1 = data2 = data;

	/* 18.3.1.82 sheetPr CT_SheetPr */
	var sheetPr = data1.match(sheetprregex);
	if(sheetPr) parse_ws_xml_sheetpr(sheetPr[0], s, wb, idx);
	else if((sheetPr = str_match_xml_ns(data1, "sheetPr"))) parse_ws_xml_sheetpr2(sheetPr[0], sheetPr[1]||"", s, wb, idx, styles, themes);

	/* 18.3.1.35 dimension CT_SheetDimension */
	var ridx = (data1.match(/<(?:\w*:)?dimension/)||{index:-1}).index;
	if(ridx > 0) {
		var ref = data1.slice(ridx,ridx+50).match(dimregex);
		if(ref && !(opts && opts.nodim)) parse_ws_xml_dim(s, ref[1]);
	}

	/* 18.3.1.88 sheetViews CT_SheetViews */
	var svs = str_match_xml_ns(data1, "sheetViews");
	if(svs && svs[1]) parse_ws_xml_sheetviews(svs[1], wb);

	/* 18.3.1.17 cols CT_Cols */
	var columns = [];
	if(opts.cellStyles) {
		/* 18.3.1.13 col CT_Col */
		var cols = data1.match(colregex);
		if(cols) parse_ws_xml_cols(columns, cols);
	}

	/* 18.3.1.80 sheetData CT_SheetData ? */
	if(mtch) parse_ws_xml_data(mtch[1], s, opts, refguess, themes, styles, wb);

	/* 18.3.1.2  autoFilter CT_AutoFilter */
	var afilter = data2.match(afregex);
	if(afilter) s['!autofilter'] = parse_ws_xml_autofilter(afilter[0]);

	/* 18.3.1.55 mergeCells CT_MergeCells */
	var merges = [];
	var _merge = data2.match(mergecregex);
	if(_merge) for(ridx = 0; ridx != _merge.length; ++ridx)
		merges[ridx] = safe_decode_range(_merge[ridx].slice(_merge[ridx].indexOf("=")+2));

	/* 18.3.1.48 hyperlinks CT_Hyperlinks */
	var hlink = data2.match(hlinkregex);
	if(hlink) parse_ws_xml_hlinks(s, hlink, rels);

	/* 18.3.1.62 pageMargins CT_PageMargins */
	var margins = data2.match(marginregex);
	if(margins) s['!margins'] = parse_ws_xml_margins(parsexmltag(margins[0]));

	/* legacyDrawing */
	var m;
	if((m = data2.match(/legacyDrawing r:id="(.*?)"/))) s['!legrel'] = m[1];

	if(opts && opts.nodim) refguess.s.c = refguess.s.r = 0;
	if(!s["!ref"] && refguess.e.c >= refguess.s.c && refguess.e.r >= refguess.s.r) s["!ref"] = encode_range(refguess);
	if(opts.sheetRows > 0 && s["!ref"]) {
		var tmpref = safe_decode_range(s["!ref"]);
		if(opts.sheetRows <= +tmpref.e.r) {
			tmpref.e.r = opts.sheetRows - 1;
			if(tmpref.e.r > refguess.e.r) tmpref.e.r = refguess.e.r;
			if(tmpref.e.r < tmpref.s.r) tmpref.s.r = tmpref.e.r;
			if(tmpref.e.c > refguess.e.c) tmpref.e.c = refguess.e.c;
			if(tmpref.e.c < tmpref.s.c) tmpref.s.c = tmpref.e.c;
			s["!fullref"] = s["!ref"];
			s["!ref"] = encode_range(tmpref);
		}
	}
	if(columns.length > 0) s["!cols"] = columns;
	if(merges.length > 0) s["!merges"] = merges;
	if(rels['!id'][s['!legrel']]) s['!legdrawel'] = rels['!id'][s['!legrel']];
	return s;
}

function write_ws_xml_merges(merges) {
	if(merges.length === 0) return "";
	var o = '<mergeCells count="' + merges.length + '">';
	for(var i = 0; i != merges.length; ++i) o += '<mergeCell ref="' + encode_range(merges[i]) + '"/>';
	return o + '</mergeCells>';
}

/* 18.3.1.82-3 sheetPr CT_ChartsheetPr / CT_SheetPr */
function parse_ws_xml_sheetpr(sheetPr, s, wb, idx) {
	var data = parsexmltag(sheetPr);
	if(!wb.Sheets[idx]) wb.Sheets[idx] = {};
	if(data.codeName) wb.Sheets[idx].CodeName = unescapexml(utf8read(data.codeName));
}
function parse_ws_xml_sheetpr2(sheetPr, body, s, wb, idx) {
	parse_ws_xml_sheetpr(sheetPr.slice(0, sheetPr.indexOf(">")), s, wb, idx);
}
function write_ws_xml_sheetpr(ws, wb, idx, opts, o) {
	var needed = false;
	var props = {}, payload = null;
	if(opts.bookType !== 'xlsx' && wb.vbaraw) {
		var cname = wb.SheetNames[idx];
		try { if(wb.Workbook) cname = wb.Workbook.Sheets[idx].CodeName || cname; } catch(e) {}
		needed = true;
		props.codeName = utf8write(escapexml(cname));
	}

	if(ws && ws["!outline"]) {
		var outlineprops = {summaryBelow:1, summaryRight:1};
		if(ws["!outline"].above) outlineprops.summaryBelow = 0;
		if(ws["!outline"].left) outlineprops.summaryRight = 0;
		payload = (payload||"") + writextag('outlinePr', null, outlineprops);
	}

	if(!needed && !payload) return;
	o[o.length] = (writextag('sheetPr', payload, props));
}

/* 18.3.1.85 sheetProtection CT_SheetProtection */
var sheetprot_deffalse = ["objects", "scenarios", "selectLockedCells", "selectUnlockedCells"];
var sheetprot_deftrue = [
	"formatColumns", "formatRows", "formatCells",
	"insertColumns", "insertRows", "insertHyperlinks",
	"deleteColumns", "deleteRows",
	"sort", "autoFilter", "pivotTables"
];
function write_ws_xml_protection(sp) {
	// algorithmName, hashValue, saltValue, spinCount
	var o = ({sheet:1});
	sheetprot_deffalse.forEach(function(n) { if(sp[n] != null && sp[n]) o[n] = "1"; });
	sheetprot_deftrue.forEach(function(n) { if(sp[n] != null && !sp[n]) o[n] = "0"; });
	/* TODO: algorithm */
	if(sp.password) o.password = crypto_CreatePasswordVerifier_Method1(sp.password).toString(16).toUpperCase();
	return writextag('sheetProtection', null, o);
}

function parse_ws_xml_hlinks(s, data, rels) {
	var dense = s["!data"] != null;
	for(var i = 0; i != data.length; ++i) {
		var val = parsexmltag(utf8read(data[i]), true);
		if(!val.ref) return;
		var rel = ((rels || {})['!id']||[])[val.id];
		if(rel) {
			val.Target = rel.Target;
			if(val.location) val.Target += "#"+unescapexml(val.location);
		} else {
			val.Target = "#" + unescapexml(val.location);
			rel = {Target: val.Target, TargetMode: 'Internal'};
		}
		val.Rel = rel;
		if(val.tooltip) { val.Tooltip = val.tooltip; delete val.tooltip; }
		var rng = safe_decode_range(val.ref);
		for(var R=rng.s.r;R<=rng.e.r;++R) for(var C=rng.s.c;C<=rng.e.c;++C) {
			var addr = encode_col(C) + encode_row(R);
			if(dense) {
				if(!s["!data"][R]) s["!data"][R] = [];
				if(!s["!data"][R][C]) s["!data"][R][C] = {t:"z",v:undefined};
				s["!data"][R][C].l = val;
			} else {
				if(!s[addr]) s[addr] = {t:"z",v:undefined};
				s[addr].l = val;
			}
		}
	}
}

function parse_ws_xml_margins(margin) {
	var o = {};
	["left", "right", "top", "bottom", "header", "footer"].forEach(function(k) {
		if(margin[k]) o[k] = parseFloat(margin[k]);
	});
	return o;
}
function write_ws_xml_margins(margin) {
	default_margins(margin);
	return writextag('pageMargins', null, margin);
}

function parse_ws_xml_cols(columns, cols) {
	var seencol = false;
	for(var coli = 0; coli != cols.length; ++coli) {
		var coll = parsexmltag(cols[coli], true);
		if(coll.hidden) coll.hidden = parsexmlbool(coll.hidden);
		var colm=parseInt(coll.min, 10)-1, colM=parseInt(coll.max,10)-1;
		if(coll.outlineLevel) coll.level = (+coll.outlineLevel || 0);
		delete coll.min; delete coll.max; coll.width = +coll.width;
		if(!seencol && coll.width) { seencol = true; find_mdw_colw(coll.width); }
		process_col(coll);
		while(colm <= colM) columns[colm++] = dup(coll);
	}
}
function write_ws_xml_cols(ws, cols) {
	var o = ["<cols>"], col;
	for(var i = 0; i != cols.length; ++i) {
		if(!(col = cols[i])) continue;
		o[o.length] = (writextag('col', null, col_obj_w(i, col)));
	}
	o[o.length] = "</cols>";
	return o.join("");
}

function parse_ws_xml_autofilter(data) {
	var o = { ref: (data.match(/ref="([^"]*)"/)||[])[1]};
	return o;
}
function write_ws_xml_autofilter(data, ws, wb, idx) {
	var ref = typeof data.ref == "string" ? data.ref : encode_range(data.ref);
	if(!wb.Workbook) wb.Workbook = ({Sheets:[]});
	if(!wb.Workbook.Names) wb.Workbook.Names = [];
	var names = wb.Workbook.Names;
	var range = decode_range(ref);
	if(range.s.r == range.e.r) { range.e.r = decode_range(ws["!ref"]).e.r; ref = encode_range(range); }
	for(var i = 0; i < names.length; ++i) {
		var name = names[i];
		if(name.Name != '_xlnm._FilterDatabase') continue;
		if(name.Sheet != idx) continue;
		name.Ref = formula_quote_sheet_name(wb.SheetNames[idx]) + "!" + fix_range(ref); break;
	}
	if(i == names.length) names.push({ Name: '_xlnm._FilterDatabase', Sheet: idx, Ref: "'" + wb.SheetNames[idx] + "'!" + ref  });
	return writextag("autoFilter", null, {ref:ref});
}

/* 18.3.1.88 sheetViews CT_SheetViews */
/* 18.3.1.87 sheetView CT_SheetView */
var sviewregex = /<(?:\w:)?sheetView(?:[^<>a-z][^<>]*)?\/?>/g;
function parse_ws_xml_sheetviews(data, wb) {
	if(!wb.Views) wb.Views = [{}];
	(data.match(sviewregex)||[]).forEach(function(r, i) {
		var tag = parsexmltag(r);
		// $FlowIgnore
		if(!wb.Views[i]) wb.Views[i] = {};
		// $FlowIgnore
		if(+tag.zoomScale) wb.Views[i].zoom = +tag.zoomScale;
		// $FlowIgnore
		if(tag.rightToLeft && parsexmlbool(tag.rightToLeft)) wb.Views[i].RTL = true;
	});
}
function write_ws_xml_sheetviews(ws, opts, idx, wb) {
	var sview = ({workbookViewId:"0"});
	// $FlowIgnore
	if((((wb||{}).Workbook||{}).Views||[])[0]) sview.rightToLeft = wb.Workbook.Views[0].RTL ? "1" : "0";
	return writextag("sheetViews", writextag("sheetView", null, sview), {});
}

function write_ws_xml_cell(cell, ref, ws, opts, idx, wb, date1904) {
	if(cell.c) ws['!comments'].push([ref, cell.c]);
	if((cell.v === undefined || cell.t === "z" && !(opts||{}).sheetStubs) && typeof cell.f !== "string" && typeof cell.z == "undefined") return "";
	var vv = "";
	var oldt = cell.t, oldv = cell.v;
	if(cell.t !== "z") switch(cell.t) {
		case 'b': vv = cell.v ? "1" : "0"; break;
		case 'n':
			if(isNaN(cell.v)) { cell.t = "e"; vv = BErr[cell.v = 0x24]; } // #NUM!
			else if(!isFinite(cell.v)) { cell.t = "e"; vv = BErr[cell.v = 0x07]; } // #DIV/0!
			else vv = ''+cell.v; break;
		case 'e': vv = BErr[cell.v]; break;
		case 'd':
			if(opts && opts.cellDates) {
				var _vv = parseDate(cell.v, date1904);
				vv = _vv.toISOString();
				if(_vv.getUTCFullYear() < 1900) vv = vv.slice(vv.indexOf("T") + 1).replace("Z","");
			} else {
				cell = dup(cell);
				cell.t = 'n';
				vv = ''+(cell.v = datenum(parseDate(cell.v, date1904), date1904));
			}
			if(typeof cell.z === 'undefined') cell.z = table_fmt[14];
			break;
		default: vv = cell.v; break;
	}
	var v = (cell.t == "z" || cell.v == null)? "" : writetag('v', escapexml(vv)), o = ({r:ref});
	/* TODO: cell style */
	var os = get_cell_style(opts.cellXfs, cell, opts);
	if(os !== 0) o.s = os;
	switch(cell.t) {
		case 'n': break;
		case 'd': o.t = "d"; break;
		case 'b': o.t = "b"; break;
		case 'e': o.t = "e"; break;
		case 'z': break;
		default: if(cell.v == null) { delete cell.t; break; }
			if(cell.v.length > 32767) throw new Error("Text length must not exceed 32767 characters");
			if(opts && opts.bookSST) {
				v = writetag('v', ''+get_sst_id(opts.Strings, cell.v, opts.revStrings));
				o.t = "s"; break;
			}
			else o.t = "str"; break;
	}
	if(cell.t != oldt) { cell.t = oldt; cell.v = oldv; }
	if(typeof cell.f == "string" && cell.f) {
		var ff = cell.F && cell.F.slice(0, ref.length) == ref ? {t:"array", ref:cell.F} : null;
		v = writextag('f', escapexml(cell.f), ff) + (cell.v != null ? v : "");
	}
	if(cell.l) {
		cell.l.display = escapexml(vv);
		ws['!links'].push([ref, cell.l]);
	}
	if(cell.D) o.cm = 1;
	return writextag('c', v, o);
}

var parse_ws_xml_data = (function() {
	var cellregex = /<(?:\w+:)?c[ \/>]/, rowregex = /<\/(?:\w+:)?row>/;
	var rregex = /r=["']([^"']*)["']/;
	var refregex = /ref=["']([^"']*)["']/;

return function parse_ws_xml_data(sdata, s, opts, guess, themes, styles, wb) {
	var ri = 0, x = "", cells = [], cref = [], idx=0, i=0, cc=0, d="", p;
	var tag, tagr = 0, tagc = 0;
	var sstr, ftag;
	var fmtid = 0, fillid = 0;
	var do_format = Array.isArray(styles.CellXf), cf;
	var arrayf = [];
	var sharedf = [];
	var dense = s["!data"] != null;
	var rows = [], rowobj = {}, rowrite = false;
	var sheetStubs = !!opts.sheetStubs;
	var date1904 = !!((wb||{}).WBProps||{}).date1904;
	for(var marr = sdata.split(rowregex), mt = 0, marrlen = marr.length; mt != marrlen; ++mt) {
		x = marr[mt].trim();
		var xlen = x.length;
		if(xlen === 0) continue;

		/* 18.3.1.73 row CT_Row */
		var rstarti = 0;
		outa: for(ri = 0; ri < xlen; ++ri) switch(/*x.charCodeAt(ri)*/x[ri]) {
			case ">" /*62*/:
				if(/*x.charCodeAt(ri-1) != 47*/x[ri-1] != "/") { ++ri; break outa; }
				if(opts && opts.cellStyles) {
					// TODO: avoid duplication
					tag = parsexmltag(x.slice(rstarti,ri), true);
					tagr = tag.r != null ? parseInt(tag.r, 10) : tagr+1; tagc = -1;
					if(opts.sheetRows && opts.sheetRows < tagr) continue;
					rowobj = {}; rowrite = false;
					if(tag.ht) { rowrite = true; rowobj.hpt = parseFloat(tag.ht); rowobj.hpx = pt2px(rowobj.hpt); }
					if(tag.hidden && parsexmlbool(tag.hidden)) { rowrite = true; rowobj.hidden = true; }
					if(tag.outlineLevel != null) { rowrite = true; rowobj.level = +tag.outlineLevel; }
					if(rowrite) rows[tagr-1] = rowobj;
				}
				break;
			case "<" /*60*/: rstarti = ri; break;
		}
		if(rstarti >= ri) break;
		tag = parsexmltag(x.slice(rstarti,ri), true);
		tagr = tag.r != null ? parseInt(tag.r, 10) : tagr+1; tagc = -1;
		if(opts.sheetRows && opts.sheetRows < tagr) continue;
		if(!opts.nodim) {
			if(guess.s.r > tagr - 1) guess.s.r = tagr - 1;
			if(guess.e.r < tagr - 1) guess.e.r = tagr - 1;
		}

		if(opts && opts.cellStyles) {
			rowobj = {}; rowrite = false;
			if(tag.ht) { rowrite = true; rowobj.hpt = parseFloat(tag.ht); rowobj.hpx = pt2px(rowobj.hpt); }
			if(tag.hidden && parsexmlbool(tag.hidden)) { rowrite = true; rowobj.hidden = true; }
			if(tag.outlineLevel != null) { rowrite = true; rowobj.level = +tag.outlineLevel; }
			if(rowrite) rows[tagr-1] = rowobj;
		}

		/* 18.3.1.4 c CT_Cell */
		cells = x.slice(ri).split(cellregex);
		for(var rslice = 0; rslice != cells.length; ++rslice) if(cells[rslice].trim().charAt(0) != "<") break;
		cells = cells.slice(rslice);
		for(ri = 0; ri != cells.length; ++ri) {
			x = cells[ri].trim();
			if(x.length === 0) continue;
			cref = x.match(rregex); idx = ri; i=0; cc=0;
			x = "<c " + (x.slice(0,1)=="<"?">":"") + x;
			if(cref != null && cref.length === 2) {
				idx = 0; d=cref[1];
				for(i=0; i != d.length; ++i) {
					if((cc=d.charCodeAt(i)-64) < 1 || cc > 26) break;
					idx = 26*idx + cc;
				}
				--idx;
				tagc = idx;
			} else ++tagc;
			for(i = 0; i != x.length; ++i) if(x.charCodeAt(i) === 62) break; ++i;
			tag = parsexmltag(x.slice(0,i), true);
			if(!tag.r) tag.r = encode_cell({r:tagr-1, c:tagc});
			d = x.slice(i);
			p = ({t:""});

			if((cref=str_match_xml_ns(d, "v"))!= null && cref[1] !== '') p.v=unescapexml(cref[1]);
			if(opts.cellFormula) {
				if((cref=str_match_xml_ns(d, "f"))!= null ) {
					if(cref[1] == "") {
						if(cref[0].indexOf('t="shared"') > -1) {
							// TODO: parse formula
							ftag = parsexmltag(cref[0]);
							if(sharedf[ftag.si]) p.f = shift_formula_xlsx(sharedf[ftag.si][1], sharedf[ftag.si][2]/*[0].ref*/, tag.r);
						}
					} else {
						/* TODO: match against XLSXFutureFunctions */
						p.f=unescapexml(utf8read(cref[1]), true);
						if(!opts.xlfn) p.f = _xlfn(p.f);
						if(cref[0].indexOf('t="array"') > -1) {
							p.F = (d.match(refregex)||[])[1];
							if(p.F.indexOf(":") > -1) arrayf.push([safe_decode_range(p.F), p.F]);
						} else if(cref[0].indexOf('t="shared"') > -1) {
							// TODO: parse formula
							ftag = parsexmltag(cref[0]);
							var ___f = unescapexml(utf8read(cref[1]));
							if(!opts.xlfn) ___f = _xlfn(___f);
							sharedf[parseInt(ftag.si, 10)] = [ftag, ___f, tag.r];
						}
					}
				} else if((cref=d.match(/<f[^<>]*\/>/))) {
					ftag = parsexmltag(cref[0]);
					if(sharedf[ftag.si]) p.f = shift_formula_xlsx(sharedf[ftag.si][1], sharedf[ftag.si][2]/*[0].ref*/, tag.r);
				}
				/* TODO: factor out contains logic */
				var _tag = decode_cell(tag.r);
				for(i = 0; i < arrayf.length; ++i)
					if(_tag.r >= arrayf[i][0].s.r && _tag.r <= arrayf[i][0].e.r)
						if(_tag.c >= arrayf[i][0].s.c && _tag.c <= arrayf[i][0].e.c)
							p.F = arrayf[i][1];
			}

			if(tag.t == null && p.v === undefined) {
				if(p.f || p.F) {
					p.v = 0; p.t = "n";
				} else if(!sheetStubs) continue;
				else p.t = "z";
			}
			else p.t = tag.t || "n";
			if(guess.s.c > tagc) guess.s.c = tagc;
			if(guess.e.c < tagc) guess.e.c = tagc;
			/* 18.18.11 t ST_CellType */
			switch(p.t) {
				case 'n':
					if(p.v == "" || p.v == null) {
						if(!sheetStubs) continue;
						p.t = 'z';
					} else p.v = parseFloat(p.v);
					break;
				case 's':
					if(typeof p.v == 'undefined') {
						if(!sheetStubs) continue;
						p.t = 'z';
					} else {
						sstr = strs[parseInt(p.v, 10)];
						p.v = sstr.t;
						p.r = sstr.r;
						if(opts.cellHTML) p.h = sstr.h;
					}
					break;
				case 'str':
					p.t = "s";
					p.v = (p.v!=null) ? unescapexml(utf8read(p.v), true) : '';
					if(opts.cellHTML) p.h = escapehtml(p.v);
					break;
				case 'inlineStr':
					cref = str_match_xml_ns(d, "is");
					p.t = 's';
					if(cref != null && (sstr = parse_si(cref[1]))) {
						p.v = sstr.t;
						if(opts.cellHTML) p.h = sstr.h;
					} else p.v = "";
					break;
				case 'b': p.v = parsexmlbool(p.v); break;
				case 'd':
					if(opts.cellDates) p.v = parseDate(p.v, date1904);
					else { p.v = datenum(parseDate(p.v, date1904), date1904); p.t = 'n'; }
					break;
				/* error string in .w, number in .v */
				case 'e':
					if(!opts || opts.cellText !== false) p.w = p.v;
					p.v = RBErr[p.v]; break;
			}
			/* formatting */
			fmtid = fillid = 0;
			cf = null;
			if(do_format && tag.s !== undefined) {
				cf = styles.CellXf[tag.s];
				if(cf != null) {
					if(cf.numFmtId != null) fmtid = cf.numFmtId;
					if(opts.cellStyles) {
						if(cf.fillId != null) fillid = cf.fillId;
					}
				}
			}
			safe_format(p, fmtid, fillid, opts, themes, styles, date1904);
			if(opts.cellDates && do_format && p.t == 'n' && fmt_is_date(table_fmt[fmtid])) { p.v = numdate(p.v + (date1904 ? 1462 : 0)); p.t = typeof p.v == "number" ? 'n' : 'd'; }
			if(tag.cm && opts.xlmeta) {
				var cm = (opts.xlmeta.Cell||[])[+tag.cm-1];
				if(cm && cm.type == 'XLDAPR') p.D = true;
			}
			var _r;
			if(opts.nodim) {
				_r = decode_cell(tag.r);
				if(guess.s.r > _r.r) guess.s.r = _r.r;
				if(guess.e.r < _r.r) guess.e.r = _r.r;
			}
			if(dense) {
				_r = decode_cell(tag.r);
				if(!s["!data"][_r.r]) s["!data"][_r.r] = [];
				s["!data"][_r.r][_r.c] = p;
			} else s[tag.r] = p;
		}
	}
	if(rows.length > 0) s['!rows'] = rows;
}; })();

function write_ws_xml_data(ws, opts, idx, wb) {
	var o = [], r = [], range = safe_decode_range(ws['!ref']), cell="", ref, rr = "", cols = [], R=0, C=0, rows = ws['!rows'];
	var dense = ws["!data"] != null, data = dense ? ws["!data"] : [];
	var params = ({r:rr}), row, height = -1;
	var date1904 = (((wb||{}).Workbook||{}).WBProps||{}).date1904;
	for(C = range.s.c; C <= range.e.c; ++C) cols[C] = encode_col(C);
	for(R = range.s.r; R <= range.e.r; ++R) {
		r = [];
		rr = encode_row(R);
		var data_R = dense ? data[R] : [];
		for(C = range.s.c; C <= range.e.c; ++C) {
			ref = cols[C] + rr;
			var _cell = dense ? data_R[C] : ws[ref];
			if(_cell === undefined) continue;
			if((cell = write_ws_xml_cell(_cell, ref, ws, opts, idx, wb, date1904)) != null) r.push(cell);
		}
		if(r.length > 0 || (rows && rows[R])) {
			params = ({r:rr});
			if(rows && rows[R]) {
				row = rows[R];
				if(row.hidden) params.hidden = 1;
				height = -1;
				if(row.hpx) height = px2pt(row.hpx);
				else if(row.hpt) height = row.hpt;
				if(height > -1) { params.ht = height; params.customHeight = 1; }
				if(row.level) { params.outlineLevel = row.level; }
			}
			o[o.length] = (writextag('row', r.join(""), params));
		}
	}
	if(rows) for(; R < rows.length; ++R) {
		if(rows && rows[R]) {
			params = ({r:R+1});
			row = rows[R];
			if(row.hidden) params.hidden = 1;
			height = -1;
			if (row.hpx) height = px2pt(row.hpx);
			else if (row.hpt) height = row.hpt;
			if (height > -1) { params.ht = height; params.customHeight = 1; }
			if (row.level) { params.outlineLevel = row.level; }
			o[o.length] = (writextag('row', "", params));
		}
	}
	return o.join("");
}

function write_ws_xml(idx, opts, wb, rels) {
	var o = [XML_HEADER, writextag('worksheet', null, {
		'xmlns': XMLNS_main[0],
		'xmlns:r': XMLNS.r
	})];
	var s = wb.SheetNames[idx], sidx = 0, rdata = "";
	var ws = wb.Sheets[s];
	if(ws == null) ws = {};
	var ref = ws['!ref'] || 'A1';
	var range = safe_decode_range(ref);
	if(range.e.c > 0x3FFF || range.e.r > 0xFFFFF) {
		if(opts.WTF) throw new Error("Range " + ref + " exceeds format limit A1:XFD1048576");
		range.e.c = Math.min(range.e.c, 0x3FFF);
		range.e.r = Math.min(range.e.c, 0xFFFFF);
		ref = encode_range(range);
	}
	if(!rels) rels = {};
	ws['!comments'] = [];
	var _drawing = [];

	write_ws_xml_sheetpr(ws, wb, idx, opts, o);

	o[o.length] = (writextag('dimension', null, {'ref': ref}));

	o[o.length] = write_ws_xml_sheetviews(ws, opts, idx, wb);

	/* TODO: store in WB, undefined styles */
	if(opts.sheetFormat) o[o.length] = (writextag('sheetFormatPr', null, {
		defaultRowHeight:opts.sheetFormat.defaultRowHeight||'16',
		baseColWidth:opts.sheetFormat.baseColWidth||'10',
		outlineLevelRow:opts.sheetFormat.outlineLevelRow||'7'
	}));

	if(ws['!cols'] != null && ws['!cols'].length > 0) o[o.length] = (write_ws_xml_cols(ws, ws['!cols']));

	o[sidx = o.length] = '<sheetData/>';
	ws['!links'] = [];
	if(ws['!ref'] != null) {
		rdata = write_ws_xml_data(ws, opts, idx, wb, rels);
		if(rdata.length > 0) o[o.length] = (rdata);
	}
	if(o.length>sidx+1) { o[o.length] = ('</sheetData>'); o[sidx]=o[sidx].replace("/>",">"); }

	/* sheetCalcPr */

	if(ws['!protect']) o[o.length] = write_ws_xml_protection(ws['!protect']);

	/* protectedRanges */
	/* scenarios */

	if(ws['!autofilter'] != null) o[o.length] = write_ws_xml_autofilter(ws['!autofilter'], ws, wb, idx);

	/* sortState */
	/* dataConsolidate */
	/* customSheetViews */

	if(ws['!merges'] != null && ws['!merges'].length > 0) o[o.length] = (write_ws_xml_merges(ws['!merges']));

	/* phoneticPr */
	/* conditionalFormatting */
	/* dataValidations */

	var relc = -1, rel, rId = -1;
	if(ws['!links'].length > 0) {
		o[o.length] = "<hyperlinks>";
ws['!links'].forEach(function(l) {
			if(!l[1].Target) return;
			rel = ({"ref":l[0]});
			if(l[1].Target.charAt(0) != "#") {
				rId = add_rels(rels, -1, escapexml(l[1].Target).replace(/#[\s\S]*$/, ""), RELS.HLINK);
				rel["r:id"] = "rId"+rId;
			}
			if((relc = l[1].Target.indexOf("#")) > -1) rel.location = escapexml(l[1].Target.slice(relc+1));
			if(l[1].Tooltip) rel.tooltip = escapexml(l[1].Tooltip);
			rel.display = l[1].display;
			o[o.length] = writextag("hyperlink",null,rel);
		});
		o[o.length] = "</hyperlinks>";
	}
	delete ws['!links'];

	/* printOptions */

	if(ws['!margins'] != null) o[o.length] =  write_ws_xml_margins(ws['!margins']);

	/* pageSetup */
	/* headerFooter */
	/* rowBreaks */
	/* colBreaks */
	/* customProperties */
	/* cellWatches */

	if(!opts || opts.ignoreEC || (opts.ignoreEC == (void 0))) o[o.length] = writetag("ignoredErrors", writextag("ignoredError", null, {numberStoredAsText:1, sqref:ref}));

	/* smartTags */

	if(_drawing.length > 0) {
		rId = add_rels(rels, -1, "../drawings/drawing" + (idx+1) + ".xml", RELS.DRAW);
		o[o.length] = writextag("drawing", null, {"r:id":"rId" + rId});
		ws['!drawing'] = _drawing;
	}

	if(ws['!comments'].length > 0) {
		rId = add_rels(rels, -1, "../drawings/vmlDrawing" + (idx+1) + ".vml", RELS.VML);
		o[o.length] = writextag("legacyDrawing", null, {"r:id":"rId" + rId});
		ws['!legacy'] = rId;
	}

	/* legacyDrawingHF */
	/* picture */
	/* oleObjects */
	/* controls */
	/* webPublishItems */
	/* tableParts */
	/* extLst */

	if(o.length>1) { o[o.length] = ('</worksheet>'); o[1]=o[1].replace("/>",">"); }
	return o.join("");
}

/* [MS-XLSB] 2.4.726 BrtRowHdr */
function parse_BrtRowHdr(data, length) {
	var z = ({});
	var tgt = data.l + length;
	z.r = data.read_shift(4);
	data.l += 4; // TODO: ixfe
	var miyRw = data.read_shift(2);
	data.l += 1; // TODO: top/bot padding
	var flags = data.read_shift(1);
	data.l = tgt;
	if(flags & 0x07) z.level = flags & 0x07;
	if(flags & 0x10) z.hidden = true;
	if(flags & 0x20) z.hpt = miyRw / 20;
	return z;
}
function write_BrtRowHdr(R, range, ws) {
	var o = new_buf(17+8*16);
	var row = (ws['!rows']||[])[R]||{};
	o.write_shift(4, R);

	o.write_shift(4, 0); /* TODO: ixfe */

	var miyRw = 0x0140;
	if(row.hpx) miyRw = px2pt(row.hpx) * 20;
	else if(row.hpt) miyRw = row.hpt * 20;
	o.write_shift(2, miyRw);

	o.write_shift(1, 0); /* top/bot padding */

	var flags = 0x0;
	if(row.level) flags |= row.level;
	if(row.hidden) flags |= 0x10;
	if(row.hpx || row.hpt) flags |= 0x20;
	o.write_shift(1, flags);

	o.write_shift(1, 0); /* phonetic guide */

	/* [MS-XLSB] 2.5.8 BrtColSpan explains the mechanism */
	var ncolspan = 0, lcs = o.l;
	o.l += 4;

	var caddr = {r:R, c:0};
	var dense = ws["!data"] != null;
	for(var i = 0; i < 16; ++i) {
		if((range.s.c > ((i+1) << 10)) || (range.e.c < (i << 10))) continue;
		var first = -1, last = -1;
		for(var j = (i<<10); j < ((i+1)<<10); ++j) {
			caddr.c = j;
			var cell = dense ? (ws["!data"][caddr.r]||[])[caddr.c] : ws[encode_cell(caddr)];
			if(cell) { if(first < 0) first = j; last = j; }
		}
		if(first < 0) continue;
		++ncolspan;
		o.write_shift(4, first);
		o.write_shift(4, last);
	}

	var l = o.l;
	o.l = lcs;
	o.write_shift(4, ncolspan);
	o.l = l;

	return o.length > o.l ? o.slice(0, o.l) : o;
}
function write_row_header(ba, ws, range, R) {
	var o = write_BrtRowHdr(R, range, ws);
	if((o.length > 17) || (ws['!rows']||[])[R]) write_record(ba, 0x0000 /* BrtRowHdr */, o);
}

/* [MS-XLSB] 2.4.820 BrtWsDim */
var parse_BrtWsDim = parse_UncheckedRfX;
var write_BrtWsDim = write_UncheckedRfX;

/* [MS-XLSB] 2.4.821 BrtWsFmtInfo */
function parse_BrtWsFmtInfo() {
}
//function write_BrtWsFmtInfo(ws, o) { }

/* [MS-XLSB] 2.4.823 BrtWsProp */
function parse_BrtWsProp(data, length) {
	var z = {};
	var f = data[data.l]; ++data.l;
	z.above = !(f & 0x40);
	z.left  = !(f & 0x80);
	/* TODO: pull flags */
	data.l += 18;
	z.name = parse_XLSBCodeName(data, length - 19);
	return z;
}
function write_BrtWsProp(str, outl, o) {
	if(o == null) o = new_buf(84+4*str.length);
	var f = 0xC0;
	if(outl) {
		if(outl.above) f &= ~0x40;
		if(outl.left)  f &= ~0x80;
	}
	o.write_shift(1, f);
	for(var i = 1; i < 3; ++i) o.write_shift(1,0);
	write_BrtColor({auto:1}, o);
	o.write_shift(-4,-1);
	o.write_shift(-4,-1);
	write_XLSBCodeName(str, o);
	return o.slice(0, o.l);
}

/* [MS-XLSB] 2.4.306 BrtCellBlank */
function parse_BrtCellBlank(data) {
	var cell = parse_XLSBCell(data);
	return [cell];
}
function write_BrtCellBlank(cell, ncell, o) {
	if(o == null) o = new_buf(8);
	return write_XLSBCell(ncell, o);
}
function parse_BrtShortBlank(data) {
	var cell = parse_XLSBShortCell(data);
	return [cell];
}
function write_BrtShortBlank(cell, ncell, o) {
	if(o == null) o = new_buf(4);
	return write_XLSBShortCell(ncell, o);
}

/* [MS-XLSB] 2.4.307 BrtCellBool */
function parse_BrtCellBool(data) {
	var cell = parse_XLSBCell(data);
	var fBool = data.read_shift(1);
	return [cell, fBool, 'b'];
}
function write_BrtCellBool(cell, ncell, o) {
	if(o == null) o = new_buf(9);
	write_XLSBCell(ncell, o);
	o.write_shift(1, cell.v ? 1 : 0);
	return o;
}
function parse_BrtShortBool(data) {
	var cell = parse_XLSBShortCell(data);
	var fBool = data.read_shift(1);
	return [cell, fBool, 'b'];
}
function write_BrtShortBool(cell, ncell, o) {
	if(o == null) o = new_buf(5);
	write_XLSBShortCell(ncell, o);
	o.write_shift(1, cell.v ? 1 : 0);
	return o;
}

/* [MS-XLSB] 2.4.308 BrtCellError */
function parse_BrtCellError(data) {
	var cell = parse_XLSBCell(data);
	var bError = data.read_shift(1);
	return [cell, bError, 'e'];
}
function write_BrtCellError(cell, ncell, o) {
	if(o == null) o = new_buf(9);
	write_XLSBCell(ncell, o);
	o.write_shift(1, cell.v);
	return o;
}
function parse_BrtShortError(data) {
	var cell = parse_XLSBShortCell(data);
	var bError = data.read_shift(1);
	return [cell, bError, 'e'];
}
function write_BrtShortError(cell, ncell, o) {
	if(o == null) o = new_buf(8);
	write_XLSBShortCell(ncell, o);
	o.write_shift(1, cell.v);
	o.write_shift(2, 0);
	o.write_shift(1, 0);
	return o;
}


/* [MS-XLSB] 2.4.311 BrtCellIsst */
function parse_BrtCellIsst(data) {
	var cell = parse_XLSBCell(data);
	var isst = data.read_shift(4);
	return [cell, isst, 's'];
}
function write_BrtCellIsst(cell, ncell, o) {
	if(o == null) o = new_buf(12);
	write_XLSBCell(ncell, o);
	o.write_shift(4, ncell.v);
	return o;
}
function parse_BrtShortIsst(data) {
	var cell = parse_XLSBShortCell(data);
	var isst = data.read_shift(4);
	return [cell, isst, 's'];
}
function write_BrtShortIsst(cell, ncell, o) {
	if(o == null) o = new_buf(8);
	write_XLSBShortCell(ncell, o);
	o.write_shift(4, ncell.v);
	return o;
}

/* [MS-XLSB] 2.4.313 BrtCellReal */
function parse_BrtCellReal(data) {
	var cell = parse_XLSBCell(data);
	var value = parse_Xnum(data);
	return [cell, value, 'n'];
}
function write_BrtCellReal(cell, ncell, o) {
	if(o == null) o = new_buf(16);
	write_XLSBCell(ncell, o);
	write_Xnum(cell.v, o);
	return o;
}
function parse_BrtShortReal(data) {
	var cell = parse_XLSBShortCell(data);
	var value = parse_Xnum(data);
	return [cell, value, 'n'];
}
function write_BrtShortReal(cell, ncell, o) {
	if(o == null) o = new_buf(12);
	write_XLSBShortCell(ncell, o);
	write_Xnum(cell.v, o);
	return o;
}

/* [MS-XLSB] 2.4.314 BrtCellRk */
function parse_BrtCellRk(data) {
	var cell = parse_XLSBCell(data);
	var value = parse_RkNumber(data);
	return [cell, value, 'n'];
}
function write_BrtCellRk(cell, ncell, o) {
	if(o == null) o = new_buf(12);
	write_XLSBCell(ncell, o);
	write_RkNumber(cell.v, o);
	return o;
}
function parse_BrtShortRk(data) {
	var cell = parse_XLSBShortCell(data);
	var value = parse_RkNumber(data);
	return [cell, value, 'n'];
}
function write_BrtShortRk(cell, ncell, o) {
	if(o == null) o = new_buf(8);
	write_XLSBShortCell(ncell, o);
	write_RkNumber(cell.v, o);
	return o;
}

/* [MS-XLSB] 2.4.323 BrtCellRString */
function parse_BrtCellRString(data) {
	var cell = parse_XLSBCell(data);
	var value = parse_RichStr(data);
	return [cell, value, 'is'];
}

/* [MS-XLSB] 2.4.317 BrtCellSt */
function parse_BrtCellSt(data) {
	var cell = parse_XLSBCell(data);
	var value = parse_XLWideString(data);
	return [cell, value, 'str'];
}
function write_BrtCellSt(cell, ncell, o) {
	var data = cell.v == null ? "" : String(cell.v);
	if(o == null) o = new_buf(12 + 4 * cell.v.length);
	write_XLSBCell(ncell, o);
	write_XLWideString(data, o);
	return o.length > o.l ? o.slice(0, o.l) : o;
}
function parse_BrtShortSt(data) {
	var cell = parse_XLSBShortCell(data);
	var value = parse_XLWideString(data);
	return [cell, value, 'str'];
}
function write_BrtShortSt(cell, ncell, o) {
	var data = cell.v == null ? "" : String(cell.v);
	if(o == null) o = new_buf(8 + 4 * data.length);
	write_XLSBShortCell(ncell, o);
	write_XLWideString(data, o);
	return o.length > o.l ? o.slice(0, o.l) : o;
}

/* [MS-XLSB] 2.4.653 BrtFmlaBool */
function parse_BrtFmlaBool(data, length, opts) {
	var end = data.l + length;
	var cell = parse_XLSBCell(data);
	cell.r = opts['!row'];
	var value = data.read_shift(1);
	var o = [cell, value, 'b'];
	if(opts.cellFormula) {
		data.l += 2;
		var formula = parse_XLSBCellParsedFormula(data, end - data.l, opts);
		o[3] = stringify_formula(formula, null/*range*/, cell, opts.supbooks, opts);/* TODO */
	}
	else data.l = end;
	return o;
}

/* [MS-XLSB] 2.4.654 BrtFmlaError */
function parse_BrtFmlaError(data, length, opts) {
	var end = data.l + length;
	var cell = parse_XLSBCell(data);
	cell.r = opts['!row'];
	var value = data.read_shift(1);
	var o = [cell, value, 'e'];
	if(opts.cellFormula) {
		data.l += 2;
		var formula = parse_XLSBCellParsedFormula(data, end - data.l, opts);
		o[3] = stringify_formula(formula, null/*range*/, cell, opts.supbooks, opts);/* TODO */
	}
	else data.l = end;
	return o;
}

/* [MS-XLSB] 2.4.655 BrtFmlaNum */
function parse_BrtFmlaNum(data, length, opts) {
	var end = data.l + length;
	var cell = parse_XLSBCell(data);
	cell.r = opts['!row'];
	var value = parse_Xnum(data);
	var o = [cell, value, 'n'];
	if(opts.cellFormula) {
		data.l += 2;
		var formula = parse_XLSBCellParsedFormula(data, end - data.l, opts);
		o[3] = stringify_formula(formula, null/*range*/, cell, opts.supbooks, opts);/* TODO */
	}
	else data.l = end;
	return o;
}

/* [MS-XLSB] 2.4.656 BrtFmlaString */
function parse_BrtFmlaString(data, length, opts) {
	var end = data.l + length;
	var cell = parse_XLSBCell(data);
	cell.r = opts['!row'];
	var value = parse_XLWideString(data);
	var o = [cell, value, 'str'];
	if(opts.cellFormula) {
		data.l += 2;
		var formula = parse_XLSBCellParsedFormula(data, end - data.l, opts);
		o[3] = stringify_formula(formula, null/*range*/, cell, opts.supbooks, opts);/* TODO */
	}
	else data.l = end;
	return o;
}

/* [MS-XLSB] 2.4.682 BrtMergeCell */
var parse_BrtMergeCell = parse_UncheckedRfX;
var write_BrtMergeCell = write_UncheckedRfX;
/* [MS-XLSB] 2.4.107 BrtBeginMergeCells */
function write_BrtBeginMergeCells(cnt, o) {
	if(o == null) o = new_buf(4);
	o.write_shift(4, cnt);
	return o;
}

/* [MS-XLSB] 2.4.662 BrtHLink */
function parse_BrtHLink(data, length) {
	var end = data.l + length;
	var rfx = parse_UncheckedRfX(data, 16);
	var relId = parse_XLNullableWideString(data);
	var loc = parse_XLWideString(data);
	var tooltip = parse_XLWideString(data);
	var display = parse_XLWideString(data);
	data.l = end;
	var o = ({rfx:rfx, relId:relId, loc:loc, display:display});
	if(tooltip) o.Tooltip = tooltip;
	return o;
}
function write_BrtHLink(l, rId) {
	var o = new_buf(50+4*(l[1].Target.length + (l[1].Tooltip || "").length));
	write_UncheckedRfX({s:decode_cell(l[0]), e:decode_cell(l[0])}, o);
	write_RelID("rId" + rId, o);
	var locidx = l[1].Target.indexOf("#");
	var loc = locidx == -1 ? "" : l[1].Target.slice(locidx+1);
	write_XLWideString(loc || "", o);
	write_XLWideString(l[1].Tooltip || "", o);
	write_XLWideString("", o);
	return o.slice(0, o.l);
}

/* [MS-XLSB] 2.4.692 BrtPane */
function parse_BrtPane(/*data, length, opts*/) {
}

/* [MS-XLSB] 2.4.6 BrtArrFmla */
function parse_BrtArrFmla(data, length, opts) {
	var end = data.l + length;
	var rfx = parse_RfX(data, 16);
	var fAlwaysCalc = data.read_shift(1);
	var o = [rfx]; o[2] = fAlwaysCalc;
	if(opts.cellFormula) {
		var formula = parse_XLSBArrayParsedFormula(data, end - data.l, opts);
		o[1] = formula;
	} else data.l = end;
	return o;
}

/* [MS-XLSB] 2.4.750 BrtShrFmla */
function parse_BrtShrFmla(data, length, opts) {
	var end = data.l + length;
	var rfx = parse_UncheckedRfX(data, 16);
	var o = [rfx];
	if(opts.cellFormula) {
		var formula = parse_XLSBSharedParsedFormula(data, end - data.l, opts);
		o[1] = formula;
		data.l = end;
	} else data.l = end;
	return o;
}

/* [MS-XLSB] 2.4.323 BrtColInfo */
/* TODO: once XLS ColInfo is set, combine the functions */
function write_BrtColInfo(C, col, o) {
	if(o == null) o = new_buf(18);
	var p = col_obj_w(C, col);
	o.write_shift(-4, C);
	o.write_shift(-4, C);
	o.write_shift(4, (p.width || 10) * 256);
	o.write_shift(4, 0/*ixfe*/); // style
	var flags = 0;
	if(col.hidden) flags |= 0x01;
	if(typeof p.width == 'number') flags |= 0x02;
	if(col.level) flags |= (col.level << 8);
	o.write_shift(2, flags); // bit flag
	return o;
}

/* [MS-XLSB] 2.4.678 BrtMargins */
var BrtMarginKeys = ["left","right","top","bottom","header","footer"];
function parse_BrtMargins(data) {
	var margins = ({});
	BrtMarginKeys.forEach(function(k) { margins[k] = parse_Xnum(data, 8); });
	return margins;
}
function write_BrtMargins(margins, o) {
	if(o == null) o = new_buf(6*8);
	default_margins(margins);
	BrtMarginKeys.forEach(function(k) { write_Xnum((margins)[k], o); });
	return o;
}

/* [MS-XLSB] 2.4.299 BrtBeginWsView */
function parse_BrtBeginWsView(data) {
	var f = data.read_shift(2);
	data.l += 28;
	return { RTL: f & 0x20 };
}
function write_BrtBeginWsView(ws, Workbook, o) {
	if(o == null) o = new_buf(30);
	var f = 0x39c;
	if((((Workbook||{}).Views||[])[0]||{}).RTL) f |= 0x20;
	o.write_shift(2, f); // bit flag
	o.write_shift(4, 0);
	o.write_shift(4, 0); // view first row
	o.write_shift(4, 0); // view first col
	o.write_shift(1, 0); // gridline color ICV
	o.write_shift(1, 0);
	o.write_shift(2, 0);
	o.write_shift(2, 100); // zoom scale
	o.write_shift(2, 0);
	o.write_shift(2, 0);
	o.write_shift(2, 0);
	o.write_shift(4, 0); // workbook view id
	return o;
}

/* [MS-XLSB] 2.4.309 BrtCellIgnoreEC */
function write_BrtCellIgnoreEC(ref) {
	var o = new_buf(24);
	o.write_shift(4, 4);
	o.write_shift(4, 1);
	write_UncheckedRfX(ref, o);
	return o;
}

/* [MS-XLSB] 2.4.748 BrtSheetProtection */
function write_BrtSheetProtection(sp, o) {
	if(o == null) o = new_buf(16*4+2);
	o.write_shift(2, sp.password ? crypto_CreatePasswordVerifier_Method1(sp.password) : 0);
	o.write_shift(4, 1); // this record should not be written if no protection
	[
		["objects",             false], // fObjects
		["scenarios",           false], // fScenarios
		["formatCells",          true], // fFormatCells
		["formatColumns",        true], // fFormatColumns
		["formatRows",           true], // fFormatRows
		["insertColumns",        true], // fInsertColumns
		["insertRows",           true], // fInsertRows
		["insertHyperlinks",     true], // fInsertHyperlinks
		["deleteColumns",        true], // fDeleteColumns
		["deleteRows",           true], // fDeleteRows
		["selectLockedCells",   false], // fSelLockedCells
		["sort",                 true], // fSort
		["autoFilter",           true], // fAutoFilter
		["pivotTables",          true], // fPivotTables
		["selectUnlockedCells", false]  // fSelUnlockedCells
	].forEach(function(n) {
if(n[1]) o.write_shift(4, sp[n[0]] != null && !sp[n[0]] ? 1 : 0);
		else      o.write_shift(4, sp[n[0]] != null && sp[n[0]] ? 0 : 1);
	});
	return o;
}

function parse_BrtDVal(/*data, length, opts*/) {
}
function parse_BrtDVal14(/*data, length, opts*/) {
}
/* [MS-XLSB] 2.1.7.61 Worksheet */
function parse_ws_bin(data, _opts, idx, rels, wb, themes, styles) {
	if(!data) return data;
	var opts = _opts || {};
	if(!rels) rels = {'!id':{}};
	if(DENSE != null && opts.dense == null) opts.dense = DENSE;
	var s = ({}); if(opts.dense) s["!data"] = [];

	var ref;
	var refguess = {s: {r:2000000, c:2000000}, e: {r:0, c:0} };

	var state = [];
	var pass = false, end = false;
	var row, p, cf, R, C, addr, sstr, rr, cell;
	var merges = [];
	opts.biff = 12;
	opts['!row'] = 0;

	var ai = 0, af = false;

	var arrayf = [];
	var sharedf = {};
	var supbooks = opts.supbooks || wb.supbooks || ([[]]);
	supbooks.sharedf = sharedf;
	supbooks.arrayf = arrayf;
	supbooks.SheetNames = wb.SheetNames || wb.Sheets.map(function(x) { return x.name; });
	if(!opts.supbooks) {
		opts.supbooks = supbooks;
		if(wb.Names) for(var i = 0; i < wb.Names.length; ++i) supbooks[0][i+1] = wb.Names[i];
	}

	var colinfo = [], rowinfo = [];
	var seencol = false;

	XLSBRecordEnum[0x0010] = { n:"BrtShortReal", f:parse_BrtShortReal };

	var cm, vm;
	var date1904 = 1462 * +!!((wb||{}).WBProps||{}).date1904;

	recordhopper(data, function ws_parse(val, RR, RT) {
		if(end) return;
		switch(RT) {
			case 0x0094: /* 'BrtWsDim' */
				ref = val; break;
			case 0x0000: /* 'BrtRowHdr' */
				row = val;
				if(opts.sheetRows && opts.sheetRows <= row.r) end=true;
				rr = encode_row(R = row.r);
				opts['!row'] = row.r;
				if(val.hidden || val.hpt || val.level != null) {
					if(val.hpt) val.hpx = pt2px(val.hpt);
					rowinfo[val.r] = val;
				}
				break;

			case 0x0002: /* 'BrtCellRk' */
			case 0x0003: /* 'BrtCellError' */
			case 0x0004: /* 'BrtCellBool' */
			case 0x0005: /* 'BrtCellReal' */
			case 0x0006: /* 'BrtCellSt' */
			case 0x0007: /* 'BrtCellIsst' */
			case 0x0008: /* 'BrtFmlaString' */
			case 0x0009: /* 'BrtFmlaNum' */
			case 0x000A: /* 'BrtFmlaBool' */
			case 0x000B: /* 'BrtFmlaError' */
			case 0x000D: /* 'BrtShortRk' */
			case 0x000E: /* 'BrtShortError' */
			case 0x000F: /* 'BrtShortBool' */
			case 0x0010: /* 'BrtShortReal' */
			case 0x0011: /* 'BrtShortSt' */
			case 0x0012: /* 'BrtShortIsst' */
			case 0x003E: /* 'BrtCellRString' */
				p = ({t:val[2]});
				switch(val[2]) {
					case 'n': p.v = val[1]; break;
					case 's': sstr = strs[val[1]]; p.v = sstr.t; p.r = sstr.r; break;
					case 'b': p.v = val[1] ? true : false; break;
					case 'e': p.v = val[1]; if(opts.cellText !== false) p.w = BErr[p.v]; break;
					case 'str': p.t = 's'; p.v = val[1]; break;
					case 'is': p.t = 's'; p.v = val[1].t; break;
				}
				if((cf = styles.CellXf[val[0].iStyleRef])) safe_format(p,cf.numFmtId,null,opts, themes, styles, date1904>0);
				C = val[0].c == -1 ? C + 1 : val[0].c;
				if(opts.dense) { if(!s["!data"][R]) s["!data"][R] = []; s["!data"][R][C] = p; }
				else s[encode_col(C) + rr] = p;
				if(opts.cellFormula) {
					af = false;
					for(ai = 0; ai < arrayf.length; ++ai) {
						var aii = arrayf[ai];
						if(row.r >= aii[0].s.r && row.r <= aii[0].e.r)
							if(C >= aii[0].s.c && C <= aii[0].e.c) {
								p.F = encode_range(aii[0]); af = true;
							}
					}
					if(!af && val.length > 3) p.f = val[3];
				}

				if(refguess.s.r > row.r) refguess.s.r = row.r;
				if(refguess.s.c > C) refguess.s.c = C;
				if(refguess.e.r < row.r) refguess.e.r = row.r;
				if(refguess.e.c < C) refguess.e.c = C;
				if(opts.cellDates && cf && p.t == 'n' && fmt_is_date(table_fmt[cf.numFmtId])) {
					var _d = SSF_parse_date_code(p.v + date1904); if(_d) { p.t = 'd'; p.v = new Date(Date.UTC(_d.y, _d.m-1,_d.d,_d.H,_d.M,_d.S,_d.u)); }
				}
				if(cm) {
					if(cm.type == 'XLDAPR') p.D = true;
					cm = void 0;
				}
				if(vm) vm = void 0;
				break;

			case 0x0001: /* 'BrtCellBlank' */
			case 0x000C: /* 'BrtShortBlank' */
				if(!opts.sheetStubs || pass) break;
				p = ({t:'z',v:void 0});
				C = val[0].c == -1 ? C + 1 : val[0].c;
				if(opts.dense) { if(!s["!data"][R]) s["!data"][R] = []; s["!data"][R][C] = p; }
				else s[encode_col(C) + rr] = p;
				if(refguess.s.r > row.r) refguess.s.r = row.r;
				if(refguess.s.c > C) refguess.s.c = C;
				if(refguess.e.r < row.r) refguess.e.r = row.r;
				if(refguess.e.c < C) refguess.e.c = C;
				if(cm) {
					if(cm.type == 'XLDAPR') p.D = true;
					cm = void 0;
				}
				if(vm) vm = void 0;
				break;

			case 0x00B0: /* 'BrtMergeCell' */
				merges.push(val); break;

			case 0x0031: { /* 'BrtCellMeta' */
				cm = ((opts.xlmeta||{}).Cell||[])[val-1];
			} break;

			case 0x01EE: /* 'BrtHLink' */
				var rel = rels['!id'][val.relId];
				if(rel) {
					val.Target = rel.Target;
					if(val.loc) val.Target += "#"+val.loc;
					val.Rel = rel;
				} else if(val.relId == '') {
					val.Target = "#" + val.loc;
				}
				for(R=val.rfx.s.r;R<=val.rfx.e.r;++R) for(C=val.rfx.s.c;C<=val.rfx.e.c;++C) {
					if(opts.dense) {
						if(!s["!data"][R]) s["!data"][R] = [];
						if(!s["!data"][R][C]) s["!data"][R][C] = {t:'z',v:undefined};
						s["!data"][R][C].l = val;
					} else {
						addr = encode_col(C) + encode_row(R);
						if(!s[addr]) s[addr] = {t:'z',v:undefined};
						s[addr].l = val;
					}
				}
				break;

			case 0x01AA: /* 'BrtArrFmla' */
				if(!opts.cellFormula) break;
				arrayf.push(val);
				cell = ((opts.dense ? s["!data"][R][C] : s[encode_col(C) + rr]));
				cell.f = stringify_formula(val[1], refguess, {r:row.r, c:C}, supbooks, opts);
				cell.F = encode_range(val[0]);
				break;
			case 0x01AB: /* 'BrtShrFmla' */
				if(!opts.cellFormula) break;
				sharedf[encode_cell(val[0].s)] = val[1];
				cell = (opts.dense ? s["!data"][R][C] : s[encode_col(C) + rr]);
				cell.f = stringify_formula(val[1], refguess, {r:row.r, c:C}, supbooks, opts);
				break;

			/* identical to 'ColInfo' in XLS */
			case 0x003C: /* 'BrtColInfo' */
				if(!opts.cellStyles) break;
				while(val.e >= val.s) {
					colinfo[val.e--] = { width: val.w/256, hidden: !!(val.flags & 0x01), level: val.level };
					if(!seencol) { seencol = true; find_mdw_colw(val.w/256); }
					process_col(colinfo[val.e+1]);
				}
				break;

			case 0x0227: /* 'BrtLegacyDrawing' */
				if(val) s["!legrel"] = val;
				break;

			case 0x00A1: /* 'BrtBeginAFilter' */
				s['!autofilter'] = { ref:encode_range(val) };
				break;

			case 0x01DC: /* 'BrtMargins' */
				s['!margins'] = val;
				break;

			case 0x0093: /* 'BrtWsProp' */
				if(!wb.Sheets[idx]) wb.Sheets[idx] = {};
				if(val.name) wb.Sheets[idx].CodeName = val.name;
				if(val.above || val.left) s['!outline'] = { above: val.above, left: val.left };
				break;

			case 0x0089: /* 'BrtBeginWsView' */
				if(!wb.Views) wb.Views = [{}];
				if(!wb.Views[0]) wb.Views[0] = {};
				if(val.RTL) wb.Views[0].RTL = true;
				break;

			case 0x01E5: /* 'BrtWsFmtInfo' */
				break;

			case 0x0040: /* 'BrtDVal' */
			case 0x041D: /* 'BrtDVal14' */
				break;

			case 0x0097: /* 'BrtPane' */
				break;
			case 0x0098: /* 'BrtSel' */
			case 0x00AF: /* 'BrtAFilterDateGroupItem' */
			case 0x0284: /* 'BrtActiveX' */
			case 0x0271: /* 'BrtBigName' */
			case 0x0232: /* 'BrtBkHim' */
			case 0x018C: /* 'BrtBrk' */
			case 0x0458: /* 'BrtCFIcon' */
			case 0x047A: /* 'BrtCFRuleExt' */
			case 0x01D7: /* 'BrtCFVO' */
			case 0x041A: /* 'BrtCFVO14' */
			case 0x0289: /* 'BrtCellIgnoreEC' */
			case 0x0451: /* 'BrtCellIgnoreEC14' */
			case 0x024D: /* 'BrtCellSmartTagProperty' */
			case 0x025F: /* 'BrtCellWatch' */
			case 0x0234: /* 'BrtColor' */
			case 0x041F: /* 'BrtColor14' */
			case 0x00A8: /* 'BrtColorFilter' */
			case 0x00AE: /* 'BrtCustomFilter' */
			case 0x049C: /* 'BrtCustomFilter14' */
			case 0x01F3: /* 'BrtDRef' */
			case 0x01FB: /* 'BrtDXF' */
			case 0x0226: /* 'BrtDrawing' */
			case 0x00AB: /* 'BrtDynamicFilter' */
			case 0x00A7: /* 'BrtFilter' */
			case 0x0499: /* 'BrtFilter14' */
			case 0x00A9: /* 'BrtIconFilter' */
			case 0x049D: /* 'BrtIconFilter14' */
			case 0x0228: /* 'BrtLegacyDrawingHF' */
			case 0x0295: /* 'BrtListPart' */
			case 0x027F: /* 'BrtOleObject' */
			case 0x01DE: /* 'BrtPageSetup' */
			case 0x0219: /* 'BrtPhoneticInfo' */
			case 0x01DD: /* 'BrtPrintOptions' */
			case 0x0218: /* 'BrtRangeProtection' */
			case 0x044F: /* 'BrtRangeProtection14' */
			case 0x02A8: /* 'BrtRangeProtectionIso' */
			case 0x0450: /* 'BrtRangeProtectionIso14' */
			case 0x0400: /* 'BrtRwDescent' */
			case 0x0297: /* 'BrtSheetCalcProp' */
			case 0x0217: /* 'BrtSheetProtection' */
			case 0x02A6: /* 'BrtSheetProtectionIso' */
			case 0x01F8: /* 'BrtSlc' */
			case 0x0413: /* 'BrtSparkline' */
			case 0x01AC: /* 'BrtTable' */
			case 0x00AA: /* 'BrtTop10Filter' */
			case 0x0C00: /* 'BrtUid' */
			case 0x0032: /* 'BrtValueMeta' */
			case 0x0816: /* 'BrtWebExtension' */
			case 0x0415: /* 'BrtWsFmtInfoEx14' */
				break;

			case 0x0023: /* 'BrtFRTBegin' */
				pass = true; break;
			case 0x0024: /* 'BrtFRTEnd' */
				pass = false; break;
			case 0x0025: /* 'BrtACBegin' */
				state.push(RT); pass = true; break;
			case 0x0026: /* 'BrtACEnd' */
				state.pop(); pass = false; break;

			default:
				if(RR.T){/* empty */}
				else if(!pass || opts.WTF) throw new Error("Unexpected record 0x" + RT.toString(16));
		}
	}, opts);

	delete opts.supbooks;
	delete opts['!row'];

	if(!s["!ref"] && (refguess.s.r < 2000000 || ref && (ref.e.r > 0 || ref.e.c > 0 || ref.s.r > 0 || ref.s.c > 0))) s["!ref"] = encode_range(ref || refguess);
	if(opts.sheetRows && s["!ref"]) {
		var tmpref = safe_decode_range(s["!ref"]);
		if(opts.sheetRows <= +tmpref.e.r) {
			tmpref.e.r = opts.sheetRows - 1;
			if(tmpref.e.r > refguess.e.r) tmpref.e.r = refguess.e.r;
			if(tmpref.e.r < tmpref.s.r) tmpref.s.r = tmpref.e.r;
			if(tmpref.e.c > refguess.e.c) tmpref.e.c = refguess.e.c;
			if(tmpref.e.c < tmpref.s.c) tmpref.s.c = tmpref.e.c;
			s["!fullref"] = s["!ref"];
			s["!ref"] = encode_range(tmpref);
		}
	}
	if(merges.length > 0) s["!merges"] = merges;
	if(colinfo.length > 0) s["!cols"] = colinfo;
	if(rowinfo.length > 0) s["!rows"] = rowinfo;
	if(rels['!id'][s['!legrel']]) s['!legdrawel'] = rels['!id'][s['!legrel']];
	return s;
}

/* TODO: something useful -- this is a stub */
function write_ws_bin_cell(ba, cell, R, C, opts, ws, last_seen, date1904) {
	var o = ({r:R, c:C});
	if(cell.c) ws['!comments'].push([encode_cell(o), cell.c]);
	if(cell.v === undefined) return false;
	var vv = "";
	switch(cell.t) {
		case 'b': vv = cell.v ? "1" : "0"; break;
		case 'd': // no BrtCellDate :(
			cell = dup(cell);
			cell.z = cell.z || table_fmt[14];
			cell.v = datenum(parseDate(cell.v, date1904), date1904); cell.t = 'n';
			break;
		/* falls through */
		case 'n': case 'e': vv = ''+cell.v; break;
		default: vv = cell.v; break;
	}
	/* TODO: cell style */
	o.s = get_cell_style(opts.cellXfs, cell, opts);
	if(cell.l) ws['!links'].push([encode_cell(o), cell.l]);
	switch(cell.t) {
		case 's': case 'str':
			if(opts.bookSST) {
				vv = get_sst_id(opts.Strings, (cell.v == null ? "" : String(cell.v)), opts.revStrings);
				o.t = "s"; o.v = vv;
				if(last_seen) write_record(ba, 0x0012 /* BrtShortIsst */, write_BrtShortIsst(cell, o));
				else write_record(ba, 0x0007 /* BrtCellIsst */, write_BrtCellIsst(cell, o));
			} else {
				o.t = "str";
				if(last_seen) write_record(ba, 0x0011 /* BrtShortSt */, write_BrtShortSt(cell, o));
				else write_record(ba, 0x0006 /* BrtCellSt */, write_BrtCellSt(cell, o));
			}
			return true;
		case 'n':
			/* TODO: determine threshold for Real vs RK */
			if(cell.v == (cell.v | 0) && cell.v > -1000 && cell.v < 1000) {
				if(last_seen) write_record(ba, 0x000D /* BrtShortRk */, write_BrtShortRk(cell, o));
				else write_record(ba, 0x0002 /* BrtCellRk */, write_BrtCellRk(cell, o));
			} else if(!isFinite(cell.v)) {
				o.t = "e";
				if(isNaN(cell.v)) {
					if(last_seen) write_record(ba, 0x000E /* BrtShortError */, write_BrtShortError({t:"e", v: 0x24}, o)); // #NUM!
					else write_record(ba, 0x0003 /* BrtCellError */, write_BrtCellError({t:"e", v: 0x24}, o)); // #NUM!
				} else {
					if(last_seen) write_record(ba, 0x000E /* BrtShortError */, write_BrtShortError({t:"e", v: 0x07}, o)); // #DIV/0!
					else write_record(ba, 0x0003 /* BrtCellError */, write_BrtCellError({t:"e", v: 0x07}, o)); // #DIV/0!
				}
			} else {
				if(last_seen) write_record(ba, 0x0010 /* BrtShortReal */, write_BrtShortReal(cell, o));
				else write_record(ba, 0x0005 /* BrtCellReal */, write_BrtCellReal(cell, o));
			} return true;
		case 'b':
			o.t = "b";
			if(last_seen) write_record(ba, 0x000F /* BrtShortBool */, write_BrtShortBool(cell, o));
			else write_record(ba, 0x0004 /* BrtCellBool */, write_BrtCellBool(cell, o));
			return true;
		case 'e':
			o.t = "e";
			if(last_seen) write_record(ba, 0x000E /* BrtShortError */, write_BrtShortError(cell, o));
			else write_record(ba, 0x0003 /* BrtCellError */, write_BrtCellError(cell, o));
			return true;
	}
	if(last_seen) write_record(ba, 0x000C /* BrtShortBlank */, write_BrtShortBlank(cell, o));
	else write_record(ba, 0x0001 /* BrtCellBlank */, write_BrtCellBlank(cell, o));
	return true;
}

function write_CELLTABLE(ba, ws, idx, opts, wb) {
	var range = safe_decode_range(ws['!ref'] || "A1"), rr = "", cols = [];
	var date1904 = (((wb||{}).Workbook||{}).WBProps||{}).date1904;
	write_record(ba, 0x0091 /* BrtBeginSheetData */);
	var dense = ws["!data"] != null, row = dense ? ws["!data"][range.s.r] : [];
	var cap = range.e.r;
	if(ws['!rows']) cap = Math.max(range.e.r, ws['!rows'].length - 1);
	for(var R = range.s.r; R <= cap; ++R) {
		rr = encode_row(R);
		if(dense) row = ws["!data"][R];
		/* [ACCELLTABLE] */
		/* BrtRowHdr */
		write_row_header(ba, ws, range, R);
		if(dense && !row) continue;
		var last_seen = false;
		if(R <= range.e.r) for(var C = range.s.c; C <= range.e.c; ++C) {
			/* *16384CELL */
			if(R === range.s.r) cols[C] = encode_col(C);
			var cell = dense ? row[C] : ws[cols[C] + rr];
			if(!cell) { last_seen = false; continue; }
			/* write cell */
			last_seen = write_ws_bin_cell(ba, cell, R, C, opts, ws, last_seen, date1904);
		}
	}
	write_record(ba, 0x0092 /* BrtEndSheetData */);
}

function write_MERGECELLS(ba, ws) {
	if(!ws || !ws['!merges']) return;
	write_record(ba, 0x00B1 /* BrtBeginMergeCells */, write_BrtBeginMergeCells(ws['!merges'].length));
	ws['!merges'].forEach(function(m) { write_record(ba, 0x00B0 /* BrtMergeCell */, write_BrtMergeCell(m)); });
	write_record(ba, 0x00B2 /* BrtEndMergeCells */);
}

function write_COLINFOS(ba, ws) {
	if(!ws || !ws['!cols']) return;
	write_record(ba, 0x0186 /* BrtBeginColInfos */);
	ws['!cols'].forEach(function(m, i) { if(m) write_record(ba, 0x003C /* 'BrtColInfo' */, write_BrtColInfo(i, m)); });
	write_record(ba, 0x0187 /* BrtEndColInfos */);
}

function write_IGNOREECS(ba, ws) {
	if(!ws || !ws['!ref']) return;
	write_record(ba, 0x0288 /* BrtBeginCellIgnoreECs */);
	write_record(ba, 0x0289 /* BrtCellIgnoreEC */, write_BrtCellIgnoreEC(safe_decode_range(ws['!ref'])));
	write_record(ba, 0x028A /* BrtEndCellIgnoreECs */);
}

function write_HLINKS(ba, ws, rels) {
	/* *BrtHLink */
	ws['!links'].forEach(function(l) {
		if(!l[1].Target) return;
		var rId = add_rels(rels, -1, l[1].Target.replace(/#[\s\S]*$/, ""), RELS.HLINK);
		write_record(ba, 0x01EE /* BrtHLink */, write_BrtHLink(l, rId));
	});
	delete ws['!links'];
}
function write_LEGACYDRAWING(ba, ws, idx, rels) {
	/* [BrtLegacyDrawing] */
	if(ws['!comments'].length > 0) {
		var rId = add_rels(rels, -1, "../drawings/vmlDrawing" + (idx+1) + ".vml", RELS.VML);
		write_record(ba, 0x0227 /* BrtLegacyDrawing */, write_RelID("rId" + rId));
		ws['!legacy'] = rId;
	}
}

function write_AUTOFILTER(ba, ws, wb, idx) {
	if(!ws['!autofilter']) return;
	var data = ws['!autofilter'];
	var ref = typeof data.ref === "string" ? data.ref : encode_range(data.ref);

	/* Update FilterDatabase defined name for the worksheet */
	if(!wb.Workbook) wb.Workbook = ({Sheets:[]});
	if(!wb.Workbook.Names) wb.Workbook.Names = [];
	var names = wb.Workbook.Names;
	var range = decode_range(ref);
	if(range.s.r == range.e.r) { range.e.r = decode_range(ws["!ref"]).e.r; ref = encode_range(range); }
	for(var i = 0; i < names.length; ++i) {
		var name = names[i];
		if(name.Name != '_xlnm._FilterDatabase') continue;
		if(name.Sheet != idx) continue;
		name.Ref = formula_quote_sheet_name(wb.SheetNames[idx]) + "!" + fix_range(ref); break;
	}
	if(i == names.length) names.push({ Name: '_xlnm._FilterDatabase', Sheet: idx, Ref: formula_quote_sheet_name(wb.SheetNames[idx]) + "!" + fix_range(ref)  });

	write_record(ba, 0x00A1 /* BrtBeginAFilter */, write_UncheckedRfX(safe_decode_range(ref)));
	/* *FILTERCOLUMN */
	/* [SORTSTATE] */
	/* BrtEndAFilter */
	write_record(ba, 0x00A2 /* BrtEndAFilter */);
}

function write_WSVIEWS2(ba, ws, Workbook) {
	write_record(ba, 0x0085 /* BrtBeginWsViews */);
	{ /* 1*WSVIEW2 */
		/* [ACUID] */
		write_record(ba, 0x0089 /* BrtBeginWsView */, write_BrtBeginWsView(ws, Workbook));
		/* [BrtPane] */
		/* *4BrtSel */
		/* *4SXSELECT */
		/* *FRT */
		write_record(ba, 0x008A /* BrtEndWsView */);
	}
	/* *FRT */
	write_record(ba, 0x0086 /* BrtEndWsViews */);
}

function write_WSFMTINFO() {
	/* [ACWSFMTINFO] */
	// write_record(ba, 0x01E5 /* BrtWsFmtInfo */, write_BrtWsFmtInfo(ws));
}

function write_SHEETPROTECT(ba, ws) {
	if(!ws['!protect']) return;
	/* [BrtSheetProtectionIso] */
	write_record(ba, 0x0217 /* BrtSheetProtection */, write_BrtSheetProtection(ws['!protect']));
}

function write_ws_bin(idx, opts, wb, rels) {
	var ba = buf_array();
	var s = wb.SheetNames[idx], ws = wb.Sheets[s] || {};
	var c = s; try { if(wb && wb.Workbook) c = wb.Workbook.Sheets[idx].CodeName || c; } catch(e) {}
	var r = safe_decode_range(ws['!ref'] || "A1");
	if(r.e.c > 0x3FFF || r.e.r > 0xFFFFF) {
		if(opts.WTF) throw new Error("Range " + (ws['!ref'] || "A1") + " exceeds format limit A1:XFD1048576");
		r.e.c = Math.min(r.e.c, 0x3FFF);
		r.e.r = Math.min(r.e.c, 0xFFFFF);
	}
	ws['!links'] = [];
	/* passed back to write_zip and removed there */
	ws['!comments'] = [];
	write_record(ba, 0x0081 /* BrtBeginSheet */);
	if(wb.vbaraw || ws['!outline']) write_record(ba, 0x0093 /* BrtWsProp */, write_BrtWsProp(c, ws['!outline']));
	write_record(ba, 0x0094 /* BrtWsDim */, write_BrtWsDim(r));
	write_WSVIEWS2(ba, ws, wb.Workbook);
	write_WSFMTINFO(ba, ws);
	write_COLINFOS(ba, ws, idx, opts, wb);
	write_CELLTABLE(ba, ws, idx, opts, wb);
	/* [BrtSheetCalcProp] */
	write_SHEETPROTECT(ba, ws);
	/* *([BrtRangeProtectionIso] BrtRangeProtection) */
	/* [SCENMAN] */
	write_AUTOFILTER(ba, ws, wb, idx);
	/* [SORTSTATE] */
	/* [DCON] */
	/* [USERSHVIEWS] */
	write_MERGECELLS(ba, ws);
	/* [BrtPhoneticInfo] */
	/* *CONDITIONALFORMATTING */
	/* [DVALS] */
	write_HLINKS(ba, ws, rels);
	/* [BrtPrintOptions] */
	if(ws['!margins']) write_record(ba, 0x01DC /* BrtMargins */, write_BrtMargins(ws['!margins']));
	/* [BrtPageSetup] */
	/* [HEADERFOOTER] */
	/* [RWBRK] */
	/* [COLBRK] */
	/* *BrtBigName */
	/* [CELLWATCHES] */
	if(!opts || opts.ignoreEC || (opts.ignoreEC == (void 0))) write_IGNOREECS(ba, ws);
	/* [SMARTTAGS] */
	/* [BrtDrawing] */
	write_LEGACYDRAWING(ba, ws, idx, rels);
	/* [BrtLegacyDrawingHF] */
	/* [BrtBkHim] */
	/* [OLEOBJECTS] */
	/* [ACTIVEXCONTROLS] */
	/* [WEBPUBITEMS] */
	/* [LISTPARTS] */
	/* FRTWORKSHEET */
	write_record(ba, 0x0082 /* BrtEndSheet */);
	return ba.end();
}
function parse_Cache(data) {
	var col = [];
	var num = data.match(/^<c:numCache>/);
	var f;

	/* 21.2.2.150 pt CT_NumVal */
	(data.match(/<c:pt idx="(\d*)"[^<>\/]*><c:v>([^<])<\/c:v><\/c:pt>/mg)||[]).forEach(function(pt) {
		var q = pt.match(/<c:pt idx="(\d*)"[^<>\/]*><c:v>([^<]*)<\/c:v><\/c:pt>/);
		if(!q) return;
		col[+q[1]] = num ? +q[2] : q[2];
	});

	/* 21.2.2.71 formatCode CT_Xstring */
	var nf = unescapexml((str_match_xml(data, "c:formatCode") || ["","General"])[1]);

	(str_match_ng(data, "<c:f>", "</c:f>")||[]).forEach(function(F) { f = F.replace(/<[^<>]*>/g,""); });

	return [col, nf, f];
}

/* 21.2 DrawingML - Charts */
function parse_chart(data, name, opts, rels, wb, csheet) {
	var cs = ((csheet || {"!type":"chart"}));
	if(!data) return csheet;
	/* 21.2.2.27 chart CT_Chart */

	var C = 0, R = 0, col = "A";
	var refguess = {s: {r:2000000, c:2000000}, e: {r:0, c:0} };

	/* 21.2.2.120 numCache CT_NumData */
	(str_match_ng(data, "<c:numCache>", "</c:numCache>")||[]).forEach(function(nc) {
		var cache = parse_Cache(nc);
		refguess.s.r = refguess.s.c = 0;
		refguess.e.c = C;
		col = encode_col(C);
		cache[0].forEach(function(n,i) {
			if(cs["!data"]) {
				if(!cs["!data"][i]) cs["!data"][i] = [];
				cs["!data"][i][C] = {t:'n', v:n, z:cache[1] };
			} else cs[col + encode_row(i)] = {t:'n', v:n, z:cache[1] };
			R = i;
		});
		if(refguess.e.r < R) refguess.e.r = R;
		++C;
	});
	if(C > 0) cs["!ref"] = encode_range(refguess);
	return cs;
}
/* 18.3 Worksheets also covers Chartsheets */
function parse_cs_xml(data, opts, idx, rels, wb) {
	if(!data) return data;
	/* 18.3.1.12 chartsheet CT_ChartSheet */
	if(!rels) rels = {'!id':{}};
	var s = ({'!type':"chart", '!drawel':null, '!rel':""});
	var m;

	/* 18.3.1.83 sheetPr CT_ChartsheetPr */
	var sheetPr = data.match(sheetprregex);
	if(sheetPr) parse_ws_xml_sheetpr(sheetPr[0], s, wb, idx);

	/* 18.3.1.36 drawing CT_Drawing */
	if((m = data.match(/drawing r:id="(.*?)"/))) s['!rel'] = m[1];

	if(rels['!id'][s['!rel']]) s['!drawel'] = rels['!id'][s['!rel']];
	return s;
}
//function write_cs_xml(idx, opts, wb, rels) {
//	var o = [XML_HEADER, writextag('chartsheet', null, {
//		'xmlns': XMLNS_main[0],
//		'xmlns:r': XMLNS.r
//	})];
//	o[o.length] = writextag("drawing", null, {"r:id": "rId1"});
//	add_rels(rels, -1, "../drawings/drawing" + (idx+1) + ".xml", RELS.DRAW);
//	if(o.length>2) { o[o.length] = ('</chartsheet>'); o[1]=o[1].replace("/>",">"); }
//	return o.join("");
//}

/* [MS-XLSB] 2.4.331 BrtCsProp */
function parse_BrtCsProp(data, length) {
	data.l += 10;
	var name = parse_XLWideString(data, length - 10);
	return { name: name };
}

/* [MS-XLSB] 2.1.7.7 Chart Sheet */
function parse_cs_bin(data, opts, idx, rels, wb) {
	if(!data) return data;
	if(!rels) rels = {'!id':{}};
	var s = {'!type':"chart", '!drawel':null, '!rel':""};
	var state = [];
	var pass = false;
	recordhopper(data, function cs_parse(val, R, RT) {
		switch(RT) {

			case 0x0226: /* 'BrtDrawing' */
				s['!rel'] = val; break;

			case 0x028B: /* 'BrtCsProp' */
				if(!wb.Sheets[idx]) wb.Sheets[idx] = {};
				if(val.name) wb.Sheets[idx].CodeName = val.name;
				break;

			case 0x0232: /* 'BrtBkHim' */
			case 0x028C: /* 'BrtCsPageSetup' */
			case 0x029D: /* 'BrtCsProtection' */
			case 0x02A7: /* 'BrtCsProtectionIso' */
			case 0x0227: /* 'BrtLegacyDrawing' */
			case 0x0228: /* 'BrtLegacyDrawingHF' */
			case 0x01DC: /* 'BrtMargins' */
			case 0x0C00: /* 'BrtUid' */
				break;

			case 0x0023: /* 'BrtFRTBegin' */
				pass = true; break;
			case 0x0024: /* 'BrtFRTEnd' */
				pass = false; break;
			case 0x0025: /* 'BrtACBegin' */
				state.push(RT); break;
			case 0x0026: /* 'BrtACEnd' */
				state.pop(); break;

			default:
				if(R.T > 0) state.push(RT);
				else if(R.T < 0) state.pop();
				else if(!pass || opts.WTF) throw new Error("Unexpected record 0x" + RT.toString(16));
		}
	}, opts);

	if(rels['!id'][s['!rel']]) s['!drawel'] = rels['!id'][s['!rel']];
	return s;
}
//function write_cs_bin() {
//	var ba = buf_array();
//	write_record(ba, 0x0081 /* BrtBeginSheet */);
//	/* [BrtCsProp] */
//	/* CSVIEWS */
//	/* [[BrtCsProtectionIso] BrtCsProtection] */
//	/* [USERCSVIEWS] */
//	/* [BrtMargins] */
//	/* [BrtCsPageSetup] */
//	/* [HEADERFOOTER] */
//	/* BrtDrawing */
//	/* [BrtLegacyDrawing] */
//	/* [BrtLegacyDrawingHF] */
//	/* [BrtBkHim] */
//	/* [WEBPUBITEMS] */
//	/* FRTCHARTSHEET */
//	write_record(ba, 0x0082 /* BrtEndSheet */);
//	return ba.end();
//}
/* 18.2.28 (CT_WorkbookProtection) Defaults */
var WBPropsDef = [
	['allowRefreshQuery',           false, "bool"],
	['autoCompressPictures',        true,  "bool"],
	['backupFile',                  false, "bool"],
	['checkCompatibility',          false, "bool"],
	['CodeName',                    ''],
	['date1904',                    false, "bool"],
	['defaultThemeVersion',         0,      "int"],
	['filterPrivacy',               false, "bool"],
	['hidePivotFieldList',          false, "bool"],
	['promptedSolutions',           false, "bool"],
	['publishItems',                false, "bool"],
	['refreshAllConnections',       false, "bool"],
	['saveExternalLinkValues',      true,  "bool"],
	['showBorderUnselectedTables',  true,  "bool"],
	['showInkAnnotation',           true,  "bool"],
	['showObjects',                 'all'],
	['showPivotChartFilter',        false, "bool"],
	['updateLinks', 'userSet']
];

/* 18.2.30 (CT_BookView) Defaults */
var WBViewDef = [
	['activeTab',                   0,      "int"],
	['autoFilterDateGrouping',      true,  "bool"],
	['firstSheet',                  0,      "int"],
	['minimized',                   false, "bool"],
	['showHorizontalScroll',        true,  "bool"],
	['showSheetTabs',               true,  "bool"],
	['showVerticalScroll',          true,  "bool"],
	['tabRatio',                    600,    "int"],
	['visibility',                  'visible']
	//window{Height,Width}, {x,y}Window
];

/* 18.2.19 (CT_Sheet) Defaults */
var SheetDef = [
	//['state', 'visible']
];

/* 18.2.2  (CT_CalcPr) Defaults */
var CalcPrDef = [
	['calcCompleted', 'true'],
	['calcMode', 'auto'],
	['calcOnSave', 'true'],
	['concurrentCalc', 'true'],
	['fullCalcOnLoad', 'false'],
	['fullPrecision', 'true'],
	['iterate', 'false'],
	['iterateCount', '100'],
	['iterateDelta', '0.001'],
	['refMode', 'A1']
];

/* 18.2.3 (CT_CustomWorkbookView) Defaults */
/*var CustomWBViewDef = [
	['autoUpdate', 'false'],
	['changesSavedWin', 'false'],
	['includeHiddenRowCol', 'true'],
	['includePrintSettings', 'true'],
	['maximized', 'false'],
	['minimized', 'false'],
	['onlySync', 'false'],
	['personalView', 'false'],
	['showComments', 'commIndicator'],
	['showFormulaBar', 'true'],
	['showHorizontalScroll', 'true'],
	['showObjects', 'all'],
	['showSheetTabs', 'true'],
	['showStatusbar', 'true'],
	['showVerticalScroll', 'true'],
	['tabRatio', '600'],
	['xWindow', '0'],
	['yWindow', '0']
];*/

function push_defaults_array(target, defaults) {
	for(var j = 0; j != target.length; ++j) { var w = target[j];
		for(var i=0; i != defaults.length; ++i) { var z = defaults[i];
			if(w[z[0]] == null) w[z[0]] = z[1];
			else switch(z[2]) {
			case "bool": if(typeof w[z[0]] == "string") w[z[0]] = parsexmlbool(w[z[0]]); break;
			case "int": if(typeof w[z[0]] == "string") w[z[0]] = parseInt(w[z[0]], 10); break;
			}
		}
	}
}
function push_defaults(target, defaults) {
	for(var i = 0; i != defaults.length; ++i) { var z = defaults[i];
		if(target[z[0]] == null) target[z[0]] = z[1];
		else switch(z[2]) {
			case "bool": if(typeof target[z[0]] == "string") target[z[0]] = parsexmlbool(target[z[0]]); break;
			case "int": if(typeof target[z[0]] == "string") target[z[0]] = parseInt(target[z[0]], 10); break;
		}
	}
}

function parse_wb_defaults(wb) {
	push_defaults(wb.WBProps, WBPropsDef);
	push_defaults(wb.CalcPr, CalcPrDef);

	push_defaults_array(wb.WBView, WBViewDef);
	push_defaults_array(wb.Sheets, SheetDef);

	_ssfopts.date1904 = parsexmlbool(wb.WBProps.date1904);
}

function safe1904(wb) {
	/* TODO: store date1904 somewhere else */
	if(!wb.Workbook) return "false";
	if(!wb.Workbook.WBProps) return "false";
	return parsexmlbool(wb.Workbook.WBProps.date1904) ? "true" : "false";
}

var badchars = ":][*?\/\\".split("");
function check_ws_name(n, safe) {
	try {
		if(n == "") throw new Error("Sheet name cannot be blank");
		if(n.length > 31) throw new Error("Sheet name cannot exceed 31 chars");
		if(n.charCodeAt(0) == 0x27 || n.charCodeAt(n.length - 1) == 0x27) throw new Error("Sheet name cannot start or end with apostrophe (')");
		if(n.toLowerCase() == "history") throw new Error("Sheet name cannot be 'History'");
		badchars.forEach(function(c) {
			if(n.indexOf(c) == -1) return;
			throw new Error("Sheet name cannot contain : \\ / ? * [ ]");
		});
	} catch(e) { if(safe) return false; throw e; }
	return true;
}
function check_wb_names(N, S, codes) {
	N.forEach(function(n,i) {
		check_ws_name(n);
		for(var j = 0; j < i; ++j) if(n == N[j]) throw new Error("Duplicate Sheet Name: " + n);
		if(codes) {
			var cn = (S && S[i] && S[i].CodeName) || n;
			if(cn.charCodeAt(0) == 95 && cn.length > 22) throw new Error("Bad Code Name: Worksheet" + cn);
		}
	});
}
function check_wb(wb) {
	if(!wb || !wb.SheetNames || !wb.Sheets) throw new Error("Invalid Workbook");
	if(!wb.SheetNames.length) throw new Error("Workbook is empty");
	var Sheets = (wb.Workbook && wb.Workbook.Sheets) || [];
	check_wb_names(wb.SheetNames, Sheets, !!wb.vbaraw);
	for(var i = 0; i < wb.SheetNames.length; ++i) check_ws(wb.Sheets[wb.SheetNames[i]], wb.SheetNames[i], i);
	wb.SheetNames.forEach(function(n, i) {
		var ws = wb.Sheets[n];
		if(!ws || !ws["!autofilter"]) return;
		var DN;
		if(!wb.Workbook) wb.Workbook = {};
		if(!wb.Workbook.Names) wb.Workbook.Names = [];
		wb.Workbook.Names.forEach(function(dn) { if(dn.Name == "_xlnm._FilterDatabase" && dn.Sheet == i) DN = dn; });
		var nn = formula_quote_sheet_name(n) + "!" + fix_range(ws["!autofilter"].ref);
		if(DN) DN.Ref = nn;
		else wb.Workbook.Names.push({Name: "_xlnm._FilterDatabase", Sheet: i, Ref: nn});
	});
	/* TODO: validate workbook */
}
/* 18.2 Workbook */
var wbnsregex = /<\w+:workbook/;
function parse_wb_xml(data, opts) {
	if(!data) throw new Error("Could not find file");
	var wb = { AppVersion:{}, WBProps:{}, WBView:[], Sheets:[], CalcPr:{}, Names:[], xmlns: "" };
	var pass = false, xmlns = "xmlns";
	var dname = {}, dnstart = 0;
	data.replace(tagregex, function xml_wb(x, idx) {
		var y = parsexmltag(x);
		switch(strip_ns(y[0])) {
			case '<?xml': break;

			/* 18.2.27 workbook CT_Workbook 1 */
			case '<workbook':
				if(x.match(wbnsregex)) xmlns = "xmlns" + x.match(/<(\w+):/)[1];
				wb.xmlns = y[xmlns];
				break;
			case '</workbook>': break;

			/* 18.2.13 fileVersion CT_FileVersion ? */
			case '<fileVersion': delete y[0]; wb.AppVersion = y; break;
			case '<fileVersion/>': case '</fileVersion>': break;

			/* 18.2.12 fileSharing CT_FileSharing ? */
			case '<fileSharing':
				break;
			case '<fileSharing/>': break;

			/* 18.2.28 workbookPr CT_WorkbookPr ? */
			case '<workbookPr':
			case '<workbookPr/>':
				WBPropsDef.forEach(function(w) {
					if(y[w[0]] == null) return;
					switch(w[2]) {
						case "bool": wb.WBProps[w[0]] = parsexmlbool(y[w[0]]); break;
						case "int": wb.WBProps[w[0]] = parseInt(y[w[0]], 10); break;
						default: wb.WBProps[w[0]] = y[w[0]];
					}
				});
				if(y.codeName) wb.WBProps.CodeName = utf8read(y.codeName);
				break;
			case '</workbookPr>': break;

			/* 18.2.29 workbookProtection CT_WorkbookProtection ? */
			case '<workbookProtection':
				break;
			case '<workbookProtection/>': break;

			/* 18.2.1  bookViews CT_BookViews ? */
			case '<bookViews': case '<bookViews>': case '</bookViews>': break;
			/* 18.2.30   workbookView CT_BookView + */
			case '<workbookView': case '<workbookView/>': delete y[0]; wb.WBView.push(y); break;
			case '</workbookView>': break;

			/* 18.2.20 sheets CT_Sheets 1 */
			case '<sheets': case '<sheets>': case '</sheets>': break; // aggregate sheet
			/* 18.2.19   sheet CT_Sheet + */
			case '<sheet':
				switch(y.state) {
					case "hidden": y.Hidden = 1; break;
					case "veryHidden": y.Hidden = 2; break;
					default: y.Hidden = 0;
				}
				delete y.state;
				y.name = unescapexml(utf8read(y.name));
				delete y[0]; wb.Sheets.push(y); break;
			case '</sheet>': break;

			/* 18.2.15 functionGroups CT_FunctionGroups ? */
			case '<functionGroups': case '<functionGroups/>': break;
			/* 18.2.14   functionGroup CT_FunctionGroup + */
			case '<functionGroup': break;

			/* 18.2.9  externalReferences CT_ExternalReferences ? */
			case '<externalReferences': case '</externalReferences>': case '<externalReferences>': break;
			/* 18.2.8    externalReference CT_ExternalReference + */
			case '<externalReference': break;

			/* 18.2.6  definedNames CT_DefinedNames ? */
			case '<definedNames/>': break;
			case '<definedNames>': case '<definedNames': pass=true; break;
			case '</definedNames>': pass=false; break;
			/* 18.2.5    definedName CT_DefinedName + */
			case '<definedName': {
				dname = {};
				dname.Name = utf8read(y.name);
				if(y.comment) dname.Comment = y.comment;
				if(y.localSheetId) dname.Sheet = +y.localSheetId;
				if(parsexmlbool(y.hidden||"0")) dname.Hidden = true;
				dnstart = idx + x.length;
			}	break;
			case '</definedName>': {
				dname.Ref = unescapexml(utf8read(data.slice(dnstart, idx)));
				wb.Names.push(dname);
			} break;
			case '<definedName/>': break;

			/* 18.2.2  calcPr CT_CalcPr ? */
			case '<calcPr': delete y[0]; wb.CalcPr = y; break;
			case '<calcPr/>': delete y[0]; wb.CalcPr = y; break;
			case '</calcPr>': break;

			/* 18.2.16 oleSize CT_OleSize ? (ref required) */
			case '<oleSize': break;

			/* 18.2.4  customWorkbookViews CT_CustomWorkbookViews ? */
			case '<customWorkbookViews>': case '</customWorkbookViews>': case '<customWorkbookViews': break;
			/* 18.2.3  customWorkbookView CT_CustomWorkbookView + */
			case '<customWorkbookView': case '</customWorkbookView>': break;

			/* 18.2.18 pivotCaches CT_PivotCaches ? */
			case '<pivotCaches>': case '</pivotCaches>': case '<pivotCaches': break;
			/* 18.2.17 pivotCache CT_PivotCache ? */
			case '<pivotCache': break;

			/* 18.2.21 smartTagPr CT_SmartTagPr ? */
			case '<smartTagPr': case '<smartTagPr/>': break;

			/* 18.2.23 smartTagTypes CT_SmartTagTypes ? */
			case '<smartTagTypes': case '<smartTagTypes>': case '</smartTagTypes>': break;
			/* 18.2.22 smartTagType CT_SmartTagType ? */
			case '<smartTagType': break;

			/* 18.2.24 webPublishing CT_WebPublishing ? */
			case '<webPublishing': case '<webPublishing/>': break;

			/* 18.2.11 fileRecoveryPr CT_FileRecoveryPr ? */
			case '<fileRecoveryPr': case '<fileRecoveryPr/>': break;

			/* 18.2.26 webPublishObjects CT_WebPublishObjects ? */
			case '<webPublishObjects>': case '<webPublishObjects': case '</webPublishObjects>': break;
			/* 18.2.25 webPublishObject CT_WebPublishObject ? */
			case '<webPublishObject': break;

			/* 18.2.10 extLst CT_ExtensionList ? */
			case '<extLst': case '<extLst>': case '</extLst>': case '<extLst/>': break;
			/* 18.2.7  ext CT_Extension + */
			case '<ext': pass=true; break; //TODO: check with versions of excel
			case '</ext>': pass=false; break;

			/* Others */
			case '<ArchID': break;
			case '<AlternateContent':
			case '<AlternateContent>': pass=true; break;
			case '</AlternateContent>': pass=false; break;

			/* TODO */
			case '<revisionPtr': break;

			default: if(!pass && opts.WTF) throw new Error('unrecognized ' + y[0] + ' in workbook');
		}
		return x;
	});
	if(XMLNS_main.indexOf(wb.xmlns) === -1) throw new Error("Unknown Namespace: " + wb.xmlns);

	parse_wb_defaults(wb);

	return wb;
}

function write_wb_xml(wb) {
	var o = [XML_HEADER];
	o[o.length] = writextag('workbook', null, {
		'xmlns': XMLNS_main[0],
		//'xmlns:mx': XMLNS.mx,
		//'xmlns:s': XMLNS_main[0],
		'xmlns:r': XMLNS.r
	});

	var write_names = (wb.Workbook && (wb.Workbook.Names||[]).length > 0);

	/* fileVersion */
	/* fileSharing */

	var workbookPr = ({codeName:"ThisWorkbook"});
	if(wb.Workbook && wb.Workbook.WBProps) {
		WBPropsDef.forEach(function(x) {
if((wb.Workbook.WBProps[x[0]]) == null) return;
			if((wb.Workbook.WBProps[x[0]]) == x[1]) return;
			workbookPr[x[0]] = (wb.Workbook.WBProps[x[0]]);
		});
if(wb.Workbook.WBProps.CodeName) { workbookPr.codeName = wb.Workbook.WBProps.CodeName; delete workbookPr.CodeName; }
	}
	o[o.length] = (writextag('workbookPr', null, workbookPr));

	/* workbookProtection */

	var sheets = wb.Workbook && wb.Workbook.Sheets || [];
	var i = 0;

	/* bookViews only written if first worksheet is hidden */
	if(sheets && sheets[0] && !!sheets[0].Hidden) {
		o[o.length] = "<bookViews>";
		for(i = 0; i != wb.SheetNames.length; ++i) {
			if(!sheets[i]) break;
			if(!sheets[i].Hidden) break;
		}
		if(i == wb.SheetNames.length) i = 0;
		o[o.length] = '<workbookView firstSheet="' + i + '" activeTab="' + i + '"/>';
		o[o.length] = "</bookViews>";
	}

	o[o.length] = "<sheets>";
	for(i = 0; i != wb.SheetNames.length; ++i) {
		var sht = ({name:escapexml(wb.SheetNames[i].slice(0,31))});
		sht.sheetId = ""+(i+1);
		sht["r:id"] = "rId"+(i+1);
		if(sheets[i]) switch(sheets[i].Hidden) {
			case 1: sht.state = "hidden"; break;
			case 2: sht.state = "veryHidden"; break;
		}
		o[o.length] = (writextag('sheet',null,sht));
	}
	o[o.length] = "</sheets>";

	/* functionGroups */
	/* externalReferences */

	if(write_names) {
		o[o.length] = "<definedNames>";
		if(wb.Workbook && wb.Workbook.Names) wb.Workbook.Names.forEach(function(n) {
			var d = {name:n.Name};
			if(n.Comment) d.comment = n.Comment;
			if(n.Sheet != null) d.localSheetId = ""+n.Sheet;
			if(n.Hidden) d.hidden = "1";
			if(!n.Ref) return;
			o[o.length] = writextag('definedName', escapexml(n.Ref), d);
		});
		o[o.length] = "</definedNames>";
	}

	/* calcPr */
	/* oleSize */
	/* customWorkbookViews */
	/* pivotCaches */
	/* smartTagPr */
	/* smartTagTypes */
	/* webPublishing */
	/* fileRecoveryPr */
	/* webPublishObjects */
	/* extLst */

	if(o.length>2){ o[o.length] = '</workbook>'; o[1]=o[1].replace("/>",">"); }
	return o.join("");
}
/* [MS-XLSB] 2.4.304 BrtBundleSh */
function parse_BrtBundleSh(data, length) {
	var z = {};
	z.Hidden = data.read_shift(4); //hsState ST_SheetState
	z.iTabID = data.read_shift(4);
	z.strRelID = parse_RelID(data,length-8);
	z.name = parse_XLWideString(data);
	return z;
}
function write_BrtBundleSh(data, o) {
	if(!o) o = new_buf(127);
	o.write_shift(4, data.Hidden);
	o.write_shift(4, data.iTabID);
	write_RelID(data.strRelID, o);
	write_XLWideString(data.name.slice(0,31), o);
	return o.length > o.l ? o.slice(0, o.l) : o;
}

/* [MS-XLSB] 2.4.815 BrtWbProp */
function parse_BrtWbProp(data, length) {
	var o = ({});
	var flags = data.read_shift(4);
	o.defaultThemeVersion = data.read_shift(4);
	var strName = (length > 8) ? parse_XLWideString(data) : "";
	if(strName.length > 0) o.CodeName = strName;
	o.autoCompressPictures = !!(flags & 0x10000);
	o.backupFile = !!(flags & 0x40);
	o.checkCompatibility = !!(flags & 0x1000);
	o.date1904 = !!(flags & 0x01);
	o.filterPrivacy = !!(flags & 0x08);
	o.hidePivotFieldList = !!(flags & 0x400);
	o.promptedSolutions = !!(flags & 0x10);
	o.publishItems = !!(flags & 0x800);
	o.refreshAllConnections = !!(flags & 0x40000);
	o.saveExternalLinkValues = !!(flags & 0x80);
	o.showBorderUnselectedTables = !!(flags & 0x04);
	o.showInkAnnotation = !!(flags & 0x20);
	o.showObjects = ["all", "placeholders", "none"][(flags >> 13) & 0x03];
	o.showPivotChartFilter = !!(flags & 0x8000);
	o.updateLinks = ["userSet", "never", "always"][(flags >> 8) & 0x03];
	return o;
}
function write_BrtWbProp(data, o) {
	if(!o) o = new_buf(72);
	var flags = 0;
	if(data) {
		/* TODO: mirror parse_BrtWbProp fields */
		if(data.date1904) flags |= 0x01;
		if(data.filterPrivacy) flags |= 0x08;
	}
	o.write_shift(4, flags);
	o.write_shift(4, 0);
	write_XLSBCodeName(data && data.CodeName || "ThisWorkbook", o);
	return o.slice(0, o.l);
}

function parse_BrtFRTArchID$(data, length) {
	var o = {};
	data.read_shift(4);
	o.ArchID = data.read_shift(4);
	data.l += length - 8;
	return o;
}

/* [MS-XLSB] 2.4.687 BrtName */
function parse_BrtName(data, length, opts) {
	var end = data.l + length;
	var flags = data.read_shift(4);
	data.l += 1; //var chKey = data.read_shift(1);
	var itab = data.read_shift(4);
	var name = parse_XLNameWideString(data);
	var formula;
	var comment = "";
	try {
		formula = parse_XLSBNameParsedFormula(data, 0, opts);
		try {
			comment = parse_XLNullableWideString(data);
		} catch(e){}
	} catch(e) { console.error("Could not parse defined name " + name); }
	if(flags & 0x20) name = "_xlnm." + name;
	//if(0 /* fProc */) {
		// unusedstring1: XLNullableWideString
		// description: XLNullableWideString
		// helpTopic: XLNullableWideString
		// unusedstring2: XLNullableWideString
	//}
	data.l = end;
	var out = ({Name:name, Ptg:formula, Flags: flags});
	if(itab < 0xFFFFFFF) out.Sheet = itab;
	if(comment) out.Comment = comment;
	return out;
}
function write_BrtName(name, wb) {
	var o = new_buf(9);
	var flags = 0;
	var dname = name.Name;
	if(XLSLblBuiltIn.indexOf(dname) > -1) { flags |= 0x20; dname = dname.slice(6); }
	o.write_shift(4, flags); // flags
	o.write_shift(1, 0); // chKey
	o.write_shift(4, name.Sheet == null ? 0xFFFFFFFF : name.Sheet);

	var arr = [
		o,
		write_XLWideString(dname),
		write_XLSBNameParsedFormula(name.Ref, wb)
	];
	if(name.Comment) arr.push(write_XLNullableWideString(name.Comment));
	else {
		var x = new_buf(4);
		x.write_shift(4, 0xFFFFFFFF);
		arr.push(x);
	}

	// if macro (flags & 0x0F):
	// write_shift(4, 0xFFFFFFFF);
	// write_XLNullableWideString(description)
	// write_XLNullableWideString(helpTopic)
	// write_shift(4, 0xFFFFFFFF);

	return bconcat(arr);
}

/* [MS-XLSB] 2.1.7.61 Workbook */
function parse_wb_bin(data, opts) {
	var wb = { AppVersion:{}, WBProps:{}, WBView:[], Sheets:[], CalcPr:{}, xmlns: "" };
	var state = [];
	var pass = false;

	if(!opts) opts = {};
	opts.biff = 12;

	var Names = [];
	var supbooks = ([[]]);
	supbooks.SheetNames = [];
	supbooks.XTI = [];

	XLSBRecordEnum[0x0010] = { n:"BrtFRTArchID$", f:parse_BrtFRTArchID$ };

	recordhopper(data, function hopper_wb(val, R, RT) {
		switch(RT) {
			case 0x009C: /* 'BrtBundleSh' */
				supbooks.SheetNames.push(val.name);
				wb.Sheets.push(val); break;

			case 0x0099: /* 'BrtWbProp' */
				wb.WBProps = val; break;

			case 0x0027: /* 'BrtName' */
				if(val.Sheet != null) opts.SID = val.Sheet;
				val.Ref = val.Ptg ? stringify_formula(val.Ptg, null, null, supbooks, opts) : "#REF!";
				delete opts.SID;
				delete val.Ptg;
				Names.push(val);
				break;
			case 0x040C: /* 'BrtNameExt' */ break;

			case 0x0165: /* 'BrtSupSelf' */
			case 0x0166: /* 'BrtSupSame' */
			case 0x0163: /* 'BrtSupBookSrc' */
			case 0x029B: /* 'BrtSupAddin' */
				if(!supbooks[0].length) supbooks[0] = [RT, val];
				else supbooks.push([RT, val]);
				supbooks[supbooks.length - 1].XTI = [];
				break;
			case 0x016A: /* 'BrtExternSheet' */
				if(supbooks.length === 0) { supbooks[0] = []; supbooks[0].XTI = []; }
				supbooks[supbooks.length - 1].XTI = supbooks[supbooks.length - 1].XTI.concat(val);
				supbooks.XTI = supbooks.XTI.concat(val);
				break;
			case 0x0169: /* 'BrtPlaceholderName' */
				break;

			case 0x0817: /* 'BrtAbsPath15' */
			case 0x009E: /* 'BrtBookView' */
			case 0x008F: /* 'BrtBeginBundleShs' */
			case 0x0298: /* 'BrtBeginFnGroup' */
			case 0x0161: /* 'BrtBeginExternals' */
				break;

			/* case 'BrtModelTimeGroupingCalcCol' */
			case 0x0C00: /* 'BrtUid' */
			case 0x0C01: /* 'BrtRevisionPtr' */
			case 0x0216: /* 'BrtBookProtection' */
			case 0x02A5: /* 'BrtBookProtectionIso' */
			case 0x009D: /* 'BrtCalcProp' */
			case 0x0262: /* 'BrtCrashRecErr' */
			case 0x0802: /* 'BrtDecoupledPivotCacheID' */
			case 0x009B: /* 'BrtFileRecover' */
			case 0x0224: /* 'BrtFileSharing' */
			case 0x02A4: /* 'BrtFileSharingIso' */
			case 0x0080: /* 'BrtFileVersion' */
			case 0x0299: /* 'BrtFnGroup' */
			case 0x0850: /* 'BrtModelRelationship' */
			case 0x084D: /* 'BrtModelTable' */
			case 0x0225: /* 'BrtOleSize' */
			case 0x0805: /* 'BrtPivotTableRef' */
			case 0x0254: /* 'BrtSmartTagType' */
			case 0x081C: /* 'BrtTableSlicerCacheID' */
			case 0x081B: /* 'BrtTableSlicerCacheIDs' */
			case 0x0822: /* 'BrtTimelineCachePivotCacheID' */
			case 0x018D: /* 'BrtUserBookView' */
			case 0x009A: /* 'BrtWbFactoid' */
			case 0x045D: /* 'BrtWbProp14' */
			case 0x0229: /* 'BrtWebOpt' */
			case 0x082B: /* 'BrtWorkBookPr15' */
				break;

			case 0x0023: /* 'BrtFRTBegin' */
				state.push(RT); pass = true; break;
			case 0x0024: /* 'BrtFRTEnd' */
				state.pop(); pass = false; break;
			case 0x0025: /* 'BrtACBegin' */
				state.push(RT); pass = true; break;
			case 0x0026: /* 'BrtACEnd' */
				state.pop(); pass = false; break;

			case 0x0010: /* 'BrtFRTArchID$' */ break;

			default:
				if(R.T){/* empty */}
				else if(!pass || (opts.WTF && state[state.length-1] != 0x0025 /* BrtACBegin */ && state[state.length-1] != 0x0023 /* BrtFRTBegin */)) throw new Error("Unexpected record 0x" + RT.toString(16));
		}
	}, opts);

	parse_wb_defaults(wb);

	// $FlowIgnore
	wb.Names = Names;

	(wb).supbooks = supbooks;
	return wb;
}

function write_BUNDLESHS(ba, wb) {
	write_record(ba, 0x008F /* BrtBeginBundleShs */);
	for(var idx = 0; idx != wb.SheetNames.length; ++idx) {
		var viz = wb.Workbook && wb.Workbook.Sheets && wb.Workbook.Sheets[idx] && wb.Workbook.Sheets[idx].Hidden || 0;
		var d = { Hidden: viz, iTabID: idx+1, strRelID: 'rId' + (idx+1), name: wb.SheetNames[idx] };
		write_record(ba, 0x009C /* BrtBundleSh */, write_BrtBundleSh(d));
	}
	write_record(ba, 0x0090 /* BrtEndBundleShs */);
}

/* [MS-XLSB] 2.4.649 BrtFileVersion */
function write_BrtFileVersion(data, o) {
	if(!o) o = new_buf(127);
	for(var i = 0; i != 4; ++i) o.write_shift(4, 0);
	write_XLWideString("SheetJS", o);
	write_XLWideString(XLSX.version, o);
	write_XLWideString(XLSX.version, o);
	write_XLWideString("7262", o);
	return o.length > o.l ? o.slice(0, o.l) : o;
}

/* [MS-XLSB] 2.4.301 BrtBookView */
function write_BrtBookView(idx, o) {
	if(!o) o = new_buf(29);
	o.write_shift(-4, 0);
	o.write_shift(-4, 460);
	o.write_shift(4,  28800);
	o.write_shift(4,  17600);
	o.write_shift(4,  500);
	o.write_shift(4,  idx);
	o.write_shift(4,  idx);
	var flags = 0x78;
	o.write_shift(1,  flags);
	return o.length > o.l ? o.slice(0, o.l) : o;
}

function write_BOOKVIEWS(ba, wb) {
	/* required if hidden tab appears before visible tab */
	if(!wb.Workbook || !wb.Workbook.Sheets) return;
	var sheets = wb.Workbook.Sheets;
	var i = 0, vistab = -1, hidden = -1;
	for(; i < sheets.length; ++i) {
		if(!sheets[i] || !sheets[i].Hidden && vistab == -1) vistab = i;
		else if(sheets[i].Hidden == 1 && hidden == -1) hidden = i;
	}
	if(hidden > vistab) return;
	write_record(ba, 0x0087 /* BrtBeginBookViews */);
	write_record(ba, 0x009E /* BrtBookView */, write_BrtBookView(vistab));
	/* 1*(BrtBookView *FRT) */
	write_record(ba, 0x0088 /* BrtEndBookViews */);
}

function write_BRTNAMES(ba, wb) {
	if(!wb.Workbook || !wb.Workbook.Names) return;
	wb.Workbook.Names.forEach(function(name) { try {
		if(name.Flags & 0x0e) return; // TODO: macro name write
		write_record(ba, 0x0027 /* BrtName */, write_BrtName(name, wb));
	} catch(e) {
		console.error("Could not serialize defined name " + JSON.stringify(name));
	} });
}

function write_SELF_EXTERNS_xlsb(wb) {
	var L = wb.SheetNames.length;
	var o = new_buf(12 * L + 28);
	o.write_shift(4, L + 2);
	o.write_shift(4, 0); o.write_shift(4, -2); o.write_shift(4, -2); // workbook-level reference
	o.write_shift(4, 0); o.write_shift(4, -1); o.write_shift(4, -1); // #REF!...
	for(var i = 0; i < L; ++i) {
		o.write_shift(4, 0); o.write_shift(4, i); o.write_shift(4, i);
	}
	return o;
}
function write_EXTERNALS_xlsb(ba, wb) {
	write_record(ba, 0x0161 /* BrtBeginExternals */);
	write_record(ba, 0x0165 /* BrtSupSelf */);
	write_record(ba, 0x016A /* BrtExternSheet */, write_SELF_EXTERNS_xlsb(wb, 0));
	write_record(ba, 0x0162 /* BrtEndExternals */);
}

/* [MS-XLSB] 2.4.305 BrtCalcProp */
/*function write_BrtCalcProp(data, o) {
	if(!o) o = new_buf(26);
	o.write_shift(4,0); // force recalc
	o.write_shift(4,1);
	o.write_shift(4,0);
	write_Xnum(0, o);
	o.write_shift(-4, 1023);
	o.write_shift(1, 0x33);
	o.write_shift(1, 0x00);
	return o;
}*/

/* [MS-XLSB] 2.4.646 BrtFileRecover */
/*function write_BrtFileRecover(data, o) {
	if(!o) o = new_buf(1);
	o.write_shift(1,0);
	return o;
}*/

/* [MS-XLSB] 2.1.7.61 Workbook */
function write_wb_bin(wb, opts) {
	var ba = buf_array();
	write_record(ba, 0x0083 /* BrtBeginBook */);
	write_record(ba, 0x0080 /* BrtFileVersion */, write_BrtFileVersion());
	/* [[BrtFileSharingIso] BrtFileSharing] */
	write_record(ba, 0x0099 /* BrtWbProp */, write_BrtWbProp(wb.Workbook && wb.Workbook.WBProps || null));
	/* [ACABSPATH] */
	/* [[BrtBookProtectionIso] BrtBookProtection] */
	write_BOOKVIEWS(ba, wb, opts);
	write_BUNDLESHS(ba, wb, opts);
	/* [FNGROUP] */
	write_EXTERNALS_xlsb(ba, wb);
	if((wb.Workbook||{}).Names) write_BRTNAMES(ba, wb);
	/* write_record(ba, 0x009D BrtCalcProp, write_BrtCalcProp()); */
	/* [BrtOleSize] */
	/* *(BrtUserBookView *FRT) */
	/* [PIVOTCACHEIDS] */
	/* [BrtWbFactoid] */
	/* [SMARTTAGTYPES] */
	/* [BrtWebOpt] */
	/* write_record(ba, 0x009B BrtFileRecover, write_BrtFileRecover()); */
	/* [WEBPUBITEMS] */
	/* [CRERRS] */
	/* FRTWORKBOOK */
	write_record(ba, 0x0084 /* BrtEndBook */);

	return ba.end();
}
function parse_wb(data, name, opts) {
	if(name.slice(-4)===".bin") return parse_wb_bin((data), opts);
	return parse_wb_xml((data), opts);
}

function parse_ws(data, name, idx, opts, rels, wb, themes, styles) {
	if(name.slice(-4)===".bin") return parse_ws_bin((data), opts, idx, rels, wb, themes, styles);
	return parse_ws_xml((data), opts, idx, rels, wb, themes, styles);
}

function parse_cs(data, name, idx, opts, rels, wb, themes, styles) {
	if(name.slice(-4)===".bin") return parse_cs_bin((data), opts, idx, rels, wb, themes, styles);
	return parse_cs_xml((data), opts, idx, rels, wb, themes, styles);
}

function parse_ms(data, name, idx, opts, rels, wb, themes, styles) {
	if(name.slice(-4)===".bin") return parse_ms_bin((data), opts, idx, rels, wb, themes, styles);
	return parse_ms_xml((data), opts, idx, rels, wb, themes, styles);
}

function parse_ds(data, name, idx, opts, rels, wb, themes, styles) {
	if(name.slice(-4)===".bin") return parse_ds_bin((data), opts, idx, rels, wb, themes, styles);
	return parse_ds_xml((data), opts, idx, rels, wb, themes, styles);
}

function parse_sty(data, name, themes, opts) {
	if(name.slice(-4)===".bin") return parse_sty_bin((data), themes, opts);
	return parse_sty_xml((data), themes, opts);
}

function parse_sst(data, name, opts) {
	if(name.slice(-4)===".bin") return parse_sst_bin((data), opts);
	return parse_sst_xml((data), opts);
}

function parse_cmnt(data, name, opts) {
	if(name.slice(-4)===".bin") return parse_comments_bin((data), opts);
	return parse_comments_xml((data), opts);
}

function parse_cc(data, name, opts) {
	if(name.slice(-4)===".bin") return parse_cc_bin((data), name, opts);
	return parse_cc_xml((data), name, opts);
}

function parse_xlink(data, rel, name, opts) {
	if(name.slice(-4)===".bin") return parse_xlink_bin((data), rel, name, opts);
	return parse_xlink_xml((data), rel, name, opts);
}

function parse_xlmeta(data, name, opts) {
	if(name.slice(-4)===".bin") return parse_xlmeta_bin((data), name, opts);
	return parse_xlmeta_xml((data), name, opts);
}
var attregexg2=/\b((?:\w+:)?[\w]+)=((?:")([^"]*)(?:")|(?:')([^']*)(?:'))/g;
var attregex2=/\b((?:\w+:)?[\w]+)=((?:")(?:[^"]*)(?:")|(?:')(?:[^']*)(?:'))/;
function xlml_parsexmltag(tag, skip_root) {
	var words = tag.split(/\s+/);
	var z = ([]); if(!skip_root) z[0] = words[0];
	if(words.length === 1) return z;
	var m = tag.match(attregexg2), y, j, w, i;
	if(m) for(i = 0; i != m.length; ++i) {
		y = m[i].match(attregex2);
if((j=y[1].indexOf(":")) === -1) z[y[1]] = y[2].slice(1,y[2].length-1);
		else {
			if(y[1].slice(0,6) === "xmlns:") w = "xmlns"+y[1].slice(6);
			else w = y[1].slice(j+1);
			z[w] = y[2].slice(1,y[2].length-1);
		}
	}
	return z;
}
function xlml_parsexmltagobj(tag) {
	var words = tag.split(/\s+/);
	var z = {};
	if(words.length === 1) return z;
	var m = tag.match(attregexg2), y, j, w, i;
	if(m) for(i = 0; i != m.length; ++i) {
		y = m[i].match(attregex2);
if((j=y[1].indexOf(":")) === -1) z[y[1]] = y[2].slice(1,y[2].length-1);
		else {
			if(y[1].slice(0,6) === "xmlns:") w = "xmlns"+y[1].slice(6);
			else w = y[1].slice(j+1);
			z[w] = y[2].slice(1,y[2].length-1);
		}
	}
	return z;
}

// ----

/* map from xlml named formats to SSF TODO: localize */
var XLMLFormatMap;

function xlml_format(format, value, date1904) {
	var fmt = XLMLFormatMap[format] || unescapexml(format);
	if(fmt === "General") return SSF_general(value);
	return SSF_format(fmt, value, {date1904: !!date1904});
}

function xlml_set_custprop(Custprops, key, cp, val) {
	var oval = val;
	switch((cp[0].match(/dt:dt="([\w.]+)"/)||["",""])[1]) {
		case "boolean": oval = parsexmlbool(val); break;
		case "i2": case "int": oval = parseInt(val, 10); break;
		case "r4": case "float": oval = parseFloat(val); break;
		case "date": case "dateTime.tz": oval = parseDate(val); break;
		case "i8": case "string": case "fixed": case "uuid": case "bin.base64": break;
		default: throw new Error("bad custprop:" + cp[0]);
	}
	Custprops[unescapexml(key)] = oval;
}

function safe_format_xlml(cell, nf, o, date1904) {
	if(cell.t === 'z') return;
	if(!o || o.cellText !== false) try {
		if(cell.t === 'e') { cell.w = cell.w || BErr[cell.v]; }
		else if(nf === "General") {
			if(cell.t === 'n') {
				if((cell.v|0) === cell.v) cell.w = cell.v.toString(10);
				else cell.w = SSF_general_num(cell.v);
			}
			else cell.w = SSF_general(cell.v);
		}
		else cell.w = xlml_format(nf||"General", cell.v, date1904);
	} catch(e) { if(o.WTF) throw e; }
	try {
		var z = XLMLFormatMap[nf]||nf||"General";
		if(o.cellNF) cell.z = z;
		if(o.cellDates && cell.t == 'n' && fmt_is_date(z)) {
			var _d = SSF_parse_date_code(cell.v + (date1904 ? 1462 : 0)); if(_d) { cell.t = 'd'; cell.v = new Date(Date.UTC(_d.y, _d.m-1,_d.d,_d.H,_d.M,_d.S,_d.u)); }
		}
	} catch(e) { if(o.WTF) throw e; }
}

function process_style_xlml(styles, stag, opts) {
	if(opts.cellStyles) {
		if(stag.Interior) {
			var I = stag.Interior;
			if(I.Pattern) I.patternType = XLMLPatternTypeMap[I.Pattern] || I.Pattern;
		}
	}
	styles[stag.ID] = stag;
}

/* TODO: there must exist some form of OSP-blessed spec */
function parse_xlml_data(xml, ss, data, cell, base, styles, csty, row, arrayf, o, date1904) {
	var nf = "General", sid = cell.StyleID, S = {}; o = o || {};
	var interiors = [];
	var i = 0;
	if(sid === undefined && row) sid = row.StyleID;
	if(sid === undefined && csty) sid = csty.StyleID;
	while(styles[sid] !== undefined) {
		var ssid = styles[sid];
		if(ssid.nf) nf = ssid.nf;
		if(ssid.Interior) interiors.push(ssid.Interior);
		if(!ssid.Parent) break;
		sid = ssid.Parent;
	}
	switch(data.Type) {
		case 'Boolean':
			cell.t = 'b';
			cell.v = parsexmlbool(xml);
			break;
		case 'String':
			cell.t = 's'; cell.r = xlml_fixstr(unescapexml(xml));
			cell.v = (xml.indexOf("<") > -1 ? unescapexml(ss||xml).replace(/<[^<>]*>/g, "") : cell.r); // todo: BR etc
			break;
		case 'DateTime':
			if(xml.slice(-1) != "Z") xml += "Z";
			cell.v = datenum(parseDate(xml, date1904), date1904);
			if(cell.v !== cell.v) cell.v = unescapexml(xml);
			if(!nf || nf == "General") nf = "yyyy-mm-dd";
			/* falls through */
		case 'Number':
			if(cell.v === undefined) cell.v=+xml;
			if(!cell.t) cell.t = 'n';
			break;
		case 'Error': cell.t = 'e'; cell.v = RBErr[xml]; if(o.cellText !== false) cell.w = xml; break;
		default:
			if(xml == "" && ss == "") { cell.t = 'z'; }
			else { cell.t = 's'; cell.v = xlml_fixstr(ss||xml); }
			break;
	}
	safe_format_xlml(cell, nf, o, date1904);
	if(o.cellFormula !== false) {
		if(cell.Formula) {
			var fstr = unescapexml(cell.Formula);
			/* strictly speaking, the leading = is required but some writers omit */
			if(fstr.charCodeAt(0) == 61 /* = */) fstr = fstr.slice(1);
			cell.f = rc_to_a1(fstr, base);
			delete cell.Formula;
			if(cell.ArrayRange == "RC") cell.F = rc_to_a1("RC:RC", base);
			else if(cell.ArrayRange) {
				cell.F = rc_to_a1(cell.ArrayRange, base);
				arrayf.push([safe_decode_range(cell.F), cell.F]);
			}
		} else {
			for(i = 0; i < arrayf.length; ++i)
				if(base.r >= arrayf[i][0].s.r && base.r <= arrayf[i][0].e.r)
					if(base.c >= arrayf[i][0].s.c && base.c <= arrayf[i][0].e.c)
						cell.F = arrayf[i][1];
		}
	}
	if(o.cellStyles) {
		interiors.forEach(function(x) {
			if(!S.patternType && x.patternType) S.patternType = x.patternType;
		});
		cell.s = S;
	}
	if(cell.StyleID !== undefined) cell.ixfe = cell.StyleID;
}

function xlml_prefix_dname(dname) {
	return XLSLblBuiltIn.indexOf("_xlnm." + dname) > -1 ? "_xlnm." + dname : dname;
}

function xlml_clean_comment(comment) {
	comment.t = comment.v || "";
	comment.t = comment.t.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
	comment.v = comment.w = comment.ixfe = undefined;
}

/* TODO: Everything */
function parse_xlml_xml(d, _opts) {
	var opts = _opts || {};
	make_ssf();
	var str = debom(xlml_normalize(d));
	if(opts.type == 'binary' || opts.type == 'array' || opts.type == 'base64') {
		if(typeof $cptable !== 'undefined') str = $cptable.utils.decode(65001, char_codes(str));
		else str = utf8read(str);
	}
	var opening = str.slice(0, 1024).toLowerCase(), ishtml = false;
	opening = opening.replace(/".*?"/g, "");
	if((opening.indexOf(">") & 1023) > Math.min((opening.indexOf(",") & 1023), (opening.indexOf(";")&1023))) { var _o = dup(opts); _o.type = "string"; return PRN.to_workbook(str, _o); }
	if(opening.indexOf("<?xml") == -1) ["html", "table", "head", "meta", "script", "style", "div"].forEach(function(tag) { if(opening.indexOf("<" + tag) >= 0) ishtml = true; });
	if(ishtml) return html_to_workbook(str, opts);

	XLMLFormatMap = ({
		"General Number": "General",
		"General Date": table_fmt[22],
		"Long Date": "dddd, mmmm dd, yyyy",
		"Medium Date": table_fmt[15],
		"Short Date": table_fmt[14],
		"Long Time": table_fmt[19],
		"Medium Time": table_fmt[18],
		"Short Time": table_fmt[20],
		"Currency": '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
		"Fixed": table_fmt[2],
		"Standard": table_fmt[4],
		"Percent": table_fmt[10],
		"Scientific": table_fmt[11],
		"Yes/No": '"Yes";"Yes";"No";@',
		"True/False": '"True";"True";"False";@',
		"On/Off": '"Yes";"Yes";"No";@'
	});


	var Rn;
	var state = [], tmp;
	if(DENSE != null && opts.dense == null) opts.dense = DENSE;
	var sheets = {}, sheetnames = [], cursheet = ({}), sheetname = ""; if(opts.dense) cursheet["!data"] = [];
	var cell = ({}), row = {};// eslint-disable-line no-unused-vars
	var dtag = xlml_parsexmltag('<Data ss:Type="String">'), didx = 0;
	var c = 0, r = 0;
	var refguess = {s: {r:2000000, c:2000000}, e: {r:0, c:0} };
	var styles = {}, stag = {};
	var ss = "", fidx = 0;
	var merges = [];
	var Props = {}, Custprops = {}, pidx = 0, cp = [];
	var comments = [], comment = ({});
	var cstys = [], csty, seencol = false;
	var arrayf = [];
	var rowinfo = [], rowobj = {}, cc = 0, rr = 0;
	var Workbook = ({ Sheets:[], WBProps:{date1904:false} }), wsprops = {};
	xlmlregex.lastIndex = 0;
	str = str_remove_ng(str, "<!--", "-->");
	var raw_Rn3 = "";
	while((Rn = xlmlregex.exec(str))) switch((Rn[3] = (raw_Rn3 = Rn[3]).toLowerCase())) {
		case 'data' /*case 'Data'*/:
			if(raw_Rn3 == "data") {
				if(Rn[1]==='/'){if((tmp=state.pop())[0]!==Rn[3]) throw new Error("Bad state: "+tmp.join("|"));}
				else if(Rn[0].charAt(Rn[0].length-2) !== '/') state.push([Rn[3], true]);
				break;
			}
			if(state[state.length-1][1]) break;
			if(Rn[1]==='/') parse_xlml_data(str.slice(didx, Rn.index), ss, dtag, state[state.length-1][0]==/*"Comment"*/"comment"?comment:cell, {c:c,r:r}, styles, cstys[c], row, arrayf, opts, Workbook.WBProps.date1904);
			else { ss = ""; dtag = xlml_parsexmltag(Rn[0]); didx = Rn.index + Rn[0].length; }
			break;
		case 'cell' /*case 'Cell'*/:
			if(Rn[1]==='/'){
				if(comments.length > 0) cell.c = comments;
				if((!opts.sheetRows || opts.sheetRows > r) && cell.v !== void 0) {
					if(opts.dense) {
						if(!cursheet["!data"][r]) cursheet["!data"][r] = [];
						cursheet["!data"][r][c] = cell;
					} else cursheet[encode_col(c) + encode_row(r)] = cell;
				}
				if(cell.HRef) {
					cell.l = ({Target:unescapexml(cell.HRef)});
					if(cell.HRefScreenTip) cell.l.Tooltip = cell.HRefScreenTip;
					delete cell.HRef; delete cell.HRefScreenTip;
				}
				if(cell.MergeAcross || cell.MergeDown) {
					cc = c + (parseInt(cell.MergeAcross,10)|0);
					rr = r + (parseInt(cell.MergeDown,10)|0);
					if(cc > c || rr > r) merges.push({s:{c:c,r:r},e:{c:cc,r:rr}});
				}
				if(!opts.sheetStubs) { if(cell.MergeAcross) c = cc + 1; else ++c; }
				else if(cell.MergeAcross || cell.MergeDown) {
for(var cma = c; cma <= cc; ++cma) {
						for(var cmd = r; cmd <= rr; ++cmd) {
							if(cma > c || cmd > r) {
								if(opts.dense) {
									if(!cursheet["!data"][cmd]) cursheet["!data"][cmd] = [];
									cursheet["!data"][cmd][cma] = {t:'z'};
								} else cursheet[encode_col(cma) + encode_row(cmd)] = {t:'z'};
							}
						}
					}
					c = cc + 1;
				}
				else ++c;
			} else {
				cell = xlml_parsexmltagobj(Rn[0]);
				if(cell.Index) c = +cell.Index - 1;
				if(c < refguess.s.c) refguess.s.c = c;
				if(c > refguess.e.c) refguess.e.c = c;
				if(Rn[0].slice(-2) === "/>") ++c;
				comments = [];
			}
			break;
		case 'row' /*case 'Row'*/:
			if(Rn[1]==='/' || Rn[0].slice(-2) === "/>") {
				if(r < refguess.s.r) refguess.s.r = r;
				if(r > refguess.e.r) refguess.e.r = r;
				if(Rn[0].slice(-2) === "/>") {
					row = xlml_parsexmltag(Rn[0]);
					if(row.Index) r = +row.Index - 1;
				}
				c = 0; ++r;
			} else {
				row = xlml_parsexmltag(Rn[0]);
				if(row.Index) r = +row.Index - 1;
				rowobj = {};
				if(row.AutoFitHeight == "0" || row.Height) {
					rowobj.hpx = parseInt(row.Height, 10); rowobj.hpt = px2pt(rowobj.hpx);
					rowinfo[r] = rowobj;
				}
				if(row.Hidden == "1") { rowobj.hidden = true; rowinfo[r] = rowobj; }
			}
			break;
		case 'worksheet' /*case 'Worksheet'*/: /* TODO: read range from FullRows/FullColumns */
			if(Rn[1]==='/'){
				if((tmp=state.pop())[0]!==Rn[3]) throw new Error("Bad state: "+tmp.join("|"));
				sheetnames.push(sheetname);
				if(refguess.s.r <= refguess.e.r && refguess.s.c <= refguess.e.c) {
					cursheet["!ref"] = encode_range(refguess);
					if(opts.sheetRows && opts.sheetRows <= refguess.e.r) {
						cursheet["!fullref"] = cursheet["!ref"];
						refguess.e.r = opts.sheetRows - 1;
						cursheet["!ref"] = encode_range(refguess);
					}
				}
				if(merges.length) cursheet["!merges"] = merges;
				if(cstys.length > 0) cursheet["!cols"] = cstys;
				if(rowinfo.length > 0) cursheet["!rows"] = rowinfo;
				sheets[sheetname] = cursheet;
			} else {
				refguess = {s: {r:2000000, c:2000000}, e: {r:0, c:0} };
				r = c = 0;
				state.push([Rn[3], false]);
				tmp = xlml_parsexmltag(Rn[0]);
				sheetname = unescapexml(tmp.Name);
				cursheet = ({}); if(opts.dense) cursheet["!data"] = [];
				merges = [];
				arrayf = [];
				rowinfo = [];
				wsprops = {name:sheetname, Hidden:0};
				Workbook.Sheets.push(wsprops);
			}
			break;
		case 'table' /*case 'Table'*/:
			if(Rn[1]==='/'){if((tmp=state.pop())[0]!==Rn[3]) throw new Error("Bad state: "+tmp.join("|"));}
			else if(Rn[0].slice(-2) == "/>") break;
			else {
				state.push([Rn[3], false]);
				cstys = []; seencol = false;
			}
			break;

		case 'style' /*case 'Style'*/:
			if(Rn[1]==='/') process_style_xlml(styles, stag, opts);
			else stag = xlml_parsexmltag(Rn[0]);
			break;

		case 'numberformat' /*case 'NumberFormat'*/:
			stag.nf = unescapexml(xlml_parsexmltag(Rn[0]).Format || "General");
			if(XLMLFormatMap[stag.nf]) stag.nf = XLMLFormatMap[stag.nf];
			for(var ssfidx = 0; ssfidx != 0x188; ++ssfidx) if(table_fmt[ssfidx] == stag.nf) break;
			if(ssfidx == 0x188) for(ssfidx = 0x39; ssfidx != 0x188; ++ssfidx) if(table_fmt[ssfidx] == null) { SSF__load(stag.nf, ssfidx); break; }
			break;

		case 'column' /*case 'Column'*/:
			if(state[state.length-1][0] !== /*'Table'*/'table') break;
			if(Rn[1]==='/') break;
			csty = xlml_parsexmltag(Rn[0]);
			if(csty.Hidden) { csty.hidden = true; delete csty.Hidden; }
			if(csty.Width) csty.wpx = parseInt(csty.Width, 10);
			if(!seencol && csty.wpx > 10) {
				seencol = true; MDW = DEF_MDW; //find_mdw_wpx(csty.wpx);
				for(var _col = 0; _col < cstys.length; ++_col) if(cstys[_col]) process_col(cstys[_col]);
			}
			if(seencol) process_col(csty);
			cstys[(csty.Index-1||cstys.length)] = csty;
			for(var i = 0; i < +csty.Span; ++i) cstys[cstys.length] = dup(csty);
			break;

		case 'namedrange' /*case 'NamedRange'*/:
			if(Rn[1]==='/') break;
			if(!Workbook.Names) Workbook.Names = [];
			var _NamedRange = parsexmltag(Rn[0]);
			var _DefinedName = ({
				Name: xlml_prefix_dname(_NamedRange.Name),
				Ref: rc_to_a1(_NamedRange.RefersTo.slice(1), {r:0, c:0})
			});
			if(Workbook.Sheets.length>0) _DefinedName.Sheet=Workbook.Sheets.length-1;
Workbook.Names.push(_DefinedName);
			break;

		case 'namedcell' /*case 'NamedCell'*/: break;
		case 'b' /*case 'B'*/: break;
		case 'i' /*case 'I'*/: break;
		case 'u' /*case 'U'*/: break;
		case 's' /*case 'S'*/: break;
		case 'em' /*case 'EM'*/: break;
		case 'h2' /*case 'H2'*/: break;
		case 'h3' /*case 'H3'*/: break;
		case 'sub' /*case 'Sub'*/: break;
		case 'sup' /*case 'Sup'*/: break;
		case 'span' /*case 'Span'*/: break;
		case 'alignment' /*case 'Alignment'*/:
			break;
		case 'borders' /*case 'Borders'*/: break;
		case 'border' /*case 'Border'*/: break;
		case 'font' /*case 'Font'*/:
			if(Rn[0].slice(-2) === "/>") break;
			else if(Rn[1]==="/") ss += str.slice(fidx, Rn.index);
			else fidx = Rn.index + Rn[0].length;
			break;
		case 'interior' /*case 'Interior'*/:
			if(!opts.cellStyles) break;
			stag.Interior = xlml_parsexmltag(Rn[0]);
			break;
		case 'protection' /*case 'Protection'*/: break;

		case 'author' /*case 'Author'*/:
		case 'title' /*case 'Title'*/:
		case 'description' /*case 'Description'*/:
		case 'created' /*case 'Created'*/:
		case 'keywords' /*case 'Keywords'*/:
		case 'subject' /*case 'Subject'*/:
		case 'category' /*case 'Category'*/:
		case 'company' /*case 'Company'*/:
		case 'lastauthor' /*case 'LastAuthor'*/:
		case 'lastsaved' /*case 'LastSaved'*/:
		case 'lastprinted' /*case 'LastPrinted'*/:
		case 'version' /*case 'Version'*/:
		case 'revision' /*case 'Revision'*/:
		case 'totaltime' /*case 'TotalTime'*/:
		case 'hyperlinkbase' /*case 'HyperlinkBase'*/:
		case 'manager' /*case 'Manager'*/:
		case 'contentstatus' /*case 'ContentStatus'*/:
		case 'identifier' /*case 'Identifier'*/:
		case 'language' /*case 'Language'*/:
		case 'appname' /*case 'AppName'*/:
			if(Rn[0].slice(-2) === "/>") break;
			else if(Rn[1]==="/") xlml_set_prop(Props, raw_Rn3, str.slice(pidx, Rn.index));
			else pidx = Rn.index + Rn[0].length;
			break;
		case 'paragraphs' /*case 'Paragraphs'*/: break;

		case 'styles' /*case 'Styles'*/:
		case 'workbook' /*case 'Workbook'*/:
			if(Rn[1]==='/'){if((tmp=state.pop())[0]!==Rn[3]) throw new Error("Bad state: "+tmp.join("|"));}
			else state.push([Rn[3], false]);
			break;

		case 'comment' /*case 'Comment'*/:
			if(Rn[1]==='/'){
				if((tmp=state.pop())[0]!==Rn[3]) throw new Error("Bad state: "+tmp.join("|"));
				xlml_clean_comment(comment);
				comments.push(comment);
			} else {
				state.push([Rn[3], false]);
				tmp = xlml_parsexmltag(Rn[0]);
				if(!parsexmlbool(tmp["ShowAlways"]||"0")) comments.hidden = true;
				comment = ({a:tmp.Author});
			}
			break;

		case 'autofilter' /*case 'AutoFilter'*/:
			if(Rn[1]==='/'){if((tmp=state.pop())[0]!==Rn[3]) throw new Error("Bad state: "+tmp.join("|"));}
			else if(Rn[0].charAt(Rn[0].length-2) !== '/') {
				var AutoFilter = xlml_parsexmltag(Rn[0]);
				cursheet['!autofilter'] = { ref:rc_to_a1(AutoFilter.Range).replace(/\$/g,"") };
				state.push([Rn[3], true]);
			}
			break;

		case 'name' /*case 'Name'*/: break;

		case 'datavalidation' /*case 'DataValidation'*/:
			if(Rn[1]==='/'){
				if((tmp=state.pop())[0]!==Rn[3]) throw new Error("Bad state: "+tmp.join("|"));
			} else {
				if(Rn[0].charAt(Rn[0].length-2) !== '/') state.push([Rn[3], true]);
			}
			break;

		case 'pixelsperinch' /*case 'PixelsPerInch'*/:
			break;
		case 'componentoptions' /*case 'ComponentOptions'*/:
		case 'documentproperties' /*case 'DocumentProperties'*/:
		case 'customdocumentproperties' /*case 'CustomDocumentProperties'*/:
		case 'officedocumentsettings' /*case 'OfficeDocumentSettings'*/:
		case 'pivottable' /*case 'PivotTable'*/:
		case 'pivotcache' /*case 'PivotCache'*/:
		case 'names' /*case 'Names'*/:
		case 'mapinfo' /*case 'MapInfo'*/:
		case 'pagebreaks' /*case 'PageBreaks'*/:
		case 'querytable' /*case 'QueryTable'*/:
		case 'sorting' /*case 'Sorting'*/:
		case 'schema' /*case 'Schema'*/: //case 'data' /*case 'data'*/:
		case 'conditionalformatting' /*case 'ConditionalFormatting'*/:
		case 'smarttagtype' /*case 'SmartTagType'*/:
		case 'smarttags' /*case 'SmartTags'*/:
		case 'excelworkbook' /*case 'ExcelWorkbook'*/:
		case 'workbookoptions' /*case 'WorkbookOptions'*/:
		case 'worksheetoptions' /*case 'WorksheetOptions'*/:
			if(Rn[1]==='/'){if((tmp=state.pop())[0]!==Rn[3]) throw new Error("Bad state: "+tmp.join("|"));}
			else if(Rn[0].charAt(Rn[0].length-2) !== '/') state.push([Rn[3], true]);
			break;

		case 'null' /*case 'Null'*/: break;

		default:
			/* FODS file root is <office:document> */
			if(state.length == 0 && Rn[3] == "document") return parse_fods(str, opts);
			/* UOS file root is <uof:UOF> */
			if(state.length == 0 && Rn[3] == "uof"/*"UOF"*/) return parse_fods(str, opts);

			var seen = true;
			switch(state[state.length-1][0]) {
				/* OfficeDocumentSettings */
				case 'officedocumentsettings' /*case 'OfficeDocumentSettings'*/: switch(Rn[3]) {
					case 'allowpng' /*case 'AllowPNG'*/: break;
					case 'removepersonalinformation' /*case 'RemovePersonalInformation'*/: break;
					case 'downloadcomponents' /*case 'DownloadComponents'*/: break;
					case 'locationofcomponents' /*case 'LocationOfComponents'*/: break;
					case 'colors' /*case 'Colors'*/: break;
					case 'color' /*case 'Color'*/: break;
					case 'index' /*case 'Index'*/: break;
					case 'rgb' /*case 'RGB'*/: break;
					case 'targetscreensize' /*case 'TargetScreenSize'*/: break;
					case 'readonlyrecommended' /*case 'ReadOnlyRecommended'*/: break;
					default: seen = false;
				} break;

				/* ComponentOptions */
				case 'componentoptions' /*case 'ComponentOptions'*/: switch(Rn[3]) {
					case 'toolbar' /*case 'Toolbar'*/: break;
					case 'hideofficelogo' /*case 'HideOfficeLogo'*/: break;
					case 'spreadsheetautofit' /*case 'SpreadsheetAutoFit'*/: break;
					case 'label' /*case 'Label'*/: break;
					case 'caption' /*case 'Caption'*/: break;
					case 'maxheight' /*case 'MaxHeight'*/: break;
					case 'maxwidth' /*case 'MaxWidth'*/: break;
					case 'nextsheetnumber' /*case 'NextSheetNumber'*/: break;
					default: seen = false;
				} break;

				/* ExcelWorkbook */
				case 'excelworkbook' /*case 'ExcelWorkbook'*/: switch(Rn[3]) {
					case 'date1904' /*case 'Date1904'*/:
Workbook.WBProps.date1904 = true;
						break;
					case 'hidehorizontalscrollbar' /*case 'HideHorizontalScrollBar'*/: break;
					case 'hideverticalscrollbar' /*case 'HideVerticalScrollBar'*/: break;
					case 'hideworkbooktabs' /*case 'HideWorkbookTabs'*/: break;
					case 'windowheight' /*case 'WindowHeight'*/: break;
					case 'windowwidth' /*case 'WindowWidth'*/: break;
					case 'windowtopx' /*case 'WindowTopX'*/: break;
					case 'windowtopy' /*case 'WindowTopY'*/: break;
					case 'tabratio' /*case 'TabRatio'*/: break;
					case 'protectstructure' /*case 'ProtectStructure'*/: break;
					case 'protectwindow' /*case 'ProtectWindow'*/: break;
					case 'protectwindows' /*case 'ProtectWindows'*/: break;
					case 'activesheet' /*case 'ActiveSheet'*/: break;
					case 'displayinknotes' /*case 'DisplayInkNotes'*/: break;
					case 'firstvisiblesheet' /*case 'FirstVisibleSheet'*/: break;
					case 'supbook' /*case 'SupBook'*/: break;
					case 'sheetname' /*case 'SheetName'*/: break;
					case 'sheetindex' /*case 'SheetIndex'*/: break;
					case 'sheetindexfirst' /*case 'SheetIndexFirst'*/: break;
					case 'sheetindexlast' /*case 'SheetIndexLast'*/: break;
					case 'dll' /*case 'Dll'*/: break;
					case 'acceptlabelsinformulas' /*case 'AcceptLabelsInFormulas'*/: break;
					case 'donotsavelinkvalues' /*case 'DoNotSaveLinkValues'*/: break;
					case 'iteration' /*case 'Iteration'*/: break;
					case 'maxiterations' /*case 'MaxIterations'*/: break;
					case 'maxchange' /*case 'MaxChange'*/: break;
					case 'path' /*case 'Path'*/: break;
					case 'xct' /*case 'Xct'*/: break;
					case 'count' /*case 'Count'*/: break;
					case 'selectedsheets' /*case 'SelectedSheets'*/: break;
					case 'calculation' /*case 'Calculation'*/: break;
					case 'uncalced' /*case 'Uncalced'*/: break;
					case 'startupprompt' /*case 'StartupPrompt'*/: break;
					case 'crn' /*case 'Crn'*/: break;
					case 'externname' /*case 'ExternName'*/: break;
					case 'formula' /*case 'Formula'*/: break;
					case 'colfirst' /*case 'ColFirst'*/: break;
					case 'collast' /*case 'ColLast'*/: break;
					case 'wantadvise' /*case 'WantAdvise'*/: break;
					case 'boolean' /*case 'Boolean'*/: break;
					case 'error' /*case 'Error'*/: break;
					case 'text' /*case 'Text'*/: break;
					case 'ole' /*case 'OLE'*/: break;
					case 'noautorecover' /*case 'NoAutoRecover'*/: break;
					case 'publishobjects' /*case 'PublishObjects'*/: break;
					case 'donotcalculatebeforesave' /*case 'DoNotCalculateBeforeSave'*/: break;
					case 'number' /*case 'Number'*/: break;
					case 'refmoder1c1' /*case 'RefModeR1C1'*/: break;
					case 'embedsavesmarttags' /*case 'EmbedSaveSmartTags'*/: break;
					default: seen = false;
				} break;

				/* WorkbookOptions */
				case 'workbookoptions' /*case 'WorkbookOptions'*/: switch(Rn[3]) {
					case 'owcversion' /*case 'OWCVersion'*/: break;
					case 'height' /*case 'Height'*/: break;
					case 'width' /*case 'Width'*/: break;
					default: seen = false;
				} break;

				/* WorksheetOptions */
				case 'worksheetoptions' /*case 'WorksheetOptions'*/: switch(Rn[3]) {
					case 'visible' /*case 'Visible'*/:
						if(Rn[0].slice(-2) === "/>"){/* empty */}
						else if(Rn[1]==="/") switch(str.slice(pidx, Rn.index)) {
							case "SheetHidden": wsprops.Hidden = 1; break;
							case "SheetVeryHidden": wsprops.Hidden = 2; break;
						}
						else pidx = Rn.index + Rn[0].length;
						break;
					case 'header' /*case 'Header'*/:
						if(!cursheet['!margins']) default_margins(cursheet['!margins']={}, 'xlml');
						if(!isNaN(+parsexmltag(Rn[0]).Margin)) cursheet['!margins'].header = +parsexmltag(Rn[0]).Margin;
						break;
					case 'footer' /*case 'Footer'*/:
						if(!cursheet['!margins']) default_margins(cursheet['!margins']={}, 'xlml');
						if(!isNaN(+parsexmltag(Rn[0]).Margin)) cursheet['!margins'].footer = +parsexmltag(Rn[0]).Margin;
						break;
					case 'pagemargins' /*case 'PageMargins'*/:
						var pagemargins = parsexmltag(Rn[0]);
						if(!cursheet['!margins']) default_margins(cursheet['!margins']={},'xlml');
						if(!isNaN(+pagemargins.Top)) cursheet['!margins'].top = +pagemargins.Top;
						if(!isNaN(+pagemargins.Left)) cursheet['!margins'].left = +pagemargins.Left;
						if(!isNaN(+pagemargins.Right)) cursheet['!margins'].right = +pagemargins.Right;
						if(!isNaN(+pagemargins.Bottom)) cursheet['!margins'].bottom = +pagemargins.Bottom;
						break;
					case 'displayrighttoleft' /*case 'DisplayRightToLeft'*/:
						if(!Workbook.Views) Workbook.Views = [];
						if(!Workbook.Views[0]) Workbook.Views[0] = {};
						Workbook.Views[0].RTL = true;
						break;

					case 'freezepanes' /*case 'FreezePanes'*/: break;
					case 'frozennosplit' /*case 'FrozenNoSplit'*/: break;

					case 'splithorizontal' /*case 'SplitHorizontal'*/:
					case 'splitvertical' /*case 'SplitVertical'*/:
						break;

					case 'donotdisplaygridlines' /*case 'DoNotDisplayGridlines'*/:
						break;

					case 'activerow' /*case 'ActiveRow'*/: break;
					case 'activecol' /*case 'ActiveCol'*/: break;
					case 'toprowbottompane' /*case 'TopRowBottomPane'*/: break;
					case 'leftcolumnrightpane' /*case 'LeftColumnRightPane'*/: break;

					case 'unsynced' /*case 'Unsynced'*/: break;
					case 'print' /*case 'Print'*/: break;
					case 'printerrors' /*case 'PrintErrors'*/: break;
					case 'panes' /*case 'Panes'*/: break;
					case 'scale' /*case 'Scale'*/: break;
					case 'pane' /*case 'Pane'*/: break;
					case 'number' /*case 'Number'*/: break;
					case 'layout' /*case 'Layout'*/: break;
					case 'pagesetup' /*case 'PageSetup'*/: break;
					case 'selected' /*case 'Selected'*/: break;
					case 'protectobjects' /*case 'ProtectObjects'*/: break;
					case 'enableselection' /*case 'EnableSelection'*/: break;
					case 'protectscenarios' /*case 'ProtectScenarios'*/: break;
					case 'validprinterinfo' /*case 'ValidPrinterInfo'*/: break;
					case 'horizontalresolution' /*case 'HorizontalResolution'*/: break;
					case 'verticalresolution' /*case 'VerticalResolution'*/: break;
					case 'numberofcopies' /*case 'NumberofCopies'*/: break;
					case 'activepane' /*case 'ActivePane'*/: break;
					case 'toprowvisible' /*case 'TopRowVisible'*/: break;
					case 'leftcolumnvisible' /*case 'LeftColumnVisible'*/: break;
					case 'fittopage' /*case 'FitToPage'*/: break;
					case 'rangeselection' /*case 'RangeSelection'*/: break;
					case 'papersizeindex' /*case 'PaperSizeIndex'*/: break;
					case 'pagelayoutzoom' /*case 'PageLayoutZoom'*/: break;
					case 'pagebreakzoom' /*case 'PageBreakZoom'*/: break;
					case 'filteron' /*case 'FilterOn'*/: break;
					case 'fitwidth' /*case 'FitWidth'*/: break;
					case 'fitheight' /*case 'FitHeight'*/: break;
					case 'commentslayout' /*case 'CommentsLayout'*/: break;
					case 'zoom' /*case 'Zoom'*/: break;
					case 'lefttoright' /*case 'LeftToRight'*/: break;
					case 'gridlines' /*case 'Gridlines'*/: break;
					case 'allowsort' /*case 'AllowSort'*/: break;
					case 'allowfilter' /*case 'AllowFilter'*/: break;
					case 'allowinsertrows' /*case 'AllowInsertRows'*/: break;
					case 'allowdeleterows' /*case 'AllowDeleteRows'*/: break;
					case 'allowinsertcols' /*case 'AllowInsertCols'*/: break;
					case 'allowdeletecols' /*case 'AllowDeleteCols'*/: break;
					case 'allowinserthyperlinks' /*case 'AllowInsertHyperlinks'*/: break;
					case 'allowformatcells' /*case 'AllowFormatCells'*/: break;
					case 'allowsizecols' /*case 'AllowSizeCols'*/: break;
					case 'allowsizerows' /*case 'AllowSizeRows'*/: break;
					case 'nosummaryrowsbelowdetail' /*case 'NoSummaryRowsBelowDetail'*/:
						if(!cursheet["!outline"]) cursheet["!outline"] = {};
						cursheet["!outline"].above = true;
						break;
					case 'tabcolorindex' /*case 'TabColorIndex'*/: break;
					case 'donotdisplayheadings' /*case 'DoNotDisplayHeadings'*/: break;
					case 'showpagelayoutzoom' /*case 'ShowPageLayoutZoom'*/: break;
					case 'nosummarycolumnsrightdetail' /*case 'NoSummaryColumnsRightDetail'*/:
						if(!cursheet["!outline"]) cursheet["!outline"] = {};
						cursheet["!outline"].left = true;
						break;
					case 'blackandwhite' /*case 'BlackAndWhite'*/: break;
					case 'donotdisplayzeros' /*case 'DoNotDisplayZeros'*/: break;
					case 'displaypagebreak' /*case 'DisplayPageBreak'*/: break;
					case 'rowcolheadings' /*case 'RowColHeadings'*/: break;
					case 'donotdisplayoutline' /*case 'DoNotDisplayOutline'*/: break;
					case 'noorientation' /*case 'NoOrientation'*/: break;
					case 'allowusepivottables' /*case 'AllowUsePivotTables'*/: break;
					case 'zeroheight' /*case 'ZeroHeight'*/: break;
					case 'viewablerange' /*case 'ViewableRange'*/: break;
					case 'selection' /*case 'Selection'*/: break;
					case 'protectcontents' /*case 'ProtectContents'*/: break;
					default: seen = false;
				} break;

				/* PivotTable */
				case 'pivottable' /*case 'PivotTable'*/: case 'pivotcache' /*case 'PivotCache'*/: switch(Rn[3]) {
					case 'immediateitemsondrop' /*case 'ImmediateItemsOnDrop'*/: break;
					case 'showpagemultipleitemlabel' /*case 'ShowPageMultipleItemLabel'*/: break;
					case 'compactrowindent' /*case 'CompactRowIndent'*/: break;
					case 'location' /*case 'Location'*/: break;
					case 'pivotfield' /*case 'PivotField'*/: break;
					case 'orientation' /*case 'Orientation'*/: break;
					case 'layoutform' /*case 'LayoutForm'*/: break;
					case 'layoutsubtotallocation' /*case 'LayoutSubtotalLocation'*/: break;
					case 'layoutcompactrow' /*case 'LayoutCompactRow'*/: break;
					case 'position' /*case 'Position'*/: break;
					case 'pivotitem' /*case 'PivotItem'*/: break;
					case 'datatype' /*case 'DataType'*/: break;
					case 'datafield' /*case 'DataField'*/: break;
					case 'sourcename' /*case 'SourceName'*/: break;
					case 'parentfield' /*case 'ParentField'*/: break;
					case 'ptlineitems' /*case 'PTLineItems'*/: break;
					case 'ptlineitem' /*case 'PTLineItem'*/: break;
					case 'countofsameitems' /*case 'CountOfSameItems'*/: break;
					case 'item' /*case 'Item'*/: break;
					case 'itemtype' /*case 'ItemType'*/: break;
					case 'ptsource' /*case 'PTSource'*/: break;
					case 'cacheindex' /*case 'CacheIndex'*/: break;
					case 'consolidationreference' /*case 'ConsolidationReference'*/: break;
					case 'filename' /*case 'FileName'*/: break;
					case 'reference' /*case 'Reference'*/: break;
					case 'nocolumngrand' /*case 'NoColumnGrand'*/: break;
					case 'norowgrand' /*case 'NoRowGrand'*/: break;
					case 'blanklineafteritems' /*case 'BlankLineAfterItems'*/: break;
					case 'hidden' /*case 'Hidden'*/: break;
					case 'subtotal' /*case 'Subtotal'*/: break;
					case 'basefield' /*case 'BaseField'*/: break;
					case 'mapchilditems' /*case 'MapChildItems'*/: break;
					case 'function' /*case 'Function'*/: break;
					case 'refreshonfileopen' /*case 'RefreshOnFileOpen'*/: break;
					case 'printsettitles' /*case 'PrintSetTitles'*/: break;
					case 'mergelabels' /*case 'MergeLabels'*/: break;
					case 'defaultversion' /*case 'DefaultVersion'*/: break;
					case 'refreshname' /*case 'RefreshName'*/: break;
					case 'refreshdate' /*case 'RefreshDate'*/: break;
					case 'refreshdatecopy' /*case 'RefreshDateCopy'*/: break;
					case 'versionlastrefresh' /*case 'VersionLastRefresh'*/: break;
					case 'versionlastupdate' /*case 'VersionLastUpdate'*/: break;
					case 'versionupdateablemin' /*case 'VersionUpdateableMin'*/: break;
					case 'versionrefreshablemin' /*case 'VersionRefreshableMin'*/: break;
					case 'calculation' /*case 'Calculation'*/: break;
					default: seen = false;
				} break;

				/* PageBreaks */
				case 'pagebreaks' /*case 'PageBreaks'*/: switch(Rn[3]) {
					case 'colbreaks' /*case 'ColBreaks'*/: break;
					case 'colbreak' /*case 'ColBreak'*/: break;
					case 'rowbreaks' /*case 'RowBreaks'*/: break;
					case 'rowbreak' /*case 'RowBreak'*/: break;
					case 'colstart' /*case 'ColStart'*/: break;
					case 'colend' /*case 'ColEnd'*/: break;
					case 'rowend' /*case 'RowEnd'*/: break;
					default: seen = false;
				} break;

				/* AutoFilter */
				case 'autofilter' /*case 'AutoFilter'*/: switch(Rn[3]) {
					case 'autofiltercolumn' /*case 'AutoFilterColumn'*/: break;
					case 'autofiltercondition' /*case 'AutoFilterCondition'*/: break;
					case 'autofilterand' /*case 'AutoFilterAnd'*/: break;
					case 'autofilteror' /*case 'AutoFilterOr'*/: break;
					default: seen = false;
				} break;

				/* QueryTable */
				case 'querytable' /*case 'QueryTable'*/: switch(Rn[3]) {
					case 'id' /*case 'Id'*/: break;
					case 'autoformatfont' /*case 'AutoFormatFont'*/: break;
					case 'autoformatpattern' /*case 'AutoFormatPattern'*/: break;
					case 'querysource' /*case 'QuerySource'*/: break;
					case 'querytype' /*case 'QueryType'*/: break;
					case 'enableredirections' /*case 'EnableRedirections'*/: break;
					case 'refreshedinxl9' /*case 'RefreshedInXl9'*/: break;
					case 'urlstring' /*case 'URLString'*/: break;
					case 'htmltables' /*case 'HTMLTables'*/: break;
					case 'connection' /*case 'Connection'*/: break;
					case 'commandtext' /*case 'CommandText'*/: break;
					case 'refreshinfo' /*case 'RefreshInfo'*/: break;
					case 'notitles' /*case 'NoTitles'*/: break;
					case 'nextid' /*case 'NextId'*/: break;
					case 'columninfo' /*case 'ColumnInfo'*/: break;
					case 'overwritecells' /*case 'OverwriteCells'*/: break;
					case 'donotpromptforfile' /*case 'DoNotPromptForFile'*/: break;
					case 'textwizardsettings' /*case 'TextWizardSettings'*/: break;
					case 'source' /*case 'Source'*/: break;
					case 'number' /*case 'Number'*/: break;
					case 'decimal' /*case 'Decimal'*/: break;
					case 'thousandseparator' /*case 'ThousandSeparator'*/: break;
					case 'trailingminusnumbers' /*case 'TrailingMinusNumbers'*/: break;
					case 'formatsettings' /*case 'FormatSettings'*/: break;
					case 'fieldtype' /*case 'FieldType'*/: break;
					case 'delimiters' /*case 'Delimiters'*/: break;
					case 'tab' /*case 'Tab'*/: break;
					case 'comma' /*case 'Comma'*/: break;
					case 'autoformatname' /*case 'AutoFormatName'*/: break;
					case 'versionlastedit' /*case 'VersionLastEdit'*/: break;
					case 'versionlastrefresh' /*case 'VersionLastRefresh'*/: break;
					default: seen = false;
				} break;

				case 'datavalidation' /*case 'DataValidation'*/:
				switch(Rn[3]) {
					case 'range' /*case 'Range'*/: break;

					case 'type' /*case 'Type'*/: break;
					case 'min' /*case 'Min'*/: break;
					case 'max' /*case 'Max'*/: break;
					case 'sort' /*case 'Sort'*/: break;
					case 'descending' /*case 'Descending'*/: break;
					case 'order' /*case 'Order'*/: break;
					case 'casesensitive' /*case 'CaseSensitive'*/: break;
					case 'value' /*case 'Value'*/: break;
					case 'errorstyle' /*case 'ErrorStyle'*/: break;
					case 'errormessage' /*case 'ErrorMessage'*/: break;
					case 'errortitle' /*case 'ErrorTitle'*/: break;
					case 'inputmessage' /*case 'InputMessage'*/: break;
					case 'inputtitle' /*case 'InputTitle'*/: break;
					case 'combohide' /*case 'ComboHide'*/: break;
					case 'inputhide' /*case 'InputHide'*/: break;
					case 'condition' /*case 'Condition'*/: break;
					case 'qualifier' /*case 'Qualifier'*/: break;
					case 'useblank' /*case 'UseBlank'*/: break;
					case 'value1' /*case 'Value1'*/: break;
					case 'value2' /*case 'Value2'*/: break;
					case 'format' /*case 'Format'*/: break;

					case 'cellrangelist' /*case 'CellRangeList'*/: break;
					default: seen = false;
				} break;

				case 'sorting' /*case 'Sorting'*/:
				case 'conditionalformatting' /*case 'ConditionalFormatting'*/:
				switch(Rn[3]) {
					case 'range' /*case 'Range'*/: break;
					case 'type' /*case 'Type'*/: break;
					case 'min' /*case 'Min'*/: break;
					case 'max' /*case 'Max'*/: break;
					case 'sort' /*case 'Sort'*/: break;
					case 'descending' /*case 'Descending'*/: break;
					case 'order' /*case 'Order'*/: break;
					case 'casesensitive' /*case 'CaseSensitive'*/: break;
					case 'value' /*case 'Value'*/: break;
					case 'errorstyle' /*case 'ErrorStyle'*/: break;
					case 'errormessage' /*case 'ErrorMessage'*/: break;
					case 'errortitle' /*case 'ErrorTitle'*/: break;
					case 'cellrangelist' /*case 'CellRangeList'*/: break;
					case 'inputmessage' /*case 'InputMessage'*/: break;
					case 'inputtitle' /*case 'InputTitle'*/: break;
					case 'combohide' /*case 'ComboHide'*/: break;
					case 'inputhide' /*case 'InputHide'*/: break;
					case 'condition' /*case 'Condition'*/: break;
					case 'qualifier' /*case 'Qualifier'*/: break;
					case 'useblank' /*case 'UseBlank'*/: break;
					case 'value1' /*case 'Value1'*/: break;
					case 'value2' /*case 'Value2'*/: break;
					case 'format' /*case 'Format'*/: break;
					default: seen = false;
				} break;

				/* MapInfo (schema) */
				case 'mapinfo' /*case 'MapInfo'*/: case 'schema' /*case 'Schema'*/: case 'data' /*case 'data'*/: switch(Rn[3]) {
					case 'map' /*case 'Map'*/: break;
					case 'entry' /*case 'Entry'*/: break;
					case 'range' /*case 'Range'*/: break;
					case 'xpath' /*case 'XPath'*/: break;
					case 'field' /*case 'Field'*/: break;
					case 'xsdtype' /*case 'XSDType'*/: break;
					case 'filteron' /*case 'FilterOn'*/: break;
					case 'aggregate' /*case 'Aggregate'*/: break;
					case 'elementtype' /*case 'ElementType'*/: break;
					case 'attributetype' /*case 'AttributeType'*/: break;
				/* These are from xsd (XML Schema Definition) */
					case 'schema' /*case 'schema'*/:
					case 'element' /*case 'element'*/:
					case 'complextype' /*case 'complexType'*/:
					case 'datatype' /*case 'datatype'*/:
					case 'all' /*case 'all'*/:
					case 'attribute' /*case 'attribute'*/:
					case 'extends' /*case 'extends'*/: break;

					case 'row' /*case 'row'*/: break;
					default: seen = false;
				} break;

				/* SmartTags (can be anything) */
				case 'smarttags' /*case 'SmartTags'*/: break;

				default: seen = false; break;
			}
			if(seen) break;
			/* CustomDocumentProperties */
			if(Rn[3].match(/!\[CDATA/)) break;
			if(!state[state.length-1][1]) throw 'Unrecognized tag: ' + Rn[3] + "|" + state.join("|");
			if(state[state.length-1][0]===/*'CustomDocumentProperties'*/'customdocumentproperties') {
				if(Rn[0].slice(-2) === "/>") break;
				else if(Rn[1]==="/") xlml_set_custprop(Custprops, raw_Rn3, cp, str.slice(pidx, Rn.index));
				else { cp = Rn; pidx = Rn.index + Rn[0].length; }
				break;
			}
			if(opts.WTF) throw 'Unrecognized tag: ' + Rn[3] + "|" + state.join("|");
	}
	var out = ({});
	if(!opts.bookSheets && !opts.bookProps) out.Sheets = sheets;
	out.SheetNames = sheetnames;
	out.Workbook = Workbook;
	out.SSF = dup(table_fmt);
	out.Props = Props;
	out.Custprops = Custprops;
	out.bookType = "xlml";
	return out;
}

function parse_xlml(data, opts) {
	fix_read_opts(opts=opts||{});
	switch(opts.type||"base64") {
		case "base64": return parse_xlml_xml(Base64_decode(data), opts);
		case "binary": case "buffer": case "file": return parse_xlml_xml(data, opts);
		case "array": return parse_xlml_xml(a2s(data), opts);
	}
}

/* TODO */
function write_props_xlml(wb, opts) {
	var o = [];
	/* DocumentProperties */
	if(wb.Props) o.push(xlml_write_docprops(wb.Props, opts));
	/* CustomDocumentProperties */
	if(wb.Custprops) o.push(xlml_write_custprops(wb.Props, wb.Custprops, opts));
	return o.join("");
}
/* TODO */
function write_wb_xlml(wb) {
	/* OfficeDocumentSettings */
	/* ExcelWorkbook */
	if((((wb||{}).Workbook||{}).WBProps||{}).date1904) return '<ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel"><Date1904/></ExcelWorkbook>';
	return "";
}
/* TODO */
function write_sty_xlml(wb, opts) {
	/* Styles */
	var styles = ['<Style ss:ID="Default" ss:Name="Normal"><NumberFormat/></Style>'];
	opts.cellXfs.forEach(function(xf, id) {
		var payload = [];
		payload.push(writextag('NumberFormat', null, {"ss:Format": escapexml(table_fmt[xf.numFmtId])}));

		var o = {"ss:ID": "s" + (21+id)};
		styles.push(writextag('Style', payload.join(""), o));
	});
	return writextag("Styles", styles.join(""));
}
function write_name_xlml(n) { return writextag("NamedRange", null, {"ss:Name": n.Name.slice(0,6) == "_xlnm." ? n.Name.slice(6) : n.Name, "ss:RefersTo":"=" + a1_to_rc(n.Ref, {r:0,c:0})}); }
function write_names_xlml(wb) {
	if(!((wb||{}).Workbook||{}).Names) return "";
var names = wb.Workbook.Names;
	var out = [];
	for(var i = 0; i < names.length; ++i) {
		var n = names[i];
		if(n.Sheet != null) continue;
		if(n.Name.match(/^_xlfn\./)) continue;
		out.push(write_name_xlml(n));
	}
	return writextag("Names", out.join(""));
}
function write_ws_xlml_names(ws, opts, idx, wb) {
	if(!ws) return "";
	if(!((wb||{}).Workbook||{}).Names) return "";
var names = wb.Workbook.Names;
	var out = [];
	for(var i = 0; i < names.length; ++i) {
		var n = names[i];
		if(n.Sheet != idx) continue;
		/*switch(n.Name) {
			case "_": continue;
		}*/
		if(n.Name.match(/^_xlfn\./)) continue;
		out.push(write_name_xlml(n));
	}
	return out.join("");
}
/* WorksheetOptions */
function write_ws_xlml_wsopts(ws, opts, idx, wb) {
	if(!ws) return "";
	var o = [];
	/* NOTE: spec technically allows any order, but stick with implied order */

	/* FitToPage */
	/* DoNotDisplayColHeaders */
	/* DoNotDisplayRowHeaders */
	/* ViewableRange */
	/* Selection */
	/* GridlineColor */
	/* Name */
	/* ExcelWorksheetType */
	/* IntlMacro */
	/* Unsynced */
	/* Selected */
	/* CodeName */

	if(ws['!margins']) {
		o.push("<PageSetup>");
		if(ws['!margins'].header) o.push(writextag("Header", null, {'x:Margin':ws['!margins'].header}));
		if(ws['!margins'].footer) o.push(writextag("Footer", null, {'x:Margin':ws['!margins'].footer}));
		o.push(writextag("PageMargins", null, {
			'x:Bottom': ws['!margins'].bottom || "0.75",
			'x:Left': ws['!margins'].left || "0.7",
			'x:Right': ws['!margins'].right || "0.7",
			'x:Top': ws['!margins'].top || "0.75"
		}));
		o.push("</PageSetup>");
	}

	/* PageSetup */
	/* DisplayPageBreak */
	/* TransitionExpressionEvaluation */
	/* TransitionFormulaEntry */
	/* Print */
	/* Zoom */
	/* PageLayoutZoom */
	/* PageBreakZoom */
	/* ShowPageBreakZoom */
	/* DefaultRowHeight */
	/* DefaultColumnWidth */
	/* StandardWidth */

	if(wb && wb.Workbook && wb.Workbook.Sheets && wb.Workbook.Sheets[idx]) {
		/* Visible */
		if(wb.Workbook.Sheets[idx].Hidden) o.push(writextag("Visible", (wb.Workbook.Sheets[idx].Hidden == 1 ? "SheetHidden" : "SheetVeryHidden"), {}));
		else {
			/* Selected */
			for(var i = 0; i < idx; ++i) if(wb.Workbook.Sheets[i] && !wb.Workbook.Sheets[i].Hidden) break;
			if(i == idx) o.push("<Selected/>");
		}
	}

	/* LeftColumnVisible */

	if(((((wb||{}).Workbook||{}).Views||[])[0]||{}).RTL) o.push("<DisplayRightToLeft/>");

	/* GridlineColorIndex */
	/* DisplayFormulas */
	/* DoNotDisplayGridlines */
	/* DoNotDisplayHeadings */
	/* DoNotDisplayOutline */
	/* ApplyAutomaticOutlineStyles */
	/* NoSummaryRowsBelowDetail */
	/* NoSummaryColumnsRightDetail */
	/* DoNotDisplayZeros */
	/* ActiveRow */
	/* ActiveColumn */
	/* FilterOn */
	/* RangeSelection */
	/* TopRowVisible */
	/* TopRowBottomPane */
	/* LeftColumnRightPane */
	/* ActivePane */
	/* SplitHorizontal */
	/* SplitVertical */
	/* FreezePanes */
	/* FrozenNoSplit */
	/* TabColorIndex */
	/* Panes */

	/* NOTE: Password not supported in XLML Format */
	if(ws['!protect']) {
		o.push(writetag("ProtectContents", "True"));
		if(ws['!protect'].objects) o.push(writetag("ProtectObjects", "True"));
		if(ws['!protect'].scenarios) o.push(writetag("ProtectScenarios", "True"));
		if(ws['!protect'].selectLockedCells != null && !ws['!protect'].selectLockedCells) o.push(writetag("EnableSelection", "NoSelection"));
		else if(ws['!protect'].selectUnlockedCells != null && !ws['!protect'].selectUnlockedCells) o.push(writetag("EnableSelection", "UnlockedCells"));
	[
		[ "formatCells", "AllowFormatCells" ],
		[ "formatColumns", "AllowSizeCols" ],
		[ "formatRows", "AllowSizeRows" ],
		[ "insertColumns", "AllowInsertCols" ],
		[ "insertRows", "AllowInsertRows" ],
		[ "insertHyperlinks", "AllowInsertHyperlinks" ],
		[ "deleteColumns", "AllowDeleteCols" ],
		[ "deleteRows", "AllowDeleteRows" ],
		[ "sort", "AllowSort" ],
		[ "autoFilter", "AllowFilter" ],
		[ "pivotTables", "AllowUsePivotTables" ]
	].forEach(function(x) { if(ws['!protect'][x[0]]) o.push("<"+x[1]+"/>"); });
	}

	if(o.length == 0) return "";
	return writextag("WorksheetOptions", o.join(""), {xmlns:XLMLNS.x});
}
function write_ws_xlml_comment(comments) {
	/* TODO: test multiple comments */
	return comments.map(function(c) {
		// TODO: formatted text
		var t = xlml_unfixstr(c.t||"");
		var d =writextag("ss:Data", t, {"xmlns":"http://www.w3.org/TR/REC-html40"});
		var p = {};
		if(c.a) p["ss:Author"] = c.a;
		if(!comments.hidden) p["ss:ShowAlways"] = "1";
		return writextag("Comment", d, p);
	}).join("");
}
function write_ws_xlml_cell(cell, ref, ws, opts, idx, wb, addr){
	if(!cell || (cell.v == undefined && cell.f == undefined)) return "";

	var attr = {};
	if(cell.f) attr["ss:Formula"] = "=" + escapexml(a1_to_rc(cell.f, addr));
	if(cell.F && cell.F.slice(0, ref.length) == ref) {
		var end = decode_cell(cell.F.slice(ref.length + 1));
		attr["ss:ArrayRange"] = "RC:R" + (end.r == addr.r ? "" : "[" + (end.r - addr.r) + "]") + "C" + (end.c == addr.c ? "" : "[" + (end.c - addr.c) + "]");
	}

	if(cell.l && cell.l.Target) {
		attr["ss:HRef"] = escapexml(cell.l.Target);
		if(cell.l.Tooltip) attr["x:HRefScreenTip"] = escapexml(cell.l.Tooltip);
	}

	if(ws['!merges']) {
		var marr = ws['!merges'];
		for(var mi = 0; mi != marr.length; ++mi) {
			if(marr[mi].s.c != addr.c || marr[mi].s.r != addr.r) continue;
			if(marr[mi].e.c > marr[mi].s.c) attr['ss:MergeAcross'] = marr[mi].e.c - marr[mi].s.c;
			if(marr[mi].e.r > marr[mi].s.r) attr['ss:MergeDown'] = marr[mi].e.r - marr[mi].s.r;
		}
	}

	var t = "", p = "";
	switch(cell.t) {
		case 'z': if(!opts.sheetStubs) return ""; break;
		case 'n': {
			if(!isFinite(cell.v)) {
				t = 'Error'; p = BErr[isNaN(cell.v) ? 0x24 : 0x07];
			} else {
				t = 'Number'; p = String(cell.v);
			}
		} break;
		case 'b': t = 'Boolean'; p = (cell.v ? "1" : "0"); break;
		case 'e': t = 'Error'; p = BErr[cell.v]; break;
		case 'd': t = 'DateTime'; p = new Date(cell.v).toISOString(); if(cell.z == null) cell.z = cell.z || table_fmt[14]; break;
		case 's': t = 'String'; p = escapexlml(cell.v||""); break;
	}
	/* TODO: cell style */
	var os = get_cell_style(opts.cellXfs, cell, opts);
	attr["ss:StyleID"] = "s" + (21+os);
	attr["ss:Index"] = addr.c + 1;
	var _v = (cell.v != null ? p : "");
	var m = cell.t == 'z' ? "" : ('<Data ss:Type="' + t + '">' + _v + '</Data>');

	if((cell.c||[]).length > 0) m += write_ws_xlml_comment(cell.c);

	return writextag("Cell", m, attr);
}
function write_ws_xlml_row(R, row) {
	var o = '<Row ss:Index="' + (R+1) + '"';
	if(row) {
		if(row.hpt && !row.hpx) row.hpx = pt2px(row.hpt);
		if(row.hpx) o += ' ss:AutoFitHeight="0" ss:Height="' + row.hpx + '"';
		if(row.hidden) o += ' ss:Hidden="1"';
	}
	return o + '>';
}
/* TODO */
function write_ws_xlml_table(ws, opts, idx, wb) {
	if(!ws['!ref']) return "";
	var range = safe_decode_range(ws['!ref']);
	var marr = ws['!merges'] || [], mi = 0;
	var o = [];
	if(ws['!cols']) ws['!cols'].forEach(function(n, i) {
		process_col(n);
		var w = !!n.width;
		var p = col_obj_w(i, n);
		var k = {"ss:Index":i+1};
		if(w) k['ss:Width'] = width2px(p.width);
		if(n.hidden) k['ss:Hidden']="1";
		o.push(writextag("Column",null,k));
	});
	var dense = ws["!data"] != null;
	var addr = {r:0,c:0};
	for(var R = range.s.r; R <= range.e.r; ++R) {
		var row = [write_ws_xlml_row(R, (ws['!rows']||[])[R])];
		addr.r = R;
		for(var C = range.s.c; C <= range.e.c; ++C) {
			addr.c = C;
			var skip = false;
			for(mi = 0; mi != marr.length; ++mi) {
				if(marr[mi].s.c > C) continue;
				if(marr[mi].s.r > R) continue;
				if(marr[mi].e.c < C) continue;
				if(marr[mi].e.r < R) continue;
				if(marr[mi].s.c != C || marr[mi].s.r != R) skip = true;
				break;
			}
			if(skip) continue;
			var ref = encode_col(C) + encode_row(R), cell = dense ? (ws["!data"][R]||[])[C] : ws[ref];
			row.push(write_ws_xlml_cell(cell, ref, ws, opts, idx, wb, addr));
		}
		row.push("</Row>");
		if(row.length > 2) o.push(row.join(""));
	}
	return o.join("");
}
function write_ws_xlml(idx, opts, wb) {
	var o = [];
	var s = wb.SheetNames[idx];
	var ws = wb.Sheets[s];

	var t = ws ? write_ws_xlml_names(ws, opts, idx, wb) : "";
	if(t.length > 0) o.push("<Names>" + t + "</Names>");

	/* Table */
	t = ws ? write_ws_xlml_table(ws, opts, idx, wb) : "";
	if(t.length > 0) o.push("<Table>" + t + "</Table>");

	/* WorksheetOptions */
	o.push(write_ws_xlml_wsopts(ws, opts, idx, wb));

	if(ws && ws["!autofilter"]) o.push('<AutoFilter x:Range="' + a1_to_rc(fix_range(ws["!autofilter"].ref), {r:0,c:0}) + '" xmlns="urn:schemas-microsoft-com:office:excel"></AutoFilter>');

	return o.join("");
}
function write_xlml(wb, opts) {
	if(!opts) opts = {};
	if(!wb.SSF) wb.SSF = dup(table_fmt);
	if(wb.SSF) {
		make_ssf(); SSF_load_table(wb.SSF);
		// $FlowIgnore
		opts.revssf = evert_num(wb.SSF); opts.revssf[wb.SSF[65535]] = 0;
		opts.ssf = wb.SSF;
		opts.cellXfs = [];
		get_cell_style(opts.cellXfs, {}, {revssf:{"General":0}});
	}
	var d = [];
	d.push(write_props_xlml(wb, opts));
	d.push(write_wb_xlml(wb, opts));
	d.push("");
	d.push(write_names_xlml(wb, opts));
	for(var i = 0; i < wb.SheetNames.length; ++i)
		d.push(writextag("Worksheet", write_ws_xlml(i, opts, wb), {"ss:Name":escapexml(wb.SheetNames[i])}));
	d[2] = write_sty_xlml(wb, opts);
	return XML_HEADER + writextag("Workbook", d.join(""), {
		'xmlns':      XLMLNS.ss,
		'xmlns:o':    XLMLNS.o,
		'xmlns:x':    XLMLNS.x,
		'xmlns:ss':   XLMLNS.ss,
		'xmlns:dt':   XLMLNS.dt,
		'xmlns:html': XLMLNS.html
	});
}
/* [MS-OLEDS] 2.3.8 CompObjStream */
function parse_compobj(obj) {
	var v = {};
	var o = obj.content;
/* [MS-OLEDS] 2.3.7 CompObjHeader -- All fields MUST be ignored */
	o.l = 28;

	v.AnsiUserType = o.read_shift(0, "lpstr-ansi");
	v.AnsiClipboardFormat = parse_ClipboardFormatOrAnsiString(o);

	if(o.length - o.l <= 4) return v;

	var m = o.read_shift(4);
	if(m == 0 || m > 40) return v;
	o.l-=4; v.Reserved1 = o.read_shift(0, "lpstr-ansi");

	if(o.length - o.l <= 4) return v;
	m = o.read_shift(4);
	if(m !== 0x71b239f4) return v;
	v.UnicodeClipboardFormat = parse_ClipboardFormatOrUnicodeString(o);

	m = o.read_shift(4);
	if(m == 0 || m > 40) return v;
	o.l-=4; v.Reserved2 = o.read_shift(0, "lpwstr");
}

/*
	Continue logic for:
	- 2.4.58 Continue          0x003c
	- 2.4.59 ContinueBigName   0x043c
	- 2.4.60 ContinueFrt       0x0812
	- 2.4.61 ContinueFrt11     0x0875
	- 2.4.62 ContinueFrt12     0x087f
*/
var CONTINUE_RT = [ 0x003c, 0x043c, 0x0812, 0x0875, 0x087f ];
function slurp(RecordType, R, blob, length, opts) {
	var l = length;
	var bufs = [];
	var d = blob.slice(blob.l,blob.l+l);
	if(opts && opts.enc && opts.enc.insitu && d.length > 0) switch(RecordType) {
	case 0x0009: case 0x0209: case 0x0409: case 0x0809/* BOF */: case 0x002F /* FilePass */: case 0x0195 /* FileLock */: case 0x00E1 /* InterfaceHdr */: case 0x0196 /* RRDInfo */: case 0x0138 /* RRDHead */: case 0x0194 /* UsrExcl */: case 0x000a /* EOF */:
		break;
	case 0x0085 /* BoundSheet8 */:
		break;
	default:
		opts.enc.insitu(d);
	}
	bufs.push(d);
	blob.l += l;
	var nextrt = __readUInt16LE(blob,blob.l), next = XLSRecordEnum[nextrt];
	var start = 0;
	while(next != null && CONTINUE_RT.indexOf(nextrt) > -1) {
		l = __readUInt16LE(blob,blob.l+2);
		start = blob.l + 4;
		if(nextrt == 0x0812 /* ContinueFrt */) start += 4;
		else if(nextrt == 0x0875 || nextrt == 0x087f) {
			start += 12;
		}
		d = blob.slice(start,blob.l+4+l);
		bufs.push(d);
		blob.l += 4+l;
		next = (XLSRecordEnum[nextrt = __readUInt16LE(blob, blob.l)]);
	}
	var b = (bconcat(bufs));
	prep_blob(b, 0);
	var ll = 0; b.lens = [];
	for(var j = 0; j < bufs.length; ++j) { b.lens.push(ll); ll += bufs[j].length; }
	if(b.length < length) throw "XLS Record 0x" + RecordType.toString(16) + " Truncated: " + b.length + " < " + length;
	return R.f(b, b.length, opts);
}

function safe_format_xf(p, opts, date1904) {
	if(p.t === 'z') return;
	if(!p.XF) return;
	var fmtid = 0;
	try {
		fmtid = p.z || p.XF.numFmtId || 0;
		if(opts.cellNF && p.z == null) p.z = table_fmt[fmtid];
	} catch(e) { if(opts.WTF) throw e; }
	if(!opts || opts.cellText !== false) try {
		if(p.t === 'e') { p.w = p.w || BErr[p.v]; }
		else if(fmtid === 0 || fmtid == "General") {
			if(p.t === 'n') {
				if((p.v|0) === p.v) p.w = p.v.toString(10);
				else p.w = SSF_general_num(p.v);
			}
			else p.w = SSF_general(p.v);
		}
		else p.w = SSF_format(fmtid,p.v, {date1904:!!date1904, dateNF: opts && opts.dateNF});
	} catch(e) { if(opts.WTF) throw e; }
	if(opts.cellDates && fmtid && p.t == 'n' && fmt_is_date(table_fmt[fmtid] || String(fmtid))) {
		var _d = SSF_parse_date_code(p.v + (date1904 ? 1462 : 0)); if(_d) { p.t = 'd'; p.v = new Date(Date.UTC(_d.y, _d.m-1,_d.d,_d.H,_d.M,_d.S,_d.u)); }
	}
}

function make_cell(val, ixfe, t) {
	return ({v:val, ixfe:ixfe, t:t});
}

// 2.3.2
function parse_workbook(blob, options) {
	var wb = ({opts:{}});
	var Sheets = {};
	if(DENSE != null && options.dense == null) options.dense = DENSE;
	var out = ({}); if(options.dense) out["!data"] = [];
	var Directory = {};
	var range = ({});
	var last_formula = null;
	var sst = ([]);
	var cur_sheet = "";
	var Preamble = {};
	var lastcell, last_cell = "", cc, cmnt, rngC, rngR;
	var sharedf = {};
	var arrayf = [];
	var temp_val;
	var country;
	var XFs = []; /* XF records */
	var palette = [];
	var Workbook = ({ Sheets:[], WBProps:{date1904:false}, Views:[{}] }), wsprops = {};
	var biff4w = false;
	var get_rgb = function getrgb(icv) {
		if(icv < 8) return XLSIcv[icv];
		if(icv < 64) return palette[icv-8] || XLSIcv[icv];
		return XLSIcv[icv];
	};
	var process_cell_style = function pcs(line, options) {
		var xfd = line.XF.data;
		if(!xfd || !xfd.patternType || !options || !options.cellStyles) return;
		line.s = ({});
		line.s.patternType = xfd.patternType;
		var t;
		if((t = rgb2Hex(get_rgb(xfd.icvFore)))) { line.s.fgColor = {rgb:t}; }
		if((t = rgb2Hex(get_rgb(xfd.icvBack)))) { line.s.bgColor = {rgb:t}; }
	};
	var addcell = function addcell(cell, line, options) {
		if(!biff4w && file_depth > 1) return;
		if(options.sheetRows && cell.r >= options.sheetRows) return;
		if(options.cellStyles && line.XF && line.XF.data) process_cell_style(line, options);
		delete line.ixfe; delete line.XF;
		lastcell = cell;
		last_cell = encode_cell(cell);
		if(!range || !range.s || !range.e) range = {s:{r:0,c:0},e:{r:0,c:0}};
		if(cell.r < range.s.r) range.s.r = cell.r;
		if(cell.c < range.s.c) range.s.c = cell.c;
		if(cell.r + 1 > range.e.r) range.e.r = cell.r + 1;
		if(cell.c + 1 > range.e.c) range.e.c = cell.c + 1;
		if(options.cellFormula && line.f) {
			for(var afi = 0; afi < arrayf.length; ++afi) {
				if(arrayf[afi][0].s.c > cell.c || arrayf[afi][0].s.r > cell.r) continue;
				if(arrayf[afi][0].e.c < cell.c || arrayf[afi][0].e.r < cell.r) continue;
				line.F = encode_range(arrayf[afi][0]);
				if(arrayf[afi][0].s.c != cell.c || arrayf[afi][0].s.r != cell.r) delete line.f;
				if(line.f) line.f = "" + stringify_formula(arrayf[afi][1], range, cell, supbooks, opts);
				break;
			}
		}
		{
			if(options.dense) {
				if(!out["!data"][cell.r]) out["!data"][cell.r] = [];
				out["!data"][cell.r][cell.c] = line;
			} else out[last_cell] = line;
		}
	};
	var opts = ({
		enc: false, // encrypted
		sbcch: 0, // cch in the preceding SupBook
		snames: [], // sheetnames
		sharedf: sharedf, // shared formulae by address
		arrayf: arrayf, // array formulae array
		rrtabid: [], // RRTabId
		lastuser: "", // Last User from WriteAccess
		biff: 8, // BIFF version
		codepage: 0, // CP from CodePage record
		winlocked: 0, // fLockWn from WinProtect
		cellStyles: !!options && !!options.cellStyles,
		WTF: !!options && !!options.wtf
	});
	if(options.password) opts.password = options.password;
	var themes;
	var merges = [];
	var objects = [];
	var colinfo = [], rowinfo = [];
	var seencol = false;
	var supbooks = ([]); // 1-indexed, will hold extern names
	supbooks.SheetNames = opts.snames;
	supbooks.sharedf = opts.sharedf;
	supbooks.arrayf = opts.arrayf;
	supbooks.names = [];
	supbooks.XTI = [];
	var last_RT = 0;
	var file_depth = 0; /* TODO: make a real stack */
	var BIFF2Fmt = 0, BIFF2FmtTable = [];
	var FilterDatabases = []; /* TODO: sort out supbooks and undefined elsewhere */
	var last_lbl;

	/* explicit override for some broken writers */
	opts.codepage = 1200;
	set_cp(1200);
	var seen_codepage = false;
	while(blob.l < blob.length - 1) {
		var s = blob.l;
		var RecordType = blob.read_shift(2);
		if(RecordType === 0 && last_RT === 0x000a /* EOF */) break;
		var length = (blob.l === blob.length ? 0 : blob.read_shift(2));
		var R = XLSRecordEnum[RecordType];
		if(file_depth == 0 && [0x0009, 0x0209, 0x0409, 0x0809].indexOf(RecordType) == -1 /* BOF */) break;
		//console.log(RecordType.toString(16), RecordType, R, blob.l, length, blob.length);
		//if(!R) console.log(blob.slice(blob.l, blob.l + length));
		if(R && R.f) {
			if(options.bookSheets) {
				if(last_RT === 0x0085 /* BoundSheet8 */ && RecordType !== 0x0085 /* R.n !== 'BoundSheet8' */) break;
			}
			last_RT = RecordType;
			if(R.r === 2 || R.r == 12) {
				var rt = blob.read_shift(2); length -= 2;
				if(!opts.enc && rt !== RecordType && (((rt&0xFF)<<8)|(rt>>8)) !== RecordType) throw new Error("rt mismatch: " + rt + "!=" + RecordType);
				if(R.r == 12){
					blob.l += 10; length -= 10;
				} // skip FRT
			}
			//console.error(R,blob.l,length,blob.length);
			var val = ({});
			if(RecordType === 0x000a /* EOF */) val = R.f(blob, length, opts);
			else val = slurp(RecordType, R, blob, length, opts);
if(file_depth == 0 && [0x0009, 0x0209, 0x0409, 0x0809].indexOf(last_RT) === -1 /* BOF */) continue;
			switch(RecordType) {
				case 0x0022 /* Date1904 */:
wb.opts.Date1904 = Workbook.WBProps.date1904 = val; break;
				case 0x0086 /* WriteProtect */: wb.opts.WriteProtect = true; break;
				case 0x002f /* FilePass */:
					if(!opts.enc) blob.l = 0;
					opts.enc = val;
					if(!options.password) throw new Error("File is password-protected");
					if(val.valid == null) throw new Error("Encryption scheme unsupported");
					if(!val.valid) throw new Error("Password is incorrect");
					break;
				case 0x005c /* WriteAccess */: opts.lastuser = val; break;
				case 0x0042 /* CodePage */:
					var cpval = Number(val);
					/* overrides based on test cases */
					switch(cpval) {
						case 0x5212: cpval =  1200; break;
						case 0x8000: cpval = 10000; break;
						case 0x8001: cpval =  1252; break;
					}
					set_cp(opts.codepage = cpval);
					seen_codepage = true;
					break;
				case 0x013d /* RRTabId */: opts.rrtabid = val; break;
				case 0x0019 /* WinProtect */: opts.winlocked = val; break;
				case 0x01b7 /* RefreshAll */: wb.opts["RefreshAll"] = val; break;
				case 0x000c /* CalcCount */: wb.opts["CalcCount"] = val; break;
				case 0x0010 /* CalcDelta */: wb.opts["CalcDelta"] = val; break;
				case 0x0011 /* CalcIter */: wb.opts["CalcIter"] = val; break;
				case 0x000d /* CalcMode */: wb.opts["CalcMode"] = val; break;
				case 0x000e /* CalcPrecision */: wb.opts["CalcPrecision"] = val; break;
				case 0x005f /* CalcSaveRecalc */: wb.opts["CalcSaveRecalc"] = val; break;
				case 0x000f /* CalcRefMode */: opts.CalcRefMode = val; break; // TODO: implement R1C1
				case 0x08a3 /* ForceFullCalculation */: wb.opts.FullCalc = val; break;
				case 0x0081 /* WsBool */:
					if(val.fDialog) out["!type"] = "dialog";
					if(!val.fBelow) (out["!outline"] || (out["!outline"] = {})).above = true;
					if(!val.fRight) (out["!outline"] || (out["!outline"] = {})).left = true;
					break; // TODO
				case 0x0043: /* BIFF2XF */ case 0x0243: /* BIFF3XF */ case 0x0443: /* BIFF4XF */
				case 0x00e0 /* XF */:
					XFs.push(val); break;
				case 0x01ae /* SupBook */:
					supbooks.push([val]);
					supbooks[supbooks.length-1].XTI = [];
					break;
				case 0x0023: case 0x0223 /* ExternName */:
					supbooks[supbooks.length-1].push(val);
					break;
				case 0x0018: case 0x0218 /* Lbl */:
					last_lbl = ({
						Name: val.Name,
						Ref: stringify_formula(val.rgce,range,null,supbooks,opts)
					});
					if(val.itab > 0) last_lbl.Sheet = val.itab - 1;
					supbooks.names.push(last_lbl);
					if(!supbooks[0]) { supbooks[0] = []; supbooks[0].XTI = []; }
					supbooks[supbooks.length-1].push(val);
					if(val.Name == "_xlnm._FilterDatabase" && val.itab > 0)
						if(val.rgce && val.rgce[0] && val.rgce[0][0] && val.rgce[0][0][0] == 'PtgArea3d')
							FilterDatabases[val.itab - 1] = { ref: encode_range(val.rgce[0][0][1][2]) };
					break;
				case 0x0016 /* ExternCount */: opts.ExternCount = val; break;
				case 0x0017 /* ExternSheet */:
					if(supbooks.length == 0) { supbooks[0] = []; supbooks[0].XTI = []; }
					supbooks[supbooks.length - 1].XTI = supbooks[supbooks.length - 1].XTI.concat(val); supbooks.XTI = supbooks.XTI.concat(val); break;
				case 0x0894 /* NameCmt */:
					/* TODO: search for correct name */
					if(opts.biff < 8) break;
					if(last_lbl != null) last_lbl.Comment = val[1];
					break;
				case 0x0012 /* Protect */: out["!protect"] = val; break; /* for sheet or book */
				case 0x0013 /* Password */: if(val !== 0 && opts.WTF) console.error("Password verifier: " + val); break;
				case 0x0085 /* BoundSheet8 */: {
					Directory[opts.biff == 4 ? opts.snames.length : val.pos] = val;
					opts.snames.push(val.name);
				} break;
				case 0x000a /* EOF */: {
					if(--file_depth ? !biff4w : biff4w) break;
					if(range.e) {
						if(range.e.r > 0 && range.e.c > 0) {
							range.e.r--; range.e.c--;
							out["!ref"] = encode_range(range);
							if(options.sheetRows && options.sheetRows <= range.e.r) {
								var tmpri = range.e.r;
								range.e.r = options.sheetRows - 1;
								out["!fullref"] = out["!ref"];
								out["!ref"] = encode_range(range);
								range.e.r = tmpri;
							}
							range.e.r++; range.e.c++;
						}
						if(merges.length > 0) out["!merges"] = merges;
						if(objects.length > 0) out["!objects"] = objects;
						if(colinfo.length > 0) out["!cols"] = colinfo;
						if(rowinfo.length > 0) out["!rows"] = rowinfo;
						Workbook.Sheets.push(wsprops);
					}
					if(cur_sheet === "") Preamble = out; else Sheets[cur_sheet] = out;
					out = ({}); if(options.dense) out["!data"] = [];
				} break;
				case 0x0009: case 0x0209: case 0x0409: case 0x0809 /* BOF */: {
					if(opts.biff === 8) opts.biff = {
						0x0009: 2,
						0x0209: 3,
						0x0409: 4
					}[RecordType] || {
						0x0200: 2,
						0x0300: 3,
						0x0400: 4,
						0x0500: 5,
						0x0600: 8,
						0x0002: 2,
						0x0007: 2
					}[val.BIFFVer] || 8;
					opts.biffguess = val.BIFFVer == 0;
					if(val.BIFFVer == 0 && val.dt == 0x1000) { opts.biff = 5; seen_codepage = true; set_cp(opts.codepage = 28591); }
					if(opts.biff == 4 && val.dt & 0x100) biff4w = true;
					if(opts.biff == 8 && val.BIFFVer == 0 && val.dt == 16) opts.biff = 2;
					if(file_depth++ && !biff4w) break;
					out = ({}); if(options.dense) out["!data"] = [];

					if(opts.biff < 8 && !seen_codepage) { seen_codepage = true; set_cp(opts.codepage = options.codepage || 1252); }
					if(opts.biff == 4 && biff4w) {
						cur_sheet = (Directory[opts.snames.indexOf(cur_sheet)+1] || {name:""}).name;
					} else if(opts.biff < 5 || val.BIFFVer == 0 && val.dt == 0x1000) {
						if(cur_sheet === "") cur_sheet = "Sheet1";
						range = {s:{r:0,c:0},e:{r:0,c:0}};
						/* fake BoundSheet8 */
						var fakebs8 = {pos: blob.l - length, name:cur_sheet};
						Directory[fakebs8.pos] = fakebs8;
						opts.snames.push(cur_sheet);
					}
					else cur_sheet = (Directory[s] || {name:""}).name;
					if(val.dt == 0x20) out["!type"] = "chart";
					if(val.dt == 0x40) out["!type"] = "macro";
					merges = [];
					objects = [];
					opts.arrayf = arrayf = [];
					colinfo = []; rowinfo = [];
					seencol = false;
					wsprops = {Hidden:(Directory[s]||{hs:0}).hs, name:cur_sheet };
				} break;
				case 0x0203 /* Number */: case 0x0003 /* BIFF2NUM */: case 0x0002 /* BIFF2INT */: {
					if(out["!type"] == "chart") if(options.dense ? (out["!data"][val.r]||[])[val.c]: out[encode_col(val.c) + encode_row(val.r)]) ++val.c;
					temp_val = ({ixfe: val.ixfe, XF: XFs[val.ixfe]||{}, v:val.val, t:'n'});
					if(BIFF2Fmt > 0) temp_val.z = (temp_val.XF && temp_val.XF.numFmtId) && BIFF2FmtTable[temp_val.XF.numFmtId] || BIFF2FmtTable[(temp_val.ixfe>>8) & 0x3F];
					safe_format_xf(temp_val, options, wb.opts.Date1904);
					addcell({c:val.c, r:val.r}, temp_val, options);
				} break;
				case 0x0005: case 0x0205 /* BoolErr */: {
					temp_val = ({ixfe: val.ixfe, XF: XFs[val.ixfe], v:val.val, t:val.t});
					if(BIFF2Fmt > 0) temp_val.z = (temp_val.XF && temp_val.XF.numFmtId) && BIFF2FmtTable[temp_val.XF.numFmtId] || BIFF2FmtTable[(temp_val.ixfe>>8) & 0x3F];
					safe_format_xf(temp_val, options, wb.opts.Date1904);
					addcell({c:val.c, r:val.r}, temp_val, options);
				} break;
				case 0x027e /* RK */: {
					temp_val = ({ixfe: val.ixfe, XF: XFs[val.ixfe], v:val.rknum, t:'n'});
					if(BIFF2Fmt > 0) temp_val.z = (temp_val.XF && temp_val.XF.numFmtId) && BIFF2FmtTable[temp_val.XF.numFmtId] || BIFF2FmtTable[(temp_val.ixfe>>8) & 0x3F];
					safe_format_xf(temp_val, options, wb.opts.Date1904);
					addcell({c:val.c, r:val.r}, temp_val, options);
				} break;
				case 0x00bd /* MulRk */: {
					for(var j = val.c; j <= val.C; ++j) {
						var ixfe = val.rkrec[j-val.c][0];
						temp_val= ({ixfe:ixfe, XF:XFs[ixfe], v:val.rkrec[j-val.c][1], t:'n'});
						if(BIFF2Fmt > 0) temp_val.z = (temp_val.XF && temp_val.XF.numFmtId) && BIFF2FmtTable[temp_val.XF.numFmtId] || BIFF2FmtTable[(temp_val.ixfe>>8) & 0x3F];
						safe_format_xf(temp_val, options, wb.opts.Date1904);
						addcell({c:j, r:val.r}, temp_val, options);
					}
				} break;
				case 0x0006: case 0x0206: case 0x0406 /* Formula */: {
					if(val.val == 'String') { last_formula = val; break; }
					temp_val = make_cell(val.val, val.cell.ixfe, val.tt);
					temp_val.XF = XFs[temp_val.ixfe];
					if(options.cellFormula) {
						var _f = val.formula;
						if(_f && _f[0] && _f[0][0] && _f[0][0][0] == 'PtgExp') {
							var _fr = _f[0][0][1][0], _fc = _f[0][0][1][1];
							var _fe = encode_cell({r:_fr, c:_fc});
							if(sharedf[_fe]) temp_val.f = ""+stringify_formula(val.formula,range,val.cell,supbooks, opts);
							else temp_val.F = ((options.dense ? (out["!data"][_fr]||[])[_fc]: out[_fe]) || {}).F;
						} else temp_val.f = ""+stringify_formula(val.formula,range,val.cell,supbooks, opts);
					}
					if(BIFF2Fmt > 0) temp_val.z = (temp_val.XF && temp_val.XF.numFmtId) && BIFF2FmtTable[temp_val.XF.numFmtId] || BIFF2FmtTable[(temp_val.ixfe>>8) & 0x3F];
					safe_format_xf(temp_val, options, wb.opts.Date1904);
					addcell(val.cell, temp_val, options);
					last_formula = val;
				} break;
				case 0x0007: case 0x0207 /* String */: {
					if(last_formula) { /* technically always true */
						last_formula.val = val;
						temp_val = make_cell(val, last_formula.cell.ixfe, 's');
						temp_val.XF = XFs[temp_val.ixfe];
						if(options.cellFormula) {
							temp_val.f = ""+stringify_formula(last_formula.formula, range, last_formula.cell, supbooks, opts);
						}
						if(BIFF2Fmt > 0) temp_val.z = (temp_val.XF && temp_val.XF.numFmtId) && BIFF2FmtTable[temp_val.XF.numFmtId] || BIFF2FmtTable[(temp_val.ixfe>>8) & 0x3F];
						safe_format_xf(temp_val, options, wb.opts.Date1904);
						addcell(last_formula.cell, temp_val, options);
						last_formula = null;
					} else throw new Error("String record expects Formula");
				} break;
				case 0x0021: case 0x0221 /* Array */: {
					arrayf.push(val);
					var _arraystart = encode_cell(val[0].s);
					cc = options.dense ? (out["!data"][val[0].s.r]||[])[val[0].s.c] : out[_arraystart];
					if(options.cellFormula && cc) {
						if(!last_formula) break; /* technically unreachable */
						if(!_arraystart || !cc) break;
						cc.f = ""+stringify_formula(val[1], range, val[0], supbooks, opts);
						cc.F = encode_range(val[0]);
					}
				} break;
				case 0x04bc /* ShrFmla */: {
					if(!options.cellFormula) break;
					if(last_cell) {
						/* TODO: capture range */
						if(!last_formula) break; /* technically unreachable */
						sharedf[encode_cell(last_formula.cell)]= val[0];
						cc = options.dense ? (out["!data"][last_formula.cell.r]||[])[last_formula.cell.c] : out[encode_cell(last_formula.cell)];
						(cc||{}).f = ""+stringify_formula(val[0], range, lastcell, supbooks, opts);
					}
				} break;
				case 0x00fd /* LabelSst */:
					temp_val=make_cell(sst[val.isst].t, val.ixfe, 's');
					if(sst[val.isst].h) temp_val.h = sst[val.isst].h;
					temp_val.XF = XFs[temp_val.ixfe];
					if(BIFF2Fmt > 0) temp_val.z = (temp_val.XF && temp_val.XF.numFmtId) && BIFF2FmtTable[temp_val.XF.numFmtId] || BIFF2FmtTable[(temp_val.ixfe>>8) & 0x3F];
					safe_format_xf(temp_val, options, wb.opts.Date1904);
					addcell({c:val.c, r:val.r}, temp_val, options);
					break;
				case 0x0201 /* Blank */: if(options.sheetStubs) {
					temp_val = ({ixfe: val.ixfe, XF: XFs[val.ixfe], t:'z'});
					if(BIFF2Fmt > 0) temp_val.z = (temp_val.XF && temp_val.XF.numFmtId) && BIFF2FmtTable[temp_val.XF.numFmtId] || BIFF2FmtTable[(temp_val.ixfe>>8) & 0x3F];
					safe_format_xf(temp_val, options, wb.opts.Date1904);
					addcell({c:val.c, r:val.r}, temp_val, options);
				} break;
				case 0x00be /* MulBlank */: if(options.sheetStubs) {
					for(var _j = val.c; _j <= val.C; ++_j) {
						var _ixfe = val.ixfe[_j-val.c];
						temp_val= ({ixfe:_ixfe, XF:XFs[_ixfe], t:'z'});
						if(BIFF2Fmt > 0) temp_val.z = (temp_val.XF && temp_val.XF.numFmtId) && BIFF2FmtTable[temp_val.XF.numFmtId] || BIFF2FmtTable[(temp_val.ixfe>>8) & 0x3F];
						safe_format_xf(temp_val, options, wb.opts.Date1904);
						addcell({c:_j, r:val.r}, temp_val, options);
					}
				} break;
				case 0x00d6 /* RString */:
				case 0x0204 /* Label */: case 0x0004 /* BIFF2STR */:
					temp_val=make_cell(val.val, val.ixfe, 's');
					temp_val.XF = XFs[temp_val.ixfe];
					if(BIFF2Fmt > 0) temp_val.z = (temp_val.XF && temp_val.XF.numFmtId) && BIFF2FmtTable[temp_val.XF.numFmtId] || BIFF2FmtTable[(temp_val.ixfe>>8) & 0x3F];
					safe_format_xf(temp_val, options, wb.opts.Date1904);
					addcell({c:val.c, r:val.r}, temp_val, options);
					break;

				case 0x0000: case 0x0200 /* Dimensions */: {
					if(file_depth === 1) range = val; /* TODO: stack */
				} break;
				case 0x00fc /* SST */: {
					sst = val;
				} break;
				case 0x041e /* Format */: { /* val = [id, fmt] */
					if(opts.biff >= 3 && opts.biff <= 4) {
						BIFF2FmtTable[BIFF2Fmt++] = val[1];
						for(var b4idx = 0; b4idx < BIFF2Fmt + 163; ++b4idx) if(table_fmt[b4idx] == val[1]) break;
						if(b4idx >= 163) SSF__load(val[1], BIFF2Fmt + 163);
					}
					else SSF__load(val[1], val[0]);
				} break;
				case 0x001e /* BIFF2FORMAT */: {
					BIFF2FmtTable[BIFF2Fmt++] = val;
					for(var b2idx = 0; b2idx < BIFF2Fmt + 163; ++b2idx) if(table_fmt[b2idx] == val) break;
					if(b2idx >= 163) SSF__load(val, BIFF2Fmt + 163);
				} break;

				case 0x00e5 /* MergeCells */: merges = merges.concat(val); break;

				case 0x005d /* Obj */: objects[val.cmo[0]] = opts.lastobj = val; break;
				case 0x01b6 /* TxO */: opts.lastobj.TxO = val; break;
				case 0x007f /* ImData */: opts.lastobj.ImData = val; break;

				case 0x01b8 /* HLink */: {
					for(rngR = val[0].s.r; rngR <= val[0].e.r; ++rngR)
						for(rngC = val[0].s.c; rngC <= val[0].e.c; ++rngC) {
							cc = options.dense ? (out["!data"][rngR]||[])[rngC] : out[encode_cell({c:rngC,r:rngR})];
							if(cc) cc.l = val[1];
						}
				} break;
				case 0x0800 /* HLinkTooltip */: {
					for(rngR = val[0].s.r; rngR <= val[0].e.r; ++rngR)
						for(rngC = val[0].s.c; rngC <= val[0].e.c; ++rngC) {
							cc = options.dense ? (out["!data"][rngR]||[])[rngC] : out[encode_cell({c:rngC,r:rngR})];
							if(cc && cc.l) cc.l.Tooltip = val[1];
							}
				} break;
				case 0x001c /* Note */: {
					/* TODO: comment continuation (row == -1 / 0xFFFF) */
					cc = options.dense ? (out["!data"][val[0].r]||[])[val[0].c] : out[encode_cell(val[0])];
					if(!cc) {
						if(options.dense) {
							if(!out["!data"][val[0].r]) out["!data"][val[0].r] = [];
							cc = out["!data"][val[0].r][val[0].c] = ({t:"z"});
						} else {
							cc = out[encode_cell(val[0])] = ({t:"z"});
						}
						range.e.r = Math.max(range.e.r, val[0].r);
						range.s.r = Math.min(range.s.r, val[0].r);
						range.e.c = Math.max(range.e.c, val[0].c);
						range.s.c = Math.min(range.s.c, val[0].c);
					}
					if(!cc.c) cc.c = [];
					if(opts.biff <= 5 && opts.biff >= 2) cmnt = {a:"SheetJ5", t:val[1]};
					else {
						var noteobj = objects[val[2]];
						cmnt = {a:val[1],t:noteobj.TxO.t};
						if(val[3] != null && !(val[3] & 0x02)) cc.c.hidden = true;
					}
					cc.c.push(cmnt);
				} break;
				case 0x087d /* XFExt */: update_xfext(XFs[val.ixfe], val.ext); break;
				case 0x007d /* ColInfo */: {
					if(!opts.cellStyles) break;
					while(val.e >= val.s) {
						colinfo[val.e--] = { width: val.w/256, level: (val.level || 0), hidden: !!(val.flags & 1) };
						if(!seencol) { seencol = true; find_mdw_colw(val.w/256); }
						process_col(colinfo[val.e+1]);
					}
				} break;
				case 0x0208 /* Row */: {
					var rowobj = {};
					if(val.level != null) { rowinfo[val.r] = rowobj; rowobj.level = val.level; }
					if(val.hidden) { rowinfo[val.r] = rowobj; rowobj.hidden = true; }
					if(val.hpt) {
						rowinfo[val.r] = rowobj;
						rowobj.hpt = val.hpt; rowobj.hpx = pt2px(val.hpt);
					}
				} break;
				case 0x0026 /* LeftMargin */:
				case 0x0027 /* RightMargin */:
				case 0x0028 /* TopMargin */:
				case 0x0029 /* BottomMargin */:
					if(!out['!margins']) default_margins(out['!margins'] = {});
					out['!margins'][({0x26: "left", 0x27:"right", 0x28:"top", 0x29:"bottom"})[RecordType]] = val;
					break;
				case 0x00a1 /* Setup */: // TODO
					if(!out['!margins']) default_margins(out['!margins'] = {});
					out['!margins'].header = val.header;
					out['!margins'].footer = val.footer;
					break;
				case 0x023e /* Window2 */: // TODO
					// $FlowIgnore
					if(val.RTL) Workbook.Views[0].RTL = true;
					break;
				case 0x0092 /* Palette */: palette = val; break;
				case 0x0896 /* Theme */: themes = val; break;
				case 0x008c /* Country */: country = val; break;
				case 0x01ba /* CodeName */: {
if(!cur_sheet) Workbook.WBProps.CodeName = val || "ThisWorkbook";
					else wsprops.CodeName = val || wsprops.name;
				} break;
			}
		} else {
			if(!R) console.error("Missing Info for XLS Record 0x" + RecordType.toString(16));
			blob.l += length;
		}
	}
	wb.SheetNames=keys(Directory).sort(function(a,b) { return Number(a) - Number(b); }).map(function(x){return Directory[x].name;});
	if(!options.bookSheets) wb.Sheets=Sheets;
	if(!wb.SheetNames.length && Preamble["!ref"]) {
		wb.SheetNames.push("Sheet1");
		/*jshint -W069 */
		if(wb.Sheets) wb.Sheets["Sheet1"] = Preamble;
		/*jshint +W069 */
	} else wb.Preamble=Preamble;
	if(wb.Sheets) FilterDatabases.forEach(function(r,i) { wb.Sheets[wb.SheetNames[i]]['!autofilter'] = r; });
	wb.Strings = sst;
	wb.SSF = dup(table_fmt);
	if(opts.enc) wb.Encryption = opts.enc;
	if(themes) wb.Themes = themes;
	wb.Metadata = {};
	if(country !== undefined) wb.Metadata.Country = country;
	if(supbooks.names.length > 0) Workbook.Names = supbooks.names;
	wb.Workbook = Workbook;
	return wb;
}

/* TODO: split props*/
var PSCLSID = {
	SI: "e0859ff2f94f6810ab9108002b27b3d9",
	DSI: "02d5cdd59c2e1b10939708002b2cf9ae",
	UDI: "05d5cdd59c2e1b10939708002b2cf9ae"
};
function parse_xls_props(cfb, props, o) {
	/* [MS-OSHARED] 2.3.3.2.2 Document Summary Information Property Set */
	var DSI = CFB.find(cfb, '/!DocumentSummaryInformation');
	if(DSI && DSI.size > 0) try {
		var DocSummary = parse_PropertySetStream(DSI, DocSummaryPIDDSI, PSCLSID.DSI);
		for(var d in DocSummary) props[d] = DocSummary[d];
	} catch(e) {if(o.WTF) throw e;/* empty */}

	/* [MS-OSHARED] 2.3.3.2.1 Summary Information Property Set*/
	var SI = CFB.find(cfb, '/!SummaryInformation');
	if(SI && SI.size > 0) try {
		var Summary = parse_PropertySetStream(SI, SummaryPIDSI, PSCLSID.SI);
		for(var s in Summary) if(props[s] == null) props[s] = Summary[s];
	} catch(e) {if(o.WTF) throw e;/* empty */}

	if(props.HeadingPairs && props.TitlesOfParts) {
		load_props_pairs(props.HeadingPairs, props.TitlesOfParts, props, o);
		delete props.HeadingPairs; delete props.TitlesOfParts;
	}
}
function write_xls_props(wb, cfb) {
	var DSEntries = [], SEntries = [], CEntries = [];
	var i = 0, Keys;
	var DocSummaryRE = evert_key(DocSummaryPIDDSI, "n");
	var SummaryRE = evert_key(SummaryPIDSI, "n");
	if(wb.Props) {
		Keys = keys(wb.Props);
		// $FlowIgnore
		for(i = 0; i < Keys.length; ++i) (Object.prototype.hasOwnProperty.call(DocSummaryRE, Keys[i]) ? DSEntries : Object.prototype.hasOwnProperty.call(SummaryRE, Keys[i]) ? SEntries : CEntries).push([Keys[i], wb.Props[Keys[i]]]);
	}
	if(wb.Custprops) {
		Keys = keys(wb.Custprops);
		// $FlowIgnore
		for(i = 0; i < Keys.length; ++i) if(!Object.prototype.hasOwnProperty.call((wb.Props||{}), Keys[i])) (Object.prototype.hasOwnProperty.call(DocSummaryRE, Keys[i]) ? DSEntries : Object.prototype.hasOwnProperty.call(SummaryRE, Keys[i]) ? SEntries : CEntries).push([Keys[i], wb.Custprops[Keys[i]]]);
	}
	var CEntries2 = [];
	for(i = 0; i < CEntries.length; ++i) {
		if(XLSPSSkip.indexOf(CEntries[i][0]) > -1 || PseudoPropsPairs.indexOf(CEntries[i][0]) > -1) continue;
		if(CEntries[i][1] == null) continue;
		CEntries2.push(CEntries[i]);
	}
	if(SEntries.length) CFB.utils.cfb_add(cfb, "/\u0005SummaryInformation", write_PropertySetStream(SEntries, PSCLSID.SI, SummaryRE, SummaryPIDSI));
	if(DSEntries.length || CEntries2.length) CFB.utils.cfb_add(cfb, "/\u0005DocumentSummaryInformation", write_PropertySetStream(DSEntries, PSCLSID.DSI, DocSummaryRE, DocSummaryPIDDSI, CEntries2.length ? CEntries2 : null, PSCLSID.UDI));
}

function parse_xlscfb(cfb, options) {
if(!options) options = {};
fix_read_opts(options);
reset_cp();
if(options.codepage) set_ansi(options.codepage);
var CompObj, WB;
if(cfb.FullPaths) {
	if(CFB.find(cfb, '/encryption')) throw new Error("File is password-protected");
	CompObj = CFB.find(cfb, '!CompObj');
	WB = CFB.find(cfb, '/Workbook') || CFB.find(cfb, '/Book');
} else {
	switch(options.type) {
		case 'base64': cfb = s2a(Base64_decode(cfb)); break;
		case 'binary': cfb = s2a(cfb); break;
		case 'buffer': break;
		case 'array': if(!Array.isArray(cfb)) cfb = Array.prototype.slice.call(cfb); break;
	}
	prep_blob(cfb, 0);
	WB = ({content: cfb});
}
var WorkbookP;

var _data;
if(CompObj) parse_compobj(CompObj);
if(options.bookProps && !options.bookSheets) WorkbookP = ({});
else {
	var T = has_buf ? 'buffer' : 'array';
	if(WB && WB.content) WorkbookP = parse_workbook(WB.content, options);
	/* Quattro Pro 7-8 */
	else if((_data=CFB.find(cfb, 'PerfectOffice_MAIN')) && _data.content) WorkbookP = WK_.to_workbook(_data.content, (options.type = T, options));
	/* Quattro Pro 9 */
	else if((_data=CFB.find(cfb, 'NativeContent_MAIN')) && _data.content) WorkbookP = WK_.to_workbook(_data.content, (options.type = T, options));
	/* Works 4 for Mac */
	else if((_data=CFB.find(cfb, 'MN0')) && _data.content) throw new Error("Unsupported Works 4 for Mac file");
	else throw new Error("Cannot find Workbook stream");
	if(options.bookVBA && cfb.FullPaths && CFB.find(cfb, '/_VBA_PROJECT_CUR/VBA/dir')) WorkbookP.vbaraw = make_vba_xls(cfb);
}

var props = {};
if(cfb.FullPaths) parse_xls_props(cfb, props, options);

WorkbookP.Props = WorkbookP.Custprops = props; /* TODO: split up properties */
if(options.bookFiles) WorkbookP.cfb = cfb;
/*WorkbookP.CompObjP = CompObjP; // TODO: storage? */
return WorkbookP;
}


function write_xlscfb(wb, opts) {
	var o = opts || {};
	var cfb = CFB.utils.cfb_new({root:"R"});
	var wbpath = "/Workbook";
	switch(o.bookType || "xls") {
		case "xls": o.bookType = "biff8";
		/* falls through */
		case "xla": if(!o.bookType) o.bookType = "xla";
		/* falls through */
		case "biff8": wbpath = "/Workbook"; o.biff = 8; break;
		case "biff5": wbpath = "/Book"; o.biff = 5; break;
		default: throw new Error("invalid type " + o.bookType + " for XLS CFB");
	}
	CFB.utils.cfb_add(cfb, wbpath, write_biff_buf(wb, o));
	if(o.biff == 8 && (wb.Props || wb.Custprops)) write_xls_props(wb, cfb);
	// TODO: SI, DSI, CO
	if(o.biff == 8 && wb.vbaraw) fill_vba_xls(cfb, CFB.read(wb.vbaraw, {type: typeof wb.vbaraw == "string" ? "binary" : "buffer"}));
	return cfb;
}
/* [MS-XLSB] 2.3 Record Enumeration */
var XLSBRecordEnum = {
	0x0000: { /* n:"BrtRowHdr", */ f:parse_BrtRowHdr },
	0x0001: { /* n:"BrtCellBlank", */ f:parse_BrtCellBlank },
	0x0002: { /* n:"BrtCellRk", */ f:parse_BrtCellRk },
	0x0003: { /* n:"BrtCellError", */ f:parse_BrtCellError },
	0x0004: { /* n:"BrtCellBool", */ f:parse_BrtCellBool },
	0x0005: { /* n:"BrtCellReal", */ f:parse_BrtCellReal },
	0x0006: { /* n:"BrtCellSt", */ f:parse_BrtCellSt },
	0x0007: { /* n:"BrtCellIsst", */ f:parse_BrtCellIsst },
	0x0008: { /* n:"BrtFmlaString", */ f:parse_BrtFmlaString },
	0x0009: { /* n:"BrtFmlaNum", */ f:parse_BrtFmlaNum },
	0x000A: { /* n:"BrtFmlaBool", */ f:parse_BrtFmlaBool },
	0x000B: { /* n:"BrtFmlaError", */ f:parse_BrtFmlaError },
	0x000C: { /* n:"BrtShortBlank", */ f:parse_BrtShortBlank },
	0x000D: { /* n:"BrtShortRk", */ f:parse_BrtShortRk },
	0x000E: { /* n:"BrtShortError", */ f:parse_BrtShortError },
	0x000F: { /* n:"BrtShortBool", */ f:parse_BrtShortBool },
	0x0010: { /* n:"BrtShortReal", */ f:parse_BrtShortReal },
	0x0011: { /* n:"BrtShortSt", */ f:parse_BrtShortSt },
	0x0012: { /* n:"BrtShortIsst", */ f:parse_BrtShortIsst },
	0x0013: { /* n:"BrtSSTItem", */ f:parse_RichStr },
	0x0014: { /* n:"BrtPCDIMissing" */ },
	0x0015: { /* n:"BrtPCDINumber" */ },
	0x0016: { /* n:"BrtPCDIBoolean" */ },
	0x0017: { /* n:"BrtPCDIError" */ },
	0x0018: { /* n:"BrtPCDIString" */ },
	0x0019: { /* n:"BrtPCDIDatetime" */ },
	0x001A: { /* n:"BrtPCDIIndex" */ },
	0x001B: { /* n:"BrtPCDIAMissing" */ },
	0x001C: { /* n:"BrtPCDIANumber" */ },
	0x001D: { /* n:"BrtPCDIABoolean" */ },
	0x001E: { /* n:"BrtPCDIAError" */ },
	0x001F: { /* n:"BrtPCDIAString" */ },
	0x0020: { /* n:"BrtPCDIADatetime" */ },
	0x0021: { /* n:"BrtPCRRecord" */ },
	0x0022: { /* n:"BrtPCRRecordDt" */ },
	0x0023: { /* n:"BrtFRTBegin", */ T:1 },
	0x0024: { /* n:"BrtFRTEnd", */ T:-1 },
	0x0025: { /* n:"BrtACBegin", */ T:1 },
	0x0026: { /* n:"BrtACEnd", */ T:-1 },
	0x0027: { /* n:"BrtName", */ f:parse_BrtName },
	0x0028: { /* n:"BrtIndexRowBlock" */ },
	0x002A: { /* n:"BrtIndexBlock" */ },
	0x002B: { /* n:"BrtFont", */ f:parse_BrtFont },
	0x002C: { /* n:"BrtFmt", */ f:parse_BrtFmt },
	0x002D: { /* n:"BrtFill", */ f:parse_BrtFill },
	0x002E: { /* n:"BrtBorder", */ f:parse_BrtBorder },
	0x002F: { /* n:"BrtXF", */ f:parse_BrtXF },
	0x0030: { /* n:"BrtStyle" */ },
	0x0031: { /* n:"BrtCellMeta", */ f:parse_Int32LE },
	0x0032: { /* n:"BrtValueMeta" */ },
	0x0033: { /* n:"BrtMdb" */ f:parse_BrtMdb },
	0x0034: { /* n:"BrtBeginFmd", */ T:1 },
	0x0035: { /* n:"BrtEndFmd", */ T:-1 },
	0x0036: { /* n:"BrtBeginMdx", */ T:1 },
	0x0037: { /* n:"BrtEndMdx", */ T:-1 },
	0x0038: { /* n:"BrtBeginMdxTuple", */ T:1 },
	0x0039: { /* n:"BrtEndMdxTuple", */ T:-1 },
	0x003A: { /* n:"BrtMdxMbrIstr" */ },
	0x003B: { /* n:"BrtStr" */ },
	0x003C: { /* n:"BrtColInfo", */ f:parse_ColInfo },
	0x003E: { /* n:"BrtCellRString", */ f:parse_BrtCellRString },
	0x003F: { /* n:"BrtCalcChainItem$", */ f:parse_BrtCalcChainItem$ },
	0x0040: { /* n:"BrtDVal", */ f:parse_BrtDVal },
	0x0041: { /* n:"BrtSxvcellNum" */ },
	0x0042: { /* n:"BrtSxvcellStr" */ },
	0x0043: { /* n:"BrtSxvcellBool" */ },
	0x0044: { /* n:"BrtSxvcellErr" */ },
	0x0045: { /* n:"BrtSxvcellDate" */ },
	0x0046: { /* n:"BrtSxvcellNil" */ },
	0x0080: { /* n:"BrtFileVersion" */ },
	0x0081: { /* n:"BrtBeginSheet", */ T:1 },
	0x0082: { /* n:"BrtEndSheet", */ T:-1 },
	0x0083: { /* n:"BrtBeginBook", */ T:1, f:parsenoop, p:0 },
	0x0084: { /* n:"BrtEndBook", */ T:-1 },
	0x0085: { /* n:"BrtBeginWsViews", */ T:1 },
	0x0086: { /* n:"BrtEndWsViews", */ T:-1 },
	0x0087: { /* n:"BrtBeginBookViews", */ T:1 },
	0x0088: { /* n:"BrtEndBookViews", */ T:-1 },
	0x0089: { /* n:"BrtBeginWsView", */ T:1, f:parse_BrtBeginWsView },
	0x008A: { /* n:"BrtEndWsView", */ T:-1 },
	0x008B: { /* n:"BrtBeginCsViews", */ T:1 },
	0x008C: { /* n:"BrtEndCsViews", */ T:-1 },
	0x008D: { /* n:"BrtBeginCsView", */ T:1 },
	0x008E: { /* n:"BrtEndCsView", */ T:-1 },
	0x008F: { /* n:"BrtBeginBundleShs", */ T:1 },
	0x0090: { /* n:"BrtEndBundleShs", */ T:-1 },
	0x0091: { /* n:"BrtBeginSheetData", */ T:1 },
	0x0092: { /* n:"BrtEndSheetData", */ T:-1 },
	0x0093: { /* n:"BrtWsProp", */ f:parse_BrtWsProp },
	0x0094: { /* n:"BrtWsDim", */ f:parse_BrtWsDim, p:16 },
	0x0097: { /* n:"BrtPane", */ f:parse_BrtPane },
	0x0098: { /* n:"BrtSel" */ },
	0x0099: { /* n:"BrtWbProp", */ f:parse_BrtWbProp },
	0x009A: { /* n:"BrtWbFactoid" */ },
	0x009B: { /* n:"BrtFileRecover" */ },
	0x009C: { /* n:"BrtBundleSh", */ f:parse_BrtBundleSh },
	0x009D: { /* n:"BrtCalcProp" */ },
	0x009E: { /* n:"BrtBookView" */ },
	0x009F: { /* n:"BrtBeginSst", */ T:1, f:parse_BrtBeginSst },
	0x00A0: { /* n:"BrtEndSst", */ T:-1 },
	0x00A1: { /* n:"BrtBeginAFilter", */ T:1, f:parse_UncheckedRfX },
	0x00A2: { /* n:"BrtEndAFilter", */ T:-1 },
	0x00A3: { /* n:"BrtBeginFilterColumn", */ T:1 },
	0x00A4: { /* n:"BrtEndFilterColumn", */ T:-1 },
	0x00A5: { /* n:"BrtBeginFilters", */ T:1 },
	0x00A6: { /* n:"BrtEndFilters", */ T:-1 },
	0x00A7: { /* n:"BrtFilter" */ },
	0x00A8: { /* n:"BrtColorFilter" */ },
	0x00A9: { /* n:"BrtIconFilter" */ },
	0x00AA: { /* n:"BrtTop10Filter" */ },
	0x00AB: { /* n:"BrtDynamicFilter" */ },
	0x00AC: { /* n:"BrtBeginCustomFilters", */ T:1 },
	0x00AD: { /* n:"BrtEndCustomFilters", */ T:-1 },
	0x00AE: { /* n:"BrtCustomFilter" */ },
	0x00AF: { /* n:"BrtAFilterDateGroupItem" */ },
	0x00B0: { /* n:"BrtMergeCell", */ f:parse_BrtMergeCell },
	0x00B1: { /* n:"BrtBeginMergeCells", */ T:1 },
	0x00B2: { /* n:"BrtEndMergeCells", */ T:-1 },
	0x00B3: { /* n:"BrtBeginPivotCacheDef", */ T:1 },
	0x00B4: { /* n:"BrtEndPivotCacheDef", */ T:-1 },
	0x00B5: { /* n:"BrtBeginPCDFields", */ T:1 },
	0x00B6: { /* n:"BrtEndPCDFields", */ T:-1 },
	0x00B7: { /* n:"BrtBeginPCDField", */ T:1 },
	0x00B8: { /* n:"BrtEndPCDField", */ T:-1 },
	0x00B9: { /* n:"BrtBeginPCDSource", */ T:1 },
	0x00BA: { /* n:"BrtEndPCDSource", */ T:-1 },
	0x00BB: { /* n:"BrtBeginPCDSRange", */ T:1 },
	0x00BC: { /* n:"BrtEndPCDSRange", */ T:-1 },
	0x00BD: { /* n:"BrtBeginPCDFAtbl", */ T:1 },
	0x00BE: { /* n:"BrtEndPCDFAtbl", */ T:-1 },
	0x00BF: { /* n:"BrtBeginPCDIRun", */ T:1 },
	0x00C0: { /* n:"BrtEndPCDIRun", */ T:-1 },
	0x00C1: { /* n:"BrtBeginPivotCacheRecords", */ T:1 },
	0x00C2: { /* n:"BrtEndPivotCacheRecords", */ T:-1 },
	0x00C3: { /* n:"BrtBeginPCDHierarchies", */ T:1 },
	0x00C4: { /* n:"BrtEndPCDHierarchies", */ T:-1 },
	0x00C5: { /* n:"BrtBeginPCDHierarchy", */ T:1 },
	0x00C6: { /* n:"BrtEndPCDHierarchy", */ T:-1 },
	0x00C7: { /* n:"BrtBeginPCDHFieldsUsage", */ T:1 },
	0x00C8: { /* n:"BrtEndPCDHFieldsUsage", */ T:-1 },
	0x00C9: { /* n:"BrtBeginExtConnection", */ T:1 },
	0x00CA: { /* n:"BrtEndExtConnection", */ T:-1 },
	0x00CB: { /* n:"BrtBeginECDbProps", */ T:1 },
	0x00CC: { /* n:"BrtEndECDbProps", */ T:-1 },
	0x00CD: { /* n:"BrtBeginECOlapProps", */ T:1 },
	0x00CE: { /* n:"BrtEndECOlapProps", */ T:-1 },
	0x00CF: { /* n:"BrtBeginPCDSConsol", */ T:1 },
	0x00D0: { /* n:"BrtEndPCDSConsol", */ T:-1 },
	0x00D1: { /* n:"BrtBeginPCDSCPages", */ T:1 },
	0x00D2: { /* n:"BrtEndPCDSCPages", */ T:-1 },
	0x00D3: { /* n:"BrtBeginPCDSCPage", */ T:1 },
	0x00D4: { /* n:"BrtEndPCDSCPage", */ T:-1 },
	0x00D5: { /* n:"BrtBeginPCDSCPItem", */ T:1 },
	0x00D6: { /* n:"BrtEndPCDSCPItem", */ T:-1 },
	0x00D7: { /* n:"BrtBeginPCDSCSets", */ T:1 },
	0x00D8: { /* n:"BrtEndPCDSCSets", */ T:-1 },
	0x00D9: { /* n:"BrtBeginPCDSCSet", */ T:1 },
	0x00DA: { /* n:"BrtEndPCDSCSet", */ T:-1 },
	0x00DB: { /* n:"BrtBeginPCDFGroup", */ T:1 },
	0x00DC: { /* n:"BrtEndPCDFGroup", */ T:-1 },
	0x00DD: { /* n:"BrtBeginPCDFGItems", */ T:1 },
	0x00DE: { /* n:"BrtEndPCDFGItems", */ T:-1 },
	0x00DF: { /* n:"BrtBeginPCDFGRange", */ T:1 },
	0x00E0: { /* n:"BrtEndPCDFGRange", */ T:-1 },
	0x00E1: { /* n:"BrtBeginPCDFGDiscrete", */ T:1 },
	0x00E2: { /* n:"BrtEndPCDFGDiscrete", */ T:-1 },
	0x00E3: { /* n:"BrtBeginPCDSDTupleCache", */ T:1 },
	0x00E4: { /* n:"BrtEndPCDSDTupleCache", */ T:-1 },
	0x00E5: { /* n:"BrtBeginPCDSDTCEntries", */ T:1 },
	0x00E6: { /* n:"BrtEndPCDSDTCEntries", */ T:-1 },
	0x00E7: { /* n:"BrtBeginPCDSDTCEMembers", */ T:1 },
	0x00E8: { /* n:"BrtEndPCDSDTCEMembers", */ T:-1 },
	0x00E9: { /* n:"BrtBeginPCDSDTCEMember", */ T:1 },
	0x00EA: { /* n:"BrtEndPCDSDTCEMember", */ T:-1 },
	0x00EB: { /* n:"BrtBeginPCDSDTCQueries", */ T:1 },
	0x00EC: { /* n:"BrtEndPCDSDTCQueries", */ T:-1 },
	0x00ED: { /* n:"BrtBeginPCDSDTCQuery", */ T:1 },
	0x00EE: { /* n:"BrtEndPCDSDTCQuery", */ T:-1 },
	0x00EF: { /* n:"BrtBeginPCDSDTCSets", */ T:1 },
	0x00F0: { /* n:"BrtEndPCDSDTCSets", */ T:-1 },
	0x00F1: { /* n:"BrtBeginPCDSDTCSet", */ T:1 },
	0x00F2: { /* n:"BrtEndPCDSDTCSet", */ T:-1 },
	0x00F3: { /* n:"BrtBeginPCDCalcItems", */ T:1 },
	0x00F4: { /* n:"BrtEndPCDCalcItems", */ T:-1 },
	0x00F5: { /* n:"BrtBeginPCDCalcItem", */ T:1 },
	0x00F6: { /* n:"BrtEndPCDCalcItem", */ T:-1 },
	0x00F7: { /* n:"BrtBeginPRule", */ T:1 },
	0x00F8: { /* n:"BrtEndPRule", */ T:-1 },
	0x00F9: { /* n:"BrtBeginPRFilters", */ T:1 },
	0x00FA: { /* n:"BrtEndPRFilters", */ T:-1 },
	0x00FB: { /* n:"BrtBeginPRFilter", */ T:1 },
	0x00FC: { /* n:"BrtEndPRFilter", */ T:-1 },
	0x00FD: { /* n:"BrtBeginPNames", */ T:1 },
	0x00FE: { /* n:"BrtEndPNames", */ T:-1 },
	0x00FF: { /* n:"BrtBeginPName", */ T:1 },
	0x0100: { /* n:"BrtEndPName", */ T:-1 },
	0x0101: { /* n:"BrtBeginPNPairs", */ T:1 },
	0x0102: { /* n:"BrtEndPNPairs", */ T:-1 },
	0x0103: { /* n:"BrtBeginPNPair", */ T:1 },
	0x0104: { /* n:"BrtEndPNPair", */ T:-1 },
	0x0105: { /* n:"BrtBeginECWebProps", */ T:1 },
	0x0106: { /* n:"BrtEndECWebProps", */ T:-1 },
	0x0107: { /* n:"BrtBeginEcWpTables", */ T:1 },
	0x0108: { /* n:"BrtEndECWPTables", */ T:-1 },
	0x0109: { /* n:"BrtBeginECParams", */ T:1 },
	0x010A: { /* n:"BrtEndECParams", */ T:-1 },
	0x010B: { /* n:"BrtBeginECParam", */ T:1 },
	0x010C: { /* n:"BrtEndECParam", */ T:-1 },
	0x010D: { /* n:"BrtBeginPCDKPIs", */ T:1 },
	0x010E: { /* n:"BrtEndPCDKPIs", */ T:-1 },
	0x010F: { /* n:"BrtBeginPCDKPI", */ T:1 },
	0x0110: { /* n:"BrtEndPCDKPI", */ T:-1 },
	0x0111: { /* n:"BrtBeginDims", */ T:1 },
	0x0112: { /* n:"BrtEndDims", */ T:-1 },
	0x0113: { /* n:"BrtBeginDim", */ T:1 },
	0x0114: { /* n:"BrtEndDim", */ T:-1 },
	0x0115: { /* n:"BrtIndexPartEnd" */ },
	0x0116: { /* n:"BrtBeginStyleSheet", */ T:1 },
	0x0117: { /* n:"BrtEndStyleSheet", */ T:-1 },
	0x0118: { /* n:"BrtBeginSXView", */ T:1 },
	0x0119: { /* n:"BrtEndSXVI", */ T:-1 },
	0x011A: { /* n:"BrtBeginSXVI", */ T:1 },
	0x011B: { /* n:"BrtBeginSXVIs", */ T:1 },
	0x011C: { /* n:"BrtEndSXVIs", */ T:-1 },
	0x011D: { /* n:"BrtBeginSXVD", */ T:1 },
	0x011E: { /* n:"BrtEndSXVD", */ T:-1 },
	0x011F: { /* n:"BrtBeginSXVDs", */ T:1 },
	0x0120: { /* n:"BrtEndSXVDs", */ T:-1 },
	0x0121: { /* n:"BrtBeginSXPI", */ T:1 },
	0x0122: { /* n:"BrtEndSXPI", */ T:-1 },
	0x0123: { /* n:"BrtBeginSXPIs", */ T:1 },
	0x0124: { /* n:"BrtEndSXPIs", */ T:-1 },
	0x0125: { /* n:"BrtBeginSXDI", */ T:1 },
	0x0126: { /* n:"BrtEndSXDI", */ T:-1 },
	0x0127: { /* n:"BrtBeginSXDIs", */ T:1 },
	0x0128: { /* n:"BrtEndSXDIs", */ T:-1 },
	0x0129: { /* n:"BrtBeginSXLI", */ T:1 },
	0x012A: { /* n:"BrtEndSXLI", */ T:-1 },
	0x012B: { /* n:"BrtBeginSXLIRws", */ T:1 },
	0x012C: { /* n:"BrtEndSXLIRws", */ T:-1 },
	0x012D: { /* n:"BrtBeginSXLICols", */ T:1 },
	0x012E: { /* n:"BrtEndSXLICols", */ T:-1 },
	0x012F: { /* n:"BrtBeginSXFormat", */ T:1 },
	0x0130: { /* n:"BrtEndSXFormat", */ T:-1 },
	0x0131: { /* n:"BrtBeginSXFormats", */ T:1 },
	0x0132: { /* n:"BrtEndSxFormats", */ T:-1 },
	0x0133: { /* n:"BrtBeginSxSelect", */ T:1 },
	0x0134: { /* n:"BrtEndSxSelect", */ T:-1 },
	0x0135: { /* n:"BrtBeginISXVDRws", */ T:1 },
	0x0136: { /* n:"BrtEndISXVDRws", */ T:-1 },
	0x0137: { /* n:"BrtBeginISXVDCols", */ T:1 },
	0x0138: { /* n:"BrtEndISXVDCols", */ T:-1 },
	0x0139: { /* n:"BrtEndSXLocation", */ T:-1 },
	0x013A: { /* n:"BrtBeginSXLocation", */ T:1 },
	0x013B: { /* n:"BrtEndSXView", */ T:-1 },
	0x013C: { /* n:"BrtBeginSXTHs", */ T:1 },
	0x013D: { /* n:"BrtEndSXTHs", */ T:-1 },
	0x013E: { /* n:"BrtBeginSXTH", */ T:1 },
	0x013F: { /* n:"BrtEndSXTH", */ T:-1 },
	0x0140: { /* n:"BrtBeginISXTHRws", */ T:1 },
	0x0141: { /* n:"BrtEndISXTHRws", */ T:-1 },
	0x0142: { /* n:"BrtBeginISXTHCols", */ T:1 },
	0x0143: { /* n:"BrtEndISXTHCols", */ T:-1 },
	0x0144: { /* n:"BrtBeginSXTDMPS", */ T:1 },
	0x0145: { /* n:"BrtEndSXTDMPs", */ T:-1 },
	0x0146: { /* n:"BrtBeginSXTDMP", */ T:1 },
	0x0147: { /* n:"BrtEndSXTDMP", */ T:-1 },
	0x0148: { /* n:"BrtBeginSXTHItems", */ T:1 },
	0x0149: { /* n:"BrtEndSXTHItems", */ T:-1 },
	0x014A: { /* n:"BrtBeginSXTHItem", */ T:1 },
	0x014B: { /* n:"BrtEndSXTHItem", */ T:-1 },
	0x014C: { /* n:"BrtBeginMetadata", */ T:1 },
	0x014D: { /* n:"BrtEndMetadata", */ T:-1 },
	0x014E: { /* n:"BrtBeginEsmdtinfo", */ T:1 },
	0x014F: { /* n:"BrtMdtinfo", */ f:parse_BrtMdtinfo },
	0x0150: { /* n:"BrtEndEsmdtinfo", */ T:-1 },
	0x0151: { /* n:"BrtBeginEsmdb", */ f:parse_BrtBeginEsmdb, T:1 },
	0x0152: { /* n:"BrtEndEsmdb", */ T:-1 },
	0x0153: { /* n:"BrtBeginEsfmd", */ T:1 },
	0x0154: { /* n:"BrtEndEsfmd", */ T:-1 },
	0x0155: { /* n:"BrtBeginSingleCells", */ T:1 },
	0x0156: { /* n:"BrtEndSingleCells", */ T:-1 },
	0x0157: { /* n:"BrtBeginList", */ T:1 },
	0x0158: { /* n:"BrtEndList", */ T:-1 },
	0x0159: { /* n:"BrtBeginListCols", */ T:1 },
	0x015A: { /* n:"BrtEndListCols", */ T:-1 },
	0x015B: { /* n:"BrtBeginListCol", */ T:1 },
	0x015C: { /* n:"BrtEndListCol", */ T:-1 },
	0x015D: { /* n:"BrtBeginListXmlCPr", */ T:1 },
	0x015E: { /* n:"BrtEndListXmlCPr", */ T:-1 },
	0x015F: { /* n:"BrtListCCFmla" */ },
	0x0160: { /* n:"BrtListTrFmla" */ },
	0x0161: { /* n:"BrtBeginExternals", */ T:1 },
	0x0162: { /* n:"BrtEndExternals", */ T:-1 },
	0x0163: { /* n:"BrtSupBookSrc", */ f:parse_RelID},
	0x0165: { /* n:"BrtSupSelf" */ },
	0x0166: { /* n:"BrtSupSame" */ },
	0x0167: { /* n:"BrtSupTabs" */ },
	0x0168: { /* n:"BrtBeginSupBook", */ T:1 },
	0x0169: { /* n:"BrtPlaceholderName" */ },
	0x016A: { /* n:"BrtExternSheet", */ f:parse_ExternSheet },
	0x016B: { /* n:"BrtExternTableStart" */ },
	0x016C: { /* n:"BrtExternTableEnd" */ },
	0x016E: { /* n:"BrtExternRowHdr" */ },
	0x016F: { /* n:"BrtExternCellBlank" */ },
	0x0170: { /* n:"BrtExternCellReal" */ },
	0x0171: { /* n:"BrtExternCellBool" */ },
	0x0172: { /* n:"BrtExternCellError" */ },
	0x0173: { /* n:"BrtExternCellString" */ },
	0x0174: { /* n:"BrtBeginEsmdx", */ T:1 },
	0x0175: { /* n:"BrtEndEsmdx", */ T:-1 },
	0x0176: { /* n:"BrtBeginMdxSet", */ T:1 },
	0x0177: { /* n:"BrtEndMdxSet", */ T:-1 },
	0x0178: { /* n:"BrtBeginMdxMbrProp", */ T:1 },
	0x0179: { /* n:"BrtEndMdxMbrProp", */ T:-1 },
	0x017A: { /* n:"BrtBeginMdxKPI", */ T:1 },
	0x017B: { /* n:"BrtEndMdxKPI", */ T:-1 },
	0x017C: { /* n:"BrtBeginEsstr", */ T:1 },
	0x017D: { /* n:"BrtEndEsstr", */ T:-1 },
	0x017E: { /* n:"BrtBeginPRFItem", */ T:1 },
	0x017F: { /* n:"BrtEndPRFItem", */ T:-1 },
	0x0180: { /* n:"BrtBeginPivotCacheIDs", */ T:1 },
	0x0181: { /* n:"BrtEndPivotCacheIDs", */ T:-1 },
	0x0182: { /* n:"BrtBeginPivotCacheID", */ T:1 },
	0x0183: { /* n:"BrtEndPivotCacheID", */ T:-1 },
	0x0184: { /* n:"BrtBeginISXVIs", */ T:1 },
	0x0185: { /* n:"BrtEndISXVIs", */ T:-1 },
	0x0186: { /* n:"BrtBeginColInfos", */ T:1 },
	0x0187: { /* n:"BrtEndColInfos", */ T:-1 },
	0x0188: { /* n:"BrtBeginRwBrk", */ T:1 },
	0x0189: { /* n:"BrtEndRwBrk", */ T:-1 },
	0x018A: { /* n:"BrtBeginColBrk", */ T:1 },
	0x018B: { /* n:"BrtEndColBrk", */ T:-1 },
	0x018C: { /* n:"BrtBrk" */ },
	0x018D: { /* n:"BrtUserBookView" */ },
	0x018E: { /* n:"BrtInfo" */ },
	0x018F: { /* n:"BrtCUsr" */ },
	0x0190: { /* n:"BrtUsr" */ },
	0x0191: { /* n:"BrtBeginUsers", */ T:1 },
	0x0193: { /* n:"BrtEOF" */ },
	0x0194: { /* n:"BrtUCR" */ },
	0x0195: { /* n:"BrtRRInsDel" */ },
	0x0196: { /* n:"BrtRREndInsDel" */ },
	0x0197: { /* n:"BrtRRMove" */ },
	0x0198: { /* n:"BrtRREndMove" */ },
	0x0199: { /* n:"BrtRRChgCell" */ },
	0x019A: { /* n:"BrtRREndChgCell" */ },
	0x019B: { /* n:"BrtRRHeader" */ },
	0x019C: { /* n:"BrtRRUserView" */ },
	0x019D: { /* n:"BrtRRRenSheet" */ },
	0x019E: { /* n:"BrtRRInsertSh" */ },
	0x019F: { /* n:"BrtRRDefName" */ },
	0x01A0: { /* n:"BrtRRNote" */ },
	0x01A1: { /* n:"BrtRRConflict" */ },
	0x01A2: { /* n:"BrtRRTQSIF" */ },
	0x01A3: { /* n:"BrtRRFormat" */ },
	0x01A4: { /* n:"BrtRREndFormat" */ },
	0x01A5: { /* n:"BrtRRAutoFmt" */ },
	0x01A6: { /* n:"BrtBeginUserShViews", */ T:1 },
	0x01A7: { /* n:"BrtBeginUserShView", */ T:1 },
	0x01A8: { /* n:"BrtEndUserShView", */ T:-1 },
	0x01A9: { /* n:"BrtEndUserShViews", */ T:-1 },
	0x01AA: { /* n:"BrtArrFmla", */ f:parse_BrtArrFmla },
	0x01AB: { /* n:"BrtShrFmla", */ f:parse_BrtShrFmla },
	0x01AC: { /* n:"BrtTable" */ },
	0x01AD: { /* n:"BrtBeginExtConnections", */ T:1 },
	0x01AE: { /* n:"BrtEndExtConnections", */ T:-1 },
	0x01AF: { /* n:"BrtBeginPCDCalcMems", */ T:1 },
	0x01B0: { /* n:"BrtEndPCDCalcMems", */ T:-1 },
	0x01B1: { /* n:"BrtBeginPCDCalcMem", */ T:1 },
	0x01B2: { /* n:"BrtEndPCDCalcMem", */ T:-1 },
	0x01B3: { /* n:"BrtBeginPCDHGLevels", */ T:1 },
	0x01B4: { /* n:"BrtEndPCDHGLevels", */ T:-1 },
	0x01B5: { /* n:"BrtBeginPCDHGLevel", */ T:1 },
	0x01B6: { /* n:"BrtEndPCDHGLevel", */ T:-1 },
	0x01B7: { /* n:"BrtBeginPCDHGLGroups", */ T:1 },
	0x01B8: { /* n:"BrtEndPCDHGLGroups", */ T:-1 },
	0x01B9: { /* n:"BrtBeginPCDHGLGroup", */ T:1 },
	0x01BA: { /* n:"BrtEndPCDHGLGroup", */ T:-1 },
	0x01BB: { /* n:"BrtBeginPCDHGLGMembers", */ T:1 },
	0x01BC: { /* n:"BrtEndPCDHGLGMembers", */ T:-1 },
	0x01BD: { /* n:"BrtBeginPCDHGLGMember", */ T:1 },
	0x01BE: { /* n:"BrtEndPCDHGLGMember", */ T:-1 },
	0x01BF: { /* n:"BrtBeginQSI", */ T:1 },
	0x01C0: { /* n:"BrtEndQSI", */ T:-1 },
	0x01C1: { /* n:"BrtBeginQSIR", */ T:1 },
	0x01C2: { /* n:"BrtEndQSIR", */ T:-1 },
	0x01C3: { /* n:"BrtBeginDeletedNames", */ T:1 },
	0x01C4: { /* n:"BrtEndDeletedNames", */ T:-1 },
	0x01C5: { /* n:"BrtBeginDeletedName", */ T:1 },
	0x01C6: { /* n:"BrtEndDeletedName", */ T:-1 },
	0x01C7: { /* n:"BrtBeginQSIFs", */ T:1 },
	0x01C8: { /* n:"BrtEndQSIFs", */ T:-1 },
	0x01C9: { /* n:"BrtBeginQSIF", */ T:1 },
	0x01CA: { /* n:"BrtEndQSIF", */ T:-1 },
	0x01CB: { /* n:"BrtBeginAutoSortScope", */ T:1 },
	0x01CC: { /* n:"BrtEndAutoSortScope", */ T:-1 },
	0x01CD: { /* n:"BrtBeginConditionalFormatting", */ T:1 },
	0x01CE: { /* n:"BrtEndConditionalFormatting", */ T:-1 },
	0x01CF: { /* n:"BrtBeginCFRule", */ T:1 },
	0x01D0: { /* n:"BrtEndCFRule", */ T:-1 },
	0x01D1: { /* n:"BrtBeginIconSet", */ T:1 },
	0x01D2: { /* n:"BrtEndIconSet", */ T:-1 },
	0x01D3: { /* n:"BrtBeginDatabar", */ T:1 },
	0x01D4: { /* n:"BrtEndDatabar", */ T:-1 },
	0x01D5: { /* n:"BrtBeginColorScale", */ T:1 },
	0x01D6: { /* n:"BrtEndColorScale", */ T:-1 },
	0x01D7: { /* n:"BrtCFVO" */ },
	0x01D8: { /* n:"BrtExternValueMeta" */ },
	0x01D9: { /* n:"BrtBeginColorPalette", */ T:1 },
	0x01DA: { /* n:"BrtEndColorPalette", */ T:-1 },
	0x01DB: { /* n:"BrtIndexedColor" */ },
	0x01DC: { /* n:"BrtMargins", */ f:parse_BrtMargins },
	0x01DD: { /* n:"BrtPrintOptions" */ },
	0x01DE: { /* n:"BrtPageSetup" */ },
	0x01DF: { /* n:"BrtBeginHeaderFooter", */ T:1 },
	0x01E0: { /* n:"BrtEndHeaderFooter", */ T:-1 },
	0x01E1: { /* n:"BrtBeginSXCrtFormat", */ T:1 },
	0x01E2: { /* n:"BrtEndSXCrtFormat", */ T:-1 },
	0x01E3: { /* n:"BrtBeginSXCrtFormats", */ T:1 },
	0x01E4: { /* n:"BrtEndSXCrtFormats", */ T:-1 },
	0x01E5: { /* n:"BrtWsFmtInfo", */ f:parse_BrtWsFmtInfo },
	0x01E6: { /* n:"BrtBeginMgs", */ T:1 },
	0x01E7: { /* n:"BrtEndMGs", */ T:-1 },
	0x01E8: { /* n:"BrtBeginMGMaps", */ T:1 },
	0x01E9: { /* n:"BrtEndMGMaps", */ T:-1 },
	0x01EA: { /* n:"BrtBeginMG", */ T:1 },
	0x01EB: { /* n:"BrtEndMG", */ T:-1 },
	0x01EC: { /* n:"BrtBeginMap", */ T:1 },
	0x01ED: { /* n:"BrtEndMap", */ T:-1 },
	0x01EE: { /* n:"BrtHLink", */ f:parse_BrtHLink },
	0x01EF: { /* n:"BrtBeginDCon", */ T:1 },
	0x01F0: { /* n:"BrtEndDCon", */ T:-1 },
	0x01F1: { /* n:"BrtBeginDRefs", */ T:1 },
	0x01F2: { /* n:"BrtEndDRefs", */ T:-1 },
	0x01F3: { /* n:"BrtDRef" */ },
	0x01F4: { /* n:"BrtBeginScenMan", */ T:1 },
	0x01F5: { /* n:"BrtEndScenMan", */ T:-1 },
	0x01F6: { /* n:"BrtBeginSct", */ T:1 },
	0x01F7: { /* n:"BrtEndSct", */ T:-1 },
	0x01F8: { /* n:"BrtSlc" */ },
	0x01F9: { /* n:"BrtBeginDXFs", */ T:1 },
	0x01FA: { /* n:"BrtEndDXFs", */ T:-1 },
	0x01FB: { /* n:"BrtDXF" */ },
	0x01FC: { /* n:"BrtBeginTableStyles", */ T:1 },
	0x01FD: { /* n:"BrtEndTableStyles", */ T:-1 },
	0x01FE: { /* n:"BrtBeginTableStyle", */ T:1 },
	0x01FF: { /* n:"BrtEndTableStyle", */ T:-1 },
	0x0200: { /* n:"BrtTableStyleElement" */ },
	0x0201: { /* n:"BrtTableStyleClient" */ },
	0x0202: { /* n:"BrtBeginVolDeps", */ T:1 },
	0x0203: { /* n:"BrtEndVolDeps", */ T:-1 },
	0x0204: { /* n:"BrtBeginVolType", */ T:1 },
	0x0205: { /* n:"BrtEndVolType", */ T:-1 },
	0x0206: { /* n:"BrtBeginVolMain", */ T:1 },
	0x0207: { /* n:"BrtEndVolMain", */ T:-1 },
	0x0208: { /* n:"BrtBeginVolTopic", */ T:1 },
	0x0209: { /* n:"BrtEndVolTopic", */ T:-1 },
	0x020A: { /* n:"BrtVolSubtopic" */ },
	0x020B: { /* n:"BrtVolRef" */ },
	0x020C: { /* n:"BrtVolNum" */ },
	0x020D: { /* n:"BrtVolErr" */ },
	0x020E: { /* n:"BrtVolStr" */ },
	0x020F: { /* n:"BrtVolBool" */ },
	0x0210: { /* n:"BrtBeginCalcChain$", */ T:1 },
	0x0211: { /* n:"BrtEndCalcChain$", */ T:-1 },
	0x0212: { /* n:"BrtBeginSortState", */ T:1 },
	0x0213: { /* n:"BrtEndSortState", */ T:-1 },
	0x0214: { /* n:"BrtBeginSortCond", */ T:1 },
	0x0215: { /* n:"BrtEndSortCond", */ T:-1 },
	0x0216: { /* n:"BrtBookProtection" */ },
	0x0217: { /* n:"BrtSheetProtection" */ },
	0x0218: { /* n:"BrtRangeProtection" */ },
	0x0219: { /* n:"BrtPhoneticInfo" */ },
	0x021A: { /* n:"BrtBeginECTxtWiz", */ T:1 },
	0x021B: { /* n:"BrtEndECTxtWiz", */ T:-1 },
	0x021C: { /* n:"BrtBeginECTWFldInfoLst", */ T:1 },
	0x021D: { /* n:"BrtEndECTWFldInfoLst", */ T:-1 },
	0x021E: { /* n:"BrtBeginECTwFldInfo", */ T:1 },
	0x0224: { /* n:"BrtFileSharing" */ },
	0x0225: { /* n:"BrtOleSize" */ },
	0x0226: { /* n:"BrtDrawing", */ f:parse_RelID },
	0x0227: { /* n:"BrtLegacyDrawing", */ f:parse_XLNullableWideString },
	0x0228: { /* n:"BrtLegacyDrawingHF" */ },
	0x0229: { /* n:"BrtWebOpt" */ },
	0x022A: { /* n:"BrtBeginWebPubItems", */ T:1 },
	0x022B: { /* n:"BrtEndWebPubItems", */ T:-1 },
	0x022C: { /* n:"BrtBeginWebPubItem", */ T:1 },
	0x022D: { /* n:"BrtEndWebPubItem", */ T:-1 },
	0x022E: { /* n:"BrtBeginSXCondFmt", */ T:1 },
	0x022F: { /* n:"BrtEndSXCondFmt", */ T:-1 },
	0x0230: { /* n:"BrtBeginSXCondFmts", */ T:1 },
	0x0231: { /* n:"BrtEndSXCondFmts", */ T:-1 },
	0x0232: { /* n:"BrtBkHim" */ },
	0x0234: { /* n:"BrtColor" */ },
	0x0235: { /* n:"BrtBeginIndexedColors", */ T:1 },
	0x0236: { /* n:"BrtEndIndexedColors", */ T:-1 },
	0x0239: { /* n:"BrtBeginMRUColors", */ T:1 },
	0x023A: { /* n:"BrtEndMRUColors", */ T:-1 },
	0x023C: { /* n:"BrtMRUColor" */ },
	0x023D: { /* n:"BrtBeginDVals", */ T:1 },
	0x023E: { /* n:"BrtEndDVals", */ T:-1 },
	0x0241: { /* n:"BrtSupNameStart" */ },
	0x0242: { /* n:"BrtSupNameValueStart" */ },
	0x0243: { /* n:"BrtSupNameValueEnd" */ },
	0x0244: { /* n:"BrtSupNameNum" */ },
	0x0245: { /* n:"BrtSupNameErr" */ },
	0x0246: { /* n:"BrtSupNameSt" */ },
	0x0247: { /* n:"BrtSupNameNil" */ },
	0x0248: { /* n:"BrtSupNameBool" */ },
	0x0249: { /* n:"BrtSupNameFmla" */ },
	0x024A: { /* n:"BrtSupNameBits" */ },
	0x024B: { /* n:"BrtSupNameEnd" */ },
	0x024C: { /* n:"BrtEndSupBook", */ T:-1 },
	0x024D: { /* n:"BrtCellSmartTagProperty" */ },
	0x024E: { /* n:"BrtBeginCellSmartTag", */ T:1 },
	0x024F: { /* n:"BrtEndCellSmartTag", */ T:-1 },
	0x0250: { /* n:"BrtBeginCellSmartTags", */ T:1 },
	0x0251: { /* n:"BrtEndCellSmartTags", */ T:-1 },
	0x0252: { /* n:"BrtBeginSmartTags", */ T:1 },
	0x0253: { /* n:"BrtEndSmartTags", */ T:-1 },
	0x0254: { /* n:"BrtSmartTagType" */ },
	0x0255: { /* n:"BrtBeginSmartTagTypes", */ T:1 },
	0x0256: { /* n:"BrtEndSmartTagTypes", */ T:-1 },
	0x0257: { /* n:"BrtBeginSXFilters", */ T:1 },
	0x0258: { /* n:"BrtEndSXFilters", */ T:-1 },
	0x0259: { /* n:"BrtBeginSXFILTER", */ T:1 },
	0x025A: { /* n:"BrtEndSXFilter", */ T:-1 },
	0x025B: { /* n:"BrtBeginFills", */ T:1 },
	0x025C: { /* n:"BrtEndFills", */ T:-1 },
	0x025D: { /* n:"BrtBeginCellWatches", */ T:1 },
	0x025E: { /* n:"BrtEndCellWatches", */ T:-1 },
	0x025F: { /* n:"BrtCellWatch" */ },
	0x0260: { /* n:"BrtBeginCRErrs", */ T:1 },
	0x0261: { /* n:"BrtEndCRErrs", */ T:-1 },
	0x0262: { /* n:"BrtCrashRecErr" */ },
	0x0263: { /* n:"BrtBeginFonts", */ T:1 },
	0x0264: { /* n:"BrtEndFonts", */ T:-1 },
	0x0265: { /* n:"BrtBeginBorders", */ T:1 },
	0x0266: { /* n:"BrtEndBorders", */ T:-1 },
	0x0267: { /* n:"BrtBeginFmts", */ T:1 },
	0x0268: { /* n:"BrtEndFmts", */ T:-1 },
	0x0269: { /* n:"BrtBeginCellXFs", */ T:1 },
	0x026A: { /* n:"BrtEndCellXFs", */ T:-1 },
	0x026B: { /* n:"BrtBeginStyles", */ T:1 },
	0x026C: { /* n:"BrtEndStyles", */ T:-1 },
	0x0271: { /* n:"BrtBigName" */ },
	0x0272: { /* n:"BrtBeginCellStyleXFs", */ T:1 },
	0x0273: { /* n:"BrtEndCellStyleXFs", */ T:-1 },
	0x0274: { /* n:"BrtBeginComments", */ T:1 },
	0x0275: { /* n:"BrtEndComments", */ T:-1 },
	0x0276: { /* n:"BrtBeginCommentAuthors", */ T:1 },
	0x0277: { /* n:"BrtEndCommentAuthors", */ T:-1 },
	0x0278: { /* n:"BrtCommentAuthor", */ f:parse_BrtCommentAuthor },
	0x0279: { /* n:"BrtBeginCommentList", */ T:1 },
	0x027A: { /* n:"BrtEndCommentList", */ T:-1 },
	0x027B: { /* n:"BrtBeginComment", */ T:1, f:parse_BrtBeginComment},
	0x027C: { /* n:"BrtEndComment", */ T:-1 },
	0x027D: { /* n:"BrtCommentText", */ f:parse_BrtCommentText },
	0x027E: { /* n:"BrtBeginOleObjects", */ T:1 },
	0x027F: { /* n:"BrtOleObject" */ },
	0x0280: { /* n:"BrtEndOleObjects", */ T:-1 },
	0x0281: { /* n:"BrtBeginSxrules", */ T:1 },
	0x0282: { /* n:"BrtEndSxRules", */ T:-1 },
	0x0283: { /* n:"BrtBeginActiveXControls", */ T:1 },
	0x0284: { /* n:"BrtActiveX" */ },
	0x0285: { /* n:"BrtEndActiveXControls", */ T:-1 },
	0x0286: { /* n:"BrtBeginPCDSDTCEMembersSortBy", */ T:1 },
	0x0288: { /* n:"BrtBeginCellIgnoreECs", */ T:1 },
	0x0289: { /* n:"BrtCellIgnoreEC" */ },
	0x028A: { /* n:"BrtEndCellIgnoreECs", */ T:-1 },
	0x028B: { /* n:"BrtCsProp", */ f:parse_BrtCsProp },
	0x028C: { /* n:"BrtCsPageSetup" */ },
	0x028D: { /* n:"BrtBeginUserCsViews", */ T:1 },
	0x028E: { /* n:"BrtEndUserCsViews", */ T:-1 },
	0x028F: { /* n:"BrtBeginUserCsView", */ T:1 },
	0x0290: { /* n:"BrtEndUserCsView", */ T:-1 },
	0x0291: { /* n:"BrtBeginPcdSFCIEntries", */ T:1 },
	0x0292: { /* n:"BrtEndPCDSFCIEntries", */ T:-1 },
	0x0293: { /* n:"BrtPCDSFCIEntry" */ },
	0x0294: { /* n:"BrtBeginListParts", */ T:1 },
	0x0295: { /* n:"BrtListPart" */ },
	0x0296: { /* n:"BrtEndListParts", */ T:-1 },
	0x0297: { /* n:"BrtSheetCalcProp" */ },
	0x0298: { /* n:"BrtBeginFnGroup", */ T:1 },
	0x0299: { /* n:"BrtFnGroup" */ },
	0x029A: { /* n:"BrtEndFnGroup", */ T:-1 },
	0x029B: { /* n:"BrtSupAddin" */ },
	0x029C: { /* n:"BrtSXTDMPOrder" */ },
	0x029D: { /* n:"BrtCsProtection" */ },
	0x029F: { /* n:"BrtBeginWsSortMap", */ T:1 },
	0x02A0: { /* n:"BrtEndWsSortMap", */ T:-1 },
	0x02A1: { /* n:"BrtBeginRRSort", */ T:1 },
	0x02A2: { /* n:"BrtEndRRSort", */ T:-1 },
	0x02A3: { /* n:"BrtRRSortItem" */ },
	0x02A4: { /* n:"BrtFileSharingIso" */ },
	0x02A5: { /* n:"BrtBookProtectionIso" */ },
	0x02A6: { /* n:"BrtSheetProtectionIso" */ },
	0x02A7: { /* n:"BrtCsProtectionIso" */ },
	0x02A8: { /* n:"BrtRangeProtectionIso" */ },
	0x02A9: { /* n:"BrtDValList" */ },
	0x0400: { /* n:"BrtRwDescent" */ },
	0x0401: { /* n:"BrtKnownFonts" */ },
	0x0402: { /* n:"BrtBeginSXTupleSet", */ T:1 },
	0x0403: { /* n:"BrtEndSXTupleSet", */ T:-1 },
	0x0404: { /* n:"BrtBeginSXTupleSetHeader", */ T:1 },
	0x0405: { /* n:"BrtEndSXTupleSetHeader", */ T:-1 },
	0x0406: { /* n:"BrtSXTupleSetHeaderItem" */ },
	0x0407: { /* n:"BrtBeginSXTupleSetData", */ T:1 },
	0x0408: { /* n:"BrtEndSXTupleSetData", */ T:-1 },
	0x0409: { /* n:"BrtBeginSXTupleSetRow", */ T:1 },
	0x040A: { /* n:"BrtEndSXTupleSetRow", */ T:-1 },
	0x040B: { /* n:"BrtSXTupleSetRowItem" */ },
	0x040C: { /* n:"BrtNameExt" */ },
	0x040D: { /* n:"BrtPCDH14" */ },
	0x040E: { /* n:"BrtBeginPCDCalcMem14", */ T:1 },
	0x040F: { /* n:"BrtEndPCDCalcMem14", */ T:-1 },
	0x0410: { /* n:"BrtSXTH14" */ },
	0x0411: { /* n:"BrtBeginSparklineGroup", */ T:1 },
	0x0412: { /* n:"BrtEndSparklineGroup", */ T:-1 },
	0x0413: { /* n:"BrtSparkline" */ },
	0x0414: { /* n:"BrtSXDI14" */ },
	0x0415: { /* n:"BrtWsFmtInfoEx14" */ },
	0x0416: { /* n:"BrtBeginConditionalFormatting14", */ T:1 },
	0x0417: { /* n:"BrtEndConditionalFormatting14", */ T:-1 },
	0x0418: { /* n:"BrtBeginCFRule14", */ T:1 },
	0x0419: { /* n:"BrtEndCFRule14", */ T:-1 },
	0x041A: { /* n:"BrtCFVO14" */ },
	0x041B: { /* n:"BrtBeginDatabar14", */ T:1 },
	0x041C: { /* n:"BrtBeginIconSet14", */ T:1 },
	0x041D: { /* n:"BrtDVal14", */ f: parse_BrtDVal14 },
	0x041E: { /* n:"BrtBeginDVals14", */ T:1 },
	0x041F: { /* n:"BrtColor14" */ },
	0x0420: { /* n:"BrtBeginSparklines", */ T:1 },
	0x0421: { /* n:"BrtEndSparklines", */ T:-1 },
	0x0422: { /* n:"BrtBeginSparklineGroups", */ T:1 },
	0x0423: { /* n:"BrtEndSparklineGroups", */ T:-1 },
	0x0425: { /* n:"BrtSXVD14" */ },
	0x0426: { /* n:"BrtBeginSXView14", */ T:1 },
	0x0427: { /* n:"BrtEndSXView14", */ T:-1 },
	0x0428: { /* n:"BrtBeginSXView16", */ T:1 },
	0x0429: { /* n:"BrtEndSXView16", */ T:-1 },
	0x042A: { /* n:"BrtBeginPCD14", */ T:1 },
	0x042B: { /* n:"BrtEndPCD14", */ T:-1 },
	0x042C: { /* n:"BrtBeginExtConn14", */ T:1 },
	0x042D: { /* n:"BrtEndExtConn14", */ T:-1 },
	0x042E: { /* n:"BrtBeginSlicerCacheIDs", */ T:1 },
	0x042F: { /* n:"BrtEndSlicerCacheIDs", */ T:-1 },
	0x0430: { /* n:"BrtBeginSlicerCacheID", */ T:1 },
	0x0431: { /* n:"BrtEndSlicerCacheID", */ T:-1 },
	0x0433: { /* n:"BrtBeginSlicerCache", */ T:1 },
	0x0434: { /* n:"BrtEndSlicerCache", */ T:-1 },
	0x0435: { /* n:"BrtBeginSlicerCacheDef", */ T:1 },
	0x0436: { /* n:"BrtEndSlicerCacheDef", */ T:-1 },
	0x0437: { /* n:"BrtBeginSlicersEx", */ T:1 },
	0x0438: { /* n:"BrtEndSlicersEx", */ T:-1 },
	0x0439: { /* n:"BrtBeginSlicerEx", */ T:1 },
	0x043A: { /* n:"BrtEndSlicerEx", */ T:-1 },
	0x043B: { /* n:"BrtBeginSlicer", */ T:1 },
	0x043C: { /* n:"BrtEndSlicer", */ T:-1 },
	0x043D: { /* n:"BrtSlicerCachePivotTables" */ },
	0x043E: { /* n:"BrtBeginSlicerCacheOlapImpl", */ T:1 },
	0x043F: { /* n:"BrtEndSlicerCacheOlapImpl", */ T:-1 },
	0x0440: { /* n:"BrtBeginSlicerCacheLevelsData", */ T:1 },
	0x0441: { /* n:"BrtEndSlicerCacheLevelsData", */ T:-1 },
	0x0442: { /* n:"BrtBeginSlicerCacheLevelData", */ T:1 },
	0x0443: { /* n:"BrtEndSlicerCacheLevelData", */ T:-1 },
	0x0444: { /* n:"BrtBeginSlicerCacheSiRanges", */ T:1 },
	0x0445: { /* n:"BrtEndSlicerCacheSiRanges", */ T:-1 },
	0x0446: { /* n:"BrtBeginSlicerCacheSiRange", */ T:1 },
	0x0447: { /* n:"BrtEndSlicerCacheSiRange", */ T:-1 },
	0x0448: { /* n:"BrtSlicerCacheOlapItem" */ },
	0x0449: { /* n:"BrtBeginSlicerCacheSelections", */ T:1 },
	0x044A: { /* n:"BrtSlicerCacheSelection" */ },
	0x044B: { /* n:"BrtEndSlicerCacheSelections", */ T:-1 },
	0x044C: { /* n:"BrtBeginSlicerCacheNative", */ T:1 },
	0x044D: { /* n:"BrtEndSlicerCacheNative", */ T:-1 },
	0x044E: { /* n:"BrtSlicerCacheNativeItem" */ },
	0x044F: { /* n:"BrtRangeProtection14" */ },
	0x0450: { /* n:"BrtRangeProtectionIso14" */ },
	0x0451: { /* n:"BrtCellIgnoreEC14" */ },
	0x0457: { /* n:"BrtList14" */ },
	0x0458: { /* n:"BrtCFIcon" */ },
	0x0459: { /* n:"BrtBeginSlicerCachesPivotCacheIDs", */ T:1 },
	0x045A: { /* n:"BrtEndSlicerCachesPivotCacheIDs", */ T:-1 },
	0x045B: { /* n:"BrtBeginSlicers", */ T:1 },
	0x045C: { /* n:"BrtEndSlicers", */ T:-1 },
	0x045D: { /* n:"BrtWbProp14" */ },
	0x045E: { /* n:"BrtBeginSXEdit", */ T:1 },
	0x045F: { /* n:"BrtEndSXEdit", */ T:-1 },
	0x0460: { /* n:"BrtBeginSXEdits", */ T:1 },
	0x0461: { /* n:"BrtEndSXEdits", */ T:-1 },
	0x0462: { /* n:"BrtBeginSXChange", */ T:1 },
	0x0463: { /* n:"BrtEndSXChange", */ T:-1 },
	0x0464: { /* n:"BrtBeginSXChanges", */ T:1 },
	0x0465: { /* n:"BrtEndSXChanges", */ T:-1 },
	0x0466: { /* n:"BrtSXTupleItems" */ },
	0x0468: { /* n:"BrtBeginSlicerStyle", */ T:1 },
	0x0469: { /* n:"BrtEndSlicerStyle", */ T:-1 },
	0x046A: { /* n:"BrtSlicerStyleElement" */ },
	0x046B: { /* n:"BrtBeginStyleSheetExt14", */ T:1 },
	0x046C: { /* n:"BrtEndStyleSheetExt14", */ T:-1 },
	0x046D: { /* n:"BrtBeginSlicerCachesPivotCacheID", */ T:1 },
	0x046E: { /* n:"BrtEndSlicerCachesPivotCacheID", */ T:-1 },
	0x046F: { /* n:"BrtBeginConditionalFormattings", */ T:1 },
	0x0470: { /* n:"BrtEndConditionalFormattings", */ T:-1 },
	0x0471: { /* n:"BrtBeginPCDCalcMemExt", */ T:1 },
	0x0472: { /* n:"BrtEndPCDCalcMemExt", */ T:-1 },
	0x0473: { /* n:"BrtBeginPCDCalcMemsExt", */ T:1 },
	0x0474: { /* n:"BrtEndPCDCalcMemsExt", */ T:-1 },
	0x0475: { /* n:"BrtPCDField14" */ },
	0x0476: { /* n:"BrtBeginSlicerStyles", */ T:1 },
	0x0477: { /* n:"BrtEndSlicerStyles", */ T:-1 },
	0x0478: { /* n:"BrtBeginSlicerStyleElements", */ T:1 },
	0x0479: { /* n:"BrtEndSlicerStyleElements", */ T:-1 },
	0x047A: { /* n:"BrtCFRuleExt" */ },
	0x047B: { /* n:"BrtBeginSXCondFmt14", */ T:1 },
	0x047C: { /* n:"BrtEndSXCondFmt14", */ T:-1 },
	0x047D: { /* n:"BrtBeginSXCondFmts14", */ T:1 },
	0x047E: { /* n:"BrtEndSXCondFmts14", */ T:-1 },
	0x0480: { /* n:"BrtBeginSortCond14", */ T:1 },
	0x0481: { /* n:"BrtEndSortCond14", */ T:-1 },
	0x0482: { /* n:"BrtEndDVals14", */ T:-1 },
	0x0483: { /* n:"BrtEndIconSet14", */ T:-1 },
	0x0484: { /* n:"BrtEndDatabar14", */ T:-1 },
	0x0485: { /* n:"BrtBeginColorScale14", */ T:1 },
	0x0486: { /* n:"BrtEndColorScale14", */ T:-1 },
	0x0487: { /* n:"BrtBeginSxrules14", */ T:1 },
	0x0488: { /* n:"BrtEndSxrules14", */ T:-1 },
	0x0489: { /* n:"BrtBeginPRule14", */ T:1 },
	0x048A: { /* n:"BrtEndPRule14", */ T:-1 },
	0x048B: { /* n:"BrtBeginPRFilters14", */ T:1 },
	0x048C: { /* n:"BrtEndPRFilters14", */ T:-1 },
	0x048D: { /* n:"BrtBeginPRFilter14", */ T:1 },
	0x048E: { /* n:"BrtEndPRFilter14", */ T:-1 },
	0x048F: { /* n:"BrtBeginPRFItem14", */ T:1 },
	0x0490: { /* n:"BrtEndPRFItem14", */ T:-1 },
	0x0491: { /* n:"BrtBeginCellIgnoreECs14", */ T:1 },
	0x0492: { /* n:"BrtEndCellIgnoreECs14", */ T:-1 },
	0x0493: { /* n:"BrtDxf14" */ },
	0x0494: { /* n:"BrtBeginDxF14s", */ T:1 },
	0x0495: { /* n:"BrtEndDxf14s", */ T:-1 },
	0x0499: { /* n:"BrtFilter14" */ },
	0x049A: { /* n:"BrtBeginCustomFilters14", */ T:1 },
	0x049C: { /* n:"BrtCustomFilter14" */ },
	0x049D: { /* n:"BrtIconFilter14" */ },
	0x049E: { /* n:"BrtPivotCacheConnectionName" */ },
	0x0800: { /* n:"BrtBeginDecoupledPivotCacheIDs", */ T:1 },
	0x0801: { /* n:"BrtEndDecoupledPivotCacheIDs", */ T:-1 },
	0x0802: { /* n:"BrtDecoupledPivotCacheID" */ },
	0x0803: { /* n:"BrtBeginPivotTableRefs", */ T:1 },
	0x0804: { /* n:"BrtEndPivotTableRefs", */ T:-1 },
	0x0805: { /* n:"BrtPivotTableRef" */ },
	0x0806: { /* n:"BrtSlicerCacheBookPivotTables" */ },
	0x0807: { /* n:"BrtBeginSxvcells", */ T:1 },
	0x0808: { /* n:"BrtEndSxvcells", */ T:-1 },
	0x0809: { /* n:"BrtBeginSxRow", */ T:1 },
	0x080A: { /* n:"BrtEndSxRow", */ T:-1 },
	0x080C: { /* n:"BrtPcdCalcMem15" */ },
	0x0813: { /* n:"BrtQsi15" */ },
	0x0814: { /* n:"BrtBeginWebExtensions", */ T:1 },
	0x0815: { /* n:"BrtEndWebExtensions", */ T:-1 },
	0x0816: { /* n:"BrtWebExtension" */ },
	0x0817: { /* n:"BrtAbsPath15" */ },
	0x0818: { /* n:"BrtBeginPivotTableUISettings", */ T:1 },
	0x0819: { /* n:"BrtEndPivotTableUISettings", */ T:-1 },
	0x081B: { /* n:"BrtTableSlicerCacheIDs" */ },
	0x081C: { /* n:"BrtTableSlicerCacheID" */ },
	0x081D: { /* n:"BrtBeginTableSlicerCache", */ T:1 },
	0x081E: { /* n:"BrtEndTableSlicerCache", */ T:-1 },
	0x081F: { /* n:"BrtSxFilter15" */ },
	0x0820: { /* n:"BrtBeginTimelineCachePivotCacheIDs", */ T:1 },
	0x0821: { /* n:"BrtEndTimelineCachePivotCacheIDs", */ T:-1 },
	0x0822: { /* n:"BrtTimelineCachePivotCacheID" */ },
	0x0823: { /* n:"BrtBeginTimelineCacheIDs", */ T:1 },
	0x0824: { /* n:"BrtEndTimelineCacheIDs", */ T:-1 },
	0x0825: { /* n:"BrtBeginTimelineCacheID", */ T:1 },
	0x0826: { /* n:"BrtEndTimelineCacheID", */ T:-1 },
	0x0827: { /* n:"BrtBeginTimelinesEx", */ T:1 },
	0x0828: { /* n:"BrtEndTimelinesEx", */ T:-1 },
	0x0829: { /* n:"BrtBeginTimelineEx", */ T:1 },
	0x082A: { /* n:"BrtEndTimelineEx", */ T:-1 },
	0x082B: { /* n:"BrtWorkBookPr15" */ },
	0x082C: { /* n:"BrtPCDH15" */ },
	0x082D: { /* n:"BrtBeginTimelineStyle", */ T:1 },
	0x082E: { /* n:"BrtEndTimelineStyle", */ T:-1 },
	0x082F: { /* n:"BrtTimelineStyleElement" */ },
	0x0830: { /* n:"BrtBeginTimelineStylesheetExt15", */ T:1 },
	0x0831: { /* n:"BrtEndTimelineStylesheetExt15", */ T:-1 },
	0x0832: { /* n:"BrtBeginTimelineStyles", */ T:1 },
	0x0833: { /* n:"BrtEndTimelineStyles", */ T:-1 },
	0x0834: { /* n:"BrtBeginTimelineStyleElements", */ T:1 },
	0x0835: { /* n:"BrtEndTimelineStyleElements", */ T:-1 },
	0x0836: { /* n:"BrtDxf15" */ },
	0x0837: { /* n:"BrtBeginDxfs15", */ T:1 },
	0x0838: { /* n:"BrtEndDxfs15", */ T:-1 },
	0x0839: { /* n:"BrtSlicerCacheHideItemsWithNoData" */ },
	0x083A: { /* n:"BrtBeginItemUniqueNames", */ T:1 },
	0x083B: { /* n:"BrtEndItemUniqueNames", */ T:-1 },
	0x083C: { /* n:"BrtItemUniqueName" */ },
	0x083D: { /* n:"BrtBeginExtConn15", */ T:1 },
	0x083E: { /* n:"BrtEndExtConn15", */ T:-1 },
	0x083F: { /* n:"BrtBeginOledbPr15", */ T:1 },
	0x0840: { /* n:"BrtEndOledbPr15", */ T:-1 },
	0x0841: { /* n:"BrtBeginDataFeedPr15", */ T:1 },
	0x0842: { /* n:"BrtEndDataFeedPr15", */ T:-1 },
	0x0843: { /* n:"BrtTextPr15" */ },
	0x0844: { /* n:"BrtRangePr15" */ },
	0x0845: { /* n:"BrtDbCommand15" */ },
	0x0846: { /* n:"BrtBeginDbTables15", */ T:1 },
	0x0847: { /* n:"BrtEndDbTables15", */ T:-1 },
	0x0848: { /* n:"BrtDbTable15" */ },
	0x0849: { /* n:"BrtBeginDataModel", */ T:1 },
	0x084A: { /* n:"BrtEndDataModel", */ T:-1 },
	0x084B: { /* n:"BrtBeginModelTables", */ T:1 },
	0x084C: { /* n:"BrtEndModelTables", */ T:-1 },
	0x084D: { /* n:"BrtModelTable" */ },
	0x084E: { /* n:"BrtBeginModelRelationships", */ T:1 },
	0x084F: { /* n:"BrtEndModelRelationships", */ T:-1 },
	0x0850: { /* n:"BrtModelRelationship" */ },
	0x0851: { /* n:"BrtBeginECTxtWiz15", */ T:1 },
	0x0852: { /* n:"BrtEndECTxtWiz15", */ T:-1 },
	0x0853: { /* n:"BrtBeginECTWFldInfoLst15", */ T:1 },
	0x0854: { /* n:"BrtEndECTWFldInfoLst15", */ T:-1 },
	0x0855: { /* n:"BrtBeginECTWFldInfo15", */ T:1 },
	0x0856: { /* n:"BrtFieldListActiveItem" */ },
	0x0857: { /* n:"BrtPivotCacheIdVersion" */ },
	0x0858: { /* n:"BrtSXDI15" */ },
	0x0859: { /* n:"BrtBeginModelTimeGroupings", */ T:1 },
	0x085A: { /* n:"BrtEndModelTimeGroupings", */ T:-1 },
	0x085B: { /* n:"BrtBeginModelTimeGrouping", */ T:1 },
	0x085C: { /* n:"BrtEndModelTimeGrouping", */ T:-1 },
	0x085D: { /* n:"BrtModelTimeGroupingCalcCol" */ },
	0x0C00: { /* n:"BrtUid" */ },
	0x0C01: { /* n:"BrtRevisionPtr" */ },
	0x1000: { /* n:"BrtBeginDynamicArrayPr", */ T:1 },
	0x1001: { /* n:"BrtEndDynamicArrayPr", */ T:-1 },
	0x138A: { /* n:"BrtBeginRichValueBlock", */ T:1 },
	0x138B: { /* n:"BrtEndRichValueBlock", */ T:-1 },
	0x13D9: { /* n:"BrtBeginRichFilters", */ T:1 },
	0x13DA: { /* n:"BrtEndRichFilters", */ T:-1 },
	0x13DB: { /* n:"BrtRichFilter" */ },
	0x13DC: { /* n:"BrtBeginRichFilterColumn", */ T:1 },
	0x13DD: { /* n:"BrtEndRichFilterColumn", */ T:-1 },
	0x13DE: { /* n:"BrtBeginCustomRichFilters", */ T:1 },
	0x13DF: { /* n:"BrtEndCustomRichFilters", */ T:-1 },
	0x13E0: { /* n:"BrtCustomRichFilter" */ },
	0x13E1: { /* n:"BrtTop10RichFilter" */ },
	0x13E2: { /* n:"BrtDynamicRichFilter" */ },
	0x13E4: { /* n:"BrtBeginRichSortCondition", */ T:1 },
	0x13E5: { /* n:"BrtEndRichSortCondition", */ T:-1 },
	0x13E6: { /* n:"BrtRichFilterDateGroupItem" */ },
	0x13E7: { /* n:"BrtBeginCalcFeatures", */ T:1 },
	0x13E8: { /* n:"BrtEndCalcFeatures", */ T:-1 },
	0x13E9: { /* n:"BrtCalcFeature" */ },
	0x13EB: { /* n:"BrtExternalLinksPr" */ },
	0xFFFF: { n:"" }
};

/* [MS-XLS] 2.3 Record Enumeration (and other sources) */
var XLSRecordEnum = {
	/* [MS-XLS] 2.3 Record Enumeration 2021-08-17 */
	0x0006: { /* n:"Formula", */ f:parse_Formula },
	0x000a: { /* n:"EOF", */ f:parsenoop2 },
	0x000c: { /* n:"CalcCount", */ f:parseuint16 }, //
	0x000d: { /* n:"CalcMode", */ f:parseuint16 }, //
	0x000e: { /* n:"CalcPrecision", */ f:parsebool }, //
	0x000f: { /* n:"CalcRefMode", */ f:parsebool }, //
	0x0010: { /* n:"CalcDelta", */ f:parse_Xnum }, //
	0x0011: { /* n:"CalcIter", */ f:parsebool }, //
	0x0012: { /* n:"Protect", */ f:parsebool },
	0x0013: { /* n:"Password", */ f:parseuint16 },
	0x0014: { /* n:"Header", */ f:parse_XLHeaderFooter },
	0x0015: { /* n:"Footer", */ f:parse_XLHeaderFooter },
	0x0017: { /* n:"ExternSheet", */ f:parse_ExternSheet },
	0x0018: { /* n:"Lbl", */ f:parse_Lbl },
	0x0019: { /* n:"WinProtect", */ f:parsebool },
	0x001a: { /* n:"VerticalPageBreaks", */ },
	0x001b: { /* n:"HorizontalPageBreaks", */ },
	0x001c: { /* n:"Note", */ f:parse_Note },
	0x001d: { /* n:"Selection", */ },
	0x0022: { /* n:"Date1904", */ f:parsebool },
	0x0023: { /* n:"ExternName", */ f:parse_ExternName },
	0x0026: { /* n:"LeftMargin", */ f:parse_Xnum }, // *
	0x0027: { /* n:"RightMargin", */ f:parse_Xnum }, // *
	0x0028: { /* n:"TopMargin", */ f:parse_Xnum }, // *
	0x0029: { /* n:"BottomMargin", */ f:parse_Xnum }, // *
	0x002a: { /* n:"PrintRowCol", */ f:parsebool },
	0x002b: { /* n:"PrintGrid", */ f:parsebool },
	0x002f: { /* n:"FilePass", */ f:parse_FilePass },
	0x0031: { /* n:"Font", */ f:parse_Font },
	0x0033: { /* n:"PrintSize", */ f:parseuint16 },
	0x003c: { /* n:"Continue", */ },
	0x003d: { /* n:"Window1", */ f:parse_Window1 },
	0x0040: { /* n:"Backup", */ f:parsebool },
	0x0041: { /* n:"Pane", */ f:parse_Pane },
	0x0042: { /* n:"CodePage", */ f:parseuint16 },
	0x004d: { /* n:"Pls", */ },
	0x0050: { /* n:"DCon", */ },
	0x0051: { /* n:"DConRef", */ },
	0x0052: { /* n:"DConName", */ },
	0x0055: { /* n:"DefColWidth", */ f:parseuint16 },
	0x0059: { /* n:"XCT", */ },
	0x005a: { /* n:"CRN", */ },
	0x005b: { /* n:"FileSharing", */ },
	0x005c: { /* n:"WriteAccess", */ f:parse_WriteAccess },
	0x005d: { /* n:"Obj", */ f:parse_Obj },
	0x005e: { /* n:"Uncalced", */ },
	0x005f: { /* n:"CalcSaveRecalc", */ f:parsebool }, //
	0x0060: { /* n:"Template", */ },
	0x0061: { /* n:"Intl", */ },
	0x0063: { /* n:"ObjProtect", */ f:parsebool },
	0x007d: { /* n:"ColInfo", */ f:parse_ColInfo },
	0x0080: { /* n:"Guts", */ f:parse_Guts },
	0x0081: { /* n:"WsBool", */ f:parse_WsBool },
	0x0082: { /* n:"GridSet", */ f:parseuint16 },
	0x0083: { /* n:"HCenter", */ f:parsebool },
	0x0084: { /* n:"VCenter", */ f:parsebool },
	0x0085: { /* n:"BoundSheet8", */ f:parse_BoundSheet8 },
	0x0086: { /* n:"WriteProtect", */ },
	0x008c: { /* n:"Country", */ f:parse_Country },
	0x008d: { /* n:"HideObj", */ f:parseuint16 },
	0x0090: { /* n:"Sort", */ },
	0x0092: { /* n:"Palette", */ f:parse_Palette },
	0x0097: { /* n:"Sync", */ },
	0x0098: { /* n:"LPr", */ },
	0x0099: { /* n:"DxGCol", */ },
	0x009a: { /* n:"FnGroupName", */ },
	0x009b: { /* n:"FilterMode", */ },
	0x009c: { /* n:"BuiltInFnGroupCount", */ f:parseuint16 },
	0x009d: { /* n:"AutoFilterInfo", */ },
	0x009e: { /* n:"AutoFilter", */ },
	0x00a0: { /* n:"Scl", */ f:parse_Scl },
	0x00a1: { /* n:"Setup", */ f:parse_Setup },
	0x00ae: { /* n:"ScenMan", */ },
	0x00af: { /* n:"SCENARIO", */ },
	0x00b0: { /* n:"SxView", */ },
	0x00b1: { /* n:"Sxvd", */ },
	0x00b2: { /* n:"SXVI", */ },
	0x00b4: { /* n:"SxIvd", */ },
	0x00b5: { /* n:"SXLI", */ },
	0x00b6: { /* n:"SXPI", */ },
	0x00b8: { /* n:"DocRoute", */ },
	0x00b9: { /* n:"RecipName", */ },
	0x00bd: { /* n:"MulRk", */ f:parse_MulRk },
	0x00be: { /* n:"MulBlank", */ f:parse_MulBlank },
	0x00c1: { /* n:"Mms", */ f:parsenoop2 },
	0x00c5: { /* n:"SXDI", */ },
	0x00c6: { /* n:"SXDB", */ },
	0x00c7: { /* n:"SXFDB", */ },
	0x00c8: { /* n:"SXDBB", */ },
	0x00c9: { /* n:"SXNum", */ },
	0x00ca: { /* n:"SxBool", */ f:parsebool },
	0x00cb: { /* n:"SxErr", */ },
	0x00cc: { /* n:"SXInt", */ },
	0x00cd: { /* n:"SXString", */ },
	0x00ce: { /* n:"SXDtr", */ },
	0x00cf: { /* n:"SxNil", */ },
	0x00d0: { /* n:"SXTbl", */ },
	0x00d1: { /* n:"SXTBRGIITM", */ },
	0x00d2: { /* n:"SxTbpg", */ },
	0x00d3: { /* n:"ObProj", */ },
	0x00d5: { /* n:"SXStreamID", */ },
	0x00d7: { /* n:"DBCell", */ },
	0x00d8: { /* n:"SXRng", */ },
	0x00d9: { /* n:"SxIsxoper", */ },
	0x00da: { /* n:"BookBool", */ f:parseuint16 },
	0x00dc: { /* n:"DbOrParamQry", */ },
	0x00dd: { /* n:"ScenarioProtect", */ f:parsebool },
	0x00de: { /* n:"OleObjectSize", */ },
	0x00e0: { /* n:"XF", */ f:parse_XF },
	0x00e1: { /* n:"InterfaceHdr", */ f:parse_InterfaceHdr },
	0x00e2: { /* n:"InterfaceEnd", */ f:parsenoop2 },
	0x00e3: { /* n:"SXVS", */ },
	0x00e5: { /* n:"MergeCells", */ f:parse_MergeCells },
	0x00e9: { /* n:"BkHim", */ },
	0x00eb: { /* n:"MsoDrawingGroup", */ },
	0x00ec: { /* n:"MsoDrawing", */ },
	0x00ed: { /* n:"MsoDrawingSelection", */ },
	0x00ef: { /* n:"PhoneticInfo", */ },
	0x00f0: { /* n:"SxRule", */ },
	0x00f1: { /* n:"SXEx", */ },
	0x00f2: { /* n:"SxFilt", */ },
	0x00f4: { /* n:"SxDXF", */ },
	0x00f5: { /* n:"SxItm", */ },
	0x00f6: { /* n:"SxName", */ },
	0x00f7: { /* n:"SxSelect", */ },
	0x00f8: { /* n:"SXPair", */ },
	0x00f9: { /* n:"SxFmla", */ },
	0x00fb: { /* n:"SxFormat", */ },
	0x00fc: { /* n:"SST", */ f:parse_SST },
	0x00fd: { /* n:"LabelSst", */ f:parse_LabelSst },
	0x00ff: { /* n:"ExtSST", */ f:parse_ExtSST },
	0x0100: { /* n:"SXVDEx", */ },
	0x0103: { /* n:"SXFormula", */ },
	0x0122: { /* n:"SXDBEx", */ },
	0x0137: { /* n:"RRDInsDel", */ },
	0x0138: { /* n:"RRDHead", */ },
	0x013b: { /* n:"RRDChgCell", */ },
	0x013d: { /* n:"RRTabId", */ f:parseuint16a },
	0x013e: { /* n:"RRDRenSheet", */ },
	0x013f: { /* n:"RRSort", */ },
	0x0140: { /* n:"RRDMove", */ },
	0x014a: { /* n:"RRFormat", */ },
	0x014b: { /* n:"RRAutoFmt", */ },
	0x014d: { /* n:"RRInsertSh", */ },
	0x014e: { /* n:"RRDMoveBegin", */ },
	0x014f: { /* n:"RRDMoveEnd", */ },
	0x0150: { /* n:"RRDInsDelBegin", */ },
	0x0151: { /* n:"RRDInsDelEnd", */ },
	0x0152: { /* n:"RRDConflict", */ },
	0x0153: { /* n:"RRDDefName", */ },
	0x0154: { /* n:"RRDRstEtxp", */ },
	0x015f: { /* n:"LRng", */ },
	0x0160: { /* n:"UsesELFs", */ f:parsebool },
	0x0161: { /* n:"DSF", */ f:parsenoop2 },
	0x0191: { /* n:"CUsr", */ },
	0x0192: { /* n:"CbUsr", */ },
	0x0193: { /* n:"UsrInfo", */ },
	0x0194: { /* n:"UsrExcl", */ },
	0x0195: { /* n:"FileLock", */ },
	0x0196: { /* n:"RRDInfo", */ },
	0x0197: { /* n:"BCUsrs", */ },
	0x0198: { /* n:"UsrChk", */ },
	0x01a9: { /* n:"UserBView", */ },
	0x01aa: { /* n:"UserSViewBegin", */ },
	0x01ab: { /* n:"UserSViewEnd", */ },
	0x01ac: { /* n:"RRDUserView", */ },
	0x01ad: { /* n:"Qsi", */ },
	0x01ae: { /* n:"SupBook", */ f:parse_SupBook },
	0x01af: { /* n:"Prot4Rev", */ f:parsebool },
	0x01b0: { /* n:"CondFmt", */ },
	0x01b1: { /* n:"CF", */ },
	0x01b2: { /* n:"DVal", */ },
	0x01b5: { /* n:"DConBin", */ },
	0x01b6: { /* n:"TxO", */ f:parse_TxO },
	0x01b7: { /* n:"RefreshAll", */ f:parsebool }, //
	0x01b8: { /* n:"HLink", */ f:parse_HLink },
	0x01b9: { /* n:"Lel", */ },
	0x01ba: { /* n:"CodeName", */ f:parse_XLUnicodeString },
	0x01bb: { /* n:"SXFDBType", */ },
	0x01bc: { /* n:"Prot4RevPass", */ f:parseuint16 },
	0x01bd: { /* n:"ObNoMacros", */ },
	0x01be: { /* n:"Dv", */ },
	0x01c0: { /* n:"Excel9File", */ f:parsenoop2 },
	0x01c1: { /* n:"RecalcId", */ f:parse_RecalcId, r:2},
	0x01c2: { /* n:"EntExU2", */ f:parsenoop2 },
	0x0200: { /* n:"Dimensions", */ f:parse_Dimensions },
	0x0201: { /* n:"Blank", */ f:parse_Blank },
	0x0203: { /* n:"Number", */ f:parse_Number },
	0x0204: { /* n:"Label", */ f:parse_Label },
	0x0205: { /* n:"BoolErr", */ f:parse_BoolErr },
	0x0207: { /* n:"String", */ f:parse_String },
	0x0208: { /* n:"Row", */ f:parse_Row },
	0x020b: { /* n:"Index", */ },
	0x0221: { /* n:"Array", */ f:parse_Array },
	0x0225: { /* n:"DefaultRowHeight", */ f:parse_DefaultRowHeight },
	0x0236: { /* n:"Table", */ },
	0x023e: { /* n:"Window2", */ f:parse_Window2 },
	0x027e: { /* n:"RK", */ f:parse_RK },
	0x0293: { /* n:"Style", */ },
	0x0418: { /* n:"BigName", */ },
	0x041e: { /* n:"Format", */ f:parse_Format },
	0x043c: { /* n:"ContinueBigName", */ },
	0x04bc: { /* n:"ShrFmla", */ f:parse_ShrFmla },
	0x0800: { /* n:"HLinkTooltip", */ f:parse_HLinkTooltip },
	0x0801: { /* n:"WebPub", */ },
	0x0802: { /* n:"QsiSXTag", */ },
	0x0803: { /* n:"DBQueryExt", */ },
	0x0804: { /* n:"ExtString", */ },
	0x0805: { /* n:"TxtQry", */ },
	0x0806: { /* n:"Qsir", */ },
	0x0807: { /* n:"Qsif", */ },
	0x0808: { /* n:"RRDTQSIF", */ },
	0x0809: { /* n:"BOF", */ f:parse_BOF },
	0x080a: { /* n:"OleDbConn", */ },
	0x080b: { /* n:"WOpt", */ },
	0x080c: { /* n:"SXViewEx", */ },
	0x080d: { /* n:"SXTH", */ },
	0x080e: { /* n:"SXPIEx", */ },
	0x080f: { /* n:"SXVDTEx", */ },
	0x0810: { /* n:"SXViewEx9", */ },
	0x0812: { /* n:"ContinueFrt", */ },
	0x0813: { /* n:"RealTimeData", */ },
	0x0850: { /* n:"ChartFrtInfo", */ },
	0x0851: { /* n:"FrtWrapper", */ },
	0x0852: { /* n:"StartBlock", */ },
	0x0853: { /* n:"EndBlock", */ },
	0x0854: { /* n:"StartObject", */ },
	0x0855: { /* n:"EndObject", */ },
	0x0856: { /* n:"CatLab", */ },
	0x0857: { /* n:"YMult", */ },
	0x0858: { /* n:"SXViewLink", */ },
	0x0859: { /* n:"PivotChartBits", */ },
	0x085a: { /* n:"FrtFontList", */ },
	0x0862: { /* n:"SheetExt", */ },
	0x0863: { /* n:"BookExt", */ r:12},
	0x0864: { /* n:"SXAddl", */ },
	0x0865: { /* n:"CrErr", */ },
	0x0866: { /* n:"HFPicture", */ },
	0x0867: { /* n:"FeatHdr", */ f:parsenoop2 },
	0x0868: { /* n:"Feat", */ },
	0x086a: { /* n:"DataLabExt", */ },
	0x086b: { /* n:"DataLabExtContents", */ },
	0x086c: { /* n:"CellWatch", */ },
	0x0871: { /* n:"FeatHdr11", */ },
	0x0872: { /* n:"Feature11", */ },
	0x0874: { /* n:"DropDownObjIds", */ },
	0x0875: { /* n:"ContinueFrt11", */ },
	0x0876: { /* n:"DConn", */ },
	0x0877: { /* n:"List12", */ },
	0x0878: { /* n:"Feature12", */ },
	0x0879: { /* n:"CondFmt12", */ },
	0x087a: { /* n:"CF12", */ },
	0x087b: { /* n:"CFEx", */ },
	0x087c: { /* n:"XFCRC", */ f:parse_XFCRC, r:12 },
	0x087d: { /* n:"XFExt", */ f:parse_XFExt, r:12 },
	0x087e: { /* n:"AutoFilter12", */ },
	0x087f: { /* n:"ContinueFrt12", */ },
	0x0884: { /* n:"MDTInfo", */ },
	0x0885: { /* n:"MDXStr", */ },
	0x0886: { /* n:"MDXTuple", */ },
	0x0887: { /* n:"MDXSet", */ },
	0x0888: { /* n:"MDXProp", */ },
	0x0889: { /* n:"MDXKPI", */ },
	0x088a: { /* n:"MDB", */ },
	0x088b: { /* n:"PLV", */ },
	0x088c: { /* n:"Compat12", */ f:parsebool, r:12 },
	0x088d: { /* n:"DXF", */ },
	0x088e: { /* n:"TableStyles", */ r:12 },
	0x088f: { /* n:"TableStyle", */ },
	0x0890: { /* n:"TableStyleElement", */ },
	0x0892: { /* n:"StyleExt", */ },
	0x0893: { /* n:"NamePublish", */ },
	0x0894: { /* n:"NameCmt", */ f:parse_NameCmt, r:12 },
	0x0895: { /* n:"SortData", */ },
	0x0896: { /* n:"Theme", */ f:parse_Theme, r:12 },
	0x0897: { /* n:"GUIDTypeLib", */ },
	0x0898: { /* n:"FnGrp12", */ },
	0x0899: { /* n:"NameFnGrp12", */ },
	0x089a: { /* n:"MTRSettings", */ f:parse_MTRSettings, r:12 },
	0x089b: { /* n:"CompressPictures", */ f:parsenoop2 },
	0x089c: { /* n:"HeaderFooter", */ },
	0x089d: { /* n:"CrtLayout12", */ },
	0x089e: { /* n:"CrtMlFrt", */ },
	0x089f: { /* n:"CrtMlFrtContinue", */ },
	0x08a3: { /* n:"ForceFullCalculation", */ f:parse_ForceFullCalculation },
	0x08a4: { /* n:"ShapePropsStream", */ },
	0x08a5: { /* n:"TextPropsStream", */ },
	0x08a6: { /* n:"RichTextStream", */ },
	0x08a7: { /* n:"CrtLayout12A", */ },
	0x1001: { /* n:"Units", */ },
	0x1002: { /* n:"Chart", */ },
	0x1003: { /* n:"Series", */ },
	0x1006: { /* n:"DataFormat", */ },
	0x1007: { /* n:"LineFormat", */ },
	0x1009: { /* n:"MarkerFormat", */ },
	0x100a: { /* n:"AreaFormat", */ },
	0x100b: { /* n:"PieFormat", */ },
	0x100c: { /* n:"AttachedLabel", */ },
	0x100d: { /* n:"SeriesText", */ },
	0x1014: { /* n:"ChartFormat", */ },
	0x1015: { /* n:"Legend", */ },
	0x1016: { /* n:"SeriesList", */ },
	0x1017: { /* n:"Bar", */ },
	0x1018: { /* n:"Line", */ },
	0x1019: { /* n:"Pie", */ },
	0x101a: { /* n:"Area", */ },
	0x101b: { /* n:"Scatter", */ },
	0x101c: { /* n:"CrtLine", */ },
	0x101d: { /* n:"Axis", */ },
	0x101e: { /* n:"Tick", */ },
	0x101f: { /* n:"ValueRange", */ },
	0x1020: { /* n:"CatSerRange", */ },
	0x1021: { /* n:"AxisLine", */ },
	0x1022: { /* n:"CrtLink", */ },
	0x1024: { /* n:"DefaultText", */ },
	0x1025: { /* n:"Text", */ },
	0x1026: { /* n:"FontX", */ f:parseuint16 },
	0x1027: { /* n:"ObjectLink", */ },
	0x1032: { /* n:"Frame", */ },
	0x1033: { /* n:"Begin", */ },
	0x1034: { /* n:"End", */ },
	0x1035: { /* n:"PlotArea", */ },
	0x103a: { /* n:"Chart3d", */ },
	0x103c: { /* n:"PicF", */ },
	0x103d: { /* n:"DropBar", */ },
	0x103e: { /* n:"Radar", */ },
	0x103f: { /* n:"Surf", */ },
	0x1040: { /* n:"RadarArea", */ },
	0x1041: { /* n:"AxisParent", */ },
	0x1043: { /* n:"LegendException", */ },
	0x1044: { /* n:"ShtProps", */ f:parse_ShtProps },
	0x1045: { /* n:"SerToCrt", */ },
	0x1046: { /* n:"AxesUsed", */ },
	0x1048: { /* n:"SBaseRef", */ },
	0x104a: { /* n:"SerParent", */ },
	0x104b: { /* n:"SerAuxTrend", */ },
	0x104e: { /* n:"IFmtRecord", */ },
	0x104f: { /* n:"Pos", */ },
	0x1050: { /* n:"AlRuns", */ },
	0x1051: { /* n:"BRAI", */ },
	0x105b: { /* n:"SerAuxErrBar", */ },
	0x105c: { /* n:"ClrtClient", */ f:parse_ClrtClient },
	0x105d: { /* n:"SerFmt", */ },
	0x105f: { /* n:"Chart3DBarShape", */ },
	0x1060: { /* n:"Fbi", */ },
	0x1061: { /* n:"BopPop", */ },
	0x1062: { /* n:"AxcExt", */ },
	0x1063: { /* n:"Dat", */ },
	0x1064: { /* n:"PlotGrowth", */ },
	0x1065: { /* n:"SIIndex", */ },
	0x1066: { /* n:"GelFrame", */ },
	0x1067: { /* n:"BopPopCustom", */ },
	0x1068: { /* n:"Fbi2", */ },

	0x0000: { /* n:"Dimensions", */ f:parse_Dimensions },
	0x0001: { /* n:"BIFF2BLANK", */ },
	0x0002: { /* n:"BIFF2INT", */ f:parse_BIFF2INT },
	0x0003: { /* n:"BIFF2NUM", */ f:parse_BIFF2NUM },
	0x0004: { /* n:"BIFF2STR", */ f:parse_BIFF2STR },
	0x0005: { /* n:"BIFF2BOOLERR", */ f:parse_BIFF2BOOLERR },
	0x0007: { /* n:"String", */ f:parse_BIFF2STRING },
	0x0008: { /* n:"BIFF2ROW", */ },
	0x0009: { /* n:"BOF", */ f:parse_BOF },
	0x000b: { /* n:"Index", */ },
	0x0016: { /* n:"ExternCount", */ f:parseuint16 },
	0x001e: { /* n:"BIFF2FORMAT", */ f:parse_BIFF2Format },
	0x001f: { /* n:"BIFF2FMTCNT", */ }, /* 16-bit cnt of BIFF2FORMAT records */
	0x0020: { /* n:"BIFF2COLINFO", */ },
	0x0021: { /* n:"Array", */ f:parse_Array },
	0x0024: { /* n:"COLWIDTH", */ },
	0x0025: { /* n:"DefaultRowHeight", */ f:parse_DefaultRowHeight },
	// 0x002c ??
	// 0x002d ??
	// 0x002e ??
	// 0x0030 FONTCOUNT: number of fonts
	0x0032: { /* n:"BIFF2FONTXTRA", */ f:parse_BIFF2FONTXTRA },
	// 0x0035: INFOOPTS
	// 0x0036: TABLE (BIFF2 only)
	// 0x0037: TABLE2 (BIFF2 only)
	// 0x0038: WNDESK
	// 0x0039 ??
	// 0x003a: BEGINPREF
	// 0x003b: ENDPREF
	0x003e: { /* n:"BIFF2WINDOW2", */ },
	// 0x003f ??
	// 0x0046: SHOWSCROLL
	// 0x0047: SHOWFORMULA
	// 0x0048: STATUSBAR
	// 0x0049: SHORTMENUS
	// 0x004A:
	// 0x004B:
	// 0x004C:
	// 0x004E:
	// 0x004F:
	// 0x0058: TOOLBAR (BIFF3)

	/* - - - */
	0x0034: { /* n:"DDEObjName", */ },
	0x0043: { /* n:"BIFF2XF", */ f:parse_BIFF2XF },
	0x0044: { /* n:"BIFF2XFINDEX", */ f:parseuint16 },
	0x0045: { /* n:"BIFF2FONTCLR", */ },
	0x0056: { /* n:"BIFF4FMTCNT", */ }, /* 16-bit cnt, similar to BIFF2 */
	0x007e: { /* n:"RK", */ }, /* Not necessarily same as 0x027e */
	0x007f: { /* n:"ImData", */ f:parse_ImData },
	0x0087: { /* n:"Addin", */ },
	0x0088: { /* n:"Edg", */ },
	0x0089: { /* n:"Pub", */ },
	// 0x8A
	// 0x8B LH: alternate menu key flag (BIFF3/4)
	// 0x8E
	0x008F: { /* n:"BIFF4SheetInfo", */ f:parse_BIFF4SheetInfo },
	0x0091: { /* n:"Sub", */ },
	// 0x93 STYLE
	0x0094: { /* n:"LHRecord", */ },
	0x0095: { /* n:"LHNGraph", */ },
	0x0096: { /* n:"Sound", */ },
	// 0xA2 FNPROTO: function prototypes (BIFF4)
	// 0xA3
	// 0xA8
	0x00a9: { /* n:"CoordList", */ },
	0x00ab: { /* n:"GCW", */ },
	0x00bc: { /* n:"ShrFmla", */ }, /* Not necessarily same as 0x04bc */
	0x00bf: { /* n:"ToolbarHdr", */ },
	0x00c0: { /* n:"ToolbarEnd", */ },
	0x00c2: { /* n:"AddMenu", */ },
	0x00c3: { /* n:"DelMenu", */ },
	0x00d6: { /* n:"RString", */ f:parse_RString },
	0x00df: { /* n:"UDDesc", */ },
	0x00ea: { /* n:"TabIdConf", */ },
	0x0162: { /* n:"XL5Modify", */ },
	0x01a5: { /* n:"FileSharing2", */ },
	0x0206: { /* n:"Formula", */ f:parse_Formula },
	0x0209: { /* n:"BOF", */ f:parse_BOF },
	0x0218: { /* n:"Lbl", */ f:parse_Lbl },
	0x0223: { /* n:"ExternName", */ f:parse_ExternName },
	0x0231: { /* n:"Font", */ },
	0x0243: { /* n:"BIFF3XF", */ f:parse_BIFF3XF },
	0x0406: { /* n:"Formula", */ f:parse_Formula },
	0x0409: { /* n:"BOF", */ f:parse_BOF },
	0x0443: { /* n:"BIFF4XF", */ f:parse_BIFF4XF },
	0x086d: { /* n:"FeatInfo", */ },
	0x0873: { /* n:"FeatInfo11", */ },
	0x0881: { /* n:"SXAddl12", */ },
	0x08c0: { /* n:"AutoWebPub", */ },
	0x08c1: { /* n:"ListObj", */ },
	0x08c2: { /* n:"ListField", */ },
	0x08c3: { /* n:"ListDV", */ },
	0x08c4: { /* n:"ListCondFmt", */ },
	0x08c5: { /* n:"ListCF", */ },
	0x08c6: { /* n:"FMQry", */ },
	0x08c7: { /* n:"FMSQry", */ },
	0x08c8: { /* n:"PLV", */ },
	0x08c9: { /* n:"LnExt", */ },
	0x08ca: { /* n:"MkrExt", */ },
	0x08cb: { /* n:"CrtCoopt", */ },
	0x08d6: { /* n:"FRTArchId$", */ r:12 },

	/* --- multiplan 4 records --- */
	0x0065: { /* n:"", */ }, // one per window
	0x0066: { /* n:"", */ }, // calc settings
	0x0069: { /* n:"", */ }, // print header
	0x006a: { /* n:"", */ }, // print footer
	0x006b: { /* n:"", */ }, // print settings
	0x006d: { /* n:"", */ }, // one per window
	0x0070: { /* n:"", */ }, // includes default col width
	0x0072: { /* n:"", */ }, // includes selected cell

	0x7262: {}
};

function write_biff_rec(ba, type, payload, length) {
	var t = type;
	if(isNaN(t)) return;
	var len = length || (payload||[]).length || 0;
	var o = ba.next(4);
	o.write_shift(2, t);
	o.write_shift(2, len);
	if(len > 0 && is_buf(payload)) ba.push(payload);
}

function write_biff_continue(ba, type, payload, length) {
	var len = length || (payload||[]).length || 0;
	if(len <= 8224) return write_biff_rec(ba, type, payload, len);
	var t = type;
	if(isNaN(t)) return;
	var parts = payload.parts || [], sidx = 0;
	var i = 0, w = 0;
	while(w + (parts[sidx] || 8224) <= 8224) { w+= (parts[sidx] || 8224); sidx++; }
	var o = ba.next(4);
	o.write_shift(2, t);
	o.write_shift(2, w);
	ba.push(payload.slice(i, i + w));
	i += w;
	while(i < len) {
		o = ba.next(4);
		o.write_shift(2, 0x3c); // TODO: figure out correct continue type
		w = 0;
		while(w + (parts[sidx] || 8224) <= 8224) { w+= (parts[sidx] || 8224); sidx++; }
		o.write_shift(2, w);
		ba.push(payload.slice(i, i+w)); i+= w;
	}
}

function write_BIFF2BERR(r, c, val, t) {
	var out = new_buf(9);
	write_BIFF2Cell(out, r, c);
	write_Bes(val, t || 'b', out);
	return out;
}

/* TODO: codepage, large strings */
function write_BIFF2LABEL(r, c, val) {
	var out = new_buf(8 + 2*val.length);
	write_BIFF2Cell(out, r, c);
	out.write_shift(1, val.length);
	out.write_shift(val.length, val, 'sbcs');
	return out.l < out.length ? out.slice(0, out.l) : out;
}

function write_comments_biff2(ba, comments) {
	comments.forEach(function(data) {
		var text = data[0].map(function(cc) { return cc.t; }).join("");
		// TODO: should '\n' be translated to '\r' to correct for Excel 5.0 bug when exporting to BIFF2/3 ?
		if(text.length <= 2048) return write_biff_rec(ba, 0x001C, write_NOTE_BIFF2(text, data[1], data[2]));
		write_biff_rec(ba, 0x001C, write_NOTE_BIFF2(text.slice(0, 2048), data[1], data[2], text.length));
		for(var i = 2048; i < text.length; i += 2048)
			write_biff_rec(ba, 0x001C, write_NOTE_BIFF2(text.slice(i, Math.min(i+2048, text.length)), -1, -1, Math.min(2048, text.length - i)));
	});
}

/* TODO: BIFF3/4 use different records -- see comments*/
function write_ws_biff2_cell(ba, cell, R, C, opts, date1904) {
	var ifmt = 0;
	if(cell.z != null) {
		ifmt = opts._BIFF2FmtTable.indexOf(cell.z);
		if(ifmt == -1) { opts._BIFF2FmtTable.push(cell.z); ifmt = opts._BIFF2FmtTable.length - 1; }
	}
	var ixfe = 0;
	if(cell.z != null) {
		for(; ixfe < opts.cellXfs.length; ++ixfe) if(opts.cellXfs[ixfe].numFmtId == ifmt) break;
		if(ixfe == opts.cellXfs.length) opts.cellXfs.push({numFmtId: ifmt});
	}
	if(cell.v != null) switch(cell.t) {
		case 'd': case 'n':
			var v = cell.t == 'd' ? datenum(parseDate(cell.v, date1904), date1904) : cell.v;
			if(opts.biff == 2 && (v == (v|0)) && (v >= 0) && (v < 65536))
				// 0x027E (RK) in BIFF3/4
				write_biff_rec(ba, 0x0002, write_BIFF2INT(R, C, v, ixfe, ifmt));
			else if(isNaN(v))
				// 0x0205 in BIFF3/4
				write_biff_rec(ba, 0x0005, write_BIFF2BERR(R, C, 0x24, "e")); // #NUM!
			else if(!isFinite(v))
				// 0x0205 in BIFF3/4
				write_biff_rec(ba, 0x0005, write_BIFF2BERR(R, C, 0x07, "e")); // #DIV/0!
			else
				// 0x0203 in BIFF3/4
				write_biff_rec(ba, 0x0003, write_BIFF2NUM(R,C, v, ixfe, ifmt));
			return;
		case 'b': case 'e':
			// 0x0205 in BIFF3/4
			write_biff_rec(ba, 0x0005, write_BIFF2BERR(R, C, cell.v, cell.t)); return;
		/* TODO: codepage, sst */
		case 's': case 'str':
			// 0x0204 in BIFF3/4
			write_biff_rec(ba, 0x0004, write_BIFF2LABEL(R, C, cell.v == null ? "" : String(cell.v).slice(0,255)));
			return;
	}
	// 0x0201 in BIFF3/4
	write_biff_rec(ba, 0x0001, write_BIFF2Cell(null, R, C));
}

function write_ws_biff2(ba, ws, idx, opts, wb) {
	var dense = ws["!data"] != null;
	var range = safe_decode_range(ws['!ref'] || "A1"), rr = "", cols = [];
	if(range.e.c > 0xFF || range.e.r > 0x3FFF) {
		if(opts.WTF) throw new Error("Range " + (ws['!ref'] || "A1") + " exceeds format limit A1:IV16384");
		range.e.c = Math.min(range.e.c, 0xFF);
		range.e.r = Math.min(range.e.r, 0x3FFF);
	}
	var date1904 = (((wb||{}).Workbook||{}).WBProps||{}).date1904;
	var row = [], comments = [];
	/* TODO: 0x0000 / 0x0200 dimensions? */
	for(var C = range.s.c; C <= range.e.c; ++C) cols[C] = encode_col(C);
	for(var R = range.s.r; R <= range.e.r; ++R) {
		if(dense) row = ws["!data"][R] || [];
		rr = encode_row(R);
		for(C = range.s.c; C <= range.e.c; ++C) {
			var cell = dense ? row[C] : ws[cols[C] + rr];
			if(!cell) continue;
			/* write cell */
			write_ws_biff2_cell(ba, cell, R, C, opts, date1904);
			if(cell.c) comments.push([cell.c, R, C]);
		}
	}

	/* ... 0x12 0x19 0x13 (Password) */
	write_comments_biff2(ba, comments);
	/* 0x3d (Window1) ... */
}

/* Based on test files */
function write_biff2_buf(wb, opts) {
	var o = opts || {};

	var ba = buf_array();
	var idx = 0;
	for(var i=0;i<wb.SheetNames.length;++i) if(wb.SheetNames[i] == o.sheet) idx=i;
	if(idx == 0 && !!o.sheet && wb.SheetNames[0] != o.sheet) throw new Error("Sheet not found: " + o.sheet);
	write_biff_rec(ba, (o.biff == 4 ? 0x0409 : (o.biff == 3 ? 0x0209 : 0x0009)), write_BOF(wb, 0x10, o));
	if(((wb.Workbook||{}).WBProps||{}).date1904) write_biff_rec(ba, 0x0022, writebool(true));
	o.cellXfs = [{numFmtId: 0}];
	o._BIFF2FmtTable = ["General"]; o._Fonts = [];
	var body = buf_array();
	write_ws_biff2(body, wb.Sheets[wb.SheetNames[idx]], idx, o, wb);

	o._BIFF2FmtTable.forEach(function(f) {
		if(o.biff <= 3) write_biff_rec(ba, 0x001E, write_BIFF2Format(f));
		else write_biff_rec(ba, 0x041E, write_BIFF4Format(f));
	});
	o.cellXfs.forEach(function(xf) {
		switch(o.biff) {
			case 2: write_biff_rec(ba, 0x0043, write_BIFF2XF(xf)); break;
			case 3: write_biff_rec(ba, 0x0243, write_BIFF3XF(xf)); break;
			case 4: write_biff_rec(ba, 0x0443, write_BIFF4XF(xf)); break;
		}
	});
	delete o._BIFF2FmtTable; delete o.cellXfs; delete o._Fonts;

	ba.push(body.end());
	write_biff_rec(ba, 0x000A);
	return ba.end();
}

var b8oid = 1, b8ocnts = [];
function write_MsoDrawingGroup() {
	var buf = new_buf(82 + 8 * b8ocnts.length);
	/* [MS-ODRAW] 2.2.12 OfficeArtDggContainer */
	buf.write_shift(2, 0x0F);
	buf.write_shift(2, 0xF000);
	buf.write_shift(4, 74 + 8 * b8ocnts.length);
	/* 2.2.48 OfficeArtFDGGBlock */
	{
		buf.write_shift(2, 0);
		buf.write_shift(2, 0xF006);
		buf.write_shift(4, 16 + 8 * b8ocnts.length);
		/* 2.2.47 OfficeArtFDGG */
		{
			buf.write_shift(4, b8oid);
			buf.write_shift(4, b8ocnts.length+1);
			var acc = 0; for(var i = 0; i < b8ocnts.length; ++i) acc += (b8ocnts[i] && b8ocnts[i][1] || 0); buf.write_shift(4, acc);
			buf.write_shift(4, b8ocnts.length);
		}
		/* 2.2.46 OfficeArtIDCL + */
		b8ocnts.forEach(function(b8) {
			buf.write_shift(4, b8[0]);
			buf.write_shift(4, b8[2]);
		});
	}
	/* 2.2.9 OfficeArtFOPT */
	{
		buf.write_shift(2, 0x33); // 0x03 | (3 << 4)
		buf.write_shift(2, 0xF00B);
		buf.write_shift(4, 0x12); // 3 * 6
		/* 2.3.21.15 Text Boolean Properties */
		buf.write_shift(2, 0xBF); buf.write_shift(4, 0x00080008);
		/* 2.3.7.2 fillColor */
		buf.write_shift(2, 0x0181); buf.write_shift(4, 0x08000041);
		/* 2.3.8.1 lineColor */
		buf.write_shift(2, 0x01C0); buf.write_shift(4, 0x08000040);
	}
	/* 2.2.45 OfficeArtSplitMenuColorContainer */
	{
		buf.write_shift(2, 0x40);
		buf.write_shift(2, 0xF11E);
		buf.write_shift(4, 16);
		buf.write_shift(4, 0x0800000D);
		buf.write_shift(4, 0x0800000C);
		buf.write_shift(4, 0x08000017);
		buf.write_shift(4, 0x100000F7);
	}
	return buf;
}
function write_comments_biff8(ba, comments) {
	var notes = [], sz = 0, pl = buf_array(), baseid = b8oid;
	var _oasc;
	comments.forEach(function(c, ci) {
		var author = "";
		var text = c[0].map(function(t) { if(t.a && !author) author = t.a; return t.t; }).join("");
		++b8oid;

		/* 2.2.14 OfficeArtSpContainer */
		{
			var oasc = new_buf(0x96);
			oasc.write_shift(2, 0x0F);
			oasc.write_shift(2, 0xF004);
			oasc.write_shift(4, 0x96);
			/* 2.2.40 OfficeArtFSP */
			{
				oasc.write_shift(2, 0xca2); // 0x02 | (0xca << 4)
				oasc.write_shift(2, 0xF00A);
				oasc.write_shift(4, 8);
				oasc.write_shift(4, b8oid);
				oasc.write_shift(4, 0xA00);
			}
			/* 2.2.9 OfficeArtFOPT */
			{
				oasc.write_shift(2, 0xE3); // 0x03 | (14 << 4)
				oasc.write_shift(2, 0xF00B);
				oasc.write_shift(4, 0x54); // 14 * 6
				/* 2.3.21.1 ITxid */
				oasc.write_shift(2, 0x80); oasc.write_shift(4, 0);
				/* 2.3.21.12 txdir */
				oasc.write_shift(2, 0x8B); oasc.write_shift(4, 0x02);
				/* 2.3.21.15 Text Boolean Properties */
				oasc.write_shift(2, 0xBF); oasc.write_shift(4, 0x00080008);
				/* 2.3.6.30 cxk */
				oasc.write_shift(2, 0x0158); oasc.l += 4;
				/* 2.3.7.2 fillColor */
				oasc.write_shift(2, 0x0181); oasc.write_shift(4, 0x08000050);
				/* 2.3.7.4 fillBackColor */
				oasc.write_shift(2, 0x0183); oasc.write_shift(4, 0x08000050);
				/* 2.3.7.6 fillCrMod */
				oasc.write_shift(2, 0x0185); oasc.write_shift(4, 0x100000F4);
				/* 2.3.7.43 Fill Style Boolean Properties */
				oasc.write_shift(2, 0x01BF); oasc.write_shift(4, 0x00100010);
				/* 2.3.8.1 lineColor */
				oasc.write_shift(2, 0x01C0); oasc.write_shift(4, 0x08000051);
				/* 2.3.8.4 lineCrMod */
				oasc.write_shift(2, 0x01C3); oasc.write_shift(4, 0x100000F4);
				/* 2.3.13.2 shadowColor */
				oasc.write_shift(2, 0x0201); oasc.write_shift(4, 0x08000051);
				/* 2.3.13.4 shadowCrMod */
				oasc.write_shift(2, 0x0203); oasc.write_shift(4, 0x100000F4);
				/* 2.3.13.23 Shadow Style Boolean Properties */
				oasc.write_shift(2, 0x023F); oasc.write_shift(4, 0x00030001);
				/* 2.3.4.44 Group Shape Boolean Properties */
				oasc.write_shift(2, 0x03BF); oasc.write_shift(4, 0x00020000 | (c[0].hidden ? 2 : 0));
			}
			/* [MS-XLS] 2.5.193 OfficeArtClientAnchorSheet */
			{
				oasc.l += 2;
				oasc.write_shift(2, 0xF010);
				oasc.write_shift(4, 0x12);
				oasc.write_shift(2, 0x3); // do not move or size with cells
				oasc.write_shift(2, c[2] + 2); oasc.l += 2;
				oasc.write_shift(2, c[1] + 1); oasc.l += 2;
				oasc.write_shift(2, c[2] + 4); oasc.l += 2;
				oasc.write_shift(2, c[1] + 5); oasc.l += 2;
			}
			/* [MS-XLS] 2.5.194 OfficeArtClientData */
			{
				oasc.l += 2;
				oasc.write_shift(2, 0xF011);
				oasc.l += 4;
			}
			oasc.l = 0x96;
			if(ci == 0) /* write_biff_rec(pl, 0x003C, oasc); */ _oasc = oasc;
			else write_biff_rec(pl, 0x00EC, oasc);
		}
		sz += 0x96;

		/* [MS-XLS] 2.4.181 Obj */
		{
			var obj = new_buf(52); // 22 + 26 + 4
			/* [MS-XLS] 2.5.143 FtCmo */
			obj.write_shift(2, 0x15);
			obj.write_shift(2, 0x12);
			obj.write_shift(2, 0x19);
			obj.write_shift(2, b8oid);
			obj.write_shift(2, 0);
			obj.l = 22;
			/* [MS-XLS] 2.5.149 FtNts */
			obj.write_shift(2, 0x0D);
			obj.write_shift(2, 0x16);
			obj.write_shift(4, 0x62726272);
			obj.write_shift(4, 0x95374305);
			obj.write_shift(4, 0x80301328);
			obj.write_shift(4, 0x69696904 + b8oid*256);
			obj.write_shift(2,0);
			obj.write_shift(4,0);
			// reserved
			obj.l += 4;
			write_biff_rec(pl, 0x005D, obj);
		}

		/* [MS-XLS] 2.5.195 OfficeArtClientTextbox */
		{
			var oact = new_buf(8);
			oact.l += 2;
			oact.write_shift(2, 0xF00D);
			oact.l += 4;
			write_biff_rec(pl, 0x00EC, oact);
		}
		sz += 8;

		/* [MS-XLS] 2.4.329 TxO */
		{
			var txo = new_buf(18);
			txo.write_shift(2, 0x12);
			txo.l += 8;
			txo.write_shift(2, text.length);
			txo.write_shift(2, 0x10);
			txo.l += 4;
			write_biff_rec(pl, 0x01b6, txo);
			/* text continue record TODO: switch to wide strings */
			{
				var cont = new_buf(1 + text.length);
				cont.write_shift(1, 0);
				cont.write_shift(text.length, text, "sbcs");
				write_biff_rec(pl, 0x003C, cont);
			}
			/* formatting continue records */
			{
				var conf = new_buf(0x10);
				conf.l += 8;
				conf.write_shift(2, text.length);
				conf.l += 6;
				write_biff_rec(pl, 0x003C, conf);
			}
		}

		/* 2.4.179 Note */
		{
			var notesh = new_buf(12 + author.length);
			notesh.write_shift(2, c[1]);
			notesh.write_shift(2, c[2]);
			notesh.write_shift(2, 0 | (c[0].hidden ? 0 : 2));
			notesh.write_shift(2, b8oid);
			notesh.write_shift(2, author.length);
			notesh.write_shift(1, 0);
			notesh.write_shift(author.length, author, "sbcs");
			notesh.l ++;
			notes.push(notesh);
		}
	});
	/* [MS-ODRAW] 2.2.13 OfficeArtDgContainer */
	{
		var hdr = new_buf(80);
		hdr.write_shift(2, 0x0F);
		hdr.write_shift(2, 0xF002);
		hdr.write_shift(4, sz + hdr.length - 8);
		/* [MS-ODRAW] 2.2.49 OfficeArtFDG */
		{
			hdr.write_shift(2, 0x10);
			hdr.write_shift(2, 0xF008);
			hdr.write_shift(4, 0x08);
			hdr.write_shift(4, comments.length + 1);
			hdr.write_shift(4, b8oid);
		}
		/* [MS-ODRAW] 2.2.16 OfficeArtSpgrContainer */
		{
			hdr.write_shift(2, 0x0f);
			hdr.write_shift(2, 0xF003);
			hdr.write_shift(4, sz + 0x30);
			/* [MS-ODRAW] 2.2.14 OfficeArtSpContainer */
			{
				hdr.write_shift(2, 0x0f);
				hdr.write_shift(2, 0xF004);
				hdr.write_shift(4, 0x28);
				/* [MS-ODRAW] 2.2.38 OfficeArtFSPGR */
				{
					hdr.write_shift(2, 0x01);
					hdr.write_shift(2, 0xF009);
					hdr.write_shift(4, 0x10);
					hdr.l += 16;
				}
				/* [MS-ODRAW] 2.2.40 OfficeArtFSP */
				{
					hdr.write_shift(2, 0x02);
					hdr.write_shift(2, 0xF00A);
					hdr.write_shift(4, 0x08);
					hdr.write_shift(4, baseid);
					hdr.write_shift(4, 0x05);
				}
			}
		}
		write_biff_rec(ba, 0x00EC, /* hdr */ _oasc ? bconcat([hdr, _oasc]) : hdr);
	}
	ba.push(pl.end());
	notes.forEach(function(n) { write_biff_rec(ba, 0x001C, n); });
	b8ocnts.push([baseid, comments.length + 1, b8oid]);
	++b8oid;
}

function write_FONTS_biff8(ba, data, opts) {
	write_biff_rec(ba, 0x0031 /* Font */, write_Font({
		sz:12,
		color: {theme:1},
		name: "Arial",
		family: 2,
		scheme: "minor"
	}, opts));
}


function write_FMTS_biff8(ba, NF, opts) {
	if(!NF) return;
	[[5,8],[23,26],[41,44],[/*63*/50,/*66],[164,*/392]].forEach(function(r) {
for(var i = r[0]; i <= r[1]; ++i) if(NF[i] != null) write_biff_rec(ba, 0x041E /* Format */, write_Format(i, NF[i], opts));
	});
}

function write_FEAT(ba, ws) {
	/* [MS-XLS] 2.4.112 */
	var o = new_buf(19);
	o.write_shift(4, 0x867); o.write_shift(4, 0); o.write_shift(4, 0);
	o.write_shift(2, 3); o.write_shift(1, 1); o.write_shift(4, 0);
	write_biff_rec(ba, 0x0867 /* FeatHdr */, o);
	/* [MS-XLS] 2.4.111 */
	o = new_buf(39);
	o.write_shift(4, 0x868); o.write_shift(4, 0); o.write_shift(4, 0);
	o.write_shift(2, 3); o.write_shift(1, 0); o.write_shift(4, 0);
	o.write_shift(2, 1); o.write_shift(4, 4); o.write_shift(2, 0);
	write_Ref8U(safe_decode_range(ws['!ref']||"A1"), o);
	o.write_shift(4, 4);
	write_biff_rec(ba, 0x0868 /* Feat */, o);
}

function write_CELLXFS_biff8(ba, opts) {
	for(var i = 0; i < 16; ++i) write_biff_rec(ba, 0x00e0 /* XF */, write_XF({numFmtId:0, style:true}, 0, opts));
	opts.cellXfs.forEach(function(c) {
		write_biff_rec(ba, 0x00e0 /* XF */, write_XF(c, 0, opts));
	});
}

function write_ws_biff8_hlinks(ba, ws) {
	for(var R=0; R<ws['!links'].length; ++R) {
		var HL = ws['!links'][R];
		write_biff_rec(ba, 0x01b8 /* HLink */, write_HLink(HL));
		if(HL[1].Tooltip) write_biff_rec(ba, 0x0800 /* HLinkTooltip */, write_HLinkTooltip(HL));
	}
	delete ws['!links'];
}

function write_ws_cols_biff8(ba, cols) {
	if(!cols) return;
	var cnt = 0;
	cols.forEach(function(col, idx) {
		if(++cnt <= 256 && col) {
			write_biff_rec(ba, 0x007d /* ColInfo */, write_ColInfo(col_obj_w(idx, col), idx));
		}
	});
}

function write_ws_biff8_cell(ba, cell, R, C, opts, date1904) {
	var os = 16 + get_cell_style(opts.cellXfs, cell, opts);
	if(cell.v == null && !cell.bf) {
		write_biff_rec(ba, 0x0201 /* Blank */, write_XLSCell(R, C, os));
		return;
	}
	if(cell.bf) write_biff_rec(ba, 0x0006 /* Formula */, write_Formula(cell, R, C, opts, os));
	else switch(cell.t) {
		case 'd': case 'n':
			var v = cell.t == 'd' ? datenum(parseDate(cell.v, date1904), date1904) : cell.v;
			if(isNaN(v)) write_biff_rec(ba, 0x0205 /* BoolErr */, write_BoolErr(R, C, 0x24, os, opts, "e")); // #NUM!
			else if(!isFinite(v)) write_biff_rec(ba, 0x0205 /* BoolErr */, write_BoolErr(R, C, 0x07, os, opts, "e")); // #DIV/0!
			/* TODO: emit RK as appropriate */
			else write_biff_rec(ba, 0x0203 /* Number */, write_Number(R, C, v, os, opts));
			break;
		case 'b': case 'e':
			write_biff_rec(ba, 0x0205 /* BoolErr */, write_BoolErr(R, C, cell.v, os, opts, cell.t));
			break;
		/* TODO: codepage, sst */
		case 's': case 'str':
			if(opts.bookSST) {
				var isst = get_sst_id(opts.Strings, cell.v == null ? "" : String(cell.v), opts.revStrings);
				write_biff_rec(ba, 0x00fd /* LabelSst */, write_LabelSst(R, C, isst, os, opts));
			} else write_biff_rec(ba, 0x0204 /* Label */, write_Label(R, C, (cell.v == null ? "" : String(cell.v)).slice(0,255), os, opts));
			break;
		default:
			write_biff_rec(ba, 0x0201 /* Blank */, write_XLSCell(R, C, os));
	}
}

/* [MS-XLS] 2.1.7.20.5 */
function write_ws_biff8(idx, opts, wb) {
	var ba = buf_array();
	var s = wb.SheetNames[idx], ws = wb.Sheets[s] || {};
	var _WB = ((wb||{}).Workbook||{});
	var _sheet = ((_WB.Sheets||[])[idx]||{});
	var dense = ws["!data"] != null;
	var b8 = opts.biff == 8;
	var ref, rr = "", cols = [];
	var range = safe_decode_range(ws['!ref'] || "A1");
	var MAX_ROWS = b8 ? 65536 : 16384;
	if(range.e.c > 0xFF || range.e.r >= MAX_ROWS) {
		if(opts.WTF) throw new Error("Range " + (ws['!ref'] || "A1") + " exceeds format limit A1:IV" + MAX_ROWS);
		range.e.c = Math.min(range.e.c, 0xFF);
		range.e.r = Math.min(range.e.r, MAX_ROWS-1);
	}

	write_biff_rec(ba, 0x0809, write_BOF(wb, 0x10, opts));
	/* [Uncalced] Index */
	write_biff_rec(ba, 0x000d /* CalcMode */, writeuint16(1));
	write_biff_rec(ba, 0x000c /* CalcCount */, writeuint16(100));
	write_biff_rec(ba, 0x000f /* CalcRefMode */, writebool(true));
	write_biff_rec(ba, 0x0011 /* CalcIter */, writebool(false));
	write_biff_rec(ba, 0x0010 /* CalcDelta */, write_Xnum(0.001));
	write_biff_rec(ba, 0x005f /* CalcSaveRecalc */, writebool(true));
	write_biff_rec(ba, 0x002a /* PrintRowCol */, writebool(false));
	write_biff_rec(ba, 0x002b /* PrintGrid */, writebool(false));
	write_biff_rec(ba, 0x0082 /* GridSet */, writeuint16(1));
	write_biff_rec(ba, 0x0080 /* Guts */, write_Guts([0,0]));
	/* DefaultRowHeight WsBool [Sync] [LPr] [HorizontalPageBreaks] [VerticalPageBreaks] */
	/* Header (string) */
	/* Footer (string) */
	write_biff_rec(ba, 0x0083 /* HCenter */, writebool(false));
	write_biff_rec(ba, 0x0084 /* VCenter */, writebool(false));
	/* ... */
	if(b8) write_ws_cols_biff8(ba, ws["!cols"]);
	/* ... */
	write_biff_rec(ba, 0x0200 /* Dimensions */, write_Dimensions(range, opts));
	/* ... */

	var date1904 = (((wb||{}).Workbook||{}).WBProps||{}).date1904;
	if(b8) ws['!links'] = [];
	for(var C = range.s.c; C <= range.e.c; ++C) cols[C] = encode_col(C);
	var comments = [];
	var row = [];
	for(var R = range.s.r; R <= range.e.r; ++R) {
		if(dense) row = ws["!data"][R] || [];
		rr = encode_row(R);
		for(C = range.s.c; C <= range.e.c; ++C) {
			var cell = dense ? row[C] : ws[cols[C] + rr];
			if(!cell) continue;
			/* write cell */
			write_ws_biff8_cell(ba, cell, R, C, opts, date1904);
			if(b8 && cell.l) ws['!links'].push([cols[C] + rr, cell.l]);
			if(cell.c) comments.push([cell.c, R, C]);
		}
	}
	var cname = _sheet.CodeName || _sheet.name || s;
	/* ... */
	if(b8) write_comments_biff8(ba, comments); else write_comments_biff2(ba, comments);
	/* ... */
	if(b8) write_biff_rec(ba, 0x023e /* Window2 */, write_Window2((_WB.Views||[])[0]));
	/* ... */
	if(b8 && (ws['!merges']||[]).length) write_biff_rec(ba, 0x00e5 /* MergeCells */, write_MergeCells(ws['!merges']));
	/* [LRng] *QUERYTABLE [PHONETICINFO] CONDFMTS */
	if(b8) write_ws_biff8_hlinks(ba, ws);
	/* [DVAL] */
	write_biff_rec(ba, 0x01ba /* CodeName */, write_XLUnicodeString(cname, opts));
	/* *WebPub *CellWatch [SheetExt] */
	if(b8) write_FEAT(ba, ws);
	/* *FEAT11 *RECORD12 */
	write_biff_rec(ba, 0x000a /* EOF */);
	return ba.end();
}

/* [MS-XLS] 2.1.7.20.3 */
function write_biff8_global(wb, bufs, opts) {
	var A = buf_array();
	var _WB = ((wb||{}).Workbook||{});
	var _sheets = (_WB.Sheets||[]);
	var _wb = _WB.WBProps||{};
	var b8 = opts.biff == 8, b5 = opts.biff == 5;
	write_biff_rec(A, 0x0809, write_BOF(wb, 0x05, opts));
	if(opts.bookType == "xla") write_biff_rec(A, 0x0087 /* Addin */);
	write_biff_rec(A, 0x00e1 /* InterfaceHdr */, b8 ? writeuint16(0x04b0) : null);
	write_biff_rec(A, 0x00c1 /* Mms */, writezeroes(2));
	if(b5) write_biff_rec(A, 0x00bf /* ToolbarHdr */);
	if(b5) write_biff_rec(A, 0x00c0 /* ToolbarEnd */);
	write_biff_rec(A, 0x00e2 /* InterfaceEnd */);
	write_biff_rec(A, 0x005c /* WriteAccess */, write_WriteAccess("SheetJS", opts));
	/* [FileSharing] */
	write_biff_rec(A, 0x0042 /* CodePage */, writeuint16(b8 ? 0x04b0 : 0x04E4));
	/* *2047 Lel */
	if(b8) write_biff_rec(A, 0x0161 /* DSF */, writeuint16(0));
	if(b8) write_biff_rec(A, 0x01c0 /* Excel9File */);
	write_biff_rec(A, 0x013d /* RRTabId */, write_RRTabId(wb.SheetNames.length));
	if(b8 && wb.vbaraw) write_biff_rec(A, 0x00d3 /* ObProj */);
	/* [ObNoMacros] */
	if(b8 && wb.vbaraw) {
		var cname = _wb.CodeName || "ThisWorkbook";
		write_biff_rec(A, 0x01ba /* CodeName */, write_XLUnicodeString(cname, opts));
	}
	write_biff_rec(A, 0x009c /* BuiltInFnGroupCount */, writeuint16(0x11));
	/* *FnGroupName *FnGrp12 */
	/* *Lbl */
	/* [OleObjectSize] */
	write_biff_rec(A, 0x0019 /* WinProtect */, writebool(false));
	write_biff_rec(A, 0x0012 /* Protect */, writebool(false));
	write_biff_rec(A, 0x0013 /* Password */, writeuint16(0));
	if(b8) write_biff_rec(A, 0x01af /* Prot4Rev */, writebool(false));
	if(b8) write_biff_rec(A, 0x01bc /* Prot4RevPass */, writeuint16(0));
	write_biff_rec(A, 0x003d /* Window1 */, write_Window1(opts));
	write_biff_rec(A, 0x0040 /* Backup */, writebool(false));
	write_biff_rec(A, 0x008d /* HideObj */, writeuint16(0));
	write_biff_rec(A, 0x0022 /* Date1904 */, writebool(safe1904(wb)=="true"));
	write_biff_rec(A, 0x000e /* CalcPrecision */, writebool(true));
	if(b8) write_biff_rec(A, 0x01b7 /* RefreshAll */, writebool(false));
	write_biff_rec(A, 0x00DA /* BookBool */, writeuint16(0));
	/* ... */
	write_FONTS_biff8(A, wb, opts);
	write_FMTS_biff8(A, wb.SSF, opts);
	write_CELLXFS_biff8(A, opts);
	/* ... */
	if(b8) write_biff_rec(A, 0x0160 /* UsesELFs */, writebool(false));
	var a = A.end();

	var C = buf_array();
	/* METADATA [MTRSettings] [ForceFullCalculation] */
	if(b8) write_biff_rec(C, 0x008C /* Country */, write_Country());
	/* *SUPBOOK *LBL *RTD [RecalcId] *HFPicture */

	/* BIFF8: MsoDrawingGroup [*Continue] */
	if(b8 && b8ocnts.length) write_biff_rec(C, 0x00EB /* MsoDrawingGroup */, write_MsoDrawingGroup());
	/* BIFF8: [SST *Continue] ExtSST */
	if(b8 && opts.Strings) write_biff_continue(C, 0x00FC /* SST */, write_SST(opts.Strings, opts));

	/* *WebPub [WOpt] [CrErr] [BookExt] *FeatHdr *DConn [THEME] [CompressPictures] [Compat12] [GUIDTypeLib] */
	write_biff_rec(C, 0x000A /* EOF */);
	var c = C.end();

	var B = buf_array();
	var blen = 0, j = 0;
	for(j = 0; j < wb.SheetNames.length; ++j) blen += (b8 ? 12 : 11) + (b8 ? 2 : 1) * wb.SheetNames[j].length;
	var start = a.length + blen + c.length;
	for(j = 0; j < wb.SheetNames.length; ++j) {
		var _sheet = _sheets[j] || ({});
		write_biff_rec(B, 0x0085 /* BoundSheet8 */, write_BoundSheet8({pos:start, hs:_sheet.Hidden||0, dt:0, name:wb.SheetNames[j]}, opts));
		start += bufs[j].length;
	}
	/* 1*BoundSheet8 */
	var b = B.end();
	if(blen != b.length) throw new Error("BS8 " + blen + " != " + b.length);

	var out = [];
	if(a.length) out.push(a);
	if(b.length) out.push(b);
	if(c.length) out.push(c);
	return bconcat(out);
}

/* [MS-XLS] 2.1.7.20 Workbook Stream */
function write_biff8_buf(wb, opts) {
	var o = opts || {};
	var bufs = [];

	if(wb && !wb.SSF) {
		wb.SSF = dup(table_fmt);
	}
	if(wb && wb.SSF) {
		make_ssf(); SSF_load_table(wb.SSF);
		// $FlowIgnore
		o.revssf = evert_num(wb.SSF); o.revssf[wb.SSF[65535]] = 0;
		o.ssf = wb.SSF;
	}

	b8oid = 1; b8ocnts = [];
	o.Strings = []; o.Strings.Count = 0; o.Strings.Unique = 0;
	fix_write_opts(o);

	o.cellXfs = [];
	get_cell_style(o.cellXfs, {}, {revssf:{"General":0}});

	if(!wb.Props) wb.Props = {};

	for(var i = 0; i < wb.SheetNames.length; ++i) bufs[bufs.length] = write_ws_biff8(i, o, wb);
	bufs.unshift(write_biff8_global(wb, bufs, o));
	return bconcat(bufs);
}

function write_biff_buf(wb, opts) {
	for(var i = 0; i <= wb.SheetNames.length; ++i) {
		var ws = wb.Sheets[wb.SheetNames[i]];
		if(!ws || !ws["!ref"]) continue;
		var range = decode_range(ws["!ref"]);
		if(range.e.c > 255) { // note: 255 is IV
			if(typeof console != "undefined" && console.error) console.error("Worksheet '" + wb.SheetNames[i] + "' extends beyond column IV (255).  Data may be lost.");
		}
		if(range.e.r > 65535) {
			if(typeof console != "undefined" && console.error) console.error("Worksheet '" + wb.SheetNames[i] + "' extends beyond row 65536.  Data may be lost.");
		}
	}

	var o = opts || {};
	switch(o.biff || 2) {
		case 8: case 5: return write_biff8_buf(wb, opts);
		case 4: case 3: case 2: return write_biff2_buf(wb, opts);
	}
	throw new Error("invalid type " + o.bookType + " for BIFF");
}
/* note: browser DOM element cannot see mso- style attrs, must parse */
function html_to_sheet(str, _opts) {
	var opts = _opts || {};
	var dense = (opts.dense != null) ? opts.dense : DENSE;
	var ws = ({}); if(dense) ws["!data"] = [];
	str = str_remove_ng(str, "<!--", "-->");
	var mtch = str.match(/<table/i);
	if(!mtch) throw new Error("Invalid HTML: could not find <table>");
	var mtch2 = str.match(/<\/table/i);
	var i = mtch.index, j = mtch2 && mtch2.index || str.length;
	var rows = split_regex(str.slice(i, j), /(:?<tr[^<>]*>)/i, "<tr>");
	var R = -1, C = 0, RS = 0, CS = 0;
	var range = {s:{r:10000000, c:10000000},e:{r:0,c:0}};
	var merges = [];
	for(i = 0; i < rows.length; ++i) {
		var row = rows[i].trim();
		var hd = row.slice(0,3).toLowerCase();
		if(hd == "<tr") { ++R; if(opts.sheetRows && opts.sheetRows <= R) { --R; break; } C = 0; continue; }
		if(hd != "<td" && hd != "<th") continue;
		var cells = row.split(/<\/t[dh]>/i);
		for(j = 0; j < cells.length; ++j) {
			var cell = cells[j].trim();
			if(!cell.match(/<t[dh]/i)) continue;
			var m = cell, cc = 0;
			/* TODO: parse styles etc */
			while(m.charAt(0) == "<" && (cc = m.indexOf(">")) > -1) m = m.slice(cc+1);
			for(var midx = 0; midx < merges.length; ++midx) {
				var _merge = merges[midx];
				if(_merge.s.c == C && _merge.s.r < R && R <= _merge.e.r) { C = _merge.e.c + 1; midx = -1; }
			}
			var tag = parsexmltag(cell.slice(0, cell.indexOf(">")));
			CS = tag.colspan ? +tag.colspan : 1;
			if((RS = +tag.rowspan)>1 || CS>1) merges.push({s:{r:R,c:C},e:{r:R + (RS||1) - 1, c:C + CS - 1}});
			var _t = tag.t || tag["data-t"] || "";
			/* TODO: generate stub cells */
			if(!m.length) { C += CS; continue; }
			m = htmldecode(m);
			if(range.s.r > R) range.s.r = R; if(range.e.r < R) range.e.r = R;
			if(range.s.c > C) range.s.c = C; if(range.e.c < C) range.e.c = C;
			if(!m.length) { C += CS; continue; }
			var o = {t:'s', v:m};
			if(opts.raw || !m.trim().length || _t == 's'){}
			else if(m === 'TRUE') o = {t:'b', v:true};
			else if(m === 'FALSE') o = {t:'b', v:false};
			else if(!isNaN(fuzzynum(m))) o = {t:'n', v:fuzzynum(m)};
			else if(!isNaN(fuzzydate(m).getDate())) {
				o = ({t:'d', v:parseDate(m)});
				if(opts.UTC === false) o.v = utc_to_local(o.v);
				if(!opts.cellDates) o = ({t:'n', v:datenum(o.v)});
				o.z = opts.dateNF || table_fmt[14];
			} else if(m.charCodeAt(0) == 35 /* # */ && RBErr[m] != null) {
				o.t = 'e'; o.w = m; o.v = RBErr[m];
			}
			if(o.cellText !== false) o.w = m;
			if(dense) { if(!ws["!data"][R]) ws["!data"][R] = []; ws["!data"][R][C] = o; }
			else ws[encode_cell({r:R, c:C})] = o;
			C += CS;
		}
	}
	ws['!ref'] = encode_range(range);
	if(merges.length) ws["!merges"] = merges;
	return ws;
}
function make_html_row(ws, r, R, o) {
	var M = (ws['!merges'] ||[]);
	var oo = [];
	var sp = ({});
	var dense = ws["!data"] != null;
	for(var C = r.s.c; C <= r.e.c; ++C) {
		var RS = 0, CS = 0;
		for(var j = 0; j < M.length; ++j) {
			if(M[j].s.r > R || M[j].s.c > C) continue;
			if(M[j].e.r < R || M[j].e.c < C) continue;
			if(M[j].s.r < R || M[j].s.c < C) { RS = -1; break; }
			RS = M[j].e.r - M[j].s.r + 1; CS = M[j].e.c - M[j].s.c + 1; break;
		}
		if(RS < 0) continue;
		var coord = encode_col(C) + encode_row(R);
		var cell = dense ? (ws["!data"][R]||[])[C] : ws[coord];
		if(cell && cell.t == 'n' && cell.v != null && !isFinite(cell.v)) {
			if(isNaN(cell.v)) cell = ({t:'e', v:0x24, w:BErr[0x24]});
			else cell = ({t:'e', v:0x07, w:BErr[0x07]});
		}
		/* TODO: html entities */
		var w = (cell && cell.v != null) && (cell.h || escapehtml(cell.w || (format_cell(cell), cell.w) || "")) || "";
		sp = ({});
		if(RS > 1) sp.rowspan = RS;
		if(CS > 1) sp.colspan = CS;
		if(o.editable) w = '<span contenteditable="true">' + w + '</span>';
		else if(cell) {
			sp["data-t"] = cell && cell.t || 'z';
			// note: data-v is unaffected by the timezone interpretation
			if(cell.v != null) sp["data-v"] = escapehtml(cell.v instanceof Date ? cell.v.toISOString() : cell.v);
			if(cell.z != null) sp["data-z"] = cell.z;
			if(cell.l && (cell.l.Target || "#").charAt(0) != "#") w = '<a href="' + escapehtml(cell.l.Target) +'">' + w + '</a>';
		}
		sp.id = (o.id || "sjs") + "-" + coord;
		oo.push(writextag('td', w, sp));
	}
	var preamble = "<tr>";
	return preamble + oo.join("") + "</tr>";
}

var HTML_BEGIN = '<html><head><meta charset="utf-8"/><title>SheetJS Table Export</title></head><body>';
var HTML_END = '</body></html>';

function html_to_workbook(str, opts) {
	var mtch = str_match_xml_ig(str, "table");
	if(!mtch || mtch.length == 0) throw new Error("Invalid HTML: could not find <table>");
	if(mtch.length == 1) {
		var w = sheet_to_workbook(html_to_sheet(mtch[0], opts), opts);
		w.bookType = "html";
		return w;
	}
	var wb = book_new();
	mtch.forEach(function(s, idx) { book_append_sheet(wb, html_to_sheet(s, opts), "Sheet" + (idx+1)); });
	wb.bookType = "html";
	return wb;
}

function make_html_preamble(ws, R, o) {
	var out = [];
	return out.join("") + '<table' + (o && o.id ? ' id="' + o.id + '"' : "") + '>';
}

function sheet_to_html(ws, opts/*, wb:?Workbook*/) {
	var o = opts || {};
	var header = o.header != null ? o.header : HTML_BEGIN;
	var footer = o.footer != null ? o.footer : HTML_END;
	var out = [header];
	var r = decode_range(ws['!ref'] || "A1");
	out.push(make_html_preamble(ws, r, o));
	if(ws["!ref"]) for(var R = r.s.r; R <= r.e.r; ++R) out.push(make_html_row(ws, r, R, o));
	out.push("</table>" + footer);
	return out.join("");
}

function sheet_add_dom(ws, table, _opts) {
	var rows = table.rows;
	if(!rows) {
		/* not an HTML TABLE */
		throw "Unsupported origin when " + table.tagName + " is not a TABLE";
	}

	var opts = _opts || {};
	var dense = ws["!data"] != null;
	var or_R = 0, or_C = 0;
	if(opts.origin != null) {
		if(typeof opts.origin == 'number') or_R = opts.origin;
		else {
			var _origin = typeof opts.origin == "string" ? decode_cell(opts.origin) : opts.origin;
			or_R = _origin.r; or_C = _origin.c;
		}
	}

	var sheetRows = Math.min(opts.sheetRows||10000000, rows.length);
	var range = {s:{r:0,c:0},e:{r:or_R,c:or_C}};
	if(ws["!ref"]) {
		var _range = decode_range(ws["!ref"]);
		range.s.r = Math.min(range.s.r, _range.s.r);
		range.s.c = Math.min(range.s.c, _range.s.c);
		range.e.r = Math.max(range.e.r, _range.e.r);
		range.e.c = Math.max(range.e.c, _range.e.c);
		if(or_R == -1) range.e.r = or_R = _range.e.r + 1;
	}
	var merges = [], midx = 0;
	var rowinfo = ws["!rows"] || (ws["!rows"] = []);
	var _R = 0, R = 0, _C = 0, C = 0, RS = 0, CS = 0;
	if(!ws["!cols"]) ws['!cols'] = [];
	for(; _R < rows.length && R < sheetRows; ++_R) {
		var row = rows[_R];
		if (is_dom_element_hidden(row)) {
			if (opts.display) continue;
			rowinfo[R] = {hidden: true};
		}
		var elts = (row.cells);
		for(_C = C = 0; _C < elts.length; ++_C) {
			var elt = elts[_C];
			if (opts.display && is_dom_element_hidden(elt)) continue;
			var v = elt.hasAttribute('data-v') ? elt.getAttribute('data-v') : elt.hasAttribute('v') ? elt.getAttribute('v') : htmldecode(elt.innerHTML);
			var z = elt.getAttribute('data-z') || elt.getAttribute('z');
			for(midx = 0; midx < merges.length; ++midx) {
				var m = merges[midx];
				if(m.s.c == C + or_C && m.s.r < R + or_R && R + or_R <= m.e.r) { C = m.e.c+1 - or_C; midx = -1; }
			}
			/* TODO: figure out how to extract nonstandard mso- style */
			CS = +elt.getAttribute("colspan") || 1;
			if( ((RS = (+elt.getAttribute("rowspan") || 1)))>1 || CS>1) merges.push({s:{r:R + or_R,c:C + or_C},e:{r:R + or_R + (RS||1) - 1, c:C + or_C + (CS||1) - 1}});
			var o = {t:'s', v:v};
			var _t = elt.getAttribute("data-t") || elt.getAttribute("t") || "";
			if(v != null) {
				if(v.length == 0) o.t = _t || 'z';
				else if(opts.raw || v.trim().length == 0 || _t == "s"){}
				else if(_t == "e" && BErr[+v]) o = {t:'e', v:+v, w: BErr[+v]};
				else if(v === 'TRUE') o = {t:'b', v:true};
				else if(v === 'FALSE') o = {t:'b', v:false};
				else if(!isNaN(fuzzynum(v))) o = {t:'n', v:fuzzynum(v)};
				else if(!isNaN(fuzzydate(v).getDate())) {
					o = ({t:'d', v:parseDate(v)});
					if(opts.UTC) o.v = local_to_utc(o.v);
					if(!opts.cellDates) o = ({t:'n', v:datenum(o.v)});
					o.z = opts.dateNF || table_fmt[14];
				} else if(v.charCodeAt(0) == 35 /* # */ && RBErr[v] != null) o = ({t:'e', v: RBErr[v], w: v});
			}
			if(o.z === undefined && z != null) o.z = z;
			/* The first link is used.  Links are assumed to be fully specified.
			 * TODO: The right way to undefined relative links is to make a new <a> */
			var l = "", Aelts = elt.getElementsByTagName("A");
			if(Aelts && Aelts.length) for(var Aelti = 0; Aelti < Aelts.length; ++Aelti)	if(Aelts[Aelti].hasAttribute("href")) {
				l = Aelts[Aelti].getAttribute("href"); if(l.charAt(0) != "#") break;
			}
			if(l && l.charAt(0) != "#" &&	l.slice(0, 11).toLowerCase() != 'javascript:') o.l = ({ Target: l });
			if(dense) { if(!ws["!data"][R + or_R]) ws["!data"][R + or_R] = []; ws["!data"][R + or_R][C + or_C] = o; }
			else ws[encode_cell({c:C + or_C, r:R + or_R})] = o;
			if(range.e.c < C + or_C) range.e.c = C + or_C;
			C += CS;
		}
		++R;
	}
	if(merges.length) ws['!merges'] = (ws["!merges"] || []).concat(merges);
	range.e.r = Math.max(range.e.r, R - 1 + or_R);
	ws['!ref'] = encode_range(range);
	if(R >= sheetRows) ws['!fullref'] = encode_range((range.e.r = rows.length-_R+R-1 + or_R,range)); // We can count the real number of rows to parse but we don't to improve the performance
	return ws;
}

function parse_dom_table(table, _opts) {
	var opts = _opts || {};
	var ws = ({}); if(opts.dense) ws["!data"] = [];
	return sheet_add_dom(ws, table, _opts);
}

function table_to_book(table, opts) {
	var o = sheet_to_workbook(parse_dom_table(table, opts), opts);
	//o.bookType = "dom"; // TODO: define a type for this
	return o;
}

function is_dom_element_hidden(element) {
	var display = '';
	var get_computed_style = get_get_computed_style_function(element);
	if(get_computed_style) display = get_computed_style(element).getPropertyValue('display');
	if(!display) display = element.style && element.style.display;
	return display === 'none';
}

/* global getComputedStyle */
function get_get_computed_style_function(element) {
	// The proper getComputedStyle implementation is the one defined in the element window
	if(element.ownerDocument.defaultView && typeof element.ownerDocument.defaultView.getComputedStyle === 'function') return element.ownerDocument.defaultView.getComputedStyle;
	// If it is not available, try to get one from the global namespace
	if(typeof getComputedStyle === 'function') return getComputedStyle;
	return null;
}
/* OpenDocument */
function parse_text_p(text) {
	/* 6.1.2 White Space Characters */
	var fixed = text
		.replace(/[\t\r\n]/g, " ").trim().replace(/ +/g, " ")
		.replace(/<text:s\/>/g," ")
		.replace(/<text:s text:c="(\d+)"\/>/g, function($$,$1) { return Array(parseInt($1,10)+1).join(" "); })
		.replace(/<text:tab[^<>]*\/>/g,"\t")
		.replace(/<text:line-break\/>/g,"\n");
	var v = unescapexml(fixed.replace(/<[^<>]*>/g,""));

	return [v];
}

/* Note: ODS can stick styles in content.xml or styles.xml, FODS blurs lines */
function parse_ods_styles(d, _opts, _nfm) {
	var number_format_map = _nfm || {};
	var str = xlml_normalize(d);
	xlmlregex.lastIndex = 0;
	str = remove_doctype(str_remove_ng(str, "<!--", "-->"));
	var Rn, NFtag, NF = "", tNF = "", y, etpos = 0, tidx = -1, infmt = false, payload = "";
	while((Rn = xlmlregex.exec(str))) {
		switch((Rn[3]=Rn[3].replace(/_[\s\S]*$/,""))) {
		/* Number Format Definitions */
		case 'number-style': // <number:number-style> 16.29.2
		case 'currency-style': // <number:currency-style> 16.29.8
		case 'percentage-style': // <number:percentage-style> 16.29.10
		case 'date-style': // <number:date-style> 16.29.11
		case 'time-style': // <number:time-style> 16.29.19
		case 'text-style': // <number:text-style> 16.29.26
			if(Rn[1]==='/') {
				infmt = false;
				if(NFtag['truncate-on-overflow'] == "false") {
					if(NF.match(/h/)) NF = NF.replace(/h+/, "[$&]");
					else if(NF.match(/m/)) NF = NF.replace(/m+/, "[$&]");
					else if(NF.match(/s/)) NF = NF.replace(/s+/, "[$&]");
				}
				number_format_map[NFtag.name] = NF;
				NF = "";
			} else if(Rn[0].charAt(Rn[0].length-2) !== '/') {
				infmt = true;
				NF = "";
				NFtag = parsexmltag(Rn[0], false);
			} break;

		// LibreOffice bug https://bugs.documentfoundation.org/show_bug.cgi?id=149484
		case 'boolean-style': // <number:boolean-style> 16.29.24
			if(Rn[1]==='/') {
				infmt = false;
				number_format_map[NFtag.name] = "General";
				NF = "";
			} else if(Rn[0].charAt(Rn[0].length-2) !== '/') {
				infmt = true;
				NF = "";
				NFtag = parsexmltag(Rn[0], false);
			} break;

		/* Number Format Elements */
		case 'boolean': // <number:boolean> 16.29.25
			NF += "General"; // ODF spec is unfortunately underspecified here
			break;

		case 'text': // <number:text> 16.29.27
			if(Rn[1]==='/') {
				payload = str.slice(tidx, xlmlregex.lastIndex - Rn[0].length);
				// NOTE: Excel has a different interpretation of "%%" and friends
				if(payload == "%" && NFtag[0] == '<number:percentage-style') NF += "%";
				else NF += '"' + payload.replace(/"/g, '""') + '"';
			} else if(Rn[0].charAt(Rn[0].length-2) !== '/') {
				tidx = xlmlregex.lastIndex;
			} break;


		case 'day': { // <number:day> 16.29.12
			y = parsexmltag(Rn[0], false);
			switch(y["style"]) {
				case "short": NF += "d"; break;
				case "long": NF += "dd"; break;
				default: NF += "dd"; break; // TODO: error condition
			}
		} break;

		case 'day-of-week': { // <number:day-of-week> 16.29.16
			y = parsexmltag(Rn[0], false);
			switch(y["style"]) {
				case "short": NF += "ddd"; break;
				case "long": NF += "dddd"; break;
				default: NF += "ddd"; break;
			}
		} break;

		case 'era': { // <number:era> 16.29.15 TODO: proper mapping
			y = parsexmltag(Rn[0], false);
			switch(y["style"]) {
				case "short": NF += "ee"; break;
				case "long": NF += "eeee"; break;
				default: NF += "eeee"; break; // TODO: error condition
			}
		} break;

		case 'hours': { // <number:hours> 16.29.20
			y = parsexmltag(Rn[0], false);
			switch(y["style"]) {
				case "short": NF += "h"; break;
				case "long": NF += "hh"; break;
				default: NF += "hh"; break; // TODO: error condition
			}
		} break;

		case 'minutes': { // <number:minutes> 16.29.21
			y = parsexmltag(Rn[0], false);
			switch(y["style"]) {
				case "short": NF += "m"; break;
				case "long": NF += "mm"; break;
				default: NF += "mm"; break; // TODO: error condition
			}
		} break;

		case 'month': { // <number:month> 16.29.13
			y = parsexmltag(Rn[0], false);
			if(y["textual"]) NF += "mm";
			switch(y["style"]) {
				case "short": NF += "m"; break;
				case "long": NF += "mm"; break;
				default: NF += "m"; break;
			}
		} break;

		case 'seconds': { // <number:seconds> 16.29.22
			y = parsexmltag(Rn[0], false);
			switch(y["style"]) {
				case "short": NF += "s"; break;
				case "long": NF += "ss"; break;
				default: NF += "ss"; break; // TODO: error condition
			}
			if(y["decimal-places"]) NF += "." + fill("0", +y["decimal-places"]);
		} break;

		case 'year': { // <number:year> 16.29.14
			y = parsexmltag(Rn[0], false);
			switch(y["style"]) {
				case "short": NF += "yy"; break;
				case "long": NF += "yyyy"; break;
				default: NF += "yy"; break; // TODO: error condition
			}
		} break;

		case 'am-pm': // <number:am-pm> 16.29.23
			NF += "AM/PM"; // LO autocorrects A/P -> AM/PM
			break;

		case 'week-of-year': // <number:week-of-year> 16.29.17
		case 'quarter': // <number:quarter> 16.29.18
			console.error("Excel does not support ODS format token " + Rn[3]);
			break;

		case 'fill-character': // <number:fill-character> 16.29.5
			if(Rn[1]==='/') {
				payload = str.slice(tidx, xlmlregex.lastIndex - Rn[0].length);
				// NOTE: Excel has a different interpretation of "%%" and friends
				NF += '"' + payload.replace(/"/g, '""') + '"*';
			} else if(Rn[0].charAt(Rn[0].length-2) !== '/') {
				tidx = xlmlregex.lastIndex;
			} break;

		case 'scientific-number': // <number:scientific-number> 16.29.6
			// TODO: find a mapping for all parameters
			y = parsexmltag(Rn[0], false);
			NF += "0." + fill("0", +y["min-decimal-places"] || +y["decimal-places"] || 2) + fill("?", +y["decimal-places"] - +y["min-decimal-places"] || 0) + "E" + (parsexmlbool(y["forced-exponent-sign"]) ? "+" : "") + fill("0", +y["min-exponent-digits"] || 2);
			break;

		case 'fraction': // <number:fraction> 16.29.7
			// TODO: find a mapping for all parameters
			y = parsexmltag(Rn[0], false);
			if(!+y["min-integer-digits"]) NF += "#";
			else NF += fill("0", +y["min-integer-digits"]);
			NF += " ";
			NF += fill("?", +y["min-numerator-digits"] || 1);
			NF += "/";
			if(+y["denominator-value"]) NF += y["denominator-value"];
			else NF += fill("?", +y["min-denominator-digits"] || 1);
			break;

		case 'currency-symbol': // <number:currency-symbol> 16.29.9
			// TODO: localization with [$-...]
			if(Rn[1]==='/') {
				NF += '"' + str.slice(tidx, xlmlregex.lastIndex - Rn[0].length).replace(/"/g, '""') + '"';
			} else if(Rn[0].charAt(Rn[0].length-2) !== '/') {
				tidx = xlmlregex.lastIndex;
			} else NF += "$";
			break;

		case 'text-properties': // <style:text-properties> 16.29.29
			y = parsexmltag(Rn[0], false);
			switch((y["color"]||"").toLowerCase().replace("#", "")) {
				case "ff0000": case "red": NF = "[Red]" + NF; break;
			}
			break;

		case 'text-content': // <number:text-content> 16.29.28
			NF += "@";
			break;

		case 'map': // <style:map> 16.3
			// TODO: handle more complex maps
			y = parsexmltag(Rn[0], false);
			if(unescapexml(y["condition"]) == "value()>=0") NF = number_format_map[y["apply-style-name"]] + ";" + NF;
			else console.error("ODS number format may be incorrect: " + y["condition"]);
			break;

		case 'number': // <number:number> 16.29.3
			// TODO: handle all the attributes
			if(Rn[1]==='/') break;
			y = parsexmltag(Rn[0], false);
			tNF = "";
			tNF += fill("0", +y["min-integer-digits"] || 1);
			if(parsexmlbool(y["grouping"])) tNF = commaify(fill("#", Math.max(0, 4 - tNF.length)) + tNF);
			if(+y["min-decimal-places"] || +y["decimal-places"]) tNF += ".";
			if(+y["min-decimal-places"]) tNF += fill("0", +y["min-decimal-places"] || 1);
			if(+y["decimal-places"] - (+y["min-decimal-places"]||0)) tNF += fill("0", +y["decimal-places"] - (+y["min-decimal-places"]||0)); // TODO: should this be "#" ?
			NF += tNF;
			break;

		case 'embedded-text': // <number:embedded-text> 16.29.4
			// TODO: verify interplay with grouping et al
			if(Rn[1]==='/') {
				if(etpos == 0) NF += '"' + str.slice(tidx, xlmlregex.lastIndex - Rn[0].length).replace(/"/g, '""') + '"';
				else NF = NF.slice(0, etpos) + '"' + str.slice(tidx, xlmlregex.lastIndex - Rn[0].length).replace(/"/g, '""') + '"' + NF.slice(etpos);
			} else if(Rn[0].charAt(Rn[0].length-2) !== '/') {
				tidx = xlmlregex.lastIndex;
				etpos = -+parsexmltag(Rn[0], false)["position"] || 0;
			} break;

	}}
	return number_format_map;
}

function parse_content_xml(d, _opts, _nfm) {
		var opts = _opts || {};
		if(DENSE != null && opts.dense == null) opts.dense = DENSE;
		var str = xlml_normalize(d);
		var state = [], tmp;
		var tag;
		var nfidx, NF = "", pidx = 0;
		var sheetag;
		var rowtag;
		var Sheets = {}, SheetNames = [];
		var ws = ({}); if(opts.dense) ws["!data"] = [];
		var Rn, q;
		var ctag = ({value:""}), ctag2 = ({});
		var textp = "", textpidx = 0, textptag, oldtextp = "", oldtextpidx = 0;
		var textR = [], oldtextR = [];
		var R = -1, C = -1, range = {s: {r:1000000,c:10000000}, e: {r:0, c:0}};
		var row_ol = 0;
		var number_format_map = _nfm || {}, styles = {};
		var merges = [], mrange = {}, mR = 0, mC = 0;
		var rowinfo = [], rowpeat = 1, colpeat = 1;
		var arrayf = [];
		var WB = {Names:[], WBProps:{}};
		var atag = ({});
		var _Ref = ["", ""];
		var comments = [], comment = ({});
		var creator = "", creatoridx = 0;
		var isstub = false, intable = false;
		var i = 0;
		xlmlregex.lastIndex = 0;
		str = remove_doctype(str_remove_ng(str, "<!--", "-->"));
		while((Rn = xlmlregex.exec(str))) switch((Rn[3]=Rn[3].replace(/_[\s\S]*$/,""))) {

			case 'table': case '工作表': // 9.1.2 <table:table>
				if(Rn[1]==='/') {
					if(range.e.c >= range.s.c && range.e.r >= range.s.r) ws['!ref'] = encode_range(range);
					else ws['!ref'] = "A1:A1";
					if(opts.sheetRows > 0 && opts.sheetRows <= range.e.r) {
						ws['!fullref'] = ws['!ref'];
						range.e.r = opts.sheetRows - 1;
						ws['!ref'] = encode_range(range);
					}
					if(merges.length) ws['!merges'] = merges;
					if(rowinfo.length) ws["!rows"] = rowinfo;
					sheetag.name = sheetag['名称'] || sheetag.name;
					if(typeof JSON !== 'undefined') JSON.stringify(sheetag);
					SheetNames.push(sheetag.name);
					Sheets[sheetag.name] = ws;
					intable = false;
				}
				else if(Rn[0].charAt(Rn[0].length-2) !== '/') {
					sheetag = parsexmltag(Rn[0], false);
					R = C = -1;
					range.s.r = range.s.c = 10000000; range.e.r = range.e.c = 0;
					ws = ({}); if(opts.dense) ws["!data"] = []; merges = [];
					rowinfo = [];
					intable = true;
				}
				break;

			case 'table-row-group': // 9.1.9 <table:table-row-group>
				if(Rn[1] === "/") --row_ol; else ++row_ol;
				break;
			case 'table-row': case '行': // 9.1.3 <table:table-row>
				if(Rn[1] === '/') { R+=rowpeat; rowpeat = 1; break; }
				rowtag = parsexmltag(Rn[0], false);
				if(rowtag['行号']) R = rowtag['行号'] - 1; else if(R == -1) R = 0;
				rowpeat = +rowtag['number-rows-repeated'] || 1;
				/* TODO: remove magic */
				if(rowpeat < 10) for(i = 0; i < rowpeat; ++i) if(row_ol > 0) rowinfo[R + i] = {level: row_ol};
				C = -1; break;
			case 'covered-table-cell': // 9.1.5 <table:covered-table-cell>
				if(Rn[1] !== '/') {
					++C;
					ctag = parsexmltag(Rn[0], false);
					colpeat = parseInt(ctag['number-columns-repeated']||"1",10) || 1;
					if(opts.sheetStubs) {
						while(colpeat-- > 0) {
							if(opts.dense) { if(!ws["!data"][R]) ws["!data"][R] = []; ws["!data"][R][C] = {t:'z'}; }
							else ws[encode_cell({r:R,c:C})] = {t:'z'};
							++C;
						} --C;
					}
					else C += colpeat - 1;
				}
				textp = ""; textR = [];
				break; /* stub */
			case 'table-cell': case '数据':
				if(Rn[0].charAt(Rn[0].length-2) === '/') {
					++C;
					ctag = parsexmltag(Rn[0], false);
					colpeat = parseInt(ctag['number-columns-repeated']||"1", 10)||1;
					q = ({t:'z', v:null});
					if(ctag.formula && opts.cellFormula != false) q.f = ods_to_csf_formula(unescapexml(ctag.formula));
					if(ctag["style-name"] && styles[ctag["style-name"]]) q.z = styles[ctag["style-name"]];
					if((ctag['数据类型'] || ctag['value-type']) == "string") {
						q.t = "s"; q.v = unescapexml(ctag['string-value'] || "");
						if(opts.dense) {
							if(!ws["!data"][R]) ws["!data"][R] = [];
							ws["!data"][R][C] = q;
						} else {
							ws[encode_col(C) + encode_row(R)] = q;
						}
					}
					C+= colpeat-1;
				} else if(Rn[1]!=='/') {
					++C;
					textp = oldtextp = ""; textpidx = oldtextpidx = 0; textR = []; oldtextR = [];
					colpeat = 1;
					var rptR = rowpeat ? R + rowpeat - 1 : R;
					if(C > range.e.c) range.e.c = C;
					if(C < range.s.c) range.s.c = C;
					if(R < range.s.r) range.s.r = R;
					if(rptR > range.e.r) range.e.r = rptR;
					ctag = parsexmltag(Rn[0], false);
					ctag2 = parsexmltagraw(Rn[0], true);
					comments = []; comment = ({});
					q = ({t:ctag['数据类型'] || ctag['value-type'], v:null});
					if(ctag["style-name"] && styles[ctag["style-name"]]) q.z = styles[ctag["style-name"]];
					if(opts.cellFormula) {
						if(ctag.formula) ctag.formula = unescapexml(ctag.formula);
						if(ctag['number-matrix-columns-spanned'] && ctag['number-matrix-rows-spanned']) {
							mR = parseInt(ctag['number-matrix-rows-spanned'],10) || 0;
							mC = parseInt(ctag['number-matrix-columns-spanned'],10) || 0;
							mrange = {s: {r:R,c:C}, e:{r:R + mR-1,c:C + mC-1}};
							q.F = encode_range(mrange);
							arrayf.push([mrange, q.F]);
						}
						if(ctag.formula) q.f = ods_to_csf_formula(ctag.formula);
						else for(i = 0; i < arrayf.length; ++i)
							if(R >= arrayf[i][0].s.r && R <= arrayf[i][0].e.r)
								if(C >= arrayf[i][0].s.c && C <= arrayf[i][0].e.c)
									q.F = arrayf[i][1];
					}
					if(ctag['number-columns-spanned'] || ctag['number-rows-spanned']) {
						mR = parseInt(ctag['number-rows-spanned']||"1",10) || 1;
						mC = parseInt(ctag['number-columns-spanned']||"1",10) || 1;
						if(mR * mC > 1) {
							mrange = {s: {r:R,c:C}, e:{r:R + mR-1,c:C + mC-1}};
							merges.push(mrange);
						}
					}

					/* 19.675.2 table:number-columns-repeated */
					if(ctag['number-columns-repeated']) colpeat = parseInt(ctag['number-columns-repeated'], 10);

					/* 19.385 office:value-type TODO: verify ODS and UOS */
					switch(q.t) {
						case 'boolean': q.t = 'b'; q.v = parsexmlbool(ctag['boolean-value']) || (+ctag['boolean-value'] >= 1); break;
						case 'float': q.t = 'n'; q.v = parseFloat(ctag.value);
							if(opts.cellDates && q.z && fmt_is_date(q.z)) { q.v = numdate(q.v + (WB.WBProps.date1904 ? 1462 : 0)); q.t = typeof q.v == "number" ? 'n' : 'd'; }
							break;
						case 'percentage': q.t = 'n'; q.v = parseFloat(ctag.value); break;
						case 'currency': q.t = 'n'; q.v = parseFloat(ctag.value); break;
						case 'date': q.t = 'd'; q.v = parseDate(ctag['date-value'], WB.WBProps.date1904);
							if(!opts.cellDates) { q.t = 'n'; q.v = datenum(q.v, WB.WBProps.date1904); }
							if(!q.z) q.z = 'm/d/yy'; break;
						/* NOTE: for `time`, Excel ODS export incorrectly uses durations relative to 1900 epoch even if 1904 is specified */
						case 'time': q.t = 'n'; q.v = parse_isodur(ctag['time-value'])/86400;
							if(opts.cellDates) { q.v = numdate(q.v); q.t = typeof q.v == "number" ? 'n' : 'd'; }
							if(!q.z) q.z = 'HH:MM:SS'; break;
						case 'number': q.t = 'n'; q.v = parseFloat(ctag['数据数值']);
							break;
						default:
							if(q.t === 'string' || q.t === 'text' || !q.t) {
								q.t = 's';
								if(ctag['string-value'] != null) { textp = unescapexml(ctag['string-value']); textR = []; }
							} else throw new Error('Unsupported value type ' + q.t);
					}
				} else {
					isstub = false;
					if(ctag2['calcext:value-type'] == "error" && RBErr[textp] != null) {
						q.t = 'e'; q.w = textp; q.v = RBErr[textp];
					}
					if(q.t === 's') {
						q.v = textp || '';
						if(textR.length) q.R = textR;
						isstub = textpidx == 0;
					}
					if(atag.Target) q.l = atag;
					if(comments.length > 0) { q.c = comments; comments = []; }
					if(textp && opts.cellText !== false) q.w = textp;
					if(isstub) { q.t = "z"; delete q.v; }
					if(!isstub || opts.sheetStubs) {
						if(!(opts.sheetRows && opts.sheetRows <= R)) {
							for(var rpt = 0; rpt < rowpeat; ++rpt) {
								colpeat = parseInt(ctag['number-columns-repeated']||"1", 10);
								if(opts.dense) {
									if(!ws["!data"][R + rpt]) ws["!data"][R + rpt] = [];
									ws["!data"][R + rpt][C] = rpt == 0 ? q : dup(q);
									while(--colpeat > 0) ws["!data"][R + rpt][C + colpeat] = dup(q);
								} else {
									ws[encode_cell({r:R + rpt,c:C})] = q;
									while(--colpeat > 0) ws[encode_cell({r:R + rpt,c:C + colpeat})] = dup(q);
								}
								if(range.e.c <= C) range.e.c = C;
							}
						}
					}
					colpeat = parseInt(ctag['number-columns-repeated']||"1", 10);
					C += colpeat-1; colpeat = 0;
					q = {};
					textp = ""; textR = [];
				}
				atag = ({});
				break; // 9.1.4 <table:table-cell>

			/* pure state */
			case 'document': // TODO: <office:document> is the root for FODS
			case 'document-content': case '电子表格文档': // 3.1.3.2 <office:document-content>
			case 'spreadsheet': case '主体': // 3.7 <office:spreadsheet>
			case 'scripts': // 3.12 <office:scripts>
			case 'styles': // TODO <office:styles>
			case 'font-face-decls': // 3.14 <office:font-face-decls>
			case 'master-styles': // 3.15.4 <office:master-styles> -- relevant for FODS
				if(Rn[1]==='/'){if((tmp=state.pop())[0]!==Rn[3]) throw "Bad state: "+tmp;}
				else if(Rn[0].charAt(Rn[0].length-2) !== '/') state.push([Rn[3], true]);
				break;

			case 'annotation': // 14.1 <office:annotation>
				if(Rn[1]==='/'){
					if((tmp=state.pop())[0]!==Rn[3]) throw "Bad state: "+tmp;
					comment.t = textp;
					if(textR.length) comment.R = textR;
					comment.a = creator;
					comments.push(comment);
					textp = oldtextp; textpidx = oldtextpidx; textR = oldtextR;
				}
				else if(Rn[0].charAt(Rn[0].length-2) !== '/') {
					state.push([Rn[3], false]);
					var annotag = parsexmltag(Rn[0], true);
					/* office:display TODO: check if there is a global override */
					if(!(annotag["display"] && parsexmlbool(annotag["display"]))) comments.hidden = true;
					oldtextp = textp; oldtextpidx = textpidx; oldtextR = textR;
					textp = ""; textpidx = 0; textR = [];
				}
				creator = ""; creatoridx = 0;
				break;

			case 'creator': // 4.3.2.7 <dc:creator>
				if(Rn[1]==='/') { creator = str.slice(creatoridx,Rn.index); }
				else creatoridx = Rn.index + Rn[0].length;
				break;

			/* ignore state */
			case 'meta': case '元数据': // TODO: <office:meta> <uof:元数据> FODS/UOF
			case 'settings': // TODO: <office:settings>
			case 'config-item-set': // TODO: <office:config-item-set>
			case 'config-item-map-indexed': // TODO: <office:config-item-map-indexed>
			case 'config-item-map-entry': // TODO: <office:config-item-map-entry>
			case 'config-item-map-named': // TODO: <office:config-item-map-entry>
			case 'shapes': // 9.2.8 <table:shapes>
			case 'frame': // 10.4.2 <draw:frame>
			case 'text-box': // 10.4.3 <draw:text-box>
			case 'image': // 10.4.4 <draw:image>
			case 'data-pilot-tables': // 9.6.2 <table:data-pilot-tables>
			case 'list-style': // 16.30 <text:list-style>
			case 'form': // 13.13 <form:form>
			case 'dde-links': // 9.8 <table:dde-links>
			case 'event-listeners': // TODO
			case 'chart': // TODO
				if(Rn[1]==='/'){if((tmp=state.pop())[0]!==Rn[3]) throw "Bad state: "+tmp;}
				else if(Rn[0].charAt(Rn[0].length-2) !== '/') state.push([Rn[3], false]);
				textp = ""; textpidx = 0; textR = [];
				break;

			case 'scientific-number': // <number:scientific-number>
			case 'currency-symbol': // <number:currency-symbol>
			case 'fill-character': // 16.29.5 <number:fill-character>
				break;

			case 'text-style': // 16.27.25 <number:text-style>
			case 'boolean-style': // 16.27.23 <number:boolean-style>
			case 'number-style': // 16.27.2 <number:number-style>
			case 'currency-style': // 16.29.8 <number:currency-style>
			case 'percentage-style': // 16.27.9 <number:percentage-style>
			case 'date-style': // 16.27.10 <number:date-style>
			case 'time-style': // 16.27.18 <number:time-style>
				if(Rn[1]==='/'){
					var xlmlidx = xlmlregex.lastIndex;
					parse_ods_styles(str.slice(nfidx, xlmlregex.lastIndex), _opts, number_format_map);
					xlmlregex.lastIndex = xlmlidx;
				} else if(Rn[0].charAt(Rn[0].length-2) !== '/') {
					nfidx = xlmlregex.lastIndex - Rn[0].length;
				} break;

			case 'script': break; // 3.13 <office:script>
			case 'libraries': break; // TODO: <ooo:libraries>
			case 'automatic-styles': break; // 3.15.3 <office:automatic-styles>

			case 'default-style': // TODO: <style:default-style>
			case 'page-layout': break; // TODO: <style:page-layout>
			case 'style': { // 16.2 <style:style>
				var styletag = parsexmltag(Rn[0], false);
				if(styletag["family"] == "table-cell" && number_format_map[styletag["data-style-name"]]) styles[styletag["name"]] = number_format_map[styletag["data-style-name"]];
			} break;
			case 'map': break; // 16.3 <style:map>
			case 'font-face': break; // 16.21 <style:font-face>

			case 'paragraph-properties': break; // 17.6 <style:paragraph-properties>
			case 'table-properties': break; // 17.15 <style:table-properties>
			case 'table-column-properties': break; // 17.16 <style:table-column-properties>
			case 'table-row-properties': break; // 17.17 <style:table-row-properties>
			case 'table-cell-properties': break; // 17.18 <style:table-cell-properties>

			case 'number': // 16.27.3 <number:number>
				break;

			case 'fraction': break; // TODO 16.27.6 <number:fraction>

			case 'day': // 16.27.11 <number:day>
			case 'month': // 16.27.12 <number:month>
			case 'year': // 16.27.13 <number:year>
			case 'era': // 16.27.14 <number:era>
			case 'day-of-week': // 16.27.15 <number:day-of-week>
			case 'week-of-year': // 16.27.16 <number:week-of-year>
			case 'quarter': // 16.27.17 <number:quarter>
			case 'hours': // 16.27.19 <number:hours>
			case 'minutes': // 16.27.20 <number:minutes>
			case 'seconds': // 16.27.21 <number:seconds>
			case 'am-pm': // 16.27.22 <number:am-pm>
				break;

			case 'boolean': break; // 16.27.24 <number:boolean>
			case 'text': // 16.27.26 <number:text>
				if(Rn[0].slice(-2) === "/>") break;
				else if(Rn[1]==="/") switch(state[state.length-1][0]) {
					case 'number-style':
					case 'date-style':
					case 'time-style':
						NF += str.slice(pidx, Rn.index);
						break;
				}
				else pidx = Rn.index + Rn[0].length;
				break;

			case 'named-range': // 9.4.12 <table:named-range>
				tag = parsexmltag(Rn[0], false);
				_Ref = ods_to_csf_3D(tag['cell-range-address']);
				var nrange = ({Name:tag.name, Ref:_Ref[0] + '!' + _Ref[1]});
				if(intable) nrange.Sheet = SheetNames.length;
				WB.Names.push(nrange);
				break;

			case 'text-content': break; // 16.27.27 <number:text-content>
			case 'text-properties': break; // 16.27.27 <style:text-properties>
			case 'embedded-text': break; // 16.27.4 <number:embedded-text>

			case 'body': case '电子表格': break; // 3.3 16.9.6 19.726.3

			case 'forms': break; // 12.25.2 13.2
			case 'table-column': break; // 9.1.6 <table:table-column>
			case 'table-header-rows': break; // 9.1.7 <table:table-header-rows>
			case 'table-rows': break; // 9.1.12 <table:table-rows>
			/* TODO: outline levels */
			case 'table-column-group': break; // 9.1.10 <table:table-column-group>
			case 'table-header-columns': break; // 9.1.11 <table:table-header-columns>
			case 'table-columns': break; // 9.1.12 <table:table-columns>

			case 'null-date': // 9.4.2 <table:null-date>
				tag = parsexmltag(Rn[0], false);
				switch(tag["date-value"]) {
					case "1904-01-01": WB.WBProps.date1904 = true; break;
				}
				break;

			case 'graphic-properties': break; // 17.21 <style:graphic-properties>
			case 'calculation-settings': break; // 9.4.1 <table:calculation-settings>
			case 'named-expressions': break; // 9.4.11 <table:named-expressions>
			case 'label-range': break; // 9.4.9 <table:label-range>
			case 'label-ranges': break; // 9.4.10 <table:label-ranges>
			case 'named-expression': break; // 9.4.13 <table:named-expression>
			case 'sort': break; // 9.4.19 <table:sort>
			case 'sort-by': break; // 9.4.20 <table:sort-by>
			case 'sort-groups': break; // 9.4.22 <table:sort-groups>

			case 'tab': break; // 6.1.4 <text:tab>
			case 'line-break': break; // 6.1.5 <text:line-break>
			case 'span': break; // 6.1.7 <text:span>
			case 'p': case '文本串': // 5.1.3 <text:p>
				if(['master-styles'].indexOf(state[state.length-1][0]) > -1) break;
				if(Rn[1]==='/' && (!ctag || !ctag['string-value'])) {
					var ptp = parse_text_p(str.slice(textpidx,Rn.index), textptag);
					textp = (textp.length > 0 ? textp + "\n" : "") + ptp[0];
				} else if(Rn[0].slice(-2) == "/>") {
					/* TODO: is self-closing 文本串 valid? */
					textp += "\n";
				} else { textptag = parsexmltag(Rn[0], false); textpidx = Rn.index + Rn[0].length; }
				break; // <text:p>
			case 's': break; // <text:s>

			case 'database-range': // 9.4.15 <table:database-range>
				if(Rn[1]==='/') break;
				try {
					_Ref = ods_to_csf_3D(parsexmltag(Rn[0])['target-range-address']);
					Sheets[_Ref[0]]['!autofilter'] = { ref:_Ref[1] };
				} catch(e) {/* empty */}
				break;

			case 'date': break; // <*:date>

			case 'object': break; // 10.4.6.2 <draw:object>
			case 'title': case '标题': break; // <*:title> OR <uof:标题>
			case 'desc': break; // <*:desc>
			case 'binary-data': break; // 10.4.5 TODO: b64 blob

			/* 9.2 Advanced Tables */
			case 'table-source': break; // 9.2.6
			case 'scenario': break; // 9.2.6

			case 'iteration': break; // 9.4.3 <table:iteration>
			case 'content-validations': break; // 9.4.4 <table:
			case 'content-validation': break; // 9.4.5 <table:
			case 'help-message': break; // 9.4.6 <table:
			case 'error-message': break; // 9.4.7 <table:
			case 'database-ranges': break; // 9.4.14 <table:database-ranges>

			/* 9.5 Filters */
			case 'filter': break; // 9.5.2 <table:filter>
			case 'filter-and': break; // 9.5.3 <table:filter-and>
			case 'filter-or': break; // 9.5.4 <table:filter-or>
			case 'filter-condition': break; // 9.5.5 <table:filter-condition>
			case 'filter-set-item': break; // 9.5.6 <table:filter-condition>

			case 'list-level-style-bullet': break; // 16.31 <text:
			case 'list-level-style-number': break; // 16.32 <text:
			case 'list-level-properties': break; // 17.19 <style:

			/* 7.3 Document Fields */
			case 'sender-firstname': // 7.3.6.2
			case 'sender-lastname': // 7.3.6.3
			case 'sender-initials': // 7.3.6.4
			case 'sender-title': // 7.3.6.5
			case 'sender-position': // 7.3.6.6
			case 'sender-email': // 7.3.6.7
			case 'sender-phone-private': // 7.3.6.8
			case 'sender-fax': // 7.3.6.9
			case 'sender-company': // 7.3.6.10
			case 'sender-phone-work': // 7.3.6.11
			case 'sender-street': // 7.3.6.12
			case 'sender-city': // 7.3.6.13
			case 'sender-postal-code': // 7.3.6.14
			case 'sender-country': // 7.3.6.15
			case 'sender-state-or-province': // 7.3.6.16
			case 'author-name': // 7.3.7.1
			case 'author-initials': // 7.3.7.2
			case 'chapter': // 7.3.8
			case 'file-name': // 7.3.9
			case 'template-name': // 7.3.9
			case 'sheet-name': // 7.3.9
				break;

			case 'event-listener':
				break;
			/* TODO: FODS Properties */
			case 'initial-creator':
			case 'creation-date':
			case 'print-date':
			case 'generator':
			case 'document-statistic':
			case 'user-defined':
			case 'editing-duration':
			case 'editing-cycles':
				break;

			/* TODO: FODS Config */
			case 'config-item':
				break;

			/* TODO: style tokens */
			case 'page-number': break; // TODO <text:page-number>
			case 'page-count': break; // TODO <text:page-count>
			case 'time': break; // TODO <text:time>

			/* 9.3 Advanced Table Cells */
			case 'cell-range-source': break; // 9.3.1 <table:
			case 'detective': break; // 9.3.2 <table:
			case 'operation': break; // 9.3.3 <table:
			case 'highlighted-range': break; // 9.3.4 <table:

			/* 9.6 Data Pilot Tables <table: */
			case 'data-pilot-table': // 9.6.3
			case 'source-cell-range': // 9.6.5
			case 'source-service': // 9.6.6
			case 'data-pilot-field': // 9.6.7
			case 'data-pilot-level': // 9.6.8
			case 'data-pilot-subtotals': // 9.6.9
			case 'data-pilot-subtotal': // 9.6.10
			case 'data-pilot-members': // 9.6.11
			case 'data-pilot-member': // 9.6.12
			case 'data-pilot-display-info': // 9.6.13
			case 'data-pilot-sort-info': // 9.6.14
			case 'data-pilot-layout-info': // 9.6.15
			case 'data-pilot-field-reference': // 9.6.16
			case 'data-pilot-groups': // 9.6.17
			case 'data-pilot-group': // 9.6.18
			case 'data-pilot-group-member': // 9.6.19
				break;

			/* 10.3 Drawing Shapes */
			case 'rect': // 10.3.2
				break;

			/* 14.6 DDE Connections */
			case 'dde-connection-decls': // 14.6.2 <text:
			case 'dde-connection-decl': // 14.6.3 <text:
			case 'dde-link': // 14.6.4 <table:
			case 'dde-source': // 14.6.5 <office:
				break;

			case 'properties': break; // 13.7 <form:properties>
			case 'property': break; // 13.8 <form:property>

			case 'a': // 6.1.8 hyperlink
				if(Rn[1]!== '/') {
					atag = parsexmltag(Rn[0], false);
					if(!atag.href) break;
					atag.Target = unescapexml(atag.href); delete atag.href;
					if(atag.Target.charAt(0) == "#" && atag.Target.indexOf(".") > -1) {
						_Ref = ods_to_csf_3D(atag.Target.slice(1));
						atag.Target = "#" + _Ref[0] + "!" + _Ref[1];
					} else if(atag.Target.match(/^\.\.[\\\/]/)) atag.Target = atag.Target.slice(3);
				}
				break;

			/* non-standard */
			case 'table-protection': break;
			case 'data-pilot-grand-total': break; // <table:
			case 'office-document-common-attrs': break; // bare
			default: switch(Rn[2]) {
				case 'dc:':       // TODO: properties
				case 'calcext:':  // ignore undocumented extensions
				case 'loext:':    // ignore undocumented extensions
				case 'ooo:':      // ignore undocumented extensions
				case 'chartooo:': // ignore undocumented extensions
				case 'draw:':     // TODO: drawing
				case 'style:':    // TODO: styles
				case 'chart:':    // TODO: charts
				case 'form:':     // TODO: forms
				case 'uof:':      // TODO: uof
				case '表:':       // TODO: uof
				case '字:':       // TODO: uof
					break;
				default: if(opts.WTF) throw new Error(Rn);
			}
		}
		var out = ({
			Sheets: Sheets,
			SheetNames: SheetNames,
			Workbook: WB
		});
		if(opts.bookSheets) delete out.Sheets;
		return out;
}

function parse_ods(zip, opts) {
	opts = opts || ({});
	if(safegetzipfile(zip, 'META-INF/manifest.xml')) parse_manifest(getzipdata(zip, 'META-INF/manifest.xml'), opts);
	var styles = getzipstr(zip, 'styles.xml');
	var Styles = styles && parse_ods_styles(utf8read(styles), opts);
	var content = getzipstr(zip, 'content.xml');
	if(!content) throw new Error("Missing content.xml in ODS / UOF file");
	var wb = parse_content_xml(utf8read(content), opts, Styles);
	if(safegetzipfile(zip, 'meta.xml')) wb.Props = parse_core_props(getzipdata(zip, 'meta.xml'));
	wb.bookType = "ods";
	return wb;
}
function parse_fods(data, opts) {
	var wb = parse_content_xml(data, opts);
	wb.bookType = "fods";
	return wb;
}
/* OpenDocument */
var write_styles_ods = /* @__PURE__ */(function() {
	var master_styles = [
		'<office:master-styles>',
			'<style:master-page style:name="mp1" style:page-layout-name="mp1">',
				'<style:header/>',
				'<style:header-left style:display="false"/>',
				'<style:footer/>',
				'<style:footer-left style:display="false"/>',
			'</style:master-page>',
		'</office:master-styles>'
	].join("");

	var payload = '<office:document-styles ' + wxt_helper({
		'xmlns:office':   "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
		'xmlns:table':    "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
		'xmlns:style':    "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
		'xmlns:text':     "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
		'xmlns:draw':     "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
		'xmlns:fo':       "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
		'xmlns:xlink':    "http://www.w3.org/1999/xlink",
		'xmlns:dc':       "http://purl.org/dc/elements/1.1/",
		'xmlns:number':   "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0",
		'xmlns:svg':      "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
		'xmlns:of':       "urn:oasis:names:tc:opendocument:xmlns:of:1.2",
		'office:version': "1.2"
	}) + '>' + master_styles + '</office:document-styles>';

	return function wso() {
		return XML_HEADER + payload;
	};
})();

// TODO: find out if anyone actually read the spec.  LO has some wild errors
function write_number_format_ods(nf, nfidx) {
	var type = "number", payload = "", nopts = { "style:name": nfidx }, c = "", i = 0;
	nf = nf.replace(/"[$]"/g, "$");
	/* TODO: replace with an actual parser based on a real grammar */
	j: {
		// TODO: support style maps
		if(nf.indexOf(";") > -1) {
			console.error("Unsupported ODS Style Map exported.  Using first branch of " + nf);
			nf = nf.slice(0, nf.indexOf(";"));
		}

		if(nf == "@") { type = "text"; payload = "<number:text-content/>"; break j; }

		/* currency flag */
		if(nf.indexOf(/\$/) > -1) { type = "currency"; }

		/* opening string literal */
		if(nf[i] == '"') {
			c = "";
			while(nf[++i] != '"' || nf[++i] == '"') c += nf[i]; --i;
			if(nf[i+1] == "*") {
				i++;
				payload += '<number:fill-character>' + escapexml(c.replace(/""/g, '"')) + '</number:fill-character>';
			} else {
				payload += '<number:text>' + escapexml(c.replace(/""/g, '"')) + '</number:text>';
			}
			nf = nf.slice(i+1); i = 0;
		}

		/* fractions */
		var t = nf.match(/# (\?+)\/(\?+)/);
		if(t) { payload += writextag("number:fraction", null, {"number:min-integer-digits":0, "number:min-numerator-digits": t[1].length, "number:max-denominator-value": Math.max(+(t[1].replace(/./g, "9")), +(t[2].replace(/./g, "9"))) }); break j; }
		if((t=nf.match(/# (\?+)\/(\d+)/))) { payload += writextag("number:fraction", null, {"number:min-integer-digits":0, "number:min-numerator-digits": t[1].length, "number:denominator-value": +t[2]}); break j; }

		/* percentages */
		if((t=nf.match(/\b(\d+)(|\.\d+)%/))) { type = "percentage"; payload += writextag("number:number", null, {"number:decimal-places": t[2] && t.length - 1 || 0, "number:min-decimal-places": t[2] && t.length - 1 || 0, "number:min-integer-digits": t[1].length }) + "<number:text>%</number:text>"; break j; }

		/* datetime */
		var has_time = false;
		if(["y","m","d"].indexOf(nf[0]) > -1) {
			type = "date";
			k: for(; i < nf.length; ++i) switch((c = nf[i].toLowerCase())) {
				case "h": case "s": has_time = true; --i; break k;
				case "m":
					l: for(var h = i+1; h < nf.length; ++h) switch(nf[h]) {
						case "y": case "d": break l;
						case "h": case "s": has_time = true; --i; break k;
					}
					/* falls through */
				case "y": case "d":
					while((nf[++i]||"").toLowerCase() == c[0]) c += c[0]; --i;
					switch(c) {
						case "y": case "yy": payload += "<number:year/>"; break;
						case "yyy": case "yyyy": payload += '<number:year number:style="long"/>'; break;
						case "mmmmm": console.error("ODS has no equivalent of format |mmmmm|");
							/* falls through */
						case "m": case "mm": case "mmm": case "mmmm":
							payload += '<number:month number:style="' + (c.length % 2 ? "short" : "long") + '" number:textual="' + (c.length >= 3 ? "true" : "false") + '"/>';
							break;
						case "d": case "dd": payload += '<number:day number:style="' + (c.length % 2 ? "short" : "long") + '"/>'; break;
						case "ddd": case "dddd": payload += '<number:day-of-week number:style="' + (c.length % 2 ? "short" : "long") + '"/>'; break;
					}
					break;
				case '"':
					while(nf[++i] != '"' || nf[++i] == '"') c += nf[i]; --i;
					payload += '<number:text>' + escapexml(c.slice(1).replace(/""/g, '"')) + '</number:text>';
					break;
				case '\\': c = nf[++i];
					payload += '<number:text>' + escapexml(c) + '</number:text>'; break;
				case '/': case ':': payload += '<number:text>' + escapexml(c) + '</number:text>'; break;
				default: console.error("unrecognized character " + c + " in ODF format " + nf);
			}
			if(!has_time) break j;
			nf = nf.slice(i+1); i = 0;
		}
		if(nf.match(/^\[?[hms]/)) {
			if(type == "number") type = "time";
			if(nf.match(/\[/)) {
				nf = nf.replace(/[\[\]]/g, "");
				nopts['number:truncate-on-overflow'] = "false";
			}
			for(; i < nf.length; ++i) switch((c = nf[i].toLowerCase())) {
				case "h": case "m": case "s":
					while((nf[++i]||"").toLowerCase() == c[0]) c += c[0]; --i;
					switch(c) {
						case "h": case "hh": payload += '<number:hours number:style="' + (c.length % 2 ? "short" : "long") + '"/>'; break;
						case "m": case "mm": payload += '<number:minutes number:style="' + (c.length % 2 ? "short" : "long") + '"/>'; break;
						case "s": case "ss":
							if(nf[i+1] == ".") do { c += nf[i+1]; ++i; } while(nf[i+1] == "0");
							payload += '<number:seconds number:style="' + (c.match("ss") ? "long" : "short") + '"' + (c.match(/\./) ? ' number:decimal-places="' + (c.match(/0+/)||[""])[0].length + '"' : "")+ '/>'; break;
					}
					break;
				case '"':
					while(nf[++i] != '"' || nf[++i] == '"') c += nf[i]; --i;
					payload += '<number:text>' + escapexml(c.slice(1).replace(/""/g, '"')) + '</number:text>';
					break;
				case '/': case ':': payload += '<number:text>' + escapexml(c) + '</number:text>'; break;
				case "a":
					if(nf.slice(i, i+3).toLowerCase() == "a/p") { payload += '<number:am-pm/>'; i += 2; break; } // Note: ODF does not support A/P
					if(nf.slice(i, i+5).toLowerCase() == "am/pm")  { payload += '<number:am-pm/>'; i += 4; break; }
					/* falls through */
				default: console.error("unrecognized character " + c + " in ODF format " + nf);
			}
			break j;
		}

		/* currency flag */
		if(nf.indexOf(/\$/) > -1) { type = "currency"; }

		/* should be in a char loop */
		if(nf[0] == "$") { payload += '<number:currency-symbol number:language="en" number:country="US">$</number:currency-symbol>'; nf = nf.slice(1); i = 0; }
		i = 0; if(nf[i] == '"') {
			while(nf[++i] != '"' || nf[++i] == '"') c += nf[i]; --i;
			if(nf[i+1] == "*") {
				i++;
				payload += '<number:fill-character>' + escapexml(c.replace(/""/g, '"')) + '</number:fill-character>';
			} else {
				payload += '<number:text>' + escapexml(c.replace(/""/g, '"')) + '</number:text>';
			}
			nf = nf.slice(i+1); i = 0;
		}

		/* number TODO: interstitial text e.g. 000)000-0000 */
		var np = nf.match(/([#0][0#,]*)(\.[0#]*|)(E[+]?0*|)/i);
		if(!np || !np[0]) console.error("Could not find numeric part of " + nf);
		else {
			var base = np[1].replace(/,/g, "");
			payload += '<number:' + (np[3] ? "scientific-" : "")+ 'number' +
				' number:min-integer-digits="' + (base.indexOf("0") == -1 ? "0" : base.length - base.indexOf("0")) + '"' +
				(np[0].indexOf(",") > -1 ? ' number:grouping="true"' : "") +
				(np[2] && ' number:decimal-places="' + (np[2].length - 1) + '"' || ' number:decimal-places="0"') +
				(np[3] && np[3].indexOf("+") > -1 ? ' number:forced-exponent-sign="true"' : "" ) +
				(np[3] ? ' number:min-exponent-digits="' + np[3].match(/0+/)[0].length + '"' : "" ) +
				'>' +
				/* TODO: interstitial text placeholders */
				'</number:' + (np[3] ? "scientific-" : "") + 'number>';
			i = np.index + np[0].length;
		}

		/* residual text */
		if(nf[i] == '"') {
			c = "";
			while(nf[++i] != '"' || nf[++i] == '"') c += nf[i]; --i;
			payload += '<number:text>' + escapexml(c.replace(/""/g, '"')) + '</number:text>';
		}
	}

	if(!payload) { console.error("Could not generate ODS number format for |" + nf + "|"); return ""; }
	return writextag("number:" + type + "-style", payload, nopts);
}

function write_names_ods(Names, SheetNames, idx) {
	//var scoped = Names.filter(function(name) { return name.Sheet == (idx == -1 ? null : idx); });
	var scoped = []; for(var namei = 0; namei < Names.length; ++namei) {
		var name = Names[namei];
		if(!name) continue;
		if(name.Sheet == (idx == -1 ? null : idx)) scoped.push(name);
	}
	if(!scoped.length) return "";
	return "      <table:named-expressions>\n" + scoped.map(function(name) {
		var odsref =  (idx == -1 ? "$" : "") + csf_to_ods_3D(name.Ref);
		return "        " + writextag("table:named-range", null, {
			"table:name": name.Name,
			"table:cell-range-address": odsref,
			"table:base-cell-address": odsref.replace(/[\.][^\.]*$/, ".$A$1")
		});
	}).join("\n") + "\n      </table:named-expressions>\n";
}
var write_content_ods = /* @__PURE__ */(function() {
	/* 6.1.2 White Space Characters */
	var write_text_p = function(text, span) {
		return escapexml(text)
			.replace(/  +/g, function($$){return '<text:s text:c="'+$$.length+'"/>';})
			.replace(/\t/g, "<text:tab/>")
			.replace(/\n/g, span ? "<text:line-break/>": "</text:p><text:p>")
			.replace(/^ /, "<text:s/>").replace(/ $/, "<text:s/>");
	};

	var null_cell_xml = '          <table:table-cell />\n';
	var write_ws = function(ws, wb, i, opts, nfs, date1904) {
		/* Section 9 Tables */
		var o = [];
		o.push('      <table:table table:name="' + escapexml(wb.SheetNames[i]) + '" table:style-name="ta1">\n');
		var R=0,C=0, range = decode_range(ws['!ref']||"A1");
		var marr = ws['!merges'] || [], mi = 0;
		var dense = ws["!data"] != null;
		if(ws["!cols"]) {
			for(C = 0; C <= range.e.c; ++C) o.push('        <table:table-column' + (ws["!cols"][C] ? ' table:style-name="co' + ws["!cols"][C].ods + '"' : '') + '></table:table-column>\n');
		}
		var H = "", ROWS = ws["!rows"]||[];
		for(R = 0; R < range.s.r; ++R) {
			H = ROWS[R] ? ' table:style-name="ro' + ROWS[R].ods + '"' : "";
			o.push('        <table:table-row' + H + '></table:table-row>\n');
		}
		for(; R <= range.e.r; ++R) {
			H = ROWS[R] ? ' table:style-name="ro' + ROWS[R].ods + '"' : "";
			o.push('        <table:table-row' + H + '>\n');
			for(C=0; C < range.s.c; ++C) o.push(null_cell_xml);
			for(; C <= range.e.c; ++C) {
				var skip = false, ct = {}, textp = "";
				for(mi = 0; mi != marr.length; ++mi) {
					if(marr[mi].s.c > C) continue;
					if(marr[mi].s.r > R) continue;
					if(marr[mi].e.c < C) continue;
					if(marr[mi].e.r < R) continue;
					if(marr[mi].s.c != C || marr[mi].s.r != R) skip = true;
					ct['table:number-columns-spanned'] = (marr[mi].e.c - marr[mi].s.c + 1);
					ct['table:number-rows-spanned'] =    (marr[mi].e.r - marr[mi].s.r + 1);
					break;
				}
				if(skip) { o.push('          <table:covered-table-cell/>\n'); continue; }
				var ref = encode_cell({r:R, c:C}), cell = dense ? (ws["!data"][R]||[])[C]: ws[ref];
				if(cell && cell.f) {
					ct['table:formula'] = escapexml(csf_to_ods_formula(cell.f));
					if(cell.F) {
						if(cell.F.slice(0, ref.length) == ref) {
							var _Fref = decode_range(cell.F);
							ct['table:number-matrix-columns-spanned'] = (_Fref.e.c - _Fref.s.c + 1);
							ct['table:number-matrix-rows-spanned'] =    (_Fref.e.r - _Fref.s.r + 1);
						}
					}
				}
				if(!cell) { o.push(null_cell_xml); continue; }
				switch(cell.t) {
					case 'b':
						textp = (cell.v ? 'TRUE' : 'FALSE');
						ct['office:value-type'] = "boolean";
						ct['office:boolean-value'] = (cell.v ? 'true' : 'false');
						break;
					case 'n':
						if(!isFinite(cell.v)) {
							if(isNaN(cell.v)) {
								textp = "#NUM!";
								ct['table:formula'] = "of:=#NUM!";
							} else {
								textp = "#DIV/0!";
								ct['table:formula'] = "of:=" + (cell.v < 0 ? "-" : "") + "1/0";
							}
							ct['office:string-value'] = "";
							ct['office:value-type'] = "string";
							ct['calcext:value-type'] = "error";
						} else {
							textp = (cell.w||String(cell.v||0));
							ct['office:value-type'] = "float";
							ct['office:value'] = (cell.v||0);
						}
						break;
					case 's': case 'str':
						textp = cell.v == null ? "" : cell.v;
						ct['office:value-type'] = "string";
						break;
					case 'd':
						textp = (cell.w||(parseDate(cell.v, date1904).toISOString()));
						ct['office:value-type'] = "date";
						ct['office:date-value'] = (parseDate(cell.v, date1904).toISOString());
						ct['table:style-name'] = "ce1";
						break;
					//case 'e': // TODO: translate to ODS errors
					default: o.push(null_cell_xml); continue; // TODO: empty cell with comments
				}
				var text_p = write_text_p(textp);
				if(cell.l && cell.l.Target) {
					var _tgt = cell.l.Target;
					_tgt = _tgt.charAt(0) == "#" ? "#" + csf_to_ods_3D(_tgt.slice(1)) : _tgt;
					// TODO: choose correct parent path format based on link delimiters
					if(_tgt.charAt(0) != "#" && !_tgt.match(/^\w+:/)) _tgt = '../' + _tgt;
					text_p = writextag('text:a', text_p, {'xlink:href': _tgt.replace(/&/g, "&amp;")});
				}
				if(nfs[cell.z]) ct["table:style-name"] = "ce" + nfs[cell.z].slice(1);
				var payload = writextag('text:p', text_p, {});
				if(cell.c) {
					var acreator = "", apayload = "", aprops = {};
					for(var ci = 0; ci < cell.c.length; ++ci) {
						if(!acreator && cell.c[ci].a) acreator = cell.c[ci].a;
						apayload += "<text:p>" + write_text_p(cell.c[ci].t) + "</text:p>";
					}
					if(!cell.c.hidden) aprops["office:display"] = true;
					payload = writextag('office:annotation', apayload, aprops) + payload;
				}
				o.push('          ' + writextag('table:table-cell', payload, ct) + '\n');
			}
			o.push('        </table:table-row>\n');
		}
		if((wb.Workbook||{}).Names) o.push(write_names_ods(wb.Workbook.Names, wb.SheetNames, i));
		o.push('      </table:table>\n');
		return o.join("");
	};

	var write_automatic_styles_ods = function(o, wb) {
		o.push(' <office:automatic-styles>\n');

		/* column styles */
		var cidx = 0;
		wb.SheetNames.map(function(n) { return wb.Sheets[n]; }).forEach(function(ws) {
			if(!ws) return;
			if(ws["!cols"]) {
				for(var C = 0; C < ws["!cols"].length; ++C) if(ws["!cols"][C]) {
					var colobj = ws["!cols"][C];
					if(colobj.width == null && colobj.wpx == null && colobj.wch == null) continue;
					process_col(colobj);
					colobj.ods = cidx;
					var w = ws["!cols"][C].wpx + "px";
					o.push('  <style:style style:name="co' + cidx + '" style:family="table-column">\n');
					o.push('   <style:table-column-properties fo:break-before="auto" style:column-width="' + w + '"/>\n');
					o.push('  </style:style>\n');
					++cidx;
				}
			}
		});

		/* row styles */
		var ridx = 0;
		wb.SheetNames.map(function(n) { return wb.Sheets[n]; }).forEach(function(ws) {
			if(!ws) return;
			if(ws["!rows"]) {
				for(var R = 0; R < ws["!rows"].length; ++R) if(ws["!rows"][R]) {
					ws["!rows"][R].ods = ridx;
					var h = ws["!rows"][R].hpx + "px";
					o.push('  <style:style style:name="ro' + ridx + '" style:family="table-row">\n');
					o.push('   <style:table-row-properties fo:break-before="auto" style:row-height="' + h + '"/>\n');
					o.push('  </style:style>\n');
					++ridx;
				}
			}
		});

		/* table */
		o.push('  <style:style style:name="ta1" style:family="table" style:master-page-name="mp1">\n');
		o.push('   <style:table-properties table:display="true" style:writing-mode="lr-tb"/>\n');
		o.push('  </style:style>\n');

		o.push('  <number:date-style style:name="N37" number:automatic-order="true">\n');
		o.push('   <number:month number:style="long"/>\n');
		o.push('   <number:text>/</number:text>\n');
		o.push('   <number:day number:style="long"/>\n');
		o.push('   <number:text>/</number:text>\n');
		o.push('   <number:year/>\n');
		o.push('  </number:date-style>\n');

		/* number formats, table cells, text */
		var nfs = {};
		var nfi = 69;
		wb.SheetNames.map(function(n) { return wb.Sheets[n]; }).forEach(function(ws) {
			if(!ws) return;
			var dense = (ws["!data"] != null);
			if(!ws["!ref"]) return;
			var range = decode_range(ws["!ref"]);
			for(var R = 0; R <= range.e.r; ++R) for(var C = 0; C <= range.e.c; ++C) {
				var c = dense ? (ws["!data"][R]||[])[C] : ws[encode_cell({r:R,c:C})];
				if(!c || !c.z || c.z.toLowerCase() == "general") continue;
				if(!nfs[c.z]) {
					var out = write_number_format_ods(c.z, "N" + nfi);
					if(out) { nfs[c.z] = "N" + nfi; ++nfi; o.push(out + "\n"); }
				}
			}
		});
		o.push('  <style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="N37"/>\n');
		keys(nfs).forEach(function(nf) {
			o.push('<style:style style:name="ce' + nfs[nf].slice(1) + '" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="' + nfs[nf] + '"/>\n');
		});

		/* page-layout */

		o.push(' </office:automatic-styles>\n');
		return nfs;
	};

	return function wcx(wb, opts) {
		var o = [XML_HEADER];
		/* 3.1.3.2 */
		var attr = wxt_helper({
			'xmlns:office':       "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
			'xmlns:table':        "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
			'xmlns:style':        "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
			'xmlns:text':         "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
			'xmlns:draw':         "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
			'xmlns:fo':           "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
			'xmlns:xlink':        "http://www.w3.org/1999/xlink",
			'xmlns:dc':           "http://purl.org/dc/elements/1.1/",
			'xmlns:meta':         "urn:oasis:names:tc:opendocument:xmlns:meta:1.0",
			'xmlns:number':       "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0",
			'xmlns:presentation': "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
			'xmlns:svg':          "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
			'xmlns:chart':        "urn:oasis:names:tc:opendocument:xmlns:chart:1.0",
			'xmlns:dr3d':         "urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0",
			'xmlns:math':         "http://www.w3.org/1998/Math/MathML",
			'xmlns:form':         "urn:oasis:names:tc:opendocument:xmlns:form:1.0",
			'xmlns:script':       "urn:oasis:names:tc:opendocument:xmlns:script:1.0",
			'xmlns:ooo':          "http://openoffice.org/2004/office",
			'xmlns:ooow':         "http://openoffice.org/2004/writer",
			'xmlns:oooc':         "http://openoffice.org/2004/calc",
			'xmlns:dom':          "http://www.w3.org/2001/xml-events",
			'xmlns:xforms':       "http://www.w3.org/2002/xforms",
			'xmlns:xsd':          "http://www.w3.org/2001/XMLSchema",
			'xmlns:xsi':          "http://www.w3.org/2001/XMLSchema-instance",
			'xmlns:sheet':        "urn:oasis:names:tc:opendocument:sh33tjs:1.0",
			'xmlns:rpt':          "http://openoffice.org/2005/report",
			'xmlns:of':           "urn:oasis:names:tc:opendocument:xmlns:of:1.2",
			'xmlns:xhtml':        "http://www.w3.org/1999/xhtml",
			'xmlns:grddl':        "http://www.w3.org/2003/g/data-view#",
			'xmlns:tableooo':     "http://openoffice.org/2009/table",
			'xmlns:drawooo':      "http://openoffice.org/2010/draw",
			'xmlns:calcext':      "urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0",
			'xmlns:loext':        "urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0",
			'xmlns:field':        "urn:openoffice:names:experimental:ooo-ms-interop:xmlns:field:1.0",
			'xmlns:formx':        "urn:openoffice:names:experimental:ooxml-odf-interop:xmlns:form:1.0",
			'xmlns:css3t':        "http://www.w3.org/TR/css3-text/",
			'office:version':     "1.2"
		});

		var fods = wxt_helper({
			'xmlns:config':    "urn:oasis:names:tc:opendocument:xmlns:config:1.0",
			'office:mimetype': "application/vnd.oasis.opendocument.spreadsheet"
		});

		if(opts.bookType == "fods") {
			o.push('<office:document' + attr + fods + '>\n');
			o.push(write_meta_ods().replace(/<office:document-meta[^<>]*?>/, "").replace(/<\/office:document-meta>/, "") + "\n");
			// TODO: settings (equiv of settings.xml for ODS)
		} else o.push('<office:document-content' + attr  + '>\n');
		// o.push('  <office:scripts/>\n');
		var nfs = write_automatic_styles_ods(o, wb);
		o.push('  <office:body>\n');
		o.push('    <office:spreadsheet>\n');
		if(((wb.Workbook||{}).WBProps||{}).date1904) o.push('      <table:calculation-settings table:case-sensitive="false" table:search-criteria-must-apply-to-whole-cell="true" table:use-wildcards="true" table:use-regular-expressions="false" table:automatic-find-labels="false">\n        <table:null-date table:date-value="1904-01-01"/>\n      </table:calculation-settings>\n');
		for(var i = 0; i != wb.SheetNames.length; ++i) o.push(write_ws(wb.Sheets[wb.SheetNames[i]], wb, i, opts, nfs, ((wb.Workbook||{}).WBProps||{}).date1904));
		if((wb.Workbook||{}).Names) o.push(write_names_ods(wb.Workbook.Names, wb.SheetNames, -1));
		o.push('    </office:spreadsheet>\n');
		o.push('  </office:body>\n');
		if(opts.bookType == "fods") o.push('</office:document>');
		else o.push('</office:document-content>');
		return o.join("");
	};
})();

function write_ods(wb, opts) {
	if(opts.bookType == "fods") return write_content_ods(wb, opts);

	var zip = zip_new();
	var f = "";

	var manifest = [];
	var rdf = [];

	/* Part 3 Section 3.3 MIME Media Type */
	f = "mimetype";
	zip_add_file(zip, f, "application/vnd.oasis.opendocument.spreadsheet");

	/* Part 1 Section 2.2 Documents */
	f = "content.xml";
	zip_add_file(zip, f, write_content_ods(wb, opts));
	manifest.push([f, "text/xml"]);
	rdf.push([f, "ContentFile"]);

	/* TODO: these are hard-coded styles to satiate excel */
	f = "styles.xml";
	zip_add_file(zip, f, write_styles_ods(wb, opts));
	manifest.push([f, "text/xml"]);
	rdf.push([f, "StylesFile"]);

	/* TODO: this is hard-coded to satiate excel */
	f = "meta.xml";
	zip_add_file(zip, f, XML_HEADER + write_meta_ods());
	manifest.push([f, "text/xml"]);
	rdf.push([f, "MetadataFile"]);

	/* Part 3 Section 6 Metadata Manifest File */
	f = "manifest.rdf";
	zip_add_file(zip, f, write_rdf(rdf/*, opts*/));
	manifest.push([f, "application/rdf+xml"]);

	/* Part 3 Section 4 Manifest File */
	f = "META-INF/manifest.xml";
	zip_add_file(zip, f, write_manifest(manifest/*, opts*/));

	return zip;
}

/*! sheetjs (C) 2013-present SheetJS -- http://sheetjs.com */
var subarray = function() {
  try {
    if (typeof Uint8Array == "undefined")
      return "slice";
    if (typeof Uint8Array.prototype.subarray == "undefined")
      return "slice";
    if (typeof Buffer !== "undefined") {
      if (typeof Buffer.prototype.subarray == "undefined")
        return "slice";
      if ((typeof Buffer.from == "function" ? Buffer.from([72, 62]) : new Buffer([72, 62])) instanceof Uint8Array)
        return "subarray";
      return "slice";
    }
    return "subarray";
  } catch (e) {
    return "slice";
  }
}();
function u8_to_dataview(array) {
  return new DataView(array.buffer, array.byteOffset, array.byteLength);
}
function u8str(u8) {
  return typeof TextDecoder != "undefined" ? new TextDecoder().decode(u8) : utf8read(a2s(u8));
}
function stru8(str) {
  return typeof TextEncoder != "undefined" ? new TextEncoder().encode(str) : s2a(utf8write(str));
}
function u8concat(u8a) {
  var len = 0;
  for (var i = 0; i < u8a.length; ++i)
    len += u8a[i].length;
  var out = new Uint8Array(len);
  var off = 0;
  for (i = 0; i < u8a.length; ++i) {
    var u8 = u8a[i], L = u8.length;
    if (L < 250) {
      for (var j = 0; j < L; ++j)
        out[off++] = u8[j];
    } else {
      out.set(u8, off);
      off += L;
    }
  }
  return out;
}
function popcnt(x) {
  x -= x >> 1 & 1431655765;
  x = (x & 858993459) + (x >> 2 & 858993459);
  return (x + (x >> 4) & 252645135) * 16843009 >>> 24;
}
function readDecimal128LE(buf, offset) {
  var exp = (buf[offset + 15] & 127) << 7 | buf[offset + 14] >> 1;
  var mantissa = buf[offset + 14] & 1;
  for (var j = offset + 13; j >= offset; --j)
    mantissa = mantissa * 256 + buf[j];
  return (buf[offset + 15] & 128 ? -mantissa : mantissa) * Math.pow(10, exp - 6176);
}
function writeDecimal128LE(buf, offset, value) {
  var exp = Math.floor(value == 0 ? 0 : Math.LOG10E * Math.log(Math.abs(value))) + 6176 - 16;
  var mantissa = value / Math.pow(10, exp - 6176);
  buf[offset + 15] |= exp >> 7;
  buf[offset + 14] |= (exp & 127) << 1;
  for (var i = 0; mantissa >= 1; ++i, mantissa /= 256)
    buf[offset + i] = mantissa & 255;
  buf[offset + 15] |= value >= 0 ? 0 : 128;
}
function parse_varint49(buf, ptr) {
  var l = ptr.l;
  var usz = buf[l] & 127;
  varint:
    if (buf[l++] >= 128) {
      usz |= (buf[l] & 127) << 7;
      if (buf[l++] < 128)
        break varint;
      usz |= (buf[l] & 127) << 14;
      if (buf[l++] < 128)
        break varint;
      usz |= (buf[l] & 127) << 21;
      if (buf[l++] < 128)
        break varint;
      usz += (buf[l] & 127) * Math.pow(2, 28);
      ++l;
      if (buf[l++] < 128)
        break varint;
      usz += (buf[l] & 127) * Math.pow(2, 35);
      ++l;
      if (buf[l++] < 128)
        break varint;
      usz += (buf[l] & 127) * Math.pow(2, 42);
      ++l;
      if (buf[l++] < 128)
        break varint;
    }
  ptr.l = l;
  return usz;
}
function write_varint49(v) {
  var usz = new Uint8Array(7);
  usz[0] = v & 127;
  var L = 1;
  sz:
    if (v > 127) {
      usz[L - 1] |= 128;
      usz[L] = v >> 7 & 127;
      ++L;
      if (v <= 16383)
        break sz;
      usz[L - 1] |= 128;
      usz[L] = v >> 14 & 127;
      ++L;
      if (v <= 2097151)
        break sz;
      usz[L - 1] |= 128;
      usz[L] = v >> 21 & 127;
      ++L;
      if (v <= 268435455)
        break sz;
      usz[L - 1] |= 128;
      usz[L] = v / 256 >>> 21 & 127;
      ++L;
      if (v <= 34359738367)
        break sz;
      usz[L - 1] |= 128;
      usz[L] = v / 65536 >>> 21 & 127;
      ++L;
      if (v <= 4398046511103)
        break sz;
      usz[L - 1] |= 128;
      usz[L] = v / 16777216 >>> 21 & 127;
      ++L;
    }
  return usz[subarray](0, L);
}
function parse_packed_varints(buf) {
  var ptr = { l: 0 };
  var out = [];
  while (ptr.l < buf.length)
    out.push(parse_varint49(buf, ptr));
  return out;
}
function write_packed_varints(nums) {
  return u8concat(nums.map(function(x) {
    return write_varint49(x);
  }));
}
function varint_to_i32(buf) {
  var l = 0, i32 = buf[l] & 127;
  if (buf[l++] < 128)
    return i32;
  i32 |= (buf[l] & 127) << 7;
  if (buf[l++] < 128)
    return i32;
  i32 |= (buf[l] & 127) << 14;
  if (buf[l++] < 128)
    return i32;
  i32 |= (buf[l] & 127) << 21;
  if (buf[l++] < 128)
    return i32;
  i32 |= (buf[l] & 15) << 28;
  return i32;
}
function varint_to_u64(buf) {
  var l = 0, lo = buf[l] & 127, hi = 0;
  varint:
    if (buf[l++] >= 128) {
      lo |= (buf[l] & 127) << 7;
      if (buf[l++] < 128)
        break varint;
      lo |= (buf[l] & 127) << 14;
      if (buf[l++] < 128)
        break varint;
      lo |= (buf[l] & 127) << 21;
      if (buf[l++] < 128)
        break varint;
      lo |= (buf[l] & 127) << 28;
      hi = buf[l] >> 4 & 7;
      if (buf[l++] < 128)
        break varint;
      hi |= (buf[l] & 127) << 3;
      if (buf[l++] < 128)
        break varint;
      hi |= (buf[l] & 127) << 10;
      if (buf[l++] < 128)
        break varint;
      hi |= (buf[l] & 127) << 17;
      if (buf[l++] < 128)
        break varint;
      hi |= (buf[l] & 127) << 24;
      if (buf[l++] < 128)
        break varint;
      hi |= (buf[l] & 127) << 31;
    }
  return [lo >>> 0, hi >>> 0];
}
function parse_shallow(buf) {
  var out = [], ptr = { l: 0 };
  while (ptr.l < buf.length) {
    var off = ptr.l;
    var num = parse_varint49(buf, ptr);
    var type = num & 7;
    num = num / 8 | 0;
    var data;
    var l = ptr.l;
    switch (type) {
      case 0:
        {
          while (buf[l++] >= 128)
            ;
          data = buf[subarray](ptr.l, l);
          ptr.l = l;
        }
        break;
      case 1:
        {
          data = buf[subarray](l, l + 8);
          ptr.l = l + 8;
        }
        break;
      case 2:
        {
          var len = parse_varint49(buf, ptr);
          data = buf[subarray](ptr.l, ptr.l + len);
          ptr.l += len;
        }
        break;
      case 5:
        {
          data = buf[subarray](l, l + 4);
          ptr.l = l + 4;
        }
        break;
      default:
        throw new Error("PB Type ".concat(type, " for Field ").concat(num, " at offset ").concat(off));
    }
    var v = { data: data, type: type };
    if (out[num] == null)
      out[num] = [];
    out[num].push(v);
  }
  return out;
}
function write_shallow(proto) {
  var out = [];
  proto.forEach(function(field, idx) {
    if (idx == 0)
      return;
    field.forEach(function(item) {
      if (!item.data)
        return;
      out.push(write_varint49(idx * 8 + item.type));
      if (item.type == 2)
        out.push(write_varint49(item.data.length));
      out.push(item.data);
    });
  });
  return u8concat(out);
}
function mappa(data, cb) {
  return (data == null ? void 0 : data.map(function(d) {
    return cb(d.data);
  })) || [];
}
function parse_iwa_file(buf) {
  var _a;
  var out = [], ptr = { l: 0 };
  while (ptr.l < buf.length) {
    var len = parse_varint49(buf, ptr);
    var ai = parse_shallow(buf[subarray](ptr.l, ptr.l + len));
    ptr.l += len;
    var res = {
      id: varint_to_i32(ai[1][0].data),
      messages: []
    };
    ai[2].forEach(function(b) {
      var mi = parse_shallow(b.data);
      var fl = varint_to_i32(mi[3][0].data);
      res.messages.push({
        meta: mi,
        data: buf[subarray](ptr.l, ptr.l + fl)
      });
      ptr.l += fl;
    });
    if ((_a = ai[3]) == null ? void 0 : _a[0])
      res.merge = varint_to_i32(ai[3][0].data) >>> 0 > 0;
    out.push(res);
  }
  return out;
}
function write_iwa_file(ias) {
  var bufs = [];
  ias.forEach(function(ia) {
    var ai = [
      [],
      [{ data: write_varint49(ia.id), type: 0 }],
      []
    ];
    if (ia.merge != null)
      ai[3] = [{ data: write_varint49(+!!ia.merge), type: 0 }];
    var midata = [];
    ia.messages.forEach(function(mi) {
      midata.push(mi.data);
      mi.meta[3] = [{ type: 0, data: write_varint49(mi.data.length) }];
      ai[2].push({ data: write_shallow(mi.meta), type: 2 });
    });
    var aipayload = write_shallow(ai);
    bufs.push(write_varint49(aipayload.length));
    bufs.push(aipayload);
    midata.forEach(function(mid) {
      return bufs.push(mid);
    });
  });
  return u8concat(bufs);
}
function parse_snappy_chunk(type, buf) {
  if (type != 0)
    throw new Error("Unexpected Snappy chunk type ".concat(type));
  var ptr = { l: 0 };
  var usz = parse_varint49(buf, ptr);
  var chunks = [];
  var l = ptr.l;
  while (l < buf.length) {
    var tag = buf[l] & 3;
    if (tag == 0) {
      var len = buf[l++] >> 2;
      if (len < 60)
        ++len;
      else {
        var c = len - 59;
        len = buf[l];
        if (c > 1)
          len |= buf[l + 1] << 8;
        if (c > 2)
          len |= buf[l + 2] << 16;
        if (c > 3)
          len |= buf[l + 3] << 24;
        len >>>= 0;
        len++;
        l += c;
      }
      chunks.push(buf[subarray](l, l + len));
      l += len;
      continue;
    } else {
      var offset = 0, length = 0;
      if (tag == 1) {
        length = (buf[l] >> 2 & 7) + 4;
        offset = (buf[l++] & 224) << 3;
        offset |= buf[l++];
      } else {
        length = (buf[l++] >> 2) + 1;
        if (tag == 2) {
          offset = buf[l] | buf[l + 1] << 8;
          l += 2;
        } else {
          offset = (buf[l] | buf[l + 1] << 8 | buf[l + 2] << 16 | buf[l + 3] << 24) >>> 0;
          l += 4;
        }
      }
      if (offset == 0)
        throw new Error("Invalid offset 0");
      var j = chunks.length - 1, off = offset;
      while (j >= 0 && off >= chunks[j].length) {
        off -= chunks[j].length;
        --j;
      }
      if (j < 0) {
        if (off == 0)
          off = chunks[j = 0].length;
        else
          throw new Error("Invalid offset beyond length");
      }
      if (length < off)
        chunks.push(chunks[j][subarray](chunks[j].length - off, chunks[j].length - off + length));
      else {
        if (off > 0) {
          chunks.push(chunks[j][subarray](chunks[j].length - off));
          length -= off;
        }
        ++j;
        while (length >= chunks[j].length) {
          chunks.push(chunks[j]);
          length -= chunks[j].length;
          ++j;
        }
        if (length)
          chunks.push(chunks[j][subarray](0, length));
      }
      if (chunks.length > 25)
        chunks = [u8concat(chunks)];
    }
  }
  var clen = 0;
  for (var u8i = 0; u8i < chunks.length; ++u8i)
    clen += chunks[u8i].length;
  if (clen != usz)
    throw new Error("Unexpected length: ".concat(clen, " != ").concat(usz));
  return chunks;
}
function decompress_iwa_file(buf) {
  if (Array.isArray(buf))
    buf = new Uint8Array(buf);
  var out = [];
  var l = 0;
  while (l < buf.length) {
    var t = buf[l++];
    var len = buf[l] | buf[l + 1] << 8 | buf[l + 2] << 16;
    l += 3;
    out.push.apply(out, parse_snappy_chunk(t, buf[subarray](l, l + len)));
    l += len;
  }
  if (l !== buf.length)
    throw new Error("data is not a valid framed stream!");
  return out.length == 1 ? out[0] : u8concat(out);
}
function compress_iwa_file(buf) {
  var out = [];
  var l = 0;
  while (l < buf.length) {
    var c = Math.min(buf.length - l, 268435455);
    var frame = new Uint8Array(4);
    out.push(frame);
    var usz = write_varint49(c);
    var L = usz.length;
    out.push(usz);
    if (c <= 60) {
      L++;
      out.push(new Uint8Array([c - 1 << 2]));
    } else if (c <= 256) {
      L += 2;
      out.push(new Uint8Array([240, c - 1 & 255]));
    } else if (c <= 65536) {
      L += 3;
      out.push(new Uint8Array([244, c - 1 & 255, c - 1 >> 8 & 255]));
    } else if (c <= 16777216) {
      L += 4;
      out.push(new Uint8Array([248, c - 1 & 255, c - 1 >> 8 & 255, c - 1 >> 16 & 255]));
    } else if (c <= 4294967296) {
      L += 5;
      out.push(new Uint8Array([252, c - 1 & 255, c - 1 >> 8 & 255, c - 1 >> 16 & 255, c - 1 >>> 24 & 255]));
    }
    out.push(buf[subarray](l, l + c));
    L += c;
    frame[0] = 0;
    frame[1] = L & 255;
    frame[2] = L >> 8 & 255;
    frame[3] = L >> 16 & 255;
    l += c;
  }
  return u8concat(out);
}
var numbers_lut_new = function() {
  return { sst: [], rsst: [], ofmt: [], nfmt: [], fmla: [], ferr: [], cmnt: [] };
};
function numbers_format_cell(cell, t, flags, ofmt, nfmt) {
  var _a, _b, _c, _d;
  var ctype = t & 255, ver = t >> 8;
  var fmt = ver >= 5 ? nfmt : ofmt;
  dur:
    if (flags & (ver > 4 ? 8 : 4) && cell.t == "n" && ctype == 7) {
      var dstyle = ((_a = fmt[7]) == null ? void 0 : _a[0]) ? varint_to_i32(fmt[7][0].data) : -1;
      if (dstyle == -1)
        break dur;
      var dmin = ((_b = fmt[15]) == null ? void 0 : _b[0]) ? varint_to_i32(fmt[15][0].data) : -1;
      var dmax = ((_c = fmt[16]) == null ? void 0 : _c[0]) ? varint_to_i32(fmt[16][0].data) : -1;
      var auto = ((_d = fmt[40]) == null ? void 0 : _d[0]) ? varint_to_i32(fmt[40][0].data) : -1;
      var d = cell.v, dd = d;
      autodur:
        if (auto) {
          if (d == 0) {
            dmin = dmax = 2;
            break autodur;
          }
          if (d >= 604800)
            dmin = 1;
          else if (d >= 86400)
            dmin = 2;
          else if (d >= 3600)
            dmin = 4;
          else if (d >= 60)
            dmin = 8;
          else if (d >= 1)
            dmin = 16;
          else
            dmin = 32;
          if (Math.floor(d) != d)
            dmax = 32;
          else if (d % 60)
            dmax = 16;
          else if (d % 3600)
            dmax = 8;
          else if (d % 86400)
            dmax = 4;
          else if (d % 604800)
            dmax = 2;
          if (dmax < dmin)
            dmax = dmin;
        }
      if (dmin == -1 || dmax == -1)
        break dur;
      var dstr = [], zstr = [];
      if (dmin == 1) {
        dd = d / 604800;
        if (dmax == 1) {
          zstr.push('d"d"');
        } else {
          dd |= 0;
          d -= 604800 * dd;
        }
        dstr.push(dd + (dstyle == 2 ? " week" + (dd == 1 ? "" : "s") : dstyle == 1 ? "w" : ""));
      }
      if (dmin <= 2 && dmax >= 2) {
        dd = d / 86400;
        if (dmax > 2) {
          dd |= 0;
          d -= 86400 * dd;
        }
        zstr.push('d"d"');
        dstr.push(dd + (dstyle == 2 ? " day" + (dd == 1 ? "" : "s") : dstyle == 1 ? "d" : ""));
      }
      if (dmin <= 4 && dmax >= 4) {
        dd = d / 3600;
        if (dmax > 4) {
          dd |= 0;
          d -= 3600 * dd;
        }
        zstr.push((dmin >= 4 ? "[h]" : "h") + '"h"');
        dstr.push(dd + (dstyle == 2 ? " hour" + (dd == 1 ? "" : "s") : dstyle == 1 ? "h" : ""));
      }
      if (dmin <= 8 && dmax >= 8) {
        dd = d / 60;
        if (dmax > 8) {
          dd |= 0;
          d -= 60 * dd;
        }
        zstr.push((dmin >= 8 ? "[m]" : "m") + '"m"');
        if (dstyle == 0)
          dstr.push((dmin == 8 && dmax == 8 || dd >= 10 ? "" : "0") + dd);
        else
          dstr.push(dd + (dstyle == 2 ? " minute" + (dd == 1 ? "" : "s") : dstyle == 1 ? "m" : ""));
      }
      if (dmin <= 16 && dmax >= 16) {
        dd = d;
        if (dmax > 16) {
          dd |= 0;
          d -= dd;
        }
        zstr.push((dmin >= 16 ? "[s]" : "s") + '"s"');
        if (dstyle == 0)
          dstr.push((dmax == 16 && dmin == 16 || dd >= 10 ? "" : "0") + dd);
        else
          dstr.push(dd + (dstyle == 2 ? " second" + (dd == 1 ? "" : "s") : dstyle == 1 ? "s" : ""));
      }
      if (dmax >= 32) {
        dd = Math.round(1e3 * d);
        if (dmin < 32)
          zstr.push('.000"ms"');
        if (dstyle == 0)
          dstr.push((dd >= 100 ? "" : dd >= 10 ? "0" : "00") + dd);
        else
          dstr.push(dd + (dstyle == 2 ? " millisecond" + (dd == 1 ? "" : "s") : dstyle == 1 ? "ms" : ""));
      }
      cell.w = dstr.join(dstyle == 0 ? ":" : " ");
      cell.z = zstr.join(dstyle == 0 ? '":"' : " ");
      if (dstyle == 0)
        cell.w = cell.w.replace(/:(\d\d\d)$/, ".$1");
    }
}
function parse_old_storage(buf, lut, v, opts) {
  var dv = u8_to_dataview(buf);
  var flags = dv.getUint32(4, true);
  var ridx = -1, sidx = -1, zidx = -1, ieee = NaN, dc = 0, dt = new Date(Date.UTC(2001, 0, 1));
  var doff = v > 1 ? 12 : 8;
  if (flags & 2) {
    zidx = dv.getUint32(doff, true);
    doff += 4;
  }
  doff += popcnt(flags & (v > 1 ? 3468 : 396)) * 4;
  if (flags & 512) {
    ridx = dv.getUint32(doff, true);
    doff += 4;
  }
  doff += popcnt(flags & (v > 1 ? 12288 : 4096)) * 4;
  if (flags & 16) {
    sidx = dv.getUint32(doff, true);
    doff += 4;
  }
  if (flags & 32) {
    ieee = dv.getFloat64(doff, true);
    doff += 8;
  }
  if (flags & 64) {
    dt.setTime(dt.getTime() + (dc = dv.getFloat64(doff, true)) * 1e3);
    doff += 8;
  }
  if (v > 1) {
    flags = dv.getUint32(8, true) >>> 16;
    if (flags & 255) {
      if (zidx == -1)
        zidx = dv.getUint32(doff, true);
      doff += 4;
    }
  }
  var ret;
  var t = buf[v >= 4 ? 1 : 2];
  switch (t) {
    case 0:
      return void 0;
    case 2:
      ret = { t: "n", v: ieee };
      break;
    case 3:
      ret = { t: "s", v: lut.sst[sidx] };
      break;
    case 5:
      {
        if (opts == null ? void 0 : opts.cellDates)
          ret = { t: "d", v: dt };
        else
          ret = { t: "n", v: dc / 86400 + 35430, z: table_fmt[14] };
      }
      break;
    case 6:
      ret = { t: "b", v: ieee > 0 };
      break;
    case 7:
      ret = { t: "n", v: ieee };
      break;
    case 8:
      ret = { t: "e", v: 0 };
      break;
    case 9:
      {
        if (ridx > -1) {
          var rts = lut.rsst[ridx];
          ret = { t: "s", v: rts.v };
          if (rts.l)
            ret.l = { Target: rts.l };
        } else
          throw new Error("Unsupported cell type ".concat(buf[subarray](0, 4)));
      }
      break;
    default:
      throw new Error("Unsupported cell type ".concat(buf[subarray](0, 4)));
  }
  if (zidx > -1)
    numbers_format_cell(ret, t | v << 8, flags, lut.ofmt[zidx], lut.nfmt[zidx]);
  if (t == 7)
    ret.v /= 86400;
  return ret;
}
function parse_new_storage(buf, lut, opts) {
  var dv = u8_to_dataview(buf);
  var flags = dv.getUint32(4, true);
  var fields = dv.getUint32(8, true);
  var doff = 12;
  var ridx = -1, sidx = -1, zidx = -1, d128 = NaN, ieee = NaN, dc = 0, dt = new Date(Date.UTC(2001, 0, 1)), eidx = -1, fidx = -1;
  if (fields & 1) {
    d128 = readDecimal128LE(buf, doff);
    doff += 16;
  }
  if (fields & 2) {
    ieee = dv.getFloat64(doff, true);
    doff += 8;
  }
  if (fields & 4) {
    dt.setTime(dt.getTime() + (dc = dv.getFloat64(doff, true)) * 1e3);
    doff += 8;
  }
  if (fields & 8) {
    sidx = dv.getUint32(doff, true);
    doff += 4;
  }
  if (fields & 16) {
    ridx = dv.getUint32(doff, true);
    doff += 4;
  }
  doff += popcnt(fields & 480) * 4;
  if (fields & 512) {
    fidx = dv.getUint32(doff, true);
    doff += 4;
  }
  doff += popcnt(fields & 1024) * 4;
  if (fields & 2048) {
    eidx = dv.getUint32(doff, true);
    doff += 4;
  }
  var ret;
  var t = buf[1];
  switch (t) {
    case 0:
      ret = { t: "z" };
      break;
    case 2:
      ret = { t: "n", v: d128 };
      break;
    case 3:
      ret = { t: "s", v: lut.sst[sidx] };
      break;
    case 5:
      {
        if (opts == null ? void 0 : opts.cellDates)
          ret = { t: "d", v: dt };
        else
          ret = { t: "n", v: dc / 86400 + 35430, z: table_fmt[14] };
      }
      break;
    case 6:
      ret = { t: "b", v: ieee > 0 };
      break;
    case 7:
      ret = { t: "n", v: ieee };
      break;
    case 8:
      ret = { t: "e", v: 0 };
      break;
    case 9:
      {
        if (ridx > -1) {
          var rts = lut.rsst[ridx];
          ret = { t: "s", v: rts.v };
          if (rts.l)
            ret.l = { Target: rts.l };
        } else
          throw new Error("Unsupported cell type ".concat(buf[1], " : ").concat(fields & 31, " : ").concat(buf[subarray](0, 4)));
      }
      break;
    case 10:
      ret = { t: "n", v: d128 };
      break;
    default:
      throw new Error("Unsupported cell type ".concat(buf[1], " : ").concat(fields & 31, " : ").concat(buf[subarray](0, 4)));
  }
  doff += popcnt(fields & 4096) * 4;
  if (fields & 516096) {
    if (zidx == -1)
      zidx = dv.getUint32(doff, true);
    doff += 4;
  }
  if (fields & 524288) {
    var cmntidx = dv.getUint32(doff, true);
    doff += 4;
    if (lut.cmnt[cmntidx])
      ret.c = iwa_to_s5s_comment(lut.cmnt[cmntidx]);
  }
  if (zidx > -1)
    numbers_format_cell(ret, t | 5 << 8, fields >> 13, lut.ofmt[zidx], lut.nfmt[zidx]);
  if (t == 7)
    ret.v /= 86400;
  return ret;
}
function write_new_storage(cell, lut) {
  var out = new Uint8Array(32), dv = u8_to_dataview(out), l = 12, fields = 0;
  out[0] = 5;
  switch (cell.t) {
    case "n":
      if (cell.z && fmt_is_date(cell.z)) {
        out[1] = 5;
        dv.setFloat64(l, (numdate(cell.v + 1462).getTime() - Date.UTC(2001, 0, 1)) / 1e3, true);
        fields |= 4;
        l += 8;
        break;
      } else {
        out[1] = 2;
        writeDecimal128LE(out, l, cell.v);
        fields |= 1;
        l += 16;
      }
      break;
    case "b":
      out[1] = 6;
      dv.setFloat64(l, cell.v ? 1 : 0, true);
      fields |= 2;
      l += 8;
      break;
    case "s":
      {
        var s = cell.v == null ? "" : String(cell.v);
        if (cell.l) {
          var irsst = lut.rsst.findIndex(function(v) {
            var _a;
            return v.v == s && v.l == ((_a = cell.l) == null ? void 0 : _a.Target);
          });
          if (irsst == -1)
            lut.rsst[irsst = lut.rsst.length] = { v: s, l: cell.l.Target };
          out[1] = 9;
          dv.setUint32(l, irsst, true);
          fields |= 16;
          l += 4;
        } else {
          var isst = lut.sst.indexOf(s);
          if (isst == -1)
            lut.sst[isst = lut.sst.length] = s;
          out[1] = 3;
          dv.setUint32(l, isst, true);
          fields |= 8;
          l += 4;
        }
      }
      break;
    case "d":
      out[1] = 5;
      dv.setFloat64(l, (cell.v.getTime() - Date.UTC(2001, 0, 1)) / 1e3, true);
      fields |= 4;
      l += 8;
      break;
    case "z":
      out[1] = 0;
      break;
    default:
      throw "unsupported cell type " + cell.t;
  }
  if (cell.c) {
    lut.cmnt.push(s5s_to_iwa_comment(cell.c));
    dv.setUint32(l, lut.cmnt.length - 1, true);
    fields |= 524288;
    l += 4;
  }
  dv.setUint32(8, fields, true);
  return out[subarray](0, l);
}
function write_old_storage(cell, lut) {
  var out = new Uint8Array(32), dv = u8_to_dataview(out), l = 12, fields = 0, s = "";
  out[0] = 4;
  switch (cell.t) {
    case "n":
      break;
    case "b":
      break;
    case "s":
      {
        s = cell.v == null ? "" : String(cell.v);
        if (cell.l) {
          var irsst = lut.rsst.findIndex(function(v) {
            var _a;
            return v.v == s && v.l == ((_a = cell.l) == null ? void 0 : _a.Target);
          });
          if (irsst == -1)
            lut.rsst[irsst = lut.rsst.length] = { v: s, l: cell.l.Target };
          out[1] = 9;
          dv.setUint32(l, irsst, true);
          fields |= 512;
          l += 4;
        } else {
        }
      }
      break;
    case "d":
      break;
    case "e":
      break;
    case "z":
      break;
    default:
      throw "unsupported cell type " + cell.t;
  }
  if (cell.c) {
    dv.setUint32(l, lut.cmnt.length - 1, true);
    fields |= 4096;
    l += 4;
  }
  switch (cell.t) {
    case "n":
      out[1] = 2;
      dv.setFloat64(l, cell.v, true);
      fields |= 32;
      l += 8;
      break;
    case "b":
      out[1] = 6;
      dv.setFloat64(l, cell.v ? 1 : 0, true);
      fields |= 32;
      l += 8;
      break;
    case "s":
      {
        s = cell.v == null ? "" : String(cell.v);
        if (cell.l) {
        } else {
          var isst = lut.sst.indexOf(s);
          if (isst == -1)
            lut.sst[isst = lut.sst.length] = s;
          out[1] = 3;
          dv.setUint32(l, isst, true);
          fields |= 16;
          l += 4;
        }
      }
      break;
    case "d":
      out[1] = 5;
      dv.setFloat64(l, (cell.v.getTime() - Date.UTC(2001, 0, 1)) / 1e3, true);
      fields |= 64;
      l += 8;
      break;
    case "z":
      out[1] = 0;
      break;
    default:
      throw "unsupported cell type " + cell.t;
  }
  dv.setUint32(8, fields, true);
  return out[subarray](0, l);
}
function parse_cell_storage(buf, lut, opts) {
  switch (buf[0]) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
      return parse_old_storage(buf, lut, buf[0], opts);
    case 5:
      return parse_new_storage(buf, lut, opts);
    default:
      throw new Error("Unsupported payload version ".concat(buf[0]));
  }
}
function parse_TSP_Reference(buf) {
  var pb = parse_shallow(buf);
  return varint_to_i32(pb[1][0].data);
}
function write_TSP_Reference(idx) {
  return write_shallow([
    [],
    [{ type: 0, data: write_varint49(idx) }]
  ]);
}
function numbers_add_oref(iwa, ref) {
  var _a;
  var orefs = ((_a = iwa.messages[0].meta[5]) == null ? void 0 : _a[0]) ? parse_packed_varints(iwa.messages[0].meta[5][0].data) : [];
  var orefidx = orefs.indexOf(ref);
  if (orefidx == -1) {
    orefs.push(ref);
    iwa.messages[0].meta[5] = [{ type: 2, data: write_packed_varints(orefs) }];
  }
}
function numbers_del_oref(iwa, ref) {
  var _a;
  var orefs = ((_a = iwa.messages[0].meta[5]) == null ? void 0 : _a[0]) ? parse_packed_varints(iwa.messages[0].meta[5][0].data) : [];
  iwa.messages[0].meta[5] = [{ type: 2, data: write_packed_varints(orefs.filter(function(r) {
    return r != ref;
  })) }];
}
function parse_TST_TableDataList(M, root) {
  var pb = parse_shallow(root.data);
  var type = varint_to_i32(pb[1][0].data);
  var entries = pb[3];
  var data = [];
  (entries || []).forEach(function(entry) {
    var _a, _b;
    var le = parse_shallow(entry.data);
    if (!le[1])
      return;
    var key = varint_to_i32(le[1][0].data) >>> 0;
    switch (type) {
      case 1:
        data[key] = u8str(le[3][0].data);
        break;
      case 8:
        {
          var rt = M[parse_TSP_Reference(le[9][0].data)][0];
          var rtp = parse_shallow(rt.data);
          var rtpref = M[parse_TSP_Reference(rtp[1][0].data)][0];
          var mtype = varint_to_i32(rtpref.meta[1][0].data);
          if (mtype != 2001)
            throw new Error("2000 unexpected reference to ".concat(mtype));
          var tswpsa = parse_shallow(rtpref.data);
          var richtext = { v: tswpsa[3].map(function(x) {
            return u8str(x.data);
          }).join("") };
          data[key] = richtext;
          sfields:
            if ((_a = tswpsa == null ? void 0 : tswpsa[11]) == null ? void 0 : _a[0]) {
              var smartfields = (_b = parse_shallow(tswpsa[11][0].data)) == null ? void 0 : _b[1];
              if (!smartfields)
                break sfields;
              smartfields.forEach(function(sf) {
                var _a2, _b2, _c;
                var attr = parse_shallow(sf.data);
                if ((_a2 = attr[2]) == null ? void 0 : _a2[0]) {
                  var obj = M[parse_TSP_Reference((_b2 = attr[2]) == null ? void 0 : _b2[0].data)][0];
                  var objtype = varint_to_i32(obj.meta[1][0].data);
                  switch (objtype) {
                    case 2032:
                      var hlink = parse_shallow(obj.data);
                      if (((_c = hlink == null ? void 0 : hlink[2]) == null ? void 0 : _c[0]) && !richtext.l)
                        richtext.l = u8str(hlink[2][0].data);
                      break;
                    case 2039:
                      break;
                    default:
                      console.log("unrecognized ObjectAttribute type ".concat(objtype));
                  }
                }
              });
            }
        }
        break;
      case 2:
        data[key] = parse_shallow(le[6][0].data);
        break;
      case 3:
        data[key] = parse_shallow(le[5][0].data);
        break;
      case 10:
        {
          var cs = M[parse_TSP_Reference(le[10][0].data)][0];
          data[key] = parse_TSD_CommentStorageArchive(M, cs.data);
        }
        break;
      default:
        throw type;
    }
  });
  return data;
}
function parse_TST_TileRowInfo(u8, type) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
  var pb = parse_shallow(u8);
  var R = varint_to_i32(pb[1][0].data) >>> 0;
  var cnt = varint_to_i32(pb[2][0].data) >>> 0;
  var wide_offsets = ((_b = (_a = pb[8]) == null ? void 0 : _a[0]) == null ? void 0 : _b.data) && varint_to_i32(pb[8][0].data) > 0 || false;
  var used_storage_u8, used_storage;
  if (((_d = (_c = pb[7]) == null ? void 0 : _c[0]) == null ? void 0 : _d.data) && type != 0) {
    used_storage_u8 = (_f = (_e = pb[7]) == null ? void 0 : _e[0]) == null ? void 0 : _f.data;
    used_storage = (_h = (_g = pb[6]) == null ? void 0 : _g[0]) == null ? void 0 : _h.data;
  } else if (((_j = (_i = pb[4]) == null ? void 0 : _i[0]) == null ? void 0 : _j.data) && type != 1) {
    used_storage_u8 = (_l = (_k = pb[4]) == null ? void 0 : _k[0]) == null ? void 0 : _l.data;
    used_storage = (_n = (_m = pb[3]) == null ? void 0 : _m[0]) == null ? void 0 : _n.data;
  } else
    throw "NUMBERS Tile missing ".concat(type, " cell storage");
  var width = wide_offsets ? 4 : 1;
  var used_storage_offsets = u8_to_dataview(used_storage_u8);
  var offsets = [];
  for (var C = 0; C < used_storage_u8.length / 2; ++C) {
    var off = used_storage_offsets.getUint16(C * 2, true);
    if (off < 65535)
      offsets.push([C, off]);
  }
  if (offsets.length != cnt)
    throw "Expected ".concat(cnt, " cells, found ").concat(offsets.length);
  var cells = [];
  for (C = 0; C < offsets.length - 1; ++C)
    cells[offsets[C][0]] = used_storage[subarray](offsets[C][1] * width, offsets[C + 1][1] * width);
  if (offsets.length >= 1)
    cells[offsets[offsets.length - 1][0]] = used_storage[subarray](offsets[offsets.length - 1][1] * width);
  return { R: R, cells: cells };
}
function parse_TST_Tile(M, root) {
  var _a;
  var pb = parse_shallow(root.data);
  var storage = -1;
  if ((_a = pb == null ? void 0 : pb[7]) == null ? void 0 : _a[0]) {
    if (varint_to_i32(pb[7][0].data) >>> 0)
      storage = 1;
    else
      storage = 0;
  }
  var ri = mappa(pb[5], function(u8) {
    return parse_TST_TileRowInfo(u8, storage);
  });
  return {
    nrows: varint_to_i32(pb[4][0].data) >>> 0,
    data: ri.reduce(function(acc, x) {
      if (!acc[x.R])
        acc[x.R] = [];
      x.cells.forEach(function(cell, C) {
        if (acc[x.R][C])
          throw new Error("Duplicate cell r=".concat(x.R, " c=").concat(C));
        acc[x.R][C] = cell;
      });
      return acc;
    }, [])
  };
}
function parse_TSD_CommentStorageArchive(M, data) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
  var out = { t: "", a: "" };
  var csp = parse_shallow(data);
  if ((_b = (_a = csp == null ? void 0 : csp[1]) == null ? void 0 : _a[0]) == null ? void 0 : _b.data)
    out.t = u8str((_d = (_c = csp == null ? void 0 : csp[1]) == null ? void 0 : _c[0]) == null ? void 0 : _d.data) || "";
  if ((_f = (_e = csp == null ? void 0 : csp[3]) == null ? void 0 : _e[0]) == null ? void 0 : _f.data) {
    var as = M[parse_TSP_Reference((_h = (_g = csp == null ? void 0 : csp[3]) == null ? void 0 : _g[0]) == null ? void 0 : _h.data)][0];
    var asp = parse_shallow(as.data);
    if ((_j = (_i = asp[1]) == null ? void 0 : _i[0]) == null ? void 0 : _j.data)
      out.a = u8str(asp[1][0].data);
  }
  if (csp == null ? void 0 : csp[4]) {
    out.replies = [];
    csp[4].forEach(function(pi) {
      var cs = M[parse_TSP_Reference(pi.data)][0];
      out.replies.push(parse_TSD_CommentStorageArchive(M, cs.data));
    });
  }
  return out;
}
function iwa_to_s5s_comment(iwa) {
  var out = [];
  out.push({ t: iwa.t || "", a: iwa.a, T: iwa.replies && iwa.replies.length > 0 });
  if (iwa.replies)
    iwa.replies.forEach(function(reply) {
      out.push({ t: reply.t || "", a: reply.a, T: true });
    });
  return out;
}
function s5s_to_iwa_comment(s5s) {
  var out = { a: "", t: "", replies: [] };
  for (var i = 0; i < s5s.length; ++i) {
    if (i == 0) {
      out.a = s5s[i].a;
      out.t = s5s[i].t;
    } else {
      out.replies.push({ a: s5s[i].a, t: s5s[i].t });
    }
  }
  return out;
}
function parse_TST_TableModelArchive(M, root, ws, opts) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
  var pb = parse_shallow(root.data);
  var range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  range.e.r = (varint_to_i32(pb[6][0].data) >>> 0) - 1;
  if (range.e.r < 0)
    throw new Error("Invalid row varint ".concat(pb[6][0].data));
  range.e.c = (varint_to_i32(pb[7][0].data) >>> 0) - 1;
  if (range.e.c < 0)
    throw new Error("Invalid col varint ".concat(pb[7][0].data));
  ws["!ref"] = encode_range(range);
  var dense = ws["!data"] != null, dws = ws;
  var store = parse_shallow(pb[4][0].data);
  var lut = numbers_lut_new();
  if ((_a = store[4]) == null ? void 0 : _a[0])
    lut.sst = parse_TST_TableDataList(M, M[parse_TSP_Reference(store[4][0].data)][0]);
  if ((_b = store[6]) == null ? void 0 : _b[0])
    lut.fmla = parse_TST_TableDataList(M, M[parse_TSP_Reference(store[6][0].data)][0]);
  if ((_c = store[11]) == null ? void 0 : _c[0])
    lut.ofmt = parse_TST_TableDataList(M, M[parse_TSP_Reference(store[11][0].data)][0]);
  if ((_d = store[12]) == null ? void 0 : _d[0])
    lut.ferr = parse_TST_TableDataList(M, M[parse_TSP_Reference(store[12][0].data)][0]);
  if ((_e = store[17]) == null ? void 0 : _e[0])
    lut.rsst = parse_TST_TableDataList(M, M[parse_TSP_Reference(store[17][0].data)][0]);
  if ((_f = store[19]) == null ? void 0 : _f[0])
    lut.cmnt = parse_TST_TableDataList(M, M[parse_TSP_Reference(store[19][0].data)][0]);
  if ((_g = store[22]) == null ? void 0 : _g[0])
    lut.nfmt = parse_TST_TableDataList(M, M[parse_TSP_Reference(store[22][0].data)][0]);
  var tile = parse_shallow(store[3][0].data);
  var _R = 0;
  if (!((_h = store[9]) == null ? void 0 : _h[0]))
    throw "NUMBERS file missing row tree";
  var rtt = parse_shallow(store[9][0].data)[1].map(function(p) {
    return parse_shallow(p.data);
  });
  rtt.forEach(function(kv) {
    _R = varint_to_i32(kv[1][0].data);
    var tidx = varint_to_i32(kv[2][0].data);
    var t = tile[1][tidx];
    if (!t)
      throw "NUMBERS missing tile " + tidx;
    var tl = parse_shallow(t.data);
    var ref2 = M[parse_TSP_Reference(tl[2][0].data)][0];
    var mtype2 = varint_to_i32(ref2.meta[1][0].data);
    if (mtype2 != 6002)
      throw new Error("6001 unexpected reference to ".concat(mtype2));
    var _tile = parse_TST_Tile(M, ref2);
    _tile.data.forEach(function(row, R) {
      row.forEach(function(buf, C) {
        var res = parse_cell_storage(buf, lut, opts);
        if (res) {
          if (dense) {
            if (!dws["!data"][_R + R])
              dws["!data"][_R + R] = [];
            dws["!data"][_R + R][C] = res;
          } else {
            ws[encode_col(C) + encode_row(_R + R)] = res;
          }
        }
      });
    });
    _R += _tile.nrows;
  });
  if ((_i = store[13]) == null ? void 0 : _i[0]) {
    var ref = M[parse_TSP_Reference(store[13][0].data)][0];
    var mtype = varint_to_i32(ref.meta[1][0].data);
    if (mtype != 6144)
      throw new Error("Expected merge type 6144, found ".concat(mtype));
    ws["!merges"] = (_j = parse_shallow(ref.data)) == null ? void 0 : _j[1].map(function(pi) {
      var merge = parse_shallow(pi.data);
      var origin = u8_to_dataview(parse_shallow(merge[1][0].data)[1][0].data), size = u8_to_dataview(parse_shallow(merge[2][0].data)[1][0].data);
      return {
        s: { r: origin.getUint16(0, true), c: origin.getUint16(2, true) },
        e: {
          r: origin.getUint16(0, true) + size.getUint16(0, true) - 1,
          c: origin.getUint16(2, true) + size.getUint16(2, true) - 1
        }
      };
    });
  }
  if (!((_k = ws["!merges"]) == null ? void 0 : _k.length) && ((_l = pb[47]) == null ? void 0 : _l[0])) {
    var merge_owner = parse_shallow(pb[47][0].data);
    if ((_m = merge_owner[2]) == null ? void 0 : _m[0]) {
      var formula_store = parse_shallow(merge_owner[2][0].data);
      if ((_n = formula_store[3]) == null ? void 0 : _n[0]) {
        ws["!merges"] = mappa(formula_store[3], function(u) {
          var _a2, _b2, _c2, _d2, _e2;
          var formula_pair = parse_shallow(u);
          var formula = parse_shallow(formula_pair[2][0].data);
          var AST_node_array = parse_shallow(formula[1][0].data);
          if (!((_a2 = AST_node_array[1]) == null ? void 0 : _a2[0]))
            return;
          var AST_node0 = parse_shallow(AST_node_array[1][0].data);
          var AST_node_type = varint_to_i32(AST_node0[1][0].data);
          if (AST_node_type != 67)
            return;
          var AST_colon_tract = parse_shallow(AST_node0[40][0].data);
          if (!((_b2 = AST_colon_tract[3]) == null ? void 0 : _b2[0]) || !((_c2 = AST_colon_tract[4]) == null ? void 0 : _c2[0]))
            return;
          var colrange = parse_shallow(AST_colon_tract[3][0].data);
          var rowrange = parse_shallow(AST_colon_tract[4][0].data);
          var c = varint_to_i32(colrange[1][0].data);
          var C = ((_d2 = colrange[2]) == null ? void 0 : _d2[0]) ? varint_to_i32(colrange[2][0].data) : c;
          var r = varint_to_i32(rowrange[1][0].data);
          var R = ((_e2 = rowrange[2]) == null ? void 0 : _e2[0]) ? varint_to_i32(rowrange[2][0].data) : r;
          return { s: { r: r, c: c }, e: { r: R, c: C } };
        }).filter(function(x) {
          return x != null;
        });
      }
    }
  }
}
function parse_TST_TableInfoArchive(M, root, opts) {
  var pb = parse_shallow(root.data);
  var out = { "!ref": "A1" };
  if (opts == null ? void 0 : opts.dense)
    out["!data"] = [];
  var tableref = M[parse_TSP_Reference(pb[2][0].data)];
  var mtype = varint_to_i32(tableref[0].meta[1][0].data);
  if (mtype != 6001)
    throw new Error("6000 unexpected reference to ".concat(mtype));
  parse_TST_TableModelArchive(M, tableref[0], out, opts);
  return out;
}
function parse_TN_SheetArchive(M, root, opts) {
  var _a;
  var pb = parse_shallow(root.data);
  var out = {
    name: ((_a = pb[1]) == null ? void 0 : _a[0]) ? u8str(pb[1][0].data) : "",
    sheets: []
  };
  var shapeoffs = mappa(pb[2], parse_TSP_Reference);
  shapeoffs.forEach(function(off) {
    M[off].forEach(function(m) {
      var mtype = varint_to_i32(m.meta[1][0].data);
      if (mtype == 6e3)
        out.sheets.push(parse_TST_TableInfoArchive(M, m, opts));
    });
  });
  return out;
}
function parse_TN_DocumentArchive(M, root, opts) {
  var _a;
  var out = book_new();
  out.Workbook = { WBProps: { date1904: true } };
  var pb = parse_shallow(root.data);
  if ((_a = pb[2]) == null ? void 0 : _a[0])
    throw new Error("Keynote presentations are not supported");
  var sheetoffs = mappa(pb[1], parse_TSP_Reference);
  sheetoffs.forEach(function(off) {
    M[off].forEach(function(m) {
      var mtype = varint_to_i32(m.meta[1][0].data);
      if (mtype == 2) {
        var root2 = parse_TN_SheetArchive(M, m, opts);
        root2.sheets.forEach(function(sheet, idx) {
          book_append_sheet(out, sheet, idx == 0 ? root2.name : root2.name + "_" + idx, true);
        });
      }
    });
  });
  if (out.SheetNames.length == 0)
    throw new Error("Empty NUMBERS file");
  out.bookType = "numbers";
  return out;
}
function parse_numbers_iwa(cfb, opts) {
  var _a, _b, _c, _d, _e, _f, _g;
  var M = {}, indices = [];
  cfb.FullPaths.forEach(function(p) {
    if (p.match(/\.iwpv2/))
      throw new Error("Unsupported password protection");
  });
  cfb.FileIndex.forEach(function(s) {
    if (!s.name.match(/\.iwa$/))
      return;
    if (s.content[0] != 0)
      return;
    var o;
    try {
      o = decompress_iwa_file(s.content);
    } catch (e) {
      return console.log("?? " + s.content.length + " " + (e.message || e));
    }
    var packets;
    try {
      packets = parse_iwa_file(o);
    } catch (e) {
      return console.log("## " + (e.message || e));
    }
    packets.forEach(function(packet) {
      M[packet.id] = packet.messages;
      indices.push(packet.id);
    });
  });
  if (!indices.length)
    throw new Error("File has no messages");
  if (((_c = (_b = (_a = M == null ? void 0 : M[1]) == null ? void 0 : _a[0].meta) == null ? void 0 : _b[1]) == null ? void 0 : _c[0].data) && varint_to_i32(M[1][0].meta[1][0].data) == 1e4)
    throw new Error("Pages documents are not supported");
  var docroot = ((_g = (_f = (_e = (_d = M == null ? void 0 : M[1]) == null ? void 0 : _d[0]) == null ? void 0 : _e.meta) == null ? void 0 : _f[1]) == null ? void 0 : _g[0].data) && varint_to_i32(M[1][0].meta[1][0].data) == 1 && M[1][0];
  if (!docroot)
    indices.forEach(function(idx) {
      M[idx].forEach(function(iwam) {
        var mtype = varint_to_i32(iwam.meta[1][0].data) >>> 0;
        if (mtype == 1) {
          if (!docroot)
            docroot = iwam;
          else
            throw new Error("Document has multiple roots");
        }
      });
    });
  if (!docroot)
    throw new Error("Cannot find Document root");
  return parse_TN_DocumentArchive(M, docroot, opts);
}
function write_TST_TileRowInfo(data, lut, wide) {
  var _a, _b, _c;
  var tri = [
    [],
    [{ type: 0, data: write_varint49(0) }],
    [{ type: 0, data: write_varint49(0) }],
    [{ type: 2, data: new Uint8Array([]) }],
    [{ type: 2, data: new Uint8Array(Array.from({ length: 510 }, function() {
      return 255;
    })) }],
    [{ type: 0, data: write_varint49(5) }],
    [{ type: 2, data: new Uint8Array([]) }],
    [{ type: 2, data: new Uint8Array(Array.from({ length: 510 }, function() {
      return 255;
    })) }],
    [{ type: 0, data: write_varint49(1) }]
  ];
  if (!((_a = tri[6]) == null ? void 0 : _a[0]) || !((_b = tri[7]) == null ? void 0 : _b[0]))
    throw "Mutation only works on post-BNC storages!";
  var cnt = 0;
  if (tri[7][0].data.length < 2 * data.length) {
    var new_7 = new Uint8Array(2 * data.length);
    new_7.set(tri[7][0].data);
    tri[7][0].data = new_7;
  }
  if (tri[4][0].data.length < 2 * data.length) {
    var new_4 = new Uint8Array(2 * data.length);
    new_4.set(tri[4][0].data);
    tri[4][0].data = new_4;
  }
  var dv = u8_to_dataview(tri[7][0].data), last_offset = 0, cell_storage = [];
  var _dv = u8_to_dataview(tri[4][0].data), _last_offset = 0, _cell_storage = [];
  var width = wide ? 4 : 1;
  for (var C = 0; C < data.length; ++C) {
    if (data[C] == null || data[C].t == "z" && !((_c = data[C].c) == null ? void 0 : _c.length) || data[C].t == "e") {
      dv.setUint16(C * 2, 65535, true);
      _dv.setUint16(C * 2, 65535);
      continue;
    }
    dv.setUint16(C * 2, last_offset / width, true);
    _dv.setUint16(C * 2, _last_offset / width, true);
    var celload, _celload;
    switch (data[C].t) {
      case "d":
        if (data[C].v instanceof Date) {
          celload = write_new_storage(data[C], lut);
          _celload = write_old_storage(data[C], lut);
          break;
        }
        celload = write_new_storage(data[C], lut);
        _celload = write_old_storage(data[C], lut);
        break;
      case "s":
      case "n":
      case "b":
      case "z":
        celload = write_new_storage(data[C], lut);
        _celload = write_old_storage(data[C], lut);
        break;
      default:
        throw new Error("Unsupported value " + data[C]);
    }
    cell_storage.push(celload);
    last_offset += celload.length;
    {
      _cell_storage.push(_celload);
      _last_offset += _celload.length;
    }
    ++cnt;
  }
  tri[2][0].data = write_varint49(cnt);
  tri[5][0].data = write_varint49(5);
  for (; C < tri[7][0].data.length / 2; ++C) {
    dv.setUint16(C * 2, 65535, true);
    _dv.setUint16(C * 2, 65535, true);
  }
  tri[6][0].data = u8concat(cell_storage);
  tri[3][0].data = u8concat(_cell_storage);
  tri[8] = [{ type: 0, data: write_varint49(wide ? 1 : 0) }];
  return tri;
}
function write_iwam(type, payload) {
  return {
    meta: [
      [],
      [{ type: 0, data: write_varint49(type) }]
    ],
    data: payload
  };
}
function get_unique_msgid(dep, dependents) {
  if (!dependents.last)
    dependents.last = 927262;
  for (var i = dependents.last; i < 2e6; ++i)
    if (!dependents[i]) {
      dependents[dependents.last = i] = dep;
      return i;
    }
  throw new Error("Too many messages");
}
function build_numbers_deps(cfb) {
  var dependents = {};
  var indices = [];
  cfb.FileIndex.map(function(fi, idx) {
    return [fi, cfb.FullPaths[idx]];
  }).forEach(function(row) {
    var fi = row[0], fp = row[1];
    if (fi.type != 2)
      return;
    if (!fi.name.match(/\.iwa/))
      return;
    if (fi.content[0] != 0)
      return;
    parse_iwa_file(decompress_iwa_file(fi.content)).forEach(function(packet) {
      indices.push(packet.id);
      dependents[packet.id] = { deps: [], location: fp, type: varint_to_i32(packet.messages[0].meta[1][0].data) };
    });
  });
  cfb.FileIndex.forEach(function(fi) {
    if (!fi.name.match(/\.iwa/))
      return;
    if (fi.content[0] != 0)
      return;
    parse_iwa_file(decompress_iwa_file(fi.content)).forEach(function(ia) {
      ia.messages.forEach(function(mess) {
        [5, 6].forEach(function(f) {
          if (!mess.meta[f])
            return;
          mess.meta[f].forEach(function(x) {
            dependents[ia.id].deps.push(varint_to_i32(x.data));
          });
        });
      });
    });
  });
  return dependents;
}
function write_TSP_Color_RGB(r, g, b) {
  return write_shallow([
    [],
    [{ type: 0, data: write_varint49(1) }],
    [],
    [{ type: 5, data: new Uint8Array(Float32Array.from([r / 255]).buffer) }],
    [{ type: 5, data: new Uint8Array(Float32Array.from([g / 255]).buffer) }],
    [{ type: 5, data: new Uint8Array(Float32Array.from([b / 255]).buffer) }],
    [{ type: 5, data: new Uint8Array(Float32Array.from([1]).buffer) }],
    [],
    [],
    [],
    [],
    [],
    [{ type: 0, data: write_varint49(1) }]
  ]);
}
function get_author_color(n) {
  switch (n) {
    case 0:
      return write_TSP_Color_RGB(99, 222, 171);
    case 1:
      return write_TSP_Color_RGB(162, 197, 240);
    case 2:
      return write_TSP_Color_RGB(255, 189, 189);
  }
  return write_TSP_Color_RGB(Math.random() * 255, Math.random() * 255, Math.random() * 255);
}
function write_numbers_iwa(wb, opts) {
  if (!opts || !opts.numbers)
    throw new Error("Must pass a `numbers` option -- check the README");
  var cfb = CFB.read(opts.numbers, { type: "base64" });
  var deps = build_numbers_deps(cfb);
  var docroot = numbers_iwa_find(cfb, deps, 1);
  if (docroot == null)
    throw "Could not find message ".concat(1, " in Numbers template");
  var sheetrefs = mappa(parse_shallow(docroot.messages[0].data)[1], parse_TSP_Reference);
  if (sheetrefs.length > 1)
    throw new Error("Template NUMBERS file must have exactly one sheet");
  wb.SheetNames.forEach(function(name, idx) {
    if (idx >= 1) {
      numbers_add_ws(cfb, deps, idx + 1);
      docroot = numbers_iwa_find(cfb, deps, 1);
      sheetrefs = mappa(parse_shallow(docroot.messages[0].data)[1], parse_TSP_Reference);
    }
    write_numbers_ws(cfb, deps, wb.Sheets[name], name, idx, sheetrefs[idx]);
  });
  return cfb;
}
function numbers_iwa_doit(cfb, deps, id, cb) {
  var entry = CFB.find(cfb, deps[id].location);
  if (!entry)
    throw "Could not find ".concat(deps[id].location, " in Numbers template");
  var x = parse_iwa_file(decompress_iwa_file(entry.content));
  var ainfo = x.find(function(packet) {
    return packet.id == id;
  });
  cb(ainfo, x);
  entry.content = compress_iwa_file(write_iwa_file(x));
  entry.size = entry.content.length;
}
function numbers_iwa_find(cfb, deps, id) {
  var entry = CFB.find(cfb, deps[id].location);
  if (!entry)
    throw "Could not find ".concat(deps[id].location, " in Numbers template");
  var x = parse_iwa_file(decompress_iwa_file(entry.content));
  var ainfo = x.find(function(packet) {
    return packet.id == id;
  });
  return ainfo;
}
function numbers_add_meta(mlist, newid, newloc) {
  mlist[3].push({ type: 2, data: write_shallow([
    [],
    [{ type: 0, data: write_varint49(newid) }],
    [{ type: 2, data: stru8(newloc.replace(/-[\s\S]*$/, "")) }],
    [{ type: 2, data: stru8(newloc) }],
    [{ type: 2, data: new Uint8Array([2, 0, 0]) }],
    [{ type: 2, data: new Uint8Array([2, 0, 0]) }],
    [],
    [],
    [],
    [],
    [{ type: 0, data: write_varint49(0) }],
    [],
    [{ type: 0, data: write_varint49(0) }]
  ]) });
  mlist[1] = [{ type: 0, data: write_varint49(Math.max(newid + 1, varint_to_i32(mlist[1][0].data))) }];
}
function numbers_add_msg(cfb, type, msg, path, deps, id) {
  if (!id)
    id = get_unique_msgid({ deps: [], location: "", type: type }, deps);
  var loc = "".concat(path, "-").concat(id, ".iwa");
  deps[id].location = "Root Entry" + loc;
  CFB.utils.cfb_add(cfb, loc, compress_iwa_file(write_iwa_file([{
    id: id,
    messages: [write_iwam(type, write_shallow(msg))]
  }])));
  var newloc = loc.replace(/^[\/]/, "").replace(/^Index\//, "").replace(/\.iwa$/, "");
  numbers_iwa_doit(cfb, deps, 2, function(ai) {
    var mlist = parse_shallow(ai.messages[0].data);
    numbers_add_meta(mlist, id || 0, newloc);
    ai.messages[0].data = write_shallow(mlist);
  });
  return id;
}
function numbers_meta_add_dep(mlist, deps, id, dep) {
  var loc = deps[id].location.replace(/^Root Entry\//, "").replace(/^Index\//, "").replace(/\.iwa$/, "");
  var parentidx = mlist[3].findIndex(function(m) {
    var _a, _b;
    var mm = parse_shallow(m.data);
    if ((_a = mm[3]) == null ? void 0 : _a[0])
      return u8str(mm[3][0].data) == loc;
    if (((_b = mm[2]) == null ? void 0 : _b[0]) && u8str(mm[2][0].data) == loc)
      return true;
    return false;
  });
  var parent = parse_shallow(mlist[3][parentidx].data);
  if (!parent[6])
    parent[6] = [];
  (Array.isArray(dep) ? dep : [dep]).forEach(function(dep2) {
    parent[6].push({
      type: 2,
      data: write_shallow([
        [],
        [{ type: 0, data: write_varint49(dep2) }]
      ])
    });
  });
  mlist[3][parentidx].data = write_shallow(parent);
}
function numbers_meta_del_dep(mlist, deps, id, dep) {
  var loc = deps[id].location.replace(/^Root Entry\//, "").replace(/^Index\//, "").replace(/\.iwa$/, "");
  var parentidx = mlist[3].findIndex(function(m) {
    var _a, _b;
    var mm = parse_shallow(m.data);
    if ((_a = mm[3]) == null ? void 0 : _a[0])
      return u8str(mm[3][0].data) == loc;
    if (((_b = mm[2]) == null ? void 0 : _b[0]) && u8str(mm[2][0].data) == loc)
      return true;
    return false;
  });
  var parent = parse_shallow(mlist[3][parentidx].data);
  if (!parent[6])
    parent[6] = [];
  parent[6] = parent[6].filter(function(m) {
    return varint_to_i32(parse_shallow(m.data)[1][0].data) != dep;
  });
  mlist[3][parentidx].data = write_shallow(parent);
}
function numbers_add_ws(cfb, deps, wsidx) {
  var sheetref = -1, newsheetref = -1;
  var remap = {};
  numbers_iwa_doit(cfb, deps, 1, function(docroot, arch) {
    var doc = parse_shallow(docroot.messages[0].data);
    sheetref = parse_TSP_Reference(parse_shallow(docroot.messages[0].data)[1][0].data);
    newsheetref = get_unique_msgid({ deps: [1], location: deps[sheetref].location, type: 2 }, deps);
    remap[sheetref] = newsheetref;
    numbers_add_oref(docroot, newsheetref);
    doc[1].push({ type: 2, data: write_TSP_Reference(newsheetref) });
    var sheet = numbers_iwa_find(cfb, deps, sheetref);
    sheet.id = newsheetref;
    if (deps[1].location == deps[newsheetref].location)
      arch.push(sheet);
    else
      numbers_iwa_doit(cfb, deps, newsheetref, function(_, x) {
        return x.push(sheet);
      });
    docroot.messages[0].data = write_shallow(doc);
  });
  var tiaref = -1;
  numbers_iwa_doit(cfb, deps, newsheetref, function(sheetroot, arch) {
    var sa = parse_shallow(sheetroot.messages[0].data);
    for (var i = 3; i <= 69; ++i)
      delete sa[i];
    var drawables = mappa(sa[2], parse_TSP_Reference);
    drawables.forEach(function(n) {
      return numbers_del_oref(sheetroot, n);
    });
    tiaref = get_unique_msgid({ deps: [newsheetref], location: deps[drawables[0]].location, type: deps[drawables[0]].type }, deps);
    numbers_add_oref(sheetroot, tiaref);
    remap[drawables[0]] = tiaref;
    sa[2] = [{ type: 2, data: write_TSP_Reference(tiaref) }];
    var tia = numbers_iwa_find(cfb, deps, drawables[0]);
    tia.id = tiaref;
    if (deps[drawables[0]].location == deps[newsheetref].location)
      arch.push(tia);
    else {
      numbers_iwa_doit(cfb, deps, 2, function(ai) {
        var mlist = parse_shallow(ai.messages[0].data);
        numbers_meta_add_dep(mlist, deps, newsheetref, tiaref);
        ai.messages[0].data = write_shallow(mlist);
      });
      numbers_iwa_doit(cfb, deps, tiaref, function(_, x) {
        return x.push(tia);
      });
    }
    sheetroot.messages[0].data = write_shallow(sa);
  });
  var tmaref = -1;
  numbers_iwa_doit(cfb, deps, tiaref, function(tiaroot, arch) {
    var tia = parse_shallow(tiaroot.messages[0].data);
    var da = parse_shallow(tia[1][0].data);
    for (var i = 3; i <= 69; ++i)
      delete da[i];
    var dap = parse_TSP_Reference(da[2][0].data);
    da[2][0].data = write_TSP_Reference(remap[dap]);
    tia[1][0].data = write_shallow(da);
    var oldtmaref = parse_TSP_Reference(tia[2][0].data);
    numbers_del_oref(tiaroot, oldtmaref);
    tmaref = get_unique_msgid({ deps: [tiaref], location: deps[oldtmaref].location, type: deps[oldtmaref].type }, deps);
    numbers_add_oref(tiaroot, tmaref);
    remap[oldtmaref] = tmaref;
    tia[2][0].data = write_TSP_Reference(tmaref);
    var tma = numbers_iwa_find(cfb, deps, oldtmaref);
    tma.id = tmaref;
    if (deps[tiaref].location == deps[tmaref].location)
      arch.push(tma);
    else
      numbers_iwa_doit(cfb, deps, tmaref, function(_, x) {
        return x.push(tma);
      });
    tiaroot.messages[0].data = write_shallow(tia);
  });
  numbers_iwa_doit(cfb, deps, tmaref, function(tmaroot, arch) {
    var _a, _b;
    var tma = parse_shallow(tmaroot.messages[0].data);
    var uuid = u8str(tma[1][0].data), new_uuid = uuid.replace(/-[A-Z0-9]*/, "-".concat(("0000" + wsidx.toString(16)).slice(-4)));
    tma[1][0].data = stru8(new_uuid);
    [12, 13, 29, 31, 32, 33, 39, 44, 47, 81, 82, 84].forEach(function(n) {
      return delete tma[n];
    });
    if (tma[45]) {
      var srrta = parse_shallow(tma[45][0].data);
      var ref = parse_TSP_Reference(srrta[1][0].data);
      numbers_del_oref(tmaroot, ref);
      delete tma[45];
    }
    if (tma[70]) {
      var hsoa = parse_shallow(tma[70][0].data);
      (_a = hsoa[2]) == null ? void 0 : _a.forEach(function(item) {
        var hsa = parse_shallow(item.data);
        [2, 3].map(function(n) {
          return hsa[n][0];
        }).forEach(function(hseadata) {
          var hsea = parse_shallow(hseadata.data);
          if (!hsea[8])
            return;
          var ref2 = parse_TSP_Reference(hsea[8][0].data);
          numbers_del_oref(tmaroot, ref2);
        });
      });
      delete tma[70];
    }
    [
      46,
      30,
      34,
      35,
      36,
      38,
      48,
      49,
      60,
      61,
      62,
      63,
      64,
      71,
      72,
      73,
      74,
      75,
      85,
      86,
      87,
      88,
      89
    ].forEach(function(n) {
      if (!tma[n])
        return;
      var ref2 = parse_TSP_Reference(tma[n][0].data);
      delete tma[n];
      numbers_del_oref(tmaroot, ref2);
    });
    var store = parse_shallow(tma[4][0].data);
    {
      [2, 4, 5, 6, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22].forEach(function(n) {
        var _a2;
        if (!((_a2 = store[n]) == null ? void 0 : _a2[0]))
          return;
        var oldref = parse_TSP_Reference(store[n][0].data);
        var newref = get_unique_msgid({ deps: [tmaref], location: deps[oldref].location, type: deps[oldref].type }, deps);
        numbers_del_oref(tmaroot, oldref);
        numbers_add_oref(tmaroot, newref);
        remap[oldref] = newref;
        var msg = numbers_iwa_find(cfb, deps, oldref);
        msg.id = newref;
        if (deps[oldref].location == deps[tmaref].location)
          arch.push(msg);
        else {
          deps[newref].location = deps[oldref].location.replace(oldref.toString(), newref.toString());
          if (deps[newref].location == deps[oldref].location)
            deps[newref].location = deps[newref].location.replace(/\.iwa/, "-".concat(newref, ".iwa"));
          CFB.utils.cfb_add(cfb, deps[newref].location, compress_iwa_file(write_iwa_file([msg])));
          var newloc = deps[newref].location.replace(/^Root Entry\//, "").replace(/^Index\//, "").replace(/\.iwa$/, "");
          numbers_iwa_doit(cfb, deps, 2, function(ai) {
            var mlist = parse_shallow(ai.messages[0].data);
            numbers_add_meta(mlist, newref, newloc);
            numbers_meta_add_dep(mlist, deps, tmaref, newref);
            ai.messages[0].data = write_shallow(mlist);
          });
        }
        store[n][0].data = write_TSP_Reference(newref);
      });
      var row_headers = parse_shallow(store[1][0].data);
      {
        (_b = row_headers[2]) == null ? void 0 : _b.forEach(function(tspref) {
          var oldref = parse_TSP_Reference(tspref.data);
          var newref = get_unique_msgid({ deps: [tmaref], location: deps[oldref].location, type: deps[oldref].type }, deps);
          numbers_del_oref(tmaroot, oldref);
          numbers_add_oref(tmaroot, newref);
          remap[oldref] = newref;
          var msg = numbers_iwa_find(cfb, deps, oldref);
          msg.id = newref;
          if (deps[oldref].location == deps[tmaref].location) {
            arch.push(msg);
          } else {
            deps[newref].location = deps[oldref].location.replace(oldref.toString(), newref.toString());
            if (deps[newref].location == deps[oldref].location)
              deps[newref].location = deps[newref].location.replace(/\.iwa/, "-".concat(newref, ".iwa"));
            CFB.utils.cfb_add(cfb, deps[newref].location, compress_iwa_file(write_iwa_file([msg])));
            var newloc = deps[newref].location.replace(/^Root Entry\//, "").replace(/^Index\//, "").replace(/\.iwa$/, "");
            numbers_iwa_doit(cfb, deps, 2, function(ai) {
              var mlist = parse_shallow(ai.messages[0].data);
              numbers_add_meta(mlist, newref, newloc);
              numbers_meta_add_dep(mlist, deps, tmaref, newref);
              ai.messages[0].data = write_shallow(mlist);
            });
          }
          tspref.data = write_TSP_Reference(newref);
        });
      }
      store[1][0].data = write_shallow(row_headers);
      var tiles = parse_shallow(store[3][0].data);
      {
        tiles[1].forEach(function(t) {
          var tst = parse_shallow(t.data);
          var oldtileref = parse_TSP_Reference(tst[2][0].data);
          var newtileref = remap[oldtileref];
          if (!remap[oldtileref]) {
            newtileref = get_unique_msgid({ deps: [tmaref], location: "", type: deps[oldtileref].type }, deps);
            deps[newtileref].location = "Root Entry/Index/Tables/Tile-".concat(newtileref, ".iwa");
            remap[oldtileref] = newtileref;
            var oldtile = numbers_iwa_find(cfb, deps, oldtileref);
            oldtile.id = newtileref;
            numbers_del_oref(tmaroot, oldtileref);
            numbers_add_oref(tmaroot, newtileref);
            CFB.utils.cfb_add(cfb, "/Index/Tables/Tile-".concat(newtileref, ".iwa"), compress_iwa_file(write_iwa_file([oldtile])));
            numbers_iwa_doit(cfb, deps, 2, function(ai) {
              var mlist = parse_shallow(ai.messages[0].data);
              mlist[3].push({ type: 2, data: write_shallow([
                [],
                [{ type: 0, data: write_varint49(newtileref) }],
                [{ type: 2, data: stru8("Tables/Tile") }],
                [{ type: 2, data: stru8("Tables/Tile-".concat(newtileref)) }],
                [{ type: 2, data: new Uint8Array([2, 0, 0]) }],
                [{ type: 2, data: new Uint8Array([2, 0, 0]) }],
                [],
                [],
                [],
                [],
                [{ type: 0, data: write_varint49(0) }],
                [],
                [{ type: 0, data: write_varint49(0) }]
              ]) });
              mlist[1] = [{ type: 0, data: write_varint49(Math.max(newtileref + 1, varint_to_i32(mlist[1][0].data))) }];
              numbers_meta_add_dep(mlist, deps, tmaref, newtileref);
              ai.messages[0].data = write_shallow(mlist);
            });
          }
          tst[2][0].data = write_TSP_Reference(newtileref);
          t.data = write_shallow(tst);
        });
      }
      store[3][0].data = write_shallow(tiles);
    }
    tma[4][0].data = write_shallow(store);
    tmaroot.messages[0].data = write_shallow(tma);
  });
}
function write_numbers_ws(cfb, deps, ws, wsname, sheetidx, rootref) {
  var drawables = [];
  numbers_iwa_doit(cfb, deps, rootref, function(docroot) {
    var sheetref = parse_shallow(docroot.messages[0].data);
    {
      sheetref[1] = [{ type: 2, data: stru8(wsname) }];
      drawables = mappa(sheetref[2], parse_TSP_Reference);
    }
    docroot.messages[0].data = write_shallow(sheetref);
  });
  var tia = numbers_iwa_find(cfb, deps, drawables[0]);
  var tmaref = parse_TSP_Reference(parse_shallow(tia.messages[0].data)[2][0].data);
  numbers_iwa_doit(cfb, deps, tmaref, function(docroot, x) {
    return write_numbers_tma(cfb, deps, ws, docroot, x, tmaref);
  });
}
var USE_WIDE_ROWS = true;
function write_numbers_tma(cfb, deps, ws, tmaroot, tmafile, tmaref) {
  if (!ws["!ref"])
    throw new Error("Cannot export empty sheet to NUMBERS");
  var range = decode_range(ws["!ref"]);
  range.s.r = range.s.c = 0;
  var trunc = false;
  if (range.e.c > 999) {
    trunc = true;
    range.e.c = 999;
  }
  if (range.e.r > 999999) {
    trunc = true;
    range.e.r = 999999;
  }
  if (trunc)
    console.error("Truncating to ".concat(encode_range(range)));
  var data = [];
  if (ws["!data"])
    data = ws["!data"];
  else {
    var colstr = [];
    for (var _C = 0; _C <= range.e.c; ++_C)
      colstr[_C] = encode_col(_C);
    for (var R_ = 0; R_ <= range.e.r; ++R_) {
      data[R_] = [];
      var _R = "" + (R_ + 1);
      for (_C = 0; _C <= range.e.c; ++_C) {
        var _cell = ws[colstr[_C] + _R];
        if (!_cell)
          continue;
        data[R_][_C] = _cell;
      }
    }
  }
  var LUT = {
    cmnt: [{ a: "~54ee77S~", t: "... the people who are crazy enough to think they can change the world, are the ones who do." }],
    ferr: [],
    fmla: [],
    nfmt: [],
    ofmt: [],
    rsst: [{ v: "~54ee77S~", l: "https://sheetjs.com/" }],
    sst: ["~Sh33tJ5~"]
  };
  var pb = parse_shallow(tmaroot.messages[0].data);
  {
    pb[6][0].data = write_varint49(range.e.r + 1);
    pb[7][0].data = write_varint49(range.e.c + 1);
    delete pb[46];
    var store = parse_shallow(pb[4][0].data);
    {
      var row_header_ref = parse_TSP_Reference(parse_shallow(store[1][0].data)[2][0].data);
      numbers_iwa_doit(cfb, deps, row_header_ref, function(rowhead, _x) {
        var _a;
        var base_bucket = parse_shallow(rowhead.messages[0].data);
        if ((_a = base_bucket == null ? void 0 : base_bucket[2]) == null ? void 0 : _a[0])
          for (var R2 = 0; R2 < data.length; ++R2) {
            var _bucket = parse_shallow(base_bucket[2][0].data);
            _bucket[1][0].data = write_varint49(R2);
            _bucket[4][0].data = write_varint49(data[R2].length);
            base_bucket[2][R2] = { type: base_bucket[2][0].type, data: write_shallow(_bucket) };
          }
        rowhead.messages[0].data = write_shallow(base_bucket);
      });
      var col_header_ref = parse_TSP_Reference(store[2][0].data);
      numbers_iwa_doit(cfb, deps, col_header_ref, function(colhead, _x) {
        var base_bucket = parse_shallow(colhead.messages[0].data);
        for (var C = 0; C <= range.e.c; ++C) {
          var _bucket = parse_shallow(base_bucket[2][0].data);
          _bucket[1][0].data = write_varint49(C);
          _bucket[4][0].data = write_varint49(range.e.r + 1);
          base_bucket[2][C] = { type: base_bucket[2][0].type, data: write_shallow(_bucket) };
        }
        colhead.messages[0].data = write_shallow(base_bucket);
      });
      var rbtree = parse_shallow(store[9][0].data);
      rbtree[1] = [];
      var tilestore = parse_shallow(store[3][0].data);
      {
        var tstride = 256;
        tilestore[2] = [{ type: 0, data: write_varint49(tstride) }];
        var tileref = parse_TSP_Reference(parse_shallow(tilestore[1][0].data)[2][0].data);
        var save_token = function() {
          var metadata = numbers_iwa_find(cfb, deps, 2);
          var mlist = parse_shallow(metadata.messages[0].data);
          var mlst = mlist[3].filter(function(m) {
            return varint_to_i32(parse_shallow(m.data)[1][0].data) == tileref;
          });
          return (mlst == null ? void 0 : mlst.length) ? varint_to_i32(parse_shallow(mlst[0].data)[12][0].data) : 0;
        }();
        {
          CFB.utils.cfb_del(cfb, deps[tileref].location);
          numbers_iwa_doit(cfb, deps, 2, function(ai) {
            var mlist = parse_shallow(ai.messages[0].data);
            mlist[3] = mlist[3].filter(function(m) {
              return varint_to_i32(parse_shallow(m.data)[1][0].data) != tileref;
            });
            numbers_meta_del_dep(mlist, deps, tmaref, tileref);
            ai.messages[0].data = write_shallow(mlist);
          });
          numbers_del_oref(tmaroot, tileref);
        }
        tilestore[1] = [];
        var ntiles = Math.ceil((range.e.r + 1) / tstride);
        for (var tidx = 0; tidx < ntiles; ++tidx) {
          var newtileid = get_unique_msgid({
            deps: [],
            location: "",
            type: 6002
          }, deps);
          deps[newtileid].location = "Root Entry/Index/Tables/Tile-".concat(newtileid, ".iwa");
          var tiledata = [
            [],
            [{ type: 0, data: write_varint49(0) }],
            [{ type: 0, data: write_varint49(Math.min(range.e.r + 1, (tidx + 1) * tstride)) }],
            [{ type: 0, data: write_varint49(0) }],
            [{ type: 0, data: write_varint49(Math.min((tidx + 1) * tstride, range.e.r + 1) - tidx * tstride) }],
            [],
            [{ type: 0, data: write_varint49(5) }],
            [{ type: 0, data: write_varint49(1) }],
            [{ type: 0, data: write_varint49(USE_WIDE_ROWS ? 1 : 0) }]
          ];
          for (var R = tidx * tstride; R <= Math.min(range.e.r, (tidx + 1) * tstride - 1); ++R) {
            var tilerow = write_TST_TileRowInfo(data[R], LUT, USE_WIDE_ROWS);
            tilerow[1][0].data = write_varint49(R - tidx * tstride);
            tiledata[5].push({ data: write_shallow(tilerow), type: 2 });
          }
          tilestore[1].push({ type: 2, data: write_shallow([
            [],
            [{ type: 0, data: write_varint49(tidx) }],
            [{ type: 2, data: write_TSP_Reference(newtileid) }]
          ]) });
          var newtile = {
            id: newtileid,
            messages: [write_iwam(6002, write_shallow(tiledata))]
          };
          var tilecontent = compress_iwa_file(write_iwa_file([newtile]));
          CFB.utils.cfb_add(cfb, "/Index/Tables/Tile-".concat(newtileid, ".iwa"), tilecontent);
          numbers_iwa_doit(cfb, deps, 2, function(ai) {
            var mlist = parse_shallow(ai.messages[0].data);
            mlist[3].push({ type: 2, data: write_shallow([
              [],
              [{ type: 0, data: write_varint49(newtileid) }],
              [{ type: 2, data: stru8("Tables/Tile") }],
              [{ type: 2, data: stru8("Tables/Tile-".concat(newtileid)) }],
              [{ type: 2, data: new Uint8Array([2, 0, 0]) }],
              [{ type: 2, data: new Uint8Array([2, 0, 0]) }],
              [],
              [],
              [],
              [],
              [{ type: 0, data: write_varint49(0) }],
              [],
              [{ type: 0, data: write_varint49(save_token) }]
            ]) });
            mlist[1] = [{ type: 0, data: write_varint49(Math.max(newtileid + 1, varint_to_i32(mlist[1][0].data))) }];
            numbers_meta_add_dep(mlist, deps, tmaref, newtileid);
            ai.messages[0].data = write_shallow(mlist);
          });
          numbers_add_oref(tmaroot, newtileid);
          rbtree[1].push({ type: 2, data: write_shallow([
            [],
            [{ type: 0, data: write_varint49(tidx * tstride) }],
            [{ type: 0, data: write_varint49(tidx) }]
          ]) });
        }
      }
      store[3][0].data = write_shallow(tilestore);
      store[9][0].data = write_shallow(rbtree);
      store[10] = [{ type: 2, data: new Uint8Array([]) }];
      if (ws["!merges"]) {
        var mergeid = get_unique_msgid({
          type: 6144,
          deps: [tmaref],
          location: deps[tmaref].location
        }, deps);
        tmafile.push({
          id: mergeid,
          messages: [write_iwam(6144, write_shallow([
            [],
            ws["!merges"].map(function(m) {
              return { type: 2, data: write_shallow([
                [],
                [{ type: 2, data: write_shallow([
                  [],
                  [{ type: 5, data: new Uint8Array(new Uint16Array([m.s.r, m.s.c]).buffer) }]
                ]) }],
                [{ type: 2, data: write_shallow([
                  [],
                  [{ type: 5, data: new Uint8Array(new Uint16Array([m.e.r - m.s.r + 1, m.e.c - m.s.c + 1]).buffer) }]
                ]) }]
              ]) };
            })
          ]))]
        });
        store[13] = [{ type: 2, data: write_TSP_Reference(mergeid) }];
        numbers_iwa_doit(cfb, deps, 2, function(ai) {
          var mlist = parse_shallow(ai.messages[0].data);
          numbers_meta_add_dep(mlist, deps, tmaref, mergeid);
          ai.messages[0].data = write_shallow(mlist);
        });
        numbers_add_oref(tmaroot, mergeid);
      } else
        delete store[13];
      var sstref = parse_TSP_Reference(store[4][0].data);
      numbers_iwa_doit(cfb, deps, sstref, function(sstroot) {
        var sstdata = parse_shallow(sstroot.messages[0].data);
        {
          sstdata[3] = [];
          LUT.sst.forEach(function(str, i) {
            if (i == 0)
              return;
            sstdata[3].push({ type: 2, data: write_shallow([
              [],
              [{ type: 0, data: write_varint49(i) }],
              [{ type: 0, data: write_varint49(1) }],
              [{ type: 2, data: stru8(str) }]
            ]) });
          });
        }
        sstroot.messages[0].data = write_shallow(sstdata);
      });
      var rsstref = parse_TSP_Reference(store[17][0].data);
      numbers_iwa_doit(cfb, deps, rsstref, function(rsstroot) {
        var rsstdata = parse_shallow(rsstroot.messages[0].data);
        rsstdata[3] = [];
        var style_indices = [
          904980,
          903835,
          903815,
          903845
        ];
        LUT.rsst.forEach(function(rsst, i) {
          if (i == 0)
            return;
          var tswpsa = [
            [],
            [{ type: 0, data: new Uint8Array([5]) }],
            [],
            [{ type: 2, data: stru8(rsst.v) }]
          ];
          tswpsa[10] = [{ type: 0, data: new Uint8Array([1]) }];
          tswpsa[19] = [{ type: 2, data: new Uint8Array([10, 6, 8, 0, 18, 2, 101, 110]) }];
          tswpsa[5] = [{ type: 2, data: new Uint8Array([10, 8, 8, 0, 18, 4, 8, 155, 149, 55]) }];
          tswpsa[2] = [{ type: 2, data: new Uint8Array([8, 148, 158, 55]) }];
          tswpsa[6] = [{ type: 2, data: new Uint8Array([10, 6, 8, 0, 16, 0, 24, 0]) }];
          tswpsa[7] = [{ type: 2, data: new Uint8Array([10, 8, 8, 0, 18, 4, 8, 135, 149, 55]) }];
          tswpsa[8] = [{ type: 2, data: new Uint8Array([10, 8, 8, 0, 18, 4, 8, 165, 149, 55]) }];
          tswpsa[14] = [{ type: 2, data: new Uint8Array([10, 6, 8, 0, 16, 0, 24, 0]) }];
          tswpsa[24] = [{ type: 2, data: new Uint8Array([10, 6, 8, 0, 16, 0, 24, 0]) }];
          var tswpsaid = get_unique_msgid({ deps: [], location: "", type: 2001 }, deps);
          var tswpsarefs = [];
          if (rsst.l) {
            var newhlinkid = numbers_add_msg(cfb, 2032, [
              [],
              [],
              [{ type: 2, data: stru8(rsst.l) }]
            ], "/Index/Tables/DataList", deps);
            tswpsa[11] = [];
            var smartfield = [[], []];
            if (!smartfield[1])
              smartfield[1] = [];
            smartfield[1].push({ type: 2, data: write_shallow([
              [],
              [{ type: 0, data: write_varint49(0) }],
              [{ type: 2, data: write_TSP_Reference(newhlinkid) }]
            ]) });
            tswpsa[11][0] = { type: 2, data: write_shallow(smartfield) };
            tswpsarefs.push(newhlinkid);
          }
          numbers_add_msg(cfb, 2001, tswpsa, "/Index/Tables/DataList", deps, tswpsaid);
          numbers_iwa_doit(cfb, deps, tswpsaid, function(iwa) {
            style_indices.forEach(function(ref) {
              return numbers_add_oref(iwa, ref);
            });
            tswpsarefs.forEach(function(ref) {
              return numbers_add_oref(iwa, ref);
            });
          });
          var rtpaid = numbers_add_msg(cfb, 6218, [
            [],
            [{ type: 2, data: write_TSP_Reference(tswpsaid) }],
            [],
            [{ type: 2, data: new Uint8Array([13, 255, 255, 255, 0, 18, 10, 16, 255, 255, 1, 24, 255, 255, 255, 255, 7]) }]
          ], "/Index/Tables/DataList", deps);
          numbers_iwa_doit(cfb, deps, rtpaid, function(iwa) {
            return numbers_add_oref(iwa, tswpsaid);
          });
          rsstdata[3].push({ type: 2, data: write_shallow([
            [],
            [{ type: 0, data: write_varint49(i) }],
            [{ type: 0, data: write_varint49(1) }],
            [],
            [],
            [],
            [],
            [],
            [],
            [{ type: 2, data: write_TSP_Reference(rtpaid) }]
          ]) });
          numbers_add_oref(rsstroot, rtpaid);
          numbers_iwa_doit(cfb, deps, 2, function(ai) {
            var mlist = parse_shallow(ai.messages[0].data);
            numbers_meta_add_dep(mlist, deps, rsstref, rtpaid);
            numbers_meta_add_dep(mlist, deps, rtpaid, tswpsaid);
            numbers_meta_add_dep(mlist, deps, tswpsaid, tswpsarefs);
            numbers_meta_add_dep(mlist, deps, tswpsaid, style_indices);
            ai.messages[0].data = write_shallow(mlist);
          });
        });
        rsstroot.messages[0].data = write_shallow(rsstdata);
      });
      if (LUT.cmnt.length > 1) {
        var cmntref = parse_TSP_Reference(store[19][0].data);
        var authors = {}, iauthor = 0;
        numbers_iwa_doit(cfb, deps, cmntref, function(cmntroot) {
          var cmntdata = parse_shallow(cmntroot.messages[0].data);
          {
            cmntdata[3] = [];
            LUT.cmnt.forEach(function(cc, i) {
              if (i == 0)
                return;
              var replies = [];
              if (cc.replies)
                cc.replies.forEach(function(c) {
                  if (!authors[c.a || ""])
                    authors[c.a || ""] = numbers_add_msg(cfb, 212, [
                      [],
                      [{ type: 2, data: stru8(c.a || "") }],
                      [{ type: 2, data: get_author_color(++iauthor) }],
                      [],
                      [{ type: 0, data: write_varint49(0) }]
                    ], "/Index/Tables/DataList", deps);
                  var aaaid2 = authors[c.a || ""];
                  var csaid2 = numbers_add_msg(cfb, 3056, [
                    [],
                    [{ type: 2, data: stru8(c.t || "") }],
                    [{ type: 2, data: write_shallow([
                      [],
                      [{ type: 1, data: new Uint8Array([0, 0, 0, 128, 116, 109, 182, 65]) }]
                    ]) }],
                    [{ type: 2, data: write_TSP_Reference(aaaid2) }]
                  ], "/Index/Tables/DataList", deps);
                  numbers_iwa_doit(cfb, deps, csaid2, function(iwa) {
                    return numbers_add_oref(iwa, aaaid2);
                  });
                  replies.push(csaid2);
                  numbers_iwa_doit(cfb, deps, 2, function(ai) {
                    var mlist = parse_shallow(ai.messages[0].data);
                    numbers_meta_add_dep(mlist, deps, csaid2, aaaid2);
                    ai.messages[0].data = write_shallow(mlist);
                  });
                });
              if (!authors[cc.a || ""])
                authors[cc.a || ""] = numbers_add_msg(cfb, 212, [
                  [],
                  [{ type: 2, data: stru8(cc.a || "") }],
                  [{ type: 2, data: get_author_color(++iauthor) }],
                  [],
                  [{ type: 0, data: write_varint49(0) }]
                ], "/Index/Tables/DataList", deps);
              var aaaid = authors[cc.a || ""];
              var csaid = numbers_add_msg(cfb, 3056, [
                [],
                [{ type: 2, data: stru8(cc.t || "") }],
                [{ type: 2, data: write_shallow([
                  [],
                  [{ type: 1, data: new Uint8Array([0, 0, 0, 128, 116, 109, 182, 65]) }]
                ]) }],
                [{ type: 2, data: write_TSP_Reference(aaaid) }],
                replies.map(function(r) {
                  return { type: 2, data: write_TSP_Reference(r) };
                }),
                [{ type: 2, data: write_shallow([
                  [],
                  [{ type: 0, data: write_varint49(i) }],
                  [{ type: 0, data: write_varint49(0) }]
                ]) }]
              ], "/Index/Tables/DataList", deps);
              numbers_iwa_doit(cfb, deps, csaid, function(iwa) {
                numbers_add_oref(iwa, aaaid);
                replies.forEach(function(r) {
                  return numbers_add_oref(iwa, r);
                });
              });
              cmntdata[3].push({ type: 2, data: write_shallow([
                [],
                [{ type: 0, data: write_varint49(i) }],
                [{ type: 0, data: write_varint49(1) }],
                [],
                [],
                [],
                [],
                [],
                [],
                [],
                [{ type: 2, data: write_TSP_Reference(csaid) }]
              ]) });
              numbers_add_oref(cmntroot, csaid);
              numbers_iwa_doit(cfb, deps, 2, function(ai) {
                var mlist = parse_shallow(ai.messages[0].data);
                numbers_meta_add_dep(mlist, deps, cmntref, csaid);
                numbers_meta_add_dep(mlist, deps, csaid, aaaid);
                if (replies.length)
                  numbers_meta_add_dep(mlist, deps, csaid, replies);
                ai.messages[0].data = write_shallow(mlist);
              });
            });
          }
          cmntdata[2][0].data = write_varint49(LUT.cmnt.length + 1);
          cmntroot.messages[0].data = write_shallow(cmntdata);
        });
      }
    }
    pb[4][0].data = write_shallow(store);
  }
  tmaroot.messages[0].data = write_shallow(pb);
}
function fix_opts_func(defaults) {
	return function fix_opts(opts) {
		for(var i = 0; i != defaults.length; ++i) {
			var d = defaults[i];
			if(opts[d[0]] === undefined) opts[d[0]] = d[1];
			if(d[2] === 'n') opts[d[0]] = Number(opts[d[0]]);
		}
	};
}

function fix_read_opts(opts) {
fix_opts_func([
	['cellNF', false], /* emit cell number format string as .z */
	['cellHTML', true], /* emit html string as .h */
	['cellFormula', true], /* emit formulae as .f */
	['cellStyles', false], /* emits style/theme as .s */
	['cellText', true], /* emit formatted text as .w */
	['cellDates', false], /* emit date cells with type `d` */

	['sheetStubs', false], /* emit empty cells */
	['sheetRows', 0, 'n'], /* read n rows (0 = read all rows) */

	['bookDeps', false], /* parse calculation chains */
	['bookSheets', false], /* only try to get sheet names (no Sheets) */
	['bookProps', false], /* only try to get properties (no Sheets) */
	['bookFiles', false], /* include raw file structure (keys, files, cfb) */
	['bookVBA', false], /* include vba raw data (vbaraw) */

	['password',''], /* password */
	['WTF', false] /* WTF mode (throws errors) */
])(opts);
}

function fix_write_opts(opts) {
fix_opts_func([
	['cellDates', false], /* write date cells with type `d` */

	['bookSST', false], /* Generate Shared String Table */

	['bookType', 'xlsx'], /* Type of workbook (xlsx/m/b) */

	['compression', false], /* Use file compression */

	['WTF', false] /* WTF mode (throws errors) */
])(opts);
}
function get_sheet_type(n) {
	if(RELS.WS.indexOf(n) > -1) return "sheet";
	if(RELS.CS && n == RELS.CS) return "chart";
	if(RELS.DS && n == RELS.DS) return "dialog";
	if(RELS.MS && n == RELS.MS) return "macro";
	return (n && n.length) ? n : "sheet";
}
function safe_parse_wbrels(wbrels, sheets) {
	if(!wbrels) return 0;
	try {
		wbrels = sheets.map(function pwbr(w) { if(!w.id) w.id = w.strRelID; return [w.name, wbrels['!id'][w.id].Target, get_sheet_type(wbrels['!id'][w.id].Type)]; });
	} catch(e) { return null; }
	return !wbrels || wbrels.length === 0 ? null : wbrels;
}

function parse_sheet_legacy_drawing(sheet, type, zip, path, idx, opts, wb, comments) {
	if(!sheet || !sheet['!legdrawel']) return;
	var dfile = resolve_path(sheet['!legdrawel'].Target, path);
	var draw = getzipstr(zip, dfile, true);
	if(draw) parse_vml(utf8read(draw), sheet, comments||[]);
}

function safe_parse_sheet(zip, path, relsPath, sheet, idx, sheetRels, sheets, stype, opts, wb, themes, styles) {
	try {
		sheetRels[sheet]=parse_rels(getzipstr(zip, relsPath, true), path);
		var data = getzipdata(zip, path);
		var _ws;
		switch(stype) {
			case 'sheet':  _ws = parse_ws(data, path, idx, opts, sheetRels[sheet], wb, themes, styles); break;
			case 'chart':  _ws = parse_cs(data, path, idx, opts, sheetRels[sheet], wb, themes, styles);
				if(!_ws || !_ws['!drawel']) break;
				var dfile = resolve_path(_ws['!drawel'].Target, path);
				var drelsp = get_rels_path(dfile);
				var draw = parse_drawing(getzipstr(zip, dfile, true), parse_rels(getzipstr(zip, drelsp, true), dfile));
				var chartp = resolve_path(draw, dfile);
				var crelsp = get_rels_path(chartp);
				_ws = parse_chart(getzipstr(zip, chartp, true), chartp, opts, parse_rels(getzipstr(zip, crelsp, true), chartp), wb, _ws);
				break;
			case 'macro':  _ws = parse_ms(data, path, idx, opts, sheetRels[sheet], wb, themes, styles); break;
			case 'dialog': _ws = parse_ds(data, path, idx, opts, sheetRels[sheet], wb, themes, styles); break;
			default: throw new Error("Unrecognized sheet type " + stype);
		}
		sheets[sheet] = _ws;

		/* scan rels for comments and threaded comments */
		var comments = [], tcomments = [];
		if(sheetRels && sheetRels[sheet]) keys(sheetRels[sheet]).forEach(function(n) {
			var dfile = "";
			if(sheetRels[sheet][n].Type == RELS.CMNT) {
				dfile = resolve_path(sheetRels[sheet][n].Target, path);
				comments = parse_cmnt(getzipdata(zip, dfile, true), dfile, opts);
				if(!comments || !comments.length) return;
				sheet_insert_comments(_ws, comments, false);
			}
			if(sheetRels[sheet][n].Type == RELS.TCMNT) {
				dfile = resolve_path(sheetRels[sheet][n].Target, path);
				tcomments = tcomments.concat(parse_tcmnt_xml(getzipdata(zip, dfile, true), opts));
			}
		});
		if(tcomments && tcomments.length) sheet_insert_comments(_ws, tcomments, true, opts.people || []);
		parse_sheet_legacy_drawing(_ws, stype, zip, path, idx, opts, wb, comments);
	} catch(e) { if(opts.WTF) throw e; }
}

function strip_front_slash(x) { return x.charAt(0) == '/' ? x.slice(1) : x; }

function parse_zip(zip, opts) {
	make_ssf();
	opts = opts || {};
	fix_read_opts(opts);

	/* OpenDocument Part 3 Section 2.2.1 OpenDocument Package */
	if(safegetzipfile(zip, 'META-INF/manifest.xml')) return parse_ods(zip, opts);
	/* UOC */
	if(safegetzipfile(zip, 'objectdata.xml')) return parse_ods(zip, opts);
	/* Numbers */
	if(safegetzipfile(zip, 'Index/Document.iwa')) {
		if(typeof Uint8Array == "undefined") throw new Error('NUMBERS file parsing requires Uint8Array support');
		if(typeof parse_numbers_iwa != "undefined") {
			if(zip.FileIndex) return parse_numbers_iwa(zip, opts);
			var _zip = CFB.utils.cfb_new();
			zipentries(zip).forEach(function(e) { zip_add_file(_zip, e, getzipbin(zip, e)); });
			return parse_numbers_iwa(_zip, opts);
		}
		throw new Error('Unsupported NUMBERS file');
	}
	if(!safegetzipfile(zip, '[Content_Types].xml')) {
		if(safegetzipfile(zip, 'index.xml.gz')) throw new Error('Unsupported NUMBERS 08 file');
		if(safegetzipfile(zip, 'index.xml')) throw new Error('Unsupported NUMBERS 09 file');
		var index_zip = CFB.find(zip, 'Index.zip');
		if(index_zip) {
			opts = dup(opts);
			delete opts.type;
			if(typeof index_zip.content == "string") opts.type = "binary";
			// TODO: Bun buffer bug
			if(typeof Bun !== "undefined" && Buffer.isBuffer(index_zip.content)) return readSync(new Uint8Array(index_zip.content), opts);
			return readSync(index_zip.content, opts);
		}
		throw new Error('Unsupported ZIP file');
	}

	var entries = zipentries(zip);
	var dir = parse_ct((getzipstr(zip, '[Content_Types].xml')));
	var xlsb = false;
	var sheets, binname;
	if(dir.workbooks.length === 0) {
		binname = "xl/workbook.xml";
		if(getzipdata(zip,binname, true)) dir.workbooks.push(binname);
	}
	if(dir.workbooks.length === 0) {
		binname = "xl/workbook.bin";
		if(!getzipdata(zip,binname,true)) throw new Error("Could not find workbook");
		dir.workbooks.push(binname);
		xlsb = true;
	}
	if(dir.workbooks[0].slice(-3) == "bin") xlsb = true;

	var themes = ({});
	var styles = ({});
	if(!opts.bookSheets && !opts.bookProps) {
		strs = [];
		if(dir.sst) try { strs=parse_sst(getzipdata(zip, strip_front_slash(dir.sst)), dir.sst, opts); } catch(e) { if(opts.WTF) throw e; }

		if(opts.cellStyles && dir.themes.length) themes = parse_theme_xml(getzipstr(zip, dir.themes[0].replace(/^\//,''), true)||"", opts);

		if(dir.style) styles = parse_sty(getzipdata(zip, strip_front_slash(dir.style)), dir.style, themes, opts);
	}

	/*var externbooks = */dir.links.map(function(link) {
		try {
			var rels = parse_rels(getzipstr(zip, get_rels_path(strip_front_slash(link))), link);
			return parse_xlink(getzipdata(zip, strip_front_slash(link)), rels, link, opts);
		} catch(e) {}
	});

	var wb = parse_wb(getzipdata(zip, strip_front_slash(dir.workbooks[0])), dir.workbooks[0], opts);

	var props = {}, propdata = "";

	if(dir.coreprops.length) {
		propdata = getzipdata(zip, strip_front_slash(dir.coreprops[0]), true);
		if(propdata) props = parse_core_props(propdata);
		if(dir.extprops.length !== 0) {
			propdata = getzipdata(zip, strip_front_slash(dir.extprops[0]), true);
			if(propdata) parse_ext_props(propdata, props, opts);
		}
	}

	var custprops = {};
	if(!opts.bookSheets || opts.bookProps) {
		if (dir.custprops.length !== 0) {
			propdata = getzipstr(zip, strip_front_slash(dir.custprops[0]), true);
			if(propdata) custprops = parse_cust_props(propdata, opts);
		}
	}

	var out = ({});
	if(opts.bookSheets || opts.bookProps) {
		if(wb.Sheets) sheets = wb.Sheets.map(function pluck(x){ return x.name; });
		else if(props.Worksheets && props.SheetNames.length > 0) sheets=props.SheetNames;
		if(opts.bookProps) { out.Props = props; out.Custprops = custprops; }
		if(opts.bookSheets && typeof sheets !== 'undefined') out.SheetNames = sheets;
		if(opts.bookSheets ? out.SheetNames : opts.bookProps) return out;
	}
	sheets = {};

	var deps = {};
	if(opts.bookDeps && dir.calcchain) deps=parse_cc(getzipdata(zip, strip_front_slash(dir.calcchain)),dir.calcchain,opts);

	var i=0;
	var sheetRels = ({});
	var path, relsPath;

	{
		var wbsheets = wb.Sheets;
		props.Worksheets = wbsheets.length;
		props.SheetNames = [];
		for(var j = 0; j != wbsheets.length; ++j) {
			props.SheetNames[j] = wbsheets[j].name;
		}
	}

	var wbext = xlsb ? "bin" : "xml";
	var wbrelsi = dir.workbooks[0].lastIndexOf("/");
	var wbrelsfile = (dir.workbooks[0].slice(0, wbrelsi+1) + "_rels/" + dir.workbooks[0].slice(wbrelsi+1) + ".rels").replace(/^\//,"");
	if(!safegetzipfile(zip, wbrelsfile)) wbrelsfile = 'xl/_rels/workbook.' + wbext + '.rels';
	var wbrels = parse_rels(getzipstr(zip, wbrelsfile, true), wbrelsfile.replace(/_rels.*/, "s5s"));

	if((dir.metadata || []).length >= 1) {
		/* TODO: MDX and other types of metadata */
		opts.xlmeta = parse_xlmeta(getzipdata(zip, strip_front_slash(dir.metadata[0])),dir.metadata[0],opts);
	}

	if((dir.people || []).length >= 1) {
		opts.people = parse_people_xml(getzipdata(zip, strip_front_slash(dir.people[0])),opts);
	}

	if(wbrels) wbrels = safe_parse_wbrels(wbrels, wb.Sheets);

	/* Numbers iOS hack */
	var nmode = (getzipdata(zip,"xl/worksheets/sheet.xml",true))?1:0;
	wsloop: for(i = 0; i != props.Worksheets; ++i) {
		var stype = "sheet";
		if(wbrels && wbrels[i]) {
			path = 'xl/' + (wbrels[i][1]).replace(/[\/]?xl\//, "");
			if(!safegetzipfile(zip, path)) path = wbrels[i][1];
			if(!safegetzipfile(zip, path)) path = wbrelsfile.replace(/_rels\/[\S\s]*$/,"") + wbrels[i][1];
			stype = wbrels[i][2];
		} else {
			path = 'xl/worksheets/sheet'+(i+1-nmode)+"." + wbext;
			path = path.replace(/sheet0\./,"sheet.");
		}
		relsPath = path.replace(/^(.*)(\/)([^\/]*)$/, "$1/_rels/$3.rels");
		if(opts && opts.sheets != null) switch(typeof opts.sheets) {
			case "number": if(i != opts.sheets) continue wsloop; break;
			case "string": if(props.SheetNames[i].toLowerCase() != opts.sheets.toLowerCase()) continue wsloop; break;
			default: if(Array.isArray && Array.isArray(opts.sheets)) {
				var snjseen = false;
				for(var snj = 0; snj != opts.sheets.length; ++snj) {
					if(typeof opts.sheets[snj] == "number" && opts.sheets[snj] == i) snjseen=1;
					if(typeof opts.sheets[snj] == "string" && opts.sheets[snj].toLowerCase() == props.SheetNames[i].toLowerCase()) snjseen = 1;
				}
				if(!snjseen) continue wsloop;
			}
		}
		safe_parse_sheet(zip, path, relsPath, props.SheetNames[i], i, sheetRels, sheets, stype, opts, wb, themes, styles);
	}

	out = ({
		Directory: dir,
		Workbook: wb,
		Props: props,
		Custprops: custprops,
		Deps: deps,
		Sheets: sheets,
		SheetNames: props.SheetNames,
		Strings: strs,
		Styles: styles,
		Themes: themes,
		SSF: dup(table_fmt)
	});
	if(opts && opts.bookFiles) {
		if(zip.files) {
			out.keys = entries;
			out.files = zip.files;
		} else {
			out.keys = [];
			out.files = {};
			zip.FullPaths.forEach(function(p, idx) {
				p = p.replace(/^Root Entry[\/]/, "");
				out.keys.push(p);
				out.files[p] = zip.FileIndex[idx];
			});
		}
	}
	if(opts && opts.bookVBA) {
		if(dir.vba.length > 0) out.vbaraw = getzipdata(zip,strip_front_slash(dir.vba[0]),true);
		else if(dir.defaults && dir.defaults.bin === CT_VBA) out.vbaraw = getzipdata(zip, 'xl/vbaProject.bin',true);
	}
	// TODO: pass back content types metadata for xlsm/xlsx resolution
	out.bookType = xlsb ? "xlsb" : "xlsx";
	return out;
}

/* [MS-OFFCRYPTO] 2.1.1 */
function parse_xlsxcfb(cfb, _opts) {
	var opts = _opts || {};
	var f = 'Workbook', data = CFB.find(cfb, f);
	try {
	f = '/!DataSpaces/Version';
	data = CFB.find(cfb, f); if(!data || !data.content) throw new Error("ECMA-376 Encrypted file missing " + f);
	/*var version = */parse_DataSpaceVersionInfo(data.content);

	/* 2.3.4.1 */
	f = '/!DataSpaces/DataSpaceMap';
	data = CFB.find(cfb, f); if(!data || !data.content) throw new Error("ECMA-376 Encrypted file missing " + f);
	var dsm = parse_DataSpaceMap(data.content);
	if(dsm.length !== 1 || dsm[0].comps.length !== 1 || dsm[0].comps[0].t !== 0 || dsm[0].name !== "StrongEncryptionDataSpace" || dsm[0].comps[0].v !== "EncryptedPackage")
		throw new Error("ECMA-376 Encrypted file bad " + f);

	/* 2.3.4.2 */
	f = '/!DataSpaces/DataSpaceInfo/StrongEncryptionDataSpace';
	data = CFB.find(cfb, f); if(!data || !data.content) throw new Error("ECMA-376 Encrypted file missing " + f);
	var seds = parse_DataSpaceDefinition(data.content);
	if(seds.length != 1 || seds[0] != "StrongEncryptionTransform")
		throw new Error("ECMA-376 Encrypted file bad " + f);

	/* 2.3.4.3 */
	f = '/!DataSpaces/TransformInfo/StrongEncryptionTransform/!Primary';
	data = CFB.find(cfb, f); if(!data || !data.content) throw new Error("ECMA-376 Encrypted file missing " + f);
	/*var hdr = */parse_Primary(data.content);
	} catch(e) {}

	f = '/EncryptionInfo';
	data = CFB.find(cfb, f); if(!data || !data.content) throw new Error("ECMA-376 Encrypted file missing " + f);
	var einfo = parse_EncryptionInfo(data.content);

	/* 2.3.4.4 */
	f = '/EncryptedPackage';
	data = CFB.find(cfb, f); if(!data || !data.content) throw new Error("ECMA-376 Encrypted file missing " + f);

/*global decrypt_agile */
if(einfo[0] == 0x04 && typeof decrypt_agile !== 'undefined') return decrypt_agile(einfo[1], data.content, opts.password || "", opts);
/*global decrypt_std76 */
if(einfo[0] == 0x02 && typeof decrypt_std76 !== 'undefined') return decrypt_std76(einfo[1], data.content, opts.password || "", opts);
	throw new Error("File is password-protected");
}

function write_zip_xlsb(wb, opts) {
	if(wb && !wb.SSF) {
		wb.SSF = dup(table_fmt);
	}
	if(wb && wb.SSF) {
		make_ssf(); SSF_load_table(wb.SSF);
		// $FlowIgnore
		opts.revssf = evert_num(wb.SSF); opts.revssf[wb.SSF[65535]] = 0;
		opts.ssf = wb.SSF;
	}
	opts.rels = {}; opts.wbrels = {};
	opts.Strings = []; opts.Strings.Count = 0; opts.Strings.Unique = 0;
	if(browser_has_Map) opts.revStrings = new Map();
	else { opts.revStrings = {}; opts.revStrings.foo = []; delete opts.revStrings.foo; }
	var wbext = "bin";
	var vbafmt = true;
	var ct = new_ct();
	fix_write_opts(opts = opts || {});
	var zip = zip_new();
	var f = "", rId = 0;

	opts.cellXfs = [];
	get_cell_style(opts.cellXfs, {}, {revssf:{"General":0}});

	if(!wb.Props) wb.Props = {};

	f = "docProps/core.xml";
	zip_add_file(zip, f, write_core_props(wb.Props, opts));
	ct.coreprops.push(f);
	add_rels(opts.rels, 2, f, RELS.CORE_PROPS);

f = "docProps/app.xml";
	if(wb.Props && wb.Props.SheetNames){/* empty */}
	else if(!wb.Workbook || !wb.Workbook.Sheets) wb.Props.SheetNames = wb.SheetNames;
	else {
		var _sn = [];
		for(var _i = 0; _i < wb.SheetNames.length; ++_i)
			if((wb.Workbook.Sheets[_i]||{}).Hidden != 2) _sn.push(wb.SheetNames[_i]);
		wb.Props.SheetNames = _sn;
	}
	wb.Props.Worksheets = wb.Props.SheetNames.length;
	zip_add_file(zip, f, write_ext_props(wb.Props, opts));
	ct.extprops.push(f);
	add_rels(opts.rels, 3, f, RELS.EXT_PROPS);

	if(wb.Custprops !== wb.Props && keys(wb.Custprops||{}).length > 0) {
		f = "docProps/custom.xml";
		zip_add_file(zip, f, write_cust_props(wb.Custprops, opts));
		ct.custprops.push(f);
		add_rels(opts.rels, 4, f, RELS.CUST_PROPS);
	}

	var people = ["SheetJ5"];
	opts.tcid = 0;

	for(rId=1;rId <= wb.SheetNames.length; ++rId) {
		var wsrels = {'!id':{}};
		var ws = wb.Sheets[wb.SheetNames[rId-1]];
		var _type = (ws || {})["!type"] || "sheet";
		switch(_type) {
		case "chart":
			/* falls through */
		default:
			f = "xl/worksheets/sheet" + rId + "." + wbext;
			zip_add_file(zip, f, write_ws_bin(rId-1, opts, wb, wsrels));
			ct.sheets.push(f);
			add_rels(opts.wbrels, -1, "worksheets/sheet" + rId + "." + wbext, RELS.WS[0]);
		}

		if(ws) {
			var comments = ws['!comments'];
			var need_vml = false;
			var cf = "";
			if(comments && comments.length > 0) {
				var needtc = false;
				comments.forEach(function(carr) {
					carr[1].forEach(function(c) { if(c.T == true) needtc = true; });
				});
				if(needtc) {
					cf = "xl/threadedComments/threadedComment" + rId + ".xml";
					zip_add_file(zip, cf, write_tcmnt_xml(comments, people, opts));
					ct.threadedcomments.push(cf);
					add_rels(wsrels, -1, "../threadedComments/threadedComment" + rId + ".xml", RELS.TCMNT);
				}

				cf = "xl/comments" + rId + "." + wbext;
				zip_add_file(zip, cf, write_comments_bin(comments, opts));
				ct.comments.push(cf);
				add_rels(wsrels, -1, "../comments" + rId + "." + wbext, RELS.CMNT);
				need_vml = true;
			}
			if(ws['!legacy']) {
				if(need_vml) zip_add_file(zip, "xl/drawings/vmlDrawing" + (rId) + ".vml", write_vml(rId, ws['!comments']));
			}
			delete ws['!comments'];
			delete ws['!legacy'];
		}

		if(wsrels['!id'].rId1) zip_add_file(zip, get_rels_path(f), write_rels(wsrels));
	}

	if(opts.Strings != null && opts.Strings.length > 0) {
		f = "xl/sharedStrings." + wbext;
		zip_add_file(zip, f, write_sst_bin(opts.Strings, opts));
		ct.strs.push(f);
		add_rels(opts.wbrels, -1, "sharedStrings." + wbext, RELS.SST);
	}

	f = "xl/workbook." + wbext;
	zip_add_file(zip, f, write_wb_bin(wb, opts));
	ct.workbooks.push(f);
	add_rels(opts.rels, 1, f, RELS.WB);

	/* TODO: something more intelligent with themes */

	f = "xl/theme/theme1.xml";
	var ww = write_theme(wb.Themes, opts);
	zip_add_file(zip, f, ww);
	ct.themes.push(f);
	add_rels(opts.wbrels, -1, "theme/theme1.xml", RELS.THEME);

	/* TODO: something more intelligent with styles */

	f = "xl/styles." + wbext;
	zip_add_file(zip, f, write_sty_bin(wb, opts));
	ct.styles.push(f);
	add_rels(opts.wbrels, -1, "styles." + wbext, RELS.STY);

	if(wb.vbaraw && vbafmt) {
		f = "xl/vbaProject.bin";
		zip_add_file(zip, f, wb.vbaraw);
		ct.vba.push(f);
		add_rels(opts.wbrels, -1, "vbaProject.bin", RELS.VBA);
	}

	f = "xl/metadata." + wbext;
	zip_add_file(zip, f, write_xlmeta_bin());
	ct.metadata.push(f);
	add_rels(opts.wbrels, -1, "metadata." + wbext, RELS.XLMETA);

	if(people.length > 1) {
		f = "xl/persons/person.xml";
		zip_add_file(zip, f, write_people_xml(people, opts));
		ct.people.push(f);
		add_rels(opts.wbrels, -1, "persons/person.xml", RELS.PEOPLE);
	}

	zip_add_file(zip, "[Content_Types].xml", write_ct(ct, opts));
	zip_add_file(zip, '_rels/.rels', write_rels(opts.rels));
	zip_add_file(zip, 'xl/_rels/workbook.' + wbext + '.rels', write_rels(opts.wbrels));

	delete opts.revssf; delete opts.ssf;
	return zip;
}

function write_zip_xlsx(wb, opts) {
	if(wb && !wb.SSF) {
		wb.SSF = dup(table_fmt);
	}
	if(wb && wb.SSF) {
		make_ssf(); SSF_load_table(wb.SSF);
		// $FlowIgnore
		opts.revssf = evert_num(wb.SSF); opts.revssf[wb.SSF[65535]] = 0;
		opts.ssf = wb.SSF;
	}
	opts.rels = {}; opts.wbrels = {};
	opts.Strings = []; opts.Strings.Count = 0; opts.Strings.Unique = 0;
	if(browser_has_Map) opts.revStrings = new Map();
	else { opts.revStrings = {}; opts.revStrings.foo = []; delete opts.revStrings.foo; }
	var wbext = "xml";
	var vbafmt = VBAFMTS.indexOf(opts.bookType) > -1;
	var ct = new_ct();
	fix_write_opts(opts = opts || {});
	var zip = zip_new();
	var f = "", rId = 0;

	opts.cellXfs = [];
	get_cell_style(opts.cellXfs, {}, {revssf:{"General":0}});

	if(!wb.Props) wb.Props = {};

	f = "docProps/core.xml";
	zip_add_file(zip, f, write_core_props(wb.Props, opts));
	ct.coreprops.push(f);
	add_rels(opts.rels, 2, f, RELS.CORE_PROPS);

f = "docProps/app.xml";
	if(wb.Props && wb.Props.SheetNames){/* empty */}
	else if(!wb.Workbook || !wb.Workbook.Sheets) wb.Props.SheetNames = wb.SheetNames;
	else {
		var _sn = [];
		for(var _i = 0; _i < wb.SheetNames.length; ++_i)
			if((wb.Workbook.Sheets[_i]||{}).Hidden != 2) _sn.push(wb.SheetNames[_i]);
		wb.Props.SheetNames = _sn;
	}
	wb.Props.Worksheets = wb.Props.SheetNames.length;
	zip_add_file(zip, f, write_ext_props(wb.Props, opts));
	ct.extprops.push(f);
	add_rels(opts.rels, 3, f, RELS.EXT_PROPS);

	if(wb.Custprops !== wb.Props && keys(wb.Custprops||{}).length > 0) {
		f = "docProps/custom.xml";
		zip_add_file(zip, f, write_cust_props(wb.Custprops, opts));
		ct.custprops.push(f);
		add_rels(opts.rels, 4, f, RELS.CUST_PROPS);
	}

	var people = ["SheetJ5"];
	opts.tcid = 0;

	for(rId=1;rId <= wb.SheetNames.length; ++rId) {
		var wsrels = {'!id':{}};
		var ws = wb.Sheets[wb.SheetNames[rId-1]];
		var _type = (ws || {})["!type"] || "sheet";
		switch(_type) {
		case "chart":
			/* falls through */
		default:
			f = "xl/worksheets/sheet" + rId + "." + wbext;
			zip_add_file(zip, f, write_ws_xml(rId-1, opts, wb, wsrels));
			ct.sheets.push(f);
			add_rels(opts.wbrels, -1, "worksheets/sheet" + rId + "." + wbext, RELS.WS[0]);
		}

		if(ws) {
			var comments = ws['!comments'];
			var need_vml = false;
			var cf = "";
			if(comments && comments.length > 0) {
				var needtc = false;
				comments.forEach(function(carr) {
					carr[1].forEach(function(c) { if(c.T == true) needtc = true; });
				});
				if(needtc) {
					cf = "xl/threadedComments/threadedComment" + rId + ".xml";
					zip_add_file(zip, cf, write_tcmnt_xml(comments, people, opts));
					ct.threadedcomments.push(cf);
					add_rels(wsrels, -1, "../threadedComments/threadedComment" + rId + ".xml", RELS.TCMNT);
				}

				cf = "xl/comments" + rId + "." + wbext;
				zip_add_file(zip, cf, write_comments_xml(comments, opts));
				ct.comments.push(cf);
				add_rels(wsrels, -1, "../comments" + rId + "." + wbext, RELS.CMNT);
				need_vml = true;
			}
			if(ws['!legacy']) {
				if(need_vml) zip_add_file(zip, "xl/drawings/vmlDrawing" + (rId) + ".vml", write_vml(rId, ws['!comments']));
			}
			delete ws['!comments'];
			delete ws['!legacy'];
		}

		if(wsrels['!id'].rId1) zip_add_file(zip, get_rels_path(f), write_rels(wsrels));
	}

	if(opts.Strings != null && opts.Strings.length > 0) {
		f = "xl/sharedStrings." + wbext;
		zip_add_file(zip, f, write_sst_xml(opts.Strings, opts));
		ct.strs.push(f);
		add_rels(opts.wbrels, -1, "sharedStrings." + wbext, RELS.SST);
	}

	f = "xl/workbook." + wbext;
	zip_add_file(zip, f, write_wb_xml(wb, opts));
	ct.workbooks.push(f);
	add_rels(opts.rels, 1, f, RELS.WB);

	/* TODO: something more intelligent with themes */

	f = "xl/theme/theme1.xml";
	zip_add_file(zip, f, write_theme(wb.Themes, opts));
	ct.themes.push(f);
	add_rels(opts.wbrels, -1, "theme/theme1.xml", RELS.THEME);

	/* TODO: something more intelligent with styles */

	f = "xl/styles." + wbext;
	zip_add_file(zip, f, write_sty_xml(wb, opts));
	ct.styles.push(f);
	add_rels(opts.wbrels, -1, "styles." + wbext, RELS.STY);

	if(wb.vbaraw && vbafmt) {
		f = "xl/vbaProject.bin";
		zip_add_file(zip, f, wb.vbaraw);
		ct.vba.push(f);
		add_rels(opts.wbrels, -1, "vbaProject.bin", RELS.VBA);
	}

	f = "xl/metadata." + wbext;
	zip_add_file(zip, f, write_xlmeta_xml());
	ct.metadata.push(f);
	add_rels(opts.wbrels, -1, "metadata." + wbext, RELS.XLMETA);

	if(people.length > 1) {
		f = "xl/persons/person.xml";
		zip_add_file(zip, f, write_people_xml(people, opts));
		ct.people.push(f);
		add_rels(opts.wbrels, -1, "persons/person.xml", RELS.PEOPLE);
	}

	zip_add_file(zip, "[Content_Types].xml", write_ct(ct, opts));
	zip_add_file(zip, '_rels/.rels', write_rels(opts.rels));
	zip_add_file(zip, 'xl/_rels/workbook.' + wbext + '.rels', write_rels(opts.wbrels));

	delete opts.revssf; delete opts.ssf;
	return zip;
}

function firstbyte(f,o) {
	var x = "";
	switch((o||{}).type || "base64") {
		case 'buffer': return [f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7]];
		case 'base64': x = Base64_decode(f.slice(0,12)); break;
		case 'binary': x = f; break;
		case 'array':  return [f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7]];
		default: throw new Error("Unrecognized type " + (o && o.type || "undefined"));
	}
	return [x.charCodeAt(0), x.charCodeAt(1), x.charCodeAt(2), x.charCodeAt(3), x.charCodeAt(4), x.charCodeAt(5), x.charCodeAt(6), x.charCodeAt(7)];
}

function read_cfb(cfb, opts) {
	if(CFB.find(cfb, "EncryptedPackage")) return parse_xlsxcfb(cfb, opts);
	return parse_xlscfb(cfb, opts);
}

function read_zip(data, opts) {
	var zip, d = data;
	var o = opts||{};
	if(!o.type) o.type = (has_buf && Buffer.isBuffer(data)) ? "buffer" : "base64";
	zip = zip_read(d, o);
	return parse_zip(zip, o);
}

function read_plaintext(data, o) {
	var i = 0;
	main: while(i < data.length) switch(data.charCodeAt(i)) {
		case 0x0A: case 0x0D: case 0x20: ++i; break;
		case 0x3C: return parse_xlml(data.slice(i),o);
		default: break main;
	}
	return PRN.to_workbook(data, o);
}

function read_plaintext_raw(data, o) {
	var str = "", bytes = firstbyte(data, o);
	switch(o.type) {
		case 'base64': str = Base64_decode(data); break;
		case 'binary': str = data; break;
		case 'buffer': str = data.toString('binary'); break;
		case 'array': str = cc2str(data); break;
		default: throw new Error("Unrecognized type " + o.type);
	}
	if(bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) str = utf8read(str);
	o.type = "binary";
	return read_plaintext(str, o);
}

function read_utf16(data, o) {
	var d = data;
	if(o.type == 'base64') d = Base64_decode(d);
	if(typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) d = new Uint8Array(data);
	d = typeof $cptable !== "undefined" ? $cptable.utils.decode(1200, d.slice(2), 'str') : (
		(has_buf && Buffer.isBuffer(data)) ? data.slice(2).toString("utf16le") :
		(typeof Uint8Array !== "undefined" && d instanceof Uint8Array) ? (
			typeof TextDecoder !== "undefined" ? new TextDecoder("utf-16le").decode(d.slice(2)) : utf16lereadu(d.slice(2))
		) : utf16leread(d.slice(2))
	);
	o.type = "binary";
	return read_plaintext(d, o);
}

function bstrify(data) {
	return !data.match(/[^\x00-\x7F]/) ? data : utf8write(data);
}

function read_prn(data, d, o, str) {
	if(str) { o.type = "string"; return PRN.to_workbook(data, o); }
	return PRN.to_workbook(d, o);
}

function readSync(data, opts) {
	reset_cp();
	var o = opts||{};
	if(o.codepage && typeof $cptable === "undefined") console.error("Codepage tables are not loaded.  Non-ASCII characters may not give expected results");
	if(typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return readSync(new Uint8Array(data), (o = dup(o), o.type = "array", o));
	/* Javet projects `byte[]` to `Int8Array` */
	if(typeof Int8Array !== 'undefined' && data instanceof Int8Array) return readSync(new Uint8Array(data.buffer, data.byteOffset, data.length), o);
	if(typeof Uint8Array !== 'undefined' && data instanceof Uint8Array && !o.type) o.type = typeof Deno !== "undefined" ? "buffer" : "array";
	var d = data, n = [0,0,0,0], str = false;
	if(o.cellStyles) { o.cellNF = true; o.sheetStubs = true; }
	_ssfopts = {};
	if(o.dateNF) _ssfopts.dateNF = o.dateNF;
	if(!o.type) o.type = (has_buf && Buffer.isBuffer(data)) ? "buffer" : "base64";
	if(o.type == "file") { o.type = has_buf ? "buffer" : "binary"; d = read_binary(data); if(typeof Uint8Array !== 'undefined' && !has_buf) o.type = "array"; }
	if(o.type == "string") { str = true; o.type = "binary"; o.codepage = 65001; d = bstrify(data); }
	if(o.type == 'array' && typeof Uint8Array !== 'undefined' && data instanceof Uint8Array && typeof ArrayBuffer !== 'undefined') {
		// $FlowIgnore
		var ab=new ArrayBuffer(3), vu=new Uint8Array(ab); vu.foo="bar";
		// $FlowIgnore
		if(!vu.foo) {o=dup(o); o.type='array'; return readSync(ab2a(d), o);}
	}
	switch((n = firstbyte(d, o))[0]) {
		case 0xD0: if(n[1] === 0xCF && n[2] === 0x11 && n[3] === 0xE0 && n[4] === 0xA1 && n[5] === 0xB1 && n[6] === 0x1A && n[7] === 0xE1) return read_cfb(CFB.read(d, o), o); break;
		case 0x09: if(n[1] <= 0x08) return parse_xlscfb(d, o); break;
		case 0x3C: return parse_xlml(d, o);
		case 0x49:
			if(n[1] === 0x49 && n[2] === 0x2a && n[3] === 0x00) throw new Error("TIFF Image File is not a spreadsheet");
			if(n[1] === 0x44) return read_wb_ID(d, o);
			break;
		case 0x54: if(n[1] === 0x41 && n[2] === 0x42 && n[3] === 0x4C) return DIF.to_workbook(d, o); break;
		case 0x50: return (n[1] === 0x4B && n[2] < 0x09 && n[3] < 0x09) ? read_zip(d, o) : read_prn(data, d, o, str);
		case 0xEF: return n[3] === 0x3C ? parse_xlml(d, o) : read_prn(data, d, o, str);
		case 0xFF:
			if(n[1] === 0xFE) { return read_utf16(d, o); }
			else if(n[1] === 0x00 && n[2] === 0x02 && n[3] === 0x00) return WK_.to_workbook(d, o);
			break;
		case 0x00:
			if(n[1] === 0x00) {
				if(n[2] >= 0x02 && n[3] === 0x00) return WK_.to_workbook(d, o);
				if(n[2] === 0x00 && (n[3] === 0x08 || n[3] === 0x09)) return WK_.to_workbook(d, o);
			}
			break;
		case 0x03: case 0x83: case 0x8B: case 0x8C: return DBF.to_workbook(d, o);
		case 0x7B: if(n[1] === 0x5C && n[2] === 0x72 && n[3] === 0x74) return rtf_to_workbook(d, o); break;
		case 0x0A: case 0x0D: case 0x20: return read_plaintext_raw(d, o);
		case 0x89: if(n[1] === 0x50 && n[2] === 0x4E && n[3] === 0x47) throw new Error("PNG Image File is not a spreadsheet"); break;
		case 0x08: if(n[1] === 0xE7) throw new Error("Unsupported Multiplan 1.x file!"); break;
		case 0x0C:
			if(n[1] === 0xEC) throw new Error("Unsupported Multiplan 2.x file!");
			if(n[1] === 0xED) throw new Error("Unsupported Multiplan 3.x file!");
			break;
	}
	if(DBF_SUPPORTED_VERSIONS.indexOf(n[0]) > -1 && n[2] <= 12 && n[3] <= 31) return DBF.to_workbook(d, o);
	return read_prn(data, d, o, str);
}

function readFileSync(filename, opts) {
	var o = opts||{}; o.type = 'file';
	return readSync(filename, o);
}
function write_cfb_ctr(cfb, o) {
	switch(o.type) {
		case "base64": case "binary": break;
		case "buffer": case "array": o.type = ""; break;
		case "file": return write_dl(o.file, CFB.write(cfb, {type:has_buf ? 'buffer' : ""}));
		case "string": throw new Error("'string' output type invalid for '" + o.bookType + "' files");
		default: throw new Error("Unrecognized type " + o.type);
	}
	return CFB.write(cfb, o);
}

function write_zip(wb, opts) {
	switch(opts.bookType) {
		case "ods": return write_ods(wb, opts);
		case "numbers": return write_numbers_iwa(wb, opts);
		case "xlsb": return write_zip_xlsb(wb, opts);
		default: return write_zip_xlsx(wb, opts);
	}
}

function write_zip_type(wb, opts) {
	var o = dup(opts||{});
	var z = write_zip(wb, o);
	return write_zip_denouement(z, o);
}
function write_zip_typeXLSX(wb, opts) {
	var o = dup(opts||{});
	var z = write_zip_xlsx(wb, o);
	return write_zip_denouement(z, o);
}
function write_zip_denouement(z, o) {
	var oopts = {};
	var ftype = has_buf ? "nodebuffer" : (typeof Uint8Array !== "undefined" ? "array" : "string");
	if(o.compression) oopts.compression = 'DEFLATE';
	if(o.password) oopts.type = ftype;
	else switch(o.type) {
		case "base64": oopts.type = "base64"; break;
		case "binary": oopts.type = "string"; break;
		case "string": throw new Error("'string' output type invalid for '" + o.bookType + "' files");
		case "buffer":
		case "file": oopts.type = ftype; break;
		default: throw new Error("Unrecognized type " + o.type);
	}
	var out = z.FullPaths ? CFB.write(z, {fileType:"zip", type: {"nodebuffer": "buffer", "string": "binary"}[oopts.type] || oopts.type, compression: !!o.compression}) : z.generate(oopts);
	if(typeof Deno !== "undefined") {
		if(typeof out == "string") {
			if(o.type == "binary" || o.type == "base64") return out;
			out = new Uint8Array(s2ab(out));
		}
	}
/*jshint -W083 */
	if(o.password && typeof encrypt_agile !== 'undefined') return write_cfb_ctr(encrypt_agile(out, o.password), o); // eslint-disable-line no-undef
/*jshint +W083 */
	if(o.type === "file") return write_dl(o.file, out);
	return o.type == "string" ? utf8read(out) : out;
}

function write_cfb_type(wb, opts) {
	var o = opts||{};
	var cfb = write_xlscfb(wb, o);
	return write_cfb_ctr(cfb, o);
}

function write_string_type(out, opts, bom) {
	if(!bom) bom = "";
	var o = bom + out;
	switch(opts.type) {
		case "base64": return Base64_encode(utf8write(o));
		case "binary": return utf8write(o);
		case "string": return out;
		case "file": return write_dl(opts.file, o, 'utf8');
		case "buffer": {
			if(has_buf) return Buffer_from(o, 'utf8');
			else if(typeof TextEncoder !== "undefined") return new TextEncoder().encode(o);
			else return write_string_type(o, {type:'binary'}).split("").map(function(c) { return c.charCodeAt(0); });
		}
	}
	throw new Error("Unrecognized type " + opts.type);
}

function write_stxt_type(out, opts) {
	switch(opts.type) {
		case "base64": return Base64_encode_pass(out);
		case "binary": return out;
		case "string": return out; /* override in sheet_to_txt */
		case "file": return write_dl(opts.file, out, 'binary');
		case "buffer": {
			if(has_buf) return Buffer_from(out, 'binary');
			else return out.split("").map(function(c) { return c.charCodeAt(0); });
		}
	}
	throw new Error("Unrecognized type " + opts.type);
}

/* TODO: test consistency */
function write_binary_type(out, opts) {
	switch(opts.type) {
		case "string":
		case "base64":
		case "binary":
			var bstr = "";
			// $FlowIgnore
			for(var i = 0; i < out.length; ++i) bstr += String.fromCharCode(out[i]);
			return opts.type == 'base64' ? Base64_encode(bstr) : opts.type == 'string' ? utf8read(bstr) : bstr;
		case "file": return write_dl(opts.file, out);
		case "buffer": return out;
		default: throw new Error("Unrecognized type " + opts.type);
	}
}

function writeSyncXLSX(wb, opts) {
	reset_cp();
	check_wb(wb);
	var o = dup(opts||{});
	if(o.cellStyles) { o.cellNF = true; o.sheetStubs = true; }
	if(o.type == "array") { o.type = "binary"; var out = (writeSyncXLSX(wb, o)); o.type = "array"; return s2ab(out); }
	return write_zip_typeXLSX(wb, o);
}

function writeSync(wb, opts) {
	reset_cp();
	check_wb(wb);
	var o = dup(opts||{});
	if(o.cellStyles) { o.cellNF = true; o.sheetStubs = true; }
	if(o.type == "array") { o.type = "binary"; var out = (writeSync(wb, o)); o.type = "array"; return s2ab(out); }
	var idx = 0;
	if(o.sheet) {
		if(typeof o.sheet == "number") idx = o.sheet;
		else idx = wb.SheetNames.indexOf(o.sheet);
		if(!wb.SheetNames[idx]) throw new Error("Sheet not found: " + o.sheet + " : " + (typeof o.sheet));
	}
	switch(o.bookType || 'xlsb') {
		case 'xml':
		case 'xlml': return write_string_type(write_xlml(wb, o), o);
		case 'slk':
		case 'sylk': return write_string_type(SYLK.from_sheet(wb.Sheets[wb.SheetNames[idx]], o, wb), o);
		case 'htm':
		case 'html': return write_string_type(sheet_to_html(wb.Sheets[wb.SheetNames[idx]], o), o);
		case 'txt': return write_stxt_type(sheet_to_txt(wb.Sheets[wb.SheetNames[idx]], o), o);
		case 'csv': return write_string_type(sheet_to_csv(wb.Sheets[wb.SheetNames[idx]], o), o, "\ufeff");
		case 'dif': return write_string_type(DIF.from_sheet(wb.Sheets[wb.SheetNames[idx]], o), o);
		case 'dbf': return write_binary_type(DBF.from_sheet(wb.Sheets[wb.SheetNames[idx]], o), o);
		case 'prn': return write_string_type(PRN.from_sheet(wb.Sheets[wb.SheetNames[idx]], o), o);
		case 'rtf': return write_string_type(sheet_to_rtf(wb.Sheets[wb.SheetNames[idx]], o), o);
		case 'eth': return write_string_type(ETH.from_sheet(wb.Sheets[wb.SheetNames[idx]], o), o);
		case 'fods': return write_string_type(write_ods(wb, o), o);
		case 'wk1': return write_binary_type(WK_.sheet_to_wk1(wb.Sheets[wb.SheetNames[idx]], o), o);
		case 'wk3': return write_binary_type(WK_.book_to_wk3(wb, o), o);
		case 'biff2': if(!o.biff) o.biff = 2; /* falls through */
		case 'biff3': if(!o.biff) o.biff = 3; /* falls through */
		case 'biff4': if(!o.biff) o.biff = 4; return write_binary_type(write_biff_buf(wb, o), o);
		case 'biff5': if(!o.biff) o.biff = 5; /* falls through */
		case 'biff8':
		case 'xla':
		case 'xls': if(!o.biff) o.biff = 8; return write_cfb_type(wb, o);
		case 'xlsx':
		case 'xlsm':
		case 'xlam':
		case 'xlsb':
		case 'numbers':
		case 'ods': return write_zip_type(wb, o);
		default: throw new Error ("Unrecognized bookType |" + o.bookType + "|");
	}
}

function resolve_book_type(o) {
	if(o.bookType) return;
	var _BT = {
		"xls": "biff8",
		"htm": "html",
		"slk": "sylk",
		"socialcalc": "eth",
		"Sh33tJS": "WTF"
	};
	var ext = o.file.slice(o.file.lastIndexOf(".")).toLowerCase();
	if(ext.match(/^\.[a-z]+$/)) o.bookType = ext.slice(1);
	o.bookType = _BT[o.bookType] || o.bookType;
}

function writeFileSync(wb, filename, opts) {
	var o = opts||{}; o.type = 'file';
	o.file = filename;
	resolve_book_type(o);
	return writeSync(wb, o);
}

function writeFileSyncXLSX(wb, filename, opts) {
	var o = opts||{}; o.type = 'file';
	o.file = filename;
	resolve_book_type(o);
	return writeSyncXLSX(wb, o);
}


function writeFileAsync(filename, wb, opts, cb) {
	var o = opts||{}; o.type = 'file';
	o.file = filename;
	resolve_book_type(o);
	o.type = 'buffer';
	var _cb = cb; if(!(_cb instanceof Function)) _cb = (opts);
	return _fs.writeFile(filename, writeSync(wb, o), _cb);
}
function make_json_row(sheet, r, R, cols, header, hdr, o) {
	var rr = encode_row(R);
	var defval = o.defval, raw = o.raw || !Object.prototype.hasOwnProperty.call(o, "raw");
	var isempty = true, dense = (sheet["!data"] != null);
	var row = (header === 1) ? [] : {};
	if(header !== 1) {
		if(Object.defineProperty) try { Object.defineProperty(row, '__rowNum__', {value:R, enumerable:false}); } catch(e) { row.__rowNum__ = R; }
		else row.__rowNum__ = R;
	}
	if(!dense || sheet["!data"][R]) for (var C = r.s.c; C <= r.e.c; ++C) {
		var val = dense ? (sheet["!data"][R]||[])[C] : sheet[cols[C] + rr];
		if(val == null || val.t === undefined) {
			if(defval === undefined) continue;
			if(hdr[C] != null) { row[hdr[C]] = defval; }
			continue;
		}
		var v = val.v;
		switch(val.t){
			case 'z': if(v == null) break; continue;
			case 'e': v = (v == 0 ? null : void 0); break;
			case 's': case 'b':
			case 'n': if(!val.z || !fmt_is_date(val.z)) break;
			v = numdate(v); // TODO: date1904 setting should also be stored in worksheet object
			if(typeof v == "number") break;
			/* falls through */
			case 'd': if(!(o && (o.UTC||(o.raw === false)))) v = utc_to_local(new Date(v)); break;
			default: throw new Error('unrecognized type ' + val.t);
		}
		if(hdr[C] != null) {
			if(v == null) {
				if(val.t == "e" && v === null) row[hdr[C]] = null;
				else if(defval !== undefined) row[hdr[C]] = defval;
				else if(raw && v === null) row[hdr[C]] = null;
				else continue;
			} else {
				row[hdr[C]] = (val.t === 'n' && typeof o.rawNumbers === 'boolean' ? o.rawNumbers : raw) ? v : format_cell(val, v, o);
			}
			if(v != null) isempty = false;
		}
	}
	return { row: row, isempty: isempty };
}


function sheet_to_json(sheet, opts) {
	if(sheet == null || sheet["!ref"] == null) return [];
	var val = {t:'n',v:0}, header = 0, offset = 1, hdr = [], v=0, vv="";
	var r = {s:{r:0,c:0},e:{r:0,c:0}};
	var o = opts || {};
	var range = o.range != null ? o.range : sheet["!ref"];
	if(o.header === 1) header = 1;
	else if(o.header === "A") header = 2;
	else if(Array.isArray(o.header)) header = 3;
	else if(o.header == null) header = 0;
	switch(typeof range) {
		case 'string': r = safe_decode_range(range); break;
		case 'number': r = safe_decode_range(sheet["!ref"]); r.s.r = range; break;
		default: r = range;
	}
	if(header > 0) offset = 0;
	var rr = encode_row(r.s.r);
	var cols = [];
	var out = [];
	var outi = 0, counter = 0;
	var dense = sheet["!data"] != null;
	var R = r.s.r, C = 0;
	var header_cnt = {};
	if(dense && !sheet["!data"][R]) sheet["!data"][R] = [];
	var colinfo = o.skipHidden && sheet["!cols"] || [];
	var rowinfo = o.skipHidden && sheet["!rows"] || [];
	for(C = r.s.c; C <= r.e.c; ++C) {
		if(((colinfo[C]||{}).hidden)) continue;
		cols[C] = encode_col(C);
		val = dense ? sheet["!data"][R][C] : sheet[cols[C] + rr];
		switch(header) {
			case 1: hdr[C] = C - r.s.c; break;
			case 2: hdr[C] = cols[C]; break;
			case 3: hdr[C] = o.header[C - r.s.c]; break;
			default:
				if(val == null) val = {w: "__EMPTY", t: "s"};
				vv = v = format_cell(val, null, o);
				counter = header_cnt[v] || 0;
				if(!counter) header_cnt[v] = 1;
				else {
					do { vv = v + "_" + (counter++); } while(header_cnt[vv]); header_cnt[v] = counter;
					header_cnt[vv] = 1;
				}
				hdr[C] = vv;
		}
	}
	for (R = r.s.r + offset; R <= r.e.r; ++R) {
		if ((rowinfo[R]||{}).hidden) continue;
		var row = make_json_row(sheet, r, R, cols, header, hdr, o);
		if((row.isempty === false) || (header === 1 ? o.blankrows !== false : !!o.blankrows)) out[outi++] = row.row;
	}
	out.length = outi;
	return out;
}

var qreg = /"/g;
function make_csv_row(sheet, r, R, cols, fs, rs, FS, w, o) {
	var isempty = true;
	var row = [], txt = "", rr = encode_row(R);
	var dense = sheet["!data"] != null;
	var datarow = dense && sheet["!data"][R] || [];
	for(var C = r.s.c; C <= r.e.c; ++C) {
		if (!cols[C]) continue;
		var val = dense ? datarow[C]: sheet[cols[C] + rr];
		if(val == null) txt = "";
		else if(val.v != null) {
			isempty = false;
			txt = ''+(o.rawNumbers && val.t == "n" ? val.v : format_cell(val, null, o));
			for(var i = 0, cc = 0; i !== txt.length; ++i) if((cc = txt.charCodeAt(i)) === fs || cc === rs || cc === 34 || o.forceQuotes) {txt = "\"" + txt.replace(qreg, '""') + "\""; break; }
			if(txt == "ID" && w == 0 && row.length == 0) txt = '"ID"';
		} else if(val.f != null && !val.F) {
			isempty = false;
			txt = '=' + val.f; if(txt.indexOf(",") >= 0) txt = '"' + txt.replace(qreg, '""') + '"';
		} else txt = "";
		/* NOTE: Excel CSV does not support array formulae */
		row.push(txt);
	}
	if(o.strip) while(row[row.length - 1] === "") --row.length;
	if(o.blankrows === false && isempty) return null;
	return row.join(FS);
}

function sheet_to_csv(sheet, opts) {
	var out = [];
	var o = opts == null ? {} : opts;
	if(sheet == null || sheet["!ref"] == null) return "";
	var r = safe_decode_range(sheet["!ref"]);
	var FS = o.FS !== undefined ? o.FS : ",", fs = FS.charCodeAt(0);
	var RS = o.RS !== undefined ? o.RS : "\n", rs = RS.charCodeAt(0);
	var row = "", cols = [];
	var colinfo = o.skipHidden && sheet["!cols"] || [];
	var rowinfo = o.skipHidden && sheet["!rows"] || [];
	for(var C = r.s.c; C <= r.e.c; ++C) if (!((colinfo[C]||{}).hidden)) cols[C] = encode_col(C);
	var w = 0;
	for(var R = r.s.r; R <= r.e.r; ++R) {
		if ((rowinfo[R]||{}).hidden) continue;
		row = make_csv_row(sheet, r, R, cols, fs, rs, FS, w, o);
		if(row == null) { continue; }
		if(row || (o.blankrows !== false)) out.push((w++ ? RS : "") + row);
	}
	return out.join("");
}

function sheet_to_txt(sheet, opts) {
	if(!opts) opts = {}; opts.FS = "\t"; opts.RS = "\n";
	var s = sheet_to_csv(sheet, opts);
	if(typeof $cptable == 'undefined' || opts.type == 'string') return s;
	var o = $cptable.utils.encode(1200, s, 'str');
	return String.fromCharCode(255) + String.fromCharCode(254) + o;
}

function sheet_to_formulae(sheet, opts) {
	var y = "", x, val="";
	if(sheet == null || sheet["!ref"] == null) return [];
	var r = safe_decode_range(sheet['!ref']), rr = "", cols = [], C;
	var cmds = [];
	var dense = sheet["!data"] != null;
	for(C = r.s.c; C <= r.e.c; ++C) cols[C] = encode_col(C);
	for(var R = r.s.r; R <= r.e.r; ++R) {
		rr = encode_row(R);
		for(C = r.s.c; C <= r.e.c; ++C) {
			y = cols[C] + rr;
			x = dense ? (sheet["!data"][R]||[])[C] : sheet[y];
			val = "";
			if(x === undefined) continue;
			else if(x.F != null) {
				y = x.F;
				if(!x.f) continue;
				val = x.f;
				if(y.indexOf(":") == -1) y = y + ":" + y;
			}
			if(x.f != null) val = x.f;
			else if(opts && opts.values === false) continue;
			else if(x.t == 'z') continue;
			else if(x.t == 'n' && x.v != null) val = "" + x.v;
			else if(x.t == 'b') val = x.v ? "TRUE" : "FALSE";
			else if(x.w !== undefined) val = "'" + x.w;
			else if(x.v === undefined) continue;
			else if(x.t == 's') val = "'" + x.v;
			else val = ""+x.v;
			cmds[cmds.length] = y + "=" + val;
		}
	}
	return cmds;
}

function sheet_add_json(_ws, js, opts) {
	var o = opts || {};
	var dense = _ws ? (_ws["!data"] != null) : o.dense;
	if(DENSE != null && dense == null) dense = DENSE;
	var offset = +!o.skipHeader;
	var ws = _ws || ({});
	if(!_ws && dense) ws["!data"] = [];
	var _R = 0, _C = 0;
	if(ws && o.origin != null) {
		if(typeof o.origin == 'number') _R = o.origin;
		else {
			var _origin = typeof o.origin == "string" ? decode_cell(o.origin) : o.origin;
			_R = _origin.r; _C = _origin.c;
		}
	}
	var range = ({s: {c:0, r:0}, e: {c:_C, r:_R + js.length - 1 + offset}});
	if(ws['!ref']) {
		var _range = safe_decode_range(ws['!ref']);
		range.e.c = Math.max(range.e.c, _range.e.c);
		range.e.r = Math.max(range.e.r, _range.e.r);
		if(_R == -1) { _R = _range.e.r + 1; range.e.r = _R + js.length - 1 + offset; }
	} else {
		if(_R == -1) { _R = 0; range.e.r = js.length - 1 + offset; }
	}
	var hdr = o.header || [], C = 0;
	var ROW = [];
	js.forEach(function (JS, R) {
		if(dense && !ws["!data"][_R + R + offset]) ws["!data"][_R + R + offset] = [];
		if(dense) ROW = ws["!data"][_R + R + offset];
		keys(JS).forEach(function(k) {
			if((C=hdr.indexOf(k)) == -1) hdr[C=hdr.length] = k;
			var v = JS[k];
			var t = 'z';
			var z = "";
			var ref = dense ? "" : (encode_col(_C + C) + encode_row(_R + R + offset));
			var cell = dense ? ROW[_C + C] : ws[ref];
			if(v && typeof v === 'object' && !(v instanceof Date)){
				if(dense) ROW[_C + C] = v;
				else ws[ref] = v;
			} else {
				if(typeof v == 'number') t = 'n';
				else if(typeof v == 'boolean') t = 'b';
				else if(typeof v == 'string') t = 's';
				else if(v instanceof Date) {
					t = 'd';
					if(!o.UTC) v = local_to_utc(v);
					if(!o.cellDates) { t = 'n'; v = datenum(v); }
					z = (cell != null && cell.z && fmt_is_date(cell.z)) ? cell.z : (o.dateNF || table_fmt[14]);
				}
				else if(v === null && o.nullError) { t = 'e'; v = 0; }
				if(!cell) {
					if(!dense) ws[ref] = cell = ({t:t, v:v});
					else ROW[_C + C] = cell = ({t:t, v:v});
				} else {
					cell.t = t; cell.v = v;
					delete cell.w; delete cell.R;
					if(z) cell.z = z;
				}
				if(z) cell.z = z;
			}
		});
	});
	range.e.c = Math.max(range.e.c, _C + hdr.length - 1);
	var __R = encode_row(_R);
	if(dense && !ws["!data"][_R]) ws["!data"][_R] = [];
	if(offset) for(C = 0; C < hdr.length; ++C) {
		if(dense) ws["!data"][_R][C + _C] = {t:'s', v:hdr[C]};
		else ws[encode_col(C + _C) + __R] = {t:'s', v:hdr[C]};
	}
	ws['!ref'] = encode_range(range);
	return ws;
}
function json_to_sheet(js, opts) { return sheet_add_json(null, js, opts); }

/* get cell, creating a stub if necessary */
function ws_get_cell_stub(ws, R, C) {
	/* A1 cell address */
	if(typeof R == "string") {
		if(ws["!data"] != null) {
			var RC = decode_cell(R);
			if(!ws["!data"][RC.r]) ws["!data"][RC.r] = [];
			return ws["!data"][RC.r][RC.c] || (ws["!data"][RC.r][RC.c] = {t:'z'});
		}
		return ws[R] || (ws[R] = {t:'z'});
	}
	/* cell address object */
	if(typeof R != "number") return ws_get_cell_stub(ws, encode_cell(R));
	/* R and C are 0-based indices */
	return ws_get_cell_stub(ws, encode_col(C||0) + encode_row(R));
}

/* find sheet index for given name / validate index */
function wb_sheet_idx(wb, sh) {
	if(typeof sh == "number") {
		if(sh >= 0 && wb.SheetNames.length > sh) return sh;
		throw new Error("Cannot find sheet # " + sh);
	} else if(typeof sh == "string") {
		var idx = wb.SheetNames.indexOf(sh);
		if(idx > -1) return idx;
		throw new Error("Cannot find sheet name |" + sh + "|");
	} else throw new Error("Cannot find sheet |" + sh + "|");
}

/* simple blank or single-sheet workbook object */
function book_new(ws, wsname) {
	var wb = { SheetNames: [], Sheets: {} };
	if(ws) book_append_sheet(wb, ws, wsname || "Sheet1");
	return wb;
}

/* add a worksheet to the end of a given workbook */
function book_append_sheet(wb, ws, name, roll) {
	var i = 1;
	if(!name) for(; i <= 0xFFFF; ++i, name = undefined) if(wb.SheetNames.indexOf(name = "Sheet" + i) == -1) break;
	if(!name || wb.SheetNames.length >= 0xFFFF) throw new Error("Too many worksheets");
	if(roll && wb.SheetNames.indexOf(name) >= 0 && name.length < 32) {
		var m = name.match(/\d+$/); // at this point, name length is capped at 32
		i = m && +m[0] || 0;
		var root = m && name.slice(0, m.index) || name;
		for(++i; i <= 0xFFFF; ++i) if(wb.SheetNames.indexOf(name = root + i) == -1) break;
	}
	check_ws_name(name);
	if(wb.SheetNames.indexOf(name) >= 0) throw new Error("Worksheet with name |" + name + "| already exists!");

	wb.SheetNames.push(name);
	wb.Sheets[name] = ws;
	return name;
}

/* set sheet visibility (visible/hidden/very hidden) */
function book_set_sheet_visibility(wb, sh, vis) {
	if(!wb.Workbook) wb.Workbook = {};
	if(!wb.Workbook.Sheets) wb.Workbook.Sheets = [];

	var idx = wb_sheet_idx(wb, sh);
	// $FlowIgnore
	if(!wb.Workbook.Sheets[idx]) wb.Workbook.Sheets[idx] = {};

	switch(vis) {
		case 0: case 1: case 2: break;
		default: throw new Error("Bad sheet visibility setting " + vis);
	}
	// $FlowIgnore
	wb.Workbook.Sheets[idx].Hidden = vis;
}

/* set number format */
function cell_set_number_format(cell, fmt) {
	cell.z = fmt;
	return cell;
}

/* set cell hyperlink */
function cell_set_hyperlink(cell, target, tooltip) {
	if(!target) {
		delete cell.l;
	} else {
		cell.l = ({ Target: target });
		if(tooltip) cell.l.Tooltip = tooltip;
	}
	return cell;
}
function cell_set_internal_link(cell, range, tooltip) { return cell_set_hyperlink(cell, "#" + range, tooltip); }

/* add to cell comments */
function cell_add_comment(cell, text, author) {
	if(!cell.c) cell.c = [];
	cell.c.push({t:text, a:author||"SheetJS"});
}

/* set array formula and flush related cells */
function sheet_set_array_formula(ws, range, formula, dynamic) {
	var rng = typeof range != "string" ? range : safe_decode_range(range);
	var rngstr = typeof range == "string" ? range : encode_range(range);
	for(var R = rng.s.r; R <= rng.e.r; ++R) for(var C = rng.s.c; C <= rng.e.c; ++C) {
		var cell = ws_get_cell_stub(ws, R, C);
		cell.t = 'n';
		cell.F = rngstr;
		delete cell.v;
		if(R == rng.s.r && C == rng.s.c) {
			cell.f = formula;
			if(dynamic) cell.D = true;
		}
	}
	var wsr = decode_range(ws["!ref"]);
	if(wsr.s.r > rng.s.r) wsr.s.r = rng.s.r;
	if(wsr.s.c > rng.s.c) wsr.s.c = rng.s.c;
	if(wsr.e.r < rng.e.r) wsr.e.r = rng.e.r;
	if(wsr.e.c < rng.e.c) wsr.e.c = rng.e.c;
	ws["!ref"] = encode_range(wsr);
	return ws;
}

var utils = {
	encode_col: encode_col,
	encode_row: encode_row,
	encode_cell: encode_cell,
	encode_range: encode_range,
	decode_col: decode_col,
	decode_row: decode_row,
	split_cell: split_cell,
	decode_cell: decode_cell,
	decode_range: decode_range,
	format_cell: format_cell,
	sheet_new: sheet_new,
	sheet_add_aoa: sheet_add_aoa,
	sheet_add_json: sheet_add_json,
	sheet_add_dom: sheet_add_dom,
	aoa_to_sheet: aoa_to_sheet,
	json_to_sheet: json_to_sheet,
	table_to_sheet: parse_dom_table,
	table_to_book: table_to_book,
	sheet_to_csv: sheet_to_csv,
	sheet_to_txt: sheet_to_txt,
	sheet_to_json: sheet_to_json,
	sheet_to_html: sheet_to_html,
	sheet_to_formulae: sheet_to_formulae,
	sheet_to_row_object_array: sheet_to_json,
	sheet_get_cell: ws_get_cell_stub,
	book_new: book_new,
	book_append_sheet: book_append_sheet,
	book_set_sheet_visibility: book_set_sheet_visibility,
	cell_set_number_format: cell_set_number_format,
	cell_set_hyperlink: cell_set_hyperlink,
	cell_set_internal_link: cell_set_internal_link,
	cell_add_comment: cell_add_comment,
	sheet_set_array_formula: sheet_set_array_formula,
	consts: {
		SHEET_VISIBLE: 0,
		SHEET_HIDDEN: 1,
		SHEET_VERY_HIDDEN: 2
	}
};

var _Readable;
function set_readable(R) { _Readable = R; }

function write_csv_stream(sheet, opts) {
	var stream = _Readable();
	var o = opts == null ? {} : opts;
	if(sheet == null || sheet["!ref"] == null) { stream.push(null); return stream; }
	var r = safe_decode_range(sheet["!ref"]);
	var FS = o.FS !== undefined ? o.FS : ",", fs = FS.charCodeAt(0);
	var RS = o.RS !== undefined ? o.RS : "\n", rs = RS.charCodeAt(0);
	var row = "", cols = [];
	var colinfo = o.skipHidden && sheet["!cols"] || [];
	var rowinfo = o.skipHidden && sheet["!rows"] || [];
	for(var C = r.s.c; C <= r.e.c; ++C) if (!((colinfo[C]||{}).hidden)) cols[C] = encode_col(C);
	var R = r.s.r;
	var BOM = false, w = 0;
	stream._read = function() {
		if(!BOM) { BOM = true; return stream.push("\uFEFF"); }
		while(R <= r.e.r) {
			++R;
			if ((rowinfo[R-1]||{}).hidden) continue;
			row = make_csv_row(sheet, r, R-1, cols, fs, rs, FS, w, o);
			if(row != null) {
				if(row || (o.blankrows !== false)) return stream.push((w++ ? RS : "") + row);
			}
		}
		return stream.push(null);
	};
	return stream;
}

function write_html_stream(ws, opts) {
	var stream = _Readable();

	var o = opts || {};
	var header = o.header != null ? o.header : HTML_BEGIN;
	var footer = o.footer != null ? o.footer : HTML_END;
	stream.push(header);
	var r = decode_range(ws['!ref']);
	stream.push(make_html_preamble(ws, r, o));
	var R = r.s.r;
	var end = false;
	stream._read = function() {
		if(R > r.e.r) {
			if(!end) { end = true; stream.push("</table>" + footer); }
			return stream.push(null);
		}
		while(R <= r.e.r) {
			stream.push(make_html_row(ws, r, R, o));
			++R;
			break;
		}
	};
	return stream;
}

function write_json_stream(sheet, opts) {
	var stream = _Readable({objectMode:true});

	if(sheet == null || sheet["!ref"] == null) { stream.push(null); return stream; }
	var val = {t:'n',v:0}, header = 0, offset = 1, hdr = [], v=0, vv="";
	var r = {s:{r:0,c:0},e:{r:0,c:0}};
	var o = opts || {};
	var range = o.range != null ? o.range : sheet["!ref"];
	if(o.header === 1) header = 1;
	else if(o.header === "A") header = 2;
	else if(Array.isArray(o.header)) header = 3;
	switch(typeof range) {
		case 'string': r = safe_decode_range(range); break;
		case 'number': r = safe_decode_range(sheet["!ref"]); r.s.r = range; break;
		default: r = range;
	}
	if(header > 0) offset = 0;
	var rr = encode_row(r.s.r);
	var cols = [];
	var counter = 0;
	var dense = sheet["!data"] != null;
	var R = r.s.r, C = 0;
	var header_cnt = {};
	if(dense && !sheet["!data"][R]) sheet["!data"][R] = [];
	var colinfo = o.skipHidden && sheet["!cols"] || [];
	var rowinfo = o.skipHidden && sheet["!rows"] || [];
	for(C = r.s.c; C <= r.e.c; ++C) {
		if(((colinfo[C]||{}).hidden)) continue;
		cols[C] = encode_col(C);
		val = dense ? sheet["!data"][R][C] : sheet[cols[C] + rr];
		switch(header) {
			case 1: hdr[C] = C - r.s.c; break;
			case 2: hdr[C] = cols[C]; break;
			case 3: hdr[C] = o.header[C - r.s.c]; break;
			default:
				if(val == null) val = {w: "__EMPTY", t: "s"};
				vv = v = format_cell(val, null, o);
				counter = header_cnt[v] || 0;
				if(!counter) header_cnt[v] = 1;
				else {
					do { vv = v + "_" + (counter++); } while(header_cnt[vv]); header_cnt[v] = counter;
					header_cnt[vv] = 1;
				}
				hdr[C] = vv;
		}
	}
	R = r.s.r + offset;
	stream._read = function() {
		while(R <= r.e.r) {
			if ((rowinfo[R-1]||{}).hidden) continue;
			var row = make_json_row(sheet, r, R, cols, header, hdr, o);
			++R;
			if((row.isempty === false) || (header === 1 ? o.blankrows !== false : !!o.blankrows)) {
				stream.push(row.row);
				return;
			}
		}
		return stream.push(null);
	};
	return stream;
}

function write_xlml_stream(wb, o) {
	var stream = _Readable();
	var opts = o == null ? {} : o;
	var stride = +opts.stride || 10;
	if(!wb.SSF) wb.SSF = dup(table_fmt);
	if(wb.SSF) {
		make_ssf(); SSF_load_table(wb.SSF);
		// $FlowIgnore
		opts.revssf = evert_num(wb.SSF); opts.revssf[wb.SSF[65535]] = 0;
		opts.ssf = wb.SSF;
		opts.cellXfs = [];
		get_cell_style(opts.cellXfs, {}, {revssf:{"General":0}});
	}

	/* do one pass to determine styles since they must be added before tables */
	wb.SheetNames.forEach(function(n) {
		var ws = wb.Sheets[n];
		if(!ws || !ws["!ref"]) return;
		var range = decode_range(ws["!ref"]);
		var dense = ws["!data"] != null;
		var ddata = dense ? ws["!data"] : [];
		var addr = {r:0,c:0};
		for(var R = range.s.r; R <= range.e.r; ++R) {
			addr.r = R;
			if(dense && !ddata[R]) continue;
			for(var C = range.s.c; C <= range.e.c; ++C) {
				addr.c = C;
				var cell = dense ? ddata[R][C] : ws[encode_col(C) + encode_row(R)];
				if(!cell) continue;
				if(cell.t == "d" && cell.z == null) { cell = dup(cell); cell.z = table_fmt[14]; }
				void get_cell_style(opts.cellXfs, cell, opts);
			}
		}
	});
	var sty = write_sty_xlml(wb, opts);

	var stage = 0, wsidx = 0, ws = wb.Sheets[wb.SheetNames[wsidx]], range = safe_decode_range(ws), R = -1, T = false;

	var marr = [], mi = 0, dense = false, darr = [], addr = {r:0,c:0};

	stream._read = function() { switch(stage) {
		/* header */
		case 0: {
			stage = 1;
			stream.push(XML_HEADER);
			stream.push("<Workbook" + wxt_helper({
				'xmlns':      XLMLNS.ss,
				'xmlns:o':    XLMLNS.o,
				'xmlns:x':    XLMLNS.x,
				'xmlns:ss':   XLMLNS.ss,
				'xmlns:dt':   XLMLNS.dt,
				'xmlns:html': XLMLNS.html
			}) + ">");
		} break;

		/* preamble */
		case 1: {
			stage = 2;
			stream.push(write_props_xlml(wb, opts));
			stream.push(write_wb_xlml(wb, opts));
		} break;

		/* style and name tables */
		case 2: {
			stage = 3;
			stream.push(sty);
			stream.push(write_names_xlml(wb, opts));
		} break;

		/* worksheet preamble */
		case 3: {
			T = false;
			if(wsidx >= wb.SheetNames.length) { stage = -1; stream.push(""); break; }

			stream.push("<Worksheet" + wxt_helper({ "ss:Name": escapexml(wb.SheetNames[wsidx])}) + ">");

			ws = wb.Sheets[wb.SheetNames[wsidx]];
			if(!ws) { stream.push("</Worksheet>"); return void ++wsidx; }

			var names = write_ws_xlml_names(ws, opts, wsidx, wb);
			if(names.length) stream.push("<Names>" + names + "</Names>");

			if(!ws["!ref"]) return (stage = 5);
			range = safe_decode_range(ws["!ref"]);
			R = range.s.r;
			stage = 4;
		} break;

		/* worksheet intramble */
		case 4: {
			if(R < 0 || R > range.e.r) { if(T) stream.push("</Table>"); return void (stage = 5); }

			if(R <= range.s.r) {
				if(ws['!cols']) ws['!cols'].forEach(function(n, i) {
					process_col(n);
					var w = !!n.width;
					var p = col_obj_w(i, n);
					var k = {"ss:Index":i+1};
					if(w) k['ss:Width'] = width2px(p.width);
					if(n.hidden) k['ss:Hidden']="1";
					if(!T) { T = true; stream.push("<Table>"); }
					stream.push(writextag("Column",null,k));
				});
				dense = ws["!data"] != null;
				if(dense) darr = ws["!data"];
				addr.r = addr.c = 0;
			}

			/* undefined `stride` rows per invocation */
			for(var cnt = 0; R <= range.e.r && cnt < stride; ++R, ++cnt) {
				var row = [write_ws_xlml_row(R, (ws['!rows']||[])[R])];
				addr.r = R;
				if(!(dense && !darr[R])) for(var C = range.s.c; C <= range.e.c; ++C) {
					addr.c = C;
					var skip = false;
					for(mi = 0; mi != marr.length; ++mi) {
						if(marr[mi].s.c > C) continue;
						if(marr[mi].s.r > R) continue;
						if(marr[mi].e.c < C) continue;
						if(marr[mi].e.r < R) continue;
						if(marr[mi].s.c != C || marr[mi].s.r != R) skip = true;
						break;
					}
					if(skip) continue;
					var ref = encode_col(C) + encode_row(R), cell = dense ? darr[R][C] : ws[ref];
					row.push(write_ws_xlml_cell(cell, ref, ws, opts, wsidx, wb, addr));
				}
				row.push("</Row>");
				if(!T) { T = true; stream.push("<Table>"); }
				stream.push(row.join(""));
			}
		} break;

		/* worksheet postamble */
		case 5: {
			stream.push(write_ws_xlml_wsopts(ws, opts, wsidx, wb));
			if(ws && ws["!autofilter"]) stream.push('<AutoFilter x:Range="' + a1_to_rc(fix_range(ws["!autofilter"].ref), {r:0,c:0}) + '" xmlns="urn:schemas-microsoft-com:office:excel"></AutoFilter>');
			stream.push("</Worksheet>");
			wsidx++; R = -1;
			return void (stage = 3);
		}

		/* footer */
		case -1: {
			stage = -2;
			stream.push("</Workbook>");
		} break;

		/* exeunt */
		case -2: stream.push(null); break;
	}};
	return stream;
}

var __stream = {
	to_json: write_json_stream,
	to_html: write_html_stream,
	to_csv: write_csv_stream,
	to_xlml: write_xlml_stream,
	set_readable: set_readable
};
if(typeof parse_xlscfb !== "undefined") XLSX.parse_xlscfb = parse_xlscfb;
XLSX.parse_zip = parse_zip;
XLSX.read = readSync; //xlsread
XLSX.readFile = readFileSync; //readFile
XLSX.readFileSync = readFileSync;
XLSX.write = writeSync;
XLSX.writeFile = writeFileSync;
XLSX.writeFileSync = writeFileSync;
XLSX.writeFileAsync = writeFileAsync;
XLSX.utils = utils;
XLSX.writeXLSX = writeSyncXLSX;
XLSX.writeFileXLSX = writeFileSyncXLSX;
XLSX.set_fs = set_fs;
XLSX.set_cptable = set_cptable;
XLSX.SSF = SSF;
if(typeof __stream !== "undefined") XLSX.stream = __stream;
if(typeof CFB !== "undefined") XLSX.CFB = CFB;
if(typeof require !== "undefined") {
  var strmod = undefined;
  if((strmod||{}).Readable) set_readable(strmod.Readable);
	try { _fs = undefined; } catch(e) {}
}
}
/*global define */
if(typeof exports !== 'undefined') make_xlsx_lib(exports);
else if(typeof module !== 'undefined' && module.exports) make_xlsx_lib(module.exports);
else if(typeof define === 'function' && define.amd) define('xlsx', function() { if(!XLSX.version) make_xlsx_lib(XLSX); return XLSX; });
else make_xlsx_lib(XLSX);
/* NOTE: the following extra line is needed for "Lightning Locker Service" */
if(typeof window !== 'undefined' && !window.XLSX) try { window.XLSX = XLSX; } catch(e) {}
