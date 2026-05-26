import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { i as PASSTHROUGH_GEMINI_REPLAY_HOOKS } from "../../provider-model-shared-DtsPmvDx.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-E_5Yag4W.js";
import "../../provider-auth-api-key-C06h8GOX.js";
import { n as applyOpencodeGoConfig, t as OPENCODE_GO_DEFAULT_MODEL_REF } from "../../onboard-DHo52Wpn.js";
import "../../api-hKkcF8dm.js";
import { t as opencodeGoMediaUnderstandingProvider } from "../../media-understanding-provider-DTL6lnrZ.js";
import { a as resolveOpencodeGoSupplementalModel, i as normalizeOpencodeGoResolvedModel, n as listOpencodeGoSupplementalModelCatalogEntries, r as normalizeOpencodeGoBaseUrl } from "../../provider-catalog-CPLia89-.js";
import { r as createOpencodeGoWrapper } from "../../stream-DcrKLb1r.js";
//#region extensions/opencode-go/index.ts
const PROVIDER_ID = "opencode-go";
const OPENCODE_SHARED_PROFILE_IDS = ["opencode:default", "opencode-go:default"];
const OPENCODE_SHARED_HINT = "Shared API key for Zen + Go catalogs";
const OPENCODE_SHARED_WIZARD_GROUP = {
	groupId: "opencode",
	groupLabel: "OpenCode",
	groupHint: OPENCODE_SHARED_HINT
};
var opencode_go_default = definePluginEntry({
	id: PROVIDER_ID,
	name: "OpenCode Go Provider",
	description: "Bundled OpenCode Go provider plugin",
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "OpenCode Go",
			docsPath: "/providers/models",
			envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "OpenCode Go catalog",
				hint: OPENCODE_SHARED_HINT,
				optionKey: "opencodeGoApiKey",
				flagName: "--opencode-go-api-key",
				envVar: "OPENCODE_API_KEY",
				promptMessage: "Enter OpenCode API key",
				profileIds: [...OPENCODE_SHARED_PROFILE_IDS],
				defaultModel: OPENCODE_GO_DEFAULT_MODEL_REF,
				applyConfig: (cfg) => applyOpencodeGoConfig(cfg),
				expectedProviders: ["opencode", "opencode-go"],
				noteMessage: [
					"OpenCode uses one API key across the Zen and Go catalogs.",
					"Go focuses on Kimi, GLM, and MiniMax coding models.",
					"Get your API key at: https://opencode.ai/auth"
				].join("\n"),
				noteTitle: "OpenCode",
				wizard: {
					choiceId: "opencode-go",
					choiceLabel: "OpenCode Go catalog",
					...OPENCODE_SHARED_WIZARD_GROUP
				}
			})],
			normalizeConfig: ({ providerConfig }) => {
				const normalizedBaseUrl = normalizeOpencodeGoBaseUrl({
					api: providerConfig.api,
					baseUrl: providerConfig.baseUrl
				});
				return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl ? {
					...providerConfig,
					baseUrl: normalizedBaseUrl
				} : void 0;
			},
			normalizeResolvedModel: ({ model }) => {
				const normalizedBaseUrl = normalizeOpencodeGoBaseUrl({
					api: model.api,
					baseUrl: model.baseUrl
				});
				const baseUrlNormalized = normalizedBaseUrl && normalizedBaseUrl !== model.baseUrl ? {
					...model,
					baseUrl: normalizedBaseUrl
				} : model;
				const modelNormalized = normalizeOpencodeGoResolvedModel(baseUrlNormalized);
				if (modelNormalized) return modelNormalized;
				return baseUrlNormalized !== model ? baseUrlNormalized : void 0;
			},
			normalizeTransport: ({ api, baseUrl }) => {
				const normalizedBaseUrl = normalizeOpencodeGoBaseUrl({
					api,
					baseUrl
				});
				return normalizedBaseUrl && normalizedBaseUrl !== baseUrl ? {
					api,
					baseUrl: normalizedBaseUrl
				} : void 0;
			},
			resolveDynamicModel: ({ modelId }) => resolveOpencodeGoSupplementalModel(modelId),
			augmentModelCatalog: () => listOpencodeGoSupplementalModelCatalogEntries(),
			...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
			wrapStreamFn: (ctx) => createOpencodeGoWrapper(ctx.streamFn, ctx.thinkingLevel),
			isModernModelRef: () => true
		});
		api.registerMediaUnderstandingProvider(opencodeGoMediaUnderstandingProvider);
	}
});
//#endregion
export { opencode_go_default as default };
