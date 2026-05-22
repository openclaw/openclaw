import { t as defineSingleProviderPluginEntry } from "../../provider-entry-Cw0c3s2S.js";
import { r as SYNTHETIC_DEFAULT_MODEL_REF } from "../../models-DuDLbp6A2.js";
import { t as applySyntheticConfig } from "../../onboard-BhwJHJGn.js";
import { t as buildSyntheticProvider } from "../../provider-catalog-k9H5qBlS.js";
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
