import { n as hasEnvHttpProxyAgentConfigured, o as resolveEnvHttpProxyAgentOptions } from "./proxy-env-B_kbC_hb.js";
import { n as resolveUndiciAutoSelectFamily, t as createUndiciAutoSelectFamilyConnectOptions } from "./undici-family-policy-C5NAXYnW.js";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
//#region src/infra/net/undici-global-dispatcher.ts
const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 1800 * 1e3;
/**
* Module-level bridge so `resolveDispatcherTimeoutMs` in fetch-guard.ts
* can read the global dispatcher timeout without relying on Undici's
* non-public `.options` field.
*/
let _globalUndiciStreamTimeoutMs;
let lastAppliedTimeoutKey = null;
let lastAppliedProxyBootstrap = false;
function resolveDispatcherKind(dispatcher) {
	const ctorName = dispatcher?.constructor?.name;
	if (typeof ctorName !== "string" || ctorName.length === 0) return "unsupported";
	if (ctorName.includes("EnvHttpProxyAgent")) return "env-proxy";
	if (ctorName.includes("ProxyAgent")) return "unsupported";
	if (ctorName.includes("Agent")) return "agent";
	return "unsupported";
}
function resolveDispatcherKey(params) {
	const autoSelectToken = params.autoSelectFamily === void 0 ? "na" : params.autoSelectFamily ? "on" : "off";
	return `${params.kind}:${params.timeoutMs}:${autoSelectToken}`;
}
function resolveCurrentDispatcherKind() {
	let dispatcher;
	try {
		dispatcher = getGlobalDispatcher();
	} catch {
		return null;
	}
	const currentKind = resolveDispatcherKind(dispatcher);
	return currentKind === "unsupported" ? null : currentKind;
}
function ensureGlobalUndiciEnvProxyDispatcher() {
	if (!hasEnvHttpProxyAgentConfigured()) return;
	if (lastAppliedProxyBootstrap) {
		if (resolveCurrentDispatcherKind() === "env-proxy") return;
		lastAppliedProxyBootstrap = false;
	}
	const currentKind = resolveCurrentDispatcherKind();
	if (currentKind === null) return;
	if (currentKind === "env-proxy") {
		lastAppliedProxyBootstrap = true;
		return;
	}
	try {
		setGlobalDispatcher(new EnvHttpProxyAgent(resolveEnvHttpProxyAgentOptions()));
		lastAppliedProxyBootstrap = true;
	} catch {}
}
function ensureGlobalUndiciStreamTimeouts(opts) {
	const timeoutMsRaw = opts?.timeoutMs ?? 18e5;
	if (!Number.isFinite(timeoutMsRaw)) return;
	const timeoutMs = Math.max(DEFAULT_UNDICI_STREAM_TIMEOUT_MS, Math.floor(timeoutMsRaw));
	_globalUndiciStreamTimeoutMs = timeoutMs;
	const kind = resolveCurrentDispatcherKind();
	if (kind === null) return;
	const autoSelectFamily = resolveUndiciAutoSelectFamily();
	const nextKey = resolveDispatcherKey({
		kind,
		timeoutMs,
		autoSelectFamily
	});
	if (lastAppliedTimeoutKey === nextKey) return;
	const connect = createUndiciAutoSelectFamilyConnectOptions(autoSelectFamily);
	try {
		if (kind === "env-proxy") setGlobalDispatcher(new EnvHttpProxyAgent({
			...resolveEnvHttpProxyAgentOptions(),
			bodyTimeout: timeoutMs,
			headersTimeout: timeoutMs,
			...connect ? { connect } : {}
		}));
		else setGlobalDispatcher(new Agent({
			bodyTimeout: timeoutMs,
			headersTimeout: timeoutMs,
			...connect ? { connect } : {}
		}));
		lastAppliedTimeoutKey = nextKey;
	} catch {}
}
function resetGlobalUndiciStreamTimeoutsForTests() {
	lastAppliedTimeoutKey = null;
	lastAppliedProxyBootstrap = false;
	_globalUndiciStreamTimeoutMs = void 0;
}
/**
* Re-evaluate proxy env changes for undici. Installs EnvHttpProxyAgent when
* proxy env is present, and restores a direct Agent after proxy env is cleared.
*/
function forceResetGlobalDispatcher() {
	lastAppliedTimeoutKey = null;
	lastAppliedProxyBootstrap = false;
	try {
		const proxyOptions = resolveEnvHttpProxyAgentOptions();
		if (hasEnvHttpProxyAgentConfigured()) {
			setGlobalDispatcher(new EnvHttpProxyAgent(proxyOptions));
			lastAppliedProxyBootstrap = true;
		} else setGlobalDispatcher(new Agent());
	} catch {}
}
//#endregion
export { forceResetGlobalDispatcher as a, ensureGlobalUndiciStreamTimeouts as i, _globalUndiciStreamTimeoutMs as n, resetGlobalUndiciStreamTimeoutsForTests as o, ensureGlobalUndiciEnvProxyDispatcher as r, DEFAULT_UNDICI_STREAM_TIMEOUT_MS as t };
