import { l as jsonResult } from "../../common-V7-zd73S.js";
import { r as OPENAI_COMPATIBLE_REPLAY_HOOKS } from "../../provider-model-shared-D-slKnZa.js";
import { s as defaultToolStreamExtraParams } from "../../provider-stream-shared-BMzmRA_f.js";
import { t as defineSingleProviderPluginEntry } from "../../provider-entry-CDwzUX_P.js";
import "../../provider-web-search-D2KY-StD.js";
import { a as normalizeNativeXaiModelId, o as resolveXaiModelCompatPatch } from "../../model-compat-TbJYnPAX.js";
import { t as buildXaiProvider } from "../../provider-catalog-BX5BIgsD.js";
import { n as applyXaiConfig, t as XAI_DEFAULT_MODEL_REF } from "../../onboard-cA7-mBVb.js";
import { t as buildXaiImageGenerationProvider } from "../../image-generation-provider-DJOEvmCQ.js";
import { t as applyXaiRuntimeModelCompat } from "../../runtime-model-compat-CGE6fRZs.js";
import { n as resolveXaiForwardCompatModel, t as isModernXaiModel } from "../../provider-models-B6wSJQy7.js";
import { i as shouldContributeXaiCompat, r as resolveXaiTransport } from "../../api-CX2NWiFV.js";
import { t as resolveThinkingProfile } from "../../provider-policy-api-BPnzGG86.js";
import { t as buildXaiRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-DrUcK6Qp.js";
import { t as buildXaiSpeechProvider } from "../../speech-provider-BHZo8BTJ.js";
import { n as resolveFallbackXaiAuth, t as isXaiToolEnabled } from "../../tool-auth-shared-CLxDQ-nU.js";
import { t as resolveEffectiveXSearchConfig } from "../../x-search-config-DjrZLBsF.js";
import { r as wrapXaiProviderStream } from "../../stream-XhQtOJDT.js";
import { n as buildXaiMediaUnderstandingProvider } from "../../stt-BHNkjNBH.js";
import { t as buildXaiVideoGenerationProvider } from "../../video-generation-provider-C-0Bk5yk.js";
import { t as createXaiWebSearchProvider } from "../../web-search-C0uIAYMT.js";
import { n as createXSearchToolDefinition, t as buildMissingXSearchApiKeyPayload } from "../../x-search-tool-shared-CJRabjCs.js";
import { Type } from "typebox";
//#region extensions/xai/index.ts
const PROVIDER_ID = "xai";
let codeExecutionModulePromise;
let xSearchModulePromise;
function loadCodeExecutionModule() {
	codeExecutionModulePromise ??= import("./code-execution.js");
	return codeExecutionModulePromise;
}
function loadXSearchModule() {
	xSearchModulePromise ??= import("./x-search.js");
	return xSearchModulePromise;
}
function hasResolvableXaiApiKey(config, auth) {
	return isXaiToolEnabled({
		sourceConfig: config,
		auth
	});
}
function isCodeExecutionEnabled(config, auth) {
	if (!config || typeof config !== "object") return hasResolvableXaiApiKey(config, auth);
	const entries = config.plugins;
	const pluginEntries = entries && typeof entries === "object" ? entries.entries : void 0;
	const xaiEntry = pluginEntries && typeof pluginEntries.xai === "object" ? pluginEntries.xai : void 0;
	const pluginConfig = xaiEntry && typeof xaiEntry.config === "object" ? xaiEntry.config : void 0;
	if ((pluginConfig && typeof pluginConfig.codeExecution === "object" ? pluginConfig.codeExecution : void 0)?.enabled === false) return false;
	return hasResolvableXaiApiKey(config, auth);
}
function isXSearchEnabled(config, auth) {
	if ((config && typeof config === "object" ? resolveEffectiveXSearchConfig(config) : void 0)?.enabled === false) return false;
	return hasResolvableXaiApiKey(config, auth);
}
function createLazyCodeExecutionTool(ctx) {
	if (!isCodeExecutionEnabled(ctx.runtimeConfig ?? ctx.config, ctx)) return null;
	return {
		label: "Code Execution",
		name: "code_execution",
		description: "Run sandboxed Python analysis with xAI. Use for calculations, tabulation, summaries, and chart-style analysis without local machine access.",
		parameters: Type.Object({ task: Type.String({ description: "The full analysis task for xAI's remote Python sandbox. Include any data to analyze directly in the task." }) }),
		execute: async (toolCallId, args) => {
			const { createCodeExecutionTool } = await loadCodeExecutionModule();
			const tool = createCodeExecutionTool({
				config: ctx.config,
				runtimeConfig: ctx.runtimeConfig ?? null,
				auth: ctx
			});
			if (!tool) return jsonResult({
				error: "missing_xai_api_key",
				message: "code_execution needs an xAI API key. Run openclaw onboard --auth-choice xai-api-key, set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey.",
				docs: "https://docs.openclaw.ai/tools/code-execution"
			});
			return await tool.execute(toolCallId, args);
		}
	};
}
function createLazyXSearchTool(ctx) {
	if (!isXSearchEnabled(ctx.runtimeConfig ?? ctx.config, ctx)) return null;
	return createXSearchToolDefinition(async (toolCallId, args) => {
		const { createXSearchTool } = await loadXSearchModule();
		const tool = createXSearchTool({
			config: ctx.config,
			runtimeConfig: ctx.runtimeConfig ?? null,
			auth: ctx
		});
		if (!tool) return jsonResult(buildMissingXSearchApiKeyPayload());
		return await tool.execute(toolCallId, args);
	});
}
var xai_default = defineSingleProviderPluginEntry({
	id: "xai",
	name: "xAI Plugin",
	description: "Bundled xAI plugin",
	provider: {
		label: "xAI",
		aliases: ["x-ai"],
		docsPath: "/providers/xai",
		auth: [{
			methodId: "api-key",
			label: "xAI API key",
			hint: "API key",
			optionKey: "xaiApiKey",
			flagName: "--xai-api-key",
			envVar: "XAI_API_KEY",
			promptMessage: "Enter xAI API key",
			defaultModel: XAI_DEFAULT_MODEL_REF,
			applyConfig: (cfg) => applyXaiConfig(cfg),
			wizard: { groupLabel: "xAI (Grok)" }
		}],
		catalog: { buildProvider: buildXaiProvider },
		...OPENAI_COMPATIBLE_REPLAY_HOOKS,
		prepareExtraParams: (ctx) => defaultToolStreamExtraParams(ctx.extraParams),
		wrapStreamFn: wrapXaiProviderStream,
		resolveSyntheticAuth: ({ config }) => {
			const fallbackAuth = resolveFallbackXaiAuth(config);
			if (!fallbackAuth) return;
			return {
				apiKey: fallbackAuth.apiKey,
				source: fallbackAuth.source,
				mode: "api-key"
			};
		},
		normalizeResolvedModel: ({ model }) => applyXaiRuntimeModelCompat(model),
		normalizeTransport: ({ provider, api, baseUrl }) => resolveXaiTransport({
			provider,
			api,
			baseUrl
		}),
		contributeResolvedModelCompat: ({ modelId, model }) => shouldContributeXaiCompat({
			modelId,
			model
		}) ? resolveXaiModelCompatPatch() : void 0,
		normalizeModelId: ({ modelId }) => normalizeNativeXaiModelId(modelId),
		resolveDynamicModel: (ctx) => resolveXaiForwardCompatModel({
			providerId: PROVIDER_ID,
			ctx
		}),
		resolveThinkingProfile,
		isModernModelRef: ({ modelId }) => isModernXaiModel(modelId)
	},
	register(api) {
		api.registerWebSearchProvider(createXaiWebSearchProvider());
		api.registerMediaUnderstandingProvider(buildXaiMediaUnderstandingProvider());
		api.registerVideoGenerationProvider(buildXaiVideoGenerationProvider());
		api.registerImageGenerationProvider(buildXaiImageGenerationProvider());
		api.registerSpeechProvider(buildXaiSpeechProvider());
		api.registerRealtimeTranscriptionProvider(buildXaiRealtimeTranscriptionProvider());
		api.registerTool((ctx) => createLazyCodeExecutionTool(ctx), { name: "code_execution" });
		api.registerTool((ctx) => createLazyXSearchTool(ctx), { name: "x_search" });
	}
});
//#endregion
export { xai_default as default };
