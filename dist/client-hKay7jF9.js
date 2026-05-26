import { n as __esmMin, r as __exportAll, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { ReadStream, fstatSync, lstatSync } from "node:fs";
import { join, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash, createHmac, getRandomValues } from "node:crypto";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";
//#region node_modules/@smithy/core/dist-es/submodules/client/middleware-stack/MiddlewareStack.js
var getAllAliases, getMiddlewareNameWithAliases, constructStack, stepWeights, priorityWeights;
var init_MiddlewareStack = __esmMin((() => {
	getAllAliases = (name, aliases) => {
		const _aliases = [];
		if (name) _aliases.push(name);
		if (aliases) for (const alias of aliases) _aliases.push(alias);
		return _aliases;
	};
	getMiddlewareNameWithAliases = (name, aliases) => {
		return `${name || "anonymous"}${aliases && aliases.length > 0 ? ` (a.k.a. ${aliases.join(",")})` : ""}`;
	};
	constructStack = () => {
		let absoluteEntries = [];
		let relativeEntries = [];
		let identifyOnResolve = false;
		const entriesNameSet = /* @__PURE__ */ new Set();
		const sort = (entries) => entries.sort((a, b) => stepWeights[b.step] - stepWeights[a.step] || priorityWeights[b.priority || "normal"] - priorityWeights[a.priority || "normal"]);
		const removeByName = (toRemove) => {
			let isRemoved = false;
			const filterCb = (entry) => {
				const aliases = getAllAliases(entry.name, entry.aliases);
				if (aliases.includes(toRemove)) {
					isRemoved = true;
					for (const alias of aliases) entriesNameSet.delete(alias);
					return false;
				}
				return true;
			};
			absoluteEntries = absoluteEntries.filter(filterCb);
			relativeEntries = relativeEntries.filter(filterCb);
			return isRemoved;
		};
		const removeByReference = (toRemove) => {
			let isRemoved = false;
			const filterCb = (entry) => {
				if (entry.middleware === toRemove) {
					isRemoved = true;
					for (const alias of getAllAliases(entry.name, entry.aliases)) entriesNameSet.delete(alias);
					return false;
				}
				return true;
			};
			absoluteEntries = absoluteEntries.filter(filterCb);
			relativeEntries = relativeEntries.filter(filterCb);
			return isRemoved;
		};
		const cloneTo = (toStack) => {
			absoluteEntries.forEach((entry) => {
				toStack.add(entry.middleware, { ...entry });
			});
			relativeEntries.forEach((entry) => {
				toStack.addRelativeTo(entry.middleware, { ...entry });
			});
			toStack.identifyOnResolve?.(stack.identifyOnResolve());
			return toStack;
		};
		const expandRelativeMiddlewareList = (from) => {
			const expandedMiddlewareList = [];
			from.before.forEach((entry) => {
				if (entry.before.length === 0 && entry.after.length === 0) expandedMiddlewareList.push(entry);
				else expandedMiddlewareList.push(...expandRelativeMiddlewareList(entry));
			});
			expandedMiddlewareList.push(from);
			from.after.reverse().forEach((entry) => {
				if (entry.before.length === 0 && entry.after.length === 0) expandedMiddlewareList.push(entry);
				else expandedMiddlewareList.push(...expandRelativeMiddlewareList(entry));
			});
			return expandedMiddlewareList;
		};
		const getMiddlewareList = (debug = false) => {
			const normalizedAbsoluteEntries = [];
			const normalizedRelativeEntries = [];
			const normalizedEntriesNameMap = {};
			absoluteEntries.forEach((entry) => {
				const normalizedEntry = {
					...entry,
					before: [],
					after: []
				};
				for (const alias of getAllAliases(normalizedEntry.name, normalizedEntry.aliases)) normalizedEntriesNameMap[alias] = normalizedEntry;
				normalizedAbsoluteEntries.push(normalizedEntry);
			});
			relativeEntries.forEach((entry) => {
				const normalizedEntry = {
					...entry,
					before: [],
					after: []
				};
				for (const alias of getAllAliases(normalizedEntry.name, normalizedEntry.aliases)) normalizedEntriesNameMap[alias] = normalizedEntry;
				normalizedRelativeEntries.push(normalizedEntry);
			});
			normalizedRelativeEntries.forEach((entry) => {
				if (entry.toMiddleware) {
					const toMiddleware = normalizedEntriesNameMap[entry.toMiddleware];
					if (toMiddleware === void 0) {
						if (debug) return;
						throw new Error(`${entry.toMiddleware} is not found when adding ${getMiddlewareNameWithAliases(entry.name, entry.aliases)} middleware ${entry.relation} ${entry.toMiddleware}`);
					}
					if (entry.relation === "after") toMiddleware.after.push(entry);
					if (entry.relation === "before") toMiddleware.before.push(entry);
				}
			});
			return sort(normalizedAbsoluteEntries).map(expandRelativeMiddlewareList).reduce((wholeList, expandedMiddlewareList) => {
				wholeList.push(...expandedMiddlewareList);
				return wholeList;
			}, []);
		};
		const stack = {
			add: (middleware, options = {}) => {
				const { name, override, aliases: _aliases } = options;
				const entry = {
					step: "initialize",
					priority: "normal",
					middleware,
					...options
				};
				const aliases = getAllAliases(name, _aliases);
				if (aliases.length > 0) {
					if (aliases.some((alias) => entriesNameSet.has(alias))) {
						if (!override) throw new Error(`Duplicate middleware name '${getMiddlewareNameWithAliases(name, _aliases)}'`);
						for (const alias of aliases) {
							const toOverrideIndex = absoluteEntries.findIndex((entry) => entry.name === alias || entry.aliases?.some((a) => a === alias));
							if (toOverrideIndex === -1) continue;
							const toOverride = absoluteEntries[toOverrideIndex];
							if (toOverride.step !== entry.step || entry.priority !== toOverride.priority) throw new Error(`"${getMiddlewareNameWithAliases(toOverride.name, toOverride.aliases)}" middleware with ${toOverride.priority} priority in ${toOverride.step} step cannot be overridden by "${getMiddlewareNameWithAliases(name, _aliases)}" middleware with ${entry.priority} priority in ${entry.step} step.`);
							absoluteEntries.splice(toOverrideIndex, 1);
						}
					}
					for (const alias of aliases) entriesNameSet.add(alias);
				}
				absoluteEntries.push(entry);
			},
			addRelativeTo: (middleware, options) => {
				const { name, override, aliases: _aliases } = options;
				const entry = {
					middleware,
					...options
				};
				const aliases = getAllAliases(name, _aliases);
				if (aliases.length > 0) {
					if (aliases.some((alias) => entriesNameSet.has(alias))) {
						if (!override) throw new Error(`Duplicate middleware name '${getMiddlewareNameWithAliases(name, _aliases)}'`);
						for (const alias of aliases) {
							const toOverrideIndex = relativeEntries.findIndex((entry) => entry.name === alias || entry.aliases?.some((a) => a === alias));
							if (toOverrideIndex === -1) continue;
							const toOverride = relativeEntries[toOverrideIndex];
							if (toOverride.toMiddleware !== entry.toMiddleware || toOverride.relation !== entry.relation) throw new Error(`"${getMiddlewareNameWithAliases(toOverride.name, toOverride.aliases)}" middleware ${toOverride.relation} "${toOverride.toMiddleware}" middleware cannot be overridden by "${getMiddlewareNameWithAliases(name, _aliases)}" middleware ${entry.relation} "${entry.toMiddleware}" middleware.`);
							relativeEntries.splice(toOverrideIndex, 1);
						}
					}
					for (const alias of aliases) entriesNameSet.add(alias);
				}
				relativeEntries.push(entry);
			},
			clone: () => cloneTo(constructStack()),
			use: (plugin) => {
				plugin.applyToStack(stack);
			},
			remove: (toRemove) => {
				if (typeof toRemove === "string") return removeByName(toRemove);
				else return removeByReference(toRemove);
			},
			removeByTag: (toRemove) => {
				let isRemoved = false;
				const filterCb = (entry) => {
					const { tags, name, aliases: _aliases } = entry;
					if (tags && tags.includes(toRemove)) {
						const aliases = getAllAliases(name, _aliases);
						for (const alias of aliases) entriesNameSet.delete(alias);
						isRemoved = true;
						return false;
					}
					return true;
				};
				absoluteEntries = absoluteEntries.filter(filterCb);
				relativeEntries = relativeEntries.filter(filterCb);
				return isRemoved;
			},
			concat: (from) => {
				const cloned = cloneTo(constructStack());
				cloned.use(from);
				cloned.identifyOnResolve(identifyOnResolve || cloned.identifyOnResolve() || (from.identifyOnResolve?.() ?? false));
				return cloned;
			},
			applyToStack: cloneTo,
			identify: () => {
				return getMiddlewareList(true).map((mw) => {
					const step = mw.step ?? mw.relation + " " + mw.toMiddleware;
					return getMiddlewareNameWithAliases(mw.name, mw.aliases) + " - " + step;
				});
			},
			identifyOnResolve(toggle) {
				if (typeof toggle === "boolean") identifyOnResolve = toggle;
				return identifyOnResolve;
			},
			resolve: (handler, context) => {
				for (const middleware of getMiddlewareList().map((entry) => entry.middleware).reverse()) handler = middleware(handler, context);
				if (identifyOnResolve) console.log(stack.identify());
				return handler;
			}
		};
		return stack;
	};
	stepWeights = {
		initialize: 5,
		serialize: 4,
		build: 3,
		finalizeRequest: 2,
		deserialize: 1
	};
	priorityWeights = {
		high: 3,
		normal: 2,
		low: 1
	};
}));
//#endregion
//#region node_modules/@smithy/types/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	exports.HttpAuthLocation = void 0;
	(function(HttpAuthLocation) {
		HttpAuthLocation["HEADER"] = "header";
		HttpAuthLocation["QUERY"] = "query";
	})(exports.HttpAuthLocation || (exports.HttpAuthLocation = {}));
	exports.HttpApiKeyAuthLocation = void 0;
	(function(HttpApiKeyAuthLocation) {
		HttpApiKeyAuthLocation["HEADER"] = "header";
		HttpApiKeyAuthLocation["QUERY"] = "query";
	})(exports.HttpApiKeyAuthLocation || (exports.HttpApiKeyAuthLocation = {}));
	exports.EndpointURLScheme = void 0;
	(function(EndpointURLScheme) {
		EndpointURLScheme["HTTP"] = "http";
		EndpointURLScheme["HTTPS"] = "https";
	})(exports.EndpointURLScheme || (exports.EndpointURLScheme = {}));
	exports.AlgorithmId = void 0;
	(function(AlgorithmId) {
		AlgorithmId["MD5"] = "md5";
		AlgorithmId["CRC32"] = "crc32";
		AlgorithmId["CRC32C"] = "crc32c";
		AlgorithmId["SHA1"] = "sha1";
		AlgorithmId["SHA256"] = "sha256";
	})(exports.AlgorithmId || (exports.AlgorithmId = {}));
	const getChecksumConfiguration = (runtimeConfig) => {
		const checksumAlgorithms = [];
		if (runtimeConfig.sha256 !== void 0) checksumAlgorithms.push({
			algorithmId: () => exports.AlgorithmId.SHA256,
			checksumConstructor: () => runtimeConfig.sha256
		});
		if (runtimeConfig.md5 != void 0) checksumAlgorithms.push({
			algorithmId: () => exports.AlgorithmId.MD5,
			checksumConstructor: () => runtimeConfig.md5
		});
		return {
			addChecksumAlgorithm(algo) {
				checksumAlgorithms.push(algo);
			},
			checksumAlgorithms() {
				return checksumAlgorithms;
			}
		};
	};
	const resolveChecksumRuntimeConfig = (clientConfig) => {
		const runtimeConfig = {};
		clientConfig.checksumAlgorithms().forEach((checksumAlgorithm) => {
			runtimeConfig[checksumAlgorithm.algorithmId()] = checksumAlgorithm.checksumConstructor();
		});
		return runtimeConfig;
	};
	const getDefaultClientConfiguration = (runtimeConfig) => {
		return getChecksumConfiguration(runtimeConfig);
	};
	const resolveDefaultRuntimeConfig = (config) => {
		return resolveChecksumRuntimeConfig(config);
	};
	exports.FieldPosition = void 0;
	(function(FieldPosition) {
		FieldPosition[FieldPosition["HEADER"] = 0] = "HEADER";
		FieldPosition[FieldPosition["TRAILER"] = 1] = "TRAILER";
	})(exports.FieldPosition || (exports.FieldPosition = {}));
	const SMITHY_CONTEXT_KEY = "__smithy_context";
	exports.IniSectionType = void 0;
	(function(IniSectionType) {
		IniSectionType["PROFILE"] = "profile";
		IniSectionType["SSO_SESSION"] = "sso-session";
		IniSectionType["SERVICES"] = "services";
	})(exports.IniSectionType || (exports.IniSectionType = {}));
	exports.RequestHandlerProtocol = void 0;
	(function(RequestHandlerProtocol) {
		RequestHandlerProtocol["HTTP_0_9"] = "http/0.9";
		RequestHandlerProtocol["HTTP_1_0"] = "http/1.0";
		RequestHandlerProtocol["TDS_8_0"] = "tds/8.0";
	})(exports.RequestHandlerProtocol || (exports.RequestHandlerProtocol = {}));
	exports.SMITHY_CONTEXT_KEY = SMITHY_CONTEXT_KEY;
	exports.getDefaultClientConfiguration = getDefaultClientConfiguration;
	exports.resolveDefaultRuntimeConfig = resolveDefaultRuntimeConfig;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/util-middleware/getSmithyContext.js
var import_dist_cjs$7, getSmithyContext;
var init_getSmithyContext = __esmMin((() => {
	import_dist_cjs$7 = require_dist_cjs();
	getSmithyContext = (context) => context[import_dist_cjs$7.SMITHY_CONTEXT_KEY] || (context[import_dist_cjs$7.SMITHY_CONTEXT_KEY] = {});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/util-middleware/normalizeProvider.js
var normalizeProvider;
var init_normalizeProvider = __esmMin((() => {
	normalizeProvider = (input) => {
		if (typeof input === "function") return input;
		const promisified = Promise.resolve(input);
		return () => promisified;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/invalid-dependency/invalidFunction.js
var invalidFunction;
var init_invalidFunction = __esmMin((() => {
	invalidFunction = (message) => () => {
		throw new Error(message);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/invalid-dependency/invalidProvider.js
var invalidProvider;
var init_invalidProvider = __esmMin((() => {
	invalidProvider = (message) => () => Promise.reject(message);
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/util-waiter/circularReplacer.js
var getCircularReplacer;
var init_circularReplacer = __esmMin((() => {
	getCircularReplacer = () => {
		const seen = /* @__PURE__ */ new WeakSet();
		return (key, value) => {
			if (typeof value === "object" && value !== null) {
				if (seen.has(value)) return "[Circular]";
				seen.add(value);
			}
			return value;
		};
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/util-waiter/utils/sleep.js
var sleep;
var init_sleep = __esmMin((() => {
	sleep = (seconds) => {
		return new Promise((resolve) => setTimeout(resolve, seconds * 1e3));
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/util-waiter/waiter.js
var waiterServiceDefaults, WaiterState, checkExceptions;
var init_waiter = __esmMin((() => {
	init_circularReplacer();
	waiterServiceDefaults = {
		minDelay: 2,
		maxDelay: 120
	};
	(function(WaiterState) {
		WaiterState["ABORTED"] = "ABORTED";
		WaiterState["FAILURE"] = "FAILURE";
		WaiterState["SUCCESS"] = "SUCCESS";
		WaiterState["RETRY"] = "RETRY";
		WaiterState["TIMEOUT"] = "TIMEOUT";
	})(WaiterState || (WaiterState = {}));
	checkExceptions = (result) => {
		if (result.state === WaiterState.ABORTED) {
			const abortError = /* @__PURE__ */ new Error(`${JSON.stringify({
				...result,
				reason: "Request was aborted"
			}, getCircularReplacer())}`);
			abortError.name = "AbortError";
			throw abortError;
		} else if (result.state === WaiterState.TIMEOUT) {
			const timeoutError = /* @__PURE__ */ new Error(`${JSON.stringify({
				...result,
				reason: "Waiter has timed out"
			}, getCircularReplacer())}`);
			timeoutError.name = "TimeoutError";
			throw timeoutError;
		} else if (result.state !== WaiterState.SUCCESS) throw new Error(`${JSON.stringify(result, getCircularReplacer())}`);
		return result;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/util-waiter/poller.js
var runPolling, checkWarn403, createMessageFromResponse, exponentialBackoffWithJitter, randomInRange;
var init_poller = __esmMin((() => {
	init_circularReplacer();
	init_sleep();
	init_waiter();
	runPolling = async ({ minDelay, maxDelay, maxWaitTime, abortController, client, abortSignal }, input, acceptorChecks) => {
		const observedResponses = {};
		const [minDelayMs, maxDelayMs] = [minDelay * 1e3, maxDelay * 1e3];
		let currentAttempt = 0;
		const waitUntil = Date.now() + maxWaitTime * 1e3;
		const warn403Time = Date.now() + 6e4;
		let didWarn403 = false;
		while (true) {
			if (currentAttempt > 0) {
				const delayMs = exponentialBackoffWithJitter(minDelayMs, maxDelayMs, currentAttempt, waitUntil);
				if (abortController?.signal?.aborted || abortSignal?.aborted) {
					const message = "AbortController signal aborted.";
					observedResponses[message] |= 0;
					observedResponses[message] += 1;
					return {
						state: WaiterState.ABORTED,
						observedResponses
					};
				}
				if (Date.now() + delayMs > waitUntil) return {
					state: WaiterState.TIMEOUT,
					observedResponses
				};
				await sleep(delayMs / 1e3);
			}
			const { state, reason } = await acceptorChecks(client, input);
			if (reason) {
				const message = createMessageFromResponse(reason);
				observedResponses[message] |= 0;
				observedResponses[message] += 1;
			}
			if (state !== WaiterState.RETRY) return {
				state,
				reason,
				final: reason,
				observedResponses
			};
			currentAttempt += 1;
			if (!didWarn403 && Date.now() >= warn403Time) {
				checkWarn403(observedResponses, client);
				didWarn403 = true;
			}
		}
	};
	checkWarn403 = (observedResponses = {}, client) => {
		const orderedErrors = Object.keys(observedResponses);
		let maxCount = 0;
		let count403 = 0;
		for (const response of orderedErrors) {
			const n = observedResponses[response] | 0;
			maxCount = Math.max(n, maxCount);
			if (response.startsWith("403:")) count403 += n;
		}
		const clientLogger = client?.config?.logger;
		const warningLogger = typeof clientLogger?.warn === "function" && !clientLogger.constructor?.name?.includes?.("NoOpLogger") ? clientLogger : console;
		if (count403 >= 3 || orderedErrors[orderedErrors.length - 1]?.startsWith("403:")) warningLogger.warn(`@smithy/util-waiter WARN - 403 status code encountered during waiter polling.`);
	};
	createMessageFromResponse = (reason) => {
		const status = reason?.$response?.statusCode ?? reason?.$metadata?.httpStatusCode;
		if (reason?.$responseBodyText) return `${status ? status + ": " : ""}Deserialization error for body: ${reason.$responseBodyText}`;
		if (status) {
			if (reason?.$response || reason?.message) return `${status ?? "Unknown"}: ${reason?.message}`;
			return `${status}: OK`;
		}
		return String(reason?.message ?? JSON.stringify(reason, getCircularReplacer()) ?? "Unknown");
	};
	exponentialBackoffWithJitter = (minDelayMs, maxDelayMs, attempt, waitUntil) => {
		if (attempt > Math.log(maxDelayMs / minDelayMs) / Math.log(2) + 1) return maxDelayMs;
		const delay = minDelayMs * 2 ** (attempt - 1);
		const waitFor = randomInRange(minDelayMs, Math.min(delay, maxDelayMs));
		if (Date.now() + waitFor > waitUntil) {
			const timeRemaining = waitUntil - Date.now();
			return Math.max(0, timeRemaining - 500);
		}
		return waitFor;
	};
	randomInRange = (min, max) => min + Math.random() * (max - min);
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/util-waiter/utils/validate.js
var validateWaiterOptions;
var init_validate = __esmMin((() => {
	validateWaiterOptions = (options) => {
		if (options.maxWaitTime <= 0) throw new Error(`WaiterConfiguration.maxWaitTime must be greater than 0`);
		else if (options.minDelay <= 0) throw new Error(`WaiterConfiguration.minDelay must be greater than 0`);
		else if (options.maxDelay <= 0) throw new Error(`WaiterConfiguration.maxDelay must be greater than 0`);
		else if (options.maxWaitTime <= options.minDelay) throw new Error(`WaiterConfiguration.maxWaitTime [${options.maxWaitTime}] must be greater than WaiterConfiguration.minDelay [${options.minDelay}] for this waiter`);
		else if (options.maxDelay < options.minDelay) throw new Error(`WaiterConfiguration.maxDelay [${options.maxDelay}] must be greater than WaiterConfiguration.minDelay [${options.minDelay}] for this waiter`);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/util-waiter/createWaiter.js
var abortTimeout, createWaiter;
var init_createWaiter = __esmMin((() => {
	init_poller();
	init_validate();
	init_waiter();
	abortTimeout = (abortSignal) => {
		let onAbort;
		return {
			clearListener() {
				if (typeof abortSignal.removeEventListener === "function") abortSignal.removeEventListener("abort", onAbort);
			},
			aborted: new Promise((resolve) => {
				onAbort = () => resolve({ state: WaiterState.ABORTED });
				if (typeof abortSignal.addEventListener === "function") abortSignal.addEventListener("abort", onAbort);
				else abortSignal.onabort = onAbort;
			})
		};
	};
	createWaiter = async (options, input, acceptorChecks) => {
		const params = {
			...waiterServiceDefaults,
			...options
		};
		validateWaiterOptions(params);
		const exitConditions = [runPolling(params, input, acceptorChecks)];
		const finalize = [];
		if (options.abortSignal) {
			const { aborted, clearListener } = abortTimeout(options.abortSignal);
			finalize.push(clearListener);
			exitConditions.push(aborted);
		}
		if (options.abortController?.signal) {
			const { aborted, clearListener } = abortTimeout(options.abortController.signal);
			finalize.push(clearListener);
			exitConditions.push(aborted);
		}
		return Promise.race(exitConditions).then((result) => {
			for (const fn of finalize) fn();
			return result;
		});
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/client.js
var Client;
var init_client$1 = __esmMin((() => {
	init_MiddlewareStack();
	Client = class {
		config;
		middlewareStack = constructStack();
		initConfig;
		handlers;
		constructor(config) {
			this.config = config;
			const { protocol, protocolSettings } = config;
			if (protocolSettings) {
				if (typeof protocol === "function") config.protocol = new protocol(protocolSettings);
			}
		}
		send(command, optionsOrCb, cb) {
			const options = typeof optionsOrCb !== "function" ? optionsOrCb : void 0;
			const callback = typeof optionsOrCb === "function" ? optionsOrCb : cb;
			const useHandlerCache = options === void 0 && this.config.cacheMiddleware === true;
			let handler;
			if (useHandlerCache) {
				if (!this.handlers) this.handlers = /* @__PURE__ */ new WeakMap();
				const handlers = this.handlers;
				if (handlers.has(command.constructor)) handler = handlers.get(command.constructor);
				else {
					handler = command.resolveMiddleware(this.middlewareStack, this.config, options);
					handlers.set(command.constructor, handler);
				}
			} else {
				delete this.handlers;
				handler = command.resolveMiddleware(this.middlewareStack, this.config, options);
			}
			if (callback) handler(command).then((result) => callback(null, result.output), (err) => callback(err)).catch(() => {});
			else return handler(command).then((result) => result.output);
		}
		destroy() {
			this.config?.requestHandler?.destroy?.();
			delete this.handlers;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/deref.js
var deref;
var init_deref = __esmMin((() => {
	deref = (schemaRef) => {
		if (typeof schemaRef === "function") return schemaRef();
		return schemaRef;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/is-array-buffer/is-array-buffer.js
var isArrayBuffer;
var init_is_array_buffer = __esmMin((() => {
	isArrayBuffer = (arg) => typeof ArrayBuffer === "function" && arg instanceof ArrayBuffer || Object.prototype.toString.call(arg) === "[object ArrayBuffer]";
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-buffer-from/buffer-from.js
var fromArrayBuffer, fromString;
var init_buffer_from = __esmMin((() => {
	init_is_array_buffer();
	fromArrayBuffer = (input, offset = 0, length = input.byteLength - offset) => {
		if (!isArrayBuffer(input)) throw new TypeError(`The "input" argument must be ArrayBuffer. Received type ${typeof input} (${input})`);
		return Buffer.from(input, offset, length);
	};
	fromString = (input, encoding) => {
		if (typeof input !== "string") throw new TypeError(`The "input" argument must be of type string. Received type ${typeof input} (${input})`);
		return encoding ? Buffer.from(input, encoding) : Buffer.from(input);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-base64/fromBase64.js
var BASE64_REGEX, fromBase64$1;
var init_fromBase64 = __esmMin((() => {
	init_buffer_from();
	BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;
	fromBase64$1 = (input) => {
		if (input.length * 3 % 4 !== 0) throw new TypeError(`Incorrect padding on base64 string.`);
		if (!BASE64_REGEX.exec(input)) throw new TypeError(`Invalid base64 string.`);
		const buffer = fromString(input, "base64");
		return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-utf8/fromUtf8.js
var fromUtf8$1;
var init_fromUtf8 = __esmMin((() => {
	init_buffer_from();
	fromUtf8$1 = (input) => {
		const buf = fromString(input, "utf8");
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength / Uint8Array.BYTES_PER_ELEMENT);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-base64/toBase64.js
var toBase64$1;
var init_toBase64 = __esmMin((() => {
	init_buffer_from();
	init_fromUtf8();
	toBase64$1 = (_input) => {
		let input;
		if (typeof _input === "string") input = fromUtf8$1(_input);
		else input = _input;
		if (typeof input !== "object" || typeof input.byteOffset !== "number" || typeof input.byteLength !== "number") throw new Error("@smithy/util-base64: toBase64 encoder function only accepts string | Uint8Array.");
		return fromArrayBuffer(input.buffer, input.byteOffset, input.byteLength).toString("base64");
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/blob/Uint8ArrayBlobAdapter.js
function bindUint8ArrayBlobAdapter(toUtf8, fromUtf8, toBase64, fromBase64) {
	return class Uint8ArrayBlobAdapter extends Uint8Array {
		static fromString(source, encoding = "utf-8") {
			if (typeof source === "string") {
				if (encoding === "base64") return Uint8ArrayBlobAdapter.mutate(fromBase64(source));
				return Uint8ArrayBlobAdapter.mutate(fromUtf8(source));
			}
			throw new Error(`Unsupported conversion from ${typeof source} to Uint8ArrayBlobAdapter.`);
		}
		static mutate(source) {
			Object.setPrototypeOf(source, Uint8ArrayBlobAdapter.prototype);
			return source;
		}
		transformToString(encoding = "utf-8") {
			if (encoding === "base64") return toBase64(this);
			return toUtf8(this);
		}
	};
}
var init_Uint8ArrayBlobAdapter = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-utf8/toUtf8.js
var toUtf8$1;
var init_toUtf8 = __esmMin((() => {
	init_buffer_from();
	toUtf8$1 = (input) => {
		if (typeof input === "string") return input;
		if (typeof input !== "object" || typeof input.byteOffset !== "number" || typeof input.byteLength !== "number") throw new Error("@smithy/util-utf8: toUtf8 encoder function only accepts string | Uint8Array.");
		return fromArrayBuffer(input.buffer, input.byteOffset, input.byteLength).toString("utf8");
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/uuid/v4.js
function bindV4(getRandomValues) {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return () => crypto.randomUUID();
	return () => {
		const rnds = new Uint8Array(16);
		getRandomValues(rnds);
		rnds[6] = rnds[6] & 15 | 64;
		rnds[8] = rnds[8] & 63 | 128;
		return decimalToHex[rnds[0]] + decimalToHex[rnds[1]] + decimalToHex[rnds[2]] + decimalToHex[rnds[3]] + "-" + decimalToHex[rnds[4]] + decimalToHex[rnds[5]] + "-" + decimalToHex[rnds[6]] + decimalToHex[rnds[7]] + "-" + decimalToHex[rnds[8]] + decimalToHex[rnds[9]] + "-" + decimalToHex[rnds[10]] + decimalToHex[rnds[11]] + decimalToHex[rnds[12]] + decimalToHex[rnds[13]] + decimalToHex[rnds[14]] + decimalToHex[rnds[15]];
	};
}
var decimalToHex;
var init_v4 = __esmMin((() => {
	decimalToHex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/copyDocumentWithTransform.js
var copyDocumentWithTransform;
var init_copyDocumentWithTransform = __esmMin((() => {
	copyDocumentWithTransform = (source, schemaRef, transform = (_) => _) => source;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/parse-utils.js
var parseBoolean, expectBoolean, expectNumber, MAX_FLOAT, expectFloat32, expectLong, expectInt, expectInt32, expectShort, expectByte, expectSizedInt, castInt, expectNonNull, expectObject, expectString, expectUnion, strictParseDouble, strictParseFloat, strictParseFloat32, NUMBER_REGEX, parseNumber, limitedParseDouble, handleFloat, limitedParseFloat, limitedParseFloat32, parseFloatString, strictParseLong, strictParseInt, strictParseInt32, strictParseShort, strictParseByte, stackTraceWarning, logger;
var init_parse_utils = __esmMin((() => {
	parseBoolean = (value) => {
		switch (value) {
			case "true": return true;
			case "false": return false;
			default: throw new Error(`Unable to parse boolean value "${value}"`);
		}
	};
	expectBoolean = (value) => {
		if (value === null || value === void 0) return;
		if (typeof value === "number") {
			if (value === 0 || value === 1) logger.warn(stackTraceWarning(`Expected boolean, got ${typeof value}: ${value}`));
			if (value === 0) return false;
			if (value === 1) return true;
		}
		if (typeof value === "string") {
			const lower = value.toLowerCase();
			if (lower === "false" || lower === "true") logger.warn(stackTraceWarning(`Expected boolean, got ${typeof value}: ${value}`));
			if (lower === "false") return false;
			if (lower === "true") return true;
		}
		if (typeof value === "boolean") return value;
		throw new TypeError(`Expected boolean, got ${typeof value}: ${value}`);
	};
	expectNumber = (value) => {
		if (value === null || value === void 0) return;
		if (typeof value === "string") {
			const parsed = parseFloat(value);
			if (!Number.isNaN(parsed)) {
				if (String(parsed) !== String(value)) logger.warn(stackTraceWarning(`Expected number but observed string: ${value}`));
				return parsed;
			}
		}
		if (typeof value === "number") return value;
		throw new TypeError(`Expected number, got ${typeof value}: ${value}`);
	};
	MAX_FLOAT = Math.ceil(2 ** 127 * (2 - 2 ** -23));
	expectFloat32 = (value) => {
		const expected = expectNumber(value);
		if (expected !== void 0 && !Number.isNaN(expected) && expected !== Infinity && expected !== -Infinity) {
			if (Math.abs(expected) > MAX_FLOAT) throw new TypeError(`Expected 32-bit float, got ${value}`);
		}
		return expected;
	};
	expectLong = (value) => {
		if (value === null || value === void 0) return;
		if (Number.isInteger(value) && !Number.isNaN(value)) return value;
		throw new TypeError(`Expected integer, got ${typeof value}: ${value}`);
	};
	expectInt = expectLong;
	expectInt32 = (value) => expectSizedInt(value, 32);
	expectShort = (value) => expectSizedInt(value, 16);
	expectByte = (value) => expectSizedInt(value, 8);
	expectSizedInt = (value, size) => {
		const expected = expectLong(value);
		if (expected !== void 0 && castInt(expected, size) !== expected) throw new TypeError(`Expected ${size}-bit integer, got ${value}`);
		return expected;
	};
	castInt = (value, size) => {
		switch (size) {
			case 32: return Int32Array.of(value)[0];
			case 16: return Int16Array.of(value)[0];
			case 8: return Int8Array.of(value)[0];
		}
	};
	expectNonNull = (value, location) => {
		if (value === null || value === void 0) {
			if (location) throw new TypeError(`Expected a non-null value for ${location}`);
			throw new TypeError("Expected a non-null value");
		}
		return value;
	};
	expectObject = (value) => {
		if (value === null || value === void 0) return;
		if (typeof value === "object" && !Array.isArray(value)) return value;
		throw new TypeError(`Expected object, got ${Array.isArray(value) ? "array" : typeof value}: ${value}`);
	};
	expectString = (value) => {
		if (value === null || value === void 0) return;
		if (typeof value === "string") return value;
		if ([
			"boolean",
			"number",
			"bigint"
		].includes(typeof value)) {
			logger.warn(stackTraceWarning(`Expected string, got ${typeof value}: ${value}`));
			return String(value);
		}
		throw new TypeError(`Expected string, got ${typeof value}: ${value}`);
	};
	expectUnion = (value) => {
		if (value === null || value === void 0) return;
		const asObject = expectObject(value);
		const setKeys = [];
		for (const k in asObject) if (asObject[k] != null) setKeys.push(k);
		if (setKeys.length === 0) throw new TypeError(`Unions must have exactly one non-null member. None were found.`);
		if (setKeys.length > 1) throw new TypeError(`Unions must have exactly one non-null member. Keys ${setKeys} were not null.`);
		return asObject;
	};
	strictParseDouble = (value) => {
		if (typeof value == "string") return expectNumber(parseNumber(value));
		return expectNumber(value);
	};
	strictParseFloat = strictParseDouble;
	strictParseFloat32 = (value) => {
		if (typeof value == "string") return expectFloat32(parseNumber(value));
		return expectFloat32(value);
	};
	NUMBER_REGEX = /(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|(-?Infinity)|(NaN)/g;
	parseNumber = (value) => {
		const matches = value.match(NUMBER_REGEX);
		if (matches === null || matches[0].length !== value.length) throw new TypeError(`Expected real number, got implicit NaN`);
		return parseFloat(value);
	};
	limitedParseDouble = (value) => {
		if (typeof value == "string") return parseFloatString(value);
		return expectNumber(value);
	};
	handleFloat = limitedParseDouble;
	limitedParseFloat = limitedParseDouble;
	limitedParseFloat32 = (value) => {
		if (typeof value == "string") return parseFloatString(value);
		return expectFloat32(value);
	};
	parseFloatString = (value) => {
		switch (value) {
			case "NaN": return NaN;
			case "Infinity": return Infinity;
			case "-Infinity": return -Infinity;
			default: throw new Error(`Unable to parse float value: ${value}`);
		}
	};
	strictParseLong = (value) => {
		if (typeof value === "string") return expectLong(parseNumber(value));
		return expectLong(value);
	};
	strictParseInt = strictParseLong;
	strictParseInt32 = (value) => {
		if (typeof value === "string") return expectInt32(parseNumber(value));
		return expectInt32(value);
	};
	strictParseShort = (value) => {
		if (typeof value === "string") return expectShort(parseNumber(value));
		return expectShort(value);
	};
	strictParseByte = (value) => {
		if (typeof value === "string") return expectByte(parseNumber(value));
		return expectByte(value);
	};
	stackTraceWarning = (message) => {
		return String(new TypeError(message).stack || message).split("\n").slice(0, 5).filter((s) => !s.includes("stackTraceWarning")).join("\n");
	};
	logger = { warn: console.warn };
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/date-utils.js
function dateToUtcString(date) {
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	const dayOfWeek = date.getUTCDay();
	const dayOfMonthInt = date.getUTCDate();
	const hoursInt = date.getUTCHours();
	const minutesInt = date.getUTCMinutes();
	const secondsInt = date.getUTCSeconds();
	const dayOfMonthString = dayOfMonthInt < 10 ? `0${dayOfMonthInt}` : `${dayOfMonthInt}`;
	const hoursString = hoursInt < 10 ? `0${hoursInt}` : `${hoursInt}`;
	const minutesString = minutesInt < 10 ? `0${minutesInt}` : `${minutesInt}`;
	const secondsString = secondsInt < 10 ? `0${secondsInt}` : `${secondsInt}`;
	return `${DAYS[dayOfWeek]}, ${dayOfMonthString} ${MONTHS[month]} ${year} ${hoursString}:${minutesString}:${secondsString} GMT`;
}
var DAYS, MONTHS, RFC3339, parseRfc3339DateTime, RFC3339_WITH_OFFSET$1, parseRfc3339DateTimeWithOffset, IMF_FIXDATE$1, RFC_850_DATE$1, ASC_TIME$1, parseRfc7231DateTime, parseEpochTimestamp, buildDate, parseTwoDigitYear, FIFTY_YEARS_IN_MILLIS, adjustRfc850Year, parseMonthByShortName, DAYS_IN_MONTH, validateDayOfMonth, isLeapYear, parseDateValue, parseMilliseconds, parseOffsetToMilliseconds, stripLeadingZeroes;
var init_date_utils = __esmMin((() => {
	init_parse_utils();
	DAYS = [
		"Sun",
		"Mon",
		"Tue",
		"Wed",
		"Thu",
		"Fri",
		"Sat"
	];
	MONTHS = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec"
	];
	RFC3339 = /* @__PURE__ */ new RegExp(/^(\d{4})-(\d{2})-(\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?[zZ]$/);
	parseRfc3339DateTime = (value) => {
		if (value === null || value === void 0) return;
		if (typeof value !== "string") throw new TypeError("RFC-3339 date-times must be expressed as strings");
		const match = RFC3339.exec(value);
		if (!match) throw new TypeError("Invalid RFC-3339 date-time value");
		const [_, yearStr, monthStr, dayStr, hours, minutes, seconds, fractionalMilliseconds] = match;
		return buildDate(strictParseShort(stripLeadingZeroes(yearStr)), parseDateValue(monthStr, "month", 1, 12), parseDateValue(dayStr, "day", 1, 31), {
			hours,
			minutes,
			seconds,
			fractionalMilliseconds
		});
	};
	RFC3339_WITH_OFFSET$1 = /* @__PURE__ */ new RegExp(/^(\d{4})-(\d{2})-(\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(([-+]\d{2}\:\d{2})|[zZ])$/);
	parseRfc3339DateTimeWithOffset = (value) => {
		if (value === null || value === void 0) return;
		if (typeof value !== "string") throw new TypeError("RFC-3339 date-times must be expressed as strings");
		const match = RFC3339_WITH_OFFSET$1.exec(value);
		if (!match) throw new TypeError("Invalid RFC-3339 date-time value");
		const [_, yearStr, monthStr, dayStr, hours, minutes, seconds, fractionalMilliseconds, offsetStr] = match;
		const date = buildDate(strictParseShort(stripLeadingZeroes(yearStr)), parseDateValue(monthStr, "month", 1, 12), parseDateValue(dayStr, "day", 1, 31), {
			hours,
			minutes,
			seconds,
			fractionalMilliseconds
		});
		if (offsetStr.toUpperCase() != "Z") date.setTime(date.getTime() - parseOffsetToMilliseconds(offsetStr));
		return date;
	};
	IMF_FIXDATE$1 = /* @__PURE__ */ new RegExp(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))? GMT$/);
	RFC_850_DATE$1 = /* @__PURE__ */ new RegExp(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))? GMT$/);
	ASC_TIME$1 = /* @__PURE__ */ new RegExp(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|\d{2}) (\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))? (\d{4})$/);
	parseRfc7231DateTime = (value) => {
		if (value === null || value === void 0) return;
		if (typeof value !== "string") throw new TypeError("RFC-7231 date-times must be expressed as strings");
		let match = IMF_FIXDATE$1.exec(value);
		if (match) {
			const [_, dayStr, monthStr, yearStr, hours, minutes, seconds, fractionalMilliseconds] = match;
			return buildDate(strictParseShort(stripLeadingZeroes(yearStr)), parseMonthByShortName(monthStr), parseDateValue(dayStr, "day", 1, 31), {
				hours,
				minutes,
				seconds,
				fractionalMilliseconds
			});
		}
		match = RFC_850_DATE$1.exec(value);
		if (match) {
			const [_, dayStr, monthStr, yearStr, hours, minutes, seconds, fractionalMilliseconds] = match;
			return adjustRfc850Year(buildDate(parseTwoDigitYear(yearStr), parseMonthByShortName(monthStr), parseDateValue(dayStr, "day", 1, 31), {
				hours,
				minutes,
				seconds,
				fractionalMilliseconds
			}));
		}
		match = ASC_TIME$1.exec(value);
		if (match) {
			const [_, monthStr, dayStr, hours, minutes, seconds, fractionalMilliseconds, yearStr] = match;
			return buildDate(strictParseShort(stripLeadingZeroes(yearStr)), parseMonthByShortName(monthStr), parseDateValue(dayStr.trimLeft(), "day", 1, 31), {
				hours,
				minutes,
				seconds,
				fractionalMilliseconds
			});
		}
		throw new TypeError("Invalid RFC-7231 date-time value");
	};
	parseEpochTimestamp = (value) => {
		if (value === null || value === void 0) return;
		let valueAsDouble;
		if (typeof value === "number") valueAsDouble = value;
		else if (typeof value === "string") valueAsDouble = strictParseDouble(value);
		else if (typeof value === "object" && value.tag === 1) valueAsDouble = value.value;
		else throw new TypeError("Epoch timestamps must be expressed as floating point numbers or their string representation");
		if (Number.isNaN(valueAsDouble) || valueAsDouble === Infinity || valueAsDouble === -Infinity) throw new TypeError("Epoch timestamps must be valid, non-Infinite, non-NaN numerics");
		return new Date(Math.round(valueAsDouble * 1e3));
	};
	buildDate = (year, month, day, time) => {
		const adjustedMonth = month - 1;
		validateDayOfMonth(year, adjustedMonth, day);
		return new Date(Date.UTC(year, adjustedMonth, day, parseDateValue(time.hours, "hour", 0, 23), parseDateValue(time.minutes, "minute", 0, 59), parseDateValue(time.seconds, "seconds", 0, 60), parseMilliseconds(time.fractionalMilliseconds)));
	};
	parseTwoDigitYear = (value) => {
		const thisYear = (/* @__PURE__ */ new Date()).getUTCFullYear();
		const valueInThisCentury = Math.floor(thisYear / 100) * 100 + strictParseShort(stripLeadingZeroes(value));
		if (valueInThisCentury < thisYear) return valueInThisCentury + 100;
		return valueInThisCentury;
	};
	FIFTY_YEARS_IN_MILLIS = 50 * 365 * 24 * 60 * 60 * 1e3;
	adjustRfc850Year = (input) => {
		if (input.getTime() - (/* @__PURE__ */ new Date()).getTime() > FIFTY_YEARS_IN_MILLIS) return new Date(Date.UTC(input.getUTCFullYear() - 100, input.getUTCMonth(), input.getUTCDate(), input.getUTCHours(), input.getUTCMinutes(), input.getUTCSeconds(), input.getUTCMilliseconds()));
		return input;
	};
	parseMonthByShortName = (value) => {
		const monthIdx = MONTHS.indexOf(value);
		if (monthIdx < 0) throw new TypeError(`Invalid month: ${value}`);
		return monthIdx + 1;
	};
	DAYS_IN_MONTH = [
		31,
		28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31
	];
	validateDayOfMonth = (year, month, day) => {
		let maxDays = DAYS_IN_MONTH[month];
		if (month === 1 && isLeapYear(year)) maxDays = 29;
		if (day > maxDays) throw new TypeError(`Invalid day for ${MONTHS[month]} in ${year}: ${day}`);
	};
	isLeapYear = (year) => {
		return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	};
	parseDateValue = (value, type, lower, upper) => {
		const dateVal = strictParseByte(stripLeadingZeroes(value));
		if (dateVal < lower || dateVal > upper) throw new TypeError(`${type} must be between ${lower} and ${upper}, inclusive`);
		return dateVal;
	};
	parseMilliseconds = (value) => {
		if (value === null || value === void 0) return 0;
		return strictParseFloat32("0." + value) * 1e3;
	};
	parseOffsetToMilliseconds = (value) => {
		const directionStr = value[0];
		let direction = 1;
		if (directionStr == "+") direction = 1;
		else if (directionStr == "-") direction = -1;
		else throw new TypeError(`Offset direction, ${directionStr}, must be "+" or "-"`);
		const hour = Number(value.substring(1, 3));
		const minute = Number(value.substring(4, 6));
		return direction * (hour * 60 + minute) * 60 * 1e3;
	};
	stripLeadingZeroes = (value) => {
		let idx = 0;
		while (idx < value.length - 1 && value.charAt(idx) === "0") idx++;
		if (idx === 0) return value;
		return value.slice(idx);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/lazy-json.js
var LazyJsonString;
var init_lazy_json = __esmMin((() => {
	LazyJsonString = function LazyJsonString(val) {
		return Object.assign(new String(val), {
			deserializeJSON() {
				return JSON.parse(String(val));
			},
			toString() {
				return String(val);
			},
			toJSON() {
				return String(val);
			}
		});
	};
	LazyJsonString.from = (object) => {
		if (object && typeof object === "object" && (object instanceof LazyJsonString || "deserializeJSON" in object)) return object;
		else if (typeof object === "string" || Object.getPrototypeOf(object) === String.prototype) return LazyJsonString(String(object));
		return LazyJsonString(JSON.stringify(object));
	};
	LazyJsonString.fromObject = LazyJsonString.from;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/quote-header.js
function quoteHeader(part) {
	if (part.includes(",") || part.includes("\"")) part = `"${part.replace(/"/g, "\\\"")}"`;
	return part;
}
var init_quote_header = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/schema-serde-lib/schema-date-utils.js
function range(v, min, max) {
	const _v = Number(v);
	if (_v < min || _v > max) throw new Error(`Value ${_v} out of range [${min}, ${max}]`);
}
var ddd, mmm, time, date, year, RFC3339_WITH_OFFSET, IMF_FIXDATE, RFC_850_DATE, ASC_TIME, months, _parseEpochTimestamp, _parseRfc3339DateTimeWithOffset, _parseRfc7231DateTime;
var init_schema_date_utils = __esmMin((() => {
	ddd = `(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:[ne|u?r]?s?day)?`;
	mmm = `(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)`;
	time = `(\\d?\\d):(\\d{2}):(\\d{2})(?:\\.(\\d+))?`;
	date = `(\\d?\\d)`;
	year = `(\\d{4})`;
	RFC3339_WITH_OFFSET = /* @__PURE__ */ new RegExp(/^(\d{4})-(\d\d)-(\d\d)[tT](\d\d):(\d\d):(\d\d)(\.(\d+))?(([-+]\d\d:\d\d)|[zZ])$/);
	IMF_FIXDATE = new RegExp(`^${ddd}, ${date} ${mmm} ${year} ${time} GMT$`);
	RFC_850_DATE = new RegExp(`^${ddd}, ${date}-${mmm}-(\\d\\d) ${time} GMT$`);
	ASC_TIME = new RegExp(`^${ddd} ${mmm} ( [1-9]|\\d\\d) ${time} ${year}$`);
	months = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec"
	];
	_parseEpochTimestamp = (value) => {
		if (value == null) return;
		let num = NaN;
		if (typeof value === "number") num = value;
		else if (typeof value === "string") {
			if (!/^-?\d*\.?\d+$/.test(value)) throw new TypeError(`parseEpochTimestamp - numeric string invalid.`);
			num = Number.parseFloat(value);
		} else if (typeof value === "object" && value.tag === 1) num = value.value;
		if (isNaN(num) || Math.abs(num) === Infinity) throw new TypeError("Epoch timestamps must be valid finite numbers.");
		return new Date(Math.round(num * 1e3));
	};
	_parseRfc3339DateTimeWithOffset = (value) => {
		if (value == null) return;
		if (typeof value !== "string") throw new TypeError("RFC3339 timestamps must be strings");
		const matches = RFC3339_WITH_OFFSET.exec(value);
		if (!matches) throw new TypeError(`Invalid RFC3339 timestamp format ${value}`);
		const [, yearStr, monthStr, dayStr, hours, minutes, seconds, , ms, offsetStr] = matches;
		range(monthStr, 1, 12);
		range(dayStr, 1, 31);
		range(hours, 0, 23);
		range(minutes, 0, 59);
		range(seconds, 0, 60);
		const date = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr), Number(hours), Number(minutes), Number(seconds), Number(ms) ? Math.round(parseFloat(`0.${ms}`) * 1e3) : 0));
		date.setUTCFullYear(Number(yearStr));
		if (offsetStr.toUpperCase() != "Z") {
			const [, sign, offsetH, offsetM] = /([+-])(\d\d):(\d\d)/.exec(offsetStr) || [
				void 0,
				"+",
				0,
				0
			];
			const scalar = sign === "-" ? 1 : -1;
			date.setTime(date.getTime() + scalar * (Number(offsetH) * 60 * 60 * 1e3 + Number(offsetM) * 60 * 1e3));
		}
		return date;
	};
	_parseRfc7231DateTime = (value) => {
		if (value == null) return;
		if (typeof value !== "string") throw new TypeError("RFC7231 timestamps must be strings.");
		let day;
		let month;
		let year;
		let hour;
		let minute;
		let second;
		let fraction;
		let matches;
		if (matches = IMF_FIXDATE.exec(value)) [, day, month, year, hour, minute, second, fraction] = matches;
		else if (matches = RFC_850_DATE.exec(value)) {
			[, day, month, year, hour, minute, second, fraction] = matches;
			year = (Number(year) + 1900).toString();
		} else if (matches = ASC_TIME.exec(value)) [, month, day, hour, minute, second, fraction, year] = matches;
		if (year && second) {
			const timestamp = Date.UTC(Number(year), months.indexOf(month), Number(day), Number(hour), Number(minute), Number(second), fraction ? Math.round(parseFloat(`0.${fraction}`) * 1e3) : 0);
			range(day, 1, 31);
			range(hour, 0, 23);
			range(minute, 0, 59);
			range(second, 0, 60);
			const date = new Date(timestamp);
			date.setUTCFullYear(Number(year));
			return date;
		}
		throw new TypeError(`Invalid RFC7231 date-time value ${value}.`);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/split-every.js
function splitEvery(value, delimiter, numDelimiters) {
	if (numDelimiters <= 0 || !Number.isInteger(numDelimiters)) throw new Error("Invalid number of delimiters (" + numDelimiters + ") for splitEvery.");
	const segments = value.split(delimiter);
	if (numDelimiters === 1) return segments;
	const compoundSegments = [];
	let currentSegment = "";
	for (let i = 0; i < segments.length; i++) {
		if (currentSegment === "") currentSegment = segments[i];
		else currentSegment += delimiter + segments[i];
		if ((i + 1) % numDelimiters === 0) {
			compoundSegments.push(currentSegment);
			currentSegment = "";
		}
	}
	if (currentSegment !== "") compoundSegments.push(currentSegment);
	return compoundSegments;
}
var init_split_every = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/split-header.js
var splitHeader;
var init_split_header = __esmMin((() => {
	splitHeader = (value) => {
		const z = value.length;
		const values = [];
		let withinQuotes = false;
		let prevChar = void 0;
		let anchor = 0;
		for (let i = 0; i < z; ++i) {
			const char = value[i];
			switch (char) {
				case `"`:
					if (prevChar !== "\\") withinQuotes = !withinQuotes;
					break;
				case ",":
					if (!withinQuotes) {
						values.push(value.slice(anchor, i));
						anchor = i + 1;
					}
					break;
				default:
			}
			prevChar = char;
		}
		values.push(value.slice(anchor));
		return values.map((v) => {
			v = v.trim();
			const z = v.length;
			if (z < 2) return v;
			if (v[0] === `"` && v[z - 1] === `"`) v = v.slice(1, z - 1);
			return v.replace(/\\"/g, "\"");
		});
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/value/NumericValue.js
function nv(input) {
	return new NumericValue(String(input), "bigDecimal");
}
var format, NumericValue;
var init_NumericValue = __esmMin((() => {
	format = /^-?\d*(\.\d+)?$/;
	NumericValue = class NumericValue {
		string;
		type;
		constructor(string, type) {
			this.string = string;
			this.type = type;
			if (!format.test(string)) throw new Error(`@smithy/core/serde - NumericValue must only contain [0-9], at most one decimal point ".", and an optional negation prefix "-".`);
		}
		toString() {
			return this.string;
		}
		static [Symbol.hasInstance](object) {
			if (!object || typeof object !== "object") return false;
			const _nv = object;
			return NumericValue.prototype.isPrototypeOf(object) || _nv.type === "bigDecimal" && format.test(_nv.string);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-hex-encoding/hex-encoding.js
function fromHex(encoded) {
	if (encoded.length % 2 !== 0) throw new Error("Hex encoded strings must have an even number length");
	const out = new Uint8Array(encoded.length / 2);
	for (let i = 0; i < encoded.length; i += 2) {
		const encodedByte = encoded.slice(i, i + 2).toLowerCase();
		if (encodedByte in HEX_TO_SHORT) out[i / 2] = HEX_TO_SHORT[encodedByte];
		else throw new Error(`Cannot decode unrecognized sequence ${encodedByte} as hexadecimal`);
	}
	return out;
}
function toHex(bytes) {
	let out = "";
	for (let i = 0; i < bytes.byteLength; i++) out += SHORT_TO_HEX[bytes[i]];
	return out;
}
var SHORT_TO_HEX, HEX_TO_SHORT;
var init_hex_encoding = __esmMin((() => {
	SHORT_TO_HEX = {};
	HEX_TO_SHORT = {};
	for (let i = 0; i < 256; i++) {
		let encodedByte = i.toString(16).toLowerCase();
		if (encodedByte.length === 1) encodedByte = `0${encodedByte}`;
		SHORT_TO_HEX[i] = encodedByte;
		HEX_TO_SHORT[encodedByte] = i;
	}
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-body-length/calculateBodyLength.js
var calculateBodyLength;
var init_calculateBodyLength = __esmMin((() => {
	calculateBodyLength = (body) => {
		if (!body) return 0;
		if (typeof body === "string") return Buffer.byteLength(body);
		else if (typeof body.byteLength === "number") return body.byteLength;
		else if (typeof body.size === "number") return body.size;
		else if (typeof body.start === "number" && typeof body.end === "number") return body.end + 1 - body.start;
		else if (body instanceof ReadStream) {
			if (body.path != null) return lstatSync(body.path).size;
			else if (typeof body.fd === "number") return fstatSync(body.fd).size;
		}
		throw new Error(`Body Length computation failed for ${body}`);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-utf8/toUint8Array.js
var toUint8Array;
var init_toUint8Array = __esmMin((() => {
	init_fromUtf8();
	toUint8Array = (data) => {
		if (typeof data === "string") return fromUtf8$1(data);
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength / Uint8Array.BYTES_PER_ELEMENT);
		return new Uint8Array(data);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/middleware-serde/deserializerMiddleware.js
var deserializerMiddleware, findHeader$1;
var init_deserializerMiddleware = __esmMin((() => {
	init_protocols();
	deserializerMiddleware = (options, deserializer) => (next, context) => async (args) => {
		const { response } = await next(args);
		try {
			return {
				response,
				output: await deserializer(response, options)
			};
		} catch (error) {
			Object.defineProperty(error, "$response", {
				value: response,
				enumerable: false,
				writable: false,
				configurable: false
			});
			if (!("$metadata" in error)) {
				const hint = `Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object.`;
				try {
					error.message += "\n  " + hint;
				} catch (e) {
					if (!context.logger || context.logger?.constructor?.name === "NoOpLogger") console.warn(hint);
					else context.logger?.warn?.(hint);
				}
				if (typeof error.$responseBodyText !== "undefined") {
					if (error.$response) error.$response.body = error.$responseBodyText;
				}
				try {
					if (HttpResponse.isInstance(response)) {
						const { headers = {} } = response;
						const headerEntries = Object.entries(headers);
						error.$metadata = {
							httpStatusCode: response.statusCode,
							requestId: findHeader$1(/^x-[\w-]+-request-?id$/, headerEntries),
							extendedRequestId: findHeader$1(/^x-[\w-]+-id-2$/, headerEntries),
							cfId: findHeader$1(/^x-[\w-]+-cf-id$/, headerEntries)
						};
					}
				} catch (e) {}
			}
			throw error;
		}
	};
	findHeader$1 = (pattern, headers) => {
		return (headers.find(([k]) => {
			return k.match(pattern);
		}) || [void 0, void 0])[1];
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/property-provider/ProviderError.js
var ProviderError;
var init_ProviderError = __esmMin((() => {
	ProviderError = class ProviderError extends Error {
		name = "ProviderError";
		tryNextLink;
		constructor(message, options = true) {
			let logger;
			let tryNextLink = true;
			if (typeof options === "boolean") {
				logger = void 0;
				tryNextLink = options;
			} else if (options != null && typeof options === "object") {
				logger = options.logger;
				tryNextLink = options.tryNextLink ?? true;
			}
			super(message);
			this.tryNextLink = tryNextLink;
			Object.setPrototypeOf(this, ProviderError.prototype);
			logger?.debug?.(`@smithy/property-provider ${tryNextLink ? "->" : "(!)"} ${message}`);
		}
		static from(error, options = true) {
			return Object.assign(new this(error.message, options), error);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/property-provider/CredentialsProviderError.js
var CredentialsProviderError;
var init_CredentialsProviderError = __esmMin((() => {
	init_ProviderError();
	CredentialsProviderError = class CredentialsProviderError extends ProviderError {
		name = "CredentialsProviderError";
		constructor(message, options = true) {
			super(message, options);
			Object.setPrototypeOf(this, CredentialsProviderError.prototype);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/property-provider/TokenProviderError.js
var TokenProviderError;
var init_TokenProviderError = __esmMin((() => {
	init_ProviderError();
	TokenProviderError = class TokenProviderError extends ProviderError {
		name = "TokenProviderError";
		constructor(message, options = true) {
			super(message, options);
			Object.setPrototypeOf(this, TokenProviderError.prototype);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/property-provider/chain.js
var chain;
var init_chain = __esmMin((() => {
	init_ProviderError();
	chain = (...providers) => async () => {
		if (providers.length === 0) throw new ProviderError("No providers in chain");
		let lastProviderError;
		for (const provider of providers) try {
			return await provider();
		} catch (err) {
			lastProviderError = err;
			if (err?.tryNextLink) continue;
			throw err;
		}
		throw lastProviderError;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/property-provider/fromValue.js
var fromValue;
var init_fromValue = __esmMin((() => {
	fromValue = (staticValue) => () => Promise.resolve(staticValue);
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/property-provider/memoize.js
var memoize;
var init_memoize = __esmMin((() => {
	memoize = (provider, isExpired, requiresRefresh) => {
		let resolved;
		let pending;
		let hasResult;
		let isConstant = false;
		const coalesceProvider = async () => {
			if (!pending) pending = provider();
			try {
				resolved = await pending;
				hasResult = true;
				isConstant = false;
			} finally {
				pending = void 0;
			}
			return resolved;
		};
		if (isExpired === void 0) return async (options) => {
			if (!hasResult || options?.forceRefresh) resolved = await coalesceProvider();
			return resolved;
		};
		return async (options) => {
			if (!hasResult || options?.forceRefresh) resolved = await coalesceProvider();
			if (isConstant) return resolved;
			if (requiresRefresh && !requiresRefresh(resolved)) {
				isConstant = true;
				return resolved;
			}
			if (isExpired(resolved)) {
				await coalesceProvider();
				return resolved;
			}
			return resolved;
		};
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/util-config-provider/booleanSelector.js
var booleanSelector;
var init_booleanSelector = __esmMin((() => {
	booleanSelector = (obj, key, type) => {
		if (!(key in obj)) return void 0;
		if (obj[key] === "true") return true;
		if (obj[key] === "false") return false;
		throw new Error(`Cannot load ${type} "${key}". Expected "true" or "false", got ${obj[key]}.`);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/util-config-provider/numberSelector.js
var numberSelector;
var init_numberSelector = __esmMin((() => {
	numberSelector = (obj, key, type) => {
		if (!(key in obj)) return void 0;
		const numberValue = parseInt(obj[key], 10);
		if (Number.isNaN(numberValue)) throw new TypeError(`Cannot load ${type} '${key}'. Expected number, got '${obj[key]}'.`);
		return numberValue;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/util-config-provider/types.js
var SelectorType;
var init_types$1 = __esmMin((() => {
	(function(SelectorType) {
		SelectorType["ENV"] = "env";
		SelectorType["CONFIG"] = "shared config entry";
	})(SelectorType || (SelectorType = {}));
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/getHomeDir.js
var homeDirCache, getHomeDirCacheKey, getHomeDir;
var init_getHomeDir = __esmMin((() => {
	homeDirCache = {};
	getHomeDirCacheKey = () => {
		if (process && process.geteuid) return `${process.geteuid()}`;
		return "DEFAULT";
	};
	getHomeDir = () => {
		const { HOME, USERPROFILE, HOMEPATH, HOMEDRIVE = `C:${sep}` } = process.env;
		if (HOME) return HOME;
		if (USERPROFILE) return USERPROFILE;
		if (HOMEPATH) return `${HOMEDRIVE}${HOMEPATH}`;
		const homeDirCacheKey = getHomeDirCacheKey();
		if (!homeDirCache[homeDirCacheKey]) homeDirCache[homeDirCacheKey] = homedir();
		return homeDirCache[homeDirCacheKey];
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/getProfileName.js
var ENV_PROFILE, DEFAULT_PROFILE, getProfileName;
var init_getProfileName = __esmMin((() => {
	ENV_PROFILE = "AWS_PROFILE";
	DEFAULT_PROFILE = "default";
	getProfileName = (init) => init.profile || process.env["AWS_PROFILE"] || "default";
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/getSSOTokenFilepath.js
var getSSOTokenFilepath;
var init_getSSOTokenFilepath = __esmMin((() => {
	init_getHomeDir();
	getSSOTokenFilepath = (id) => {
		const cacheName = createHash("sha1").update(id).digest("hex");
		return join(getHomeDir(), ".aws", "sso", "cache", `${cacheName}.json`);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/getSSOTokenFromFile.js
var tokenIntercept, getSSOTokenFromFile;
var init_getSSOTokenFromFile = __esmMin((() => {
	init_getSSOTokenFilepath();
	tokenIntercept = {};
	getSSOTokenFromFile = async (id) => {
		if (tokenIntercept[id]) return tokenIntercept[id];
		const ssoTokenText = await readFile(getSSOTokenFilepath(id), "utf8");
		return JSON.parse(ssoTokenText);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/constants.js
var init_constants$2 = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/getConfigData.js
var import_dist_cjs$6, getConfigData;
var init_getConfigData = __esmMin((() => {
	import_dist_cjs$6 = require_dist_cjs();
	init_constants$2();
	getConfigData = (data) => Object.entries(data).filter(([key]) => {
		const indexOfSeparator = key.indexOf(".");
		if (indexOfSeparator === -1) return false;
		return Object.values(import_dist_cjs$6.IniSectionType).includes(key.substring(0, indexOfSeparator));
	}).reduce((acc, [key, value]) => {
		const indexOfSeparator = key.indexOf(".");
		const updatedKey = key.substring(0, indexOfSeparator) === import_dist_cjs$6.IniSectionType.PROFILE ? key.substring(indexOfSeparator + 1) : key;
		acc[updatedKey] = value;
		return acc;
	}, { ...data.default && { default: data.default } });
})), getConfigFilepath;
var init_getConfigFilepath = __esmMin((() => {
	init_getHomeDir();
	getConfigFilepath = () => process.env["AWS_CONFIG_FILE"] || join(getHomeDir(), ".aws", "config");
})), getCredentialsFilepath;
var init_getCredentialsFilepath = __esmMin((() => {
	init_getHomeDir();
	getCredentialsFilepath = () => process.env["AWS_SHARED_CREDENTIALS_FILE"] || join(getHomeDir(), ".aws", "credentials");
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/parseIni.js
var import_dist_cjs$5, prefixKeyRegex, profileNameBlockList, parseIni;
var init_parseIni = __esmMin((() => {
	import_dist_cjs$5 = require_dist_cjs();
	init_constants$2();
	prefixKeyRegex = /^([\w-]+)\s(["'])?([\w-@\+\.%:/]+)\2$/;
	profileNameBlockList = ["__proto__", "profile __proto__"];
	parseIni = (iniData) => {
		const map = {};
		let currentSection;
		let currentSubSection;
		for (const iniLine of iniData.split(/\r?\n/)) {
			const trimmedLine = iniLine.split(/(^|\s)[;#]/)[0].trim();
			if (trimmedLine[0] === "[" && trimmedLine[trimmedLine.length - 1] === "]") {
				currentSection = void 0;
				currentSubSection = void 0;
				const sectionName = trimmedLine.substring(1, trimmedLine.length - 1);
				const matches = prefixKeyRegex.exec(sectionName);
				if (matches) {
					const [, prefix, , name] = matches;
					if (Object.values(import_dist_cjs$5.IniSectionType).includes(prefix)) currentSection = [prefix, name].join(".");
				} else currentSection = sectionName;
				if (profileNameBlockList.includes(sectionName)) throw new Error(`Found invalid profile name "${sectionName}"`);
			} else if (currentSection) {
				const indexOfEqualsSign = trimmedLine.indexOf("=");
				if (![0, -1].includes(indexOfEqualsSign)) {
					const [name, value] = [trimmedLine.substring(0, indexOfEqualsSign).trim(), trimmedLine.substring(indexOfEqualsSign + 1).trim()];
					if (value === "") currentSubSection = name;
					else {
						if (currentSubSection && iniLine.trimStart() === iniLine) currentSubSection = void 0;
						map[currentSection] = map[currentSection] || {};
						const key = currentSubSection ? [currentSubSection, name].join(".") : name;
						map[currentSection][key] = value;
					}
				}
			}
		}
		return map;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/readFile.js
var filePromises, fileIntercept, readFile$1;
var init_readFile = __esmMin((() => {
	filePromises = {};
	fileIntercept = {};
	readFile$1 = (path, options) => {
		if (fileIntercept[path] !== void 0) return fileIntercept[path];
		if (!filePromises[path] || options?.ignoreCache) filePromises[path] = readFile(path, "utf8");
		return filePromises[path];
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/loadSharedConfigFiles.js
var swallowError$1, loadSharedConfigFiles;
var init_loadSharedConfigFiles = __esmMin((() => {
	init_getConfigData();
	init_getConfigFilepath();
	init_getCredentialsFilepath();
	init_getHomeDir();
	init_parseIni();
	init_readFile();
	init_constants$2();
	swallowError$1 = () => ({});
	loadSharedConfigFiles = async (init = {}) => {
		const { filepath = getCredentialsFilepath(), configFilepath = getConfigFilepath() } = init;
		const homeDir = getHomeDir();
		const relativeHomeDirPrefix = "~/";
		let resolvedFilepath = filepath;
		if (filepath.startsWith(relativeHomeDirPrefix)) resolvedFilepath = join(homeDir, filepath.slice(2));
		let resolvedConfigFilepath = configFilepath;
		if (configFilepath.startsWith(relativeHomeDirPrefix)) resolvedConfigFilepath = join(homeDir, configFilepath.slice(2));
		const parsedFiles = await Promise.all([readFile$1(resolvedConfigFilepath, { ignoreCache: init.ignoreCache }).then(parseIni).then(getConfigData).catch(swallowError$1), readFile$1(resolvedFilepath, { ignoreCache: init.ignoreCache }).then(parseIni).catch(swallowError$1)]);
		return {
			configFile: parsedFiles[0],
			credentialsFile: parsedFiles[1]
		};
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/getSsoSessionData.js
var import_dist_cjs$4, getSsoSessionData;
var init_getSsoSessionData = __esmMin((() => {
	import_dist_cjs$4 = require_dist_cjs();
	init_loadSharedConfigFiles();
	getSsoSessionData = (data) => Object.entries(data).filter(([key]) => key.startsWith(import_dist_cjs$4.IniSectionType.SSO_SESSION + ".")).reduce((acc, [key, value]) => ({
		...acc,
		[key.substring(key.indexOf(".") + 1)]: value
	}), {});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/loadSsoSessionData.js
var swallowError, loadSsoSessionData;
var init_loadSsoSessionData = __esmMin((() => {
	init_getConfigFilepath();
	init_getSsoSessionData();
	init_parseIni();
	init_readFile();
	swallowError = () => ({});
	loadSsoSessionData = async (init = {}) => readFile$1(init.configFilepath ?? getConfigFilepath()).then(parseIni).then(getSsoSessionData).catch(swallowError);
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/mergeConfigFiles.js
var mergeConfigFiles;
var init_mergeConfigFiles = __esmMin((() => {
	mergeConfigFiles = (...files) => {
		const merged = {};
		for (const file of files) for (const [key, values] of Object.entries(file)) if (merged[key] !== void 0) Object.assign(merged[key], values);
		else merged[key] = values;
		return merged;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/parseKnownFiles.js
var parseKnownFiles;
var init_parseKnownFiles = __esmMin((() => {
	init_loadSharedConfigFiles();
	init_mergeConfigFiles();
	parseKnownFiles = async (init) => {
		const parsedFiles = await loadSharedConfigFiles(init);
		return mergeConfigFiles(parsedFiles.configFile, parsedFiles.credentialsFile);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/shared-ini-file-loader/externalDataInterceptor.js
var externalDataInterceptor;
var init_externalDataInterceptor = __esmMin((() => {
	init_getSSOTokenFromFile();
	init_readFile();
	externalDataInterceptor = {
		getFileRecord() {
			return fileIntercept;
		},
		interceptFile(path, contents) {
			fileIntercept[path] = Promise.resolve(contents);
		},
		getTokenRecord() {
			return tokenIntercept;
		},
		interceptToken(id, contents) {
			tokenIntercept[id] = contents;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/node-config-provider/getSelectorName.js
function getSelectorName(functionString) {
	try {
		const constants = new Set(Array.from(functionString.match(/([A-Z_]){3,}/g) ?? []));
		constants.delete("CONFIG");
		constants.delete("CONFIG_PREFIX_SEPARATOR");
		constants.delete("ENV");
		return [...constants].join(", ");
	} catch (e) {
		return functionString;
	}
}
var init_getSelectorName = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/node-config-provider/fromEnv.js
var fromEnv;
var init_fromEnv = __esmMin((() => {
	init_CredentialsProviderError();
	init_getSelectorName();
	fromEnv = (envVarSelector, options) => async () => {
		try {
			const config = envVarSelector(process.env, options);
			if (config === void 0) throw new Error();
			return config;
		} catch (e) {
			throw new CredentialsProviderError(e.message || `Not found in ENV: ${getSelectorName(envVarSelector.toString())}`, { logger: options?.logger });
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/node-config-provider/fromSharedConfigFiles.js
var fromSharedConfigFiles;
var init_fromSharedConfigFiles = __esmMin((() => {
	init_CredentialsProviderError();
	init_getProfileName();
	init_loadSharedConfigFiles();
	init_getSelectorName();
	fromSharedConfigFiles = (configSelector, { preferredFile = "config", ...init } = {}) => async () => {
		const profile = getProfileName(init);
		const { configFile, credentialsFile } = await loadSharedConfigFiles(init);
		const profileFromCredentials = credentialsFile[profile] || {};
		const profileFromConfig = configFile[profile] || {};
		const mergedProfile = preferredFile === "config" ? {
			...profileFromCredentials,
			...profileFromConfig
		} : {
			...profileFromConfig,
			...profileFromCredentials
		};
		try {
			const configValue = configSelector(mergedProfile, preferredFile === "config" ? configFile : credentialsFile);
			if (configValue === void 0) throw new Error();
			return configValue;
		} catch (e) {
			throw new CredentialsProviderError(e.message || `Not found in config files w/ profile [${profile}]: ${getSelectorName(configSelector.toString())}`, { logger: init.logger });
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/node-config-provider/fromStatic.js
var isFunction, fromStatic;
var init_fromStatic = __esmMin((() => {
	init_fromValue();
	isFunction = (func) => typeof func === "function";
	fromStatic = (defaultValue) => isFunction(defaultValue) ? async () => await defaultValue() : fromValue(defaultValue);
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/node-config-provider/configLoader.js
var loadConfig;
var init_configLoader = __esmMin((() => {
	init_chain();
	init_memoize();
	init_fromEnv();
	init_fromSharedConfigFiles();
	init_fromStatic();
	loadConfig = ({ environmentVariableSelector, configFileSelector, default: defaultValue }, configuration = {}) => {
		const { signingName, logger } = configuration;
		return memoize(chain(fromEnv(environmentVariableSelector, {
			signingName,
			logger
		}), fromSharedConfigFiles(configFileSelector, configuration), fromStatic(defaultValue)));
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/endpointsConfig/NodeUseDualstackEndpointConfigOptions.js
var ENV_USE_DUALSTACK_ENDPOINT, CONFIG_USE_DUALSTACK_ENDPOINT, NODE_USE_DUALSTACK_ENDPOINT_CONFIG_OPTIONS, nodeDualstackConfigSelectors;
var init_NodeUseDualstackEndpointConfigOptions = __esmMin((() => {
	init_booleanSelector();
	init_types$1();
	ENV_USE_DUALSTACK_ENDPOINT = "AWS_USE_DUALSTACK_ENDPOINT";
	CONFIG_USE_DUALSTACK_ENDPOINT = "use_dualstack_endpoint";
	NODE_USE_DUALSTACK_ENDPOINT_CONFIG_OPTIONS = {
		environmentVariableSelector: (env) => booleanSelector(env, ENV_USE_DUALSTACK_ENDPOINT, SelectorType.ENV),
		configFileSelector: (profile) => booleanSelector(profile, CONFIG_USE_DUALSTACK_ENDPOINT, SelectorType.CONFIG),
		default: false
	};
	nodeDualstackConfigSelectors = {
		environmentVariableSelector: (env) => booleanSelector(env, ENV_USE_DUALSTACK_ENDPOINT, SelectorType.ENV),
		configFileSelector: (profile) => booleanSelector(profile, CONFIG_USE_DUALSTACK_ENDPOINT, SelectorType.CONFIG),
		default: void 0
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/endpointsConfig/NodeUseFipsEndpointConfigOptions.js
var ENV_USE_FIPS_ENDPOINT, CONFIG_USE_FIPS_ENDPOINT, NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS, nodeFipsConfigSelectors;
var init_NodeUseFipsEndpointConfigOptions = __esmMin((() => {
	init_booleanSelector();
	init_types$1();
	ENV_USE_FIPS_ENDPOINT = "AWS_USE_FIPS_ENDPOINT";
	CONFIG_USE_FIPS_ENDPOINT = "use_fips_endpoint";
	NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS = {
		environmentVariableSelector: (env) => booleanSelector(env, ENV_USE_FIPS_ENDPOINT, SelectorType.ENV),
		configFileSelector: (profile) => booleanSelector(profile, CONFIG_USE_FIPS_ENDPOINT, SelectorType.CONFIG),
		default: false
	};
	nodeFipsConfigSelectors = {
		environmentVariableSelector: (env) => booleanSelector(env, ENV_USE_FIPS_ENDPOINT, SelectorType.ENV),
		configFileSelector: (profile) => booleanSelector(profile, CONFIG_USE_FIPS_ENDPOINT, SelectorType.CONFIG),
		default: void 0
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/endpointsConfig/resolveCustomEndpointsConfig.js
var resolveCustomEndpointsConfig;
var init_resolveCustomEndpointsConfig = __esmMin((() => {
	init_client();
	resolveCustomEndpointsConfig = (input) => {
		const { tls, endpoint, urlParser, useDualstackEndpoint } = input;
		return Object.assign(input, {
			tls: tls ?? true,
			endpoint: normalizeProvider(typeof endpoint === "string" ? urlParser(endpoint) : endpoint),
			isCustomEndpoint: true,
			useDualstackEndpoint: normalizeProvider(useDualstackEndpoint ?? false)
		});
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/endpointsConfig/utils/getEndpointFromRegion.js
var getEndpointFromRegion;
var init_getEndpointFromRegion = __esmMin((() => {
	getEndpointFromRegion = async (input) => {
		const { tls = true } = input;
		const region = await input.region();
		if (!(/* @__PURE__ */ new RegExp(/^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])$/)).test(region)) throw new Error("Invalid region in client config");
		const useDualstackEndpoint = await input.useDualstackEndpoint();
		const useFipsEndpoint = await input.useFipsEndpoint();
		const { hostname } = await input.regionInfoProvider(region, {
			useDualstackEndpoint,
			useFipsEndpoint
		}) ?? {};
		if (!hostname) throw new Error("Cannot resolve hostname from client config");
		return input.urlParser(`${tls ? "https:" : "http:"}//${hostname}`);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/endpointsConfig/resolveEndpointsConfig.js
var resolveEndpointsConfig;
var init_resolveEndpointsConfig = __esmMin((() => {
	init_client();
	init_getEndpointFromRegion();
	resolveEndpointsConfig = (input) => {
		const useDualstackEndpoint = normalizeProvider(input.useDualstackEndpoint ?? false);
		const { endpoint, useFipsEndpoint, urlParser, tls } = input;
		return Object.assign(input, {
			tls: tls ?? true,
			endpoint: endpoint ? normalizeProvider(typeof endpoint === "string" ? urlParser(endpoint) : endpoint) : () => getEndpointFromRegion({
				...input,
				useDualstackEndpoint,
				useFipsEndpoint
			}),
			isCustomEndpoint: !!endpoint,
			useDualstackEndpoint
		});
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/regionConfig/config.js
var REGION_ENV_NAME, REGION_INI_NAME, NODE_REGION_CONFIG_OPTIONS, NODE_REGION_CONFIG_FILE_OPTIONS;
var init_config$1 = __esmMin((() => {
	REGION_ENV_NAME = "AWS_REGION";
	REGION_INI_NAME = "region";
	NODE_REGION_CONFIG_OPTIONS = {
		environmentVariableSelector: (env) => env[REGION_ENV_NAME],
		configFileSelector: (profile) => profile[REGION_INI_NAME],
		default: () => {
			throw new Error("Region is missing");
		}
	};
	NODE_REGION_CONFIG_FILE_OPTIONS = { preferredFile: "credentials" };
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/regionConfig/checkRegion.js
var validRegions, checkRegion;
var init_checkRegion = __esmMin((() => {
	init_endpoints();
	validRegions = /* @__PURE__ */ new Set();
	checkRegion = (region, check = isValidHostLabel) => {
		if (!validRegions.has(region) && !check(region)) if (region === "*") console.warn(`@smithy/config-resolver WARN - Please use the caller region instead of "*". See "sigv4a" in https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/CLIENTS.md.`);
		else throw new Error(`Region not accepted: region="${region}" is not a valid hostname component.`);
		else validRegions.add(region);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/regionConfig/isFipsRegion.js
var isFipsRegion;
var init_isFipsRegion = __esmMin((() => {
	isFipsRegion = (region) => typeof region === "string" && (region.startsWith("fips-") || region.endsWith("-fips"));
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/regionConfig/getRealRegion.js
var getRealRegion;
var init_getRealRegion = __esmMin((() => {
	init_isFipsRegion();
	getRealRegion = (region) => isFipsRegion(region) ? ["fips-aws-global", "aws-fips"].includes(region) ? "us-east-1" : region.replace(/fips-(dkr-|prod-)?|-fips/, "") : region;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/regionConfig/resolveRegionConfig.js
var resolveRegionConfig;
var init_resolveRegionConfig = __esmMin((() => {
	init_checkRegion();
	init_getRealRegion();
	init_isFipsRegion();
	resolveRegionConfig = (input) => {
		const { region, useFipsEndpoint } = input;
		if (!region) throw new Error("Region is missing");
		return Object.assign(input, {
			region: async () => {
				const realRegion = getRealRegion(typeof region === "function" ? await region() : region);
				checkRegion(realRegion);
				return realRegion;
			},
			useFipsEndpoint: async () => {
				if (isFipsRegion(typeof region === "string" ? region : await region())) return true;
				return typeof useFipsEndpoint !== "function" ? Promise.resolve(!!useFipsEndpoint) : useFipsEndpoint();
			}
		});
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/regionInfo/getHostnameFromVariants.js
var getHostnameFromVariants;
var init_getHostnameFromVariants = __esmMin((() => {
	getHostnameFromVariants = (variants = [], { useFipsEndpoint, useDualstackEndpoint }) => variants.find(({ tags }) => useFipsEndpoint === tags.includes("fips") && useDualstackEndpoint === tags.includes("dualstack"))?.hostname;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/regionInfo/getResolvedHostname.js
var getResolvedHostname;
var init_getResolvedHostname = __esmMin((() => {
	getResolvedHostname = (resolvedRegion, { regionHostname, partitionHostname }) => regionHostname ? regionHostname : partitionHostname ? partitionHostname.replace("{region}", resolvedRegion) : void 0;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/regionInfo/getResolvedPartition.js
var getResolvedPartition;
var init_getResolvedPartition = __esmMin((() => {
	getResolvedPartition = (region, { partitionHash }) => Object.keys(partitionHash || {}).find((key) => partitionHash[key].regions.includes(region)) ?? "aws";
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/regionInfo/getResolvedSigningRegion.js
var getResolvedSigningRegion;
var init_getResolvedSigningRegion = __esmMin((() => {
	getResolvedSigningRegion = (hostname, { signingRegion, regionRegex, useFipsEndpoint }) => {
		if (signingRegion) return signingRegion;
		else if (useFipsEndpoint) {
			const regionRegexJs = regionRegex.replace("\\\\", "\\").replace(/^\^/g, "\\.").replace(/\$$/g, "\\.");
			const regionRegexmatchArray = hostname.match(regionRegexJs);
			if (regionRegexmatchArray) return regionRegexmatchArray[0].slice(1, -1);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/config-resolver/regionInfo/getRegionInfo.js
var getRegionInfo;
var init_getRegionInfo = __esmMin((() => {
	init_getHostnameFromVariants();
	init_getResolvedHostname();
	init_getResolvedPartition();
	init_getResolvedSigningRegion();
	getRegionInfo = (region, { useFipsEndpoint = false, useDualstackEndpoint = false, signingService, regionHash, partitionHash }) => {
		const partition = getResolvedPartition(region, { partitionHash });
		const resolvedRegion = region in regionHash ? region : partitionHash[partition]?.endpoint ?? region;
		const hostnameOptions = {
			useFipsEndpoint,
			useDualstackEndpoint
		};
		const hostname = getResolvedHostname(resolvedRegion, {
			regionHostname: getHostnameFromVariants(regionHash[resolvedRegion]?.variants, hostnameOptions),
			partitionHostname: getHostnameFromVariants(partitionHash[partition]?.variants, hostnameOptions)
		});
		if (hostname === void 0) throw new Error(`Endpoint resolution failed for: [object Object]`);
		const signingRegion = getResolvedSigningRegion(hostname, {
			signingRegion: regionHash[resolvedRegion]?.signingRegion,
			regionRegex: partitionHash[partition].regionRegex,
			useFipsEndpoint
		});
		return {
			partition,
			signingService,
			hostname,
			...signingRegion && { signingRegion },
			...regionHash[resolvedRegion]?.signingService && { signingService: regionHash[resolvedRegion].signingService }
		};
	};
})), DEFAULTS_MODE_OPTIONS, IMDS_REGION_PATH;
var init_constants$1 = __esmMin((() => {
	DEFAULTS_MODE_OPTIONS = [
		"in-region",
		"cross-region",
		"mobile",
		"standard",
		"legacy"
	];
	IMDS_REGION_PATH = "/latest/meta-data/placement/region";
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/defaults-mode/defaultsModeConfig.js
var AWS_DEFAULTS_MODE_ENV, AWS_DEFAULTS_MODE_CONFIG, NODE_DEFAULTS_MODE_CONFIG_OPTIONS;
var init_defaultsModeConfig = __esmMin((() => {
	AWS_DEFAULTS_MODE_ENV = "AWS_DEFAULTS_MODE";
	AWS_DEFAULTS_MODE_CONFIG = "defaults_mode";
	NODE_DEFAULTS_MODE_CONFIG_OPTIONS = {
		environmentVariableSelector: (env) => {
			return env[AWS_DEFAULTS_MODE_ENV];
		},
		configFileSelector: (profile) => {
			return profile[AWS_DEFAULTS_MODE_CONFIG];
		},
		default: "legacy"
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/defaults-mode/resolveDefaultsModeConfig.js
var resolveDefaultsModeConfig, resolveNodeDefaultsModeAuto, inferPhysicalRegion, getImdsEndpoint, imdsHttpGet;
var init_resolveDefaultsModeConfig = __esmMin((() => {
	init_config$1();
	init_configLoader();
	init_memoize();
	init_constants$1();
	init_defaultsModeConfig();
	resolveDefaultsModeConfig = ({ region = loadConfig(NODE_REGION_CONFIG_OPTIONS), defaultsMode = loadConfig(NODE_DEFAULTS_MODE_CONFIG_OPTIONS) } = {}) => memoize(async () => {
		const mode = typeof defaultsMode === "function" ? await defaultsMode() : defaultsMode;
		switch (mode?.toLowerCase()) {
			case "auto": return resolveNodeDefaultsModeAuto(region);
			case "in-region":
			case "cross-region":
			case "mobile":
			case "standard":
			case "legacy": return Promise.resolve(mode?.toLocaleLowerCase());
			case void 0: return Promise.resolve("legacy");
			default: throw new Error(`Invalid parameter for "defaultsMode", expect ${DEFAULTS_MODE_OPTIONS.join(", ")}, got ${mode}`);
		}
	});
	resolveNodeDefaultsModeAuto = async (clientRegion) => {
		if (clientRegion) {
			const resolvedRegion = typeof clientRegion === "function" ? await clientRegion() : clientRegion;
			const inferredRegion = await inferPhysicalRegion();
			if (!inferredRegion) return "standard";
			if (resolvedRegion === inferredRegion) return "in-region";
			else return "cross-region";
		}
		return "standard";
	};
	inferPhysicalRegion = async () => {
		if (process.env["AWS_EXECUTION_ENV"] && (process.env["AWS_REGION"] || process.env["AWS_DEFAULT_REGION"])) return process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"];
		if (!process.env["AWS_EC2_METADATA_DISABLED"]) try {
			return (await imdsHttpGet({
				hostname: (await getImdsEndpoint()).hostname,
				path: IMDS_REGION_PATH
			})).toString();
		} catch (e) {}
	};
	getImdsEndpoint = async () => {
		const envEndpoint = process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT;
		if (envEndpoint) {
			const url = new URL(envEndpoint);
			return {
				hostname: url.hostname,
				path: url.pathname
			};
		}
		if (process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE === "IPv6") return {
			hostname: "fd00:ec2::254",
			path: "/"
		};
		return {
			hostname: "169.254.169.254",
			path: "/"
		};
	};
	imdsHttpGet = async ({ hostname, path }) => {
		const { request } = await import("node:http");
		return new Promise((resolve, reject) => {
			const req = request({
				method: "GET",
				hostname: hostname.replace(/^\[(.+)]$/, "$1"),
				path,
				timeout: 1e3,
				signal: AbortSignal.timeout(1e3)
			});
			req.on("error", (err) => {
				reject(err);
				req.destroy();
			});
			req.on("timeout", () => {
				reject(/* @__PURE__ */ new Error("TimeoutError from instance metadata service"));
				req.destroy();
			});
			req.on("response", (res) => {
				const { statusCode = 400 } = res;
				if (statusCode < 200 || 300 <= statusCode) {
					reject(Object.assign(/* @__PURE__ */ new Error("Error response received from instance metadata service"), { statusCode }));
					req.destroy();
					return;
				}
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					resolve(Buffer.concat(chunks));
					req.destroy();
				});
			});
			req.end();
		});
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/config/index.js
var config_exports = /* @__PURE__ */ __exportAll({
	CONFIG_PREFIX_SEPARATOR: () => ".",
	CONFIG_USE_DUALSTACK_ENDPOINT: () => CONFIG_USE_DUALSTACK_ENDPOINT,
	CONFIG_USE_FIPS_ENDPOINT: () => CONFIG_USE_FIPS_ENDPOINT,
	CredentialsProviderError: () => CredentialsProviderError,
	DEFAULT_PROFILE: () => DEFAULT_PROFILE,
	DEFAULT_USE_DUALSTACK_ENDPOINT: () => false,
	DEFAULT_USE_FIPS_ENDPOINT: () => false,
	ENV_PROFILE: () => ENV_PROFILE,
	ENV_USE_DUALSTACK_ENDPOINT: () => ENV_USE_DUALSTACK_ENDPOINT,
	ENV_USE_FIPS_ENDPOINT: () => ENV_USE_FIPS_ENDPOINT,
	NODE_REGION_CONFIG_FILE_OPTIONS: () => NODE_REGION_CONFIG_FILE_OPTIONS,
	NODE_REGION_CONFIG_OPTIONS: () => NODE_REGION_CONFIG_OPTIONS,
	NODE_USE_DUALSTACK_ENDPOINT_CONFIG_OPTIONS: () => NODE_USE_DUALSTACK_ENDPOINT_CONFIG_OPTIONS,
	NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS: () => NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS,
	ProviderError: () => ProviderError,
	REGION_ENV_NAME: () => REGION_ENV_NAME,
	REGION_INI_NAME: () => REGION_INI_NAME,
	SelectorType: () => SelectorType,
	TokenProviderError: () => TokenProviderError,
	booleanSelector: () => booleanSelector,
	chain: () => chain,
	externalDataInterceptor: () => externalDataInterceptor,
	fromStatic: () => fromStatic,
	fromValue: () => fromValue,
	getHomeDir: () => getHomeDir,
	getProfileName: () => getProfileName,
	getRegionInfo: () => getRegionInfo,
	getSSOTokenFilepath: () => getSSOTokenFilepath,
	getSSOTokenFromFile: () => getSSOTokenFromFile,
	loadConfig: () => loadConfig,
	loadSharedConfigFiles: () => loadSharedConfigFiles,
	loadSsoSessionData: () => loadSsoSessionData,
	memoize: () => memoize,
	nodeDualstackConfigSelectors: () => nodeDualstackConfigSelectors,
	nodeFipsConfigSelectors: () => nodeFipsConfigSelectors,
	numberSelector: () => numberSelector,
	parseKnownFiles: () => parseKnownFiles,
	readFile: () => readFile$1,
	resolveCustomEndpointsConfig: () => resolveCustomEndpointsConfig,
	resolveDefaultsModeConfig: () => resolveDefaultsModeConfig,
	resolveEndpointsConfig: () => resolveEndpointsConfig,
	resolveRegionConfig: () => resolveRegionConfig
});
var init_config = __esmMin((() => {
	init_ProviderError();
	init_CredentialsProviderError();
	init_TokenProviderError();
	init_chain();
	init_fromValue();
	init_memoize();
	init_booleanSelector();
	init_numberSelector();
	init_types$1();
	init_getHomeDir();
	init_getProfileName();
	init_getSSOTokenFilepath();
	init_getSSOTokenFromFile();
	init_constants$2();
	init_loadSharedConfigFiles();
	init_loadSsoSessionData();
	init_parseKnownFiles();
	init_externalDataInterceptor();
	init_readFile();
	init_configLoader();
	init_fromStatic();
	init_NodeUseDualstackEndpointConfigOptions();
	init_NodeUseFipsEndpointConfigOptions();
	init_resolveCustomEndpointsConfig();
	init_resolveEndpointsConfig();
	init_config$1();
	init_resolveRegionConfig();
	init_getRegionInfo();
	init_resolveDefaultsModeConfig();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/adaptors/getEndpointUrlConfig.js
var ENV_ENDPOINT_URL, CONFIG_ENDPOINT_URL, getEndpointUrlConfig;
var init_getEndpointUrlConfig = __esmMin((() => {
	init_config();
	ENV_ENDPOINT_URL = "AWS_ENDPOINT_URL";
	CONFIG_ENDPOINT_URL = "endpoint_url";
	getEndpointUrlConfig = (serviceId) => ({
		environmentVariableSelector: (env) => {
			const serviceEndpointUrl = env[[ENV_ENDPOINT_URL, ...serviceId.split(" ").map((w) => w.toUpperCase())].join("_")];
			if (serviceEndpointUrl) return serviceEndpointUrl;
			const endpointUrl = env[ENV_ENDPOINT_URL];
			if (endpointUrl) return endpointUrl;
		},
		configFileSelector: (profile, config) => {
			if (config && profile.services) {
				const servicesSection = config[["services", profile.services].join(".")];
				if (servicesSection) {
					const endpointUrl = servicesSection[[serviceId.split(" ").map((w) => w.toLowerCase()).join("_"), CONFIG_ENDPOINT_URL].join(".")];
					if (endpointUrl) return endpointUrl;
				}
			}
			const endpointUrl = profile[CONFIG_ENDPOINT_URL];
			if (endpointUrl) return endpointUrl;
		},
		default: void 0
	});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/adaptors/getEndpointFromConfig.js
var getEndpointFromConfig;
var init_getEndpointFromConfig = __esmMin((() => {
	init_config();
	init_getEndpointUrlConfig();
	getEndpointFromConfig = async (serviceId) => loadConfig(getEndpointUrlConfig(serviceId ?? ""))();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/service-customizations/s3.js
var resolveParamsForS3, DOMAIN_PATTERN, IP_ADDRESS_PATTERN, DOTS_PATTERN, isDnsCompatibleBucketName, isArnBucketName;
var init_s3 = __esmMin((() => {
	resolveParamsForS3 = async (endpointParams) => {
		const bucket = endpointParams?.Bucket || "";
		if (typeof endpointParams.Bucket === "string") endpointParams.Bucket = bucket.replace(/#/g, encodeURIComponent("#")).replace(/\?/g, encodeURIComponent("?"));
		if (isArnBucketName(bucket)) {
			if (endpointParams.ForcePathStyle === true) throw new Error("Path-style addressing cannot be used with ARN buckets");
		} else if (!isDnsCompatibleBucketName(bucket) || bucket.indexOf(".") !== -1 && !String(endpointParams.Endpoint).startsWith("http:") || bucket.toLowerCase() !== bucket || bucket.length < 3) endpointParams.ForcePathStyle = true;
		if (endpointParams.DisableMultiRegionAccessPoints) {
			endpointParams.disableMultiRegionAccessPoints = true;
			endpointParams.DisableMRAP = true;
		}
		return endpointParams;
	};
	DOMAIN_PATTERN = /^[a-z0-9][a-z0-9\.\-]{1,61}[a-z0-9]$/;
	IP_ADDRESS_PATTERN = /(\d+\.){3}\d+/;
	DOTS_PATTERN = /\.\./;
	isDnsCompatibleBucketName = (bucketName) => DOMAIN_PATTERN.test(bucketName) && !IP_ADDRESS_PATTERN.test(bucketName) && !DOTS_PATTERN.test(bucketName);
	isArnBucketName = (bucketName) => {
		const [arn, partition, service, , , bucket] = bucketName.split(":");
		const isArn = arn === "arn" && bucketName.split(":").length >= 6;
		const isValidArn = Boolean(isArn && partition && service && bucket);
		if (isArn && !isValidArn) throw new Error(`Invalid ARN: ${bucketName} was an invalid ARN.`);
		return isValidArn;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/service-customizations/index.js
var init_service_customizations = __esmMin((() => {
	init_s3();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/adaptors/createConfigValueProvider.js
var createConfigValueProvider;
var init_createConfigValueProvider = __esmMin((() => {
	createConfigValueProvider = (configKey, canonicalEndpointParamKey, config, isClientContextParam = false) => {
		const configProvider = async () => {
			let configValue;
			if (isClientContextParam) configValue = config.clientContextParams?.[configKey] ?? config[configKey] ?? config[canonicalEndpointParamKey];
			else configValue = config[configKey] ?? config[canonicalEndpointParamKey];
			if (typeof configValue === "function") return configValue();
			return configValue;
		};
		if (configKey === "credentialScope" || canonicalEndpointParamKey === "CredentialScope") return async () => {
			const credentials = typeof config.credentials === "function" ? await config.credentials() : config.credentials;
			return credentials?.credentialScope ?? credentials?.CredentialScope;
		};
		if (configKey === "accountId" || canonicalEndpointParamKey === "AccountId") return async () => {
			const credentials = typeof config.credentials === "function" ? await config.credentials() : config.credentials;
			return credentials?.accountId ?? credentials?.AccountId;
		};
		if (configKey === "endpoint" || canonicalEndpointParamKey === "endpoint") return async () => {
			if (config.isCustomEndpoint === false) return;
			const endpoint = await configProvider();
			if (endpoint && typeof endpoint === "object") {
				if ("url" in endpoint) return endpoint.url.href;
				if ("hostname" in endpoint) {
					const { protocol, hostname, port, path } = endpoint;
					return `${protocol}//${hostname}${port ? ":" + port : ""}${path}`;
				}
			}
			return endpoint;
		};
		return configProvider;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/toEndpointV1.js
var toEndpointV1;
var init_toEndpointV1$1 = __esmMin((() => {
	init_protocols();
	toEndpointV1 = (endpoint) => {
		if (typeof endpoint === "object") {
			if ("url" in endpoint) {
				const v1Endpoint = parseUrl(endpoint.url);
				if (endpoint.headers) {
					v1Endpoint.headers = {};
					for (const name in endpoint.headers) v1Endpoint.headers[name.toLowerCase()] = endpoint.headers[name].join(", ");
				}
				return v1Endpoint;
			}
			return endpoint;
		}
		return parseUrl(endpoint);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/adaptors/toEndpointV1.js
var init_toEndpointV1 = __esmMin((() => {
	init_toEndpointV1$1();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/adaptors/getEndpointFromInstructions.js
function bindGetEndpointFromInstructions(getEndpointFromConfig) {
	return async (commandInput, instructionsSupplier, clientConfig, context) => {
		if (!clientConfig.isCustomEndpoint) {
			let endpointFromConfig;
			if (clientConfig.serviceConfiguredEndpoint) endpointFromConfig = await clientConfig.serviceConfiguredEndpoint();
			else endpointFromConfig = await getEndpointFromConfig(clientConfig.serviceId);
			if (endpointFromConfig) {
				clientConfig.endpoint = () => Promise.resolve(toEndpointV1(endpointFromConfig));
				clientConfig.isCustomEndpoint = true;
			}
		}
		const endpointParams = await resolveParams(commandInput, instructionsSupplier, clientConfig);
		if (typeof clientConfig.endpointProvider !== "function") throw new Error("config.endpointProvider is not set.");
		const endpoint = clientConfig.endpointProvider(endpointParams, context);
		if (clientConfig.isCustomEndpoint && clientConfig.endpoint) {
			const customEndpoint = await clientConfig.endpoint();
			if (customEndpoint?.headers) {
				endpoint.headers ??= {};
				for (const [name, value] of Object.entries(customEndpoint.headers)) endpoint.headers[name] = Array.isArray(value) ? value : [value];
			}
		}
		return endpoint;
	};
}
var resolveParams;
var init_getEndpointFromInstructions = __esmMin((() => {
	init_service_customizations();
	init_createConfigValueProvider();
	init_toEndpointV1();
	resolveParams = async (commandInput, instructionsSupplier, clientConfig) => {
		const endpointParams = {};
		const instructions = instructionsSupplier?.getEndpointParameterInstructions?.() || {};
		for (const [name, instruction] of Object.entries(instructions)) switch (instruction.type) {
			case "staticContextParams":
				endpointParams[name] = instruction.value;
				break;
			case "contextParams":
				endpointParams[name] = commandInput[instruction.name];
				break;
			case "clientContextParams":
			case "builtInParams":
				endpointParams[name] = await createConfigValueProvider(instruction.name, name, clientConfig, instruction.type !== "builtInParams")();
				break;
			case "operationContextParams":
				endpointParams[name] = instruction.get(commandInput);
				break;
			default: throw new Error("Unrecognized endpoint parameter instruction: " + JSON.stringify(instruction));
		}
		if (Object.keys(instructions).length === 0) Object.assign(endpointParams, clientConfig);
		if (String(clientConfig.serviceId).toLowerCase() === "s3") await resolveParamsForS3(endpointParams);
		return endpointParams;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/endpointMiddleware.js
function setFeature(context, feature, value) {
	if (!context.__smithy_context) context.__smithy_context = { features: {} };
	else if (!context.__smithy_context.features) context.__smithy_context.features = {};
	context.__smithy_context.features[feature] = value;
}
function bindEndpointMiddleware(getEndpointFromConfig) {
	const getEndpointFromInstructions = bindGetEndpointFromInstructions(getEndpointFromConfig);
	return ({ config, instructions }) => {
		return (next, context) => async (args) => {
			if (config.isCustomEndpoint) setFeature(context, "ENDPOINT_OVERRIDE", "N");
			const endpoint = await getEndpointFromInstructions(args.input, { getEndpointParameterInstructions() {
				return instructions;
			} }, { ...config }, context);
			context.endpointV2 = endpoint;
			context.authSchemes = endpoint.properties?.authSchemes;
			const authScheme = context.authSchemes?.[0];
			if (authScheme) {
				context["signing_region"] = authScheme.signingRegion;
				context["signing_service"] = authScheme.signingName;
				const httpAuthOption = getSmithyContext(context)?.selectedHttpAuthScheme?.httpAuthOption;
				if (httpAuthOption) httpAuthOption.signingProperties = Object.assign(httpAuthOption.signingProperties || {}, {
					signing_region: authScheme.signingRegion,
					signingRegion: authScheme.signingRegion,
					signing_service: authScheme.signingName,
					signingName: authScheme.signingName,
					signingRegionSet: authScheme.signingRegionSet
				}, authScheme.properties);
			}
			return next({ ...args });
		};
	};
}
var init_endpointMiddleware = __esmMin((() => {
	init_client();
	init_getEndpointFromInstructions();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/getEndpointPlugin.js
function bindGetEndpointPlugin(getEndpointFromConfig) {
	const endpointMiddleware = bindEndpointMiddleware(getEndpointFromConfig);
	return (config, instructions) => ({ applyToStack: (clientStack) => {
		clientStack.addRelativeTo(endpointMiddleware({
			config,
			instructions
		}), endpointMiddlewareOptions);
	} });
}
var serializerMiddlewareOption$2, endpointMiddlewareOptions;
var init_getEndpointPlugin = __esmMin((() => {
	init_endpointMiddleware();
	serializerMiddlewareOption$2 = {
		name: "serializerMiddleware",
		step: "serialize",
		tags: ["SERIALIZER"],
		override: true
	};
	endpointMiddlewareOptions = {
		step: "serialize",
		tags: [
			"ENDPOINT_PARAMETERS",
			"ENDPOINT_V2",
			"ENDPOINT"
		],
		name: "endpointV2Middleware",
		override: true,
		relation: "before",
		toMiddleware: serializerMiddlewareOption$2.name
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/resolveEndpointConfig.js
function bindResolveEndpointConfig(getEndpointFromConfig) {
	return (input) => {
		const tls = input.tls ?? true;
		const { endpoint, useDualstackEndpoint, useFipsEndpoint } = input;
		const resolvedConfig = Object.assign(input, {
			endpoint: endpoint != null ? async () => toEndpointV1(await normalizeProvider(endpoint)()) : void 0,
			tls,
			isCustomEndpoint: !!endpoint,
			useDualstackEndpoint: normalizeProvider(useDualstackEndpoint ?? false),
			useFipsEndpoint: normalizeProvider(useFipsEndpoint ?? false)
		});
		let configuredEndpointPromise = void 0;
		resolvedConfig.serviceConfiguredEndpoint = async () => {
			if (input.serviceId && !configuredEndpointPromise) configuredEndpointPromise = getEndpointFromConfig(input.serviceId);
			return configuredEndpointPromise;
		};
		return resolvedConfig;
	};
}
var init_resolveEndpointConfig = __esmMin((() => {
	init_client();
	init_toEndpointV1();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/bdd/BinaryDecisionDiagram.js
var BinaryDecisionDiagram;
var init_BinaryDecisionDiagram = __esmMin((() => {
	BinaryDecisionDiagram = class BinaryDecisionDiagram {
		nodes;
		root;
		conditions;
		results;
		constructor(bdd, root, conditions, results) {
			this.nodes = bdd;
			this.root = root;
			this.conditions = conditions;
			this.results = results;
		}
		static from(bdd, root, conditions, results) {
			return new BinaryDecisionDiagram(bdd, root, conditions, results);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/cache/EndpointCache.js
var EndpointCache;
var init_EndpointCache = __esmMin((() => {
	EndpointCache = class {
		capacity;
		data = /* @__PURE__ */ new Map();
		parameters = [];
		constructor({ size, params }) {
			this.capacity = size ?? 50;
			if (params) this.parameters = params;
		}
		get(endpointParams, resolver) {
			const key = this.hash(endpointParams);
			if (key === false) return resolver();
			if (!this.data.has(key)) {
				if (this.data.size > this.capacity + 10) {
					const keys = this.data.keys();
					let i = 0;
					while (true) {
						const { value, done } = keys.next();
						this.data.delete(value);
						if (done || ++i > 10) break;
					}
				}
				this.data.set(key, resolver());
			}
			return this.data.get(key);
		}
		size() {
			return this.data.size;
		}
		hash(endpointParams) {
			let buffer = "";
			const { parameters } = this;
			if (parameters.length === 0) return false;
			for (const param of parameters) {
				const val = String(endpointParams[param] ?? "");
				if (val.includes("|;")) return false;
				buffer += val + "|;";
			}
			return buffer;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/types/EndpointError.js
var EndpointError;
var init_EndpointError = __esmMin((() => {
	EndpointError = class extends Error {
		constructor(message) {
			super(message);
			this.name = "EndpointError";
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/types/EndpointFunctions.js
var init_EndpointFunctions = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/types/EndpointRuleObject.js
var init_EndpointRuleObject = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/types/ErrorRuleObject.js
var init_ErrorRuleObject = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/types/RuleSetObject.js
var init_RuleSetObject = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/types/TreeRuleObject.js
var init_TreeRuleObject = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/types/shared.js
var init_shared = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/types/index.js
var init_types = __esmMin((() => {
	init_EndpointError();
	init_EndpointFunctions();
	init_EndpointRuleObject();
	init_ErrorRuleObject();
	init_RuleSetObject();
	init_TreeRuleObject();
	init_shared();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/debug/debugId.js
var debugId;
var init_debugId = __esmMin((() => {
	debugId = "endpoints";
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/debug/toDebugString.js
function toDebugString(input) {
	if (typeof input !== "object" || input == null) return input;
	if ("ref" in input) return `$${toDebugString(input.ref)}`;
	if ("fn" in input) return `${input.fn}(${(input.argv || []).map(toDebugString).join(", ")})`;
	return JSON.stringify(input, null, 2);
}
var init_toDebugString = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/debug/index.js
var init_debug = __esmMin((() => {
	init_debugId();
	init_toDebugString();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/customEndpointFunctions.js
var customEndpointFunctions;
var init_customEndpointFunctions = __esmMin((() => {
	customEndpointFunctions = {};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/booleanEquals.js
var booleanEquals;
var init_booleanEquals = __esmMin((() => {
	booleanEquals = (value1, value2) => value1 === value2;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/coalesce.js
function coalesce(...args) {
	for (const arg of args) if (arg != null) return arg;
}
var init_coalesce = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/getAttrPathList.js
var getAttrPathList;
var init_getAttrPathList = __esmMin((() => {
	init_types();
	getAttrPathList = (path) => {
		const parts = path.split(".");
		const pathList = [];
		for (const part of parts) {
			const squareBracketIndex = part.indexOf("[");
			if (squareBracketIndex !== -1) {
				if (part.indexOf("]") !== part.length - 1) throw new EndpointError(`Path: '${path}' does not end with ']'`);
				const arrayIndex = part.slice(squareBracketIndex + 1, -1);
				if (Number.isNaN(parseInt(arrayIndex))) throw new EndpointError(`Invalid array index: '${arrayIndex}' in path: '${path}'`);
				if (squareBracketIndex !== 0) pathList.push(part.slice(0, squareBracketIndex));
				pathList.push(arrayIndex);
			} else pathList.push(part);
		}
		return pathList;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/getAttr.js
var getAttr;
var init_getAttr = __esmMin((() => {
	init_types();
	init_getAttrPathList();
	getAttr = (value, path) => getAttrPathList(path).reduce((acc, index) => {
		if (typeof acc !== "object") throw new EndpointError(`Index '${index}' in '${path}' not found in '${JSON.stringify(value)}'`);
		else if (Array.isArray(acc)) {
			const i = parseInt(index);
			return acc[i < 0 ? acc.length + i : i];
		}
		return acc[index];
	}, value);
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/isSet.js
var isSet;
var init_isSet = __esmMin((() => {
	isSet = (value) => value != null;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/isValidHostLabel.js
var VALID_HOST_LABEL_REGEX, isValidHostLabel;
var init_isValidHostLabel = __esmMin((() => {
	VALID_HOST_LABEL_REGEX = new RegExp(`^(?!.*-$)(?!-)[a-zA-Z0-9-]{1,63}$`);
	isValidHostLabel = (value, allowSubDomains = false) => {
		if (!allowSubDomains) return VALID_HOST_LABEL_REGEX.test(value);
		const labels = value.split(".");
		for (const label of labels) if (!isValidHostLabel(label)) return false;
		return true;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/ite.js
function ite(condition, trueValue, falseValue) {
	return condition ? trueValue : falseValue;
}
var init_ite = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/not.js
var not;
var init_not = __esmMin((() => {
	not = (value) => !value;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/isIpAddress.js
var IP_V4_REGEX, isIpAddress;
var init_isIpAddress = __esmMin((() => {
	IP_V4_REGEX = new RegExp(`^(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}$`);
	isIpAddress = (value) => IP_V4_REGEX.test(value) || value.startsWith("[") && value.endsWith("]");
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/parseURL.js
var import_dist_cjs$3, DEFAULT_PORTS, parseURL;
var init_parseURL = __esmMin((() => {
	import_dist_cjs$3 = require_dist_cjs();
	init_isIpAddress();
	DEFAULT_PORTS = {
		[import_dist_cjs$3.EndpointURLScheme.HTTP]: 80,
		[import_dist_cjs$3.EndpointURLScheme.HTTPS]: 443
	};
	parseURL = (value) => {
		const whatwgURL = (() => {
			try {
				if (value instanceof URL) return value;
				if (typeof value === "object" && "hostname" in value) {
					const { hostname, port, protocol = "", path = "", query = {} } = value;
					const url = new URL(`${protocol}//${hostname}${port ? `:${port}` : ""}${path}`);
					url.search = Object.entries(query).map(([k, v]) => `${k}=${v}`).join("&");
					return url;
				}
				return new URL(value);
			} catch (error) {
				return null;
			}
		})();
		if (!whatwgURL) {
			console.error(`Unable to parse ${JSON.stringify(value)} as a whatwg URL.`);
			return null;
		}
		const urlString = whatwgURL.href;
		const { host, hostname, pathname, protocol, search } = whatwgURL;
		if (search) return null;
		const scheme = protocol.slice(0, -1);
		if (!Object.values(import_dist_cjs$3.EndpointURLScheme).includes(scheme)) return null;
		const isIp = isIpAddress(hostname);
		return {
			scheme,
			authority: `${host}${urlString.includes(`${host}:${DEFAULT_PORTS[scheme]}`) || typeof value === "string" && value.includes(`${host}:${DEFAULT_PORTS[scheme]}`) ? `:${DEFAULT_PORTS[scheme]}` : ``}`,
			path: pathname,
			normalizedPath: pathname.endsWith("/") ? pathname : `${pathname}/`,
			isIp
		};
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/split.js
function split(value, delimiter, limit) {
	if (limit === 1) return [value];
	if (value === "") return [""];
	const parts = value.split(delimiter);
	if (limit === 0) return parts;
	return parts.slice(0, limit - 1).concat(parts.slice(1).join(delimiter));
}
var init_split = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/stringEquals.js
var stringEquals;
var init_stringEquals = __esmMin((() => {
	stringEquals = (value1, value2) => value1 === value2;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/substring.js
var substring;
var init_substring = __esmMin((() => {
	substring = (input, start, stop, reverse) => {
		if (input == null || start >= stop || input.length < stop || /[^\u0000-\u007f]/.test(input)) return null;
		if (!reverse) return input.substring(start, stop);
		return input.substring(input.length - stop, input.length - start);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/uriEncode.js
var uriEncode;
var init_uriEncode = __esmMin((() => {
	uriEncode = (value) => encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/lib/index.js
var init_lib = __esmMin((() => {
	init_booleanEquals();
	init_coalesce();
	init_getAttr();
	init_isSet();
	init_isValidHostLabel();
	init_ite();
	init_not();
	init_parseURL();
	init_split();
	init_stringEquals();
	init_substring();
	init_uriEncode();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/endpointFunctions.js
var endpointFunctions;
var init_endpointFunctions = __esmMin((() => {
	init_lib();
	endpointFunctions = {
		booleanEquals,
		coalesce,
		getAttr,
		isSet,
		isValidHostLabel,
		ite,
		not,
		parseURL,
		split,
		stringEquals,
		substring,
		uriEncode
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/evaluateTemplate.js
var evaluateTemplate;
var init_evaluateTemplate = __esmMin((() => {
	init_lib();
	evaluateTemplate = (template, options) => {
		const evaluatedTemplateArr = [];
		const { referenceRecord, endpointParams } = options;
		let currentIndex = 0;
		while (currentIndex < template.length) {
			const openingBraceIndex = template.indexOf("{", currentIndex);
			if (openingBraceIndex === -1) {
				evaluatedTemplateArr.push(template.slice(currentIndex));
				break;
			}
			evaluatedTemplateArr.push(template.slice(currentIndex, openingBraceIndex));
			const closingBraceIndex = template.indexOf("}", openingBraceIndex);
			if (closingBraceIndex === -1) {
				evaluatedTemplateArr.push(template.slice(openingBraceIndex));
				break;
			}
			if (template[openingBraceIndex + 1] === "{" && template[closingBraceIndex + 1] === "}") {
				evaluatedTemplateArr.push(template.slice(openingBraceIndex + 1, closingBraceIndex));
				currentIndex = closingBraceIndex + 2;
			}
			const parameterName = template.substring(openingBraceIndex + 1, closingBraceIndex);
			if (parameterName.includes("#")) {
				const [refName, attrName] = parameterName.split("#");
				evaluatedTemplateArr.push(getAttr(referenceRecord[refName] ?? endpointParams[refName], attrName));
			} else evaluatedTemplateArr.push(referenceRecord[parameterName] ?? endpointParams[parameterName]);
			currentIndex = closingBraceIndex + 1;
		}
		return evaluatedTemplateArr.join("");
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/getReferenceValue.js
var getReferenceValue;
var init_getReferenceValue = __esmMin((() => {
	getReferenceValue = ({ ref }, options) => {
		return options.referenceRecord[ref] ?? options.endpointParams[ref];
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/evaluateExpression.js
var evaluateExpression, callFunction, group$2;
var init_evaluateExpression = __esmMin((() => {
	init_types();
	init_customEndpointFunctions();
	init_endpointFunctions();
	init_evaluateTemplate();
	init_getReferenceValue();
	evaluateExpression = (obj, keyName, options) => {
		if (typeof obj === "string") return evaluateTemplate(obj, options);
		else if (obj["fn"]) return group$2.callFunction(obj, options);
		else if (obj["ref"]) return getReferenceValue(obj, options);
		throw new EndpointError(`'${keyName}': ${String(obj)} is not a string, function or reference.`);
	};
	callFunction = ({ fn, argv }, options) => {
		const evaluatedArgs = Array(argv.length);
		for (let i = 0; i < evaluatedArgs.length; ++i) {
			const arg = argv[i];
			if (typeof arg === "boolean" || typeof arg === "number") evaluatedArgs[i] = arg;
			else evaluatedArgs[i] = group$2.evaluateExpression(arg, "arg", options);
		}
		const namespaceSeparatorIndex = fn.indexOf(".");
		if (namespaceSeparatorIndex !== -1) {
			const customFunction = customEndpointFunctions[fn.slice(0, namespaceSeparatorIndex)]?.[fn.slice(namespaceSeparatorIndex + 1)];
			if (typeof customFunction === "function") return customFunction(...evaluatedArgs);
		}
		const callable = endpointFunctions[fn];
		if (typeof callable === "function") return callable(...evaluatedArgs);
		throw new Error(`function ${fn} not loaded in endpointFunctions.`);
	};
	group$2 = {
		evaluateExpression,
		callFunction
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/callFunction.js
var init_callFunction = __esmMin((() => {
	init_evaluateExpression();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/evaluateCondition.js
var evaluateCondition;
var init_evaluateCondition = __esmMin((() => {
	init_debug();
	init_types();
	init_callFunction();
	evaluateCondition = (condition, options) => {
		const { assign } = condition;
		if (assign && assign in options.referenceRecord) throw new EndpointError(`'${assign}' is already defined in Reference Record.`);
		const value = callFunction(condition, options);
		options.logger?.debug?.(`${debugId} evaluateCondition: ${toDebugString(condition)} = ${toDebugString(value)}`);
		const result = value === "" ? true : !!value;
		if (assign != null) return {
			result,
			toAssign: {
				name: assign,
				value
			}
		};
		return { result };
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/getEndpointHeaders.js
var getEndpointHeaders;
var init_getEndpointHeaders = __esmMin((() => {
	init_types();
	init_evaluateExpression();
	getEndpointHeaders = (headers, options) => Object.entries(headers ?? {}).reduce((acc, [headerKey, headerVal]) => {
		acc[headerKey] = headerVal.map((headerValEntry) => {
			const processedExpr = evaluateExpression(headerValEntry, "Header value entry", options);
			if (typeof processedExpr !== "string") throw new EndpointError(`Header '${headerKey}' value '${processedExpr}' is not a string`);
			return processedExpr;
		});
		return acc;
	}, {});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/getEndpointProperties.js
var getEndpointProperties, getEndpointProperty, group$1;
var init_getEndpointProperties = __esmMin((() => {
	init_types();
	init_evaluateTemplate();
	getEndpointProperties = (properties, options) => Object.entries(properties).reduce((acc, [propertyKey, propertyVal]) => {
		acc[propertyKey] = group$1.getEndpointProperty(propertyVal, options);
		return acc;
	}, {});
	getEndpointProperty = (property, options) => {
		if (Array.isArray(property)) return property.map((propertyEntry) => getEndpointProperty(propertyEntry, options));
		switch (typeof property) {
			case "string": return evaluateTemplate(property, options);
			case "object":
				if (property === null) throw new EndpointError(`Unexpected endpoint property: ${property}`);
				return group$1.getEndpointProperties(property, options);
			case "boolean": return property;
			default: throw new EndpointError(`Unexpected endpoint property type: ${typeof property}`);
		}
	};
	group$1 = {
		getEndpointProperty,
		getEndpointProperties
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/getEndpointUrl.js
var getEndpointUrl;
var init_getEndpointUrl = __esmMin((() => {
	init_types();
	init_evaluateExpression();
	getEndpointUrl = (endpointUrl, options) => {
		const expression = evaluateExpression(endpointUrl, "Endpoint URL", options);
		if (typeof expression === "string") try {
			return new URL(expression);
		} catch (error) {
			console.error(`Failed to construct URL with ${expression}`, error);
			throw error;
		}
		throw new EndpointError(`Endpoint URL must be a string, got ${typeof expression}`);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/decideEndpoint.js
var RESULT, decideEndpoint;
var init_decideEndpoint = __esmMin((() => {
	init_types();
	init_evaluateCondition();
	init_evaluateExpression();
	init_getEndpointHeaders();
	init_getEndpointProperties();
	init_getEndpointUrl();
	RESULT = 1e8;
	decideEndpoint = (bdd, options) => {
		const { nodes, root, results, conditions } = bdd;
		let ref = root;
		const referenceRecord = {};
		const closure = {
			referenceRecord,
			endpointParams: options.endpointParams,
			logger: options.logger
		};
		while (ref !== 1 && ref !== -1 && ref < RESULT) {
			const node_i = 3 * (Math.abs(ref) - 1);
			const [condition_i, highRef, lowRef] = [
				nodes[node_i],
				nodes[node_i + 1],
				nodes[node_i + 2]
			];
			const [fn, argv, assign] = conditions[condition_i];
			const evaluation = evaluateCondition({
				fn,
				assign,
				argv
			}, closure);
			if (evaluation.toAssign) {
				const { name, value } = evaluation.toAssign;
				referenceRecord[name] = value;
			}
			ref = ref >= 0 === evaluation.result ? highRef : lowRef;
		}
		if (ref >= RESULT) {
			const result = results[ref - RESULT];
			if (result[0] === -1) {
				const [, errorExpression] = result;
				throw new EndpointError(evaluateExpression(errorExpression, "Error", closure));
			}
			const [url, properties, headers] = result;
			return {
				url: getEndpointUrl(url, closure),
				properties: getEndpointProperties(properties, closure),
				headers: getEndpointHeaders(headers ?? {}, closure)
			};
		}
		throw new EndpointError(`No matching endpoint.`);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/evaluateConditions.js
var evaluateConditions;
var init_evaluateConditions = __esmMin((() => {
	init_debug();
	init_evaluateCondition();
	evaluateConditions = (conditions = [], options) => {
		const conditionsReferenceRecord = {};
		const conditionOptions = {
			...options,
			referenceRecord: { ...options.referenceRecord }
		};
		let didAssign = false;
		for (const condition of conditions) {
			const { result, toAssign } = evaluateCondition(condition, conditionOptions);
			if (!result) return { result };
			if (toAssign) {
				didAssign = true;
				conditionsReferenceRecord[toAssign.name] = toAssign.value;
				conditionOptions.referenceRecord[toAssign.name] = toAssign.value;
				options.logger?.debug?.(`${debugId} assign: ${toAssign.name} := ${toDebugString(toAssign.value)}`);
			}
		}
		if (didAssign) return {
			result: true,
			referenceRecord: conditionsReferenceRecord
		};
		return { result: true };
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/evaluateEndpointRule.js
var evaluateEndpointRule;
var init_evaluateEndpointRule = __esmMin((() => {
	init_debug();
	init_evaluateConditions();
	init_getEndpointHeaders();
	init_getEndpointProperties();
	init_getEndpointUrl();
	evaluateEndpointRule = (endpointRule, options) => {
		const { conditions, endpoint } = endpointRule;
		const { result, referenceRecord } = evaluateConditions(conditions, options);
		if (!result) return;
		const endpointRuleOptions = referenceRecord ? {
			...options,
			referenceRecord: {
				...options.referenceRecord,
				...referenceRecord
			}
		} : options;
		const { url, properties, headers } = endpoint;
		options.logger?.debug?.(`${debugId} Resolving endpoint from template: ${toDebugString(endpoint)}`);
		const endpointToReturn = { url: getEndpointUrl(url, endpointRuleOptions) };
		if (headers != null) endpointToReturn.headers = getEndpointHeaders(headers, endpointRuleOptions);
		if (properties != null) endpointToReturn.properties = getEndpointProperties(properties, endpointRuleOptions);
		return endpointToReturn;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/evaluateErrorRule.js
var evaluateErrorRule;
var init_evaluateErrorRule = __esmMin((() => {
	init_types();
	init_evaluateConditions();
	init_evaluateExpression();
	evaluateErrorRule = (errorRule, options) => {
		const { conditions, error } = errorRule;
		const { result, referenceRecord } = evaluateConditions(conditions, options);
		if (!result) return;
		throw new EndpointError(evaluateExpression(error, "Error", referenceRecord ? {
			...options,
			referenceRecord: {
				...options.referenceRecord,
				...referenceRecord
			}
		} : options));
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/evaluateRules.js
var evaluateRules, evaluateTreeRule, group;
var init_evaluateRules = __esmMin((() => {
	init_types();
	init_evaluateConditions();
	init_evaluateEndpointRule();
	init_evaluateErrorRule();
	evaluateRules = (rules, options) => {
		for (const rule of rules) if (rule.type === "endpoint") {
			const endpointOrUndefined = evaluateEndpointRule(rule, options);
			if (endpointOrUndefined) return endpointOrUndefined;
		} else if (rule.type === "error") evaluateErrorRule(rule, options);
		else if (rule.type === "tree") {
			const endpointOrUndefined = group.evaluateTreeRule(rule, options);
			if (endpointOrUndefined) return endpointOrUndefined;
		} else throw new EndpointError(`Unknown endpoint rule: ${rule}`);
		throw new EndpointError(`Rules evaluation failed`);
	};
	evaluateTreeRule = (treeRule, options) => {
		const { conditions, rules } = treeRule;
		const { result, referenceRecord } = evaluateConditions(conditions, options);
		if (!result) return;
		const treeRuleOptions = referenceRecord ? {
			...options,
			referenceRecord: {
				...options.referenceRecord,
				...referenceRecord
			}
		} : options;
		return group.evaluateRules(rules, treeRuleOptions);
	};
	group = {
		evaluateRules,
		evaluateTreeRule
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/utils/index.js
var init_utils = __esmMin((() => {
	init_customEndpointFunctions();
	init_evaluateRules();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/util-endpoints/resolveEndpoint.js
var resolveEndpoint;
var init_resolveEndpoint = __esmMin((() => {
	init_debug();
	init_types();
	init_utils();
	resolveEndpoint = (ruleSetObject, options) => {
		const { endpointParams, logger } = options;
		const { parameters, rules } = ruleSetObject;
		options.logger?.debug?.(`${debugId} Initial EndpointParams: ${toDebugString(endpointParams)}`);
		for (const paramKey in parameters) {
			const parameter = parameters[paramKey];
			const endpointParam = endpointParams[paramKey];
			if (endpointParam == null && parameter.default != null) {
				endpointParams[paramKey] = parameter.default;
				continue;
			}
			if (parameter.required && endpointParam == null) throw new EndpointError(`Missing required parameter: '${paramKey}'`);
		}
		const endpoint = evaluateRules(rules, {
			endpointParams,
			logger,
			referenceRecord: {}
		});
		options.logger?.debug?.(`${debugId} Resolved endpoint: ${toDebugString(endpoint)}`);
		return endpoint;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/resolveEndpointRequiredConfig.js
var resolveEndpointRequiredConfig;
var init_resolveEndpointRequiredConfig = __esmMin((() => {
	resolveEndpointRequiredConfig = (input) => {
		const { endpoint } = input;
		if (endpoint === void 0) input.endpoint = async () => {
			throw new Error("@smithy/middleware-endpoint: (default endpointRuleSet) endpoint is not set - you must configure an endpoint.");
		};
		return input;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/endpoints/index.js
var endpoints_exports = /* @__PURE__ */ __exportAll({
	BinaryDecisionDiagram: () => BinaryDecisionDiagram,
	EndpointCache: () => EndpointCache,
	EndpointError: () => EndpointError,
	customEndpointFunctions: () => customEndpointFunctions,
	decideEndpoint: () => decideEndpoint,
	endpointMiddleware: () => endpointMiddleware,
	endpointMiddlewareOptions: () => endpointMiddlewareOptions,
	getEndpointFromInstructions: () => getEndpointFromInstructions,
	getEndpointPlugin: () => getEndpointPlugin,
	isIpAddress: () => isIpAddress,
	isValidHostLabel: () => isValidHostLabel,
	middlewareEndpointToEndpointV1: () => toEndpointV1,
	resolveEndpoint: () => resolveEndpoint,
	resolveEndpointConfig: () => resolveEndpointConfig,
	resolveEndpointRequiredConfig: () => resolveEndpointRequiredConfig,
	resolveParams: () => resolveParams,
	toEndpointV1: () => toEndpointV1
});
var getEndpointFromInstructions, resolveEndpointConfig, endpointMiddleware, getEndpointPlugin;
var init_endpoints = __esmMin((() => {
	init_getEndpointFromConfig();
	init_getEndpointFromInstructions();
	init_endpointMiddleware();
	init_getEndpointPlugin();
	init_resolveEndpointConfig();
	init_toEndpointV1$1();
	init_BinaryDecisionDiagram();
	init_EndpointCache();
	init_decideEndpoint();
	init_isIpAddress();
	init_isValidHostLabel();
	init_customEndpointFunctions();
	init_resolveEndpoint();
	init_types();
	init_toEndpointV1();
	init_resolveEndpointRequiredConfig();
	getEndpointFromInstructions = bindGetEndpointFromInstructions(getEndpointFromConfig);
	resolveEndpointConfig = bindResolveEndpointConfig(getEndpointFromConfig);
	endpointMiddleware = bindEndpointMiddleware(getEndpointFromConfig);
	getEndpointPlugin = bindGetEndpointPlugin(getEndpointFromConfig);
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/middleware-serde/serializerMiddleware.js
var serializerMiddleware;
var init_serializerMiddleware = __esmMin((() => {
	init_endpoints();
	serializerMiddleware = (options, serializer) => (next, context) => async (args) => {
		const endpointConfig = options;
		const endpoint = context.endpointV2 ? async () => toEndpointV1(context.endpointV2) : endpointConfig.endpoint;
		if (!endpoint) throw new Error("No valid endpoint provider available.");
		const request = await serializer(args.input, {
			...options,
			endpoint
		});
		return next({
			...args,
			request
		});
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/middleware-serde/serdePlugin.js
function getSerdePlugin(config, serializer, deserializer) {
	return { applyToStack: (commandStack) => {
		commandStack.add(deserializerMiddleware(config, deserializer), deserializerMiddlewareOption$1);
		commandStack.add(serializerMiddleware(config, serializer), serializerMiddlewareOption$1);
	} };
}
var deserializerMiddlewareOption$1, serializerMiddlewareOption$1;
var init_serdePlugin = __esmMin((() => {
	init_deserializerMiddleware();
	init_serializerMiddleware();
	deserializerMiddlewareOption$1 = {
		name: "deserializerMiddleware",
		step: "deserialize",
		tags: ["DESERIALIZER"],
		override: true
	};
	serializerMiddlewareOption$1 = {
		name: "serializerMiddleware",
		step: "serialize",
		tags: ["SERIALIZER"],
		override: true
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/hash-node/hash-node.js
function castSourceData(toCast, encoding) {
	if (Buffer.isBuffer(toCast)) return toCast;
	if (typeof toCast === "string") return fromString(toCast, encoding);
	if (ArrayBuffer.isView(toCast)) return fromArrayBuffer(toCast.buffer, toCast.byteOffset, toCast.byteLength);
	return fromArrayBuffer(toCast);
}
var Hash;
var init_hash_node = __esmMin((() => {
	init_buffer_from();
	init_toUint8Array();
	Hash = class {
		algorithmIdentifier;
		secret;
		hash;
		constructor(algorithmIdentifier, secret) {
			this.algorithmIdentifier = algorithmIdentifier;
			this.secret = secret;
			this.reset();
		}
		update(toHash, encoding) {
			this.hash.update(toUint8Array(castSourceData(toHash, encoding)));
		}
		digest() {
			return Promise.resolve(this.hash.digest());
		}
		reset() {
			this.hash = this.secret ? createHmac(this.algorithmIdentifier, castSourceData(this.secret)) : createHash(this.algorithmIdentifier);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/checksum/ChecksumStream.js
var ChecksumStream$1;
var init_ChecksumStream = __esmMin((() => {
	init_toBase64();
	ChecksumStream$1 = class extends Duplex {
		expectedChecksum;
		checksumSourceLocation;
		checksum;
		source;
		base64Encoder;
		pendingCallback = null;
		constructor({ expectedChecksum, checksum, source, checksumSourceLocation, base64Encoder }) {
			super();
			if (typeof source.pipe === "function") this.source = source;
			else throw new Error(`@smithy/util-stream: unsupported source type ${source?.constructor?.name ?? source} in ChecksumStream.`);
			this.base64Encoder = base64Encoder ?? toBase64$1;
			this.expectedChecksum = expectedChecksum;
			this.checksum = checksum;
			this.checksumSourceLocation = checksumSourceLocation;
			this.source.pipe(this);
		}
		_read(size) {
			if (this.pendingCallback) {
				const callback = this.pendingCallback;
				this.pendingCallback = null;
				callback();
			}
		}
		_write(chunk, encoding, callback) {
			try {
				this.checksum.update(chunk);
				if (!this.push(chunk)) {
					this.pendingCallback = callback;
					return;
				}
			} catch (e) {
				return callback(e);
			}
			return callback();
		}
		async _final(callback) {
			try {
				const digest = await this.checksum.digest();
				const received = this.base64Encoder(digest);
				if (this.expectedChecksum !== received) return callback(/* @__PURE__ */ new Error(`Checksum mismatch: expected "${this.expectedChecksum}" but received "${received}" in response header "${this.checksumSourceLocation}".`));
			} catch (e) {
				return callback(e);
			}
			this.push(null);
			return callback();
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/stream-type-check.js
var isReadableStream, isBlob;
var init_stream_type_check = __esmMin((() => {
	isReadableStream = (stream) => typeof ReadableStream === "function" && (stream?.constructor?.name === ReadableStream.name || stream instanceof ReadableStream);
	isBlob = (blob) => {
		return typeof Blob === "function" && (blob?.constructor?.name === Blob.name || blob instanceof Blob);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-utf8/fromUtf8.browser.js
var fromUtf8;
var init_fromUtf8_browser = __esmMin((() => {
	fromUtf8 = (input) => new TextEncoder().encode(input);
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-base64/constants-for-browser.js
var chars, alphabetByEncoding, alphabetByValue;
var init_constants_for_browser = __esmMin((() => {
	chars = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/`;
	alphabetByEncoding = Object.entries(chars).reduce((acc, [i, c]) => {
		acc[c] = Number(i);
		return acc;
	}, {});
	alphabetByValue = chars.split("");
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-base64/toBase64.browser.js
function toBase64(_input) {
	let input;
	if (typeof _input === "string") input = fromUtf8(_input);
	else input = _input;
	const isArrayLike = typeof input === "object" && typeof input.length === "number";
	const isUint8Array = typeof input === "object" && typeof input.byteOffset === "number" && typeof input.byteLength === "number";
	if (!isArrayLike && !isUint8Array) throw new Error("@smithy/util-base64: toBase64 encoder function only accepts string | Uint8Array.");
	let str = "";
	for (let i = 0; i < input.length; i += 3) {
		let bits = 0;
		let bitLength = 0;
		for (let j = i, limit = Math.min(i + 3, input.length); j < limit; j++) {
			bits |= input[j] << (limit - j - 1) * 8;
			bitLength += 8;
		}
		const bitClusterCount = Math.ceil(bitLength / 6);
		bits <<= bitClusterCount * 6 - bitLength;
		for (let k = 1; k <= bitClusterCount; k++) {
			const offset = (bitClusterCount - k) * 6;
			str += alphabetByValue[(bits & 63 << offset) >> offset];
		}
		str += "==".slice(0, 4 - bitClusterCount);
	}
	return str;
}
var init_toBase64_browser = __esmMin((() => {
	init_fromUtf8_browser();
	init_constants_for_browser();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/checksum/ChecksumStream.browser.js
var ReadableStreamRef, ChecksumStream;
var init_ChecksumStream_browser = __esmMin((() => {
	ReadableStreamRef = typeof ReadableStream === "function" ? ReadableStream : function() {};
	ChecksumStream = class extends ReadableStreamRef {};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/checksum/createChecksumStream.browser.js
var createChecksumStream$1;
var init_createChecksumStream_browser = __esmMin((() => {
	init_toBase64_browser();
	init_stream_type_check();
	init_ChecksumStream_browser();
	createChecksumStream$1 = ({ expectedChecksum, checksum, source, checksumSourceLocation, base64Encoder }) => {
		if (!isReadableStream(source)) throw new Error(`@smithy/util-stream: unsupported source type ${source?.constructor?.name ?? source} in ChecksumStream.`);
		const encoder = base64Encoder ?? toBase64;
		if (typeof TransformStream !== "function") throw new Error("@smithy/util-stream: unable to instantiate ChecksumStream because API unavailable: ReadableStream/TransformStream.");
		const transform = new TransformStream({
			start() {},
			async transform(chunk, controller) {
				checksum.update(chunk);
				controller.enqueue(chunk);
			},
			async flush(controller) {
				const received = encoder(await checksum.digest());
				if (expectedChecksum !== received) {
					const error = /* @__PURE__ */ new Error(`Checksum mismatch: expected "${expectedChecksum}" but received "${received}" in response header "${checksumSourceLocation}".`);
					controller.error(error);
				} else controller.terminate();
			}
		});
		source.pipeThrough(transform);
		const readable = transform.readable;
		Object.setPrototypeOf(readable, ChecksumStream.prototype);
		return readable;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/checksum/createChecksumStream.js
function createChecksumStream(init) {
	if (typeof ReadableStream === "function" && isReadableStream(init.source)) return createChecksumStream$1(init);
	return new ChecksumStream$1(init);
}
var init_createChecksumStream = __esmMin((() => {
	init_stream_type_check();
	init_ChecksumStream();
	init_createChecksumStream_browser();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/ByteArrayCollector.js
var ByteArrayCollector;
var init_ByteArrayCollector = __esmMin((() => {
	ByteArrayCollector = class {
		allocByteArray;
		byteLength = 0;
		byteArrays = [];
		constructor(allocByteArray) {
			this.allocByteArray = allocByteArray;
		}
		push(byteArray) {
			this.byteArrays.push(byteArray);
			this.byteLength += byteArray.byteLength;
		}
		flush() {
			if (this.byteArrays.length === 1) {
				const bytes = this.byteArrays[0];
				this.reset();
				return bytes;
			}
			const aggregation = this.allocByteArray(this.byteLength);
			let cursor = 0;
			for (let i = 0; i < this.byteArrays.length; ++i) {
				const bytes = this.byteArrays[i];
				aggregation.set(bytes, cursor);
				cursor += bytes.byteLength;
			}
			this.reset();
			return aggregation;
		}
		reset() {
			this.byteArrays = [];
			this.byteLength = 0;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/createBufferedReadable.browser.js
function createBufferedReadableStream(upstream, size, logger) {
	const reader = upstream.getReader();
	let streamBufferingLoggedWarning = false;
	let bytesSeen = 0;
	const buffers = ["", new ByteArrayCollector((size) => new Uint8Array(size))];
	let mode = -1;
	const pull = async (controller) => {
		const { value, done } = await reader.read();
		const chunk = value;
		if (done) {
			if (mode !== -1) {
				const remainder = flush(buffers, mode);
				if (sizeOf(remainder) > 0) controller.enqueue(remainder);
			}
			controller.close();
		} else {
			const chunkMode = modeOf(chunk, false);
			if (mode !== chunkMode) {
				if (mode >= 0) controller.enqueue(flush(buffers, mode));
				mode = chunkMode;
			}
			if (mode === -1) {
				controller.enqueue(chunk);
				return;
			}
			const chunkSize = sizeOf(chunk);
			bytesSeen += chunkSize;
			const bufferSize = sizeOf(buffers[mode]);
			if (chunkSize >= size && bufferSize === 0) controller.enqueue(chunk);
			else {
				const newSize = merge(buffers, mode, chunk);
				if (!streamBufferingLoggedWarning && bytesSeen > size * 2) {
					streamBufferingLoggedWarning = true;
					logger?.warn(`@smithy/util-stream - stream chunk size ${chunkSize} is below threshold of ${size}, automatically buffering.`);
				}
				if (newSize >= size) controller.enqueue(flush(buffers, mode));
				else await pull(controller);
			}
		}
	};
	return new ReadableStream({ pull });
}
function merge(buffers, mode, chunk) {
	switch (mode) {
		case 0:
			buffers[0] += chunk;
			return sizeOf(buffers[0]);
		case 1:
		case 2:
			buffers[mode].push(chunk);
			return sizeOf(buffers[mode]);
	}
}
function flush(buffers, mode) {
	switch (mode) {
		case 0:
			const s = buffers[0];
			buffers[0] = "";
			return s;
		case 1:
		case 2: return buffers[mode].flush();
	}
	throw new Error(`@smithy/util-stream - invalid index ${mode} given to flush()`);
}
function sizeOf(chunk) {
	return chunk?.byteLength ?? chunk?.length ?? 0;
}
function modeOf(chunk, allowBuffer = true) {
	if (allowBuffer && typeof Buffer !== "undefined" && chunk instanceof Buffer) return 2;
	if (chunk instanceof Uint8Array) return 1;
	if (typeof chunk === "string") return 0;
	return -1;
}
var init_createBufferedReadable_browser = __esmMin((() => {
	init_ByteArrayCollector();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/createBufferedReadable.js
function createBufferedReadable(upstream, size, logger) {
	if (isReadableStream(upstream)) return createBufferedReadableStream(upstream, size, logger);
	const downstream = new Readable({ read() {} });
	let streamBufferingLoggedWarning = false;
	let bytesSeen = 0;
	const buffers = [
		"",
		new ByteArrayCollector((size) => new Uint8Array(size)),
		new ByteArrayCollector((size) => Buffer.from(new Uint8Array(size)))
	];
	let mode = -1;
	upstream.on("data", (chunk) => {
		const chunkMode = modeOf(chunk, true);
		if (mode !== chunkMode) {
			if (mode >= 0) downstream.push(flush(buffers, mode));
			mode = chunkMode;
		}
		if (mode === -1) {
			downstream.push(chunk);
			return;
		}
		const chunkSize = sizeOf(chunk);
		bytesSeen += chunkSize;
		const bufferSize = sizeOf(buffers[mode]);
		if (chunkSize >= size && bufferSize === 0) downstream.push(chunk);
		else {
			const newSize = merge(buffers, mode, chunk);
			if (!streamBufferingLoggedWarning && bytesSeen > size * 2) {
				streamBufferingLoggedWarning = true;
				logger?.warn(`@smithy/util-stream - stream chunk size ${chunkSize} is below threshold of ${size}, automatically buffering.`);
			}
			if (newSize >= size) downstream.push(flush(buffers, mode));
		}
	});
	upstream.on("end", () => {
		if (mode !== -1) {
			const remainder = flush(buffers, mode);
			if (sizeOf(remainder) > 0) downstream.push(remainder);
		}
		downstream.push(null);
	});
	return downstream;
}
var init_createBufferedReadable = __esmMin((() => {
	init_ByteArrayCollector();
	init_createBufferedReadable_browser();
	init_stream_type_check();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/getAwsChunkedEncodingStream.browser.js
var getAwsChunkedEncodingStream$1;
var init_getAwsChunkedEncodingStream_browser = __esmMin((() => {
	getAwsChunkedEncodingStream$1 = (readableStream, options) => {
		const { base64Encoder, bodyLengthChecker, checksumAlgorithmFn, checksumLocationName, streamHasher } = options;
		const checksumRequired = base64Encoder !== void 0 && bodyLengthChecker !== void 0 && checksumAlgorithmFn !== void 0 && checksumLocationName !== void 0 && streamHasher !== void 0;
		const digest = checksumRequired ? streamHasher(checksumAlgorithmFn, readableStream) : void 0;
		const reader = readableStream.getReader();
		return new ReadableStream({ async pull(controller) {
			const { value, done } = await reader.read();
			if (done) {
				controller.enqueue(`0\r\n`);
				if (checksumRequired) {
					const checksum = base64Encoder(await digest);
					controller.enqueue(`${checksumLocationName}:${checksum}\r\n`);
					controller.enqueue(`\r\n`);
				}
				controller.close();
			} else controller.enqueue(`${(bodyLengthChecker(value) || 0).toString(16)}\r\n${value}\r\n`);
		} });
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/getAwsChunkedEncodingStream.js
function getAwsChunkedEncodingStream(stream, options) {
	const readable = stream;
	const readableStream = stream;
	if (isReadableStream(readableStream)) return getAwsChunkedEncodingStream$1(readableStream, options);
	const { base64Encoder, bodyLengthChecker, checksumAlgorithmFn, checksumLocationName, streamHasher } = options;
	const checksumRequired = base64Encoder !== void 0 && checksumAlgorithmFn !== void 0 && checksumLocationName !== void 0 && streamHasher !== void 0;
	const digest = checksumRequired ? streamHasher(checksumAlgorithmFn, readable) : void 0;
	const awsChunkedEncodingStream = new Readable({ read: () => {} });
	readable.on("data", (data) => {
		const length = bodyLengthChecker(data) || 0;
		if (length === 0) return;
		awsChunkedEncodingStream.push(`${length.toString(16)}\r\n`);
		awsChunkedEncodingStream.push(data);
		awsChunkedEncodingStream.push("\r\n");
	});
	readable.on("end", async () => {
		awsChunkedEncodingStream.push(`0\r\n`);
		if (checksumRequired) {
			const checksum = base64Encoder(await digest);
			awsChunkedEncodingStream.push(`${checksumLocationName}:${checksum}\r\n`);
			awsChunkedEncodingStream.push(`\r\n`);
		}
		awsChunkedEncodingStream.push(null);
	});
	return awsChunkedEncodingStream;
}
var init_getAwsChunkedEncodingStream = __esmMin((() => {
	init_getAwsChunkedEncodingStream_browser();
	init_stream_type_check();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/headStream.browser.js
async function headStream$1(stream, bytes) {
	let byteLengthCounter = 0;
	const chunks = [];
	const reader = stream.getReader();
	let isDone = false;
	while (!isDone) {
		const { done, value } = await reader.read();
		if (value) {
			chunks.push(value);
			byteLengthCounter += value?.byteLength ?? 0;
		}
		if (byteLengthCounter >= bytes) break;
		isDone = done;
	}
	reader.releaseLock();
	const collected = new Uint8Array(Math.min(bytes, byteLengthCounter));
	let offset = 0;
	for (const chunk of chunks) {
		if (chunk.byteLength > collected.byteLength - offset) {
			collected.set(chunk.subarray(0, collected.byteLength - offset), offset);
			break;
		} else collected.set(chunk, offset);
		offset += chunk.length;
	}
	return collected;
}
var init_headStream_browser = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/headStream.js
var headStream, Collector$1;
var init_headStream = __esmMin((() => {
	init_headStream_browser();
	init_stream_type_check();
	headStream = (stream, bytes) => {
		if (isReadableStream(stream)) return headStream$1(stream, bytes);
		return new Promise((resolve, reject) => {
			const collector = new Collector$1();
			collector.limit = bytes;
			stream.pipe(collector);
			stream.on("error", (err) => {
				collector.end();
				reject(err);
			});
			collector.on("error", reject);
			collector.on("finish", function() {
				resolve(new Uint8Array(Buffer.concat(this.buffers)));
			});
		});
	};
	Collector$1 = class extends Writable {
		buffers = [];
		limit = Infinity;
		bytesBuffered = 0;
		_write(chunk, encoding, callback) {
			this.buffers.push(chunk);
			this.bytesBuffered += chunk.byteLength ?? 0;
			if (this.bytesBuffered >= this.limit) {
				const excess = this.bytesBuffered - this.limit;
				const tailBuffer = this.buffers[this.buffers.length - 1];
				this.buffers[this.buffers.length - 1] = tailBuffer.subarray(0, tailBuffer.byteLength - excess);
				this.emit("finish");
			}
			callback();
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-utf8/toUtf8.browser.js
var toUtf8;
var init_toUtf8_browser = __esmMin((() => {
	toUtf8 = (input) => {
		if (typeof input === "string") return input;
		if (typeof input !== "object" || typeof input.byteOffset !== "number" || typeof input.byteLength !== "number") throw new Error("@smithy/util-utf8: toUtf8 encoder function only accepts string | Uint8Array.");
		return new TextDecoder("utf-8").decode(input);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-base64/fromBase64.browser.js
var fromBase64;
var init_fromBase64_browser = __esmMin((() => {
	init_constants_for_browser();
	fromBase64 = (input) => {
		let totalByteLength = input.length / 4 * 3;
		if (input.slice(-2) === "==") totalByteLength -= 2;
		else if (input.slice(-1) === "=") totalByteLength--;
		const out = new ArrayBuffer(totalByteLength);
		const dataView = new DataView(out);
		for (let i = 0; i < input.length; i += 4) {
			let bits = 0;
			let bitLength = 0;
			for (let j = i, limit = i + 3; j <= limit; j++) if (input[j] !== "=") {
				if (!(input[j] in alphabetByEncoding)) throw new TypeError(`Invalid character ${input[j]} in base64 string.`);
				bits |= alphabetByEncoding[input[j]] << (limit - j) * 6;
				bitLength += 6;
			} else bits >>= 6;
			const chunkOffset = i / 4 * 3;
			bits >>= bitLength % 8;
			const byteLength = Math.floor(bitLength / 8);
			for (let k = 0; k < byteLength; k++) {
				const offset = (byteLength - k - 1) * 8;
				dataView.setUint8(chunkOffset + k, (bits & 255 << offset) >> offset);
			}
		}
		return new Uint8Array(out);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/stream-collector.browser.js
async function collectBlob(blob) {
	const arrayBuffer = fromBase64(await readToBase64(blob));
	return new Uint8Array(arrayBuffer);
}
async function collectStream(stream) {
	const chunks = [];
	const reader = stream.getReader();
	let isDone = false;
	let length = 0;
	while (!isDone) {
		const { done, value } = await reader.read();
		if (value) {
			chunks.push(value);
			length += value.length;
		}
		isDone = done;
	}
	const collected = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		collected.set(chunk, offset);
		offset += chunk.length;
	}
	return collected;
}
function readToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => {
			if (reader.readyState !== 2) return reject(/* @__PURE__ */ new Error("Reader aborted too early"));
			const result = reader.result ?? "";
			const commaIndex = result.indexOf(",");
			const dataOffset = commaIndex > -1 ? commaIndex + 1 : result.length;
			resolve(result.substring(dataOffset));
		};
		reader.onabort = () => reject(/* @__PURE__ */ new Error("Read aborted"));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}
var streamCollector$1;
var init_stream_collector_browser = __esmMin((() => {
	init_fromBase64_browser();
	streamCollector$1 = async (stream) => {
		if (typeof Blob === "function" && stream instanceof Blob || stream.constructor?.name === "Blob") {
			if (Blob.prototype.arrayBuffer !== void 0) return new Uint8Array(await stream.arrayBuffer());
			return collectBlob(stream);
		}
		return collectStream(stream);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/sdk-stream-mixin.browser.js
var ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED$1, sdkStreamMixin$1, isBlobInstance;
var init_sdk_stream_mixin_browser = __esmMin((() => {
	init_toBase64_browser();
	init_hex_encoding();
	init_toUtf8_browser();
	init_stream_collector_browser();
	init_stream_type_check();
	ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED$1 = "The stream has already been transformed.";
	sdkStreamMixin$1 = (stream) => {
		if (!isBlobInstance(stream) && !isReadableStream(stream)) {
			const name = stream?.__proto__?.constructor?.name || stream;
			throw new Error(`Unexpected stream implementation, expect Blob or ReadableStream, got ${name}`);
		}
		let transformed = false;
		const transformToByteArray = async () => {
			if (transformed) throw new Error(ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED$1);
			transformed = true;
			return await streamCollector$1(stream);
		};
		const blobToWebStream = (blob) => {
			if (typeof blob.stream !== "function") throw new Error("Cannot transform payload Blob to web stream. Please make sure the Blob.stream() is polyfilled.\nIf you are using React Native, this API is not yet supported, see: https://react-native.canny.io/feature-requests/p/fetch-streaming-body");
			return blob.stream();
		};
		return Object.assign(stream, {
			transformToByteArray,
			transformToString: async (encoding) => {
				const buf = await transformToByteArray();
				if (encoding === "base64") return toBase64(buf);
				else if (encoding === "hex") return toHex(buf);
				else if (encoding === void 0 || encoding === "utf8" || encoding === "utf-8") return toUtf8(buf);
				else if (typeof TextDecoder === "function") return new TextDecoder(encoding).decode(buf);
				else throw new Error("TextDecoder is not available, please make sure polyfill is provided.");
			},
			transformToWebStream: () => {
				if (transformed) throw new Error(ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED$1);
				transformed = true;
				if (isBlobInstance(stream)) return blobToWebStream(stream);
				else if (isReadableStream(stream)) return stream;
				else throw new Error(`Cannot transform payload to web stream, got ${stream}`);
			}
		});
	};
	isBlobInstance = (stream) => typeof Blob === "function" && stream instanceof Blob;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/stream-collector.js
async function collectReadableStream(stream) {
	const chunks = [];
	const reader = stream.getReader();
	let isDone = false;
	let length = 0;
	while (!isDone) {
		const { done, value } = await reader.read();
		if (value) {
			chunks.push(value);
			length += value.length;
		}
		isDone = done;
	}
	const collected = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		collected.set(chunk, offset);
		offset += chunk.length;
	}
	return collected;
}
var Collector, isReadableStreamInstance, streamCollector;
var init_stream_collector = __esmMin((() => {
	Collector = class extends Writable {
		bufferedBytes = [];
		_write(chunk, encoding, callback) {
			this.bufferedBytes.push(chunk);
			callback();
		}
	};
	isReadableStreamInstance = (stream) => typeof ReadableStream === "function" && stream instanceof ReadableStream;
	streamCollector = (stream) => {
		if (isReadableStreamInstance(stream)) return collectReadableStream(stream);
		return new Promise((resolve, reject) => {
			const collector = new Collector();
			stream.pipe(collector);
			stream.on("error", (err) => {
				collector.end();
				reject(err);
			});
			collector.on("error", reject);
			collector.on("finish", function() {
				resolve(new Uint8Array(Buffer.concat(this.bufferedBytes)));
			});
		});
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/sdk-stream-mixin.js
var ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED, sdkStreamMixin;
var init_sdk_stream_mixin = __esmMin((() => {
	init_buffer_from();
	init_sdk_stream_mixin_browser();
	init_stream_collector();
	ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED = "The stream has already been transformed.";
	sdkStreamMixin = (stream) => {
		if (!(stream instanceof Readable)) try {
			return sdkStreamMixin$1(stream);
		} catch (e) {
			const name = stream?.__proto__?.constructor?.name || stream;
			throw new Error(`Unexpected stream implementation, expect Stream.Readable instance, got ${name}`);
		}
		let transformed = false;
		const transformToByteArray = async () => {
			if (transformed) throw new Error(ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED);
			transformed = true;
			return await streamCollector(stream);
		};
		return Object.assign(stream, {
			transformToByteArray,
			transformToString: async (encoding) => {
				const buf = await transformToByteArray();
				if (encoding === void 0 || Buffer.isEncoding(encoding)) return fromArrayBuffer(buf.buffer, buf.byteOffset, buf.byteLength).toString(encoding);
				else return new TextDecoder(encoding).decode(buf);
			},
			transformToWebStream: () => {
				if (transformed) throw new Error(ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED);
				if (stream.readableFlowing !== null) throw new Error("The stream has been consumed by other callbacks.");
				if (typeof Readable.toWeb !== "function") throw new Error("Readable.toWeb() is not supported. Please ensure a polyfill is available.");
				transformed = true;
				return Readable.toWeb(stream);
			}
		});
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/splitStream.browser.js
async function splitStream$1(stream) {
	if (typeof stream.stream === "function") stream = stream.stream();
	return stream.tee();
}
var init_splitStream_browser = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/util-stream/splitStream.js
async function splitStream(stream) {
	if (isReadableStream(stream) || isBlob(stream)) return splitStream$1(stream);
	const stream1 = new PassThrough();
	const stream2 = new PassThrough();
	stream.pipe(stream1);
	stream.pipe(stream2);
	return [stream1, stream2];
}
var init_splitStream = __esmMin((() => {
	init_splitStream_browser();
	init_stream_type_check();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/serde/index.js
var serde_exports = /* @__PURE__ */ __exportAll({
	ChecksumStream: () => ChecksumStream$1,
	Hash: () => Hash,
	LazyJsonString: () => LazyJsonString,
	NumericValue: () => NumericValue,
	Uint8ArrayBlobAdapter: () => Uint8ArrayBlobAdapter,
	_parseEpochTimestamp: () => _parseEpochTimestamp,
	_parseRfc3339DateTimeWithOffset: () => _parseRfc3339DateTimeWithOffset,
	_parseRfc7231DateTime: () => _parseRfc7231DateTime,
	calculateBodyLength: () => calculateBodyLength,
	copyDocumentWithTransform: () => copyDocumentWithTransform,
	createBufferedReadable: () => createBufferedReadable,
	createChecksumStream: () => createChecksumStream,
	dateToUtcString: () => dateToUtcString,
	deserializerMiddleware: () => deserializerMiddleware,
	deserializerMiddlewareOption: () => deserializerMiddlewareOption$1,
	expectBoolean: () => expectBoolean,
	expectByte: () => expectByte,
	expectFloat32: () => expectFloat32,
	expectInt: () => expectInt,
	expectInt32: () => expectInt32,
	expectLong: () => expectLong,
	expectNonNull: () => expectNonNull,
	expectNumber: () => expectNumber,
	expectObject: () => expectObject,
	expectShort: () => expectShort,
	expectString: () => expectString,
	expectUnion: () => expectUnion,
	fromArrayBuffer: () => fromArrayBuffer,
	fromBase64: () => fromBase64$1,
	fromHex: () => fromHex,
	fromString: () => fromString,
	fromUtf8: () => fromUtf8$1,
	generateIdempotencyToken: () => generateIdempotencyToken,
	getAwsChunkedEncodingStream: () => getAwsChunkedEncodingStream,
	getSerdePlugin: () => getSerdePlugin,
	handleFloat: () => handleFloat,
	headStream: () => headStream,
	isArrayBuffer: () => isArrayBuffer,
	isBlob: () => isBlob,
	isReadableStream: () => isReadableStream,
	limitedParseDouble: () => limitedParseDouble,
	limitedParseFloat: () => limitedParseFloat,
	limitedParseFloat32: () => limitedParseFloat32,
	logger: () => logger,
	nv: () => nv,
	parseBoolean: () => parseBoolean,
	parseEpochTimestamp: () => parseEpochTimestamp,
	parseRfc3339DateTime: () => parseRfc3339DateTime,
	parseRfc3339DateTimeWithOffset: () => parseRfc3339DateTimeWithOffset,
	parseRfc7231DateTime: () => parseRfc7231DateTime,
	quoteHeader: () => quoteHeader,
	sdkStreamMixin: () => sdkStreamMixin,
	serializerMiddleware: () => serializerMiddleware,
	serializerMiddlewareOption: () => serializerMiddlewareOption$1,
	splitEvery: () => splitEvery,
	splitHeader: () => splitHeader,
	splitStream: () => splitStream,
	strictParseByte: () => strictParseByte,
	strictParseDouble: () => strictParseDouble,
	strictParseFloat: () => strictParseFloat,
	strictParseFloat32: () => strictParseFloat32,
	strictParseInt: () => strictParseInt,
	strictParseInt32: () => strictParseInt32,
	strictParseLong: () => strictParseLong,
	strictParseShort: () => strictParseShort,
	toBase64: () => toBase64$1,
	toHex: () => toHex,
	toUint8Array: () => toUint8Array,
	toUtf8: () => toUtf8$1,
	v4: () => v4
});
var Uint8ArrayBlobAdapter, _getRandomValues, v4, generateIdempotencyToken;
var init_serde = __esmMin((() => {
	init_fromBase64();
	init_toBase64();
	init_Uint8ArrayBlobAdapter();
	init_fromUtf8();
	init_toUtf8();
	init_v4();
	init_copyDocumentWithTransform();
	init_date_utils();
	init_lazy_json();
	init_parse_utils();
	init_quote_header();
	init_schema_date_utils();
	init_split_every();
	init_split_header();
	init_NumericValue();
	init_hex_encoding();
	init_calculateBodyLength();
	init_toUint8Array();
	init_buffer_from();
	init_is_array_buffer();
	init_deserializerMiddleware();
	init_serdePlugin();
	init_serializerMiddleware();
	init_hash_node();
	init_ChecksumStream();
	init_createChecksumStream();
	init_createBufferedReadable();
	init_getAwsChunkedEncodingStream();
	init_headStream();
	init_sdk_stream_mixin();
	init_splitStream();
	init_stream_type_check();
	Uint8ArrayBlobAdapter = class extends bindUint8ArrayBlobAdapter(toUtf8$1, fromUtf8$1, toBase64$1, fromBase64$1) {};
	_getRandomValues = getRandomValues;
	v4 = bindV4(_getRandomValues);
	generateIdempotencyToken = v4;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/collect-stream-body.js
var collectBody;
var init_collect_stream_body = __esmMin((() => {
	init_serde();
	collectBody = async (streamBody = new Uint8Array(), context) => {
		if (streamBody instanceof Uint8Array) return Uint8ArrayBlobAdapter.mutate(streamBody);
		if (!streamBody) return Uint8ArrayBlobAdapter.mutate(new Uint8Array());
		const fromContext = context.streamCollector(streamBody);
		return Uint8ArrayBlobAdapter.mutate(await fromContext);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/extended-encode-uri-component.js
function extendedEncodeURIComponent(str) {
	return encodeURIComponent(str).replace(/[!'()*]/g, function(c) {
		return "%" + c.charCodeAt(0).toString(16).toUpperCase();
	});
}
var init_extended_encode_uri_component = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/SerdeContext.js
var SerdeContext;
var init_SerdeContext = __esmMin((() => {
	SerdeContext = class {
		serdeContext;
		setSerdeContext(serdeContext) {
			this.serdeContext = serdeContext;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/protocol-http/httpRequest.js
function cloneQuery(query) {
	return Object.keys(query).reduce((carry, paramName) => {
		const param = query[paramName];
		return {
			...carry,
			[paramName]: Array.isArray(param) ? [...param] : param
		};
	}, {});
}
var HttpRequest;
var init_httpRequest = __esmMin((() => {
	HttpRequest = class HttpRequest {
		method;
		protocol;
		hostname;
		port;
		path;
		query;
		headers;
		username;
		password;
		fragment;
		body;
		constructor(options) {
			this.method = options.method || "GET";
			this.hostname = options.hostname || "localhost";
			this.port = options.port;
			this.query = options.query || {};
			this.headers = options.headers || {};
			this.body = options.body;
			this.protocol = options.protocol ? options.protocol.slice(-1) !== ":" ? `${options.protocol}:` : options.protocol : "https:";
			this.path = options.path ? options.path.charAt(0) !== "/" ? `/${options.path}` : options.path : "/";
			this.username = options.username;
			this.password = options.password;
			this.fragment = options.fragment;
		}
		static clone(request) {
			const cloned = new HttpRequest({
				...request,
				headers: { ...request.headers }
			});
			if (cloned.query) cloned.query = cloneQuery(cloned.query);
			return cloned;
		}
		static isInstance(request) {
			if (!request) return false;
			const req = request;
			return "method" in req && "protocol" in req && "hostname" in req && "path" in req && typeof req["query"] === "object" && typeof req["headers"] === "object";
		}
		clone() {
			return HttpRequest.clone(this);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/protocol-http/httpResponse.js
var HttpResponse;
var init_httpResponse = __esmMin((() => {
	HttpResponse = class {
		statusCode;
		reason;
		headers;
		body;
		constructor(options) {
			this.statusCode = options.statusCode;
			this.reason = options.reason;
			this.headers = options.headers || {};
			this.body = options.body;
		}
		static isInstance(response) {
			if (!response) return false;
			const resp = response;
			return typeof resp.statusCode === "number" && typeof resp.headers === "object";
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/HttpProtocol.js
var HttpProtocol;
var init_HttpProtocol = __esmMin((() => {
	init_schema();
	init_SerdeContext();
	init_httpRequest();
	init_httpResponse();
	HttpProtocol = class extends SerdeContext {
		options;
		compositeErrorRegistry;
		constructor(options) {
			super();
			this.options = options;
			this.compositeErrorRegistry = TypeRegistry.for(options.defaultNamespace);
			for (const etr of options.errorTypeRegistries ?? []) this.compositeErrorRegistry.copyFrom(etr);
		}
		getRequestType() {
			return HttpRequest;
		}
		getResponseType() {
			return HttpResponse;
		}
		setSerdeContext(serdeContext) {
			this.serdeContext = serdeContext;
			this.serializer.setSerdeContext(serdeContext);
			this.deserializer.setSerdeContext(serdeContext);
			if (this.getPayloadCodec()) this.getPayloadCodec().setSerdeContext(serdeContext);
		}
		updateServiceEndpoint(request, endpoint) {
			if ("url" in endpoint) {
				request.protocol = endpoint.url.protocol;
				request.hostname = endpoint.url.hostname;
				request.port = endpoint.url.port ? Number(endpoint.url.port) : void 0;
				request.path = endpoint.url.pathname;
				request.fragment = endpoint.url.hash || void 0;
				request.username = endpoint.url.username || void 0;
				request.password = endpoint.url.password || void 0;
				if (!request.query) request.query = {};
				for (const [k, v] of endpoint.url.searchParams.entries()) request.query[k] = v;
				if (endpoint.headers) for (const name in endpoint.headers) request.headers[name] = endpoint.headers[name].join(", ");
				return request;
			} else {
				request.protocol = endpoint.protocol;
				request.hostname = endpoint.hostname;
				request.port = endpoint.port ? Number(endpoint.port) : void 0;
				request.path = endpoint.path;
				request.query = { ...endpoint.query };
				if (endpoint.headers) for (const name in endpoint.headers) request.headers[name] = endpoint.headers[name];
				return request;
			}
		}
		setHostPrefix(request, operationSchema, input) {
			if (this.serdeContext?.disableHostPrefix) return;
			const inputNs = NormalizedSchema.of(operationSchema.input);
			const opTraits = translateTraits(operationSchema.traits ?? {});
			if (opTraits.endpoint) {
				let hostPrefix = opTraits.endpoint?.[0];
				if (typeof hostPrefix === "string") {
					for (const [name, member] of inputNs.structIterator()) {
						if (!member.getMergedTraits().hostLabel) continue;
						const replacement = input[name];
						if (typeof replacement !== "string") throw new Error(`@smithy/core/schema - ${name} in input must be a string as hostLabel.`);
						hostPrefix = hostPrefix.replace(`{${name}}`, replacement);
					}
					request.hostname = hostPrefix + request.hostname;
				}
			}
		}
		deserializeMetadata(output) {
			return {
				httpStatusCode: output.statusCode,
				requestId: output.headers["x-amzn-requestid"] ?? output.headers["x-amzn-request-id"] ?? output.headers["x-amz-request-id"],
				extendedRequestId: output.headers["x-amz-id-2"],
				cfId: output.headers["x-amz-cf-id"]
			};
		}
		async serializeEventStream({ eventStream, requestSchema, initialRequest }) {
			return (await this.loadEventStreamCapability()).serializeEventStream({
				eventStream,
				requestSchema,
				initialRequest
			});
		}
		async deserializeEventStream({ response, responseSchema, initialResponseContainer }) {
			return (await this.loadEventStreamCapability()).deserializeEventStream({
				response,
				responseSchema,
				initialResponseContainer
			});
		}
		async loadEventStreamCapability() {
			const { EventStreamSerde } = await import("./event-streams-CE59bXid.js");
			return new EventStreamSerde({
				marshaller: this.getEventStreamMarshaller(),
				serializer: this.serializer,
				deserializer: this.deserializer,
				serdeContext: this.serdeContext,
				defaultContentType: this.getDefaultContentType()
			});
		}
		getDefaultContentType() {
			throw new Error(`@smithy/core/protocols - ${this.constructor.name} getDefaultContentType() implementation missing.`);
		}
		async deserializeHttpMessage(schema, context, response, arg4, arg5) {
			return [];
		}
		getEventStreamMarshaller() {
			const context = this.serdeContext;
			if (!context.eventStreamMarshaller) throw new Error("@smithy/core - HttpProtocol: eventStreamMarshaller missing in serdeContext.");
			return context.eventStreamMarshaller;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/HttpBindingProtocol.js
var HttpBindingProtocol;
var init_HttpBindingProtocol = __esmMin((() => {
	init_schema();
	init_serde();
	init_HttpProtocol();
	init_collect_stream_body();
	init_extended_encode_uri_component();
	init_httpRequest();
	HttpBindingProtocol = class extends HttpProtocol {
		async serializeRequest(operationSchema, _input, context) {
			const input = _input && typeof _input === "object" ? _input : {};
			const serializer = this.serializer;
			const query = {};
			const headers = {};
			const endpoint = await context.endpoint();
			const ns = NormalizedSchema.of(operationSchema?.input);
			const payloadMemberNames = [];
			const payloadMemberSchemas = [];
			let hasNonHttpBindingMember = false;
			let payload;
			const request = new HttpRequest({
				protocol: "",
				hostname: "",
				port: void 0,
				path: "",
				fragment: void 0,
				query,
				headers,
				body: void 0
			});
			if (endpoint) {
				this.updateServiceEndpoint(request, endpoint);
				this.setHostPrefix(request, operationSchema, input);
				const opTraits = translateTraits(operationSchema.traits);
				if (opTraits.http) {
					request.method = opTraits.http[0];
					const [path, search] = opTraits.http[1].split("?");
					if (request.path == "/") request.path = path;
					else request.path += path;
					const traitSearchParams = new URLSearchParams(search ?? "");
					for (const [key, value] of traitSearchParams) query[key] = value;
				}
			}
			for (const [memberName, memberNs] of ns.structIterator()) {
				const memberTraits = memberNs.getMergedTraits() ?? {};
				const inputMemberValue = input[memberName];
				if (inputMemberValue == null && !memberNs.isIdempotencyToken()) {
					if (memberTraits.httpLabel) {
						if (request.path.includes(`{${memberName}+}`) || request.path.includes(`{${memberName}}`)) throw new Error(`No value provided for input HTTP label: ${memberName}.`);
					}
					continue;
				}
				if (memberTraits.httpPayload) if (memberNs.isStreaming()) if (memberNs.isStructSchema()) {
					if (input[memberName]) payload = await this.serializeEventStream({
						eventStream: input[memberName],
						requestSchema: ns
					});
				} else payload = inputMemberValue;
				else {
					serializer.write(memberNs, inputMemberValue);
					payload = serializer.flush();
				}
				else if (memberTraits.httpLabel) {
					serializer.write(memberNs, inputMemberValue);
					const replacement = serializer.flush();
					if (request.path.includes(`{${memberName}+}`)) request.path = request.path.replace(`{${memberName}+}`, replacement.split("/").map(extendedEncodeURIComponent).join("/"));
					else if (request.path.includes(`{${memberName}}`)) request.path = request.path.replace(`{${memberName}}`, extendedEncodeURIComponent(replacement));
				} else if (memberTraits.httpHeader) {
					serializer.write(memberNs, inputMemberValue);
					headers[memberTraits.httpHeader.toLowerCase()] = String(serializer.flush());
				} else if (typeof memberTraits.httpPrefixHeaders === "string") for (const key in inputMemberValue) {
					const val = inputMemberValue[key];
					const amalgam = memberTraits.httpPrefixHeaders + key;
					serializer.write([memberNs.getValueSchema(), { httpHeader: amalgam }], val);
					headers[amalgam.toLowerCase()] = serializer.flush();
				}
				else if (memberTraits.httpQuery || memberTraits.httpQueryParams) this.serializeQuery(memberNs, inputMemberValue, query);
				else {
					hasNonHttpBindingMember = true;
					payloadMemberNames.push(memberName);
					payloadMemberSchemas.push(memberNs);
				}
			}
			if (hasNonHttpBindingMember && input) {
				const [namespace, name] = (ns.getName(true) ?? "#Unknown").split("#");
				const requiredMembers = ns.getSchema()[6];
				const payloadSchema = [
					3,
					namespace,
					name,
					ns.getMergedTraits(),
					payloadMemberNames,
					payloadMemberSchemas,
					void 0
				];
				if (requiredMembers) payloadSchema[6] = requiredMembers;
				else payloadSchema.pop();
				serializer.write(payloadSchema, input);
				payload = serializer.flush();
			}
			request.headers = headers;
			request.query = query;
			request.body = payload;
			return request;
		}
		serializeQuery(ns, data, query) {
			const serializer = this.serializer;
			const traits = ns.getMergedTraits();
			if (traits.httpQueryParams) {
				for (const key in data) if (!(key in query)) {
					const val = data[key];
					const valueSchema = ns.getValueSchema();
					Object.assign(valueSchema.getMergedTraits(), {
						...traits,
						httpQuery: key,
						httpQueryParams: void 0
					});
					this.serializeQuery(valueSchema, val, query);
				}
				return;
			}
			if (ns.isListSchema()) {
				const sparse = !!ns.getMergedTraits().sparse;
				const buffer = [];
				for (const item of data) {
					serializer.write([ns.getValueSchema(), traits], item);
					const serializable = serializer.flush();
					if (sparse || serializable !== void 0) buffer.push(serializable);
				}
				query[traits.httpQuery] = buffer;
			} else {
				serializer.write([ns, traits], data);
				query[traits.httpQuery] = serializer.flush();
			}
		}
		async deserializeResponse(operationSchema, context, response) {
			const deserializer = this.deserializer;
			const ns = NormalizedSchema.of(operationSchema.output);
			const dataObject = {};
			if (response.statusCode >= 300) {
				const bytes = await collectBody(response.body, context);
				if (bytes.byteLength > 0) Object.assign(dataObject, await deserializer.read(15, bytes));
				await this.handleError(operationSchema, context, response, dataObject, this.deserializeMetadata(response));
				throw new Error("@smithy/core/protocols - HTTP Protocol error handler failed to throw.");
			}
			for (const header in response.headers) {
				const value = response.headers[header];
				delete response.headers[header];
				response.headers[header.toLowerCase()] = value;
			}
			const nonHttpBindingMembers = await this.deserializeHttpMessage(ns, context, response, dataObject);
			if (nonHttpBindingMembers.length) {
				const bytes = await collectBody(response.body, context);
				if (bytes.byteLength > 0) {
					const dataFromBody = await deserializer.read(ns, bytes);
					for (const member of nonHttpBindingMembers) if (dataFromBody[member] != null) dataObject[member] = dataFromBody[member];
				}
			} else if (nonHttpBindingMembers.discardResponseBody) await collectBody(response.body, context);
			dataObject.$metadata = this.deserializeMetadata(response);
			return dataObject;
		}
		async deserializeHttpMessage(schema, context, response, arg4, arg5) {
			let dataObject;
			if (arg4 instanceof Set) dataObject = arg5;
			else dataObject = arg4;
			let discardResponseBody = true;
			const deserializer = this.deserializer;
			const ns = NormalizedSchema.of(schema);
			const nonHttpBindingMembers = [];
			for (const [memberName, memberSchema] of ns.structIterator()) {
				const memberTraits = memberSchema.getMemberTraits();
				if (memberTraits.httpPayload) {
					discardResponseBody = false;
					if (memberSchema.isStreaming()) if (memberSchema.isStructSchema()) dataObject[memberName] = await this.deserializeEventStream({
						response,
						responseSchema: ns
					});
					else dataObject[memberName] = sdkStreamMixin(response.body);
					else if (response.body) {
						const bytes = await collectBody(response.body, context);
						if (bytes.byteLength > 0) dataObject[memberName] = await deserializer.read(memberSchema, bytes);
					}
				} else if (memberTraits.httpHeader) {
					const key = String(memberTraits.httpHeader).toLowerCase();
					const value = response.headers[key];
					if (null != value) if (memberSchema.isListSchema()) {
						const headerListValueSchema = memberSchema.getValueSchema();
						headerListValueSchema.getMergedTraits().httpHeader = key;
						let sections;
						if (headerListValueSchema.isTimestampSchema() && headerListValueSchema.getSchema() === 4) sections = splitEvery(value, ",", 2);
						else sections = splitHeader(value);
						const list = [];
						for (const section of sections) list.push(await deserializer.read(headerListValueSchema, section.trim()));
						dataObject[memberName] = list;
					} else dataObject[memberName] = await deserializer.read(memberSchema, value);
				} else if (memberTraits.httpPrefixHeaders !== void 0) {
					dataObject[memberName] = {};
					for (const header in response.headers) if (header.startsWith(memberTraits.httpPrefixHeaders)) {
						const value = response.headers[header];
						const valueSchema = memberSchema.getValueSchema();
						valueSchema.getMergedTraits().httpHeader = header;
						dataObject[memberName][header.slice(memberTraits.httpPrefixHeaders.length)] = await deserializer.read(valueSchema, value);
					}
				} else if (memberTraits.httpResponseCode) dataObject[memberName] = response.statusCode;
				else nonHttpBindingMembers.push(memberName);
			}
			nonHttpBindingMembers.discardResponseBody = discardResponseBody;
			return nonHttpBindingMembers;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/RpcProtocol.js
var RpcProtocol;
var init_RpcProtocol = __esmMin((() => {
	init_schema();
	init_HttpProtocol();
	init_collect_stream_body();
	init_httpRequest();
	RpcProtocol = class extends HttpProtocol {
		async serializeRequest(operationSchema, _input, context) {
			const serializer = this.serializer;
			const query = {};
			const headers = {};
			const endpoint = await context.endpoint();
			const ns = NormalizedSchema.of(operationSchema?.input);
			const schema = ns.getSchema();
			let payload;
			const input = _input && typeof _input === "object" ? _input : {};
			const request = new HttpRequest({
				protocol: "",
				hostname: "",
				port: void 0,
				path: "/",
				fragment: void 0,
				query,
				headers,
				body: void 0
			});
			if (endpoint) {
				this.updateServiceEndpoint(request, endpoint);
				this.setHostPrefix(request, operationSchema, input);
			}
			if (input) {
				const eventStreamMember = ns.getEventStreamMember();
				if (eventStreamMember) {
					if (input[eventStreamMember]) {
						const initialRequest = {};
						for (const [memberName, memberSchema] of ns.structIterator()) if (memberName !== eventStreamMember && input[memberName]) {
							serializer.write(memberSchema, input[memberName]);
							initialRequest[memberName] = serializer.flush();
						}
						payload = await this.serializeEventStream({
							eventStream: input[eventStreamMember],
							requestSchema: ns,
							initialRequest
						});
					}
				} else {
					serializer.write(schema, input);
					payload = serializer.flush();
				}
			}
			request.headers = Object.assign(request.headers, headers);
			request.query = query;
			request.body = payload;
			request.method = "POST";
			return request;
		}
		async deserializeResponse(operationSchema, context, response) {
			const deserializer = this.deserializer;
			const ns = NormalizedSchema.of(operationSchema.output);
			const dataObject = {};
			if (response.statusCode >= 300) {
				const bytes = await collectBody(response.body, context);
				if (bytes.byteLength > 0) Object.assign(dataObject, await deserializer.read(15, bytes));
				await this.handleError(operationSchema, context, response, dataObject, this.deserializeMetadata(response));
				throw new Error("@smithy/core/protocols - RPC Protocol error handler failed to throw.");
			}
			for (const header in response.headers) {
				const value = response.headers[header];
				delete response.headers[header];
				response.headers[header.toLowerCase()] = value;
			}
			const eventStreamMember = ns.getEventStreamMember();
			if (eventStreamMember) dataObject[eventStreamMember] = await this.deserializeEventStream({
				response,
				responseSchema: ns,
				initialResponseContainer: dataObject
			});
			else {
				const bytes = await collectBody(response.body, context);
				if (bytes.byteLength > 0) Object.assign(dataObject, await deserializer.read(ns, bytes));
			}
			dataObject.$metadata = this.deserializeMetadata(response);
			return dataObject;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/resolve-path.js
var resolvedPath;
var init_resolve_path = __esmMin((() => {
	init_extended_encode_uri_component();
	resolvedPath = (resolvedPath, input, memberName, labelValueProvider, uriLabel, isGreedyLabel) => {
		if (input != null && input[memberName] !== void 0) {
			const labelValue = labelValueProvider();
			if (labelValue == null || labelValue.length <= 0) throw new Error("Empty value provided for input HTTP label: " + memberName + ".");
			resolvedPath = resolvedPath.replace(uriLabel, isGreedyLabel ? labelValue.split("/").map((segment) => extendedEncodeURIComponent(segment)).join("/") : extendedEncodeURIComponent(labelValue));
		} else throw new Error("No value provided for input HTTP label: " + memberName + ".");
		return resolvedPath;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/requestBuilder.js
function requestBuilder(input, context) {
	return new RequestBuilder(input, context);
}
var RequestBuilder;
var init_requestBuilder = __esmMin((() => {
	init_httpRequest();
	init_resolve_path();
	RequestBuilder = class {
		input;
		context;
		query = {};
		method = "";
		headers = {};
		path = "";
		body = null;
		hostname = "";
		resolvePathStack = [];
		constructor(input, context) {
			this.input = input;
			this.context = context;
		}
		async build() {
			const { hostname, protocol = "https", port, path: basePath } = await this.context.endpoint();
			this.path = basePath;
			for (const resolvePath of this.resolvePathStack) resolvePath(this.path);
			return new HttpRequest({
				protocol,
				hostname: this.hostname || hostname,
				port,
				method: this.method,
				path: this.path,
				query: this.query,
				body: this.body,
				headers: this.headers
			});
		}
		hn(hostname) {
			this.hostname = hostname;
			return this;
		}
		bp(uriLabel) {
			this.resolvePathStack.push((basePath) => {
				this.path = `${basePath?.endsWith("/") ? basePath.slice(0, -1) : basePath || ""}` + uriLabel;
			});
			return this;
		}
		p(memberName, labelValueProvider, uriLabel, isGreedyLabel) {
			this.resolvePathStack.push((path) => {
				this.path = resolvedPath(path, this.input, memberName, labelValueProvider, uriLabel, isGreedyLabel);
			});
			return this;
		}
		h(headers) {
			this.headers = headers;
			return this;
		}
		q(query) {
			this.query = query;
			return this;
		}
		b(body) {
			this.body = body;
			return this;
		}
		m(method) {
			this.method = method;
			return this;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/serde/determineTimestampFormat.js
function determineTimestampFormat(ns, settings) {
	if (settings.timestampFormat.useTrait) {
		if (ns.isTimestampSchema() && (ns.getSchema() === 5 || ns.getSchema() === 6 || ns.getSchema() === 7)) return ns.getSchema();
	}
	const { httpLabel, httpPrefixHeaders, httpHeader, httpQuery } = ns.getMergedTraits();
	return (settings.httpBindings ? typeof httpPrefixHeaders === "string" || Boolean(httpHeader) ? 6 : Boolean(httpQuery) || Boolean(httpLabel) ? 5 : void 0 : void 0) ?? settings.timestampFormat.default;
}
var init_determineTimestampFormat = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/serde/FromStringShapeDeserializer.js
var FromStringShapeDeserializer;
var init_FromStringShapeDeserializer = __esmMin((() => {
	init_schema();
	init_serde();
	init_SerdeContext();
	init_determineTimestampFormat();
	FromStringShapeDeserializer = class extends SerdeContext {
		settings;
		constructor(settings) {
			super();
			this.settings = settings;
		}
		read(_schema, data) {
			const ns = NormalizedSchema.of(_schema);
			if (ns.isListSchema()) return splitHeader(data).map((item) => this.read(ns.getValueSchema(), item));
			if (ns.isBlobSchema()) return (this.serdeContext?.base64Decoder ?? fromBase64$1)(data);
			if (ns.isTimestampSchema()) switch (determineTimestampFormat(ns, this.settings)) {
				case 5: return _parseRfc3339DateTimeWithOffset(data);
				case 6: return _parseRfc7231DateTime(data);
				case 7: return _parseEpochTimestamp(data);
				default:
					console.warn("Missing timestamp format, parsing value with Date constructor:", data);
					return new Date(data);
			}
			if (ns.isStringSchema()) {
				const mediaType = ns.getMergedTraits().mediaType;
				let intermediateValue = data;
				if (mediaType) {
					if (ns.getMergedTraits().httpHeader) intermediateValue = this.base64ToUtf8(intermediateValue);
					if (mediaType === "application/json" || mediaType.endsWith("+json")) intermediateValue = LazyJsonString.from(intermediateValue);
					return intermediateValue;
				}
			}
			if (ns.isNumericSchema()) return Number(data);
			if (ns.isBigIntegerSchema()) return BigInt(data);
			if (ns.isBigDecimalSchema()) return new NumericValue(data, "bigDecimal");
			if (ns.isBooleanSchema()) return String(data).toLowerCase() === "true";
			return data;
		}
		base64ToUtf8(base64String) {
			return (this.serdeContext?.utf8Encoder ?? toUtf8$1)((this.serdeContext?.base64Decoder ?? fromBase64$1)(base64String));
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/serde/HttpInterceptingShapeDeserializer.js
var HttpInterceptingShapeDeserializer;
var init_HttpInterceptingShapeDeserializer = __esmMin((() => {
	init_schema();
	init_serde();
	init_SerdeContext();
	init_FromStringShapeDeserializer();
	HttpInterceptingShapeDeserializer = class extends SerdeContext {
		codecDeserializer;
		stringDeserializer;
		constructor(codecDeserializer, codecSettings) {
			super();
			this.codecDeserializer = codecDeserializer;
			this.stringDeserializer = new FromStringShapeDeserializer(codecSettings);
		}
		setSerdeContext(serdeContext) {
			this.stringDeserializer.setSerdeContext(serdeContext);
			this.codecDeserializer.setSerdeContext(serdeContext);
			this.serdeContext = serdeContext;
		}
		read(schema, data) {
			const ns = NormalizedSchema.of(schema);
			const traits = ns.getMergedTraits();
			const toString = this.serdeContext?.utf8Encoder ?? toUtf8$1;
			if (traits.httpHeader || traits.httpResponseCode) return this.stringDeserializer.read(ns, toString(data));
			if (traits.httpPayload) {
				if (ns.isBlobSchema()) {
					const toBytes = this.serdeContext?.utf8Decoder ?? fromUtf8$1;
					if (typeof data === "string") return toBytes(data);
					return data;
				} else if (ns.isStringSchema()) {
					if ("byteLength" in data) return toString(data);
					return data;
				}
			}
			return this.codecDeserializer.read(ns, data);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/serde/ToStringShapeSerializer.js
var ToStringShapeSerializer;
var init_ToStringShapeSerializer = __esmMin((() => {
	init_schema();
	init_serde();
	init_SerdeContext();
	init_determineTimestampFormat();
	ToStringShapeSerializer = class extends SerdeContext {
		settings;
		stringBuffer = "";
		constructor(settings) {
			super();
			this.settings = settings;
		}
		write(schema, value) {
			const ns = NormalizedSchema.of(schema);
			switch (typeof value) {
				case "object":
					if (value === null) {
						this.stringBuffer = "null";
						return;
					}
					if (ns.isTimestampSchema()) {
						if (!(value instanceof Date)) throw new Error(`@smithy/core/protocols - received non-Date value ${value} when schema expected Date in ${ns.getName(true)}`);
						switch (determineTimestampFormat(ns, this.settings)) {
							case 5:
								this.stringBuffer = value.toISOString().replace(".000Z", "Z");
								break;
							case 6:
								this.stringBuffer = dateToUtcString(value);
								break;
							case 7:
								this.stringBuffer = String(value.getTime() / 1e3);
								break;
							default:
								console.warn("Missing timestamp format, using epoch seconds", value);
								this.stringBuffer = String(value.getTime() / 1e3);
						}
						return;
					}
					if (ns.isBlobSchema() && "byteLength" in value) {
						this.stringBuffer = (this.serdeContext?.base64Encoder ?? toBase64$1)(value);
						return;
					}
					if (ns.isListSchema() && Array.isArray(value)) {
						let buffer = "";
						for (const item of value) {
							this.write([ns.getValueSchema(), ns.getMergedTraits()], item);
							const headerItem = this.flush();
							const serialized = ns.getValueSchema().isTimestampSchema() ? headerItem : quoteHeader(headerItem);
							if (buffer !== "") buffer += ", ";
							buffer += serialized;
						}
						this.stringBuffer = buffer;
						return;
					}
					this.stringBuffer = JSON.stringify(value, null, 2);
					break;
				case "string":
					const mediaType = ns.getMergedTraits().mediaType;
					let intermediateValue = value;
					if (mediaType) {
						if (mediaType === "application/json" || mediaType.endsWith("+json")) intermediateValue = LazyJsonString.from(intermediateValue);
						if (ns.getMergedTraits().httpHeader) {
							this.stringBuffer = (this.serdeContext?.base64Encoder ?? toBase64$1)(intermediateValue.toString());
							return;
						}
					}
					this.stringBuffer = value;
					break;
				default: if (ns.isIdempotencyToken()) this.stringBuffer = generateIdempotencyToken();
				else this.stringBuffer = String(value);
			}
		}
		flush() {
			const buffer = this.stringBuffer;
			this.stringBuffer = "";
			return buffer;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/serde/HttpInterceptingShapeSerializer.js
var HttpInterceptingShapeSerializer;
var init_HttpInterceptingShapeSerializer = __esmMin((() => {
	init_schema();
	init_ToStringShapeSerializer();
	HttpInterceptingShapeSerializer = class {
		codecSerializer;
		stringSerializer;
		buffer;
		constructor(codecSerializer, codecSettings, stringSerializer = new ToStringShapeSerializer(codecSettings)) {
			this.codecSerializer = codecSerializer;
			this.stringSerializer = stringSerializer;
		}
		setSerdeContext(serdeContext) {
			this.codecSerializer.setSerdeContext(serdeContext);
			this.stringSerializer.setSerdeContext(serdeContext);
		}
		write(schema, value) {
			const ns = NormalizedSchema.of(schema);
			const traits = ns.getMergedTraits();
			if (traits.httpHeader || traits.httpLabel || traits.httpQuery) {
				this.stringSerializer.write(ns, value);
				this.buffer = this.stringSerializer.flush();
				return;
			}
			return this.codecSerializer.write(ns, value);
		}
		flush() {
			if (this.buffer !== void 0) {
				const buffer = this.buffer;
				this.buffer = void 0;
				return buffer;
			}
			return this.codecSerializer.flush();
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/protocol-http/Field.js
var import_dist_cjs$2, Field;
var init_Field = __esmMin((() => {
	import_dist_cjs$2 = require_dist_cjs();
	Field = class {
		name;
		kind;
		values;
		constructor({ name, kind = import_dist_cjs$2.FieldPosition.HEADER, values = [] }) {
			this.name = name;
			this.kind = kind;
			this.values = values;
		}
		add(value) {
			this.values.push(value);
		}
		set(values) {
			this.values = values;
		}
		remove(value) {
			this.values = this.values.filter((v) => v !== value);
		}
		toString() {
			return this.values.map((v) => v.includes(",") || v.includes(" ") ? `"${v}"` : v).join(", ");
		}
		get() {
			return this.values;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/protocol-http/Fields.js
var Fields;
var init_Fields = __esmMin((() => {
	Fields = class {
		entries = {};
		encoding;
		constructor({ fields = [], encoding = "utf-8" }) {
			fields.forEach(this.setField.bind(this));
			this.encoding = encoding;
		}
		setField(field) {
			this.entries[field.name.toLowerCase()] = field;
		}
		getField(name) {
			return this.entries[name.toLowerCase()];
		}
		removeField(name) {
			delete this.entries[name.toLowerCase()];
		}
		getByType(kind) {
			return Object.values(this.entries).filter((field) => field.kind === kind);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/protocol-http/isValidHostname.js
function isValidHostname(hostname) {
	return /^[a-z0-9][a-z0-9\.\-]*[a-z0-9]$/.test(hostname);
}
var init_isValidHostname = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/protocol-http/extensions/httpExtensionConfiguration.js
var getHttpHandlerExtensionConfiguration, resolveHttpHandlerRuntimeConfig;
var init_httpExtensionConfiguration = __esmMin((() => {
	getHttpHandlerExtensionConfiguration = (runtimeConfig) => {
		return {
			setHttpHandler(handler) {
				runtimeConfig.httpHandler = handler;
			},
			httpHandler() {
				return runtimeConfig.httpHandler;
			},
			updateHttpClientConfig(key, value) {
				runtimeConfig.httpHandler?.updateHttpClientConfig(key, value);
			},
			httpHandlerConfigs() {
				return runtimeConfig.httpHandler.httpHandlerConfigs();
			}
		};
	};
	resolveHttpHandlerRuntimeConfig = (httpHandlerExtensionConfiguration) => {
		return { httpHandler: httpHandlerExtensionConfiguration.httpHandler() };
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/middleware-content-length/contentLengthMiddleware.js
function contentLengthMiddleware(bodyLengthChecker) {
	return (next) => async (args) => {
		const request = args.request;
		if (HttpRequest.isInstance(request)) {
			const { body, headers } = request;
			if (body && Object.keys(headers).map((str) => str.toLowerCase()).indexOf(CONTENT_LENGTH_HEADER) === -1) try {
				const length = bodyLengthChecker(body);
				request.headers = {
					...request.headers,
					[CONTENT_LENGTH_HEADER]: String(length)
				};
			} catch (error) {}
		}
		return next({
			...args,
			request
		});
	};
}
var CONTENT_LENGTH_HEADER, contentLengthMiddlewareOptions, getContentLengthPlugin;
var init_contentLengthMiddleware = __esmMin((() => {
	init_httpRequest();
	CONTENT_LENGTH_HEADER = "content-length";
	contentLengthMiddlewareOptions = {
		step: "build",
		tags: ["SET_CONTENT_LENGTH", "CONTENT_LENGTH"],
		name: "contentLengthMiddleware",
		override: true
	};
	getContentLengthPlugin = (options) => ({ applyToStack: (clientStack) => {
		clientStack.add(contentLengthMiddleware(options.bodyLengthChecker), contentLengthMiddlewareOptions);
	} });
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/util-uri-escape/escape-uri.js
var escapeUri, hexEncode;
var init_escape_uri = __esmMin((() => {
	escapeUri = (uri) => encodeURIComponent(uri).replace(/[!'()*]/g, hexEncode);
	hexEncode = (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/util-uri-escape/escape-uri-path.js
var escapeUriPath;
var init_escape_uri_path = __esmMin((() => {
	init_escape_uri();
	escapeUriPath = (uri) => uri.split("/").map(escapeUri).join("/");
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/querystring-builder/buildQueryString.js
function buildQueryString(query) {
	const parts = [];
	for (let key of Object.keys(query).sort()) {
		const value = query[key];
		key = escapeUri(key);
		if (Array.isArray(value)) for (let i = 0, iLen = value.length; i < iLen; i++) parts.push(`${key}=${escapeUri(value[i])}`);
		else {
			let qsEntry = key;
			if (value || typeof value === "string") qsEntry += `=${escapeUri(value)}`;
			parts.push(qsEntry);
		}
	}
	return parts.join("&");
}
var init_buildQueryString = __esmMin((() => {
	init_escape_uri();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/querystring-parser/parseQueryString.js
function parseQueryString(querystring) {
	const query = {};
	querystring = querystring.replace(/^\?/, "");
	if (querystring) for (const pair of querystring.split("&")) {
		let [key, value = null] = pair.split("=");
		key = decodeURIComponent(key);
		if (value) value = decodeURIComponent(value);
		if (!(key in query)) query[key] = value;
		else if (Array.isArray(query[key])) query[key].push(value);
		else query[key] = [query[key], value];
	}
	return query;
}
var init_parseQueryString = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/url-parser/parseUrl.js
var parseUrl;
var init_parseUrl = __esmMin((() => {
	init_parseQueryString();
	parseUrl = (url) => {
		if (typeof url === "string") return parseUrl(new URL(url));
		const { hostname, pathname, port, protocol, search } = url;
		let query;
		if (search) query = parseQueryString(search);
		return {
			hostname,
			port: port ? parseInt(port) : void 0,
			protocol,
			path: pathname,
			query
		};
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/protocols/index.js
var protocols_exports = /* @__PURE__ */ __exportAll({
	Field: () => Field,
	Fields: () => Fields,
	FromStringShapeDeserializer: () => FromStringShapeDeserializer,
	HttpBindingProtocol: () => HttpBindingProtocol,
	HttpInterceptingShapeDeserializer: () => HttpInterceptingShapeDeserializer,
	HttpInterceptingShapeSerializer: () => HttpInterceptingShapeSerializer,
	HttpProtocol: () => HttpProtocol,
	HttpRequest: () => HttpRequest,
	HttpResponse: () => HttpResponse,
	RequestBuilder: () => RequestBuilder,
	RpcProtocol: () => RpcProtocol,
	SerdeContext: () => SerdeContext,
	ToStringShapeSerializer: () => ToStringShapeSerializer,
	buildQueryString: () => buildQueryString,
	collectBody: () => collectBody,
	contentLengthMiddleware: () => contentLengthMiddleware,
	contentLengthMiddlewareOptions: () => contentLengthMiddlewareOptions,
	determineTimestampFormat: () => determineTimestampFormat,
	escapeUri: () => escapeUri,
	escapeUriPath: () => escapeUriPath,
	extendedEncodeURIComponent: () => extendedEncodeURIComponent,
	getContentLengthPlugin: () => getContentLengthPlugin,
	getHttpHandlerExtensionConfiguration: () => getHttpHandlerExtensionConfiguration,
	isValidHostname: () => isValidHostname,
	parseQueryString: () => parseQueryString,
	parseUrl: () => parseUrl,
	requestBuilder: () => requestBuilder,
	resolveHttpHandlerRuntimeConfig: () => resolveHttpHandlerRuntimeConfig,
	resolvedPath: () => resolvedPath
});
var init_protocols = __esmMin((() => {
	init_collect_stream_body();
	init_extended_encode_uri_component();
	init_HttpBindingProtocol();
	init_HttpProtocol();
	init_RpcProtocol();
	init_requestBuilder();
	init_resolve_path();
	init_FromStringShapeDeserializer();
	init_HttpInterceptingShapeDeserializer();
	init_HttpInterceptingShapeSerializer();
	init_ToStringShapeSerializer();
	init_determineTimestampFormat();
	init_SerdeContext();
	init_Field();
	init_Fields();
	init_httpRequest();
	init_httpResponse();
	init_isValidHostname();
	init_httpExtensionConfiguration();
	init_contentLengthMiddleware();
	init_escape_uri();
	init_escape_uri_path();
	init_buildQueryString();
	init_parseQueryString();
	init_parseUrl();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/schemas/operation.js
var operation;
var init_operation = __esmMin((() => {
	operation = (namespace, name, traits, input, output) => ({
		name,
		namespace,
		traits,
		input,
		output
	});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/middleware/schemaDeserializationMiddleware.js
var schemaDeserializationMiddleware, findHeader;
var init_schemaDeserializationMiddleware = __esmMin((() => {
	init_client();
	init_protocols();
	init_operation();
	schemaDeserializationMiddleware = (config) => (next, context) => async (args) => {
		const { response } = await next(args);
		const { operationSchema } = getSmithyContext(context);
		const [, ns, n, t, i, o] = operationSchema ?? [];
		try {
			return {
				response,
				output: await config.protocol.deserializeResponse(operation(ns, n, t, i, o), {
					...config,
					...context
				}, response)
			};
		} catch (error) {
			Object.defineProperty(error, "$response", {
				value: response,
				enumerable: false,
				writable: false,
				configurable: false
			});
			if (!("$metadata" in error)) {
				const hint = `Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object.`;
				try {
					error.message += "\n  " + hint;
				} catch (e) {
					if (!context.logger || context.logger?.constructor?.name === "NoOpLogger") console.warn(hint);
					else context.logger?.warn?.(hint);
				}
				if (typeof error.$responseBodyText !== "undefined") {
					if (error.$response) error.$response.body = error.$responseBodyText;
				}
				try {
					if (HttpResponse.isInstance(response)) {
						const { headers = {} } = response;
						const headerEntries = Object.entries(headers);
						error.$metadata = {
							httpStatusCode: response.statusCode,
							requestId: findHeader(/^x-[\w-]+-request-?id$/, headerEntries),
							extendedRequestId: findHeader(/^x-[\w-]+-id-2$/, headerEntries),
							cfId: findHeader(/^x-[\w-]+-cf-id$/, headerEntries)
						};
					}
				} catch (e) {}
			}
			throw error;
		}
	};
	findHeader = (pattern, headers) => {
		return (headers.find(([k]) => {
			return k.match(pattern);
		}) || [void 0, void 0])[1];
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/middleware/schemaSerializationMiddleware.js
var schemaSerializationMiddleware;
var init_schemaSerializationMiddleware = __esmMin((() => {
	init_client();
	init_endpoints();
	init_operation();
	schemaSerializationMiddleware = (config) => (next, context) => async (args) => {
		const { operationSchema } = getSmithyContext(context);
		const [, ns, n, t, i, o] = operationSchema ?? [];
		const endpoint = context.endpointV2 ? async () => toEndpointV1(context.endpointV2) : config.endpoint;
		const request = await config.protocol.serializeRequest(operation(ns, n, t, i, o), args.input, {
			...config,
			...context,
			endpoint
		});
		return next({
			...args,
			request
		});
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/middleware/getSchemaSerdePlugin.js
function getSchemaSerdePlugin(config) {
	return { applyToStack: (commandStack) => {
		commandStack.add(schemaSerializationMiddleware(config), serializerMiddlewareOption);
		commandStack.add(schemaDeserializationMiddleware(config), deserializerMiddlewareOption);
		config.protocol.setSerdeContext(config);
	} };
}
var deserializerMiddlewareOption, serializerMiddlewareOption;
var init_getSchemaSerdePlugin = __esmMin((() => {
	init_schemaDeserializationMiddleware();
	init_schemaSerializationMiddleware();
	deserializerMiddlewareOption = {
		name: "deserializerMiddleware",
		step: "deserialize",
		tags: ["DESERIALIZER"],
		override: true
	};
	serializerMiddlewareOption = {
		name: "serializerMiddleware",
		step: "serialize",
		tags: ["SERIALIZER"],
		override: true
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/schemas/Schema.js
var Schema;
var init_Schema = __esmMin((() => {
	Schema = class {
		name;
		namespace;
		traits;
		static assign(instance, values) {
			return Object.assign(instance, values);
		}
		static [Symbol.hasInstance](lhs) {
			const isPrototype = this.prototype.isPrototypeOf(lhs);
			if (!isPrototype && typeof lhs === "object" && lhs !== null) return lhs.symbol === this.symbol;
			return isPrototype;
		}
		getName() {
			return this.namespace + "#" + this.name;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/schemas/ListSchema.js
var ListSchema, list;
var init_ListSchema = __esmMin((() => {
	init_Schema();
	ListSchema = class ListSchema extends Schema {
		static symbol = Symbol.for("@smithy/lis");
		name;
		traits;
		valueSchema;
		symbol = ListSchema.symbol;
	};
	list = (namespace, name, traits, valueSchema) => Schema.assign(new ListSchema(), {
		name,
		namespace,
		traits,
		valueSchema
	});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/schemas/MapSchema.js
var MapSchema, map$1;
var init_MapSchema = __esmMin((() => {
	init_Schema();
	MapSchema = class MapSchema extends Schema {
		static symbol = Symbol.for("@smithy/map");
		name;
		traits;
		keySchema;
		valueSchema;
		symbol = MapSchema.symbol;
	};
	map$1 = (namespace, name, traits, keySchema, valueSchema) => Schema.assign(new MapSchema(), {
		name,
		namespace,
		traits,
		keySchema,
		valueSchema
	});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/schemas/OperationSchema.js
var OperationSchema, op;
var init_OperationSchema = __esmMin((() => {
	init_Schema();
	OperationSchema = class OperationSchema extends Schema {
		static symbol = Symbol.for("@smithy/ope");
		name;
		traits;
		input;
		output;
		symbol = OperationSchema.symbol;
	};
	op = (namespace, name, traits, input, output) => Schema.assign(new OperationSchema(), {
		name,
		namespace,
		traits,
		input,
		output
	});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/schemas/StructureSchema.js
var StructureSchema, struct;
var init_StructureSchema = __esmMin((() => {
	init_Schema();
	StructureSchema = class StructureSchema extends Schema {
		static symbol = Symbol.for("@smithy/str");
		name;
		traits;
		memberNames;
		memberList;
		symbol = StructureSchema.symbol;
	};
	struct = (namespace, name, traits, memberNames, memberList) => Schema.assign(new StructureSchema(), {
		name,
		namespace,
		traits,
		memberNames,
		memberList
	});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/schemas/ErrorSchema.js
var ErrorSchema, error;
var init_ErrorSchema = __esmMin((() => {
	init_Schema();
	init_StructureSchema();
	ErrorSchema = class ErrorSchema extends StructureSchema {
		static symbol = Symbol.for("@smithy/err");
		ctor;
		symbol = ErrorSchema.symbol;
	};
	error = (namespace, name, traits, memberNames, memberList, ctor) => Schema.assign(new ErrorSchema(), {
		name,
		namespace,
		traits,
		memberNames,
		memberList,
		ctor: null
	});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/schemas/translateTraits.js
function translateTraits(indicator) {
	if (typeof indicator === "object") return indicator;
	indicator = indicator | 0;
	if (traitsCache[indicator]) return traitsCache[indicator];
	const traits = {};
	let i = 0;
	for (const trait of [
		"httpLabel",
		"idempotent",
		"idempotencyToken",
		"sensitive",
		"httpPayload",
		"httpResponseCode",
		"httpQueryParams"
	]) if ((indicator >> i++ & 1) === 1) traits[trait] = 1;
	return traitsCache[indicator] = traits;
}
var traitsCache;
var init_translateTraits = __esmMin((() => {
	traitsCache = [];
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/schemas/NormalizedSchema.js
function member(memberSchema, memberName) {
	if (memberSchema instanceof NormalizedSchema) return Object.assign(memberSchema, {
		memberName,
		_isMemberSchema: true
	});
	return new NormalizedSchema(memberSchema, memberName);
}
var anno, simpleSchemaCacheN, simpleSchemaCacheS, NormalizedSchema, isMemberSchema, isStaticSchema;
var init_NormalizedSchema = __esmMin((() => {
	init_deref();
	init_translateTraits();
	anno = {
		it: Symbol.for("@smithy/nor-struct-it"),
		ns: Symbol.for("@smithy/ns")
	};
	simpleSchemaCacheN = [];
	simpleSchemaCacheS = {};
	NormalizedSchema = class NormalizedSchema {
		ref;
		memberName;
		static symbol = Symbol.for("@smithy/nor");
		symbol = NormalizedSchema.symbol;
		name;
		schema;
		_isMemberSchema;
		traits;
		memberTraits;
		normalizedTraits;
		constructor(ref, memberName) {
			this.ref = ref;
			this.memberName = memberName;
			const traitStack = [];
			let _ref = ref;
			let schema = ref;
			this._isMemberSchema = false;
			while (isMemberSchema(_ref)) {
				traitStack.push(_ref[1]);
				_ref = _ref[0];
				schema = deref(_ref);
				this._isMemberSchema = true;
			}
			if (traitStack.length > 0) {
				this.memberTraits = {};
				for (let i = traitStack.length - 1; i >= 0; --i) {
					const traitSet = traitStack[i];
					Object.assign(this.memberTraits, translateTraits(traitSet));
				}
			} else this.memberTraits = 0;
			if (schema instanceof NormalizedSchema) {
				const computedMemberTraits = this.memberTraits;
				Object.assign(this, schema);
				this.memberTraits = Object.assign({}, computedMemberTraits, schema.getMemberTraits(), this.getMemberTraits());
				this.normalizedTraits = void 0;
				this.memberName = memberName ?? schema.memberName;
				return;
			}
			this.schema = deref(schema);
			if (isStaticSchema(this.schema)) {
				this.name = `${this.schema[1]}#${this.schema[2]}`;
				this.traits = this.schema[3];
			} else {
				this.name = this.memberName ?? String(schema);
				this.traits = 0;
			}
			if (this._isMemberSchema && !memberName) throw new Error(`@smithy/core/schema - NormalizedSchema member init ${this.getName(true)} missing member name.`);
		}
		static [Symbol.hasInstance](lhs) {
			const isPrototype = this.prototype.isPrototypeOf(lhs);
			if (!isPrototype && typeof lhs === "object" && lhs !== null) return lhs.symbol === this.symbol;
			return isPrototype;
		}
		static of(ref) {
			const keyAble = typeof ref === "function" || typeof ref === "object" && ref !== null;
			if (typeof ref === "number") {
				if (simpleSchemaCacheN[ref]) return simpleSchemaCacheN[ref];
			} else if (typeof ref === "string") {
				if (simpleSchemaCacheS[ref]) return simpleSchemaCacheS[ref];
			} else if (keyAble) {
				if (ref[anno.ns]) return ref[anno.ns];
			}
			const sc = deref(ref);
			if (sc instanceof NormalizedSchema) return sc;
			if (isMemberSchema(sc)) {
				const [ns, traits] = sc;
				if (ns instanceof NormalizedSchema) {
					Object.assign(ns.getMergedTraits(), translateTraits(traits));
					return ns;
				}
				throw new Error(`@smithy/core/schema - may not init unwrapped member schema=${JSON.stringify(ref, null, 2)}.`);
			}
			const ns = new NormalizedSchema(sc);
			if (keyAble) return ref[anno.ns] = ns;
			if (typeof sc === "string") return simpleSchemaCacheS[sc] = ns;
			if (typeof sc === "number") return simpleSchemaCacheN[sc] = ns;
			return ns;
		}
		getSchema() {
			const sc = this.schema;
			if (Array.isArray(sc) && sc[0] === 0) return sc[4];
			return sc;
		}
		getName(withNamespace = false) {
			const { name } = this;
			return !withNamespace && name && name.includes("#") ? name.split("#")[1] : name || void 0;
		}
		getMemberName() {
			return this.memberName;
		}
		isMemberSchema() {
			return this._isMemberSchema;
		}
		isListSchema() {
			const sc = this.getSchema();
			return typeof sc === "number" ? sc >= 64 && sc < 128 : sc[0] === 1;
		}
		isMapSchema() {
			const sc = this.getSchema();
			return typeof sc === "number" ? sc >= 128 && sc <= 255 : sc[0] === 2;
		}
		isStructSchema() {
			const sc = this.getSchema();
			if (typeof sc !== "object") return false;
			const id = sc[0];
			return id === 3 || id === -3 || id === 4;
		}
		isUnionSchema() {
			const sc = this.getSchema();
			if (typeof sc !== "object") return false;
			return sc[0] === 4;
		}
		isBlobSchema() {
			const sc = this.getSchema();
			return sc === 21 || sc === 42;
		}
		isTimestampSchema() {
			const sc = this.getSchema();
			return typeof sc === "number" && sc >= 4 && sc <= 7;
		}
		isUnitSchema() {
			return this.getSchema() === "unit";
		}
		isDocumentSchema() {
			return this.getSchema() === 15;
		}
		isStringSchema() {
			return this.getSchema() === 0;
		}
		isBooleanSchema() {
			return this.getSchema() === 2;
		}
		isNumericSchema() {
			return this.getSchema() === 1;
		}
		isBigIntegerSchema() {
			return this.getSchema() === 17;
		}
		isBigDecimalSchema() {
			return this.getSchema() === 19;
		}
		isStreaming() {
			const { streaming } = this.getMergedTraits();
			return !!streaming || this.getSchema() === 42;
		}
		isIdempotencyToken() {
			return !!this.getMergedTraits().idempotencyToken;
		}
		getMergedTraits() {
			return this.normalizedTraits ?? (this.normalizedTraits = {
				...this.getOwnTraits(),
				...this.getMemberTraits()
			});
		}
		getMemberTraits() {
			return translateTraits(this.memberTraits);
		}
		getOwnTraits() {
			return translateTraits(this.traits);
		}
		getKeySchema() {
			const [isDoc, isMap] = [this.isDocumentSchema(), this.isMapSchema()];
			if (!isDoc && !isMap) throw new Error(`@smithy/core/schema - cannot get key for non-map: ${this.getName(true)}`);
			const schema = this.getSchema();
			return member([isDoc ? 15 : schema[4] ?? 0, 0], "key");
		}
		getValueSchema() {
			const sc = this.getSchema();
			const [isDoc, isMap, isList] = [
				this.isDocumentSchema(),
				this.isMapSchema(),
				this.isListSchema()
			];
			const memberSchema = typeof sc === "number" ? 63 & sc : sc && typeof sc === "object" && (isMap || isList) ? sc[3 + sc[0]] : isDoc ? 15 : void 0;
			if (memberSchema != null) return member([memberSchema, 0], isMap ? "value" : "member");
			throw new Error(`@smithy/core/schema - ${this.getName(true)} has no value member.`);
		}
		getMemberSchema(memberName) {
			const struct = this.getSchema();
			if (this.isStructSchema() && struct[4].includes(memberName)) {
				const i = struct[4].indexOf(memberName);
				const memberSchema = struct[5][i];
				return member(isMemberSchema(memberSchema) ? memberSchema : [memberSchema, 0], memberName);
			}
			if (this.isDocumentSchema()) return member([15, 0], memberName);
			throw new Error(`@smithy/core/schema - ${this.getName(true)} has no member=${memberName}.`);
		}
		getMemberSchemas() {
			const buffer = {};
			try {
				for (const [k, v] of this.structIterator()) buffer[k] = v;
			} catch (ignored) {}
			return buffer;
		}
		getEventStreamMember() {
			if (this.isStructSchema()) {
				for (const [memberName, memberSchema] of this.structIterator()) if (memberSchema.isStreaming() && memberSchema.isStructSchema()) return memberName;
			}
			return "";
		}
		*structIterator() {
			if (this.isUnitSchema()) return;
			if (!this.isStructSchema()) throw new Error("@smithy/core/schema - cannot iterate non-struct schema.");
			const struct = this.getSchema();
			const z = struct[4].length;
			let it = struct[anno.it];
			if (it && z === it.length) {
				yield* it;
				return;
			}
			it = Array(z);
			for (let i = 0; i < z; ++i) {
				const k = struct[4][i];
				const v = member([struct[5][i], 0], k);
				yield it[i] = [k, v];
			}
			struct[anno.it] = it;
		}
	};
	isMemberSchema = (sc) => Array.isArray(sc) && sc.length === 2;
	isStaticSchema = (sc) => Array.isArray(sc) && sc.length >= 5;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/schemas/SimpleSchema.js
var SimpleSchema, sim, simAdapter;
var init_SimpleSchema = __esmMin((() => {
	init_Schema();
	SimpleSchema = class SimpleSchema extends Schema {
		static symbol = Symbol.for("@smithy/sim");
		name;
		schemaRef;
		traits;
		symbol = SimpleSchema.symbol;
	};
	sim = (namespace, name, schemaRef, traits) => Schema.assign(new SimpleSchema(), {
		name,
		namespace,
		traits,
		schemaRef
	});
	simAdapter = (namespace, name, traits, schemaRef) => Schema.assign(new SimpleSchema(), {
		name,
		namespace,
		traits,
		schemaRef
	});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/schemas/sentinels.js
var SCHEMA;
var init_sentinels = __esmMin((() => {
	SCHEMA = {
		BLOB: 21,
		STREAMING_BLOB: 42,
		BOOLEAN: 2,
		STRING: 0,
		NUMERIC: 1,
		BIG_INTEGER: 17,
		BIG_DECIMAL: 19,
		DOCUMENT: 15,
		TIMESTAMP_DEFAULT: 4,
		TIMESTAMP_DATE_TIME: 5,
		TIMESTAMP_HTTP_DATE: 6,
		TIMESTAMP_EPOCH_SECONDS: 7,
		LIST_MODIFIER: 64,
		MAP_MODIFIER: 128
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/TypeRegistry.js
var TypeRegistry;
var init_TypeRegistry = __esmMin((() => {
	TypeRegistry = class TypeRegistry {
		namespace;
		schemas;
		exceptions;
		static registries = /* @__PURE__ */ new Map();
		constructor(namespace, schemas = /* @__PURE__ */ new Map(), exceptions = /* @__PURE__ */ new Map()) {
			this.namespace = namespace;
			this.schemas = schemas;
			this.exceptions = exceptions;
		}
		static for(namespace) {
			if (!TypeRegistry.registries.has(namespace)) TypeRegistry.registries.set(namespace, new TypeRegistry(namespace));
			return TypeRegistry.registries.get(namespace);
		}
		copyFrom(other) {
			const { schemas, exceptions } = this;
			for (const [k, v] of other.schemas) if (!schemas.has(k)) schemas.set(k, v);
			for (const [k, v] of other.exceptions) if (!exceptions.has(k)) exceptions.set(k, v);
		}
		register(shapeId, schema) {
			const qualifiedName = this.normalizeShapeId(shapeId);
			for (const r of [this, TypeRegistry.for(qualifiedName.split("#")[0])]) r.schemas.set(qualifiedName, schema);
		}
		getSchema(shapeId) {
			const id = this.normalizeShapeId(shapeId);
			if (!this.schemas.has(id)) {
				if (!shapeId.includes("#")) {
					const suffix = "#" + shapeId;
					const candidates = [];
					for (const [shapeId, schema] of this.schemas.entries()) if (shapeId.endsWith(suffix)) candidates.push(schema);
					if (candidates.length === 1) return candidates[0];
				}
				throw new Error(`@smithy/core/schema - schema not found for ${id}`);
			}
			return this.schemas.get(id);
		}
		registerError(es, ctor) {
			const $error = es;
			const ns = $error[1];
			for (const r of [this, TypeRegistry.for(ns)]) {
				r.schemas.set(ns + "#" + $error[2], $error);
				r.exceptions.set($error, ctor);
			}
		}
		getErrorCtor(es) {
			const $error = es;
			if (this.exceptions.has($error)) return this.exceptions.get($error);
			return TypeRegistry.for($error[1]).exceptions.get($error);
		}
		getBaseException() {
			for (const exceptionKey of this.exceptions.keys()) if (Array.isArray(exceptionKey)) {
				const [, ns, name] = exceptionKey;
				const id = ns + "#" + name;
				if (id.startsWith("smithy.ts.sdk.synthetic.") && id.endsWith("ServiceException")) return exceptionKey;
			}
		}
		find(predicate) {
			for (const schema of this.schemas.values()) if (predicate(schema)) return schema;
		}
		clear() {
			this.schemas.clear();
			this.exceptions.clear();
		}
		normalizeShapeId(shapeId) {
			if (shapeId.includes("#")) return shapeId;
			return this.namespace + "#" + shapeId;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/schema/index.js
var schema_exports = /* @__PURE__ */ __exportAll({
	ErrorSchema: () => ErrorSchema,
	ListSchema: () => ListSchema,
	MapSchema: () => MapSchema,
	NormalizedSchema: () => NormalizedSchema,
	OperationSchema: () => OperationSchema,
	SCHEMA: () => SCHEMA,
	Schema: () => Schema,
	SimpleSchema: () => SimpleSchema,
	StructureSchema: () => StructureSchema,
	TypeRegistry: () => TypeRegistry,
	deref: () => deref,
	deserializerMiddlewareOption: () => deserializerMiddlewareOption,
	error: () => error,
	getSchemaSerdePlugin: () => getSchemaSerdePlugin,
	isStaticSchema: () => isStaticSchema,
	list: () => list,
	map: () => map$1,
	op: () => op,
	operation: () => operation,
	serializerMiddlewareOption: () => serializerMiddlewareOption,
	sim: () => sim,
	simAdapter: () => simAdapter,
	simpleSchemaCacheN: () => simpleSchemaCacheN,
	simpleSchemaCacheS: () => simpleSchemaCacheS,
	struct: () => struct,
	traitsCache: () => traitsCache,
	translateTraits: () => translateTraits
});
var init_schema = __esmMin((() => {
	init_deref();
	init_getSchemaSerdePlugin();
	init_ListSchema();
	init_MapSchema();
	init_OperationSchema();
	init_operation();
	init_ErrorSchema();
	init_NormalizedSchema();
	init_Schema();
	init_SimpleSchema();
	init_StructureSchema();
	init_sentinels();
	init_translateTraits();
	init_TypeRegistry();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/schemaLogFilter.js
function schemaLogFilter(schema, data) {
	if (data == null) return data;
	const ns = NormalizedSchema.of(schema);
	if (ns.getMergedTraits().sensitive) return SENSITIVE_STRING$1;
	if (ns.isListSchema()) {
		if (!!ns.getValueSchema().getMergedTraits().sensitive) return SENSITIVE_STRING$1;
	} else if (ns.isMapSchema()) {
		if (!!ns.getKeySchema().getMergedTraits().sensitive || !!ns.getValueSchema().getMergedTraits().sensitive) return SENSITIVE_STRING$1;
	} else if (ns.isStructSchema() && typeof data === "object") {
		const object = data;
		const newObject = {};
		for (const [member, memberNs] of ns.structIterator()) if (object[member] != null) newObject[member] = schemaLogFilter(memberNs, object[member]);
		return newObject;
	}
	return data;
}
var SENSITIVE_STRING$1;
var init_schemaLogFilter = __esmMin((() => {
	init_schema();
	SENSITIVE_STRING$1 = "***SensitiveInformation***";
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/command.js
var import_dist_cjs$1, Command, ClassBuilder;
var init_command = __esmMin((() => {
	import_dist_cjs$1 = require_dist_cjs();
	init_MiddlewareStack();
	init_schemaLogFilter();
	Command = class {
		middlewareStack = constructStack();
		schema;
		static classBuilder() {
			return new ClassBuilder();
		}
		resolveMiddlewareWithContext(clientStack, configuration, options, { middlewareFn, clientName, commandName, inputFilterSensitiveLog, outputFilterSensitiveLog, smithyContext, additionalContext, CommandCtor }) {
			for (const mw of middlewareFn.bind(this)(CommandCtor, clientStack, configuration, options)) this.middlewareStack.use(mw);
			const stack = clientStack.concat(this.middlewareStack);
			const { logger } = configuration;
			const handlerExecutionContext = {
				logger,
				clientName,
				commandName,
				inputFilterSensitiveLog,
				outputFilterSensitiveLog,
				[import_dist_cjs$1.SMITHY_CONTEXT_KEY]: {
					commandInstance: this,
					...smithyContext
				},
				...additionalContext
			};
			const { requestHandler } = configuration;
			let requestOptions = options ?? {};
			if (smithyContext.eventStream) requestOptions = {
				isEventStream: true,
				...requestOptions
			};
			return stack.resolve((request) => requestHandler.handle(request.request, requestOptions), handlerExecutionContext);
		}
	};
	ClassBuilder = class {
		_init = () => {};
		_ep = {};
		_middlewareFn = () => [];
		_commandName = "";
		_clientName = "";
		_additionalContext = {};
		_smithyContext = {};
		_inputFilterSensitiveLog = void 0;
		_outputFilterSensitiveLog = void 0;
		_serializer = null;
		_deserializer = null;
		_operationSchema;
		init(cb) {
			this._init = cb;
		}
		ep(endpointParameterInstructions) {
			this._ep = endpointParameterInstructions;
			return this;
		}
		m(middlewareSupplier) {
			this._middlewareFn = middlewareSupplier;
			return this;
		}
		s(service, operation, smithyContext = {}) {
			this._smithyContext = {
				service,
				operation,
				...smithyContext
			};
			return this;
		}
		c(additionalContext = {}) {
			this._additionalContext = additionalContext;
			return this;
		}
		n(clientName, commandName) {
			this._clientName = clientName;
			this._commandName = commandName;
			return this;
		}
		f(inputFilter = (_) => _, outputFilter = (_) => _) {
			this._inputFilterSensitiveLog = inputFilter;
			this._outputFilterSensitiveLog = outputFilter;
			return this;
		}
		ser(serializer) {
			this._serializer = serializer;
			return this;
		}
		de(deserializer) {
			this._deserializer = deserializer;
			return this;
		}
		sc(operation) {
			this._operationSchema = operation;
			this._smithyContext.operationSchema = operation;
			return this;
		}
		build() {
			const closure = this;
			let CommandRef;
			return CommandRef = class extends Command {
				input;
				static getEndpointParameterInstructions() {
					return closure._ep;
				}
				constructor(...[input]) {
					super();
					this.input = input ?? {};
					closure._init(this);
					this.schema = closure._operationSchema;
				}
				resolveMiddleware(stack, configuration, options) {
					const op = closure._operationSchema;
					const input = op?.[4] ?? op?.input;
					const output = op?.[5] ?? op?.output;
					return this.resolveMiddlewareWithContext(stack, configuration, options, {
						CommandCtor: CommandRef,
						middlewareFn: closure._middlewareFn,
						clientName: closure._clientName,
						commandName: closure._commandName,
						inputFilterSensitiveLog: closure._inputFilterSensitiveLog ?? (op ? schemaLogFilter.bind(null, input) : (_) => _),
						outputFilterSensitiveLog: closure._outputFilterSensitiveLog ?? (op ? schemaLogFilter.bind(null, output) : (_) => _),
						smithyContext: closure._smithyContext,
						additionalContext: closure._additionalContext
					});
				}
				serialize = closure._serializer;
				deserialize = closure._deserializer;
			};
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/constants.js
var SENSITIVE_STRING;
var init_constants = __esmMin((() => {
	SENSITIVE_STRING = "***SensitiveInformation***";
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/create-aggregated-client.js
var createAggregatedClient;
var init_create_aggregated_client = __esmMin((() => {
	createAggregatedClient = (commands, Client, options) => {
		for (const [command, CommandCtor] of Object.entries(commands)) {
			const methodImpl = async function(args, optionsOrCb, cb) {
				const command = new CommandCtor(args);
				if (typeof optionsOrCb === "function") this.send(command, optionsOrCb);
				else if (typeof cb === "function") {
					if (typeof optionsOrCb !== "object") throw new Error(`Expected http options but got ${typeof optionsOrCb}`);
					this.send(command, optionsOrCb || {}, cb);
				} else return this.send(command, optionsOrCb);
			};
			const methodName = (command[0].toLowerCase() + command.slice(1)).replace(/Command$/, "");
			Client.prototype[methodName] = methodImpl;
		}
		const { paginators = {}, waiters = {} } = options ?? {};
		for (const [paginatorName, paginatorFn] of Object.entries(paginators)) if (Client.prototype[paginatorName] === void 0) Client.prototype[paginatorName] = function(commandInput = {}, paginationConfiguration, ...rest) {
			return paginatorFn({
				...paginationConfiguration,
				client: this
			}, commandInput, ...rest);
		};
		for (const [waiterName, waiterFn] of Object.entries(waiters)) if (Client.prototype[waiterName] === void 0) Client.prototype[waiterName] = async function(commandInput = {}, waiterConfiguration, ...rest) {
			let config = waiterConfiguration;
			if (typeof waiterConfiguration === "number") config = { maxWaitTime: waiterConfiguration };
			return waiterFn({
				...config,
				client: this
			}, commandInput, ...rest);
		};
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/exceptions.js
var ServiceException, decorateServiceException;
var init_exceptions = __esmMin((() => {
	ServiceException = class ServiceException extends Error {
		$fault;
		$response;
		$retryable;
		$metadata;
		constructor(options) {
			super(options.message);
			Object.setPrototypeOf(this, Object.getPrototypeOf(this).constructor.prototype);
			this.name = options.name;
			this.$fault = options.$fault;
			this.$metadata = options.$metadata;
		}
		static isInstance(value) {
			if (!value) return false;
			const candidate = value;
			return ServiceException.prototype.isPrototypeOf(candidate) || Boolean(candidate.$fault) && Boolean(candidate.$metadata) && (candidate.$fault === "client" || candidate.$fault === "server");
		}
		static [Symbol.hasInstance](instance) {
			if (!instance) return false;
			const candidate = instance;
			if (this === ServiceException) return ServiceException.isInstance(instance);
			if (ServiceException.isInstance(instance)) {
				if (candidate.name && this.name) return this.prototype.isPrototypeOf(instance) || candidate.name === this.name;
				return this.prototype.isPrototypeOf(instance);
			}
			return false;
		}
	};
	decorateServiceException = (exception, additions = {}) => {
		Object.entries(additions).filter(([, v]) => v !== void 0).forEach(([k, v]) => {
			if (exception[k] == void 0 || exception[k] === "") exception[k] = v;
		});
		exception.message = exception.message || exception.Message || "UnknownError";
		delete exception.Message;
		return exception;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/default-error-handler.js
var throwDefaultError, withBaseException, deserializeMetadata;
var init_default_error_handler = __esmMin((() => {
	init_exceptions();
	throwDefaultError = ({ output, parsedBody, exceptionCtor, errorCode }) => {
		const $metadata = deserializeMetadata(output);
		const statusCode = $metadata.httpStatusCode ? $metadata.httpStatusCode + "" : void 0;
		throw decorateServiceException(new exceptionCtor({
			name: parsedBody?.code || parsedBody?.Code || errorCode || statusCode || "UnknownError",
			$fault: "client",
			$metadata
		}), parsedBody);
	};
	withBaseException = (ExceptionCtor) => {
		return ({ output, parsedBody, errorCode }) => {
			throwDefaultError({
				output,
				parsedBody,
				exceptionCtor: ExceptionCtor,
				errorCode
			});
		};
	};
	deserializeMetadata = (output) => ({
		httpStatusCode: output.statusCode,
		requestId: output.headers["x-amzn-requestid"] ?? output.headers["x-amzn-request-id"] ?? output.headers["x-amz-request-id"],
		extendedRequestId: output.headers["x-amz-id-2"],
		cfId: output.headers["x-amz-cf-id"]
	});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/defaults-mode.js
var loadConfigsForDefaultMode;
var init_defaults_mode = __esmMin((() => {
	loadConfigsForDefaultMode = (mode) => {
		switch (mode) {
			case "standard": return {
				retryMode: "standard",
				connectionTimeout: 3100
			};
			case "in-region": return {
				retryMode: "standard",
				connectionTimeout: 1100
			};
			case "cross-region": return {
				retryMode: "standard",
				connectionTimeout: 3100
			};
			case "mobile": return {
				retryMode: "standard",
				connectionTimeout: 3e4
			};
			default: return {};
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/emitWarningIfUnsupportedVersion.js
var warningEmitted, emitWarningIfUnsupportedVersion;
var init_emitWarningIfUnsupportedVersion = __esmMin((() => {
	warningEmitted = false;
	emitWarningIfUnsupportedVersion = (version) => {
		if (version && !warningEmitted && parseInt(version.substring(1, version.indexOf("."))) < 16) warningEmitted = true;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/extensions/checksum.js
var import_dist_cjs, knownAlgorithms, getChecksumConfiguration, resolveChecksumRuntimeConfig;
var init_checksum = __esmMin((() => {
	import_dist_cjs = require_dist_cjs();
	knownAlgorithms = Object.values(import_dist_cjs.AlgorithmId);
	getChecksumConfiguration = (runtimeConfig) => {
		const checksumAlgorithms = [];
		for (const id in import_dist_cjs.AlgorithmId) {
			const algorithmId = import_dist_cjs.AlgorithmId[id];
			if (runtimeConfig[algorithmId] === void 0) continue;
			checksumAlgorithms.push({
				algorithmId: () => algorithmId,
				checksumConstructor: () => runtimeConfig[algorithmId]
			});
		}
		for (const [id, ChecksumCtor] of Object.entries(runtimeConfig.checksumAlgorithms ?? {})) checksumAlgorithms.push({
			algorithmId: () => id,
			checksumConstructor: () => ChecksumCtor
		});
		return {
			addChecksumAlgorithm(algo) {
				runtimeConfig.checksumAlgorithms = runtimeConfig.checksumAlgorithms ?? {};
				const id = algo.algorithmId();
				const ctor = algo.checksumConstructor();
				if (knownAlgorithms.includes(id)) runtimeConfig.checksumAlgorithms[id.toUpperCase()] = ctor;
				else runtimeConfig.checksumAlgorithms[id] = ctor;
				checksumAlgorithms.push(algo);
			},
			checksumAlgorithms() {
				return checksumAlgorithms;
			}
		};
	};
	resolveChecksumRuntimeConfig = (clientConfig) => {
		const runtimeConfig = {};
		clientConfig.checksumAlgorithms().forEach((checksumAlgorithm) => {
			const id = checksumAlgorithm.algorithmId();
			if (knownAlgorithms.includes(id)) runtimeConfig[id] = checksumAlgorithm.checksumConstructor();
		});
		return runtimeConfig;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/extensions/retry.js
var getRetryConfiguration, resolveRetryRuntimeConfig;
var init_retry = __esmMin((() => {
	getRetryConfiguration = (runtimeConfig) => {
		return {
			setRetryStrategy(retryStrategy) {
				runtimeConfig.retryStrategy = retryStrategy;
			},
			retryStrategy() {
				return runtimeConfig.retryStrategy;
			}
		};
	};
	resolveRetryRuntimeConfig = (retryStrategyConfiguration) => {
		const runtimeConfig = {};
		runtimeConfig.retryStrategy = retryStrategyConfiguration.retryStrategy();
		return runtimeConfig;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/extensions/defaultExtensionConfiguration.js
var getDefaultExtensionConfiguration, getDefaultClientConfiguration, resolveDefaultRuntimeConfig;
var init_defaultExtensionConfiguration = __esmMin((() => {
	init_checksum();
	init_retry();
	getDefaultExtensionConfiguration = (runtimeConfig) => {
		return Object.assign(getChecksumConfiguration(runtimeConfig), getRetryConfiguration(runtimeConfig));
	};
	getDefaultClientConfiguration = getDefaultExtensionConfiguration;
	resolveDefaultRuntimeConfig = (config) => {
		return Object.assign(resolveChecksumRuntimeConfig(config), resolveRetryRuntimeConfig(config));
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/get-array-if-single-item.js
var getArrayIfSingleItem;
var init_get_array_if_single_item = __esmMin((() => {
	getArrayIfSingleItem = (mayBeArray) => Array.isArray(mayBeArray) ? mayBeArray : [mayBeArray];
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/get-value-from-text-node.js
var getValueFromTextNode;
var init_get_value_from_text_node = __esmMin((() => {
	getValueFromTextNode = (obj) => {
		const textNodeName = "#text";
		for (const key in obj) if (obj.hasOwnProperty(key) && obj[key][textNodeName] !== void 0) obj[key] = obj[key][textNodeName];
		else if (typeof obj[key] === "object" && obj[key] !== null) obj[key] = getValueFromTextNode(obj[key]);
		return obj;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/is-serializable-header-value.js
var isSerializableHeaderValue;
var init_is_serializable_header_value = __esmMin((() => {
	isSerializableHeaderValue = (value) => {
		return value != null;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/NoOpLogger.js
var NoOpLogger;
var init_NoOpLogger = __esmMin((() => {
	NoOpLogger = class {
		trace() {}
		debug() {}
		info() {}
		warn() {}
		error() {}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/object-mapping.js
function map(arg0, arg1, arg2) {
	let target;
	let filter;
	let instructions;
	if (typeof arg1 === "undefined" && typeof arg2 === "undefined") {
		target = {};
		instructions = arg0;
	} else {
		target = arg0;
		if (typeof arg1 === "function") {
			filter = arg1;
			instructions = arg2;
			return mapWithFilter(target, filter, instructions);
		} else instructions = arg1;
	}
	for (const key of Object.keys(instructions)) {
		if (!Array.isArray(instructions[key])) {
			target[key] = instructions[key];
			continue;
		}
		applyInstruction(target, null, instructions, key);
	}
	return target;
}
var convertMap, take, mapWithFilter, applyInstruction, nonNullish, pass;
var init_object_mapping = __esmMin((() => {
	convertMap = (target) => {
		const output = {};
		for (const [k, v] of Object.entries(target || {})) output[k] = [, v];
		return output;
	};
	take = (source, instructions) => {
		const out = {};
		for (const key in instructions) applyInstruction(out, source, instructions, key);
		return out;
	};
	mapWithFilter = (target, filter, instructions) => {
		return map(target, Object.entries(instructions).reduce((_instructions, [key, value]) => {
			if (Array.isArray(value)) _instructions[key] = value;
			else if (typeof value === "function") _instructions[key] = [filter, value()];
			else _instructions[key] = [filter, value];
			return _instructions;
		}, {}));
	};
	applyInstruction = (target, source, instructions, targetKey) => {
		if (source !== null) {
			let instruction = instructions[targetKey];
			if (typeof instruction === "function") instruction = [, instruction];
			const [filter = nonNullish, valueFn = pass, sourceKey = targetKey] = instruction;
			if (typeof filter === "function" && filter(source[sourceKey]) || typeof filter !== "function" && !!filter) target[targetKey] = valueFn(source[sourceKey]);
			return;
		}
		let [filter, value] = instructions[targetKey];
		if (typeof value === "function") {
			let _value;
			const defaultFilterPassed = filter === void 0 && (_value = value()) != null;
			const customFilterPassed = typeof filter === "function" && !!filter(void 0) || typeof filter !== "function" && !!filter;
			if (defaultFilterPassed) target[targetKey] = _value;
			else if (customFilterPassed) target[targetKey] = value();
		} else {
			const defaultFilterPassed = filter === void 0 && value != null;
			const customFilterPassed = typeof filter === "function" && !!filter(value) || typeof filter !== "function" && !!filter;
			if (defaultFilterPassed || customFilterPassed) target[targetKey] = value;
		}
	};
	nonNullish = (_) => _ != null;
	pass = (_) => _;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/ser-utils.js
var serializeFloat, serializeDateTime;
var init_ser_utils = __esmMin((() => {
	serializeFloat = (value) => {
		if (value !== value) return "NaN";
		switch (value) {
			case Infinity: return "Infinity";
			case -Infinity: return "-Infinity";
			default: return value;
		}
	};
	serializeDateTime = (date) => date.toISOString().replace(".000Z", "Z");
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/smithy-client/serde-json.js
var _json;
var init_serde_json = __esmMin((() => {
	_json = (obj) => {
		if (obj == null) return {};
		if (Array.isArray(obj)) return obj.filter((_) => _ != null).map(_json);
		if (typeof obj === "object") {
			const target = {};
			for (const key of Object.keys(obj)) {
				if (obj[key] == null) continue;
				target[key] = _json(obj[key]);
			}
			return target;
		}
		return obj;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/client/index.js
var client_exports = /* @__PURE__ */ __exportAll({
	AlgorithmId: () => import_dist_cjs.AlgorithmId,
	Client: () => Client,
	Command: () => Command,
	NoOpLogger: () => NoOpLogger,
	SENSITIVE_STRING: () => SENSITIVE_STRING,
	ServiceException: () => ServiceException,
	WaiterState: () => WaiterState,
	_json: () => _json,
	checkExceptions: () => checkExceptions,
	constructStack: () => constructStack,
	convertMap: () => convertMap,
	createAggregatedClient: () => createAggregatedClient,
	createWaiter: () => createWaiter,
	decorateServiceException: () => decorateServiceException,
	emitWarningIfUnsupportedVersion: () => emitWarningIfUnsupportedVersion,
	getArrayIfSingleItem: () => getArrayIfSingleItem,
	getChecksumConfiguration: () => getChecksumConfiguration,
	getDefaultClientConfiguration: () => getDefaultClientConfiguration,
	getDefaultExtensionConfiguration: () => getDefaultExtensionConfiguration,
	getRetryConfiguration: () => getRetryConfiguration,
	getSmithyContext: () => getSmithyContext,
	getValueFromTextNode: () => getValueFromTextNode,
	invalidFunction: () => invalidFunction,
	invalidProvider: () => invalidProvider,
	isSerializableHeaderValue: () => isSerializableHeaderValue,
	loadConfigsForDefaultMode: () => loadConfigsForDefaultMode,
	map: () => map,
	normalizeProvider: () => normalizeProvider,
	resolveChecksumRuntimeConfig: () => resolveChecksumRuntimeConfig,
	resolveDefaultRuntimeConfig: () => resolveDefaultRuntimeConfig,
	resolveRetryRuntimeConfig: () => resolveRetryRuntimeConfig,
	schemaLogFilter: () => schemaLogFilter,
	serializeDateTime: () => serializeDateTime,
	serializeFloat: () => serializeFloat,
	take: () => take,
	throwDefaultError: () => throwDefaultError,
	waiterServiceDefaults: () => waiterServiceDefaults,
	withBaseException: () => withBaseException
});
var init_client = __esmMin((() => {
	init_MiddlewareStack();
	init_getSmithyContext();
	init_normalizeProvider();
	init_invalidFunction();
	init_invalidProvider();
	init_createWaiter();
	init_waiter();
	init_client$1();
	init_command();
	init_constants();
	init_create_aggregated_client();
	init_default_error_handler();
	init_defaults_mode();
	init_emitWarningIfUnsupportedVersion();
	init_exceptions();
	init_defaultExtensionConfiguration();
	init_checksum();
	init_retry();
	init_get_array_if_single_item();
	init_get_value_from_text_node();
	init_is_serializable_header_value();
	init_NoOpLogger();
	init_object_mapping();
	init_schemaLogFilter();
	init_ser_utils();
	init_serde_json();
}));
//#endregion
export { init_HttpBindingProtocol as $, init_configLoader as $t, protocols_exports as A, init_toBase64 as An, EndpointError as At, HttpInterceptingShapeSerializer as B, init_normalizeProvider as Bn, init_resolveDefaultsModeConfig as Bt, TypeRegistry as C, parseEpochTimestamp as Cn, init_decideEndpoint as Ct, getSchemaSerdePlugin as D, init_parse_utils as Dn, isValidHostLabel as Dt, init_NormalizedSchema as E, expectUnion as En, init_isValidHostLabel as Et, getContentLengthPlugin as F, init_fromBase64 as Fn, init_BinaryDecisionDiagram as Ft, init_FromStringShapeDeserializer as G, NODE_REGION_CONFIG_OPTIONS as Gt, HttpInterceptingShapeDeserializer as H, getSmithyContext as Hn, init_resolveRegionConfig as Ht, init_contentLengthMiddleware as I, deref as In, init_getEndpointFromInstructions as It, init_requestBuilder as J, init_config$1 as Jt, determineTimestampFormat as K, REGION_ENV_NAME as Kt, getHttpHandlerExtensionConfiguration as L, init_deref as Ln, resolveParams as Lt, parseUrl as M, fromUtf8$1 as Mn, EndpointCache as Mt, buildQueryString as N, init_fromUtf8 as Nn, init_EndpointCache as Nt, init_getSchemaSerdePlugin as O, init_toUtf8 as On, customEndpointFunctions as Ot, init_buildQueryString as P, fromBase64$1 as Pn, BinaryDecisionDiagram as Pt, HttpBindingProtocol as Q, init_NodeUseDualstackEndpointConfigOptions as Qt, init_httpExtensionConfiguration as R, Client as Rn, config_exports as Rt, schema_exports as S, init_date_utils as Sn, decideEndpoint as St, NormalizedSchema as T, parseRfc7231DateTime as Tn, isIpAddress as Tt, init_HttpInterceptingShapeDeserializer as U, init_getSmithyContext as Un, resolveRegionConfig as Ut, init_HttpInterceptingShapeSerializer as V, normalizeProvider as Vn, resolveDefaultsModeConfig as Vt, FromStringShapeDeserializer as W, require_dist_cjs as Wn, NODE_REGION_CONFIG_FILE_OPTIONS as Wt, RpcProtocol as X, init_NodeUseFipsEndpointConfigOptions as Xt, requestBuilder as Y, NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS as Yt, init_RpcProtocol as Z, NODE_USE_DUALSTACK_ENDPOINT_CONFIG_OPTIONS as Zt, createAggregatedClient as _, _parseEpochTimestamp as _n, getEndpointPlugin as _t, getValueFromTextNode as a, ProviderError as an, init_SerdeContext as at, init_command as b, init_lazy_json as bn, init_resolveEndpoint as bt, init_defaultExtensionConfiguration as c, toUint8Array as cn, collectBody as ct, init_emitWarningIfUnsupportedVersion as d, fromHex as dn, init_serde as dt, loadConfig as en, HttpResponse as et, init_defaults_mode as f, init_hex_encoding as fn, serde_exports as ft, init_exceptions as g, nv as gn, endpoints_exports as gt, decorateServiceException as h, init_NumericValue as hn, init_hash_node as ht, init_NoOpLogger as i, init_booleanSelector as in, SerdeContext as it, init_parseUrl as j, toBase64$1 as jn, init_EndpointError as jt, init_protocols as k, toUtf8$1 as kn, init_customEndpointFunctions as kt, resolveDefaultRuntimeConfig as l, calculateBodyLength as ln, init_collect_stream_body as lt, ServiceException as m, NumericValue as mn, Hash as mt, init_client as n, init_types$1 as nn, HttpRequest as nt, init_get_value_from_text_node as o, init_ProviderError as on, extendedEncodeURIComponent as ot, loadConfigsForDefaultMode as p, toHex as pn, v4 as pt, init_determineTimestampFormat as q, REGION_INI_NAME as qt, NoOpLogger as r, booleanSelector as rn, init_httpRequest as rt, getDefaultExtensionConfiguration as s, init_toUint8Array as sn, init_extended_encode_uri_component as st, client_exports as t, SelectorType as tn, init_httpResponse as tt, emitWarningIfUnsupportedVersion as u, init_calculateBodyLength as un, generateIdempotencyToken as ut, init_create_aggregated_client as v, init_schema_date_utils as vn, init_endpoints as vt, init_TypeRegistry as w, parseRfc3339DateTimeWithOffset as wn, init_isIpAddress as wt, init_schema as x, dateToUtcString as xn, resolveEndpoint as xt, Command as y, LazyJsonString as yn, resolveEndpointConfig as yt, resolveHttpHandlerRuntimeConfig as z, init_client$1 as zn, init_config as zt };
