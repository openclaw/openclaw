import { t as defineSingleProviderPluginEntry } from "../../provider-entry-CDwzUX_P.js";
import { n as applyCerebrasConfig, t as CEREBRAS_DEFAULT_MODEL_REF } from "../../onboard-C1OEjR65.js";
import { t as buildCerebrasProvider } from "../../provider-catalog--iFzISwx.js";
var cerebras_default = defineSingleProviderPluginEntry({
	id: "cerebras",
	name: "Cerebras Provider",
	description: "Bundled Cerebras provider plugin",
	provider: {
		label: "Cerebras",
		docsPath: "/providers/cerebras",
		auth: [{
			methodId: "api-key",
			label: "Cerebras API key",
			hint: "Fast OpenAI-compatible inference",
			optionKey: "cerebrasApiKey",
			flagName: "--cerebras-api-key",
			envVar: "CEREBRAS_API_KEY",
			promptMessage: "Enter Cerebras API key",
			defaultModel: CEREBRAS_DEFAULT_MODEL_REF,
			applyConfig: (cfg) => applyCerebrasConfig(cfg),
			noteMessage: ["Cerebras provides high-speed OpenAI-compatible inference for GPT OSS, GLM, Qwen, and Llama models.", "Get your API key at: https://cloud.cerebras.ai"].join("\n"),
			noteTitle: "Cerebras",
			wizard: {
				groupLabel: "Cerebras",
				groupHint: "Fast OpenAI-compatible inference"
			}
		}],
		catalog: {
			buildProvider: buildCerebrasProvider,
			buildStaticProvider: buildCerebrasProvider
		}
	}
});
//#endregion
export { cerebras_default as default };
