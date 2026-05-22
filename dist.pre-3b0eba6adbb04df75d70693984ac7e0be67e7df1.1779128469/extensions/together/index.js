import { t as defineSingleProviderPluginEntry } from "../../provider-entry-B5p3pd5V.js";
import { n as applyTogetherConfig, t as TOGETHER_DEFAULT_MODEL_REF } from "../../onboard-CfW5fKPR.js";
import { t as buildTogetherProvider } from "../../provider-catalog-DRzwj8Tr.js";
import { t as buildTogetherVideoGenerationProvider } from "../../video-generation-provider-_85kLmHK.js";
var together_default = defineSingleProviderPluginEntry({
	id: "together",
	name: "Together Provider",
	description: "Bundled Together provider plugin",
	provider: {
		label: "Together",
		docsPath: "/providers/together",
		auth: [{
			methodId: "api-key",
			label: "Together AI API key",
			hint: "API key",
			optionKey: "togetherApiKey",
			flagName: "--together-api-key",
			envVar: "TOGETHER_API_KEY",
			promptMessage: "Enter Together AI API key",
			defaultModel: TOGETHER_DEFAULT_MODEL_REF,
			applyConfig: (cfg) => applyTogetherConfig(cfg),
			wizard: { groupLabel: "Together AI" }
		}],
		catalog: { buildProvider: buildTogetherProvider },
		classifyFailoverReason: ({ errorMessage }) => /\bconcurrency limit\b.*\b(?:breached|reached)\b/i.test(errorMessage) ? "rate_limit" : void 0
	},
	register(api) {
		api.registerVideoGenerationProvider(buildTogetherVideoGenerationProvider());
	}
});
//#endregion
export { together_default as default };
