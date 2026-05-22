import { t as generateOAuthState } from "./provider-auth-runtime-CIhLOW7D.js";
import { i as MSTEAMS_OAUTH_CALLBACK_PORT, t as MSTEAMS_DEFAULT_DELEGATED_SCOPES } from "./oauth.shared-D6WlFNjC.js";
import { t as exchangeMSTeamsCodeForTokens } from "./oauth.token-CzeYAyeY.js";
import { a as waitForLocalCallback, i as shouldUseManualOAuthFlow, n as generatePkce, r as parseCallbackInput, t as buildMSTeamsAuthUrl } from "./oauth.flow-CCU4iZIh.js";
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
