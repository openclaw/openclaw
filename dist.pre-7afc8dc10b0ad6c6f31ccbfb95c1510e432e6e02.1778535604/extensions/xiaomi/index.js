import { t as defineSingleProviderPluginEntry } from "../../provider-entry-D1K5glsY.js";
import { n as PROVIDER_LABELS } from "../../provider-usage.shared-2nMoeasH.js";
import "../../provider-usage-Dd1S3j3n.js";
import { n as buildXiaomiProvider } from "../../provider-catalog-Ddu3kPEv.js";
import { n as applyXiaomiConfig, t as XIAOMI_DEFAULT_MODEL_REF } from "../../onboard-Ds5i0l3V.js";
import { t as buildXiaomiSpeechProvider } from "../../speech-provider-6aG5u0Mc.js";
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
