import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-LndEvhRk.js";
import { i as applyXaiModelCompat } from "../../provider-tools-B6vtw4BW.js";
import "../../text-runtime-BFTVdjnu.js";
import { t as defineSingleProviderPluginEntry } from "../../provider-entry-DeqMx0YZ.js";
import { n as VENICE_DEFAULT_MODEL_REF } from "../../models-D9BC3GGm.js";
import { t as buildVeniceProvider } from "../../provider-catalog-ky_C6m79.js";
import { t as applyVeniceConfig } from "../../onboard-Czedr8h9.js";
import { t as createVeniceDeepSeekV4Wrapper } from "../../stream-CEKvfQx2.js";
//#region extensions/venice/index.ts
const PROVIDER_ID = "venice";
function isXaiBackedVeniceModel(modelId) {
	return normalizeLowercaseStringOrEmpty(modelId).includes("grok");
}
var venice_default = defineSingleProviderPluginEntry({
	id: PROVIDER_ID,
	name: "Venice Provider",
	description: "Bundled Venice provider plugin",
	provider: {
		label: "Venice",
		docsPath: "/providers/venice",
		auth: [{
			methodId: "api-key",
			label: "Venice AI API key",
			hint: "Privacy-focused (uncensored models)",
			optionKey: "veniceApiKey",
			flagName: "--venice-api-key",
			envVar: "VENICE_API_KEY",
			promptMessage: "Enter Venice AI API key",
			defaultModel: VENICE_DEFAULT_MODEL_REF,
			applyConfig: (cfg) => applyVeniceConfig(cfg),
			noteMessage: [
				"Venice AI provides privacy-focused inference with uncensored models.",
				"Get your API key at: https://venice.ai/settings/api",
				"Supports 'private' (fully private) and 'anonymized' (proxy) modes."
			].join("\n"),
			noteTitle: "Venice AI",
			wizard: { groupLabel: "Venice AI" }
		}],
		catalog: { buildProvider: buildVeniceProvider },
		normalizeResolvedModel: ({ modelId, model }) => isXaiBackedVeniceModel(modelId) ? applyXaiModelCompat(model) : void 0,
		wrapStreamFn: (ctx) => createVeniceDeepSeekV4Wrapper(ctx.streamFn, ctx.thinkingLevel)
	}
});
//#endregion
export { venice_default as default };
