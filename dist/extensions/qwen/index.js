import { t as defineSingleProviderPluginEntry } from "../../provider-entry-DYbqN6AQ.js";
import { A as isQwenCodingPlanBaseUrl, h as QWEN_DEFAULT_MODEL_REF, u as QWEN_36_PLUS_MODEL_ID, x as applyQwenNativeStreamingUsageCompat } from "../../models-D_eCLX7P.js";
import { n as buildQwenProvider } from "../../provider-catalog-9QA674ve.js";
import { n as wrapQwenProviderStream } from "../../stream-DYMa65k0.js";
import "../../api-CYblPfIU.js";
import { t as buildQwenMediaUnderstandingProvider } from "../../media-understanding-provider-Bcf51DvV.js";
import { d as applyQwenStandardConfig, f as applyQwenStandardConfigCn, l as applyQwenConfig, u as applyQwenConfigCn } from "../../onboard-DaAC6sp4.js";
import { t as buildQwenVideoGenerationProvider } from "../../video-generation-provider-Csz-Bd93.js";
//#region extensions/qwen/index.ts
const PROVIDER_ID = "qwen";
const LEGACY_PROVIDER_ID = "modelstudio";
function normalizeProviderId(value) {
	return value.trim().toLowerCase();
}
function resolveConfiguredQwenBaseUrl(config) {
	const providers = config?.models?.providers;
	if (!providers) return;
	for (const [providerId, provider] of Object.entries(providers)) {
		const normalized = normalizeProviderId(providerId);
		if (normalized !== PROVIDER_ID && normalized !== LEGACY_PROVIDER_ID) continue;
		const baseUrl = provider?.baseUrl?.trim();
		if (baseUrl) return baseUrl;
	}
}
var qwen_default = defineSingleProviderPluginEntry({
	id: PROVIDER_ID,
	name: "Qwen Provider",
	description: "Bundled Qwen Cloud provider plugin",
	provider: {
		label: "Qwen Cloud",
		docsPath: "/providers/qwen",
		aliases: ["modelstudio", "qwencloud"],
		auth: [
			{
				methodId: "standard-api-key-cn",
				label: "Standard API Key for China (pay-as-you-go)",
				hint: "Endpoint: dashscope.aliyuncs.com",
				optionKey: "modelstudioStandardApiKeyCn",
				flagName: "--modelstudio-standard-api-key-cn",
				envVar: "QWEN_API_KEY",
				promptMessage: "Enter Qwen Cloud API key (China standard endpoint)",
				defaultModel: QWEN_DEFAULT_MODEL_REF,
				applyConfig: (cfg) => applyQwenStandardConfigCn(cfg),
				noteMessage: [
					"Manage API keys: https://home.qwencloud.com/api-keys",
					"Docs: https://docs.qwencloud.com/",
					"Endpoint: dashscope.aliyuncs.com/compatible-mode/v1",
					"Models: qwen3.6-plus, qwen3.5-plus, qwen3-coder-plus, etc."
				].join("\n"),
				noteTitle: "Qwen Cloud Standard (China)",
				wizard: {
					choiceHint: "Endpoint: dashscope.aliyuncs.com",
					groupLabel: "Qwen Cloud",
					groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap"
				}
			},
			{
				methodId: "standard-api-key",
				label: "Standard API Key for Global/Intl (pay-as-you-go)",
				hint: "Endpoint: dashscope-intl.aliyuncs.com",
				optionKey: "modelstudioStandardApiKey",
				flagName: "--modelstudio-standard-api-key",
				envVar: "QWEN_API_KEY",
				promptMessage: "Enter Qwen Cloud API key (Global/Intl standard endpoint)",
				defaultModel: QWEN_DEFAULT_MODEL_REF,
				applyConfig: (cfg) => applyQwenStandardConfig(cfg),
				noteMessage: [
					"Manage API keys: https://home.qwencloud.com/api-keys",
					"Docs: https://docs.qwencloud.com/",
					"Endpoint: dashscope-intl.aliyuncs.com/compatible-mode/v1",
					"Models: qwen3.6-plus, qwen3.5-plus, qwen3-coder-plus, etc."
				].join("\n"),
				noteTitle: "Qwen Cloud Standard (Global/Intl)",
				wizard: {
					choiceHint: "Endpoint: dashscope-intl.aliyuncs.com",
					groupLabel: "Qwen Cloud",
					groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap"
				}
			},
			{
				methodId: "api-key-cn",
				label: "Coding Plan API Key for China (subscription)",
				hint: "Endpoint: coding.dashscope.aliyuncs.com",
				optionKey: "modelstudioApiKeyCn",
				flagName: "--modelstudio-api-key-cn",
				envVar: "QWEN_API_KEY",
				promptMessage: "Enter Qwen Cloud Coding Plan API key (China)",
				defaultModel: QWEN_DEFAULT_MODEL_REF,
				applyConfig: (cfg) => applyQwenConfigCn(cfg),
				noteMessage: [
					"Manage API keys: https://home.qwencloud.com/api-keys",
					"Docs: https://docs.qwencloud.com/",
					"Endpoint: coding.dashscope.aliyuncs.com",
					"Models: qwen3.5-plus, glm-5, kimi-k2.5, MiniMax-M2.5, etc."
				].join("\n"),
				noteTitle: "Qwen Cloud Coding Plan (China)",
				wizard: {
					choiceHint: "Endpoint: coding.dashscope.aliyuncs.com",
					groupLabel: "Qwen Cloud",
					groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap"
				}
			},
			{
				methodId: "api-key",
				label: "Coding Plan API Key for Global/Intl (subscription)",
				hint: "Endpoint: coding-intl.dashscope.aliyuncs.com",
				optionKey: "modelstudioApiKey",
				flagName: "--modelstudio-api-key",
				envVar: "QWEN_API_KEY",
				promptMessage: "Enter Qwen Cloud Coding Plan API key (Global/Intl)",
				defaultModel: QWEN_DEFAULT_MODEL_REF,
				applyConfig: (cfg) => applyQwenConfig(cfg),
				noteMessage: [
					"Manage API keys: https://home.qwencloud.com/api-keys",
					"Docs: https://docs.qwencloud.com/",
					"Endpoint: coding-intl.dashscope.aliyuncs.com",
					"Models: qwen3.5-plus, glm-5, kimi-k2.5, MiniMax-M2.5, etc."
				].join("\n"),
				noteTitle: "Qwen Cloud Coding Plan (Global/Intl)",
				wizard: {
					choiceHint: "Endpoint: coding-intl.dashscope.aliyuncs.com",
					groupLabel: "Qwen Cloud",
					groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap"
				}
			}
		],
		catalog: { run: async (ctx) => {
			const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
			if (!apiKey) return null;
			return { provider: {
				...buildQwenProvider({ baseUrl: resolveConfiguredQwenBaseUrl(ctx.config) ?? "https://coding-intl.dashscope.aliyuncs.com/v1" }),
				apiKey
			} };
		} },
		applyNativeStreamingUsageCompat: ({ providerConfig }) => applyQwenNativeStreamingUsageCompat(providerConfig),
		wrapStreamFn: wrapQwenProviderStream,
		normalizeConfig: ({ providerConfig }) => {
			if (!isQwenCodingPlanBaseUrl(providerConfig.baseUrl)) return;
			const models = providerConfig.models?.filter((model) => model.id !== QWEN_36_PLUS_MODEL_ID);
			return models && models.length !== providerConfig.models?.length ? {
				...providerConfig,
				models
			} : void 0;
		}
	},
	register(api) {
		api.registerMediaUnderstandingProvider(buildQwenMediaUnderstandingProvider());
		api.registerVideoGenerationProvider(buildQwenVideoGenerationProvider());
	}
});
//#endregion
export { qwen_default as default };
