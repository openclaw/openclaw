import { n as isWSL2Sync } from "./wsl-CPSzfLq9.js";
import { m as generateHexPkceVerifierChallenge } from "./provider-auth-D5QGE8z6.js";
import "./runtime-env-AKjXcC53.js";
import { o as waitForLocalOAuthCallback, r as parseOAuthCallbackInput } from "./provider-auth-runtime-CNBotkGP.js";
import { c as SCOPES, s as REDIRECT_URI, t as AUTH_URL } from "./oauth.shared-APUjVVTu.js";
import { r as resolveOAuthClientConfig } from "./oauth.credentials-DgCr2HPm.js";
//#region extensions/google/oauth.flow.ts
function shouldUseManualOAuthFlow(isRemote) {
	return isRemote || isWSL2Sync();
}
function generatePkce() {
	return generateHexPkceVerifierChallenge();
}
function buildAuthUrl(challenge, state) {
	const { clientId } = resolveOAuthClientConfig();
	return `${AUTH_URL}?${new URLSearchParams({
		client_id: clientId,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		access_type: "offline",
		prompt: "consent"
	}).toString()}`;
}
function parseCallbackInput(input) {
	return parseOAuthCallbackInput(input, {
		missingState: "Missing 'state' parameter. Paste the full URL.",
		invalidInput: "Paste the full redirect URL, not just the code."
	});
}
async function waitForLocalCallback(params) {
	return await waitForLocalOAuthCallback({
		expectedState: params.expectedState,
		timeoutMs: params.timeoutMs,
		port: 8085,
		callbackPath: "/oauth2callback",
		redirectUri: REDIRECT_URI,
		successTitle: "Gemini CLI OAuth complete",
		progressMessage: `Waiting for OAuth callback on ${REDIRECT_URI}…`,
		onProgress: params.onProgress
	});
}
//#endregion
export { waitForLocalCallback as a, shouldUseManualOAuthFlow as i, generatePkce as n, parseCallbackInput as r, buildAuthUrl as t };
