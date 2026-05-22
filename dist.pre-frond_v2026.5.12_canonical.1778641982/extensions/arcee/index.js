import { r as OPENAI_COMPATIBLE_REPLAY_HOOKS } from "../../provider-model-shared-BpwAf3yf.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-4LkKTmj0.js";
import { t as definePluginEntry } from "../../plugin-entry-6pkoHhQg.js";
import "../../provider-auth-api-key-4oSOW7im.js";
import { r as readConfiguredProviderCatalogEntries } from "../../provider-catalog-shared-Db90GZEt.js";
import { a as buildArceeProvider, i as buildArceeOpenRouterProvider, o as normalizeArceeOpenRouterBaseUrl, s as toArceeOpenRouterModelId } from "../../provider-catalog-q5LvpWou.js";
import { i as applyArceeOpenRouterConfig, n as ARCEE_OPENROUTER_DEFAULT_MODEL_REF, r as applyArceeConfig, t as ARCEE_DEFAULT_MODEL_REF } from "../../onboard-Be__AcXZ.js";
//#region extensions/arcee/index.ts
const PROVIDER_ID = "arcee";
const ARCEE_WIZARD_GROUP = {
	groupId: "arcee",
	groupLabel: "Arcee AI",
	groupHint: "Direct API or OpenRouter"
};
function buildArceeAuthMethods() {
	return [createProviderApiKeyAuthMethod({
		providerId: PROVIDER_ID,
		methodId: "arcee-platform",
		label: "Arcee AI API key",
		hint: "Direct access to Arcee platform",
		optionKey: "arceeaiApiKey",
		flagName: "--arceeai-api-key",
		envVar: "ARCEEAI_API_KEY",
		promptMessage: "Enter Arcee AI API key",
		defaultModel: ARCEE_DEFAULT_MODEL_REF,
		expectedProviders: [PROVIDER_ID],
		applyConfig: (cfg) => applyArceeConfig(cfg),
		wizard: {
			choiceId: "arceeai-api-key",
			choiceLabel: "Arcee AI API key",
			choiceHint: "Direct (chat.arcee.ai)",
			...ARCEE_WIZARD_GROUP
		}
	}), createProviderApiKeyAuthMethod({
		providerId: PROVIDER_ID,
		methodId: "openrouter",
		label: "OpenRouter API key",
		hint: "Access Arcee models via OpenRouter",
		optionKey: "openrouterApiKey",
		flagName: "--openrouter-api-key",
		envVar: "OPENROUTER_API_KEY",
		promptMessage: "Enter OpenRouter API key",
		profileId: "openrouter:default",
		defaultModel: ARCEE_OPENROUTER_DEFAULT_MODEL_REF,
		expectedProviders: [PROVIDER_ID, "openrouter"],
		applyConfig: (cfg) => applyArceeOpenRouterConfig(cfg),
		wizard: {
			choiceId: "arceeai-openrouter",
			choiceLabel: "OpenRouter API key",
			choiceHint: "Via OpenRouter (openrouter.ai)",
			...ARCEE_WIZARD_GROUP
		}
	})];
}
async function resolveArceeCatalog(ctx) {
	const directKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
	if (directKey) return { provider: {
		...buildArceeProvider(),
		apiKey: directKey
	} };
	const openRouterKey = ctx.resolveProviderApiKey("openrouter").apiKey;
	if (openRouterKey) return { provider: {
		...buildArceeOpenRouterProvider(),
		apiKey: openRouterKey
	} };
	return null;
}
function normalizeArceeResolvedModel(model) {
	const normalizedBaseUrl = normalizeArceeOpenRouterBaseUrl(model.baseUrl);
	if (!normalizedBaseUrl) return;
	const normalizedId = toArceeOpenRouterModelId(model.id);
	if (normalizedId === model.id && normalizedBaseUrl === model.baseUrl) return;
	return {
		...model,
		id: normalizedId,
		baseUrl: normalizedBaseUrl
	};
}
var arcee_default = definePluginEntry({
	id: PROVIDER_ID,
	name: "Arcee AI Provider",
	description: "Bundled Arcee AI provider plugin",
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Arcee AI",
			docsPath: "/providers/arcee",
			envVars: ["ARCEEAI_API_KEY", "OPENROUTER_API_KEY"],
			auth: buildArceeAuthMethods(),
			catalog: { run: resolveArceeCatalog },
			augmentModelCatalog: ({ config }) => readConfiguredProviderCatalogEntries({
				config,
				providerId: PROVIDER_ID
			}),
			normalizeConfig: ({ providerConfig }) => {
				const normalizedBaseUrl = normalizeArceeOpenRouterBaseUrl(providerConfig.baseUrl);
				return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl ? {
					...providerConfig,
					baseUrl: normalizedBaseUrl
				} : void 0;
			},
			normalizeResolvedModel: ({ model }) => normalizeArceeResolvedModel(model),
			normalizeTransport: ({ api, baseUrl }) => {
				const normalizedBaseUrl = normalizeArceeOpenRouterBaseUrl(baseUrl);
				return normalizedBaseUrl && normalizedBaseUrl !== baseUrl ? {
					api,
					baseUrl: normalizedBaseUrl
				} : void 0;
			},
			...OPENAI_COMPATIBLE_REPLAY_HOOKS
		});
	}
});
//#endregion
export { arcee_default as default };
