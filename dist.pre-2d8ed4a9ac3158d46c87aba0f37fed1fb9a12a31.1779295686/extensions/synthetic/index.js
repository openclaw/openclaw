import { t as defineSingleProviderPluginEntry } from "../../provider-entry-BDSAzSXr.js";
import { r as SYNTHETIC_DEFAULT_MODEL_REF } from "../../models-BnCvz27t.js";
import { t as applySyntheticConfig } from "../../onboard-C8rmiHAq.js";
import { t as buildSyntheticProvider } from "../../provider-catalog-CmNvNSgE.js";
var synthetic_default = defineSingleProviderPluginEntry({
	id: "synthetic",
	name: "Synthetic Provider",
	description: "Bundled Synthetic provider plugin",
	provider: {
		label: "Synthetic",
		docsPath: "/providers/synthetic",
		auth: [{
			methodId: "api-key",
			label: "Synthetic API key",
			hint: "Anthropic-compatible (multi-model)",
			optionKey: "syntheticApiKey",
			flagName: "--synthetic-api-key",
			envVar: "SYNTHETIC_API_KEY",
			promptMessage: "Enter Synthetic API key",
			defaultModel: SYNTHETIC_DEFAULT_MODEL_REF,
			applyConfig: (cfg) => applySyntheticConfig(cfg)
		}],
		catalog: { buildProvider: buildSyntheticProvider }
	}
});
//#endregion
export { synthetic_default as default };
