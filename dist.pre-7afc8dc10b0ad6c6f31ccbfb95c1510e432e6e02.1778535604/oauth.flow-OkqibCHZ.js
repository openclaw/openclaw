import { n as isWSL2Sync } from "./wsl-DDkBKapf.js";
import { m as generateHexPkceVerifierChallenge } from "./provider-auth-BTiyooTa.js";
import "./runtime-env-B1r2kK7q.js";
import { o as waitForLocalOAuthCallback, r as parseOAuthCallbackInput } from "./provider-auth-runtime-XmZAOSGY.js";
import { c as SCOPES, s as REDIRECT_URI, t as AUTH_URL } from "./oauth.shared-lB6dgtjU.js";
import { r as resolveOAuthClientConfig } from "./oauth.credentials-D__kmSaS.js";
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
