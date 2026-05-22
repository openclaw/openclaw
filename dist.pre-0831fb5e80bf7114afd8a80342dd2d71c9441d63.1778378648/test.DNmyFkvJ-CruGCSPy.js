import { C as stringify, E as y, S as ordinal, T as plugins, _ as createSimpleStackTrace, b as isObject, d as delay, f as getSafeTimers, g as assertTypes, h as printDiffOrStringify, l as parseErrorStacktrace, m as diff, o as getCurrentTest, p as processError, s as getNames, u as parseSingleStack, v as getCallLastIndex, w as format, x as noop, y as getType } from "./dist-BloWqfp3.js";
//#region node_modules/vitest/dist/chunks/utils.BX5Fg8C4.js
const NAME_WORKER_STATE = "__vitest_worker__";
function getWorkerState() {
	const workerState = globalThis[NAME_WORKER_STATE];
	if (!workerState) throw new Error("Vitest failed to access its internal state.\n\nOne of the following is possible:\n- \"vitest\" is imported directly without running \"vitest\" command\n- \"vitest\" is imported inside \"globalSetup\" (to fix this, use \"setupFiles\" instead, because \"globalSetup\" runs in a different context)\n- \"vitest\" is imported inside Vite / Vitest config file\n- Otherwise, it might be a Vitest bug. Please report it to https://github.com/vitest-dev/vitest/issues\n");
	return workerState;
}
function isChildProcess() {
	return typeof process !== "undefined" && !!process.send;
}
function resetModules(modules, resetMocks = false) {
	const skipPaths = [
		/\/vitest\/dist\//,
		/vitest-virtual-\w+\/dist/,
		/@vitest\/dist/,
		...!resetMocks ? [/^mock:/] : []
	];
	modules.idToModuleMap.forEach((node, path) => {
		if (skipPaths.some((re) => re.test(path))) return;
		node.promise = void 0;
		node.exports = void 0;
		node.evaluated = false;
		node.importers.clear();
	});
}
function waitNextTick() {
	const { setTimeout } = getSafeTimers();
	return new Promise((resolve) => setTimeout(resolve, 0));
}
async function waitForImportsToResolve() {
	await waitNextTick();
	const state = getWorkerState();
	const promises = [];
	const resolvingCount = state.resolvingModules.size;
	for (const [_, mod] of state.evaluatedModules.idToModuleMap) if (mod.promise && !mod.evaluated) promises.push(mod.promise);
	if (!promises.length && !resolvingCount) return;
	await Promise.allSettled(promises);
	await waitForImportsToResolve();
}
//#endregion
//#region node_modules/@vitest/spy/dist/index.js
function isMockFunction(fn) {
	return typeof fn === "function" && "_isMockFunction" in fn && fn._isMockFunction === true;
}
const MOCK_RESTORE = /* @__PURE__ */ new Set();
const REGISTERED_MOCKS = /* @__PURE__ */ new Set();
const MOCK_CONFIGS = /* @__PURE__ */ new WeakMap();
function createMockInstance(options = {}) {
	const { originalImplementation, restore, mockImplementation, resetToMockImplementation, resetToMockName } = options;
	if (restore) MOCK_RESTORE.add(restore);
	const config = getDefaultConfig(originalImplementation);
	const state = getDefaultState();
	const mock = createMock({
		config,
		state,
		...options
	});
	const mockLength = (mockImplementation || originalImplementation)?.length ?? 0;
	Object.defineProperty(mock, "length", {
		writable: true,
		enumerable: false,
		value: mockLength,
		configurable: true
	});
	if (resetToMockName) config.mockName = mock.name || "vi.fn()";
	MOCK_CONFIGS.set(mock, config);
	REGISTERED_MOCKS.add(mock);
	mock._isMockFunction = true;
	mock.getMockImplementation = () => {
		return config.onceMockImplementations[0] || config.mockImplementation;
	};
	Object.defineProperty(mock, "mock", {
		configurable: false,
		enumerable: true,
		writable: false,
		value: state
	});
	mock.mockImplementation = function mockImplementation(implementation) {
		config.mockImplementation = implementation;
		return mock;
	};
	mock.mockImplementationOnce = function mockImplementationOnce(implementation) {
		config.onceMockImplementations.push(implementation);
		return mock;
	};
	mock.withImplementation = function withImplementation(implementation, callback) {
		const previousImplementation = config.mockImplementation;
		const previousOnceImplementations = config.onceMockImplementations;
		const reset = () => {
			config.mockImplementation = previousImplementation;
			config.onceMockImplementations = previousOnceImplementations;
		};
		config.mockImplementation = implementation;
		config.onceMockImplementations = [];
		const returnValue = callback();
		if (typeof returnValue === "object" && typeof returnValue?.then === "function") return returnValue.then(() => {
			reset();
			return mock;
		});
		else reset();
		return mock;
	};
	mock.mockReturnThis = function mockReturnThis() {
		return mock.mockImplementation(function() {
			return this;
		});
	};
	mock.mockReturnValue = function mockReturnValue(value) {
		return mock.mockImplementation(function() {
			if (new.target) throwConstructorError("mockReturnValue");
			return value;
		});
	};
	mock.mockReturnValueOnce = function mockReturnValueOnce(value) {
		return mock.mockImplementationOnce(function() {
			if (new.target) throwConstructorError("mockReturnValueOnce");
			return value;
		});
	};
	mock.mockThrow = function mockThrow(value) {
		return mock.mockImplementation(function() {
			throw value;
		});
	};
	mock.mockThrowOnce = function mockThrowOnce(value) {
		return mock.mockImplementationOnce(function() {
			throw value;
		});
	};
	mock.mockResolvedValue = function mockResolvedValue(value) {
		return mock.mockImplementation(function() {
			if (new.target) throwConstructorError("mockResolvedValue");
			return Promise.resolve(value);
		});
	};
	mock.mockResolvedValueOnce = function mockResolvedValueOnce(value) {
		return mock.mockImplementationOnce(function() {
			if (new.target) throwConstructorError("mockResolvedValueOnce");
			return Promise.resolve(value);
		});
	};
	mock.mockRejectedValue = function mockRejectedValue(value) {
		return mock.mockImplementation(function() {
			if (new.target) throwConstructorError("mockRejectedValue");
			return Promise.reject(value);
		});
	};
	mock.mockRejectedValueOnce = function mockRejectedValueOnce(value) {
		return mock.mockImplementationOnce(function() {
			if (new.target) throwConstructorError("mockRejectedValueOnce");
			return Promise.reject(value);
		});
	};
	mock.mockClear = function mockClear() {
		state.calls = [];
		state.contexts = [];
		state.instances = [];
		state.invocationCallOrder = [];
		state.results = [];
		state.settledResults = [];
		return mock;
	};
	mock.mockReset = function mockReset() {
		mock.mockClear();
		config.mockImplementation = resetToMockImplementation ? mockImplementation : void 0;
		config.mockName = resetToMockName ? mock.name || "vi.fn()" : "vi.fn()";
		config.onceMockImplementations = [];
		return mock;
	};
	mock.mockRestore = function mockRestore() {
		mock.mockReset();
		return restore?.();
	};
	mock.mockName = function mockName(name) {
		if (typeof name === "string") config.mockName = name;
		return mock;
	};
	mock.getMockName = function getMockName() {
		return config.mockName || "vi.fn()";
	};
	if (Symbol.dispose) mock[Symbol.dispose] = () => mock.mockRestore();
	if (mockImplementation) mock.mockImplementation(mockImplementation);
	return mock;
}
function fn(originalImplementation) {
	if (originalImplementation != null && isMockFunction(originalImplementation)) return originalImplementation;
	return createMockInstance({
		mockImplementation: originalImplementation,
		resetToMockImplementation: true
	});
}
function spyOn(object, key, accessor) {
	assert$2(object != null, "The vi.spyOn() function could not find an object to spy upon. The first argument must be defined.");
	assert$2(typeof object === "object" || typeof object === "function", "Vitest cannot spy on a primitive value.");
	const [originalDescriptorObject, originalDescriptor] = getDescriptor(object, key) || [];
	assert$2(originalDescriptor || key in object, `The property "${String(key)}" is not defined on the ${typeof object}.`);
	let accessType = accessor || "value";
	let ssr = false;
	if (accessType === "value" && originalDescriptor && originalDescriptor.value == null && originalDescriptor.get) {
		accessType = "get";
		ssr = true;
	}
	let original;
	if (originalDescriptor) {
		original = originalDescriptor[accessType];
		if (original == null && accessType === "value") original = object[key];
	} else if (accessType !== "value") original = () => object[key];
	else original = object[key];
	const originalImplementation = ssr && original ? original() : original;
	const originalType = typeof originalImplementation;
	assert$2(originalType === "function" || accessType !== "value" && original == null, `vi.spyOn() can only spy on a function. Received ${originalType}.`);
	if (isMockFunction(originalImplementation)) return originalImplementation;
	const reassign = (cb) => {
		const { value, ...desc } = originalDescriptor || {
			configurable: true,
			writable: true
		};
		if (accessType !== "value") delete desc.writable;
		desc[accessType] = cb;
		Object.defineProperty(object, key, desc);
	};
	const restore = () => {
		if (originalDescriptorObject !== object) Reflect.deleteProperty(object, key);
		else if (originalDescriptor && !original) Object.defineProperty(object, key, originalDescriptor);
		else reassign(original);
	};
	const mock = createMockInstance({
		restore,
		originalImplementation,
		resetToMockName: true
	});
	try {
		reassign(ssr ? () => mock : mock);
	} catch (error) {
		if (error instanceof TypeError && Symbol.toStringTag && object[Symbol.toStringTag] === "Module" && (error.message.includes("Cannot redefine property") || error.message.includes("Cannot replace module namespace") || error.message.includes("can't redefine non-configurable property"))) throw new TypeError(`Cannot spy on export "${String(key)}". Module namespace is not configurable in ESM. See: https://vitest.dev/guide/browser/#limitations`, { cause: error });
		throw error;
	}
	return mock;
}
function getDescriptor(obj, method) {
	const objDescriptor = Object.getOwnPropertyDescriptor(obj, method);
	if (objDescriptor) return [obj, objDescriptor];
	let currentProto = Object.getPrototypeOf(obj);
	while (currentProto !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(currentProto, method);
		if (descriptor) return [currentProto, descriptor];
		currentProto = Object.getPrototypeOf(currentProto);
	}
}
function assert$2(condition, message) {
	if (!condition) throw new Error(message);
}
let invocationCallCounter = 1;
function createMock({ state, config, name: mockName, prototypeState, prototypeConfig, keepMembersImplementation, mockImplementation, prototypeMembers = [] }) {
	const original = config.mockOriginal;
	const pseudoOriginal = mockImplementation;
	const name = mockName || original?.name || "Mock";
	const namedObject = { [name]: (function(...args) {
		registerCalls(args, state, prototypeState);
		registerInvocationOrder(invocationCallCounter++, state, prototypeState);
		const result = {
			type: "incomplete",
			value: void 0
		};
		const settledResult = {
			type: "incomplete",
			value: void 0
		};
		registerResult(result, state, prototypeState);
		registerSettledResult(settledResult, state, prototypeState);
		const context = new.target ? void 0 : this;
		const [instanceIndex, instancePrototypeIndex] = registerInstance(context, state, prototypeState);
		const [contextIndex, contextPrototypeIndex] = registerContext(context, state, prototypeState);
		const implementation = config.onceMockImplementations.shift() || config.mockImplementation || prototypeConfig?.onceMockImplementations.shift() || prototypeConfig?.mockImplementation || original || function() {};
		let returnValue;
		let thrownValue;
		let didThrow = false;
		try {
			if (new.target) {
				returnValue = Reflect.construct(implementation, args, new.target);
				for (const prop of prototypeMembers) {
					const prototypeMock = returnValue[prop];
					if (prototypeMock !== mock.prototype[prop]) continue;
					const isMock = isMockFunction(prototypeMock);
					const prototypeState = isMock ? prototypeMock.mock : void 0;
					const prototypeConfig = isMock ? MOCK_CONFIGS.get(prototypeMock) : void 0;
					returnValue[prop] = createMockInstance({
						originalImplementation: keepMembersImplementation ? prototypeConfig?.mockOriginal : void 0,
						prototypeState,
						prototypeConfig,
						keepMembersImplementation
					});
				}
			} else returnValue = implementation.apply(this, args);
		} catch (error) {
			thrownValue = error;
			didThrow = true;
			if (error instanceof TypeError && error.message.includes("is not a constructor")) console.warn(`[vitest] The ${namedObject[name].getMockName()} mock did not use 'function' or 'class' in its implementation, see https://vitest.dev/api/vi#vi-spyon for examples.`);
			throw error;
		} finally {
			if (didThrow) {
				result.type = "throw";
				result.value = thrownValue;
				settledResult.type = "rejected";
				settledResult.value = thrownValue;
			} else {
				result.type = "return";
				result.value = returnValue;
				if (new.target) {
					state.contexts[contextIndex - 1] = returnValue;
					state.instances[instanceIndex - 1] = returnValue;
					if (contextPrototypeIndex != null && prototypeState) prototypeState.contexts[contextPrototypeIndex - 1] = returnValue;
					if (instancePrototypeIndex != null && prototypeState) prototypeState.instances[instancePrototypeIndex - 1] = returnValue;
				}
				if (returnValue instanceof Promise) returnValue.then((settledValue) => {
					settledResult.type = "fulfilled";
					settledResult.value = settledValue;
				}, (rejectedValue) => {
					settledResult.type = "rejected";
					settledResult.value = rejectedValue;
				});
				else {
					settledResult.type = "fulfilled";
					settledResult.value = returnValue;
				}
			}
		}
		return returnValue;
	}) };
	const mock = namedObject[name];
	const copyPropertiesFrom = original || pseudoOriginal;
	if (copyPropertiesFrom) copyOriginalStaticProperties(mock, copyPropertiesFrom);
	return mock;
}
function registerCalls(args, state, prototypeState) {
	state.calls.push(args);
	prototypeState?.calls.push(args);
}
function registerInvocationOrder(order, state, prototypeState) {
	state.invocationCallOrder.push(order);
	prototypeState?.invocationCallOrder.push(order);
}
function registerResult(result, state, prototypeState) {
	state.results.push(result);
	prototypeState?.results.push(result);
}
function registerSettledResult(result, state, prototypeState) {
	state.settledResults.push(result);
	prototypeState?.settledResults.push(result);
}
function registerInstance(instance, state, prototypeState) {
	return [state.instances.push(instance), prototypeState?.instances.push(instance)];
}
function registerContext(context, state, prototypeState) {
	return [state.contexts.push(context), prototypeState?.contexts.push(context)];
}
function copyOriginalStaticProperties(mock, original) {
	const { properties, descriptors } = getAllProperties(original);
	for (const key of properties) {
		const descriptor = descriptors[key];
		if (getDescriptor(mock, key)) continue;
		Object.defineProperty(mock, key, descriptor);
	}
}
const ignoreProperties = new Set([
	"length",
	"name",
	"prototype",
	Symbol.for("nodejs.util.promisify.custom")
]);
function getAllProperties(original) {
	const properties = /* @__PURE__ */ new Set();
	const descriptors = {};
	while (original && original !== Object.prototype && original !== Function.prototype) {
		const ownProperties = [...Object.getOwnPropertyNames(original), ...Object.getOwnPropertySymbols(original)];
		for (const prop of ownProperties) {
			if (descriptors[prop] || ignoreProperties.has(prop)) continue;
			properties.add(prop);
			descriptors[prop] = Object.getOwnPropertyDescriptor(original, prop);
		}
		original = Object.getPrototypeOf(original);
	}
	return {
		properties,
		descriptors
	};
}
function getDefaultConfig(original) {
	return {
		mockImplementation: void 0,
		mockOriginal: original,
		mockName: "vi.fn()",
		onceMockImplementations: []
	};
}
function getDefaultState() {
	const state = {
		calls: [],
		contexts: [],
		instances: [],
		invocationCallOrder: [],
		settledResults: [],
		results: [],
		get lastCall() {
			return state.calls.at(-1);
		}
	};
	return state;
}
function restoreAllMocks() {
	for (const restore of MOCK_RESTORE) restore();
	MOCK_RESTORE.clear();
}
function clearAllMocks() {
	REGISTERED_MOCKS.forEach((mock) => mock.mockClear());
}
function resetAllMocks() {
	REGISTERED_MOCKS.forEach((mock) => mock.mockReset());
}
function throwConstructorError(shorthand) {
	throw new TypeError(`Cannot use \`${shorthand}\` when called with \`new\`. Use \`mockImplementation\` with a \`class\` keyword instead. See https://vitest.dev/api/mock#class-support for more information.`);
}
//#endregion
//#region node_modules/chai/index.js
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, {
	enumerable: true,
	configurable: true,
	writable: true,
	value
}) : obj[key] = value;
var __name = (target, value) => __defProp(target, "name", {
	value,
	configurable: true
});
var __export = (target, all) => {
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var utils_exports = {};
__export(utils_exports, {
	addChainableMethod: () => addChainableMethod,
	addLengthGuard: () => addLengthGuard,
	addMethod: () => addMethod,
	addProperty: () => addProperty,
	checkError: () => check_error_exports,
	compareByInspect: () => compareByInspect,
	eql: () => deep_eql_default,
	events: () => events,
	expectTypes: () => expectTypes,
	flag: () => flag,
	getActual: () => getActual,
	getMessage: () => getMessage2,
	getName: () => getName,
	getOperator: () => getOperator,
	getOwnEnumerableProperties: () => getOwnEnumerableProperties,
	getOwnEnumerablePropertySymbols: () => getOwnEnumerablePropertySymbols,
	getPathInfo: () => getPathInfo,
	hasProperty: () => hasProperty,
	inspect: () => inspect2,
	isNaN: () => isNaN2,
	isNumeric: () => isNumeric,
	isProxyEnabled: () => isProxyEnabled,
	isRegExp: () => isRegExp2,
	objDisplay: () => objDisplay,
	overwriteChainableMethod: () => overwriteChainableMethod,
	overwriteMethod: () => overwriteMethod,
	overwriteProperty: () => overwriteProperty,
	proxify: () => proxify,
	test: () => test$1,
	transferFlags: () => transferFlags,
	type: () => type
});
var check_error_exports = {};
__export(check_error_exports, {
	compatibleConstructor: () => compatibleConstructor,
	compatibleInstance: () => compatibleInstance,
	compatibleMessage: () => compatibleMessage,
	getConstructorName: () => getConstructorName,
	getMessage: () => getMessage
});
function isErrorInstance(obj) {
	return obj instanceof Error || Object.prototype.toString.call(obj) === "[object Error]";
}
__name(isErrorInstance, "isErrorInstance");
function isRegExp(obj) {
	return Object.prototype.toString.call(obj) === "[object RegExp]";
}
__name(isRegExp, "isRegExp");
function compatibleInstance(thrown, errorLike) {
	return isErrorInstance(errorLike) && thrown === errorLike;
}
__name(compatibleInstance, "compatibleInstance");
function compatibleConstructor(thrown, errorLike) {
	if (isErrorInstance(errorLike)) return thrown.constructor === errorLike.constructor || thrown instanceof errorLike.constructor;
	else if ((typeof errorLike === "object" || typeof errorLike === "function") && errorLike.prototype) return thrown.constructor === errorLike || thrown instanceof errorLike;
	return false;
}
__name(compatibleConstructor, "compatibleConstructor");
function compatibleMessage(thrown, errMatcher) {
	const comparisonString = typeof thrown === "string" ? thrown : thrown.message;
	if (isRegExp(errMatcher)) return errMatcher.test(comparisonString);
	else if (typeof errMatcher === "string") return comparisonString.indexOf(errMatcher) !== -1;
	return false;
}
__name(compatibleMessage, "compatibleMessage");
function getConstructorName(errorLike) {
	let constructorName = errorLike;
	if (isErrorInstance(errorLike)) constructorName = errorLike.constructor.name;
	else if (typeof errorLike === "function") {
		constructorName = errorLike.name;
		if (constructorName === "") constructorName = new errorLike().name || constructorName;
	}
	return constructorName;
}
__name(getConstructorName, "getConstructorName");
function getMessage(errorLike) {
	let msg = "";
	if (errorLike && errorLike.message) msg = errorLike.message;
	else if (typeof errorLike === "string") msg = errorLike;
	return msg;
}
__name(getMessage, "getMessage");
function flag(obj, key, value) {
	let flags = obj.__flags || (obj.__flags = /* @__PURE__ */ Object.create(null));
	if (arguments.length === 3) flags[key] = value;
	else return flags[key];
}
__name(flag, "flag");
function test$1(obj, args) {
	let negate = flag(obj, "negate"), expr = args[0];
	return negate ? !expr : expr;
}
__name(test$1, "test");
function type(obj) {
	if (typeof obj === "undefined") return "undefined";
	if (obj === null) return "null";
	const stringTag = obj[Symbol.toStringTag];
	if (typeof stringTag === "string") return stringTag;
	return Object.prototype.toString.call(obj).slice(8, -1);
}
__name(type, "type");
var canElideFrames = "captureStackTrace" in Error;
var _AssertionError = class _AssertionError extends Error {
	constructor(message = "Unspecified AssertionError", props, ssf) {
		super(message);
		__publicField(this, "message");
		this.message = message;
		if (canElideFrames) Error.captureStackTrace(this, ssf || _AssertionError);
		for (const key in props) if (!(key in this)) this[key] = props[key];
	}
	get name() {
		return "AssertionError";
	}
	get ok() {
		return false;
	}
	toJSON(stack) {
		return {
			...this,
			name: this.name,
			message: this.message,
			ok: false,
			stack: stack !== false ? this.stack : void 0
		};
	}
};
__name(_AssertionError, "AssertionError");
var AssertionError = _AssertionError;
function expectTypes(obj, types) {
	let flagMsg = flag(obj, "message");
	let ssfi = flag(obj, "ssfi");
	flagMsg = flagMsg ? flagMsg + ": " : "";
	obj = flag(obj, "object");
	types = types.map(function(t) {
		return t.toLowerCase();
	});
	types.sort();
	let str = types.map(function(t, index) {
		let art = ~[
			"a",
			"e",
			"i",
			"o",
			"u"
		].indexOf(t.charAt(0)) ? "an" : "a";
		return (types.length > 1 && index === types.length - 1 ? "or " : "") + art + " " + t;
	}).join(", ");
	let objType = type(obj).toLowerCase();
	if (!types.some(function(expected) {
		return objType === expected;
	})) throw new AssertionError(flagMsg + "object tested must be " + str + ", but " + objType + " given", void 0, ssfi);
}
__name(expectTypes, "expectTypes");
function getActual(obj, args) {
	return args.length > 4 ? args[4] : obj._obj;
}
__name(getActual, "getActual");
var ansiColors = {
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
var styles = {
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
var truncator = "…";
function colorise(value, styleType) {
	const color = ansiColors[styles[styleType]] || ansiColors[styleType] || "";
	if (!color) return String(value);
	return `\x1B[${color[0]}m${String(value)}\x1B[${color[1]}m`;
}
__name(colorise, "colorise");
function normaliseOptions({ showHidden = false, depth = 2, colors = false, customInspect = true, showProxy = false, maxArrayLength = Infinity, breakLength = Infinity, seen = [], truncate: truncate2 = Infinity, stylize = String } = {}, inspect3) {
	const options = {
		showHidden: Boolean(showHidden),
		depth: Number(depth),
		colors: Boolean(colors),
		customInspect: Boolean(customInspect),
		showProxy: Boolean(showProxy),
		maxArrayLength: Number(maxArrayLength),
		breakLength: Number(breakLength),
		truncate: Number(truncate2),
		seen,
		inspect: inspect3,
		stylize
	};
	if (options.colors) options.stylize = colorise;
	return options;
}
__name(normaliseOptions, "normaliseOptions");
function isHighSurrogate(char) {
	return char >= "\ud800" && char <= "\udbff";
}
__name(isHighSurrogate, "isHighSurrogate");
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
__name(truncate, "truncate");
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
__name(inspectList, "inspectList");
function quoteComplexKey(key) {
	if (key.match(/^[a-zA-Z_][a-zA-Z_0-9]*$/)) return key;
	return JSON.stringify(key).replace(/'/g, "\\'").replace(/\\"/g, "\"").replace(/(^"|"$)/g, "'");
}
__name(quoteComplexKey, "quoteComplexKey");
function inspectProperty([key, value], options) {
	options.truncate -= 2;
	if (typeof key === "string") key = quoteComplexKey(key);
	else if (typeof key !== "number") key = `[${options.inspect(key, options)}]`;
	options.truncate -= key.length;
	value = options.inspect(value, options);
	return `${key}: ${value}`;
}
__name(inspectProperty, "inspectProperty");
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
__name(inspectArray, "inspectArray");
var getArrayName = /* @__PURE__ */ __name((array) => {
	if (typeof Buffer === "function" && array instanceof Buffer) return "Buffer";
	if (array[Symbol.toStringTag]) return array[Symbol.toStringTag];
	return array.constructor.name;
}, "getArrayName");
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
__name(inspectTypedArray, "inspectTypedArray");
function inspectDate(dateObject, options) {
	const stringRepresentation = dateObject.toJSON();
	if (stringRepresentation === null) return "Invalid Date";
	const split = stringRepresentation.split("T");
	const date = split[0];
	return options.stylize(`${date}T${truncate(split[1], options.truncate - date.length - 1)}`, "date");
}
__name(inspectDate, "inspectDate");
function inspectFunction(func, options) {
	const functionType = func[Symbol.toStringTag] || "Function";
	const name = func.name;
	if (!name) return options.stylize(`[${functionType}]`, "special");
	return options.stylize(`[${functionType} ${truncate(name, options.truncate - 11)}]`, "special");
}
__name(inspectFunction, "inspectFunction");
function inspectMapEntry([key, value], options) {
	options.truncate -= 4;
	key = options.inspect(key, options);
	options.truncate -= key.length;
	value = options.inspect(value, options);
	return `${key} => ${value}`;
}
__name(inspectMapEntry, "inspectMapEntry");
function mapToEntries(map) {
	const entries = [];
	map.forEach((value, key) => {
		entries.push([key, value]);
	});
	return entries;
}
__name(mapToEntries, "mapToEntries");
function inspectMap(map, options) {
	if (map.size === 0) return "Map{}";
	options.truncate -= 7;
	return `Map{ ${inspectList(mapToEntries(map), options, inspectMapEntry)} }`;
}
__name(inspectMap, "inspectMap");
var isNaN = Number.isNaN || ((i) => i !== i);
function inspectNumber(number, options) {
	if (isNaN(number)) return options.stylize("NaN", "number");
	if (number === Infinity) return options.stylize("Infinity", "number");
	if (number === -Infinity) return options.stylize("-Infinity", "number");
	if (number === 0) return options.stylize(1 / number === Infinity ? "+0" : "-0", "number");
	return options.stylize(truncate(String(number), options.truncate), "number");
}
__name(inspectNumber, "inspectNumber");
function inspectBigInt(number, options) {
	let nums = truncate(number.toString(), options.truncate - 1);
	if (nums !== truncator) nums += "n";
	return options.stylize(nums, "bigint");
}
__name(inspectBigInt, "inspectBigInt");
function inspectRegExp(value, options) {
	const flags = value.toString().split("/")[2];
	const sourceLength = options.truncate - (2 + flags.length);
	const source = value.source;
	return options.stylize(`/${truncate(source, sourceLength)}/${flags}`, "regexp");
}
__name(inspectRegExp, "inspectRegExp");
function arrayFromSet(set2) {
	const values = [];
	set2.forEach((value) => {
		values.push(value);
	});
	return values;
}
__name(arrayFromSet, "arrayFromSet");
function inspectSet(set2, options) {
	if (set2.size === 0) return "Set{}";
	options.truncate -= 7;
	return `Set{ ${inspectList(arrayFromSet(set2), options)} }`;
}
__name(inspectSet, "inspectSet");
var stringEscapeChars = /* @__PURE__ */ new RegExp("['\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0604\\u070f\\u17b4\\u17b5\\u200c-\\u200f\\u2028-\\u202f\\u2060-\\u206f\\ufeff\\ufff0-\\uffff]", "g");
var escapeCharacters = {
	"\b": "\\b",
	"	": "\\t",
	"\n": "\\n",
	"\f": "\\f",
	"\r": "\\r",
	"'": "\\'",
	"\\": "\\\\"
};
var hex = 16;
var unicodeLength = 4;
function escape(char) {
	return escapeCharacters[char] || `\\u${`0000${char.charCodeAt(0).toString(hex)}`.slice(-unicodeLength)}`;
}
__name(escape, "escape");
function inspectString(string, options) {
	if (stringEscapeChars.test(string)) string = string.replace(stringEscapeChars, escape);
	return options.stylize(`'${truncate(string, options.truncate - 2)}'`, "string");
}
__name(inspectString, "inspectString");
function inspectSymbol(value) {
	if ("description" in Symbol.prototype) return value.description ? `Symbol(${value.description})` : "Symbol()";
	return value.toString();
}
__name(inspectSymbol, "inspectSymbol");
var promise_default = /* @__PURE__ */ __name(() => "Promise{…}", "getPromiseValue");
function inspectObject(object, options) {
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
__name(inspectObject, "inspectObject");
var toStringTag = typeof Symbol !== "undefined" && Symbol.toStringTag ? Symbol.toStringTag : false;
function inspectClass(value, options) {
	let name = "";
	if (toStringTag && toStringTag in value) name = value[toStringTag];
	name = name || value.constructor.name;
	if (!name || name === "_class") name = "<Anonymous Class>";
	options.truncate -= name.length;
	return `${name}${inspectObject(value, options)}`;
}
__name(inspectClass, "inspectClass");
function inspectArguments(args, options) {
	if (args.length === 0) return "Arguments[]";
	options.truncate -= 13;
	return `Arguments[ ${inspectList(args, options)} ]`;
}
__name(inspectArguments, "inspectArguments");
var errorKeys = [
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
function inspectObject2(error, options) {
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
__name(inspectObject2, "inspectObject");
function inspectAttribute([key, value], options) {
	options.truncate -= 3;
	if (!value) return `${options.stylize(String(key), "yellow")}`;
	return `${options.stylize(String(key), "yellow")}=${options.stylize(`"${value}"`, "string")}`;
}
__name(inspectAttribute, "inspectAttribute");
function inspectNodeCollection(collection, options) {
	return inspectList(collection, options, inspectNode, "\n");
}
__name(inspectNodeCollection, "inspectNodeCollection");
function inspectNode(node, options) {
	switch (node.nodeType) {
		case 1: return inspectHTML(node, options);
		case 3: return options.inspect(node.data, options);
		default: return options.inspect(node, options);
	}
}
__name(inspectNode, "inspectNode");
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
	const truncate2 = options.truncate;
	let children = inspectNodeCollection(element.children, options);
	if (children && children.length > truncate2) children = `${truncator}(${element.children.length})`;
	return `${head}${propertyContents}${headClose}${children}${tail}`;
}
__name(inspectHTML, "inspectHTML");
var chaiInspect = typeof Symbol === "function" && typeof Symbol.for === "function" ? /* @__PURE__ */ Symbol.for("chai/inspect") : "@@chai/inspect";
var nodeInspect = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");
var constructorMap = /* @__PURE__ */ new WeakMap();
var stringTagMap = {};
var baseTypesMap = {
	undefined: /* @__PURE__ */ __name((value, options) => options.stylize("undefined", "undefined"), "undefined"),
	null: /* @__PURE__ */ __name((value, options) => options.stylize("null", "null"), "null"),
	boolean: /* @__PURE__ */ __name((value, options) => options.stylize(String(value), "boolean"), "boolean"),
	Boolean: /* @__PURE__ */ __name((value, options) => options.stylize(String(value), "boolean"), "Boolean"),
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
	Promise: promise_default,
	WeakSet: /* @__PURE__ */ __name((value, options) => options.stylize("WeakSet{…}", "special"), "WeakSet"),
	WeakMap: /* @__PURE__ */ __name((value, options) => options.stylize("WeakMap{…}", "special"), "WeakMap"),
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
	Generator: /* @__PURE__ */ __name(() => "", "Generator"),
	DataView: /* @__PURE__ */ __name(() => "", "DataView"),
	ArrayBuffer: /* @__PURE__ */ __name(() => "", "ArrayBuffer"),
	Error: inspectObject2,
	HTMLCollection: inspectNodeCollection,
	NodeList: inspectNodeCollection
};
var inspectCustom = /* @__PURE__ */ __name((value, options, type3, inspectFn) => {
	if (chaiInspect in value && typeof value[chaiInspect] === "function") return value[chaiInspect](options);
	if (nodeInspect in value && typeof value[nodeInspect] === "function") return value[nodeInspect](options.depth, options, inspectFn);
	if ("inspect" in value && typeof value.inspect === "function") return value.inspect(options.depth, options);
	if ("constructor" in value && constructorMap.has(value.constructor)) return constructorMap.get(value.constructor)(value, options);
	if (stringTagMap[type3]) return stringTagMap[type3](value, options);
	return "";
}, "inspectCustom");
var toString = Object.prototype.toString;
function inspect(value, opts = {}) {
	const options = normaliseOptions(opts, inspect);
	const { customInspect } = options;
	let type3 = value === null ? "null" : typeof value;
	if (type3 === "object") type3 = toString.call(value).slice(8, -1);
	if (type3 in baseTypesMap) return baseTypesMap[type3](value, options);
	if (customInspect && value) {
		const output = inspectCustom(value, options, type3, inspect);
		if (output) {
			if (typeof output === "string") return output;
			return inspect(output, options);
		}
	}
	const proto = value ? Object.getPrototypeOf(value) : false;
	if (proto === Object.prototype || proto === null) return inspectObject(value, options);
	if (value && typeof HTMLElement === "function" && value instanceof HTMLElement) return inspectHTML(value, options);
	if ("constructor" in value) {
		if (value.constructor !== Object) return inspectClass(value, options);
		return inspectObject(value, options);
	}
	if (value === Object(value)) return inspectObject(value, options);
	return options.stylize(String(value), type3);
}
__name(inspect, "inspect");
var config = {
	/**
	* ### config.includeStack
	*
	* User configurable property, influences whether stack trace
	* is included in Assertion error message. Default of false
	* suppresses stack trace in the error message.
	*
	*     chai.config.includeStack = true;  // enable stack on error
	*
	* @param {boolean}
	* @public
	*/
	includeStack: false,
	/**
	* ### config.showDiff
	*
	* User configurable property, influences whether or not
	* the `showDiff` flag should be included in the thrown
	* AssertionErrors. `false` will always be `false`; `true`
	* will be true when the assertion has requested a diff
	* be shown.
	*
	* @param {boolean}
	* @public
	*/
	showDiff: true,
	/**
	* ### config.truncateThreshold
	*
	* User configurable property, sets length threshold for actual and
	* expected values in assertion errors. If this threshold is exceeded, for
	* example for large data structures, the value is replaced with something
	* like `[ Array(3) ]` or `{ Object (prop1, prop2) }`.
	*
	* Set it to zero if you want to disable truncating altogether.
	*
	* This is especially userful when doing assertions on arrays: having this
	* set to a reasonable large value makes the failure messages readily
	* inspectable.
	*
	*     chai.config.truncateThreshold = 0;  // disable truncating
	*
	* @param {number}
	* @public
	*/
	truncateThreshold: 40,
	/**
	* ### config.useProxy
	*
	* User configurable property, defines if chai will use a Proxy to throw
	* an error when a non-existent property is read, which protects users
	* from typos when using property-based assertions.
	*
	* Set it to false if you want to disable this feature.
	*
	*     chai.config.useProxy = false;  // disable use of Proxy
	*
	* This feature is automatically disabled regardless of this config value
	* in environments that don't support proxies.
	*
	* @param {boolean}
	* @public
	*/
	useProxy: true,
	/**
	* ### config.proxyExcludedKeys
	*
	* User configurable property, defines which properties should be ignored
	* instead of throwing an error if they do not exist on the assertion.
	* This is only applied if the environment Chai is running in supports proxies and
	* if the `useProxy` configuration setting is enabled.
	* By default, `then` and `inspect` will not throw an error if they do not exist on the
	* assertion object because the `.inspect` property is read by `util.inspect` (for example, when
	* using `console.log` on the assertion object) and `.then` is necessary for promise type-checking.
	*
	*     // By default these keys will not throw an error if they do not exist on the assertion object
	*     chai.config.proxyExcludedKeys = ['then', 'inspect'];
	*
	* @param {Array}
	* @public
	*/
	proxyExcludedKeys: [
		"then",
		"catch",
		"inspect",
		"toJSON"
	],
	/**
	* ### config.deepEqual
	*
	* User configurable property, defines which a custom function to use for deepEqual
	* comparisons.
	* By default, the function used is the one from the `deep-eql` package without custom comparator.
	*
	*     // use a custom comparator
	*     chai.config.deepEqual = (expected, actual) => {
	*         return chai.util.eql(expected, actual, {
	*             comparator: (expected, actual) => {
	*                 // for non number comparison, use the default behavior
	*                 if(typeof expected !== 'number') return null;
	*                 // allow a difference of 10 between compared numbers
	*                 return typeof actual === 'number' && Math.abs(actual - expected) < 10
	*             }
	*         })
	*     };
	*
	* @param {Function}
	* @public
	*/
	deepEqual: null
};
function inspect2(obj, showHidden, depth, colors) {
	return inspect(obj, {
		colors,
		depth: typeof depth === "undefined" ? 2 : depth,
		showHidden,
		truncate: config.truncateThreshold ? config.truncateThreshold : Infinity
	});
}
__name(inspect2, "inspect");
function objDisplay(obj) {
	let str = inspect2(obj), type3 = Object.prototype.toString.call(obj);
	if (config.truncateThreshold && str.length >= config.truncateThreshold) if (type3 === "[object Function]") return !obj.name || obj.name === "" ? "[Function]" : "[Function: " + obj.name + "]";
	else if (type3 === "[object Array]") return "[ Array(" + obj.length + ") ]";
	else if (type3 === "[object Object]") {
		let keys = Object.keys(obj);
		return "{ Object (" + (keys.length > 2 ? keys.splice(0, 2).join(", ") + ", ..." : keys.join(", ")) + ") }";
	} else return str;
	else return str;
}
__name(objDisplay, "objDisplay");
function getMessage2(obj, args) {
	let negate = flag(obj, "negate");
	let val = flag(obj, "object");
	let expected = args[3];
	let actual = getActual(obj, args);
	let msg = negate ? args[2] : args[1];
	let flagMsg = flag(obj, "message");
	if (typeof msg === "function") msg = msg();
	msg = msg || "";
	msg = msg.replace(/#\{this\}/g, function() {
		return objDisplay(val);
	}).replace(/#\{act\}/g, function() {
		return objDisplay(actual);
	}).replace(/#\{exp\}/g, function() {
		return objDisplay(expected);
	});
	return flagMsg ? flagMsg + ": " + msg : msg;
}
__name(getMessage2, "getMessage");
function transferFlags(assertion, object, includeAll) {
	let flags = assertion.__flags || (assertion.__flags = /* @__PURE__ */ Object.create(null));
	if (!object.__flags) object.__flags = /* @__PURE__ */ Object.create(null);
	includeAll = arguments.length === 3 ? includeAll : true;
	for (let flag3 in flags) if (includeAll || flag3 !== "object" && flag3 !== "ssfi" && flag3 !== "lockSsfi" && flag3 != "message") object.__flags[flag3] = flags[flag3];
}
__name(transferFlags, "transferFlags");
function type2(obj) {
	if (typeof obj === "undefined") return "undefined";
	if (obj === null) return "null";
	const stringTag = obj[Symbol.toStringTag];
	if (typeof stringTag === "string") return stringTag;
	return Object.prototype.toString.call(obj).slice(8, -1);
}
__name(type2, "type");
function FakeMap() {
	this._key = "chai/deep-eql__" + Math.random() + Date.now();
}
__name(FakeMap, "FakeMap");
FakeMap.prototype = {
	get: /* @__PURE__ */ __name(function get(key) {
		return key[this._key];
	}, "get"),
	set: /* @__PURE__ */ __name(function set(key, value) {
		if (Object.isExtensible(key)) Object.defineProperty(key, this._key, {
			value,
			configurable: true
		});
	}, "set")
};
var MemoizeMap = typeof WeakMap === "function" ? WeakMap : FakeMap;
function memoizeCompare(leftHandOperand, rightHandOperand, memoizeMap) {
	if (!memoizeMap || isPrimitive(leftHandOperand) || isPrimitive(rightHandOperand)) return null;
	var leftHandMap = memoizeMap.get(leftHandOperand);
	if (leftHandMap) {
		var result = leftHandMap.get(rightHandOperand);
		if (typeof result === "boolean") return result;
	}
	return null;
}
__name(memoizeCompare, "memoizeCompare");
function memoizeSet(leftHandOperand, rightHandOperand, memoizeMap, result) {
	if (!memoizeMap || isPrimitive(leftHandOperand) || isPrimitive(rightHandOperand)) return;
	var leftHandMap = memoizeMap.get(leftHandOperand);
	if (leftHandMap) leftHandMap.set(rightHandOperand, result);
	else {
		leftHandMap = new MemoizeMap();
		leftHandMap.set(rightHandOperand, result);
		memoizeMap.set(leftHandOperand, leftHandMap);
	}
}
__name(memoizeSet, "memoizeSet");
var deep_eql_default = deepEqual;
function deepEqual(leftHandOperand, rightHandOperand, options) {
	if (options && options.comparator) return extensiveDeepEqual(leftHandOperand, rightHandOperand, options);
	var simpleResult = simpleEqual(leftHandOperand, rightHandOperand);
	if (simpleResult !== null) return simpleResult;
	return extensiveDeepEqual(leftHandOperand, rightHandOperand, options);
}
__name(deepEqual, "deepEqual");
function simpleEqual(leftHandOperand, rightHandOperand) {
	if (leftHandOperand === rightHandOperand) return leftHandOperand !== 0 || 1 / leftHandOperand === 1 / rightHandOperand;
	if (leftHandOperand !== leftHandOperand && rightHandOperand !== rightHandOperand) return true;
	if (isPrimitive(leftHandOperand) || isPrimitive(rightHandOperand)) return false;
	return null;
}
__name(simpleEqual, "simpleEqual");
function extensiveDeepEqual(leftHandOperand, rightHandOperand, options) {
	options = options || {};
	options.memoize = options.memoize === false ? false : options.memoize || new MemoizeMap();
	var comparator = options && options.comparator;
	var memoizeResultLeft = memoizeCompare(leftHandOperand, rightHandOperand, options.memoize);
	if (memoizeResultLeft !== null) return memoizeResultLeft;
	var memoizeResultRight = memoizeCompare(rightHandOperand, leftHandOperand, options.memoize);
	if (memoizeResultRight !== null) return memoizeResultRight;
	if (comparator) {
		var comparatorResult = comparator(leftHandOperand, rightHandOperand);
		if (comparatorResult === false || comparatorResult === true) {
			memoizeSet(leftHandOperand, rightHandOperand, options.memoize, comparatorResult);
			return comparatorResult;
		}
		var simpleResult = simpleEqual(leftHandOperand, rightHandOperand);
		if (simpleResult !== null) return simpleResult;
	}
	var leftHandType = type2(leftHandOperand);
	if (leftHandType !== type2(rightHandOperand)) {
		memoizeSet(leftHandOperand, rightHandOperand, options.memoize, false);
		return false;
	}
	memoizeSet(leftHandOperand, rightHandOperand, options.memoize, true);
	var result = extensiveDeepEqualByType(leftHandOperand, rightHandOperand, leftHandType, options);
	memoizeSet(leftHandOperand, rightHandOperand, options.memoize, result);
	return result;
}
__name(extensiveDeepEqual, "extensiveDeepEqual");
function extensiveDeepEqualByType(leftHandOperand, rightHandOperand, leftHandType, options) {
	switch (leftHandType) {
		case "String":
		case "Number":
		case "Boolean":
		case "Date": return deepEqual(leftHandOperand.valueOf(), rightHandOperand.valueOf());
		case "Promise":
		case "Symbol":
		case "function":
		case "WeakMap":
		case "WeakSet": return leftHandOperand === rightHandOperand;
		case "Error": return keysEqual(leftHandOperand, rightHandOperand, [
			"name",
			"message",
			"code"
		], options);
		case "Arguments":
		case "Int8Array":
		case "Uint8Array":
		case "Uint8ClampedArray":
		case "Int16Array":
		case "Uint16Array":
		case "Int32Array":
		case "Uint32Array":
		case "Float32Array":
		case "Float64Array":
		case "Array": return iterableEqual(leftHandOperand, rightHandOperand, options);
		case "RegExp": return regexpEqual(leftHandOperand, rightHandOperand);
		case "Generator": return generatorEqual(leftHandOperand, rightHandOperand, options);
		case "DataView": return iterableEqual(new Uint8Array(leftHandOperand.buffer), new Uint8Array(rightHandOperand.buffer), options);
		case "ArrayBuffer": return iterableEqual(new Uint8Array(leftHandOperand), new Uint8Array(rightHandOperand), options);
		case "Set": return entriesEqual(leftHandOperand, rightHandOperand, options);
		case "Map": return entriesEqual(leftHandOperand, rightHandOperand, options);
		case "Temporal.PlainDate":
		case "Temporal.PlainTime":
		case "Temporal.PlainDateTime":
		case "Temporal.Instant":
		case "Temporal.ZonedDateTime":
		case "Temporal.PlainYearMonth":
		case "Temporal.PlainMonthDay": return leftHandOperand.equals(rightHandOperand);
		case "Temporal.Duration": return leftHandOperand.total("nanoseconds") === rightHandOperand.total("nanoseconds");
		case "Temporal.TimeZone":
		case "Temporal.Calendar": return leftHandOperand.toString() === rightHandOperand.toString();
		default: return objectEqual(leftHandOperand, rightHandOperand, options);
	}
}
__name(extensiveDeepEqualByType, "extensiveDeepEqualByType");
function regexpEqual(leftHandOperand, rightHandOperand) {
	return leftHandOperand.toString() === rightHandOperand.toString();
}
__name(regexpEqual, "regexpEqual");
function entriesEqual(leftHandOperand, rightHandOperand, options) {
	try {
		if (leftHandOperand.size !== rightHandOperand.size) return false;
		if (leftHandOperand.size === 0) return true;
	} catch (sizeError) {
		return false;
	}
	var leftHandItems = [];
	var rightHandItems = [];
	leftHandOperand.forEach(/* @__PURE__ */ __name(function gatherEntries(key, value) {
		leftHandItems.push([key, value]);
	}, "gatherEntries"));
	rightHandOperand.forEach(/* @__PURE__ */ __name(function gatherEntries(key, value) {
		rightHandItems.push([key, value]);
	}, "gatherEntries"));
	return iterableEqual(leftHandItems.sort(), rightHandItems.sort(), options);
}
__name(entriesEqual, "entriesEqual");
function iterableEqual(leftHandOperand, rightHandOperand, options) {
	var length = leftHandOperand.length;
	if (length !== rightHandOperand.length) return false;
	if (length === 0) return true;
	var index = -1;
	while (++index < length) if (deepEqual(leftHandOperand[index], rightHandOperand[index], options) === false) return false;
	return true;
}
__name(iterableEqual, "iterableEqual");
function generatorEqual(leftHandOperand, rightHandOperand, options) {
	return iterableEqual(getGeneratorEntries(leftHandOperand), getGeneratorEntries(rightHandOperand), options);
}
__name(generatorEqual, "generatorEqual");
function hasIteratorFunction(target) {
	return typeof Symbol !== "undefined" && typeof target === "object" && typeof Symbol.iterator !== "undefined" && typeof target[Symbol.iterator] === "function";
}
__name(hasIteratorFunction, "hasIteratorFunction");
function getIteratorEntries(target) {
	if (hasIteratorFunction(target)) try {
		return getGeneratorEntries(target[Symbol.iterator]());
	} catch (iteratorError) {
		return [];
	}
	return [];
}
__name(getIteratorEntries, "getIteratorEntries");
function getGeneratorEntries(generator) {
	var generatorResult = generator.next();
	var accumulator = [generatorResult.value];
	while (generatorResult.done === false) {
		generatorResult = generator.next();
		accumulator.push(generatorResult.value);
	}
	return accumulator;
}
__name(getGeneratorEntries, "getGeneratorEntries");
function getEnumerableKeys(target) {
	var keys = [];
	for (var key in target) keys.push(key);
	return keys;
}
__name(getEnumerableKeys, "getEnumerableKeys");
function getEnumerableSymbols(target) {
	var keys = [];
	var allKeys = Object.getOwnPropertySymbols(target);
	for (var i = 0; i < allKeys.length; i += 1) {
		var key = allKeys[i];
		if (Object.getOwnPropertyDescriptor(target, key).enumerable) keys.push(key);
	}
	return keys;
}
__name(getEnumerableSymbols, "getEnumerableSymbols");
function keysEqual(leftHandOperand, rightHandOperand, keys, options) {
	var length = keys.length;
	if (length === 0) return true;
	for (var i = 0; i < length; i += 1) if (deepEqual(leftHandOperand[keys[i]], rightHandOperand[keys[i]], options) === false) return false;
	return true;
}
__name(keysEqual, "keysEqual");
function objectEqual(leftHandOperand, rightHandOperand, options) {
	var leftHandKeys = getEnumerableKeys(leftHandOperand);
	var rightHandKeys = getEnumerableKeys(rightHandOperand);
	var leftHandSymbols = getEnumerableSymbols(leftHandOperand);
	var rightHandSymbols = getEnumerableSymbols(rightHandOperand);
	leftHandKeys = leftHandKeys.concat(leftHandSymbols);
	rightHandKeys = rightHandKeys.concat(rightHandSymbols);
	if (leftHandKeys.length && leftHandKeys.length === rightHandKeys.length) {
		if (iterableEqual(mapSymbols(leftHandKeys).sort(), mapSymbols(rightHandKeys).sort()) === false) return false;
		return keysEqual(leftHandOperand, rightHandOperand, leftHandKeys, options);
	}
	var leftHandEntries = getIteratorEntries(leftHandOperand);
	var rightHandEntries = getIteratorEntries(rightHandOperand);
	if (leftHandEntries.length && leftHandEntries.length === rightHandEntries.length) {
		leftHandEntries.sort();
		rightHandEntries.sort();
		return iterableEqual(leftHandEntries, rightHandEntries, options);
	}
	if (leftHandKeys.length === 0 && leftHandEntries.length === 0 && rightHandKeys.length === 0 && rightHandEntries.length === 0) return true;
	return false;
}
__name(objectEqual, "objectEqual");
function isPrimitive(value) {
	return value === null || typeof value !== "object";
}
__name(isPrimitive, "isPrimitive");
function mapSymbols(arr) {
	return arr.map(/* @__PURE__ */ __name(function mapSymbol(entry) {
		if (typeof entry === "symbol") return entry.toString();
		return entry;
	}, "mapSymbol"));
}
__name(mapSymbols, "mapSymbols");
function hasProperty(obj, name) {
	if (typeof obj === "undefined" || obj === null) return false;
	return name in Object(obj);
}
__name(hasProperty, "hasProperty");
function parsePath(path) {
	return path.replace(/([^\\])\[/g, "$1.[").match(/(\\\.|[^.]+?)+/g).map((value) => {
		if (value === "constructor" || value === "__proto__" || value === "prototype") return {};
		const mArr = /^\[(\d+)\]$/.exec(value);
		let parsed = null;
		if (mArr) parsed = { i: parseFloat(mArr[1]) };
		else parsed = { p: value.replace(/\\([.[\]])/g, "$1") };
		return parsed;
	});
}
__name(parsePath, "parsePath");
function internalGetPathValue(obj, parsed, pathDepth) {
	let temporaryValue = obj;
	let res = null;
	pathDepth = typeof pathDepth === "undefined" ? parsed.length : pathDepth;
	for (let i = 0; i < pathDepth; i++) {
		const part = parsed[i];
		if (temporaryValue) {
			if (typeof part.p === "undefined") temporaryValue = temporaryValue[part.i];
			else temporaryValue = temporaryValue[part.p];
			if (i === pathDepth - 1) res = temporaryValue;
		}
	}
	return res;
}
__name(internalGetPathValue, "internalGetPathValue");
function getPathInfo(obj, path) {
	const parsed = parsePath(path);
	const last = parsed[parsed.length - 1];
	const info = {
		parent: parsed.length > 1 ? internalGetPathValue(obj, parsed, parsed.length - 1) : obj,
		name: last.p || last.i,
		value: internalGetPathValue(obj, parsed)
	};
	info.exists = hasProperty(info.parent, info.name);
	return info;
}
__name(getPathInfo, "getPathInfo");
var _Assertion = class _Assertion {
	/**
	* Creates object for chaining.
	* `Assertion` objects contain metadata in the form of flags. Three flags can
	* be assigned during instantiation by passing arguments to this constructor:
	*
	* - `object`: This flag contains the target of the assertion. For example, in
	* the assertion `expect(numKittens).to.equal(7);`, the `object` flag will
	* contain `numKittens` so that the `equal` assertion can reference it when
	* needed.
	*
	* - `message`: This flag contains an optional custom error message to be
	* prepended to the error message that's generated by the assertion when it
	* fails.
	*
	* - `ssfi`: This flag stands for "start stack function indicator". It
	* contains a function reference that serves as the starting point for
	* removing frames from the stack trace of the error that's created by the
	* assertion when it fails. The goal is to provide a cleaner stack trace to
	* end users by removing Chai's internal functions. Note that it only works
	* in environments that support `Error.captureStackTrace`, and only when
	* `Chai.config.includeStack` hasn't been set to `false`.
	*
	* - `lockSsfi`: This flag controls whether or not the given `ssfi` flag
	* should retain its current value, even as assertions are chained off of
	* this object. This is usually set to `true` when creating a new assertion
	* from within another assertion. It's also temporarily set to `true` before
	* an overwritten assertion gets called by the overwriting assertion.
	*
	* - `eql`: This flag contains the deepEqual function to be used by the assertion.
	*
	* @param {unknown} obj target of the assertion
	* @param {string} [msg] (optional) custom error message
	* @param {Function} [ssfi] (optional) starting point for removing stack frames
	* @param {boolean} [lockSsfi] (optional) whether or not the ssfi flag is locked
	*/
	constructor(obj, msg, ssfi, lockSsfi) {
		/** @type {{}} */
		__publicField(this, "__flags", {});
		flag(this, "ssfi", ssfi || _Assertion);
		flag(this, "lockSsfi", lockSsfi);
		flag(this, "object", obj);
		flag(this, "message", msg);
		flag(this, "eql", config.deepEqual || deep_eql_default);
		return proxify(this);
	}
	/** @returns {boolean} */
	static get includeStack() {
		console.warn("Assertion.includeStack is deprecated, use chai.config.includeStack instead.");
		return config.includeStack;
	}
	/** @param {boolean} value */
	static set includeStack(value) {
		console.warn("Assertion.includeStack is deprecated, use chai.config.includeStack instead.");
		config.includeStack = value;
	}
	/** @returns {boolean} */
	static get showDiff() {
		console.warn("Assertion.showDiff is deprecated, use chai.config.showDiff instead.");
		return config.showDiff;
	}
	/** @param {boolean} value */
	static set showDiff(value) {
		console.warn("Assertion.showDiff is deprecated, use chai.config.showDiff instead.");
		config.showDiff = value;
	}
	/**
	* @param {string} name
	* @param {Function} fn
	*/
	static addProperty(name, fn) {
		addProperty(this.prototype, name, fn);
	}
	/**
	* @param {string} name
	* @param {Function} fn
	*/
	static addMethod(name, fn) {
		addMethod(this.prototype, name, fn);
	}
	/**
	* @param {string} name
	* @param {Function} fn
	* @param {Function} chainingBehavior
	*/
	static addChainableMethod(name, fn, chainingBehavior) {
		addChainableMethod(this.prototype, name, fn, chainingBehavior);
	}
	/**
	* @param {string} name
	* @param {Function} fn
	*/
	static overwriteProperty(name, fn) {
		overwriteProperty(this.prototype, name, fn);
	}
	/**
	* @param {string} name
	* @param {Function} fn
	*/
	static overwriteMethod(name, fn) {
		overwriteMethod(this.prototype, name, fn);
	}
	/**
	* @param {string} name
	* @param {Function} fn
	* @param {Function} chainingBehavior
	*/
	static overwriteChainableMethod(name, fn, chainingBehavior) {
		overwriteChainableMethod(this.prototype, name, fn, chainingBehavior);
	}
	/**
	* ### .assert(expression, message, negateMessage, expected, actual, showDiff)
	*
	* Executes an expression and check expectations. Throws AssertionError for reporting if test doesn't pass.
	*
	* @name assert
	* @param {unknown} _expr to be tested
	* @param {string | Function} msg or function that returns message to display if expression fails
	* @param {string | Function} _negateMsg or function that returns negatedMessage to display if negated expression fails
	* @param {unknown} expected value (remember to check for negation)
	* @param {unknown} _actual (optional) will default to `this.obj`
	* @param {boolean} showDiff (optional) when set to `true`, assert will display a diff in addition to the message if expression fails
	* @returns {void}
	*/
	assert(_expr, msg, _negateMsg, expected, _actual, showDiff) {
		const ok = test$1(this, arguments);
		if (false !== showDiff) showDiff = true;
		if (void 0 === expected && void 0 === _actual) showDiff = false;
		if (true !== config.showDiff) showDiff = false;
		if (!ok) {
			msg = getMessage2(this, arguments);
			const assertionErrorObjectProperties = {
				actual: getActual(this, arguments),
				expected,
				showDiff
			};
			const operator = getOperator(this, arguments);
			if (operator) assertionErrorObjectProperties.operator = operator;
			throw new AssertionError(msg, assertionErrorObjectProperties, config.includeStack ? this.assert : flag(this, "ssfi"));
		}
	}
	/**
	* Quick reference to stored `actual` value for plugin developers.
	*
	* @returns {unknown}
	*/
	get _obj() {
		return flag(this, "object");
	}
	/**
	* Quick reference to stored `actual` value for plugin developers.
	*
	* @param {unknown} val
	*/
	set _obj(val) {
		flag(this, "object", val);
	}
};
__name(_Assertion, "Assertion");
var Assertion = _Assertion;
var events = new EventTarget();
var _PluginEvent = class _PluginEvent extends Event {
	constructor(type3, name, fn) {
		super(type3);
		this.name = String(name);
		this.fn = fn;
	}
};
__name(_PluginEvent, "PluginEvent");
var PluginEvent = _PluginEvent;
function isProxyEnabled() {
	return config.useProxy && typeof Proxy !== "undefined" && typeof Reflect !== "undefined";
}
__name(isProxyEnabled, "isProxyEnabled");
function addProperty(ctx, name, getter) {
	getter = getter === void 0 ? function() {} : getter;
	Object.defineProperty(ctx, name, {
		get: /* @__PURE__ */ __name(function propertyGetter() {
			if (!isProxyEnabled() && !flag(this, "lockSsfi")) flag(this, "ssfi", propertyGetter);
			let result = getter.call(this);
			if (result !== void 0) return result;
			let newAssertion = new Assertion();
			transferFlags(this, newAssertion);
			return newAssertion;
		}, "propertyGetter"),
		configurable: true
	});
	events.dispatchEvent(new PluginEvent("addProperty", name, getter));
}
__name(addProperty, "addProperty");
var fnLengthDesc = Object.getOwnPropertyDescriptor(function() {}, "length");
function addLengthGuard(fn, assertionName, isChainable) {
	if (!fnLengthDesc.configurable) return fn;
	Object.defineProperty(fn, "length", { get: /* @__PURE__ */ __name(function() {
		if (isChainable) throw Error("Invalid Chai property: " + assertionName + ".length. Due to a compatibility issue, \"length\" cannot directly follow \"" + assertionName + "\". Use \"" + assertionName + ".lengthOf\" instead.");
		throw Error("Invalid Chai property: " + assertionName + ".length. See docs for proper usage of \"" + assertionName + "\".");
	}, "get") });
	return fn;
}
__name(addLengthGuard, "addLengthGuard");
function getProperties(object) {
	let result = Object.getOwnPropertyNames(object);
	function addProperty2(property) {
		if (result.indexOf(property) === -1) result.push(property);
	}
	__name(addProperty2, "addProperty");
	let proto = Object.getPrototypeOf(object);
	while (proto !== null) {
		Object.getOwnPropertyNames(proto).forEach(addProperty2);
		proto = Object.getPrototypeOf(proto);
	}
	return result;
}
__name(getProperties, "getProperties");
var builtins = [
	"__flags",
	"__methods",
	"_obj",
	"assert"
];
function proxify(obj, nonChainableMethodName) {
	if (!isProxyEnabled()) return obj;
	return new Proxy(obj, { get: /* @__PURE__ */ __name(function proxyGetter(target, property) {
		if (typeof property === "string" && config.proxyExcludedKeys.indexOf(property) === -1 && !Reflect.has(target, property)) {
			if (nonChainableMethodName) throw Error("Invalid Chai property: " + nonChainableMethodName + "." + property + ". See docs for proper usage of \"" + nonChainableMethodName + "\".");
			let suggestion = null;
			let suggestionDistance = 4;
			getProperties(target).forEach(function(prop) {
				if (!Object.prototype.hasOwnProperty(prop) && builtins.indexOf(prop) === -1) {
					let dist = stringDistanceCapped(property, prop, suggestionDistance);
					if (dist < suggestionDistance) {
						suggestion = prop;
						suggestionDistance = dist;
					}
				}
			});
			if (suggestion !== null) throw Error("Invalid Chai property: " + property + ". Did you mean \"" + suggestion + "\"?");
			else throw Error("Invalid Chai property: " + property);
		}
		if (builtins.indexOf(property) === -1 && !flag(target, "lockSsfi")) flag(target, "ssfi", proxyGetter);
		return Reflect.get(target, property);
	}, "proxyGetter") });
}
__name(proxify, "proxify");
function stringDistanceCapped(strA, strB, cap) {
	if (Math.abs(strA.length - strB.length) >= cap) return cap;
	let memo = [];
	for (let i = 0; i <= strA.length; i++) {
		memo[i] = Array(strB.length + 1).fill(0);
		memo[i][0] = i;
	}
	for (let j = 0; j < strB.length; j++) memo[0][j] = j;
	for (let i = 1; i <= strA.length; i++) {
		let ch = strA.charCodeAt(i - 1);
		for (let j = 1; j <= strB.length; j++) {
			if (Math.abs(i - j) >= cap) {
				memo[i][j] = cap;
				continue;
			}
			memo[i][j] = Math.min(memo[i - 1][j] + 1, memo[i][j - 1] + 1, memo[i - 1][j - 1] + (ch === strB.charCodeAt(j - 1) ? 0 : 1));
		}
	}
	return memo[strA.length][strB.length];
}
__name(stringDistanceCapped, "stringDistanceCapped");
function addMethod(ctx, name, method) {
	let methodWrapper = /* @__PURE__ */ __name(function() {
		if (!flag(this, "lockSsfi")) flag(this, "ssfi", methodWrapper);
		let result = method.apply(this, arguments);
		if (result !== void 0) return result;
		let newAssertion = new Assertion();
		transferFlags(this, newAssertion);
		return newAssertion;
	}, "methodWrapper");
	addLengthGuard(methodWrapper, name, false);
	ctx[name] = proxify(methodWrapper, name);
	events.dispatchEvent(new PluginEvent("addMethod", name, method));
}
__name(addMethod, "addMethod");
function overwriteProperty(ctx, name, getter) {
	let _get = Object.getOwnPropertyDescriptor(ctx, name), _super = /* @__PURE__ */ __name(function() {}, "_super");
	if (_get && "function" === typeof _get.get) _super = _get.get;
	Object.defineProperty(ctx, name, {
		get: /* @__PURE__ */ __name(function overwritingPropertyGetter() {
			if (!isProxyEnabled() && !flag(this, "lockSsfi")) flag(this, "ssfi", overwritingPropertyGetter);
			let origLockSsfi = flag(this, "lockSsfi");
			flag(this, "lockSsfi", true);
			let result = getter(_super).call(this);
			flag(this, "lockSsfi", origLockSsfi);
			if (result !== void 0) return result;
			let newAssertion = new Assertion();
			transferFlags(this, newAssertion);
			return newAssertion;
		}, "overwritingPropertyGetter"),
		configurable: true
	});
}
__name(overwriteProperty, "overwriteProperty");
function overwriteMethod(ctx, name, method) {
	let _method = ctx[name], _super = /* @__PURE__ */ __name(function() {
		throw new Error(name + " is not a function");
	}, "_super");
	if (_method && "function" === typeof _method) _super = _method;
	let overwritingMethodWrapper = /* @__PURE__ */ __name(function() {
		if (!flag(this, "lockSsfi")) flag(this, "ssfi", overwritingMethodWrapper);
		let origLockSsfi = flag(this, "lockSsfi");
		flag(this, "lockSsfi", true);
		let result = method(_super).apply(this, arguments);
		flag(this, "lockSsfi", origLockSsfi);
		if (result !== void 0) return result;
		let newAssertion = new Assertion();
		transferFlags(this, newAssertion);
		return newAssertion;
	}, "overwritingMethodWrapper");
	addLengthGuard(overwritingMethodWrapper, name, false);
	ctx[name] = proxify(overwritingMethodWrapper, name);
}
__name(overwriteMethod, "overwriteMethod");
var canSetPrototype = typeof Object.setPrototypeOf === "function";
var testFn = /* @__PURE__ */ __name(function() {}, "testFn");
var excludeNames = Object.getOwnPropertyNames(testFn).filter(function(name) {
	let propDesc = Object.getOwnPropertyDescriptor(testFn, name);
	if (typeof propDesc !== "object") return true;
	return !propDesc.configurable;
});
var call = Function.prototype.call;
var apply = Function.prototype.apply;
var _PluginAddChainableMethodEvent = class _PluginAddChainableMethodEvent extends PluginEvent {
	constructor(type3, name, fn, chainingBehavior) {
		super(type3, name, fn);
		this.chainingBehavior = chainingBehavior;
	}
};
__name(_PluginAddChainableMethodEvent, "PluginAddChainableMethodEvent");
var PluginAddChainableMethodEvent = _PluginAddChainableMethodEvent;
function addChainableMethod(ctx, name, method, chainingBehavior) {
	if (typeof chainingBehavior !== "function") chainingBehavior = /* @__PURE__ */ __name(function() {}, "chainingBehavior");
	let chainableBehavior = {
		method,
		chainingBehavior
	};
	if (!ctx.__methods) ctx.__methods = {};
	ctx.__methods[name] = chainableBehavior;
	Object.defineProperty(ctx, name, {
		get: /* @__PURE__ */ __name(function chainableMethodGetter() {
			chainableBehavior.chainingBehavior.call(this);
			let chainableMethodWrapper = /* @__PURE__ */ __name(function() {
				if (!flag(this, "lockSsfi")) flag(this, "ssfi", chainableMethodWrapper);
				let result = chainableBehavior.method.apply(this, arguments);
				if (result !== void 0) return result;
				let newAssertion = new Assertion();
				transferFlags(this, newAssertion);
				return newAssertion;
			}, "chainableMethodWrapper");
			addLengthGuard(chainableMethodWrapper, name, true);
			if (canSetPrototype) {
				let prototype = Object.create(this);
				prototype.call = call;
				prototype.apply = apply;
				Object.setPrototypeOf(chainableMethodWrapper, prototype);
			} else Object.getOwnPropertyNames(ctx).forEach(function(asserterName) {
				if (excludeNames.indexOf(asserterName) !== -1) return;
				Object.defineProperty(chainableMethodWrapper, asserterName, Object.getOwnPropertyDescriptor(ctx, asserterName));
			});
			transferFlags(this, chainableMethodWrapper);
			return proxify(chainableMethodWrapper);
		}, "chainableMethodGetter"),
		configurable: true
	});
	events.dispatchEvent(new PluginAddChainableMethodEvent("addChainableMethod", name, method, chainingBehavior));
}
__name(addChainableMethod, "addChainableMethod");
function overwriteChainableMethod(ctx, name, method, chainingBehavior) {
	let chainableBehavior = ctx.__methods[name];
	let _chainingBehavior = chainableBehavior.chainingBehavior;
	chainableBehavior.chainingBehavior = /* @__PURE__ */ __name(function overwritingChainableMethodGetter() {
		let result = chainingBehavior(_chainingBehavior).call(this);
		if (result !== void 0) return result;
		let newAssertion = new Assertion();
		transferFlags(this, newAssertion);
		return newAssertion;
	}, "overwritingChainableMethodGetter");
	let _method = chainableBehavior.method;
	chainableBehavior.method = /* @__PURE__ */ __name(function overwritingChainableMethodWrapper() {
		let result = method(_method).apply(this, arguments);
		if (result !== void 0) return result;
		let newAssertion = new Assertion();
		transferFlags(this, newAssertion);
		return newAssertion;
	}, "overwritingChainableMethodWrapper");
}
__name(overwriteChainableMethod, "overwriteChainableMethod");
function compareByInspect(a, b) {
	return inspect2(a) < inspect2(b) ? -1 : 1;
}
__name(compareByInspect, "compareByInspect");
function getOwnEnumerablePropertySymbols(obj) {
	if (typeof Object.getOwnPropertySymbols !== "function") return [];
	return Object.getOwnPropertySymbols(obj).filter(function(sym) {
		return Object.getOwnPropertyDescriptor(obj, sym).enumerable;
	});
}
__name(getOwnEnumerablePropertySymbols, "getOwnEnumerablePropertySymbols");
function getOwnEnumerableProperties(obj) {
	return Object.keys(obj).concat(getOwnEnumerablePropertySymbols(obj));
}
__name(getOwnEnumerableProperties, "getOwnEnumerableProperties");
var isNaN2 = Number.isNaN;
function isObjectType(obj) {
	let objectType = type(obj);
	return [
		"Array",
		"Object",
		"Function"
	].indexOf(objectType) !== -1;
}
__name(isObjectType, "isObjectType");
function getOperator(obj, args) {
	let operator = flag(obj, "operator");
	let negate = flag(obj, "negate");
	let expected = args[3];
	let msg = negate ? args[2] : args[1];
	if (operator) return operator;
	if (typeof msg === "function") msg = msg();
	msg = msg || "";
	if (!msg) return;
	if (/\shave\s/.test(msg)) return;
	let isObject = isObjectType(expected);
	if (/\snot\s/.test(msg)) return isObject ? "notDeepStrictEqual" : "notStrictEqual";
	return isObject ? "deepStrictEqual" : "strictEqual";
}
__name(getOperator, "getOperator");
function getName(fn) {
	return fn.name;
}
__name(getName, "getName");
function isRegExp2(obj) {
	return Object.prototype.toString.call(obj) === "[object RegExp]";
}
__name(isRegExp2, "isRegExp");
function isNumeric(obj) {
	return ["Number", "BigInt"].includes(type(obj));
}
__name(isNumeric, "isNumeric");
var { flag: flag2 } = utils_exports;
[
	"to",
	"be",
	"been",
	"is",
	"and",
	"has",
	"have",
	"with",
	"that",
	"which",
	"at",
	"of",
	"same",
	"but",
	"does",
	"still",
	"also"
].forEach(function(chain) {
	Assertion.addProperty(chain);
});
Assertion.addProperty("not", function() {
	flag2(this, "negate", true);
});
Assertion.addProperty("deep", function() {
	flag2(this, "deep", true);
});
Assertion.addProperty("nested", function() {
	flag2(this, "nested", true);
});
Assertion.addProperty("own", function() {
	flag2(this, "own", true);
});
Assertion.addProperty("ordered", function() {
	flag2(this, "ordered", true);
});
Assertion.addProperty("any", function() {
	flag2(this, "any", true);
	flag2(this, "all", false);
});
Assertion.addProperty("all", function() {
	flag2(this, "all", true);
	flag2(this, "any", false);
});
var functionTypes = {
	function: [
		"function",
		"asyncfunction",
		"generatorfunction",
		"asyncgeneratorfunction"
	],
	asyncfunction: ["asyncfunction", "asyncgeneratorfunction"],
	generatorfunction: ["generatorfunction", "asyncgeneratorfunction"],
	asyncgeneratorfunction: ["asyncgeneratorfunction"]
};
function an(type3, msg) {
	if (msg) flag2(this, "message", msg);
	type3 = type3.toLowerCase();
	let obj = flag2(this, "object"), article = ~[
		"a",
		"e",
		"i",
		"o",
		"u"
	].indexOf(type3.charAt(0)) ? "an " : "a ";
	const detectedType = type(obj).toLowerCase();
	if (functionTypes["function"].includes(type3)) this.assert(functionTypes[type3].includes(detectedType), "expected #{this} to be " + article + type3, "expected #{this} not to be " + article + type3);
	else this.assert(type3 === detectedType, "expected #{this} to be " + article + type3, "expected #{this} not to be " + article + type3);
}
__name(an, "an");
Assertion.addChainableMethod("an", an);
Assertion.addChainableMethod("a", an);
function SameValueZero(a, b) {
	return isNaN2(a) && isNaN2(b) || a === b;
}
__name(SameValueZero, "SameValueZero");
function includeChainingBehavior() {
	flag2(this, "contains", true);
}
__name(includeChainingBehavior, "includeChainingBehavior");
function include(val, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object"), objType = type(obj).toLowerCase(), flagMsg = flag2(this, "message"), negate = flag2(this, "negate"), ssfi = flag2(this, "ssfi"), isDeep = flag2(this, "deep"), descriptor = isDeep ? "deep " : "", isEql = isDeep ? flag2(this, "eql") : SameValueZero;
	flagMsg = flagMsg ? flagMsg + ": " : "";
	let included = false;
	switch (objType) {
		case "string":
			included = obj.indexOf(val) !== -1;
			break;
		case "weakset":
			if (isDeep) throw new AssertionError(flagMsg + "unable to use .deep.include with WeakSet", void 0, ssfi);
			included = obj.has(val);
			break;
		case "map":
			obj.forEach(function(item) {
				included = included || isEql(item, val);
			});
			break;
		case "set":
			if (isDeep) obj.forEach(function(item) {
				included = included || isEql(item, val);
			});
			else included = obj.has(val);
			break;
		case "array":
			if (isDeep) included = obj.some(function(item) {
				return isEql(item, val);
			});
			else included = obj.indexOf(val) !== -1;
			break;
		default: {
			if (val !== Object(val)) throw new AssertionError(flagMsg + "the given combination of arguments (" + objType + " and " + type(val).toLowerCase() + ") is invalid for this assertion. You can use an array, a map, an object, a set, a string, or a weakset instead of a " + type(val).toLowerCase(), void 0, ssfi);
			let props = Object.keys(val);
			let firstErr = null;
			let numErrs = 0;
			props.forEach(function(prop) {
				let propAssertion = new Assertion(obj);
				transferFlags(this, propAssertion, true);
				flag2(propAssertion, "lockSsfi", true);
				if (!negate || props.length === 1) {
					propAssertion.property(prop, val[prop]);
					return;
				}
				try {
					propAssertion.property(prop, val[prop]);
				} catch (err) {
					if (!check_error_exports.compatibleConstructor(err, AssertionError)) throw err;
					if (firstErr === null) firstErr = err;
					numErrs++;
				}
			}, this);
			if (negate && props.length > 1 && numErrs === props.length) throw firstErr;
			return;
		}
	}
	this.assert(included, "expected #{this} to " + descriptor + "include " + inspect2(val), "expected #{this} to not " + descriptor + "include " + inspect2(val));
}
__name(include, "include");
Assertion.addChainableMethod("include", include, includeChainingBehavior);
Assertion.addChainableMethod("contain", include, includeChainingBehavior);
Assertion.addChainableMethod("contains", include, includeChainingBehavior);
Assertion.addChainableMethod("includes", include, includeChainingBehavior);
Assertion.addProperty("ok", function() {
	this.assert(flag2(this, "object"), "expected #{this} to be truthy", "expected #{this} to be falsy");
});
Assertion.addProperty("true", function() {
	this.assert(true === flag2(this, "object"), "expected #{this} to be true", "expected #{this} to be false", flag2(this, "negate") ? false : true);
});
Assertion.addProperty("numeric", function() {
	const object = flag2(this, "object");
	this.assert(["Number", "BigInt"].includes(type(object)), "expected #{this} to be numeric", "expected #{this} to not be numeric", flag2(this, "negate") ? false : true);
});
Assertion.addProperty("callable", function() {
	const val = flag2(this, "object");
	const ssfi = flag2(this, "ssfi");
	const message = flag2(this, "message");
	const msg = message ? `${message}: ` : "";
	const negate = flag2(this, "negate");
	const assertionMessage = negate ? `${msg}expected ${inspect2(val)} not to be a callable function` : `${msg}expected ${inspect2(val)} to be a callable function`;
	const isCallable = [
		"Function",
		"AsyncFunction",
		"GeneratorFunction",
		"AsyncGeneratorFunction"
	].includes(type(val));
	if (isCallable && negate || !isCallable && !negate) throw new AssertionError(assertionMessage, void 0, ssfi);
});
Assertion.addProperty("false", function() {
	this.assert(false === flag2(this, "object"), "expected #{this} to be false", "expected #{this} to be true", flag2(this, "negate") ? true : false);
});
Assertion.addProperty("null", function() {
	this.assert(null === flag2(this, "object"), "expected #{this} to be null", "expected #{this} not to be null");
});
Assertion.addProperty("undefined", function() {
	this.assert(void 0 === flag2(this, "object"), "expected #{this} to be undefined", "expected #{this} not to be undefined");
});
Assertion.addProperty("NaN", function() {
	this.assert(isNaN2(flag2(this, "object")), "expected #{this} to be NaN", "expected #{this} not to be NaN");
});
function assertExist() {
	let val = flag2(this, "object");
	this.assert(val !== null && val !== void 0, "expected #{this} to exist", "expected #{this} to not exist");
}
__name(assertExist, "assertExist");
Assertion.addProperty("exist", assertExist);
Assertion.addProperty("exists", assertExist);
Assertion.addProperty("empty", function() {
	let val = flag2(this, "object"), ssfi = flag2(this, "ssfi"), flagMsg = flag2(this, "message"), itemsCount;
	flagMsg = flagMsg ? flagMsg + ": " : "";
	switch (type(val).toLowerCase()) {
		case "array":
		case "string":
			itemsCount = val.length;
			break;
		case "map":
		case "set":
			itemsCount = val.size;
			break;
		case "weakmap":
		case "weakset": throw new AssertionError(flagMsg + ".empty was passed a weak collection", void 0, ssfi);
		case "function": throw new AssertionError((flagMsg + ".empty was passed a function " + getName(val)).trim(), void 0, ssfi);
		default:
			if (val !== Object(val)) throw new AssertionError(flagMsg + ".empty was passed non-string primitive " + inspect2(val), void 0, ssfi);
			itemsCount = Object.keys(val).length;
	}
	this.assert(0 === itemsCount, "expected #{this} to be empty", "expected #{this} not to be empty");
});
function checkArguments() {
	let type3 = type(flag2(this, "object"));
	this.assert("Arguments" === type3, "expected #{this} to be arguments but got " + type3, "expected #{this} to not be arguments");
}
__name(checkArguments, "checkArguments");
Assertion.addProperty("arguments", checkArguments);
Assertion.addProperty("Arguments", checkArguments);
function assertEqual(val, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object");
	if (flag2(this, "deep")) {
		let prevLockSsfi = flag2(this, "lockSsfi");
		flag2(this, "lockSsfi", true);
		this.eql(val);
		flag2(this, "lockSsfi", prevLockSsfi);
	} else this.assert(val === obj, "expected #{this} to equal #{exp}", "expected #{this} to not equal #{exp}", val, this._obj, true);
}
__name(assertEqual, "assertEqual");
Assertion.addMethod("equal", assertEqual);
Assertion.addMethod("equals", assertEqual);
Assertion.addMethod("eq", assertEqual);
function assertEql(obj, msg) {
	if (msg) flag2(this, "message", msg);
	let eql = flag2(this, "eql");
	this.assert(eql(obj, flag2(this, "object")), "expected #{this} to deeply equal #{exp}", "expected #{this} to not deeply equal #{exp}", obj, this._obj, true);
}
__name(assertEql, "assertEql");
Assertion.addMethod("eql", assertEql);
Assertion.addMethod("eqls", assertEql);
function assertAbove(n, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object"), doLength = flag2(this, "doLength"), flagMsg = flag2(this, "message"), msgPrefix = flagMsg ? flagMsg + ": " : "", ssfi = flag2(this, "ssfi"), objType = type(obj).toLowerCase(), nType = type(n).toLowerCase();
	if (doLength && objType !== "map" && objType !== "set") new Assertion(obj, flagMsg, ssfi, true).to.have.property("length");
	if (!doLength && objType === "date" && nType !== "date") throw new AssertionError(msgPrefix + "the argument to above must be a date", void 0, ssfi);
	else if (!isNumeric(n) && (doLength || isNumeric(obj))) throw new AssertionError(msgPrefix + "the argument to above must be a number", void 0, ssfi);
	else if (!doLength && objType !== "date" && !isNumeric(obj)) {
		let printObj = objType === "string" ? "'" + obj + "'" : obj;
		throw new AssertionError(msgPrefix + "expected " + printObj + " to be a number or a date", void 0, ssfi);
	}
	if (doLength) {
		let descriptor = "length", itemsCount;
		if (objType === "map" || objType === "set") {
			descriptor = "size";
			itemsCount = obj.size;
		} else itemsCount = obj.length;
		this.assert(itemsCount > n, "expected #{this} to have a " + descriptor + " above #{exp} but got #{act}", "expected #{this} to not have a " + descriptor + " above #{exp}", n, itemsCount);
	} else this.assert(obj > n, "expected #{this} to be above #{exp}", "expected #{this} to be at most #{exp}", n);
}
__name(assertAbove, "assertAbove");
Assertion.addMethod("above", assertAbove);
Assertion.addMethod("gt", assertAbove);
Assertion.addMethod("greaterThan", assertAbove);
function assertLeast(n, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object"), doLength = flag2(this, "doLength"), flagMsg = flag2(this, "message"), msgPrefix = flagMsg ? flagMsg + ": " : "", ssfi = flag2(this, "ssfi"), objType = type(obj).toLowerCase(), nType = type(n).toLowerCase(), errorMessage, shouldThrow = true;
	if (doLength && objType !== "map" && objType !== "set") new Assertion(obj, flagMsg, ssfi, true).to.have.property("length");
	if (!doLength && objType === "date" && nType !== "date") errorMessage = msgPrefix + "the argument to least must be a date";
	else if (!isNumeric(n) && (doLength || isNumeric(obj))) errorMessage = msgPrefix + "the argument to least must be a number";
	else if (!doLength && objType !== "date" && !isNumeric(obj)) {
		let printObj = objType === "string" ? "'" + obj + "'" : obj;
		errorMessage = msgPrefix + "expected " + printObj + " to be a number or a date";
	} else shouldThrow = false;
	if (shouldThrow) throw new AssertionError(errorMessage, void 0, ssfi);
	if (doLength) {
		let descriptor = "length", itemsCount;
		if (objType === "map" || objType === "set") {
			descriptor = "size";
			itemsCount = obj.size;
		} else itemsCount = obj.length;
		this.assert(itemsCount >= n, "expected #{this} to have a " + descriptor + " at least #{exp} but got #{act}", "expected #{this} to have a " + descriptor + " below #{exp}", n, itemsCount);
	} else this.assert(obj >= n, "expected #{this} to be at least #{exp}", "expected #{this} to be below #{exp}", n);
}
__name(assertLeast, "assertLeast");
Assertion.addMethod("least", assertLeast);
Assertion.addMethod("gte", assertLeast);
Assertion.addMethod("greaterThanOrEqual", assertLeast);
function assertBelow(n, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object"), doLength = flag2(this, "doLength"), flagMsg = flag2(this, "message"), msgPrefix = flagMsg ? flagMsg + ": " : "", ssfi = flag2(this, "ssfi"), objType = type(obj).toLowerCase(), nType = type(n).toLowerCase(), errorMessage, shouldThrow = true;
	if (doLength && objType !== "map" && objType !== "set") new Assertion(obj, flagMsg, ssfi, true).to.have.property("length");
	if (!doLength && objType === "date" && nType !== "date") errorMessage = msgPrefix + "the argument to below must be a date";
	else if (!isNumeric(n) && (doLength || isNumeric(obj))) errorMessage = msgPrefix + "the argument to below must be a number";
	else if (!doLength && objType !== "date" && !isNumeric(obj)) {
		let printObj = objType === "string" ? "'" + obj + "'" : obj;
		errorMessage = msgPrefix + "expected " + printObj + " to be a number or a date";
	} else shouldThrow = false;
	if (shouldThrow) throw new AssertionError(errorMessage, void 0, ssfi);
	if (doLength) {
		let descriptor = "length", itemsCount;
		if (objType === "map" || objType === "set") {
			descriptor = "size";
			itemsCount = obj.size;
		} else itemsCount = obj.length;
		this.assert(itemsCount < n, "expected #{this} to have a " + descriptor + " below #{exp} but got #{act}", "expected #{this} to not have a " + descriptor + " below #{exp}", n, itemsCount);
	} else this.assert(obj < n, "expected #{this} to be below #{exp}", "expected #{this} to be at least #{exp}", n);
}
__name(assertBelow, "assertBelow");
Assertion.addMethod("below", assertBelow);
Assertion.addMethod("lt", assertBelow);
Assertion.addMethod("lessThan", assertBelow);
function assertMost(n, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object"), doLength = flag2(this, "doLength"), flagMsg = flag2(this, "message"), msgPrefix = flagMsg ? flagMsg + ": " : "", ssfi = flag2(this, "ssfi"), objType = type(obj).toLowerCase(), nType = type(n).toLowerCase(), errorMessage, shouldThrow = true;
	if (doLength && objType !== "map" && objType !== "set") new Assertion(obj, flagMsg, ssfi, true).to.have.property("length");
	if (!doLength && objType === "date" && nType !== "date") errorMessage = msgPrefix + "the argument to most must be a date";
	else if (!isNumeric(n) && (doLength || isNumeric(obj))) errorMessage = msgPrefix + "the argument to most must be a number";
	else if (!doLength && objType !== "date" && !isNumeric(obj)) {
		let printObj = objType === "string" ? "'" + obj + "'" : obj;
		errorMessage = msgPrefix + "expected " + printObj + " to be a number or a date";
	} else shouldThrow = false;
	if (shouldThrow) throw new AssertionError(errorMessage, void 0, ssfi);
	if (doLength) {
		let descriptor = "length", itemsCount;
		if (objType === "map" || objType === "set") {
			descriptor = "size";
			itemsCount = obj.size;
		} else itemsCount = obj.length;
		this.assert(itemsCount <= n, "expected #{this} to have a " + descriptor + " at most #{exp} but got #{act}", "expected #{this} to have a " + descriptor + " above #{exp}", n, itemsCount);
	} else this.assert(obj <= n, "expected #{this} to be at most #{exp}", "expected #{this} to be above #{exp}", n);
}
__name(assertMost, "assertMost");
Assertion.addMethod("most", assertMost);
Assertion.addMethod("lte", assertMost);
Assertion.addMethod("lessThanOrEqual", assertMost);
Assertion.addMethod("within", function(start, finish, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object"), doLength = flag2(this, "doLength"), flagMsg = flag2(this, "message"), msgPrefix = flagMsg ? flagMsg + ": " : "", ssfi = flag2(this, "ssfi"), objType = type(obj).toLowerCase(), startType = type(start).toLowerCase(), finishType = type(finish).toLowerCase(), errorMessage, shouldThrow = true, range = startType === "date" && finishType === "date" ? start.toISOString() + ".." + finish.toISOString() : start + ".." + finish;
	if (doLength && objType !== "map" && objType !== "set") new Assertion(obj, flagMsg, ssfi, true).to.have.property("length");
	if (!doLength && objType === "date" && (startType !== "date" || finishType !== "date")) errorMessage = msgPrefix + "the arguments to within must be dates";
	else if ((!isNumeric(start) || !isNumeric(finish)) && (doLength || isNumeric(obj))) errorMessage = msgPrefix + "the arguments to within must be numbers";
	else if (!doLength && objType !== "date" && !isNumeric(obj)) {
		let printObj = objType === "string" ? "'" + obj + "'" : obj;
		errorMessage = msgPrefix + "expected " + printObj + " to be a number or a date";
	} else shouldThrow = false;
	if (shouldThrow) throw new AssertionError(errorMessage, void 0, ssfi);
	if (doLength) {
		let descriptor = "length", itemsCount;
		if (objType === "map" || objType === "set") {
			descriptor = "size";
			itemsCount = obj.size;
		} else itemsCount = obj.length;
		this.assert(itemsCount >= start && itemsCount <= finish, "expected #{this} to have a " + descriptor + " within " + range, "expected #{this} to not have a " + descriptor + " within " + range);
	} else this.assert(obj >= start && obj <= finish, "expected #{this} to be within " + range, "expected #{this} to not be within " + range);
});
function assertInstanceOf(constructor, msg) {
	if (msg) flag2(this, "message", msg);
	let target = flag2(this, "object");
	let ssfi = flag2(this, "ssfi");
	let flagMsg = flag2(this, "message");
	let isInstanceOf;
	try {
		isInstanceOf = target instanceof constructor;
	} catch (err) {
		if (err instanceof TypeError) {
			flagMsg = flagMsg ? flagMsg + ": " : "";
			throw new AssertionError(flagMsg + "The instanceof assertion needs a constructor but " + type(constructor) + " was given.", void 0, ssfi);
		}
		throw err;
	}
	let name = getName(constructor);
	if (name == null) name = "an unnamed constructor";
	this.assert(isInstanceOf, "expected #{this} to be an instance of " + name, "expected #{this} to not be an instance of " + name);
}
__name(assertInstanceOf, "assertInstanceOf");
Assertion.addMethod("instanceof", assertInstanceOf);
Assertion.addMethod("instanceOf", assertInstanceOf);
function assertProperty(name, val, msg) {
	if (msg) flag2(this, "message", msg);
	let isNested = flag2(this, "nested"), isOwn = flag2(this, "own"), flagMsg = flag2(this, "message"), obj = flag2(this, "object"), ssfi = flag2(this, "ssfi"), nameType = typeof name;
	flagMsg = flagMsg ? flagMsg + ": " : "";
	if (isNested) {
		if (nameType !== "string") throw new AssertionError(flagMsg + "the argument to property must be a string when using nested syntax", void 0, ssfi);
	} else if (nameType !== "string" && nameType !== "number" && nameType !== "symbol") throw new AssertionError(flagMsg + "the argument to property must be a string, number, or symbol", void 0, ssfi);
	if (isNested && isOwn) throw new AssertionError(flagMsg + "The \"nested\" and \"own\" flags cannot be combined.", void 0, ssfi);
	if (obj === null || obj === void 0) throw new AssertionError(flagMsg + "Target cannot be null or undefined.", void 0, ssfi);
	let isDeep = flag2(this, "deep"), negate = flag2(this, "negate"), pathInfo = isNested ? getPathInfo(obj, name) : null, value = isNested ? pathInfo.value : obj[name], isEql = isDeep ? flag2(this, "eql") : (val1, val2) => val1 === val2;
	let descriptor = "";
	if (isDeep) descriptor += "deep ";
	if (isOwn) descriptor += "own ";
	if (isNested) descriptor += "nested ";
	descriptor += "property ";
	let hasProperty2;
	if (isOwn) hasProperty2 = Object.prototype.hasOwnProperty.call(obj, name);
	else if (isNested) hasProperty2 = pathInfo.exists;
	else hasProperty2 = hasProperty(obj, name);
	if (!negate || arguments.length === 1) this.assert(hasProperty2, "expected #{this} to have " + descriptor + inspect2(name), "expected #{this} to not have " + descriptor + inspect2(name));
	if (arguments.length > 1) this.assert(hasProperty2 && isEql(val, value), "expected #{this} to have " + descriptor + inspect2(name) + " of #{exp}, but got #{act}", "expected #{this} to not have " + descriptor + inspect2(name) + " of #{act}", val, value);
	flag2(this, "object", value);
}
__name(assertProperty, "assertProperty");
Assertion.addMethod("property", assertProperty);
function assertOwnProperty(_name, _value, _msg) {
	flag2(this, "own", true);
	assertProperty.apply(this, arguments);
}
__name(assertOwnProperty, "assertOwnProperty");
Assertion.addMethod("ownProperty", assertOwnProperty);
Assertion.addMethod("haveOwnProperty", assertOwnProperty);
function assertOwnPropertyDescriptor(name, descriptor, msg) {
	if (typeof descriptor === "string") {
		msg = descriptor;
		descriptor = null;
	}
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object");
	let actualDescriptor = Object.getOwnPropertyDescriptor(Object(obj), name);
	let eql = flag2(this, "eql");
	if (actualDescriptor && descriptor) this.assert(eql(descriptor, actualDescriptor), "expected the own property descriptor for " + inspect2(name) + " on #{this} to match " + inspect2(descriptor) + ", got " + inspect2(actualDescriptor), "expected the own property descriptor for " + inspect2(name) + " on #{this} to not match " + inspect2(descriptor), descriptor, actualDescriptor, true);
	else this.assert(actualDescriptor, "expected #{this} to have an own property descriptor for " + inspect2(name), "expected #{this} to not have an own property descriptor for " + inspect2(name));
	flag2(this, "object", actualDescriptor);
}
__name(assertOwnPropertyDescriptor, "assertOwnPropertyDescriptor");
Assertion.addMethod("ownPropertyDescriptor", assertOwnPropertyDescriptor);
Assertion.addMethod("haveOwnPropertyDescriptor", assertOwnPropertyDescriptor);
function assertLengthChain() {
	flag2(this, "doLength", true);
}
__name(assertLengthChain, "assertLengthChain");
function assertLength(n, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object"), objType = type(obj).toLowerCase(), flagMsg = flag2(this, "message"), ssfi = flag2(this, "ssfi"), descriptor = "length", itemsCount;
	switch (objType) {
		case "map":
		case "set":
			descriptor = "size";
			itemsCount = obj.size;
			break;
		default:
			new Assertion(obj, flagMsg, ssfi, true).to.have.property("length");
			itemsCount = obj.length;
	}
	this.assert(itemsCount == n, "expected #{this} to have a " + descriptor + " of #{exp} but got #{act}", "expected #{this} to not have a " + descriptor + " of #{act}", n, itemsCount);
}
__name(assertLength, "assertLength");
Assertion.addChainableMethod("length", assertLength, assertLengthChain);
Assertion.addChainableMethod("lengthOf", assertLength, assertLengthChain);
function assertMatch(re, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object");
	this.assert(re.exec(obj), "expected #{this} to match " + re, "expected #{this} not to match " + re);
}
__name(assertMatch, "assertMatch");
Assertion.addMethod("match", assertMatch);
Assertion.addMethod("matches", assertMatch);
Assertion.addMethod("string", function(str, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object");
	new Assertion(obj, flag2(this, "message"), flag2(this, "ssfi"), true).is.a("string");
	this.assert(~obj.indexOf(str), "expected #{this} to contain " + inspect2(str), "expected #{this} to not contain " + inspect2(str));
});
function assertKeys(keys) {
	let obj = flag2(this, "object"), objType = type(obj), keysType = type(keys), ssfi = flag2(this, "ssfi"), isDeep = flag2(this, "deep"), str, deepStr = "", actual, ok = true, flagMsg = flag2(this, "message");
	flagMsg = flagMsg ? flagMsg + ": " : "";
	let mixedArgsMsg = flagMsg + "when testing keys against an object or an array you must give a single Array|Object|String argument or multiple String arguments";
	if (objType === "Map" || objType === "Set") {
		deepStr = isDeep ? "deeply " : "";
		actual = [];
		obj.forEach(function(val, key) {
			actual.push(key);
		});
		if (keysType !== "Array") keys = Array.prototype.slice.call(arguments);
	} else {
		actual = getOwnEnumerableProperties(obj);
		switch (keysType) {
			case "Array":
				if (arguments.length > 1) throw new AssertionError(mixedArgsMsg, void 0, ssfi);
				break;
			case "Object":
				if (arguments.length > 1) throw new AssertionError(mixedArgsMsg, void 0, ssfi);
				keys = Object.keys(keys);
				break;
			default: keys = Array.prototype.slice.call(arguments);
		}
		keys = keys.map(function(val) {
			return typeof val === "symbol" ? val : String(val);
		});
	}
	if (!keys.length) throw new AssertionError(flagMsg + "keys required", void 0, ssfi);
	let len = keys.length, any = flag2(this, "any"), all = flag2(this, "all"), expected = keys, isEql = isDeep ? flag2(this, "eql") : (val1, val2) => val1 === val2;
	if (!any && !all) all = true;
	if (any) ok = expected.some(function(expectedKey) {
		return actual.some(function(actualKey) {
			return isEql(expectedKey, actualKey);
		});
	});
	if (all) {
		ok = expected.every(function(expectedKey) {
			return actual.some(function(actualKey) {
				return isEql(expectedKey, actualKey);
			});
		});
		if (!flag2(this, "contains")) ok = ok && keys.length == actual.length;
	}
	if (len > 1) {
		keys = keys.map(function(key) {
			return inspect2(key);
		});
		let last = keys.pop();
		if (all) str = keys.join(", ") + ", and " + last;
		if (any) str = keys.join(", ") + ", or " + last;
	} else str = inspect2(keys[0]);
	str = (len > 1 ? "keys " : "key ") + str;
	str = (flag2(this, "contains") ? "contain " : "have ") + str;
	this.assert(ok, "expected #{this} to " + deepStr + str, "expected #{this} to not " + deepStr + str, expected.slice(0).sort(compareByInspect), actual.sort(compareByInspect), true);
}
__name(assertKeys, "assertKeys");
Assertion.addMethod("keys", assertKeys);
Assertion.addMethod("key", assertKeys);
function assertThrows(errorLike, errMsgMatcher, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object"), ssfi = flag2(this, "ssfi"), flagMsg = flag2(this, "message"), negate = flag2(this, "negate") || false;
	new Assertion(obj, flagMsg, ssfi, true).is.a("function");
	if (isRegExp2(errorLike) || typeof errorLike === "string") {
		errMsgMatcher = errorLike;
		errorLike = null;
	}
	let caughtErr;
	let errorWasThrown = false;
	try {
		obj();
	} catch (err) {
		errorWasThrown = true;
		caughtErr = err;
	}
	let everyArgIsUndefined = errorLike === void 0 && errMsgMatcher === void 0;
	let everyArgIsDefined = Boolean(errorLike && errMsgMatcher);
	let errorLikeFail = false;
	let errMsgMatcherFail = false;
	if (everyArgIsUndefined || !everyArgIsUndefined && !negate) {
		let errorLikeString = "an error";
		if (errorLike instanceof Error) errorLikeString = "#{exp}";
		else if (errorLike) errorLikeString = check_error_exports.getConstructorName(errorLike);
		let actual = caughtErr;
		if (caughtErr instanceof Error) actual = caughtErr.toString();
		else if (typeof caughtErr === "string") actual = caughtErr;
		else if (caughtErr && (typeof caughtErr === "object" || typeof caughtErr === "function")) try {
			actual = check_error_exports.getConstructorName(caughtErr);
		} catch (_err) {}
		this.assert(errorWasThrown, "expected #{this} to throw " + errorLikeString, "expected #{this} to not throw an error but #{act} was thrown", errorLike && errorLike.toString(), actual);
	}
	if (errorLike && caughtErr) {
		if (errorLike instanceof Error) {
			if (check_error_exports.compatibleInstance(caughtErr, errorLike) === negate) if (everyArgIsDefined && negate) errorLikeFail = true;
			else this.assert(negate, "expected #{this} to throw #{exp} but #{act} was thrown", "expected #{this} to not throw #{exp}" + (caughtErr && !negate ? " but #{act} was thrown" : ""), errorLike.toString(), caughtErr.toString());
		}
		if (check_error_exports.compatibleConstructor(caughtErr, errorLike) === negate) if (everyArgIsDefined && negate) errorLikeFail = true;
		else this.assert(negate, "expected #{this} to throw #{exp} but #{act} was thrown", "expected #{this} to not throw #{exp}" + (caughtErr ? " but #{act} was thrown" : ""), errorLike instanceof Error ? errorLike.toString() : errorLike && check_error_exports.getConstructorName(errorLike), caughtErr instanceof Error ? caughtErr.toString() : caughtErr && check_error_exports.getConstructorName(caughtErr));
	}
	if (caughtErr && errMsgMatcher !== void 0 && errMsgMatcher !== null) {
		let placeholder = "including";
		if (isRegExp2(errMsgMatcher)) placeholder = "matching";
		if (check_error_exports.compatibleMessage(caughtErr, errMsgMatcher) === negate) if (everyArgIsDefined && negate) errMsgMatcherFail = true;
		else this.assert(negate, "expected #{this} to throw error " + placeholder + " #{exp} but got #{act}", "expected #{this} to throw error not " + placeholder + " #{exp}", errMsgMatcher, check_error_exports.getMessage(caughtErr));
	}
	if (errorLikeFail && errMsgMatcherFail) this.assert(negate, "expected #{this} to throw #{exp} but #{act} was thrown", "expected #{this} to not throw #{exp}" + (caughtErr ? " but #{act} was thrown" : ""), errorLike instanceof Error ? errorLike.toString() : errorLike && check_error_exports.getConstructorName(errorLike), caughtErr instanceof Error ? caughtErr.toString() : caughtErr && check_error_exports.getConstructorName(caughtErr));
	flag2(this, "object", caughtErr);
}
__name(assertThrows, "assertThrows");
Assertion.addMethod("throw", assertThrows);
Assertion.addMethod("throws", assertThrows);
Assertion.addMethod("Throw", assertThrows);
function respondTo(method, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object"), itself = flag2(this, "itself"), context = "function" === typeof obj && !itself ? obj.prototype[method] : obj[method];
	this.assert("function" === typeof context, "expected #{this} to respond to " + inspect2(method), "expected #{this} to not respond to " + inspect2(method));
}
__name(respondTo, "respondTo");
Assertion.addMethod("respondTo", respondTo);
Assertion.addMethod("respondsTo", respondTo);
Assertion.addProperty("itself", function() {
	flag2(this, "itself", true);
});
function satisfy(matcher, msg) {
	if (msg) flag2(this, "message", msg);
	let result = matcher(flag2(this, "object"));
	this.assert(result, "expected #{this} to satisfy " + objDisplay(matcher), "expected #{this} to not satisfy" + objDisplay(matcher), flag2(this, "negate") ? false : true, result);
}
__name(satisfy, "satisfy");
Assertion.addMethod("satisfy", satisfy);
Assertion.addMethod("satisfies", satisfy);
function closeTo(expected, delta, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object"), flagMsg = flag2(this, "message"), ssfi = flag2(this, "ssfi");
	new Assertion(obj, flagMsg, ssfi, true).is.numeric;
	let message = "A `delta` value is required for `closeTo`";
	if (delta == void 0) throw new AssertionError(flagMsg ? `${flagMsg}: ${message}` : message, void 0, ssfi);
	new Assertion(delta, flagMsg, ssfi, true).is.numeric;
	message = "A `expected` value is required for `closeTo`";
	if (expected == void 0) throw new AssertionError(flagMsg ? `${flagMsg}: ${message}` : message, void 0, ssfi);
	new Assertion(expected, flagMsg, ssfi, true).is.numeric;
	const abs = /* @__PURE__ */ __name((x) => x < 0 ? -x : x, "abs");
	const strip = /* @__PURE__ */ __name((number) => parseFloat(parseFloat(number).toPrecision(12)), "strip");
	this.assert(strip(abs(obj - expected)) <= delta, "expected #{this} to be close to " + expected + " +/- " + delta, "expected #{this} not to be close to " + expected + " +/- " + delta);
}
__name(closeTo, "closeTo");
Assertion.addMethod("closeTo", closeTo);
Assertion.addMethod("approximately", closeTo);
function isSubsetOf(_subset, _superset, cmp, contains, ordered) {
	let superset = Array.from(_superset);
	let subset = Array.from(_subset);
	if (!contains) {
		if (subset.length !== superset.length) return false;
		superset = superset.slice();
	}
	return subset.every(function(elem, idx) {
		if (ordered) return cmp ? cmp(elem, superset[idx]) : elem === superset[idx];
		if (!cmp) {
			let matchIdx = superset.indexOf(elem);
			if (matchIdx === -1) return false;
			if (!contains) superset.splice(matchIdx, 1);
			return true;
		}
		return superset.some(function(elem2, matchIdx) {
			if (!cmp(elem, elem2)) return false;
			if (!contains) superset.splice(matchIdx, 1);
			return true;
		});
	});
}
__name(isSubsetOf, "isSubsetOf");
Assertion.addMethod("members", function(subset, msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object"), flagMsg = flag2(this, "message"), ssfi = flag2(this, "ssfi");
	new Assertion(obj, flagMsg, ssfi, true).to.be.iterable;
	new Assertion(subset, flagMsg, ssfi, true).to.be.iterable;
	let contains = flag2(this, "contains");
	let ordered = flag2(this, "ordered");
	let subject, failMsg, failNegateMsg;
	if (contains) {
		subject = ordered ? "an ordered superset" : "a superset";
		failMsg = "expected #{this} to be " + subject + " of #{exp}";
		failNegateMsg = "expected #{this} to not be " + subject + " of #{exp}";
	} else {
		subject = ordered ? "ordered members" : "members";
		failMsg = "expected #{this} to have the same " + subject + " as #{exp}";
		failNegateMsg = "expected #{this} to not have the same " + subject + " as #{exp}";
	}
	let cmp = flag2(this, "deep") ? flag2(this, "eql") : void 0;
	this.assert(isSubsetOf(subset, obj, cmp, contains, ordered), failMsg, failNegateMsg, subset, obj, true);
});
Assertion.addProperty("iterable", function(msg) {
	if (msg) flag2(this, "message", msg);
	let obj = flag2(this, "object");
	this.assert(obj != void 0 && obj[Symbol.iterator], "expected #{this} to be an iterable", "expected #{this} to not be an iterable", obj);
});
function oneOf(list, msg) {
	if (msg) flag2(this, "message", msg);
	let expected = flag2(this, "object"), flagMsg = flag2(this, "message"), ssfi = flag2(this, "ssfi"), contains = flag2(this, "contains"), isDeep = flag2(this, "deep"), eql = flag2(this, "eql");
	new Assertion(list, flagMsg, ssfi, true).to.be.an("array");
	if (contains) this.assert(list.some(function(possibility) {
		return expected.indexOf(possibility) > -1;
	}), "expected #{this} to contain one of #{exp}", "expected #{this} to not contain one of #{exp}", list, expected);
	else if (isDeep) this.assert(list.some(function(possibility) {
		return eql(expected, possibility);
	}), "expected #{this} to deeply equal one of #{exp}", "expected #{this} to deeply equal one of #{exp}", list, expected);
	else this.assert(list.indexOf(expected) > -1, "expected #{this} to be one of #{exp}", "expected #{this} to not be one of #{exp}", list, expected);
}
__name(oneOf, "oneOf");
Assertion.addMethod("oneOf", oneOf);
function assertChanges(subject, prop, msg) {
	if (msg) flag2(this, "message", msg);
	let fn = flag2(this, "object"), flagMsg = flag2(this, "message"), ssfi = flag2(this, "ssfi");
	new Assertion(fn, flagMsg, ssfi, true).is.a("function");
	let initial;
	if (!prop) {
		new Assertion(subject, flagMsg, ssfi, true).is.a("function");
		initial = subject();
	} else {
		new Assertion(subject, flagMsg, ssfi, true).to.have.property(prop);
		initial = subject[prop];
	}
	fn();
	let final = prop === void 0 || prop === null ? subject() : subject[prop];
	let msgObj = prop === void 0 || prop === null ? initial : "." + prop;
	flag2(this, "deltaMsgObj", msgObj);
	flag2(this, "initialDeltaValue", initial);
	flag2(this, "finalDeltaValue", final);
	flag2(this, "deltaBehavior", "change");
	flag2(this, "realDelta", final !== initial);
	this.assert(initial !== final, "expected " + msgObj + " to change", "expected " + msgObj + " to not change");
}
__name(assertChanges, "assertChanges");
Assertion.addMethod("change", assertChanges);
Assertion.addMethod("changes", assertChanges);
function assertIncreases(subject, prop, msg) {
	if (msg) flag2(this, "message", msg);
	let fn = flag2(this, "object"), flagMsg = flag2(this, "message"), ssfi = flag2(this, "ssfi");
	new Assertion(fn, flagMsg, ssfi, true).is.a("function");
	let initial;
	if (!prop) {
		new Assertion(subject, flagMsg, ssfi, true).is.a("function");
		initial = subject();
	} else {
		new Assertion(subject, flagMsg, ssfi, true).to.have.property(prop);
		initial = subject[prop];
	}
	new Assertion(initial, flagMsg, ssfi, true).is.a("number");
	fn();
	let final = prop === void 0 || prop === null ? subject() : subject[prop];
	let msgObj = prop === void 0 || prop === null ? initial : "." + prop;
	flag2(this, "deltaMsgObj", msgObj);
	flag2(this, "initialDeltaValue", initial);
	flag2(this, "finalDeltaValue", final);
	flag2(this, "deltaBehavior", "increase");
	flag2(this, "realDelta", final - initial);
	this.assert(final - initial > 0, "expected " + msgObj + " to increase", "expected " + msgObj + " to not increase");
}
__name(assertIncreases, "assertIncreases");
Assertion.addMethod("increase", assertIncreases);
Assertion.addMethod("increases", assertIncreases);
function assertDecreases(subject, prop, msg) {
	if (msg) flag2(this, "message", msg);
	let fn = flag2(this, "object"), flagMsg = flag2(this, "message"), ssfi = flag2(this, "ssfi");
	new Assertion(fn, flagMsg, ssfi, true).is.a("function");
	let initial;
	if (!prop) {
		new Assertion(subject, flagMsg, ssfi, true).is.a("function");
		initial = subject();
	} else {
		new Assertion(subject, flagMsg, ssfi, true).to.have.property(prop);
		initial = subject[prop];
	}
	new Assertion(initial, flagMsg, ssfi, true).is.a("number");
	fn();
	let final = prop === void 0 || prop === null ? subject() : subject[prop];
	let msgObj = prop === void 0 || prop === null ? initial : "." + prop;
	flag2(this, "deltaMsgObj", msgObj);
	flag2(this, "initialDeltaValue", initial);
	flag2(this, "finalDeltaValue", final);
	flag2(this, "deltaBehavior", "decrease");
	flag2(this, "realDelta", initial - final);
	this.assert(final - initial < 0, "expected " + msgObj + " to decrease", "expected " + msgObj + " to not decrease");
}
__name(assertDecreases, "assertDecreases");
Assertion.addMethod("decrease", assertDecreases);
Assertion.addMethod("decreases", assertDecreases);
function assertDelta(delta, msg) {
	if (msg) flag2(this, "message", msg);
	let msgObj = flag2(this, "deltaMsgObj");
	let initial = flag2(this, "initialDeltaValue");
	let final = flag2(this, "finalDeltaValue");
	let behavior = flag2(this, "deltaBehavior");
	let realDelta = flag2(this, "realDelta");
	let expression;
	if (behavior === "change") expression = Math.abs(final - initial) === Math.abs(delta);
	else expression = realDelta === Math.abs(delta);
	this.assert(expression, "expected " + msgObj + " to " + behavior + " by " + delta, "expected " + msgObj + " to not " + behavior + " by " + delta);
}
__name(assertDelta, "assertDelta");
Assertion.addMethod("by", assertDelta);
Assertion.addProperty("extensible", function() {
	let obj = flag2(this, "object");
	let isExtensible = obj === Object(obj) && Object.isExtensible(obj);
	this.assert(isExtensible, "expected #{this} to be extensible", "expected #{this} to not be extensible");
});
Assertion.addProperty("sealed", function() {
	let obj = flag2(this, "object");
	let isSealed = obj === Object(obj) ? Object.isSealed(obj) : true;
	this.assert(isSealed, "expected #{this} to be sealed", "expected #{this} to not be sealed");
});
Assertion.addProperty("frozen", function() {
	let obj = flag2(this, "object");
	let isFrozen = obj === Object(obj) ? Object.isFrozen(obj) : true;
	this.assert(isFrozen, "expected #{this} to be frozen", "expected #{this} to not be frozen");
});
Assertion.addProperty("finite", function(_msg) {
	let obj = flag2(this, "object");
	this.assert(typeof obj === "number" && isFinite(obj), "expected #{this} to be a finite number", "expected #{this} to not be a finite number");
});
function compareSubset(expected, actual) {
	if (expected === actual) return true;
	if (typeof actual !== typeof expected) return false;
	if (typeof expected !== "object" || expected === null) return expected === actual;
	if (!actual) return false;
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual)) return false;
		return expected.every(function(exp) {
			return actual.some(function(act) {
				return compareSubset(exp, act);
			});
		});
	}
	if (expected instanceof Date) if (actual instanceof Date) return expected.getTime() === actual.getTime();
	else return false;
	return Object.keys(expected).every(function(key) {
		let expectedValue = expected[key];
		let actualValue = actual[key];
		if (typeof expectedValue === "object" && expectedValue !== null && actualValue !== null) return compareSubset(expectedValue, actualValue);
		if (typeof expectedValue === "function") return expectedValue(actualValue);
		return actualValue === expectedValue;
	});
}
__name(compareSubset, "compareSubset");
Assertion.addMethod("containSubset", function(expected) {
	const actual = flag(this, "object");
	const showDiff = config.showDiff;
	this.assert(compareSubset(expected, actual), "expected #{act} to contain subset #{exp}", "expected #{act} to not contain subset #{exp}", expected, actual, showDiff);
});
function expect(val, message) {
	return new Assertion(val, message);
}
__name(expect, "expect");
expect.fail = function(actual, expected, message, operator) {
	if (arguments.length < 2) {
		message = actual;
		actual = void 0;
	}
	message = message || "expect.fail()";
	throw new AssertionError(message, {
		actual,
		expected,
		operator
	}, expect.fail);
};
var should_exports = {};
__export(should_exports, {
	Should: () => Should,
	should: () => should$1
});
function loadShould() {
	function shouldGetter() {
		if (this instanceof String || this instanceof Number || this instanceof Boolean || typeof Symbol === "function" && this instanceof Symbol || typeof BigInt === "function" && this instanceof BigInt) return new Assertion(this.valueOf(), null, shouldGetter);
		return new Assertion(this, null, shouldGetter);
	}
	__name(shouldGetter, "shouldGetter");
	function shouldSetter(value) {
		Object.defineProperty(this, "should", {
			value,
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	__name(shouldSetter, "shouldSetter");
	Object.defineProperty(Object.prototype, "should", {
		set: shouldSetter,
		get: shouldGetter,
		configurable: true
	});
	let should2 = {};
	should2.fail = function(actual, expected, message, operator) {
		if (arguments.length < 2) {
			message = actual;
			actual = void 0;
		}
		message = message || "should.fail()";
		throw new AssertionError(message, {
			actual,
			expected,
			operator
		}, should2.fail);
	};
	should2.equal = function(actual, expected, message) {
		new Assertion(actual, message).to.equal(expected);
	};
	should2.Throw = function(fn, errt, errs, msg) {
		new Assertion(fn, msg).to.Throw(errt, errs);
	};
	should2.exist = function(val, msg) {
		new Assertion(val, msg).to.exist;
	};
	should2.not = {};
	should2.not.equal = function(actual, expected, msg) {
		new Assertion(actual, msg).to.not.equal(expected);
	};
	should2.not.Throw = function(fn, errt, errs, msg) {
		new Assertion(fn, msg).to.not.Throw(errt, errs);
	};
	should2.not.exist = function(val, msg) {
		new Assertion(val, msg).to.not.exist;
	};
	should2["throw"] = should2["Throw"];
	should2.not["throw"] = should2.not["Throw"];
	return should2;
}
__name(loadShould, "loadShould");
var should$1 = loadShould;
var Should = loadShould;
function assert$1(express, errmsg) {
	new Assertion(null, null, assert$1, true).assert(express, errmsg, "[ negation message unavailable ]");
}
__name(assert$1, "assert");
assert$1.fail = function(actual, expected, message, operator) {
	if (arguments.length < 2) {
		message = actual;
		actual = void 0;
	}
	message = message || "assert.fail()";
	throw new AssertionError(message, {
		actual,
		expected,
		operator
	}, assert$1.fail);
};
assert$1.isOk = function(val, msg) {
	new Assertion(val, msg, assert$1.isOk, true).is.ok;
};
assert$1.isNotOk = function(val, msg) {
	new Assertion(val, msg, assert$1.isNotOk, true).is.not.ok;
};
assert$1.equal = function(act, exp, msg) {
	let test2 = new Assertion(act, msg, assert$1.equal, true);
	test2.assert(exp == flag(test2, "object"), "expected #{this} to equal #{exp}", "expected #{this} to not equal #{act}", exp, act, true);
};
assert$1.notEqual = function(act, exp, msg) {
	let test2 = new Assertion(act, msg, assert$1.notEqual, true);
	test2.assert(exp != flag(test2, "object"), "expected #{this} to not equal #{exp}", "expected #{this} to equal #{act}", exp, act, true);
};
assert$1.strictEqual = function(act, exp, msg) {
	new Assertion(act, msg, assert$1.strictEqual, true).to.equal(exp);
};
assert$1.notStrictEqual = function(act, exp, msg) {
	new Assertion(act, msg, assert$1.notStrictEqual, true).to.not.equal(exp);
};
assert$1.deepEqual = assert$1.deepStrictEqual = function(act, exp, msg) {
	new Assertion(act, msg, assert$1.deepEqual, true).to.eql(exp);
};
assert$1.notDeepEqual = function(act, exp, msg) {
	new Assertion(act, msg, assert$1.notDeepEqual, true).to.not.eql(exp);
};
assert$1.isAbove = function(val, abv, msg) {
	new Assertion(val, msg, assert$1.isAbove, true).to.be.above(abv);
};
assert$1.isAtLeast = function(val, atlst, msg) {
	new Assertion(val, msg, assert$1.isAtLeast, true).to.be.least(atlst);
};
assert$1.isBelow = function(val, blw, msg) {
	new Assertion(val, msg, assert$1.isBelow, true).to.be.below(blw);
};
assert$1.isAtMost = function(val, atmst, msg) {
	new Assertion(val, msg, assert$1.isAtMost, true).to.be.most(atmst);
};
assert$1.isTrue = function(val, msg) {
	new Assertion(val, msg, assert$1.isTrue, true).is["true"];
};
assert$1.isNotTrue = function(val, msg) {
	new Assertion(val, msg, assert$1.isNotTrue, true).to.not.equal(true);
};
assert$1.isFalse = function(val, msg) {
	new Assertion(val, msg, assert$1.isFalse, true).is["false"];
};
assert$1.isNotFalse = function(val, msg) {
	new Assertion(val, msg, assert$1.isNotFalse, true).to.not.equal(false);
};
assert$1.isNull = function(val, msg) {
	new Assertion(val, msg, assert$1.isNull, true).to.equal(null);
};
assert$1.isNotNull = function(val, msg) {
	new Assertion(val, msg, assert$1.isNotNull, true).to.not.equal(null);
};
assert$1.isNaN = function(val, msg) {
	new Assertion(val, msg, assert$1.isNaN, true).to.be.NaN;
};
assert$1.isNotNaN = function(value, message) {
	new Assertion(value, message, assert$1.isNotNaN, true).not.to.be.NaN;
};
assert$1.exists = function(val, msg) {
	new Assertion(val, msg, assert$1.exists, true).to.exist;
};
assert$1.notExists = function(val, msg) {
	new Assertion(val, msg, assert$1.notExists, true).to.not.exist;
};
assert$1.isUndefined = function(val, msg) {
	new Assertion(val, msg, assert$1.isUndefined, true).to.equal(void 0);
};
assert$1.isDefined = function(val, msg) {
	new Assertion(val, msg, assert$1.isDefined, true).to.not.equal(void 0);
};
assert$1.isCallable = function(value, message) {
	new Assertion(value, message, assert$1.isCallable, true).is.callable;
};
assert$1.isNotCallable = function(value, message) {
	new Assertion(value, message, assert$1.isNotCallable, true).is.not.callable;
};
assert$1.isObject = function(val, msg) {
	new Assertion(val, msg, assert$1.isObject, true).to.be.a("object");
};
assert$1.isNotObject = function(val, msg) {
	new Assertion(val, msg, assert$1.isNotObject, true).to.not.be.a("object");
};
assert$1.isArray = function(val, msg) {
	new Assertion(val, msg, assert$1.isArray, true).to.be.an("array");
};
assert$1.isNotArray = function(val, msg) {
	new Assertion(val, msg, assert$1.isNotArray, true).to.not.be.an("array");
};
assert$1.isString = function(val, msg) {
	new Assertion(val, msg, assert$1.isString, true).to.be.a("string");
};
assert$1.isNotString = function(val, msg) {
	new Assertion(val, msg, assert$1.isNotString, true).to.not.be.a("string");
};
assert$1.isNumber = function(val, msg) {
	new Assertion(val, msg, assert$1.isNumber, true).to.be.a("number");
};
assert$1.isNotNumber = function(val, msg) {
	new Assertion(val, msg, assert$1.isNotNumber, true).to.not.be.a("number");
};
assert$1.isNumeric = function(val, msg) {
	new Assertion(val, msg, assert$1.isNumeric, true).is.numeric;
};
assert$1.isNotNumeric = function(val, msg) {
	new Assertion(val, msg, assert$1.isNotNumeric, true).is.not.numeric;
};
assert$1.isFinite = function(val, msg) {
	new Assertion(val, msg, assert$1.isFinite, true).to.be.finite;
};
assert$1.isBoolean = function(val, msg) {
	new Assertion(val, msg, assert$1.isBoolean, true).to.be.a("boolean");
};
assert$1.isNotBoolean = function(val, msg) {
	new Assertion(val, msg, assert$1.isNotBoolean, true).to.not.be.a("boolean");
};
assert$1.typeOf = function(val, type3, msg) {
	new Assertion(val, msg, assert$1.typeOf, true).to.be.a(type3);
};
assert$1.notTypeOf = function(value, type3, message) {
	new Assertion(value, message, assert$1.notTypeOf, true).to.not.be.a(type3);
};
assert$1.instanceOf = function(val, type3, msg) {
	new Assertion(val, msg, assert$1.instanceOf, true).to.be.instanceOf(type3);
};
assert$1.notInstanceOf = function(val, type3, msg) {
	new Assertion(val, msg, assert$1.notInstanceOf, true).to.not.be.instanceOf(type3);
};
assert$1.include = function(exp, inc, msg) {
	new Assertion(exp, msg, assert$1.include, true).include(inc);
};
assert$1.notInclude = function(exp, inc, msg) {
	new Assertion(exp, msg, assert$1.notInclude, true).not.include(inc);
};
assert$1.deepInclude = function(exp, inc, msg) {
	new Assertion(exp, msg, assert$1.deepInclude, true).deep.include(inc);
};
assert$1.notDeepInclude = function(exp, inc, msg) {
	new Assertion(exp, msg, assert$1.notDeepInclude, true).not.deep.include(inc);
};
assert$1.nestedInclude = function(exp, inc, msg) {
	new Assertion(exp, msg, assert$1.nestedInclude, true).nested.include(inc);
};
assert$1.notNestedInclude = function(exp, inc, msg) {
	new Assertion(exp, msg, assert$1.notNestedInclude, true).not.nested.include(inc);
};
assert$1.deepNestedInclude = function(exp, inc, msg) {
	new Assertion(exp, msg, assert$1.deepNestedInclude, true).deep.nested.include(inc);
};
assert$1.notDeepNestedInclude = function(exp, inc, msg) {
	new Assertion(exp, msg, assert$1.notDeepNestedInclude, true).not.deep.nested.include(inc);
};
assert$1.ownInclude = function(exp, inc, msg) {
	new Assertion(exp, msg, assert$1.ownInclude, true).own.include(inc);
};
assert$1.notOwnInclude = function(exp, inc, msg) {
	new Assertion(exp, msg, assert$1.notOwnInclude, true).not.own.include(inc);
};
assert$1.deepOwnInclude = function(exp, inc, msg) {
	new Assertion(exp, msg, assert$1.deepOwnInclude, true).deep.own.include(inc);
};
assert$1.notDeepOwnInclude = function(exp, inc, msg) {
	new Assertion(exp, msg, assert$1.notDeepOwnInclude, true).not.deep.own.include(inc);
};
assert$1.match = function(exp, re, msg) {
	new Assertion(exp, msg, assert$1.match, true).to.match(re);
};
assert$1.notMatch = function(exp, re, msg) {
	new Assertion(exp, msg, assert$1.notMatch, true).to.not.match(re);
};
assert$1.property = function(obj, prop, msg) {
	new Assertion(obj, msg, assert$1.property, true).to.have.property(prop);
};
assert$1.notProperty = function(obj, prop, msg) {
	new Assertion(obj, msg, assert$1.notProperty, true).to.not.have.property(prop);
};
assert$1.propertyVal = function(obj, prop, val, msg) {
	new Assertion(obj, msg, assert$1.propertyVal, true).to.have.property(prop, val);
};
assert$1.notPropertyVal = function(obj, prop, val, msg) {
	new Assertion(obj, msg, assert$1.notPropertyVal, true).to.not.have.property(prop, val);
};
assert$1.deepPropertyVal = function(obj, prop, val, msg) {
	new Assertion(obj, msg, assert$1.deepPropertyVal, true).to.have.deep.property(prop, val);
};
assert$1.notDeepPropertyVal = function(obj, prop, val, msg) {
	new Assertion(obj, msg, assert$1.notDeepPropertyVal, true).to.not.have.deep.property(prop, val);
};
assert$1.ownProperty = function(obj, prop, msg) {
	new Assertion(obj, msg, assert$1.ownProperty, true).to.have.own.property(prop);
};
assert$1.notOwnProperty = function(obj, prop, msg) {
	new Assertion(obj, msg, assert$1.notOwnProperty, true).to.not.have.own.property(prop);
};
assert$1.ownPropertyVal = function(obj, prop, value, msg) {
	new Assertion(obj, msg, assert$1.ownPropertyVal, true).to.have.own.property(prop, value);
};
assert$1.notOwnPropertyVal = function(obj, prop, value, msg) {
	new Assertion(obj, msg, assert$1.notOwnPropertyVal, true).to.not.have.own.property(prop, value);
};
assert$1.deepOwnPropertyVal = function(obj, prop, value, msg) {
	new Assertion(obj, msg, assert$1.deepOwnPropertyVal, true).to.have.deep.own.property(prop, value);
};
assert$1.notDeepOwnPropertyVal = function(obj, prop, value, msg) {
	new Assertion(obj, msg, assert$1.notDeepOwnPropertyVal, true).to.not.have.deep.own.property(prop, value);
};
assert$1.nestedProperty = function(obj, prop, msg) {
	new Assertion(obj, msg, assert$1.nestedProperty, true).to.have.nested.property(prop);
};
assert$1.notNestedProperty = function(obj, prop, msg) {
	new Assertion(obj, msg, assert$1.notNestedProperty, true).to.not.have.nested.property(prop);
};
assert$1.nestedPropertyVal = function(obj, prop, val, msg) {
	new Assertion(obj, msg, assert$1.nestedPropertyVal, true).to.have.nested.property(prop, val);
};
assert$1.notNestedPropertyVal = function(obj, prop, val, msg) {
	new Assertion(obj, msg, assert$1.notNestedPropertyVal, true).to.not.have.nested.property(prop, val);
};
assert$1.deepNestedPropertyVal = function(obj, prop, val, msg) {
	new Assertion(obj, msg, assert$1.deepNestedPropertyVal, true).to.have.deep.nested.property(prop, val);
};
assert$1.notDeepNestedPropertyVal = function(obj, prop, val, msg) {
	new Assertion(obj, msg, assert$1.notDeepNestedPropertyVal, true).to.not.have.deep.nested.property(prop, val);
};
assert$1.lengthOf = function(exp, len, msg) {
	new Assertion(exp, msg, assert$1.lengthOf, true).to.have.lengthOf(len);
};
assert$1.hasAnyKeys = function(obj, keys, msg) {
	new Assertion(obj, msg, assert$1.hasAnyKeys, true).to.have.any.keys(keys);
};
assert$1.hasAllKeys = function(obj, keys, msg) {
	new Assertion(obj, msg, assert$1.hasAllKeys, true).to.have.all.keys(keys);
};
assert$1.containsAllKeys = function(obj, keys, msg) {
	new Assertion(obj, msg, assert$1.containsAllKeys, true).to.contain.all.keys(keys);
};
assert$1.doesNotHaveAnyKeys = function(obj, keys, msg) {
	new Assertion(obj, msg, assert$1.doesNotHaveAnyKeys, true).to.not.have.any.keys(keys);
};
assert$1.doesNotHaveAllKeys = function(obj, keys, msg) {
	new Assertion(obj, msg, assert$1.doesNotHaveAllKeys, true).to.not.have.all.keys(keys);
};
assert$1.hasAnyDeepKeys = function(obj, keys, msg) {
	new Assertion(obj, msg, assert$1.hasAnyDeepKeys, true).to.have.any.deep.keys(keys);
};
assert$1.hasAllDeepKeys = function(obj, keys, msg) {
	new Assertion(obj, msg, assert$1.hasAllDeepKeys, true).to.have.all.deep.keys(keys);
};
assert$1.containsAllDeepKeys = function(obj, keys, msg) {
	new Assertion(obj, msg, assert$1.containsAllDeepKeys, true).to.contain.all.deep.keys(keys);
};
assert$1.doesNotHaveAnyDeepKeys = function(obj, keys, msg) {
	new Assertion(obj, msg, assert$1.doesNotHaveAnyDeepKeys, true).to.not.have.any.deep.keys(keys);
};
assert$1.doesNotHaveAllDeepKeys = function(obj, keys, msg) {
	new Assertion(obj, msg, assert$1.doesNotHaveAllDeepKeys, true).to.not.have.all.deep.keys(keys);
};
assert$1.throws = function(fn, errorLike, errMsgMatcher, msg) {
	if ("string" === typeof errorLike || errorLike instanceof RegExp) {
		errMsgMatcher = errorLike;
		errorLike = null;
	}
	return flag(new Assertion(fn, msg, assert$1.throws, true).to.throw(errorLike, errMsgMatcher), "object");
};
assert$1.doesNotThrow = function(fn, errorLike, errMsgMatcher, message) {
	if ("string" === typeof errorLike || errorLike instanceof RegExp) {
		errMsgMatcher = errorLike;
		errorLike = null;
	}
	new Assertion(fn, message, assert$1.doesNotThrow, true).to.not.throw(errorLike, errMsgMatcher);
};
assert$1.operator = function(val, operator, val2, msg) {
	let ok;
	switch (operator) {
		case "==":
			ok = val == val2;
			break;
		case "===":
			ok = val === val2;
			break;
		case ">":
			ok = val > val2;
			break;
		case ">=":
			ok = val >= val2;
			break;
		case "<":
			ok = val < val2;
			break;
		case "<=":
			ok = val <= val2;
			break;
		case "!=":
			ok = val != val2;
			break;
		case "!==":
			ok = val !== val2;
			break;
		default:
			msg = msg ? msg + ": " : msg;
			throw new AssertionError(msg + "Invalid operator \"" + operator + "\"", void 0, assert$1.operator);
	}
	let test2 = new Assertion(ok, msg, assert$1.operator, true);
	test2.assert(true === flag(test2, "object"), "expected " + inspect2(val) + " to be " + operator + " " + inspect2(val2), "expected " + inspect2(val) + " to not be " + operator + " " + inspect2(val2));
};
assert$1.closeTo = function(act, exp, delta, msg) {
	new Assertion(act, msg, assert$1.closeTo, true).to.be.closeTo(exp, delta);
};
assert$1.approximately = function(act, exp, delta, msg) {
	new Assertion(act, msg, assert$1.approximately, true).to.be.approximately(exp, delta);
};
assert$1.sameMembers = function(set1, set2, msg) {
	new Assertion(set1, msg, assert$1.sameMembers, true).to.have.same.members(set2);
};
assert$1.notSameMembers = function(set1, set2, msg) {
	new Assertion(set1, msg, assert$1.notSameMembers, true).to.not.have.same.members(set2);
};
assert$1.sameDeepMembers = function(set1, set2, msg) {
	new Assertion(set1, msg, assert$1.sameDeepMembers, true).to.have.same.deep.members(set2);
};
assert$1.notSameDeepMembers = function(set1, set2, msg) {
	new Assertion(set1, msg, assert$1.notSameDeepMembers, true).to.not.have.same.deep.members(set2);
};
assert$1.sameOrderedMembers = function(set1, set2, msg) {
	new Assertion(set1, msg, assert$1.sameOrderedMembers, true).to.have.same.ordered.members(set2);
};
assert$1.notSameOrderedMembers = function(set1, set2, msg) {
	new Assertion(set1, msg, assert$1.notSameOrderedMembers, true).to.not.have.same.ordered.members(set2);
};
assert$1.sameDeepOrderedMembers = function(set1, set2, msg) {
	new Assertion(set1, msg, assert$1.sameDeepOrderedMembers, true).to.have.same.deep.ordered.members(set2);
};
assert$1.notSameDeepOrderedMembers = function(set1, set2, msg) {
	new Assertion(set1, msg, assert$1.notSameDeepOrderedMembers, true).to.not.have.same.deep.ordered.members(set2);
};
assert$1.includeMembers = function(superset, subset, msg) {
	new Assertion(superset, msg, assert$1.includeMembers, true).to.include.members(subset);
};
assert$1.notIncludeMembers = function(superset, subset, msg) {
	new Assertion(superset, msg, assert$1.notIncludeMembers, true).to.not.include.members(subset);
};
assert$1.includeDeepMembers = function(superset, subset, msg) {
	new Assertion(superset, msg, assert$1.includeDeepMembers, true).to.include.deep.members(subset);
};
assert$1.notIncludeDeepMembers = function(superset, subset, msg) {
	new Assertion(superset, msg, assert$1.notIncludeDeepMembers, true).to.not.include.deep.members(subset);
};
assert$1.includeOrderedMembers = function(superset, subset, msg) {
	new Assertion(superset, msg, assert$1.includeOrderedMembers, true).to.include.ordered.members(subset);
};
assert$1.notIncludeOrderedMembers = function(superset, subset, msg) {
	new Assertion(superset, msg, assert$1.notIncludeOrderedMembers, true).to.not.include.ordered.members(subset);
};
assert$1.includeDeepOrderedMembers = function(superset, subset, msg) {
	new Assertion(superset, msg, assert$1.includeDeepOrderedMembers, true).to.include.deep.ordered.members(subset);
};
assert$1.notIncludeDeepOrderedMembers = function(superset, subset, msg) {
	new Assertion(superset, msg, assert$1.notIncludeDeepOrderedMembers, true).to.not.include.deep.ordered.members(subset);
};
assert$1.oneOf = function(inList, list, msg) {
	new Assertion(inList, msg, assert$1.oneOf, true).to.be.oneOf(list);
};
assert$1.isIterable = function(obj, msg) {
	if (obj == void 0 || !obj[Symbol.iterator]) {
		msg = msg ? `${msg} expected ${inspect2(obj)} to be an iterable` : `expected ${inspect2(obj)} to be an iterable`;
		throw new AssertionError(msg, void 0, assert$1.isIterable);
	}
};
assert$1.changes = function(fn, obj, prop, msg) {
	if (arguments.length === 3 && typeof obj === "function") {
		msg = prop;
		prop = null;
	}
	new Assertion(fn, msg, assert$1.changes, true).to.change(obj, prop);
};
assert$1.changesBy = function(fn, obj, prop, delta, msg) {
	if (arguments.length === 4 && typeof obj === "function") {
		let tmpMsg = delta;
		delta = prop;
		msg = tmpMsg;
	} else if (arguments.length === 3) {
		delta = prop;
		prop = null;
	}
	new Assertion(fn, msg, assert$1.changesBy, true).to.change(obj, prop).by(delta);
};
assert$1.doesNotChange = function(fn, obj, prop, msg) {
	if (arguments.length === 3 && typeof obj === "function") {
		msg = prop;
		prop = null;
	}
	return new Assertion(fn, msg, assert$1.doesNotChange, true).to.not.change(obj, prop);
};
assert$1.changesButNotBy = function(fn, obj, prop, delta, msg) {
	if (arguments.length === 4 && typeof obj === "function") {
		let tmpMsg = delta;
		delta = prop;
		msg = tmpMsg;
	} else if (arguments.length === 3) {
		delta = prop;
		prop = null;
	}
	new Assertion(fn, msg, assert$1.changesButNotBy, true).to.change(obj, prop).but.not.by(delta);
};
assert$1.increases = function(fn, obj, prop, msg) {
	if (arguments.length === 3 && typeof obj === "function") {
		msg = prop;
		prop = null;
	}
	return new Assertion(fn, msg, assert$1.increases, true).to.increase(obj, prop);
};
assert$1.increasesBy = function(fn, obj, prop, delta, msg) {
	if (arguments.length === 4 && typeof obj === "function") {
		let tmpMsg = delta;
		delta = prop;
		msg = tmpMsg;
	} else if (arguments.length === 3) {
		delta = prop;
		prop = null;
	}
	new Assertion(fn, msg, assert$1.increasesBy, true).to.increase(obj, prop).by(delta);
};
assert$1.doesNotIncrease = function(fn, obj, prop, msg) {
	if (arguments.length === 3 && typeof obj === "function") {
		msg = prop;
		prop = null;
	}
	return new Assertion(fn, msg, assert$1.doesNotIncrease, true).to.not.increase(obj, prop);
};
assert$1.increasesButNotBy = function(fn, obj, prop, delta, msg) {
	if (arguments.length === 4 && typeof obj === "function") {
		let tmpMsg = delta;
		delta = prop;
		msg = tmpMsg;
	} else if (arguments.length === 3) {
		delta = prop;
		prop = null;
	}
	new Assertion(fn, msg, assert$1.increasesButNotBy, true).to.increase(obj, prop).but.not.by(delta);
};
assert$1.decreases = function(fn, obj, prop, msg) {
	if (arguments.length === 3 && typeof obj === "function") {
		msg = prop;
		prop = null;
	}
	return new Assertion(fn, msg, assert$1.decreases, true).to.decrease(obj, prop);
};
assert$1.decreasesBy = function(fn, obj, prop, delta, msg) {
	if (arguments.length === 4 && typeof obj === "function") {
		let tmpMsg = delta;
		delta = prop;
		msg = tmpMsg;
	} else if (arguments.length === 3) {
		delta = prop;
		prop = null;
	}
	new Assertion(fn, msg, assert$1.decreasesBy, true).to.decrease(obj, prop).by(delta);
};
assert$1.doesNotDecrease = function(fn, obj, prop, msg) {
	if (arguments.length === 3 && typeof obj === "function") {
		msg = prop;
		prop = null;
	}
	return new Assertion(fn, msg, assert$1.doesNotDecrease, true).to.not.decrease(obj, prop);
};
assert$1.doesNotDecreaseBy = function(fn, obj, prop, delta, msg) {
	if (arguments.length === 4 && typeof obj === "function") {
		let tmpMsg = delta;
		delta = prop;
		msg = tmpMsg;
	} else if (arguments.length === 3) {
		delta = prop;
		prop = null;
	}
	return new Assertion(fn, msg, assert$1.doesNotDecreaseBy, true).to.not.decrease(obj, prop).by(delta);
};
assert$1.decreasesButNotBy = function(fn, obj, prop, delta, msg) {
	if (arguments.length === 4 && typeof obj === "function") {
		let tmpMsg = delta;
		delta = prop;
		msg = tmpMsg;
	} else if (arguments.length === 3) {
		delta = prop;
		prop = null;
	}
	new Assertion(fn, msg, assert$1.decreasesButNotBy, true).to.decrease(obj, prop).but.not.by(delta);
};
assert$1.ifError = function(val) {
	if (val) throw val;
};
assert$1.isExtensible = function(obj, msg) {
	new Assertion(obj, msg, assert$1.isExtensible, true).to.be.extensible;
};
assert$1.isNotExtensible = function(obj, msg) {
	new Assertion(obj, msg, assert$1.isNotExtensible, true).to.not.be.extensible;
};
assert$1.isSealed = function(obj, msg) {
	new Assertion(obj, msg, assert$1.isSealed, true).to.be.sealed;
};
assert$1.isNotSealed = function(obj, msg) {
	new Assertion(obj, msg, assert$1.isNotSealed, true).to.not.be.sealed;
};
assert$1.isFrozen = function(obj, msg) {
	new Assertion(obj, msg, assert$1.isFrozen, true).to.be.frozen;
};
assert$1.isNotFrozen = function(obj, msg) {
	new Assertion(obj, msg, assert$1.isNotFrozen, true).to.not.be.frozen;
};
assert$1.isEmpty = function(val, msg) {
	new Assertion(val, msg, assert$1.isEmpty, true).to.be.empty;
};
assert$1.isNotEmpty = function(val, msg) {
	new Assertion(val, msg, assert$1.isNotEmpty, true).to.not.be.empty;
};
assert$1.containsSubset = function(val, exp, msg) {
	new Assertion(val, msg).to.containSubset(exp);
};
assert$1.doesNotContainSubset = function(val, exp, msg) {
	new Assertion(val, msg).to.not.containSubset(exp);
};
for (const [name, as] of [
	["isOk", "ok"],
	["isNotOk", "notOk"],
	["throws", "throw"],
	["throws", "Throw"],
	["isExtensible", "extensible"],
	["isNotExtensible", "notExtensible"],
	["isSealed", "sealed"],
	["isNotSealed", "notSealed"],
	["isFrozen", "frozen"],
	["isNotFrozen", "notFrozen"],
	["isEmpty", "empty"],
	["isNotEmpty", "notEmpty"],
	["isCallable", "isFunction"],
	["isNotCallable", "isNotFunction"],
	["containsSubset", "containSubset"]
]) assert$1[as] = assert$1[name];
var used = [];
function use(fn) {
	const exports = {
		use,
		AssertionError,
		util: utils_exports,
		config,
		expect,
		assert: assert$1,
		Assertion,
		...should_exports
	};
	if (!~used.indexOf(fn)) {
		fn(exports, utils_exports);
		used.push(fn);
	}
	return exports;
}
__name(use, "use");
//#endregion
//#region node_modules/@vitest/expect/dist/index.js
const ChaiStyleAssertions = (chai, utils) => {
	function defProperty(name, delegateTo) {
		utils.addProperty(chai.Assertion.prototype, name, function() {
			const jestMethod = chai.Assertion.prototype[delegateTo];
			if (!jestMethod) throw new Error(`Cannot delegate to ${String(delegateTo)}: method not found. Ensure JestChaiExpect plugin is loaded first.`);
			return jestMethod.call(this);
		});
	}
	function defPropertyWithArgs(name, delegateTo, ...args) {
		utils.addProperty(chai.Assertion.prototype, name, function() {
			const jestMethod = chai.Assertion.prototype[delegateTo];
			if (!jestMethod) throw new Error(`Cannot delegate to ${String(delegateTo)}: method not found. Ensure JestChaiExpect plugin is loaded first.`);
			return jestMethod.call(this, ...args);
		});
	}
	function defMethod(name, delegateTo) {
		utils.addMethod(chai.Assertion.prototype, name, function(...args) {
			const jestMethod = chai.Assertion.prototype[delegateTo];
			if (!jestMethod) throw new Error(`Cannot delegate to ${String(delegateTo)}: method not found. Ensure JestChaiExpect plugin is loaded first.`);
			return jestMethod.call(this, ...args);
		});
	}
	defProperty("called", "toHaveBeenCalled");
	defProperty("calledOnce", "toHaveBeenCalledOnce");
	defPropertyWithArgs("calledTwice", "toHaveBeenCalledTimes", 2);
	defPropertyWithArgs("calledThrice", "toHaveBeenCalledTimes", 3);
	defMethod("callCount", "toHaveBeenCalledTimes");
	defMethod("calledWith", "toHaveBeenCalledWith");
	defMethod("calledOnceWith", "toHaveBeenCalledExactlyOnceWith");
	defMethod("lastCalledWith", "toHaveBeenLastCalledWith");
	defMethod("nthCalledWith", "toHaveBeenNthCalledWith");
	defMethod("returned", "toHaveReturned");
	defMethod("returnedWith", "toHaveReturnedWith");
	defMethod("returnedTimes", "toHaveReturnedTimes");
	defMethod("lastReturnedWith", "toHaveLastReturnedWith");
	defMethod("nthReturnedWith", "toHaveNthReturnedWith");
	defMethod("calledBefore", "toHaveBeenCalledBefore");
	defMethod("calledAfter", "toHaveBeenCalledAfter");
};
const MATCHERS_OBJECT = Symbol.for("matchers-object");
const JEST_MATCHERS_OBJECT = Symbol.for("$$jest-matchers-object");
const GLOBAL_EXPECT = Symbol.for("expect-global");
const ASYMMETRIC_MATCHERS_OBJECT = Symbol.for("asymmetric-matchers-object");
const customMatchers = {
	toSatisfy(actual, expected, message) {
		const { printReceived, printExpected, matcherHint } = this.utils;
		const pass = expected(actual);
		return {
			pass,
			message: () => pass ? `\
${matcherHint(".not.toSatisfy", "received", "")}

Expected value to not satisfy:
${message || printExpected(expected)}
Received:
${printReceived(actual)}` : `\
${matcherHint(".toSatisfy", "received", "")}

Expected value to satisfy:
${message || printExpected(expected)}

Received:
${printReceived(actual)}`
		};
	},
	toBeOneOf(actual, expected) {
		const { equals, customTesters } = this;
		const { printReceived, printExpected, matcherHint } = this.utils;
		let pass;
		if (Array.isArray(expected)) pass = expected.length === 0 || expected.some((item) => equals(item, actual, customTesters));
		else if (expected instanceof Set) pass = expected.size === 0 || expected.has(actual) || [...expected].some((item) => equals(item, actual, customTesters));
		else throw new TypeError(`You must provide an array or set to ${matcherHint(".toBeOneOf")}, not '${typeof expected}'.`);
		return {
			pass,
			message: () => pass ? `\
${matcherHint(".not.toBeOneOf", "received", "")}

Expected value to not be one of:
${printExpected(expected)}
Received:
${printReceived(actual)}` : `\
${matcherHint(".toBeOneOf", "received", "")}

Expected value to be one of:
${printExpected(expected)}

Received:
${printReceived(actual)}`
		};
	}
};
const EXPECTED_COLOR = y.green;
const RECEIVED_COLOR = y.red;
const INVERTED_COLOR = y.inverse;
const BOLD_WEIGHT = y.bold;
const DIM_COLOR = y.dim;
function matcherHint(matcherName, received = "received", expected = "expected", options = {}) {
	const { comment = "", isDirectExpectCall = false, isNot = false, promise = "", secondArgument = "", expectedColor = EXPECTED_COLOR, receivedColor = RECEIVED_COLOR, secondArgumentColor = EXPECTED_COLOR } = options;
	let hint = "";
	let dimString = "expect";
	if (!isDirectExpectCall && received !== "") {
		hint += DIM_COLOR(`${dimString}(`) + receivedColor(received);
		dimString = ")";
	}
	if (promise !== "") {
		hint += DIM_COLOR(`${dimString}.`) + promise;
		dimString = "";
	}
	if (isNot) {
		hint += `${DIM_COLOR(`${dimString}.`)}not`;
		dimString = "";
	}
	if (matcherName.includes(".")) dimString += matcherName;
	else {
		hint += DIM_COLOR(`${dimString}.`) + matcherName;
		dimString = "";
	}
	if (expected === "") dimString += "()";
	else {
		hint += DIM_COLOR(`${dimString}(`) + expectedColor(expected);
		if (secondArgument) hint += DIM_COLOR(", ") + secondArgumentColor(secondArgument);
		dimString = ")";
	}
	if (comment !== "") dimString += ` // ${comment}`;
	if (dimString !== "") hint += DIM_COLOR(dimString);
	return hint;
}
const SPACE_SYMBOL = "·";
function replaceTrailingSpaces(text) {
	return text.replace(/\s+$/gm, (spaces) => SPACE_SYMBOL.repeat(spaces.length));
}
function printReceived(object) {
	return RECEIVED_COLOR(replaceTrailingSpaces(stringify(object)));
}
function printExpected(value) {
	return EXPECTED_COLOR(replaceTrailingSpaces(stringify(value)));
}
function getMatcherUtils() {
	return {
		EXPECTED_COLOR,
		RECEIVED_COLOR,
		INVERTED_COLOR,
		BOLD_WEIGHT,
		DIM_COLOR,
		diff,
		matcherHint,
		printReceived,
		printExpected,
		printDiffOrStringify,
		printWithType
	};
}
function printWithType(name, value, print) {
	const type = getType(value);
	return (type !== "null" && type !== "undefined" ? `${name} has type:  ${type}\n` : "") + `${name} has value: ${print(value)}`;
}
function addCustomEqualityTesters(newTesters) {
	if (!Array.isArray(newTesters)) throw new TypeError(`expect.customEqualityTesters: Must be set to an array of Testers. Was given "${getType(newTesters)}"`);
	globalThis[JEST_MATCHERS_OBJECT].customEqualityTesters.push(...newTesters);
}
function getCustomEqualityTesters() {
	return globalThis[JEST_MATCHERS_OBJECT].customEqualityTesters;
}
function equals(a, b, customTesters, strictCheck) {
	customTesters = customTesters || [];
	return eq(a, b, [], [], customTesters, strictCheck ? hasKey : hasDefinedKey);
}
Function.prototype.toString;
function isAsymmetric(obj) {
	return !!obj && typeof obj === "object" && "asymmetricMatch" in obj && isA("Function", obj.asymmetricMatch);
}
function asymmetricMatch(a, b, customTesters) {
	const asymmetricA = isAsymmetric(a);
	const asymmetricB = isAsymmetric(b);
	if (asymmetricA && asymmetricB) return;
	if (asymmetricA) return a.asymmetricMatch(b, customTesters);
	if (asymmetricB) return b.asymmetricMatch(a, customTesters);
}
function isError(value) {
	if (typeof Error.isError === "function") return Error.isError(value);
	switch (Object.prototype.toString.call(value)) {
		case "[object Error]":
		case "[object Exception]":
		case "[object DOMException]": return true;
		default: return value instanceof Error;
	}
}
function eq(a, b, aStack, bStack, customTesters, hasKey) {
	let result = true;
	const asymmetricResult = asymmetricMatch(a, b, customTesters);
	if (asymmetricResult !== void 0) return asymmetricResult;
	const testerContext = { equals };
	for (let i = 0; i < customTesters.length; i++) {
		const customTesterResult = customTesters[i].call(testerContext, a, b, customTesters);
		if (customTesterResult !== void 0) return customTesterResult;
	}
	if (typeof URL === "function" && a instanceof URL && b instanceof URL) return a.href === b.href;
	if (Object.is(a, b)) return true;
	if (a === null || b === null) return a === b;
	const className = Object.prototype.toString.call(a);
	if (className !== Object.prototype.toString.call(b)) return false;
	switch (className) {
		case "[object Boolean]":
		case "[object String]":
		case "[object Number]": if (typeof a !== typeof b) return false;
		else if (typeof a !== "object" && typeof b !== "object") return Object.is(a, b);
		else return Object.is(a.valueOf(), b.valueOf());
		case "[object Date]": {
			const numA = +a;
			const numB = +b;
			return numA === numB || Number.isNaN(numA) && Number.isNaN(numB);
		}
		case "[object RegExp]": return a.source === b.source && a.flags === b.flags;
		case "[object Temporal.Instant]":
		case "[object Temporal.ZonedDateTime]":
		case "[object Temporal.PlainDateTime]":
		case "[object Temporal.PlainDate]":
		case "[object Temporal.PlainTime]":
		case "[object Temporal.PlainYearMonth]":
		case "[object Temporal.PlainMonthDay]": return a.equals(b);
		case "[object Temporal.Duration]": return a.toString() === b.toString();
	}
	if (typeof a !== "object" || typeof b !== "object") return false;
	if (isDomNode(a) && isDomNode(b)) return a.isEqualNode(b);
	let length = aStack.length;
	while (length--) if (aStack[length] === a) return bStack[length] === b;
	else if (bStack[length] === b) return false;
	aStack.push(a);
	bStack.push(b);
	if (className === "[object Array]" && a.length !== b.length) return false;
	if (isError(a) && isError(b)) try {
		return isErrorEqual(a, b, aStack, bStack, customTesters, hasKey);
	} finally {
		aStack.pop();
		bStack.pop();
	}
	const aKeys = keys(a, hasKey);
	let key;
	let size = aKeys.length;
	if (keys(b, hasKey).length !== size) return false;
	while (size--) {
		key = aKeys[size];
		result = hasKey(b, key) && eq(a[key], b[key], aStack, bStack, customTesters, hasKey);
		if (!result) return false;
	}
	aStack.pop();
	bStack.pop();
	return result;
}
function isErrorEqual(a, b, aStack, bStack, customTesters, hasKey) {
	let result = Object.prototype.toString.call(a) === Object.prototype.toString.call(b) && a.name === b.name && a.message === b.message;
	if (typeof b.cause !== "undefined") result &&= eq(a.cause, b.cause, aStack, bStack, customTesters, hasKey);
	if (a instanceof AggregateError && b instanceof AggregateError) result &&= eq(a.errors, b.errors, aStack, bStack, customTesters, hasKey);
	result &&= eq({ ...a }, { ...b }, aStack, bStack, customTesters, hasKey);
	return result;
}
function keys(obj, hasKey) {
	const keys = [];
	for (const key in obj) if (hasKey(obj, key)) keys.push(key);
	return keys.concat(Object.getOwnPropertySymbols(obj).filter((symbol) => Object.getOwnPropertyDescriptor(obj, symbol).enumerable));
}
function hasDefinedKey(obj, key) {
	return hasKey(obj, key) && obj[key] !== void 0;
}
function hasKey(obj, key) {
	return Object.hasOwn(obj, key);
}
function isA(typeName, value) {
	return Object.prototype.toString.apply(value) === `[object ${typeName}]`;
}
function isDomNode(obj) {
	return obj !== null && typeof obj === "object" && "nodeType" in obj && typeof obj.nodeType === "number" && "nodeName" in obj && typeof obj.nodeName === "string" && "isEqualNode" in obj && typeof obj.isEqualNode === "function";
}
const IS_KEYED_SENTINEL = "@@__IMMUTABLE_KEYED__@@";
const IS_SET_SENTINEL = "@@__IMMUTABLE_SET__@@";
const IS_LIST_SENTINEL = "@@__IMMUTABLE_LIST__@@";
const IS_ORDERED_SENTINEL = "@@__IMMUTABLE_ORDERED__@@";
const IS_RECORD_SYMBOL = "@@__IMMUTABLE_RECORD__@@";
function isImmutableUnorderedKeyed(maybeKeyed) {
	return !!(maybeKeyed && maybeKeyed[IS_KEYED_SENTINEL] && !maybeKeyed[IS_ORDERED_SENTINEL]);
}
function isImmutableUnorderedSet(maybeSet) {
	return !!(maybeSet && maybeSet[IS_SET_SENTINEL] && !maybeSet[IS_ORDERED_SENTINEL]);
}
function isObjectLiteral(source) {
	return source != null && typeof source === "object" && !Array.isArray(source);
}
function isImmutableList(source) {
	return Boolean(source && isObjectLiteral(source) && source[IS_LIST_SENTINEL]);
}
function isImmutableOrderedKeyed(source) {
	return Boolean(source && isObjectLiteral(source) && source[IS_KEYED_SENTINEL] && source[IS_ORDERED_SENTINEL]);
}
function isImmutableOrderedSet(source) {
	return Boolean(source && isObjectLiteral(source) && source[IS_SET_SENTINEL] && source[IS_ORDERED_SENTINEL]);
}
function isImmutableRecord(source) {
	return Boolean(source && isObjectLiteral(source) && source[IS_RECORD_SYMBOL]);
}
/**
* Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*
*/
const IteratorSymbol = Symbol.iterator;
function hasIterator(object) {
	return !!(object != null && object[IteratorSymbol]);
}
function iterableEquality(a, b, customTesters = [], aStack = [], bStack = []) {
	if (typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b) || !hasIterator(a) || !hasIterator(b)) return;
	if (a.constructor !== b.constructor) return false;
	let length = aStack.length;
	while (length--) if (aStack[length] === a) return bStack[length] === b;
	aStack.push(a);
	bStack.push(b);
	const filteredCustomTesters = [...customTesters.filter((t) => t !== iterableEquality), iterableEqualityWithStack];
	function iterableEqualityWithStack(a, b) {
		return iterableEquality(a, b, [...customTesters], [...aStack], [...bStack]);
	}
	if (a.size !== void 0) {
		if (a.size !== b.size) return false;
		else if (isA("Set", a) || isImmutableUnorderedSet(a)) {
			let allFound = true;
			for (const aValue of a) if (!b.has(aValue)) {
				let has = false;
				for (const bValue of b) if (equals(aValue, bValue, filteredCustomTesters) === true) has = true;
				if (has === false) {
					allFound = false;
					break;
				}
			}
			aStack.pop();
			bStack.pop();
			return allFound;
		} else if (isA("Map", a) || isImmutableUnorderedKeyed(a)) {
			let allFound = true;
			for (const aEntry of a) if (!b.has(aEntry[0]) || !equals(aEntry[1], b.get(aEntry[0]), filteredCustomTesters)) {
				let has = false;
				for (const bEntry of b) {
					const matchedKey = equals(aEntry[0], bEntry[0], filteredCustomTesters);
					let matchedValue = false;
					if (matchedKey === true) matchedValue = equals(aEntry[1], bEntry[1], filteredCustomTesters);
					if (matchedValue === true) has = true;
				}
				if (has === false) {
					allFound = false;
					break;
				}
			}
			aStack.pop();
			bStack.pop();
			return allFound;
		}
	}
	const bIterator = b[IteratorSymbol]();
	for (const aValue of a) {
		const nextB = bIterator.next();
		if (nextB.done || !equals(aValue, nextB.value, filteredCustomTesters)) return false;
	}
	if (!bIterator.next().done) return false;
	if (!isImmutableList(a) && !isImmutableOrderedKeyed(a) && !isImmutableOrderedSet(a) && !isImmutableRecord(a)) {
		if (!equals(Object.entries(a), Object.entries(b), filteredCustomTesters)) return false;
	}
	aStack.pop();
	bStack.pop();
	return true;
}
/**
* Checks if `hasOwnProperty(object, key)` up the prototype chain, stopping at `Object.prototype`.
*/
function hasPropertyInObject(object, key) {
	if (!object || typeof object !== "object" || object === Object.prototype) return false;
	return Object.hasOwn(object, key) || hasPropertyInObject(Object.getPrototypeOf(object), key);
}
function isObjectWithKeys(a) {
	return isObject(a) && !isError(a) && !Array.isArray(a) && !(a instanceof Date) && !(a instanceof Set) && !(a instanceof Map);
}
function subsetEquality(object, subset, customTesters = []) {
	const filteredCustomTesters = customTesters.filter((t) => t !== subsetEquality);
	const subsetEqualityWithContext = (seenReferences = /* @__PURE__ */ new WeakMap()) => (object, subset) => {
		if (!isObjectWithKeys(subset)) return;
		return Object.keys(subset).every((key) => {
			if (subset[key] != null && typeof subset[key] === "object") {
				if (seenReferences.has(subset[key])) return equals(object[key], subset[key], filteredCustomTesters);
				seenReferences.set(subset[key], true);
			}
			const result = object != null && hasPropertyInObject(object, key) && equals(object[key], subset[key], [...filteredCustomTesters, subsetEqualityWithContext(seenReferences)]);
			seenReferences.delete(subset[key]);
			return result;
		});
	};
	return subsetEqualityWithContext()(object, subset);
}
function typeEquality(a, b) {
	if (a == null || b == null || a.constructor === b.constructor) return;
	return false;
}
function arrayBufferEquality(a, b) {
	let dataViewA = a;
	let dataViewB = b;
	if (!(a instanceof DataView && b instanceof DataView)) {
		if (!(a instanceof ArrayBuffer) || !(b instanceof ArrayBuffer)) return;
		try {
			dataViewA = new DataView(a);
			dataViewB = new DataView(b);
		} catch {
			return;
		}
	}
	if (dataViewA.byteLength !== dataViewB.byteLength) return false;
	for (let i = 0; i < dataViewA.byteLength; i++) if (dataViewA.getUint8(i) !== dataViewB.getUint8(i)) return false;
	return true;
}
function sparseArrayEquality(a, b, customTesters = []) {
	if (!Array.isArray(a) || !Array.isArray(b)) return;
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	return equals(a, b, customTesters.filter((t) => t !== sparseArrayEquality), true) && equals(aKeys, bKeys);
}
function generateToBeMessage(deepEqualityName, expected = "#{this}", actual = "#{exp}") {
	const toBeMessage = `expected ${expected} to be ${actual} // Object.is equality`;
	if (["toStrictEqual", "toEqual"].includes(deepEqualityName)) return `${toBeMessage}\n\nIf it should pass with deep equality, replace "toBe" with "${deepEqualityName}"\n\nExpected: ${expected}\nReceived: serializes to the same string\n`;
	return toBeMessage;
}
function pluralize(word, count) {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}
function getObjectKeys(object) {
	return [...Object.keys(object), ...Object.getOwnPropertySymbols(object).filter((s) => Object.getOwnPropertyDescriptor(object, s)?.enumerable)];
}
function getObjectSubset(object, subset, customTesters) {
	let stripped = 0;
	const getObjectSubsetWithContext = (seenReferences = /* @__PURE__ */ new WeakMap()) => (object, subset) => {
		if (Array.isArray(object)) {
			if (Array.isArray(subset) && subset.length === object.length) return subset.map((sub, i) => getObjectSubsetWithContext(seenReferences)(object[i], sub));
		} else if (object instanceof Date) return object;
		else if (isObject(object) && isObject(subset)) {
			if (equals(object, subset, [
				...customTesters,
				iterableEquality,
				subsetEquality
			])) return subset;
			const trimmed = {};
			seenReferences.set(object, trimmed);
			if (typeof object.constructor === "function" && typeof object.constructor.name === "string") Object.defineProperty(trimmed, "constructor", {
				enumerable: false,
				value: object.constructor
			});
			for (const key of getObjectKeys(object)) if (hasPropertyInObject(subset, key)) trimmed[key] = seenReferences.has(object[key]) ? seenReferences.get(object[key]) : getObjectSubsetWithContext(seenReferences)(object[key], subset[key]);
			else if (!seenReferences.has(object[key])) {
				stripped += 1;
				if (isObject(object[key])) stripped += getObjectKeys(object[key]).length;
				getObjectSubsetWithContext(seenReferences)(object[key], subset[key]);
			}
			if (getObjectKeys(trimmed).length > 0) return trimmed;
		}
		return object;
	};
	return {
		subset: getObjectSubsetWithContext()(object, subset),
		stripped
	};
}
/**
* Detects if an object is a Standard Schema V1 compatible schema
*/
function isStandardSchema(obj) {
	return !!obj && (typeof obj === "object" || typeof obj === "function") && obj["~standard"] && typeof obj["~standard"].validate === "function";
}
if (!Object.hasOwn(globalThis, MATCHERS_OBJECT)) {
	const globalState = /* @__PURE__ */ new WeakMap();
	const matchers = Object.create(null);
	const customEqualityTesters = [];
	const asymmetricMatchers = Object.create(null);
	Object.defineProperty(globalThis, MATCHERS_OBJECT, { get: () => globalState });
	Object.defineProperty(globalThis, JEST_MATCHERS_OBJECT, {
		configurable: true,
		get: () => ({
			state: globalState.get(globalThis[GLOBAL_EXPECT]),
			matchers,
			customEqualityTesters
		})
	});
	Object.defineProperty(globalThis, ASYMMETRIC_MATCHERS_OBJECT, { get: () => asymmetricMatchers });
}
function getState(expect) {
	return globalThis[MATCHERS_OBJECT].get(expect);
}
function setState(state, expect) {
	const map = globalThis[MATCHERS_OBJECT];
	const current = map.get(expect) || {};
	const results = Object.defineProperties(current, {
		...Object.getOwnPropertyDescriptors(current),
		...Object.getOwnPropertyDescriptors(state)
	});
	map.set(expect, results);
}
var AsymmetricMatcher$1 = class {
	$$typeof = Symbol.for("jest.asymmetricMatcher");
	constructor(sample, inverse = false) {
		this.sample = sample;
		this.inverse = inverse;
	}
	getMatcherContext(expect) {
		return {
			...getState(expect || globalThis[GLOBAL_EXPECT]),
			equals,
			isNot: this.inverse,
			customTesters: getCustomEqualityTesters(),
			utils: {
				...getMatcherUtils(),
				diff,
				stringify,
				iterableEquality,
				subsetEquality
			}
		};
	}
};
AsymmetricMatcher$1.prototype[Symbol.for("chai/inspect")] = function(options) {
	const result = stringify(this, options.depth, { min: true });
	if (result.length <= options.truncate) return result;
	return `${this.toString()}{…}`;
};
var StringContaining = class extends AsymmetricMatcher$1 {
	constructor(sample, inverse = false) {
		if (!isA("String", sample)) throw new Error("Expected is not a string");
		super(sample, inverse);
	}
	asymmetricMatch(other) {
		const result = isA("String", other) && other.includes(this.sample);
		return this.inverse ? !result : result;
	}
	toString() {
		return `String${this.inverse ? "Not" : ""}Containing`;
	}
	getExpectedType() {
		return "string";
	}
};
var Anything = class extends AsymmetricMatcher$1 {
	asymmetricMatch(other) {
		return other != null;
	}
	toString() {
		return "Anything";
	}
	toAsymmetricMatcher() {
		return "Anything";
	}
};
var ObjectContaining = class extends AsymmetricMatcher$1 {
	constructor(sample, inverse = false) {
		super(sample, inverse);
	}
	getPrototype(obj) {
		if (Object.getPrototypeOf) return Object.getPrototypeOf(obj);
		if (obj.constructor.prototype === obj) return null;
		return obj.constructor.prototype;
	}
	hasProperty(obj, property) {
		if (!obj) return false;
		if (Object.hasOwn(obj, property)) return true;
		return this.hasProperty(this.getPrototype(obj), property);
	}
	getProperties(obj) {
		return [...Object.keys(obj), ...Object.getOwnPropertySymbols(obj).filter((s) => Object.getOwnPropertyDescriptor(obj, s)?.enumerable)];
	}
	asymmetricMatch(other, customTesters) {
		if (typeof this.sample !== "object") throw new TypeError(`You must provide an object to ${this.toString()}, not '${typeof this.sample}'.`);
		let result = true;
		const properties = this.getProperties(this.sample);
		for (const property of properties) {
			if (!this.hasProperty(other, property)) {
				result = false;
				break;
			}
			const value = this.sample[property];
			const otherValue = other[property];
			if (!equals(value, otherValue, customTesters)) {
				result = false;
				break;
			}
		}
		return this.inverse ? !result : result;
	}
	toString() {
		return `Object${this.inverse ? "Not" : ""}Containing`;
	}
	getExpectedType() {
		return "object";
	}
};
var ArrayContaining = class extends AsymmetricMatcher$1 {
	constructor(sample, inverse = false) {
		super(sample, inverse);
	}
	asymmetricMatch(other, customTesters) {
		if (!Array.isArray(this.sample)) throw new TypeError(`You must provide an array to ${this.toString()}, not '${typeof this.sample}'.`);
		const result = this.sample.length === 0 || Array.isArray(other) && this.sample.every((item) => other.some((another) => equals(item, another, customTesters)));
		return this.inverse ? !result : result;
	}
	toString() {
		return `Array${this.inverse ? "Not" : ""}Containing`;
	}
	getExpectedType() {
		return "array";
	}
};
var Any = class extends AsymmetricMatcher$1 {
	constructor(sample) {
		if (typeof sample === "undefined") throw new TypeError("any() expects to be passed a constructor function. Please pass one or use anything() to match any object.");
		super(sample);
	}
	fnNameFor(func) {
		if (func.name) return func.name;
		const matches = Function.prototype.toString.call(func).match(/^(?:async)?\s*function\s*(?:\*\s*)?([\w$]+)\s*\(/);
		return matches ? matches[1] : "<anonymous>";
	}
	asymmetricMatch(other) {
		if (this.sample === String) return typeof other == "string" || other instanceof String;
		if (this.sample === Number) return typeof other == "number" || other instanceof Number;
		if (this.sample === Function) return typeof other == "function" || typeof other === "function";
		if (this.sample === Boolean) return typeof other == "boolean" || other instanceof Boolean;
		if (this.sample === BigInt) return typeof other == "bigint" || other instanceof BigInt;
		if (this.sample === Symbol) return typeof other == "symbol" || other instanceof Symbol;
		if (this.sample === Object) return typeof other == "object";
		return other instanceof this.sample;
	}
	toString() {
		return "Any";
	}
	getExpectedType() {
		if (this.sample === String) return "string";
		if (this.sample === Number) return "number";
		if (this.sample === Function) return "function";
		if (this.sample === Object) return "object";
		if (this.sample === Boolean) return "boolean";
		return this.fnNameFor(this.sample);
	}
	toAsymmetricMatcher() {
		return `Any<${this.fnNameFor(this.sample)}>`;
	}
};
var StringMatching = class extends AsymmetricMatcher$1 {
	constructor(sample, inverse = false) {
		if (!isA("String", sample) && !isA("RegExp", sample)) throw new Error("Expected is not a String or a RegExp");
		super(new RegExp(sample), inverse);
	}
	asymmetricMatch(other) {
		const result = isA("String", other) && this.sample.test(other);
		return this.inverse ? !result : result;
	}
	toString() {
		return `String${this.inverse ? "Not" : ""}Matching`;
	}
	getExpectedType() {
		return "string";
	}
};
var CloseTo = class extends AsymmetricMatcher$1 {
	precision;
	constructor(sample, precision = 2, inverse = false) {
		if (!isA("Number", sample)) throw new Error("Expected is not a Number");
		if (!isA("Number", precision)) throw new Error("Precision is not a Number");
		super(sample);
		this.inverse = inverse;
		this.precision = precision;
	}
	asymmetricMatch(other) {
		if (!isA("Number", other)) return false;
		let result = false;
		if (other === Number.POSITIVE_INFINITY && this.sample === Number.POSITIVE_INFINITY) result = true;
		else if (other === Number.NEGATIVE_INFINITY && this.sample === Number.NEGATIVE_INFINITY) result = true;
		else result = Math.abs(this.sample - other) < 10 ** -this.precision / 2;
		return this.inverse ? !result : result;
	}
	toString() {
		return `Number${this.inverse ? "Not" : ""}CloseTo`;
	}
	getExpectedType() {
		return "number";
	}
	toAsymmetricMatcher() {
		return [
			this.toString(),
			this.sample,
			`(${pluralize("digit", this.precision)})`
		].join(" ");
	}
};
var SchemaMatching = class extends AsymmetricMatcher$1 {
	result;
	constructor(sample, inverse = false) {
		if (!isStandardSchema(sample)) throw new TypeError("SchemaMatching expected to receive a Standard Schema.");
		super(sample, inverse);
	}
	asymmetricMatch(other) {
		const result = this.sample["~standard"].validate(other);
		if (result instanceof Promise) throw new TypeError("Async schema validation is not supported in asymmetric matchers.");
		this.result = result;
		const pass = !this.result.issues || this.result.issues.length === 0;
		return this.inverse ? !pass : pass;
	}
	toString() {
		return `Schema${this.inverse ? "Not" : ""}Matching`;
	}
	getExpectedType() {
		return "object";
	}
	toAsymmetricMatcher() {
		const { utils } = this.getMatcherContext();
		if ((this.result?.issues || []).length > 0) return `${this.toString()} ${utils.stringify(this.result, void 0, { printBasicPrototype: false })}`;
		return this.toString();
	}
};
const JestAsymmetricMatchers = (chai, utils) => {
	utils.addMethod(chai.expect, "anything", () => new Anything());
	utils.addMethod(chai.expect, "any", (expected) => new Any(expected));
	utils.addMethod(chai.expect, "stringContaining", (expected) => new StringContaining(expected));
	utils.addMethod(chai.expect, "objectContaining", (expected) => new ObjectContaining(expected));
	utils.addMethod(chai.expect, "arrayContaining", (expected) => new ArrayContaining(expected));
	utils.addMethod(chai.expect, "stringMatching", (expected) => new StringMatching(expected));
	utils.addMethod(chai.expect, "closeTo", (expected, precision) => new CloseTo(expected, precision));
	utils.addMethod(chai.expect, "schemaMatching", (expected) => new SchemaMatching(expected));
	chai.expect.not = {
		stringContaining: (expected) => new StringContaining(expected, true),
		objectContaining: (expected) => new ObjectContaining(expected, true),
		arrayContaining: (expected) => new ArrayContaining(expected, true),
		stringMatching: (expected) => new StringMatching(expected, true),
		closeTo: (expected, precision) => new CloseTo(expected, precision, true),
		schemaMatching: (expected) => new SchemaMatching(expected, true)
	};
};
function createAssertionMessage(util, assertion, hasArgs) {
	const soft = util.flag(assertion, "soft") ? ".soft" : "";
	const not = util.flag(assertion, "negate") ? "not." : "";
	const name = `${util.flag(assertion, "_name")}(${hasArgs ? "expected" : ""})`;
	const promiseName = util.flag(assertion, "promise");
	return `expect${soft}(actual)${promiseName ? `.${promiseName}` : ""}.${not}${name}`;
}
function recordAsyncExpect(_test, promise, assertion, error, isSoft) {
	const test = _test;
	if (test && promise instanceof Promise) {
		promise = promise.finally(() => {
			if (!test.promises) return;
			const index = test.promises.indexOf(promise);
			if (index !== -1) test.promises.splice(index, 1);
		});
		if (!test.promises) test.promises = [];
		if (isSoft) promise = promise.then(noop, (err) => {
			handleTestError(test, err);
		});
		test.promises.push(promise);
		let resolved = false;
		test.onFinished ??= [];
		test.onFinished.push(() => {
			if (!resolved) {
				const stack = (globalThis.__vitest_worker__?.onFilterStackTrace || ((s) => s || ""))(error.stack);
				console.warn([
					`Promise returned by \`${assertion}\` was not awaited. `,
					"Vitest currently auto-awaits hanging assertions at the end of the test, but this will cause the test to fail in the next Vitest major. ",
					"Please remember to await the assertion.\n",
					stack
				].join(""));
			}
		});
		return {
			then(onFulfilled, onRejected) {
				resolved = true;
				return promise.then(onFulfilled, onRejected);
			},
			catch(onRejected) {
				resolved = true;
				return promise.catch(onRejected);
			},
			finally(onFinally) {
				resolved = true;
				return promise.finally(onFinally);
			},
			[Symbol.toStringTag]: "Promise"
		};
	}
	return promise;
}
function handleTestError(test, err) {
	test.result ||= { state: "fail" };
	test.result.state = "fail";
	test.result.errors ||= [];
	test.result.errors.push(processError(err));
}
/** wrap assertion function to support `expect.soft` and provide assertion name as `_name` */
function wrapAssertion(utils, name, fn) {
	return function(...args) {
		if (name !== "withTest") utils.flag(this, "_name", name);
		if (!utils.flag(this, "soft")) try {
			return fn.apply(this, args);
		} finally {}
		const test = utils.flag(this, "vitest-test");
		if (!test) throw new Error("expect.soft() can only be used inside a test");
		try {
			const result = fn.apply(this, args);
			if (result && typeof result === "object" && typeof result.then === "function") return result.then(noop, (err) => {
				handleTestError(test, err);
			});
			return result;
		} catch (err) {
			handleTestError(test, err);
		}
	};
}
const JestChaiExpect = (chai, utils) => {
	const { AssertionError } = chai;
	const customTesters = getCustomEqualityTesters();
	function def(name, fn) {
		const addMethod = (n) => {
			const softWrapper = wrapAssertion(utils, n, fn);
			utils.addMethod(chai.Assertion.prototype, n, softWrapper);
			utils.addMethod(globalThis[JEST_MATCHERS_OBJECT].matchers, n, softWrapper);
		};
		if (Array.isArray(name)) name.forEach((n) => addMethod(n));
		else addMethod(name);
	}
	[
		"throw",
		"throws",
		"Throw"
	].forEach((m) => {
		utils.overwriteMethod(chai.Assertion.prototype, m, (_super) => {
			return function(...args) {
				const promise = utils.flag(this, "promise");
				const object = utils.flag(this, "object");
				const isNot = utils.flag(this, "negate");
				if (promise === "rejects") utils.flag(this, "object", () => {
					throw object;
				});
				else if (promise === "resolves" && typeof object !== "function") if (!isNot) throw new AssertionError(utils.flag(this, "message") || "expected promise to throw an error, but it didn't", { showDiff: false }, utils.flag(this, "ssfi"));
				else return;
				_super.apply(this, args);
			};
		});
	});
	def("withTest", function(test) {
		utils.flag(this, "vitest-test", test);
		return this;
	});
	def("toEqual", function(expected) {
		const actual = utils.flag(this, "object");
		const equal = equals(actual, expected, [...customTesters, iterableEquality]);
		return this.assert(equal, "expected #{this} to deeply equal #{exp}", "expected #{this} to not deeply equal #{exp}", expected, actual);
	});
	def("toStrictEqual", function(expected) {
		const obj = utils.flag(this, "object");
		const equal = equals(obj, expected, [
			...customTesters,
			iterableEquality,
			typeEquality,
			sparseArrayEquality,
			arrayBufferEquality
		], true);
		return this.assert(equal, "expected #{this} to strictly equal #{exp}", "expected #{this} to not strictly equal #{exp}", expected, obj);
	});
	def("toBe", function(expected) {
		const actual = this._obj;
		const pass = Object.is(actual, expected);
		let deepEqualityName = "";
		if (!pass) {
			if (equals(actual, expected, [
				...customTesters,
				iterableEquality,
				typeEquality,
				sparseArrayEquality,
				arrayBufferEquality
			], true)) deepEqualityName = "toStrictEqual";
			else if (equals(actual, expected, [...customTesters, iterableEquality])) deepEqualityName = "toEqual";
		}
		return this.assert(pass, generateToBeMessage(deepEqualityName), "expected #{this} not to be #{exp} // Object.is equality", expected, actual);
	});
	def("toMatchObject", function(expected) {
		const actual = this._obj;
		const pass = equals(actual, expected, [
			...customTesters,
			iterableEquality,
			subsetEquality
		]);
		const isNot = utils.flag(this, "negate");
		const { subset: actualSubset, stripped } = getObjectSubset(actual, expected, customTesters);
		if (pass && isNot || !pass && !isNot) {
			const msg = utils.getMessage(this, [
				pass,
				"expected #{this} to match object #{exp}",
				"expected #{this} to not match object #{exp}",
				expected,
				actualSubset,
				false
			]);
			throw new AssertionError(stripped === 0 ? msg : `${msg}\n(${stripped} matching ${stripped === 1 ? "property" : "properties"} omitted from actual)`, {
				showDiff: true,
				expected,
				actual: actualSubset
			});
		}
	});
	def("toMatch", function(expected) {
		const actual = this._obj;
		if (typeof actual !== "string") throw new TypeError(`.toMatch() expects to receive a string, but got ${typeof actual}`);
		return this.assert(typeof expected === "string" ? actual.includes(expected) : actual.match(expected), `expected #{this} to match #{exp}`, `expected #{this} not to match #{exp}`, expected, actual);
	});
	def("toContain", function(item) {
		const actual = this._obj;
		if (typeof Node !== "undefined" && actual instanceof Node) {
			if (!(item instanceof Node)) throw new TypeError(`toContain() expected a DOM node as the argument, but got ${typeof item}`);
			return this.assert(actual.contains(item), "expected #{this} to contain element #{exp}", "expected #{this} not to contain element #{exp}", item, actual);
		}
		if (typeof DOMTokenList !== "undefined" && actual instanceof DOMTokenList) {
			assertTypes(item, "class name", ["string"]);
			const expectedClassList = utils.flag(this, "negate") ? actual.value.replace(item, "").trim() : `${actual.value} ${item}`;
			return this.assert(actual.contains(item), `expected "${actual.value}" to contain "${item}"`, `expected "${actual.value}" not to contain "${item}"`, expectedClassList, actual.value);
		}
		if (typeof actual === "string" && typeof item === "string") return this.assert(actual.includes(item), `expected #{this} to contain #{exp}`, `expected #{this} not to contain #{exp}`, item, actual);
		if (actual != null && typeof actual !== "string") utils.flag(this, "object", Array.from(actual));
		return this.contain(item);
	});
	def("toContainEqual", function(expected) {
		const obj = utils.flag(this, "object");
		const index = Array.from(obj).findIndex((item) => {
			return equals(item, expected, customTesters);
		});
		this.assert(index !== -1, "expected #{this} to deep equally contain #{exp}", "expected #{this} to not deep equally contain #{exp}", expected);
	});
	def("toBeTruthy", function() {
		const obj = utils.flag(this, "object");
		this.assert(Boolean(obj), "expected #{this} to be truthy", "expected #{this} to not be truthy", true, obj);
	});
	def("toBeFalsy", function() {
		const obj = utils.flag(this, "object");
		this.assert(!obj, "expected #{this} to be falsy", "expected #{this} to not be falsy", false, obj);
	});
	def("toBeGreaterThan", function(expected) {
		const actual = this._obj;
		assertTypes(actual, "actual", ["number", "bigint"]);
		assertTypes(expected, "expected", ["number", "bigint"]);
		return this.assert(actual > expected, `expected ${actual} to be greater than ${expected}`, `expected ${actual} to be not greater than ${expected}`, expected, actual, false);
	});
	def("toBeGreaterThanOrEqual", function(expected) {
		const actual = this._obj;
		assertTypes(actual, "actual", ["number", "bigint"]);
		assertTypes(expected, "expected", ["number", "bigint"]);
		return this.assert(actual >= expected, `expected ${actual} to be greater than or equal to ${expected}`, `expected ${actual} to be not greater than or equal to ${expected}`, expected, actual, false);
	});
	def("toBeLessThan", function(expected) {
		const actual = this._obj;
		assertTypes(actual, "actual", ["number", "bigint"]);
		assertTypes(expected, "expected", ["number", "bigint"]);
		return this.assert(actual < expected, `expected ${actual} to be less than ${expected}`, `expected ${actual} to be not less than ${expected}`, expected, actual, false);
	});
	def("toBeLessThanOrEqual", function(expected) {
		const actual = this._obj;
		assertTypes(actual, "actual", ["number", "bigint"]);
		assertTypes(expected, "expected", ["number", "bigint"]);
		return this.assert(actual <= expected, `expected ${actual} to be less than or equal to ${expected}`, `expected ${actual} to be not less than or equal to ${expected}`, expected, actual, false);
	});
	def("toBeNaN", function() {
		const obj = utils.flag(this, "object");
		this.assert(Number.isNaN(obj), "expected #{this} to be NaN", "expected #{this} not to be NaN", NaN, obj);
	});
	def("toBeUndefined", function() {
		const obj = utils.flag(this, "object");
		this.assert(void 0 === obj, "expected #{this} to be undefined", "expected #{this} not to be undefined", void 0, obj);
	});
	def("toBeNull", function() {
		const obj = utils.flag(this, "object");
		this.assert(obj === null, "expected #{this} to be null", "expected #{this} not to be null", null, obj);
	});
	def("toBeNullable", function() {
		const obj = utils.flag(this, "object");
		this.assert(obj == null, "expected #{this} to be nullish", "expected #{this} not to be nullish", null, obj);
	});
	def("toBeDefined", function() {
		const obj = utils.flag(this, "object");
		this.assert(typeof obj !== "undefined", "expected #{this} to be defined", "expected #{this} to be undefined", obj);
	});
	def("toBeTypeOf", function(expected) {
		const actual = typeof this._obj;
		const equal = expected === actual;
		return this.assert(equal, "expected #{this} to be type of #{exp}", "expected #{this} not to be type of #{exp}", expected, actual);
	});
	def("toBeInstanceOf", function(obj) {
		return this.instanceOf(obj);
	});
	def("toHaveLength", function(length) {
		return this.have.length(length);
	});
	def("toHaveProperty", function(...args) {
		if (Array.isArray(args[0])) args[0] = args[0].map((key) => String(key).replace(/([.[\]])/g, "\\$1")).join(".");
		const actual = this._obj;
		const [propertyName, expected] = args;
		const getValue = () => {
			if (Object.hasOwn(actual, propertyName)) return {
				value: actual[propertyName],
				exists: true
			};
			return utils.getPathInfo(actual, propertyName);
		};
		const { value, exists } = getValue();
		const pass = exists && (args.length === 1 || equals(expected, value, customTesters));
		const valueString = args.length === 1 ? "" : ` with value ${utils.objDisplay(expected)}`;
		return this.assert(pass, `expected #{this} to have property "${propertyName}"${valueString}`, `expected #{this} to not have property "${propertyName}"${valueString}`, expected, exists ? value : void 0);
	});
	def("toBeCloseTo", function(received, precision = 2) {
		const expected = this._obj;
		let pass = false;
		let expectedDiff = 0;
		let receivedDiff = 0;
		if (received === Number.POSITIVE_INFINITY && expected === Number.POSITIVE_INFINITY) pass = true;
		else if (received === Number.NEGATIVE_INFINITY && expected === Number.NEGATIVE_INFINITY) pass = true;
		else {
			expectedDiff = 10 ** -precision / 2;
			receivedDiff = Math.abs(expected - received);
			pass = receivedDiff < expectedDiff;
		}
		return this.assert(pass, `expected #{this} to be close to #{exp}, received difference is ${receivedDiff}, but expected ${expectedDiff}`, `expected #{this} to not be close to #{exp}, received difference is ${receivedDiff}, but expected ${expectedDiff}`, received, expected, false);
	});
	function assertIsMock(assertion) {
		if (!isMockFunction(assertion._obj)) throw new TypeError(`${utils.inspect(assertion._obj)} is not a spy or a call to a spy!`);
	}
	function getSpy(assertion) {
		assertIsMock(assertion);
		return assertion._obj;
	}
	def(["toHaveBeenCalledTimes", "toBeCalledTimes"], function(number) {
		const spy = getSpy(this);
		const spyName = spy.getMockName();
		const callCount = spy.mock.calls.length;
		return this.assert(callCount === number, `expected "${spyName}" to be called #{exp} times, but got ${callCount} times`, `expected "${spyName}" to not be called #{exp} times`, number, callCount, false);
	});
	def("toHaveBeenCalledOnce", function() {
		const spy = getSpy(this);
		const spyName = spy.getMockName();
		const callCount = spy.mock.calls.length;
		return this.assert(callCount === 1, `expected "${spyName}" to be called once, but got ${callCount} times`, `expected "${spyName}" to not be called once`, 1, callCount, false);
	});
	def(["toHaveBeenCalled", "toBeCalled"], function() {
		const spy = getSpy(this);
		const spyName = spy.getMockName();
		const callCount = spy.mock.calls.length;
		const called = callCount > 0;
		const isNot = utils.flag(this, "negate");
		let msg = utils.getMessage(this, [
			called,
			`expected "${spyName}" to be called at least once`,
			`expected "${spyName}" to not be called at all, but actually been called ${callCount} times`,
			true,
			called
		]);
		if (called && isNot) msg = formatCalls(spy, msg);
		if (called && isNot || !called && !isNot) throw new AssertionError(msg);
	});
	function equalsArgumentArray(a, b) {
		return a.length === b.length && a.every((aItem, i) => equals(aItem, b[i], [...customTesters, iterableEquality]));
	}
	def(["toHaveBeenCalledWith", "toBeCalledWith"], function(...args) {
		const spy = getSpy(this);
		const spyName = spy.getMockName();
		const pass = spy.mock.calls.some((callArg) => equalsArgumentArray(callArg, args));
		const isNot = utils.flag(this, "negate");
		const msg = utils.getMessage(this, [
			pass,
			`expected "${spyName}" to be called with arguments: #{exp}`,
			`expected "${spyName}" to not be called with arguments: #{exp}`,
			args
		]);
		if (pass && isNot || !pass && !isNot) throw new AssertionError(formatCalls(spy, msg, args));
	});
	def("toHaveBeenCalledExactlyOnceWith", function(...args) {
		const spy = getSpy(this);
		const spyName = spy.getMockName();
		const callCount = spy.mock.calls.length;
		const pass = spy.mock.calls.some((callArg) => equalsArgumentArray(callArg, args)) && callCount === 1;
		const isNot = utils.flag(this, "negate");
		const msg = utils.getMessage(this, [
			pass,
			`expected "${spyName}" to be called once with arguments: #{exp}`,
			`expected "${spyName}" to not be called once with arguments: #{exp}`,
			args
		]);
		if (pass && isNot || !pass && !isNot) throw new AssertionError(formatCalls(spy, msg, args));
	});
	def("toHaveBeenNthCalledWith", function(times, ...args) {
		const spy = getSpy(this);
		const spyName = spy.getMockName();
		const nthCall = spy.mock.calls[times - 1];
		const callCount = spy.mock.calls.length;
		const isCalled = times <= callCount;
		this.assert(nthCall && equalsArgumentArray(nthCall, args), `expected ${ordinal(times)} "${spyName}" call to have been called with #{exp}${isCalled ? `` : `, but called only ${callCount} times`}`, `expected ${ordinal(times)} "${spyName}" call to not have been called with #{exp}`, args, nthCall, isCalled);
	});
	def("toHaveBeenLastCalledWith", function(...args) {
		const spy = getSpy(this);
		const spyName = spy.getMockName();
		const lastCall = spy.mock.calls.at(-1);
		this.assert(lastCall && equalsArgumentArray(lastCall, args), `expected last "${spyName}" call to have been called with #{exp}`, `expected last "${spyName}" call to not have been called with #{exp}`, args, lastCall);
	});
	/**
	* Used for `toHaveBeenCalledBefore` and `toHaveBeenCalledAfter` to determine if the expected spy was called before the result spy.
	*/
	function isSpyCalledBeforeAnotherSpy(beforeSpy, afterSpy, failIfNoFirstInvocation) {
		const beforeInvocationCallOrder = beforeSpy.mock.invocationCallOrder;
		const afterInvocationCallOrder = afterSpy.mock.invocationCallOrder;
		if (beforeInvocationCallOrder.length === 0) return !failIfNoFirstInvocation;
		if (afterInvocationCallOrder.length === 0) return false;
		return beforeInvocationCallOrder[0] < afterInvocationCallOrder[0];
	}
	def(["toHaveBeenCalledBefore"], function(resultSpy, failIfNoFirstInvocation = true) {
		const expectSpy = getSpy(this);
		if (!isMockFunction(resultSpy)) throw new TypeError(`${utils.inspect(resultSpy)} is not a spy or a call to a spy`);
		this.assert(isSpyCalledBeforeAnotherSpy(expectSpy, resultSpy, failIfNoFirstInvocation), `expected "${expectSpy.getMockName()}" to have been called before "${resultSpy.getMockName()}"`, `expected "${expectSpy.getMockName()}" to not have been called before "${resultSpy.getMockName()}"`, resultSpy, expectSpy);
	});
	def(["toHaveBeenCalledAfter"], function(resultSpy, failIfNoFirstInvocation = true) {
		const expectSpy = getSpy(this);
		if (!isMockFunction(resultSpy)) throw new TypeError(`${utils.inspect(resultSpy)} is not a spy or a call to a spy`);
		this.assert(isSpyCalledBeforeAnotherSpy(resultSpy, expectSpy, failIfNoFirstInvocation), `expected "${expectSpy.getMockName()}" to have been called after "${resultSpy.getMockName()}"`, `expected "${expectSpy.getMockName()}" to not have been called after "${resultSpy.getMockName()}"`, resultSpy, expectSpy);
	});
	def(["toThrow", "toThrowError"], function(expected) {
		if (typeof expected === "string" || typeof expected === "undefined" || expected instanceof RegExp) return this.throws(expected === "" ? /^$/ : expected);
		const obj = this._obj;
		const promise = utils.flag(this, "promise");
		const isNot = utils.flag(this, "negate");
		let thrown = null;
		if (promise === "rejects") thrown = obj;
		else if (promise === "resolves" && typeof obj !== "function") if (!isNot) throw new AssertionError(utils.flag(this, "message") || "expected promise to throw an error, but it didn't", { showDiff: false }, utils.flag(this, "ssfi"));
		else return;
		else {
			let isThrow = false;
			try {
				obj();
			} catch (err) {
				isThrow = true;
				thrown = err;
			}
			if (!isThrow && !isNot) throw new AssertionError(utils.flag(this, "message") || "expected function to throw an error, but it didn't", { showDiff: false }, utils.flag(this, "ssfi"));
		}
		if (typeof expected === "function") {
			const name = expected.name || expected.prototype.constructor.name;
			return this.assert(thrown && thrown instanceof expected, `expected error to be instance of ${name}`, `expected error not to be instance of ${name}`, expected, thrown);
		}
		if (isError(expected)) {
			const equal = equals(thrown, expected, [...customTesters, iterableEquality]);
			return this.assert(equal, "expected a thrown error to be #{exp}", "expected a thrown error not to be #{exp}", expected, thrown);
		}
		if (typeof expected === "object" && "asymmetricMatch" in expected && typeof expected.asymmetricMatch === "function") {
			const matcher = expected;
			return this.assert(thrown && matcher.asymmetricMatch(thrown), "expected error to match asymmetric matcher", "expected error not to match asymmetric matcher", matcher, thrown);
		}
		const equal = equals(thrown, expected, [...customTesters, iterableEquality]);
		return this.assert(equal, "expected a thrown value to equal #{exp}", "expected a thrown value not to equal #{exp}", expected, thrown);
	});
	[{
		name: "toHaveResolved",
		condition: (spy) => spy.mock.settledResults.length > 0 && spy.mock.settledResults.some(({ type }) => type === "fulfilled"),
		action: "resolved"
	}, {
		name: ["toHaveReturned", "toReturn"],
		condition: (spy) => spy.mock.calls.length > 0 && spy.mock.results.some(({ type }) => type !== "throw"),
		action: "called"
	}].forEach(({ name, condition, action }) => {
		def(name, function() {
			const spy = getSpy(this);
			const spyName = spy.getMockName();
			const pass = condition(spy);
			this.assert(pass, `expected "${spyName}" to be successfully ${action} at least once`, `expected "${spyName}" to not be successfully ${action}`, pass, !pass, false);
		});
	});
	[{
		name: "toHaveResolvedTimes",
		condition: (spy, times) => spy.mock.settledResults.reduce((s, { type }) => type === "fulfilled" ? ++s : s, 0) === times,
		action: "resolved"
	}, {
		name: ["toHaveReturnedTimes", "toReturnTimes"],
		condition: (spy, times) => spy.mock.results.reduce((s, { type }) => type === "throw" ? s : ++s, 0) === times,
		action: "called"
	}].forEach(({ name, condition, action }) => {
		def(name, function(times) {
			const spy = getSpy(this);
			const spyName = spy.getMockName();
			const pass = condition(spy, times);
			this.assert(pass, `expected "${spyName}" to be successfully ${action} ${times} times`, `expected "${spyName}" to not be successfully ${action} ${times} times`, `expected resolved times: ${times}`, `received resolved times: ${pass}`, false);
		});
	});
	[{
		name: "toHaveResolvedWith",
		condition: (spy, value) => spy.mock.settledResults.some(({ type, value: result }) => type === "fulfilled" && equals(value, result)),
		action: "resolve"
	}, {
		name: ["toHaveReturnedWith", "toReturnWith"],
		condition: (spy, value) => spy.mock.results.some(({ type, value: result }) => type === "return" && equals(value, result)),
		action: "return"
	}].forEach(({ name, condition, action }) => {
		def(name, function(value) {
			const spy = getSpy(this);
			const pass = condition(spy, value);
			const isNot = utils.flag(this, "negate");
			if (pass && isNot || !pass && !isNot) {
				const spyName = spy.getMockName();
				const msg = utils.getMessage(this, [
					pass,
					`expected "${spyName}" to ${action} with: #{exp} at least once`,
					`expected "${spyName}" to not ${action} with: #{exp}`,
					value
				]);
				throw new AssertionError(formatReturns(spy, action === "return" ? spy.mock.results : spy.mock.settledResults, msg, value));
			}
		});
	});
	[{
		name: "toHaveLastResolvedWith",
		condition: (spy, value) => {
			const result = spy.mock.settledResults.at(-1);
			return Boolean(result && result.type === "fulfilled" && equals(result.value, value));
		},
		action: "resolve"
	}, {
		name: "toHaveLastReturnedWith",
		condition: (spy, value) => {
			const result = spy.mock.results.at(-1);
			return Boolean(result && result.type === "return" && equals(result.value, value));
		},
		action: "return"
	}].forEach(({ name, condition, action }) => {
		def(name, function(value) {
			const spy = getSpy(this);
			const result = (action === "return" ? spy.mock.results : spy.mock.settledResults).at(-1);
			const spyName = spy.getMockName();
			this.assert(condition(spy, value), `expected last "${spyName}" call to ${action} #{exp}`, `expected last "${spyName}" call to not ${action} #{exp}`, value, result?.value);
		});
	});
	[{
		name: "toHaveNthResolvedWith",
		condition: (spy, index, value) => {
			const result = spy.mock.settledResults[index - 1];
			return result && result.type === "fulfilled" && equals(result.value, value);
		},
		action: "resolve"
	}, {
		name: "toHaveNthReturnedWith",
		condition: (spy, index, value) => {
			const result = spy.mock.results[index - 1];
			return result && result.type === "return" && equals(result.value, value);
		},
		action: "return"
	}].forEach(({ name, condition, action }) => {
		def(name, function(nthCall, value) {
			const spy = getSpy(this);
			const spyName = spy.getMockName();
			const result = (action === "return" ? spy.mock.results : spy.mock.settledResults)[nthCall - 1];
			const ordinalCall = `${ordinal(nthCall)} call`;
			this.assert(condition(spy, nthCall, value), `expected ${ordinalCall} "${spyName}" call to ${action} #{exp}`, `expected ${ordinalCall} "${spyName}" call to not ${action} #{exp}`, value, result?.value);
		});
	});
	def("withContext", function(context) {
		for (const key in context) utils.flag(this, key, context[key]);
		return this;
	});
	utils.addProperty(chai.Assertion.prototype, "resolves", function __VITEST_RESOLVES__() {
		const error = /* @__PURE__ */ new Error("resolves");
		utils.flag(this, "promise", "resolves");
		utils.flag(this, "error", error);
		const test = utils.flag(this, "vitest-test");
		const obj = utils.flag(this, "object");
		if (utils.flag(this, "poll")) throw new SyntaxError(`expect.poll() is not supported in combination with .resolves`);
		if (typeof obj?.then !== "function") throw new TypeError(`You must provide a Promise to expect() when using .resolves, not '${typeof obj}'.`);
		const proxy = new Proxy(this, { get: (target, key, receiver) => {
			const result = Reflect.get(target, key, receiver);
			if (typeof result !== "function") return result instanceof chai.Assertion ? proxy : result;
			return (...args) => {
				utils.flag(this, "_name", key);
				return recordAsyncExpect(test, Promise.resolve(obj).then((value) => {
					utils.flag(this, "object", value);
					return result.call(this, ...args);
				}, (err) => {
					const _error = new AssertionError(`promise rejected "${utils.inspect(err)}" instead of resolving`, { showDiff: false });
					_error.cause = err;
					throw _error;
				}).catch((err) => {
					if (isError(err) && error.stack) err.stack = error.stack.replace(error.message, err.message);
					throw err;
				}), createAssertionMessage(utils, this, !!args.length), error, utils.flag(this, "soft"));
			};
		} });
		return proxy;
	});
	utils.addProperty(chai.Assertion.prototype, "rejects", function __VITEST_REJECTS__() {
		const error = /* @__PURE__ */ new Error("rejects");
		utils.flag(this, "promise", "rejects");
		utils.flag(this, "error", error);
		const test = utils.flag(this, "vitest-test");
		const obj = utils.flag(this, "object");
		const wrapper = typeof obj === "function" ? obj() : obj;
		if (utils.flag(this, "poll")) throw new SyntaxError(`expect.poll() is not supported in combination with .rejects`);
		if (typeof wrapper?.then !== "function") throw new TypeError(`You must provide a Promise to expect() when using .rejects, not '${typeof wrapper}'.`);
		const proxy = new Proxy(this, { get: (target, key, receiver) => {
			const result = Reflect.get(target, key, receiver);
			if (typeof result !== "function") return result instanceof chai.Assertion ? proxy : result;
			return (...args) => {
				utils.flag(this, "_name", key);
				return recordAsyncExpect(test, Promise.resolve(wrapper).then((value) => {
					throw new AssertionError(`promise resolved "${utils.inspect(value)}" instead of rejecting`, {
						showDiff: true,
						expected: /* @__PURE__ */ new Error("rejected promise"),
						actual: value
					});
				}, (err) => {
					utils.flag(this, "object", err);
					return result.call(this, ...args);
				}).catch((err) => {
					if (isError(err) && error.stack) err.stack = error.stack.replace(error.message, err.message);
					throw err;
				}), createAssertionMessage(utils, this, !!args.length), error, utils.flag(this, "soft"));
			};
		} });
		return proxy;
	});
};
function formatCalls(spy, msg, showActualCall) {
	if (spy.mock.calls.length) msg += y.gray(`\n\nReceived:\n\n${spy.mock.calls.map((callArg, i) => {
		let methodCall = y.bold(`  ${ordinal(i + 1)} ${spy.getMockName()} call:\n\n`);
		if (showActualCall) methodCall += diff(showActualCall, callArg, { omitAnnotationLines: true });
		else methodCall += stringify(callArg).split("\n").map((line) => `    ${line}`).join("\n");
		methodCall += "\n";
		return methodCall;
	}).join("\n")}`);
	msg += y.gray(`\n\nNumber of calls: ${y.bold(spy.mock.calls.length)}\n`);
	return msg;
}
function formatReturns(spy, results, msg, showActualReturn) {
	if (results.length) msg += y.gray(`\n\nReceived:\n\n${results.map((callReturn, i) => {
		let methodCall = y.bold(`  ${ordinal(i + 1)} ${spy.getMockName()} call return:\n\n`);
		if (showActualReturn) methodCall += diff(showActualReturn, callReturn.value, { omitAnnotationLines: true });
		else methodCall += stringify(callReturn).split("\n").map((line) => `    ${line}`).join("\n");
		methodCall += "\n";
		return methodCall;
	}).join("\n")}`);
	msg += y.gray(`\n\nNumber of calls: ${y.bold(spy.mock.calls.length)}\n`);
	return msg;
}
function getMatcherState(assertion, expect) {
	const obj = assertion._obj;
	const isNot = utils_exports.flag(assertion, "negate");
	const promise = utils_exports.flag(assertion, "promise") || "";
	const customMessage = utils_exports.flag(assertion, "message");
	const jestUtils = {
		...getMatcherUtils(),
		diff,
		stringify,
		iterableEquality,
		subsetEquality
	};
	let task = utils_exports.flag(assertion, "vitest-test");
	const currentTestName = task?.fullTestName ?? "";
	if (task?.type !== "test") task = void 0;
	const matcherState = {
		...getState(expect),
		currentTestName,
		customTesters: getCustomEqualityTesters(),
		isNot,
		utils: jestUtils,
		promise,
		equals,
		suppressedErrors: [],
		soft: utils_exports.flag(assertion, "soft"),
		poll: utils_exports.flag(assertion, "poll"),
		assertion
	};
	Object.assign(matcherState, { task });
	return {
		state: matcherState,
		isNot,
		obj,
		customMessage
	};
}
var JestExtendError = class extends Error {
	constructor(message, actual, expected, __vitest_error_context__) {
		super(message);
		this.actual = actual;
		this.expected = expected;
		this.__vitest_error_context__ = __vitest_error_context__;
	}
};
function JestExtendPlugin(c, expect, matchers) {
	return (_, utils) => {
		Object.entries(matchers).forEach(([expectAssertionName, expectAssertion]) => {
			function __VITEST_EXTEND_ASSERTION__(...args) {
				const { state, isNot, obj, customMessage } = getMatcherState(this, expect);
				const result = expectAssertion.call(state, obj, ...args);
				if (result && typeof result === "object" && typeof result.then === "function") return result.then(({ pass, message, actual, expected, meta }) => {
					if (pass && isNot || !pass && !isNot) throw new JestExtendError((customMessage ? `${customMessage}: ` : "") + message(), actual, expected, {
						assertionName: expectAssertionName,
						meta
					});
				});
				const { pass, message, actual, expected, meta } = result;
				if (pass && isNot || !pass && !isNot) throw new JestExtendError((customMessage ? `${customMessage}: ` : "") + message(), actual, expected, {
					assertionName: expectAssertionName,
					meta
				});
			}
			const softWrapper = wrapAssertion(utils, expectAssertionName, __VITEST_EXTEND_ASSERTION__);
			utils.addMethod(globalThis[JEST_MATCHERS_OBJECT].matchers, expectAssertionName, softWrapper);
			utils.addMethod(c.Assertion.prototype, expectAssertionName, softWrapper);
			if (expectAssertion.__vitest_poll_takeover__) {
				const addedMethod = c.Assertion.prototype[expectAssertionName];
				Object.defineProperty(addedMethod, "__vitest_poll_takeover__", { value: true });
			}
			class CustomMatcher extends AsymmetricMatcher$1 {
				constructor(inverse = false, ...sample) {
					super(sample, inverse);
				}
				asymmetricMatch(other) {
					const { pass } = expectAssertion.call(this.getMatcherContext(expect), other, ...this.sample);
					return this.inverse ? !pass : pass;
				}
				toString() {
					return `${this.inverse ? "not." : ""}${expectAssertionName}`;
				}
				getExpectedType() {
					return "any";
				}
				toAsymmetricMatcher() {
					return `${this.toString()}<${this.sample.map((item) => stringify(item)).join(", ")}>`;
				}
			}
			const customMatcher = (...sample) => new CustomMatcher(false, ...sample);
			Object.defineProperty(expect, expectAssertionName, {
				configurable: true,
				enumerable: true,
				value: customMatcher,
				writable: true
			});
			Object.defineProperty(expect.not, expectAssertionName, {
				configurable: true,
				enumerable: true,
				value: (...sample) => new CustomMatcher(true, ...sample),
				writable: true
			});
			Object.defineProperty(globalThis[ASYMMETRIC_MATCHERS_OBJECT], expectAssertionName, {
				configurable: true,
				enumerable: true,
				value: customMatcher,
				writable: true
			});
		});
	};
}
const JestExtend = (chai, utils) => {
	utils.addMethod(chai.expect, "extend", (expect, expects) => {
		use(JestExtendPlugin(chai, expect, expects));
	});
};
//#endregion
//#region node_modules/@vitest/utils/dist/offset.js
const lineSplitRE = /\r?\n/;
function positionToOffset(source, lineNumber, columnNumber) {
	const lines = source.split(lineSplitRE);
	const nl = /\r\n/.test(source) ? 2 : 1;
	let start = 0;
	if (lineNumber > lines.length) return source.length;
	for (let i = 0; i < lineNumber - 1; i++) start += lines[i].length + nl;
	return start + columnNumber;
}
function offsetToLineNumber(source, offset) {
	if (offset > source.length) throw new Error(`offset is longer than source length! offset ${offset} > length ${source.length}`);
	const lines = source.split(lineSplitRE);
	const nl = /\r\n/.test(source) ? 2 : 1;
	let counted = 0;
	let line = 0;
	for (; line < lines.length; line++) {
		const lineLength = lines[line].length + nl;
		if (counted + lineLength >= offset) break;
		counted += lineLength;
	}
	return line + 1;
}
//#endregion
//#region node_modules/vitest/dist/chunks/_commonjsHelpers.D26ty3Ew.js
var commonjsGlobal = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : {};
//#endregion
//#region node_modules/vitest/dist/chunks/rpc.MzXet3jl.js
const RealDate = Date;
let now = null;
var MockDate = class MockDate extends RealDate {
	constructor(y, m, d, h, M, s, ms) {
		super();
		let date;
		switch (arguments.length) {
			case 0:
				if (now !== null) date = new RealDate(now.valueOf());
				else date = new RealDate();
				break;
			case 1:
				date = new RealDate(y);
				break;
			default:
				d = typeof d === "undefined" ? 1 : d;
				h = h || 0;
				M = M || 0;
				s = s || 0;
				ms = ms || 0;
				date = new RealDate(y, m, d, h, M, s, ms);
				break;
		}
		Object.setPrototypeOf(date, MockDate.prototype);
		return date;
	}
};
MockDate.UTC = RealDate.UTC;
MockDate.now = function() {
	return new MockDate().valueOf();
};
MockDate.parse = function(dateString) {
	return RealDate.parse(dateString);
};
MockDate.toString = function() {
	return RealDate.toString();
};
function mockDate(date) {
	const dateObj = new RealDate(date.valueOf());
	if (Number.isNaN(dateObj.getTime())) throw new TypeError(`mockdate: The time set is an invalid date: ${date}`);
	globalThis.Date = MockDate;
	now = dateObj.valueOf();
}
function resetDate() {
	globalThis.Date = RealDate;
}
const { get } = Reflect;
//#endregion
//#region node_modules/@vitest/snapshot/dist/index.js
function getDefaultExportFromCjs(x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
var naturalCompare$1 = { exports: {} };
var hasRequiredNaturalCompare;
function requireNaturalCompare() {
	if (hasRequiredNaturalCompare) return naturalCompare$1.exports;
	hasRequiredNaturalCompare = 1;
	/*
	* @version    1.4.0
	* @date       2015-10-26
	* @stability  3 - Stable
	* @author     Lauri Rooden (https://github.com/litejs/natural-compare-lite)
	* @license    MIT License
	*/
	var naturalCompare = function(a, b) {
		var i, codeA, codeB = 1, posA = 0, posB = 0, alphabet = String.alphabet;
		function getCode(str, pos, code) {
			if (code) {
				for (i = pos; code = getCode(str, i), code < 76 && code > 65;) ++i;
				return +str.slice(pos - 1, i);
			}
			code = alphabet && alphabet.indexOf(str.charAt(pos));
			return code > -1 ? code + 76 : (code = str.charCodeAt(pos) || 0, code < 45 || code > 127) ? code : code < 46 ? 65 : code < 48 ? code - 1 : code < 58 ? code + 18 : code < 65 ? code - 11 : code < 91 ? code + 11 : code < 97 ? code - 37 : code < 123 ? code + 5 : code - 63;
		}
		if ((a += "") != (b += "")) for (; codeB;) {
			codeA = getCode(a, posA++);
			codeB = getCode(b, posB++);
			if (codeA < 76 && codeB < 76 && codeA > 66 && codeB > 66) {
				codeA = getCode(a, posA, posA);
				codeB = getCode(b, posB, posA = i);
				posB = i;
			}
			if (codeA != codeB) return codeA < codeB ? -1 : 1;
		}
		return 0;
	};
	try {
		naturalCompare$1.exports = naturalCompare;
	} catch (e) {
		String.naturalCompare = naturalCompare;
	}
	return naturalCompare$1.exports;
}
var naturalCompare = /* @__PURE__ */ getDefaultExportFromCjs(requireNaturalCompare());
const serialize$1 = (val, config, indentation, depth, refs, printer) => {
	const name = val.getMockName();
	const nameString = name === "vi.fn()" ? "" : ` ${name}`;
	let callsString = "";
	if (val.mock.calls.length !== 0) {
		const indentationNext = indentation + config.indent;
		callsString = ` {${config.spacingOuter}${indentationNext}"calls": ${printer(val.mock.calls, config, indentationNext, depth, refs)}${config.min ? ", " : ","}${config.spacingOuter}${indentationNext}"results": ${printer(val.mock.results, config, indentationNext, depth, refs)}${config.min ? "" : ","}${config.spacingOuter}${indentation}}`;
	}
	return `[MockFunction${nameString}]${callsString}`;
};
const test = (val) => val && !!val._isMockFunction;
const plugin = {
	serialize: serialize$1,
	test
};
const { DOMCollection, DOMElement, Immutable, ReactElement, ReactTestComponent, AsymmetricMatcher } = plugins;
let PLUGINS = [
	ReactTestComponent,
	ReactElement,
	DOMElement,
	DOMCollection,
	Immutable,
	AsymmetricMatcher,
	plugin
];
function addSerializer(plugin) {
	PLUGINS = [plugin].concat(PLUGINS);
}
function getSerializers() {
	return PLUGINS;
}
function testNameToKey(testName, count) {
	return `${testName} ${count}`;
}
function keyToTestName(key) {
	if (!/ \d+$/.test(key)) throw new Error("Snapshot keys must end with a number.");
	return key.replace(/ \d+$/, "");
}
function getSnapshotData(content, options) {
	const update = options.updateSnapshot;
	const data = Object.create(null);
	let snapshotContents = "";
	let dirty = false;
	if (content != null) try {
		snapshotContents = content;
		new Function("exports", snapshotContents)(data);
	} catch {}
	if ((update === "all" || update === "new") && snapshotContents) dirty = true;
	return {
		data,
		dirty
	};
}
function addExtraLineBreaks(string) {
	return string.includes("\n") ? `\n${string}\n` : string;
}
function removeExtraLineBreaks(string) {
	return string.length > 2 && string[0] === "\n" && string.endsWith("\n") ? string.slice(1, -1) : string;
}
const escapeRegex = true;
const printFunctionName = false;
function serialize(val, indent = 2, formatOverrides = {}) {
	return normalizeNewlines(format(val, {
		escapeRegex,
		indent,
		plugins: getSerializers(),
		printFunctionName,
		...formatOverrides
	}));
}
function escapeBacktickString(str) {
	return str.replace(/`|\\|\$\{/g, "\\$&");
}
function printBacktickString(str) {
	return `\`${escapeBacktickString(str)}\``;
}
function normalizeNewlines(string) {
	return string.replace(/\r\n|\r/g, "\n");
}
async function saveSnapshotFile(environment, snapshotData, snapshotPath) {
	const snapshots = Object.keys(snapshotData).sort(naturalCompare).map((key) => `exports[${printBacktickString(key)}] = ${printBacktickString(normalizeNewlines(snapshotData[key]))};`);
	const content = `${environment.getHeader()}\n\n${snapshots.join("\n\n")}\n`;
	const oldContent = await environment.readSnapshotFile(snapshotPath);
	if (oldContent != null && oldContent === content) return;
	await environment.saveSnapshotFile(snapshotPath, content);
}
function deepMergeArray(target = [], source = []) {
	const mergedOutput = Array.from(target);
	source.forEach((sourceElement, index) => {
		const targetElement = mergedOutput[index];
		if (Array.isArray(target[index])) mergedOutput[index] = deepMergeArray(target[index], sourceElement);
		else if (isObject(targetElement)) mergedOutput[index] = deepMergeSnapshot(target[index], sourceElement);
		else mergedOutput[index] = sourceElement;
	});
	return mergedOutput;
}
/**
* Deep merge, but considers asymmetric matchers. Unlike base util's deep merge,
* will merge any object-like instance.
* Compatible with Jest's snapshot matcher. Should not be used outside of snapshot.
*
* @example
* ```ts
* toMatchSnapshot({
*   name: expect.stringContaining('text')
* })
* ```
*/
function deepMergeSnapshot(target, source) {
	if (isObject(target) && isObject(source)) {
		const mergedOutput = { ...target };
		Object.keys(source).forEach((key) => {
			if (isObject(source[key]) && !source[key].$$typeof) if (!(key in target)) Object.assign(mergedOutput, { [key]: source[key] });
			else mergedOutput[key] = deepMergeSnapshot(target[key], source[key]);
			else if (Array.isArray(source[key])) mergedOutput[key] = deepMergeArray(target[key], source[key]);
			else Object.assign(mergedOutput, { [key]: source[key] });
		});
		return mergedOutput;
	} else if (Array.isArray(target) && Array.isArray(source)) return deepMergeArray(target, source);
	return target;
}
var DefaultMap = class extends Map {
	constructor(defaultFn, entries) {
		super(entries);
		this.defaultFn = defaultFn;
	}
	get(key) {
		if (!this.has(key)) this.set(key, this.defaultFn(key));
		return super.get(key);
	}
};
var CounterMap = class extends DefaultMap {
	constructor() {
		super(() => 0);
	}
	_total;
	valueOf() {
		return this._total = this.total();
	}
	increment(key) {
		if (typeof this._total !== "undefined") this._total++;
		this.set(key, this.get(key) + 1);
	}
	total() {
		if (typeof this._total !== "undefined") return this._total;
		let total = 0;
		for (const x of this.values()) total += x;
		return total;
	}
};
/* @__NO_SIDE_EFFECTS__ */
function memo(fn) {
	const cache = /* @__PURE__ */ new Map();
	return (arg) => {
		if (!cache.has(arg)) cache.set(arg, fn(arg));
		return cache.get(arg);
	};
}
async function saveInlineSnapshots(environment, snapshots) {
	const MagicString = (await import("./magic-string.es-Dz43pXo-.js")).default;
	const files = new Set(snapshots.map((i) => i.file));
	await Promise.all(Array.from(files).map(async (file) => {
		const snaps = snapshots.filter((i) => i.file === file);
		const code = await environment.readSnapshotFile(file);
		if (code == null) throw new Error(`cannot read ${file} when saving inline snapshot`);
		const s = new MagicString(code);
		for (const snap of snaps) replaceInlineSnap(code, s, positionToOffset(code, snap.line, snap.column), snap.snapshot, snap.assertionName);
		const transformed = s.toString();
		if (transformed !== code) await environment.saveSnapshotFile(file, transformed);
	}));
}
const defaultStartObjectRegex = /(?:toMatchInlineSnapshot|toThrowErrorMatchingInlineSnapshot)\s*\(\s*(?:\/\*[\s\S]*\*\/\s*|\/\/.*(?:[\n\r\u2028\u2029]\s*|[\t\v\f \xA0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]))*\{/;
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const buildStartObjectRegex = /* @__PURE__ */ memo((assertionName) => {
	const replaced = defaultStartObjectRegex.source.replace("toMatchInlineSnapshot|toThrowErrorMatchingInlineSnapshot", escapeRegExp(assertionName));
	return new RegExp(replaced);
});
function replaceObjectSnap(code, s, index, newSnap, assertionName) {
	let _code = code.slice(index);
	const startMatch = (assertionName ? buildStartObjectRegex(assertionName) : defaultStartObjectRegex).exec(_code);
	if (!startMatch) return false;
	_code = _code.slice(startMatch.index);
	let callEnd = getCallLastIndex(_code);
	if (callEnd === null) return false;
	callEnd += index + startMatch.index;
	const shapeEnd = getObjectShapeEndIndex(code, index + startMatch.index + startMatch[0].length);
	const snap = `, ${prepareSnapString(newSnap, code, index)}`;
	if (shapeEnd === callEnd) s.appendLeft(callEnd, snap);
	else s.overwrite(shapeEnd, callEnd, snap);
	return true;
}
function getObjectShapeEndIndex(code, index) {
	let startBraces = 1;
	let endBraces = 0;
	while (startBraces !== endBraces && index < code.length) {
		const s = code[index++];
		if (s === "{") startBraces++;
		else if (s === "}") endBraces++;
	}
	return index;
}
function prepareSnapString(snap, source, index) {
	const lineNumber = offsetToLineNumber(source, index);
	const indent = source.split(lineSplitRE)[lineNumber - 1].match(/^\s*/)[0] || "";
	const indentNext = indent.includes("	") ? `${indent}\t` : `${indent}  `;
	const lines = snap.trim().replace(/\\/g, "\\\\").split(/\n/g);
	const isOneline = lines.length <= 1;
	const quote = "`";
	if (isOneline) return `${quote}${lines.join("\n").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}${quote}`;
	return `${quote}\n${lines.map((i) => i ? indentNext + i : "").join("\n").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\n${indent}${quote}`;
}
const defaultMethodNames = ["toMatchInlineSnapshot", "toThrowErrorMatchingInlineSnapshot"];
function getCodeStartingAtIndex(code, index, methodNames) {
	for (const name of methodNames) {
		const adjusted = index - name.length;
		if (adjusted >= 0 && code.slice(adjusted, index) === name) return {
			code: code.slice(adjusted),
			index: adjusted
		};
	}
	return {
		code: code.slice(index),
		index
	};
}
const defaultStartRegex = /(?:toMatchInlineSnapshot|toThrowErrorMatchingInlineSnapshot)\s*\(\s*(?:\/\*[\s\S]*\*\/\s*|\/\/.*(?:[\n\r\u2028\u2029]\s*|[\t\v\f \xA0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]))*[\w$]*(['"`)])/;
const buildStartRegex = /* @__PURE__ */ memo((assertionName) => {
	const replaced = defaultStartRegex.source.replace("toMatchInlineSnapshot|toThrowErrorMatchingInlineSnapshot", escapeRegExp(assertionName));
	return new RegExp(replaced);
});
function replaceInlineSnap(code, s, currentIndex, newSnap, assertionName) {
	const { code: codeStartingAtIndex, index } = getCodeStartingAtIndex(code, currentIndex, assertionName ? [assertionName] : defaultMethodNames);
	const startMatch = (assertionName ? buildStartRegex(assertionName) : defaultStartRegex).exec(codeStartingAtIndex);
	const firstKeywordMatch = (assertionName ? new RegExp(escapeRegExp(assertionName)) : /toMatchInlineSnapshot|toThrowErrorMatchingInlineSnapshot/).exec(codeStartingAtIndex);
	if (!startMatch || startMatch.index !== firstKeywordMatch?.index) return replaceObjectSnap(code, s, index, newSnap, assertionName);
	const quote = startMatch[1];
	const startIndex = index + startMatch.index + startMatch[0].length;
	const snapString = prepareSnapString(newSnap, code, index);
	if (quote === ")") {
		s.appendRight(startIndex - 1, snapString);
		return true;
	}
	const endMatch = new RegExp(`(?:^|[^\\\\])${quote}`).exec(code.slice(startIndex));
	if (!endMatch) return false;
	const endIndex = startIndex + endMatch.index + endMatch[0].length;
	s.overwrite(startIndex - 1, endIndex, snapString);
	return true;
}
const INDENTATION_REGEX = /^([^\S\n]*)\S/m;
function stripSnapshotIndentation(inlineSnapshot) {
	const match = inlineSnapshot.match(INDENTATION_REGEX);
	if (!match || !match[1]) return inlineSnapshot;
	const indentation = match[1];
	const lines = inlineSnapshot.split(/\n/g);
	if (lines.length <= 2) return inlineSnapshot;
	if (lines[0].trim() !== "" || lines.at(-1)?.trim() !== "") return inlineSnapshot;
	for (let i = 1; i < lines.length - 1; i++) if (lines[i] !== "") {
		if (lines[i].indexOf(indentation) !== 0) return inlineSnapshot;
		lines[i] = lines[i].substring(indentation.length);
	}
	lines[lines.length - 1] = "";
	inlineSnapshot = lines.join("\n");
	return inlineSnapshot;
}
async function saveRawSnapshots(environment, snapshots) {
	await Promise.all(snapshots.map(async (snap) => {
		if (!snap.readonly) await environment.saveSnapshotFile(snap.file, snap.snapshot);
	}));
}
function isSameStackPosition(x, y) {
	return x.file === y.file && x.column === y.column && x.line === y.line;
}
var SnapshotState = class SnapshotState {
	_counters = new CounterMap();
	_dirty;
	_updateSnapshot;
	_snapshotData;
	_initialData;
	_inlineSnapshots;
	_inlineSnapshotStacks;
	_testIdToKeys = new DefaultMap(() => []);
	_rawSnapshots;
	_uncheckedKeys;
	_snapshotFormat;
	_environment;
	_fileExists;
	expand;
	_added = new CounterMap();
	_matched = new CounterMap();
	_unmatched = new CounterMap();
	_updated = new CounterMap();
	get added() {
		return this._added;
	}
	set added(value) {
		this._added._total = value;
	}
	get matched() {
		return this._matched;
	}
	set matched(value) {
		this._matched._total = value;
	}
	get unmatched() {
		return this._unmatched;
	}
	set unmatched(value) {
		this._unmatched._total = value;
	}
	get updated() {
		return this._updated;
	}
	set updated(value) {
		this._updated._total = value;
	}
	constructor(testFilePath, snapshotPath, snapshotContent, options) {
		this.testFilePath = testFilePath;
		this.snapshotPath = snapshotPath;
		const { data, dirty } = getSnapshotData(snapshotContent, options);
		this._fileExists = snapshotContent != null;
		this._initialData = { ...data };
		this._snapshotData = { ...data };
		this._dirty = dirty;
		this._inlineSnapshots = [];
		this._inlineSnapshotStacks = [];
		this._rawSnapshots = [];
		this._uncheckedKeys = new Set(Object.keys(this._snapshotData));
		this.expand = options.expand || false;
		this._updateSnapshot = options.updateSnapshot;
		this._snapshotFormat = {
			printBasicPrototype: false,
			escapeString: false,
			maxOutputLength: 2 ** 27,
			...options.snapshotFormat
		};
		this._environment = options.snapshotEnvironment;
	}
	static async create(testFilePath, options) {
		const snapshotPath = await options.snapshotEnvironment.resolvePath(testFilePath);
		return new SnapshotState(testFilePath, snapshotPath, await options.snapshotEnvironment.readSnapshotFile(snapshotPath), options);
	}
	get snapshotUpdateState() {
		return this._updateSnapshot;
	}
	get environment() {
		return this._environment;
	}
	markSnapshotsAsCheckedForTest(testName) {
		this._uncheckedKeys.forEach((uncheckedKey) => {
			if (/ \d+$| > /.test(uncheckedKey.slice(testName.length))) this._uncheckedKeys.delete(uncheckedKey);
		});
	}
	clearTest(testId) {
		this._inlineSnapshots = this._inlineSnapshots.filter((s) => s.testId !== testId);
		this._inlineSnapshotStacks = this._inlineSnapshotStacks.filter((s) => s.testId !== testId);
		for (const key of this._testIdToKeys.get(testId)) {
			const name = keyToTestName(key);
			const count = this._counters.get(name);
			if (count > 0) {
				if (key in this._snapshotData || key in this._initialData) this._snapshotData[key] = this._initialData[key];
				this._counters.set(name, count - 1);
			}
		}
		this._testIdToKeys.delete(testId);
		this.added.delete(testId);
		this.updated.delete(testId);
		this.matched.delete(testId);
		this.unmatched.delete(testId);
	}
	_inferInlineSnapshotStack(stacks) {
		const promiseIndex = stacks.findIndex((i) => i.method.match(/__VITEST_(RESOLVES|REJECTS)__/));
		if (promiseIndex !== -1) return stacks[promiseIndex + 3];
		const pollChainIndex = stacks.findIndex((i) => i.method.match(/__VITEST_POLL_CHAIN__/));
		if (pollChainIndex !== -1) return stacks[pollChainIndex + 1];
		for (let i = 0; i < stacks.length; i++) {
			const match = stacks[i].method.match(/__INLINE_SNAPSHOT_OFFSET_(\d+)__/);
			if (match) return stacks[i + Number(match[1])] ?? null;
		}
		const customMatcherIndex = stacks.findIndex((i) => i.method.includes("__VITEST_EXTEND_ASSERTION__"));
		if (customMatcherIndex !== -1) return stacks[customMatcherIndex + 3] ?? null;
		const stackIndex = stacks.findIndex((i) => i.method.includes("__INLINE_SNAPSHOT__"));
		return stackIndex !== -1 ? stacks[stackIndex + 2] : null;
	}
	_addSnapshot(key, receivedSerialized, options) {
		this._dirty = true;
		if (options.stack) this._inlineSnapshots.push({
			...options.stack,
			snapshot: receivedSerialized,
			testId: options.testId,
			assertionName: options.assertionName
		});
		else if (options.rawSnapshot) this._rawSnapshots.push({
			...options.rawSnapshot,
			snapshot: receivedSerialized
		});
		else this._snapshotData[key] = receivedSerialized;
	}
	_resolveKey(testId, testName, key) {
		this._counters.increment(testName);
		const count = this._counters.get(testName);
		if (!key) key = testNameToKey(testName, count);
		this._testIdToKeys.get(testId).push(key);
		return {
			key,
			count
		};
	}
	_resolveInlineStack(options) {
		const { testId, snapshot, assertionName, error } = options;
		const stacks = parseErrorStacktrace(error, { ignoreStackEntries: [] });
		const _stack = this._inferInlineSnapshotStack(stacks);
		if (!_stack) {
			const message = stacks.map((s) => `  ${s.file}:${s.line}:${s.column}${s.method ? ` (${s.method})` : ""}`).join("\n");
			throw new Error(`@vitest/snapshot: Couldn't infer stack frame for inline snapshot.\n${message}`);
		}
		const stack = this.environment.processStackTrace?.(_stack) || _stack;
		stack.column--;
		const snapshotsWithSameStack = this._inlineSnapshotStacks.filter((s) => isSameStackPosition(s, stack));
		if (snapshotsWithSameStack.length > 0) {
			this._inlineSnapshots = this._inlineSnapshots.filter((s) => !isSameStackPosition(s, stack));
			const differentSnapshot = snapshotsWithSameStack.find((s) => s.snapshot !== snapshot);
			if (differentSnapshot) throw Object.assign(/* @__PURE__ */ new Error(`${assertionName} with different snapshots cannot be called at the same location`), {
				actual: snapshot,
				expected: differentSnapshot.snapshot
			});
		}
		this._inlineSnapshotStacks.push({
			...stack,
			testId,
			snapshot
		});
		return stack;
	}
	_reconcile(opts) {
		if (opts.hasSnapshot && this._updateSnapshot === "all" || (!opts.hasSnapshot || !opts.snapshotIsPersisted) && (this._updateSnapshot === "new" || this._updateSnapshot === "all")) {
			if (this._updateSnapshot === "all") if (!opts.pass) {
				if (opts.hasSnapshot) this.updated.increment(opts.testId);
				else this.added.increment(opts.testId);
				this._addSnapshot(opts.key, opts.addValue, {
					stack: opts.stack,
					testId: opts.testId,
					rawSnapshot: opts.rawSnapshot,
					assertionName: opts.assertionName
				});
			} else this.matched.increment(opts.testId);
			else {
				this._addSnapshot(opts.key, opts.addValue, {
					stack: opts.stack,
					testId: opts.testId,
					rawSnapshot: opts.rawSnapshot,
					assertionName: opts.assertionName
				});
				this.added.increment(opts.testId);
			}
			return {
				actual: "",
				count: opts.count,
				expected: "",
				key: opts.key,
				pass: true
			};
		} else if (!opts.pass) {
			this.unmatched.increment(opts.testId);
			return {
				actual: opts.actualDisplay,
				count: opts.count,
				expected: opts.expectedDisplay,
				key: opts.key,
				pass: false
			};
		} else {
			this.matched.increment(opts.testId);
			return {
				actual: "",
				count: opts.count,
				expected: "",
				key: opts.key,
				pass: true
			};
		}
	}
	async save() {
		const hasExternalSnapshots = Object.keys(this._snapshotData).length;
		const hasInlineSnapshots = this._inlineSnapshots.length;
		const hasRawSnapshots = this._rawSnapshots.length;
		const isEmpty = !hasExternalSnapshots && !hasInlineSnapshots && !hasRawSnapshots;
		const status = {
			deleted: false,
			saved: false
		};
		if ((this._dirty || this._uncheckedKeys.size) && !isEmpty) {
			if (hasExternalSnapshots) {
				await saveSnapshotFile(this._environment, this._snapshotData, this.snapshotPath);
				this._fileExists = true;
			}
			if (hasInlineSnapshots) await saveInlineSnapshots(this._environment, this._inlineSnapshots);
			if (hasRawSnapshots) await saveRawSnapshots(this._environment, this._rawSnapshots);
			status.saved = true;
		} else if (!hasExternalSnapshots && this._fileExists) {
			if (this._updateSnapshot === "all") {
				await this._environment.removeSnapshotFile(this.snapshotPath);
				this._fileExists = false;
			}
			status.deleted = true;
		}
		return status;
	}
	getUncheckedCount() {
		return this._uncheckedKeys.size || 0;
	}
	getUncheckedKeys() {
		return Array.from(this._uncheckedKeys);
	}
	removeUncheckedKeys() {
		if (this._updateSnapshot === "all" && this._uncheckedKeys.size) {
			this._dirty = true;
			this._uncheckedKeys.forEach((key) => delete this._snapshotData[key]);
			this._uncheckedKeys.clear();
		}
	}
	probeExpectedSnapshot(options) {
		const count = this._counters.get(options.testName) + 1;
		const key = testNameToKey(options.testName, count);
		return {
			key,
			count,
			data: options?.isInline ? options.inlineSnapshot : this._snapshotData[key],
			markAsChecked: () => {
				this._counters.increment(options.testName);
				this._testIdToKeys.get(options.testId).push(key);
				this._uncheckedKeys.delete(key);
			}
		};
	}
	match({ testId, testName, received, key, inlineSnapshot, isInline, error, rawSnapshot, assertionName }) {
		const resolved = this._resolveKey(testId, testName, key);
		key = resolved.key;
		const count = resolved.count;
		if (!(isInline && this._snapshotData[key] !== void 0)) this._uncheckedKeys.delete(key);
		let receivedSerialized = rawSnapshot && typeof received === "string" ? received : serialize(received, void 0, this._snapshotFormat);
		if (!rawSnapshot) receivedSerialized = addExtraLineBreaks(receivedSerialized);
		if (rawSnapshot) {
			if (rawSnapshot.content && rawSnapshot.content.match(/\r\n/) && !receivedSerialized.match(/\r\n/)) rawSnapshot.content = normalizeNewlines(rawSnapshot.content);
		}
		const expected = isInline ? inlineSnapshot : rawSnapshot ? rawSnapshot.content : this._snapshotData[key];
		const expectedTrimmed = rawSnapshot ? expected : expected?.trim();
		const pass = expectedTrimmed === (rawSnapshot ? receivedSerialized : receivedSerialized.trim());
		const hasSnapshot = expected !== void 0;
		const snapshotIsPersisted = isInline || this._fileExists || rawSnapshot && rawSnapshot.content != null;
		if (pass && !isInline && !rawSnapshot) this._snapshotData[key] = receivedSerialized;
		const stack = isInline ? this._resolveInlineStack({
			testId,
			snapshot: receivedSerialized,
			assertionName: assertionName || "toMatchInlineSnapshot",
			error: error || /* @__PURE__ */ new Error("snapshot")
		}) : void 0;
		return this._reconcile({
			testId,
			key,
			count,
			pass,
			hasSnapshot,
			snapshotIsPersisted: !!snapshotIsPersisted,
			addValue: receivedSerialized,
			actualDisplay: rawSnapshot ? receivedSerialized : removeExtraLineBreaks(receivedSerialized),
			expectedDisplay: expectedTrimmed !== void 0 ? rawSnapshot ? expectedTrimmed : removeExtraLineBreaks(expectedTrimmed) : void 0,
			stack,
			rawSnapshot,
			assertionName
		});
	}
	processDomainSnapshot({ testId, received, expectedSnapshot, matchResult, isInline, error, assertionName }) {
		const stack = isInline ? this._resolveInlineStack({
			testId,
			snapshot: received,
			assertionName,
			error: error || /* @__PURE__ */ new Error("STACK_TRACE_ERROR")
		}) : void 0;
		const actualResolved = matchResult?.resolved ?? received;
		const expectedResolved = matchResult?.expected ?? expectedSnapshot.data;
		return this._reconcile({
			testId,
			key: expectedSnapshot.key,
			count: expectedSnapshot.count,
			pass: matchResult?.pass ?? false,
			hasSnapshot: !!expectedSnapshot.data,
			snapshotIsPersisted: isInline ? true : this._fileExists,
			addValue: actualResolved,
			actualDisplay: removeExtraLineBreaks(actualResolved),
			expectedDisplay: expectedResolved !== void 0 ? removeExtraLineBreaks(expectedResolved) : void 0,
			stack,
			assertionName
		});
	}
	async pack() {
		const snapshot = {
			filepath: this.testFilePath,
			added: 0,
			fileDeleted: false,
			matched: 0,
			unchecked: 0,
			uncheckedKeys: [],
			unmatched: 0,
			updated: 0
		};
		const uncheckedCount = this.getUncheckedCount();
		const uncheckedKeys = this.getUncheckedKeys();
		if (uncheckedCount) this.removeUncheckedKeys();
		const status = await this.save();
		snapshot.fileDeleted = status.deleted;
		snapshot.added = this.added.total();
		snapshot.matched = this.matched.total();
		snapshot.unmatched = this.unmatched.total();
		snapshot.updated = this.updated.total();
		snapshot.unchecked = !status.deleted ? uncheckedCount : 0;
		snapshot.uncheckedKeys = Array.from(uncheckedKeys);
		return snapshot;
	}
};
function createMismatchError(message, expand, actual, expected) {
	const error = new Error(message);
	Object.defineProperty(error, "actual", {
		value: actual,
		enumerable: true,
		configurable: true,
		writable: true
	});
	Object.defineProperty(error, "expected", {
		value: expected,
		enumerable: true,
		configurable: true,
		writable: true
	});
	Object.defineProperty(error, "diffOptions", { value: { expand } });
	return error;
}
var SnapshotClient = class {
	snapshotStateMap = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.options = options;
	}
	async setup(filepath, options) {
		if (this.snapshotStateMap.has(filepath)) return;
		this.snapshotStateMap.set(filepath, await SnapshotState.create(filepath, options));
	}
	async finish(filepath) {
		const result = await this.getSnapshotState(filepath).pack();
		this.snapshotStateMap.delete(filepath);
		return result;
	}
	skipTest(filepath, testName) {
		this.getSnapshotState(filepath).markSnapshotsAsCheckedForTest(testName);
	}
	clearTest(filepath, testId) {
		this.getSnapshotState(filepath).clearTest(testId);
	}
	getSnapshotState(filepath) {
		const state = this.snapshotStateMap.get(filepath);
		if (!state) throw new Error(`The snapshot state for '${filepath}' is not found. Did you call 'SnapshotClient.setup()'?`);
		return state;
	}
	match(options) {
		const { filepath, name, testId = name, message, isInline = false, properties, inlineSnapshot, error, errorMessage, rawSnapshot, assertionName } = options;
		let { received } = options;
		if (!filepath) throw new Error("Snapshot cannot be used outside of test");
		const snapshotState = this.getSnapshotState(filepath);
		const testName = [name, ...message ? [message] : []].join(" > ");
		const expectedSnapshot = snapshotState.probeExpectedSnapshot({
			testName,
			testId,
			isInline,
			inlineSnapshot
		});
		if (typeof properties === "object") {
			if (typeof received !== "object" || !received) {
				expectedSnapshot.markAsChecked();
				throw new Error("Received value must be an object when the matcher has properties");
			}
			let propertiesPass;
			try {
				propertiesPass = this.options.isEqual?.(received, properties) ?? false;
			} catch (err) {
				expectedSnapshot.markAsChecked();
				throw err;
			}
			if (!propertiesPass) {
				expectedSnapshot.markAsChecked();
				return {
					pass: false,
					message: () => errorMessage || "Snapshot properties mismatched",
					actual: received,
					expected: properties
				};
			}
			received = deepMergeSnapshot(received, properties);
		}
		const { actual, expected, key, pass } = snapshotState.match({
			testId,
			testName,
			received,
			isInline,
			error,
			inlineSnapshot,
			rawSnapshot,
			assertionName
		});
		return {
			pass,
			message: () => `Snapshot \`${key || "unknown"}\` mismatched`,
			actual: rawSnapshot ? actual : actual?.trim(),
			expected: rawSnapshot ? expected : expected?.trim()
		};
	}
	assert(options) {
		const result = this.match(options);
		if (!result.pass) {
			const snapshotState = this.getSnapshotState(options.filepath);
			throw createMismatchError(result.message(), snapshotState.expand, result.actual, result.expected);
		}
	}
	matchDomain(options) {
		const { received, filepath, name, testId = name, message, adapter, isInline = false, inlineSnapshot, error } = options;
		if (!filepath) throw new Error("Snapshot cannot be used outside of test");
		const captured = adapter.capture(received);
		const rendered = adapter.render(captured);
		const snapshotState = this.getSnapshotState(filepath);
		const testName = [name, ...message ? [message] : []].join(" > ");
		const expectedSnapshot = snapshotState.probeExpectedSnapshot({
			testName,
			testId,
			isInline,
			inlineSnapshot
		});
		expectedSnapshot.markAsChecked();
		const matchResult = expectedSnapshot.data ? adapter.match(captured, adapter.parseExpected(expectedSnapshot.data)) : void 0;
		const { actual, expected, key, pass } = snapshotState.processDomainSnapshot({
			testId,
			received: rendered,
			expectedSnapshot,
			matchResult,
			isInline,
			error,
			assertionName: options.assertionName
		});
		return {
			pass,
			message: () => `Snapshot \`${key}\` mismatched`,
			actual: actual?.trim(),
			expected: expected?.trim()
		};
	}
	async pollMatchDomain(options) {
		const { poll, filepath, name, testId = name, message, adapter, isInline = false, inlineSnapshot, error, timeout = 1e3, interval = 50 } = options;
		if (!filepath) throw new Error("Snapshot cannot be used outside of test");
		const snapshotState = this.getSnapshotState(filepath);
		const testName = [name, ...message ? [message] : []].join(" > ");
		const expectedSnapshot = snapshotState.probeExpectedSnapshot({
			testName,
			testId,
			isInline,
			inlineSnapshot
		});
		const reference = expectedSnapshot.data && snapshotState.snapshotUpdateState !== "all" ? adapter.parseExpected(expectedSnapshot.data) : void 0;
		const stableResult = await getStableSnapshot({
			adapter,
			poll,
			interval,
			timedOut: timeout > 0 ? new Promise((r) => setTimeout(r, timeout)) : void 0,
			match: reference ? (captured) => adapter.match(captured, reference).pass : void 0
		});
		expectedSnapshot.markAsChecked();
		if (!stableResult?.rendered) {
			if (stableResult?.lastPollError) throw stableResult.lastPollError;
			return {
				pass: false,
				message: () => `poll() did not produce a stable snapshot within the timeout`
			};
		}
		const matchResult = expectedSnapshot.data ? adapter.match(stableResult.captured, adapter.parseExpected(expectedSnapshot.data)) : void 0;
		const { actual, expected, key, pass } = snapshotState.processDomainSnapshot({
			testId,
			received: stableResult.rendered,
			expectedSnapshot,
			matchResult,
			isInline,
			error,
			assertionName: options.assertionName
		});
		return {
			pass,
			message: () => `Snapshot \`${key}\` mismatched`,
			actual: actual?.trim(),
			expected: expected?.trim()
		};
	}
	async assertRaw(options) {
		if (!options.rawSnapshot) throw new Error("Raw snapshot is required");
		const { filepath, rawSnapshot } = options;
		if (rawSnapshot.content == null) {
			if (!filepath) throw new Error("Snapshot cannot be used outside of test");
			const snapshotState = this.getSnapshotState(filepath);
			options.filepath ||= filepath;
			rawSnapshot.file = await snapshotState.environment.resolveRawPath(filepath, rawSnapshot.file);
			rawSnapshot.content = await snapshotState.environment.readSnapshotFile(rawSnapshot.file) ?? void 0;
		}
		return this.assert(options);
	}
	clear() {
		this.snapshotStateMap.clear();
	}
};
/**
* Polls repeatedly until the value reaches a stable state.
*
* Compares consecutive rendered outputs from the current session —
* when two consecutive polls produce the same rendered string,
* the value is considered stable.
*
* Every `await` (poll call, interval delay) races against `timedOut`
* so that hanging polls and delays are interrupted.
*/
async function getStableSnapshot({ adapter, poll, interval, timedOut, match }) {
	let lastRendered;
	let lastPollError;
	let lastStable;
	while (true) {
		try {
			const pollResult = await raceWith(Promise.resolve(poll()), timedOut);
			if (!pollResult.ok) break;
			const captured = adapter.capture(pollResult.value);
			const rendered = adapter.render(captured);
			if (lastRendered !== void 0 && rendered === lastRendered) {
				lastStable = {
					captured,
					rendered
				};
				if (!match || match(captured)) break;
			} else {
				lastRendered = rendered;
				lastStable = void 0;
			}
		} catch (pollError) {
			lastRendered = void 0;
			lastStable = void 0;
			lastPollError = pollError;
		}
		if (!(await raceWith(new Promise((r) => setTimeout(r, interval)), timedOut)).ok) break;
	}
	return {
		...lastStable,
		lastPollError
	};
}
/** Type-safe `Promise.race` — tells you which promise won. */
function raceWith(promise, other) {
	const left = promise.then((value) => ({
		ok: true,
		value
	}));
	if (!other) return left;
	return Promise.race([left, other.then((value) => ({
		ok: false,
		value
	}))]);
}
//#endregion
//#region node_modules/vitest/dist/chunks/test.DNmyFkvJ.js
var fakeTimersSrc = {};
var global$1;
var hasRequiredGlobal;
function requireGlobal() {
	if (hasRequiredGlobal) return global$1;
	hasRequiredGlobal = 1;
	/**
	* A reference to the global object
	* @type {object} globalObject
	*/
	var globalObject;
	/* istanbul ignore else */
	if (typeof commonjsGlobal !== "undefined") globalObject = commonjsGlobal;
	else if (typeof window !== "undefined") globalObject = window;
	else globalObject = self;
	global$1 = globalObject;
	return global$1;
}
var throwsOnProto_1;
var hasRequiredThrowsOnProto;
function requireThrowsOnProto() {
	if (hasRequiredThrowsOnProto) return throwsOnProto_1;
	hasRequiredThrowsOnProto = 1;
	/**
	* Is true when the environment causes an error to be thrown for accessing the
	* __proto__ property.
	* This is necessary in order to support `node --disable-proto=throw`.
	*
	* See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/proto
	* @type {boolean}
	*/
	let throwsOnProto;
	try {
		({}).__proto__;
		throwsOnProto = false;
	} catch (_) {
		/* istanbul ignore next */
		throwsOnProto = true;
	}
	throwsOnProto_1 = throwsOnProto;
	return throwsOnProto_1;
}
var copyPrototypeMethods;
var hasRequiredCopyPrototypeMethods;
function requireCopyPrototypeMethods() {
	if (hasRequiredCopyPrototypeMethods) return copyPrototypeMethods;
	hasRequiredCopyPrototypeMethods = 1;
	var call = Function.call;
	var throwsOnProto = requireThrowsOnProto();
	var disallowedProperties = [
		"size",
		"caller",
		"callee",
		"arguments"
	];
	/* istanbul ignore next */
	if (throwsOnProto) disallowedProperties.push("__proto__");
	copyPrototypeMethods = function copyPrototypeMethods(prototype) {
		return Object.getOwnPropertyNames(prototype).reduce(function(result, name) {
			if (disallowedProperties.includes(name)) return result;
			if (typeof prototype[name] !== "function") return result;
			result[name] = call.bind(prototype[name]);
			return result;
		}, Object.create(null));
	};
	return copyPrototypeMethods;
}
var array;
var hasRequiredArray;
function requireArray() {
	if (hasRequiredArray) return array;
	hasRequiredArray = 1;
	array = requireCopyPrototypeMethods()(Array.prototype);
	return array;
}
var calledInOrder_1;
var hasRequiredCalledInOrder;
function requireCalledInOrder() {
	if (hasRequiredCalledInOrder) return calledInOrder_1;
	hasRequiredCalledInOrder = 1;
	var every = requireArray().every;
	/**
	* @private
	*/
	function hasCallsLeft(callMap, spy) {
		if (callMap[spy.id] === void 0) callMap[spy.id] = 0;
		return callMap[spy.id] < spy.callCount;
	}
	/**
	* @private
	*/
	function checkAdjacentCalls(callMap, spy, index, spies) {
		var calledBeforeNext = true;
		if (index !== spies.length - 1) calledBeforeNext = spy.calledBefore(spies[index + 1]);
		if (hasCallsLeft(callMap, spy) && calledBeforeNext) {
			callMap[spy.id] += 1;
			return true;
		}
		return false;
	}
	/**
	* A Sinon proxy object (fake, spy, stub)
	* @typedef {object} SinonProxy
	* @property {Function} calledBefore - A method that determines if this proxy was called before another one
	* @property {string} id - Some id
	* @property {number} callCount - Number of times this proxy has been called
	*/
	/**
	* Returns true when the spies have been called in the order they were supplied in
	* @param  {SinonProxy[] | SinonProxy} spies An array of proxies, or several proxies as arguments
	* @returns {boolean} true when spies are called in order, false otherwise
	*/
	function calledInOrder(spies) {
		return every(arguments.length > 1 ? arguments : spies, checkAdjacentCalls.bind(null, {}));
	}
	calledInOrder_1 = calledInOrder;
	return calledInOrder_1;
}
var className_1;
var hasRequiredClassName;
function requireClassName() {
	if (hasRequiredClassName) return className_1;
	hasRequiredClassName = 1;
	/**
	* Returns a display name for a value from a constructor
	* @param  {object} value A value to examine
	* @returns {(string|null)} A string or null
	*/
	function className(value) {
		return value.constructor && value.constructor.name || null;
	}
	className_1 = className;
	return className_1;
}
var deprecated = {};
var hasRequiredDeprecated;
function requireDeprecated() {
	if (hasRequiredDeprecated) return deprecated;
	hasRequiredDeprecated = 1;
	(function(exports$1) {
		/**
		* Returns a function that will invoke the supplied function and print a
		* deprecation warning to the console each time it is called.
		* @param  {Function} func
		* @param  {string} msg
		* @returns {Function}
		*/
		exports$1.wrap = function(func, msg) {
			var wrapped = function() {
				exports$1.printWarning(msg);
				return func.apply(this, arguments);
			};
			if (func.prototype) wrapped.prototype = func.prototype;
			return wrapped;
		};
		/**
		* Returns a string which can be supplied to `wrap()` to notify the user that a
		* particular part of the sinon API has been deprecated.
		* @param  {string} packageName
		* @param  {string} funcName
		* @returns {string}
		*/
		exports$1.defaultMsg = function(packageName, funcName) {
			return `${packageName}.${funcName} is deprecated and will be removed from the public API in a future version of ${packageName}.`;
		};
		/**
		* Prints a warning on the console, when it exists
		* @param  {string} msg
		* @returns {undefined}
		*/
		exports$1.printWarning = function(msg) {
			/* istanbul ignore next */
			if (typeof process === "object" && process.emitWarning) process.emitWarning(msg);
			else if (console.info) console.info(msg);
			else console.log(msg);
		};
	})(deprecated);
	return deprecated;
}
var every;
var hasRequiredEvery;
function requireEvery() {
	if (hasRequiredEvery) return every;
	hasRequiredEvery = 1;
	/**
	* Returns true when fn returns true for all members of obj.
	* This is an every implementation that works for all iterables
	* @param  {object}   obj
	* @param  {Function} fn
	* @returns {boolean}
	*/
	every = function every(obj, fn) {
		var pass = true;
		try {
			obj.forEach(function() {
				if (!fn.apply(this, arguments)) throw new Error();
			});
		} catch (e) {
			pass = false;
		}
		return pass;
	};
	return every;
}
var functionName;
var hasRequiredFunctionName;
function requireFunctionName() {
	if (hasRequiredFunctionName) return functionName;
	hasRequiredFunctionName = 1;
	/**
	* Returns a display name for a function
	* @param  {Function} func
	* @returns {string}
	*/
	functionName = function functionName(func) {
		if (!func) return "";
		try {
			return func.displayName || func.name || (String(func).match(/function ([^\s(]+)/) || [])[1];
		} catch (e) {
			return "";
		}
	};
	return functionName;
}
var orderByFirstCall_1;
var hasRequiredOrderByFirstCall;
function requireOrderByFirstCall() {
	if (hasRequiredOrderByFirstCall) return orderByFirstCall_1;
	hasRequiredOrderByFirstCall = 1;
	var sort = requireArray().sort;
	var slice = requireArray().slice;
	/**
	* @private
	*/
	function comparator(a, b) {
		var aCall = a.getCall(0);
		var bCall = b.getCall(0);
		return (aCall && aCall.callId || -1) < (bCall && bCall.callId || -1) ? -1 : 1;
	}
	/**
	* A Sinon proxy object (fake, spy, stub)
	* @typedef {object} SinonProxy
	* @property {Function} getCall - A method that can return the first call
	*/
	/**
	* Sorts an array of SinonProxy instances (fake, spy, stub) by their first call
	* @param  {SinonProxy[] | SinonProxy} spies
	* @returns {SinonProxy[]}
	*/
	function orderByFirstCall(spies) {
		return sort(slice(spies), comparator);
	}
	orderByFirstCall_1 = orderByFirstCall;
	return orderByFirstCall_1;
}
var _function;
var hasRequired_function;
function require_function() {
	if (hasRequired_function) return _function;
	hasRequired_function = 1;
	_function = requireCopyPrototypeMethods()(Function.prototype);
	return _function;
}
var map;
var hasRequiredMap;
function requireMap() {
	if (hasRequiredMap) return map;
	hasRequiredMap = 1;
	map = requireCopyPrototypeMethods()(Map.prototype);
	return map;
}
var object;
var hasRequiredObject;
function requireObject() {
	if (hasRequiredObject) return object;
	hasRequiredObject = 1;
	object = requireCopyPrototypeMethods()(Object.prototype);
	return object;
}
var set;
var hasRequiredSet;
function requireSet() {
	if (hasRequiredSet) return set;
	hasRequiredSet = 1;
	set = requireCopyPrototypeMethods()(Set.prototype);
	return set;
}
var string;
var hasRequiredString;
function requireString() {
	if (hasRequiredString) return string;
	hasRequiredString = 1;
	string = requireCopyPrototypeMethods()(String.prototype);
	return string;
}
var prototypes;
var hasRequiredPrototypes;
function requirePrototypes() {
	if (hasRequiredPrototypes) return prototypes;
	hasRequiredPrototypes = 1;
	prototypes = {
		array: requireArray(),
		function: require_function(),
		map: requireMap(),
		object: requireObject(),
		set: requireSet(),
		string: requireString()
	};
	return prototypes;
}
var typeDetect$1 = { exports: {} };
var typeDetect = typeDetect$1.exports;
var hasRequiredTypeDetect;
function requireTypeDetect() {
	if (hasRequiredTypeDetect) return typeDetect$1.exports;
	hasRequiredTypeDetect = 1;
	(function(module, exports$1) {
		(function(global, factory) {
			module.exports = factory();
		})(typeDetect, (function() {
			var promiseExists = typeof Promise === "function";
			var globalObject = typeof self === "object" ? self : commonjsGlobal;
			var symbolExists = typeof Symbol !== "undefined";
			var mapExists = typeof Map !== "undefined";
			var setExists = typeof Set !== "undefined";
			var weakMapExists = typeof WeakMap !== "undefined";
			var weakSetExists = typeof WeakSet !== "undefined";
			var dataViewExists = typeof DataView !== "undefined";
			var symbolIteratorExists = symbolExists && typeof Symbol.iterator !== "undefined";
			var symbolToStringTagExists = symbolExists && typeof Symbol.toStringTag !== "undefined";
			var setEntriesExists = setExists && typeof Set.prototype.entries === "function";
			var mapEntriesExists = mapExists && typeof Map.prototype.entries === "function";
			var setIteratorPrototype = setEntriesExists && Object.getPrototypeOf((/* @__PURE__ */ new Set()).entries());
			var mapIteratorPrototype = mapEntriesExists && Object.getPrototypeOf((/* @__PURE__ */ new Map()).entries());
			var arrayIteratorExists = symbolIteratorExists && typeof Array.prototype[Symbol.iterator] === "function";
			var arrayIteratorPrototype = arrayIteratorExists && Object.getPrototypeOf([][Symbol.iterator]());
			var stringIteratorExists = symbolIteratorExists && typeof String.prototype[Symbol.iterator] === "function";
			var stringIteratorPrototype = stringIteratorExists && Object.getPrototypeOf(""[Symbol.iterator]());
			var toStringLeftSliceLength = 8;
			var toStringRightSliceLength = -1;
			/**
			* ### typeOf (obj)
			*
			* Uses `Object.prototype.toString` to determine the type of an object,
			* normalising behaviour across engine versions & well optimised.
			*
			* @param {Mixed} object
			* @return {String} object type
			* @api public
			*/
			function typeDetect(obj) {
				var typeofObj = typeof obj;
				if (typeofObj !== "object") return typeofObj;
				if (obj === null) return "null";
				if (obj === globalObject) return "global";
				if (Array.isArray(obj) && (symbolToStringTagExists === false || !(Symbol.toStringTag in obj))) return "Array";
				if (typeof window === "object" && window !== null) {
					if (typeof window.location === "object" && obj === window.location) return "Location";
					if (typeof window.document === "object" && obj === window.document) return "Document";
					if (typeof window.navigator === "object") {
						if (typeof window.navigator.mimeTypes === "object" && obj === window.navigator.mimeTypes) return "MimeTypeArray";
						if (typeof window.navigator.plugins === "object" && obj === window.navigator.plugins) return "PluginArray";
					}
					if ((typeof window.HTMLElement === "function" || typeof window.HTMLElement === "object") && obj instanceof window.HTMLElement) {
						if (obj.tagName === "BLOCKQUOTE") return "HTMLQuoteElement";
						if (obj.tagName === "TD") return "HTMLTableDataCellElement";
						if (obj.tagName === "TH") return "HTMLTableHeaderCellElement";
					}
				}
				var stringTag = symbolToStringTagExists && obj[Symbol.toStringTag];
				if (typeof stringTag === "string") return stringTag;
				var objPrototype = Object.getPrototypeOf(obj);
				if (objPrototype === RegExp.prototype) return "RegExp";
				if (objPrototype === Date.prototype) return "Date";
				if (promiseExists && objPrototype === Promise.prototype) return "Promise";
				if (setExists && objPrototype === Set.prototype) return "Set";
				if (mapExists && objPrototype === Map.prototype) return "Map";
				if (weakSetExists && objPrototype === WeakSet.prototype) return "WeakSet";
				if (weakMapExists && objPrototype === WeakMap.prototype) return "WeakMap";
				if (dataViewExists && objPrototype === DataView.prototype) return "DataView";
				if (mapExists && objPrototype === mapIteratorPrototype) return "Map Iterator";
				if (setExists && objPrototype === setIteratorPrototype) return "Set Iterator";
				if (arrayIteratorExists && objPrototype === arrayIteratorPrototype) return "Array Iterator";
				if (stringIteratorExists && objPrototype === stringIteratorPrototype) return "String Iterator";
				if (objPrototype === null) return "Object";
				return Object.prototype.toString.call(obj).slice(toStringLeftSliceLength, toStringRightSliceLength);
			}
			return typeDetect;
		}));
	})(typeDetect$1);
	return typeDetect$1.exports;
}
var typeOf;
var hasRequiredTypeOf;
function requireTypeOf() {
	if (hasRequiredTypeOf) return typeOf;
	hasRequiredTypeOf = 1;
	var type = requireTypeDetect();
	/**
	* Returns the lower-case result of running type from type-detect on the value
	* @param  {*} value
	* @returns {string}
	*/
	typeOf = function typeOf(value) {
		return type(value).toLowerCase();
	};
	return typeOf;
}
var valueToString_1;
var hasRequiredValueToString;
function requireValueToString() {
	if (hasRequiredValueToString) return valueToString_1;
	hasRequiredValueToString = 1;
	/**
	* Returns a string representation of the value
	* @param  {*} value
	* @returns {string}
	*/
	function valueToString(value) {
		if (value && value.toString) return value.toString();
		return String(value);
	}
	valueToString_1 = valueToString;
	return valueToString_1;
}
var lib;
var hasRequiredLib;
function requireLib() {
	if (hasRequiredLib) return lib;
	hasRequiredLib = 1;
	lib = {
		global: requireGlobal(),
		calledInOrder: requireCalledInOrder(),
		className: requireClassName(),
		deprecated: requireDeprecated(),
		every: requireEvery(),
		functionName: requireFunctionName(),
		orderByFirstCall: requireOrderByFirstCall(),
		prototypes: requirePrototypes(),
		typeOf: requireTypeOf(),
		valueToString: requireValueToString()
	};
	return lib;
}
var hasRequiredFakeTimersSrc;
function requireFakeTimersSrc() {
	if (hasRequiredFakeTimersSrc) return fakeTimersSrc;
	hasRequiredFakeTimersSrc = 1;
	const globalObject = requireLib().global;
	let timersModule, timersPromisesModule;
	if (typeof __vitest_required__ !== "undefined") {
		try {
			timersModule = __vitest_required__.timers;
		} catch (e) {}
		try {
			timersPromisesModule = __vitest_required__.timersPromises;
		} catch (e) {}
	}
	/**
	* @typedef {"nextAsync" | "manual" | "interval"} TickMode
	*/
	/**
	* @typedef {object} NextAsyncTickMode
	* @property {"nextAsync"} mode
	*/
	/**
	* @typedef {object} ManualTickMode
	* @property {"manual"} mode
	*/
	/**
	* @typedef {object} IntervalTickMode
	* @property {"interval"} mode
	* @property {number} [delta]
	*/
	/**
	* @typedef {IntervalTickMode | NextAsyncTickMode | ManualTickMode} TimerTickMode
	*/
	/**
	* @typedef {object} IdleDeadline
	* @property {boolean} didTimeout - whether or not the callback was called before reaching the optional timeout
	* @property {function():number} timeRemaining - a floating-point value providing an estimate of the number of milliseconds remaining in the current idle period
	*/
	/**
	* Queues a function to be called during a browser's idle periods
	* @callback RequestIdleCallback
	* @param {function(IdleDeadline)} callback
	* @param {{timeout: number}} options - an options object
	* @returns {number} the id
	*/
	/**
	* @callback NextTick
	* @param {VoidVarArgsFunc} callback - the callback to run
	* @param {...*} args - optional arguments to call the callback with
	* @returns {void}
	*/
	/**
	* @callback SetImmediate
	* @param {VoidVarArgsFunc} callback - the callback to run
	* @param {...*} args - optional arguments to call the callback with
	* @returns {NodeImmediate}
	*/
	/**
	* @callback VoidVarArgsFunc
	* @param {...*} callback - the callback to run
	* @returns {void}
	*/
	/**
	* @typedef RequestAnimationFrame
	* @property {function(number):void} requestAnimationFrame
	* @returns {number} - the id
	*/
	/**
	* @typedef Performance
	* @property {function(): number} now
	*/
	/**
	* @typedef {object} Clock
	* @property {number} now - the current time
	* @property {Date} Date - the Date constructor
	* @property {number} loopLimit - the maximum number of timers before assuming an infinite loop
	* @property {RequestIdleCallback} requestIdleCallback
	* @property {function(number):void} cancelIdleCallback
	* @property {setTimeout} setTimeout
	* @property {clearTimeout} clearTimeout
	* @property {NextTick} nextTick
	* @property {queueMicrotask} queueMicrotask
	* @property {setInterval} setInterval
	* @property {clearInterval} clearInterval
	* @property {SetImmediate} setImmediate
	* @property {function(NodeImmediate):void} clearImmediate
	* @property {function():number} countTimers
	* @property {RequestAnimationFrame} requestAnimationFrame
	* @property {function(number):void} cancelAnimationFrame
	* @property {function():void} runMicrotasks
	* @property {function(string | number): number} tick
	* @property {function(string | number): Promise<number>} tickAsync
	* @property {function(): number} next
	* @property {function(): Promise<number>} nextAsync
	* @property {function(): number} runAll
	* @property {function(): number} runToFrame
	* @property {function(): Promise<number>} runAllAsync
	* @property {function(): number} runToLast
	* @property {function(): Promise<number>} runToLastAsync
	* @property {function(): void} reset
	* @property {function(number | Date): void} setSystemTime
	* @property {function(number): void} jump
	* @property {Performance} performance
	* @property {function(number[]): number[]} hrtime - process.hrtime (legacy)
	* @property {function(): void} uninstall Uninstall the clock.
	* @property {Function[]} methods - the methods that are faked
	* @property {boolean} [shouldClearNativeTimers] inherited from config
	* @property {{methodName:string, original:any}[] | undefined} timersModuleMethods
	* @property {{methodName:string, original:any}[] | undefined} timersPromisesModuleMethods
	* @property {Map<function(): void, AbortSignal>} abortListenerMap
	* @property {function(TimerTickMode): void} setTickMode
	*/
	/**
	* Configuration object for the `install` method.
	* @typedef {object} Config
	* @property {number|Date} [now] a number (in milliseconds) or a Date object (default epoch)
	* @property {string[]} [toFake] names of the methods that should be faked.
	* @property {number} [loopLimit] the maximum number of timers that will be run when calling runAll()
	* @property {boolean} [shouldAdvanceTime] tells FakeTimers to increment mocked time automatically (default false)
	* @property {number} [advanceTimeDelta] increment mocked time every <<advanceTimeDelta>> ms (default: 20ms)
	* @property {boolean} [shouldClearNativeTimers] forwards clear timer calls to native functions if they are not fakes (default: false)
	* @property {boolean} [ignoreMissingTimers] default is false, meaning asking to fake timers that are not present will throw an error
	*/
	/**
	* The internal structure to describe a scheduled fake timer
	* @typedef {object} Timer
	* @property {Function} func
	* @property {*[]} args
	* @property {number} delay
	* @property {number} callAt
	* @property {number} createdAt
	* @property {boolean} immediate
	* @property {number} id
	* @property {Error} [error]
	*/
	/**
	* A Node timer
	* @typedef {object} NodeImmediate
	* @property {function(): boolean} hasRef
	* @property {function(): NodeImmediate} ref
	* @property {function(): NodeImmediate} unref
	*/
	/**
	* Mocks available features in the specified global namespace.
	* @param {*} _global Namespace to mock (e.g. `window`)
	* @returns {FakeTimers}
	*/
	function withGlobal(_global) {
		const maxTimeout = Math.pow(2, 31) - 1;
		const idCounterStart = 0xe8d4a51000;
		const NOOP = function() {};
		const NOOP_ARRAY = function() {
			return [];
		};
		const isPresent = {};
		let timeoutResult, addTimerReturnsObject = false;
		if (_global.setTimeout) {
			isPresent.setTimeout = true;
			timeoutResult = _global.setTimeout(NOOP, 0);
			addTimerReturnsObject = typeof timeoutResult === "object";
		}
		isPresent.clearTimeout = Boolean(_global.clearTimeout);
		isPresent.setInterval = Boolean(_global.setInterval);
		isPresent.clearInterval = Boolean(_global.clearInterval);
		isPresent.hrtime = _global.process && typeof _global.process.hrtime === "function";
		isPresent.hrtimeBigint = isPresent.hrtime && typeof _global.process.hrtime.bigint === "function";
		isPresent.nextTick = _global.process && typeof _global.process.nextTick === "function";
		const utilPromisify = _global.process && _global.__vitest_required__ && _global.__vitest_required__.util.promisify;
		isPresent.performance = _global.performance && typeof _global.performance.now === "function";
		const hasPerformancePrototype = _global.Performance && (typeof _global.Performance).match(/^(function|object)$/);
		const hasPerformanceConstructorPrototype = _global.performance && _global.performance.constructor && _global.performance.constructor.prototype;
		isPresent.queueMicrotask = _global.hasOwnProperty("queueMicrotask");
		isPresent.requestAnimationFrame = _global.requestAnimationFrame && typeof _global.requestAnimationFrame === "function";
		isPresent.cancelAnimationFrame = _global.cancelAnimationFrame && typeof _global.cancelAnimationFrame === "function";
		isPresent.requestIdleCallback = _global.requestIdleCallback && typeof _global.requestIdleCallback === "function";
		isPresent.cancelIdleCallbackPresent = _global.cancelIdleCallback && typeof _global.cancelIdleCallback === "function";
		isPresent.setImmediate = _global.setImmediate && typeof _global.setImmediate === "function";
		isPresent.clearImmediate = _global.clearImmediate && typeof _global.clearImmediate === "function";
		isPresent.Intl = _global.Intl && typeof _global.Intl === "object";
		if (_global.clearTimeout) _global.clearTimeout(timeoutResult);
		const NativeDate = _global.Date;
		const NativeIntl = isPresent.Intl ? Object.defineProperties(Object.create(null), Object.getOwnPropertyDescriptors(_global.Intl)) : void 0;
		let uniqueTimerId = idCounterStart;
		if (NativeDate === void 0) throw new Error("The global scope doesn't have a `Date` object (see https://github.com/sinonjs/sinon/issues/1852#issuecomment-419622780)");
		isPresent.Date = true;
		/**
		* The PerformanceEntry object encapsulates a single performance metric
		* that is part of the browser's performance timeline.
		*
		* This is an object returned by the `mark` and `measure` methods on the Performance prototype
		*/
		class FakePerformanceEntry {
			constructor(name, entryType, startTime, duration) {
				this.name = name;
				this.entryType = entryType;
				this.startTime = startTime;
				this.duration = duration;
			}
			toJSON() {
				return JSON.stringify({ ...this });
			}
		}
		/**
		* @param {number} num
		* @returns {boolean}
		*/
		function isNumberFinite(num) {
			if (Number.isFinite) return Number.isFinite(num);
			return isFinite(num);
		}
		let isNearInfiniteLimit = false;
		/**
		* @param {Clock} clock
		* @param {number} i
		*/
		function checkIsNearInfiniteLimit(clock, i) {
			if (clock.loopLimit && i === clock.loopLimit - 1) isNearInfiniteLimit = true;
		}
		/**
		*
		*/
		function resetIsNearInfiniteLimit() {
			isNearInfiniteLimit = false;
		}
		/**
		* Parse strings like "01:10:00" (meaning 1 hour, 10 minutes, 0 seconds) into
		* number of milliseconds. This is used to support human-readable strings passed
		* to clock.tick()
		* @param {string} str
		* @returns {number}
		*/
		function parseTime(str) {
			if (!str) return 0;
			const strings = str.split(":");
			const l = strings.length;
			let i = l;
			let ms = 0;
			let parsed;
			if (l > 3 || !/^(\d\d:){0,2}\d\d?$/.test(str)) throw new Error("tick only understands numbers, 'm:s' and 'h:m:s'. Each part must be two digits");
			while (i--) {
				parsed = parseInt(strings[i], 10);
				if (parsed >= 60) throw new Error(`Invalid time ${str}`);
				ms += parsed * Math.pow(60, l - i - 1);
			}
			return ms * 1e3;
		}
		/**
		* Get the decimal part of the millisecond value as nanoseconds
		* @param {number} msFloat the number of milliseconds
		* @returns {number} an integer number of nanoseconds in the range [0,1e6)
		*
		* Example: nanoRemainer(123.456789) -> 456789
		*/
		function nanoRemainder(msFloat) {
			const modulo = 1e6;
			const remainder = msFloat * 1e6 % modulo;
			const positiveRemainder = remainder < 0 ? remainder + modulo : remainder;
			return Math.floor(positiveRemainder);
		}
		/**
		* Used to grok the `now` parameter to createClock.
		* @param {Date|number} epoch the system time
		* @returns {number}
		*/
		function getEpoch(epoch) {
			if (!epoch) return 0;
			if (typeof epoch.getTime === "function") return epoch.getTime();
			if (typeof epoch === "number") return epoch;
			throw new TypeError("now should be milliseconds since UNIX epoch");
		}
		/**
		* @param {number} from
		* @param {number} to
		* @param {Timer} timer
		* @returns {boolean}
		*/
		function inRange(from, to, timer) {
			return timer && timer.callAt >= from && timer.callAt <= to;
		}
		/**
		* @param {Clock} clock
		* @param {Timer} job
		*/
		function getInfiniteLoopError(clock, job) {
			const infiniteLoopError = /* @__PURE__ */ new Error(`Aborting after running ${clock.loopLimit} timers, assuming an infinite loop!`);
			if (!job.error) return infiniteLoopError;
			const computedTargetPattern = /target\.*[<|(|[].*?[>|\]|)]\s*/;
			let clockMethodPattern = new RegExp(String(Object.keys(clock).join("|")));
			if (addTimerReturnsObject) clockMethodPattern = new RegExp(`\\s+at (Object\\.)?(?:${Object.keys(clock).join("|")})\\s+`);
			let matchedLineIndex = -1;
			job.error.stack.split("\n").some(function(line, i) {
				/* istanbul ignore if */
				if (line.match(computedTargetPattern)) {
					matchedLineIndex = i;
					return true;
				}
				if (line.match(clockMethodPattern)) {
					matchedLineIndex = i;
					return false;
				}
				return matchedLineIndex >= 0;
			});
			const stack = `${infiniteLoopError}\n${job.type || "Microtask"} - ${job.func.name || "anonymous"}\n${job.error.stack.split("\n").slice(matchedLineIndex + 1).join("\n")}`;
			try {
				Object.defineProperty(infiniteLoopError, "stack", { value: stack });
			} catch (e) {}
			return infiniteLoopError;
		}
		function createDate() {
			class ClockDate extends NativeDate {
				/**
				* @param {number} year
				* @param {number} month
				* @param {number} date
				* @param {number} hour
				* @param {number} minute
				* @param {number} second
				* @param {number} ms
				* @returns void
				*/
				constructor(year, month, date, hour, minute, second, ms) {
					if (arguments.length === 0) super(ClockDate.clock.now);
					else super(...arguments);
					Object.defineProperty(this, "constructor", {
						value: NativeDate,
						enumerable: false
					});
				}
				static [Symbol.hasInstance](instance) {
					return instance instanceof NativeDate;
				}
			}
			ClockDate.isFake = true;
			if (NativeDate.now) ClockDate.now = function now() {
				return ClockDate.clock.now;
			};
			if (NativeDate.toSource) ClockDate.toSource = function toSource() {
				return NativeDate.toSource();
			};
			ClockDate.toString = function toString() {
				return NativeDate.toString();
			};
			return new Proxy(ClockDate, { apply() {
				if (this instanceof ClockDate) throw new TypeError("A Proxy should only capture `new` calls with the `construct` handler. This is not supposed to be possible, so check the logic.");
				return new NativeDate(ClockDate.clock.now).toString();
			} });
		}
		/**
		* Mirror Intl by default on our fake implementation
		*
		* Most of the properties are the original native ones,
		* but we need to take control of those that have a
		* dependency on the current clock.
		* @returns {object} the partly fake Intl implementation
		*/
		function createIntl() {
			const ClockIntl = {};
			Object.getOwnPropertyNames(NativeIntl).forEach((property) => ClockIntl[property] = NativeIntl[property]);
			ClockIntl.DateTimeFormat = function(...args) {
				const realFormatter = new NativeIntl.DateTimeFormat(...args);
				const formatter = {};
				[
					"formatRange",
					"formatRangeToParts",
					"resolvedOptions"
				].forEach((method) => {
					formatter[method] = realFormatter[method].bind(realFormatter);
				});
				["format", "formatToParts"].forEach((method) => {
					formatter[method] = function(date) {
						return realFormatter[method](date || ClockIntl.clock.now);
					};
				});
				return formatter;
			};
			ClockIntl.DateTimeFormat.prototype = Object.create(NativeIntl.DateTimeFormat.prototype);
			ClockIntl.DateTimeFormat.supportedLocalesOf = NativeIntl.DateTimeFormat.supportedLocalesOf;
			return ClockIntl;
		}
		function enqueueJob(clock, job) {
			if (!clock.jobs) clock.jobs = [];
			clock.jobs.push(job);
		}
		function runJobs(clock) {
			if (!clock.jobs) return;
			for (let i = 0; i < clock.jobs.length; i++) {
				const job = clock.jobs[i];
				job.func.apply(null, job.args);
				checkIsNearInfiniteLimit(clock, i);
				if (clock.loopLimit && i > clock.loopLimit) throw getInfiniteLoopError(clock, job);
			}
			resetIsNearInfiniteLimit();
			clock.jobs = [];
		}
		/**
		* @param {Clock} clock
		* @param {Timer} timer
		* @returns {number} id of the created timer
		*/
		function addTimer(clock, timer) {
			if (timer.func === void 0) throw new Error("Callback must be provided to timer calls");
			if (addTimerReturnsObject) {
				if (typeof timer.func !== "function") throw new TypeError(`[ERR_INVALID_CALLBACK]: Callback must be a function. Received ${timer.func} of type ${typeof timer.func}`);
			}
			if (isNearInfiniteLimit) timer.error = /* @__PURE__ */ new Error();
			timer.type = timer.immediate ? "Immediate" : "Timeout";
			if (timer.hasOwnProperty("delay")) {
				if (typeof timer.delay !== "number") timer.delay = parseInt(timer.delay, 10);
				if (!isNumberFinite(timer.delay)) timer.delay = 0;
				timer.delay = timer.delay > maxTimeout ? 1 : timer.delay;
				timer.delay = Math.max(0, timer.delay);
			}
			if (timer.hasOwnProperty("interval")) {
				timer.type = "Interval";
				timer.interval = timer.interval > maxTimeout ? 1 : timer.interval;
			}
			if (timer.hasOwnProperty("animation")) {
				timer.type = "AnimationFrame";
				timer.animation = true;
			}
			if (timer.hasOwnProperty("idleCallback")) {
				timer.type = "IdleCallback";
				timer.idleCallback = true;
			}
			if (!clock.timers) clock.timers = {};
			timer.id = uniqueTimerId++;
			timer.createdAt = clock.now;
			timer.callAt = clock.now + (parseInt(timer.delay) || (clock.duringTick ? 1 : 0));
			clock.timers[timer.id] = timer;
			if (addTimerReturnsObject) {
				const res = {
					refed: true,
					ref: function() {
						this.refed = true;
						return res;
					},
					unref: function() {
						this.refed = false;
						return res;
					},
					hasRef: function() {
						return this.refed;
					},
					refresh: function() {
						timer.callAt = clock.now + (parseInt(timer.delay) || (clock.duringTick ? 1 : 0));
						clock.timers[timer.id] = timer;
						return res;
					},
					[Symbol.toPrimitive]: function() {
						return timer.id;
					}
				};
				return res;
			}
			return timer.id;
		}
		/**
		* Timer comparitor
		* @param {Timer} a
		* @param {Timer} b
		* @returns {number}
		*/
		function compareTimers(a, b) {
			if (a.callAt < b.callAt) return -1;
			if (a.callAt > b.callAt) return 1;
			if (a.immediate && !b.immediate) return -1;
			if (!a.immediate && b.immediate) return 1;
			if (a.createdAt < b.createdAt) return -1;
			if (a.createdAt > b.createdAt) return 1;
			if (a.id < b.id) return -1;
			if (a.id > b.id) return 1;
		}
		/**
		* @param {Clock} clock
		* @param {number} from
		* @param {number} to
		* @returns {Timer}
		*/
		function firstTimerInRange(clock, from, to) {
			const timers = clock.timers;
			let timer = null;
			let id, isInRange;
			for (id in timers) if (timers.hasOwnProperty(id)) {
				isInRange = inRange(from, to, timers[id]);
				if (isInRange && (!timer || compareTimers(timer, timers[id]) === 1)) timer = timers[id];
			}
			return timer;
		}
		/**
		* @param {Clock} clock
		* @returns {Timer}
		*/
		function firstTimer(clock) {
			const timers = clock.timers;
			let timer = null;
			let id;
			for (id in timers) if (timers.hasOwnProperty(id)) {
				if (!timer || compareTimers(timer, timers[id]) === 1) timer = timers[id];
			}
			return timer;
		}
		/**
		* @param {Clock} clock
		* @returns {Timer}
		*/
		function lastTimer(clock) {
			const timers = clock.timers;
			let timer = null;
			let id;
			for (id in timers) if (timers.hasOwnProperty(id)) {
				if (!timer || compareTimers(timer, timers[id]) === -1) timer = timers[id];
			}
			return timer;
		}
		/**
		* @param {Clock} clock
		* @param {Timer} timer
		*/
		function callTimer(clock, timer) {
			if (typeof timer.interval === "number") clock.timers[timer.id].callAt += timer.interval;
			else delete clock.timers[timer.id];
			if (typeof timer.func === "function") timer.func.apply(null, timer.args);
			else {
				const eval2 = eval;
				(function() {
					eval2(timer.func);
				})();
			}
		}
		/**
		* Gets clear handler name for a given timer type
		* @param {string} ttype
		*/
		function getClearHandler(ttype) {
			if (ttype === "IdleCallback" || ttype === "AnimationFrame") return `cancel${ttype}`;
			return `clear${ttype}`;
		}
		/**
		* Gets schedule handler name for a given timer type
		* @param {string} ttype
		*/
		function getScheduleHandler(ttype) {
			if (ttype === "IdleCallback" || ttype === "AnimationFrame") return `request${ttype}`;
			return `set${ttype}`;
		}
		/**
		* Creates an anonymous function to warn only once
		*/
		function createWarnOnce() {
			let calls = 0;
			return function(msg) {
				!calls++ && console.warn(msg);
			};
		}
		const warnOnce = createWarnOnce();
		/**
		* @param {Clock} clock
		* @param {number} timerId
		* @param {string} ttype
		*/
		function clearTimer(clock, timerId, ttype) {
			if (!timerId) return;
			if (!clock.timers) clock.timers = {};
			const id = Number(timerId);
			if (Number.isNaN(id) || id < idCounterStart) {
				const handlerName = getClearHandler(ttype);
				if (clock.shouldClearNativeTimers === true) {
					const nativeHandler = clock[`_${handlerName}`];
					return typeof nativeHandler === "function" ? nativeHandler(timerId) : void 0;
				}
				warnOnce(`FakeTimers: ${handlerName} was invoked to clear a native timer instead of one created by this library.
To automatically clean-up native timers, use \`shouldClearNativeTimers\`.`);
			}
			if (clock.timers.hasOwnProperty(id)) {
				const timer = clock.timers[id];
				if (timer.type === ttype || timer.type === "Timeout" && ttype === "Interval" || timer.type === "Interval" && ttype === "Timeout") delete clock.timers[id];
				else {
					const clear = getClearHandler(ttype);
					const schedule = getScheduleHandler(timer.type);
					throw new Error(`Cannot clear timer: timer created with ${schedule}() but cleared with ${clear}()`);
				}
			}
		}
		/**
		* @param {Clock} clock
		* @returns {Timer[]}
		*/
		function uninstall(clock) {
			let method, i, l;
			const installedHrTime = "_hrtime";
			const installedNextTick = "_nextTick";
			for (i = 0, l = clock.methods.length; i < l; i++) {
				method = clock.methods[i];
				if (method === "hrtime" && _global.process) _global.process.hrtime = clock[installedHrTime];
				else if (method === "nextTick" && _global.process) _global.process.nextTick = clock[installedNextTick];
				else if (method === "performance") {
					const originalPerfDescriptor = Object.getOwnPropertyDescriptor(clock, `_${method}`);
					if (originalPerfDescriptor && originalPerfDescriptor.get && !originalPerfDescriptor.set) Object.defineProperty(_global, method, originalPerfDescriptor);
					else if (originalPerfDescriptor.configurable) _global[method] = clock[`_${method}`];
				} else if (_global[method] && _global[method].hadOwnProperty) _global[method] = clock[`_${method}`];
				else try {
					delete _global[method];
				} catch (ignore) {}
				if (clock.timersModuleMethods !== void 0) for (let j = 0; j < clock.timersModuleMethods.length; j++) {
					const entry = clock.timersModuleMethods[j];
					timersModule[entry.methodName] = entry.original;
				}
				if (clock.timersPromisesModuleMethods !== void 0) for (let j = 0; j < clock.timersPromisesModuleMethods.length; j++) {
					const entry = clock.timersPromisesModuleMethods[j];
					timersPromisesModule[entry.methodName] = entry.original;
				}
			}
			clock.setTickMode("manual");
			clock.methods = [];
			for (const [listener, signal] of clock.abortListenerMap.entries()) {
				signal.removeEventListener("abort", listener);
				clock.abortListenerMap.delete(listener);
			}
			if (!clock.timers) return [];
			return Object.keys(clock.timers).map(function mapper(key) {
				return clock.timers[key];
			});
		}
		/**
		* @param {object} target the target containing the method to replace
		* @param {string} method the keyname of the method on the target
		* @param {Clock} clock
		*/
		function hijackMethod(target, method, clock) {
			clock[method].hadOwnProperty = Object.prototype.hasOwnProperty.call(target, method);
			clock[`_${method}`] = target[method];
			if (method === "Date") target[method] = clock[method];
			else if (method === "Intl") target[method] = clock[method];
			else if (method === "performance") {
				const originalPerfDescriptor = Object.getOwnPropertyDescriptor(target, method);
				if (originalPerfDescriptor && originalPerfDescriptor.get && !originalPerfDescriptor.set) {
					Object.defineProperty(clock, `_${method}`, originalPerfDescriptor);
					Object.defineProperty(target, method, Object.getOwnPropertyDescriptor(clock, method));
				} else target[method] = clock[method];
			} else {
				target[method] = function() {
					return clock[method].apply(clock, arguments);
				};
				Object.defineProperties(target[method], Object.getOwnPropertyDescriptors(clock[method]));
			}
			target[method].clock = clock;
		}
		/**
		* @param {Clock} clock
		* @param {number} advanceTimeDelta
		*/
		function doIntervalTick(clock, advanceTimeDelta) {
			clock.tick(advanceTimeDelta);
		}
		/**
		* @typedef {object} Timers
		* @property {setTimeout} setTimeout
		* @property {clearTimeout} clearTimeout
		* @property {setInterval} setInterval
		* @property {clearInterval} clearInterval
		* @property {Date} Date
		* @property {Intl} Intl
		* @property {SetImmediate=} setImmediate
		* @property {function(NodeImmediate): void=} clearImmediate
		* @property {function(number[]):number[]=} hrtime
		* @property {NextTick=} nextTick
		* @property {Performance=} performance
		* @property {RequestAnimationFrame=} requestAnimationFrame
		* @property {boolean=} queueMicrotask
		* @property {function(number): void=} cancelAnimationFrame
		* @property {RequestIdleCallback=} requestIdleCallback
		* @property {function(number): void=} cancelIdleCallback
		*/
		/** @type {Timers} */
		const timers = {
			setTimeout: _global.setTimeout,
			clearTimeout: _global.clearTimeout,
			setInterval: _global.setInterval,
			clearInterval: _global.clearInterval,
			Date: _global.Date
		};
		if (isPresent.setImmediate) timers.setImmediate = _global.setImmediate;
		if (isPresent.clearImmediate) timers.clearImmediate = _global.clearImmediate;
		if (isPresent.hrtime) timers.hrtime = _global.process.hrtime;
		if (isPresent.nextTick) timers.nextTick = _global.process.nextTick;
		if (isPresent.performance) timers.performance = _global.performance;
		if (isPresent.requestAnimationFrame) timers.requestAnimationFrame = _global.requestAnimationFrame;
		if (isPresent.queueMicrotask) timers.queueMicrotask = _global.queueMicrotask;
		if (isPresent.cancelAnimationFrame) timers.cancelAnimationFrame = _global.cancelAnimationFrame;
		if (isPresent.requestIdleCallback) timers.requestIdleCallback = _global.requestIdleCallback;
		if (isPresent.cancelIdleCallback) timers.cancelIdleCallback = _global.cancelIdleCallback;
		if (isPresent.Intl) timers.Intl = NativeIntl;
		const originalSetTimeout = _global.setImmediate || _global.setTimeout;
		const originalClearInterval = _global.clearInterval;
		const originalSetInterval = _global.setInterval;
		/**
		* @param {Date|number} [start] the system time - non-integer values are floored
		* @param {number} [loopLimit] maximum number of timers that will be run when calling runAll()
		* @returns {Clock}
		*/
		function createClock(start, loopLimit) {
			start = Math.floor(getEpoch(start));
			loopLimit = loopLimit || 1e3;
			let nanos = 0;
			const adjustedSystemTime = [0, 0];
			const clock = {
				now: start,
				Date: createDate(),
				loopLimit,
				tickMode: {
					mode: "manual",
					counter: 0,
					delta: void 0
				}
			};
			clock.Date.clock = clock;
			function getTimeToNextFrame() {
				return 16 - (clock.now - start) % 16;
			}
			function hrtime(prev) {
				const millisSinceStart = clock.now - adjustedSystemTime[0] - start;
				const secsSinceStart = Math.floor(millisSinceStart / 1e3);
				const remainderInNanos = (millisSinceStart - secsSinceStart * 1e3) * 1e6 + nanos - adjustedSystemTime[1];
				if (Array.isArray(prev)) {
					if (prev[1] > 1e9) throw new TypeError("Number of nanoseconds can't exceed a billion");
					const oldSecs = prev[0];
					let nanoDiff = remainderInNanos - prev[1];
					let secDiff = secsSinceStart - oldSecs;
					if (nanoDiff < 0) {
						nanoDiff += 1e9;
						secDiff -= 1;
					}
					return [secDiff, nanoDiff];
				}
				return [secsSinceStart, remainderInNanos];
			}
			/**
			* A high resolution timestamp in milliseconds.
			* @typedef {number} DOMHighResTimeStamp
			*/
			/**
			* performance.now()
			* @returns {DOMHighResTimeStamp}
			*/
			function fakePerformanceNow() {
				const hrt = hrtime();
				return hrt[0] * 1e3 + hrt[1] / 1e6;
			}
			if (isPresent.hrtimeBigint) hrtime.bigint = function() {
				const parts = hrtime();
				return BigInt(parts[0]) * BigInt(1e9) + BigInt(parts[1]);
			};
			if (isPresent.Intl) {
				clock.Intl = createIntl();
				clock.Intl.clock = clock;
			}
			/**
			* @param {TimerTickMode} tickModeConfig - The new configuration for how the clock should tick.
			*/
			clock.setTickMode = function(tickModeConfig) {
				const { mode: newMode, delta: newDelta } = tickModeConfig;
				const { mode: oldMode, delta: oldDelta } = clock.tickMode;
				if (newMode === oldMode && newDelta === oldDelta) return;
				if (oldMode === "interval") originalClearInterval(clock.attachedInterval);
				clock.tickMode = {
					counter: clock.tickMode.counter + 1,
					mode: newMode,
					delta: newDelta
				};
				if (newMode === "nextAsync") advanceUntilModeChanges();
				else if (newMode === "interval") createIntervalTick(clock, newDelta || 20);
			};
			async function advanceUntilModeChanges() {
				async function newMacrotask() {
					const channel = new MessageChannel();
					await new Promise((resolve) => {
						channel.port1.onmessage = () => {
							resolve();
							channel.port1.close();
						};
						channel.port2.postMessage(void 0);
					});
					channel.port1.close();
					channel.port2.close();
					await new Promise((resolve) => {
						originalSetTimeout(resolve);
					});
				}
				const { counter } = clock.tickMode;
				while (clock.tickMode.counter === counter) {
					await newMacrotask();
					if (clock.tickMode.counter !== counter) return;
					clock.next();
				}
			}
			function pauseAutoTickUntilFinished(promise) {
				if (clock.tickMode.mode !== "nextAsync") return promise;
				clock.setTickMode({ mode: "manual" });
				return promise.finally(() => {
					clock.setTickMode({ mode: "nextAsync" });
				});
			}
			clock.requestIdleCallback = function requestIdleCallback(func, timeout) {
				let timeToNextIdlePeriod = 0;
				if (clock.countTimers() > 0) timeToNextIdlePeriod = 50;
				const result = addTimer(clock, {
					func,
					args: Array.prototype.slice.call(arguments, 2),
					delay: typeof timeout === "undefined" ? timeToNextIdlePeriod : Math.min(timeout, timeToNextIdlePeriod),
					idleCallback: true
				});
				return Number(result);
			};
			clock.cancelIdleCallback = function cancelIdleCallback(timerId) {
				return clearTimer(clock, timerId, "IdleCallback");
			};
			clock.setTimeout = function setTimeout(func, timeout) {
				return addTimer(clock, {
					func,
					args: Array.prototype.slice.call(arguments, 2),
					delay: timeout
				});
			};
			if (typeof _global.Promise !== "undefined" && utilPromisify) clock.setTimeout[utilPromisify.custom] = function promisifiedSetTimeout(timeout, arg) {
				return new _global.Promise(function setTimeoutExecutor(resolve) {
					addTimer(clock, {
						func: resolve,
						args: [arg],
						delay: timeout
					});
				});
			};
			clock.clearTimeout = function clearTimeout(timerId) {
				return clearTimer(clock, timerId, "Timeout");
			};
			clock.nextTick = function nextTick(func) {
				return enqueueJob(clock, {
					func,
					args: Array.prototype.slice.call(arguments, 1),
					error: isNearInfiniteLimit ? /* @__PURE__ */ new Error() : null
				});
			};
			clock.queueMicrotask = function queueMicrotask(func) {
				return clock.nextTick(func);
			};
			clock.setInterval = function setInterval(func, timeout) {
				timeout = parseInt(timeout, 10);
				return addTimer(clock, {
					func,
					args: Array.prototype.slice.call(arguments, 2),
					delay: timeout,
					interval: timeout
				});
			};
			clock.clearInterval = function clearInterval(timerId) {
				return clearTimer(clock, timerId, "Interval");
			};
			if (isPresent.setImmediate) {
				clock.setImmediate = function setImmediate(func) {
					return addTimer(clock, {
						func,
						args: Array.prototype.slice.call(arguments, 1),
						immediate: true
					});
				};
				if (typeof _global.Promise !== "undefined" && utilPromisify) clock.setImmediate[utilPromisify.custom] = function promisifiedSetImmediate(arg) {
					return new _global.Promise(function setImmediateExecutor(resolve) {
						addTimer(clock, {
							func: resolve,
							args: [arg],
							immediate: true
						});
					});
				};
				clock.clearImmediate = function clearImmediate(timerId) {
					return clearTimer(clock, timerId, "Immediate");
				};
			}
			clock.countTimers = function countTimers() {
				return Object.keys(clock.timers || {}).length + (clock.jobs || []).length;
			};
			clock.requestAnimationFrame = function requestAnimationFrame(func) {
				const result = addTimer(clock, {
					func,
					delay: getTimeToNextFrame(),
					get args() {
						return [fakePerformanceNow()];
					},
					animation: true
				});
				return Number(result);
			};
			clock.cancelAnimationFrame = function cancelAnimationFrame(timerId) {
				return clearTimer(clock, timerId, "AnimationFrame");
			};
			clock.runMicrotasks = function runMicrotasks() {
				runJobs(clock);
			};
			/**
			* @param {number|string} tickValue milliseconds or a string parseable by parseTime
			* @param {boolean} isAsync
			* @param {Function} resolve
			* @param {Function} reject
			* @returns {number|undefined} will return the new `now` value or nothing for async
			*/
			function doTick(tickValue, isAsync, resolve, reject) {
				const msFloat = typeof tickValue === "number" ? tickValue : parseTime(tickValue);
				const ms = Math.floor(msFloat);
				const remainder = nanoRemainder(msFloat);
				let nanosTotal = nanos + remainder;
				let tickTo = clock.now + ms;
				if (msFloat < 0) throw new TypeError("Negative ticks are not supported");
				if (nanosTotal >= 1e6) {
					tickTo += 1;
					nanosTotal -= 1e6;
				}
				nanos = nanosTotal;
				let tickFrom = clock.now;
				let previous = clock.now;
				let timer, firstException, oldNow, nextPromiseTick, compensationCheck, postTimerCall;
				clock.duringTick = true;
				oldNow = clock.now;
				runJobs(clock);
				if (oldNow !== clock.now) {
					tickFrom += clock.now - oldNow;
					tickTo += clock.now - oldNow;
				}
				function doTickInner() {
					timer = firstTimerInRange(clock, tickFrom, tickTo);
					while (timer && tickFrom <= tickTo) {
						if (clock.timers[timer.id]) {
							tickFrom = timer.callAt;
							clock.now = timer.callAt;
							oldNow = clock.now;
							try {
								runJobs(clock);
								callTimer(clock, timer);
							} catch (e) {
								firstException = firstException || e;
							}
							if (isAsync) {
								originalSetTimeout(nextPromiseTick);
								return;
							}
							compensationCheck();
						}
						postTimerCall();
					}
					oldNow = clock.now;
					runJobs(clock);
					if (oldNow !== clock.now) {
						tickFrom += clock.now - oldNow;
						tickTo += clock.now - oldNow;
					}
					clock.duringTick = false;
					timer = firstTimerInRange(clock, tickFrom, tickTo);
					if (timer) try {
						clock.tick(tickTo - clock.now);
					} catch (e) {
						firstException = firstException || e;
					}
					else {
						clock.now = tickTo;
						nanos = nanosTotal;
					}
					if (firstException) throw firstException;
					if (isAsync) resolve(clock.now);
					else return clock.now;
				}
				nextPromiseTick = isAsync && function() {
					try {
						compensationCheck();
						postTimerCall();
						doTickInner();
					} catch (e) {
						reject(e);
					}
				};
				compensationCheck = function() {
					if (oldNow !== clock.now) {
						tickFrom += clock.now - oldNow;
						tickTo += clock.now - oldNow;
						previous += clock.now - oldNow;
					}
				};
				postTimerCall = function() {
					timer = firstTimerInRange(clock, previous, tickTo);
					previous = tickFrom;
				};
				return doTickInner();
			}
			/**
			* @param {string|number} tickValue number of milliseconds or a human-readable value like "01:11:15"
			* @returns {number} will return the new `now` value
			*/
			clock.tick = function tick(tickValue) {
				return doTick(tickValue, false);
			};
			if (typeof _global.Promise !== "undefined")
 /**
			* @param {string|number} tickValue number of milliseconds or a human-readable value like "01:11:15"
			* @returns {Promise}
			*/
			clock.tickAsync = function tickAsync(tickValue) {
				return pauseAutoTickUntilFinished(new _global.Promise(function(resolve, reject) {
					originalSetTimeout(function() {
						try {
							doTick(tickValue, true, resolve, reject);
						} catch (e) {
							reject(e);
						}
					});
				}));
			};
			clock.next = function next() {
				runJobs(clock);
				const timer = firstTimer(clock);
				if (!timer) return clock.now;
				clock.duringTick = true;
				try {
					clock.now = timer.callAt;
					callTimer(clock, timer);
					runJobs(clock);
					return clock.now;
				} finally {
					clock.duringTick = false;
				}
			};
			if (typeof _global.Promise !== "undefined") clock.nextAsync = function nextAsync() {
				return pauseAutoTickUntilFinished(new _global.Promise(function(resolve, reject) {
					originalSetTimeout(function() {
						try {
							const timer = firstTimer(clock);
							if (!timer) {
								resolve(clock.now);
								return;
							}
							let err;
							clock.duringTick = true;
							clock.now = timer.callAt;
							try {
								callTimer(clock, timer);
							} catch (e) {
								err = e;
							}
							clock.duringTick = false;
							originalSetTimeout(function() {
								if (err) reject(err);
								else resolve(clock.now);
							});
						} catch (e) {
							reject(e);
						}
					});
				}));
			};
			clock.runAll = function runAll() {
				let numTimers, i;
				runJobs(clock);
				for (i = 0; i < clock.loopLimit; i++) {
					if (!clock.timers) {
						resetIsNearInfiniteLimit();
						return clock.now;
					}
					numTimers = Object.keys(clock.timers).length;
					if (numTimers === 0) {
						resetIsNearInfiniteLimit();
						return clock.now;
					}
					clock.next();
					checkIsNearInfiniteLimit(clock, i);
				}
				throw getInfiniteLoopError(clock, firstTimer(clock));
			};
			clock.runToFrame = function runToFrame() {
				return clock.tick(getTimeToNextFrame());
			};
			if (typeof _global.Promise !== "undefined") clock.runAllAsync = function runAllAsync() {
				return pauseAutoTickUntilFinished(new _global.Promise(function(resolve, reject) {
					let i = 0;
					/**
					*
					*/
					function doRun() {
						originalSetTimeout(function() {
							try {
								runJobs(clock);
								let numTimers;
								if (i < clock.loopLimit) {
									if (!clock.timers) {
										resetIsNearInfiniteLimit();
										resolve(clock.now);
										return;
									}
									numTimers = Object.keys(clock.timers).length;
									if (numTimers === 0) {
										resetIsNearInfiniteLimit();
										resolve(clock.now);
										return;
									}
									clock.next();
									i++;
									doRun();
									checkIsNearInfiniteLimit(clock, i);
									return;
								}
								reject(getInfiniteLoopError(clock, firstTimer(clock)));
							} catch (e) {
								reject(e);
							}
						});
					}
					doRun();
				}));
			};
			clock.runToLast = function runToLast() {
				const timer = lastTimer(clock);
				if (!timer) {
					runJobs(clock);
					return clock.now;
				}
				return clock.tick(timer.callAt - clock.now);
			};
			if (typeof _global.Promise !== "undefined") clock.runToLastAsync = function runToLastAsync() {
				return pauseAutoTickUntilFinished(new _global.Promise(function(resolve, reject) {
					originalSetTimeout(function() {
						try {
							const timer = lastTimer(clock);
							if (!timer) {
								runJobs(clock);
								resolve(clock.now);
							}
							resolve(clock.tickAsync(timer.callAt - clock.now));
						} catch (e) {
							reject(e);
						}
					});
				}));
			};
			clock.reset = function reset() {
				nanos = 0;
				clock.timers = {};
				clock.jobs = [];
				clock.now = start;
			};
			clock.setSystemTime = function setSystemTime(systemTime) {
				const newNow = getEpoch(systemTime);
				const difference = newNow - clock.now;
				let id, timer;
				adjustedSystemTime[0] = adjustedSystemTime[0] + difference;
				adjustedSystemTime[1] = adjustedSystemTime[1] + nanos;
				clock.now = newNow;
				nanos = 0;
				for (id in clock.timers) if (clock.timers.hasOwnProperty(id)) {
					timer = clock.timers[id];
					timer.createdAt += difference;
					timer.callAt += difference;
				}
			};
			/**
			* @param {string|number} tickValue number of milliseconds or a human-readable value like "01:11:15"
			* @returns {number} will return the new `now` value
			*/
			clock.jump = function jump(tickValue) {
				const msFloat = typeof tickValue === "number" ? tickValue : parseTime(tickValue);
				const ms = Math.floor(msFloat);
				for (const timer of Object.values(clock.timers)) if (clock.now + ms > timer.callAt) timer.callAt = clock.now + ms;
				clock.tick(ms);
			};
			if (isPresent.performance) {
				clock.performance = Object.create(null);
				clock.performance.now = fakePerformanceNow;
			}
			if (isPresent.hrtime) clock.hrtime = hrtime;
			return clock;
		}
		function createIntervalTick(clock, delta) {
			clock.attachedInterval = originalSetInterval(doIntervalTick.bind(null, clock, delta), delta);
		}
		/**
		* @param {Config=} [config] Optional config
		* @returns {Clock}
		*/
		function install(config) {
			if (arguments.length > 1 || config instanceof Date || Array.isArray(config) || typeof config === "number") throw new TypeError(`FakeTimers.install called with ${String(config)} install requires an object parameter`);
			if (_global.Date.isFake === true) throw new TypeError("Can't install fake timers twice on the same global object.");
			config = typeof config !== "undefined" ? config : {};
			config.shouldAdvanceTime = config.shouldAdvanceTime || false;
			config.advanceTimeDelta = config.advanceTimeDelta || 20;
			config.shouldClearNativeTimers = config.shouldClearNativeTimers || false;
			if (config.target) throw new TypeError("config.target is no longer supported. Use `withGlobal(target)` instead.");
			/**
			* @param {string} timer/object the name of the thing that is not present
			* @param timer
			*/
			function handleMissingTimer(timer) {
				if (config.ignoreMissingTimers) return;
				throw new ReferenceError(`non-existent timers and/or objects cannot be faked: '${timer}'`);
			}
			let i, l;
			const clock = createClock(config.now, config.loopLimit);
			clock.shouldClearNativeTimers = config.shouldClearNativeTimers;
			clock.uninstall = function() {
				return uninstall(clock);
			};
			clock.abortListenerMap = /* @__PURE__ */ new Map();
			clock.methods = config.toFake || [];
			if (clock.methods.length === 0) clock.methods = Object.keys(timers);
			if (config.shouldAdvanceTime === true) clock.setTickMode({
				mode: "interval",
				delta: config.advanceTimeDelta
			});
			if (clock.methods.includes("performance")) {
				const proto = (() => {
					if (hasPerformanceConstructorPrototype) return _global.performance.constructor.prototype;
					if (hasPerformancePrototype) return _global.Performance.prototype;
				})();
				if (proto) {
					Object.getOwnPropertyNames(proto).forEach(function(name) {
						if (name !== "now") clock.performance[name] = name.indexOf("getEntries") === 0 ? NOOP_ARRAY : NOOP;
					});
					clock.performance.mark = (name) => new FakePerformanceEntry(name, "mark", 0, 0);
					clock.performance.measure = (name) => new FakePerformanceEntry(name, "measure", 0, 100);
					clock.performance.timeOrigin = getEpoch(config.now);
				} else if ((config.toFake || []).includes("performance")) return handleMissingTimer("performance");
			}
			if (_global === globalObject && timersModule) clock.timersModuleMethods = [];
			if (_global === globalObject && timersPromisesModule) clock.timersPromisesModuleMethods = [];
			for (i = 0, l = clock.methods.length; i < l; i++) {
				const nameOfMethodToReplace = clock.methods[i];
				if (!isPresent[nameOfMethodToReplace]) {
					handleMissingTimer(nameOfMethodToReplace);
					continue;
				}
				if (nameOfMethodToReplace === "hrtime") {
					if (_global.process && typeof _global.process.hrtime === "function") hijackMethod(_global.process, nameOfMethodToReplace, clock);
				} else if (nameOfMethodToReplace === "nextTick") {
					if (_global.process && typeof _global.process.nextTick === "function") hijackMethod(_global.process, nameOfMethodToReplace, clock);
				} else hijackMethod(_global, nameOfMethodToReplace, clock);
				if (clock.timersModuleMethods !== void 0 && timersModule[nameOfMethodToReplace]) {
					const original = timersModule[nameOfMethodToReplace];
					clock.timersModuleMethods.push({
						methodName: nameOfMethodToReplace,
						original
					});
					timersModule[nameOfMethodToReplace] = _global[nameOfMethodToReplace];
				}
				if (clock.timersPromisesModuleMethods !== void 0) {
					if (nameOfMethodToReplace === "setTimeout") {
						clock.timersPromisesModuleMethods.push({
							methodName: "setTimeout",
							original: timersPromisesModule.setTimeout
						});
						timersPromisesModule.setTimeout = (delay, value, options = {}) => new Promise((resolve, reject) => {
							const abort = () => {
								options.signal.removeEventListener("abort", abort);
								clock.abortListenerMap.delete(abort);
								clock.clearTimeout(handle);
								reject(options.signal.reason);
							};
							const handle = clock.setTimeout(() => {
								if (options.signal) {
									options.signal.removeEventListener("abort", abort);
									clock.abortListenerMap.delete(abort);
								}
								resolve(value);
							}, delay);
							if (options.signal) if (options.signal.aborted) abort();
							else {
								options.signal.addEventListener("abort", abort);
								clock.abortListenerMap.set(abort, options.signal);
							}
						});
					} else if (nameOfMethodToReplace === "setImmediate") {
						clock.timersPromisesModuleMethods.push({
							methodName: "setImmediate",
							original: timersPromisesModule.setImmediate
						});
						timersPromisesModule.setImmediate = (value, options = {}) => new Promise((resolve, reject) => {
							const abort = () => {
								options.signal.removeEventListener("abort", abort);
								clock.abortListenerMap.delete(abort);
								clock.clearImmediate(handle);
								reject(options.signal.reason);
							};
							const handle = clock.setImmediate(() => {
								if (options.signal) {
									options.signal.removeEventListener("abort", abort);
									clock.abortListenerMap.delete(abort);
								}
								resolve(value);
							});
							if (options.signal) if (options.signal.aborted) abort();
							else {
								options.signal.addEventListener("abort", abort);
								clock.abortListenerMap.set(abort, options.signal);
							}
						});
					} else if (nameOfMethodToReplace === "setInterval") {
						clock.timersPromisesModuleMethods.push({
							methodName: "setInterval",
							original: timersPromisesModule.setInterval
						});
						timersPromisesModule.setInterval = (delay, value, options = {}) => ({ [Symbol.asyncIterator]: () => {
							const createResolvable = () => {
								let resolve, reject;
								const promise = new Promise((res, rej) => {
									resolve = res;
									reject = rej;
								});
								promise.resolve = resolve;
								promise.reject = reject;
								return promise;
							};
							let done = false;
							let hasThrown = false;
							let returnCall;
							let nextAvailable = 0;
							const nextQueue = [];
							const handle = clock.setInterval(() => {
								if (nextQueue.length > 0) nextQueue.shift().resolve();
								else nextAvailable++;
							}, delay);
							const abort = () => {
								options.signal.removeEventListener("abort", abort);
								clock.abortListenerMap.delete(abort);
								clock.clearInterval(handle);
								done = true;
								for (const resolvable of nextQueue) resolvable.resolve();
							};
							if (options.signal) if (options.signal.aborted) done = true;
							else {
								options.signal.addEventListener("abort", abort);
								clock.abortListenerMap.set(abort, options.signal);
							}
							return {
								next: async () => {
									if (options.signal?.aborted && !hasThrown) {
										hasThrown = true;
										throw options.signal.reason;
									}
									if (done) return {
										done: true,
										value: void 0
									};
									if (nextAvailable > 0) {
										nextAvailable--;
										return {
											done: false,
											value
										};
									}
									const resolvable = createResolvable();
									nextQueue.push(resolvable);
									await resolvable;
									if (returnCall && nextQueue.length === 0) returnCall.resolve();
									if (options.signal?.aborted && !hasThrown) {
										hasThrown = true;
										throw options.signal.reason;
									}
									if (done) return {
										done: true,
										value: void 0
									};
									return {
										done: false,
										value
									};
								},
								return: async () => {
									if (done) return {
										done: true,
										value: void 0
									};
									if (nextQueue.length > 0) {
										returnCall = createResolvable();
										await returnCall;
									}
									clock.clearInterval(handle);
									done = true;
									if (options.signal) {
										options.signal.removeEventListener("abort", abort);
										clock.abortListenerMap.delete(abort);
									}
									return {
										done: true,
										value: void 0
									};
								}
							};
						} });
					}
				}
			}
			return clock;
		}
		return {
			timers,
			createClock,
			install,
			withGlobal
		};
	}
	/**
	* @typedef {object} FakeTimers
	* @property {Timers} timers
	* @property {createClock} createClock
	* @property {Function} install
	* @property {withGlobal} withGlobal
	*/
	/** @type {FakeTimers} */
	const defaultImplementation = withGlobal(globalObject);
	fakeTimersSrc.timers = defaultImplementation.timers;
	fakeTimersSrc.createClock = defaultImplementation.createClock;
	fakeTimersSrc.install = defaultImplementation.install;
	fakeTimersSrc.withGlobal = withGlobal;
	return fakeTimersSrc;
}
var fakeTimersSrcExports = requireFakeTimersSrc();
var FakeTimers = class {
	_global;
	_clock;
	_fakingTime;
	_fakingDate;
	_fakeTimers;
	_userConfig;
	_now = RealDate.now;
	constructor({ global, config }) {
		this._userConfig = config;
		this._fakingDate = null;
		this._fakingTime = false;
		this._fakeTimers = fakeTimersSrcExports.withGlobal(global);
		this._global = global;
	}
	clearAllTimers() {
		if (this._fakingTime) this._clock.reset();
	}
	dispose() {
		this.useRealTimers();
	}
	runAllTimers() {
		if (this._checkFakeTimers()) this._clock.runAll();
	}
	async runAllTimersAsync() {
		if (this._checkFakeTimers()) await this._clock.runAllAsync();
	}
	runOnlyPendingTimers() {
		if (this._checkFakeTimers()) this._clock.runToLast();
	}
	async runOnlyPendingTimersAsync() {
		if (this._checkFakeTimers()) await this._clock.runToLastAsync();
	}
	advanceTimersToNextTimer(steps = 1) {
		if (this._checkFakeTimers()) for (let i = steps; i > 0; i--) {
			this._clock.next();
			this._clock.tick(0);
			if (this._clock.countTimers() === 0) break;
		}
	}
	async advanceTimersToNextTimerAsync(steps = 1) {
		if (this._checkFakeTimers()) for (let i = steps; i > 0; i--) {
			await this._clock.nextAsync();
			this._clock.tick(0);
			if (this._clock.countTimers() === 0) break;
		}
	}
	advanceTimersByTime(msToRun) {
		if (this._checkFakeTimers()) this._clock.tick(msToRun);
	}
	async advanceTimersByTimeAsync(msToRun) {
		if (this._checkFakeTimers()) await this._clock.tickAsync(msToRun);
	}
	advanceTimersToNextFrame() {
		if (this._checkFakeTimers()) this._clock.runToFrame();
	}
	runAllTicks() {
		if (this._checkFakeTimers()) this._clock.runMicrotasks();
	}
	useRealTimers() {
		if (this._fakingDate) {
			resetDate();
			this._fakingDate = null;
		}
		if (this._fakingTime) {
			this._clock.uninstall();
			this._fakingTime = false;
		}
	}
	useFakeTimers() {
		const fakeDate = this._fakingDate || Date.now();
		if (this._fakingDate) {
			resetDate();
			this._fakingDate = null;
		}
		if (this._fakingTime) this._clock.uninstall();
		const toFake = Object.keys(this._fakeTimers.timers).filter((timer) => timer !== "nextTick" && timer !== "queueMicrotask");
		if (this._userConfig?.toFake?.includes("nextTick") && isChildProcess()) throw new Error("process.nextTick cannot be mocked inside child_process");
		this._clock = this._fakeTimers.install({
			now: fakeDate,
			...this._userConfig,
			toFake: this._userConfig?.toFake || toFake,
			ignoreMissingTimers: true
		});
		this._fakingTime = true;
	}
	reset() {
		if (this._checkFakeTimers()) {
			const { now } = this._clock;
			this._clock.reset();
			this._clock.setSystemTime(now);
		}
	}
	setSystemTime(now) {
		const date = typeof now === "undefined" || now instanceof Date ? now : new Date(now);
		if (this._fakingTime) this._clock.setSystemTime(date);
		else {
			this._fakingDate = date ?? new Date(this.getRealSystemTime());
			mockDate(this._fakingDate);
		}
	}
	getMockedSystemTime() {
		return this._fakingTime ? new Date(this._clock.now) : this._fakingDate;
	}
	getRealSystemTime() {
		return this._now();
	}
	getTimerCount() {
		if (this._checkFakeTimers()) return this._clock.countTimers();
		return 0;
	}
	setTimerTickMode(mode, interval) {
		if (this._checkFakeTimers()) if (mode === "manual") this._clock.setTickMode({ mode: "manual" });
		else if (mode === "nextTimerAsync") this._clock.setTickMode({ mode: "nextAsync" });
		else if (mode === "interval") this._clock.setTickMode({
			mode: "interval",
			delta: interval
		});
		else throw new Error(`Invalid tick mode: ${mode}`);
	}
	configure(config) {
		this._userConfig = config;
	}
	isFakeTimers() {
		return this._fakingTime;
	}
	_checkFakeTimers() {
		if (!this._fakingTime) throw new Error("A function to advance timers was called but the timers APIs are not mocked. Call `vi.useFakeTimers()` in the test file first.");
		return this._fakingTime;
	}
};
function copyStackTrace$1(target, source) {
	if (source.stack !== void 0) target.stack = source.stack.replace(source.message, target.message);
	return target;
}
function waitFor(callback, options = {}) {
	const { setTimeout, setInterval, clearTimeout, clearInterval } = getSafeTimers();
	const { interval = 50, timeout = 1e3 } = typeof options === "number" ? { timeout: options } : options;
	const STACK_TRACE_ERROR = /* @__PURE__ */ new Error("STACK_TRACE_ERROR");
	return new Promise((resolve, reject) => {
		let lastError;
		let promiseStatus = "idle";
		let timeoutId;
		let intervalId;
		const onResolve = (result) => {
			if (timeoutId) clearTimeout(timeoutId);
			if (intervalId) clearInterval(intervalId);
			resolve(result);
		};
		const handleTimeout = () => {
			if (intervalId) clearInterval(intervalId);
			let error = lastError;
			if (!error) error = copyStackTrace$1(/* @__PURE__ */ new Error("Timed out in waitFor!"), STACK_TRACE_ERROR);
			reject(error);
		};
		const checkCallback = () => {
			if (vi.isFakeTimers()) vi.advanceTimersByTime(interval);
			if (promiseStatus === "pending") return;
			try {
				const result = callback();
				if (result !== null && typeof result === "object" && typeof result.then === "function") {
					const thenable = result;
					promiseStatus = "pending";
					thenable.then((resolvedValue) => {
						promiseStatus = "resolved";
						onResolve(resolvedValue);
					}, (rejectedValue) => {
						promiseStatus = "rejected";
						lastError = rejectedValue;
					});
				} else {
					onResolve(result);
					return true;
				}
			} catch (error) {
				lastError = error;
			}
		};
		if (checkCallback() === true) return;
		timeoutId = setTimeout(handleTimeout, timeout);
		intervalId = setInterval(checkCallback, interval);
	});
}
function waitUntil(callback, options = {}) {
	const { setTimeout, setInterval, clearTimeout, clearInterval } = getSafeTimers();
	const { interval = 50, timeout = 1e3 } = typeof options === "number" ? { timeout: options } : options;
	const STACK_TRACE_ERROR = /* @__PURE__ */ new Error("STACK_TRACE_ERROR");
	return new Promise((resolve, reject) => {
		let promiseStatus = "idle";
		let timeoutId;
		let intervalId;
		const onReject = (error) => {
			if (intervalId) clearInterval(intervalId);
			if (!error) error = copyStackTrace$1(/* @__PURE__ */ new Error("Timed out in waitUntil!"), STACK_TRACE_ERROR);
			reject(error);
		};
		const onResolve = (result) => {
			if (!result) return;
			if (timeoutId) clearTimeout(timeoutId);
			if (intervalId) clearInterval(intervalId);
			resolve(result);
			return true;
		};
		const checkCallback = () => {
			if (vi.isFakeTimers()) vi.advanceTimersByTime(interval);
			if (promiseStatus === "pending") return;
			try {
				const result = callback();
				if (result !== null && typeof result === "object" && typeof result.then === "function") {
					const thenable = result;
					promiseStatus = "pending";
					thenable.then((resolvedValue) => {
						promiseStatus = "resolved";
						onResolve(resolvedValue);
					}, (rejectedValue) => {
						promiseStatus = "rejected";
						onReject(rejectedValue);
					});
				} else return onResolve(result);
			} catch (error) {
				onReject(error);
			}
		};
		if (checkCallback() === true) return;
		timeoutId = setTimeout(onReject, timeout);
		intervalId = setInterval(checkCallback, interval);
	});
}
function createVitest() {
	let _config = null;
	const state = () => getWorkerState();
	let _timers;
	const timers = () => _timers ||= new FakeTimers({
		global: globalThis,
		config: state().config.fakeTimers
	});
	const _stubsGlobal = /* @__PURE__ */ new Map();
	const _stubsEnv = /* @__PURE__ */ new Map();
	const _envBooleans = [
		"PROD",
		"DEV",
		"SSR"
	];
	const utils = {
		useFakeTimers(config) {
			if (isChildProcess()) {
				if (config?.toFake?.includes("nextTick") || state().config?.fakeTimers?.toFake?.includes("nextTick")) throw new Error("vi.useFakeTimers({ toFake: [\"nextTick\"] }) is not supported in node:child_process. Use --pool=threads if mocking nextTick is required.");
			}
			if (config) timers().configure({
				...state().config.fakeTimers,
				...config
			});
			else timers().configure(state().config.fakeTimers);
			timers().useFakeTimers();
			return utils;
		},
		isFakeTimers() {
			return timers().isFakeTimers();
		},
		useRealTimers() {
			timers().useRealTimers();
			return utils;
		},
		runOnlyPendingTimers() {
			timers().runOnlyPendingTimers();
			return utils;
		},
		async runOnlyPendingTimersAsync() {
			await timers().runOnlyPendingTimersAsync();
			return utils;
		},
		runAllTimers() {
			timers().runAllTimers();
			return utils;
		},
		async runAllTimersAsync() {
			await timers().runAllTimersAsync();
			return utils;
		},
		runAllTicks() {
			timers().runAllTicks();
			return utils;
		},
		advanceTimersByTime(ms) {
			timers().advanceTimersByTime(ms);
			return utils;
		},
		async advanceTimersByTimeAsync(ms) {
			await timers().advanceTimersByTimeAsync(ms);
			return utils;
		},
		advanceTimersToNextTimer() {
			timers().advanceTimersToNextTimer();
			return utils;
		},
		async advanceTimersToNextTimerAsync() {
			await timers().advanceTimersToNextTimerAsync();
			return utils;
		},
		advanceTimersToNextFrame() {
			timers().advanceTimersToNextFrame();
			return utils;
		},
		getTimerCount() {
			return timers().getTimerCount();
		},
		setSystemTime(time) {
			timers().setSystemTime(time);
			return utils;
		},
		getMockedSystemTime() {
			return timers().getMockedSystemTime();
		},
		getRealSystemTime() {
			return timers().getRealSystemTime();
		},
		clearAllTimers() {
			timers().clearAllTimers();
			return utils;
		},
		setTimerTickMode(mode, interval) {
			timers().setTimerTickMode(mode, interval);
			return utils;
		},
		spyOn,
		fn,
		waitFor,
		waitUntil,
		defineHelper: (fn) => {
			return function __VITEST_HELPER__(...args) {
				const result = fn.apply(this, args);
				if (result && typeof result === "object" && typeof result.then === "function") return (async function __VITEST_HELPER__() {
					return await result;
				})();
				return result;
			};
		},
		hoisted(factory) {
			assertTypes(factory, "\"vi.hoisted\" factory", ["function"]);
			return factory();
		},
		mock(path, factory) {
			if (typeof path !== "string") throw new TypeError(`vi.mock() expects a string path, but received a ${typeof path}`);
			const importer = getImporter("mock");
			_mocker().queueMock(path, importer, typeof factory === "function" ? () => factory(() => _mocker().importActual(path, importer, _mocker().getMockContext().callstack)) : factory);
		},
		unmock(path) {
			if (typeof path !== "string") throw new TypeError(`vi.unmock() expects a string path, but received a ${typeof path}`);
			_mocker().queueUnmock(path, getImporter("unmock"));
		},
		doMock(path, factory) {
			if (typeof path !== "string") throw new TypeError(`vi.doMock() expects a string path, but received a ${typeof path}`);
			const importer = getImporter("doMock");
			_mocker().queueMock(path, importer, typeof factory === "function" ? () => factory(() => _mocker().importActual(path, importer, _mocker().getMockContext().callstack)) : factory);
			const rv = {};
			if (Symbol.dispose) rv[Symbol.dispose] = () => {
				_mocker().queueUnmock(path, importer);
			};
			return rv;
		},
		doUnmock(path) {
			if (typeof path !== "string") throw new TypeError(`vi.doUnmock() expects a string path, but received a ${typeof path}`);
			const importer = getImporter("doUnmock");
			_mocker().queueUnmock(path, importer);
		},
		async importActual(path) {
			const importer = getImporter("importActual");
			return _mocker().importActual(path, importer, _mocker().getMockContext().callstack);
		},
		async importMock(path) {
			const importer = getImporter("importMock");
			return _mocker().importMock(path, importer);
		},
		mockObject(value, options) {
			return _mocker().mockObject({ value }, void 0, options?.spy ? "autospy" : "automock").value;
		},
		mocked(item, _options = {}) {
			return item;
		},
		isMockFunction(fn) {
			return isMockFunction(fn);
		},
		clearAllMocks() {
			clearAllMocks();
			return utils;
		},
		resetAllMocks() {
			resetAllMocks();
			return utils;
		},
		restoreAllMocks() {
			restoreAllMocks();
			return utils;
		},
		stubGlobal(name, value) {
			if (!_stubsGlobal.has(name)) _stubsGlobal.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
			Object.defineProperty(globalThis, name, {
				value,
				writable: true,
				configurable: true,
				enumerable: true
			});
			return utils;
		},
		stubEnv(name, value) {
			const env = state().metaEnv;
			if (!_stubsEnv.has(name)) _stubsEnv.set(name, env[name]);
			if (_envBooleans.includes(name)) env[name] = value ? "1" : "";
			else if (value === void 0) delete env[name];
			else env[name] = String(value);
			return utils;
		},
		unstubAllGlobals() {
			_stubsGlobal.forEach((original, name) => {
				if (!original) Reflect.deleteProperty(globalThis, name);
				else Object.defineProperty(globalThis, name, original);
			});
			_stubsGlobal.clear();
			return utils;
		},
		unstubAllEnvs() {
			const env = state().metaEnv;
			_stubsEnv.forEach((original, name) => {
				if (original === void 0) delete env[name];
				else env[name] = original;
			});
			_stubsEnv.clear();
			return utils;
		},
		resetModules() {
			resetModules(state().evaluatedModules);
			return utils;
		},
		async dynamicImportSettled() {
			return waitForImportsToResolve();
		},
		setConfig(config) {
			if (!_config) _config = { ...state().config };
			Object.assign(state().config, config);
		},
		resetConfig() {
			if (_config) Object.assign(state().config, _config);
		}
	};
	return utils;
}
const vi = createVitest();
function _mocker() {
	return typeof __vitest_mocker__ !== "undefined" ? __vitest_mocker__ : new Proxy({}, { get(_, name) {
		throw new Error(`Vitest mocker was not initialized in this environment. vi.${String(name)}() is forbidden.`);
	} });
}
function getImporter(name) {
	const stackArray = createSimpleStackTrace({ stackTraceLimit: 5 }).split("\n");
	return parseSingleStack(stackArray[stackArray.findLastIndex((stack) => {
		return stack.includes(` at Object.${name}`) || stack.includes(`${name}@`) || stack.includes(` at ${name} (`);
	}) + 1])?.file || "";
}
const unsupported = [
	"matchSnapshot",
	"toMatchSnapshot",
	"toMatchInlineSnapshot",
	"toThrowErrorMatchingSnapshot",
	"toThrowErrorMatchingInlineSnapshot",
	"throws",
	"Throw",
	"throw",
	"toThrow",
	"toThrowError"
];
/**
* Attaches a `cause` property to the error if missing, copies the stack trace from the source, and throws.
*
* @param error - The error to throw
* @param source - Error to copy the stack trace from
*
* @throws Always throws the provided error with an amended stack trace
*/
function throwWithCause(error, source) {
	if (error.cause == null) error.cause = /* @__PURE__ */ new Error("Matcher did not succeed in time.");
	throw copyStackTrace(error, source);
}
function createExpectPoll(expect) {
	return function poll(fn, options = {}) {
		const defaults = getWorkerState().config.expect?.poll ?? {};
		const { interval = defaults.interval ?? 50, timeout = defaults.timeout ?? 1e3, message } = options;
		const assertion = expect(null, message).withContext({ poll: true });
		fn = fn.bind(assertion);
		utils_exports.flag(assertion, "_poll.fn", fn);
		utils_exports.flag(assertion, "_poll.timeout", timeout);
		utils_exports.flag(assertion, "_poll.interval", interval);
		const test = utils_exports.flag(assertion, "vitest-test");
		if (!test) throw new Error("expect.poll() must be called inside a test");
		const proxy = new Proxy(assertion, { get(target, key, receiver) {
			const assertionFunction = Reflect.get(target, key, receiver);
			if (typeof assertionFunction !== "function") return assertionFunction instanceof Assertion ? proxy : assertionFunction;
			if (key === "assert") return assertionFunction;
			if (typeof key === "string" && unsupported.includes(key)) throw new SyntaxError(`expect.poll() is not supported in combination with .${key}(). Use vi.waitFor() if your assertion condition is unstable.`);
			return function __VITEST_POLL_CHAIN__(...args) {
				const STACK_TRACE_ERROR = /* @__PURE__ */ new Error("STACK_TRACE_ERROR");
				const promise = async () => {
					utils_exports.flag(assertion, "_name", key);
					utils_exports.flag(assertion, "error", STACK_TRACE_ERROR);
					const onSettled = utils_exports.flag(assertion, "_poll.onSettled");
					if (Object.getOwnPropertyDescriptor(assertionFunction, "__vitest_poll_takeover__")?.value) try {
						const output = await assertionFunction.call(assertion, ...args);
						await onSettled?.({
							assertion,
							status: "pass"
						});
						return output;
					} catch (err) {
						await onSettled?.({
							assertion,
							status: "fail"
						});
						throwWithCause(err, STACK_TRACE_ERROR);
					}
					const { setTimeout, clearTimeout } = getSafeTimers();
					let executionPhase = "fn";
					let hasTimedOut = false;
					const timerId = setTimeout(() => {
						hasTimedOut = true;
					}, timeout);
					try {
						while (true) {
							const isLastAttempt = hasTimedOut;
							if (isLastAttempt) utils_exports.flag(assertion, "_isLastPollAttempt", true);
							try {
								executionPhase = "fn";
								const obj = await fn();
								utils_exports.flag(assertion, "object", obj);
								executionPhase = "assertion";
								const output = await assertionFunction.call(assertion, ...args);
								await onSettled?.({
									assertion,
									status: "pass"
								});
								return output;
							} catch (err) {
								if (isLastAttempt || executionPhase === "assertion" && utils_exports.flag(assertion, "_poll.assert_once")) {
									await onSettled?.({
										assertion,
										status: "fail"
									});
									throwWithCause(err, STACK_TRACE_ERROR);
								}
								await delay(interval, setTimeout);
								if (vi.isFakeTimers()) vi.advanceTimersByTime(interval);
							}
						}
					} finally {
						clearTimeout(timerId);
					}
				};
				let awaited = false;
				test.onFinished ??= [];
				test.onFinished.push(() => {
					if (!awaited) {
						const negated = utils_exports.flag(assertion, "negate") ? "not." : "";
						const assertionString = `expect.${utils_exports.flag(assertion, "_poll.element") ? "element(locator)" : "poll(assertion)"}.${negated}${String(key)}()`;
						throw copyStackTrace(/* @__PURE__ */ new Error(`${assertionString} was not awaited. This assertion is asynchronous and must be awaited; otherwise, it is not executed to avoid unhandled rejections:\n\nawait ${assertionString}\n`), STACK_TRACE_ERROR);
					}
				});
				let resultPromise;
				return {
					then(onFulfilled, onRejected) {
						awaited = true;
						return (resultPromise ||= promise()).then(onFulfilled, onRejected);
					},
					catch(onRejected) {
						awaited = true;
						return (resultPromise ||= promise()).catch(onRejected);
					},
					finally(onFinally) {
						awaited = true;
						return (resultPromise ||= promise()).finally(onFinally);
					},
					[Symbol.toStringTag]: "Promise"
				};
			};
		} });
		return proxy;
	};
}
function copyStackTrace(target, source) {
	if (source.stack !== void 0) target.stack = source.stack.replace(source.message, target.message);
	return target;
}
let _client;
function getSnapshotClient() {
	if (!_client) _client = new SnapshotClient({ isEqual: (received, expected) => {
		return equals(received, expected, [iterableEquality, subsetEquality]);
	} });
	return _client;
}
function getError(expected, promise) {
	if (typeof expected !== "function") {
		if (!promise) throw new Error(`expected must be a function, received ${typeof expected}`);
		return expected;
	}
	try {
		expected();
	} catch (e) {
		return e;
	}
	throw new Error("snapshot function didn't throw");
}
function getTestNames(test) {
	return {
		filepath: test.file.filepath,
		name: getNames(test).slice(1).join(" > "),
		testId: test.id
	};
}
function getAssertionName(assertion) {
	const name = utils_exports.flag(assertion, "_name");
	if (!name) throw new Error("Assertion name is not set. This is a bug in Vitest. Please, open a new issue with reproduction.");
	return name;
}
function getTest(obj) {
	const test = utils_exports.flag(obj, "vitest-test");
	if (!test) throw new Error(`'${getAssertionName(obj)}' cannot be used without test context`);
	return test;
}
function validateAssertion(assertion) {
	if (utils_exports.flag(assertion, "negate")) throw new Error(`${getAssertionName(assertion)} cannot be used with "not"`);
}
const SnapshotPlugin = (chai, utils) => {
	for (const key of ["matchSnapshot", "toMatchSnapshot"]) utils.addMethod(chai.Assertion.prototype, key, wrapAssertion(utils, key, function(propertiesOrHint, hint) {
		return assertMatchResult(toMatchSnapshotImpl({
			assertion: this,
			received: utils.flag(this, "object"),
			...normalizeArguments(propertiesOrHint, hint)
		}), chai.util.flag(this, "message"));
	}));
	utils.addMethod(chai.Assertion.prototype, "toMatchFileSnapshot", function(filepath, hint) {
		utils.flag(this, "_name", "toMatchFileSnapshot");
		validateAssertion(this);
		const assertPromise = toMatchFileSnapshotImpl({
			assertion: this,
			received: utils.flag(this, "object"),
			filepath,
			hint
		}).then((result) => assertMatchResult(result, chai.util.flag(this, "message")));
		return recordAsyncExpect(getTest(this), assertPromise, createAssertionMessage(utils, this, true), /* @__PURE__ */ new Error("resolves"), utils.flag(this, "soft"));
	});
	utils.addMethod(chai.Assertion.prototype, "toMatchInlineSnapshot", wrapAssertion(utils, "toMatchInlineSnapshot", function __INLINE_SNAPSHOT_OFFSET_3__(propertiesOrInlineSnapshot, inlineSnapshotOrHint, hint) {
		return assertMatchResult(toMatchSnapshotImpl({
			assertion: this,
			received: utils.flag(this, "object"),
			isInline: true,
			...normalizeInlineArguments(propertiesOrInlineSnapshot, inlineSnapshotOrHint, hint)
		}), chai.util.flag(this, "message"));
	}));
	utils.addMethod(chai.Assertion.prototype, "toThrowErrorMatchingSnapshot", wrapAssertion(utils, "toThrowErrorMatchingSnapshot", function(propertiesOrHint, hint) {
		validateAssertion(this);
		const received = utils.flag(this, "object");
		const promise = utils.flag(this, "promise");
		return assertMatchResult(toMatchSnapshotImpl({
			assertion: this,
			received: getError(received, promise),
			...normalizeArguments(propertiesOrHint, hint)
		}), chai.util.flag(this, "message"));
	}));
	utils.addMethod(chai.Assertion.prototype, "toThrowErrorMatchingInlineSnapshot", wrapAssertion(utils, "toThrowErrorMatchingInlineSnapshot", function __INLINE_SNAPSHOT_OFFSET_3__(inlineSnapshotOrHint, hint) {
		validateAssertion(this);
		const received = utils.flag(this, "object");
		const promise = utils.flag(this, "promise");
		return assertMatchResult(toMatchSnapshotImpl({
			assertion: this,
			received: getError(received, promise),
			isInline: true,
			...normalizeInlineArguments(void 0, inlineSnapshotOrHint, hint)
		}), chai.util.flag(this, "message"));
	}));
	utils.addMethod(chai.expect, "addSnapshotSerializer", addSerializer);
};
function normalizeArguments(propertiesOrHint, hint) {
	if (typeof propertiesOrHint === "string") return { hint: propertiesOrHint };
	return {
		properties: propertiesOrHint,
		hint
	};
}
function normalizeInlineArguments(propertiesOrInlineSnapshot, inlineSnapshotOrHint, hint) {
	let inlineSnapshot;
	if (typeof propertiesOrInlineSnapshot === "string") {
		inlineSnapshot = stripSnapshotIndentation(propertiesOrInlineSnapshot);
		return {
			inlineSnapshot,
			hint: inlineSnapshotOrHint
		};
	}
	if (inlineSnapshotOrHint) inlineSnapshot = stripSnapshotIndentation(inlineSnapshotOrHint);
	return {
		properties: propertiesOrInlineSnapshot,
		inlineSnapshot,
		hint
	};
}
function toMatchSnapshotImpl(options) {
	const { assertion } = options;
	validateAssertion(assertion);
	const assertionName = getAssertionName(assertion);
	const test = getTest(assertion);
	return getSnapshotClient().match({
		received: options.received,
		properties: options.properties,
		message: options.hint,
		isInline: options.isInline,
		inlineSnapshot: options.inlineSnapshot,
		assertionName,
		error: utils_exports.flag(assertion, "error"),
		...getTestNames(test)
	});
}
async function toMatchFileSnapshotImpl(options) {
	const { assertion } = options;
	validateAssertion(assertion);
	const testNames = getTestNames(getTest(assertion));
	const snapshotState = getSnapshotClient().getSnapshotState(testNames.filepath);
	const rawSnapshotFile = await snapshotState.environment.resolveRawPath(testNames.filepath, options.filepath);
	const rawSnapshotContent = await snapshotState.environment.readSnapshotFile(rawSnapshotFile);
	return getSnapshotClient().match({
		received: options.received,
		message: options.hint,
		rawSnapshot: {
			file: rawSnapshotFile,
			content: rawSnapshotContent ?? void 0
		},
		...testNames
	});
}
function assertMatchResult(result, customMessage) {
	if (!result.pass) {
		const errorMessage = (customMessage ? `${customMessage}: ` : "") + result.message();
		throw Object.assign(new Error(errorMessage), {
			actual: result.actual,
			expected: result.expected,
			diffOptions: { expand: getWorkerState().config.snapshotOptions.expand }
		});
	}
}
use(JestExtend);
use(JestChaiExpect);
use(ChaiStyleAssertions);
use(SnapshotPlugin);
use(JestAsymmetricMatchers);
function createExpect(test) {
	const expect$1 = ((value, message) => {
		const { assertionCalls } = getState(expect$1);
		setState({ assertionCalls: assertionCalls + 1 }, expect$1);
		const assert = expect(value, message);
		const _test = test || getCurrentTest();
		if (_test) return assert.withTest(_test);
		else return assert;
	});
	Object.assign(expect$1, expect);
	Object.assign(expect$1, globalThis[ASYMMETRIC_MATCHERS_OBJECT]);
	expect$1.getState = () => getState(expect$1);
	expect$1.setState = (state) => setState(state, expect$1);
	const globalState = getState(globalThis[GLOBAL_EXPECT]) || {};
	setState({
		...globalState,
		assertionCalls: 0,
		isExpectingAssertions: false,
		isExpectingAssertionsError: null,
		expectedAssertionsNumber: null,
		expectedAssertionsNumberErrorGen: null,
		get testPath() {
			return getWorkerState().filepath;
		},
		currentTestName: test ? test.fullTestName ?? "" : globalState.currentTestName
	}, expect$1);
	expect$1.assert = assert$1;
	expect$1.extend = (matchers) => expect.extend(expect$1, matchers);
	expect$1.addEqualityTesters = (customTesters) => addCustomEqualityTesters(customTesters);
	expect$1.soft = (...args) => {
		return expect$1(...args).withContext({ soft: true });
	};
	expect$1.poll = createExpectPoll(expect$1);
	expect$1.unreachable = (message) => {
		assert$1.fail(`expected${message ? ` "${message}" ` : " "}not to be reached`);
	};
	function assertions(expected) {
		const errorGen = () => /* @__PURE__ */ new Error(`expected number of assertions to be ${expected}, but got ${expect$1.getState().assertionCalls}`);
		if (Error.captureStackTrace) Error.captureStackTrace(errorGen(), assertions);
		expect$1.setState({
			expectedAssertionsNumber: expected,
			expectedAssertionsNumberErrorGen: errorGen
		});
	}
	function hasAssertions() {
		const error = /* @__PURE__ */ new Error("expected any number of assertion, but got none");
		if (Error.captureStackTrace) Error.captureStackTrace(error, hasAssertions);
		expect$1.setState({
			isExpectingAssertions: true,
			isExpectingAssertionsError: error
		});
	}
	utils_exports.addMethod(expect$1, "assertions", assertions);
	utils_exports.addMethod(expect$1, "hasAssertions", hasAssertions);
	expect$1.extend(customMatchers);
	return expect$1;
}
const globalExpect = createExpect();
Object.defineProperty(globalThis, GLOBAL_EXPECT, {
	value: globalExpect,
	writable: true,
	configurable: true
});
//#endregion
export { vi as n, globalExpect as t };
