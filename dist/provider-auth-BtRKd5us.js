import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import "./types.secrets-DwPik3M8.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { n as saveJsonFile, t as loadJsonFile } from "./json-file-DpLhTVdZ.js";
import "./ref-contract-D_h_G00C.js";
import "./provider-env-vars-HpAfBQBJ.js";
import "./constants-D_82oc2f.js";
import { c as loadAuthProfileStoreForSecretsRuntime, l as loadAuthProfileStoreWithoutExternalProfiles, n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import "./model-auth-markers-Cf78z2Zm.js";
import { t as resolveEnvApiKey } from "./model-auth-env-CZ-LXyVa.js";
import "./models-config.providers.secrets-k1Lv9zej.js";
import { n as resolveProviderEndpoint } from "./provider-attribution-B2QMzk1g.js";
import { n as resolveApiKeyForProfile } from "./oauth--yqMDDjF.js";
import { n as listProfilesForProvider } from "./profile-list-C0HtPlut.js";
import "./profiles-9GB1thhi.js";
import "./repair-BQzHL5co.js";
import { i as resolveAuthProfileOrder } from "./order-DJrj83KE.js";
import { i as COPILOT_INTEGRATION_ID, s as buildCopilotIdeHeaders } from "./copilot-dynamic-headers-CVy4X1Kj.js";
import "./provider-model-shared-DtsPmvDx.js";
import "./provider-auth-input-DMNIEm93.js";
import "./provider-auth-helpers-BZ5Z8RV6.js";
import "./provider-api-key-auth-E_5Yag4W.js";
import "./agent-dir-compat-_xK_EqIx.js";
import "./provider-auth-result-qR7142tf.js";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
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
const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
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
		const { agentDir, profileIds } = resolveUsableProviderAuthProfiles(params);
		return {
			agentDir,
			profileIds
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
	const { agentDir, profileIds, store } = resolveUsableProviderAuthProfiles(params);
	if (!agentDir || profileIds.length === 0) return;
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
function resolveUsableProviderAuthProfiles(params) {
	const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.cfg ?? {});
	const store = loadAuthProfileStoreForSecretsRuntime(agentDir);
	const profileIds = resolveAuthProfileOrder({
		cfg: params.cfg,
		store,
		provider: params.provider
	});
	if (profileIds.length > 0) return {
		agentDir,
		profileIds,
		store
	};
	const fallbackStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
		allowKeychainPrompt: params.allowKeychainPrompt ?? false,
		resolveLegacyOAuthSidecars: true
	});
	return {
		agentDir,
		profileIds: resolveAuthProfileOrder({
			cfg: params.cfg,
			store: fallbackStore,
			provider: params.provider
		}),
		store: fallbackStore
	};
}
//#endregion
export { listUsableProviderAuthProfileIds as a, generateHexPkceVerifierChallenge as c, isProviderAuthProfileConfigured as i, generatePkceVerifierChallenge as l, deriveCopilotApiBaseUrlFromToken as n, resolveCopilotApiToken as o, isProviderApiKeyConfigured as r, resolveProviderAuthProfileApiKey as s, DEFAULT_COPILOT_API_BASE_URL as t, toFormUrlEncoded as u };
