import "../../defaults-mDjiWzE5.js";
import { a as normalizeModelCompat } from "../../provider-model-compat-CmPOKTzc.js";
import { l as cloneFirstTemplateModel, r as OPENAI_COMPATIBLE_REPLAY_HOOKS } from "../../provider-model-shared-DtsPmvDx.js";
import { t as defineSingleProviderPluginEntry } from "../../provider-entry-DYbqN6AQ.js";
import { t as isFireworksKimiModelId } from "../../model-id-BhN5iHky.js";
import { l as buildFireworksProvider, n as FIREWORKS_DEFAULT_CONTEXT_WINDOW, r as FIREWORKS_DEFAULT_MAX_TOKENS, t as FIREWORKS_BASE_URL } from "../../provider-catalog-Dczb1vRK.js";
import { n as applyFireworksConfig, t as FIREWORKS_DEFAULT_MODEL_REF } from "../../onboard-CvtqbvNe.js";
import { n as wrapFireworksProviderStream } from "../../stream-B2N1Sk1_.js";
import { t as resolveFireworksThinkingProfile } from "../../thinking-policy-D67HZmJf.js";
//#region extensions/fireworks/index.ts
const PROVIDER_ID = "fireworks";
function resolveFireworksDynamicModel(ctx) {
	const modelId = ctx.modelId.trim();
	if (!modelId) return;
	return cloneFirstTemplateModel({
		providerId: PROVIDER_ID,
		modelId,
		templateIds: ["accounts/fireworks/routers/kimi-k2p5-turbo"],
		ctx,
		patch: {
			provider: PROVIDER_ID,
			reasoning: !isFireworksKimiModelId(modelId)
		}
	}) ?? normalizeModelCompat({
		id: modelId,
		name: modelId,
		provider: PROVIDER_ID,
		api: "openai-completions",
		baseUrl: FIREWORKS_BASE_URL,
		reasoning: !isFireworksKimiModelId(modelId),
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
		maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS || 2e5
	});
}
var fireworks_default = defineSingleProviderPluginEntry({
	id: PROVIDER_ID,
	name: "Fireworks Provider",
	description: "Bundled Fireworks AI provider plugin",
	provider: {
		label: "Fireworks",
		aliases: ["fireworks-ai"],
		docsPath: "/providers/fireworks",
		auth: [{
			methodId: "api-key",
			label: "Fireworks API key",
			hint: "API key",
			optionKey: "fireworksApiKey",
			flagName: "--fireworks-api-key",
			envVar: "FIREWORKS_API_KEY",
			promptMessage: "Enter Fireworks API key",
			defaultModel: FIREWORKS_DEFAULT_MODEL_REF,
			applyConfig: (cfg) => applyFireworksConfig(cfg)
		}],
		catalog: {
			buildProvider: buildFireworksProvider,
			allowExplicitBaseUrl: true
		},
		...OPENAI_COMPATIBLE_REPLAY_HOOKS,
		wrapStreamFn: wrapFireworksProviderStream,
		resolveThinkingProfile: ({ modelId }) => resolveFireworksThinkingProfile(modelId),
		resolveDynamicModel: (ctx) => resolveFireworksDynamicModel(ctx),
		isModernModelRef: () => true
	}
});
//#endregion
export { fireworks_default as default };
