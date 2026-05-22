import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import os from "node:os";
//#region extensions/google/vertex-adc.ts
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
let cachedGoogleVertexAuthorizedUserToken;
function resetGoogleVertexAuthorizedUserTokenCacheForTest() {
	cachedGoogleVertexAuthorizedUserToken = void 0;
}
function normalizeOptionalString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function isGoogleVertexCredentialsMarker(apiKey) {
	return apiKey === void 0 || apiKey === GCP_VERTEX_CREDENTIALS_MARKER;
}
function resolveGoogleApplicationCredentialsPath(env = process.env) {
	const explicit = normalizeOptionalString(env.GOOGLE_APPLICATION_CREDENTIALS);
	if (explicit) return existsSync(explicit) ? explicit : void 0;
	const homeDir = normalizeOptionalString(env.HOME) ?? os.homedir();
	const homeFallback = path.join(homeDir, ".config", "gcloud", "application_default_credentials.json");
	if (existsSync(homeFallback)) return homeFallback;
	const appDataDir = normalizeOptionalString(env.APPDATA);
	if (!appDataDir) return;
	const appDataFallback = path.join(appDataDir, "gcloud", "application_default_credentials.json");
	return existsSync(appDataFallback) ? appDataFallback : void 0;
}
async function readGoogleAuthorizedUserCredentials(credentialsPath) {
	let parsed;
	try {
		parsed = JSON.parse(await readFile(credentialsPath, "utf8"));
	} catch {
		return;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
	const record = parsed;
	if (record.type !== "authorized_user") return;
	return {
		type: "authorized_user",
		client_id: normalizeOptionalString(record.client_id),
		client_secret: normalizeOptionalString(record.client_secret),
		refresh_token: normalizeOptionalString(record.refresh_token)
	};
}
function hasGoogleVertexAuthorizedUserAdcSync(env = process.env) {
	const credentialsPath = resolveGoogleApplicationCredentialsPath(env);
	if (!credentialsPath) return false;
	try {
		const parsed = JSON.parse(readFileSync(credentialsPath, "utf8"));
		return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed) && parsed.type === "authorized_user";
	} catch {
		return false;
	}
}
async function refreshGoogleVertexAuthorizedUserAccessToken(params) {
	const clientId = normalizeOptionalString(params.credentials.client_id);
	const clientSecret = normalizeOptionalString(params.credentials.client_secret);
	const refreshToken = normalizeOptionalString(params.credentials.refresh_token);
	if (!clientId || !clientSecret || !refreshToken) throw new Error("Google Vertex authorized_user ADC is missing client_id, client_secret, or refresh_token.");
	const cached = cachedGoogleVertexAuthorizedUserToken;
	if (cached?.credentialsPath === params.credentialsPath && cached.refreshToken === refreshToken && cached.expiresAtMs - Date.now() > 6e4) return cached.token;
	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: refreshToken,
		grant_type: "refresh_token"
	});
	const response = await (params.fetchImpl ?? fetch)(GOOGLE_OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body
	});
	const payload = await response.json().catch(() => void 0);
	if (!response.ok) {
		const description = normalizeOptionalString(payload?.error_description);
		const code = normalizeOptionalString(payload?.error);
		throw new Error(`Google Vertex ADC token refresh failed: ${response.status}${code ? ` ${code}` : ""}${description ? ` (${description})` : ""}`);
	}
	const token = normalizeOptionalString(payload?.access_token);
	if (!token) throw new Error("Google Vertex ADC token refresh response did not include an access_token.");
	const expiresInSeconds = typeof payload?.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
	cachedGoogleVertexAuthorizedUserToken = {
		token,
		expiresAtMs: Date.now() + Math.max(1, expiresInSeconds) * 1e3,
		credentialsPath: params.credentialsPath,
		refreshToken
	};
	return token;
}
async function resolveGoogleVertexAuthorizedUserHeaders(fetchImpl) {
	const credentialsPath = resolveGoogleApplicationCredentialsPath();
	if (!credentialsPath) throw new Error("Google Vertex ADC credentials not found. Set GOOGLE_APPLICATION_CREDENTIALS or run gcloud auth application-default login.");
	const credentials = await readGoogleAuthorizedUserCredentials(credentialsPath);
	if (!credentials) throw new Error("Google Vertex ADC fallback requires an authorized_user credentials file.");
	return { Authorization: `Bearer ${await refreshGoogleVertexAuthorizedUserAccessToken({
		credentialsPath,
		credentials,
		fetchImpl
	})}` };
}
//#endregion
export { resolveGoogleVertexAuthorizedUserHeaders as i, isGoogleVertexCredentialsMarker as n, resetGoogleVertexAuthorizedUserTokenCacheForTest as r, hasGoogleVertexAuthorizedUserAdcSync as t };
