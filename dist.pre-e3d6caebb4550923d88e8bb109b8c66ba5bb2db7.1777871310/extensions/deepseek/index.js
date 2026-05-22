import { a as buildProviderReplayFamilyHooks } from "../../provider-model-shared-wmBDALmq.js";
import { r as readConfiguredProviderCatalogEntries } from "../../provider-catalog-shared-BanUMnOe.js";
import { t as defineSingleProviderPluginEntry } from "../../provider-entry-B24YCSzl.js";
import { i as isDeepSeekV4ModelId } from "../../models-BnMjN7-P.js";
import { t as buildDeepSeekProvider } from "../../provider-catalog-DBhPV2YX.js";
import { t as createDeepSeekV4ThinkingWrapper } from "../../stream-9LnWcTyH.js";
import { n as applyDeepSeekConfig, t as DEEPSEEK_DEFAULT_MODEL_REF } from "../../onboard-DBncCmPd.js";
//#region extensions/deepseek/index.ts
const PROVIDER_ID = "deepseek";
const V4_THINKING_LEVEL_IDS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
function buildDeepSeekV4ThinkingLevel(id) {
	return { id };
}
const DEEPSEEK_V4_THINKING_PROFILE = {
	levels: V4_THINKING_LEVEL_IDS.map(buildDeepSeekV4ThinkingLevel),
	defaultLevel: "high"
};
function resolveDeepSeekV4ThinkingProfile(modelId) {
	return isDeepSeekV4ModelId(modelId) ? DEEPSEEK_V4_THINKING_PROFILE : void 0;
}
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
		...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
		wrapStreamFn: (ctx) => createDeepSeekV4ThinkingWrapper(ctx.streamFn, ctx.thinkingLevel),
		resolveThinkingProfile: ({ modelId }) => resolveDeepSeekV4ThinkingProfile(modelId),
		isModernModelRef: ({ modelId }) => Boolean(resolveDeepSeekV4ThinkingProfile(modelId))
	}
});
//#endregion
export { deepseek_default as default };
