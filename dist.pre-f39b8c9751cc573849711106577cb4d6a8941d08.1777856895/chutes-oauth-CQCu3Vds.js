import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { createHash, randomBytes } from "node:crypto";
//#region src/agents/chutes-oauth.ts
const CHUTES_OAUTH_ISSUER = "https://api.chutes.ai";
const CHUTES_AUTHORIZE_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/authorize`;
const CHUTES_TOKEN_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/token`;
const CHUTES_USERINFO_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/userinfo`;
const DEFAULT_EXPIRES_BUFFER_MS = 300 * 1e3;
function generateChutesPkce() {
	const verifier = randomBytes(32).toString("hex");
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url")
	};
}
function parseOAuthCallbackInput(input, expectedState) {
	const trimmed = input.trim();
	if (!trimmed) return { error: "No input provided" };
	let url;
	try {
		url = new URL(trimmed);
	} catch {
		if (!/\s/.test(trimmed) && !trimmed.includes("://") && !trimmed.includes("?") && !trimmed.includes("=")) return { error: "Paste the full redirect URL (must include code + state)." };
		const qs = trimmed.startsWith("?") ? trimmed : `?${trimmed}`;
		try {
			url = new URL(`http://localhost/${qs}`);
		} catch {
			return { error: "Paste the full redirect URL (must include code + state)." };
		}
	}
	const code = normalizeOptionalString(url.searchParams.get("code"));
	const state = normalizeOptionalString(url.searchParams.get("state"));
	if (!code) return { error: "Missing 'code' parameter in URL" };
	if (!state) return { error: "Missing 'state' parameter. Paste the full redirect URL." };
	if (state !== expectedState) return { error: "OAuth state mismatch - possible CSRF attack. Please retry login." };
	return {
		code,
		state
	};
}
function coerceExpiresAt(expiresInSeconds, now) {
	const value = now + Math.max(0, Math.floor(expiresInSeconds)) * 1e3 - DEFAULT_EXPIRES_BUFFER_MS;
	return Math.max(value, now + 3e4);
}
async function fetchChutesUserInfo(params) {
	const response = await (params.fetchFn ?? fetch)(CHUTES_USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${params.accessToken}` } });
	if (!response.ok) return null;
	const data = await response.json();
	if (!data || typeof data !== "object") return null;
	return data;
}
async function exchangeChutesCodeForTokens(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const now = params.now ?? Date.now();
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: params.app.clientId,
		code: params.code,
		redirect_uri: params.app.redirectUri,
		code_verifier: params.codeVerifier
	});
	if (params.app.clientSecret) body.set("client_secret", params.app.clientSecret);
	const response = await fetchFn(CHUTES_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Chutes token exchange failed: ${text}`);
	}
	const data = await response.json();
	const access = data.access_token?.trim();
	const refresh = data.refresh_token?.trim();
	const expiresIn = data.expires_in ?? 0;
	if (!access) throw new Error("Chutes token exchange returned no access_token");
	if (!refresh) throw new Error("Chutes token exchange returned no refresh_token");
	const info = await fetchChutesUserInfo({
		accessToken: access,
		fetchFn
	});
	return {
		access,
		refresh,
		expires: coerceExpiresAt(expiresIn, now),
		email: info?.username,
		accountId: info?.sub,
		clientId: params.app.clientId
	};
}
async function refreshChutesTokens(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const now = params.now ?? Date.now();
	const refreshToken = params.credential.refresh?.trim();
	if (!refreshToken) throw new Error("Chutes OAuth credential is missing refresh token");
	const clientId = params.credential.clientId?.trim() ?? process.env.CHUTES_CLIENT_ID?.trim();
	if (!clientId) throw new Error("Missing CHUTES_CLIENT_ID for Chutes OAuth refresh (set env var or re-auth).");
	const clientSecret = normalizeOptionalString(process.env.CHUTES_CLIENT_SECRET);
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: clientId,
		refresh_token: refreshToken
	});
	if (clientSecret) body.set("client_secret", clientSecret);
	const response = await fetchFn(CHUTES_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Chutes token refresh failed: ${text}`);
	}
	const data = await response.json();
	const access = data.access_token?.trim();
	const newRefresh = data.refresh_token?.trim();
	const expiresIn = data.expires_in ?? 0;
	if (!access) throw new Error("Chutes token refresh returned no access_token");
	return {
		...params.credential,
		access,
		refresh: newRefresh || refreshToken,
		expires: coerceExpiresAt(expiresIn, now),
		clientId
	};
}
//#endregion
export { refreshChutesTokens as a, parseOAuthCallbackInput as i, exchangeChutesCodeForTokens as n, generateChutesPkce as r, CHUTES_AUTHORIZE_ENDPOINT as t };
