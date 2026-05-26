import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as extensionForMime } from "./mime-DppuT-pZ.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest, i as fetchProviderDownloadResponse, m as resolveProviderOperationTimeoutMs, n as createProviderOperationDeadline, p as resolveProviderHttpRequestConfig, r as createProviderOperationTimeoutResolver, s as pollProviderOperationJson } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import "./media-mime-j2Nhr7Df.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
import { t as TOGETHER_BASE_URL } from "./models-AP1dobyb.js";
//#region extensions/together/video-generation-provider.ts
const DEFAULT_TOGETHER_VIDEO_MODEL = "Wan-AI/Wan2.2-T2V-A14B";
const TOGETHER_VIDEO_BASE_URL = "https://api.together.xyz/v2";
const DEFAULT_TIMEOUT_MS = 12e4;
const POLL_INTERVAL_MS = 5e3;
const MAX_POLL_ATTEMPTS = 120;
function resolveTogetherVideoBaseUrl(req) {
	const configuredBaseUrl = normalizeOptionalString(req.cfg?.models?.providers?.together?.baseUrl);
	if (!configuredBaseUrl || stripTrailingSlash(configuredBaseUrl) === stripTrailingSlash(TOGETHER_BASE_URL)) return TOGETHER_VIDEO_BASE_URL;
	return configuredBaseUrl;
}
function stripTrailingSlash(value) {
	return value.replace(/\/+$/u, "");
}
function toDataUrl(buffer, mimeType) {
	return `data:${mimeType};base64,${buffer.toString("base64")}`;
}
function extractTogetherVideoUrl(payload) {
	if (Array.isArray(payload.outputs)) {
		for (const entry of payload.outputs) {
			const url = normalizeOptionalString(entry.video_url) ?? normalizeOptionalString(entry.url);
			if (url) return url;
		}
		return;
	}
	return normalizeOptionalString(payload.outputs?.video_url) ?? normalizeOptionalString(payload.outputs?.url);
}
async function pollTogetherVideo(params) {
	const deadline = createProviderOperationDeadline({
		timeoutMs: params.timeoutMs,
		label: `Together video generation task ${params.videoId}`
	});
	return await pollProviderOperationJson({
		url: `${params.baseUrl}/videos/${params.videoId}`,
		headers: params.headers,
		deadline,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		fetchFn: params.fetchFn,
		maxAttempts: MAX_POLL_ATTEMPTS,
		pollIntervalMs: POLL_INTERVAL_MS,
		requestFailedMessage: "Together video status request failed",
		timeoutMessage: `Together video generation task ${params.videoId} did not finish in time`,
		isComplete: (payload) => payload.status === "completed",
		getFailureMessage: (payload) => payload.status === "failed" ? normalizeOptionalString(payload.error?.message) ?? "Together video generation failed" : void 0
	});
}
async function downloadTogetherVideo(params) {
	const response = await fetchProviderDownloadResponse({
		url: params.url,
		init: { method: "GET" },
		timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		fetchFn: params.fetchFn,
		provider: "together",
		requestFailedMessage: "Together generated video download failed"
	});
	const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
	const arrayBuffer = await response.arrayBuffer();
	return {
		buffer: Buffer.from(arrayBuffer),
		mimeType,
		fileName: `video-1.${extensionForMime(mimeType)?.slice(1) ?? "mp4"}`
	};
}
function buildTogetherVideoGenerationProvider() {
	return {
		id: "together",
		label: "Together",
		defaultModel: DEFAULT_TOGETHER_VIDEO_MODEL,
		models: [
			DEFAULT_TOGETHER_VIDEO_MODEL,
			"Wan-AI/Wan2.2-I2V-A14B",
			"minimax/Hailuo-02",
			"Kwai/Kling-2.1-Master"
		],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: "together",
			agentDir
		}),
		capabilities: {
			generate: {
				maxVideos: 1,
				maxDurationSeconds: 12,
				supportsSize: true
			},
			imageToVideo: {
				enabled: true,
				maxVideos: 1,
				maxInputImages: 1,
				maxDurationSeconds: 12,
				supportsSize: true
			},
			videoToVideo: { enabled: false }
		},
		async generateVideo(req) {
			if ((req.inputVideos?.length ?? 0) > 0) throw new Error("Together video generation does not support video reference inputs.");
			const auth = await resolveApiKeyForProvider({
				provider: "together",
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("Together API key missing");
			const fetchFn = fetch;
			const deadline = createProviderOperationDeadline({
				timeoutMs: req.timeoutMs,
				label: "Together video generation"
			});
			const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl: resolveTogetherVideoBaseUrl(req),
				defaultBaseUrl: TOGETHER_VIDEO_BASE_URL,
				allowPrivateNetwork: false,
				defaultHeaders: {
					Authorization: `Bearer ${auth.apiKey}`,
					"Content-Type": "application/json"
				},
				provider: "together",
				capability: "video",
				transport: "http"
			});
			const body = {
				model: normalizeOptionalString(req.model) ?? DEFAULT_TOGETHER_VIDEO_MODEL,
				prompt: req.prompt
			};
			if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) body.seconds = String(Math.max(1, Math.round(req.durationSeconds)));
			const size = normalizeOptionalString(req.size);
			if (size) {
				const match = /^(\d+)x(\d+)$/u.exec(size);
				if (match) {
					body.width = Number.parseInt(match[1] ?? "", 10);
					body.height = Number.parseInt(match[2] ?? "", 10);
				}
			}
			if (req.inputImages?.[0]) {
				const input = req.inputImages[0];
				const value = normalizeOptionalString(input.url) ? normalizeOptionalString(input.url) : input.buffer ? toDataUrl(input.buffer, normalizeOptionalString(input.mimeType) ?? "image/png") : void 0;
				if (!value) throw new Error("Together reference image is missing image data.");
				body.reference_images = [value];
			}
			const { response, release } = await postJsonRequest({
				url: `${baseUrl}/videos`,
				headers,
				body,
				timeoutMs: resolveProviderOperationTimeoutMs({
					deadline,
					defaultTimeoutMs: DEFAULT_TIMEOUT_MS
				}),
				fetchFn,
				allowPrivateNetwork,
				dispatcherPolicy
			});
			try {
				await assertOkOrThrowHttpError(response, "Together video generation failed");
				const videoId = normalizeOptionalString((await response.json()).id);
				if (!videoId) throw new Error("Together video generation response missing id");
				const completed = await pollTogetherVideo({
					videoId,
					headers,
					timeoutMs: resolveProviderOperationTimeoutMs({
						deadline,
						defaultTimeoutMs: DEFAULT_TIMEOUT_MS
					}),
					baseUrl,
					fetchFn
				});
				const videoUrl = extractTogetherVideoUrl(completed);
				if (!videoUrl) throw new Error("Together video generation completed without an output URL");
				return {
					videos: [await downloadTogetherVideo({
						url: videoUrl,
						timeoutMs: createProviderOperationTimeoutResolver({
							deadline,
							defaultTimeoutMs: DEFAULT_TIMEOUT_MS
						}),
						fetchFn
					})],
					model: completed.model ?? req.model ?? DEFAULT_TOGETHER_VIDEO_MODEL,
					metadata: {
						videoId,
						status: completed.status,
						videoUrl
					}
				};
			} finally {
				await release();
			}
		}
	};
}
//#endregion
export { buildTogetherVideoGenerationProvider as t };
