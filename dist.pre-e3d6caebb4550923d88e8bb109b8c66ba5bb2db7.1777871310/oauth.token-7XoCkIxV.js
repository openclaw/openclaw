import { n as fetchWithSsrFGuard } from "./fetch-guard-C2Af5kcY.js";
import "./ssrf-runtime-B3HHI4NS.js";
import { a as MSTEAMS_OAUTH_REDIRECT_URI, n as MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS, s as buildMSTeamsTokenEndpoint, t as MSTEAMS_DEFAULT_DELEGATED_SCOPES } from "./oauth.shared-YqUN65-6.js";
//#region extensions/msteams/src/oauth.token.ts
/** Five-minute buffer subtracted from token expiry to avoid edge-case clock drift. */
const EXPIRY_BUFFER_MS = 300 * 1e3;
function createMSTeamsTokenBody(params) {
	const body = new URLSearchParams({
		client_id: params.clientId,
		client_secret: params.clientSecret,
		grant_type: params.grantType,
		scope: [...params.scopes].join(" ")
	});
	for (const [key, value] of Object.entries(params.values ?? {})) body.set(key, value);
	return body;
}
async function fetchMSTeamsTokens(params) {
	const currentFetch = globalThis.fetch;
	const { response, release } = await fetchWithSsrFGuard({
		url: params.tokenUrl,
		fetchImpl: async (input, guardedInit) => await currentFetch(input, guardedInit),
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
				Accept: "application/json"
			},
			body: params.body,
			signal: AbortSignal.timeout(MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS)
		},
		auditContext: params.auditContext
	});
	try {
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`MSTeams ${params.failureLabel} failed (${response.status}): ${errorText}`);
		}
		return await response.json();
	} finally {
		await release();
	}
}
async function requestMSTeamsDelegatedTokens(params) {
	const scopes = params.scopes ?? MSTEAMS_DEFAULT_DELEGATED_SCOPES;
	const body = createMSTeamsTokenBody({
		clientId: params.clientId,
		clientSecret: params.clientSecret,
		grantType: params.grantType,
		scopes,
		values: params.values
	});
	const data = await fetchMSTeamsTokens({
		tokenUrl: buildMSTeamsTokenEndpoint(params.tenantId),
		body,
		auditContext: params.auditContext,
		failureLabel: params.failureLabel
	});
	return {
		accessToken: data.access_token,
		refreshToken: params.resolveRefreshToken(data),
		expiresAt: Date.now() + data.expires_in * 1e3 - EXPIRY_BUFFER_MS,
		scopes: data.scope ? data.scope.split(" ") : [...scopes]
	};
}
async function exchangeMSTeamsCodeForTokens(params) {
	return await requestMSTeamsDelegatedTokens({
		tenantId: params.tenantId,
		clientId: params.clientId,
		clientSecret: params.clientSecret,
		grantType: "authorization_code",
		scopes: params.scopes,
		values: {
			code: params.code,
			redirect_uri: MSTEAMS_OAUTH_REDIRECT_URI,
			code_verifier: params.verifier
		},
		auditContext: "msteams-oauth-token-exchange",
		failureLabel: "token exchange",
		resolveRefreshToken: (data) => {
			if (!data.refresh_token) throw new Error("No refresh token received from Azure AD. Please try again.");
			return data.refresh_token;
		}
	});
}
async function refreshMSTeamsDelegatedTokens(params) {
	return await requestMSTeamsDelegatedTokens({
		tenantId: params.tenantId,
		clientId: params.clientId,
		clientSecret: params.clientSecret,
		grantType: "refresh_token",
		scopes: params.scopes,
		values: { refresh_token: params.refreshToken },
		auditContext: "msteams-oauth-token-refresh",
		failureLabel: "token refresh",
		resolveRefreshToken: (data) => data.refresh_token ?? params.refreshToken
	});
}
//#endregion
export { refreshMSTeamsDelegatedTokens as n, exchangeMSTeamsCodeForTokens as t };
