import { t as defineSingleProviderPluginEntry } from "../../provider-entry-De5OyS6w.js";
import { n as PROVIDER_LABELS } from "../../provider-usage.shared-BH4N8K15.js";
import "../../provider-usage-CjE5RLmk.js";
import { n as buildXiaomiProvider } from "../../provider-catalog-B9bBnMbi.js";
import { n as applyXiaomiConfig, t as XIAOMI_DEFAULT_MODEL_REF } from "../../onboard-Dp-HH4oQ.js";
import { t as buildXiaomiSpeechProvider } from "../../speech-provider-BIr1CXLU.js";
var xiaomi_default = defineSingleProviderPluginEntry({
	id: "xiaomi",
	name: "Xiaomi Provider",
	description: "Bundled Xiaomi provider plugin",
	provider: {
		label: "Xiaomi",
		docsPath: "/providers/xiaomi",
		auth: [{
			methodId: "api-key",
			label: "Xiaomi API key",
			hint: "API key",
			optionKey: "xiaomiApiKey",
			flagName: "--xiaomi-api-key",
			envVar: "XIAOMI_API_KEY",
			promptMessage: "Enter Xiaomi API key",
			defaultModel: XIAOMI_DEFAULT_MODEL_REF,
			applyConfig: (cfg) => applyXiaomiConfig(cfg)
		}],
		catalog: { buildProvider: buildXiaomiProvider },
		resolveUsageAuth: async (ctx) => {
			const apiKey = ctx.resolveApiKeyFromConfigAndStore({ envDirect: [ctx.env.XIAOMI_API_KEY] });
			return apiKey ? { token: apiKey } : null;
		},
		fetchUsageSnapshot: async () => ({
			provider: "xiaomi",
			displayName: PROVIDER_LABELS.xiaomi,
			windows: []
		})
	},
	register(api) {
		api.registerSpeechProvider(buildXiaomiSpeechProvider());
	}
});
//#endregion
export { xiaomi_default as default };
