import { l as resolveDefaultSecretProviderAlias } from "./ref-contract-D_h_G00C.js";
import { n as resolveActiveManagedProxyTlsOptions } from "./managed-proxy-undici-CxE3Ud0o.js";
import "./fetch-timeout-CptH2le9.js";
import { i as runPassiveAccountLifecycle } from "./channel-lifecycle.core-CDt0hRZR.js";
import { t as createLoggerBackedRuntime } from "./runtime-logger-CdfMCDWX.js";
import { createAmbientNodeProxyAgent, hasAmbientNodeProxyConfigured } from "@openclaw/proxyline";
//#region src/plugin-sdk/extension-shared.ts
function buildPassiveChannelStatusSummary(snapshot, extra) {
	return {
		configured: snapshot.configured ?? false,
		...extra ?? {},
		running: snapshot.running ?? false,
		lastStartAt: snapshot.lastStartAt ?? null,
		lastStopAt: snapshot.lastStopAt ?? null,
		lastError: snapshot.lastError ?? null
	};
}
function buildPassiveProbedChannelStatusSummary(snapshot, extra) {
	return {
		...buildPassiveChannelStatusSummary(snapshot, extra),
		probe: snapshot.probe,
		lastProbeAt: snapshot.lastProbeAt ?? null
	};
}
function buildTrafficStatusSummary(snapshot) {
	return {
		lastInboundAt: snapshot?.lastInboundAt ?? null,
		lastOutboundAt: snapshot?.lastOutboundAt ?? null
	};
}
async function runStoppablePassiveMonitor(params) {
	await runPassiveAccountLifecycle({
		abortSignal: params.abortSignal,
		start: params.start,
		stop: async (monitor) => {
			monitor.stop();
		}
	});
}
function resolveLoggerBackedRuntime(runtime, logger) {
	return runtime ?? createLoggerBackedRuntime({
		logger,
		exitError: () => /* @__PURE__ */ new Error("Runtime exit not available")
	});
}
function requireChannelOpenAllowFrom(params) {
	params.requireOpenAllowFrom({
		policy: params.policy,
		allowFrom: params.allowFrom,
		ctx: params.ctx,
		path: ["allowFrom"],
		message: `channels.${params.channel}.dmPolicy="open" requires channels.${params.channel}.allowFrom to include "*"`
	});
}
function readStatusIssueFields(value, fields) {
	if (!value || typeof value !== "object") return null;
	const record = value;
	const result = {};
	for (const field of fields) result[field] = record[field];
	return result;
}
function coerceStatusIssueAccountId(value) {
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : void 0;
}
function createDeferred() {
	let resolve;
	let reject;
	return {
		promise: new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		}),
		resolve,
		reject
	};
}
const DEFAULT_PACKAGE_JSON_VERSION_CANDIDATES = [
	"../package.json",
	"./package.json",
	"../../package.json"
];
function formatPluginConfigIssue(issue, options) {
	if (!issue) return options?.invalidConfigMessage ?? "invalid config";
	if (issue.code === "unrecognized_keys" && issue.keys.length > 0) return options?.unknownKeyMessage?.(issue.keys[0]) ?? `unknown config key: ${issue.keys[0]}`;
	if (issue.code === "invalid_type" && issue.path.length === 0) return options?.rootInvalidTypeMessage ?? "expected config object";
	return issue.message;
}
function normalizePluginConfigIssuePath(path) {
	return path.filter((segment) => {
		const kind = typeof segment;
		return kind === "string" || kind === "number";
	});
}
function mapPluginConfigIssues(issues, options) {
	return issues.map((issue) => ({
		path: normalizePluginConfigIssuePath(issue.path),
		message: formatPluginConfigIssue(issue, options)
	}));
}
function canResolveEnvSecretRefInReadOnlyPath(params) {
	const providerConfig = params.cfg?.secrets?.providers?.[params.provider];
	if (!providerConfig) return params.provider === resolveDefaultSecretProviderAlias(params.cfg ?? {}, "env");
	if (providerConfig.source !== "env") return false;
	const allowlist = providerConfig.allowlist;
	return !allowlist || allowlist.includes(params.id);
}
function readPluginPackageVersion(params) {
	for (const candidate of params.candidates ?? DEFAULT_PACKAGE_JSON_VERSION_CANDIDATES) try {
		const version = params.require(candidate).version;
		if (typeof version === "string" && version.trim().length > 0) return version;
	} catch {}
	return params.fallback ?? "unknown";
}
async function resolveAmbientNodeProxyAgent(params) {
	const protocol = params?.protocol ?? "https";
	if (!hasAmbientNodeProxyConfigured({ protocol })) return;
	try {
		const proxyTls = resolveActiveManagedProxyTlsOptions();
		const agent = createAmbientNodeProxyAgent({
			protocol,
			...proxyTls ? { proxyTls } : {}
		});
		if (agent === void 0) return;
		params?.onUsingProxy?.();
		return agent;
	} catch (error) {
		params?.onError?.(error);
		return;
	}
}
//#endregion
export { coerceStatusIssueAccountId as a, mapPluginConfigIssues as c, readStatusIssueFields as d, requireChannelOpenAllowFrom as f, runStoppablePassiveMonitor as h, canResolveEnvSecretRefInReadOnlyPath as i, normalizePluginConfigIssuePath as l, resolveLoggerBackedRuntime as m, buildPassiveProbedChannelStatusSummary as n, createDeferred as o, resolveAmbientNodeProxyAgent as p, buildTrafficStatusSummary as r, formatPluginConfigIssue as s, buildPassiveChannelStatusSummary as t, readPluginPackageVersion as u };
