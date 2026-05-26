import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { p as resolveUserPath } from "./utils-CKsuXgDI.js";
import "./types.secrets-BxqheYvy.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-26EcJVc0.js";
import { n as saveJsonFile, t as loadJsonFile } from "./json-file-C3OPVumq.js";
import "./ref-contract-BLk8mcqQ.js";
import "./provider-env-vars-Bdegz5z9.js";
import { n as ensureAuthProfileStore } from "./store-a4exFSck.js";
import "./model-auth-markers-UDEQVW7W.js";
import { t as resolveEnvApiKey } from "./model-auth-env-CblHr3q1.js";
import "./models-config.providers.secrets-DzUJ8-IV.js";
import { n as resolveProviderEndpoint } from "./provider-attribution-BJpDy8Xw.js";
import { n as resolveApiKeyForProfile } from "./oauth-B8qSiLIG.js";
import { n as listProfilesForProvider } from "./profile-list-1dJMPDMe.js";
import "./repair-CzDi-eiN.js";
import { i as resolveAuthProfileOrder } from "./order-YU9choem.js";
import "./profiles-Bj_dclxz.js";
import "./provider-model-shared-D-slKnZa.js";
import "./provider-auth-input-BB3v7mkT.js";
import "./provider-auth-helpers-Hp3hWZu2.js";
import "./provider-api-key-auth-DaaaGg6p.js";
import "./provider-auth-result-Bwa-OosX.js";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
//#region src/plugin-sdk/agent-dir-compat.ts
/**
* @deprecated Prefer resolveAgentDir(cfg, agentId) or resolveDefaultAgentDir(cfg).
* Kept for third-party plugin SDK compatibility.
*/
function resolveOpenClawAgentDir(env = process.env) {
	const override = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
	return override ? resolveUserPath(override, env) : resolveDefaultAgentDir({}, env);
}
//#endregion
//#region src/plugin-sdk/oauth-utils.ts
/**
* Encode a flat object as application/x-www-form-urlencoded form data.
*
* @deprecated OAuth provider-owned helper; keep this local to provider plugins instead.
*/
function toFormUrlEncoded(data) {
	return Object.entries(data).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}
