import { t as applyModelCompatPatch } from "../../provider-model-compat-Dy84335e.js";
import { a as buildProviderReplayFamilyHooks } from "../../provider-model-shared-Bd4Hr4Ay.js";
import { t as defineSingleProviderPluginEntry } from "../../provider-entry-B5p3pd5V.js";
import { n as PROVIDER_LABELS } from "../../provider-usage.shared-DEV4fYbf.js";
import "../../provider-usage-B2-IxdBS.js";
import { n as buildXiaomiProvider } from "../../provider-catalog-DOZ5SKLx.js";
import { n as applyXiaomiConfig, t as XIAOMI_DEFAULT_MODEL_REF } from "../../onboard-CGAoOfa3.js";
import { t as buildXiaomiSpeechProvider } from "../../speech-provider-B77SKEdr.js";
import { r as resolveMiMoThinkingProfile } from "../../thinking-BasQca8w.js";
import { t as createMiMoThinkingWrapper } from "../../stream-CtSlMXiF.js";
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
