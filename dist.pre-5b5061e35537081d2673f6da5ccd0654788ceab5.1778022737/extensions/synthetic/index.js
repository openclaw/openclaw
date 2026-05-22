import { t as defineSingleProviderPluginEntry } from "../../provider-entry-B24YCSzl.js";
import { r as SYNTHETIC_DEFAULT_MODEL_REF } from "../../models-BNV4vuns.js";
import { t as applySyntheticConfig } from "../../onboard-DTAyyfmb.js";
import { t as buildSyntheticProvider } from "../../provider-catalog-xVxrzc_J.js";
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
