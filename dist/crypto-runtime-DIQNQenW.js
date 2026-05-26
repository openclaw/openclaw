import { o as withFileLock } from "./file-lock-D5OTq3qW.js";
import { t as formatMatrixErrorMessage } from "./errors-Cd21tNWv.js";
import { t as ensureMatrixCryptoRuntime } from "./deps-C2Br7iRw.js";
import { n as LogService, r as noop } from "./logger-CjN9_ytq.js";
import { i as MATRIX_IDB_SNAPSHOT_LOCK_OPTIONS, n as isRepairableSecretStorageAccessError } from "./recovery-key-store-DLpPEjzu.js";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { MatrixEventEvent } from "matrix-js-sdk/lib/matrix.js";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import { DecryptionFailureCode } from "matrix-js-sdk/lib/crypto-api/index.js";
import { VerificationPhase, VerificationRequestEvent, VerifierEvent } from "matrix-js-sdk/lib/crypto-api/verification.js";
//#region node_modules/fake-indexeddb/build/esm/lib/errors.js
const messages = {
	AbortError: "A request was aborted, for example through a call to IDBTransaction.abort.",
	ConstraintError: "A mutation operation in the transaction failed because a constraint was not satisfied. For example, an object such as an object store or index already exists and a request attempted to create a new one.",
	DataCloneError: "The data being stored could not be cloned by the internal structured cloning algorithm.",
	DataError: "Data provided to an operation does not meet requirements.",
	InvalidAccessError: "An invalid operation was performed on an object. For example transaction creation attempt was made, but an empty scope was provided.",
	InvalidStateError: "An operation was called on an object on which it is not allowed or at a time when it is not allowed. Also occurs if a request is made on a source object that has been deleted or removed. Use TransactionInactiveError or ReadOnlyError when possible, as they are more specific variations of InvalidStateError.",
	NotFoundError: "The operation failed because the requested database object could not be found. For example, an object store did not exist but was being opened.",
	ReadOnlyError: "The mutating operation was attempted in a \"readonly\" transaction.",
	TransactionInactiveError: "A request was placed against a transaction which is currently not active, or which is finished.",
	SyntaxError: "The keypath argument contains an invalid key path",
	VersionError: "An attempt was made to open a database using a lower version than the existing version."
};
const setErrorCode = (error, value) => {
	Object.defineProperty(error, "code", {
		value,
		writable: false,
		enumerable: true,
		configurable: false
	});
};
var AbortError = class extends DOMException {
	constructor(message = messages.AbortError) {
		super(message, "AbortError");
	}
};
var ConstraintError = class extends DOMException {
	constructor(message = messages.ConstraintError) {
		super(message, "ConstraintError");
	}
};
var DataError = class extends DOMException {
	constructor(message = messages.DataError) {
		super(message, "DataError");
		setErrorCode(this, 0);
	}
};
var InvalidAccessError = class extends DOMException {
	constructor(message = messages.InvalidAccessError) {
		super(message, "InvalidAccessError");
	}
};
var InvalidStateError = class extends DOMException {
	constructor(message = messages.InvalidStateError) {
		super(message, "InvalidStateError");
		setErrorCode(this, 11);
	}
};
var NotFoundError = class extends DOMException {
	constructor(message = messages.NotFoundError) {
		super(message, "NotFoundError");
	}
};
var ReadOnlyError = class extends DOMException {
	constructor(message = messages.ReadOnlyError) {
		super(message, "ReadOnlyError");
	}
};
var SyntaxError = class extends DOMException {
	constructor(message = messages.VersionError) {
		super(message, "SyntaxError");
		setErrorCode(this, 12);
	}
};
var TransactionInactiveError = class extends DOMException {
	constructor(message = messages.TransactionInactiveError) {
		super(message, "TransactionInactiveError");
		setErrorCode(this, 0);
	}
};
var VersionError = class extends DOMException {
	constructor(message = messages.VersionError) {
		super(message, "VersionError");
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/isSharedArrayBuffer.js
function isSharedArrayBuffer(input) {
	return typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer;
}
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/valueToKeyWithoutThrowing.js
const INVALID_TYPE = Symbol("INVALID_TYPE");
const INVALID_VALUE = Symbol("INVALID_VALUE");
const valueToKeyWithoutThrowing = (input, seen) => {
	if (typeof input === "number") {
		if (isNaN(input)) return INVALID_VALUE;
		return input;
	} else if (Object.prototype.toString.call(input) === "[object Date]") {
		const ms = input.valueOf();
		if (isNaN(ms)) return INVALID_VALUE;
		return new Date(ms);
	} else if (typeof input === "string") return input;
	else if (input instanceof ArrayBuffer || isSharedArrayBuffer(input) || typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(input)) {
		if ("detached" in input ? input.detached : input.byteLength === 0) return INVALID_VALUE;
		let arrayBuffer;
		let offset = 0;
		let length = 0;
		if (input instanceof ArrayBuffer || isSharedArrayBuffer(input)) {
			arrayBuffer = input;
			length = input.byteLength;
		} else {
			arrayBuffer = input.buffer;
			offset = input.byteOffset;
			length = input.byteLength;
		}
		return arrayBuffer.slice(offset, offset + length);
	} else if (Array.isArray(input)) {
		if (seen === void 0) seen = /* @__PURE__ */ new Set();
		else if (seen.has(input)) return INVALID_VALUE;
		seen.add(input);
		let hasInvalid = false;
		const keys = Array.from({ length: input.length }, (_, i) => {
			if (hasInvalid) return;
			if (!Object.hasOwn(input, i)) {
				hasInvalid = true;
				return;
			}
			const entry = input[i];
			const key = valueToKeyWithoutThrowing(entry, seen);
			if (key === INVALID_VALUE || key === INVALID_TYPE) {
				hasInvalid = true;
				return;
			}
			return key;
		});
		if (hasInvalid) return INVALID_VALUE;
		return keys;
	} else return INVALID_TYPE;
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/valueToKey.js
const valueToKey = (input, seen) => {
	const result = valueToKeyWithoutThrowing(input, seen);
	if (result === INVALID_VALUE || result === INVALID_TYPE) throw new DataError();
	return result;
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/cmp.js
const getType = (x) => {
	if (typeof x === "number") return "Number";
	if (Object.prototype.toString.call(x) === "[object Date]") return "Date";
	if (Array.isArray(x)) return "Array";
	if (typeof x === "string") return "String";
	if (x instanceof ArrayBuffer) return "Binary";
	throw new DataError();
};
const cmp = (first, second) => {
	if (second === void 0) throw new TypeError();
	first = valueToKey(first);
	second = valueToKey(second);
	const t1 = getType(first);
	const t2 = getType(second);
	if (t1 !== t2) {
		if (t1 === "Array") return 1;
		if (t1 === "Binary" && (t2 === "String" || t2 === "Date" || t2 === "Number")) return 1;
		if (t1 === "String" && (t2 === "Date" || t2 === "Number")) return 1;
		if (t1 === "Date" && t2 === "Number") return 1;
		return -1;
	}
	if (t1 === "Binary") {
		first = new Uint8Array(first);
		second = new Uint8Array(second);
	}
	if (t1 === "Array" || t1 === "Binary") {
		const length = Math.min(first.length, second.length);
		for (let i = 0; i < length; i++) {
			const result = cmp(first[i], second[i]);
			if (result !== 0) return result;
		}
		if (first.length > second.length) return 1;
		if (first.length < second.length) return -1;
		return 0;
	}
	if (t1 === "Date") {
		if (first.getTime() === second.getTime()) return 0;
	} else if (first === second) return 0;
	return first > second ? 1 : -1;
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/FDBKeyRange.js
var FDBKeyRange = class FDBKeyRange {
	static only(value) {
		if (arguments.length === 0) throw new TypeError();
		value = valueToKey(value);
		return new FDBKeyRange(value, value, false, false);
	}
	static lowerBound(lower, open = false) {
		if (arguments.length === 0) throw new TypeError();
		lower = valueToKey(lower);
		return new FDBKeyRange(lower, void 0, open, true);
	}
	static upperBound(upper, open = false) {
		if (arguments.length === 0) throw new TypeError();
		upper = valueToKey(upper);
		return new FDBKeyRange(void 0, upper, true, open);
	}
	static bound(lower, upper, lowerOpen = false, upperOpen = false) {
		if (arguments.length < 2) throw new TypeError();
		const cmpResult = cmp(lower, upper);
		if (cmpResult === 1 || cmpResult === 0 && (lowerOpen || upperOpen)) throw new DataError();
		lower = valueToKey(lower);
		upper = valueToKey(upper);
		return new FDBKeyRange(lower, upper, lowerOpen, upperOpen);
	}
	constructor(lower, upper, lowerOpen, upperOpen) {
		this.lower = lower;
		this.upper = upper;
		this.lowerOpen = lowerOpen;
		this.upperOpen = upperOpen;
	}
	includes(key) {
		if (arguments.length === 0) throw new TypeError();
		key = valueToKey(key);
		if (this.lower !== void 0) {
			const cmpResult = cmp(this.lower, key);
			if (cmpResult === 1 || cmpResult === 0 && this.lowerOpen) return false;
		}
		if (this.upper !== void 0) {
			const cmpResult = cmp(this.upper, key);
			if (cmpResult === -1 || cmpResult === 0 && this.upperOpen) return false;
		}
		return true;
	}
	get [Symbol.toStringTag]() {
		return "IDBKeyRange";
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/extractKey.js
const extractKey = (keyPath, value) => {
	if (Array.isArray(keyPath)) {
		const result = [];
		for (let item of keyPath) {
			if (item !== void 0 && item !== null && typeof item !== "string" && item.toString) item = item.toString();
			const key = extractKey(item, value).key;
			result.push(valueToKey(key));
		}
		return {
			type: "found",
			key: result
		};
	}
	if (keyPath === "") return {
		type: "found",
		key: value
	};
	let remainingKeyPath = keyPath;
	let object = value;
	while (remainingKeyPath !== null) {
		let identifier;
		const i = remainingKeyPath.indexOf(".");
		if (i >= 0) {
			identifier = remainingKeyPath.slice(0, i);
			remainingKeyPath = remainingKeyPath.slice(i + 1);
		} else {
			identifier = remainingKeyPath;
			remainingKeyPath = null;
		}
		if (!(identifier === "length" && (typeof object === "string" || Array.isArray(object)) || (identifier === "size" || identifier === "type") && typeof Blob !== "undefined" && object instanceof Blob || (identifier === "name" || identifier === "lastModified") && typeof File !== "undefined" && object instanceof File) && (typeof object !== "object" || object === null || !Object.hasOwn(object, identifier))) return { type: "notFound" };
		object = object[identifier];
	}
	return {
		type: "found",
		key: object
	};
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/cloneValueForInsertion.js
function cloneValueForInsertion(value, transaction) {
	if (transaction._state !== "active") throw new Error("Assert: transaction state is active");
	transaction._state = "inactive";
	try {
		return structuredClone(value);
	} finally {
		transaction._state = "active";
	}
}
//#endregion
//#region node_modules/fake-indexeddb/build/esm/FDBCursor.js
const getEffectiveObjectStore = (cursor) => {
	if (cursor.source instanceof FDBObjectStore) return cursor.source;
	return cursor.source.objectStore;
};
const makeKeyRange = (range, lowers, uppers) => {
	let lower = range !== void 0 ? range.lower : void 0;
	let upper = range !== void 0 ? range.upper : void 0;
	for (const lowerTemp of lowers) {
		if (lowerTemp === void 0) continue;
		if (lower === void 0 || cmp(lower, lowerTemp) === 1) lower = lowerTemp;
	}
	for (const upperTemp of uppers) {
		if (upperTemp === void 0) continue;
		if (upper === void 0 || cmp(upper, upperTemp) === -1) upper = upperTemp;
	}
	if (lower !== void 0 && upper !== void 0) return FDBKeyRange.bound(lower, upper);
	if (lower !== void 0) return FDBKeyRange.lowerBound(lower);
	if (upper !== void 0) return FDBKeyRange.upperBound(upper);
};
var FDBCursor = class {
	_gotValue = false;
	_position = void 0;
	_objectStorePosition = void 0;
	_keyOnly = false;
	_key = void 0;
	_primaryKey = void 0;
	constructor(source, range, direction = "next", request, keyOnly = false) {
		this._range = range;
		this._source = source;
		this._direction = direction;
		this._request = request;
		this._keyOnly = keyOnly;
	}
	get source() {
		return this._source;
	}
	set source(val) {}
	get request() {
		return this._request;
	}
	set request(val) {}
	get direction() {
		return this._direction;
	}
	set direction(val) {}
	get key() {
		return this._key;
	}
	set key(val) {}
	get primaryKey() {
		return this._primaryKey;
	}
	set primaryKey(val) {}
	_iterate(key, primaryKey) {
		const sourceIsObjectStore = this.source instanceof FDBObjectStore;
		const records = this.source instanceof FDBObjectStore ? this.source._rawObjectStore.records : this.source._rawIndex.records;
		let foundRecord;
		if (this.direction === "next") {
			const range = makeKeyRange(this._range, [key, this._position], []);
			for (const record of records.values(range)) {
				const cmpResultKey = key !== void 0 ? cmp(record.key, key) : void 0;
				const cmpResultPosition = this._position !== void 0 ? cmp(record.key, this._position) : void 0;
				if (key !== void 0) {
					if (cmpResultKey === -1) continue;
				}
				if (primaryKey !== void 0) {
					if (cmpResultKey === -1) continue;
					const cmpResultPrimaryKey = cmp(record.value, primaryKey);
					if (cmpResultKey === 0 && cmpResultPrimaryKey === -1) continue;
				}
				if (this._position !== void 0 && sourceIsObjectStore) {
					if (cmpResultPosition !== 1) continue;
				}
				if (this._position !== void 0 && !sourceIsObjectStore) {
					if (cmpResultPosition === -1) continue;
					if (cmpResultPosition === 0 && cmp(record.value, this._objectStorePosition) !== 1) continue;
				}
				if (this._range !== void 0) {
					if (!this._range.includes(record.key)) continue;
				}
				foundRecord = record;
				break;
			}
		} else if (this.direction === "nextunique") {
			const range = makeKeyRange(this._range, [key, this._position], []);
			for (const record of records.values(range)) {
				if (key !== void 0) {
					if (cmp(record.key, key) === -1) continue;
				}
				if (this._position !== void 0) {
					if (cmp(record.key, this._position) !== 1) continue;
				}
				if (this._range !== void 0) {
					if (!this._range.includes(record.key)) continue;
				}
				foundRecord = record;
				break;
			}
		} else if (this.direction === "prev") {
			const range = makeKeyRange(this._range, [], [key, this._position]);
			for (const record of records.values(range, "prev")) {
				const cmpResultKey = key !== void 0 ? cmp(record.key, key) : void 0;
				const cmpResultPosition = this._position !== void 0 ? cmp(record.key, this._position) : void 0;
				if (key !== void 0) {
					if (cmpResultKey === 1) continue;
				}
				if (primaryKey !== void 0) {
					if (cmpResultKey === 1) continue;
					const cmpResultPrimaryKey = cmp(record.value, primaryKey);
					if (cmpResultKey === 0 && cmpResultPrimaryKey === 1) continue;
				}
				if (this._position !== void 0 && sourceIsObjectStore) {
					if (cmpResultPosition !== -1) continue;
				}
				if (this._position !== void 0 && !sourceIsObjectStore) {
					if (cmpResultPosition === 1) continue;
					if (cmpResultPosition === 0 && cmp(record.value, this._objectStorePosition) !== -1) continue;
				}
				if (this._range !== void 0) {
					if (!this._range.includes(record.key)) continue;
				}
				foundRecord = record;
				break;
			}
		} else if (this.direction === "prevunique") {
			let tempRecord;
			const range = makeKeyRange(this._range, [], [key, this._position]);
			for (const record of records.values(range, "prev")) {
				if (key !== void 0) {
					if (cmp(record.key, key) === 1) continue;
				}
				if (this._position !== void 0) {
					if (cmp(record.key, this._position) !== -1) continue;
				}
				if (this._range !== void 0) {
					if (!this._range.includes(record.key)) continue;
				}
				tempRecord = record;
				break;
			}
			if (tempRecord) foundRecord = records.get(tempRecord.key);
		}
		let result;
		if (!foundRecord) {
			this._key = void 0;
			if (!sourceIsObjectStore) this._objectStorePosition = void 0;
			if (!this._keyOnly && this.toString() === "[object IDBCursorWithValue]") this.value = void 0;
			result = null;
		} else {
			this._position = foundRecord.key;
			if (!sourceIsObjectStore) this._objectStorePosition = foundRecord.value;
			this._key = foundRecord.key;
			if (sourceIsObjectStore) {
				this._primaryKey = structuredClone(foundRecord.key);
				if (!this._keyOnly && this.toString() === "[object IDBCursorWithValue]") this.value = structuredClone(foundRecord.value);
			} else {
				this._primaryKey = structuredClone(foundRecord.value);
				if (!this._keyOnly && this.toString() === "[object IDBCursorWithValue]") {
					if (this.source instanceof FDBObjectStore) throw new Error("This should never happen");
					const value = this.source.objectStore._rawObjectStore.getValue(foundRecord.value);
					this.value = structuredClone(value);
				}
			}
			this._gotValue = true;
			result = this;
		}
		return result;
	}
	update(value) {
		if (value === void 0) throw new TypeError();
		const effectiveObjectStore = getEffectiveObjectStore(this);
		const effectiveKey = Object.hasOwn(this.source, "_rawIndex") ? this.primaryKey : this._position;
		const transaction = effectiveObjectStore.transaction;
		if (transaction._state !== "active") throw new TransactionInactiveError();
		if (transaction.mode === "readonly") throw new ReadOnlyError();
		if (effectiveObjectStore._rawObjectStore.deleted) throw new InvalidStateError();
		if (!(this.source instanceof FDBObjectStore) && this.source._rawIndex.deleted) throw new InvalidStateError();
		if (!this._gotValue || !Object.hasOwn(this, "value")) throw new InvalidStateError();
		const clone = cloneValueForInsertion(value, transaction);
		if (effectiveObjectStore.keyPath !== null) {
			let tempKey;
			try {
				tempKey = extractKey(effectiveObjectStore.keyPath, clone).key;
			} catch (err) {}
			if (cmp(tempKey, effectiveKey) !== 0) throw new DataError();
		}
		const record = {
			key: effectiveKey,
			value: clone
		};
		return transaction._execRequestAsync({
			operation: effectiveObjectStore._rawObjectStore.storeRecord.bind(effectiveObjectStore._rawObjectStore, record, false, transaction._rollbackLog),
			source: this
		});
	}
	advance(count) {
		if (!Number.isInteger(count) || count <= 0) throw new TypeError();
		const effectiveObjectStore = getEffectiveObjectStore(this);
		const transaction = effectiveObjectStore.transaction;
		if (transaction._state !== "active") throw new TransactionInactiveError();
		if (effectiveObjectStore._rawObjectStore.deleted) throw new InvalidStateError();
		if (!(this.source instanceof FDBObjectStore) && this.source._rawIndex.deleted) throw new InvalidStateError();
		if (!this._gotValue) throw new InvalidStateError();
		if (this._request) this._request.readyState = "pending";
		transaction._execRequestAsync({
			operation: () => {
				let result;
				for (let i = 0; i < count; i++) {
					result = this._iterate();
					if (!result) break;
				}
				return result;
			},
			request: this._request,
			source: this.source
		});
		this._gotValue = false;
	}
	continue(key) {
		const effectiveObjectStore = getEffectiveObjectStore(this);
		const transaction = effectiveObjectStore.transaction;
		if (transaction._state !== "active") throw new TransactionInactiveError();
		if (effectiveObjectStore._rawObjectStore.deleted) throw new InvalidStateError();
		if (!(this.source instanceof FDBObjectStore) && this.source._rawIndex.deleted) throw new InvalidStateError();
		if (!this._gotValue) throw new InvalidStateError();
		if (key !== void 0) {
			key = valueToKey(key);
			const cmpResult = cmp(key, this._position);
			if (cmpResult <= 0 && (this.direction === "next" || this.direction === "nextunique") || cmpResult >= 0 && (this.direction === "prev" || this.direction === "prevunique")) throw new DataError();
		}
		if (this._request) this._request.readyState = "pending";
		transaction._execRequestAsync({
			operation: this._iterate.bind(this, key),
			request: this._request,
			source: this.source
		});
		this._gotValue = false;
	}
	continuePrimaryKey(key, primaryKey) {
		const effectiveObjectStore = getEffectiveObjectStore(this);
		const transaction = effectiveObjectStore.transaction;
		if (transaction._state !== "active") throw new TransactionInactiveError();
		if (effectiveObjectStore._rawObjectStore.deleted) throw new InvalidStateError();
		if (!(this.source instanceof FDBObjectStore) && this.source._rawIndex.deleted) throw new InvalidStateError();
		if (this.source instanceof FDBObjectStore || this.direction !== "next" && this.direction !== "prev") throw new InvalidAccessError();
		if (!this._gotValue) throw new InvalidStateError();
		if (key === void 0 || primaryKey === void 0) throw new DataError();
		key = valueToKey(key);
		const cmpResult = cmp(key, this._position);
		if (cmpResult === -1 && this.direction === "next" || cmpResult === 1 && this.direction === "prev") throw new DataError();
		const cmpResult2 = cmp(primaryKey, this._objectStorePosition);
		if (cmpResult === 0) {
			if (cmpResult2 <= 0 && this.direction === "next" || cmpResult2 >= 0 && this.direction === "prev") throw new DataError();
		}
		if (this._request) this._request.readyState = "pending";
		transaction._execRequestAsync({
			operation: this._iterate.bind(this, key, primaryKey),
			request: this._request,
			source: this.source
		});
		this._gotValue = false;
	}
	delete() {
		const effectiveObjectStore = getEffectiveObjectStore(this);
		const effectiveKey = Object.hasOwn(this.source, "_rawIndex") ? this.primaryKey : this._position;
		const transaction = effectiveObjectStore.transaction;
		if (transaction._state !== "active") throw new TransactionInactiveError();
		if (transaction.mode === "readonly") throw new ReadOnlyError();
		if (effectiveObjectStore._rawObjectStore.deleted) throw new InvalidStateError();
		if (!(this.source instanceof FDBObjectStore) && this.source._rawIndex.deleted) throw new InvalidStateError();
		if (!this._gotValue || !Object.hasOwn(this, "value")) throw new InvalidStateError();
		return transaction._execRequestAsync({
			operation: effectiveObjectStore._rawObjectStore.deleteRecord.bind(effectiveObjectStore._rawObjectStore, effectiveKey, transaction._rollbackLog),
			source: this
		});
	}
	get [Symbol.toStringTag]() {
		return "IDBCursor";
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/FDBCursorWithValue.js
var FDBCursorWithValue = class extends FDBCursor {
	value = void 0;
	constructor(source, range, direction, request) {
		super(source, range, direction, request);
	}
	get [Symbol.toStringTag]() {
		return "IDBCursorWithValue";
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/FakeEventTarget.js
const stopped = (event, listener) => {
	return event.immediatePropagationStopped || event.eventPhase === event.CAPTURING_PHASE && listener.capture === false || event.eventPhase === event.BUBBLING_PHASE && listener.capture === true;
};
const invokeEventListeners = (event, obj) => {
	event.currentTarget = obj;
	const errors = [];
	const invoke = (callbackOrObject) => {
		try {
			(typeof callbackOrObject === "function" ? callbackOrObject : callbackOrObject.handleEvent).call(event.currentTarget, event);
		} catch (err) {
			errors.push(err);
		}
	};
	for (const listener of obj.listeners.slice()) {
		if (event.type !== listener.type || stopped(event, listener)) continue;
		invoke(listener.callback);
	}
	const prop = {
		abort: "onabort",
		blocked: "onblocked",
		close: "onclose",
		complete: "oncomplete",
		error: "onerror",
		success: "onsuccess",
		upgradeneeded: "onupgradeneeded",
		versionchange: "onversionchange"
	}[event.type];
	if (prop === void 0) throw new Error(`Unknown event type: "${event.type}"`);
	const callback = event.currentTarget[prop];
	if (callback) {
		const listener = {
			callback,
			capture: false,
			type: event.type
		};
		if (!stopped(event, listener)) invoke(listener.callback);
	}
	if (errors.length) throw new AggregateError(errors);
};
var FakeEventTarget = class {
	listeners = [];
	addEventListener(type, callback, options) {
		const capture = !!(typeof options === "object" && options ? options.capture : options);
		this.listeners.push({
			callback,
			capture,
			type
		});
	}
	removeEventListener(type, callback, options) {
		const capture = !!(typeof options === "object" && options ? options.capture : options);
		const i = this.listeners.findIndex((listener) => {
			return listener.type === type && listener.callback === callback && listener.capture === capture;
		});
		this.listeners.splice(i, 1);
	}
	dispatchEvent(event) {
		if (event.dispatched || !event.initialized) throw new InvalidStateError("The object is in an invalid state.");
		event.isTrusted = false;
		event.dispatched = true;
		event.target = this;
		event.eventPhase = event.CAPTURING_PHASE;
		for (const obj of event.eventPath) if (!event.propagationStopped) invokeEventListeners(event, obj);
		event.eventPhase = event.AT_TARGET;
		if (!event.propagationStopped) invokeEventListeners(event, event.target);
		if (event.bubbles) {
			event.eventPath.reverse();
			event.eventPhase = event.BUBBLING_PHASE;
			for (const obj of event.eventPath) if (!event.propagationStopped) invokeEventListeners(event, obj);
		}
		event.dispatched = false;
		event.eventPhase = event.NONE;
		event.currentTarget = null;
		if (event.canceled) return false;
		return true;
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/FDBRequest.js
var FDBRequest = class extends FakeEventTarget {
	_result = null;
	_error = null;
	source = null;
	transaction = null;
	readyState = "pending";
	onsuccess = null;
	onerror = null;
	get error() {
		if (this.readyState === "pending") throw new InvalidStateError();
		return this._error;
	}
	set error(value) {
		this._error = value;
	}
	get result() {
		if (this.readyState === "pending") throw new InvalidStateError();
		return this._result;
	}
	set result(value) {
		this._result = value;
	}
	get [Symbol.toStringTag]() {
		return "IDBRequest";
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/FakeDOMStringList.js
var FakeDOMStringList = class {
	constructor(...values) {
		this._values = values;
		for (let i = 0; i < values.length; i++) this[i] = values[i];
	}
	contains(value) {
		return this._values.includes(value);
	}
	item(i) {
		if (i < 0 || i >= this._values.length) return null;
		return this._values[i];
	}
	get length() {
		return this._values.length;
	}
	[Symbol.iterator]() {
		return this._values[Symbol.iterator]();
	}
	_push(...values) {
		for (let i = 0; i < values.length; i++) this[this._values.length + i] = values[i];
		this._values.push(...values);
	}
	_sort(...values) {
		this._values.sort(...values);
		for (let i = 0; i < this._values.length; i++) this[i] = this._values[i];
		return this;
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/valueToKeyRange.js
const valueToKeyRange = (value, nullDisallowedFlag = false) => {
	if (value instanceof FDBKeyRange) return value;
	if (value === null || value === void 0) {
		if (nullDisallowedFlag) throw new DataError();
		return new FDBKeyRange(void 0, void 0, false, false);
	}
	const key = valueToKey(value);
	return FDBKeyRange.only(key);
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/getKeyPath.js
const convertKey = (key) => typeof key === "object" && key ? key + "" : key;
function getKeyPath(keyPath) {
	return Array.isArray(keyPath) ? keyPath.map(convertKey) : convertKey(keyPath);
}
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/isPotentiallyValidKeyRange.js
const isPotentiallyValidKeyRange = (value) => {
	if (value instanceof FDBKeyRange) return true;
	return valueToKeyWithoutThrowing(value) !== INVALID_TYPE;
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/enforceRange.js
const enforceRange = (num, type) => {
	if (isNaN(num) || num < 0 || num > (type === "unsigned long" ? 4294967295 : 9007199254740991)) throw new TypeError();
	if (num >= 0) return Math.floor(num);
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/extractGetAllOptions.js
const extractGetAllOptions = (queryOrOptions, count, numArguments) => {
	let query;
	let direction;
	if (queryOrOptions === void 0 || queryOrOptions === null || isPotentiallyValidKeyRange(queryOrOptions)) {
		query = queryOrOptions;
		if (numArguments > 1 && count !== void 0) count = enforceRange(count, "unsigned long");
	} else {
		const getAllOptions = queryOrOptions;
		if (getAllOptions.query !== void 0) query = getAllOptions.query;
		if (getAllOptions.count !== void 0) count = enforceRange(getAllOptions.count, "unsigned long");
		if (getAllOptions.direction !== void 0) direction = getAllOptions.direction;
	}
	return {
		query,
		count,
		direction
	};
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/FDBIndex.js
const confirmActiveTransaction$1 = (index) => {
	if (index._rawIndex.deleted || index.objectStore._rawObjectStore.deleted) throw new InvalidStateError();
	if (index.objectStore.transaction._state !== "active") throw new TransactionInactiveError();
};
var FDBIndex = class {
	constructor(objectStore, rawIndex) {
		this._rawIndex = rawIndex;
		this._name = rawIndex.name;
		this.objectStore = objectStore;
		this.keyPath = getKeyPath(rawIndex.keyPath);
		this.multiEntry = rawIndex.multiEntry;
		this.unique = rawIndex.unique;
	}
	get name() {
		return this._name;
	}
	set name(name) {
		const transaction = this.objectStore.transaction;
		if (!transaction.db._runningVersionchangeTransaction) throw transaction._state === "active" ? new InvalidStateError() : new TransactionInactiveError();
		if (transaction._state !== "active") throw new TransactionInactiveError();
		if (this._rawIndex.deleted || this.objectStore._rawObjectStore.deleted) throw new InvalidStateError();
		name = String(name);
		if (name === this._name) return;
		if (this.objectStore.indexNames.contains(name)) throw new ConstraintError();
		const oldName = this._name;
		const oldIndexNames = [...this.objectStore.indexNames];
		this._name = name;
		this._rawIndex.name = name;
		this.objectStore._indexesCache.delete(oldName);
		this.objectStore._indexesCache.set(name, this);
		this.objectStore._rawObjectStore.rawIndexes.delete(oldName);
		this.objectStore._rawObjectStore.rawIndexes.set(name, this._rawIndex);
		this.objectStore.indexNames = new FakeDOMStringList(...Array.from(this.objectStore._rawObjectStore.rawIndexes.keys()).filter((indexName) => {
			const index = this.objectStore._rawObjectStore.rawIndexes.get(indexName);
			return index && !index.deleted;
		}).sort());
		if (!this.objectStore.transaction._createdIndexes.has(this._rawIndex)) transaction._rollbackLog.push(() => {
			this._name = oldName;
			this._rawIndex.name = oldName;
			this.objectStore._indexesCache.delete(name);
			this.objectStore._indexesCache.set(oldName, this);
			this.objectStore._rawObjectStore.rawIndexes.delete(name);
			this.objectStore._rawObjectStore.rawIndexes.set(oldName, this._rawIndex);
			this.objectStore.indexNames = new FakeDOMStringList(...oldIndexNames);
		});
	}
	openCursor(range, direction) {
		confirmActiveTransaction$1(this);
		if (range === null) range = void 0;
		if (range !== void 0 && !(range instanceof FDBKeyRange)) range = FDBKeyRange.only(valueToKey(range));
		const request = new FDBRequest();
		request.source = this;
		request.transaction = this.objectStore.transaction;
		const cursor = new FDBCursorWithValue(this, range, direction, request);
		return this.objectStore.transaction._execRequestAsync({
			operation: cursor._iterate.bind(cursor),
			request,
			source: this
		});
	}
	openKeyCursor(range, direction) {
		confirmActiveTransaction$1(this);
		if (range === null) range = void 0;
		if (range !== void 0 && !(range instanceof FDBKeyRange)) range = FDBKeyRange.only(valueToKey(range));
		const request = new FDBRequest();
		request.source = this;
		request.transaction = this.objectStore.transaction;
		const cursor = new FDBCursor(this, range, direction, request, true);
		return this.objectStore.transaction._execRequestAsync({
			operation: cursor._iterate.bind(cursor),
			request,
			source: this
		});
	}
	get(key) {
		confirmActiveTransaction$1(this);
		if (!(key instanceof FDBKeyRange)) key = valueToKey(key);
		return this.objectStore.transaction._execRequestAsync({
			operation: this._rawIndex.getValue.bind(this._rawIndex, key),
			source: this
		});
	}
	getAll(queryOrOptions, count) {
		const options = extractGetAllOptions(queryOrOptions, count, arguments.length);
		confirmActiveTransaction$1(this);
		const range = valueToKeyRange(options.query);
		return this.objectStore.transaction._execRequestAsync({
			operation: this._rawIndex.getAllValues.bind(this._rawIndex, range, options.count, options.direction),
			source: this
		});
	}
	getKey(key) {
		confirmActiveTransaction$1(this);
		if (!(key instanceof FDBKeyRange)) key = valueToKey(key);
		return this.objectStore.transaction._execRequestAsync({
			operation: this._rawIndex.getKey.bind(this._rawIndex, key),
			source: this
		});
	}
	getAllKeys(queryOrOptions, count) {
		const options = extractGetAllOptions(queryOrOptions, count, arguments.length);
		confirmActiveTransaction$1(this);
		const range = valueToKeyRange(options.query);
		return this.objectStore.transaction._execRequestAsync({
			operation: this._rawIndex.getAllKeys.bind(this._rawIndex, range, options.count, options.direction),
			source: this
		});
	}
	getAllRecords(options) {
		let query;
		let count;
		let direction;
		if (options !== void 0) {
			if (options.query !== void 0) query = options.query;
			if (options.count !== void 0) count = enforceRange(options.count, "unsigned long");
			if (options.direction !== void 0) direction = options.direction;
		}
		confirmActiveTransaction$1(this);
		const range = valueToKeyRange(query);
		return this.objectStore.transaction._execRequestAsync({
			operation: this._rawIndex.getAllRecords.bind(this._rawIndex, range, count, direction),
			source: this
		});
	}
	count(key) {
		confirmActiveTransaction$1(this);
		if (key === null) key = void 0;
		if (key !== void 0 && !(key instanceof FDBKeyRange)) key = FDBKeyRange.only(valueToKey(key));
		return this.objectStore.transaction._execRequestAsync({
			operation: () => {
				return this._rawIndex.count(key);
			},
			source: this
		});
	}
	get [Symbol.toStringTag]() {
		return "IDBIndex";
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/canInjectKey.js
const canInjectKey = (keyPath, value) => {
	if (Array.isArray(keyPath)) throw new Error("The key paths used in this section are always strings and never sequences, since it is not possible to create a object store which has a key generator and also has a key path that is a sequence.");
	const identifiers = keyPath.split(".");
	if (identifiers.length === 0) throw new Error("Assert: identifiers is not empty");
	identifiers.pop();
	for (const identifier of identifiers) {
		if (typeof value !== "object" && !Array.isArray(value)) return false;
		if (!Object.hasOwn(value, identifier)) return true;
		value = value[identifier];
	}
	return typeof value === "object" || Array.isArray(value);
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/FDBRecord.js
var FDBRecord = class {
	constructor(key, primaryKey, value) {
		this._key = key;
		this._primaryKey = primaryKey;
		this._value = value;
	}
	get key() {
		return this._key;
	}
	set key(_) {}
	get primaryKey() {
		return this._primaryKey;
	}
	set primaryKey(_) {}
	get value() {
		return this._value;
	}
	set value(_) {}
	get [Symbol.toStringTag]() {
		return "IDBRecord";
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/binarySearchTree.js
const MAX_TOMBSTONE_FACTOR = 2 / 3;
const EVERYTHING_KEY_RANGE = new FDBKeyRange(void 0, void 0, false, false);
/**
* Simple red-black binary tree with some aspects of a scapegoat tree. The main goal here is simplicity of
* implementation, tailored to the needs of IndexedDB.
*
* Basically this implements a [red-black tree][1] for insertions, but uses the much simpler [scapegoat tree][2]
* strategy for deletions. Deletions are a simple matter of rebuilding the tree from scratch if more than 2/3 of the
* tree is full of deleted (tombstone) markers.
*
* [1]: https://en.wikipedia.org/wiki/Red%E2%80%93black_tree
* [2]: https://en.wikipedia.org/wiki/Scapegoat_tree
*/
var BinarySearchTree = class {
	_numTombstones = 0;
	_numNodes = 0;
	/**
	*
	* @param keysAreUnique - whether keys can be unique, and thus whether we cn skip checking `record.value` when
	* comparing. This is basically used to distinguish ObjectStores (where the value is the entire object, not used
	* as a key) from non-unique Indexes (where both the key and the value are meaningful keys used for sorting)
	*/
	constructor(keysAreUnique) {
		this._keysAreUnique = !!keysAreUnique;
	}
	size() {
		return this._numNodes - this._numTombstones;
	}
	get(record) {
		return this._getByComparator(this._root, (otherRecord) => this._compare(record, otherRecord));
	}
	contains(record) {
		return !!this.get(record);
	}
	_compare(a, b) {
		const keyComparison = cmp(a.key, b.key);
		if (keyComparison !== 0) return keyComparison;
		return this._keysAreUnique ? 0 : cmp(a.value, b.value);
	}
	_getByComparator(node, comparator) {
		let current = node;
		while (current) {
			const comparison = comparator(current.record);
			if (comparison < 0) current = current.left;
			else if (comparison > 0) current = current.right;
			else return current.record;
		}
	}
	/**
	* Put a new record, and return the overwritten record if an overwrite occurred.
	* @param record
	* @param noOverwrite - throw a ConstraintError in case of overwrite
	*/
	put(record, noOverwrite = false) {
		if (!this._root) {
			this._root = {
				record,
				left: void 0,
				right: void 0,
				parent: void 0,
				deleted: false,
				red: false
			};
			this._numNodes++;
			return;
		}
		return this._put(this._root, record, noOverwrite);
	}
	_put(node, record, noOverwrite) {
		const comparison = this._compare(record, node.record);
		if (comparison < 0) if (node.left) return this._put(node.left, record, noOverwrite);
		else {
			node.left = {
				record,
				left: void 0,
				right: void 0,
				parent: node,
				deleted: false,
				red: true
			};
			this._onNewNodeInserted(node.left);
		}
		else if (comparison > 0) if (node.right) return this._put(node.right, record, noOverwrite);
		else {
			node.right = {
				record,
				left: void 0,
				right: void 0,
				parent: node,
				deleted: false,
				red: true
			};
			this._onNewNodeInserted(node.right);
		}
		else if (node.deleted) {
			node.deleted = false;
			node.record = record;
			this._numTombstones--;
		} else if (noOverwrite) throw new ConstraintError();
		else {
			const overwrittenRecord = node.record;
			node.record = record;
			return overwrittenRecord;
		}
	}
	delete(record) {
		if (!this._root) return;
		this._delete(this._root, record);
		if (this._numTombstones > this._numNodes * MAX_TOMBSTONE_FACTOR) {
			const records = [...this.getAllRecords()];
			this._root = this._rebuild(records, void 0, false);
			this._numNodes = records.length;
			this._numTombstones = 0;
		}
	}
	_delete(node, record) {
		if (!node) return;
		const comparison = this._compare(record, node.record);
		if (comparison < 0) this._delete(node.left, record);
		else if (comparison > 0) this._delete(node.right, record);
		else if (!node.deleted) {
			this._numTombstones++;
			node.deleted = true;
		}
	}
	*getAllRecords(descending = false) {
		yield* this.getRecords(EVERYTHING_KEY_RANGE, descending);
	}
	*getRecords(keyRange, descending = false) {
		yield* this._getRecordsForNode(this._root, keyRange, descending);
	}
	*_getRecordsForNode(node, keyRange, descending = false) {
		if (!node) return;
		yield* this._findRecords(node, keyRange, descending);
	}
	*_findRecords(node, keyRange, descending = false) {
		const { lower, upper, lowerOpen, upperOpen } = keyRange;
		const { record: { key } } = node;
		const lowerComparison = lower === void 0 ? -1 : cmp(lower, key);
		const upperComparison = upper === void 0 ? 1 : cmp(upper, key);
		const moreLeft = this._keysAreUnique ? lowerComparison < 0 : lowerComparison <= 0;
		const moreRight = this._keysAreUnique ? upperComparison > 0 : upperComparison >= 0;
		const moreStart = descending ? moreRight : moreLeft;
		const moreEnd = descending ? moreLeft : moreRight;
		const start = descending ? "right" : "left";
		const end = descending ? "left" : "right";
		const lowerMatches = lowerOpen ? lowerComparison < 0 : lowerComparison <= 0;
		const upperMatches = upperOpen ? upperComparison > 0 : upperComparison >= 0;
		if (moreStart && node[start]) yield* this._findRecords(node[start], keyRange, descending);
		if (lowerMatches && upperMatches && !node.deleted) yield node.record;
		if (moreEnd && node[end]) yield* this._findRecords(node[end], keyRange, descending);
	}
	_onNewNodeInserted(newNode) {
		this._numNodes++;
		this._rebalanceTree(newNode);
	}
	_rebalanceTree(node) {
		let parent = node.parent;
		do {
			if (!parent.red) return;
			const grandparent = parent.parent;
			if (!grandparent) {
				parent.red = false;
				return;
			}
			const parentIsRightChild = parent === grandparent.right;
			const uncle = parentIsRightChild ? grandparent.left : grandparent.right;
			if (!uncle || !uncle.red) {
				if (node === (parentIsRightChild ? parent.left : parent.right)) {
					this._rotateSubtree(parent, parentIsRightChild);
					node = parent;
					parent = parentIsRightChild ? grandparent.right : grandparent.left;
				}
				this._rotateSubtree(grandparent, !parentIsRightChild);
				parent.red = false;
				grandparent.red = true;
				return;
			}
			parent.red = false;
			uncle.red = false;
			grandparent.red = true;
			node = grandparent;
		} while (node.parent ? parent = node.parent : false);
	}
	_rotateSubtree(node, right) {
		const parent = node.parent;
		const newRoot = right ? node.left : node.right;
		const newChild = right ? newRoot.right : newRoot.left;
		node[right ? "left" : "right"] = newChild;
		if (newChild) newChild.parent = node;
		newRoot[right ? "right" : "left"] = node;
		newRoot.parent = parent;
		node.parent = newRoot;
		if (parent) parent[node === parent.right ? "right" : "left"] = newRoot;
		else this._root = newRoot;
		return newRoot;
	}
	_rebuild(records, parent, red) {
		const { length } = records;
		if (!length) return;
		const mid = length >>> 1;
		const node = {
			record: records[mid],
			left: void 0,
			right: void 0,
			parent,
			deleted: false,
			red
		};
		const left = this._rebuild(records.slice(0, mid), node, !red);
		const right = this._rebuild(records.slice(mid + 1), node, !red);
		node.left = left;
		node.right = right;
		return node;
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/RecordStore.js
var RecordStore = class {
	constructor(keysAreUnique) {
		this.keysAreUnique = keysAreUnique;
		this.records = new BinarySearchTree(this.keysAreUnique);
	}
	get(key) {
		const range = key instanceof FDBKeyRange ? key : FDBKeyRange.only(key);
		return this.records.getRecords(range).next().value;
	}
	/**
	* Put a new record, and return the overwritten record if an overwrite occurred.
	* @param newRecord
	* @param noOverwrite - throw a ConstraintError in case of overwrite
	*/
	put(newRecord, noOverwrite = false) {
		return this.records.put(newRecord, noOverwrite);
	}
	delete(key) {
		const range = key instanceof FDBKeyRange ? key : FDBKeyRange.only(key);
		const deletedRecords = [...this.records.getRecords(range)];
		for (const record of deletedRecords) this.records.delete(record);
		return deletedRecords;
	}
	deleteByValue(key) {
		const range = key instanceof FDBKeyRange ? key : FDBKeyRange.only(key);
		const deletedRecords = [];
		for (const record of this.records.getAllRecords()) if (range.includes(record.value)) {
			this.records.delete(record);
			deletedRecords.push(record);
		}
		return deletedRecords;
	}
	clear() {
		const deletedRecords = [...this.records.getAllRecords()];
		this.records = new BinarySearchTree(this.keysAreUnique);
		return deletedRecords;
	}
	values(range, direction = "next") {
		const descending = direction === "prev" || direction === "prevunique";
		const records = range ? this.records.getRecords(range, descending) : this.records.getAllRecords(descending);
		return { [Symbol.iterator]: () => {
			const next = () => {
				return records.next();
			};
			if (direction === "next" || direction === "prev") return { next };
			if (direction === "nextunique") {
				let previousValue = void 0;
				return { next: () => {
					let current = next();
					while (!current.done && previousValue !== void 0 && cmp(previousValue.key, current.value.key) === 0) current = next();
					previousValue = current.value;
					return current;
				} };
			}
			let current = next();
			let nextResult = next();
			return { next: () => {
				while (!nextResult.done && cmp(current.value.key, nextResult.value.key) === 0) {
					current = nextResult;
					nextResult = next();
				}
				const result = current;
				current = nextResult;
				nextResult = next();
				return result;
			} };
		} };
	}
	size() {
		return this.records.size();
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/Index.js
var Index = class {
	deleted = false;
	initialized = false;
	constructor(rawObjectStore, name, keyPath, multiEntry, unique) {
		this.rawObjectStore = rawObjectStore;
		this.name = name;
		this.keyPath = keyPath;
		this.multiEntry = multiEntry;
		this.unique = unique;
		this.records = new RecordStore(unique);
	}
	getKey(key) {
		const record = this.records.get(key);
		return record !== void 0 ? record.value : void 0;
	}
	getAllKeys(range, count, direction) {
		if (count === void 0 || count === 0) count = Infinity;
		const records = [];
		for (const record of this.records.values(range, direction)) {
			records.push(structuredClone(record.value));
			if (records.length >= count) break;
		}
		return records;
	}
	getValue(key) {
		const record = this.records.get(key);
		return record !== void 0 ? this.rawObjectStore.getValue(record.value) : void 0;
	}
	getAllValues(range, count, direction) {
		if (count === void 0 || count === 0) count = Infinity;
		const records = [];
		for (const record of this.records.values(range, direction)) {
			records.push(this.rawObjectStore.getValue(record.value));
			if (records.length >= count) break;
		}
		return records;
	}
	getAllRecords(range, count, direction) {
		if (count === void 0 || count === 0) count = Infinity;
		const records = [];
		for (const record of this.records.values(range, direction)) {
			records.push(new FDBRecord(structuredClone(record.key), structuredClone(this.rawObjectStore.getKey(record.value)), this.rawObjectStore.getValue(record.value)));
			if (records.length >= count) break;
		}
		return records;
	}
	storeRecord(newRecord) {
		let indexKey;
		try {
			indexKey = extractKey(this.keyPath, newRecord.value).key;
		} catch (err) {
			if (err.name === "DataError") return;
			throw err;
		}
		if (!this.multiEntry || !Array.isArray(indexKey)) try {
			valueToKey(indexKey);
		} catch (e) {
			return;
		}
		else {
			const keep = [];
			for (const part of indexKey) if (keep.indexOf(part) < 0) try {
				keep.push(valueToKey(part));
			} catch (err) {}
			indexKey = keep;
		}
		if (!this.multiEntry || !Array.isArray(indexKey)) {
			if (this.unique) {
				if (this.records.get(indexKey)) throw new ConstraintError();
			}
		} else if (this.unique) {
			for (const individualIndexKey of indexKey) if (this.records.get(individualIndexKey)) throw new ConstraintError();
		}
		if (!this.multiEntry || !Array.isArray(indexKey)) this.records.put({
			key: indexKey,
			value: newRecord.key
		});
		else for (const individualIndexKey of indexKey) this.records.put({
			key: individualIndexKey,
			value: newRecord.key
		});
	}
	initialize(transaction) {
		if (this.initialized) throw new Error("Index already initialized");
		transaction._execRequestAsync({
			operation: () => {
				try {
					for (const record of this.rawObjectStore.records.values()) this.storeRecord(record);
					this.initialized = true;
				} catch (err) {
					transaction._abort(err.name);
				}
			},
			source: null
		});
	}
	count(range) {
		let count = 0;
		for (const record of this.records.values(range)) count += 1;
		return count;
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/validateKeyPath.js
const validateKeyPath = (keyPath, parent) => {
	if (keyPath !== void 0 && keyPath !== null && typeof keyPath !== "string" && keyPath.toString && (parent === "array" || !Array.isArray(keyPath))) keyPath = keyPath.toString();
	if (typeof keyPath === "string") {
		if (keyPath === "" && parent !== "string") return;
		try {
			if (keyPath.length >= 1 && /^(?:[$A-Z_a-z\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0-\u08B2\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58\u0C59\u0C60\u0C61\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D60\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F4\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19C1-\u19C7\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FCC\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA78E\uA790-\uA7AD\uA7B0\uA7B1\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB5F\uAB64\uAB65\uABC0-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC])(?:[$0-9A-Z_a-z\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05F0-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u0800-\u082D\u0840-\u085B\u08A0-\u08B2\u08E4-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58\u0C59\u0C60-\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D01-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D57\u0D60-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1380-\u138F\u13A0-\u13F4\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1877\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19D9\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1CD0-\u1CD2\u1CD4-\u1CF6\u1CF8\u1CF9\u1D00-\u1DF5\u1DFC-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u200C\u200D\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u2E2F\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099\u309A\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FCC\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA69D\uA69F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA78E\uA790-\uA7AD\uA7B0\uA7B1\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C4\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA900-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB5F\uAB64\uAB65\uABC0-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2D\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC])*$/.test(keyPath)) return;
		} catch (err) {
			throw new SyntaxError(err.message);
		}
		if (keyPath.indexOf(" ") >= 0) throw new SyntaxError("The keypath argument contains an invalid key path (no spaces allowed).");
	}
	if (Array.isArray(keyPath) && keyPath.length > 0) {
		if (parent) throw new SyntaxError("The keypath argument contains an invalid key path (nested arrays).");
		for (const part of keyPath) validateKeyPath(part, "array");
		return;
	} else if (typeof keyPath === "string" && keyPath.indexOf(".") >= 0) {
		keyPath = keyPath.split(".");
		for (const part of keyPath) validateKeyPath(part, "string");
		return;
	}
	throw new SyntaxError();
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/FDBObjectStore.js
const confirmActiveTransaction = (objectStore) => {
	if (objectStore._rawObjectStore.deleted) throw new InvalidStateError();
	if (objectStore.transaction._state !== "active") throw new TransactionInactiveError();
};
const buildRecordAddPut = (objectStore, value, key) => {
	confirmActiveTransaction(objectStore);
	if (objectStore.transaction.mode === "readonly") throw new ReadOnlyError();
	if (objectStore.keyPath !== null) {
		if (key !== void 0) throw new DataError();
	}
	const clone = cloneValueForInsertion(value, objectStore.transaction);
	if (objectStore.keyPath !== null) {
		const tempKey = extractKey(objectStore.keyPath, clone);
		if (tempKey.type === "found") valueToKey(tempKey.key);
		else if (!objectStore._rawObjectStore.keyGenerator) throw new DataError();
		else if (!canInjectKey(objectStore.keyPath, clone)) throw new DataError();
	}
	if (objectStore.keyPath === null && objectStore._rawObjectStore.keyGenerator === null && key === void 0) throw new DataError();
	if (key !== void 0) key = valueToKey(key);
	return {
		key,
		value: clone
	};
};
var FDBObjectStore = class {
	_indexesCache = /* @__PURE__ */ new Map();
	constructor(transaction, rawObjectStore) {
		this._rawObjectStore = rawObjectStore;
		this._name = rawObjectStore.name;
		this.keyPath = getKeyPath(rawObjectStore.keyPath);
		this.autoIncrement = rawObjectStore.autoIncrement;
		this.transaction = transaction;
		this.indexNames = new FakeDOMStringList(...Array.from(rawObjectStore.rawIndexes.keys()).sort());
	}
	get name() {
		return this._name;
	}
	set name(name) {
		const transaction = this.transaction;
		if (!transaction.db._runningVersionchangeTransaction) throw transaction._state === "active" ? new InvalidStateError() : new TransactionInactiveError();
		confirmActiveTransaction(this);
		name = String(name);
		if (name === this._name) return;
		if (this._rawObjectStore.rawDatabase.rawObjectStores.has(name)) throw new ConstraintError();
		const oldName = this._name;
		const oldObjectStoreNames = [...transaction.db.objectStoreNames];
		this._name = name;
		this._rawObjectStore.name = name;
		this.transaction._objectStoresCache.delete(oldName);
		this.transaction._objectStoresCache.set(name, this);
		this._rawObjectStore.rawDatabase.rawObjectStores.delete(oldName);
		this._rawObjectStore.rawDatabase.rawObjectStores.set(name, this._rawObjectStore);
		transaction.db.objectStoreNames = new FakeDOMStringList(...Array.from(this._rawObjectStore.rawDatabase.rawObjectStores.keys()).filter((objectStoreName) => {
			const objectStore = this._rawObjectStore.rawDatabase.rawObjectStores.get(objectStoreName);
			return objectStore && !objectStore.deleted;
		}).sort());
		const oldScope = new Set(transaction._scope);
		const oldTransactionObjectStoreNames = [...transaction.objectStoreNames];
		this.transaction._scope.delete(oldName);
		transaction._scope.add(name);
		transaction.objectStoreNames = new FakeDOMStringList(...Array.from(transaction._scope).sort());
		if (!this.transaction._createdObjectStores.has(this._rawObjectStore)) transaction._rollbackLog.push(() => {
			this._name = oldName;
			this._rawObjectStore.name = oldName;
			this.transaction._objectStoresCache.delete(name);
			this.transaction._objectStoresCache.set(oldName, this);
			this._rawObjectStore.rawDatabase.rawObjectStores.delete(name);
			this._rawObjectStore.rawDatabase.rawObjectStores.set(oldName, this._rawObjectStore);
			transaction.db.objectStoreNames = new FakeDOMStringList(...oldObjectStoreNames);
			transaction._scope = oldScope;
			transaction.objectStoreNames = new FakeDOMStringList(...oldTransactionObjectStoreNames);
		});
	}
	put(value, key) {
		if (arguments.length === 0) throw new TypeError();
		const record = buildRecordAddPut(this, value, key);
		return this.transaction._execRequestAsync({
			operation: this._rawObjectStore.storeRecord.bind(this._rawObjectStore, record, false, this.transaction._rollbackLog),
			source: this
		});
	}
	add(value, key) {
		if (arguments.length === 0) throw new TypeError();
		const record = buildRecordAddPut(this, value, key);
		return this.transaction._execRequestAsync({
			operation: this._rawObjectStore.storeRecord.bind(this._rawObjectStore, record, true, this.transaction._rollbackLog),
			source: this
		});
	}
	delete(key) {
		if (arguments.length === 0) throw new TypeError();
		confirmActiveTransaction(this);
		if (this.transaction.mode === "readonly") throw new ReadOnlyError();
		if (!(key instanceof FDBKeyRange)) key = valueToKey(key);
		return this.transaction._execRequestAsync({
			operation: this._rawObjectStore.deleteRecord.bind(this._rawObjectStore, key, this.transaction._rollbackLog),
			source: this
		});
	}
	get(key) {
		if (arguments.length === 0) throw new TypeError();
		confirmActiveTransaction(this);
		if (!(key instanceof FDBKeyRange)) key = valueToKey(key);
		return this.transaction._execRequestAsync({
			operation: this._rawObjectStore.getValue.bind(this._rawObjectStore, key),
			source: this
		});
	}
	getAll(queryOrOptions, count) {
		const options = extractGetAllOptions(queryOrOptions, count, arguments.length);
		confirmActiveTransaction(this);
		const range = valueToKeyRange(options.query);
		return this.transaction._execRequestAsync({
			operation: this._rawObjectStore.getAllValues.bind(this._rawObjectStore, range, options.count, options.direction),
			source: this
		});
	}
	getKey(key) {
		if (arguments.length === 0) throw new TypeError();
		confirmActiveTransaction(this);
		if (!(key instanceof FDBKeyRange)) key = valueToKey(key);
		return this.transaction._execRequestAsync({
			operation: this._rawObjectStore.getKey.bind(this._rawObjectStore, key),
			source: this
		});
	}
	getAllKeys(queryOrOptions, count) {
		const options = extractGetAllOptions(queryOrOptions, count, arguments.length);
		confirmActiveTransaction(this);
		const range = valueToKeyRange(options.query);
		return this.transaction._execRequestAsync({
			operation: this._rawObjectStore.getAllKeys.bind(this._rawObjectStore, range, options.count, options.direction),
			source: this
		});
	}
	getAllRecords(options) {
		let query;
		let count;
		let direction;
		if (options !== void 0) {
			if (options.query !== void 0) query = options.query;
			if (options.count !== void 0) count = enforceRange(options.count, "unsigned long");
			if (options.direction !== void 0) direction = options.direction;
		}
		confirmActiveTransaction(this);
		const range = valueToKeyRange(query);
		return this.transaction._execRequestAsync({
			operation: this._rawObjectStore.getAllRecords.bind(this._rawObjectStore, range, count, direction),
			source: this
		});
	}
	clear() {
		confirmActiveTransaction(this);
		if (this.transaction.mode === "readonly") throw new ReadOnlyError();
		return this.transaction._execRequestAsync({
			operation: this._rawObjectStore.clear.bind(this._rawObjectStore, this.transaction._rollbackLog),
			source: this
		});
	}
	openCursor(range, direction) {
		confirmActiveTransaction(this);
		if (range === null) range = void 0;
		if (range !== void 0 && !(range instanceof FDBKeyRange)) range = FDBKeyRange.only(valueToKey(range));
		const request = new FDBRequest();
		request.source = this;
		request.transaction = this.transaction;
		const cursor = new FDBCursorWithValue(this, range, direction, request);
		return this.transaction._execRequestAsync({
			operation: cursor._iterate.bind(cursor),
			request,
			source: this
		});
	}
	openKeyCursor(range, direction) {
		confirmActiveTransaction(this);
		if (range === null) range = void 0;
		if (range !== void 0 && !(range instanceof FDBKeyRange)) range = FDBKeyRange.only(valueToKey(range));
		const request = new FDBRequest();
		request.source = this;
		request.transaction = this.transaction;
		const cursor = new FDBCursor(this, range, direction, request, true);
		return this.transaction._execRequestAsync({
			operation: cursor._iterate.bind(cursor),
			request,
			source: this
		});
	}
	createIndex(name, keyPath, optionalParameters = {}) {
		if (arguments.length < 2) throw new TypeError();
		const multiEntry = optionalParameters.multiEntry !== void 0 ? optionalParameters.multiEntry : false;
		const unique = optionalParameters.unique !== void 0 ? optionalParameters.unique : false;
		if (this.transaction.mode !== "versionchange") throw new InvalidStateError();
		confirmActiveTransaction(this);
		if (this.indexNames.contains(name)) throw new ConstraintError();
		validateKeyPath(keyPath);
		if (Array.isArray(keyPath) && multiEntry) throw new InvalidAccessError();
		const indexNames = [...this.indexNames];
		const index = new Index(this._rawObjectStore, name, keyPath, multiEntry, unique);
		this.indexNames._push(name);
		this.indexNames._sort();
		this.transaction._createdIndexes.add(index);
		this._rawObjectStore.rawIndexes.set(name, index);
		index.initialize(this.transaction);
		this.transaction._rollbackLog.push(() => {
			index.deleted = true;
			this.indexNames = new FakeDOMStringList(...indexNames);
			this._rawObjectStore.rawIndexes.delete(index.name);
		});
		return new FDBIndex(this, index);
	}
	index(name) {
		if (arguments.length === 0) throw new TypeError();
		if (this._rawObjectStore.deleted || this.transaction._state === "finished") throw new InvalidStateError();
		const index = this._indexesCache.get(name);
		if (index !== void 0) return index;
		const rawIndex = this._rawObjectStore.rawIndexes.get(name);
		if (!this.indexNames.contains(name) || rawIndex === void 0) throw new NotFoundError();
		const index2 = new FDBIndex(this, rawIndex);
		this._indexesCache.set(name, index2);
		return index2;
	}
	deleteIndex(name) {
		if (arguments.length === 0) throw new TypeError();
		if (this.transaction.mode !== "versionchange") throw new InvalidStateError();
		confirmActiveTransaction(this);
		const rawIndex = this._rawObjectStore.rawIndexes.get(name);
		if (rawIndex === void 0) throw new NotFoundError();
		this.transaction._rollbackLog.push(() => {
			rawIndex.deleted = false;
			this._rawObjectStore.rawIndexes.set(rawIndex.name, rawIndex);
			this.indexNames._push(rawIndex.name);
			this.indexNames._sort();
		});
		this.indexNames = new FakeDOMStringList(...Array.from(this.indexNames).filter((indexName) => {
			return indexName !== name;
		}));
		rawIndex.deleted = true;
		this.transaction._execRequestAsync({
			operation: () => {
				if (rawIndex === this._rawObjectStore.rawIndexes.get(name)) this._rawObjectStore.rawIndexes.delete(name);
			},
			source: this
		});
	}
	count(key) {
		confirmActiveTransaction(this);
		if (key === null) key = void 0;
		if (key !== void 0 && !(key instanceof FDBKeyRange)) key = FDBKeyRange.only(valueToKey(key));
		return this.transaction._execRequestAsync({
			operation: () => {
				return this._rawObjectStore.count(key);
			},
			source: this
		});
	}
	get [Symbol.toStringTag]() {
		return "IDBObjectStore";
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/FakeEvent.js
var Event = class {
	eventPath = [];
	NONE = 0;
	CAPTURING_PHASE = 1;
	AT_TARGET = 2;
	BUBBLING_PHASE = 3;
	propagationStopped = false;
	immediatePropagationStopped = false;
	canceled = false;
	initialized = true;
	dispatched = false;
	target = null;
	currentTarget = null;
	eventPhase = 0;
	defaultPrevented = false;
	isTrusted = false;
	timeStamp = Date.now();
	constructor(type, eventInitDict = {}) {
		this.type = type;
		this.bubbles = eventInitDict.bubbles !== void 0 ? eventInitDict.bubbles : false;
		this.cancelable = eventInitDict.cancelable !== void 0 ? eventInitDict.cancelable : false;
	}
	preventDefault() {
		if (this.cancelable) this.canceled = true;
	}
	stopPropagation() {
		this.propagationStopped = true;
	}
	stopImmediatePropagation() {
		this.propagationStopped = true;
		this.immediatePropagationStopped = true;
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/scheduling.js
function getSetImmediateFromJsdom() {
	if (typeof navigator !== "undefined" && /jsdom/.test(navigator.userAgent)) {
		const outerRealmFunctionConstructor = Node.constructor;
		return new outerRealmFunctionConstructor("return setImmediate")();
	} else return;
}
const schedulerPostTask = typeof scheduler !== "undefined" && ((fn) => scheduler.postTask(fn));
const doSetTimeout = (fn) => setTimeout(fn, 0);
const queueTask = (fn) => {
	(globalThis.setImmediate || getSetImmediateFromJsdom() || schedulerPostTask || doSetTimeout)(fn);
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/FDBTransaction.js
const prioritizedListenerTypes = [
	"error",
	"abort",
	"complete"
];
var FDBTransaction = class extends FakeEventTarget {
	_state = "active";
	_started = false;
	_rollbackLog = [];
	_objectStoresCache = /* @__PURE__ */ new Map();
	_openRequest = null;
	error = null;
	onabort = null;
	oncomplete = null;
	onerror = null;
	_prioritizedListeners = /* @__PURE__ */ new Map();
	_requests = [];
	_createdIndexes = /* @__PURE__ */ new Set();
	_createdObjectStores = /* @__PURE__ */ new Set();
	constructor(storeNames, mode, durability, db) {
		super();
		this._scope = new Set(storeNames);
		this.mode = mode;
		this.durability = durability;
		this.db = db;
		this.objectStoreNames = new FakeDOMStringList(...Array.from(this._scope).sort());
		for (const type of prioritizedListenerTypes) this.addEventListener(type, () => {
			this._prioritizedListeners.get(type)?.();
		});
	}
	_abort(errName) {
		for (const f of this._rollbackLog.reverse()) f();
		if (errName !== null) {
			const e = new DOMException(void 0, errName);
			this.error = e;
		}
		for (const { request } of this._requests) if (request.readyState !== "done") {
			request.readyState = "done";
			if (request.source) queueTask(() => {
				request.result = void 0;
				request.error = new AbortError();
				const event = new Event("error", {
					bubbles: true,
					cancelable: true
				});
				event.eventPath = [this.db, this];
				try {
					request.dispatchEvent(event);
				} catch (_err) {
					if (this._state === "active") this._abort("AbortError");
				}
			});
		}
		queueTask(() => {
			const isUpgradeTransaction = this.mode === "versionchange";
			if (isUpgradeTransaction) this.db._rawDatabase.connections = this.db._rawDatabase.connections.filter((connection) => !connection._rawDatabase.transactions.includes(this));
			const event = new Event("abort", {
				bubbles: true,
				cancelable: false
			});
			event.eventPath = [this.db];
			this.dispatchEvent(event);
			if (isUpgradeTransaction) {
				const request = this._openRequest;
				request.transaction = null;
				request.result = void 0;
			}
		});
		this._state = "finished";
	}
	abort() {
		if (this._state === "committing" || this._state === "finished") throw new InvalidStateError();
		this._state = "active";
		this._abort(null);
	}
	objectStore(name) {
		if (this._state !== "active") throw new InvalidStateError();
		const objectStore = this._objectStoresCache.get(name);
		if (objectStore !== void 0) return objectStore;
		const rawObjectStore = this.db._rawDatabase.rawObjectStores.get(name);
		if (!this._scope.has(name) || rawObjectStore === void 0) throw new NotFoundError();
		const objectStore2 = new FDBObjectStore(this, rawObjectStore);
		this._objectStoresCache.set(name, objectStore2);
		return objectStore2;
	}
	_execRequestAsync(obj) {
		const source = obj.source;
		const operation = obj.operation;
		let request = Object.hasOwn(obj, "request") ? obj.request : null;
		if (this._state !== "active") throw new TransactionInactiveError();
		if (!request) if (!source) request = new FDBRequest();
		else {
			request = new FDBRequest();
			request.source = source;
			request.transaction = source.transaction;
		}
		this._requests.push({
			operation,
			request
		});
		return request;
	}
	_start() {
		this._started = true;
		let operation;
		let request;
		while (this._requests.length > 0) {
			const r = this._requests.shift();
			if (r && r.request.readyState !== "done") {
				request = r.request;
				operation = r.operation;
				break;
			}
		}
		if (request && operation) {
			if (!request.source) operation();
			else {
				let defaultAction;
				let event;
				try {
					const result = operation();
					request.readyState = "done";
					request.result = result;
					request.error = void 0;
					if (this._state === "inactive") this._state = "active";
					event = new Event("success", {
						bubbles: false,
						cancelable: false
					});
				} catch (err) {
					request.readyState = "done";
					request.result = void 0;
					request.error = err;
					if (this._state === "inactive") this._state = "active";
					event = new Event("error", {
						bubbles: true,
						cancelable: true
					});
					defaultAction = this._abort.bind(this, err.name);
				}
				try {
					event.eventPath = [this.db, this];
					request.dispatchEvent(event);
				} catch (_err) {
					if (this._state === "active") {
						this._abort("AbortError");
						defaultAction = void 0;
					}
				}
				if (!event.canceled) {
					if (defaultAction) defaultAction();
				}
			}
			queueTask(this._start.bind(this));
			return;
		}
		if (this._state !== "finished") {
			this._state = "finished";
			if (!this.error) {
				const event = new Event("complete");
				this.dispatchEvent(event);
			}
		}
	}
	commit() {
		if (this._state !== "active") throw new InvalidStateError();
		this._state = "committing";
	}
	get [Symbol.toStringTag]() {
		return "IDBTransaction";
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/KeyGenerator.js
const MAX_KEY = 9007199254740992;
var KeyGenerator = class {
	num = 0;
	next() {
		if (this.num >= MAX_KEY) throw new ConstraintError();
		this.num += 1;
		return this.num;
	}
	setIfLarger(num) {
		const value = Math.floor(Math.min(num, MAX_KEY)) - 1;
		if (value >= this.num) this.num = value + 1;
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/ObjectStore.js
var ObjectStore = class {
	deleted = false;
	records = new RecordStore(true);
	rawIndexes = /* @__PURE__ */ new Map();
	constructor(rawDatabase, name, keyPath, autoIncrement) {
		this.rawDatabase = rawDatabase;
		this.keyGenerator = autoIncrement === true ? new KeyGenerator() : null;
		this.deleted = false;
		this.name = name;
		this.keyPath = keyPath;
		this.autoIncrement = autoIncrement;
	}
	getKey(key) {
		const record = this.records.get(key);
		return record !== void 0 ? structuredClone(record.key) : void 0;
	}
	getAllKeys(range, count, direction) {
		if (count === void 0 || count === 0) count = Infinity;
		const records = [];
		for (const record of this.records.values(range, direction)) {
			records.push(structuredClone(record.key));
			if (records.length >= count) break;
		}
		return records;
	}
	getValue(key) {
		const record = this.records.get(key);
		return record !== void 0 ? structuredClone(record.value) : void 0;
	}
	getAllValues(range, count, direction) {
		if (count === void 0 || count === 0) count = Infinity;
		const records = [];
		for (const record of this.records.values(range, direction)) {
			records.push(structuredClone(record.value));
			if (records.length >= count) break;
		}
		return records;
	}
	getAllRecords(range, count, direction) {
		if (count === void 0 || count === 0) count = Infinity;
		const records = [];
		for (const record of this.records.values(range, direction)) {
			records.push(new FDBRecord(structuredClone(record.key), structuredClone(record.key), structuredClone(record.value)));
			if (records.length >= count) break;
		}
		return records;
	}
	storeRecord(newRecord, noOverwrite, rollbackLog) {
		if (this.keyPath !== null) {
			const key = extractKey(this.keyPath, newRecord.value).key;
			if (key !== void 0) newRecord.key = key;
		}
		const rollbackLogForThisOperation = [];
		if (this.keyGenerator !== null && newRecord.key === void 0) {
			let rolledBack = false;
			const keyGeneratorBefore = this.keyGenerator.num;
			const rollbackKeyGenerator = () => {
				if (rolledBack) return;
				rolledBack = true;
				if (this.keyGenerator) this.keyGenerator.num = keyGeneratorBefore;
			};
			rollbackLogForThisOperation.push(rollbackKeyGenerator);
			if (rollbackLog) rollbackLog.push(rollbackKeyGenerator);
			newRecord.key = this.keyGenerator.next();
			if (this.keyPath !== null) {
				if (Array.isArray(this.keyPath)) throw new Error("Cannot have an array key path in an object store with a key generator");
				let remainingKeyPath = this.keyPath;
				let object = newRecord.value;
				let identifier;
				let i = 0;
				while (i >= 0) {
					if (typeof object !== "object") throw new DataError();
					i = remainingKeyPath.indexOf(".");
					if (i >= 0) {
						identifier = remainingKeyPath.slice(0, i);
						remainingKeyPath = remainingKeyPath.slice(i + 1);
						if (!Object.hasOwn(object, identifier)) Object.defineProperty(object, identifier, {
							configurable: true,
							enumerable: true,
							writable: true,
							value: {}
						});
						object = object[identifier];
					}
				}
				identifier = remainingKeyPath;
				Object.defineProperty(object, identifier, {
					configurable: true,
					enumerable: true,
					writable: true,
					value: newRecord.key
				});
			}
		} else if (this.keyGenerator !== null && typeof newRecord.key === "number") this.keyGenerator.setIfLarger(newRecord.key);
		const existingRecord = this.records.put(newRecord, noOverwrite);
		let rolledBack = false;
		const rollbackStoreRecord = () => {
			if (rolledBack) return;
			rolledBack = true;
			if (existingRecord) this.storeRecord(existingRecord, false);
			else this.deleteRecord(newRecord.key);
		};
		rollbackLogForThisOperation.push(rollbackStoreRecord);
		if (rollbackLog) rollbackLog.push(rollbackStoreRecord);
		if (existingRecord) for (const rawIndex of this.rawIndexes.values()) rawIndex.records.deleteByValue(newRecord.key);
		try {
			for (const rawIndex of this.rawIndexes.values()) if (rawIndex.initialized) rawIndex.storeRecord(newRecord);
		} catch (err) {
			if (err.name === "ConstraintError") for (const rollback of rollbackLogForThisOperation) rollback();
			throw err;
		}
		return newRecord.key;
	}
	deleteRecord(key, rollbackLog) {
		const deletedRecords = this.records.delete(key);
		if (rollbackLog) for (const record of deletedRecords) rollbackLog.push(() => {
			this.storeRecord(record, true);
		});
		for (const rawIndex of this.rawIndexes.values()) rawIndex.records.deleteByValue(key);
	}
	clear(rollbackLog) {
		const deletedRecords = this.records.clear();
		if (rollbackLog) for (const record of deletedRecords) rollbackLog.push(() => {
			this.storeRecord(record, true);
		});
		for (const rawIndex of this.rawIndexes.values()) rawIndex.records.clear();
	}
	count(range) {
		if (range === void 0 || range.lower === void 0 && range.upper === void 0) return this.records.size();
		let count = 0;
		for (const record of this.records.values(range)) count += 1;
		return count;
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/closeConnection.js
const closeConnection = (connection, forced = false) => {
	connection._closePending = true;
	if (connection._rawDatabase.transactions.every((transaction) => {
		return transaction._state === "finished";
	})) {
		connection._closed = true;
		connection._rawDatabase.connections = connection._rawDatabase.connections.filter((otherConnection) => {
			return connection !== otherConnection;
		});
		if (forced) {
			const event = new Event("close", {
				bubbles: false,
				cancelable: false
			});
			event.eventPath = [];
			connection.dispatchEvent(event);
		}
	} else queueTask(() => {
		closeConnection(connection, forced);
	});
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/FDBDatabase.js
const confirmActiveVersionchangeTransaction = (database) => {
	let transaction;
	if (database._runningVersionchangeTransaction) transaction = database._rawDatabase.transactions.findLast((tx) => {
		return tx.mode === "versionchange";
	});
	if (!transaction) throw new InvalidStateError();
	if (transaction._state !== "active") throw new TransactionInactiveError();
	return transaction;
};
var FDBDatabase = class extends FakeEventTarget {
	_closePending = false;
	_closed = false;
	_runningVersionchangeTransaction = false;
	constructor(rawDatabase) {
		super();
		this._rawDatabase = rawDatabase;
		this._rawDatabase.connections.push(this);
		this.name = rawDatabase.name;
		this.version = rawDatabase.version;
		this.objectStoreNames = new FakeDOMStringList(...Array.from(rawDatabase.rawObjectStores.keys()).sort());
	}
	createObjectStore(name, options = {}) {
		if (name === void 0) throw new TypeError();
		const transaction = confirmActiveVersionchangeTransaction(this);
		const keyPath = options !== null && options.keyPath !== void 0 ? options.keyPath : null;
		const autoIncrement = options !== null && options.autoIncrement !== void 0 ? options.autoIncrement : false;
		if (keyPath !== null) validateKeyPath(keyPath);
		if (this._rawDatabase.rawObjectStores.has(name)) throw new ConstraintError();
		if (autoIncrement && (keyPath === "" || Array.isArray(keyPath))) throw new InvalidAccessError();
		const objectStoreNames = [...this.objectStoreNames];
		const transactionObjectStoreNames = [...transaction.objectStoreNames];
		const rawObjectStore = new ObjectStore(this._rawDatabase, name, keyPath, autoIncrement);
		this.objectStoreNames._push(name);
		this.objectStoreNames._sort();
		transaction._scope.add(name);
		transaction._createdObjectStores.add(rawObjectStore);
		this._rawDatabase.rawObjectStores.set(name, rawObjectStore);
		transaction.objectStoreNames = new FakeDOMStringList(...this.objectStoreNames);
		transaction._rollbackLog.push(() => {
			rawObjectStore.deleted = true;
			this.objectStoreNames = new FakeDOMStringList(...objectStoreNames);
			transaction.objectStoreNames = new FakeDOMStringList(...transactionObjectStoreNames);
			transaction._scope.delete(rawObjectStore.name);
			this._rawDatabase.rawObjectStores.delete(rawObjectStore.name);
		});
		return transaction.objectStore(name);
	}
	deleteObjectStore(name) {
		if (name === void 0) throw new TypeError();
		const transaction = confirmActiveVersionchangeTransaction(this);
		const store = this._rawDatabase.rawObjectStores.get(name);
		if (store === void 0) throw new NotFoundError();
		this.objectStoreNames = new FakeDOMStringList(...Array.from(this.objectStoreNames).filter((objectStoreName) => {
			return objectStoreName !== name;
		}));
		transaction.objectStoreNames = new FakeDOMStringList(...this.objectStoreNames);
		const objectStore = transaction._objectStoresCache.get(name);
		let prevIndexNames;
		if (objectStore) {
			prevIndexNames = [...objectStore.indexNames];
			objectStore.indexNames = new FakeDOMStringList();
		}
		transaction._rollbackLog.push(() => {
			store.deleted = false;
			this._rawDatabase.rawObjectStores.set(store.name, store);
			this.objectStoreNames._push(store.name);
			transaction.objectStoreNames._push(store.name);
			this.objectStoreNames._sort();
			if (objectStore && prevIndexNames) objectStore.indexNames = new FakeDOMStringList(...prevIndexNames);
		});
		store.deleted = true;
		this._rawDatabase.rawObjectStores.delete(name);
		transaction._objectStoresCache.delete(name);
	}
	transaction(storeNames, mode, options) {
		mode = mode !== void 0 ? mode : "readonly";
		if (mode !== "readonly" && mode !== "readwrite" && mode !== "versionchange") throw new TypeError("Invalid mode: " + mode);
		if (this._rawDatabase.transactions.some((transaction) => {
			return transaction._state === "active" && transaction.mode === "versionchange" && transaction.db === this;
		})) throw new InvalidStateError();
		if (this._closePending) throw new InvalidStateError();
		if (!Array.isArray(storeNames)) storeNames = [storeNames];
		if (storeNames.length === 0 && mode !== "versionchange") throw new InvalidAccessError();
		for (const storeName of storeNames) if (!this.objectStoreNames.contains(storeName)) throw new NotFoundError("No objectStore named " + storeName + " in this database");
		const durability = options?.durability ?? "default";
		if (durability !== "default" && durability !== "strict" && durability !== "relaxed") throw new TypeError(`'${durability}' (value of 'durability' member of IDBTransactionOptions) is not a valid value for enumeration IDBTransactionDurability`);
		const tx = new FDBTransaction(storeNames, mode, durability, this);
		this._rawDatabase.transactions.push(tx);
		this._rawDatabase.processTransactions();
		return tx;
	}
	close() {
		closeConnection(this);
	}
	get [Symbol.toStringTag]() {
		return "IDBDatabase";
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/FDBOpenDBRequest.js
var FDBOpenDBRequest = class extends FDBRequest {
	onupgradeneeded = null;
	onblocked = null;
	get [Symbol.toStringTag]() {
		return "IDBOpenDBRequest";
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/FDBVersionChangeEvent.js
var FDBVersionChangeEvent = class extends Event {
	constructor(type, parameters = {}) {
		super(type);
		this.newVersion = parameters.newVersion !== void 0 ? parameters.newVersion : null;
		this.oldVersion = parameters.oldVersion !== void 0 ? parameters.oldVersion : 0;
	}
	get [Symbol.toStringTag]() {
		return "IDBVersionChangeEvent";
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/intersection.js
/**
* Minimal polyfill of `Set.prototype.intersection`, available in Node 22+.
* @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set/intersection
* @param set1
* @param set2
*/
function intersection(set1, set2) {
	if ("intersection" in set1) return set1.intersection(set2);
	return new Set([...set1].filter((item) => set2.has(item)));
}
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/Database.js
var Database = class {
	transactions = [];
	rawObjectStores = /* @__PURE__ */ new Map();
	connections = [];
	constructor(name, version) {
		this.name = name;
		this.version = version;
		this.processTransactions = this.processTransactions.bind(this);
	}
	processTransactions() {
		queueTask(() => {
			const running = this.transactions.filter((transaction) => transaction._started && transaction._state !== "finished");
			const waiting = this.transactions.filter((transaction) => !transaction._started && transaction._state !== "finished");
			const next = waiting.find((transaction, i) => {
				if (running.some((other) => !(transaction.mode === "readonly" && other.mode === "readonly") && intersection(other._scope, transaction._scope).size > 0)) return false;
				return !waiting.slice(0, i).some((other) => intersection(other._scope, transaction._scope).size > 0);
			});
			if (next) {
				next.addEventListener("complete", this.processTransactions);
				next.addEventListener("abort", this.processTransactions);
				next._start();
			}
		});
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/lib/validateRequiredArguments.js
function validateRequiredArguments(numArguments, expectedNumArguments, methodName) {
	if (numArguments < expectedNumArguments) throw new TypeError(`${methodName}: At least ${expectedNumArguments} ${expectedNumArguments === 1 ? "argument" : "arguments"} required, but only ${arguments.length} passed`);
}
//#endregion
//#region node_modules/fake-indexeddb/build/esm/FDBFactory.js
const runTaskInConnectionQueue = (connectionQueues, name, task) => {
	const queue = connectionQueues.get(name) ?? Promise.resolve();
	connectionQueues.set(name, queue.then(task));
};
const waitForOthersClosedDelete = (databases, name, openDatabases, cb) => {
	if (openDatabases.some((openDatabase2) => {
		return !openDatabase2._closed && !openDatabase2._closePending;
	})) {
		queueTask(() => waitForOthersClosedDelete(databases, name, openDatabases, cb));
		return;
	}
	databases.delete(name);
	cb(null);
};
const deleteDatabase = (databases, connectionQueues, name, request, cb) => {
	const deleteDBTask = () => {
		return new Promise((resolve) => {
			const db = databases.get(name);
			const oldVersion = db !== void 0 ? db.version : 0;
			const onComplete = (err) => {
				try {
					if (err) cb(err);
					else cb(null, oldVersion);
				} finally {
					resolve();
				}
			};
			try {
				const db = databases.get(name);
				if (db === void 0) {
					onComplete(null);
					return;
				}
				const openConnections = db.connections.filter((connection) => {
					return !connection._closed;
				});
				for (const openDatabase2 of openConnections) if (!openDatabase2._closePending) queueTask(() => {
					const event = new FDBVersionChangeEvent("versionchange", {
						newVersion: null,
						oldVersion: db.version
					});
					openDatabase2.dispatchEvent(event);
				});
				queueTask(() => {
					if (openConnections.some((openDatabase3) => {
						return !openDatabase3._closed && !openDatabase3._closePending;
					})) queueTask(() => {
						const event = new FDBVersionChangeEvent("blocked", {
							newVersion: null,
							oldVersion: db.version
						});
						request.dispatchEvent(event);
					});
					waitForOthersClosedDelete(databases, name, openConnections, onComplete);
				});
			} catch (err) {
				onComplete(err);
			}
		});
	};
	runTaskInConnectionQueue(connectionQueues, name, deleteDBTask);
};
const runVersionchangeTransaction = (connection, version, request, cb) => {
	connection._runningVersionchangeTransaction = true;
	const oldVersion = connection._oldVersion = connection.version;
	const openConnections = connection._rawDatabase.connections.filter((otherDatabase) => {
		return connection !== otherDatabase;
	});
	for (const openDatabase2 of openConnections) if (!openDatabase2._closed && !openDatabase2._closePending) queueTask(() => {
		const event = new FDBVersionChangeEvent("versionchange", {
			newVersion: version,
			oldVersion
		});
		openDatabase2.dispatchEvent(event);
	});
	queueTask(() => {
		if (openConnections.some((openDatabase3) => {
			return !openDatabase3._closed && !openDatabase3._closePending;
		})) queueTask(() => {
			const event = new FDBVersionChangeEvent("blocked", {
				newVersion: version,
				oldVersion
			});
			request.dispatchEvent(event);
		});
		const waitForOthersClosed = () => {
			if (openConnections.some((openDatabase2) => {
				return !openDatabase2._closed && !openDatabase2._closePending;
			})) {
				queueTask(waitForOthersClosed);
				return;
			}
			connection._rawDatabase.version = version;
			connection.version = version;
			const transaction = connection.transaction(Array.from(connection.objectStoreNames), "versionchange");
			transaction._openRequest = request;
			request.result = connection;
			request.readyState = "done";
			request.transaction = transaction;
			transaction._rollbackLog.push(() => {
				connection._rawDatabase.version = oldVersion;
				connection.version = oldVersion;
			});
			transaction._state = "active";
			const event = new FDBVersionChangeEvent("upgradeneeded", {
				newVersion: version,
				oldVersion
			});
			let didThrow = false;
			try {
				request.dispatchEvent(event);
			} catch (_err) {
				didThrow = true;
			}
			const concludeUpgrade = () => {
				if (transaction._state === "active") {
					transaction._state = "inactive";
					if (didThrow) transaction._abort("AbortError");
				}
			};
			if (didThrow) concludeUpgrade();
			else queueTask(concludeUpgrade);
			transaction._prioritizedListeners.set("error", () => {
				connection._runningVersionchangeTransaction = false;
				connection._oldVersion = void 0;
			});
			transaction._prioritizedListeners.set("abort", () => {
				connection._runningVersionchangeTransaction = false;
				connection._oldVersion = void 0;
				queueTask(() => {
					request.transaction = null;
					cb(new AbortError());
				});
			});
			transaction._prioritizedListeners.set("complete", () => {
				connection._runningVersionchangeTransaction = false;
				connection._oldVersion = void 0;
				queueTask(() => {
					request.transaction = null;
					if (connection._closePending) cb(new AbortError());
					else cb(null);
				});
			});
		};
		waitForOthersClosed();
	});
};
const openDatabase = (databases, connectionQueues, name, version, request, cb) => {
	const openDBTask = () => {
		return new Promise((resolve) => {
			const onComplete = (err) => {
				try {
					if (err) cb(err);
					else cb(null, connection);
				} finally {
					resolve();
				}
			};
			let db = databases.get(name);
			if (db === void 0) {
				db = new Database(name, 0);
				databases.set(name, db);
			}
			if (version === void 0) version = db.version !== 0 ? db.version : 1;
			if (db.version > version) return onComplete(new VersionError());
			const connection = new FDBDatabase(db);
			if (db.version < version) runVersionchangeTransaction(connection, version, request, (err) => {
				onComplete(err);
			});
			else onComplete(null);
		});
	};
	runTaskInConnectionQueue(connectionQueues, name, openDBTask);
};
var FDBFactory = class {
	_databases = /* @__PURE__ */ new Map();
	_connectionQueues = /* @__PURE__ */ new Map();
	cmp(first, second) {
		validateRequiredArguments(arguments.length, 2, "IDBFactory.cmp");
		return cmp(first, second);
	}
	deleteDatabase(name) {
		validateRequiredArguments(arguments.length, 1, "IDBFactory.deleteDatabase");
		const request = new FDBOpenDBRequest();
		request.source = null;
		queueTask(() => {
			deleteDatabase(this._databases, this._connectionQueues, name, request, (err, oldVersion) => {
				if (err) {
					request.error = new DOMException(err.message, err.name);
					request.readyState = "done";
					const event = new Event("error", {
						bubbles: true,
						cancelable: true
					});
					event.eventPath = [];
					request.dispatchEvent(event);
					return;
				}
				request.result = void 0;
				request.readyState = "done";
				const event2 = new FDBVersionChangeEvent("success", {
					newVersion: null,
					oldVersion
				});
				request.dispatchEvent(event2);
			});
		});
		return request;
	}
	open(name, version) {
		validateRequiredArguments(arguments.length, 1, "IDBFactory.open");
		if (arguments.length > 1 && version !== void 0) version = enforceRange(version, "MAX_SAFE_INTEGER");
		if (version === 0) throw new TypeError("Database version cannot be 0");
		const request = new FDBOpenDBRequest();
		request.source = null;
		queueTask(() => {
			openDatabase(this._databases, this._connectionQueues, name, version, request, (err, connection) => {
				if (err) {
					request.result = void 0;
					request.readyState = "done";
					request.error = new DOMException(err.message, err.name);
					const event = new Event("error", {
						bubbles: true,
						cancelable: true
					});
					event.eventPath = [];
					request.dispatchEvent(event);
					return;
				}
				request.result = connection;
				request.readyState = "done";
				const event2 = new Event("success");
				event2.eventPath = [];
				request.dispatchEvent(event2);
			});
		});
		return request;
	}
	databases() {
		return Promise.resolve(Array.from(this._databases.entries(), ([name, database]) => {
			const activeVersionChangeConnection = database.connections.find((connection) => connection._runningVersionchangeTransaction);
			return {
				name,
				version: activeVersionChangeConnection ? activeVersionChangeConnection._oldVersion : database.version
			};
		}).filter(({ version }) => {
			return version > 0;
		}));
	}
	get [Symbol.toStringTag]() {
		return "IDBFactory";
	}
};
//#endregion
//#region node_modules/fake-indexeddb/build/esm/fakeIndexedDB.js
const fakeIndexedDB = new FDBFactory();
//#endregion
//#region node_modules/fake-indexeddb/auto/index.mjs
var globalVar = typeof window !== "undefined" ? window : typeof WorkerGlobalScope !== "undefined" ? self : typeof global !== "undefined" ? global : Function("return this;")();
const createPropertyDescriptor = (value) => {
	return {
		value,
		enumerable: false,
		configurable: true,
		writable: true
	};
};
Object.defineProperties(globalVar, {
	indexedDB: createPropertyDescriptor(fakeIndexedDB),
	IDBCursor: createPropertyDescriptor(FDBCursor),
	IDBCursorWithValue: createPropertyDescriptor(FDBCursorWithValue),
	IDBDatabase: createPropertyDescriptor(FDBDatabase),
	IDBFactory: createPropertyDescriptor(FDBFactory),
	IDBIndex: createPropertyDescriptor(FDBIndex),
	IDBKeyRange: createPropertyDescriptor(FDBKeyRange),
	IDBObjectStore: createPropertyDescriptor(FDBObjectStore),
	IDBOpenDBRequest: createPropertyDescriptor(FDBOpenDBRequest),
	IDBRecord: createPropertyDescriptor(FDBRecord),
	IDBRequest: createPropertyDescriptor(FDBRequest),
	IDBTransaction: createPropertyDescriptor(FDBTransaction),
	IDBVersionChangeEvent: createPropertyDescriptor(FDBVersionChangeEvent)
});
//#endregion
//#region extensions/matrix/src/matrix/sdk/verification-status.ts
function isMatrixDeviceLocallyVerified(status) {
	return status?.localVerified === true;
}
function isMatrixDeviceOwnerVerified(status) {
	return status?.crossSigningVerified === true;
}
function isMatrixDeviceVerifiedInCurrentClient(status) {
	return status?.isVerified?.() === true || isMatrixDeviceLocallyVerified(status) || isMatrixDeviceOwnerVerified(status);
}
//#endregion
//#region extensions/matrix/src/matrix/sdk/crypto-bootstrap.ts
const CROSS_SIGNING_PUBLICATION_WAIT_MS = 5e3;
var MatrixCryptoBootstrapper = class {
	constructor(deps) {
		this.deps = deps;
		this.verificationHandlerRegistered = false;
	}
	async bootstrap(crypto, options = {}) {
		const strict = options.strict === true;
		const deferSecretStorageBootstrapUntilAfterCrossSigning = options.forceResetCrossSigning === true;
		this.registerVerificationRequestHandler(crypto);
		if (!deferSecretStorageBootstrapUntilAfterCrossSigning) await this.bootstrapSecretStorage(crypto, {
			strict,
			allowSecretStorageRecreateWithoutRecoveryKey: options.allowSecretStorageRecreateWithoutRecoveryKey === true
		});
		let crossSigning = await this.bootstrapCrossSigning(crypto, {
			forceResetCrossSigning: options.forceResetCrossSigning === true,
			allowAutomaticCrossSigningReset: options.allowAutomaticCrossSigningReset !== false,
			allowSecretStorageRecreateWithoutRecoveryKey: options.allowSecretStorageRecreateWithoutRecoveryKey === true,
			strict
		});
		await this.bootstrapSecretStorage(crypto, {
			strict,
			allowSecretStorageRecreateWithoutRecoveryKey: options.allowSecretStorageRecreateWithoutRecoveryKey === true
		});
		if (deferSecretStorageBootstrapUntilAfterCrossSigning) crossSigning = await this.bootstrapCrossSigning(crypto, {
			forceResetCrossSigning: false,
			allowAutomaticCrossSigningReset: false,
			allowSecretStorageRecreateWithoutRecoveryKey: options.allowSecretStorageRecreateWithoutRecoveryKey === true,
			strict
		});
		const ownDeviceVerified = await this.ensureOwnDeviceTrust(crypto, { strict });
		return {
			crossSigningReady: crossSigning.ready,
			crossSigningPublished: crossSigning.published,
			ownDeviceVerified
		};
	}
	createSigningKeysUiAuthCallback(params) {
		return async (makeRequest) => {
			try {
				return await makeRequest(null);
			} catch {
				try {
					return await makeRequest({ type: "m.login.dummy" });
				} catch {
					if (!params.password?.trim()) throw new Error("Matrix cross-signing key upload requires UIA; provide matrix.password for m.login.password fallback");
					return await makeRequest({
						type: "m.login.password",
						identifier: {
							type: "m.id.user",
							user: params.userId
						},
						password: params.password
					});
				}
			}
		};
	}
	async bootstrapCrossSigning(crypto, options) {
		const userId = await this.deps.getUserId();
		const authUploadDeviceSigningKeys = this.createSigningKeysUiAuthCallback({
			userId,
			password: this.deps.getPassword?.()
		});
		const hasPublishedCrossSigningKeys = async () => {
			if (typeof crypto.userHasCrossSigningKeys !== "function") return true;
			try {
				return await crypto.userHasCrossSigningKeys(userId, true);
			} catch {
				return false;
			}
		};
		const refreshPublishedCrossSigningKeys = async () => {
			if (typeof crypto.userHasCrossSigningKeys !== "function") return;
			try {
				await crypto.userHasCrossSigningKeys(userId, true);
			} catch {}
		};
		const isCrossSigningReady = async () => {
			if (typeof crypto.isCrossSigningReady !== "function") return true;
			try {
				return await crypto.isCrossSigningReady();
			} catch {
				return false;
			}
		};
		const finalize = async () => {
			const ready = await isCrossSigningReady();
			const published = ready ? await waitForPublishedCrossSigningKeys() : await hasPublishedCrossSigningKeys();
			if (ready && published) {
				LogService.info("MatrixClientLite", "Cross-signing bootstrap complete");
				return {
					ready,
					published
				};
			}
			const message = "Cross-signing bootstrap finished but server keys are still not published";
			LogService.warn("MatrixClientLite", message);
			if (options.strict) throw new Error(message);
			return {
				ready,
				published
			};
		};
		const waitForPublishedCrossSigningKeys = async () => {
			const startedAt = Date.now();
			do {
				if (await hasPublishedCrossSigningKeys()) return true;
				await setTimeout$1(250);
			} while (Date.now() - startedAt < CROSS_SIGNING_PUBLICATION_WAIT_MS);
			return false;
		};
		if (options.forceResetCrossSigning) {
			const resetCrossSigning = async () => {
				await crypto.bootstrapCrossSigning({
					setupNewCrossSigning: true,
					authUploadDeviceSigningKeys
				});
			};
			try {
				await resetCrossSigning();
				await this.trustFreshOwnIdentity(crypto);
			} catch (err) {
				if (options.allowSecretStorageRecreateWithoutRecoveryKey && isRepairableSecretStorageAccessError(err)) {
					LogService.warn("MatrixClientLite", "Forced cross-signing reset could not unlock secret storage; recreating secret storage and retrying.");
					try {
						await this.deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
							allowSecretStorageRecreateWithoutRecoveryKey: true,
							forceNewSecretStorage: true
						});
						await resetCrossSigning();
						await this.trustFreshOwnIdentity(crypto);
					} catch (repairErr) {
						LogService.warn("MatrixClientLite", "Forced cross-signing reset failed:", repairErr);
						if (options.strict) throw repairErr instanceof Error ? repairErr : new Error(String(repairErr));
						return {
							ready: false,
							published: false
						};
					}
					return await finalize();
				}
				LogService.warn("MatrixClientLite", "Forced cross-signing reset failed:", err);
				if (options.strict) throw err instanceof Error ? err : new Error(String(err));
				return {
					ready: false,
					published: false
				};
			}
			return await finalize();
		}
		try {
			await refreshPublishedCrossSigningKeys();
			await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys });
		} catch (err) {
			if (options.allowSecretStorageRecreateWithoutRecoveryKey && isRepairableSecretStorageAccessError(err)) {
				LogService.warn("MatrixClientLite", "Cross-signing bootstrap could not unlock secret storage; recreating secret storage during explicit bootstrap and retrying.");
				await this.deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
					allowSecretStorageRecreateWithoutRecoveryKey: true,
					forceNewSecretStorage: true
				});
				await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys });
			} else if (!options.allowAutomaticCrossSigningReset) {
				LogService.warn("MatrixClientLite", "Initial cross-signing bootstrap failed and automatic reset is disabled:", err);
				return {
					ready: false,
					published: false
				};
			} else {
				LogService.warn("MatrixClientLite", "Initial cross-signing bootstrap failed, trying reset:", err);
				try {
					await crypto.bootstrapCrossSigning({
						setupNewCrossSigning: true,
						authUploadDeviceSigningKeys
					});
				} catch (resetErr) {
					LogService.warn("MatrixClientLite", "Failed to bootstrap cross-signing:", resetErr);
					if (options.strict) throw resetErr instanceof Error ? resetErr : new Error(String(resetErr));
					return {
						ready: false,
						published: false
					};
				}
			}
		}
		const firstPassReady = await isCrossSigningReady();
		const firstPassPublished = await hasPublishedCrossSigningKeys();
		if (firstPassReady && firstPassPublished) {
			LogService.info("MatrixClientLite", "Cross-signing bootstrap complete");
			return {
				ready: true,
				published: true
			};
		}
		if (!options.allowAutomaticCrossSigningReset) return {
			ready: firstPassReady,
			published: firstPassPublished
		};
		try {
			await crypto.bootstrapCrossSigning({
				setupNewCrossSigning: true,
				authUploadDeviceSigningKeys
			});
			await this.trustFreshOwnIdentity(crypto);
		} catch (err) {
			LogService.warn("MatrixClientLite", "Fallback cross-signing bootstrap failed:", err);
			if (options.strict) throw err instanceof Error ? err : new Error(String(err));
			return {
				ready: false,
				published: false
			};
		}
		return await finalize();
	}
	async trustFreshOwnIdentity(crypto) {
		const ownIdentity = typeof crypto.getOwnIdentity === "function" ? await crypto.getOwnIdentity().catch(() => void 0) : void 0;
		if (!ownIdentity) return;
		try {
			if (typeof ownIdentity.isVerified === "function" && ownIdentity.isVerified()) return;
			await ownIdentity.verify?.();
		} finally {
			ownIdentity.free?.();
		}
	}
	async bootstrapSecretStorage(crypto, options) {
		try {
			await this.deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, { allowSecretStorageRecreateWithoutRecoveryKey: options.allowSecretStorageRecreateWithoutRecoveryKey });
			LogService.info("MatrixClientLite", "Secret storage bootstrap complete");
		} catch (err) {
			LogService.warn("MatrixClientLite", "Failed to bootstrap secret storage:", err);
			if (options.strict) throw err instanceof Error ? err : new Error(String(err));
		}
	}
	registerVerificationRequestHandler(crypto) {
		if (this.verificationHandlerRegistered) return;
		this.verificationHandlerRegistered = true;
		crypto.on(CryptoEvent.VerificationRequestReceived, async (request) => {
			const verificationRequest = request;
			try {
				this.deps.verificationManager.trackVerificationRequest(verificationRequest);
			} catch (err) {
				LogService.warn("MatrixClientLite", `Failed to track verification request from ${verificationRequest.otherUserId}:`, err);
			}
		});
		this.deps.decryptBridge.bindCryptoRetrySignals(crypto);
		LogService.info("MatrixClientLite", "Verification request handler registered");
	}
	async ensureOwnDeviceTrust(crypto, options) {
		const deviceId = this.deps.getDeviceId()?.trim();
		if (!deviceId) return null;
		const userId = await this.deps.getUserId();
		if (isMatrixDeviceOwnerVerified(typeof crypto.getDeviceVerificationStatus === "function" ? await crypto.getDeviceVerificationStatus(userId, deviceId).catch(() => null) : null)) return true;
		if (typeof crypto.setDeviceVerified === "function") await crypto.setDeviceVerified(userId, deviceId, true);
		if (typeof crypto.crossSignDevice === "function") {
			if (typeof crypto.isCrossSigningReady === "function" ? await crypto.isCrossSigningReady() : true) await crypto.crossSignDevice(deviceId);
		}
		const verified = isMatrixDeviceOwnerVerified(typeof crypto.getDeviceVerificationStatus === "function" ? await crypto.getDeviceVerificationStatus(userId, deviceId).catch(() => null) : null);
		if (!verified && options.strict) throw new Error(`Matrix own device ${deviceId} does not have full Matrix identity trust after bootstrap`);
		return verified;
	}
};
//#endregion
//#region extensions/matrix/src/matrix/sdk/crypto-facade.ts
let matrixCryptoNodeRuntimePromise = null;
async function loadMatrixCryptoNodeRuntime() {
	matrixCryptoNodeRuntimePromise ??= import("./crypto-node.runtime.js").catch((error) => {
		matrixCryptoNodeRuntimePromise = null;
		throw error;
	});
	return await matrixCryptoNodeRuntimePromise;
}
async function loadMatrixCryptoNodeBindings() {
	await ensureMatrixCryptoRuntime();
	return (await loadMatrixCryptoNodeRuntime()).loadMatrixCryptoNodeBindings();
}
function trackInProgressToDeviceVerifications(deps) {
	const crypto = deps.client.getCrypto();
	const userId = deps.client.getUserId();
	if (!userId || typeof crypto?.getVerificationRequestsToDeviceInProgress !== "function") return;
	for (const request of crypto.getVerificationRequestsToDeviceInProgress(userId)) deps.verificationManager.trackVerificationRequest(request);
}
function createMatrixCryptoFacade(deps) {
	return {
		prepare: async (_joinedRooms) => {},
		updateSyncData: async (_toDeviceMessages, _otkCounts, _unusedFallbackKeyAlgs, _changedDeviceLists, _leftDeviceLists) => {},
		isRoomEncrypted: async (roomId) => {
			if (deps.client.getRoom(roomId)?.hasEncryptionStateEvent()) return true;
			try {
				const event = await deps.getRoomStateEvent(roomId, "m.room.encryption", "");
				return typeof event.algorithm === "string" && event.algorithm.length > 0;
			} catch {
				return false;
			}
		},
		requestOwnUserVerification: async () => {
			const crypto = deps.client.getCrypto();
			return await deps.verificationManager.requestOwnUserVerification(crypto);
		},
		encryptMedia: async (buffer) => {
			const { Attachment } = await loadMatrixCryptoNodeBindings();
			const encrypted = Attachment.encrypt(new Uint8Array(buffer));
			const mediaInfoJson = encrypted.mediaEncryptionInfo;
			if (!mediaInfoJson) throw new Error("Matrix media encryption failed: missing media encryption info");
			const parsed = JSON.parse(mediaInfoJson);
			return {
				buffer: Buffer.from(encrypted.encryptedData),
				file: {
					key: parsed.key,
					iv: parsed.iv,
					hashes: parsed.hashes,
					v: parsed.v
				}
			};
		},
		decryptMedia: async (file, opts) => {
			const { Attachment, EncryptedAttachment } = await loadMatrixCryptoNodeBindings();
			const encrypted = await deps.downloadContent(file.url, opts);
			const metadata = {
				url: file.url,
				key: file.key,
				iv: file.iv,
				hashes: file.hashes,
				v: file.v
			};
			const attachment = new EncryptedAttachment(new Uint8Array(encrypted), JSON.stringify(metadata));
			const decrypted = Attachment.decrypt(attachment);
			return Buffer.from(decrypted);
		},
		getRecoveryKey: async () => {
			return deps.recoveryKeyStore.getRecoveryKeySummary();
		},
		listVerifications: async () => {
			trackInProgressToDeviceVerifications(deps);
			return deps.verificationManager.listVerifications();
		},
		ensureVerificationDmTracked: async ({ roomId, userId }) => {
			const crypto = deps.client.getCrypto();
			const request = typeof crypto?.findVerificationRequestDMInProgress === "function" ? crypto.findVerificationRequestDMInProgress(roomId, userId) : void 0;
			if (!request) return null;
			return deps.verificationManager.trackVerificationRequest(request);
		},
		requestVerification: async (params) => {
			const crypto = deps.client.getCrypto();
			return await deps.verificationManager.requestVerification(crypto, params);
		},
		acceptVerification: async (id) => {
			trackInProgressToDeviceVerifications(deps);
			return await deps.verificationManager.acceptVerification(id);
		},
		cancelVerification: async (id, params) => {
			trackInProgressToDeviceVerifications(deps);
			return await deps.verificationManager.cancelVerification(id, params);
		},
		startVerification: async (id, method = "sas") => {
			trackInProgressToDeviceVerifications(deps);
			return await deps.verificationManager.startVerification(id, method);
		},
		generateVerificationQr: async (id) => {
			trackInProgressToDeviceVerifications(deps);
			return await deps.verificationManager.generateVerificationQr(id);
		},
		scanVerificationQr: async (id, qrDataBase64) => {
			trackInProgressToDeviceVerifications(deps);
			return await deps.verificationManager.scanVerificationQr(id, qrDataBase64);
		},
		confirmVerificationSas: async (id) => {
			trackInProgressToDeviceVerifications(deps);
			return await deps.verificationManager.confirmVerificationSas(id);
		},
		mismatchVerificationSas: async (id) => {
			trackInProgressToDeviceVerifications(deps);
			return deps.verificationManager.mismatchVerificationSas(id);
		},
		confirmVerificationReciprocateQr: async (id) => {
			trackInProgressToDeviceVerifications(deps);
			return deps.verificationManager.confirmVerificationReciprocateQr(id);
		},
		getVerificationSas: async (id) => {
			trackInProgressToDeviceVerifications(deps);
			return deps.verificationManager.getVerificationSas(id);
		}
	};
}
//#endregion
//#region extensions/matrix/src/matrix/sdk/decrypt-bridge.ts
const MATRIX_DECRYPT_RETRY_BASE_DELAY_MS = 1500;
const MATRIX_DECRYPT_RETRY_MAX_DELAY_MS = 3e4;
const MATRIX_DECRYPT_RETRY_MAX_ATTEMPTS = 8;
function resolveDecryptRetryKey(roomId, eventId) {
	if (!roomId || !eventId) return null;
	return `${roomId}|${eventId}`;
}
function isDecryptionFailure(event) {
	return typeof event.isDecryptionFailure === "function" && event.isDecryptionFailure();
}
function getDecryptionFailureReason(event) {
	const reason = event.decryptionFailureReason;
	return typeof reason === "string" && reason in DecryptionFailureCode ? reason : null;
}
function shouldRetryDecryptionFailure(event) {
	if (!isDecryptionFailure(event)) return false;
	const reason = getDecryptionFailureReason(event);
	if (!reason) return true;
	return reason === DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID || reason === DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX || reason === DecryptionFailureCode.UNKNOWN_ERROR;
}
var MatrixDecryptBridge = class {
	constructor(deps) {
		this.deps = deps;
		this.trackedEncryptedEvents = /* @__PURE__ */ new WeakSet();
		this.decryptedMessageDedupe = /* @__PURE__ */ new Map();
		this.decryptRetries = /* @__PURE__ */ new Map();
		this.failedDecryptionsNotified = /* @__PURE__ */ new Set();
		this.exhaustedDecryptRetries = /* @__PURE__ */ new Set();
		this.activeRetryRuns = 0;
		this.retryIdleResolvers = /* @__PURE__ */ new Set();
		this.cryptoRetrySignalsBound = false;
	}
	shouldEmitUnencryptedMessage(roomId, eventId) {
		if (!eventId) return true;
		const key = `${roomId}|${eventId}`;
		if (this.decryptedMessageDedupe.get(key) === void 0) return true;
		this.decryptedMessageDedupe.delete(key);
		return false;
	}
	attachEncryptedEvent(event, roomId) {
		if (this.trackedEncryptedEvents.has(event)) return;
		this.trackedEncryptedEvents.add(event);
		event.on(MatrixEventEvent.Decrypted, (decryptedEvent, err) => {
			this.handleEncryptedEventDecrypted({
				roomId,
				encryptedEvent: event,
				decryptedEvent,
				err
			});
		});
		if (shouldRetryDecryptionFailure(event)) {
			const eventId = this.deps.toRaw(event).event_id || event.getId() || "";
			this.scheduleDecryptRetry({
				event,
				roomId,
				eventId
			});
		}
	}
	retryPendingNow(reason) {
		const pending = Array.from(this.decryptRetries.entries());
		if (pending.length === 0) return;
		LogService.debug("MatrixClientLite", `Retrying pending decryptions due to ${reason}`);
		for (const [retryKey, state] of pending) {
			if (state.timer) {
				clearTimeout(state.timer);
				state.timer = null;
			}
			if (state.inFlight) continue;
			this.runDecryptRetry(retryKey).catch(noop);
		}
	}
	bindCryptoRetrySignals(crypto) {
		if (!crypto || this.cryptoRetrySignalsBound) return;
		this.cryptoRetrySignalsBound = true;
		const trigger = (reason) => {
			this.retryPendingNow(reason);
		};
		crypto.on(CryptoEvent.KeyBackupDecryptionKeyCached, () => {
			trigger("crypto.keyBackupDecryptionKeyCached");
		});
		crypto.on(CryptoEvent.RehydrationCompleted, () => {
			trigger("dehydration.RehydrationCompleted");
		});
		crypto.on(CryptoEvent.DevicesUpdated, () => {
			trigger("crypto.devicesUpdated");
		});
		crypto.on(CryptoEvent.KeysChanged, () => {
			trigger("crossSigning.keysChanged");
		});
	}
	stop() {
		for (const retryKey of this.decryptRetries.keys()) this.clearDecryptRetry(retryKey);
	}
	async drainPendingDecryptions(reason) {
		for (let attempts = 0; attempts < MATRIX_DECRYPT_RETRY_MAX_ATTEMPTS; attempts += 1) {
			if (this.decryptRetries.size === 0) return;
			this.retryPendingNow(reason);
			await this.waitForActiveRetryRunsToFinish();
			if (!Array.from(this.decryptRetries.values()).some((state) => state.timer || state.inFlight)) return;
		}
	}
	handleEncryptedEventDecrypted(params) {
		const decryptedRoomId = params.decryptedEvent.getRoomId() || params.roomId;
		const decryptedRaw = this.deps.toRaw(params.decryptedEvent);
		const retryEventId = decryptedRaw.event_id || params.encryptedEvent.getId() || "";
		const retryKey = resolveDecryptRetryKey(decryptedRoomId, retryEventId);
		if (params.err) {
			this.emitFailedDecryptionOnce(retryKey, decryptedRoomId, decryptedRaw, params.err);
			if (shouldRetryDecryptionFailure(params.decryptedEvent)) this.scheduleDecryptRetry({
				event: params.encryptedEvent,
				roomId: decryptedRoomId,
				eventId: retryEventId
			});
			else if (retryKey) this.clearDecryptRetry(retryKey);
			return;
		}
		if (isDecryptionFailure(params.decryptedEvent)) {
			this.emitFailedDecryptionOnce(retryKey, decryptedRoomId, decryptedRaw, /* @__PURE__ */ new Error("Matrix event failed to decrypt"));
			if (shouldRetryDecryptionFailure(params.decryptedEvent)) this.scheduleDecryptRetry({
				event: params.encryptedEvent,
				roomId: decryptedRoomId,
				eventId: retryEventId
			});
			else if (retryKey) this.clearDecryptRetry(retryKey);
			return;
		}
		if (retryKey) this.clearDecryptRetry(retryKey);
		this.rememberDecryptedMessage(decryptedRoomId, decryptedRaw.event_id);
		this.deps.emitDecryptedEvent(decryptedRoomId, decryptedRaw);
		this.deps.emitMessage(decryptedRoomId, decryptedRaw);
	}
	emitFailedDecryptionOnce(retryKey, roomId, event, error) {
		if (retryKey) {
			if (this.failedDecryptionsNotified.has(retryKey)) return;
			this.failedDecryptionsNotified.add(retryKey);
		}
		this.deps.emitFailedDecryption(roomId, event, error);
	}
	scheduleDecryptRetry(params) {
		const retryKey = resolveDecryptRetryKey(params.roomId, params.eventId);
		if (!retryKey) return;
		const existing = this.decryptRetries.get(retryKey);
		if (this.exhaustedDecryptRetries.has(retryKey)) return;
		if (existing?.timer || existing?.inFlight) return;
		const attempts = (existing?.attempts ?? 0) + 1;
		if (attempts > MATRIX_DECRYPT_RETRY_MAX_ATTEMPTS) {
			const retry = this.decryptRetries.get(retryKey);
			if (retry?.timer) clearTimeout(retry.timer);
			this.decryptRetries.delete(retryKey);
			this.exhaustedDecryptRetries.add(retryKey);
			LogService.debug("MatrixClientLite", `Giving up decryption retry for ${params.eventId} in ${params.roomId} after ${attempts - 1} attempts`);
			return;
		}
		const delayMs = Math.min(MATRIX_DECRYPT_RETRY_BASE_DELAY_MS * 2 ** (attempts - 1), MATRIX_DECRYPT_RETRY_MAX_DELAY_MS);
		const next = {
			event: params.event,
			roomId: params.roomId,
			eventId: params.eventId,
			attempts,
			inFlight: false,
			timer: null
		};
		next.timer = setTimeout(() => {
			this.runDecryptRetry(retryKey).catch(noop);
		}, delayMs);
		this.decryptRetries.set(retryKey, next);
	}
	async runDecryptRetry(retryKey) {
		const state = this.decryptRetries.get(retryKey);
		if (!state || state.inFlight) return;
		state.inFlight = true;
		state.timer = null;
		this.activeRetryRuns += 1;
		if (!(typeof this.deps.client.decryptEventIfNeeded === "function")) {
			this.clearDecryptRetry(retryKey);
			this.activeRetryRuns = Math.max(0, this.activeRetryRuns - 1);
			this.resolveRetryIdleIfNeeded();
			return;
		}
		try {
			await this.deps.client.decryptEventIfNeeded?.(state.event, { isRetry: true });
		} catch {} finally {
			state.inFlight = false;
			this.activeRetryRuns = Math.max(0, this.activeRetryRuns - 1);
			this.resolveRetryIdleIfNeeded();
		}
		if (this.decryptRetries.get(retryKey) !== state) return;
		if (isDecryptionFailure(state.event)) {
			if (!shouldRetryDecryptionFailure(state.event)) {
				this.clearDecryptRetry(retryKey);
				return;
			}
			this.scheduleDecryptRetry(state);
			return;
		}
		this.clearDecryptRetry(retryKey);
		const raw = this.deps.toRaw(state.event);
		this.rememberDecryptedMessage(state.roomId, raw.event_id);
		this.deps.emitDecryptedEvent(state.roomId, raw);
		this.deps.emitMessage(state.roomId, raw);
	}
	clearDecryptRetry(retryKey) {
		const state = this.decryptRetries.get(retryKey);
		if (state?.timer) clearTimeout(state.timer);
		this.decryptRetries.delete(retryKey);
		this.exhaustedDecryptRetries.delete(retryKey);
		this.failedDecryptionsNotified.delete(retryKey);
	}
	rememberDecryptedMessage(roomId, eventId) {
		if (!eventId) return;
		const now = Date.now();
		this.pruneDecryptedMessageDedupe(now);
		this.decryptedMessageDedupe.set(`${roomId}|${eventId}`, now);
	}
	pruneDecryptedMessageDedupe(now) {
		const ttlMs = 3e4;
		for (const [key, createdAt] of this.decryptedMessageDedupe) if (now - createdAt > ttlMs) this.decryptedMessageDedupe.delete(key);
		const maxEntries = 2048;
		while (this.decryptedMessageDedupe.size > maxEntries) {
			const oldest = this.decryptedMessageDedupe.keys().next().value;
			if (oldest === void 0) break;
			this.decryptedMessageDedupe.delete(oldest);
		}
	}
	async waitForActiveRetryRunsToFinish() {
		if (this.activeRetryRuns === 0) return;
		await new Promise((resolve) => {
			this.retryIdleResolvers.add(resolve);
			if (this.activeRetryRuns === 0) {
				this.retryIdleResolvers.delete(resolve);
				resolve();
			}
		});
	}
	resolveRetryIdleIfNeeded() {
		if (this.activeRetryRuns !== 0) return;
		for (const resolve of this.retryIdleResolvers) resolve();
		this.retryIdleResolvers.clear();
	}
};
//#endregion
//#region extensions/matrix/src/matrix/sdk/idb-persistence.ts
function isValidIdbIndexSnapshot(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return typeof candidate.name === "string" && (typeof candidate.keyPath === "string" || Array.isArray(candidate.keyPath) && candidate.keyPath.every((entry) => typeof entry === "string")) && typeof candidate.multiEntry === "boolean" && typeof candidate.unique === "boolean";
}
function isValidIdbRecordSnapshot(value) {
	if (!value || typeof value !== "object") return false;
	return "key" in value && "value" in value;
}
function isValidIdbStoreSnapshot(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	const validKeyPath = candidate.keyPath === null || typeof candidate.keyPath === "string" || Array.isArray(candidate.keyPath) && candidate.keyPath.every((entry) => typeof entry === "string");
	return typeof candidate.name === "string" && validKeyPath && typeof candidate.autoIncrement === "boolean" && Array.isArray(candidate.indexes) && candidate.indexes.every((entry) => isValidIdbIndexSnapshot(entry)) && Array.isArray(candidate.records) && candidate.records.every((entry) => isValidIdbRecordSnapshot(entry));
}
function isValidIdbDatabaseSnapshot(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return typeof candidate.name === "string" && typeof candidate.version === "number" && Number.isFinite(candidate.version) && candidate.version > 0 && Array.isArray(candidate.stores) && candidate.stores.every((entry) => isValidIdbStoreSnapshot(entry));
}
function parseSnapshotPayload(data) {
	const parsed = JSON.parse(data);
	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	if (!parsed.every((entry) => isValidIdbDatabaseSnapshot(entry))) throw new Error("Malformed IndexedDB snapshot payload");
	return parsed;
}
function idbReq(req) {
	return new Promise((resolve, reject) => {
		req.addEventListener("success", () => resolve(req.result), { once: true });
		req.addEventListener("error", () => reject(req.error), { once: true });
	});
}
async function dumpIndexedDatabases(databasePrefix) {
	const idb = fakeIndexedDB;
	const dbList = await idb.databases();
	const snapshot = [];
	const expectedPrefix = databasePrefix ? `${databasePrefix}::` : null;
	for (const { name, version } of dbList) {
		if (!name || !version) continue;
		if (expectedPrefix && !name.startsWith(expectedPrefix)) continue;
		const db = await new Promise((resolve, reject) => {
			const r = idb.open(name, version);
			r.addEventListener("success", () => resolve(r.result), { once: true });
			r.addEventListener("error", () => reject(r.error), { once: true });
		});
		const stores = [];
		for (const storeName of db.objectStoreNames) {
			const store = db.transaction(storeName, "readonly").objectStore(storeName);
			const storeInfo = {
				name: storeName,
				keyPath: store.keyPath,
				autoIncrement: store.autoIncrement,
				indexes: [],
				records: []
			};
			for (const idxName of store.indexNames) {
				const idx = store.index(idxName);
				storeInfo.indexes.push({
					name: idxName,
					keyPath: idx.keyPath,
					multiEntry: idx.multiEntry,
					unique: idx.unique
				});
			}
			const keys = await idbReq(store.getAllKeys());
			const values = await idbReq(store.getAll());
			storeInfo.records = keys.map((k, i) => ({
				key: k,
				value: values[i]
			}));
			stores.push(storeInfo);
		}
		snapshot.push({
			name,
			version,
			stores
		});
		db.close();
	}
	return snapshot;
}
async function restoreIndexedDatabases(snapshot) {
	const idb = fakeIndexedDB;
	for (const dbSnap of snapshot) await new Promise((resolve, reject) => {
		const r = idb.open(dbSnap.name, dbSnap.version);
		r.addEventListener("upgradeneeded", () => {
			const db = r.result;
			for (const storeSnap of dbSnap.stores) {
				const opts = {};
				if (storeSnap.keyPath !== null) opts.keyPath = storeSnap.keyPath;
				if (storeSnap.autoIncrement) opts.autoIncrement = true;
				const store = db.createObjectStore(storeSnap.name, opts);
				for (const idx of storeSnap.indexes) store.createIndex(idx.name, idx.keyPath, {
					unique: idx.unique,
					multiEntry: idx.multiEntry
				});
			}
		});
		r.addEventListener("success", () => {
			(async () => {
				const db = r.result;
				for (const storeSnap of dbSnap.stores) {
					if (storeSnap.records.length === 0) continue;
					const tx = db.transaction(storeSnap.name, "readwrite");
					const store = tx.objectStore(storeSnap.name);
					for (const rec of storeSnap.records) if (storeSnap.keyPath !== null) store.put(rec.value);
					else store.put(rec.value, rec.key);
					await new Promise((res) => {
						tx.addEventListener("complete", () => res(), { once: true });
					});
				}
				db.close();
				resolve();
			})().catch(reject);
		}, { once: true });
		r.addEventListener("error", () => reject(r.error), { once: true });
	});
}
function resolveDefaultIdbSnapshotPath() {
	const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "/tmp", ".openclaw");
	return path.join(stateDir, "matrix", "crypto-idb-snapshot.json");
}
async function restoreIdbFromDisk(snapshotPath) {
	const candidatePaths = snapshotPath ? [snapshotPath] : [resolveDefaultIdbSnapshotPath()];
	for (const resolvedPath of candidatePaths) {
		if (!fs.existsSync(resolvedPath)) continue;
		try {
			if (await withFileLock(resolvedPath, MATRIX_IDB_SNAPSHOT_LOCK_OPTIONS, async () => {
				const snapshot = parseSnapshotPayload(fs.readFileSync(resolvedPath, "utf8"));
				if (!snapshot) return false;
				await restoreIndexedDatabases(snapshot);
				LogService.info("IdbPersistence", `Restored ${snapshot.length} IndexedDB database(s) from ${resolvedPath}`);
				return true;
			})) return true;
		} catch (err) {
			LogService.warn("IdbPersistence", `Failed to restore IndexedDB snapshot from ${resolvedPath}:`, err);
			continue;
		}
	}
	return false;
}
async function persistIdbToDisk(params) {
	const snapshotPath = params?.snapshotPath ?? resolveDefaultIdbSnapshotPath();
	try {
		fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
		const persistedCount = await withFileLock(snapshotPath, MATRIX_IDB_SNAPSHOT_LOCK_OPTIONS, async () => {
			const snapshot = await dumpIndexedDatabases(params?.databasePrefix);
			if (snapshot.length === 0) return 0;
			fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
			fs.chmodSync(snapshotPath, 384);
			return snapshot.length;
		});
		if (persistedCount === 0) return;
		LogService.debug("IdbPersistence", `Persisted ${persistedCount} IndexedDB database(s) to ${snapshotPath}`);
	} catch (err) {
		LogService.warn("IdbPersistence", "Failed to persist IndexedDB snapshot:", err);
	}
}
//#endregion
//#region extensions/matrix/src/matrix/sdk/verification-manager.ts
const MATRIX_VERIFICATION_PHASES = new Set([
	-1,
	VerificationPhase.Unsent,
	VerificationPhase.Requested,
	VerificationPhase.Ready,
	VerificationPhase.Started,
	VerificationPhase.Cancelled,
	VerificationPhase.Done
]);
function isMatrixVerificationPhase(value) {
	return typeof value === "number" && MATRIX_VERIFICATION_PHASES.has(value);
}
const MAX_TRACKED_VERIFICATION_SESSIONS = 256;
const TERMINAL_SESSION_RETENTION_MS = 1440 * 60 * 1e3;
const SAS_AUTO_CONFIRM_DELAY_MS = 3e4;
var MatrixVerificationManager = class {
	constructor(opts = {}) {
		this.opts = opts;
		this.verificationSessions = /* @__PURE__ */ new Map();
		this.verificationSessionCounter = 0;
		this.trackedVerificationRequests = /* @__PURE__ */ new WeakSet();
		this.trackedVerificationVerifiers = /* @__PURE__ */ new WeakSet();
		this.summaryListeners = /* @__PURE__ */ new Set();
	}
	readRequestValue(_request, reader, fallback) {
		try {
			return reader();
		} catch {
			return fallback;
		}
	}
	readVerificationPhase(request, fallback) {
		const phase = this.readRequestValue(request, () => request.phase, fallback);
		return isMatrixVerificationPhase(phase) ? phase : fallback;
	}
	readVerificationRequestIdentity(request) {
		return {
			transactionId: this.readRequestValue(request, () => request.transactionId?.trim() ?? "", ""),
			roomId: this.readRequestValue(request, () => request.roomId ?? "", ""),
			otherUserId: this.readRequestValue(request, () => request.otherUserId, ""),
			otherDeviceId: this.readRequestValue(request, () => request.otherDeviceId ?? "", ""),
			isSelfVerification: this.readRequestValue(request, () => request.isSelfVerification, false),
			initiatedByMe: this.readRequestValue(request, () => request.initiatedByMe, false)
		};
	}
	isSameLogicalVerificationRequest(left, right) {
		const leftIdentity = this.readVerificationRequestIdentity(left);
		const rightIdentity = this.readVerificationRequestIdentity(right);
		return leftIdentity.transactionId !== "" && leftIdentity.transactionId === rightIdentity.transactionId && leftIdentity.roomId === rightIdentity.roomId && leftIdentity.otherUserId === rightIdentity.otherUserId && this.isSameOptionalIdentityValue(leftIdentity.otherDeviceId, rightIdentity.otherDeviceId) && leftIdentity.isSelfVerification === rightIdentity.isSelfVerification && leftIdentity.initiatedByMe === rightIdentity.initiatedByMe;
	}
	isSameOptionalIdentityValue(left, right) {
		return left === "" || right === "" || left === right;
	}
	pruneVerificationSessions(nowMs) {
		for (const [id, session] of this.verificationSessions) {
			const phase = this.readVerificationPhase(session.request, -1);
			if ((phase === VerificationPhase.Done || phase === VerificationPhase.Cancelled) && nowMs - session.updatedAtMs > TERMINAL_SESSION_RETENTION_MS) this.verificationSessions.delete(id);
		}
		if (this.verificationSessions.size <= MAX_TRACKED_VERIFICATION_SESSIONS) return;
		const sortedByAge = Array.from(this.verificationSessions.entries()).toSorted((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
		const overflow = this.verificationSessions.size - MAX_TRACKED_VERIFICATION_SESSIONS;
		for (let i = 0; i < overflow; i += 1) {
			const entry = sortedByAge[i];
			if (entry) this.verificationSessions.delete(entry[0]);
		}
	}
	getVerificationPhaseName(phase) {
		switch (phase) {
			case VerificationPhase.Unsent: return "unsent";
			case VerificationPhase.Requested: return "requested";
			case VerificationPhase.Ready: return "ready";
			case VerificationPhase.Started: return "started";
			case VerificationPhase.Cancelled: return "cancelled";
			case VerificationPhase.Done: return "done";
			default: return `unknown(${phase})`;
		}
	}
	emitVerificationSummary(session) {
		const summary = this.buildVerificationSummary(session);
		for (const listener of this.summaryListeners) listener(summary);
	}
	touchVerificationSession(session) {
		session.updatedAtMs = Date.now();
		this.emitVerificationSummary(session);
	}
	clearSasAutoConfirmTimer(session) {
		if (!session.sasAutoConfirmTimer) return;
		clearTimeout(session.sasAutoConfirmTimer);
		session.sasAutoConfirmTimer = void 0;
	}
	buildVerificationSummary(session) {
		const request = session.request;
		const phase = this.readVerificationPhase(request, VerificationPhase.Requested);
		const accepting = this.readRequestValue(request, () => request.accepting, false);
		const declining = this.readRequestValue(request, () => request.declining, false);
		const pending = this.readRequestValue(request, () => request.pending, false);
		const methodsRaw = this.readRequestValue(request, () => request.methods, []);
		const methods = Array.isArray(methodsRaw) ? methodsRaw.filter((entry) => typeof entry === "string") : [];
		const sasCallbacks = session.sasCallbacks ?? session.activeVerifier?.getShowSasCallbacks();
		if (sasCallbacks) session.sasCallbacks = sasCallbacks;
		const canAccept = phase < VerificationPhase.Ready && !accepting && !declining;
		return {
			id: session.id,
			transactionId: this.readRequestValue(request, () => request.transactionId, void 0),
			roomId: this.readRequestValue(request, () => request.roomId, void 0),
			otherUserId: this.readRequestValue(request, () => request.otherUserId, "unknown"),
			otherDeviceId: this.readRequestValue(request, () => request.otherDeviceId, void 0),
			isSelfVerification: this.readRequestValue(request, () => request.isSelfVerification, false),
			initiatedByMe: this.readRequestValue(request, () => request.initiatedByMe, false),
			phase,
			phaseName: this.getVerificationPhaseName(phase),
			pending,
			methods,
			chosenMethod: this.readRequestValue(request, () => request.chosenMethod ?? null, null),
			canAccept,
			hasSas: Boolean(sasCallbacks),
			sas: sasCallbacks ? {
				decimal: sasCallbacks.sas.decimal,
				emoji: sasCallbacks.sas.emoji
			} : void 0,
			hasReciprocateQr: Boolean(session.reciprocateQrCallbacks),
			completed: phase === VerificationPhase.Done,
			error: session.error,
			createdAt: new Date(session.createdAtMs).toISOString(),
			updatedAt: new Date(session.updatedAtMs).toISOString()
		};
	}
	findVerificationSession(id) {
		const direct = this.verificationSessions.get(id);
		if (direct) return direct;
		const transactionMatches = Array.from(this.verificationSessions.values()).filter((session) => {
			return this.readRequestValue(session.request, () => session.request.transactionId?.trim(), "") === id;
		});
		if (transactionMatches.length === 1) return transactionMatches[0];
		if (transactionMatches.length > 1) throw new Error(`Matrix verification request id is ambiguous for transaction ${id}; use the verification id instead`);
		throw new Error(`Matrix verification request not found: ${id}`);
	}
	ensureVerificationRequestTracked(session) {
		const requestObj = session.request;
		if (this.trackedVerificationRequests.has(requestObj)) return;
		this.trackedVerificationRequests.add(requestObj);
		session.request.on(VerificationRequestEvent.Change, () => {
			this.touchVerificationSession(session);
			this.maybeAutoAcceptInboundRequest(session);
			const verifier = this.readRequestValue(session.request, () => session.request.verifier, null);
			if (verifier) this.attachVerifierToVerificationSession(session, verifier);
			this.maybeAutoStartInboundSas(session);
		});
	}
	maybeAutoAcceptInboundRequest(session) {
		if (session.acceptRequested) return;
		const request = session.request;
		const isSelfVerification = this.readRequestValue(request, () => request.isSelfVerification, false);
		const initiatedByMe = this.readRequestValue(request, () => request.initiatedByMe, false);
		const phase = this.readVerificationPhase(request, VerificationPhase.Requested);
		const accepting = this.readRequestValue(request, () => request.accepting, false);
		const declining = this.readRequestValue(request, () => request.declining, false);
		if (isSelfVerification || initiatedByMe) return;
		if (phase !== VerificationPhase.Requested || accepting || declining) return;
		session.acceptRequested = true;
		request.accept().then(() => {
			this.touchVerificationSession(session);
		}).catch((err) => {
			session.acceptRequested = false;
			session.error = formatMatrixErrorMessage(err);
			this.touchVerificationSession(session);
		});
	}
	maybeAutoStartInboundSas(session) {
		if (session.activeVerifier || session.verifyStarted || session.startRequested) return;
		if (this.readRequestValue(session.request, () => session.request.initiatedByMe, true)) return;
		if (!this.readRequestValue(session.request, () => session.request.isSelfVerification, false)) return;
		const phase = this.readVerificationPhase(session.request, VerificationPhase.Requested);
		if (phase < VerificationPhase.Ready || phase >= VerificationPhase.Cancelled) return;
		const methodsRaw = this.readRequestValue(session.request, () => session.request.methods, []);
		const methods = Array.isArray(methodsRaw) ? methodsRaw.filter((entry) => typeof entry === "string") : [];
		const chosenMethod = this.readRequestValue(session.request, () => session.request.chosenMethod, null);
		if (!(methods.includes(VerificationMethod.Sas) || chosenMethod === VerificationMethod.Sas)) return;
		session.startRequested = true;
		session.request.startVerification(VerificationMethod.Sas).then((verifier) => {
			this.attachVerifierToVerificationSession(session, verifier);
			this.touchVerificationSession(session);
		}).catch(() => {
			session.startRequested = false;
		});
	}
	attachVerifierToVerificationSession(session, verifier) {
		session.activeVerifier = verifier;
		this.touchVerificationSession(session);
		const maybeSas = verifier.getShowSasCallbacks();
		if (maybeSas) {
			session.sasCallbacks = maybeSas;
			this.maybeAutoConfirmSas(session);
		}
		const maybeReciprocateQr = verifier.getReciprocateQrCodeCallbacks();
		if (maybeReciprocateQr) session.reciprocateQrCallbacks = maybeReciprocateQr;
		const verifierObj = verifier;
		if (this.trackedVerificationVerifiers.has(verifierObj)) {
			this.ensureVerificationStarted(session);
			return;
		}
		this.trackedVerificationVerifiers.add(verifierObj);
		verifier.on(VerifierEvent.ShowSas, (sas) => {
			session.sasCallbacks = sas;
			this.touchVerificationSession(session);
			this.maybeAutoConfirmSas(session);
		});
		verifier.on(VerifierEvent.ShowReciprocateQr, (qr) => {
			session.reciprocateQrCallbacks = qr;
			this.touchVerificationSession(session);
		});
		verifier.on(VerifierEvent.Cancel, (err) => {
			this.clearSasAutoConfirmTimer(session);
			session.error = formatMatrixErrorMessage(err);
			this.touchVerificationSession(session);
		});
		this.ensureVerificationStarted(session);
	}
	maybeAutoConfirmSas(session) {
		if (session.sasAutoConfirmStarted || session.sasAutoConfirmTimer) return;
		if (this.readRequestValue(session.request, () => session.request.initiatedByMe, true)) return;
		const callbacks = session.sasCallbacks ?? session.activeVerifier?.getShowSasCallbacks();
		if (!callbacks) return;
		session.sasCallbacks = callbacks;
		session.sasAutoConfirmTimer = setTimeout(() => {
			session.sasAutoConfirmTimer = void 0;
			if (this.readVerificationPhase(session.request, VerificationPhase.Requested) >= VerificationPhase.Cancelled) return;
			session.sasAutoConfirmStarted = true;
			this.confirmSasForSession(session, callbacks, { trustOwnDevice: true }).then(() => {
				this.touchVerificationSession(session);
			}).catch((err) => {
				session.error = formatMatrixErrorMessage(err);
				this.touchVerificationSession(session);
			});
		}, SAS_AUTO_CONFIRM_DELAY_MS);
	}
	async confirmSasForSession(session, callbacks, opts = { trustOwnDevice: true }) {
		await callbacks.confirm();
		if (opts.trustOwnDevice) await this.trustOwnDeviceAfterConfirmedSas(session);
	}
	ensureVerificationStarted(session) {
		if (!session.activeVerifier || session.verifyStarted) return;
		session.verifyStarted = true;
		session.verifyPromise = session.activeVerifier.verify().then(() => {
			this.touchVerificationSession(session);
		}).catch((err) => {
			session.error = formatMatrixErrorMessage(err);
			this.touchVerificationSession(session);
		});
	}
	async trustOwnDeviceAfterConfirmedSas(session) {
		if (!this.readRequestValue(session.request, () => session.request.isSelfVerification, false)) return;
		const deviceId = this.readRequestValue(session.request, () => session.request.otherDeviceId?.trim(), "");
		if (!deviceId || !this.opts.trustOwnDeviceAfterSas) return;
		await this.opts.trustOwnDeviceAfterSas(deviceId);
	}
	onSummaryChanged(listener) {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}
	trackVerificationRequest(request) {
		this.pruneVerificationSessions(Date.now());
		const requestObj = request;
		for (const existing of this.verificationSessions.values()) if (existing.request === requestObj) {
			this.touchVerificationSession(existing);
			return this.buildVerificationSummary(existing);
		}
		if (this.readVerificationRequestIdentity(request).transactionId) {
			for (const existing of this.verificationSessions.values()) if (this.isSameLogicalVerificationRequest(existing.request, request)) {
				existing.request = request;
				this.ensureVerificationRequestTracked(existing);
				const verifier = this.readRequestValue(request, () => request.verifier, null);
				if (verifier) this.attachVerifierToVerificationSession(existing, verifier);
				this.touchVerificationSession(existing);
				return this.buildVerificationSummary(existing);
			}
		}
		const now = Date.now();
		const session = {
			id: `verification-${++this.verificationSessionCounter}`,
			request,
			createdAtMs: now,
			updatedAtMs: now,
			verifyStarted: false,
			startRequested: false,
			acceptRequested: false,
			sasAutoConfirmStarted: false
		};
		this.verificationSessions.set(session.id, session);
		this.ensureVerificationRequestTracked(session);
		this.maybeAutoAcceptInboundRequest(session);
		const verifier = this.readRequestValue(request, () => request.verifier, null);
		if (verifier) this.attachVerifierToVerificationSession(session, verifier);
		this.maybeAutoStartInboundSas(session);
		this.emitVerificationSummary(session);
		return this.buildVerificationSummary(session);
	}
	async requestOwnUserVerification(crypto) {
		if (!crypto) return null;
		const request = await crypto.requestOwnUserVerification();
		if (!request) return null;
		return this.trackVerificationRequest(request);
	}
	listVerifications() {
		this.pruneVerificationSessions(Date.now());
		return Array.from(this.verificationSessions.values()).map((session) => this.buildVerificationSummary(session)).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	async requestVerification(crypto, params) {
		if (!crypto) throw new Error("Matrix crypto is not available");
		let request = null;
		if (params.ownUser) request = await crypto.requestOwnUserVerification();
		else if (params.userId && params.deviceId && crypto.requestDeviceVerification) request = await crypto.requestDeviceVerification(params.userId, params.deviceId);
		else if (params.userId && params.roomId && crypto.requestVerificationDM) request = await crypto.requestVerificationDM(params.userId, params.roomId);
		else throw new Error("Matrix verification request requires one of: ownUser, userId+deviceId, or userId+roomId");
		if (!request) throw new Error("Matrix verification request could not be created");
		return this.trackVerificationRequest(request);
	}
	async acceptVerification(id) {
		const session = this.findVerificationSession(id);
		await session.request.accept();
		this.touchVerificationSession(session);
		return this.buildVerificationSummary(session);
	}
	async cancelVerification(id, params) {
		const session = this.findVerificationSession(id);
		await session.request.cancel(params);
		this.touchVerificationSession(session);
		return this.buildVerificationSummary(session);
	}
	async startVerification(id, method = "sas") {
		const session = this.findVerificationSession(id);
		if (method !== "sas") throw new Error("Matrix startVerification currently supports only SAS directly");
		const verifier = await session.request.startVerification(VerificationMethod.Sas);
		this.attachVerifierToVerificationSession(session, verifier);
		this.ensureVerificationStarted(session);
		return this.buildVerificationSummary(session);
	}
	async generateVerificationQr(id) {
		const qr = await this.findVerificationSession(id).request.generateQRCode();
		if (!qr) throw new Error("Matrix verification QR data is not available yet");
		return { qrDataBase64: Buffer.from(qr).toString("base64") };
	}
	async scanVerificationQr(id, qrDataBase64) {
		const session = this.findVerificationSession(id);
		const trimmed = qrDataBase64.trim();
		if (!trimmed) throw new Error("Matrix verification QR payload is required");
		const qrBytes = Buffer.from(trimmed, "base64");
		if (qrBytes.length === 0) throw new Error("Matrix verification QR payload is invalid base64");
		const verifier = await session.request.scanQRCode(new Uint8ClampedArray(qrBytes));
		this.attachVerifierToVerificationSession(session, verifier);
		this.ensureVerificationStarted(session);
		return this.buildVerificationSummary(session);
	}
	async confirmVerificationSas(id) {
		const session = this.findVerificationSession(id);
		const callbacks = session.sasCallbacks ?? session.activeVerifier?.getShowSasCallbacks();
		if (!callbacks) throw new Error("Matrix SAS confirmation is not available for this verification request");
		this.clearSasAutoConfirmTimer(session);
		session.sasCallbacks = callbacks;
		session.sasAutoConfirmStarted = true;
		await this.confirmSasForSession(session, callbacks);
		if (session.verifyPromise) await session.verifyPromise;
		this.touchVerificationSession(session);
		return this.buildVerificationSummary(session);
	}
	mismatchVerificationSas(id) {
		const session = this.findVerificationSession(id);
		const callbacks = session.sasCallbacks ?? session.activeVerifier?.getShowSasCallbacks();
		if (!callbacks) throw new Error("Matrix SAS mismatch is not available for this verification request");
		this.clearSasAutoConfirmTimer(session);
		session.sasCallbacks = callbacks;
		callbacks.mismatch();
		this.touchVerificationSession(session);
		return this.buildVerificationSummary(session);
	}
	confirmVerificationReciprocateQr(id) {
		const session = this.findVerificationSession(id);
		const callbacks = session.reciprocateQrCallbacks ?? session.activeVerifier?.getReciprocateQrCodeCallbacks();
		if (!callbacks) throw new Error("Matrix reciprocate-QR confirmation is not available for this verification request");
		session.reciprocateQrCallbacks = callbacks;
		callbacks.confirm();
		this.touchVerificationSession(session);
		return this.buildVerificationSummary(session);
	}
	getVerificationSas(id) {
		const session = this.findVerificationSession(id);
		const callbacks = session.sasCallbacks ?? session.activeVerifier?.getShowSasCallbacks();
		if (!callbacks) throw new Error("Matrix SAS data is not available for this verification request");
		session.sasCallbacks = callbacks;
		return {
			decimal: callbacks.sas.decimal,
			emoji: callbacks.sas.emoji
		};
	}
};
//#endregion
export { MatrixCryptoBootstrapper, MatrixDecryptBridge, MatrixVerificationManager, createMatrixCryptoFacade, isMatrixDeviceOwnerVerified, isMatrixDeviceVerifiedInCurrentClient, persistIdbToDisk, restoreIdbFromDisk };
