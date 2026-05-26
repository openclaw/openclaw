import { t as buildOauthProviderAuthResult } from "./provider-auth-result-qR7142tf.js";
import { r as fetchGeminiUsage } from "./provider-usage-OfXY2nM7.js";
import { r as parseGoogleUsageToken, t as formatGoogleOauthApiKey } from "./oauth-token-shared-CM8G9B70.js";
import { t as GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks-N2DroWIC.js";
import { n as resolveGoogleGeminiForwardCompatModel, t as isModernGoogleModel } from "./provider-models-Di4zgFzI.js";
//#region extensions/google/gemini-cli-provider.ts
const PROVIDER_ID = "google-gemini-cli";
const PROVIDER_LABEL = "Gemini CLI OAuth";
const DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
const ENV_VARS = [
	"OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
	"OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
	"GEMINI_CLI_OAUTH_CLIENT_ID",
	"GEMINI_CLI_OAUTH_CLIENT_SECRET"
];
async function fetchGeminiCliUsage(ctx) {
	return await fetchGeminiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, PROVIDER_ID);
}
function buildGoogleGeminiCliProvider() {
	return {
		id: PROVIDER_ID,
		label: PROVIDER_LABEL,
		docsPath: "/providers/models",
		aliases: ["gemini-cli"],
		envVars: [...ENV_VARS],
		auth: [{
			id: "oauth",
			label: "Google OAuth",
			hint: "PKCE + localhost callback",
			kind: "oauth",
			run: async (ctx) => {
				await ctx.prompter.note([
					"This is an unofficial integration and is not endorsed by Google.",
					"Some users have reported account restrictions or suspensions after using third-party Gemini CLI and Antigravity OAuth clients.",
					"Proceed only if you understand and accept this risk."
				].join("\n"), "Google Gemini CLI caution");
				if (!await ctx.prompter.confirm({
					message: "Continue with Google Gemini CLI OAuth?",
					initialValue: false
				})) {
					await ctx.prompter.note("Skipped Google Gemini CLI OAuth setup.", "Setup skipped");
					return { profiles: [] };
				}
				const spin = ctx.prompter.progress("Starting Gemini CLI OAuth…");
				try {
					const { loginGeminiCliOAuth } = await import("./extensions/google/oauth.runtime.js");
					const result = await loginGeminiCliOAuth({
						isRemote: ctx.isRemote,
						openUrl: ctx.openUrl,
						log: (msg) => ctx.runtime.log(msg),
						note: ctx.prompter.note,
						prompt: async (message) => ctx.prompter.text({ message }),
						progress: spin
					});
					spin.stop("Gemini CLI OAuth complete");
					return buildOauthProviderAuthResult({
						providerId: PROVIDER_ID,
						defaultModel: DEFAULT_MODEL,
						access: result.access,
						refresh: result.refresh,
						expires: result.expires,
						email: result.email,
						configPatch: { agents: { defaults: {
							agentRuntime: { id: PROVIDER_ID },
							models: { [DEFAULT_MODEL]: {} }
						} } },
						...result.projectId ? { credentialExtra: { projectId: result.projectId } } : {},
						...result.projectId ? { notes: ["If requests fail, set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID."] } : {}
					});
				} catch (err) {
					spin.stop("Gemini CLI OAuth failed");
					await ctx.prompter.note("Trouble with OAuth? Ensure your Google account has Gemini CLI access.", "OAuth help");
					throw err;
				}
			}
		}],
		wizard: { setup: {
			choiceId: "google-gemini-cli",
			choiceLabel: "Gemini CLI OAuth",
			choiceHint: "Google OAuth with project-aware token payload",
			methodId: "oauth"
		} },
		resolveDynamicModel: (ctx) => resolveGoogleGeminiForwardCompatModel({
			providerId: PROVIDER_ID,
			ctx
		}),
		...GOOGLE_GEMINI_PROVIDER_HOOKS,
		isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
		formatApiKey: (cred) => formatGoogleOauthApiKey(cred),
		refreshOAuth: async (cred) => {
			const { refreshGeminiCliOAuthToken } = await import("./extensions/google/oauth.runtime.js");
			return await refreshGeminiCliOAuthToken(cred);
		},
		resolveUsageAuth: async (ctx) => {
			const auth = await ctx.resolveOAuthToken();
			if (!auth) return null;
			return {
				...auth,
				token: parseGoogleUsageToken(auth.token)
			};
		},
		fetchUsageSnapshot: async (ctx) => await fetchGeminiCliUsage(ctx)
	};
}
function registerGoogleGeminiCliProvider(api) {
	api.registerProvider(buildGoogleGeminiCliProvider());
}
//#endregion
export { registerGoogleGeminiCliProvider as n, buildGoogleGeminiCliProvider as t };
