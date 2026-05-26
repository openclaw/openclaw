import { t as defineSingleProviderPluginEntry } from "../../provider-entry-DYbqN6AQ.js";
import { n as applyHuggingfaceConfig, t as HUGGINGFACE_DEFAULT_MODEL_REF } from "../../onboard-BtjiCZ_h.js";
import { t as buildHuggingfaceProvider } from "../../provider-catalog-DILyU-la.js";
//#region extensions/huggingface/index.ts
const PROVIDER_ID = "huggingface";
var huggingface_default = defineSingleProviderPluginEntry({
	id: PROVIDER_ID,
	name: "Hugging Face Provider",
	description: "Bundled Hugging Face provider plugin",
	provider: {
		label: "Hugging Face",
		docsPath: "/providers/huggingface",
		envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
		auth: [{
			methodId: "api-key",
			label: "Hugging Face API key",
			hint: "Inference API (HF token)",
			optionKey: "huggingfaceApiKey",
			flagName: "--huggingface-api-key",
			envVar: "HUGGINGFACE_HUB_TOKEN",
			promptMessage: "Enter Hugging Face API key",
			defaultModel: HUGGINGFACE_DEFAULT_MODEL_REF,
			applyConfig: (cfg) => applyHuggingfaceConfig(cfg)
		}],
		catalog: {
			order: "simple",
			run: async (ctx) => {
				const pluginEntry = ctx.config?.plugins?.entries?.[PROVIDER_ID];
				if (((pluginEntry && typeof pluginEntry === "object" && pluginEntry.config ? pluginEntry.config : void 0)?.discovery?.enabled ?? ctx.config?.models?.huggingfaceDiscovery?.enabled) === false) return null;
				const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
				if (!apiKey) return null;
				return { provider: {
					...await buildHuggingfaceProvider(discoveryApiKey),
					apiKey
				} };
			}
		}
	}
});
//#endregion
export { huggingface_default as default };
