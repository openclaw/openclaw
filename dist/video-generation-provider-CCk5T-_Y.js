import { p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
import { a as DEFAULT_VIDEO_GENERATION_TIMEOUT_MS, n as DASHSCOPE_WAN_VIDEO_MODELS, p as runDashscopeVideoGenerationTask, r as DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL, t as DASHSCOPE_WAN_VIDEO_CAPABILITIES } from "./video-generation-CNgr9W07.js";
//#region extensions/alibaba/video-generation-provider.ts
const DEFAULT_ALIBABA_VIDEO_BASE_URL = "https://dashscope-intl.aliyuncs.com";
const DEFAULT_ALIBABA_VIDEO_MODEL = DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL;
function resolveAlibabaVideoBaseUrl(req) {
	return req.cfg?.models?.providers?.alibaba?.baseUrl?.trim() || DEFAULT_ALIBABA_VIDEO_BASE_URL;
}
function resolveDashscopeAigcApiBaseUrl(baseUrl) {
	return baseUrl.replace(/\/+$/u, "");
}
function buildAlibabaVideoGenerationProvider() {
	return {
		id: "alibaba",
		label: "Alibaba Model Studio",
		defaultModel: DEFAULT_ALIBABA_VIDEO_MODEL,
		models: [...DASHSCOPE_WAN_VIDEO_MODELS],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: "alibaba",
			agentDir
		}),
		capabilities: DASHSCOPE_WAN_VIDEO_CAPABILITIES,
		async generateVideo(req) {
			const fetchFn = fetch;
			const auth = await resolveApiKeyForProvider({
				provider: "alibaba",
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("Alibaba Model Studio API key missing");
			const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl: resolveAlibabaVideoBaseUrl(req),
				defaultBaseUrl: DEFAULT_ALIBABA_VIDEO_BASE_URL,
				defaultHeaders: {
					Authorization: `Bearer ${auth.apiKey}`,
					"Content-Type": "application/json",
					"X-DashScope-Async": "enable"
				},
				provider: "alibaba",
				capability: "video",
				transport: "http"
			});
			return await runDashscopeVideoGenerationTask({
				providerLabel: "Alibaba Wan",
				model: req.model?.trim() || DEFAULT_ALIBABA_VIDEO_MODEL,
				req,
				url: `${resolveDashscopeAigcApiBaseUrl(baseUrl)}/api/v1/services/aigc/video-generation/video-synthesis`,
				headers,
				baseUrl: resolveDashscopeAigcApiBaseUrl(baseUrl),
				timeoutMs: req.timeoutMs,
				fetchFn,
				allowPrivateNetwork,
				dispatcherPolicy,
				defaultTimeoutMs: DEFAULT_VIDEO_GENERATION_TIMEOUT_MS
			});
		}
	};
}
//#endregion
export { buildAlibabaVideoGenerationProvider as t };
