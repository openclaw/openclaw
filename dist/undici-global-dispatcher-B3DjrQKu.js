import { n as hasEnvHttpProxyAgentConfigured, o as resolveEnvHttpProxyAgentOptions } from "./proxy-env-Cs0G_0hd.js";
import { t as addActiveManagedProxyTlsOptions } from "./managed-proxy-undici-CxE3Ud0o.js";
import { c as withTemporaryUndiciAutoSelectFamily, i as loadUndiciGlobalDispatcherDeps, n as createHttp1EnvHttpProxyAgent, o as createUndiciAutoSelectFamilyConnectOptions, s as resolveUndiciAutoSelectFamily, t as createHttp1Agent } from "./undici-runtime-DWGlO0I7.js";
import { isProxylineDispatcher } from "@openclaw/proxyline/dispatcher-brand";
//#region src/infra/net/undici-global-dispatcher.ts
const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 1800 * 1e3;
const HTTP1_ONLY_DISPATCHER_OPTIONS = Object.freeze({ allowH2: false });
/**
* Module-level bridge so `resolveDispatcherTimeoutMs` in fetch-guard.ts
* can read the global dispatcher timeout without relying on Undici's
* non-public `.options` field.
*/
let globalUndiciStreamTimeoutMs;
let lastAppliedTimeoutKey = null;
let lastAppliedProxyBootstrapKey = null;
const UNDICI_DISPATCH_HELPER_METHODS = new Set([
	"compose",
	"connect",
	"pipeline",
	"request",
	"stream",
	"upgrade"
]);
const UNDICI_DISPATCHER_LIFECYCLE_METHODS = new Set(["close", "destroy"]);
const timedProxylineManagedDispatchers = /* @__PURE__ */ new WeakMap();
function isTimedProxylineManagedDispatcher(dispatcher) {
	return typeof dispatcher === "object" && dispatcher !== null ? timedProxylineManagedDispatchers.has(dispatcher) : false;
}
function withDefaultDispatchTimeout(timeout, timeoutMs) {
	return timeout == null ? timeoutMs : timeout;
}
function createTimedProxylineManagedDispatcher(dispatcher, timeoutMs, autoSelectFamily) {
	const existingState = timedProxylineManagedDispatchers.get(dispatcher);
	if (existingState) {
		existingState.autoSelectFamily = autoSelectFamily;
		existingState.timeoutMs = timeoutMs;
		return dispatcher;
	}
	const state = {
		autoSelectFamily,
		timeoutMs,
		dispatch(options, handler) {
			return withTemporaryUndiciAutoSelectFamily(state.autoSelectFamily, () => dispatcher.dispatch({
				...options,
				bodyTimeout: withDefaultDispatchTimeout(options.bodyTimeout, state.timeoutMs),
				headersTimeout: withDefaultDispatchTimeout(options.headersTimeout, state.timeoutMs),
				...HTTP1_ONLY_DISPATCHER_OPTIONS
			}, handler));
		}
	};
	const proxy = new Proxy(dispatcher, { get(target, property, receiver) {
		if (property === "dispatch") return state.dispatch;
		const value = Reflect.get(target, property, receiver);
		if (typeof value !== "function") return value;
		if (UNDICI_DISPATCHER_LIFECYCLE_METHODS.has(property)) return value.bind(target);
		if (UNDICI_DISPATCH_HELPER_METHODS.has(property)) return (...args) => Reflect.apply(value, receiver, args);
		return value;
	} });
	timedProxylineManagedDispatchers.set(proxy, state);
	return proxy;
}
function resolveDispatcherKind(dispatcher) {
	const ctorName = dispatcher?.constructor?.name;
	if (typeof ctorName !== "string" || ctorName.length === 0) return "unsupported";
	if (ctorName.includes("EnvHttpProxyAgent")) return "env-proxy";
	if (isTimedProxylineManagedDispatcher(dispatcher) || isProxylineDispatcher(dispatcher)) return "proxyline-managed";
	if (ctorName.includes("ProxyAgent")) return "unsupported";
	if (ctorName.includes("Agent")) return "agent";
	return "unsupported";
}
function resolveDispatcherKey(params) {
	const autoSelectToken = params.autoSelectFamily === void 0 ? "na" : params.autoSelectFamily ? "on" : "off";
	return `${params.kind}:${params.timeoutMs}:${autoSelectToken}`;
}
function resolveEnvProxyDispatcherOptions() {
	return {
		...addActiveManagedProxyTlsOptions(resolveEnvHttpProxyAgentOptions()),
		...HTTP1_ONLY_DISPATCHER_OPTIONS
	};
}
function resolveEnvProxyBootstrapKey(options) {
	const entries = Object.entries(options ?? {}).filter(([, value]) => value !== void 0).toSorted(([a], [b]) => a.localeCompare(b));
	return JSON.stringify(entries);
}
function resolveStreamTimeoutMs(opts) {
	const timeoutMsRaw = opts?.timeoutMs ?? 18e5;
	if (!Number.isFinite(timeoutMsRaw)) return null;
	return Math.max(DEFAULT_UNDICI_STREAM_TIMEOUT_MS, Math.floor(timeoutMsRaw));
}
function resolveCurrentDispatcherKind(runtime) {
	return resolveCurrentDispatcherInfo(runtime)?.kind ?? null;
}
function resolveCurrentDispatcherInfo(runtime) {
	let dispatcher;
	try {
		dispatcher = runtime.getGlobalDispatcher();
	} catch {
		return null;
	}
	const currentKind = resolveDispatcherKind(dispatcher);
	if (currentKind === "unsupported") return null;
	return {
		kind: currentKind,
		dispatcher
	};
}
function ensureGlobalUndiciEnvProxyDispatcher() {
	if (!hasEnvHttpProxyAgentConfigured()) return;
	const runtime = loadUndiciGlobalDispatcherDeps();
	const { setGlobalDispatcher } = runtime;
	const proxyOptions = resolveEnvProxyDispatcherOptions();
	const nextBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
	const currentKind = resolveCurrentDispatcherKind(runtime);
	if (currentKind === null) return;
	if (currentKind === "proxyline-managed") {
		lastAppliedProxyBootstrapKey = nextBootstrapKey;
		return;
	}
	if (currentKind === "env-proxy" && lastAppliedProxyBootstrapKey === null) {
		lastAppliedProxyBootstrapKey = nextBootstrapKey;
		return;
	}
	if (currentKind === "env-proxy" && lastAppliedProxyBootstrapKey === nextBootstrapKey) return;
	try {
		setGlobalDispatcher(createHttp1EnvHttpProxyAgent(proxyOptions));
		lastAppliedProxyBootstrapKey = nextBootstrapKey;
	} catch {}
}
function applyGlobalDispatcherStreamTimeouts(params) {
	const { runtime, dispatcher, kind, timeoutMs } = params;
	const autoSelectFamily = resolveUndiciAutoSelectFamily();
	const nextKey = resolveDispatcherKey({
		kind,
		timeoutMs,
		autoSelectFamily
	});
	const needsProxylineWrapper = kind === "proxyline-managed" && !isTimedProxylineManagedDispatcher(dispatcher);
	if (lastAppliedTimeoutKey === nextKey && !needsProxylineWrapper) return;
	const connect = createUndiciAutoSelectFamilyConnectOptions(autoSelectFamily);
	try {
		if (kind === "proxyline-managed") runtime.setGlobalDispatcher(createTimedProxylineManagedDispatcher(dispatcher, timeoutMs, autoSelectFamily));
		else if (kind === "env-proxy") {
			const proxyOptions = {
				...addActiveManagedProxyTlsOptions(resolveEnvHttpProxyAgentOptions()),
				bodyTimeout: timeoutMs,
				headersTimeout: timeoutMs,
				...connect ? { connect } : {},
				...HTTP1_ONLY_DISPATCHER_OPTIONS
			};
			runtime.setGlobalDispatcher(createHttp1EnvHttpProxyAgent(proxyOptions, timeoutMs));
		} else runtime.setGlobalDispatcher(createHttp1Agent(connect ? { connect } : void 0, timeoutMs));
		lastAppliedTimeoutKey = nextKey;
	} catch {}
}
function ensureGlobalUndiciStreamTimeouts(opts) {
	const timeoutMs = resolveStreamTimeoutMs(opts);
	if (timeoutMs === null) return;
	globalUndiciStreamTimeoutMs = timeoutMs;
	if (!hasEnvHttpProxyAgentConfigured()) {
		lastAppliedTimeoutKey = null;
		return;
	}
	const runtime = loadUndiciGlobalDispatcherDeps();
	const current = resolveCurrentDispatcherInfo(runtime);
	if (current === null) return;
	if (current.kind !== "env-proxy" && current.kind !== "proxyline-managed") return;
	applyGlobalDispatcherStreamTimeouts({
		runtime,
		dispatcher: current.dispatcher,
		kind: current.kind,
		timeoutMs
	});
}
function ensureGlobalUndiciDispatcherStreamTimeouts(opts) {
	const timeoutMs = resolveStreamTimeoutMs(opts);
	if (timeoutMs === null) return;
	globalUndiciStreamTimeoutMs = timeoutMs;
	const runtime = loadUndiciGlobalDispatcherDeps();
	const current = resolveCurrentDispatcherInfo(runtime);
	if (current === null) return;
	applyGlobalDispatcherStreamTimeouts({
		runtime,
		dispatcher: current.dispatcher,
		kind: current.kind,
		timeoutMs
	});
}
function resetGlobalUndiciStreamTimeoutsForTests() {
	lastAppliedTimeoutKey = null;
	lastAppliedProxyBootstrapKey = null;
	globalUndiciStreamTimeoutMs = void 0;
}
/**
* Re-evaluate proxy env changes for root undici imports. Installs
* EnvHttpProxyAgent when proxy env is present, and restores a direct Agent
* after proxy env is cleared.
*/
function forceResetGlobalDispatcher(opts) {
	lastAppliedTimeoutKey = null;
	if (!hasEnvHttpProxyAgentConfigured()) {
		if (lastAppliedProxyBootstrapKey === null) return;
		lastAppliedProxyBootstrapKey = null;
		try {
			const { setGlobalDispatcher } = loadUndiciGlobalDispatcherDeps();
			setGlobalDispatcher(createHttp1Agent());
		} catch {}
		return;
	}
	try {
		const runtime = loadUndiciGlobalDispatcherDeps();
		const { setGlobalDispatcher } = runtime;
		const proxyOptions = resolveEnvProxyDispatcherOptions();
		if (opts?.preserveProxylineManaged) {
			if (resolveCurrentDispatcherInfo(runtime)?.kind === "proxyline-managed") {
				lastAppliedProxyBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
				return;
			}
		}
		setGlobalDispatcher(createHttp1EnvHttpProxyAgent(proxyOptions));
		lastAppliedProxyBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
	} catch {}
}
//#endregion
export { forceResetGlobalDispatcher as a, ensureGlobalUndiciStreamTimeouts as i, ensureGlobalUndiciDispatcherStreamTimeouts as n, globalUndiciStreamTimeoutMs as o, ensureGlobalUndiciEnvProxyDispatcher as r, resetGlobalUndiciStreamTimeoutsForTests as s, DEFAULT_UNDICI_STREAM_TIMEOUT_MS as t };
