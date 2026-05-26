import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { n as isWSL2Sync } from "./wsl-2-jVkfxN.js";
import { n as hasEnvHttpProxyAgentConfigured, o as resolveEnvHttpProxyAgentOptions } from "./proxy-env-Cs0G_0hd.js";
import { n as createHttp1EnvHttpProxyAgent, r as createHttp1ProxyAgent } from "./undici-runtime-DWGlO0I7.js";
import { o as createPinnedLookup } from "./ssrf-DdDeGa5L.js";
import { n as getProxyUrlFromFetch, r as makeProxyFetch } from "./proxy-fetch-B02LTFkt.js";
import { i as resolveEffectiveDebugProxyUrl } from "./env-CDrl0Kuj.js";
import "./error-runtime-DGHc7DZw.js";
import { t as resolveFetch } from "./fetch-CN0jBepr.js";
import "./fetch-runtime-BTAr6cKn.js";
import { t as captureHttpExchange } from "./runtime-Cqhsh14m.js";
import "./proxy-capture-v_LMACCK.js";
import { t as resolveRequestUrl } from "./request-url-vv3NYC-S.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import process$1 from "node:process";
import { randomUUID } from "node:crypto";
import * as dns from "node:dns";
import { Agent, fetch } from "undici";
//#region extensions/telegram/src/api-root.ts
const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";
const TELEGRAM_BOT_ENDPOINT_SEGMENT_RE = /^bot\d+:[^/]+$/u;
function isTelegramBotEndpointSegment(segment) {
	try {
		return TELEGRAM_BOT_ENDPOINT_SEGMENT_RE.test(decodeURIComponent(segment));
	} catch {
		return TELEGRAM_BOT_ENDPOINT_SEGMENT_RE.test(segment);
	}
}
function normalizeTelegramApiRoot(apiRoot) {
	const trimmed = apiRoot?.trim();
	if (!trimmed) return DEFAULT_TELEGRAM_API_ROOT;
	let normalized = trimmed.replace(/\/+$/u, "");
	try {
		const url = new URL(normalized);
		const segments = url.pathname.split("/").filter(Boolean);
		if (segments.length > 0 && isTelegramBotEndpointSegment(segments[segments.length - 1] ?? "")) {
			segments.pop();
			url.pathname = segments.length > 0 ? `/${segments.join("/")}` : "/";
			url.search = "";
			url.hash = "";
			normalized = url.toString().replace(/\/+$/u, "");
		}
	} catch {}
	return normalized;
}
function hasTelegramBotEndpointApiRoot(apiRoot) {
	if (typeof apiRoot !== "string" || !apiRoot.trim()) return false;
	try {
		const segments = new URL(apiRoot.trim()).pathname.split("/").filter(Boolean);
		const last = segments[segments.length - 1];
		return Boolean(last && isTelegramBotEndpointSegment(last));
	} catch {
		return false;
	}
}
//#endregion
//#region extensions/telegram/src/network-config.ts
const TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY";
const TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY";
const TELEGRAM_DNS_RESULT_ORDER_ENV = "OPENCLAW_TELEGRAM_DNS_RESULT_ORDER";
let wsl2SyncCache;
function isWSL2SyncCached() {
	if (typeof wsl2SyncCache === "boolean") return wsl2SyncCache;
	wsl2SyncCache = isWSL2Sync();
	return wsl2SyncCache;
}
function resolveTelegramAutoSelectFamilyDecision(params) {
	const env = params?.env ?? process$1.env;
	const nodeMajor = typeof params?.nodeMajor === "number" ? params.nodeMajor : Number(process$1.versions.node.split(".")[0]);
	if (isTruthyEnvValue(env["OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY"])) return {
		value: true,
		source: `env:${TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV}`
	};
	if (isTruthyEnvValue(env["OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY"])) return {
		value: false,
		source: `env:${TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV}`
	};
	if (typeof params?.network?.autoSelectFamily === "boolean") return {
		value: params.network.autoSelectFamily,
		source: "config"
	};
	if (isWSL2SyncCached()) return {
		value: false,
		source: "default-wsl2"
	};
	if (Number.isFinite(nodeMajor) && nodeMajor >= 22) return {
		value: true,
		source: "default-node22"
	};
	return { value: null };
}
/**
* Resolve DNS result order setting for Telegram network requests.
* Some networks/ISPs have issues with IPv6 causing fetch failures.
* Setting "ipv4first" prioritizes IPv4 addresses in DNS resolution.
*
* Priority:
* 1. Environment variable OPENCLAW_TELEGRAM_DNS_RESULT_ORDER
* 2. Config: channels.telegram.network.dnsResultOrder
* 3. Process default: dns.getDefaultResultOrder()
* 4. Default: "ipv4first" on Node 22+ (to work around common IPv6 issues)
*/
function resolveTelegramDnsResultOrderDecision(params) {
	const env = params?.env ?? process$1.env;
	const nodeMajor = typeof params?.nodeMajor === "number" ? params.nodeMajor : Number(process$1.versions.node.split(".")[0]);
	const envValue = normalizeOptionalLowercaseString(env[TELEGRAM_DNS_RESULT_ORDER_ENV]);
	if (envValue === "ipv4first" || envValue === "verbatim") return {
		value: envValue,
		source: `env:${TELEGRAM_DNS_RESULT_ORDER_ENV}`
	};
	const configValue = normalizeOptionalLowercaseString((params?.network)?.dnsResultOrder);
	if (configValue === "ipv4first" || configValue === "verbatim") return {
		value: configValue,
		source: "config"
	};
	const processDefaultValue = normalizeOptionalLowercaseString(params && "defaultResultOrder" in params ? params.defaultResultOrder : dns.getDefaultResultOrder?.());
	if (processDefaultValue === "ipv4first" || processDefaultValue === "verbatim") return {
		value: processDefaultValue,
		source: "process-default"
	};
	if (Number.isFinite(nodeMajor) && nodeMajor >= 22) return {
		value: "ipv4first",
		source: "default-node22"
	};
	return { value: null };
}
//#endregion
//#region extensions/telegram/src/fetch.ts
const log = createSubsystemLogger("telegram/network");
const TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;
const TELEGRAM_API_HOSTNAME = "api.telegram.org";
const TELEGRAM_FALLBACK_IPS = ["149.154.167.220"];
const TELEGRAM_DISPATCHER_KEEP_ALIVE_TIMEOUT_MS = 3e4;
const TELEGRAM_DISPATCHER_KEEP_ALIVE_MAX_TIMEOUT_MS = 6e5;
const TELEGRAM_DISPATCHER_CONNECTIONS_PER_ORIGIN = 10;
const TELEGRAM_DISPATCHER_PIPELINING = 1;
const TELEGRAM_STICKY_FALLBACK_PRIMARY_PROBE_SUCCESS_THRESHOLD = 5;
const TELEGRAM_TRANSPORT_ATTEMPT_FAILURE_THRESHOLD = 5;
const TELEGRAM_TRANSPORT_ATTEMPT_INITIAL_COOLDOWN_MS = 1e4;
const TELEGRAM_TRANSPORT_ATTEMPT_MAX_COOLDOWN_MS = 6e4;
function telegramAgentPoolOptions() {
	return {
		allowH2: false,
		keepAliveTimeout: TELEGRAM_DISPATCHER_KEEP_ALIVE_TIMEOUT_MS,
		keepAliveMaxTimeout: TELEGRAM_DISPATCHER_KEEP_ALIVE_MAX_TIMEOUT_MS,
		connections: TELEGRAM_DISPATCHER_CONNECTIONS_PER_ORIGIN,
		pipelining: TELEGRAM_DISPATCHER_PIPELINING
	};
}
const FALLBACK_RETRY_ERROR_CODES = [
	"ETIMEDOUT",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET"
];
function normalizeDnsResultOrder(value) {
	if (value === "ipv4first" || value === "verbatim") return value;
	return null;
}
function createDnsResultOrderLookup(order) {
	if (!order) return;
	const lookup = dns.lookup;
	return (hostname, options, callback) => {
		lookup(hostname, {
			...typeof options === "number" ? { family: options } : options ? { ...options } : {},
			order,
			verbatim: order === "verbatim"
		}, callback);
	};
}
function buildTelegramConnectOptions(params) {
	const connect = {};
	if (params.forceIpv4) {
		connect.family = 4;
		connect.autoSelectFamily = false;
	} else if (typeof params.autoSelectFamily === "boolean") {
		connect.autoSelectFamily = params.autoSelectFamily;
		connect.autoSelectFamilyAttemptTimeout = TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS;
	}
	const lookup = createDnsResultOrderLookup(params.dnsResultOrder);
	if (lookup) connect.lookup = lookup;
	return Object.keys(connect).length > 0 ? connect : null;
}
function shouldBypassEnvProxyForTelegramApi(env = process.env) {
	const noProxyValue = env.no_proxy ?? env.NO_PROXY ?? "";
	if (!noProxyValue) return false;
	if (noProxyValue === "*") return true;
	const targetHostname = normalizeLowercaseStringOrEmpty(TELEGRAM_API_HOSTNAME);
	const targetPort = 443;
	const noProxyEntries = noProxyValue.split(/[,\s]/);
	for (let i = 0; i < noProxyEntries.length; i++) {
		const entry = noProxyEntries[i];
		if (!entry) continue;
		const parsed = entry.match(/^(.+):(\d+)$/);
		const entryHostname = normalizeLowercaseStringOrEmpty((parsed ? parsed[1] : entry).replace(/^\*?\./, ""));
		const entryPort = parsed ? Number.parseInt(parsed[2], 10) : 0;
		if (entryPort && entryPort !== targetPort) continue;
		if (targetHostname === entryHostname || targetHostname.slice(-(entryHostname.length + 1)) === `.${entryHostname}`) return true;
	}
	return false;
}
function hasEnvHttpProxyForTelegramApi(env = process.env) {
	return hasEnvHttpProxyAgentConfigured(env);
}
function resolveOpenClawProxyUrlForTelegram(env = process.env) {
	const proxyUrl = env.OPENCLAW_PROXY_URL?.trim();
	return proxyUrl ? proxyUrl : void 0;
}
function resolveTelegramDispatcherPolicy(params) {
	const connect = buildTelegramConnectOptions({
		autoSelectFamily: params.autoSelectFamily,
		dnsResultOrder: params.dnsResultOrder,
		forceIpv4: params.forceIpv4
	});
	const explicitProxyUrl = params.proxyUrl?.trim();
	if (explicitProxyUrl) return {
		policy: connect ? {
			mode: "explicit-proxy",
			proxyUrl: explicitProxyUrl,
			allowPrivateProxy: true,
			proxyTls: { ...connect }
		} : {
			mode: "explicit-proxy",
			proxyUrl: explicitProxyUrl,
			allowPrivateProxy: true
		},
		mode: "explicit-proxy"
	};
	if (params.useEnvProxy) return {
		policy: {
			mode: "env-proxy",
			...connect ? {
				connect: { ...connect },
				proxyTls: { ...connect }
			} : {}
		},
		mode: "env-proxy"
	};
	return {
		policy: {
			mode: "direct",
			...connect ? { connect: { ...connect } } : {}
		},
		mode: "direct"
	};
}
function withPinnedLookup(options, pinnedHostname) {
	if (!pinnedHostname) return options ? { ...options } : void 0;
	const lookup = createPinnedLookup({
		hostname: pinnedHostname.hostname,
		addresses: [...pinnedHostname.addresses],
		fallback: dns.lookup
	});
	return options ? {
		...options,
		lookup
	} : { lookup };
}
function createTelegramDispatcher(policy) {
	const poolOptions = telegramAgentPoolOptions();
	if (policy.mode === "explicit-proxy") {
		const requestTlsOptions = withPinnedLookup(policy.proxyTls, policy.pinnedHostname);
		const proxyOptions = {
			uri: policy.proxyUrl,
			...poolOptions,
			...requestTlsOptions ? { requestTls: requestTlsOptions } : {}
		};
		try {
			return {
				dispatcher: createHttp1ProxyAgent(proxyOptions),
				mode: "explicit-proxy",
				effectivePolicy: policy
			};
		} catch (err) {
			const reason = formatErrorMessage(err);
			throw new Error(`explicit proxy dispatcher init failed: ${reason}`, { cause: err });
		}
	}
	if (policy.mode === "env-proxy") {
		const connectOptions = withPinnedLookup(policy.connect, policy.pinnedHostname);
		const proxyTlsOptions = withPinnedLookup(policy.proxyTls, policy.pinnedHostname);
		const proxyOptions = {
			...poolOptions,
			...resolveEnvHttpProxyAgentOptions(),
			...connectOptions ? { connect: connectOptions } : {},
			...proxyTlsOptions ? { proxyTls: proxyTlsOptions } : {}
		};
		try {
			return {
				dispatcher: createHttp1EnvHttpProxyAgent(proxyOptions),
				mode: "env-proxy",
				effectivePolicy: policy
			};
		} catch (err) {
			log.warn(`env proxy dispatcher init failed; falling back to direct dispatcher: ${formatErrorMessage(err)}`);
			const directPolicy = {
				mode: "direct",
				...connectOptions ? { connect: connectOptions } : {}
			};
			return {
				dispatcher: new Agent({
					...poolOptions,
					...directPolicy.connect ? { connect: directPolicy.connect } : {}
				}),
				mode: "direct",
				effectivePolicy: directPolicy
			};
		}
	}
	const connectOptions = withPinnedLookup(policy.connect, policy.pinnedHostname);
	return {
		dispatcher: new Agent({
			...poolOptions,
			...connectOptions ? { connect: connectOptions } : {}
		}),
		mode: "direct",
		effectivePolicy: policy
	};
}
function withDispatcherIfMissing(init, dispatcher) {
	if (init?.dispatcher) return init ?? {};
	return init ? {
		...init,
		dispatcher
	} : { dispatcher };
}
function resolveWrappedFetch(fetchImpl) {
	return resolveFetch(fetchImpl) ?? fetchImpl;
}
function logResolverNetworkDecisions(params) {
	if (params.autoSelectDecision.value !== null) {
		const sourceLabel = params.autoSelectDecision.source ? ` (${params.autoSelectDecision.source})` : "";
		log.debug(`autoSelectFamily=${params.autoSelectDecision.value}${sourceLabel}`);
	}
	if (params.dnsDecision.value !== null) {
		const sourceLabel = params.dnsDecision.source ? ` (${params.dnsDecision.source})` : "";
		log.debug(`dnsResultOrder=${params.dnsDecision.value}${sourceLabel}`);
	}
}
function collectErrorCodes(err) {
	const codes = /* @__PURE__ */ new Set();
	const queue = [err];
	const seen = /* @__PURE__ */ new Set();
	let queueIndex = 0;
	while (queueIndex < queue.length) {
		const current = queue[queueIndex++];
		if (!current || seen.has(current)) continue;
		seen.add(current);
		if (typeof current === "object") {
			const code = current.code;
			if (typeof code === "string" && code.trim()) codes.add(code.trim().toUpperCase());
			const cause = current.cause;
			if (cause && !seen.has(cause)) queue.push(cause);
			const errors = current.errors;
			if (Array.isArray(errors)) {
				for (const nested of errors) if (nested && !seen.has(nested)) queue.push(nested);
			}
		}
	}
	return codes;
}
function formatErrorCodes(err) {
	const codes = [...collectErrorCodes(err)];
	return codes.length > 0 ? codes.join(",") : "none";
}
var TelegramTransportAttemptUnhealthyError = class extends Error {
	constructor(unhealthyUntilMs) {
		const remainingMs = Math.max(0, unhealthyUntilMs - Date.now());
		super(`telegram transport attempt temporarily unhealthy; retry after ${remainingMs}ms`);
		this.name = "TelegramTransportAttemptUnhealthyError";
	}
};
function shouldUseTelegramTransportFallback(err) {
	if (err instanceof TelegramTransportAttemptUnhealthyError) return true;
	const ctx = {
		message: err && typeof err === "object" && "message" in err ? normalizeLowercaseStringOrEmpty(String(err.message)) : "",
		codes: collectErrorCodes(err)
	};
	const hasFetchFailedEnvelope = ctx.message.includes("fetch failed");
	return FALLBACK_RETRY_ERROR_CODES.some((code) => ctx.codes.has(code)) || hasFetchFailedEnvelope && ctx.codes.size === 0;
}
function shouldRetryTelegramTransportFallback(err) {
	return shouldUseTelegramTransportFallback(err);
}
function createTelegramTransportAttempts(params) {
	params.ownedDispatchers.add(params.defaultDispatcher.dispatcher);
	const attempts = [{
		createDispatcher: () => params.defaultDispatcher.dispatcher,
		exportAttempt: { dispatcherPolicy: params.defaultDispatcher.effectivePolicy }
	}];
	if (!params.allowFallback || !params.fallbackPolicy) return attempts;
	const fallbackPolicy = params.fallbackPolicy;
	const ownedDispatchers = params.ownedDispatchers;
	let ipv4Dispatcher = null;
	attempts.push({
		createDispatcher: () => {
			if (!ipv4Dispatcher) {
				ipv4Dispatcher = createTelegramDispatcher(fallbackPolicy).dispatcher;
				ownedDispatchers.add(ipv4Dispatcher);
			}
			return ipv4Dispatcher;
		},
		exportAttempt: { dispatcherPolicy: fallbackPolicy },
		logLevel: "debug",
		logMessage: "fetch fallback: enabling sticky IPv4-only dispatcher"
	});
	if (TELEGRAM_FALLBACK_IPS.length === 0) return attempts;
	const fallbackIpPolicy = {
		...fallbackPolicy,
		pinnedHostname: {
			hostname: TELEGRAM_API_HOSTNAME,
			addresses: [...TELEGRAM_FALLBACK_IPS]
		}
	};
	let fallbackIpDispatcher = null;
	attempts.push({
		createDispatcher: () => {
			if (!fallbackIpDispatcher) {
				fallbackIpDispatcher = createTelegramDispatcher(fallbackIpPolicy).dispatcher;
				ownedDispatchers.add(fallbackIpDispatcher);
			}
			return fallbackIpDispatcher;
		},
		exportAttempt: { dispatcherPolicy: fallbackIpPolicy },
		logLevel: "warn",
		logMessage: "fetch fallback: DNS-resolved IP unreachable; trying alternative Telegram API IP"
	});
	return attempts;
}
async function destroyOwnedDispatchers(dispatchers) {
	await Promise.all([...dispatchers].map(async (dispatcher) => {
		try {
			await dispatcher.destroy();
		} catch {}
	}));
}
function resolveTelegramTransport(proxyFetch, options) {
	const autoSelectDecision = resolveTelegramAutoSelectFamilyDecision({ network: options?.network });
	const dnsDecision = resolveTelegramDnsResultOrderDecision({ network: options?.network });
	logResolverNetworkDecisions({
		autoSelectDecision,
		dnsDecision
	});
	const effectiveProxyFetch = proxyFetch ?? (() => {
		const debugProxyUrl = resolveEffectiveDebugProxyUrl(void 0);
		return debugProxyUrl ? makeProxyFetch(debugProxyUrl) : void 0;
	})();
	const explicitProxyUrl = effectiveProxyFetch ? getProxyUrlFromFetch(effectiveProxyFetch) : void 0;
	const hasEnvProxy = !explicitProxyUrl && hasEnvHttpProxyForTelegramApi();
	const managedProxyUrl = !effectiveProxyFetch && !hasEnvProxy ? resolveOpenClawProxyUrlForTelegram() : void 0;
	const resolvedExplicitProxyUrl = explicitProxyUrl ?? managedProxyUrl;
	const undiciSourceFetch = resolveWrappedFetch(fetch);
	const sourceFetch = resolvedExplicitProxyUrl ? undiciSourceFetch : effectiveProxyFetch ? resolveWrappedFetch(effectiveProxyFetch) : undiciSourceFetch;
	const dnsResultOrder = normalizeDnsResultOrder(dnsDecision.value);
	if (effectiveProxyFetch && !explicitProxyUrl) return {
		fetch: sourceFetch,
		sourceFetch,
		close: async () => {}
	};
	const useEnvProxy = !resolvedExplicitProxyUrl && hasEnvProxy;
	const defaultDispatcher = createTelegramDispatcher(resolveTelegramDispatcherPolicy({
		autoSelectFamily: autoSelectDecision.value,
		dnsResultOrder,
		useEnvProxy,
		forceIpv4: false,
		proxyUrl: resolvedExplicitProxyUrl
	}).policy);
	const shouldBypassEnvProxy = shouldBypassEnvProxyForTelegramApi();
	const allowStickyFallback = defaultDispatcher.mode === "direct" || defaultDispatcher.mode === "env-proxy" && shouldBypassEnvProxy;
	const fallbackDispatcherPolicy = allowStickyFallback ? resolveTelegramDispatcherPolicy({
		autoSelectFamily: false,
		dnsResultOrder: "ipv4first",
		useEnvProxy: defaultDispatcher.mode === "env-proxy",
		forceIpv4: true,
		proxyUrl: resolvedExplicitProxyUrl
	}).policy : void 0;
	const ownedDispatchers = /* @__PURE__ */ new Set();
	const transportAttempts = createTelegramTransportAttempts({
		defaultDispatcher,
		allowFallback: allowStickyFallback,
		fallbackPolicy: fallbackDispatcherPolicy,
		ownedDispatchers
	});
	let stickyAttemptIndex = 0;
	let stickySuccessCount = 0;
	let primaryProbeDue = false;
	const attemptHealth = transportAttempts.map(() => ({
		consecutiveFailures: 0,
		cooldownMs: TELEGRAM_TRANSPORT_ATTEMPT_INITIAL_COOLDOWN_MS,
		unhealthyUntilMs: 0
	}));
	const resetStickyRecoveryProbe = () => {
		stickySuccessCount = 0;
		primaryProbeDue = false;
	};
	const getAttemptCooldownError = (attemptIndex) => {
		const health = attemptHealth[attemptIndex];
		if (health.unhealthyUntilMs <= Date.now()) return null;
		return new TelegramTransportAttemptUnhealthyError(health.unhealthyUntilMs);
	};
	const recordAttemptFailure = (attemptIndex, err) => {
		if (!shouldUseTelegramTransportFallback(err)) return;
		const health = attemptHealth[attemptIndex];
		health.consecutiveFailures += 1;
		if (health.consecutiveFailures < TELEGRAM_TRANSPORT_ATTEMPT_FAILURE_THRESHOLD) return;
		const cooldownMs = Math.min(TELEGRAM_TRANSPORT_ATTEMPT_MAX_COOLDOWN_MS, Math.max(TELEGRAM_TRANSPORT_ATTEMPT_INITIAL_COOLDOWN_MS, health.cooldownMs));
		health.consecutiveFailures = 0;
		health.cooldownMs = Math.min(TELEGRAM_TRANSPORT_ATTEMPT_MAX_COOLDOWN_MS, cooldownMs * 2);
		health.unhealthyUntilMs = Date.now() + cooldownMs;
		log.warn(`telegram transport attempt marked temporarily unhealthy for ${cooldownMs}ms (codes=${formatErrorCodes(err)})`);
	};
	const promoteStickyAttempt = (nextIndex, err, reason) => {
		if (nextIndex <= stickyAttemptIndex || nextIndex >= transportAttempts.length) return false;
		const nextAttempt = transportAttempts[nextIndex];
		if (nextAttempt.logMessage) {
			const reasonText = reason ? `, reason=${reason}` : "";
			const logLine = `${nextAttempt.logMessage} (codes=${formatErrorCodes(err)}${reasonText})`;
			if (nextAttempt.logLevel === "debug") log.debug(logLine);
			else log.warn(logLine);
		}
		stickyAttemptIndex = nextIndex;
		resetStickyRecoveryProbe();
		return true;
	};
	const recordSuccessfulAttempt = (attemptIndex) => {
		const health = attemptHealth[attemptIndex];
		health.consecutiveFailures = 0;
		health.cooldownMs = TELEGRAM_TRANSPORT_ATTEMPT_INITIAL_COOLDOWN_MS;
		health.unhealthyUntilMs = 0;
		if (stickyAttemptIndex === 0) {
			resetStickyRecoveryProbe();
			return;
		}
		if (attemptIndex < stickyAttemptIndex) {
			log.debug(`fetch fallback: recovered from attempt ${stickyAttemptIndex} to attempt ${attemptIndex}`);
			stickyAttemptIndex = attemptIndex;
			resetStickyRecoveryProbe();
			return;
		}
		if (attemptIndex !== stickyAttemptIndex) return;
		stickySuccessCount += 1;
		if (stickySuccessCount >= TELEGRAM_STICKY_FALLBACK_PRIMARY_PROBE_SUCCESS_THRESHOLD) {
			stickySuccessCount = 0;
			primaryProbeDue = true;
			log.debug("fetch fallback: scheduling primary dispatcher recovery probe");
		}
	};
	const resolvedFetch = (async (input, init) => {
		const callerProvidedDispatcher = Boolean(init?.dispatcher);
		const stickyStartIndex = Math.min(stickyAttemptIndex, transportAttempts.length - 1);
		const stickyCooldownError = callerProvidedDispatcher ? null : getAttemptCooldownError(stickyStartIndex);
		const primaryProbe = !callerProvidedDispatcher && stickyStartIndex > 0 && (primaryProbeDue || stickyCooldownError !== null);
		const startIndex = primaryProbe ? 0 : stickyStartIndex;
		if (primaryProbe) {
			primaryProbeDue = false;
			log.debug(stickyCooldownError ? "fetch fallback: re-probing primary dispatcher while sticky fallback is cooling down" : "fetch fallback: re-probing primary dispatcher after sticky fallback successes");
		}
		let err;
		if (callerProvidedDispatcher) try {
			const response = await sourceFetch(input, init);
			captureHttpExchange({
				url: resolveRequestUrl(input),
				method: init?.method ?? "GET",
				requestHeaders: init?.headers,
				requestBody: init?.body ?? null,
				response,
				flowId: randomUUID(),
				meta: { subsystem: "telegram-fetch" }
			});
			return response;
		} catch (caught) {
			if (!shouldUseTelegramTransportFallback(caught)) throw caught;
			return sourceFetch(input, init ?? {});
		}
		for (let attemptIndex = startIndex; attemptIndex < transportAttempts.length; attemptIndex += 1) {
			const attempt = transportAttempts[attemptIndex];
			if (attemptIndex > startIndex) promoteStickyAttempt(attemptIndex, err);
			const cooldownError = getAttemptCooldownError(attemptIndex);
			if (cooldownError) {
				err = cooldownError;
				continue;
			}
			try {
				const response = await sourceFetch(input, withDispatcherIfMissing(init, attempt.createDispatcher()));
				captureHttpExchange({
					url: resolveRequestUrl(input),
					method: init?.method ?? "GET",
					requestHeaders: init?.headers,
					requestBody: init?.body ?? null,
					response,
					flowId: randomUUID(),
					meta: attemptIndex === startIndex ? { subsystem: "telegram-fetch" } : {
						subsystem: "telegram-fetch",
						fallbackAttempt: attemptIndex
					}
				});
				recordSuccessfulAttempt(attemptIndex);
				return response;
			} catch (caught) {
				err = caught;
				if (!shouldUseTelegramTransportFallback(err)) throw err;
				recordAttemptFailure(attemptIndex, err);
			}
		}
		throw err;
	});
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		const toDestroy = [...ownedDispatchers];
		ownedDispatchers.clear();
		await destroyOwnedDispatchers(toDestroy);
	};
	return {
		fetch: resolvedFetch,
		sourceFetch,
		dispatcherAttempts: transportAttempts.map((attempt) => attempt.exportAttempt),
		forceFallback: (reason) => promoteStickyAttempt(stickyAttemptIndex + 1, /* @__PURE__ */ new Error("forced fallback"), reason),
		close
	};
}
function resolveTelegramFetch(proxyFetch, options) {
	return resolveTelegramTransport(proxyFetch, options).fetch;
}
/**
* Resolve the Telegram Bot API base URL from an optional `apiRoot` config value.
* Returns a trimmed URL without trailing slash, or the standard default.
*/
function resolveTelegramApiBase(apiRoot) {
	return normalizeTelegramApiRoot(apiRoot);
}
//#endregion
export { hasTelegramBotEndpointApiRoot as a, shouldRetryTelegramTransportFallback as i, resolveTelegramFetch as n, normalizeTelegramApiRoot as o, resolveTelegramTransport as r, resolveTelegramApiBase as t };
