import { t as sanitizeForLog } from "./ansi-Dqm1lzVL.js";
import { t as formatCliCommand } from "./command-format-ut6bcRZg.js";
import { r as normalizeProviderId } from "./provider-id-DIRgKpoh.js";
//#region src/agents/auth-profiles/oauth-refresh-failure.ts
const OAUTH_REFRESH_FAILURE_PROVIDER_RE = /OAuth token refresh failed for ([^:]+):/i;
const SAFE_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
function extractOAuthRefreshFailureProvider(message) {
	const provider = message.match(OAUTH_REFRESH_FAILURE_PROVIDER_RE)?.[1]?.trim();
	return provider && provider.length > 0 ? provider : null;
}
function sanitizeOAuthRefreshFailureProvider(provider) {
	const normalized = normalizeProviderId(provider ? sanitizeForLog(provider).replaceAll("`", "").trim() : "");
	return normalized && SAFE_PROVIDER_ID_RE.test(normalized) ? normalized : null;
}
function classifyOAuthRefreshFailureReason(message) {
	const lower = message.toLowerCase();
	if (lower.includes("refresh_token_reused")) return "refresh_token_reused";
	if (lower.includes("invalid_grant")) return "invalid_grant";
	if (lower.includes("signing in again") || lower.includes("sign in again")) return "sign_in_again";
	if (lower.includes("invalid refresh token")) return "invalid_refresh_token";
	if (lower.includes("expired or revoked") || lower.includes("revoked")) return "revoked";
	return null;
}
function classifyOAuthRefreshFailure(message) {
	if (!/oauth token refresh failed/i.test(message)) return null;
	return {
		provider: sanitizeOAuthRefreshFailureProvider(extractOAuthRefreshFailureProvider(message)),
		reason: classifyOAuthRefreshFailureReason(message)
	};
}
function buildOAuthRefreshFailureLoginCommand(provider) {
	const safeProvider = sanitizeOAuthRefreshFailureProvider(provider);
	return safeProvider ? formatCliCommand(`openclaw models auth login --provider ${safeProvider}`) : formatCliCommand("openclaw models auth login");
}
//#endregion
export { classifyOAuthRefreshFailure as n, classifyOAuthRefreshFailureReason as r, buildOAuthRefreshFailureLoginCommand as t };
