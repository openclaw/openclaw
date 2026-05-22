//#region node_modules/tinyrainbow/dist/index.js
var b = {
	reset: [0, 0],
	bold: [
		1,
		22,
		"\x1B[22m\x1B[1m"
	],
	dim: [
		2,
		22,
		"\x1B[22m\x1B[2m"
	],
	italic: [3, 23],
	underline: [4, 24],
	inverse: [7, 27],
	hidden: [8, 28],
	strikethrough: [9, 29],
	black: [30, 39],
	red: [31, 39],
	green: [32, 39],
	yellow: [33, 39],
	blue: [34, 39],
	magenta: [35, 39],
	cyan: [36, 39],
	white: [37, 39],
	gray: [90, 39],
	bgBlack: [40, 49],
	bgRed: [41, 49],
	bgGreen: [42, 49],
	bgYellow: [43, 49],
	bgBlue: [44, 49],
	bgMagenta: [45, 49],
	bgCyan: [46, 49],
	bgWhite: [47, 49],
	blackBright: [90, 39],
	redBright: [91, 39],
	greenBright: [92, 39],
	yellowBright: [93, 39],
	blueBright: [94, 39],
	magentaBright: [95, 39],
	cyanBright: [96, 39],
	whiteBright: [97, 39],
	bgBlackBright: [100, 49],
	bgRedBright: [101, 49],
	bgGreenBright: [102, 49],
	bgYellowBright: [103, 49],
	bgBlueBright: [104, 49],
	bgMagentaBright: [105, 49],
	bgCyanBright: [106, 49],
	bgWhiteBright: [107, 49]
};
function i(e) {
	return String(e);
}
i.open = "";
i.close = "";
function B() {
	let e = typeof process != "undefined" ? process : void 0, r = (e == null ? void 0 : e.env) || {}, a = r.FORCE_TTY !== "false", l = (e == null ? void 0 : e.argv) || [];
	return !("NO_COLOR" in r || l.includes("--no-color")) && ("FORCE_COLOR" in r || l.includes("--color") || (e == null ? void 0 : e.platform) === "win32" || a && r.TERM !== "dumb" || "CI" in r) || typeof window != "undefined" && !!window.chrome;
}
function C({ force: e } = {}) {
	let r = e || B(), a = (t, o, u, n) => {
		let g = "", s = 0;
		do
			g += t.substring(s, n) + u, s = n + o.length, n = t.indexOf(o, s);
		while (~n);
		return g + t.substring(s);
	}, l = (t, o, u = t) => {
		let n = (g) => {
			let s = String(g), h = s.indexOf(o, t.length);
			return ~h ? t + a(s, o, u, h) + o : t + s + o;
		};
		return n.open = t, n.close = o, n;
	}, c = { isColorSupported: r }, f = (t) => `\x1B[${t}m`;
	for (let t in b) {
		let o = b[t];
		c[t] = r ? l(f(o[0]), f(o[1]), o[2]) : i;
	}
	return c;
}
var y = C();
//#endregion
//#region node_modules/@vitest/pretty-format/dist/index.js
function _mergeNamespaces(n, m) {
	m.forEach(function(e) {
		e && typeof e !== "string" && !Array.isArray(e) && Object.keys(e).forEach(function(k) {
			if (k !== "default" && !(k in n)) {
				var d = Object.getOwnPropertyDescriptor(e, k);
				Object.defineProperty(n, k, d.get ? d : {
					enumerable: true,
					get: function() {
						return e[k];
					}
				});
			}
		});
	});
	return Object.freeze(n);
}
function getKeysOfEnumerableProperties(object, compareKeys) {
	const rawKeys = Object.keys(object);
	const keys = compareKeys === null ? rawKeys : rawKeys.sort(compareKeys);
	if (Object.getOwnPropertySymbols) {
		for (const symbol of Object.getOwnPropertySymbols(object)) if (Object.getOwnPropertyDescriptor(object, symbol).enumerable) keys.push(symbol);
	}
	return keys;
}
/**
* Return entries (for example, of a map)
* with spacing, indentation, and comma
* without surrounding punctuation (for example, braces)
*/
function printIteratorEntries(iterator, config, indentation, depth, refs, printer, separator = ": ") {
	let result = "";
	let width = 0;
	let current = iterator.next();
	if (!current.done) {
		result += config.spacingOuter;
		const indentationNext = indentation + config.indent;
		while (!current.done) {
			result += indentationNext;
			if (width++ === config.maxWidth) {
				result += "…";
				break;
			}
			const name = printer(current.value[0], config, indentationNext, depth, refs);
			const value = printer(current.value[1], config, indentationNext, depth, refs);
			result += name + separator + value;
			current = iterator.next();
			if (!current.done) result += `,${config.spacingInner}`;
			else if (!config.min) result += ",";
		}
		result += config.spacingOuter + indentation;
	}
	return result;
}
/**
* Return values (for example, of a set)
* with spacing, indentation, and comma
* without surrounding punctuation (braces or brackets)
*/
function printIteratorValues(iterator, config, indentation, depth, refs, printer) {
	let result = "";
	let width = 0;
	let current = iterator.next();
	if (!current.done) {
		result += config.spacingOuter;
		const indentationNext = indentation + config.indent;
		while (!current.done) {
			result += indentationNext;
			if (width++ === config.maxWidth) {
				result += "…";
				break;
			}
			result += printer(current.value, config, indentationNext, depth, refs);
			current = iterator.next();
			if (!current.done) result += `,${config.spacingInner}`;
			else if (!config.min) result += ",";
		}
		result += config.spacingOuter + indentation;
	}
	return result;
}
/**
* Return items (for example, of an array)
* with spacing, indentation, and comma
* without surrounding punctuation (for example, brackets)
*/
function printListItems(list, config, indentation, depth, refs, printer) {
	let result = "";
	list = list instanceof ArrayBuffer ? new DataView(list) : list;
	const isDataView = (l) => l instanceof DataView;
	const length = isDataView(list) ? list.byteLength : list.length;
	if (length > 0) {
		result += config.spacingOuter;
		const indentationNext = indentation + config.indent;
		for (let i = 0; i < length; i++) {
			result += indentationNext;
			if (i === config.maxWidth) {
				result += "…";
				break;
			}
			if (isDataView(list) || i in list) result += printer(isDataView(list) ? list.getInt8(i) : list[i], config, indentationNext, depth, refs);
			if (i < length - 1) result += `,${config.spacingInner}`;
			else if (!config.min) result += ",";
		}
		result += config.spacingOuter + indentation;
	}
	return result;
}
/**
* Return properties of an object
* with spacing, indentation, and comma
* without surrounding punctuation (for example, braces)
*/
function printObjectProperties(val, config, indentation, depth, refs, printer) {
	let result = "";
	const keys = getKeysOfEnumerableProperties(val, config.compareKeys);
	if (keys.length > 0) {
		result += config.spacingOuter;
		const indentationNext = indentation + config.indent;
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			const name = printer(key, config, indentationNext, depth, refs);
			const value = printer(val[key], config, indentationNext, depth, refs);
			result += `${indentationNext + name}: ${value}`;
			if (i < keys.length - 1) result += `,${config.spacingInner}`;
			else if (!config.min) result += ",";
		}
		result += config.spacingOuter + indentation;
	}
	return result;
}
const asymmetricMatcher = typeof Symbol === "function" && Symbol.for ? Symbol.for("jest.asymmetricMatcher") : 1267621;
const SPACE$2 = " ";
const serialize$5 = (val, config, indentation, depth, refs, printer) => {
	const stringedValue = val.toString();
	if (stringedValue === "ArrayContaining" || stringedValue === "ArrayNotContaining") {
		if (++depth > config.maxDepth) return `[${stringedValue}]`;
		return `${stringedValue + SPACE$2}[${printListItems(val.sample, config, indentation, depth, refs, printer)}]`;
	}
	if (stringedValue === "ObjectContaining" || stringedValue === "ObjectNotContaining") {
		if (++depth > config.maxDepth) return `[${stringedValue}]`;
		return `${stringedValue + SPACE$2}{${printObjectProperties(val.sample, config, indentation, depth, refs, printer)}}`;
	}
	if (stringedValue === "StringMatching" || stringedValue === "StringNotMatching") return stringedValue + SPACE$2 + printer(val.sample, config, indentation, depth, refs);
	if (stringedValue === "StringContaining" || stringedValue === "StringNotContaining") return stringedValue + SPACE$2 + printer(val.sample, config, indentation, depth, refs);
	if (typeof val.toAsymmetricMatcher !== "function") throw new TypeError(`Asymmetric matcher ${val.constructor.name} does not implement toAsymmetricMatcher()`);
	return val.toAsymmetricMatcher();
};
const test$5 = (val) => val && val.$$typeof === asymmetricMatcher;
const plugin$5 = {
	serialize: serialize$5,
	test: test$5
};
const SPACE$1 = " ";
const OBJECT_NAMES = new Set(["DOMStringMap", "NamedNodeMap"]);
const ARRAY_REGEXP = /^(?:HTML\w*Collection|NodeList)$/;
function testName(name) {
	return OBJECT_NAMES.has(name) || ARRAY_REGEXP.test(name);
}
const test$4 = (val) => val && val.constructor && !!val.constructor.name && testName(val.constructor.name);
function isNamedNodeMap(collection) {
	return collection.constructor.name === "NamedNodeMap";
}
const serialize$4 = (collection, config, indentation, depth, refs, printer) => {
	const name = collection.constructor.name;
	if (++depth > config.maxDepth) return `[${name}]`;
	return (config.min ? "" : name + SPACE$1) + (OBJECT_NAMES.has(name) ? `{${printObjectProperties(isNamedNodeMap(collection) ? [...collection].reduce((props, attribute) => {
		props[attribute.name] = attribute.value;
		return props;
	}, {}) : { ...collection }, config, indentation, depth, refs, printer)}}` : `[${printListItems([...collection], config, indentation, depth, refs, printer)}]`);
};
const plugin$4 = {
	serialize: serialize$4,
	test: test$4
};
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/
function escapeHTML(str) {
	return str.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function printProps(keys, props, config, indentation, depth, refs, printer) {
	const indentationNext = indentation + config.indent;
	const colors = config.colors;
	return keys.map((key) => {
		const value = props[key];
		if (typeof value === "string" && value[0] === "_" && value.startsWith("__vitest_") && value.match(/__vitest_\d+__/)) return "";
		let printed = printer(value, config, indentationNext, depth, refs);
		if (typeof value !== "string") {
			if (printed.includes("\n")) printed = config.spacingOuter + indentationNext + printed + config.spacingOuter + indentation;
			printed = `{${printed}}`;
		}
		return `${config.spacingInner + indentation + colors.prop.open + key + colors.prop.close}=${colors.value.open}${printed}${colors.value.close}`;
	}).join("");
}
function printChildren(children, config, indentation, depth, refs, printer) {
	return children.map((child) => config.spacingOuter + indentation + (typeof child === "string" ? printText(child, config) : printer(child, config, indentation, depth, refs))).join("");
}
function printShadowRoot(children, config, indentation, depth, refs, printer) {
	if (config.printShadowRoot === false) return "";
	return [`${config.spacingOuter + indentation}#shadow-root`, printChildren(children, config, indentation + config.indent, depth, refs, printer)].join("");
}
function printText(text, config) {
	const contentColor = config.colors.content;
	return contentColor.open + escapeHTML(text) + contentColor.close;
}
function printComment(comment, config) {
	const commentColor = config.colors.comment;
	return `${commentColor.open}<!--${escapeHTML(comment)}-->${commentColor.close}`;
}
function printElement(type, printedProps, printedChildren, config, indentation) {
	const tagColor = config.colors.tag;
	return `${tagColor.open}<${type}${printedProps && tagColor.close + printedProps + config.spacingOuter + indentation + tagColor.open}${printedChildren ? `>${tagColor.close}${printedChildren}${config.spacingOuter}${indentation}${tagColor.open}</${type}` : `${printedProps && !config.min ? "" : " "}/`}>${tagColor.close}`;
}
function printElementAsLeaf(type, config) {
	const tagColor = config.colors.tag;
	return `${tagColor.open}<${type}${tagColor.close} …${tagColor.open} />${tagColor.close}`;
}
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const FRAGMENT_NODE = 11;
const ELEMENT_REGEXP = /^(?:(?:HTML|SVG)\w*)?Element$/;
function testHasAttribute(val) {
	try {
		return typeof val.hasAttribute === "function" && val.hasAttribute("is");
	} catch {
		return false;
	}
}
function testNode(val) {
	const constructorName = val.constructor.name;
	const { nodeType, tagName } = val;
	const isCustomElement = typeof tagName === "string" && tagName.includes("-") || testHasAttribute(val);
	return nodeType === ELEMENT_NODE && (ELEMENT_REGEXP.test(constructorName) || isCustomElement) || nodeType === TEXT_NODE && constructorName === "Text" || nodeType === COMMENT_NODE && constructorName === "Comment" || nodeType === FRAGMENT_NODE && constructorName === "DocumentFragment";
}
const test$3 = (val) => val?.constructor?.name && testNode(val);
function nodeIsText(node) {
	return node.nodeType === TEXT_NODE;
}
function nodeIsComment(node) {
	return node.nodeType === COMMENT_NODE;
}
function nodeIsFragment(node) {
	return node.nodeType === FRAGMENT_NODE;
}
function filterChildren(children, filterNode) {
	let filtered = children.filter((node) => {
		if (node.nodeType === TEXT_NODE) return (node.data || "").trim().length > 0;
		return true;
	});
	if (filterNode) filtered = filtered.filter(filterNode);
	return filtered;
}
function serializeDOM(node, config, indentation, depth, refs, printer, filterNode) {
	if (nodeIsText(node)) return printText(node.data, config);
	if (nodeIsComment(node)) return printComment(node.data, config);
	const type = nodeIsFragment(node) ? "DocumentFragment" : node.tagName.toLowerCase();
	if (++depth > config.maxDepth) return printElementAsLeaf(type, config);
	const children = Array.prototype.slice.call(node.childNodes || node.children);
	const shadowChildren = nodeIsFragment(node) || !node.shadowRoot ? [] : Array.prototype.slice.call(node.shadowRoot.children);
	const resolvedChildren = filterNode ? filterChildren(children, filterNode) : children;
	const resolvedShadowChildren = filterNode ? filterChildren(shadowChildren, filterNode) : shadowChildren;
	return printElement(type, printProps(nodeIsFragment(node) ? [] : Array.from(node.attributes, (attr) => attr.name).sort(), nodeIsFragment(node) ? {} : [...node.attributes].reduce((props, attribute) => {
		props[attribute.name] = attribute.value;
		return props;
	}, {}), config, indentation + config.indent, depth, refs, printer), (resolvedShadowChildren.length > 0 ? printShadowRoot(resolvedShadowChildren, config, indentation + config.indent, depth, refs, printer) : "") + printChildren(resolvedChildren, config, indentation + config.indent, depth, refs, printer), config, indentation);
}
const serialize$3 = (node, config, indentation, depth, refs, printer) => serializeDOM(node, config, indentation, depth, refs, printer);
function createDOMElementFilter(filterNode) {
	return {
		test: test$3,
		serialize: (node, config, indentation, depth, refs, printer) => serializeDOM(node, config, indentation, depth, refs, printer, filterNode)
	};
}
const plugin$3 = {
	serialize: serialize$3,
	test: test$3
};
const IS_ITERABLE_SENTINEL = "@@__IMMUTABLE_ITERABLE__@@";
const IS_LIST_SENTINEL = "@@__IMMUTABLE_LIST__@@";
const IS_KEYED_SENTINEL = "@@__IMMUTABLE_KEYED__@@";
const IS_MAP_SENTINEL = "@@__IMMUTABLE_MAP__@@";
const IS_ORDERED_SENTINEL = "@@__IMMUTABLE_ORDERED__@@";
const IS_RECORD_SENTINEL = "@@__IMMUTABLE_RECORD__@@";
const IS_SEQ_SENTINEL = "@@__IMMUTABLE_SEQ__@@";
const IS_SET_SENTINEL = "@@__IMMUTABLE_SET__@@";
const IS_STACK_SENTINEL = "@@__IMMUTABLE_STACK__@@";
const getImmutableName = (name) => `Immutable.${name}`;
const printAsLeaf = (name) => `[${name}]`;
const SPACE = " ";
const LAZY = "…";
function printImmutableEntries(val, config, indentation, depth, refs, printer, type) {
	return ++depth > config.maxDepth ? printAsLeaf(getImmutableName(type)) : `${getImmutableName(type) + SPACE}{${printIteratorEntries(val.entries(), config, indentation, depth, refs, printer)}}`;
}
function getRecordEntries(val) {
	let i = 0;
	return { next() {
		if (i < val._keys.length) {
			const key = val._keys[i++];
			return {
				done: false,
				value: [key, val.get(key)]
			};
		}
		return {
			done: true,
			value: void 0
		};
	} };
}
function printImmutableRecord(val, config, indentation, depth, refs, printer) {
	const name = getImmutableName(val._name || "Record");
	return ++depth > config.maxDepth ? printAsLeaf(name) : `${name + SPACE}{${printIteratorEntries(getRecordEntries(val), config, indentation, depth, refs, printer)}}`;
}
function printImmutableSeq(val, config, indentation, depth, refs, printer) {
	const name = getImmutableName("Seq");
	if (++depth > config.maxDepth) return printAsLeaf(name);
	if (val[IS_KEYED_SENTINEL]) return `${name + SPACE}{${val._iter || val._object ? printIteratorEntries(val.entries(), config, indentation, depth, refs, printer) : LAZY}}`;
	return `${name + SPACE}[${val._iter || val._array || val._collection || val._iterable ? printIteratorValues(val.values(), config, indentation, depth, refs, printer) : LAZY}]`;
}
function printImmutableValues(val, config, indentation, depth, refs, printer, type) {
	return ++depth > config.maxDepth ? printAsLeaf(getImmutableName(type)) : `${getImmutableName(type) + SPACE}[${printIteratorValues(val.values(), config, indentation, depth, refs, printer)}]`;
}
const serialize$2 = (val, config, indentation, depth, refs, printer) => {
	if (val[IS_MAP_SENTINEL]) return printImmutableEntries(val, config, indentation, depth, refs, printer, val[IS_ORDERED_SENTINEL] ? "OrderedMap" : "Map");
	if (val[IS_LIST_SENTINEL]) return printImmutableValues(val, config, indentation, depth, refs, printer, "List");
	if (val[IS_SET_SENTINEL]) return printImmutableValues(val, config, indentation, depth, refs, printer, val[IS_ORDERED_SENTINEL] ? "OrderedSet" : "Set");
	if (val[IS_STACK_SENTINEL]) return printImmutableValues(val, config, indentation, depth, refs, printer, "Stack");
	if (val[IS_SEQ_SENTINEL]) return printImmutableSeq(val, config, indentation, depth, refs, printer);
	return printImmutableRecord(val, config, indentation, depth, refs, printer);
};
const test$2 = (val) => val && (val[IS_ITERABLE_SENTINEL] === true || val[IS_RECORD_SENTINEL] === true);
const plugin$2 = {
	serialize: serialize$2,
	test: test$2
};
function getDefaultExportFromCjs$1(x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
var reactIs$1 = { exports: {} };
var reactIs_production = {};
/**
* @license React
* react-is.production.js
*
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/
var hasRequiredReactIs_production;
function requireReactIs_production() {
	if (hasRequiredReactIs_production) return reactIs_production;
	hasRequiredReactIs_production = 1;
	var REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = Symbol.for("react.memo"), REACT_LAZY_TYPE = Symbol.for("react.lazy"), REACT_VIEW_TRANSITION_TYPE = Symbol.for("react.view_transition"), REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference");
	function typeOf(object) {
		if ("object" === typeof object && null !== object) {
			var $$typeof = object.$$typeof;
			switch ($$typeof) {
				case REACT_ELEMENT_TYPE: switch (object = object.type, object) {
					case REACT_FRAGMENT_TYPE:
					case REACT_PROFILER_TYPE:
					case REACT_STRICT_MODE_TYPE:
					case REACT_SUSPENSE_TYPE:
					case REACT_SUSPENSE_LIST_TYPE:
					case REACT_VIEW_TRANSITION_TYPE: return object;
					default: switch (object = object && object.$$typeof, object) {
						case REACT_CONTEXT_TYPE:
						case REACT_FORWARD_REF_TYPE:
						case REACT_LAZY_TYPE:
						case REACT_MEMO_TYPE: return object;
						case REACT_CONSUMER_TYPE: return object;
						default: return $$typeof;
					}
				}
				case REACT_PORTAL_TYPE: return $$typeof;
			}
		}
	}
	reactIs_production.ContextConsumer = REACT_CONSUMER_TYPE;
	reactIs_production.ContextProvider = REACT_CONTEXT_TYPE;
	reactIs_production.Element = REACT_ELEMENT_TYPE;
	reactIs_production.ForwardRef = REACT_FORWARD_REF_TYPE;
	reactIs_production.Fragment = REACT_FRAGMENT_TYPE;
	reactIs_production.Lazy = REACT_LAZY_TYPE;
	reactIs_production.Memo = REACT_MEMO_TYPE;
	reactIs_production.Portal = REACT_PORTAL_TYPE;
	reactIs_production.Profiler = REACT_PROFILER_TYPE;
	reactIs_production.StrictMode = REACT_STRICT_MODE_TYPE;
	reactIs_production.Suspense = REACT_SUSPENSE_TYPE;
	reactIs_production.SuspenseList = REACT_SUSPENSE_LIST_TYPE;
	reactIs_production.isContextConsumer = function(object) {
		return typeOf(object) === REACT_CONSUMER_TYPE;
	};
	reactIs_production.isContextProvider = function(object) {
		return typeOf(object) === REACT_CONTEXT_TYPE;
	};
	reactIs_production.isElement = function(object) {
		return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
	};
	reactIs_production.isForwardRef = function(object) {
		return typeOf(object) === REACT_FORWARD_REF_TYPE;
	};
	reactIs_production.isFragment = function(object) {
		return typeOf(object) === REACT_FRAGMENT_TYPE;
	};
	reactIs_production.isLazy = function(object) {
		return typeOf(object) === REACT_LAZY_TYPE;
	};
	reactIs_production.isMemo = function(object) {
		return typeOf(object) === REACT_MEMO_TYPE;
	};
	reactIs_production.isPortal = function(object) {
		return typeOf(object) === REACT_PORTAL_TYPE;
	};
	reactIs_production.isProfiler = function(object) {
		return typeOf(object) === REACT_PROFILER_TYPE;
	};
	reactIs_production.isStrictMode = function(object) {
		return typeOf(object) === REACT_STRICT_MODE_TYPE;
	};
	reactIs_production.isSuspense = function(object) {
		return typeOf(object) === REACT_SUSPENSE_TYPE;
	};
	reactIs_production.isSuspenseList = function(object) {
		return typeOf(object) === REACT_SUSPENSE_LIST_TYPE;
	};
	reactIs_production.isValidElementType = function(type) {
		return "string" === typeof type || "function" === typeof type || type === REACT_FRAGMENT_TYPE || type === REACT_PROFILER_TYPE || type === REACT_STRICT_MODE_TYPE || type === REACT_SUSPENSE_TYPE || type === REACT_SUSPENSE_LIST_TYPE || "object" === typeof type && null !== type && (type.$$typeof === REACT_LAZY_TYPE || type.$$typeof === REACT_MEMO_TYPE || type.$$typeof === REACT_CONTEXT_TYPE || type.$$typeof === REACT_CONSUMER_TYPE || type.$$typeof === REACT_FORWARD_REF_TYPE || type.$$typeof === REACT_CLIENT_REFERENCE || void 0 !== type.getModuleId) ? true : false;
	};
	reactIs_production.typeOf = typeOf;
	return reactIs_production;
}
var hasRequiredReactIs$1;
function requireReactIs$1() {
	if (hasRequiredReactIs$1) return reactIs$1.exports;
	hasRequiredReactIs$1 = 1;
	reactIs$1.exports = requireReactIs_production();
	return reactIs$1.exports;
}
var reactIsExports$1 = requireReactIs$1();
var ReactIs19 = /* @__PURE__ */ _mergeNamespaces({
	__proto__: null,
	default: /* @__PURE__ */ getDefaultExportFromCjs$1(reactIsExports$1)
}, [reactIsExports$1]);
var reactIs = { exports: {} };
var reactIs_production_min = {};
/**
* @license React
* react-is.production.min.js
*
* Copyright (c) Facebook, Inc. and its affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/
var hasRequiredReactIs_production_min;
function requireReactIs_production_min() {
	if (hasRequiredReactIs_production_min) return reactIs_production_min;
	hasRequiredReactIs_production_min = 1;
	var b = Symbol.for("react.element"), c = Symbol.for("react.portal"), d = Symbol.for("react.fragment"), e = Symbol.for("react.strict_mode"), f = Symbol.for("react.profiler"), g = Symbol.for("react.provider"), h = Symbol.for("react.context"), k = Symbol.for("react.server_context"), l = Symbol.for("react.forward_ref"), m = Symbol.for("react.suspense"), n = Symbol.for("react.suspense_list"), p = Symbol.for("react.memo"), q = Symbol.for("react.lazy"), t = Symbol.for("react.offscreen"), u = Symbol.for("react.module.reference");
	function v(a) {
		if ("object" === typeof a && null !== a) {
			var r = a.$$typeof;
			switch (r) {
				case b: switch (a = a.type, a) {
					case d:
					case f:
					case e:
					case m:
					case n: return a;
					default: switch (a = a && a.$$typeof, a) {
						case k:
						case h:
						case l:
						case q:
						case p:
						case g: return a;
						default: return r;
					}
				}
				case c: return r;
			}
		}
	}
	reactIs_production_min.ContextConsumer = h;
	reactIs_production_min.ContextProvider = g;
	reactIs_production_min.Element = b;
	reactIs_production_min.ForwardRef = l;
	reactIs_production_min.Fragment = d;
	reactIs_production_min.Lazy = q;
	reactIs_production_min.Memo = p;
	reactIs_production_min.Portal = c;
	reactIs_production_min.Profiler = f;
	reactIs_production_min.StrictMode = e;
	reactIs_production_min.Suspense = m;
	reactIs_production_min.SuspenseList = n;
	reactIs_production_min.isAsyncMode = function() {
		return false;
	};
	reactIs_production_min.isConcurrentMode = function() {
		return false;
	};
	reactIs_production_min.isContextConsumer = function(a) {
		return v(a) === h;
	};
	reactIs_production_min.isContextProvider = function(a) {
		return v(a) === g;
	};
	reactIs_production_min.isElement = function(a) {
		return "object" === typeof a && null !== a && a.$$typeof === b;
	};
	reactIs_production_min.isForwardRef = function(a) {
		return v(a) === l;
	};
	reactIs_production_min.isFragment = function(a) {
		return v(a) === d;
	};
	reactIs_production_min.isLazy = function(a) {
		return v(a) === q;
	};
	reactIs_production_min.isMemo = function(a) {
		return v(a) === p;
	};
	reactIs_production_min.isPortal = function(a) {
		return v(a) === c;
	};
	reactIs_production_min.isProfiler = function(a) {
		return v(a) === f;
	};
	reactIs_production_min.isStrictMode = function(a) {
		return v(a) === e;
	};
	reactIs_production_min.isSuspense = function(a) {
		return v(a) === m;
	};
	reactIs_production_min.isSuspenseList = function(a) {
		return v(a) === n;
	};
	reactIs_production_min.isValidElementType = function(a) {
		return "string" === typeof a || "function" === typeof a || a === d || a === f || a === e || a === m || a === n || a === t || "object" === typeof a && null !== a && (a.$$typeof === q || a.$$typeof === p || a.$$typeof === g || a.$$typeof === h || a.$$typeof === l || a.$$typeof === u || void 0 !== a.getModuleId) ? true : false;
	};
	reactIs_production_min.typeOf = v;
	return reactIs_production_min;
}
var hasRequiredReactIs;
function requireReactIs() {
	if (hasRequiredReactIs) return reactIs.exports;
	hasRequiredReactIs = 1;
	reactIs.exports = requireReactIs_production_min();
	return reactIs.exports;
}
var reactIsExports = requireReactIs();
var ReactIs18 = /* @__PURE__ */ _mergeNamespaces({
	__proto__: null,
	default: /* @__PURE__ */ getDefaultExportFromCjs$1(reactIsExports)
}, [reactIsExports]);
const ReactIs = Object.fromEntries([
	"isAsyncMode",
	"isConcurrentMode",
	"isContextConsumer",
	"isContextProvider",
	"isElement",
	"isForwardRef",
	"isFragment",
	"isLazy",
	"isMemo",
	"isPortal",
	"isProfiler",
	"isStrictMode",
	"isSuspense",
	"isSuspenseList",
	"isValidElementType"
].map((m) => [m, (v) => ReactIs18[m](v) || ReactIs19[m](v)]));
function getChildren(arg, children = []) {
	if (Array.isArray(arg)) for (const item of arg) getChildren(item, children);
	else if (arg != null && arg !== false && arg !== "") children.push(arg);
	return children;
}
function getType$2(element) {
	const type = element.type;
	if (typeof type === "string") return type;
	if (typeof type === "function") return type.displayName || type.name || "Unknown";
	if (ReactIs.isFragment(element)) return "React.Fragment";
	if (ReactIs.isSuspense(element)) return "React.Suspense";
	if (typeof type === "object" && type !== null) {
		if (ReactIs.isContextProvider(element)) return "Context.Provider";
		if (ReactIs.isContextConsumer(element)) return "Context.Consumer";
		if (ReactIs.isForwardRef(element)) {
			if (type.displayName) return type.displayName;
			const functionName = type.render.displayName || type.render.name || "";
			return functionName === "" ? "ForwardRef" : `ForwardRef(${functionName})`;
		}
		if (ReactIs.isMemo(element)) {
			const functionName = type.displayName || type.type.displayName || type.type.name || "";
			return functionName === "" ? "Memo" : `Memo(${functionName})`;
		}
	}
	return "UNDEFINED";
}
function getPropKeys$1(element) {
	const { props } = element;
	return Object.keys(props).filter((key) => key !== "children" && props[key] !== void 0).sort();
}
const serialize$1 = (element, config, indentation, depth, refs, printer) => ++depth > config.maxDepth ? printElementAsLeaf(getType$2(element), config) : printElement(getType$2(element), printProps(getPropKeys$1(element), element.props, config, indentation + config.indent, depth, refs, printer), printChildren(getChildren(element.props.children), config, indentation + config.indent, depth, refs, printer), config, indentation);
const test$1 = (val) => val != null && ReactIs.isElement(val);
const plugin$1 = {
	serialize: serialize$1,
	test: test$1
};
const testSymbol = typeof Symbol === "function" && Symbol.for ? Symbol.for("react.test.json") : 245830487;
function getPropKeys(object) {
	const { props } = object;
	return props ? Object.keys(props).filter((key) => props[key] !== void 0).sort() : [];
}
const serialize = (object, config, indentation, depth, refs, printer) => ++depth > config.maxDepth ? printElementAsLeaf(object.type, config) : printElement(object.type, object.props ? printProps(getPropKeys(object), object.props, config, indentation + config.indent, depth, refs, printer) : "", object.children ? printChildren(object.children, config, indentation + config.indent, depth, refs, printer) : "", config, indentation);
const test$6 = (val) => val && val.$$typeof === testSymbol;
const plugin = {
	serialize,
	test: test$6
};
const toString$1 = Object.prototype.toString;
const toISOString = Date.prototype.toISOString;
const errorToString = Error.prototype.toString;
const regExpToString = RegExp.prototype.toString;
/**
* Explicitly comparing typeof constructor to function avoids undefined as name
* when mock identity-obj-proxy returns the key as the value for any key.
*/
function getConstructorName(val) {
	return typeof val.constructor === "function" && val.constructor.name || "Object";
}
/** Is val is equal to global window object? Works even if it does not exist :) */
function isWindow(val) {
	return typeof window !== "undefined" && val === window;
}
const SYMBOL_REGEXP = /^Symbol\((.*)\)(.*)$/;
const NEWLINE_REGEXP = /\n/g;
var PrettyFormatPluginError = class extends Error {
	constructor(message, stack) {
		super(message);
		this.stack = stack;
		this.name = this.constructor.name;
	}
};
function isToStringedArrayType(toStringed) {
	return toStringed === "[object Array]" || toStringed === "[object ArrayBuffer]" || toStringed === "[object DataView]" || toStringed === "[object Float32Array]" || toStringed === "[object Float64Array]" || toStringed === "[object Int8Array]" || toStringed === "[object Int16Array]" || toStringed === "[object Int32Array]" || toStringed === "[object Uint8Array]" || toStringed === "[object Uint8ClampedArray]" || toStringed === "[object Uint16Array]" || toStringed === "[object Uint32Array]";
}
function printNumber(val) {
	return Object.is(val, -0) ? "-0" : String(val);
}
function printBigInt(val) {
	return String(`${val}n`);
}
function printFunction(val, printFunctionName) {
	if (!printFunctionName) return "[Function]";
	return `[Function ${val.name || "anonymous"}]`;
}
function printSymbol(val) {
	return String(val).replace(SYMBOL_REGEXP, "Symbol($1)");
}
function printError(val) {
	return `[${errorToString.call(val)}]`;
}
/**
* The first port of call for printing an object, handles most of the
* data-types in JS.
*/
function printBasicValue(val, printFunctionName, escapeRegex, escapeString) {
	if (val === true || val === false) return `${val}`;
	if (val === void 0) return "undefined";
	if (val === null) return "null";
	const typeOf = typeof val;
	if (typeOf === "number") return printNumber(val);
	if (typeOf === "bigint") return printBigInt(val);
	if (typeOf === "string") {
		if (escapeString) return `"${val.replaceAll(/"|\\/g, "\\$&")}"`;
		return `"${val}"`;
	}
	if (typeOf === "function") return printFunction(val, printFunctionName);
	if (typeOf === "symbol") return printSymbol(val);
	const toStringed = toString$1.call(val);
	if (toStringed === "[object WeakMap]") return "WeakMap {}";
	if (toStringed === "[object WeakSet]") return "WeakSet {}";
	if (toStringed === "[object Function]" || toStringed === "[object GeneratorFunction]") return printFunction(val, printFunctionName);
	if (toStringed === "[object Symbol]") return printSymbol(val);
	if (toStringed === "[object Date]") return Number.isNaN(+val) ? "Date { NaN }" : toISOString.call(val);
	if (toStringed === "[object Error]") return printError(val);
	if (toStringed === "[object RegExp]") {
		if (escapeRegex) return regExpToString.call(val).replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&");
		return regExpToString.call(val);
	}
	if (val instanceof Error) return printError(val);
	return null;
}
/**
* Handles more complex objects ( such as objects with circular references.
* maps and sets etc )
*/
function printComplexValue(val, config, indentation, depth, refs, hasCalledToJSON) {
	if (refs.includes(val)) return "[Circular]";
	refs = [...refs];
	refs.push(val);
	const hitMaxDepth = ++depth > config.maxDepth;
	const min = config.min;
	if (config.callToJSON && !hitMaxDepth && val.toJSON && typeof val.toJSON === "function" && !hasCalledToJSON) return printer(val.toJSON(), config, indentation, depth, refs, true);
	const toStringed = toString$1.call(val);
	if (toStringed === "[object Arguments]") return hitMaxDepth ? "[Arguments]" : `${min ? "" : "Arguments "}[${printListItems(val, config, indentation, depth, refs, printer)}]`;
	if (isToStringedArrayType(toStringed)) return hitMaxDepth ? `[${val.constructor.name}]` : `${min ? "" : !config.printBasicPrototype && val.constructor.name === "Array" ? "" : `${val.constructor.name} `}[${printListItems(val, config, indentation, depth, refs, printer)}]`;
	if (toStringed === "[object Map]") return hitMaxDepth ? "[Map]" : `Map {${printIteratorEntries(val.entries(), config, indentation, depth, refs, printer, " => ")}}`;
	if (toStringed === "[object Set]") return hitMaxDepth ? "[Set]" : `Set {${printIteratorValues(val.values(), config, indentation, depth, refs, printer)}}`;
	return hitMaxDepth || isWindow(val) ? `[${getConstructorName(val)}]` : `${min ? "" : !config.printBasicPrototype && getConstructorName(val) === "Object" ? "" : `${getConstructorName(val)} `}{${printObjectProperties(val, config, indentation, depth, refs, printer)}}`;
}
const ErrorPlugin = {
	test: (val) => val && val instanceof Error,
	serialize(val, config, indentation, depth, refs, printer) {
		if (refs.includes(val)) return "[Circular]";
		refs = [...refs, val];
		const hitMaxDepth = ++depth > config.maxDepth;
		const { message, cause, ...rest } = val;
		const entries = {
			message,
			...typeof cause !== "undefined" ? { cause } : {},
			...val instanceof AggregateError ? { errors: val.errors } : {},
			...rest
		};
		const name = val.name !== "Error" ? val.name : getConstructorName(val);
		return hitMaxDepth ? `[${name}]` : `${name} {${printIteratorEntries(Object.entries(entries).values(), config, indentation, depth, refs, printer)}}`;
	}
};
function isNewPlugin(plugin) {
	return plugin.serialize != null;
}
function printPlugin(plugin, val, config, indentation, depth, refs) {
	let printed;
	try {
		printed = isNewPlugin(plugin) ? plugin.serialize(val, config, indentation, depth, refs, printer) : plugin.print(val, (valChild) => printer(valChild, config, indentation, depth, refs), (str) => {
			const indentationNext = indentation + config.indent;
			return indentationNext + str.replaceAll(NEWLINE_REGEXP, `\n${indentationNext}`);
		}, {
			edgeSpacing: config.spacingOuter,
			min: config.min,
			spacing: config.spacingInner
		}, config.colors);
	} catch (error) {
		throw new PrettyFormatPluginError(error.message, error.stack);
	}
	if (typeof printed !== "string") throw new TypeError(`pretty-format: Plugin must return type "string" but instead returned "${typeof printed}".`);
	return printed;
}
function findPlugin(plugins, val) {
	for (const plugin of plugins) try {
		if (plugin.test(val)) return plugin;
	} catch (error) {
		throw new PrettyFormatPluginError(error.message, error.stack);
	}
	return null;
}
function printer(val, config, indentation, depth, refs, hasCalledToJSON) {
	let result;
	const plugin = findPlugin(config.plugins, val);
	if (plugin !== null) result = printPlugin(plugin, val, config, indentation, depth, refs);
	else {
		const basicResult = printBasicValue(val, config.printFunctionName, config.escapeRegex, config.escapeString);
		if (basicResult !== null) result = basicResult;
		else result = printComplexValue(val, config, indentation, depth, refs, hasCalledToJSON);
	}
	config._outputLengthPerDepth[depth] ??= 0;
	config._outputLengthPerDepth[depth] += result.length;
	if (config._outputLengthPerDepth[depth] > config.maxOutputLength) config.maxDepth = 0;
	return result;
}
const DEFAULT_THEME = {
	comment: "gray",
	content: "reset",
	prop: "yellow",
	tag: "cyan",
	value: "green"
};
const DEFAULT_THEME_KEYS = Object.keys(DEFAULT_THEME);
const DEFAULT_OPTIONS = {
	callToJSON: true,
	compareKeys: void 0,
	escapeRegex: false,
	escapeString: true,
	highlight: false,
	indent: 2,
	maxDepth: Number.POSITIVE_INFINITY,
	maxOutputLength: 1e6,
	maxWidth: Number.POSITIVE_INFINITY,
	min: false,
	plugins: [],
	printBasicPrototype: true,
	printFunctionName: true,
	printShadowRoot: true,
	theme: DEFAULT_THEME
};
function validateOptions(options) {
	for (const key of Object.keys(options)) if (!Object.hasOwn(DEFAULT_OPTIONS, key)) throw new Error(`pretty-format: Unknown option "${key}".`);
	if (options.min && options.indent !== void 0 && options.indent !== 0) throw new Error("pretty-format: Options \"min\" and \"indent\" cannot be used together.");
}
function getColorsHighlight() {
	return DEFAULT_THEME_KEYS.reduce((colors, key) => {
		const value = DEFAULT_THEME[key];
		const color = value && y[value];
		if (color && typeof color.close === "string" && typeof color.open === "string") colors[key] = color;
		else throw new Error(`pretty-format: Option "theme" has a key "${key}" whose value "${value}" is undefined in ansi-styles.`);
		return colors;
	}, Object.create(null));
}
function getColorsEmpty() {
	return DEFAULT_THEME_KEYS.reduce((colors, key) => {
		colors[key] = {
			close: "",
			open: ""
		};
		return colors;
	}, Object.create(null));
}
function getPrintFunctionName(options) {
	return options?.printFunctionName ?? DEFAULT_OPTIONS.printFunctionName;
}
function getEscapeRegex(options) {
	return options?.escapeRegex ?? DEFAULT_OPTIONS.escapeRegex;
}
function getEscapeString(options) {
	return options?.escapeString ?? DEFAULT_OPTIONS.escapeString;
}
function getConfig(options) {
	return {
		callToJSON: options?.callToJSON ?? DEFAULT_OPTIONS.callToJSON,
		colors: options?.highlight ? getColorsHighlight() : getColorsEmpty(),
		compareKeys: typeof options?.compareKeys === "function" || options?.compareKeys === null ? options.compareKeys : DEFAULT_OPTIONS.compareKeys,
		escapeRegex: getEscapeRegex(options),
		escapeString: getEscapeString(options),
		indent: options?.min ? "" : createIndent(options?.indent ?? DEFAULT_OPTIONS.indent),
		maxDepth: options?.maxDepth ?? DEFAULT_OPTIONS.maxDepth,
		maxWidth: options?.maxWidth ?? DEFAULT_OPTIONS.maxWidth,
		min: options?.min ?? DEFAULT_OPTIONS.min,
		plugins: options?.plugins ?? DEFAULT_OPTIONS.plugins,
		printBasicPrototype: options?.printBasicPrototype ?? true,
		printFunctionName: getPrintFunctionName(options),
		printShadowRoot: options?.printShadowRoot ?? true,
		spacingInner: options?.min ? " " : "\n",
		spacingOuter: options?.min ? "" : "\n",
		maxOutputLength: options?.maxOutputLength ?? DEFAULT_OPTIONS.maxOutputLength,
		_outputLengthPerDepth: []
	};
}
function createIndent(indent) {
	return Array.from({ length: indent + 1 }).join(" ");
}
/**
* Returns a presentation string of your `val` object
* @param val any potential JavaScript object
* @param options Custom settings
*/
function format$1(val, options) {
	if (options) {
		validateOptions(options);
		if (options.plugins) {
			const plugin = findPlugin(options.plugins, val);
			if (plugin !== null) return printPlugin(plugin, val, getConfig(options), "", 0, []);
		}
	}
	const basicResult = printBasicValue(val, getPrintFunctionName(options), getEscapeRegex(options), getEscapeString(options));
	if (basicResult !== null) return basicResult;
	return printComplexValue(val, getConfig(options), "", 0, []);
}
const plugins = {
	AsymmetricMatcher: plugin$5,
	DOMCollection: plugin$4,
	DOMElement: plugin$3,
	Immutable: plugin$2,
	ReactElement: plugin$1,
	ReactTestComponent: plugin,
	Error: ErrorPlugin
};
//#endregion
//#region node_modules/@vitest/utils/dist/display.js
const ansiColors = {
	bold: ["1", "22"],
	dim: ["2", "22"],
	italic: ["3", "23"],
	underline: ["4", "24"],
	inverse: ["7", "27"],
	hidden: ["8", "28"],
	strike: ["9", "29"],
	black: ["30", "39"],
	red: ["31", "39"],
	green: ["32", "39"],
	yellow: ["33", "39"],
	blue: ["34", "39"],
	magenta: ["35", "39"],
	cyan: ["36", "39"],
	white: ["37", "39"],
	brightblack: ["30;1", "39"],
	brightred: ["31;1", "39"],
	brightgreen: ["32;1", "39"],
	brightyellow: ["33;1", "39"],
	brightblue: ["34;1", "39"],
	brightmagenta: ["35;1", "39"],
	brightcyan: ["36;1", "39"],
	brightwhite: ["37;1", "39"],
	grey: ["90", "39"]
};
const styles = {
	special: "cyan",
	number: "yellow",
	bigint: "yellow",
	boolean: "yellow",
	undefined: "grey",
	null: "bold",
	string: "green",
	symbol: "green",
	date: "magenta",
	regexp: "red"
};
const truncator = "…";
function colorise(value, styleType) {
	const color = ansiColors[styles[styleType]] || ansiColors[styleType] || "";
	if (!color) return String(value);
	return `\u001b[${color[0]}m${String(value)}\u001b[${color[1]}m`;
}
function normaliseOptions({ showHidden = false, depth = 2, colors = false, customInspect = true, showProxy = false, maxArrayLength = Infinity, breakLength = Infinity, seen = [], truncate = Infinity, stylize = String } = {}, inspect) {
	const options = {
		showHidden: Boolean(showHidden),
		depth: Number(depth),
		colors: Boolean(colors),
		customInspect: Boolean(customInspect),
		showProxy: Boolean(showProxy),
		maxArrayLength: Number(maxArrayLength),
		breakLength: Number(breakLength),
		truncate: Number(truncate),
		seen,
		inspect,
		stylize
	};
	if (options.colors) options.stylize = colorise;
	return options;
}
function isHighSurrogate(char) {
	return char >= "\ud800" && char <= "\udbff";
}
function truncate(string, length, tail = truncator) {
	string = String(string);
	const tailLength = tail.length;
	const stringLength = string.length;
	if (tailLength > length && stringLength > tailLength) return tail;
	if (stringLength > length && stringLength > tailLength) {
		let end = length - tailLength;
		if (end > 0 && isHighSurrogate(string[end - 1])) end = end - 1;
		return `${string.slice(0, end)}${tail}`;
	}
	return string;
}
function inspectList(list, options, inspectItem, separator = ", ") {
	inspectItem = inspectItem || options.inspect;
	const size = list.length;
	if (size === 0) return "";
	const originalLength = options.truncate;
	let output = "";
	let peek = "";
	let truncated = "";
	for (let i = 0; i < size; i += 1) {
		const last = i + 1 === list.length;
		const secondToLast = i + 2 === list.length;
		truncated = `${truncator}(${list.length - i})`;
		const value = list[i];
		options.truncate = originalLength - output.length - (last ? 0 : separator.length);
		const string = peek || inspectItem(value, options) + (last ? "" : separator);
		const nextLength = output.length + string.length;
		const truncatedLength = nextLength + truncated.length;
		if (last && nextLength > originalLength && output.length + truncated.length <= originalLength) break;
		if (!last && !secondToLast && truncatedLength > originalLength) break;
		peek = last ? "" : inspectItem(list[i + 1], options) + (secondToLast ? "" : separator);
		if (!last && secondToLast && truncatedLength > originalLength && nextLength + peek.length > originalLength) break;
		output += string;
		if (!last && !secondToLast && nextLength + peek.length >= originalLength) {
			truncated = `${truncator}(${list.length - i - 1})`;
			break;
		}
		truncated = "";
	}
	return `${output}${truncated}`;
}
function quoteComplexKey(key) {
	if (key.match(/^[a-zA-Z_][a-zA-Z_0-9]*$/)) return key;
	return JSON.stringify(key).replace(/'/g, "\\'").replace(/\\"/g, "\"").replace(/(^"|"$)/g, "'");
}
function inspectProperty([key, value], options) {
	options.truncate -= 2;
	if (typeof key === "string") key = quoteComplexKey(key);
	else if (typeof key !== "number") key = `[${options.inspect(key, options)}]`;
	options.truncate -= key.length;
	value = options.inspect(value, options);
	return `${key}: ${value}`;
}
function inspectArray(array, options) {
	const nonIndexProperties = Object.keys(array).slice(array.length);
	if (!array.length && !nonIndexProperties.length) return "[]";
	options.truncate -= 4;
	const listContents = inspectList(array, options);
	options.truncate -= listContents.length;
	let propertyContents = "";
	if (nonIndexProperties.length) propertyContents = inspectList(nonIndexProperties.map((key) => [key, array[key]]), options, inspectProperty);
	return `[ ${listContents}${propertyContents ? `, ${propertyContents}` : ""} ]`;
}
const getArrayName = (array) => {
	if (typeof Buffer === "function" && array instanceof Buffer) return "Buffer";
	if (array[Symbol.toStringTag]) return array[Symbol.toStringTag];
	return array.constructor.name;
};
function inspectTypedArray(array, options) {
	const name = getArrayName(array);
	options.truncate -= name.length + 4;
	const nonIndexProperties = Object.keys(array).slice(array.length);
	if (!array.length && !nonIndexProperties.length) return `${name}[]`;
	let output = "";
	for (let i = 0; i < array.length; i++) {
		const string = `${options.stylize(truncate(array[i], options.truncate), "number")}${i === array.length - 1 ? "" : ", "}`;
		options.truncate -= string.length;
		if (array[i] !== array.length && options.truncate <= 3) {
			output += `${truncator}(${array.length - array[i] + 1})`;
			break;
		}
		output += string;
	}
	let propertyContents = "";
	if (nonIndexProperties.length) propertyContents = inspectList(nonIndexProperties.map((key) => [key, array[key]]), options, inspectProperty);
	return `${name}[ ${output}${propertyContents ? `, ${propertyContents}` : ""} ]`;
}
function inspectDate(dateObject, options) {
	const stringRepresentation = dateObject.toJSON();
	if (stringRepresentation === null) return "Invalid Date";
	const split = stringRepresentation.split("T");
	const date = split[0];
	return options.stylize(`${date}T${truncate(split[1], options.truncate - date.length - 1)}`, "date");
}
function inspectFunction(func, options) {
	const functionType = func[Symbol.toStringTag] || "Function";
	const name = func.name;
	if (!name) return options.stylize(`[${functionType}]`, "special");
	return options.stylize(`[${functionType} ${truncate(name, options.truncate - 11)}]`, "special");
}
function inspectMapEntry([key, value], options) {
	options.truncate -= 4;
	key = options.inspect(key, options);
	options.truncate -= key.length;
	value = options.inspect(value, options);
	return `${key} => ${value}`;
}
function mapToEntries(map) {
	const entries = [];
	map.forEach((value, key) => {
		entries.push([key, value]);
	});
	return entries;
}
function inspectMap(map, options) {
	if (map.size === 0) return "Map{}";
	options.truncate -= 7;
	return `Map{ ${inspectList(mapToEntries(map), options, inspectMapEntry)} }`;
}
const isNaN = Number.isNaN || ((i) => i !== i);
function inspectNumber(number, options) {
	if (isNaN(number)) return options.stylize("NaN", "number");
	if (number === Infinity) return options.stylize("Infinity", "number");
	if (number === -Infinity) return options.stylize("-Infinity", "number");
	if (number === 0) return options.stylize(1 / number === Infinity ? "+0" : "-0", "number");
	return options.stylize(truncate(String(number), options.truncate), "number");
}
function inspectBigInt(number, options) {
	let nums = truncate(number.toString(), options.truncate - 1);
	if (nums !== truncator) nums += "n";
	return options.stylize(nums, "bigint");
}
function inspectRegExp(value, options) {
	const flags = value.toString().split("/")[2];
	const sourceLength = options.truncate - (2 + flags.length);
	const source = value.source;
	return options.stylize(`/${truncate(source, sourceLength)}/${flags}`, "regexp");
}
function arrayFromSet(set) {
	const values = [];
	set.forEach((value) => {
		values.push(value);
	});
	return values;
}
function inspectSet(set, options) {
	if (set.size === 0) return "Set{}";
	options.truncate -= 7;
	return `Set{ ${inspectList(arrayFromSet(set), options)} }`;
}
const stringEscapeChars = /* @__PURE__ */ new RegExp("['\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0604\\u070f\\u17b4\\u17b5\\u200c-\\u200f\\u2028-\\u202f\\u2060-\\u206f\\ufeff\\ufff0-\\uffff]", "g");
const escapeCharacters = {
	"\b": "\\b",
	"	": "\\t",
	"\n": "\\n",
	"\f": "\\f",
	"\r": "\\r",
	"'": "\\'",
	"\\": "\\\\"
};
const hex = 16;
function escape(char) {
	return escapeCharacters[char] || `\\u${`0000${char.charCodeAt(0).toString(hex)}`.slice(-4)}`;
}
function inspectString(string, options) {
	if (stringEscapeChars.test(string)) string = string.replace(stringEscapeChars, escape);
	return options.stylize(`'${truncate(string, options.truncate - 2)}'`, "string");
}
function inspectSymbol(value) {
	if ("description" in Symbol.prototype) return value.description ? `Symbol(${value.description})` : "Symbol()";
	return value.toString();
}
const getPromiseValue = () => "Promise{…}";
function inspectObject$1(object, options) {
	const properties = Object.getOwnPropertyNames(object);
	const symbols = Object.getOwnPropertySymbols ? Object.getOwnPropertySymbols(object) : [];
	if (properties.length === 0 && symbols.length === 0) return "{}";
	options.truncate -= 4;
	options.seen = options.seen || [];
	if (options.seen.includes(object)) return "[Circular]";
	options.seen.push(object);
	const propertyContents = inspectList(properties.map((key) => [key, object[key]]), options, inspectProperty);
	const symbolContents = inspectList(symbols.map((key) => [key, object[key]]), options, inspectProperty);
	options.seen.pop();
	let sep = "";
	if (propertyContents && symbolContents) sep = ", ";
	return `{ ${propertyContents}${sep}${symbolContents} }`;
}
const toStringTag = typeof Symbol !== "undefined" && Symbol.toStringTag ? Symbol.toStringTag : false;
function inspectClass(value, options) {
	let name = "";
	if (toStringTag && toStringTag in value) name = value[toStringTag];
	name = name || value.constructor.name;
	if (!name || name === "_class") name = "<Anonymous Class>";
	options.truncate -= name.length;
	return `${name}${inspectObject$1(value, options)}`;
}
function inspectArguments(args, options) {
	if (args.length === 0) return "Arguments[]";
	options.truncate -= 13;
	return `Arguments[ ${inspectList(args, options)} ]`;
}
const errorKeys = [
	"stack",
	"line",
	"column",
	"name",
	"message",
	"fileName",
	"lineNumber",
	"columnNumber",
	"number",
	"description",
	"cause"
];
function inspectObject(error, options) {
	const properties = Object.getOwnPropertyNames(error).filter((key) => errorKeys.indexOf(key) === -1);
	const name = error.name;
	options.truncate -= name.length;
	let message = "";
	if (typeof error.message === "string") message = truncate(error.message, options.truncate);
	else properties.unshift("message");
	message = message ? `: ${message}` : "";
	options.truncate -= message.length + 5;
	options.seen = options.seen || [];
	if (options.seen.includes(error)) return "[Circular]";
	options.seen.push(error);
	const propertyContents = inspectList(properties.map((key) => [key, error[key]]), options, inspectProperty);
	return `${name}${message}${propertyContents ? ` { ${propertyContents} }` : ""}`;
}
function inspectAttribute([key, value], options) {
	options.truncate -= 3;
	if (!value) return `${options.stylize(String(key), "yellow")}`;
	return `${options.stylize(String(key), "yellow")}=${options.stylize(`"${value}"`, "string")}`;
}
function inspectNodeCollection(collection, options) {
	return inspectList(collection, options, inspectNode, "\n");
}
function inspectNode(node, options) {
	switch (node.nodeType) {
		case 1: return inspectHTML(node, options);
		case 3: return options.inspect(node.data, options);
		default: return options.inspect(node, options);
	}
}
function inspectHTML(element, options) {
	const properties = element.getAttributeNames();
	const name = element.tagName.toLowerCase();
	const head = options.stylize(`<${name}`, "special");
	const headClose = options.stylize(`>`, "special");
	const tail = options.stylize(`</${name}>`, "special");
	options.truncate -= name.length * 2 + 5;
	let propertyContents = "";
	if (properties.length > 0) {
		propertyContents += " ";
		propertyContents += inspectList(properties.map((key) => [key, element.getAttribute(key)]), options, inspectAttribute, " ");
	}
	options.truncate -= propertyContents.length;
	const truncate = options.truncate;
	let children = inspectNodeCollection(element.children, options);
	if (children && children.length > truncate) children = `${truncator}(${element.children.length})`;
	return `${head}${propertyContents}${headClose}${children}${tail}`;
}
const chaiInspect = typeof Symbol === "function" && typeof Symbol.for === "function" ? Symbol.for("chai/inspect") : "@@chai/inspect";
const nodeInspect = Symbol.for("nodejs.util.inspect.custom");
const constructorMap = /* @__PURE__ */ new WeakMap();
const stringTagMap = {};
const baseTypesMap = {
	undefined: (value, options) => options.stylize("undefined", "undefined"),
	null: (value, options) => options.stylize("null", "null"),
	boolean: (value, options) => options.stylize(String(value), "boolean"),
	Boolean: (value, options) => options.stylize(String(value), "boolean"),
	number: inspectNumber,
	Number: inspectNumber,
	bigint: inspectBigInt,
	BigInt: inspectBigInt,
	string: inspectString,
	String: inspectString,
	function: inspectFunction,
	Function: inspectFunction,
	symbol: inspectSymbol,
	Symbol: inspectSymbol,
	Array: inspectArray,
	Date: inspectDate,
	Map: inspectMap,
	Set: inspectSet,
	RegExp: inspectRegExp,
	Promise: getPromiseValue,
	WeakSet: (value, options) => options.stylize("WeakSet{…}", "special"),
	WeakMap: (value, options) => options.stylize("WeakMap{…}", "special"),
	Arguments: inspectArguments,
	Int8Array: inspectTypedArray,
	Uint8Array: inspectTypedArray,
	Uint8ClampedArray: inspectTypedArray,
	Int16Array: inspectTypedArray,
	Uint16Array: inspectTypedArray,
	Int32Array: inspectTypedArray,
	Uint32Array: inspectTypedArray,
	Float32Array: inspectTypedArray,
	Float64Array: inspectTypedArray,
	Generator: () => "",
	DataView: () => "",
	ArrayBuffer: () => "",
	Error: inspectObject,
	HTMLCollection: inspectNodeCollection,
	NodeList: inspectNodeCollection
};
const inspectCustom = (value, options, type, inspectFn) => {
	if (chaiInspect in value && typeof value[chaiInspect] === "function") return value[chaiInspect](options);
	if (nodeInspect in value && typeof value[nodeInspect] === "function") return value[nodeInspect](options.depth, options, inspectFn);
	if ("inspect" in value && typeof value.inspect === "function") return value.inspect(options.depth, options);
	if ("constructor" in value && constructorMap.has(value.constructor)) return constructorMap.get(value.constructor)(value, options);
	if (stringTagMap[type]) return stringTagMap[type](value, options);
	return "";
};
const toString = Object.prototype.toString;
function inspect$1(value, opts = {}) {
	const options = normaliseOptions(opts, inspect$1);
	const { customInspect } = options;
	let type = value === null ? "null" : typeof value;
	if (type === "object") type = toString.call(value).slice(8, -1);
	if (type in baseTypesMap) return baseTypesMap[type](value, options);
	if (customInspect && value) {
		const output = inspectCustom(value, options, type, inspect$1);
		if (output) {
			if (typeof output === "string") return output;
			return inspect$1(output, options);
		}
	}
	const proto = value ? Object.getPrototypeOf(value) : false;
	if (proto === Object.prototype || proto === null) return inspectObject$1(value, options);
	if (value && typeof HTMLElement === "function" && value instanceof HTMLElement) return inspectHTML(value, options);
	if ("constructor" in value) {
		if (value.constructor !== Object) return inspectClass(value, options);
		return inspectObject$1(value, options);
	}
	if (value === Object(value)) return inspectObject$1(value, options);
	return options.stylize(String(value), type);
}
const { AsymmetricMatcher: AsymmetricMatcher$1, DOMCollection: DOMCollection$1, DOMElement: DOMElement$1, Immutable: Immutable$1, ReactElement: ReactElement$1, ReactTestComponent: ReactTestComponent$1 } = plugins;
const PLUGINS$1 = [
	ReactTestComponent$1,
	ReactElement$1,
	DOMElement$1,
	DOMCollection$1,
	Immutable$1,
	AsymmetricMatcher$1
];
function stringify(object, maxDepth = 10, { maxLength, filterNode, ...options } = {}) {
	const MAX_LENGTH = maxLength ?? 1e4;
	let result;
	const filterFn = typeof filterNode === "string" ? createNodeFilterFromSelector(filterNode) : filterNode;
	const plugins = filterFn ? [
		ReactTestComponent$1,
		ReactElement$1,
		createDOMElementFilter(filterFn),
		DOMCollection$1,
		Immutable$1,
		AsymmetricMatcher$1
	] : PLUGINS$1;
	try {
		result = format$1(object, {
			maxDepth,
			escapeString: false,
			plugins,
			...options
		});
	} catch {
		result = format$1(object, {
			callToJSON: false,
			maxDepth,
			escapeString: false,
			plugins,
			...options
		});
	}
	return result.length >= MAX_LENGTH && maxDepth > 1 ? stringify(object, Math.floor(Math.min(maxDepth, Number.MAX_SAFE_INTEGER) / 2), {
		maxLength,
		filterNode,
		...options
	}) : result;
}
function createNodeFilterFromSelector(selector) {
	const ELEMENT_NODE = 1;
	const COMMENT_NODE = 8;
	return (node) => {
		if (node.nodeType === COMMENT_NODE) return false;
		if (node.nodeType === ELEMENT_NODE && node.matches) try {
			return !node.matches(selector);
		} catch {
			return true;
		}
		return true;
	};
}
const formatRegExp = /%[sdjifoOc%]/g;
function baseFormat(args, options = {}) {
	const formatArg = (item, inspecOptions) => {
		if (options.prettifyObject) return stringify(item, void 0, {
			printBasicPrototype: false,
			escapeString: false
		});
		return inspect(item, inspecOptions);
	};
	if (typeof args[0] !== "string") {
		const objects = [];
		for (let i = 0; i < args.length; i++) objects.push(formatArg(args[i], {
			depth: 0,
			colors: false
		}));
		return objects.join(" ");
	}
	const len = args.length;
	let i = 1;
	const template = args[0];
	let str = String(template).replace(formatRegExp, (x) => {
		if (x === "%%") return "%";
		if (i >= len) return x;
		switch (x) {
			case "%s": {
				const value = args[i++];
				if (typeof value === "bigint") return `${value.toString()}n`;
				if (typeof value === "number" && value === 0 && 1 / value < 0) return "-0";
				if (typeof value === "object" && value !== null) {
					if (typeof value.toString === "function" && value.toString !== Object.prototype.toString) return value.toString();
					return formatArg(value, {
						depth: 0,
						colors: false
					});
				}
				return String(value);
			}
			case "%d": {
				const value = args[i++];
				if (typeof value === "bigint") return `${value.toString()}n`;
				if (typeof value === "symbol") return "NaN";
				return Number(value).toString();
			}
			case "%i": {
				const value = args[i++];
				if (typeof value === "bigint") return `${value.toString()}n`;
				return Number.parseInt(String(value)).toString();
			}
			case "%f": return Number.parseFloat(String(args[i++])).toString();
			case "%o": return formatArg(args[i++], {
				showHidden: true,
				showProxy: true
			});
			case "%O": return formatArg(args[i++]);
			case "%c":
				i++;
				return "";
			case "%j": try {
				return JSON.stringify(args[i++]);
			} catch (err) {
				const m = err.message;
				if (m.includes("circular structure") || m.includes("cyclic structures") || m.includes("cyclic object")) return "[Circular]";
				throw err;
			}
			default: return x;
		}
	});
	for (let x = args[i]; i < len; x = args[++i]) if (x === null || typeof x !== "object") str += ` ${typeof x === "symbol" ? x.toString() : x}`;
	else str += ` ${formatArg(x)}`;
	return str;
}
function format(...args) {
	return baseFormat(args);
}
function inspect(obj, options = {}) {
	if (options.truncate === 0) options.truncate = Number.POSITIVE_INFINITY;
	return inspect$1(obj, options);
}
function objDisplay(obj, options = {}) {
	if (typeof options.truncate === "undefined") options.truncate = 40;
	const str = inspect(obj, options);
	const type = Object.prototype.toString.call(obj);
	if (options.truncate && str.length >= options.truncate) if (type === "[object Function]") {
		const fn = obj;
		return !fn.name ? "[Function]" : `[Function: ${fn.name}]`;
	} else if (type === "[object Array]") return `[ Array(${obj.length}) ]`;
	else if (type === "[object Object]") {
		const keys = Object.keys(obj);
		return `{ Object (${keys.length > 2 ? `${keys.splice(0, 2).join(", ")}, ...` : keys.join(", ")}) }`;
	} else return str;
	return str;
}
//#endregion
//#region node_modules/@vitest/utils/dist/helpers.js
/**
* Get original stacktrace without source map support the most performant way.
* - Create only 1 stack frame.
* - Rewrite prepareStackTrace to bypass "support-stack-trace" (usually takes ~250ms).
*/
function createSimpleStackTrace(options) {
	const { message = "$$stack trace error", stackTraceLimit = 1 } = options || {};
	const limit = Error.stackTraceLimit;
	const prepareStackTrace = Error.prepareStackTrace;
	Error.stackTraceLimit = stackTraceLimit;
	Error.prepareStackTrace = (e) => e.stack;
	const stackTrace = new Error(message).stack || "";
	Error.prepareStackTrace = prepareStackTrace;
	Error.stackTraceLimit = limit;
	return stackTrace;
}
function notNullish(v) {
	return v != null;
}
function assertTypes(value, name, types) {
	const receivedType = typeof value;
	if (!types.includes(receivedType)) throw new TypeError(`${name} value must be ${types.join(" or ")}, received "${receivedType}"`);
}
function isPrimitive(value) {
	return value === null || typeof value !== "function" && typeof value !== "object";
}
function filterOutComments(s) {
	const result = [];
	let commentState = "none";
	for (let i = 0; i < s.length; ++i) if (commentState === "singleline") {
		if (s[i] === "\n") commentState = "none";
	} else if (commentState === "multiline") {
		if (s[i - 1] === "*" && s[i] === "/") commentState = "none";
	} else if (commentState === "none") if (s[i] === "/" && s[i + 1] === "/") commentState = "singleline";
	else if (s[i] === "/" && s[i + 1] === "*") {
		commentState = "multiline";
		i += 2;
	} else result.push(s[i]);
	return result.join("");
}
function toArray(array) {
	if (array === null || array === void 0) array = [];
	if (Array.isArray(array)) return array;
	return [array];
}
function isObject(item) {
	return item != null && typeof item === "object" && !Array.isArray(item);
}
function isFinalObj(obj) {
	return obj === Object.prototype || obj === Function.prototype || obj === RegExp.prototype;
}
function getType$1(value) {
	return Object.prototype.toString.apply(value).slice(8, -1);
}
function collectOwnProperties(obj, collector) {
	const collect = typeof collector === "function" ? collector : (key) => collector.add(key);
	Object.getOwnPropertyNames(obj).forEach(collect);
	Object.getOwnPropertySymbols(obj).forEach(collect);
}
function getOwnProperties(obj) {
	const ownProps = /* @__PURE__ */ new Set();
	if (isFinalObj(obj)) return [];
	collectOwnProperties(obj, ownProps);
	return Array.from(ownProps);
}
const defaultCloneOptions = { forceWritable: false };
function deepClone(val, options = defaultCloneOptions) {
	return clone(val, /* @__PURE__ */ new WeakMap(), options);
}
function clone(val, seen, options = defaultCloneOptions) {
	let k, out;
	if (seen.has(val)) return seen.get(val);
	if (Array.isArray(val)) {
		out = Array.from({ length: k = val.length });
		seen.set(val, out);
		while (k--) out[k] = clone(val[k], seen, options);
		return out;
	}
	if (Object.prototype.toString.call(val) === "[object Object]") {
		out = Object.create(Object.getPrototypeOf(val));
		seen.set(val, out);
		const props = getOwnProperties(val);
		for (const k of props) {
			const descriptor = Object.getOwnPropertyDescriptor(val, k);
			if (!descriptor) continue;
			const cloned = clone(val[k], seen, options);
			if (options.forceWritable) Object.defineProperty(out, k, {
				enumerable: descriptor.enumerable,
				configurable: true,
				writable: true,
				value: cloned
			});
			else if ("get" in descriptor) Object.defineProperty(out, k, {
				...descriptor,
				get() {
					return cloned;
				}
			});
			else Object.defineProperty(out, k, {
				...descriptor,
				value: cloned
			});
		}
		return out;
	}
	return val;
}
function noop() {}
function objectAttr(source, path, defaultValue = void 0) {
	const paths = path.replace(/\[(\d+)\]/g, ".$1").split(".");
	let result = source;
	for (const p of paths) {
		result = new Object(result)[p];
		if (result === void 0) return defaultValue;
	}
	return result;
}
function createDefer() {
	let resolve = null;
	let reject = null;
	const p = new Promise((_resolve, _reject) => {
		resolve = _resolve;
		reject = _reject;
	});
	p.resolve = resolve;
	p.reject = reject;
	return p;
}
/**
* If code starts with a function call, will return its last index, respecting arguments.
* This will return 25 - last ending character of toMatch ")"
* Also works with callbacks
* ```
* toMatch({ test: '123' });
* toBeAliased('123')
* ```
*/
function getCallLastIndex(code) {
	let charIndex = -1;
	let inString = null;
	let startedBracers = 0;
	let endedBracers = 0;
	let beforeChar = null;
	while (charIndex <= code.length) {
		beforeChar = code[charIndex];
		charIndex++;
		const char = code[charIndex];
		if ((char === "\"" || char === "'" || char === "`") && beforeChar !== "\\") {
			if (inString === char) inString = null;
			else if (!inString) inString = char;
		}
		if (!inString) {
			if (char === "(") startedBracers++;
			if (char === ")") endedBracers++;
		}
		if (startedBracers && endedBracers && startedBracers === endedBracers) return charIndex;
	}
	return null;
}
function isNegativeNaN(val) {
	if (!Number.isNaN(val)) return false;
	const f64 = new Float64Array(1);
	f64[0] = val;
	return new Uint32Array(f64.buffer)[1] >>> 31 === 1;
}
function ordinal(i) {
	const j = i % 10;
	const k = i % 100;
	if (j === 1 && k !== 11) return `${i}st`;
	if (j === 2 && k !== 12) return `${i}nd`;
	if (j === 3 && k !== 13) return `${i}rd`;
	return `${i}th`;
}
function unique(array) {
	return Array.from(new Set(array));
}
/**
* Class representing one diff tuple.
* Attempts to look like a two-element array (which is what this used to be).
* @param {number} op Operation, one of: DIFF_DELETE, DIFF_INSERT, DIFF_EQUAL.
* @param {string} text Text to be deleted, inserted, or retained.
* @constructor
*/
var Diff = class {
	0;
	1;
	constructor(op, text) {
		this[0] = op;
		this[1] = text;
	}
};
/**
* Determine the common prefix of two strings.
* @param {string} text1 First string.
* @param {string} text2 Second string.
* @return {number} The number of characters common to the start of each
*     string.
*/
function diff_commonPrefix(text1, text2) {
	if (!text1 || !text2 || text1.charAt(0) !== text2.charAt(0)) return 0;
	let pointermin = 0;
	let pointermax = Math.min(text1.length, text2.length);
	let pointermid = pointermax;
	let pointerstart = 0;
	while (pointermin < pointermid) {
		if (text1.substring(pointerstart, pointermid) === text2.substring(pointerstart, pointermid)) {
			pointermin = pointermid;
			pointerstart = pointermin;
		} else pointermax = pointermid;
		pointermid = Math.floor((pointermax - pointermin) / 2 + pointermin);
	}
	return pointermid;
}
/**
* Determine the common suffix of two strings.
* @param {string} text1 First string.
* @param {string} text2 Second string.
* @return {number} The number of characters common to the end of each string.
*/
function diff_commonSuffix(text1, text2) {
	if (!text1 || !text2 || text1.charAt(text1.length - 1) !== text2.charAt(text2.length - 1)) return 0;
	let pointermin = 0;
	let pointermax = Math.min(text1.length, text2.length);
	let pointermid = pointermax;
	let pointerend = 0;
	while (pointermin < pointermid) {
		if (text1.substring(text1.length - pointermid, text1.length - pointerend) === text2.substring(text2.length - pointermid, text2.length - pointerend)) {
			pointermin = pointermid;
			pointerend = pointermin;
		} else pointermax = pointermid;
		pointermid = Math.floor((pointermax - pointermin) / 2 + pointermin);
	}
	return pointermid;
}
/**
* Determine if the suffix of one string is the prefix of another.
* @param {string} text1 First string.
* @param {string} text2 Second string.
* @return {number} The number of characters common to the end of the first
*     string and the start of the second string.
* @private
*/
function diff_commonOverlap_(text1, text2) {
	const text1_length = text1.length;
	const text2_length = text2.length;
	if (text1_length === 0 || text2_length === 0) return 0;
	if (text1_length > text2_length) text1 = text1.substring(text1_length - text2_length);
	else if (text1_length < text2_length) text2 = text2.substring(0, text1_length);
	const text_length = Math.min(text1_length, text2_length);
	if (text1 === text2) return text_length;
	let best = 0;
	let length = 1;
	while (true) {
		const pattern = text1.substring(text_length - length);
		const found = text2.indexOf(pattern);
		if (found === -1) return best;
		length += found;
		if (found === 0 || text1.substring(text_length - length) === text2.substring(0, length)) {
			best = length;
			length++;
		}
	}
}
/**
* Reduce the number of edits by eliminating semantically trivial equalities.
* @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
*/
function diff_cleanupSemantic(diffs) {
	let changes = false;
	const equalities = [];
	let equalitiesLength = 0;
	/** @type {?string} */
	let lastEquality = null;
	let pointer = 0;
	let length_insertions1 = 0;
	let length_deletions1 = 0;
	let length_insertions2 = 0;
	let length_deletions2 = 0;
	while (pointer < diffs.length) {
		if (diffs[pointer][0] === 0) {
			equalities[equalitiesLength++] = pointer;
			length_insertions1 = length_insertions2;
			length_deletions1 = length_deletions2;
			length_insertions2 = 0;
			length_deletions2 = 0;
			lastEquality = diffs[pointer][1];
		} else {
			if (diffs[pointer][0] === 1) length_insertions2 += diffs[pointer][1].length;
			else length_deletions2 += diffs[pointer][1].length;
			if (lastEquality && lastEquality.length <= Math.max(length_insertions1, length_deletions1) && lastEquality.length <= Math.max(length_insertions2, length_deletions2)) {
				diffs.splice(equalities[equalitiesLength - 1], 0, new Diff(-1, lastEquality));
				diffs[equalities[equalitiesLength - 1] + 1][0] = 1;
				equalitiesLength--;
				equalitiesLength--;
				pointer = equalitiesLength > 0 ? equalities[equalitiesLength - 1] : -1;
				length_insertions1 = 0;
				length_deletions1 = 0;
				length_insertions2 = 0;
				length_deletions2 = 0;
				lastEquality = null;
				changes = true;
			}
		}
		pointer++;
	}
	if (changes) diff_cleanupMerge(diffs);
	diff_cleanupSemanticLossless(diffs);
	pointer = 1;
	while (pointer < diffs.length) {
		if (diffs[pointer - 1][0] === -1 && diffs[pointer][0] === 1) {
			const deletion = diffs[pointer - 1][1];
			const insertion = diffs[pointer][1];
			const overlap_length1 = diff_commonOverlap_(deletion, insertion);
			const overlap_length2 = diff_commonOverlap_(insertion, deletion);
			if (overlap_length1 >= overlap_length2) {
				if (overlap_length1 >= deletion.length / 2 || overlap_length1 >= insertion.length / 2) {
					diffs.splice(pointer, 0, new Diff(0, insertion.substring(0, overlap_length1)));
					diffs[pointer - 1][1] = deletion.substring(0, deletion.length - overlap_length1);
					diffs[pointer + 1][1] = insertion.substring(overlap_length1);
					pointer++;
				}
			} else if (overlap_length2 >= deletion.length / 2 || overlap_length2 >= insertion.length / 2) {
				diffs.splice(pointer, 0, new Diff(0, deletion.substring(0, overlap_length2)));
				diffs[pointer - 1][0] = 1;
				diffs[pointer - 1][1] = insertion.substring(0, insertion.length - overlap_length2);
				diffs[pointer + 1][0] = -1;
				diffs[pointer + 1][1] = deletion.substring(overlap_length2);
				pointer++;
			}
			pointer++;
		}
		pointer++;
	}
}
const nonAlphaNumericRegex_ = /[^a-z0-9]/i;
const whitespaceRegex_ = /\s/;
const linebreakRegex_ = /[\r\n]/;
const blanklineEndRegex_ = /\n\r?\n$/;
const blanklineStartRegex_ = /^\r?\n\r?\n/;
/**
* Look for single edits surrounded on both sides by equalities
* which can be shifted sideways to align the edit to a word boundary.
* e.g: The c<ins>at c</ins>ame. -> The <ins>cat </ins>came.
* @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
*/
function diff_cleanupSemanticLossless(diffs) {
	let pointer = 1;
	while (pointer < diffs.length - 1) {
		if (diffs[pointer - 1][0] === 0 && diffs[pointer + 1][0] === 0) {
			let equality1 = diffs[pointer - 1][1];
			let edit = diffs[pointer][1];
			let equality2 = diffs[pointer + 1][1];
			const commonOffset = diff_commonSuffix(equality1, edit);
			if (commonOffset) {
				const commonString = edit.substring(edit.length - commonOffset);
				equality1 = equality1.substring(0, equality1.length - commonOffset);
				edit = commonString + edit.substring(0, edit.length - commonOffset);
				equality2 = commonString + equality2;
			}
			let bestEquality1 = equality1;
			let bestEdit = edit;
			let bestEquality2 = equality2;
			let bestScore = diff_cleanupSemanticScore_(equality1, edit) + diff_cleanupSemanticScore_(edit, equality2);
			while (edit.charAt(0) === equality2.charAt(0)) {
				equality1 += edit.charAt(0);
				edit = edit.substring(1) + equality2.charAt(0);
				equality2 = equality2.substring(1);
				const score = diff_cleanupSemanticScore_(equality1, edit) + diff_cleanupSemanticScore_(edit, equality2);
				if (score >= bestScore) {
					bestScore = score;
					bestEquality1 = equality1;
					bestEdit = edit;
					bestEquality2 = equality2;
				}
			}
			if (diffs[pointer - 1][1] !== bestEquality1) {
				if (bestEquality1) diffs[pointer - 1][1] = bestEquality1;
				else {
					diffs.splice(pointer - 1, 1);
					pointer--;
				}
				diffs[pointer][1] = bestEdit;
				if (bestEquality2) diffs[pointer + 1][1] = bestEquality2;
				else {
					diffs.splice(pointer + 1, 1);
					pointer--;
				}
			}
		}
		pointer++;
	}
}
/**
* Reorder and merge like edit sections.  Merge equalities.
* Any edit section can move as long as it doesn't cross an equality.
* @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
*/
function diff_cleanupMerge(diffs) {
	diffs.push(new Diff(0, ""));
	let pointer = 0;
	let count_delete = 0;
	let count_insert = 0;
	let text_delete = "";
	let text_insert = "";
	let commonlength;
	while (pointer < diffs.length) switch (diffs[pointer][0]) {
		case 1:
			count_insert++;
			text_insert += diffs[pointer][1];
			pointer++;
			break;
		case -1:
			count_delete++;
			text_delete += diffs[pointer][1];
			pointer++;
			break;
		case 0:
			if (count_delete + count_insert > 1) {
				if (count_delete !== 0 && count_insert !== 0) {
					commonlength = diff_commonPrefix(text_insert, text_delete);
					if (commonlength !== 0) {
						if (pointer - count_delete - count_insert > 0 && diffs[pointer - count_delete - count_insert - 1][0] === 0) diffs[pointer - count_delete - count_insert - 1][1] += text_insert.substring(0, commonlength);
						else {
							diffs.splice(0, 0, new Diff(0, text_insert.substring(0, commonlength)));
							pointer++;
						}
						text_insert = text_insert.substring(commonlength);
						text_delete = text_delete.substring(commonlength);
					}
					commonlength = diff_commonSuffix(text_insert, text_delete);
					if (commonlength !== 0) {
						diffs[pointer][1] = text_insert.substring(text_insert.length - commonlength) + diffs[pointer][1];
						text_insert = text_insert.substring(0, text_insert.length - commonlength);
						text_delete = text_delete.substring(0, text_delete.length - commonlength);
					}
				}
				pointer -= count_delete + count_insert;
				diffs.splice(pointer, count_delete + count_insert);
				if (text_delete.length) {
					diffs.splice(pointer, 0, new Diff(-1, text_delete));
					pointer++;
				}
				if (text_insert.length) {
					diffs.splice(pointer, 0, new Diff(1, text_insert));
					pointer++;
				}
				pointer++;
			} else if (pointer !== 0 && diffs[pointer - 1][0] === 0) {
				diffs[pointer - 1][1] += diffs[pointer][1];
				diffs.splice(pointer, 1);
			} else pointer++;
			count_insert = 0;
			count_delete = 0;
			text_delete = "";
			text_insert = "";
			break;
	}
	if (diffs.at(-1)?.[1] === "") diffs.pop();
	let changes = false;
	pointer = 1;
	while (pointer < diffs.length - 1) {
		if (diffs[pointer - 1][0] === 0 && diffs[pointer + 1][0] === 0) {
			if (diffs[pointer][1].substring(diffs[pointer][1].length - diffs[pointer - 1][1].length) === diffs[pointer - 1][1]) {
				diffs[pointer][1] = diffs[pointer - 1][1] + diffs[pointer][1].substring(0, diffs[pointer][1].length - diffs[pointer - 1][1].length);
				diffs[pointer + 1][1] = diffs[pointer - 1][1] + diffs[pointer + 1][1];
				diffs.splice(pointer - 1, 1);
				changes = true;
			} else if (diffs[pointer][1].substring(0, diffs[pointer + 1][1].length) === diffs[pointer + 1][1]) {
				diffs[pointer - 1][1] += diffs[pointer + 1][1];
				diffs[pointer][1] = diffs[pointer][1].substring(diffs[pointer + 1][1].length) + diffs[pointer + 1][1];
				diffs.splice(pointer + 1, 1);
				changes = true;
			}
		}
		pointer++;
	}
	if (changes) diff_cleanupMerge(diffs);
}
/**
* Given two strings, compute a score representing whether the internal
* boundary falls on logical boundaries.
* Scores range from 6 (best) to 0 (worst).
* Closure, but does not reference any external variables.
* @param {string} one First string.
* @param {string} two Second string.
* @return {number} The score.
* @private
*/
function diff_cleanupSemanticScore_(one, two) {
	if (!one || !two) return 6;
	const char1 = one.charAt(one.length - 1);
	const char2 = two.charAt(0);
	const nonAlphaNumeric1 = char1.match(nonAlphaNumericRegex_);
	const nonAlphaNumeric2 = char2.match(nonAlphaNumericRegex_);
	const whitespace1 = nonAlphaNumeric1 && char1.match(whitespaceRegex_);
	const whitespace2 = nonAlphaNumeric2 && char2.match(whitespaceRegex_);
	const lineBreak1 = whitespace1 && char1.match(linebreakRegex_);
	const lineBreak2 = whitespace2 && char2.match(linebreakRegex_);
	const blankLine1 = lineBreak1 && one.match(blanklineEndRegex_);
	const blankLine2 = lineBreak2 && two.match(blanklineStartRegex_);
	if (blankLine1 || blankLine2) return 5;
	else if (lineBreak1 || lineBreak2) return 4;
	else if (nonAlphaNumeric1 && !whitespace1 && whitespace2) return 3;
	else if (whitespace1 || whitespace2) return 2;
	else if (nonAlphaNumeric1 || nonAlphaNumeric2) return 1;
	return 0;
}
/**
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/
const NO_DIFF_MESSAGE = "Compared values have no visual difference.";
const SIMILAR_MESSAGE = "Compared values serialize to the same structure.\nPrinting internal object structure without calling `toJSON` instead.";
function getDefaultExportFromCjs(x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
var build = {};
var hasRequiredBuild;
function requireBuild() {
	if (hasRequiredBuild) return build;
	hasRequiredBuild = 1;
	Object.defineProperty(build, "__esModule", { value: true });
	build.default = diffSequence;
	/**
	* Copyright (c) Meta Platforms, Inc. and affiliates.
	*
	* This source code is licensed under the MIT license found in the
	* LICENSE file in the root directory of this source tree.
	*
	*/
	const pkg = "diff-sequences";
	const NOT_YET_SET = 0;
	const countCommonItemsF = (aIndex, aEnd, bIndex, bEnd, isCommon) => {
		let nCommon = 0;
		while (aIndex < aEnd && bIndex < bEnd && isCommon(aIndex, bIndex)) {
			aIndex += 1;
			bIndex += 1;
			nCommon += 1;
		}
		return nCommon;
	};
	const countCommonItemsR = (aStart, aIndex, bStart, bIndex, isCommon) => {
		let nCommon = 0;
		while (aStart <= aIndex && bStart <= bIndex && isCommon(aIndex, bIndex)) {
			aIndex -= 1;
			bIndex -= 1;
			nCommon += 1;
		}
		return nCommon;
	};
	const extendPathsF = (d, aEnd, bEnd, bF, isCommon, aIndexesF, iMaxF) => {
		let iF = 0;
		let kF = -d;
		let aFirst = aIndexesF[iF];
		let aIndexPrev1 = aFirst;
		aIndexesF[iF] += countCommonItemsF(aFirst + 1, aEnd, bF + aFirst - kF + 1, bEnd, isCommon);
		const nF = d < iMaxF ? d : iMaxF;
		for (iF += 1, kF += 2; iF <= nF; iF += 1, kF += 2) {
			if (iF !== d && aIndexPrev1 < aIndexesF[iF]) aFirst = aIndexesF[iF];
			else {
				aFirst = aIndexPrev1 + 1;
				if (aEnd <= aFirst) return iF - 1;
			}
			aIndexPrev1 = aIndexesF[iF];
			aIndexesF[iF] = aFirst + countCommonItemsF(aFirst + 1, aEnd, bF + aFirst - kF + 1, bEnd, isCommon);
		}
		return iMaxF;
	};
	const extendPathsR = (d, aStart, bStart, bR, isCommon, aIndexesR, iMaxR) => {
		let iR = 0;
		let kR = d;
		let aFirst = aIndexesR[iR];
		let aIndexPrev1 = aFirst;
		aIndexesR[iR] -= countCommonItemsR(aStart, aFirst - 1, bStart, bR + aFirst - kR - 1, isCommon);
		const nR = d < iMaxR ? d : iMaxR;
		for (iR += 1, kR -= 2; iR <= nR; iR += 1, kR -= 2) {
			if (iR !== d && aIndexesR[iR] < aIndexPrev1) aFirst = aIndexesR[iR];
			else {
				aFirst = aIndexPrev1 - 1;
				if (aFirst < aStart) return iR - 1;
			}
			aIndexPrev1 = aIndexesR[iR];
			aIndexesR[iR] = aFirst - countCommonItemsR(aStart, aFirst - 1, bStart, bR + aFirst - kR - 1, isCommon);
		}
		return iMaxR;
	};
	const extendOverlappablePathsF = (d, aStart, aEnd, bStart, bEnd, isCommon, aIndexesF, iMaxF, aIndexesR, iMaxR, division) => {
		const bF = bStart - aStart;
		const aLength = aEnd - aStart;
		const baDeltaLength = bEnd - bStart - aLength;
		const kMinOverlapF = -baDeltaLength - (d - 1);
		const kMaxOverlapF = -baDeltaLength + (d - 1);
		let aIndexPrev1 = NOT_YET_SET;
		const nF = d < iMaxF ? d : iMaxF;
		for (let iF = 0, kF = -d; iF <= nF; iF += 1, kF += 2) {
			const insert = iF === 0 || iF !== d && aIndexPrev1 < aIndexesF[iF];
			const aLastPrev = insert ? aIndexesF[iF] : aIndexPrev1;
			const aFirst = insert ? aLastPrev : aLastPrev + 1;
			const bFirst = bF + aFirst - kF;
			const nCommonF = countCommonItemsF(aFirst + 1, aEnd, bFirst + 1, bEnd, isCommon);
			const aLast = aFirst + nCommonF;
			aIndexPrev1 = aIndexesF[iF];
			aIndexesF[iF] = aLast;
			if (kMinOverlapF <= kF && kF <= kMaxOverlapF) {
				const iR = (d - 1 - (kF + baDeltaLength)) / 2;
				if (iR <= iMaxR && aIndexesR[iR] - 1 <= aLast) {
					const bLastPrev = bF + aLastPrev - (insert ? kF + 1 : kF - 1);
					const nCommonR = countCommonItemsR(aStart, aLastPrev, bStart, bLastPrev, isCommon);
					const aIndexPrevFirst = aLastPrev - nCommonR;
					const bIndexPrevFirst = bLastPrev - nCommonR;
					const aEndPreceding = aIndexPrevFirst + 1;
					const bEndPreceding = bIndexPrevFirst + 1;
					division.nChangePreceding = d - 1;
					if (d - 1 === aEndPreceding + bEndPreceding - aStart - bStart) {
						division.aEndPreceding = aStart;
						division.bEndPreceding = bStart;
					} else {
						division.aEndPreceding = aEndPreceding;
						division.bEndPreceding = bEndPreceding;
					}
					division.nCommonPreceding = nCommonR;
					if (nCommonR !== 0) {
						division.aCommonPreceding = aEndPreceding;
						division.bCommonPreceding = bEndPreceding;
					}
					division.nCommonFollowing = nCommonF;
					if (nCommonF !== 0) {
						division.aCommonFollowing = aFirst + 1;
						division.bCommonFollowing = bFirst + 1;
					}
					const aStartFollowing = aLast + 1;
					const bStartFollowing = bFirst + nCommonF + 1;
					division.nChangeFollowing = d - 1;
					if (d - 1 === aEnd + bEnd - aStartFollowing - bStartFollowing) {
						division.aStartFollowing = aEnd;
						division.bStartFollowing = bEnd;
					} else {
						division.aStartFollowing = aStartFollowing;
						division.bStartFollowing = bStartFollowing;
					}
					return true;
				}
			}
		}
		return false;
	};
	const extendOverlappablePathsR = (d, aStart, aEnd, bStart, bEnd, isCommon, aIndexesF, iMaxF, aIndexesR, iMaxR, division) => {
		const bR = bEnd - aEnd;
		const aLength = aEnd - aStart;
		const baDeltaLength = bEnd - bStart - aLength;
		const kMinOverlapR = baDeltaLength - d;
		const kMaxOverlapR = baDeltaLength + d;
		let aIndexPrev1 = NOT_YET_SET;
		const nR = d < iMaxR ? d : iMaxR;
		for (let iR = 0, kR = d; iR <= nR; iR += 1, kR -= 2) {
			const insert = iR === 0 || iR !== d && aIndexesR[iR] < aIndexPrev1;
			const aLastPrev = insert ? aIndexesR[iR] : aIndexPrev1;
			const aFirst = insert ? aLastPrev : aLastPrev - 1;
			const bFirst = bR + aFirst - kR;
			const nCommonR = countCommonItemsR(aStart, aFirst - 1, bStart, bFirst - 1, isCommon);
			const aLast = aFirst - nCommonR;
			aIndexPrev1 = aIndexesR[iR];
			aIndexesR[iR] = aLast;
			if (kMinOverlapR <= kR && kR <= kMaxOverlapR) {
				const iF = (d + (kR - baDeltaLength)) / 2;
				if (iF <= iMaxF && aLast - 1 <= aIndexesF[iF]) {
					const bLast = bFirst - nCommonR;
					division.nChangePreceding = d;
					if (d === aLast + bLast - aStart - bStart) {
						division.aEndPreceding = aStart;
						division.bEndPreceding = bStart;
					} else {
						division.aEndPreceding = aLast;
						division.bEndPreceding = bLast;
					}
					division.nCommonPreceding = nCommonR;
					if (nCommonR !== 0) {
						division.aCommonPreceding = aLast;
						division.bCommonPreceding = bLast;
					}
					division.nChangeFollowing = d - 1;
					if (d === 1) {
						division.nCommonFollowing = 0;
						division.aStartFollowing = aEnd;
						division.bStartFollowing = bEnd;
					} else {
						const bLastPrev = bR + aLastPrev - (insert ? kR - 1 : kR + 1);
						const nCommonF = countCommonItemsF(aLastPrev, aEnd, bLastPrev, bEnd, isCommon);
						division.nCommonFollowing = nCommonF;
						if (nCommonF !== 0) {
							division.aCommonFollowing = aLastPrev;
							division.bCommonFollowing = bLastPrev;
						}
						const aStartFollowing = aLastPrev + nCommonF;
						const bStartFollowing = bLastPrev + nCommonF;
						if (d - 1 === aEnd + bEnd - aStartFollowing - bStartFollowing) {
							division.aStartFollowing = aEnd;
							division.bStartFollowing = bEnd;
						} else {
							division.aStartFollowing = aStartFollowing;
							division.bStartFollowing = bStartFollowing;
						}
					}
					return true;
				}
			}
		}
		return false;
	};
	const divide = (nChange, aStart, aEnd, bStart, bEnd, isCommon, aIndexesF, aIndexesR, division) => {
		const bF = bStart - aStart;
		const bR = bEnd - aEnd;
		const aLength = aEnd - aStart;
		const bLength = bEnd - bStart;
		const baDeltaLength = bLength - aLength;
		let iMaxF = aLength;
		let iMaxR = aLength;
		aIndexesF[0] = aStart - 1;
		aIndexesR[0] = aEnd;
		if (baDeltaLength % 2 === 0) {
			const dMin = (nChange || baDeltaLength) / 2;
			const dMax = (aLength + bLength) / 2;
			for (let d = 1; d <= dMax; d += 1) {
				iMaxF = extendPathsF(d, aEnd, bEnd, bF, isCommon, aIndexesF, iMaxF);
				if (d < dMin) iMaxR = extendPathsR(d, aStart, bStart, bR, isCommon, aIndexesR, iMaxR);
				else if (extendOverlappablePathsR(d, aStart, aEnd, bStart, bEnd, isCommon, aIndexesF, iMaxF, aIndexesR, iMaxR, division)) return;
			}
		} else {
			const dMin = ((nChange || baDeltaLength) + 1) / 2;
			const dMax = (aLength + bLength + 1) / 2;
			let d = 1;
			iMaxF = extendPathsF(d, aEnd, bEnd, bF, isCommon, aIndexesF, iMaxF);
			for (d += 1; d <= dMax; d += 1) {
				iMaxR = extendPathsR(d - 1, aStart, bStart, bR, isCommon, aIndexesR, iMaxR);
				if (d < dMin) iMaxF = extendPathsF(d, aEnd, bEnd, bF, isCommon, aIndexesF, iMaxF);
				else if (extendOverlappablePathsF(d, aStart, aEnd, bStart, bEnd, isCommon, aIndexesF, iMaxF, aIndexesR, iMaxR, division)) return;
			}
		}
		/* istanbul ignore next */
		throw new Error(`${pkg}: no overlap aStart=${aStart} aEnd=${aEnd} bStart=${bStart} bEnd=${bEnd}`);
	};
	const findSubsequences = (nChange, aStart, aEnd, bStart, bEnd, transposed, callbacks, aIndexesF, aIndexesR, division) => {
		if (bEnd - bStart < aEnd - aStart) {
			transposed = !transposed;
			if (transposed && callbacks.length === 1) {
				const { foundSubsequence, isCommon } = callbacks[0];
				callbacks[1] = {
					foundSubsequence: (nCommon, bCommon, aCommon) => {
						foundSubsequence(nCommon, aCommon, bCommon);
					},
					isCommon: (bIndex, aIndex) => isCommon(aIndex, bIndex)
				};
			}
			const tStart = aStart;
			const tEnd = aEnd;
			aStart = bStart;
			aEnd = bEnd;
			bStart = tStart;
			bEnd = tEnd;
		}
		const { foundSubsequence, isCommon } = callbacks[transposed ? 1 : 0];
		divide(nChange, aStart, aEnd, bStart, bEnd, isCommon, aIndexesF, aIndexesR, division);
		const { nChangePreceding, aEndPreceding, bEndPreceding, nCommonPreceding, aCommonPreceding, bCommonPreceding, nCommonFollowing, aCommonFollowing, bCommonFollowing, nChangeFollowing, aStartFollowing, bStartFollowing } = division;
		if (aStart < aEndPreceding && bStart < bEndPreceding) findSubsequences(nChangePreceding, aStart, aEndPreceding, bStart, bEndPreceding, transposed, callbacks, aIndexesF, aIndexesR, division);
		if (nCommonPreceding !== 0) foundSubsequence(nCommonPreceding, aCommonPreceding, bCommonPreceding);
		if (nCommonFollowing !== 0) foundSubsequence(nCommonFollowing, aCommonFollowing, bCommonFollowing);
		if (aStartFollowing < aEnd && bStartFollowing < bEnd) findSubsequences(nChangeFollowing, aStartFollowing, aEnd, bStartFollowing, bEnd, transposed, callbacks, aIndexesF, aIndexesR, division);
	};
	const validateLength = (name, arg) => {
		if (typeof arg !== "number") throw new TypeError(`${pkg}: ${name} typeof ${typeof arg} is not a number`);
		if (!Number.isSafeInteger(arg)) throw new RangeError(`${pkg}: ${name} value ${arg} is not a safe integer`);
		if (arg < 0) throw new RangeError(`${pkg}: ${name} value ${arg} is a negative integer`);
	};
	const validateCallback = (name, arg) => {
		const type = typeof arg;
		if (type !== "function") throw new TypeError(`${pkg}: ${name} typeof ${type} is not a function`);
	};
	function diffSequence(aLength, bLength, isCommon, foundSubsequence) {
		validateLength("aLength", aLength);
		validateLength("bLength", bLength);
		validateCallback("isCommon", isCommon);
		validateCallback("foundSubsequence", foundSubsequence);
		const nCommonF = countCommonItemsF(0, aLength, 0, bLength, isCommon);
		if (nCommonF !== 0) foundSubsequence(nCommonF, 0, 0);
		if (aLength !== nCommonF || bLength !== nCommonF) {
			const aStart = nCommonF;
			const bStart = nCommonF;
			const nCommonR = countCommonItemsR(aStart, aLength - 1, bStart, bLength - 1, isCommon);
			const aEnd = aLength - nCommonR;
			const bEnd = bLength - nCommonR;
			const nCommonFR = nCommonF + nCommonR;
			if (aLength !== nCommonFR && bLength !== nCommonFR) findSubsequences(0, aStart, aEnd, bStart, bEnd, false, [{
				foundSubsequence,
				isCommon
			}], [NOT_YET_SET], [NOT_YET_SET], {
				aCommonFollowing: NOT_YET_SET,
				aCommonPreceding: NOT_YET_SET,
				aEndPreceding: NOT_YET_SET,
				aStartFollowing: NOT_YET_SET,
				bCommonFollowing: NOT_YET_SET,
				bCommonPreceding: NOT_YET_SET,
				bEndPreceding: NOT_YET_SET,
				bStartFollowing: NOT_YET_SET,
				nChangeFollowing: NOT_YET_SET,
				nChangePreceding: NOT_YET_SET,
				nCommonFollowing: NOT_YET_SET,
				nCommonPreceding: NOT_YET_SET
			});
			if (nCommonR !== 0) foundSubsequence(nCommonR, aEnd, bEnd);
		}
	}
	return build;
}
var diffSequences = /* @__PURE__ */ getDefaultExportFromCjs(/* @__PURE__ */ requireBuild());
function formatTrailingSpaces(line, trailingSpaceFormatter) {
	return line.replace(/\s+$/, (match) => trailingSpaceFormatter(match));
}
function printDiffLine(line, isFirstOrLast, color, indicator, trailingSpaceFormatter, emptyFirstOrLastLinePlaceholder) {
	return line.length !== 0 ? color(`${indicator} ${formatTrailingSpaces(line, trailingSpaceFormatter)}`) : indicator !== " " ? color(indicator) : isFirstOrLast && emptyFirstOrLastLinePlaceholder.length !== 0 ? color(`${indicator} ${emptyFirstOrLastLinePlaceholder}`) : "";
}
function printDeleteLine(line, isFirstOrLast, { aColor, aIndicator, changeLineTrailingSpaceColor, emptyFirstOrLastLinePlaceholder }) {
	return printDiffLine(line, isFirstOrLast, aColor, aIndicator, changeLineTrailingSpaceColor, emptyFirstOrLastLinePlaceholder);
}
function printInsertLine(line, isFirstOrLast, { bColor, bIndicator, changeLineTrailingSpaceColor, emptyFirstOrLastLinePlaceholder }) {
	return printDiffLine(line, isFirstOrLast, bColor, bIndicator, changeLineTrailingSpaceColor, emptyFirstOrLastLinePlaceholder);
}
function printCommonLine(line, isFirstOrLast, { commonColor, commonIndicator, commonLineTrailingSpaceColor, emptyFirstOrLastLinePlaceholder }) {
	return printDiffLine(line, isFirstOrLast, commonColor, commonIndicator, commonLineTrailingSpaceColor, emptyFirstOrLastLinePlaceholder);
}
function createPatchMark(aStart, aEnd, bStart, bEnd, { patchColor }) {
	return patchColor(`@@ -${aStart + 1},${aEnd - aStart} +${bStart + 1},${bEnd - bStart} @@`);
}
function joinAlignedDiffsNoExpand(diffs, options) {
	const iLength = diffs.length;
	const nContextLines = options.contextLines;
	const nContextLines2 = nContextLines + nContextLines;
	let jLength = iLength;
	let hasExcessAtStartOrEnd = false;
	let nExcessesBetweenChanges = 0;
	let i = 0;
	while (i !== iLength) {
		const iStart = i;
		while (i !== iLength && diffs[i][0] === 0) i += 1;
		if (iStart !== i) if (iStart === 0) {
			if (i > nContextLines) {
				jLength -= i - nContextLines;
				hasExcessAtStartOrEnd = true;
			}
		} else if (i === iLength) {
			const n = i - iStart;
			if (n > nContextLines) {
				jLength -= n - nContextLines;
				hasExcessAtStartOrEnd = true;
			}
		} else {
			const n = i - iStart;
			if (n > nContextLines2) {
				jLength -= n - nContextLines2;
				nExcessesBetweenChanges += 1;
			}
		}
		while (i !== iLength && diffs[i][0] !== 0) i += 1;
	}
	const hasPatch = nExcessesBetweenChanges !== 0 || hasExcessAtStartOrEnd;
	if (nExcessesBetweenChanges !== 0) jLength += nExcessesBetweenChanges + 1;
	else if (hasExcessAtStartOrEnd) jLength += 1;
	const jLast = jLength - 1;
	const lines = [];
	let jPatchMark = 0;
	if (hasPatch) lines.push("");
	let aStart = 0;
	let bStart = 0;
	let aEnd = 0;
	let bEnd = 0;
	const pushCommonLine = (line) => {
		const j = lines.length;
		lines.push(printCommonLine(line, j === 0 || j === jLast, options));
		aEnd += 1;
		bEnd += 1;
	};
	const pushDeleteLine = (line) => {
		const j = lines.length;
		lines.push(printDeleteLine(line, j === 0 || j === jLast, options));
		aEnd += 1;
	};
	const pushInsertLine = (line) => {
		const j = lines.length;
		lines.push(printInsertLine(line, j === 0 || j === jLast, options));
		bEnd += 1;
	};
	i = 0;
	while (i !== iLength) {
		let iStart = i;
		while (i !== iLength && diffs[i][0] === 0) i += 1;
		if (iStart !== i) if (iStart === 0) {
			if (i > nContextLines) {
				iStart = i - nContextLines;
				aStart = iStart;
				bStart = iStart;
				aEnd = aStart;
				bEnd = bStart;
			}
			for (let iCommon = iStart; iCommon !== i; iCommon += 1) pushCommonLine(diffs[iCommon][1]);
		} else if (i === iLength) {
			const iEnd = i - iStart > nContextLines ? iStart + nContextLines : i;
			for (let iCommon = iStart; iCommon !== iEnd; iCommon += 1) pushCommonLine(diffs[iCommon][1]);
		} else {
			const nCommon = i - iStart;
			if (nCommon > nContextLines2) {
				const iEnd = iStart + nContextLines;
				for (let iCommon = iStart; iCommon !== iEnd; iCommon += 1) pushCommonLine(diffs[iCommon][1]);
				lines[jPatchMark] = createPatchMark(aStart, aEnd, bStart, bEnd, options);
				jPatchMark = lines.length;
				lines.push("");
				const nOmit = nCommon - nContextLines2;
				aStart = aEnd + nOmit;
				bStart = bEnd + nOmit;
				aEnd = aStart;
				bEnd = bStart;
				for (let iCommon = i - nContextLines; iCommon !== i; iCommon += 1) pushCommonLine(diffs[iCommon][1]);
			} else for (let iCommon = iStart; iCommon !== i; iCommon += 1) pushCommonLine(diffs[iCommon][1]);
		}
		while (i !== iLength && diffs[i][0] === -1) {
			pushDeleteLine(diffs[i][1]);
			i += 1;
		}
		while (i !== iLength && diffs[i][0] === 1) {
			pushInsertLine(diffs[i][1]);
			i += 1;
		}
	}
	if (hasPatch) lines[jPatchMark] = createPatchMark(aStart, aEnd, bStart, bEnd, options);
	return lines.join("\n");
}
function joinAlignedDiffsExpand(diffs, options) {
	return diffs.map((diff, i, diffs) => {
		const line = diff[1];
		const isFirstOrLast = i === 0 || i === diffs.length - 1;
		switch (diff[0]) {
			case -1: return printDeleteLine(line, isFirstOrLast, options);
			case 1: return printInsertLine(line, isFirstOrLast, options);
			default: return printCommonLine(line, isFirstOrLast, options);
		}
	}).join("\n");
}
const noColor = (string) => string;
const DIFF_CONTEXT_DEFAULT = 5;
const DIFF_TRUNCATE_THRESHOLD_DEFAULT = 0;
function getDefaultOptions() {
	return {
		aAnnotation: "Expected",
		aColor: y.green,
		aIndicator: "-",
		bAnnotation: "Received",
		bColor: y.red,
		bIndicator: "+",
		changeColor: y.inverse,
		changeLineTrailingSpaceColor: noColor,
		commonColor: y.dim,
		commonIndicator: " ",
		commonLineTrailingSpaceColor: noColor,
		compareKeys: void 0,
		contextLines: DIFF_CONTEXT_DEFAULT,
		emptyFirstOrLastLinePlaceholder: "",
		expand: false,
		includeChangeCounts: false,
		omitAnnotationLines: false,
		patchColor: y.yellow,
		printBasicPrototype: false,
		truncateThreshold: DIFF_TRUNCATE_THRESHOLD_DEFAULT,
		truncateAnnotation: "... Diff result is truncated",
		truncateAnnotationColor: noColor
	};
}
function getCompareKeys(compareKeys) {
	return compareKeys && typeof compareKeys === "function" ? compareKeys : void 0;
}
function getContextLines(contextLines) {
	return typeof contextLines === "number" && Number.isSafeInteger(contextLines) && contextLines >= 0 ? contextLines : DIFF_CONTEXT_DEFAULT;
}
function normalizeDiffOptions(options = {}) {
	return {
		...getDefaultOptions(),
		...options,
		compareKeys: getCompareKeys(options.compareKeys),
		contextLines: getContextLines(options.contextLines)
	};
}
function isEmptyString(lines) {
	return lines.length === 1 && lines[0].length === 0;
}
function countChanges(diffs) {
	let a = 0;
	let b = 0;
	diffs.forEach((diff) => {
		switch (diff[0]) {
			case -1:
				a += 1;
				break;
			case 1:
				b += 1;
				break;
		}
	});
	return {
		a,
		b
	};
}
function printAnnotation({ aAnnotation, aColor, aIndicator, bAnnotation, bColor, bIndicator, includeChangeCounts, omitAnnotationLines }, changeCounts) {
	if (omitAnnotationLines) return "";
	let aRest = "";
	let bRest = "";
	if (includeChangeCounts) {
		const aCount = String(changeCounts.a);
		const bCount = String(changeCounts.b);
		const baAnnotationLengthDiff = bAnnotation.length - aAnnotation.length;
		const aAnnotationPadding = " ".repeat(Math.max(0, baAnnotationLengthDiff));
		const bAnnotationPadding = " ".repeat(Math.max(0, -baAnnotationLengthDiff));
		const baCountLengthDiff = bCount.length - aCount.length;
		const aCountPadding = " ".repeat(Math.max(0, baCountLengthDiff));
		const bCountPadding = " ".repeat(Math.max(0, -baCountLengthDiff));
		aRest = `${aAnnotationPadding}  ${aIndicator} ${aCountPadding}${aCount}`;
		bRest = `${bAnnotationPadding}  ${bIndicator} ${bCountPadding}${bCount}`;
	}
	const a = `${aIndicator} ${aAnnotation}${aRest}`;
	const b = `${bIndicator} ${bAnnotation}${bRest}`;
	return `${aColor(a)}\n${bColor(b)}\n\n`;
}
function printDiffLines(diffs, truncated, options) {
	return printAnnotation(options, countChanges(diffs)) + (options.expand ? joinAlignedDiffsExpand(diffs, options) : joinAlignedDiffsNoExpand(diffs, options)) + (truncated ? options.truncateAnnotationColor(`\n${options.truncateAnnotation}`) : "");
}
function diffLinesUnified(aLines, bLines, options) {
	const normalizedOptions = normalizeDiffOptions(options);
	const [diffs, truncated] = diffLinesRaw(isEmptyString(aLines) ? [] : aLines, isEmptyString(bLines) ? [] : bLines, normalizedOptions);
	return printDiffLines(diffs, truncated, normalizedOptions);
}
function diffLinesUnified2(aLinesDisplay, bLinesDisplay, aLinesCompare, bLinesCompare, options) {
	if (isEmptyString(aLinesDisplay) && isEmptyString(aLinesCompare)) {
		aLinesDisplay = [];
		aLinesCompare = [];
	}
	if (isEmptyString(bLinesDisplay) && isEmptyString(bLinesCompare)) {
		bLinesDisplay = [];
		bLinesCompare = [];
	}
	if (aLinesDisplay.length !== aLinesCompare.length || bLinesDisplay.length !== bLinesCompare.length) return diffLinesUnified(aLinesDisplay, bLinesDisplay, options);
	const [diffs, truncated] = diffLinesRaw(aLinesCompare, bLinesCompare, options);
	let aIndex = 0;
	let bIndex = 0;
	diffs.forEach((diff) => {
		switch (diff[0]) {
			case -1:
				diff[1] = aLinesDisplay[aIndex];
				aIndex += 1;
				break;
			case 1:
				diff[1] = bLinesDisplay[bIndex];
				bIndex += 1;
				break;
			default:
				diff[1] = bLinesDisplay[bIndex];
				aIndex += 1;
				bIndex += 1;
		}
	});
	return printDiffLines(diffs, truncated, normalizeDiffOptions(options));
}
function diffLinesRaw(aLines, bLines, options) {
	const truncate = options?.truncateThreshold ?? false;
	const truncateThreshold = Math.max(Math.floor(options?.truncateThreshold ?? 0), 0);
	const aLength = truncate ? Math.min(aLines.length, truncateThreshold) : aLines.length;
	const bLength = truncate ? Math.min(bLines.length, truncateThreshold) : bLines.length;
	const truncated = aLength !== aLines.length || bLength !== bLines.length;
	const isCommon = (aIndex, bIndex) => aLines[aIndex] === bLines[bIndex];
	const diffs = [];
	let aIndex = 0;
	let bIndex = 0;
	const foundSubsequence = (nCommon, aCommon, bCommon) => {
		for (; aIndex !== aCommon; aIndex += 1) diffs.push(new Diff(-1, aLines[aIndex]));
		for (; bIndex !== bCommon; bIndex += 1) diffs.push(new Diff(1, bLines[bIndex]));
		for (; nCommon !== 0; nCommon -= 1, aIndex += 1, bIndex += 1) diffs.push(new Diff(0, bLines[bIndex]));
	};
	diffSequences(aLength, bLength, isCommon, foundSubsequence);
	for (; aIndex !== aLength; aIndex += 1) diffs.push(new Diff(-1, aLines[aIndex]));
	for (; bIndex !== bLength; bIndex += 1) diffs.push(new Diff(1, bLines[bIndex]));
	return [diffs, truncated];
}
function getType(value) {
	if (value === void 0) return "undefined";
	else if (value === null) return "null";
	else if (Array.isArray(value)) return "array";
	else if (typeof value === "boolean") return "boolean";
	else if (typeof value === "function") return "function";
	else if (typeof value === "number") return "number";
	else if (typeof value === "string") return "string";
	else if (typeof value === "bigint") return "bigint";
	else if (typeof value === "object") {
		if (value != null) {
			if (value.constructor === RegExp) return "regexp";
			else if (value.constructor === Map) return "map";
			else if (value.constructor === Set) return "set";
			else if (value.constructor === Date) return "date";
		}
		return "object";
	} else if (typeof value === "symbol") return "symbol";
	throw new Error(`value of unknown type: ${value}`);
}
function getNewLineSymbol(string) {
	return string.includes("\r\n") ? "\r\n" : "\n";
}
function diffStrings(a, b, options) {
	const truncate = options?.truncateThreshold ?? false;
	const truncateThreshold = Math.max(Math.floor(options?.truncateThreshold ?? 0), 0);
	let aLength = a.length;
	let bLength = b.length;
	if (truncate) {
		const aMultipleLines = a.includes("\n");
		const bMultipleLines = b.includes("\n");
		const aNewLineSymbol = getNewLineSymbol(a);
		const bNewLineSymbol = getNewLineSymbol(b);
		const _a = aMultipleLines ? `${a.split(aNewLineSymbol, truncateThreshold).join(aNewLineSymbol)}\n` : a;
		const _b = bMultipleLines ? `${b.split(bNewLineSymbol, truncateThreshold).join(bNewLineSymbol)}\n` : b;
		aLength = _a.length;
		bLength = _b.length;
	}
	const truncated = aLength !== a.length || bLength !== b.length;
	const isCommon = (aIndex, bIndex) => a[aIndex] === b[bIndex];
	let aIndex = 0;
	let bIndex = 0;
	const diffs = [];
	const foundSubsequence = (nCommon, aCommon, bCommon) => {
		if (aIndex !== aCommon) diffs.push(new Diff(-1, a.slice(aIndex, aCommon)));
		if (bIndex !== bCommon) diffs.push(new Diff(1, b.slice(bIndex, bCommon)));
		aIndex = aCommon + nCommon;
		bIndex = bCommon + nCommon;
		diffs.push(new Diff(0, b.slice(bCommon, bIndex)));
	};
	diffSequences(aLength, bLength, isCommon, foundSubsequence);
	if (aIndex !== aLength) diffs.push(new Diff(-1, a.slice(aIndex)));
	if (bIndex !== bLength) diffs.push(new Diff(1, b.slice(bIndex)));
	return [diffs, truncated];
}
function concatenateRelevantDiffs(op, diffs, changeColor) {
	return diffs.reduce((reduced, diff) => reduced + (diff[0] === 0 ? diff[1] : diff[0] === op && diff[1].length !== 0 ? changeColor(diff[1]) : ""), "");
}
var ChangeBuffer = class {
	op;
	line;
	lines;
	changeColor;
	constructor(op, changeColor) {
		this.op = op;
		this.line = [];
		this.lines = [];
		this.changeColor = changeColor;
	}
	pushSubstring(substring) {
		this.pushDiff(new Diff(this.op, substring));
	}
	pushLine() {
		this.lines.push(this.line.length !== 1 ? new Diff(this.op, concatenateRelevantDiffs(this.op, this.line, this.changeColor)) : this.line[0][0] === this.op ? this.line[0] : new Diff(this.op, this.line[0][1]));
		this.line.length = 0;
	}
	isLineEmpty() {
		return this.line.length === 0;
	}
	pushDiff(diff) {
		this.line.push(diff);
	}
	align(diff) {
		const string = diff[1];
		if (string.includes("\n")) {
			const substrings = string.split("\n");
			const iLast = substrings.length - 1;
			substrings.forEach((substring, i) => {
				if (i < iLast) {
					this.pushSubstring(substring);
					this.pushLine();
				} else if (substring.length !== 0) this.pushSubstring(substring);
			});
		} else this.pushDiff(diff);
	}
	moveLinesTo(lines) {
		if (!this.isLineEmpty()) this.pushLine();
		lines.push(...this.lines);
		this.lines.length = 0;
	}
};
var CommonBuffer = class {
	deleteBuffer;
	insertBuffer;
	lines;
	constructor(deleteBuffer, insertBuffer) {
		this.deleteBuffer = deleteBuffer;
		this.insertBuffer = insertBuffer;
		this.lines = [];
	}
	pushDiffCommonLine(diff) {
		this.lines.push(diff);
	}
	pushDiffChangeLines(diff) {
		const isDiffEmpty = diff[1].length === 0;
		if (!isDiffEmpty || this.deleteBuffer.isLineEmpty()) this.deleteBuffer.pushDiff(diff);
		if (!isDiffEmpty || this.insertBuffer.isLineEmpty()) this.insertBuffer.pushDiff(diff);
	}
	flushChangeLines() {
		this.deleteBuffer.moveLinesTo(this.lines);
		this.insertBuffer.moveLinesTo(this.lines);
	}
	align(diff) {
		const op = diff[0];
		const string = diff[1];
		if (string.includes("\n")) {
			const substrings = string.split("\n");
			const iLast = substrings.length - 1;
			substrings.forEach((substring, i) => {
				if (i === 0) {
					const subdiff = new Diff(op, substring);
					if (this.deleteBuffer.isLineEmpty() && this.insertBuffer.isLineEmpty()) {
						this.flushChangeLines();
						this.pushDiffCommonLine(subdiff);
					} else {
						this.pushDiffChangeLines(subdiff);
						this.flushChangeLines();
					}
				} else if (i < iLast) this.pushDiffCommonLine(new Diff(op, substring));
				else if (substring.length !== 0) this.pushDiffChangeLines(new Diff(op, substring));
			});
		} else this.pushDiffChangeLines(diff);
	}
	getLines() {
		this.flushChangeLines();
		return this.lines;
	}
};
function getAlignedDiffs(diffs, changeColor) {
	const deleteBuffer = new ChangeBuffer(-1, changeColor);
	const insertBuffer = new ChangeBuffer(1, changeColor);
	const commonBuffer = new CommonBuffer(deleteBuffer, insertBuffer);
	diffs.forEach((diff) => {
		switch (diff[0]) {
			case -1:
				deleteBuffer.align(diff);
				break;
			case 1:
				insertBuffer.align(diff);
				break;
			default: commonBuffer.align(diff);
		}
	});
	return commonBuffer.getLines();
}
function hasCommonDiff(diffs, isMultiline) {
	if (isMultiline) {
		const iLast = diffs.length - 1;
		return diffs.some((diff, i) => diff[0] === 0 && (i !== iLast || diff[1] !== "\n"));
	}
	return diffs.some((diff) => diff[0] === 0);
}
function diffStringsUnified(a, b, options) {
	if (a !== b && a.length !== 0 && b.length !== 0) {
		const isMultiline = a.includes("\n") || b.includes("\n");
		const [diffs, truncated] = diffStringsRaw(isMultiline ? `${a}\n` : a, isMultiline ? `${b}\n` : b, true, options);
		if (hasCommonDiff(diffs, isMultiline)) {
			const optionsNormalized = normalizeDiffOptions(options);
			return printDiffLines(getAlignedDiffs(diffs, optionsNormalized.changeColor), truncated, optionsNormalized);
		}
	}
	return diffLinesUnified(a.split("\n"), b.split("\n"), options);
}
function diffStringsRaw(a, b, cleanup, options) {
	const [diffs, truncated] = diffStrings(a, b, options);
	if (cleanup) diff_cleanupSemantic(diffs);
	return [diffs, truncated];
}
function getCommonMessage(message, options) {
	const { commonColor } = normalizeDiffOptions(options);
	return commonColor(message);
}
const { AsymmetricMatcher, DOMCollection, DOMElement, Immutable, ReactElement, ReactTestComponent } = plugins;
const PLUGINS = [
	ReactTestComponent,
	ReactElement,
	DOMElement,
	DOMCollection,
	Immutable,
	AsymmetricMatcher,
	plugins.Error
];
const FORMAT_OPTIONS = {
	maxDepth: 20,
	plugins: PLUGINS
};
const FALLBACK_FORMAT_OPTIONS = {
	callToJSON: false,
	maxDepth: 8,
	plugins: PLUGINS
};
/**
* @param a Expected value
* @param b Received value
* @param options Diff options
* @returns {string | null} a string diff
*/
function diff(a, b, options) {
	if (Object.is(a, b)) return "";
	const aType = getType(a);
	let expectedType = aType;
	let omitDifference = false;
	if (aType === "object" && typeof a.asymmetricMatch === "function") {
		if (a.$$typeof !== Symbol.for("jest.asymmetricMatcher")) return;
		if (typeof a.getExpectedType !== "function") return;
		expectedType = a.getExpectedType();
		omitDifference = expectedType === "string";
	}
	if (expectedType !== getType(b)) {
		const { aAnnotation, aColor, aIndicator, bAnnotation, bColor, bIndicator } = normalizeDiffOptions(options);
		const formatOptions = getFormatOptions(FALLBACK_FORMAT_OPTIONS, options);
		let aDisplay = format$1(a, formatOptions);
		let bDisplay = format$1(b, formatOptions);
		const MAX_LENGTH = 1e5;
		function truncate(s) {
			return s.length <= MAX_LENGTH ? s : `${s.slice(0, MAX_LENGTH)}...`;
		}
		aDisplay = truncate(aDisplay);
		bDisplay = truncate(bDisplay);
		return `${`${aColor(`${aIndicator} ${aAnnotation}:`)}\n${aDisplay}`}\n\n${`${bColor(`${bIndicator} ${bAnnotation}:`)}\n${bDisplay}`}`;
	}
	if (omitDifference) return;
	switch (aType) {
		case "string": return diffLinesUnified(a.split("\n"), b.split("\n"), options);
		case "boolean":
		case "number": return comparePrimitive(a, b, options);
		case "map": return compareObjects(sortMap(a), sortMap(b), options);
		case "set": return compareObjects(sortSet(a), sortSet(b), options);
		default: return compareObjects(a, b, options);
	}
}
function comparePrimitive(a, b, options) {
	const aFormat = format$1(a, FORMAT_OPTIONS);
	const bFormat = format$1(b, FORMAT_OPTIONS);
	return aFormat === bFormat ? "" : diffLinesUnified(aFormat.split("\n"), bFormat.split("\n"), options);
}
function sortMap(map) {
	return new Map(Array.from(map.entries()).sort());
}
function sortSet(set) {
	return new Set(Array.from(set.values()).sort());
}
function compareObjects(a, b, options) {
	let difference;
	let hasThrown = false;
	try {
		difference = getObjectsDifference(a, b, getFormatOptions(FORMAT_OPTIONS, options), options);
	} catch {
		hasThrown = true;
	}
	const noDiffMessage = getCommonMessage(NO_DIFF_MESSAGE, options);
	if (difference === void 0 || difference === noDiffMessage) {
		difference = getObjectsDifference(a, b, getFormatOptions(FALLBACK_FORMAT_OPTIONS, options), options);
		if (difference !== noDiffMessage && !hasThrown) difference = `${getCommonMessage(SIMILAR_MESSAGE, options)}\n\n${difference}`;
	}
	return difference;
}
function getFormatOptions(formatOptions, options) {
	const { compareKeys, printBasicPrototype, maxDepth } = normalizeDiffOptions(options);
	return {
		...formatOptions,
		compareKeys,
		printBasicPrototype,
		maxDepth: maxDepth ?? formatOptions.maxDepth
	};
}
function getObjectsDifference(a, b, formatOptions, options) {
	const formatOptionsZeroIndent = {
		...formatOptions,
		indent: 0
	};
	const aCompare = format$1(a, formatOptionsZeroIndent);
	const bCompare = format$1(b, formatOptionsZeroIndent);
	if (aCompare === bCompare) return getCommonMessage(NO_DIFF_MESSAGE, options);
	else {
		const aDisplay = format$1(a, formatOptions);
		const bDisplay = format$1(b, formatOptions);
		return diffLinesUnified2(aDisplay.split("\n"), bDisplay.split("\n"), aCompare.split("\n"), bCompare.split("\n"), options);
	}
}
const MAX_DIFF_STRING_LENGTH = 2e4;
function isAsymmetricMatcher(data) {
	return getType$1(data) === "Object" && typeof data.asymmetricMatch === "function";
}
function isReplaceable(obj1, obj2) {
	const obj1Type = getType$1(obj1);
	return obj1Type === getType$1(obj2) && (obj1Type === "Object" || obj1Type === "Array");
}
function printDiffOrStringify(received, expected, options) {
	const { aAnnotation, bAnnotation } = normalizeDiffOptions(options);
	if (typeof expected === "string" && typeof received === "string" && expected.length > 0 && received.length > 0 && expected.length <= MAX_DIFF_STRING_LENGTH && received.length <= MAX_DIFF_STRING_LENGTH && expected !== received) {
		if (expected.includes("\n") || received.includes("\n")) return diffStringsUnified(expected, received, options);
		const [diffs] = diffStringsRaw(expected, received, true);
		const hasCommonDiff = diffs.some((diff) => diff[0] === 0);
		const printLabel = getLabelPrinter(aAnnotation, bAnnotation);
		return `${printLabel(aAnnotation) + printExpected(getCommonAndChangedSubstrings(diffs, -1, hasCommonDiff))}\n${printLabel(bAnnotation) + printReceived(getCommonAndChangedSubstrings(diffs, 1, hasCommonDiff))}`;
	}
	const clonedExpected = deepClone(expected, { forceWritable: true });
	const { replacedExpected, replacedActual } = replaceAsymmetricMatcher(deepClone(received, { forceWritable: true }), clonedExpected);
	return diff(replacedExpected, replacedActual, options);
}
function replaceAsymmetricMatcher(actual, expected, actualReplaced = /* @__PURE__ */ new WeakSet(), expectedReplaced = /* @__PURE__ */ new WeakSet()) {
	if (actual instanceof Error && expected instanceof Error && typeof actual.cause !== "undefined" && typeof expected.cause === "undefined") {
		delete actual.cause;
		return {
			replacedActual: actual,
			replacedExpected: expected
		};
	}
	if (!isReplaceable(actual, expected)) return {
		replacedActual: actual,
		replacedExpected: expected
	};
	if (actualReplaced.has(actual) || expectedReplaced.has(expected)) return {
		replacedActual: actual,
		replacedExpected: expected
	};
	actualReplaced.add(actual);
	expectedReplaced.add(expected);
	getOwnProperties(expected).forEach((key) => {
		const expectedValue = expected[key];
		const actualValue = actual[key];
		if (isAsymmetricMatcher(expectedValue)) {
			if (expectedValue.asymmetricMatch(actualValue)) expected[key] = actualValue;
			else if ("sample" in expectedValue && expectedValue.sample !== void 0 && isReplaceable(actualValue, expectedValue.sample)) {
				const replaced = replaceAsymmetricMatcher(actualValue, expectedValue.sample, actualReplaced, expectedReplaced);
				actual[key] = replaced.replacedActual;
				expected[key] = replaced.replacedExpected;
			}
		} else if (isAsymmetricMatcher(actualValue)) {
			if (actualValue.asymmetricMatch(expectedValue)) actual[key] = expectedValue;
			else if ("sample" in actualValue && actualValue.sample !== void 0 && isReplaceable(actualValue.sample, expectedValue)) {
				const replaced = replaceAsymmetricMatcher(actualValue.sample, expectedValue, actualReplaced, expectedReplaced);
				actual[key] = replaced.replacedActual;
				expected[key] = replaced.replacedExpected;
			}
		} else if (isReplaceable(actualValue, expectedValue)) {
			const replaced = replaceAsymmetricMatcher(actualValue, expectedValue, actualReplaced, expectedReplaced);
			actual[key] = replaced.replacedActual;
			expected[key] = replaced.replacedExpected;
		}
	});
	return {
		replacedActual: actual,
		replacedExpected: expected
	};
}
function getLabelPrinter(...strings) {
	const maxLength = strings.reduce((max, string) => string.length > max ? string.length : max, 0);
	return (string) => `${string}: ${" ".repeat(maxLength - string.length)}`;
}
const SPACE_SYMBOL = "·";
function replaceTrailingSpaces(text) {
	return text.replace(/\s+$/gm, (spaces) => SPACE_SYMBOL.repeat(spaces.length));
}
function printReceived(object) {
	return y.red(replaceTrailingSpaces(stringify(object)));
}
function printExpected(value) {
	return y.green(replaceTrailingSpaces(stringify(value)));
}
function getCommonAndChangedSubstrings(diffs, op, hasCommonDiff) {
	return diffs.reduce((reduced, diff) => reduced + (diff[0] === 0 ? diff[1] : diff[0] === op ? hasCommonDiff ? y.inverse(diff[1]) : diff[1] : ""), "");
}
//#endregion
//#region node_modules/@vitest/utils/dist/serialize.js
const IS_RECORD_SYMBOL = "@@__IMMUTABLE_RECORD__@@";
const IS_COLLECTION_SYMBOL = "@@__IMMUTABLE_ITERABLE__@@";
function isImmutable(v) {
	return v && (v[IS_COLLECTION_SYMBOL] || v[IS_RECORD_SYMBOL]);
}
const OBJECT_PROTO = Object.getPrototypeOf({});
function getUnserializableMessage(err) {
	if (err instanceof Error) return `<unserializable>: ${err.message}`;
	if (typeof err === "string") return `<unserializable>: ${err}`;
	return "<unserializable>";
}
function serializeValue(val, seen = /* @__PURE__ */ new WeakMap()) {
	if (!val || typeof val === "string") return val;
	if (val instanceof Error && "toJSON" in val && typeof val.toJSON === "function") {
		const jsonValue = val.toJSON();
		if (jsonValue && jsonValue !== val && typeof jsonValue === "object") {
			if (typeof val.message === "string") safe(() => jsonValue.message ??= normalizeErrorMessage(val.message));
			if (typeof val.stack === "string") safe(() => jsonValue.stack ??= val.stack);
			if (typeof val.name === "string") safe(() => jsonValue.name ??= val.name);
			if (val.cause != null) safe(() => jsonValue.cause ??= serializeValue(val.cause, seen));
		}
		return serializeValue(jsonValue, seen);
	}
	if (typeof val === "function") return `Function<${val.name || "anonymous"}>`;
	if (typeof val === "symbol") return val.toString();
	if (typeof val !== "object") return val;
	if (typeof Buffer !== "undefined" && val instanceof Buffer) return `<Buffer(${val.length}) ...>`;
	if (typeof Uint8Array !== "undefined" && val instanceof Uint8Array) return `<Uint8Array(${val.length}) ...>`;
	if (isImmutable(val)) return serializeValue(val.toJSON(), seen);
	if (val instanceof Promise || val.constructor && val.constructor.prototype === "AsyncFunction") return "Promise";
	if (typeof Element !== "undefined" && val instanceof Element) return val.tagName;
	if (typeof val.toJSON === "function") return serializeValue(val.toJSON(), seen);
	if (seen.has(val)) return seen.get(val);
	if (Array.isArray(val)) {
		const clone = new Array(val.length);
		seen.set(val, clone);
		val.forEach((e, i) => {
			try {
				clone[i] = serializeValue(e, seen);
			} catch (err) {
				clone[i] = getUnserializableMessage(err);
			}
		});
		return clone;
	} else {
		const clone = Object.create(null);
		seen.set(val, clone);
		let obj = val;
		while (obj && obj !== OBJECT_PROTO) {
			Object.getOwnPropertyNames(obj).forEach((key) => {
				if (key in clone) return;
				try {
					clone[key] = serializeValue(val[key], seen);
				} catch (err) {
					delete clone[key];
					clone[key] = getUnserializableMessage(err);
				}
			});
			obj = Object.getPrototypeOf(obj);
		}
		if (val instanceof Error) safe(() => clone.message = normalizeErrorMessage(val.message));
		return clone;
	}
}
function safe(fn) {
	try {
		return fn();
	} catch {}
}
function normalizeErrorMessage(message) {
	return message.replace(/\(0\s?,\s?__vite_ssr_import_\d+__.(\w+)\)/g, "$1").replace(/__(vite_ssr_import|vi_import)_\d+__\./g, "").replace(/getByTestId('__vitest_\d+__')/g, "page");
}
//#endregion
//#region node_modules/@vitest/utils/dist/error.js
function processError(_err, diffOptions, seen = /* @__PURE__ */ new WeakSet()) {
	if (!_err || typeof _err !== "object") return { message: String(_err) };
	const err = _err;
	if (err.showDiff || err.showDiff === void 0 && err.expected !== void 0 && err.actual !== void 0) err.diff = printDiffOrStringify(err.actual, err.expected, {
		...diffOptions,
		...err.diffOptions
	});
	if ("expected" in err && typeof err.expected !== "string") err.expected = stringify(err.expected, 10);
	if ("actual" in err && typeof err.actual !== "string") err.actual = stringify(err.actual, 10);
	try {
		if (!seen.has(err) && typeof err.cause === "object") {
			seen.add(err);
			err.cause = processError(err.cause, diffOptions, seen);
		}
	} catch {}
	try {
		return serializeValue(err);
	} catch (e) {
		return serializeValue(/* @__PURE__ */ new Error(`Failed to fully serialize error: ${e?.message}\nInner error message: ${err?.message}`));
	}
}
//#endregion
//#region node_modules/@vitest/utils/dist/timers.js
const SAFE_TIMERS_SYMBOL = Symbol("vitest:SAFE_TIMERS");
function getSafeTimers() {
	const { setTimeout: safeSetTimeout, setInterval: safeSetInterval, clearInterval: safeClearInterval, clearTimeout: safeClearTimeout, setImmediate: safeSetImmediate, clearImmediate: safeClearImmediate, queueMicrotask: safeQueueMicrotask } = globalThis[SAFE_TIMERS_SYMBOL] || globalThis;
	const { nextTick: safeNextTick } = globalThis[SAFE_TIMERS_SYMBOL] || globalThis.process || {};
	return {
		nextTick: safeNextTick,
		setTimeout: safeSetTimeout,
		setInterval: safeSetInterval,
		clearInterval: safeClearInterval,
		clearTimeout: safeClearTimeout,
		setImmediate: safeSetImmediate,
		clearImmediate: safeClearImmediate,
		queueMicrotask: safeQueueMicrotask
	};
}
/**
* Returns a promise that resolves after the specified duration.
*
* @param timeout - Delay in milliseconds
* @param scheduler - Timer function to use, defaults to `setTimeout`. Useful for mocked timers.
*
* @example
* await delay(100)
*
* @example
* // With mocked timers
* const { setTimeout } = getSafeTimers()
* await delay(100, setTimeout)
*/
function delay(timeout, scheduler = setTimeout) {
	return new Promise((resolve) => scheduler(resolve, timeout));
}
//#endregion
//#region node_modules/@vitest/utils/dist/chunk-pathe.M-eThtNZ.js
const _DRIVE_LETTER_START_RE = /^[A-Za-z]:\//;
function normalizeWindowsPath(input = "") {
	if (!input) return input;
	return input.replace(/\\/g, "/").replace(_DRIVE_LETTER_START_RE, (r) => r.toUpperCase());
}
const _IS_ABSOLUTE_RE = /^[/\\](?![/\\])|^[/\\]{2}(?!\.)|^[A-Za-z]:[/\\]/;
function cwd() {
	if (typeof process !== "undefined" && typeof process.cwd === "function") return process.cwd().replace(/\\/g, "/");
	return "/";
}
const resolve = function(...arguments_) {
	arguments_ = arguments_.map((argument) => normalizeWindowsPath(argument));
	let resolvedPath = "";
	let resolvedAbsolute = false;
	for (let index = arguments_.length - 1; index >= -1 && !resolvedAbsolute; index--) {
		const path = index >= 0 ? arguments_[index] : cwd();
		if (!path || path.length === 0) continue;
		resolvedPath = `${path}/${resolvedPath}`;
		resolvedAbsolute = isAbsolute(path);
	}
	resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);
	if (resolvedAbsolute && !isAbsolute(resolvedPath)) return `/${resolvedPath}`;
	return resolvedPath.length > 0 ? resolvedPath : ".";
};
function normalizeString(path, allowAboveRoot) {
	let res = "";
	let lastSegmentLength = 0;
	let lastSlash = -1;
	let dots = 0;
	let char = null;
	for (let index = 0; index <= path.length; ++index) {
		if (index < path.length) char = path[index];
		else if (char === "/") break;
		else char = "/";
		if (char === "/") {
			if (lastSlash === index - 1 || dots === 1);
			else if (dots === 2) {
				if (res.length < 2 || lastSegmentLength !== 2 || res[res.length - 1] !== "." || res[res.length - 2] !== ".") {
					if (res.length > 2) {
						const lastSlashIndex = res.lastIndexOf("/");
						if (lastSlashIndex === -1) {
							res = "";
							lastSegmentLength = 0;
						} else {
							res = res.slice(0, lastSlashIndex);
							lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
						}
						lastSlash = index;
						dots = 0;
						continue;
					} else if (res.length > 0) {
						res = "";
						lastSegmentLength = 0;
						lastSlash = index;
						dots = 0;
						continue;
					}
				}
				if (allowAboveRoot) {
					res += res.length > 0 ? "/.." : "..";
					lastSegmentLength = 2;
				}
			} else {
				if (res.length > 0) res += `/${path.slice(lastSlash + 1, index)}`;
				else res = path.slice(lastSlash + 1, index);
				lastSegmentLength = index - lastSlash - 1;
			}
			lastSlash = index;
			dots = 0;
		} else if (char === "." && dots !== -1) ++dots;
		else dots = -1;
	}
	return res;
}
const isAbsolute = function(p) {
	return _IS_ABSOLUTE_RE.test(p);
};
//#endregion
//#region node_modules/@vitest/utils/dist/source-map.js
var comma = ",".charCodeAt(0);
var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var intToChar = new Uint8Array(64);
var charToInt = new Uint8Array(128);
for (let i = 0; i < chars.length; i++) {
	const c = chars.charCodeAt(i);
	intToChar[i] = c;
	charToInt[c] = i;
}
function decodeInteger(reader, relative) {
	let value = 0;
	let shift = 0;
	let integer = 0;
	do {
		integer = charToInt[reader.next()];
		value |= (integer & 31) << shift;
		shift += 5;
	} while (integer & 32);
	const shouldNegate = value & 1;
	value >>>= 1;
	if (shouldNegate) value = -2147483648 | -value;
	return relative + value;
}
function hasMoreVlq(reader, max) {
	if (reader.pos >= max) return false;
	return reader.peek() !== comma;
}
var StringReader = class {
	constructor(buffer) {
		this.pos = 0;
		this.buffer = buffer;
	}
	next() {
		return this.buffer.charCodeAt(this.pos++);
	}
	peek() {
		return this.buffer.charCodeAt(this.pos);
	}
	indexOf(char) {
		const { buffer, pos } = this;
		const idx = buffer.indexOf(char, pos);
		return idx === -1 ? buffer.length : idx;
	}
};
function decode(mappings) {
	const { length } = mappings;
	const reader = new StringReader(mappings);
	const decoded = [];
	let genColumn = 0;
	let sourcesIndex = 0;
	let sourceLine = 0;
	let sourceColumn = 0;
	let namesIndex = 0;
	do {
		const semi = reader.indexOf(";");
		const line = [];
		let sorted = true;
		let lastCol = 0;
		genColumn = 0;
		while (reader.pos < semi) {
			let seg;
			genColumn = decodeInteger(reader, genColumn);
			if (genColumn < lastCol) sorted = false;
			lastCol = genColumn;
			if (hasMoreVlq(reader, semi)) {
				sourcesIndex = decodeInteger(reader, sourcesIndex);
				sourceLine = decodeInteger(reader, sourceLine);
				sourceColumn = decodeInteger(reader, sourceColumn);
				if (hasMoreVlq(reader, semi)) {
					namesIndex = decodeInteger(reader, namesIndex);
					seg = [
						genColumn,
						sourcesIndex,
						sourceLine,
						sourceColumn,
						namesIndex
					];
				} else seg = [
					genColumn,
					sourcesIndex,
					sourceLine,
					sourceColumn
				];
			} else seg = [genColumn];
			line.push(seg);
			reader.pos++;
		}
		if (!sorted) sort(line);
		decoded.push(line);
		reader.pos = semi + 1;
	} while (reader.pos <= length);
	return decoded;
}
function sort(line) {
	line.sort(sortComparator);
}
function sortComparator(a, b) {
	return a[0] - b[0];
}
var COLUMN = 0;
var SOURCES_INDEX = 1;
var SOURCE_LINE = 2;
var SOURCE_COLUMN = 3;
var NAMES_INDEX = 4;
var found = false;
function binarySearch(haystack, needle, low, high) {
	while (low <= high) {
		const mid = low + (high - low >> 1);
		const cmp = haystack[mid][COLUMN] - needle;
		if (cmp === 0) {
			found = true;
			return mid;
		}
		if (cmp < 0) low = mid + 1;
		else high = mid - 1;
	}
	found = false;
	return low - 1;
}
function upperBound(haystack, needle, index) {
	for (let i = index + 1; i < haystack.length; index = i++) if (haystack[i][COLUMN] !== needle) break;
	return index;
}
function lowerBound(haystack, needle, index) {
	for (let i = index - 1; i >= 0; index = i--) if (haystack[i][COLUMN] !== needle) break;
	return index;
}
function memoizedBinarySearch(haystack, needle, state, key) {
	const { lastKey, lastNeedle, lastIndex } = state;
	let low = 0;
	let high = haystack.length - 1;
	if (key === lastKey) {
		if (needle === lastNeedle) {
			found = lastIndex !== -1 && haystack[lastIndex][COLUMN] === needle;
			return lastIndex;
		}
		if (needle >= lastNeedle) low = lastIndex === -1 ? 0 : lastIndex;
		else high = lastIndex;
	}
	state.lastKey = key;
	state.lastNeedle = needle;
	return state.lastIndex = binarySearch(haystack, needle, low, high);
}
var LINE_GTR_ZERO = "`line` must be greater than 0 (lines start at line 1)";
var COL_GTR_EQ_ZERO = "`column` must be greater than or equal to 0 (columns start at column 0)";
var LEAST_UPPER_BOUND = -1;
var GREATEST_LOWER_BOUND = 1;
function cast(map) {
	return map;
}
function decodedMappings(map) {
	var _a;
	return (_a = cast(map))._decoded || (_a._decoded = decode(cast(map)._encoded));
}
function originalPositionFor(map, needle) {
	let { line, column, bias } = needle;
	line--;
	if (line < 0) throw new Error(LINE_GTR_ZERO);
	if (column < 0) throw new Error(COL_GTR_EQ_ZERO);
	const decoded = decodedMappings(map);
	if (line >= decoded.length) return OMapping(null, null, null, null);
	const segments = decoded[line];
	const index = traceSegmentInternal(segments, cast(map)._decodedMemo, line, column, bias || GREATEST_LOWER_BOUND);
	if (index === -1) return OMapping(null, null, null, null);
	const segment = segments[index];
	if (segment.length === 1) return OMapping(null, null, null, null);
	const { names, resolvedSources } = map;
	return OMapping(resolvedSources[segment[SOURCES_INDEX]], segment[SOURCE_LINE] + 1, segment[SOURCE_COLUMN], segment.length === 5 ? names[segment[NAMES_INDEX]] : null);
}
function OMapping(source, line, column, name) {
	return {
		source,
		line,
		column,
		name
	};
}
function traceSegmentInternal(segments, memo, line, column, bias) {
	let index = memoizedBinarySearch(segments, column, memo, line);
	if (found) index = (bias === LEAST_UPPER_BOUND ? upperBound : lowerBound)(segments, column, index);
	else if (bias === LEAST_UPPER_BOUND) index++;
	if (index === -1 || index === segments.length) return -1;
	return index;
}
const CHROME_IE_STACK_REGEXP = /^\s*at .*(?:\S:\d+|\(native\))/m;
const SAFARI_NATIVE_CODE_REGEXP = /^(?:eval@)?(?:\[native code\])?$/;
const stackIgnorePatterns = [
	"node:internal",
	/\/packages\/\w+\/dist\//,
	/\/@vitest\/\w+\/dist\//,
	"/vitest/dist/",
	"/vitest/src/",
	"/node_modules/chai/",
	"/node_modules/tinyspy/",
	"/vite/dist/node/module-runner",
	"/rolldown-vite/dist/node/module-runner",
	"/deps/chunk-",
	"/deps/@vitest",
	"/deps/loupe",
	"/deps/chai",
	"/browser-playwright/dist/locators.js",
	"/browser-webdriverio/dist/locators.js",
	"/browser-preview/dist/locators.js",
	/node:\w+/,
	/__vitest_test__/,
	/__vitest_browser__/,
	"/@id/__x00__vitest/browser",
	/\/deps\/vitest_/
];
const NOW_LENGTH = Date.now().toString().length;
const REGEXP_VITEST = new RegExp(`vitest=\\d{${NOW_LENGTH}}`);
function extractLocation(urlLike) {
	if (!urlLike.includes(":")) return [urlLike];
	const parts = /(.+?)(?::(\d+))?(?::(\d+))?$/.exec(urlLike.replace(/^\(|\)$/g, ""));
	if (!parts) return [urlLike];
	let url = parts[1];
	if (url.startsWith("async ")) url = url.slice(6);
	if (url.startsWith("http:") || url.startsWith("https:")) {
		const urlObj = new URL(url);
		urlObj.searchParams.delete("import");
		urlObj.searchParams.delete("browserv");
		url = urlObj.pathname + urlObj.hash + urlObj.search;
	}
	if (url.startsWith("/@fs/")) {
		const isWindows = /^\/@fs\/[a-zA-Z]:\//.test(url);
		url = url.slice(isWindows ? 5 : 4);
	}
	if (url.includes("vitest=")) url = url.replace(REGEXP_VITEST, "").replace(/[?&]$/, "");
	return [
		url,
		parts[2] || void 0,
		parts[3] || void 0
	];
}
function parseSingleFFOrSafariStack(raw) {
	let line = raw.trim();
	if (SAFARI_NATIVE_CODE_REGEXP.test(line)) return null;
	if (line.includes(" > eval")) line = line.replace(/ line (\d+)(?: > eval line \d+)* > eval:\d+:\d+/g, ":$1");
	if (!line.includes("@")) return null;
	let atIndex = -1;
	let locationPart = "";
	let functionName;
	for (let i = 0; i < line.length; i++) if (line[i] === "@") {
		const candidateLocation = line.slice(i + 1);
		if (candidateLocation.includes(":") && candidateLocation.length >= 3) {
			atIndex = i;
			locationPart = candidateLocation;
			functionName = i > 0 ? line.slice(0, i) : void 0;
			break;
		}
	}
	if (atIndex === -1 || !locationPart.includes(":") || locationPart.length < 3) return null;
	const [url, lineNumber, columnNumber] = extractLocation(locationPart);
	if (!url || !lineNumber || !columnNumber) return null;
	return {
		file: url,
		method: functionName || "",
		line: Number.parseInt(lineNumber),
		column: Number.parseInt(columnNumber)
	};
}
function parseSingleStack(raw) {
	const line = raw.trim();
	if (!CHROME_IE_STACK_REGEXP.test(line)) return parseSingleFFOrSafariStack(line);
	return parseSingleV8Stack(line);
}
function parseSingleV8Stack(raw) {
	let line = raw.trim();
	if (!CHROME_IE_STACK_REGEXP.test(line)) return null;
	if (line.includes("(eval ")) line = line.replace(/eval code/g, "eval").replace(/(\(eval at [^()]*)|(,.*$)/g, "");
	let sanitizedLine = line.replace(/^\s+/, "").replace(/\(eval code/g, "(").replace(/^.*?\s+/, "");
	const location = sanitizedLine.match(/ (\(.+\)$)/);
	sanitizedLine = location ? sanitizedLine.replace(location[0], "") : sanitizedLine;
	const [url, lineNumber, columnNumber] = extractLocation(location ? location[1] : sanitizedLine);
	let method = location && sanitizedLine || "";
	let file = url && ["eval", "<anonymous>"].includes(url) ? void 0 : url;
	if (!file || !lineNumber || !columnNumber) return null;
	if (method.startsWith("async ")) method = method.slice(6);
	if (file.startsWith("file://")) file = file.slice(7);
	file = file.startsWith("node:") || file.startsWith("internal:") ? file : resolve(file);
	if (method) method = method.replace(/\(0\s?,\s?__vite_ssr_import_\d+__.(\w+)\)/g, "$1").replace(/__(vite_ssr_import|vi_import)_\d+__\./g, "").replace(/(Object\.)?__vite_ssr_export_default__\s?/g, "");
	return {
		method,
		file,
		line: Number.parseInt(lineNumber),
		column: Number.parseInt(columnNumber)
	};
}
function parseStacktrace(stack, options = {}) {
	const { ignoreStackEntries = stackIgnorePatterns } = options;
	let stacks = !CHROME_IE_STACK_REGEXP.test(stack) ? parseFFOrSafariStackTrace(stack) : parseV8Stacktrace(stack);
	const helperIndex = stacks.findLastIndex((s) => s.method.includes("__VITEST_HELPER__"));
	if (helperIndex >= 0) stacks = stacks.slice(helperIndex + 1);
	return stacks.map((stack) => {
		if (options.getUrlId) stack.file = options.getUrlId(stack.file);
		const map = options.getSourceMap?.(stack.file);
		if (!map || typeof map !== "object" || !map.version) return shouldFilter(ignoreStackEntries, stack.file) ? null : stack;
		const position = getOriginalPosition(new DecodedMap(map, stack.file), stack);
		if (!position) return stack;
		const { line, column, source, name } = position;
		let file = source || stack.file;
		if (file.match(/\/\w:\//)) file = file.slice(1);
		if (shouldFilter(ignoreStackEntries, file)) return null;
		if (line != null && column != null) return {
			line,
			column,
			file,
			method: name || stack.method
		};
		return stack;
	}).filter((s) => s != null);
}
function shouldFilter(ignoreStackEntries, file) {
	return ignoreStackEntries.some((p) => file.match(p));
}
function parseFFOrSafariStackTrace(stack) {
	return stack.split("\n").map((line) => parseSingleFFOrSafariStack(line)).filter(notNullish);
}
function parseV8Stacktrace(stack) {
	return stack.split("\n").map((line) => parseSingleV8Stack(line)).filter(notNullish);
}
function parseErrorStacktrace(e, options = {}) {
	if (!e || isPrimitive(e)) return [];
	if ("stacks" in e && e.stacks) return e.stacks;
	const stackStr = e.stack || "";
	let stackFrames = typeof stackStr === "string" ? parseStacktrace(stackStr, options) : [];
	if (!stackFrames.length) {
		const e_ = e;
		if (e_.fileName != null && e_.lineNumber != null && e_.columnNumber != null) stackFrames = parseStacktrace(`${e_.fileName}:${e_.lineNumber}:${e_.columnNumber}`, options);
		if (e_.sourceURL != null && e_.line != null && e_._column != null) stackFrames = parseStacktrace(`${e_.sourceURL}:${e_.line}:${e_.column}`, options);
	}
	if (options.frameFilter) stackFrames = stackFrames.filter((f) => options.frameFilter(e, f) !== false);
	e.stacks = stackFrames;
	return stackFrames;
}
var DecodedMap = class {
	_encoded;
	_decoded;
	_decodedMemo;
	url;
	version;
	names = [];
	resolvedSources;
	constructor(map, from) {
		this.map = map;
		const { mappings, names, sources } = map;
		this.version = map.version;
		this.names = names || [];
		this._encoded = mappings || "";
		this._decodedMemo = memoizedState();
		this.url = from;
		this.resolvedSources = (sources || []).map((s) => resolve(from, "..", s || ""));
	}
};
function memoizedState() {
	return {
		lastKey: -1,
		lastNeedle: -1,
		lastIndex: -1
	};
}
function getOriginalPosition(map, needle) {
	const result = originalPositionFor(map, needle);
	if (result.column == null) return null;
	return result;
}
//#endregion
//#region node_modules/@vitest/runner/dist/chunk-artifact.js
var PendingError = class extends Error {
	code = "VITEST_PENDING";
	taskId;
	constructor(message, task, note) {
		super(message);
		this.message = message;
		this.note = note;
		this.taskId = task.id;
	}
};
var FixtureDependencyError = class extends Error {
	name = "FixtureDependencyError";
};
var FixtureAccessError = class extends Error {
	name = "FixtureAccessError";
};
var FixtureParseError = class extends Error {
	name = "FixtureParseError";
};
const fnMap = /* @__PURE__ */ new WeakMap();
const testFixtureMap = /* @__PURE__ */ new WeakMap();
const hooksMap = /* @__PURE__ */ new WeakMap();
function setFn(key, fn) {
	fnMap.set(key, fn);
}
function setTestFixture(key, fixture) {
	testFixtureMap.set(key, fixture);
}
function getTestFixtures(key) {
	return testFixtureMap.get(key);
}
function setHooks(key, hooks) {
	hooksMap.set(key, hooks);
}
function getHooks(key) {
	return hooksMap.get(key);
}
const FIXTURE_STACK_TRACE_KEY = Symbol.for("VITEST_FIXTURE_STACK_TRACE");
var TestFixtures = class TestFixtures {
	_suiteContexts;
	_overrides = /* @__PURE__ */ new WeakMap();
	_registrations;
	static _definitions = [];
	static _builtinFixtures = [
		"task",
		"signal",
		"onTestFailed",
		"onTestFinished",
		"skip",
		"annotate"
	];
	static _fixtureOptionKeys = [
		"auto",
		"injected",
		"scope"
	];
	static _fixtureScopes = [
		"test",
		"file",
		"worker"
	];
	static _workerContextSuite = { type: "worker" };
	static clearDefinitions() {
		TestFixtures._definitions.length = 0;
	}
	static getWorkerContexts() {
		return TestFixtures._definitions.map((f) => f.getWorkerContext());
	}
	static getFileContexts(file) {
		return TestFixtures._definitions.map((f) => f.getFileContext(file));
	}
	static isFixtureOptions(obj) {
		return isObject(obj) && Object.keys(obj).some((key) => TestFixtures._fixtureOptionKeys.includes(key));
	}
	constructor(registrations) {
		this._registrations = registrations ?? /* @__PURE__ */ new Map();
		this._suiteContexts = /* @__PURE__ */ new WeakMap();
		TestFixtures._definitions.push(this);
	}
	extend(runner, userFixtures) {
		const { suite } = getCurrentSuite();
		const isTopLevel = !suite || suite.file === suite;
		return new TestFixtures(this.parseUserFixtures(runner, userFixtures, isTopLevel));
	}
	get(suite) {
		let currentSuite = suite;
		while (currentSuite) {
			const overrides = this._overrides.get(currentSuite);
			if (overrides) return overrides;
			if (currentSuite === currentSuite.file) break;
			currentSuite = currentSuite.suite || currentSuite.file;
		}
		return this._registrations;
	}
	override(runner, userFixtures) {
		const { suite: currentSuite, file } = getCurrentSuite();
		const suite = currentSuite || file;
		const isTopLevel = !currentSuite || currentSuite.file === currentSuite;
		const suiteRegistrations = new Map(this.get(suite));
		const registrations = this.parseUserFixtures(runner, userFixtures, isTopLevel, suiteRegistrations);
		if (isTopLevel) this._registrations = registrations;
		else this._overrides.set(suite, registrations);
	}
	getFileContext(file) {
		if (!this._suiteContexts.has(file)) this._suiteContexts.set(file, Object.create(null));
		return this._suiteContexts.get(file);
	}
	getWorkerContext() {
		if (!this._suiteContexts.has(TestFixtures._workerContextSuite)) this._suiteContexts.set(TestFixtures._workerContextSuite, Object.create(null));
		return this._suiteContexts.get(TestFixtures._workerContextSuite);
	}
	parseUserFixtures(runner, userFixtures, supportNonTest, registrations = new Map(this._registrations)) {
		const errors = [];
		Object.entries(userFixtures).forEach(([name, fn]) => {
			let options;
			let value;
			let _options;
			if (Array.isArray(fn) && fn.length >= 2 && TestFixtures.isFixtureOptions(fn[1])) {
				_options = fn[1];
				options = {
					auto: _options.auto ?? false,
					scope: _options.scope ?? "test",
					injected: _options.injected ?? false
				};
				value = options.injected ? runner.injectValue?.(name) ?? fn[0] : fn[0];
			} else value = fn;
			const parent = registrations.get(name);
			if (parent && options) {
				if (parent.scope !== options.scope) errors.push(new FixtureDependencyError(`The "${name}" fixture was already registered with a "${options.scope}" scope.`));
				if (parent.auto !== options.auto) errors.push(new FixtureDependencyError(`The "${name}" fixture was already registered as { auto: ${options.auto} }.`));
			} else if (parent) options = {
				auto: parent.auto,
				scope: parent.scope,
				injected: parent.injected
			};
			else if (!options) options = {
				auto: false,
				injected: false,
				scope: "test"
			};
			if (options.scope && !TestFixtures._fixtureScopes.includes(options.scope)) errors.push(new FixtureDependencyError(`The "${name}" fixture has unknown scope "${options.scope}".`));
			if (!supportNonTest && options.scope !== "test") errors.push(new FixtureDependencyError(`The "${name}" fixture cannot be defined with a ${options.scope} scope${!_options?.scope && parent?.scope ? " (inherited from the base fixture)" : ""} inside the describe block. Define it at the top level of the file instead.`));
			const deps = isFixtureFunction(value) ? getUsedProps(value) : /* @__PURE__ */ new Set();
			const item = {
				name,
				value,
				auto: options.auto ?? false,
				injected: options.injected ?? false,
				scope: options.scope ?? "test",
				deps,
				parent
			};
			if (isFixtureFunction(value)) Object.assign(value, { [FIXTURE_STACK_TRACE_KEY]: /* @__PURE__ */ new Error("STACK_TRACE_ERROR") });
			registrations.set(name, item);
			if (item.scope === "worker" && (runner.pool === "vmThreads" || runner.pool === "vmForks")) item.scope = "file";
		});
		for (const fixture of registrations.values()) for (const depName of fixture.deps) {
			if (TestFixtures._builtinFixtures.includes(depName)) continue;
			const dep = registrations.get(depName);
			if (!dep) {
				errors.push(new FixtureDependencyError(`The "${fixture.name}" fixture depends on unknown fixture "${depName}".`));
				continue;
			}
			if (depName === fixture.name && !fixture.parent) {
				errors.push(new FixtureDependencyError(`The "${fixture.name}" fixture depends on itself, but does not have a base implementation.`));
				continue;
			}
			if (TestFixtures._fixtureScopes.indexOf(fixture.scope) > TestFixtures._fixtureScopes.indexOf(dep.scope)) {
				errors.push(new FixtureDependencyError(`The ${fixture.scope} "${fixture.name}" fixture cannot depend on a ${dep.scope} fixture "${dep.name}".`));
				continue;
			}
		}
		if (errors.length === 1) throw errors[0];
		else if (errors.length > 1) throw new AggregateError(errors, "Cannot resolve user fixtures. See errors for more information.");
		return registrations;
	}
};
const cleanupFnArrayMap = /* @__PURE__ */ new WeakMap();
const contextHasFixturesCache = /* @__PURE__ */ new WeakMap();
function withFixtures(fn, options) {
	const collector = getCurrentSuite();
	const suite = options?.suite || collector.suite || collector.file;
	return async (hookContext) => {
		const context = hookContext || options?.context;
		if (!context) {
			if (options?.suiteHook) validateSuiteHook(fn, options.suiteHook, options.stackTraceError);
			return fn({});
		}
		const fixtures = options?.fixtures || getTestFixtures(context);
		if (!fixtures) return fn(context);
		const registrations = fixtures.get(suite);
		if (!registrations.size) return fn(context);
		const usedFixtures = [];
		const usedProps = getUsedProps(fn);
		for (const fixture of registrations.values()) if (isAutoFixture(fixture, options) || usedProps.has(fixture.name)) usedFixtures.push(fixture);
		if (!usedFixtures.length) return fn(context);
		if (!cleanupFnArrayMap.has(context)) cleanupFnArrayMap.set(context, []);
		const cleanupFnArray = cleanupFnArrayMap.get(context);
		const pendingFixtures = resolveDeps(usedFixtures, registrations);
		if (!pendingFixtures.length) return fn(context);
		if (options?.suiteHook) {
			const testScopedFixtures = pendingFixtures.filter((f) => f.scope === "test");
			if (testScopedFixtures.length > 0) {
				const fixtureNames = testScopedFixtures.map((f) => `"${f.name}"`).join(", ");
				const error = new FixtureDependencyError(`Test-scoped fixtures cannot be used inside ${options.suiteHook} hook. The following fixtures are test-scoped: ${fixtureNames}. Use { scope: 'file' } or { scope: 'worker' } fixtures instead, or move the logic to ${{
					aroundAll: "aroundEach",
					beforeAll: "beforeEach",
					afterAll: "afterEach"
				}[options.suiteHook]} hook.`);
				if (options.stackTraceError?.stack) error.stack = error.message + options.stackTraceError.stack.replace(options.stackTraceError.message, "");
				throw error;
			}
		}
		if (!contextHasFixturesCache.has(context)) contextHasFixturesCache.set(context, /* @__PURE__ */ new WeakSet());
		const cachedFixtures = contextHasFixturesCache.get(context);
		for (const fixture of pendingFixtures) if (fixture.scope === "test") {
			if (cachedFixtures.has(fixture)) continue;
			cachedFixtures.add(fixture);
			const resolvedValue = await resolveTestFixtureValue(fixture, context, cleanupFnArray);
			context[fixture.name] = resolvedValue;
			cleanupFnArray.push(() => {
				cachedFixtures.delete(fixture);
			});
		} else {
			const resolvedValue = await resolveScopeFixtureValue(fixtures, suite, fixture);
			context[fixture.name] = resolvedValue;
		}
		return fn(context);
	};
}
function isAutoFixture(fixture, options) {
	if (!fixture.auto) return false;
	if (options?.suiteHook && fixture.scope === "test") return false;
	return true;
}
function isFixtureFunction(value) {
	return typeof value === "function";
}
function resolveTestFixtureValue(fixture, context, cleanupFnArray) {
	if (!isFixtureFunction(fixture.value)) return fixture.value;
	return resolveFixtureFunction(fixture.value, fixture.name, context, cleanupFnArray);
}
const scopedFixturePromiseCache = /* @__PURE__ */ new WeakMap();
async function resolveScopeFixtureValue(fixtures, suite, fixture) {
	const workerContext = fixtures.getWorkerContext();
	const fileContext = fixtures.getFileContext(suite.file);
	const fixtureContext = fixture.scope === "worker" ? workerContext : fileContext;
	if (!isFixtureFunction(fixture.value)) {
		fixtureContext[fixture.name] = fixture.value;
		return fixture.value;
	}
	if (fixture.name in fixtureContext) return fixtureContext[fixture.name];
	if (scopedFixturePromiseCache.has(fixture)) return scopedFixturePromiseCache.get(fixture);
	if (!cleanupFnArrayMap.has(fixtureContext)) cleanupFnArrayMap.set(fixtureContext, []);
	const cleanupFnFileArray = cleanupFnArrayMap.get(fixtureContext);
	const promise = resolveFixtureFunction(fixture.value, fixture.name, fixture.scope === "file" ? {
		...workerContext,
		...fileContext
	} : fixtureContext, cleanupFnFileArray).then((value) => {
		fixtureContext[fixture.name] = value;
		scopedFixturePromiseCache.delete(fixture);
		return value;
	});
	scopedFixturePromiseCache.set(fixture, promise);
	return promise;
}
async function resolveFixtureFunction(fixtureFn, fixtureName, context, cleanupFnArray) {
	const useFnArgPromise = createDefer();
	const stackTraceError = FIXTURE_STACK_TRACE_KEY in fixtureFn && fixtureFn[FIXTURE_STACK_TRACE_KEY] instanceof Error ? fixtureFn[FIXTURE_STACK_TRACE_KEY] : void 0;
	let isUseFnArgResolved = false;
	const fixtureReturn = fixtureFn(context, async (useFnArg) => {
		isUseFnArgResolved = true;
		useFnArgPromise.resolve(useFnArg);
		const useReturnPromise = createDefer();
		cleanupFnArray.push(async () => {
			useReturnPromise.resolve();
			await fixtureReturn;
		});
		await useReturnPromise;
	}).then(() => {
		if (!isUseFnArgResolved) {
			const error = /* @__PURE__ */ new Error(`Fixture "${fixtureName}" returned without calling "use". Make sure to call "use" in every code path of the fixture function.`);
			if (stackTraceError?.stack) error.stack = error.message + stackTraceError.stack.replace(stackTraceError.message, "");
			useFnArgPromise.reject(error);
		}
	}).catch((e) => {
		if (!isUseFnArgResolved) {
			useFnArgPromise.reject(e);
			return;
		}
		throw e;
	});
	return useFnArgPromise;
}
function resolveDeps(usedFixtures, registrations, depSet = /* @__PURE__ */ new Set(), pendingFixtures = []) {
	usedFixtures.forEach((fixture) => {
		if (pendingFixtures.includes(fixture)) return;
		if (!isFixtureFunction(fixture.value) || !fixture.deps) {
			pendingFixtures.push(fixture);
			return;
		}
		if (depSet.has(fixture)) if (fixture.parent) fixture = fixture.parent;
		else throw new Error(`Circular fixture dependency detected: ${fixture.name} <- ${[...depSet].reverse().map((d) => d.name).join(" <- ")}`);
		depSet.add(fixture);
		resolveDeps([...fixture.deps].map((n) => n === fixture.name ? fixture.parent : registrations.get(n)).filter((n) => !!n), registrations, depSet, pendingFixtures);
		pendingFixtures.push(fixture);
		depSet.clear();
	});
	return pendingFixtures;
}
function validateSuiteHook(fn, hook, suiteError) {
	const usedProps = getUsedProps(fn, {
		sourceError: suiteError,
		suiteHook: hook
	});
	if (usedProps.size) {
		const error = new FixtureAccessError(`The ${hook} hook uses fixtures "${[...usedProps].join("\", \"")}", but has no access to context. Did you forget to call it as "test.${hook}()" instead of "${hook}()"?\nIf you used internal "suite" task as the first argument previously, access it in the second argument instead. See https://vitest.dev/guide/test-context#suite-level-hooks`);
		if (suiteError) error.stack = suiteError.stack?.replace(suiteError.message, error.message);
		throw error;
	}
}
const kPropsSymbol = Symbol("$vitest:fixture-props");
const kPropNamesSymbol = Symbol("$vitest:fixture-prop-names");
function configureProps(fn, options) {
	Object.defineProperty(fn, kPropsSymbol, {
		value: options,
		enumerable: false
	});
}
function memoProps(fn, props) {
	fn[kPropNamesSymbol] = props;
	return props;
}
function getUsedProps(fn, { sourceError, suiteHook } = {}) {
	if (kPropNamesSymbol in fn) return fn[kPropNamesSymbol];
	const { index: fixturesIndex = 0, original: implementation = fn } = kPropsSymbol in fn ? fn[kPropsSymbol] : {};
	let fnString = filterOutComments(implementation.toString());
	if (/__async\((?:this|null), (?:null|arguments|\[[_0-9, ]*\]), function\*/.test(fnString)) fnString = fnString.split(/__async\((?:this|null),/)[1];
	const match = fnString.match(/[^(]*\(([^)]*)/);
	if (!match) return memoProps(fn, /* @__PURE__ */ new Set());
	const args = splitByComma(match[1]);
	if (!args.length) return memoProps(fn, /* @__PURE__ */ new Set());
	const fixturesArgument = args[fixturesIndex];
	if (!fixturesArgument) return memoProps(fn, /* @__PURE__ */ new Set());
	if (!(fixturesArgument[0] === "{" && fixturesArgument.endsWith("}"))) {
		const ordinalArgument = ordinal(fixturesIndex + 1);
		const error = new FixtureParseError(`The ${ordinalArgument} argument inside a fixture must use object destructuring pattern, e.g. ({ task } => {}). Instead, received "${fixturesArgument}".${suiteHook ? ` If you used internal "suite" task as the ${ordinalArgument} argument previously, access it in the ${ordinal(fixturesIndex + 2)} argument instead.` : ""}`);
		if (sourceError) error.stack = sourceError.stack?.replace(sourceError.message, error.message);
		throw error;
	}
	const props = splitByComma(fixturesArgument.slice(1, -1).replace(/\s/g, "")).map((prop) => {
		return prop.replace(/:.*|=.*/g, "");
	});
	const last = props.at(-1);
	if (last && last.startsWith("...")) {
		const error = new FixtureParseError(`Rest parameters are not supported in fixtures, received "${last}".`);
		if (sourceError) error.stack = sourceError.stack?.replace(sourceError.message, error.message);
		throw error;
	}
	return memoProps(fn, new Set(props));
}
function splitByComma(s) {
	const result = [];
	const stack = [];
	let start = 0;
	for (let i = 0; i < s.length; i++) if (s[i] === "{" || s[i] === "[") stack.push(s[i] === "{" ? "}" : "]");
	else if (s[i] === stack.at(-1)) stack.pop();
	else if (!stack.length && s[i] === ",") {
		const token = s.substring(start, i).trim();
		if (token) result.push(token);
		start = i + 1;
	}
	const lastToken = s.substring(start).trim();
	if (lastToken) result.push(lastToken);
	return result;
}
let _test;
function getCurrentTest() {
	return _test;
}
const kChainableContext = Symbol("kChainableContext");
function getChainableContext(chainable) {
	return chainable?.[kChainableContext];
}
function createChainable(keys, fn, context) {
	function create(context) {
		const chain = function(...args) {
			return fn.apply(context, args);
		};
		Object.assign(chain, fn);
		Object.defineProperty(chain, kChainableContext, {
			value: {
				withContext: () => chain.bind(context),
				getFixtures: () => context.fixtures,
				setContext: (key, value) => {
					context[key] = value;
				},
				mergeContext: (ctx) => {
					Object.assign(context, ctx);
				}
			},
			enumerable: false
		});
		for (const key of keys) Object.defineProperty(chain, key, { get() {
			return create({
				...context,
				[key]: true
			});
		} });
		return chain;
	}
	const chain = create(context ?? {});
	Object.defineProperty(chain, "fn", {
		value: fn,
		enumerable: false
	});
	return chain;
}
function getDefaultHookTimeout() {
	return getRunner().config.hookTimeout;
}
const CLEANUP_TIMEOUT_KEY = Symbol.for("VITEST_CLEANUP_TIMEOUT");
const CLEANUP_STACK_TRACE_KEY = Symbol.for("VITEST_CLEANUP_STACK_TRACE");
const AROUND_TIMEOUT_KEY = Symbol.for("VITEST_AROUND_TIMEOUT");
const AROUND_STACK_TRACE_KEY = Symbol.for("VITEST_AROUND_STACK_TRACE");
/**
* Registers a callback function to be executed once before all tests within the current suite.
* This hook is useful for scenarios where you need to perform setup operations that are common to all tests in a suite, such as initializing a database connection or setting up a test environment.
*
* **Note:** The `beforeAll` hooks are executed in the order they are defined one after another. You can configure this by changing the `sequence.hooks` option in the config file.
*
* @param {Function} fn - The callback function to be executed before all tests.
* @param {number} [timeout] - Optional timeout in milliseconds for the hook. If not provided, the default hook timeout from the runner's configuration is used.
* @returns {void}
* @example
* ```ts
* // Example of using beforeAll to set up a database connection
* beforeAll(async () => {
*   await database.connect();
* });
* ```
*/
function beforeAll(fn, timeout = getDefaultHookTimeout()) {
	assertTypes(fn, "\"beforeAll\" callback", ["function"]);
	const stackTraceError = /* @__PURE__ */ new Error("STACK_TRACE_ERROR");
	const context = getChainableContext(this);
	return getCurrentSuite().on("beforeAll", Object.assign(withTimeout(withSuiteFixtures("beforeAll", fn, context, stackTraceError), timeout, true, stackTraceError), {
		[CLEANUP_TIMEOUT_KEY]: timeout,
		[CLEANUP_STACK_TRACE_KEY]: stackTraceError
	}));
}
/**
* Registers a callback function to be executed once after all tests within the current suite have completed.
* This hook is useful for scenarios where you need to perform cleanup operations after all tests in a suite have run, such as closing database connections or cleaning up temporary files.
*
* **Note:** The `afterAll` hooks are running in reverse order of their registration. You can configure this by changing the `sequence.hooks` option in the config file.
*
* @param {Function} fn - The callback function to be executed after all tests.
* @param {number} [timeout] - Optional timeout in milliseconds for the hook. If not provided, the default hook timeout from the runner's configuration is used.
* @returns {void}
* @example
* ```ts
* // Example of using afterAll to close a database connection
* afterAll(async () => {
*   await database.disconnect();
* });
* ```
*/
function afterAll(fn, timeout) {
	assertTypes(fn, "\"afterAll\" callback", ["function"]);
	const context = getChainableContext(this);
	const stackTraceError = /* @__PURE__ */ new Error("STACK_TRACE_ERROR");
	return getCurrentSuite().on("afterAll", withTimeout(withSuiteFixtures("afterAll", fn, context, stackTraceError), timeout ?? getDefaultHookTimeout(), true, stackTraceError));
}
/**
* Registers a callback function to be executed before each test within the current suite.
* This hook is useful for scenarios where you need to reset or reinitialize the test environment before each test runs, such as resetting database states, clearing caches, or reinitializing variables.
*
* **Note:** The `beforeEach` hooks are executed in the order they are defined one after another. You can configure this by changing the `sequence.hooks` option in the config file.
*
* @param {Function} fn - The callback function to be executed before each test. This function receives an `TestContext` parameter if additional test context is needed.
* @param {number} [timeout] - Optional timeout in milliseconds for the hook. If not provided, the default hook timeout from the runner's configuration is used.
* @returns {void}
* @example
* ```ts
* // Example of using beforeEach to reset a database state
* beforeEach(async () => {
*   await database.reset();
* });
* ```
*/
function beforeEach(fn, timeout = getDefaultHookTimeout()) {
	assertTypes(fn, "\"beforeEach\" callback", ["function"]);
	const stackTraceError = /* @__PURE__ */ new Error("STACK_TRACE_ERROR");
	const wrapper = (context, suite) => {
		return withFixtures(fn, { suite })(context);
	};
	return getCurrentSuite().on("beforeEach", Object.assign(withTimeout(wrapper, timeout ?? getDefaultHookTimeout(), true, stackTraceError, abortIfTimeout), {
		[CLEANUP_TIMEOUT_KEY]: timeout,
		[CLEANUP_STACK_TRACE_KEY]: stackTraceError
	}));
}
/**
* Registers a callback function to be executed after each test within the current suite has completed.
* This hook is useful for scenarios where you need to clean up or reset the test environment after each test runs, such as deleting temporary files, clearing test-specific database entries, or resetting mocked functions.
*
* **Note:** The `afterEach` hooks are running in reverse order of their registration. You can configure this by changing the `sequence.hooks` option in the config file.
*
* @param {Function} fn - The callback function to be executed after each test. This function receives an `TestContext` parameter if additional test context is needed.
* @param {number} [timeout] - Optional timeout in milliseconds for the hook. If not provided, the default hook timeout from the runner's configuration is used.
* @returns {void}
* @example
* ```ts
* // Example of using afterEach to delete temporary files created during a test
* afterEach(async () => {
*   await fileSystem.deleteTempFiles();
* });
* ```
*/
function afterEach(fn, timeout) {
	assertTypes(fn, "\"afterEach\" callback", ["function"]);
	const wrapper = (context, suite) => {
		return withFixtures(fn, { suite })(context);
	};
	return getCurrentSuite().on("afterEach", withTimeout(wrapper, timeout ?? getDefaultHookTimeout(), true, /* @__PURE__ */ new Error("STACK_TRACE_ERROR"), abortIfTimeout));
}
createTestHook("onTestFailed", (test, handler, timeout) => {
	test.onFailed ||= [];
	test.onFailed.push(withTimeout(handler, timeout ?? getDefaultHookTimeout(), true, /* @__PURE__ */ new Error("STACK_TRACE_ERROR"), abortIfTimeout));
});
createTestHook("onTestFinished", (test, handler, timeout) => {
	test.onFinished ||= [];
	test.onFinished.push(withTimeout(handler, timeout ?? getDefaultHookTimeout(), true, /* @__PURE__ */ new Error("STACK_TRACE_ERROR"), abortIfTimeout));
});
/**
* Registers a callback function that wraps around all tests within the current suite.
* The callback receives a `runSuite` function that must be called to run the suite's tests.
* This hook is useful for scenarios where you need to wrap an entire suite in a context
* (e.g., starting a server, opening a database connection that all tests share).
*
* **Note:** When multiple `aroundAll` hooks are registered, they are nested inside each other.
* The first registered hook is the outermost wrapper.
*
* @param {Function} fn - The callback function that wraps the suite. Must call `runSuite()` to run the tests.
* @param {number} [timeout] - Optional timeout in milliseconds for the hook. If not provided, the default hook timeout from the runner's configuration is used.
* @returns {void}
* @example
* ```ts
* // Example of using aroundAll to wrap suite in a tracing span
* aroundAll(async (runSuite) => {
*   await tracer.trace('test-suite', runSuite);
* });
* ```
* @example
* ```ts
* // Example of using aroundAll with fixtures
* aroundAll(async (runSuite, { db }) => {
*   await db.transaction(() => runSuite());
* });
* ```
*/
function aroundAll(fn, timeout) {
	assertTypes(fn, "\"aroundAll\" callback", ["function"]);
	const stackTraceError = /* @__PURE__ */ new Error("STACK_TRACE_ERROR");
	const resolvedTimeout = timeout ?? getDefaultHookTimeout();
	const context = getChainableContext(this);
	return getCurrentSuite().on("aroundAll", Object.assign(withSuiteFixtures("aroundAll", fn, context, stackTraceError, 1), {
		[AROUND_TIMEOUT_KEY]: resolvedTimeout,
		[AROUND_STACK_TRACE_KEY]: stackTraceError
	}));
}
/**
* Registers a callback function that wraps around each test within the current suite.
* The callback receives a `runTest` function that must be called to run the test.
* This hook is useful for scenarios where you need to wrap tests in a context (e.g., database transactions).
*
* **Note:** When multiple `aroundEach` hooks are registered, they are nested inside each other.
* The first registered hook is the outermost wrapper.
*
* @param {Function} fn - The callback function that wraps the test. Must call `runTest()` to run the test.
* @param {number} [timeout] - Optional timeout in milliseconds for the hook. If not provided, the default hook timeout from the runner's configuration is used.
* @returns {void}
* @example
* ```ts
* // Example of using aroundEach to wrap tests in a database transaction
* aroundEach(async (runTest) => {
*   await database.transaction(() => runTest());
* });
* ```
* @example
* ```ts
* // Example of using aroundEach with fixtures
* aroundEach(async (runTest, { db }) => {
*   await db.transaction(() => runTest());
* });
* ```
*/
function aroundEach(fn, timeout) {
	assertTypes(fn, "\"aroundEach\" callback", ["function"]);
	const stackTraceError = /* @__PURE__ */ new Error("STACK_TRACE_ERROR");
	const resolvedTimeout = timeout ?? getDefaultHookTimeout();
	const wrapper = (runTest, context, suite) => {
		const innerFn = (ctx) => fn(runTest, ctx, suite);
		configureProps(innerFn, {
			index: 1,
			original: fn
		});
		return withFixtures(innerFn, { suite })(context);
	};
	return getCurrentSuite().on("aroundEach", Object.assign(wrapper, {
		[AROUND_TIMEOUT_KEY]: resolvedTimeout,
		[AROUND_STACK_TRACE_KEY]: stackTraceError
	}));
}
function withSuiteFixtures(suiteHook, fn, context, stackTraceError, contextIndex = 0) {
	return (...args) => {
		const suite = args.at(-1);
		const prefix = args.slice(0, -1);
		const wrapper = (ctx) => fn(...prefix, ctx, suite);
		configureProps(wrapper, {
			index: contextIndex,
			original: fn
		});
		const fixtures = context?.getFixtures();
		const fileContext = fixtures?.getFileContext(suite.file);
		return withFixtures(wrapper, {
			suiteHook,
			fixtures,
			context: fileContext,
			stackTraceError
		})();
	};
}
function createTestHook(name, handler) {
	return (fn, timeout) => {
		assertTypes(fn, `"${name}" callback`, ["function"]);
		const current = getCurrentTest();
		if (!current) throw new Error(`Hook ${name}() can only be called inside a test`);
		return handler(current, fn, timeout);
	};
}
function findTestFileStackTrace(testFilePath, error) {
	const lines = error.split("\n").slice(1);
	for (const line of lines) {
		const stack = parseSingleStack(line);
		if (stack && stack.file === testFilePath) return stack;
	}
}
function validateTags(config, tags) {
	if (!config.strictTags) return;
	const availableTags = new Set(config.tags.map((tag) => tag.name));
	for (const tag of tags) if (!availableTags.has(tag)) throw createNoTagsError(config.tags, tag);
}
function createNoTagsError(availableTags, tag, prefix = "tag") {
	if (!availableTags.length) throw new Error(`The Vitest config does't define any "tags", cannot apply "${tag}" ${prefix} for this test. See: https://vitest.dev/guide/test-tags`);
	throw new Error(`The ${prefix} "${tag}" is not defined in the configuration. Available tags are:\n${availableTags.map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}`).join("\n")}`);
}
function getNames(task) {
	const names = [task.name];
	let current = task;
	while (current?.suite) {
		current = current.suite;
		if (current?.name) names.unshift(current.name);
	}
	if (current !== task.file) names.unshift(task.file.name);
	return names;
}
function createTaskName(names, separator = " > ") {
	return names.filter((name) => name !== void 0).join(separator);
}
/**
* Creates a suite of tests, allowing for grouping and hierarchical organization of tests.
* Suites can contain both tests and other suites, enabling complex test structures.
*
* @param {string} name - The name of the suite, used for identification and reporting.
* @param {Function} fn - A function that defines the tests and suites within this suite.
* @example
* ```ts
* // Define a suite with two tests
* suite('Math operations', () => {
*   test('should add two numbers', () => {
*     expect(add(1, 2)).toBe(3);
*   });
*
*   test('should subtract two numbers', () => {
*     expect(subtract(5, 2)).toBe(3);
*   });
* });
* ```
* @example
* ```ts
* // Define nested suites
* suite('String operations', () => {
*   suite('Trimming', () => {
*     test('should trim whitespace from start and end', () => {
*       expect('  hello  '.trim()).toBe('hello');
*     });
*   });
*
*   suite('Concatenation', () => {
*     test('should concatenate two strings', () => {
*       expect('hello' + ' ' + 'world').toBe('hello world');
*     });
*   });
* });
* ```
*/
const suite = createSuite();
/**
* Defines a test case with a given name and test function. The test function can optionally be configured with test options.
*
* @param {string | Function} name - The name of the test or a function that will be used as a test name.
* @param {TestOptions | TestFunction} [optionsOrFn] - Optional. The test options or the test function if no explicit name is provided.
* @param {number | TestOptions | TestFunction} [optionsOrTest] - Optional. The test function or options, depending on the previous parameters.
* @throws {Error} If called inside another test function.
* @example
* ```ts
* // Define a simple test
* test('should add two numbers', () => {
*   expect(add(1, 2)).toBe(3);
* });
* ```
* @example
* ```ts
* // Define a test with options
* test('should subtract two numbers', { retry: 3 }, () => {
*   expect(subtract(5, 2)).toBe(3);
* });
* ```
*/
const test = createTest(function(name, optionsOrFn, optionsOrTest) {
	if (getCurrentTest()) throw new Error("Calling the test function inside another test function is not allowed. Please put it inside \"describe\" or \"suite\" so it can be properly collected.");
	getCurrentSuite().test.fn.call(this, formatName(name), optionsOrFn, optionsOrTest);
});
/**
* Creates a suite of tests, allowing for grouping and hierarchical organization of tests.
* Suites can contain both tests and other suites, enabling complex test structures.
*
* @param {string} name - The name of the suite, used for identification and reporting.
* @param {Function} fn - A function that defines the tests and suites within this suite.
* @example
* ```ts
* // Define a suite with two tests
* describe('Math operations', () => {
*   test('should add two numbers', () => {
*     expect(add(1, 2)).toBe(3);
*   });
*
*   test('should subtract two numbers', () => {
*     expect(subtract(5, 2)).toBe(3);
*   });
* });
* ```
* @example
* ```ts
* // Define nested suites
* describe('String operations', () => {
*   describe('Trimming', () => {
*     test('should trim whitespace from start and end', () => {
*       expect('  hello  '.trim()).toBe('hello');
*     });
*   });
*
*   describe('Concatenation', () => {
*     test('should concatenate two strings', () => {
*       expect('hello' + ' ' + 'world').toBe('hello world');
*     });
*   });
* });
* ```
*/
const describe = suite;
/**
* Defines a test case with a given name and test function. The test function can optionally be configured with test options.
*
* @param {string | Function} name - The name of the test or a function that will be used as a test name.
* @param {TestOptions | TestFunction} [optionsOrFn] - Optional. The test options or the test function if no explicit name is provided.
* @param {number | TestOptions | TestFunction} [optionsOrTest] - Optional. The test function or options, depending on the previous parameters.
* @throws {Error} If called inside another test function.
* @example
* ```ts
* // Define a simple test
* it('adds two numbers', () => {
*   expect(add(1, 2)).toBe(3);
* });
* ```
* @example
* ```ts
* // Define a test with options
* it('subtracts two numbers', { retry: 3 }, () => {
*   expect(subtract(5, 2)).toBe(3);
* });
* ```
*/
const it = test;
let runner;
let defaultSuite;
let currentTestFilepath;
function assert(condition, message) {
	if (!condition) throw new Error(`Vitest failed to find ${message}. One of the following is possible:
- "vitest" is imported directly without running "vitest" command
- "vitest" is imported inside "globalSetup" (to fix this, use "setupFiles" instead, because "globalSetup" runs in a different context)
- "vitest" is imported inside Vite / Vitest config file
- Otherwise, it might be a Vitest bug. Please report it to https://github.com/vitest-dev/vitest/issues
`);
}
function getRunner() {
	assert(runner, "the runner");
	return runner;
}
function getCurrentSuite() {
	const currentSuite = collectorContext.currentSuite || defaultSuite;
	assert(currentSuite, "the current suite");
	return currentSuite;
}
function createSuiteHooks() {
	return {
		beforeAll: [],
		afterAll: [],
		beforeEach: [],
		afterEach: [],
		aroundEach: [],
		aroundAll: []
	};
}
const POSITIVE_INFINITY = Number.POSITIVE_INFINITY;
function parseArguments(optionsOrFn, timeoutOrTest) {
	if (timeoutOrTest != null && typeof timeoutOrTest === "object") throw new TypeError(`Signature "test(name, fn, { ... })" was deprecated in Vitest 3 and removed in Vitest 4. Please, provide options as a second argument instead.`);
	let options = {};
	let fn;
	if (typeof timeoutOrTest === "number") options = { timeout: timeoutOrTest };
	else if (typeof optionsOrFn === "object") options = optionsOrFn;
	if (typeof optionsOrFn === "function") {
		if (typeof timeoutOrTest === "function") throw new TypeError("Cannot use two functions as arguments. Please use the second argument for options.");
		fn = optionsOrFn;
	} else if (typeof timeoutOrTest === "function") fn = timeoutOrTest;
	return {
		options,
		handler: fn
	};
}
function createSuiteCollector(name, factory = () => {}, mode, each, suiteOptions) {
	const tasks = [];
	let suite;
	initSuite(true);
	const task = function(name = "", options = {}) {
		const currentSuite = collectorContext.currentSuite?.suite;
		const testTags = unique([...(currentSuite ?? collectorContext.currentSuite?.file)?.tags || [], ...toArray(options.tags)]);
		const tagsOptions = testTags.map((tag) => {
			const tagDefinition = runner.config.tags?.find((t) => t.name === tag);
			if (!tagDefinition && runner.config.strictTags) throw createNoTagsError(runner.config.tags, tag);
			return tagDefinition;
		}).filter((r) => r != null).sort((tag1, tag2) => (tag2.priority ?? POSITIVE_INFINITY) - (tag1.priority ?? POSITIVE_INFINITY)).reduce((acc, tag) => {
			const { name, description, priority, meta, ...options } = tag;
			Object.assign(acc, options);
			if (meta) acc.meta = Object.assign(acc.meta ?? Object.create(null), meta);
			return acc;
		}, {});
		const testOwnMeta = options.meta;
		options = {
			...tagsOptions,
			...options
		};
		const timeout = options.timeout ?? runner.config.testTimeout;
		const parentMeta = currentSuite?.meta;
		const tagMeta = tagsOptions.meta;
		const testMeta = Object.create(null);
		if (tagMeta) Object.assign(testMeta, tagMeta);
		if (parentMeta) Object.assign(testMeta, parentMeta);
		if (testOwnMeta) Object.assign(testMeta, testOwnMeta);
		const task = {
			id: "",
			name,
			fullName: createTaskName([currentSuite?.fullName ?? collectorContext.currentSuite?.file?.fullName, name]),
			fullTestName: createTaskName([currentSuite?.fullTestName, name]),
			suite: currentSuite,
			each: options.each,
			fails: options.fails,
			context: void 0,
			type: "test",
			file: currentSuite?.file ?? collectorContext.currentSuite?.file,
			timeout,
			retry: options.retry ?? runner.config.retry,
			repeats: options.repeats,
			mode: options.only ? "only" : options.skip ? "skip" : options.todo ? "todo" : "run",
			meta: testMeta,
			annotations: [],
			artifacts: [],
			tags: testTags
		};
		const handler = options.handler;
		if (task.mode === "run" && !handler) task.mode = "todo";
		if (options.concurrent || !options.sequential && runner.config.sequence.concurrent) task.concurrent = true;
		task.shuffle = suiteOptions?.shuffle;
		const context = createTestContext(task, runner);
		Object.defineProperty(task, "context", {
			value: context,
			enumerable: false
		});
		setTestFixture(context, options.fixtures ?? new TestFixtures());
		const limit = Error.stackTraceLimit;
		Error.stackTraceLimit = 10;
		const stackTraceError = /* @__PURE__ */ new Error("STACK_TRACE_ERROR");
		Error.stackTraceLimit = limit;
		if (handler) setFn(task, withTimeout(withCancel(withAwaitAsyncAssertions(withFixtures(handler, { context }), task), task.context.signal), timeout, false, stackTraceError, (_, error) => abortIfTimeout([context], error)));
		if (runner.config.includeTaskLocation) {
			const error = stackTraceError.stack;
			const stack = findTestFileStackTrace(currentTestFilepath, error);
			if (stack) task.location = {
				line: stack.line,
				column: stack.column
			};
		}
		tasks.push(task);
		return task;
	};
	const test = createTest(function(name, optionsOrFn, timeoutOrTest) {
		let { options, handler } = parseArguments(optionsOrFn, timeoutOrTest);
		if (typeof suiteOptions === "object") options = Object.assign({}, suiteOptions, options);
		const concurrent = this.concurrent ?? (!this.sequential && options?.concurrent);
		if (options.concurrent != null && concurrent != null) options.concurrent = concurrent;
		const sequential = this.sequential ?? (!this.concurrent && options?.sequential);
		if (options.sequential != null && sequential != null) options.sequential = sequential;
		const test = task(formatName(name), {
			...this,
			...options,
			handler
		});
		test.type = "test";
	});
	const collector = {
		type: "collector",
		name,
		mode,
		suite,
		options: suiteOptions,
		test,
		file: suite.file,
		tasks,
		collect,
		task,
		clear,
		on: addHook
	};
	function addHook(name, ...fn) {
		getHooks(suite)[name].push(...fn);
	}
	function initSuite(includeLocation) {
		if (typeof suiteOptions === "number") suiteOptions = { timeout: suiteOptions };
		const currentSuite = collectorContext.currentSuite?.suite;
		const parentTask = currentSuite ?? collectorContext.currentSuite?.file;
		const suiteTags = toArray(suiteOptions?.tags);
		validateTags(runner.config, suiteTags);
		suite = {
			id: "",
			type: "suite",
			name,
			fullName: createTaskName([currentSuite?.fullName ?? collectorContext.currentSuite?.file?.fullName, name]),
			fullTestName: createTaskName([currentSuite?.fullTestName, name]),
			suite: currentSuite,
			mode,
			each,
			file: currentSuite?.file ?? collectorContext.currentSuite?.file,
			shuffle: suiteOptions?.shuffle,
			tasks: [],
			meta: suiteOptions?.meta ?? Object.create(null),
			concurrent: suiteOptions?.concurrent,
			tags: unique([...parentTask?.tags || [], ...suiteTags])
		};
		setHooks(suite, createSuiteHooks());
	}
	function clear() {
		tasks.length = 0;
		initSuite(false);
	}
	async function collect(file) {
		if (!file) throw new TypeError("File is required to collect tasks.");
		if (factory) await runWithSuite(collector, () => factory(test));
		const allChildren = [];
		for (const i of tasks) allChildren.push(i.type === "collector" ? await i.collect(file) : i);
		suite.tasks = allChildren;
		return suite;
	}
	collectTask(collector);
	return collector;
}
function withAwaitAsyncAssertions(fn, task) {
	return (async (...args) => {
		const fnResult = await fn(...args);
		if (task.promises) {
			const errors = (await Promise.allSettled(task.promises)).map((r) => r.status === "rejected" ? r.reason : void 0).filter(Boolean);
			if (errors.length) throw errors;
		}
		return fnResult;
	});
}
function createSuite() {
	function suiteFn(name, factoryOrOptions, optionsOrFactory) {
		if (getCurrentTest()) throw new Error("Calling the suite function inside test function is not allowed. It can be only called at the top level or inside another suite function.");
		const currentSuite = collectorContext.currentSuite || defaultSuite;
		let { options, handler: factory } = parseArguments(factoryOrOptions, optionsOrFactory);
		const isConcurrentSpecified = options.concurrent || this.concurrent || options.sequential === false;
		const isSequentialSpecified = options.sequential || this.sequential || options.concurrent === false;
		const { meta: parentMeta, ...parentOptions } = currentSuite?.options || {};
		options = {
			...parentOptions,
			...options
		};
		const shuffle = this.shuffle ?? options.shuffle ?? currentSuite?.options?.shuffle ?? runner?.config.sequence.shuffle;
		if (shuffle != null) options.shuffle = shuffle;
		let mode = this.only ?? options.only ? "only" : this.skip ?? options.skip ? "skip" : this.todo ?? options.todo ? "todo" : "run";
		if (mode === "run" && !factory) mode = "todo";
		const isConcurrent = isConcurrentSpecified || options.concurrent && !isSequentialSpecified;
		const isSequential = isSequentialSpecified || options.sequential && !isConcurrentSpecified;
		if (isConcurrent != null) options.concurrent = isConcurrent && !isSequential;
		if (isSequential != null) options.sequential = isSequential && !isConcurrent;
		if (parentMeta) options.meta = Object.assign(Object.create(null), parentMeta, options.meta);
		return createSuiteCollector(formatName(name), factory, mode, this.each, options);
	}
	suiteFn.each = function(cases, ...args) {
		const context = getChainableContext(this);
		const suite = context.withContext();
		context.setContext("each", true);
		if (Array.isArray(cases) && args.length) cases = formatTemplateString(cases, args);
		return (name, optionsOrFn, fnOrOptions) => {
			const _name = formatName(name);
			const arrayOnlyCases = cases.every(Array.isArray);
			const { options, handler } = parseArguments(optionsOrFn, fnOrOptions);
			const fnFirst = typeof optionsOrFn === "function";
			cases.forEach((i, idx) => {
				const items = Array.isArray(i) ? i : [i];
				if (fnFirst) if (arrayOnlyCases) suite(formatTitle(_name, items, idx), handler ? () => handler(...items) : void 0, options.timeout);
				else suite(formatTitle(_name, items, idx), handler ? () => handler(i) : void 0, options.timeout);
				else if (arrayOnlyCases) suite(formatTitle(_name, items, idx), options, handler ? () => handler(...items) : void 0);
				else suite(formatTitle(_name, items, idx), options, handler ? () => handler(i) : void 0);
			});
			context.setContext("each", void 0);
		};
	};
	suiteFn.for = function(cases, ...args) {
		if (Array.isArray(cases) && args.length) cases = formatTemplateString(cases, args);
		return (name, optionsOrFn, fnOrOptions) => {
			const name_ = formatName(name);
			const { options, handler } = parseArguments(optionsOrFn, fnOrOptions);
			cases.forEach((item, idx) => {
				suite(formatTitle(name_, toArray(item), idx), options, handler ? () => handler(item) : void 0);
			});
		};
	};
	suiteFn.skipIf = (condition) => condition ? suite.skip : suite;
	suiteFn.runIf = (condition) => condition ? suite : suite.skip;
	return createChainable([
		"concurrent",
		"sequential",
		"shuffle",
		"skip",
		"only",
		"todo"
	], suiteFn);
}
function createTaskCollector(fn) {
	const taskFn = fn;
	taskFn.each = function(cases, ...args) {
		const context = getChainableContext(this);
		const test = context.withContext();
		context.setContext("each", true);
		if (Array.isArray(cases) && args.length) cases = formatTemplateString(cases, args);
		return (name, optionsOrFn, fnOrOptions) => {
			const _name = formatName(name);
			const arrayOnlyCases = cases.every(Array.isArray);
			const { options, handler } = parseArguments(optionsOrFn, fnOrOptions);
			const fnFirst = typeof optionsOrFn === "function";
			cases.forEach((i, idx) => {
				const items = Array.isArray(i) ? i : [i];
				if (fnFirst) if (arrayOnlyCases) test(formatTitle(_name, items, idx), handler ? () => handler(...items) : void 0, options.timeout);
				else test(formatTitle(_name, items, idx), handler ? () => handler(i) : void 0, options.timeout);
				else if (arrayOnlyCases) test(formatTitle(_name, items, idx), options, handler ? () => handler(...items) : void 0);
				else test(formatTitle(_name, items, idx), options, handler ? () => handler(i) : void 0);
			});
			context.setContext("each", void 0);
		};
	};
	taskFn.for = function(cases, ...args) {
		const test = getChainableContext(this).withContext();
		if (Array.isArray(cases) && args.length) cases = formatTemplateString(cases, args);
		return (name, optionsOrFn, fnOrOptions) => {
			const _name = formatName(name);
			const { options, handler } = parseArguments(optionsOrFn, fnOrOptions);
			cases.forEach((item, idx) => {
				const handlerWrapper = handler ? (ctx) => handler(item, ctx) : void 0;
				if (handlerWrapper) configureProps(handlerWrapper, {
					index: 1,
					original: handler
				});
				test(formatTitle(_name, toArray(item), idx), options, handlerWrapper);
			});
		};
	};
	taskFn.skipIf = function(condition) {
		return condition ? this.skip : this;
	};
	taskFn.runIf = function(condition) {
		return condition ? this : this.skip;
	};
	/**
	* Parse builder pattern arguments into a fixtures object.
	* Handles both builder pattern (name, options?, value) and object syntax.
	*/
	function parseBuilderFixtures(fixturesOrName, optionsOrFn, maybeFn) {
		if (typeof fixturesOrName !== "string") return fixturesOrName;
		const fixtureName = fixturesOrName;
		let fixtureOptions;
		let fixtureValue;
		if (maybeFn !== void 0) {
			fixtureOptions = optionsOrFn;
			fixtureValue = maybeFn;
		} else if (optionsOrFn !== null && typeof optionsOrFn === "object" && !Array.isArray(optionsOrFn) && TestFixtures.isFixtureOptions(optionsOrFn)) {
			fixtureOptions = optionsOrFn;
			fixtureValue = {};
		} else {
			fixtureOptions = void 0;
			fixtureValue = optionsOrFn;
		}
		if (typeof fixtureValue === "function") {
			const builderFn = fixtureValue;
			const fixture = async (ctx, use) => {
				let cleanup;
				const onCleanup = (fn) => {
					if (cleanup !== void 0) throw new Error("onCleanup can only be called once per fixture. Define separate fixtures if you need multiple cleanup functions.");
					cleanup = fn;
				};
				await use(await builderFn(ctx, { onCleanup }));
				if (cleanup) await cleanup();
			};
			configureProps(fixture, { original: builderFn });
			if (fixtureOptions) return { [fixtureName]: [fixture, fixtureOptions] };
			return { [fixtureName]: fixture };
		}
		if (fixtureOptions) return { [fixtureName]: [fixtureValue, fixtureOptions] };
		return { [fixtureName]: fixtureValue };
	}
	taskFn.override = function(fixturesOrName, optionsOrFn, maybeFn) {
		const userFixtures = parseBuilderFixtures(fixturesOrName, optionsOrFn, maybeFn);
		getChainableContext(this).getFixtures().override(runner, userFixtures);
		return this;
	};
	taskFn.scoped = function(fixtures) {
		console.warn(`test.scoped() is deprecated and will be removed in future versions. Please use test.override() instead.`);
		return this.override(fixtures);
	};
	taskFn.extend = function(fixturesOrName, optionsOrFn, maybeFn) {
		const userFixtures = parseBuilderFixtures(fixturesOrName, optionsOrFn, maybeFn);
		const fixtures = getChainableContext(this).getFixtures().extend(runner, userFixtures);
		const _test = createTest(function(name, optionsOrFn, optionsOrTest) {
			fn.call(this, formatName(name), optionsOrFn, optionsOrTest);
		});
		getChainableContext(_test).mergeContext({ fixtures });
		return _test;
	};
	taskFn.describe = suite;
	taskFn.suite = suite;
	taskFn.beforeEach = beforeEach;
	taskFn.afterEach = afterEach;
	taskFn.beforeAll = beforeAll;
	taskFn.afterAll = afterAll;
	taskFn.aroundEach = aroundEach;
	taskFn.aroundAll = aroundAll;
	return createChainable([
		"concurrent",
		"sequential",
		"skip",
		"only",
		"todo",
		"fails"
	], taskFn, { fixtures: new TestFixtures() });
}
function createTest(fn) {
	return createTaskCollector(fn);
}
function formatName(name) {
	return typeof name === "string" ? name : typeof name === "function" ? name.name || "<anonymous>" : String(name);
}
function formatTitle(template, items, idx) {
	if (template.includes("%#") || template.includes("%$")) template = template.replace(/%%/g, "__vitest_escaped_%__").replace(/%#/g, `${idx}`).replace(/%\$/g, `${idx + 1}`).replace(/__vitest_escaped_%__/g, "%%");
	const count = template.split("%").length - 1;
	if (template.includes("%f")) (template.match(/%f/g) || []).forEach((_, i) => {
		if (isNegativeNaN(items[i]) || Object.is(items[i], -0)) {
			let occurrence = 0;
			template = template.replace(/%f/g, (match) => {
				occurrence++;
				return occurrence === i + 1 ? "-%f" : match;
			});
		}
	});
	const isObjectItem = isObject(items[0]);
	function formatAttribute(s) {
		return s.replace(/\$([$\w.]+)/g, (_, key) => {
			const isArrayKey = /^\d+$/.test(key);
			if (!isObjectItem && !isArrayKey) return `$${key}`;
			const arrayElement = isArrayKey ? objectAttr(items, key) : void 0;
			return objDisplay(isObjectItem ? objectAttr(items[0], key, arrayElement) : arrayElement, { truncate: runner?.config?.chaiConfig?.truncateThreshold });
		});
	}
	let output = "";
	let i = 0;
	handleRegexMatch(template, formatRegExp, (match) => {
		if (i < count) output += format(match[0], items[i++]);
		else output += match[0];
	}, (nonMatch) => {
		output += formatAttribute(nonMatch);
	});
	return output;
}
function handleRegexMatch(input, regex, onMatch, onNonMatch) {
	let lastIndex = 0;
	for (const m of input.matchAll(regex)) {
		if (lastIndex < m.index) onNonMatch(input.slice(lastIndex, m.index));
		onMatch(m);
		lastIndex = m.index + m[0].length;
	}
	if (lastIndex < input.length) onNonMatch(input.slice(lastIndex));
}
function formatTemplateString(cases, args) {
	const header = cases.join("").trim().replace(/ /g, "").split("\n").map((i) => i.split("|"))[0];
	const res = [];
	for (let i = 0; i < Math.floor(args.length / header.length); i++) {
		const oneCase = {};
		for (let j = 0; j < header.length; j++) oneCase[header[j]] = args[i * header.length + j];
		res.push(oneCase);
	}
	return res;
}
const now$2 = globalThis.performance ? globalThis.performance.now.bind(globalThis.performance) : Date.now;
const collectorContext = {
	tasks: [],
	currentSuite: null
};
function collectTask(task) {
	collectorContext.currentSuite?.tasks.push(task);
}
async function runWithSuite(suite, fn) {
	const prev = collectorContext.currentSuite;
	collectorContext.currentSuite = suite;
	await fn();
	collectorContext.currentSuite = prev;
}
function withTimeout(fn, timeout, isHook = false, stackTraceError, onTimeout) {
	if (timeout <= 0 || timeout === Number.POSITIVE_INFINITY) return fn;
	const { setTimeout, clearTimeout } = getSafeTimers();
	return (function runWithTimeout(...args) {
		const startTime = now$2();
		const runner = getRunner();
		runner._currentTaskStartTime = startTime;
		runner._currentTaskTimeout = timeout;
		return new Promise((resolve_, reject_) => {
			const timer = setTimeout(() => {
				clearTimeout(timer);
				rejectTimeoutError();
			}, timeout);
			timer.unref?.();
			function rejectTimeoutError() {
				const error = makeTimeoutError(isHook, timeout, stackTraceError);
				onTimeout?.(args, error);
				reject_(error);
			}
			function resolve(result) {
				runner._currentTaskStartTime = void 0;
				runner._currentTaskTimeout = void 0;
				clearTimeout(timer);
				if (now$2() - startTime >= timeout) {
					rejectTimeoutError();
					return;
				}
				resolve_(result);
			}
			function reject(error) {
				runner._currentTaskStartTime = void 0;
				runner._currentTaskTimeout = void 0;
				clearTimeout(timer);
				reject_(error);
			}
			try {
				const result = fn(...args);
				if (typeof result === "object" && result != null && typeof result.then === "function") result.then(resolve, reject);
				else resolve(result);
			} catch (error) {
				reject(error);
			}
		});
	});
}
function withCancel(fn, signal) {
	return (function runWithCancel(...args) {
		return new Promise((resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason));
			try {
				const result = fn(...args);
				if (typeof result === "object" && result != null && typeof result.then === "function") result.then(resolve, reject);
				else resolve(result);
			} catch (error) {
				reject(error);
			}
		});
	});
}
const abortControllers = /* @__PURE__ */ new WeakMap();
function abortIfTimeout([context], error) {
	if (context) abortContextSignal(context, error);
}
function abortContextSignal(context, error) {
	abortControllers.get(context)?.abort(error);
}
function createTestContext(test, runner) {
	const context = function() {
		throw new Error("done() callback is deprecated, use promise instead");
	};
	let abortController = abortControllers.get(context);
	if (!abortController) {
		abortController = new AbortController();
		abortControllers.set(context, abortController);
	}
	context.signal = abortController.signal;
	context.task = test;
	context.skip = (condition, note) => {
		if (condition === false) return;
		test.result ??= { state: "skip" };
		test.result.pending = true;
		throw new PendingError("test is skipped; abort execution", test, typeof condition === "string" ? condition : note);
	};
	context.annotate = ((message, type, attachment) => {
		if (test.result && test.result.state !== "run") throw new Error(`Cannot annotate tests outside of the test run. The test "${test.name}" finished running with the "${test.result.state}" state already.`);
		const annotation = {
			message,
			type: typeof type === "object" || type === void 0 ? "notice" : type
		};
		const annotationAttachment = typeof type === "object" ? type : attachment;
		if (annotationAttachment) {
			annotation.attachment = annotationAttachment;
			manageArtifactAttachment(annotation.attachment);
		}
		return recordAsyncOperation(test, recordArtifact(test, {
			type: "internal:annotation",
			annotation
		}).then(async ({ annotation }) => {
			if (!runner.onTestAnnotate) throw new Error(`Test runner doesn't support test annotations.`);
			await finishSendTasksUpdate(runner);
			const resolvedAnnotation = await runner.onTestAnnotate(test, annotation);
			test.annotations.push(resolvedAnnotation);
			return resolvedAnnotation;
		}));
	});
	context.onTestFailed = (handler, timeout) => {
		test.onFailed ||= [];
		test.onFailed.push(withTimeout(handler, timeout ?? runner.config.hookTimeout, true, /* @__PURE__ */ new Error("STACK_TRACE_ERROR"), (_, error) => abortController.abort(error)));
	};
	context.onTestFinished = (handler, timeout) => {
		test.onFinished ||= [];
		test.onFinished.push(withTimeout(handler, timeout ?? runner.config.hookTimeout, true, /* @__PURE__ */ new Error("STACK_TRACE_ERROR"), (_, error) => abortController.abort(error)));
	};
	return runner.extendTaskContext?.(context) || context;
}
function makeTimeoutError(isHook, timeout, stackTraceError) {
	const message = `${isHook ? "Hook" : "Test"} timed out in ${timeout}ms.\nIf this is a long-running ${isHook ? "hook" : "test"}, pass a timeout value as the last argument or configure it globally with "${isHook ? "hookTimeout" : "testTimeout"}".`;
	const error = new Error(message);
	if (stackTraceError?.stack) error.stack = stackTraceError.stack.replace(error.message, stackTraceError.message);
	return error;
}
globalThis.performance ? globalThis.performance.now.bind(globalThis.performance) : Date.now;
globalThis.performance ? globalThis.performance.now.bind(globalThis.performance) : Date.now;
const unixNow = Date.now;
const { clearTimeout, setTimeout: setTimeout$1 } = getSafeTimers();
const packs = /* @__PURE__ */ new Map();
const eventsPacks = [];
const pendingTasksUpdates = [];
function sendTasksUpdate(runner) {
	if (packs.size) {
		const taskPacks = Array.from(packs).map(([id, task]) => {
			return [
				id,
				task[0],
				task[1]
			];
		});
		const p = runner.onTaskUpdate?.(taskPacks, eventsPacks);
		if (p) {
			pendingTasksUpdates.push(p);
			p.then(() => pendingTasksUpdates.splice(pendingTasksUpdates.indexOf(p), 1), () => {});
		}
		eventsPacks.length = 0;
		packs.clear();
	}
}
async function finishSendTasksUpdate(runner) {
	sendTasksUpdate(runner);
	await Promise.all(pendingTasksUpdates);
}
function throttle(fn, ms) {
	let last = 0;
	let pendingCall;
	return function call(...args) {
		const now = unixNow();
		if (now - last > ms) {
			last = now;
			clearTimeout(pendingCall);
			pendingCall = void 0;
			return fn.apply(this, args);
		}
		pendingCall ??= setTimeout$1(() => call.bind(this)(...args), ms);
	};
}
throttle(sendTasksUpdate, 100);
/**
* @experimental
* @advanced
*
* Records a custom test artifact during test execution.
*
* This function allows you to attach structured data, files, or metadata to a test.
*
* Vitest automatically injects the source location where the artifact was created and manages any attachments you include.
*
* **Note:** artifacts must be recorded before the task is reported. Any artifacts recorded after that will not be included in the task.
*
* @param task - The test task context, typically accessed via `this.task` in custom matchers or `context.task` in tests
* @param artifact - The artifact to record. Must extend {@linkcode TestArtifactBase}
*
* @returns A promise that resolves to the recorded artifact with location injected
*
* @throws {Error} If the test runner doesn't support artifacts
*
* @example
* ```ts
* // In a custom assertion
* async function toHaveValidSchema(this: MatcherState, actual: unknown) {
*   const validation = validateSchema(actual)
*
*   await recordArtifact(this.task, {
*     type: 'my-plugin:schema-validation',
*     passed: validation.valid,
*     errors: validation.errors,
*   })
*
*   return { pass: validation.valid, message: () => '...' }
* }
* ```
*/
async function recordArtifact(task, artifact) {
	const runner = getRunner();
	const stack = findTestFileStackTrace(task.file.filepath, (/* @__PURE__ */ new Error("STACK_TRACE")).stack);
	if (stack) {
		artifact.location = {
			file: stack.file,
			line: stack.line,
			column: stack.column
		};
		if (artifact.type === "internal:annotation") artifact.annotation.location = artifact.location;
	}
	if (Array.isArray(artifact.attachments)) for (const attachment of artifact.attachments) manageArtifactAttachment(attachment);
	if (artifact.type === "internal:annotation") return artifact;
	if (!runner.onTestArtifactRecord) throw new Error(`Test runner doesn't support test artifacts.`);
	await finishSendTasksUpdate(runner);
	const resolvedArtifact = await runner.onTestArtifactRecord(task, artifact);
	task.artifacts.push(resolvedArtifact);
	return resolvedArtifact;
}
const table = [];
for (let i = 65; i < 91; i++) table.push(String.fromCharCode(i));
for (let i = 97; i < 123; i++) table.push(String.fromCharCode(i));
for (let i = 0; i < 10; i++) table.push(i.toString(10));
table.push("+", "/");
function encodeUint8Array(bytes) {
	let base64 = "";
	const len = bytes.byteLength;
	for (let i = 0; i < len; i += 3) if (len === i + 1) {
		const a = (bytes[i] & 252) >> 2;
		const b = (bytes[i] & 3) << 4;
		base64 += table[a];
		base64 += table[b];
		base64 += "==";
	} else if (len === i + 2) {
		const a = (bytes[i] & 252) >> 2;
		const b = (bytes[i] & 3) << 4 | (bytes[i + 1] & 240) >> 4;
		const c = (bytes[i + 1] & 15) << 2;
		base64 += table[a];
		base64 += table[b];
		base64 += table[c];
		base64 += "=";
	} else {
		const a = (bytes[i] & 252) >> 2;
		const b = (bytes[i] & 3) << 4 | (bytes[i + 1] & 240) >> 4;
		const c = (bytes[i + 1] & 15) << 2 | (bytes[i + 2] & 192) >> 6;
		const d = bytes[i + 2] & 63;
		base64 += table[a];
		base64 += table[b];
		base64 += table[c];
		base64 += table[d];
	}
	return base64;
}
/**
* Records an async operation associated with a test task.
*
* This function tracks promises that should be awaited before a test completes.
* The promise is automatically removed from the test's promise list once it settles.
*/
function recordAsyncOperation(test, promise) {
	promise = promise.finally(() => {
		if (!test.promises) return;
		const index = test.promises.indexOf(promise);
		if (index !== -1) test.promises.splice(index, 1);
	});
	if (!test.promises) test.promises = [];
	test.promises.push(promise);
	return promise;
}
/**
* Validates and prepares a test attachment for serialization.
*
* This function ensures attachments have either `body` or `path` set (but not both), and converts `Uint8Array` bodies to base64-encoded strings for easier serialization.
*
* @param attachment - The attachment to validate and prepare
*
* @throws {TypeError} If neither `body` nor `path` is provided
* @throws {TypeError} If both `body` and `path` are provided
*/
function manageArtifactAttachment(attachment) {
	if (attachment.body == null && !attachment.path) throw new TypeError(`Test attachment requires "body" or "path" to be set. Both are missing.`);
	if (attachment.body && attachment.path) throw new TypeError(`Test attachment requires only one of "body" or "path" to be set. Both are specified.`);
	if (attachment.path && attachment.bodyEncoding) throw new TypeError(`Test attachment with "path" should not have "bodyEncoding" specified.`);
	if (attachment.body instanceof Uint8Array) attachment.body = encodeUint8Array(attachment.body);
	if (attachment.body != null) attachment.bodyEncoding ??= "base64";
}
//#endregion
export { stringify as C, y as E, ordinal as S, plugins as T, createSimpleStackTrace as _, describe as a, isObject as b, it as c, delay as d, getSafeTimers as f, assertTypes as g, printDiffOrStringify as h, beforeEach as i, parseErrorStacktrace as l, diff as m, afterEach as n, getCurrentTest as o, processError as p, beforeAll as r, getNames as s, afterAll as t, parseSingleStack as u, getCallLastIndex as v, format$1 as w, noop as x, getType$1 as y };
