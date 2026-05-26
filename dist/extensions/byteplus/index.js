import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-DaaaGg6p.js";
import { t as definePluginEntry } from "../../plugin-entry-CJpThfKg.js";
import { m as ensureModelAllowlistEntry } from "../../provider-onboard-DhuPxzG7.js";
import "../../provider-auth-api-key-BdQf4UTi.js";
import { a as BYTEPLUS_MODEL_CATALOG, r as BYTEPLUS_CODING_MODEL_CATALOG } from "../../models-BI8i8cTC.js";
import { n as buildBytePlusProvider, t as buildBytePlusCodingProvider } from "../../provider-catalog-BBD8udus.js";
import { t as buildBytePlusVideoGenerationProvider } from "../../video-generation-provider-B5jFfriL.js";
//#region extensions/byteplus/index.ts
const PROVIDER_ID = "byteplus";
const BYTEPLUS_DEFAULT_MODEL_REF = "byteplus-plan/ark-code-latest";
var byteplus_default = definePluginEntry({
	id: PROVIDER_ID,
	name: "BytePlus Provider",
	description: "Bundled BytePlus provider plugin",
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "BytePlus",
			docsPath: "/concepts/model-providers#byteplus-international",
			envVars: ["BYTEPLUS_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "BytePlus API key",
				hint: "API key",
				optionKey: "byteplusApiKey",
				flagName: "--byteplus-api-key",
				envVar: "BYTEPLUS_API_KEY",
				promptMessage: "Enter BytePlus API key",
				defaultModel: BYTEPLUS_DEFAULT_MODEL_REF,
				expectedProviders: ["byteplus"],
				applyConfig: (cfg) => ensureModelAllowlistEntry({
					cfg,
					modelRef: BYTEPLUS_DEFAULT_MODEL_REF
				}),
				wizard: {
					choiceId: "byteplus-api-key",
					choiceLabel: "BytePlus API key",
					groupId: "byteplus",
					groupLabel: "BytePlus",
					groupHint: "API key"
				}
			})],
			catalog: {
				order: "paired",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					return { providers: {
						byteplus: {
							...buildBytePlusProvider(),
							apiKey
						},
						"byteplus-plan": {
							...buildBytePlusCodingProvider(),
							apiKey
						}
					} };
				}
			},
			augmentModelCatalog: () => {
				const byteplusModels = BYTEPLUS_MODEL_CATALOG.map((entry) => ({
					provider: "byteplus",
					id: entry.id,
					name: entry.name,
					reasoning: entry.reasoning,
					input: [...entry.input],
					contextWindow: entry.contextWindow
				}));
				const byteplusPlanModels = BYTEPLUS_CODING_MODEL_CATALOG.map((entry) => ({
					provider: "byteplus-plan",
					id: entry.id,
					name: entry.name,
					reasoning: entry.reasoning,
					input: [...entry.input],
					contextWindow: entry.contextWindow
				}));
				return [...byteplusModels, ...byteplusPlanModels];
			}
		});
		api.registerVideoGenerationProvider(buildBytePlusVideoGenerationProvider());
	}
});
//#endregion
export { byteplus_default as default };
