import { t as defineSingleProviderPluginEntry } from "../../provider-entry-DYbqN6AQ.js";
import { r as buildQianfanProvider } from "../../provider-catalog-RV0Di9vu.js";
import { n as applyQianfanConfig, t as QIANFAN_DEFAULT_MODEL_REF } from "../../onboard-fi7GjJ1s.js";
var qianfan_default = defineSingleProviderPluginEntry({
	id: "qianfan",
	name: "Qianfan Provider",
	description: "Bundled Qianfan provider plugin",
	provider: {
		label: "Qianfan",
		docsPath: "/providers/qianfan",
		auth: [{
			methodId: "api-key",
			label: "Qianfan API key",
			hint: "API key",
			optionKey: "qianfanApiKey",
			flagName: "--qianfan-api-key",
			envVar: "QIANFAN_API_KEY",
			promptMessage: "Enter Qianfan API key",
			defaultModel: QIANFAN_DEFAULT_MODEL_REF,
			applyConfig: (cfg) => applyQianfanConfig(cfg)
		}],
		catalog: { buildProvider: buildQianfanProvider }
	}
});
//#endregion
export { qianfan_default as default };