/**
* Generate a PKCE verifier/challenge pair suitable for OAuth authorization flows.
*
* @deprecated OAuth provider-owned helper; keep this local to provider plugins instead.
*/
function generatePkceVerifierChallenge() {
	const verifier = randomBytes(32).toString("base64url");
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url")
	};
}
/** Generate a PKCE verifier/challenge pair with a 64-character hex verifier. */
function generateHexPkceVerifierChallenge() {
	const verifier = randomBytes(32).toString("hex");
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url")
	};
}
//#endregion
//#region src/plugin-sdk/provider-auth.ts
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
const COPILOT_EDITOR_VERSION = "vscode/1.96.2";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
const COPILOT_USER_AGENT = "GitHubCopilotChat/0.26.7";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
const COPILOT_GITHUB_API_VERSION = "2025-04-01";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
const COPILOT_INTEGRATION_ID = "vscode-chat";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
function buildCopilotIdeHeaders(params = {}) {
	return {
		"Editor-Version": COPILOT_EDITOR_VERSION,
		"Editor-Plugin-Version": COPILOT_EDITOR_PLUGIN_VERSION,
		"User-Agent": COPILOT_USER_AGENT,
		...params.includeApiVersion ? { "X-Github-Api-Version": COPILOT_GITHUB_API_VERSION } : {}
	};
}
function resolveCopilotTokenCachePath(env = process.env) {
	return path.join(resolveStateDir(env), "credentials", "github-copilot.token.json");
}
function isCopilotTokenUsable(cache, now = Date.now()) {
	return cache.integrationId === "vscode-chat" && cache.expiresAt - now > 300 * 1e3;
}
function parseCopilotTokenResponse(value) {
	if (!value || typeof value !== "object") throw new Error("Unexpected response from GitHub Copilot token endpoint");
	const asRecord = value;
	const token = asRecord.token;
	const expiresAt = asRecord.expires_at;
	if (typeof token !== "string" || token.trim().length === 0) throw new Error("Copilot token response missing token");
	let expiresAtMs;
	if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) expiresAtMs = expiresAt < 1e11 ? expiresAt * 1e3 : expiresAt;
	else if (typeof expiresAt === "string" && expiresAt.trim().length > 0) {
		const parsed = Number.parseInt(expiresAt, 10);
		if (!Number.isFinite(parsed)) throw new Error("Copilot token response has invalid expires_at");
		expiresAtMs = parsed < 1e11 ? parsed * 1e3 : parsed;
	} else throw new Error("Copilot token response missing expires_at");
	return {
		token,
		expiresAt: expiresAtMs
	};
}
function resolveCopilotProxyHost(proxyEp) {
	const trimmed = proxyEp.trim();
	if (!trimmed) return null;
	const urlText = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(urlText);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return normalizeLowercaseStringOrEmpty(url.hostname);
	} catch {
		return null;
	}
}
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
function deriveCopilotApiBaseUrlFromToken(token) {
	const trimmed = token.trim();
	if (!trimmed) return null;
	const proxyEp = trimmed.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)?.[1]?.trim();
	if (!proxyEp) return null;
	const proxyHost = resolveCopilotProxyHost(proxyEp);
	if (!proxyHost) return null;
	const baseUrl = `https://${proxyHost.replace(/^proxy\./i, "api.")}`;
	return resolveProviderEndpoint(baseUrl).endpointClass === "invalid" ? null : baseUrl;
}
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
async function resolveCopilotApiToken(params) {
	const env = params.env ?? process.env;
	const cachePath = params.cachePath?.trim() || resolveCopilotTokenCachePath(env);
	const loadJsonFileFn = params.loadJsonFileImpl ?? loadJsonFile;
	const saveJsonFileFn = params.saveJsonFileImpl ?? saveJsonFile;
	const cached = loadJsonFileFn(cachePath);
	if (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
		if (isCopilotTokenUsable(cached)) return {
			token: cached.token,
			expiresAt: cached.expiresAt,
			source: `cache:${cachePath}`,
			baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) ?? "https://api.individual.githubcopilot.com"
		};
	}
	const res = await (params.fetchImpl ?? fetch)(COPILOT_TOKEN_URL, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${params.githubToken}`,
			"Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
			...buildCopilotIdeHeaders({ includeApiVersion: true })
		}
	});
	if (!res.ok) throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);
	const json = parseCopilotTokenResponse(await res.json());
	const payload = {
		token: json.token,
		expiresAt: json.expiresAt,
		updatedAt: Date.now(),
		integrationId: COPILOT_INTEGRATION_ID
	};
	saveJsonFileFn(cachePath, payload);
	return {
		token: payload.token,
		expiresAt: payload.expiresAt,
		source: `fetched:${COPILOT_TOKEN_URL}`,
		baseUrl: deriveCopilotApiBaseUrlFromToken(payload.token) ?? "https://api.individual.githubcopilot.com"
	};
}
function isProviderApiKeyConfigured(params) {
	if (resolveEnvApiKey(params.provider)?.apiKey) return true;
	const agentDir = params.agentDir?.trim();
	if (!agentDir) return false;
	return listProfilesForProvider(ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false }), params.provider).length > 0;
}
function listUsableProviderAuthProfileIds(params) {
	try {
		const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.cfg ?? {});
		const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
		return {
			agentDir,
			profileIds: resolveAuthProfileOrder({
				cfg: params.cfg,
				store,
				provider: params.provider
			})
		};
	} catch {
		return {
			agentDir: "",
			profileIds: []
		};
	}
}
function isProviderAuthProfileConfigured(params) {
	return listUsableProviderAuthProfileIds(params).profileIds.length > 0;
}
async function resolveProviderAuthProfileApiKey(params) {
	const { agentDir, profileIds } = listUsableProviderAuthProfileIds(params);
	if (!agentDir || profileIds.length === 0) return;
	const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
	for (const profileId of profileIds) {
		const resolved = await resolveApiKeyForProfile({
			cfg: params.cfg,
			store,
			agentDir,
			profileId
		});
		if (resolved?.apiKey) return resolved.apiKey;
	}
}
//#endregion
export { resolveOpenClawAgentDir as _, COPILOT_USER_AGENT as a, deriveCopilotApiBaseUrlFromToken as c, listUsableProviderAuthProfileIds as d, resolveCopilotApiToken as f, toFormUrlEncoded as g, generatePkceVerifierChallenge as h, COPILOT_INTEGRATION_ID as i, isProviderApiKeyConfigured as l, generateHexPkceVerifierChallenge as m, COPILOT_EDITOR_VERSION as n, DEFAULT_COPILOT_API_BASE_URL as o, resolveProviderAuthProfileApiKey as p, COPILOT_GITHUB_API_VERSION as r, buildCopilotIdeHeaders as s, COPILOT_EDITOR_PLUGIN_VERSION as t, isProviderAuthProfileConfigured as u };
