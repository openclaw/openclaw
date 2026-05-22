import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { u as resolveGatewayPort } from "./paths-Cnwfh6dH.js";
import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import { a as trimToUndefined } from "./credential-planner-TRN8ZQQS.js";
import { r as resolveGatewayCredentialsFromConfig } from "./credentials-3pqoqcnv.js";
import { i as getRuntimeConfig } from "./io-rEK73C2c.js";
import "./config-CWWzPkaY.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BNv08iCR.js";
import { u as resolveLeastPrivilegeOperatorScopesForMethod } from "./method-scopes-DfV0ICXA.js";
import { r as callGateway } from "./call-ICzU8dj9.js";
import { t as getOperatorApprovalRuntimeToken } from "./operator-approval-runtime-token-KD7pf53L.js";
import { _ as readStringParam } from "./common-DZFnGYgt.js";
//#region src/agents/tools/gateway.ts
function readGatewayCallOptions(params) {
	return {
		gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
		gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
		timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : void 0
	};
}
function canonicalizeToolGatewayWsUrl(raw) {
	const input = raw.trim();
	let url;
	try {
		url = new URL(input);
	} catch (error) {
		const message = formatErrorMessage(error);
		throw new Error(`invalid gatewayUrl: ${input} (${message})`, { cause: error });
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`invalid gatewayUrl protocol: ${url.protocol} (expected ws:// or wss://)`);
	if (url.username || url.password) throw new Error("invalid gatewayUrl: credentials are not allowed");
	if (url.search || url.hash) throw new Error("invalid gatewayUrl: query/hash not allowed");
	if (url.pathname && url.pathname !== "/") throw new Error("invalid gatewayUrl: path not allowed");
	return {
		origin: url.origin,
		key: `${url.protocol}//${normalizeLowercaseStringOrEmpty(url.host)}`
	};
}
function validateGatewayUrlOverrideForAgentTools(params) {
	const { cfg } = params;
	const port = resolveGatewayPort(cfg);
	const localAllowed = new Set([
		`ws://127.0.0.1:${port}`,
		`wss://127.0.0.1:${port}`,
		`ws://localhost:${port}`,
		`wss://localhost:${port}`,
		`ws://[::1]:${port}`,
		`wss://[::1]:${port}`
	]);
	let remoteKey;
	const remoteUrl = normalizeOptionalString(cfg.gateway?.remote?.url) ?? "";
	if (remoteUrl) try {
		remoteKey = canonicalizeToolGatewayWsUrl(remoteUrl).key;
	} catch {}
	const parsed = canonicalizeToolGatewayWsUrl(params.urlOverride);
	if (localAllowed.has(parsed.key)) return {
		url: parsed.origin,
		target: "local"
	};
	if (remoteKey && parsed.key === remoteKey) return {
		url: parsed.origin,
		target: "remote"
	};
	throw new Error([
		"gatewayUrl override rejected.",
		`Allowed: ws(s) loopback on port ${port} (127.0.0.1/localhost/[::1])`,
		"Or: configure gateway.remote.url and omit gatewayUrl to use the configured remote gateway."
	].join(" "));
}
function resolveGatewayOverrideToken(params) {
	if (params.explicitToken) return params.explicitToken;
	return resolveGatewayCredentialsFromConfig({
		cfg: params.cfg,
		env: process.env,
		modeOverride: params.target,
		remoteTokenFallback: params.target === "remote" ? "remote-only" : "remote-env-local",
		remotePasswordFallback: params.target === "remote" ? "remote-only" : "remote-env-local"
	}).token;
}
function resolveGatewayOptions(opts) {
	const cfg = getRuntimeConfig();
	const validatedOverride = trimToUndefined(opts?.gatewayUrl) !== void 0 ? validateGatewayUrlOverrideForAgentTools({
		cfg,
		urlOverride: String(opts?.gatewayUrl)
	}) : void 0;
	const explicitToken = trimToUndefined(opts?.gatewayToken);
	const token = validatedOverride ? resolveGatewayOverrideToken({
		cfg,
		target: validatedOverride.target,
		explicitToken
	}) : explicitToken;
	const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e4;
	return {
		url: validatedOverride?.url,
		token,
		timeoutMs
	};
}
const APPROVAL_RUNTIME_METHODS = new Set([
	"exec.approval.request",
	"exec.approval.waitDecision",
	"plugin.approval.request",
	"plugin.approval.waitDecision"
]);
function resolveApprovalRuntimeTokenForGatewayTool(params) {
	if (!APPROVAL_RUNTIME_METHODS.has(params.method)) return;
	if (trimToUndefined(params.opts.gatewayUrl) !== void 0) return;
	return getOperatorApprovalRuntimeToken();
}
async function callGatewayTool(method, opts, params, extra) {
	const gateway = resolveGatewayOptions(opts);
	const scopes = Array.isArray(extra?.scopes) ? extra.scopes : resolveLeastPrivilegeOperatorScopesForMethod(method, params);
	const approvalRuntimeToken = resolveApprovalRuntimeTokenForGatewayTool({
		method,
		opts
	});
	return await callGateway({
		url: gateway.url,
		token: gateway.token,
		method,
		params,
		timeoutMs: gateway.timeoutMs,
		expectFinal: extra?.expectFinal,
		clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
		clientDisplayName: "agent",
		mode: GATEWAY_CLIENT_MODES.BACKEND,
		...approvalRuntimeToken ? { approvalRuntimeToken } : {},
		scopes
	});
}
//#endregion
export { readGatewayCallOptions as n, resolveGatewayOptions as r, callGatewayTool as t };
