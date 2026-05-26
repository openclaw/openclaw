import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import "./model-auth-markers-Cf78z2Zm.js";
import { n as listProfilesForProvider } from "./profile-list-C0HtPlut.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as buildProviderReplayFamilyHooks } from "./provider-model-shared-DtsPmvDx.js";
import { t as createProviderApiKeyAuthMethod } from "./provider-api-key-auth-E_5Yag4W.js";
import { t as buildOauthProviderAuthResult } from "./provider-auth-result-qR7142tf.js";
import "./provider-auth-BtRKd5us.js";
import "./provider-auth-api-key-C06h8GOX.js";
import { r as MINIMAX_FAST_MODE_STREAM_HOOKS } from "./provider-stream-B32dNOmb.js";
import "./provider-stream-family-CGsj5YYd.js";
import { n as fetchMinimaxUsage } from "./provider-usage-OfXY2nM7.js";
import { o as isMiniMaxModernModelId, t as MINIMAX_DEFAULT_MODEL_ID } from "./provider-models-DHcchnyE.js";
import { n as buildMinimaxProvider, t as buildMinimaxPortalProvider } from "./provider-catalog-CDM6thbh.js";
import { n as applyMinimaxApiConfigCn, t as applyMinimaxApiConfig } from "./onboard-CK50G_9l.js";
import "./api-Cd9yANwz.js";
//#region extensions/minimax/provider-registration.ts
const API_PROVIDER_ID = "minimax";
const PORTAL_PROVIDER_ID = "minimax-portal";
const PROVIDER_LABEL = "MiniMax";
const DEFAULT_MODEL = MINIMAX_DEFAULT_MODEL_ID;
const DEFAULT_BASE_URL_CN = "https://api.minimaxi.com/anthropic";
const DEFAULT_BASE_URL_GLOBAL = "https://api.minimax.io/anthropic";
const MINIMAX_USAGE_ENV_VAR_KEYS = [
	"MINIMAX_OAUTH_TOKEN",
	"MINIMAX_CODE_PLAN_KEY",
	"MINIMAX_CODING_API_KEY",
	"MINIMAX_API_KEY"
];
const MINIMAX_WIZARD_GROUP = {
	groupId: "minimax",
	groupLabel: "MiniMax",
	groupHint: "M2.7 (recommended)"
};
const MINIMAX_PROVIDER_HOOKS = {
	...buildProviderReplayFamilyHooks({
		family: "hybrid-anthropic-openai",
		anthropicModelDropThinkingBlocks: true
	}),
	...MINIMAX_FAST_MODE_STREAM_HOOKS,
	resolveReasoningOutputMode: () => "native"
};
function getDefaultBaseUrl(region) {
	return region === "cn" ? DEFAULT_BASE_URL_CN : DEFAULT_BASE_URL_GLOBAL;
}
function resolveMinimaxRegionLabel(region) {
	return region === "cn" ? "CN" : "Global";
}
function resolveMinimaxEndpointHint(region) {
	return region === "cn" ? "CN endpoint - api.minimaxi.com" : "Global endpoint - api.minimax.io";
}
function apiModelRef(modelId) {
	return `${API_PROVIDER_ID}/${modelId}`;
}
function portalModelRef(modelId) {
	return `${PORTAL_PROVIDER_ID}/${modelId}`;
}
function getProviderBaseUrl(cfg, providerId) {
	return normalizeOptionalString(cfg.models?.providers?.[providerId]?.baseUrl);
}
function resolveMinimaxUsageBaseUrl(cfg) {
	return getProviderBaseUrl(cfg, PORTAL_PROVIDER_ID) ?? getProviderBaseUrl(cfg, API_PROVIDER_ID);
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
		...buildMinimaxProvider(ctx.env),
		apiKey
	} };
}
function resolvePortalCatalog(ctx) {
	const explicitProvider = ctx.config.models?.providers?.[PORTAL_PROVIDER_ID];
	const envApiKey = ctx.resolveProviderApiKey(PORTAL_PROVIDER_ID).apiKey;
	const hasProfiles = listProfilesForProvider(ensureAuthProfileStore(ctx.agentDir, { allowKeychainPrompt: false }), PORTAL_PROVIDER_ID).length > 0;
	const explicitApiKey = normalizeOptionalString(explicitProvider?.apiKey);
	const apiKey = envApiKey ?? explicitApiKey ?? (hasProfiles ? "minimax-oauth" : void 0);
	if (!apiKey) return null;
	return { provider: buildPortalProviderCatalog({
		baseUrl: normalizeOptionalString(explicitProvider?.baseUrl) || buildMinimaxPortalProvider(ctx.env).baseUrl,
		apiKey
	}) };
}
function createOAuthHandler(region) {
	const defaultBaseUrl = getDefaultBaseUrl(region);
	const regionLabel = resolveMinimaxRegionLabel(region);
	return async (ctx) => {
		const progress = ctx.prompter.progress(`Starting MiniMax OAuth (${regionLabel})…`);
		try {
			const { loginMiniMaxPortalOAuth } = await import("./extensions/minimax/oauth.runtime.js");
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
						api: "anthropic-messages",
						authHeader: true,
						models: []
					} } },
					agents: { defaults: { models: {
						[portalModelRef("MiniMax-M2.7")]: { alias: "minimax-m2.7" },
						[portalModelRef("MiniMax-M2.7-highspeed")]: { alias: "minimax-m2.7-highspeed" }
					} } }
				},
				notes: [
					"MiniMax OAuth tokens auto-refresh. Re-run login if refresh fails or access is revoked.",
					`Base URL defaults to ${defaultBaseUrl}. Override models.providers.${PORTAL_PROVIDER_ID}.baseUrl if needed.`,
					...result.notification_message ? [result.notification_message] : []
				]
			});
		} catch (err) {
			const errorMsg = formatErrorMessage(err);
			progress.stop(`MiniMax OAuth failed: ${errorMsg}`);
			await ctx.prompter.note("If OAuth fails, verify your MiniMax account has portal access and try again.", "MiniMax OAuth");
			throw err;
		}
	};
}
function createMinimaxApiKeyMethod(region) {
	const regionLabel = resolveMinimaxRegionLabel(region);
	const endpointHint = resolveMinimaxEndpointHint(region);
	const isCn = region === "cn";
	return createProviderApiKeyAuthMethod({
		providerId: API_PROVIDER_ID,
		methodId: isCn ? "api-cn" : "api-global",
		label: `MiniMax API key (${regionLabel})`,
		hint: endpointHint,
		optionKey: "minimaxApiKey",
		flagName: "--minimax-api-key",
		envVar: "MINIMAX_API_KEY",
		promptMessage: isCn ? "Enter MiniMax CN API key (sk-api- or sk-cp-)\nhttps://platform.minimaxi.com/user-center/basic-information/interface-key" : "Enter MiniMax API key (sk-api- or sk-cp-)\nhttps://platform.minimax.io/user-center/basic-information/interface-key",
		profileId: isCn ? "minimax:cn" : "minimax:global",
		allowProfile: false,
		defaultModel: apiModelRef(DEFAULT_MODEL),
		expectedProviders: isCn ? ["minimax", "minimax-cn"] : ["minimax"],
		applyConfig: (cfg) => isCn ? applyMinimaxApiConfigCn(cfg) : applyMinimaxApiConfig(cfg),
		wizard: {
			choiceId: isCn ? "minimax-cn-api" : "minimax-global-api",
			choiceLabel: `MiniMax API key (${regionLabel})`,
			choiceHint: endpointHint,
			...MINIMAX_WIZARD_GROUP
		}
	});
}
function createMinimaxOAuthMethod(region) {
	const regionLabel = resolveMinimaxRegionLabel(region);
	const endpointHint = resolveMinimaxEndpointHint(region);
	const isCn = region === "cn";
	return {
		id: isCn ? "oauth-cn" : "oauth",
		label: `MiniMax OAuth (${regionLabel})`,
		hint: endpointHint,
		kind: "device_code",
		wizard: {
			choiceId: isCn ? "minimax-cn-oauth" : "minimax-global-oauth",
			choiceLabel: `MiniMax OAuth (${regionLabel})`,
			choiceHint: endpointHint,
			...MINIMAX_WIZARD_GROUP
		},
		run: createOAuthHandler(region)
	};
}
function registerMinimaxProviders(api) {
	api.registerProvider({
		id: API_PROVIDER_ID,
		label: PROVIDER_LABEL,
		hookAliases: ["minimax-cn"],
		docsPath: "/providers/minimax",
		envVars: ["MINIMAX_API_KEY"],
		auth: [createMinimaxApiKeyMethod("global"), createMinimaxApiKeyMethod("cn")],
		catalog: {
			order: "simple",
			run: async (ctx) => resolveApiCatalog(ctx)
		},
		resolveUsageAuth: async (ctx) => {
			const portalOauth = await ctx.resolveOAuthToken({ provider: PORTAL_PROVIDER_ID });
			if (portalOauth) return portalOauth;
			const apiKey = ctx.resolveApiKeyFromConfigAndStore({
				providerIds: [API_PROVIDER_ID, PORTAL_PROVIDER_ID],
				envDirect: MINIMAX_USAGE_ENV_VAR_KEYS.map((name) => ctx.env[name])
			});
			return apiKey ? { token: apiKey } : null;
		},
		...MINIMAX_PROVIDER_HOOKS,
		isModernModelRef: ({ modelId }) => isMiniMaxModernModelId(modelId),
		fetchUsageSnapshot: async (ctx) => await fetchMinimaxUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, { baseUrl: resolveMinimaxUsageBaseUrl(ctx.config) })
	});
	api.registerProvider({
		id: PORTAL_PROVIDER_ID,
		label: PROVIDER_LABEL,
		hookAliases: ["minimax-portal-cn"],
		docsPath: "/providers/minimax",
		envVars: ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
		catalog: { run: async (ctx) => resolvePortalCatalog(ctx) },
		auth: [createMinimaxOAuthMethod("global"), createMinimaxOAuthMethod("cn")],
		...MINIMAX_PROVIDER_HOOKS,
		isModernModelRef: ({ modelId }) => isMiniMaxModernModelId(modelId)
	});
}
//#endregion
export { registerMinimaxProviders as t };
