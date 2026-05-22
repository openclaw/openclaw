import { t as applyModelCompatPatch } from "../../provider-model-compat-B8Ufait7.js";
import { a as buildProviderReplayFamilyHooks } from "../../provider-model-shared-BDPvUGt6.js";
import { t as defineSingleProviderPluginEntry } from "../../provider-entry-CvzPTPLs.js";
import { n as PROVIDER_LABELS } from "../../provider-usage.shared-BT_zLwRX.js";
import "../../provider-usage-D4q2FTtg.js";
import { n as buildXiaomiProvider } from "../../provider-catalog-BeZHra27.js";
import { n as applyXiaomiConfig, t as XIAOMI_DEFAULT_MODEL_REF } from "../../onboard-fNBReBaa.js";
import { t as buildXiaomiSpeechProvider } from "../../speech-provider-ButxpT3B.js";
import { r as resolveMiMoThinkingProfile } from "../../thinking-DaFsqdy3.js";
import { t as createMiMoThinkingWrapper } from "../../stream-CZ6ZM8i0.js";
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
