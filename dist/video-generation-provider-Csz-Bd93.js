import { p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
import { a as DEFAULT_VIDEO_GENERATION_TIMEOUT_MS, n as DASHSCOPE_WAN_VIDEO_MODELS, p as runDashscopeVideoGenerationTask, r as DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL, t as DASHSCOPE_WAN_VIDEO_CAPABILITIES } from "./video-generation-CNgr9W07.js";
import "./models-D_eCLX7P.js";
//#region extensions/qwen/video-generation-provider.ts
const DEFAULT_QWEN_VIDEO_BASE_URL = "https://dashscope-intl.aliyuncs.com";
const DEFAULT_QWEN_VIDEO_MODEL = DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL;
function resolveQwenVideoBaseUrl(req) {
	const direct = req.cfg?.models?.providers?.qwen?.baseUrl?.trim();
	if (!direct) return DEFAULT_QWEN_VIDEO_BASE_URL;
	try {
		return new URL(direct).toString();
	} catch {
		return DEFAULT_QWEN_VIDEO_BASE_URL;
	}
}
function resolveDashscopeAigcApiBaseUrl(baseUrl) {
	try {
		const url = new URL(baseUrl);
		if (url.hostname === "coding-intl.dashscope.aliyuncs.com" || url.hostname === "coding.dashscope.aliyuncs.com" || url.hostname === "dashscope-intl.aliyuncs.com" || url.hostname === "dashscope.aliyuncs.com") return url.origin;
	} catch {}
	if (baseUrl.startsWith("https://dashscope.aliyuncs.com/compatible-mode/v1")) return "https://dashscope.aliyuncs.com";
	if (baseUrl.startsWith("https://dashscope-intl.aliyuncs.com/compatible-mode/v1")) return DEFAULT_QWEN_VIDEO_BASE_URL;
	return baseUrl.replace(/\/+$/u, "");
}
function buildQwenVideoGenerationProvider() {
	return {
		id: "qwen",
		label: "Qwen Cloud",
		defaultModel: DEFAULT_QWEN_VIDEO_MODEL,
		models: [...DASHSCOPE_WAN_VIDEO_MODELS],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: "qwen",
			agentDir
		}),
		capabilities: DASHSCOPE_WAN_VIDEO_CAPABILITIES,
		async generateVideo(req) {
			const fetchFn = fetch;
			const auth = await resolveApiKeyForProvider({
				provider: "qwen",
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("Qwen API key missing");
			const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl: resolveQwenVideoBaseUrl(req),
				defaultBaseUrl: DEFAULT_QWEN_VIDEO_BASE_URL,
				defaultHeaders: {
					Authorization: `Bearer ${auth.apiKey}`,
					"Content-Type": "application/json",
					"X-DashScope-Async": "enable"
				},
				provider: "qwen",
				capability: "video",
				transport: "http"
			});
			return await runDashscopeVideoGenerationTask({
				providerLabel: "Qwen",
				model: req.model?.trim() || DEFAULT_QWEN_VIDEO_MODEL,
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
export { buildQwenVideoGenerationProvider as t };
