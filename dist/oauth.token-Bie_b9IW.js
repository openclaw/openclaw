import { f as TOKEN_URL, s as REDIRECT_URI } from "./oauth.shared-APUjVVTu.js";
import { r as resolveOAuthClientConfig } from "./oauth.credentials-DgCr2HPm.js";
import { t as fetchWithTimeout } from "./oauth.http-C7IqwB3q.js";
import { n as resolveGooglePersonalOAuthIdentity, t as resolveGoogleOAuthIdentity } from "./oauth.project-Bb6sZETc.js";
import { t as isGeminiCliPersonalOAuth } from "./oauth.settings-FMyIcFFE.js";
//#region extensions/google/oauth.token.ts
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
	const data = await response.json();
	if (!data.refresh_token) throw new Error("No refresh token received. Please try again.");
	const identity = isGeminiCliPersonalOAuth() ? await resolveGooglePersonalOAuthIdentity(data.access_token) : await resolveGoogleOAuthIdentity(data.access_token);
	const expiresAt = Date.now() + data.expires_in * 1e3 - 300 * 1e3;
	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: expiresAt,
		projectId: identity.projectId,
		email: identity.email
	};
}
//#endregion
export { exchangeCodeForTokens as t };
