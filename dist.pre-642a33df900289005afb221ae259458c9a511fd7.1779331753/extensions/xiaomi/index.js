import { t as applyModelCompatPatch } from "../../provider-model-compat-CmPOKTzc.js";
import { a as buildProviderReplayFamilyHooks } from "../../provider-model-shared-DtsPmvDx.js";
import { t as defineSingleProviderPluginEntry } from "../../provider-entry-Dt4S1fAB.js";
import { n as PROVIDER_LABELS } from "../../provider-usage.shared-C1tmIJp0.js";
import "../../provider-usage-n_2ymB5v.js";
import { n as buildXiaomiProvider } from "../../provider-catalog-Cv1MFs4d.js";
import { n as applyXiaomiConfig, t as XIAOMI_DEFAULT_MODEL_REF } from "../../onboard-GBK17njX.js";
import { t as buildXiaomiSpeechProvider } from "../../speech-provider-7ltjKtqC.js";
import { r as resolveMiMoThinkingProfile } from "../../thinking-K_YRDMzr.js";
import { t as createMiMoThinkingWrapper } from "../../stream-BWiWsmCy.js";
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
		...buildProviderReplayFamilyHooks({
			family: "openai-compatible",
			dropReasoningFromHistory: false
		}),
		normalizeResolvedModel: ({ model }) => applyModelCompatPatch(model, { omitEmptyArrayItems: true }),
		wrapStreamFn: (ctx) => createMiMoThinkingWrapper(ctx.streamFn, ctx.thinkingLevel),
		resolveThinkingProfile: ({ modelId }) => resolveMiMoThinkingProfile(modelId),
		isModernModelRef: ({ modelId }) => Boolean(resolveMiMoThinkingProfile(modelId)),
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
