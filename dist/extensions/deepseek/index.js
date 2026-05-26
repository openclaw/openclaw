import { n as buildProviderToolCompatFamilyHooks } from "../../provider-tools-D8Ja_oUH.js";
import { a as buildProviderReplayFamilyHooks } from "../../provider-model-shared-DtsPmvDx.js";
import { a as readConfiguredProviderCatalogEntries } from "../../provider-catalog-shared-BLp5nwNN.js";
import { t as defineSingleProviderPluginEntry } from "../../provider-entry-DYbqN6AQ.js";
import { t as buildDeepSeekProvider } from "../../provider-catalog-gNsEYitN.js";
import { t as createDeepSeekV4ThinkingWrapper } from "../../stream-BQ9hyEa2.js";
import { n as applyDeepSeekConfig, t as DEEPSEEK_DEFAULT_MODEL_REF } from "../../onboard-gz9Ya_HO.js";
import { t as resolveDeepSeekV4ThinkingProfile } from "../../thinking-DpufZF19.js";
//#region extensions/deepseek/index.ts
const PROVIDER_ID = "deepseek";
var deepseek_default = defineSingleProviderPluginEntry({
	id: PROVIDER_ID,
	name: "DeepSeek Provider",
	description: "Bundled DeepSeek provider plugin",
	provider: {
		label: "DeepSeek",
		docsPath: "/providers/deepseek",
		auth: [{
			methodId: "api-key",
			label: "DeepSeek API key",
			hint: "API key",
			optionKey: "deepseekApiKey",
			flagName: "--deepseek-api-key",
			envVar: "DEEPSEEK_API_KEY",
			promptMessage: "Enter DeepSeek API key",
			defaultModel: DEEPSEEK_DEFAULT_MODEL_REF,
			applyConfig: (cfg) => applyDeepSeekConfig(cfg),
			wizard: {
				choiceId: "deepseek-api-key",
				choiceLabel: "DeepSeek API key",
				groupId: "deepseek",
				groupLabel: "DeepSeek",
				groupHint: "API key"
			}
		}],
		catalog: { buildProvider: buildDeepSeekProvider },
		augmentModelCatalog: ({ config }) => readConfiguredProviderCatalogEntries({
			config,
			providerId: PROVIDER_ID
		}),
		matchesContextOverflowError: ({ errorMessage }) => /\bdeepseek\b.*(?:input.*too long|context.*exceed)/i.test(errorMessage),
		...buildProviderReplayFamilyHooks({
			family: "openai-compatible",
			dropReasoningFromHistory: false
		}),
		...buildProviderToolCompatFamilyHooks("deepseek"),
		wrapStreamFn: (ctx) => createDeepSeekV4ThinkingWrapper(ctx.streamFn, ctx.thinkingLevel),
		resolveThinkingProfile: ({ modelId }) => resolveDeepSeekV4ThinkingProfile(modelId),
		isModernModelRef: ({ modelId }) => Boolean(resolveDeepSeekV4ThinkingProfile(modelId))
	}
});
//#endregion
export { deepseek_default as default };
