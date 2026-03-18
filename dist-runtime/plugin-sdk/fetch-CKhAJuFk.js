import { n as init_subsystem, t as createSubsystemLogger } from "./subsystem-0lZt3jI5.js";
import { n as resolveFetch, t as init_fetch } from "./fetch-CysqlwhH.js";
import { i as logWarn } from "./logger-CXkOEiRn.js";
import { t as hasEnvHttpProxyConfigured } from "./proxy-env-Cc8_f1rT.js";
import { readFileSync } from "node:fs";
import fs$1 from "node:fs/promises";
import process$1 from "node:process";
import * as dns from "node:dns";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch } from "undici";
//#region src/utils/boolean.ts
const DEFAULT_TRUTHY = [
	"true",
	"1",
	"yes",
	"on"
];
const DEFAULT_FALSY = [
	"false",
	"0",
	"no",
	"off"
];
const DEFAULT_TRUTHY_SET = new Set(DEFAULT_TRUTHY);
const DEFAULT_FALSY_SET = new Set(DEFAULT_FALSY);
function parseBooleanValue(value, options = {}) {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return;
	const truthy = options.truthy ?? DEFAULT_TRUTHY;
	const falsy = options.falsy ?? DEFAULT_FALSY;
	const truthySet = truthy === DEFAULT_TRUTHY ? DEFAULT_TRUTHY_SET : new Set(truthy);
	const falsySet = falsy === DEFAULT_FALSY ? DEFAULT_FALSY_SET : new Set(falsy);
	if (truthySet.has(normalized)) return true;
	if (falsySet.has(normalized)) return false;
}
//#endregion
//#region src/infra/env.ts
init_subsystem();
createSubsystemLogger("env");
function isTruthyEnvValue(value) {
	return parseBooleanValue(value) === true;
}
//#endregion
//#region src/infra/net/proxy-fetch.ts
const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");
/**
* Create a fetch function that routes requests through the given HTTP proxy.
* Uses undici's ProxyAgent under the hood.
*/
function makeProxyFetch(proxyUrl) {
	let agent = null;
	const resolveAgent = () => {
		if (!agent) agent = new ProxyAgent(proxyUrl);
		return agent;
	};
	const proxyFetch = ((input, init) => fetch(input, {
		...init,
		dispatcher: resolveAgent()
	}));
	Object.defineProperty(proxyFetch, PROXY_FETCH_PROXY_URL, {
		value: proxyUrl,
		enumerable: false,
		configurable: false,
		writable: false
	});
	return proxyFetch;
}
function getProxyUrlFromFetch(fetchImpl) {
	const proxyUrl = fetchImpl?.[PROXY_FETCH_PROXY_URL];
	if (typeof proxyUrl !== "string") return;
	const trimmed = proxyUrl.trim();
	return trimmed ? trimmed : void 0;
}
/**
* Resolve a proxy-aware fetch from standard environment variables
* (HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy).
* Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
* Returns undefined when no proxy is configured.
* Gracefully returns undefined if the proxy URL is malformed.
*/
function resolveProxyFetchFromEnv(env = process.env) {
	if (!hasEnvHttpProxyConfigured("https", env)) return;
	try {
		const agent = new EnvHttpProxyAgent();
		return ((input, init) => fetch(input, {
			...init,
			dispatcher: agent
		}));
	} catch (err) {
		logWarn(`Proxy env var set but agent creation failed — falling back to direct fetch: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
}
//#endregion
//#region src/infra/wsl.ts
let wslCached = null;
function isWSLEnv() {
	if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME || process.env.WSLENV) return true;
	return false;
}
/**
* Synchronously check if running in WSL.
* Checks env vars first, then /proc/version.
*/
function isWSLSync() {
	if (process.platform !== "linux") return false;
	if (isWSLEnv()) return true;
	try {
		const release = readFileSync("/proc/version", "utf8").toLowerCase();
		return release.includes("microsoft") || release.includes("wsl");
	} catch {
		return false;
	}
}
/**
* Synchronously check if running in WSL2.
*/
function isWSL2Sync() {
	if (!isWSLSync()) return false;
	try {
		const version = readFileSync("/proc/version", "utf8").toLowerCase();
		return version.includes("wsl2") || version.includes("microsoft-standard");
	} catch {
		return false;
	}
}
async function isWSL() {
	if (wslCached !== null) return wslCached;
	if (process.platform !== "linux") {
		wslCached = false;
		return wslCached;
	}
	if (isWSLEnv()) {
		wslCached = true;
		return wslCached;
	}
	try {
		const release = await fs$1.readFile("/proc/sys/kernel/osrelease", "utf8");
		wslCached = release.toLowerCase().includes("microsoft") || release.toLowerCase().includes("wsl");
	} catch {
		wslCached = false;
	}
	return wslCached;
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
* 3. Default: "ipv4first" on Node 22+ (to work around common IPv6 issues)
*/
function resolveTelegramDnsResultOrderDecision(params) {
	const env = params?.env ?? process$1.env;
	const nodeMajor = typeof params?.nodeMajor === "number" ? params.nodeMajor : Number(process$1.versions.node.split(".")[0]);
	const envValue = env[TELEGRAM_DNS_RESULT_ORDER_ENV]?.trim().toLowerCase();
	if (envValue === "ipv4first" || envValue === "verbatim") return {
		value: envValue,
		source: `env:${TELEGRAM_DNS_RESULT_ORDER_ENV}`
	};
	const configValue = (params?.network)?.dnsResultOrder?.trim().toLowerCase();
	if (configValue === "ipv4first" || configValue === "verbatim") return {
		value: configValue,
		source: "config"
	};
	if (Number.isFinite(nodeMajor) && nodeMajor >= 22) return {
		value: "ipv4first",
		source: "default-node22"
	};
	return { value: null };
}
//#endregion
//#region extensions/telegram/src/fetch.ts
init_fetch();
init_subsystem();
const log = createSubsystemLogger("telegram/network");
const TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;
const TELEGRAM_API_HOSTNAME = "api.telegram.org";
const FALLBACK_RETRY_ERROR_CODES = [
	"ETIMEDOUT",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET"
];
const IPV4_FALLBACK_RULES = [{
	name: "fetch-failed-envelope",
	matches: ({ message }) => message.includes("fetch failed")
}, {
	name: "known-network-code",
	matches: ({ codes }) => FALLBACK_RETRY_ERROR_CODES.some((code) => codes.has(code))
}];
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
	const targetHostname = TELEGRAM_API_HOSTNAME.toLowerCase();
	const targetPort = 443;
	const noProxyEntries = noProxyValue.split(/[,\s]/);
	for (let i = 0; i < noProxyEntries.length; i++) {
		const entry = noProxyEntries[i];
		if (!entry) continue;
		const parsed = entry.match(/^(.+):(\d+)$/);
		const entryHostname = (parsed ? parsed[1] : entry).replace(/^\*?\./, "").toLowerCase();
		const entryPort = parsed ? Number.parseInt(parsed[2], 10) : 0;
		if (entryPort && entryPort !== targetPort) continue;
		if (targetHostname === entryHostname || targetHostname.slice(-(entryHostname.length + 1)) === `.${entryHostname}`) return true;
	}
	return false;
}
function hasEnvHttpProxyForTelegramApi(env = process.env) {
	return hasEnvHttpProxyConfigured("https", env);
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
			proxyTls: { ...connect }
		} : {
			mode: "explicit-proxy",
			proxyUrl: explicitProxyUrl
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
function createTelegramDispatcher(policy) {
	if (policy.mode === "explicit-proxy") {
		const proxyOptions = policy.proxyTls ? {
			uri: policy.proxyUrl,
			proxyTls: { ...policy.proxyTls }
		} : policy.proxyUrl;
		try {
			return {
				dispatcher: new ProxyAgent(proxyOptions),
				mode: "explicit-proxy",
				effectivePolicy: policy
			};
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new Error(`explicit proxy dispatcher init failed: ${reason}`, { cause: err });
		}
	}
	if (policy.mode === "env-proxy") {
		const proxyOptions = policy.connect || policy.proxyTls ? {
			...policy.connect ? { connect: { ...policy.connect } } : {},
			...policy.proxyTls ? { proxyTls: { ...policy.proxyTls } } : {}
		} : void 0;
		try {
			return {
				dispatcher: new EnvHttpProxyAgent(proxyOptions),
				mode: "env-proxy",
				effectivePolicy: policy
			};
		} catch (err) {
			log.warn(`env proxy dispatcher init failed; falling back to direct dispatcher: ${err instanceof Error ? err.message : String(err)}`);
			const directPolicy = {
				mode: "direct",
				...policy.connect ? { connect: { ...policy.connect } } : {}
			};
			return {
				dispatcher: new Agent(directPolicy.connect ? { connect: { ...directPolicy.connect } } : void 0),
				mode: "direct",
				effectivePolicy: directPolicy
			};
		}
	}
	return {
		dispatcher: new Agent(policy.connect ? { connect: { ...policy.connect } } : void 0),
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
		log.info(`autoSelectFamily=${params.autoSelectDecision.value}${sourceLabel}`);
	}
	if (params.dnsDecision.value !== null) {
		const sourceLabel = params.dnsDecision.source ? ` (${params.dnsDecision.source})` : "";
		log.info(`dnsResultOrder=${params.dnsDecision.value}${sourceLabel}`);
	}
}
function collectErrorCodes(err) {
	const codes = /* @__PURE__ */ new Set();
	const queue = [err];
	const seen = /* @__PURE__ */ new Set();
	while (queue.length > 0) {
		const current = queue.shift();
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
function shouldRetryWithIpv4Fallback(err) {
	const ctx = {
		message: err && typeof err === "object" && "message" in err ? String(err.message).toLowerCase() : "",
		codes: collectErrorCodes(err)
	};
	for (const rule of IPV4_FALLBACK_RULES) if (!rule.matches(ctx)) return false;
	return true;
}
function shouldRetryTelegramIpv4Fallback(err) {
	return shouldRetryWithIpv4Fallback(err);
}
function resolveTelegramTransport(proxyFetch, options) {
	const autoSelectDecision = resolveTelegramAutoSelectFamilyDecision({ network: options?.network });
	const dnsDecision = resolveTelegramDnsResultOrderDecision({ network: options?.network });
	logResolverNetworkDecisions({
		autoSelectDecision,
		dnsDecision
	});
	const explicitProxyUrl = proxyFetch ? getProxyUrlFromFetch(proxyFetch) : void 0;
	const undiciSourceFetch = resolveWrappedFetch(fetch);
	const sourceFetch = explicitProxyUrl ? undiciSourceFetch : proxyFetch ? resolveWrappedFetch(proxyFetch) : undiciSourceFetch;
	const dnsResultOrder = normalizeDnsResultOrder(dnsDecision.value);
	if (proxyFetch && !explicitProxyUrl) return {
		fetch: sourceFetch,
		sourceFetch
	};
	const useEnvProxy = !explicitProxyUrl && hasEnvHttpProxyForTelegramApi();
	const defaultDispatcher = createTelegramDispatcher(resolveTelegramDispatcherPolicy({
		autoSelectFamily: autoSelectDecision.value,
		dnsResultOrder,
		useEnvProxy,
		forceIpv4: false,
		proxyUrl: explicitProxyUrl
	}).policy);
	const shouldBypassEnvProxy = shouldBypassEnvProxyForTelegramApi();
	const allowStickyIpv4Fallback = defaultDispatcher.mode === "direct" || defaultDispatcher.mode === "env-proxy" && shouldBypassEnvProxy;
	const stickyShouldUseEnvProxy = defaultDispatcher.mode === "env-proxy";
	const fallbackPinnedDispatcherPolicy = allowStickyIpv4Fallback ? resolveTelegramDispatcherPolicy({
		autoSelectFamily: false,
		dnsResultOrder: "ipv4first",
		useEnvProxy: stickyShouldUseEnvProxy,
		forceIpv4: true,
		proxyUrl: explicitProxyUrl
	}).policy : void 0;
	let stickyIpv4FallbackEnabled = false;
	let stickyIpv4Dispatcher = null;
	const resolveStickyIpv4Dispatcher = () => {
		if (!stickyIpv4Dispatcher) {
			if (!fallbackPinnedDispatcherPolicy) return defaultDispatcher.dispatcher;
			stickyIpv4Dispatcher = createTelegramDispatcher(fallbackPinnedDispatcherPolicy).dispatcher;
		}
		return stickyIpv4Dispatcher;
	};
	const resolvedFetch = (async (input, init) => {
		const callerProvidedDispatcher = Boolean(init?.dispatcher);
		const initialInit = withDispatcherIfMissing(init, stickyIpv4FallbackEnabled ? resolveStickyIpv4Dispatcher() : defaultDispatcher.dispatcher);
		try {
			return await sourceFetch(input, initialInit);
		} catch (err) {
			if (shouldRetryWithIpv4Fallback(err)) {
				if (callerProvidedDispatcher) return sourceFetch(input, init ?? {});
				if (!allowStickyIpv4Fallback) throw err;
				if (!stickyIpv4FallbackEnabled) {
					stickyIpv4FallbackEnabled = true;
					log.warn(`fetch fallback: enabling sticky IPv4-only dispatcher (codes=${formatErrorCodes(err)})`);
				}
				return sourceFetch(input, withDispatcherIfMissing(init, resolveStickyIpv4Dispatcher()));
			}
			throw err;
		}
	});
	return {
		fetch: resolvedFetch,
		sourceFetch,
		pinnedDispatcherPolicy: defaultDispatcher.effectivePolicy,
		fallbackPinnedDispatcherPolicy
	};
}
function resolveTelegramFetch(proxyFetch, options) {
	return resolveTelegramTransport(proxyFetch, options).fetch;
}
//#endregion
export { isWSL2Sync as a, makeProxyFetch as c, parseBooleanValue as d, isWSL as i, resolveProxyFetchFromEnv as l, resolveTelegramTransport as n, isWSLEnv as o, shouldRetryTelegramIpv4Fallback as r, isWSLSync as s, resolveTelegramFetch as t, isTruthyEnvValue as u };
