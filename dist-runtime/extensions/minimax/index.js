import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-BZ4hHpx2.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import { t as buildOauthProviderAuthResult } from "../../provider-auth-result-BwNanZxe.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../paths-OqPpu-UR.js";
import "../../auth-profiles-CuJtivJK.js";
import { a as ensureAuthProfileStore, n as listProfilesForProvider } from "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import { d as buildMinimaxProvider, u as buildMinimaxPortalProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import "../../onboard-auth.models-DgQQVW6a.js";
import { n as applyMinimaxApiConfigCn, t as applyMinimaxApiConfig } from "../../onboard-auth.config-minimax-CHFiQ6wX.js";
import "../../provider-usage.fetch.shared-4in1kuRh.js";
import { n as fetchMinimaxUsage } from "../../provider-usage.fetch-CT9bwlMB.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-C_oZ2YEn.js";
import { n as toFormUrlEncoded, t as generatePkceVerifierChallenge } from "../../oauth-utils-B4v3kD9s.js";
import { randomBytes, randomUUID } from "node:crypto";
//#region extensions/minimax/oauth.ts
const MINIMAX_OAUTH_CONFIG = {
	cn: {
		baseUrl: "https://api.minimaxi.com",
		clientId: "78257093-7e40-4613-99e0-527b14b39113"
	},
	global: {
		baseUrl: "https://api.minimax.io",
		clientId: "78257093-7e40-4613-99e0-527b14b39113"
	}
};
const MINIMAX_OAUTH_SCOPE = "group_id profile model.completion";
const MINIMAX_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:user_code";
function getOAuthEndpoints(region) {
	const config = MINIMAX_OAUTH_CONFIG[region];
	return {
		codeEndpoint: `${config.baseUrl}/oauth/code`,
		tokenEndpoint: `${config.baseUrl}/oauth/token`,
		clientId: config.clientId,
		baseUrl: config.baseUrl
	};
}
function generatePkce() {
	const { verifier, challenge } = generatePkceVerifierChallenge();
	return {
		verifier,
		challenge,
		state: randomBytes(16).toString("base64url")
	};
}
async function requestOAuthCode(params) {
	const endpoints = getOAuthEndpoints(params.region);
	const response = await fetch(endpoints.codeEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			"x-request-id": randomUUID()
		},
		body: toFormUrlEncoded({
			response_type: "code",
			client_id: endpoints.clientId,
			scope: MINIMAX_OAUTH_SCOPE,
			code_challenge: params.challenge,
			code_challenge_method: "S256",
			state: params.state
		})
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`MiniMax OAuth authorization failed: ${text || response.statusText}`);
	}
	const payload = await response.json();
	if (!payload.user_code || !payload.verification_uri) throw new Error(payload.error ?? "MiniMax OAuth authorization returned an incomplete payload (missing user_code or verification_uri).");
	if (payload.state !== params.state) throw new Error("MiniMax OAuth state mismatch: possible CSRF attack or session corruption.");
	return payload;
}
async function pollOAuthToken(params) {
	const endpoints = getOAuthEndpoints(params.region);
	const response = await fetch(endpoints.tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json"
		},
		body: toFormUrlEncoded({
			grant_type: MINIMAX_OAUTH_GRANT_TYPE,
			client_id: endpoints.clientId,
			user_code: params.userCode,
			code_verifier: params.verifier
		})
	});
	const text = await response.text();
	let payload;
	if (text) try {
		payload = JSON.parse(text);
	} catch {
		payload = void 0;
	}
	if (!response.ok) return {
		status: "error",
		message: (payload?.base_resp?.status_msg ?? text) || "MiniMax OAuth failed to parse response."
	};
	if (!payload) return {
		status: "error",
		message: "MiniMax OAuth failed to parse response."
	};
	const tokenPayload = payload;
	if (tokenPayload.status === "error") return {
		status: "error",
		message: "An error occurred. Please try again later"
	};
	if (tokenPayload.status !== "success") return {
		status: "pending",
		message: "current user code is not authorized"
	};
	if (!tokenPayload.access_token || !tokenPayload.refresh_token || !tokenPayload.expired_in) return {
		status: "error",
		message: "MiniMax OAuth returned incomplete token payload."
	};
	return {
		status: "success",
		token: {
			access: tokenPayload.access_token,
			refresh: tokenPayload.refresh_token,
			expires: tokenPayload.expired_in,
			resourceUrl: tokenPayload.resource_url,
			notification_message: tokenPayload.notification_message
		}
	};
}
async function loginMiniMaxPortalOAuth(params) {
	const region = params.region ?? "global";
	const { verifier, challenge, state } = generatePkce();
	const oauth = await requestOAuthCode({
		challenge,
		state,
		region
	});
	const verificationUrl = oauth.verification_uri;
	const noteLines = [
		`Open ${verificationUrl} to approve access.`,
		`If prompted, enter the code ${oauth.user_code}.`,
		`Interval: ${oauth.interval ?? "default (2000ms)"}, Expires at: ${oauth.expired_in} unix timestamp`
	];
	await params.note(noteLines.join("\n"), "MiniMax OAuth");
	try {
		await params.openUrl(verificationUrl);
	} catch {}
	let pollIntervalMs = oauth.interval ? oauth.interval : 2e3;
	const expireTimeMs = oauth.expired_in;
	while (Date.now() < expireTimeMs) {
		params.progress.update("Waiting for MiniMax OAuth approval…");
		const result = await pollOAuthToken({
			userCode: oauth.user_code,
			verifier,
			region
		});
		if (result.status === "success") return result.token;
		if (result.status === "error") throw new Error(result.message);
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		pollIntervalMs = Math.max(pollIntervalMs, 2e3);
	}
	throw new Error("MiniMax OAuth timed out before authorization completed.");
}
//#endregion
//#region extensions/minimax/index.ts
const API_PROVIDER_ID = "minimax";
const PORTAL_PROVIDER_ID = "minimax-portal";
const PROVIDER_LABEL = "MiniMax";
const DEFAULT_MODEL = "MiniMax-M2.5";
const DEFAULT_BASE_URL_CN = "https://api.minimaxi.com/anthropic";
const DEFAULT_BASE_URL_GLOBAL = "https://api.minimax.io/anthropic";
function getDefaultBaseUrl(region) {
	return region === "cn" ? DEFAULT_BASE_URL_CN : DEFAULT_BASE_URL_GLOBAL;
}
function apiModelRef(modelId) {
	return `${API_PROVIDER_ID}/${modelId}`;
}
function portalModelRef(modelId) {
	return `${PORTAL_PROVIDER_ID}/${modelId}`;
}
function isModernMiniMaxModel(modelId) {
	return modelId.trim().toLowerCase().startsWith("minimax-m2.5");
}
function buildPortalProviderCatalog(params) {
	return {
		...buildMinimaxPortalProvider(),
		baseUrl: params.baseUrl,
		apiKey: params.apiKey
	};
}
function resolveApiCatalog(ctx) {
	const apiKey = ctx.resolveProviderApiKey(API_PROVIDER_ID).apiKey;
	if (!apiKey) return null;
	return { provider: {
		...buildMinimaxProvider(),
		apiKey
	} };
}
function resolvePortalCatalog(ctx) {
	const explicitProvider = ctx.config.models?.providers?.[PORTAL_PROVIDER_ID];
	const envApiKey = ctx.resolveProviderApiKey(PORTAL_PROVIDER_ID).apiKey;
	const hasProfiles = listProfilesForProvider(ensureAuthProfileStore(ctx.agentDir, { allowKeychainPrompt: false }), PORTAL_PROVIDER_ID).length > 0;
	const explicitApiKey = typeof explicitProvider?.apiKey === "string" ? explicitProvider.apiKey.trim() : void 0;
	const apiKey = envApiKey ?? explicitApiKey ?? (hasProfiles ? "minimax-oauth" : void 0);
	if (!apiKey) return null;
	return { provider: buildPortalProviderCatalog({
		baseUrl: (typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl.trim() : void 0) || DEFAULT_BASE_URL_GLOBAL,
		apiKey
	}) };
}
function createOAuthHandler(region) {
	const defaultBaseUrl = getDefaultBaseUrl(region);
	const regionLabel = region === "cn" ? "CN" : "Global";
	return async (ctx) => {
		const progress = ctx.prompter.progress(`Starting MiniMax OAuth (${regionLabel})…`);
		try {
			const result = await loginMiniMaxPortalOAuth({
				openUrl: ctx.openUrl,
				note: ctx.prompter.note,
				progress,
				region
			});
			progress.stop("MiniMax OAuth complete");
			if (result.notification_message) await ctx.prompter.note(result.notification_message, "MiniMax OAuth");
			const baseUrl = result.resourceUrl || defaultBaseUrl;
			return buildOauthProviderAuthResult({
				providerId: PORTAL_PROVIDER_ID,
				defaultModel: portalModelRef(DEFAULT_MODEL),
				access: result.access,
				refresh: result.refresh,
				expires: result.expires,
				configPatch: {
					models: { providers: { [PORTAL_PROVIDER_ID]: {
						baseUrl,
						models: []
					} } },
					agents: { defaults: { models: {
						[portalModelRef("MiniMax-M2.5")]: { alias: "minimax-m2.5" },
						[portalModelRef("MiniMax-M2.5-highspeed")]: { alias: "minimax-m2.5-highspeed" },
						[portalModelRef("MiniMax-M2.5-Lightning")]: { alias: "minimax-m2.5-lightning" }
					} } }
				},
				notes: [
					"MiniMax OAuth tokens auto-refresh. Re-run login if refresh fails or access is revoked.",
					`Base URL defaults to ${defaultBaseUrl}. Override models.providers.${PORTAL_PROVIDER_ID}.baseUrl if needed.`,
					...result.notification_message ? [result.notification_message] : []
				]
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			progress.stop(`MiniMax OAuth failed: ${errorMsg}`);
			await ctx.prompter.note("If OAuth fails, verify your MiniMax account has portal access and try again.", "MiniMax OAuth");
			throw err;
		}
	};
}
const minimaxPlugin = {
	id: API_PROVIDER_ID,
	name: "MiniMax",
	description: "Bundled MiniMax API-key and OAuth provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: API_PROVIDER_ID,
			label: PROVIDER_LABEL,
			docsPath: "/providers/minimax",
			envVars: ["MINIMAX_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: API_PROVIDER_ID,
				methodId: "api-global",
				label: "MiniMax API key (Global)",
				hint: "Global endpoint - api.minimax.io",
				optionKey: "minimaxApiKey",
				flagName: "--minimax-api-key",
				envVar: "MINIMAX_API_KEY",
				promptMessage: "Enter MiniMax API key (sk-api- or sk-cp-)\nhttps://platform.minimax.io/user-center/basic-information/interface-key",
				profileId: "minimax:global",
				allowProfile: false,
				defaultModel: apiModelRef(DEFAULT_MODEL),
				expectedProviders: ["minimax"],
				applyConfig: (cfg) => applyMinimaxApiConfig(cfg),
				wizard: {
					choiceId: "minimax-global-api",
					choiceLabel: "MiniMax API key (Global)",
					choiceHint: "Global endpoint - api.minimax.io",
					groupId: "minimax",
					groupLabel: "MiniMax",
					groupHint: "M2.5 (recommended)"
				}
			}), createProviderApiKeyAuthMethod({
				providerId: API_PROVIDER_ID,
				methodId: "api-cn",
				label: "MiniMax API key (CN)",
				hint: "CN endpoint - api.minimaxi.com",
				optionKey: "minimaxApiKey",
				flagName: "--minimax-api-key",
				envVar: "MINIMAX_API_KEY",
				promptMessage: "Enter MiniMax CN API key (sk-api- or sk-cp-)\nhttps://platform.minimaxi.com/user-center/basic-information/interface-key",
				profileId: "minimax:cn",
				allowProfile: false,
				defaultModel: apiModelRef(DEFAULT_MODEL),
				expectedProviders: ["minimax", "minimax-cn"],
				applyConfig: (cfg) => applyMinimaxApiConfigCn(cfg),
				wizard: {
					choiceId: "minimax-cn-api",
					choiceLabel: "MiniMax API key (CN)",
					choiceHint: "CN endpoint - api.minimaxi.com",
					groupId: "minimax",
					groupLabel: "MiniMax",
					groupHint: "M2.5 (recommended)"
				}
			})],
			catalog: {
				order: "simple",
				run: async (ctx) => resolveApiCatalog(ctx)
			},
			resolveUsageAuth: async (ctx) => {
				const apiKey = ctx.resolveApiKeyFromConfigAndStore({ envDirect: [ctx.env.MINIMAX_CODE_PLAN_KEY, ctx.env.MINIMAX_API_KEY] });
				return apiKey ? { token: apiKey } : null;
			},
			isModernModelRef: ({ modelId }) => isModernMiniMaxModel(modelId),
			fetchUsageSnapshot: async (ctx) => await fetchMinimaxUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn)
		});
		api.registerProvider({
			id: PORTAL_PROVIDER_ID,
			label: PROVIDER_LABEL,
			docsPath: "/providers/minimax",
			envVars: ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
			catalog: { run: async (ctx) => resolvePortalCatalog(ctx) },
			auth: [{
				id: "oauth",
				label: "MiniMax OAuth (Global)",
				hint: "Global endpoint - api.minimax.io",
				kind: "device_code",
				wizard: {
					choiceId: "minimax-global-oauth",
					choiceLabel: "MiniMax OAuth (Global)",
					choiceHint: "Global endpoint - api.minimax.io",
					groupId: "minimax",
					groupLabel: "MiniMax",
					groupHint: "M2.5 (recommended)"
				},
				run: createOAuthHandler("global")
			}, {
				id: "oauth-cn",
				label: "MiniMax OAuth (CN)",
				hint: "CN endpoint - api.minimaxi.com",
				kind: "device_code",
				wizard: {
					choiceId: "minimax-cn-oauth",
					choiceLabel: "MiniMax OAuth (CN)",
					choiceHint: "CN endpoint - api.minimaxi.com",
					groupId: "minimax",
					groupLabel: "MiniMax",
					groupHint: "M2.5 (recommended)"
				},
				run: createOAuthHandler("cn")
			}],
			isModernModelRef: ({ modelId }) => isModernMiniMaxModel(modelId)
		});
	}
};
//#endregion
export { minimaxPlugin as default };
