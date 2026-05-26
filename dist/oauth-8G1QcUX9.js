import { n as isWSL2Sync } from "./wsl-2-jVkfxN.js";
import "./runtime-env-BtvWnLRh.js";
import { c as generateHexPkceVerifierChallenge } from "./provider-auth-BtRKd5us.js";
import { i as parseOAuthCallbackInput, n as generateOAuthState, s as waitForLocalOAuthCallback } from "./provider-auth-runtime-COV17c31.js";
import { a as MSTEAMS_OAUTH_CALLBACK_PORT, i as MSTEAMS_OAUTH_CALLBACK_PATH, o as MSTEAMS_OAUTH_REDIRECT_URI, r as MSTEAMS_DEFAULT_DELEGATED_SCOPES, s as buildMSTeamsAuthEndpoint, t as exchangeMSTeamsCodeForTokens } from "./oauth.token-C2fbS5a3.js";
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
//#region extensions/msteams/src/oauth.ts
async function loginMSTeamsDelegated(ctx, params) {
	const scopes = params.scopes ?? MSTEAMS_DEFAULT_DELEGATED_SCOPES;
	const needsManual = shouldUseManualOAuthFlow(ctx.isRemote);
	await ctx.note(needsManual ? [
		"You are running in a remote/VPS environment.",
		"A URL will be shown for you to open in your LOCAL browser.",
		"After signing in, copy the redirect URL and paste it back here."
	].join("\n") : [
		"Browser will open for Microsoft authentication.",
		`Sign in to grant delegated permissions for MSTeams.`,
		`The callback will be captured automatically on localhost:${MSTEAMS_OAUTH_CALLBACK_PORT}.`
	].join("\n"), "MSTeams Delegated OAuth");
	const { verifier, challenge } = generatePkce();
	const state = generateOAuthState();
	const authUrl = buildMSTeamsAuthUrl({
		tenantId: params.tenantId,
		clientId: params.clientId,
		challenge,
		state,
		scopes
	});
	if (needsManual) return manualFlow(ctx, authUrl, state, verifier, params);
	ctx.progress.update("Complete sign-in in browser...");
	try {
		await ctx.openUrl(authUrl);
	} catch {
		ctx.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);
	}
	try {
		const { code } = await waitForLocalCallback({
			expectedState: state,
			timeoutMs: 300 * 1e3,
			onProgress: (msg) => ctx.progress.update(msg)
		});
		ctx.progress.update("Exchanging authorization code for tokens...");
		return await exchangeMSTeamsCodeForTokens({
			tenantId: params.tenantId,
			clientId: params.clientId,
			clientSecret: params.clientSecret,
			code,
			verifier,
			scopes
		});
	} catch (err) {
		if (err instanceof Error && (err.message.includes("EADDRINUSE") || err.message.includes("port") || err.message.includes("listen"))) {
			ctx.progress.update("Local callback server failed. Switching to manual mode...");
			return manualFlow(ctx, authUrl, state, verifier, params, err);
		}
		throw err;
	}
}
async function manualFlow(ctx, authUrl, state, verifier, params, cause) {
	ctx.progress.update("OAuth URL ready");
	ctx.log(`\nOpen this URL in your LOCAL browser:\n\n${authUrl}\n`);
	ctx.progress.update("Waiting for you to paste the callback URL...");
	const parsed = parseCallbackInput(await ctx.prompt("Paste the redirect URL here: "), state);
	if ("error" in parsed) throw new Error(parsed.error, cause ? { cause } : void 0);
	if (parsed.state !== state) throw new Error("OAuth state mismatch - please try again", cause ? { cause } : void 0);
	ctx.progress.update("Exchanging authorization code for tokens...");
	return exchangeMSTeamsCodeForTokens({
		tenantId: params.tenantId,
		clientId: params.clientId,
		clientSecret: params.clientSecret,
		code: parsed.code,
		verifier,
		scopes: params.scopes
	});
}
//#endregion
export { loginMSTeamsDelegated };
