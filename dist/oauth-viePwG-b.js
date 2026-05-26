import { n as generateOAuthState } from "./provider-auth-runtime-COV17c31.js";
import "./oauth.credentials-3k3dUirY.js";
import { a as waitForLocalCallback, i as shouldUseManualOAuthFlow, n as generatePkce, r as parseCallbackInput, t as buildAuthUrl } from "./oauth.flow-B8nStpX3.js";
import { n as refreshTokensForGeminiCli, t as exchangeCodeForTokens } from "./oauth.token-cwSsBQuK.js";
//#region extensions/google/oauth.ts
async function loginGeminiCliOAuth(ctx) {
	const needsManual = shouldUseManualOAuthFlow(ctx.isRemote);
	await ctx.note(needsManual ? [
		"You are running in a remote/VPS environment.",
		"A URL will be shown for you to open in your LOCAL browser.",
		"After signing in, copy the redirect URL and paste it back here."
	].join("\n") : [
		"Browser will open for Google authentication.",
		"Sign in with your Google account for Gemini CLI access.",
		"The callback will be captured automatically on localhost:8085."
	].join("\n"), "Gemini CLI OAuth");
	const { verifier, challenge } = generatePkce();
	const state = generateOAuthState();
	const authUrl = buildAuthUrl(challenge, state);
	if (needsManual) return manualFlow(ctx, authUrl, state, verifier);
	ctx.progress.update("Complete sign-in in browser...");
	ctx.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);
	try {
		await ctx.openUrl(authUrl);
	} catch {}
	try {
		const { code } = await waitForLocalCallback({
			expectedState: state,
			timeoutMs: 300 * 1e3,
			onProgress: (msg) => ctx.progress.update(msg)
		});
		ctx.progress.update("Exchanging authorization code for tokens...");
		return await exchangeCodeForTokens(code, verifier);
	} catch (err) {
		if (err instanceof Error && (err.message.includes("EADDRINUSE") || err.message.includes("port") || err.message.includes("listen"))) {
			ctx.progress.update("Local callback server failed. Switching to manual mode...");
			return manualFlow(ctx, authUrl, state, verifier, err);
		}
		throw err;
	}
}
async function manualFlow(ctx, authUrl, state, verifier, cause) {
	ctx.progress.update("OAuth URL ready");
	ctx.log(`\nOpen this URL in your LOCAL browser:\n\n${authUrl}\n`);
	ctx.progress.update("Waiting for you to paste the callback URL...");
	const parsed = parseCallbackInput(await ctx.prompt("Paste the redirect URL here: "));
	if ("error" in parsed) throw new Error(parsed.error, cause ? { cause } : void 0);
	if (parsed.state !== state) throw new Error("OAuth state mismatch - please try again", cause ? { cause } : void 0);
	ctx.progress.update("Exchanging authorization code for tokens...");
	return exchangeCodeForTokens(parsed.code, verifier);
}
async function refreshGeminiCliOAuthToken(credentials) {
	return {
		type: "oauth",
		provider: "google-gemini-cli",
		...await refreshTokensForGeminiCli(credentials)
	};
}
//#endregion
export { refreshGeminiCliOAuthToken as n, loginGeminiCliOAuth as t };
