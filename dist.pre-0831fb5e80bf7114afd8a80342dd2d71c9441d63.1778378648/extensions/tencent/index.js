import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-CMMgmetU.js";
import { t as definePluginEntry } from "../../plugin-entry-CdPayZCH.js";
import "../../provider-auth-api-key-Byo72YCi.js";
import { c as buildSingleProviderApiKeyCatalog } from "../../provider-catalog-shared-D9UvY9lm.js";
import { n as TOKENHUB_MODEL_CATALOG, r as TOKENHUB_PROVIDER_ID } from "../../models-CXqGhkbu.js";
import { t as buildTokenHubProvider } from "../../provider-catalog-D5ZvwuTU.js";
import { n as applyTokenHubConfig, t as TOKENHUB_DEFAULT_MODEL_REF } from "../../onboard-B9AhRmxI.js";
//#region extensions/tencent/index.ts
function buildStaticCatalogEntries(providerId, catalog) {
	return catalog.map((entry) => ({
		provider: providerId,
		id: entry.id,
		name: entry.name,
		reasoning: entry.reasoning,
		input: [...entry.input],
		contextWindow: entry.contextWindow
	}));
}
var tencent_default = definePluginEntry({
	id: "tencent",
	name: "Tencent Cloud Provider",
	description: "Bundled Tencent Cloud provider plugin (TokenHub)",
	register(api) {
		api.registerProvider({
			id: TOKENHUB_PROVIDER_ID,
			label: "Tencent TokenHub",
			docsPath: "/providers/tencent",
			envVars: ["TOKENHUB_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: TOKENHUB_PROVIDER_ID,
				methodId: "api-key",
				label: "Tencent TokenHub",
				hint: "Hy via Tencent TokenHub Gateway",
				optionKey: "tokenhubApiKey",
				flagName: "--tokenhub-api-key",
				envVar: "TOKENHUB_API_KEY",
				promptMessage: "Enter Tencent TokenHub API key",
				defaultModel: TOKENHUB_DEFAULT_MODEL_REF,
				expectedProviders: [TOKENHUB_PROVIDER_ID],
				applyConfig: (cfg) => applyTokenHubConfig(cfg),
				wizard: {
					choiceId: "tokenhub-api-key",
					choiceLabel: "Tencent TokenHub",
					groupId: "tencent",
					groupLabel: "Tencent Cloud",
					groupHint: "Tencent TokenHub"
				}
			})],
			catalog: {
				order: "simple",
				run: (ctx) => buildSingleProviderApiKeyCatalog({
					ctx,
					providerId: TOKENHUB_PROVIDER_ID,
					buildProvider: buildTokenHubProvider
				})
			},
			augmentModelCatalog: () => buildStaticCatalogEntries(TOKENHUB_PROVIDER_ID, TOKENHUB_MODEL_CATALOG)
		});
	}
});
//#endregion
export { tencent_default as default };
