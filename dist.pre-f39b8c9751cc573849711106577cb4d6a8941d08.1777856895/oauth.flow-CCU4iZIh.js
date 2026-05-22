import { n as isWSL2Sync } from "./wsl-CZKU2bq6.js";
import { p as generateHexPkceVerifierChallenge } from "./provider-auth-CK1ryEny.js";
import "./runtime-env-PjQ_OX8O.js";
import { o as waitForLocalOAuthCallback, r as parseOAuthCallbackInput } from "./provider-auth-runtime-CIhLOW7D.js";
import { a as MSTEAMS_OAUTH_REDIRECT_URI, i as MSTEAMS_OAUTH_CALLBACK_PORT, o as buildMSTeamsAuthEndpoint, r as MSTEAMS_OAUTH_CALLBACK_PATH, t as MSTEAMS_DEFAULT_DELEGATED_SCOPES } from "./oauth.shared-D6WlFNjC.js";
//#region extensions/msteams/src/oauth.flow.ts
function shouldUseManualOAuthFlow(isRemote) {
	return isRemote || isWSL2Sync();
}
function generatePkce() {
	return generateHexPkceVerifierChallenge();
}
function buildMSTeamsAuthUrl(params) {
	const scopes = params.scopes ?? MSTEAMS_DEFAULT_DELEGATED_SCOPES;
	return `${buildMSTeamsAuthEndpoint(params.tenantId)}?${new URLSearchParams({
		client_id: params.clientId,
		response_type: "code",
		redirect_uri: MSTEAMS_OAUTH_REDIRECT_URI,
		scope: scopes.join(" "),
		code_challenge: params.challenge,
		code_challenge_method: "S256",
		state: params.state,
		prompt: "consent"
	}).toString()}`;
}
function parseCallbackInput(input, _expectedState) {
	return parseOAuthCallbackInput(input, {
		missingState: "Missing 'state' parameter in URL. Paste the full redirect URL.",
		invalidInput: "Paste the full redirect URL (including code and state parameters), not just the authorization code."
	});
}
async function waitForLocalCallback(params) {
	return await waitForLocalOAuthCallback({
		expectedState: params.expectedState,
		timeoutMs: params.timeoutMs,
		port: MSTEAMS_OAUTH_CALLBACK_PORT,
		callbackPath: MSTEAMS_OAUTH_CALLBACK_PATH,
		redirectUri: MSTEAMS_OAUTH_REDIRECT_URI,
		successTitle: "MSTeams Delegated OAuth complete",
		progressMessage: `Waiting for OAuth callback on ${MSTEAMS_OAUTH_REDIRECT_URI}...`,
		onProgress: params.onProgress
	});
}
//#endregion
export { waitForLocalCallback as a, shouldUseManualOAuthFlow as i, generatePkce as n, parseCallbackInput as r, buildMSTeamsAuthUrl as t };
