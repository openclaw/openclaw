import { f as TOKEN_URL, s as REDIRECT_URI } from "./oauth.shared-BD6M390i.js";
import { r as resolveOAuthClientConfig } from "./oauth.credentials-3k3dUirY.js";
import { t as fetchWithTimeout } from "./oauth.http-CWexeY83.js";
import { n as resolveGooglePersonalOAuthIdentity, t as resolveGoogleOAuthIdentity } from "./oauth.project-BkQSCat8.js";
import { t as isGeminiCliPersonalOAuth } from "./oauth.settings-DqkNKvyO.js";
//#region extensions/google/oauth.token.ts
async function requestTokenGrant(body) {
	const response = await fetchWithTimeout(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
			Accept: "*/*",
			"User-Agent": "google-api-nodejs-client/9.15.1"
		},
		body
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Token exchange failed: ${errorText}`);
	}
	return await response.json();
}
async function buildGeminiCliCredentials(params) {
	const accessToken = params.tokenResponse.access_token;
	if (!accessToken) throw new Error("No access token received. Please try again.");
	let identity = params.existing ?? {};
	try {
		if (!identity.email || !identity.projectId) {
			const discovered = await resolveGeminiCliIdentity(accessToken);
			identity = {
				email: identity.email ?? discovered.email,
				projectId: identity.projectId ?? discovered.projectId
			};
		}
	} catch (error) {
		if (!params.allowIdentityFallback || !params.existing?.email && !params.existing?.projectId) throw error;
	}
	const expiresInMs = typeof params.tokenResponse.expires_in === "number" ? params.tokenResponse.expires_in * 1e3 : 0;
	const expiresAt = Date.now() + expiresInMs - 300 * 1e3;
	return {
		refresh: params.tokenResponse.refresh_token ?? params.refreshTokenFallback ?? "",
		access: accessToken,
		expires: expiresAt,
		projectId: identity.projectId,
		email: identity.email
	};
}
async function resolveGeminiCliIdentity(accessToken) {
	return isGeminiCliPersonalOAuth() ? await resolveGooglePersonalOAuthIdentity(accessToken) : await resolveGoogleOAuthIdentity(accessToken);
}
async function exchangeCodeForTokens(code, verifier) {
	const { clientId, clientSecret } = resolveOAuthClientConfig();
	const body = new URLSearchParams({
		client_id: clientId,
		code,
		grant_type: "authorization_code",
		redirect_uri: REDIRECT_URI,
		code_verifier: verifier
	});
	if (clientSecret) body.set("client_secret", clientSecret);
	const refreshed = await buildGeminiCliCredentials({ tokenResponse: await requestTokenGrant(body) });
	if (!refreshed.refresh) throw new Error("No refresh token received. Please try again.");
	return refreshed;
}
async function refreshTokensForGeminiCli(credentials) {
	const { clientId, clientSecret } = resolveOAuthClientConfig();
	const body = new URLSearchParams({
		client_id: clientId,
		grant_type: "refresh_token",
		refresh_token: credentials.refresh
	});
	if (clientSecret) body.set("client_secret", clientSecret);
	return await buildGeminiCliCredentials({
		tokenResponse: await requestTokenGrant(body),
		refreshTokenFallback: credentials.refresh,
		existing: {
			email: credentials.email,
			projectId: credentials.projectId
		},
		allowIdentityFallback: true
	});
}
//#endregion
export { refreshTokensForGeminiCli as n, exchangeCodeForTokens as t };
