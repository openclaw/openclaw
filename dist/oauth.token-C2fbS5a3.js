import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { m as readProviderJsonResponse } from "./provider-http-errors-C90BH-le.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/msteams/src/oauth.shared.ts
const MSTEAMS_OAUTH_REDIRECT_URI = "http://localhost:8086/oauth2callback";
const MSTEAMS_OAUTH_CALLBACK_PORT = 8086;
const MSTEAMS_OAUTH_CALLBACK_PATH = "/oauth2callback";
const MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS = 1e4;
const MSTEAMS_DEFAULT_DELEGATED_SCOPES = [
	"ChatMessage.Send",
	"ChannelMessage.Send",
	"Chat.ReadWrite",
	"offline_access"
];
function buildMSTeamsAuthEndpoint(tenantId) {
	return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`;
}
function buildMSTeamsTokenEndpoint(tenantId) {
	return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}
//#endregion
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
		return await readProviderJsonResponse(response, `MSTeams ${params.failureLabel} failed`);
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
export { MSTEAMS_OAUTH_CALLBACK_PORT as a, MSTEAMS_OAUTH_CALLBACK_PATH as i, refreshMSTeamsDelegatedTokens as n, MSTEAMS_OAUTH_REDIRECT_URI as o, MSTEAMS_DEFAULT_DELEGATED_SCOPES as r, buildMSTeamsAuthEndpoint as s, exchangeMSTeamsCodeForTokens as t };
