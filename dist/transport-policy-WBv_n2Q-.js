import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./provider-model-shared-DtsPmvDx.js";
import { i as isOpenAICodexBaseUrl, r as isOpenAIApiBaseUrl } from "./base-url-UKY1cn1G.js";
//#region extensions/openai/transport-policy.ts
const DEFAULT_OPENAI_WS_DEGRADE_COOLDOWN_MS = 6e4;
const AZURE_PROVIDER_IDS = new Set(["azure-openai", "azure-openai-responses"]);
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
function isAzureOpenAIBaseUrl(baseUrl) {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return false;
	try {
		return normalizeLowercaseStringOrEmpty(new URL(trimmed).hostname).endsWith(".openai.azure.com");
	} catch {
		return false;
	}
}
function normalizeIdentityValue(value, maxLength = 160) {
	const trimmed = value.trim().replace(/[\r\n]+/g, " ");
	return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}
function usesKnownNativeOpenAIRoute(provider, baseUrl) {
	const normalizedProvider = normalizeProviderId(provider);
	if (!normalizedProvider) return false;
	if (normalizedProvider === "openai") return !baseUrl || isOpenAIApiBaseUrl(baseUrl);
	if (AZURE_PROVIDER_IDS.has(normalizedProvider)) return !baseUrl || isAzureOpenAIBaseUrl(baseUrl);
	if (normalizedProvider === OPENAI_CODEX_PROVIDER_ID) return !baseUrl || isOpenAIApiBaseUrl(baseUrl) || isOpenAICodexBaseUrl(baseUrl);
	return false;
}
function resolveSessionHeaders(params) {
	if (!params.sessionId || !usesKnownNativeOpenAIRoute(params.provider, params.baseUrl)) return;
	const sessionId = normalizeIdentityValue(params.sessionId);
	if (!sessionId) return;
	return {
		"x-client-request-id": sessionId,
		"x-openclaw-session-id": sessionId
	};
}
function resolveOpenAITransportTurnState(ctx) {
	const sessionHeaders = resolveSessionHeaders({
		provider: ctx.provider,
		baseUrl: ctx.model?.baseUrl,
		sessionId: ctx.sessionId
	});
	if (!sessionHeaders) return;
	const turnId = normalizeIdentityValue(ctx.turnId);
	const attempt = String(Math.max(1, ctx.attempt));
	return {
		headers: {
			...sessionHeaders,
			"x-openclaw-turn-id": turnId,
			"x-openclaw-turn-attempt": attempt
		},
		metadata: {
			openclaw_session_id: sessionHeaders["x-openclaw-session-id"] ?? "",
			openclaw_turn_id: turnId,
			openclaw_turn_attempt: attempt,
			openclaw_transport: ctx.transport
		}
	};
}
function resolveOpenAIWebSocketSessionPolicy(ctx) {
	if (!usesKnownNativeOpenAIRoute(ctx.provider, ctx.model?.baseUrl)) return;
	return {
		headers: resolveSessionHeaders({
			provider: ctx.provider,
			baseUrl: ctx.model?.baseUrl,
			sessionId: ctx.sessionId
		}),
		degradeCooldownMs: DEFAULT_OPENAI_WS_DEGRADE_COOLDOWN_MS
	};
}
//#endregion
export { resolveOpenAIWebSocketSessionPolicy as n, resolveOpenAITransportTurnState as t };
