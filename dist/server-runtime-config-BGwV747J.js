import { n as isVitestRuntimeEnv } from "./env-Dhqok4CP.js";
import { i as isLoopbackHost, l as isValidIPv4, p as resolveGatewayBindHost, t as defaultGatewayBindMode } from "./net-DCUMtgJy.js";
import { t as assertGatewayAuthConfigured } from "./auth-DZ1o6pTQ.js";
import { n as resolveGatewayAuth } from "./auth-resolve-BEn3Se6k.js";
import { r as normalizeControlUiBasePath } from "./control-ui-shared-C2-bVRg-.js";
import { r as mergeGatewayTailscaleConfig } from "./startup-auth-CWNnB8iD.js";
import { _ as resolveHooksConfig } from "./hooks-BrCZyF5b.js";
//#region src/gateway/env-deprecation.ts
const LEGACY_ENV_PREFIXES = ["CLAWDBOT_", "MOLTBOT_"];
let warned = false;
function warnLegacyOpenClawEnvVars(env = process.env) {
	if (warned || isVitestRuntimeEnv(env)) return;
	const prefixCounts = /* @__PURE__ */ new Map();
	for (const key of Object.keys(env)) {
		const prefix = LEGACY_ENV_PREFIXES.find((candidate) => key.startsWith(candidate));
		if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
	}
	const legacyVarCount = [...prefixCounts.values()].reduce((total, count) => total + count, 0);
	if (legacyVarCount === 0) return;
	const detectedPrefixes = LEGACY_ENV_PREFIXES.filter((prefix) => prefixCounts.has(prefix)).map((prefix) => `${prefix}*`).join(", ");
	process.emitWarning([`Legacy ${detectedPrefixes} environment variables were detected (${legacyVarCount} total), but OpenClaw only reads OPENCLAW_* names now.`, "Rename them by replacing the legacy prefix with OPENCLAW_; the old names are ignored."].join("\n"), {
		code: "OPENCLAW_LEGACY_ENV_VARS",
		type: "DeprecationWarning"
	});
	warned = true;
}
//#endregion
//#region src/gateway/server-runtime-config.ts
async function resolveGatewayRuntimeConfig(params) {
	warnLegacyOpenClawEnvVars();
	const tailscaleModeEarly = (params.tailscale?.mode ?? params.cfg.gateway?.tailscale?.mode) || "off";
	const bindMode = params.bind ?? params.cfg.gateway?.bind ?? (tailscaleModeEarly !== "off" ? "loopback" : defaultGatewayBindMode());
	const customBindHost = params.cfg.gateway?.customBindHost;
	const bindHost = params.host ?? await resolveGatewayBindHost(bindMode, customBindHost);
	if (bindMode === "loopback" && !isLoopbackHost(bindHost)) throw new Error(`gateway bind=loopback resolved to non-loopback host ${bindHost}; refusing fallback to a network bind`);
	if (bindMode === "custom") {
		const configuredCustomBindHost = customBindHost?.trim();
		if (!configuredCustomBindHost) throw new Error("gateway.bind=custom requires gateway.customBindHost");
		if (!isValidIPv4(configuredCustomBindHost)) throw new Error(`gateway.bind=custom requires a valid IPv4 customBindHost (got ${configuredCustomBindHost})`);
		if (bindHost !== configuredCustomBindHost) throw new Error(`gateway bind=custom requested ${configuredCustomBindHost} but resolved ${bindHost}; refusing fallback`);
	}
	const controlUiEnabled = params.controlUiEnabled ?? params.cfg.gateway?.controlUi?.enabled ?? true;
	const openAiChatCompletionsConfig = params.cfg.gateway?.http?.endpoints?.chatCompletions;
	const openAiChatCompletionsEnabled = params.openAiChatCompletionsEnabled ?? openAiChatCompletionsConfig?.enabled ?? false;
	const openResponsesConfig = params.cfg.gateway?.http?.endpoints?.responses;
	const openResponsesEnabled = params.openResponsesEnabled ?? openResponsesConfig?.enabled ?? false;
	const strictTransportSecurityConfig = params.cfg.gateway?.http?.securityHeaders?.strictTransportSecurity;
	const strictTransportSecurityHeader = strictTransportSecurityConfig === false ? void 0 : typeof strictTransportSecurityConfig === "string" && strictTransportSecurityConfig.trim().length > 0 ? strictTransportSecurityConfig.trim() : void 0;
	const controlUiBasePath = normalizeControlUiBasePath(params.cfg.gateway?.controlUi?.basePath);
	const controlUiRootRaw = params.cfg.gateway?.controlUi?.root;
	const controlUiRoot = typeof controlUiRootRaw === "string" && controlUiRootRaw.trim().length > 0 ? controlUiRootRaw.trim() : void 0;
	const tailscaleConfig = mergeGatewayTailscaleConfig(params.cfg.gateway?.tailscale ?? {}, params.tailscale ?? {});
	const tailscaleMode = tailscaleConfig.mode ?? "off";
	const resolvedAuth = resolveGatewayAuth({
		authConfig: params.cfg.gateway?.auth,
		authOverride: params.auth,
		env: process.env,
		tailscaleMode
	});
	const authMode = resolvedAuth.mode;
	const hasToken = typeof resolvedAuth.token === "string" && resolvedAuth.token.trim().length > 0;
	const hasPassword = typeof resolvedAuth.password === "string" && resolvedAuth.password.trim().length > 0;
	const hasSharedSecret = authMode === "token" && hasToken || authMode === "password" && hasPassword;
	const hooksConfig = resolveHooksConfig(params.cfg);
	const trustedProxies = params.cfg.gateway?.trustedProxies ?? [];
	const controlUiAllowedOrigins = (params.cfg.gateway?.controlUi?.allowedOrigins ?? []).map((value) => value.trim()).filter(Boolean);
	const dangerouslyAllowHostHeaderOriginFallback = params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
	assertGatewayAuthConfigured(resolvedAuth, params.cfg.gateway?.auth);
	if (tailscaleMode === "funnel" && authMode !== "password") throw new Error("tailscale funnel requires gateway auth mode=password (set gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD)");
	if (tailscaleMode !== "off" && !isLoopbackHost(bindHost)) throw new Error("tailscale serve/funnel requires gateway bind=loopback (127.0.0.1)");
	if (!isLoopbackHost(bindHost) && !hasSharedSecret && authMode !== "trusted-proxy") throw new Error(`refusing to bind gateway to ${bindHost}:${params.port} without auth (set gateway.auth.token/password, or set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD; legacy CLAWDBOT_* and MOLTBOT_* environment variables are ignored)`);
	if (controlUiEnabled && !isLoopbackHost(bindHost) && controlUiAllowedOrigins.length === 0 && !dangerouslyAllowHostHeaderOriginFallback) throw new Error("non-loopback Control UI requires gateway.controlUi.allowedOrigins (set explicit origins), or set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true to use Host-header origin fallback mode");
	if (authMode === "trusted-proxy") {
		if (trustedProxies.length === 0) throw new Error("gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured with at least one proxy IP");
	}
	return {
		bindHost,
		controlUiEnabled,
		openAiChatCompletionsEnabled,
		openAiChatCompletionsConfig: openAiChatCompletionsConfig ? {
			...openAiChatCompletionsConfig,
			enabled: openAiChatCompletionsEnabled
		} : void 0,
		openResponsesEnabled,
		openResponsesConfig: openResponsesConfig ? {
			...openResponsesConfig,
			enabled: openResponsesEnabled
		} : void 0,
		strictTransportSecurityHeader,
		controlUiBasePath,
		controlUiRoot,
		resolvedAuth,
		authMode,
		tailscaleConfig,
		tailscaleMode,
		hooksConfig
	};
}
//#endregion
export { resolveGatewayRuntimeConfig };
