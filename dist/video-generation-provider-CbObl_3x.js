import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { r as extensionForMime } from "./mime-Bg_OIUJn.js";
import { r as fetchWithTimeout } from "./fetch-timeout-BxQNNg4F.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-B_ZYSMaC.js";
import { a as postJsonRequest, d as resolveProviderOperationTimeoutMs, i as pollProviderOperationJson, n as createProviderOperationDeadline, u as resolveProviderHttpRequestConfig } from "./shared-BtBXLREr.js";
import { l as isProviderApiKeyConfigured } from "./provider-auth-D5QGE8z6.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./media-mime-C13b9Hj2.js";
import { a as resolveApiKeyForProvider } from "./provider-auth-runtime-CNBotkGP.js";
import "./provider-http-BWEeBX6j.js";
import { i as toOpenAIDataUrl, r as resolveConfiguredOpenAIBaseUrl } from "./shared-BTr-HIdJ.js";
//#region extensions/openai/video-generation-provider.ts
const DEFAULT_OPENAI_VIDEO_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_VIDEO_MODEL = "sora-2";
const DEFAULT_TIMEOUT_MS = 12e4;
const POLL_INTERVAL_MS = 2500;
const MAX_POLL_ATTEMPTS = 120;
const OPENAI_VIDEO_SECONDS = [
	4,
	8,
	12
];
const OPENAI_VIDEO_SIZES = [
	"720x1280",
	"1280x720",
	"1024x1792",
	"1792x1024"
];
function toBlobBytes(buffer) {
	const arrayBuffer = new ArrayBuffer(buffer.byteLength);
	new Uint8Array(arrayBuffer).set(buffer);
	return arrayBuffer;
}
function resolveDurationSeconds(durationSeconds) {
	if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) return;
	const rounded = Math.max(OPENAI_VIDEO_SECONDS[0], Math.round(durationSeconds));
	const nearest = OPENAI_VIDEO_SECONDS.reduce((best, current) => Math.abs(current - rounded) < Math.abs(best - rounded) ? current : best);
	return String(nearest);
}
function resolveSize(params) {
	const explicitSize = normalizeOptionalString(params.size);
	if (explicitSize && OPENAI_VIDEO_SIZES.includes(explicitSize)) return explicitSize;
	switch (normalizeOptionalString(params.aspectRatio)) {
		case "9:16": return "720x1280";
		case "16:9": return "1280x720";
		case "4:7": return "1024x1792";
		case "7:4": return "1792x1024";
		default: break;
	}
	if (params.resolution === "1080P") return "1792x1024";
}
function resolveReferenceAsset(req) {
	const allAssets = [...req.inputImages ?? [], ...req.inputVideos ?? []];
	if (allAssets.length === 0) return null;
	if (allAssets.length > 1) throw new Error("OpenAI video generation supports at most one reference image or video.");
	const [asset] = allAssets;
	if (!asset?.buffer) throw new Error("OpenAI video generation currently requires local image/video uploads for reference assets.");
	const mimeType = normalizeOptionalString(asset.mimeType) || ((req.inputVideos?.length ?? 0) > 0 ? "video/mp4" : "image/png");
	const extension = extensionForMime(mimeType)?.slice(1) ?? (mimeType.startsWith("video/") ? "mp4" : "png");
	const fileName = normalizeOptionalString(asset.fileName) || `${(req.inputVideos?.length ?? 0) > 0 ? "reference-video" : "reference-image"}.${extension}`;
	return new File([toBlobBytes(asset.buffer)], fileName, { type: mimeType });
}
async function pollOpenAIVideo(params) {
	const deadline = createProviderOperationDeadline({
		timeoutMs: params.timeoutMs,
		label: `OpenAI video generation task ${params.videoId}`
	});
	return await pollProviderOperationJson({
		url: `${params.baseUrl}/videos/${params.videoId}`,
		headers: params.headers,
		deadline,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		fetchFn: params.fetchFn,
		maxAttempts: MAX_POLL_ATTEMPTS,
		pollIntervalMs: POLL_INTERVAL_MS,
		requestFailedMessage: "OpenAI video status request failed",
		timeoutMessage: `OpenAI video generation task ${params.videoId} did not finish in time`,
		isComplete: (payload) => payload.status === "completed",
		getFailureMessage: (payload) => payload.status === "failed" ? normalizeOptionalString(payload.error?.message) || "OpenAI video generation failed" : void 0
	});
}
async function downloadOpenAIVideo(params) {
	const url = new URL(`${params.baseUrl}/videos/${params.videoId}/content`);
	url.searchParams.set("variant", "video");
	const response = await fetchWithTimeout(url.toString(), {
		method: "GET",
		headers: new Headers({
			...Object.fromEntries(params.headers.entries()),
			Accept: "application/binary"
		})
	}, params.timeoutMs ?? DEFAULT_TIMEOUT_MS, params.fetchFn);
	await assertOkOrThrowHttpError(response, "OpenAI video download failed");
	const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
	const arrayBuffer = await response.arrayBuffer();
	return {
		buffer: Buffer.from(arrayBuffer),
		mimeType,
		fileName: `video-1.${extensionForMime(mimeType)?.slice(1) ?? "mp4"}`
	};
}
function buildOpenAIVideoGenerationProvider() {
	return {
		id: "openai",
		aliases: ["openai-codex"],
		label: "OpenAI",
		defaultModel: DEFAULT_OPENAI_VIDEO_MODEL,
		models: [DEFAULT_OPENAI_VIDEO_MODEL, "sora-2-pro"],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: "openai",
			agentDir
		}),
		capabilities: {
			generate: {
				maxVideos: 1,
				maxDurationSeconds: 12,
				supportedDurationSeconds: OPENAI_VIDEO_SECONDS,
				supportsSize: true,
				sizes: OPENAI_VIDEO_SIZES
			},
			imageToVideo: {
				enabled: true,
				maxVideos: 1,
				maxInputImages: 1,
				maxDurationSeconds: 12,
				supportedDurationSeconds: OPENAI_VIDEO_SECONDS,
				supportsSize: true,
				sizes: OPENAI_VIDEO_SIZES
			},
			videoToVideo: {
				enabled: true,
				maxVideos: 1,
				maxInputVideos: 1,
				maxDurationSeconds: 12,
				supportedDurationSeconds: OPENAI_VIDEO_SECONDS,
				supportsSize: true,
				sizes: OPENAI_VIDEO_SIZES
			}
		},
		async generateVideo(req) {
			const auth = await resolveApiKeyForProvider({
				provider: "openai",
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("OpenAI API key missing");
			const fetchFn = fetch;
			const deadline = createProviderOperationDeadline({
				timeoutMs: req.timeoutMs,
				label: "OpenAI video generation"
			});
			const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl: resolveConfiguredOpenAIBaseUrl(req.cfg),
				defaultBaseUrl: DEFAULT_OPENAI_VIDEO_BASE_URL,
				allowPrivateNetwork: false,
				defaultHeaders: { Authorization: `Bearer ${auth.apiKey}` },
				provider: "openai",
				capability: "video",
				transport: "http"
			});
			const model = normalizeOptionalString(req.model) ?? DEFAULT_OPENAI_VIDEO_MODEL;
			const seconds = resolveDurationSeconds(req.durationSeconds);
			const size = resolveSize({
				size: req.size,
				aspectRatio: req.aspectRatio,
				resolution: req.resolution
			});
			const inputImage = req.inputImages?.[0];
			const referenceAsset = resolveReferenceAsset(req);
			const requestUrl = `${baseUrl}/videos`;
			const { response, release } = referenceAsset ? inputImage?.buffer ? await (() => {
				const jsonHeaders = new Headers(headers);
				jsonHeaders.set("Content-Type", "application/json");
				return postJsonRequest({
					url: requestUrl,
					headers: jsonHeaders,
					body: {
						prompt: req.prompt,
						model,
						...seconds ? { seconds } : {},
						...size ? { size } : {},
						input_reference: { image_url: toOpenAIDataUrl(inputImage.buffer, normalizeOptionalString(inputImage.mimeType) ?? "image/png") }
					},
					timeoutMs: resolveProviderOperationTimeoutMs({
						deadline,
						defaultTimeoutMs: DEFAULT_TIMEOUT_MS
					}),
					fetchFn,
					allowPrivateNetwork,
					dispatcherPolicy
				});
			})() : await (() => {
				const form = new FormData();
				form.set("prompt", req.prompt);
				form.set("model", model);
				if (seconds) form.set("seconds", seconds);
				if (size) form.set("size", size);
				form.set("input_reference", referenceAsset);
				const multipartHeaders = new Headers(headers);
				multipartHeaders.delete("Content-Type");
				return fetchWithTimeout(requestUrl, {
					method: "POST",
					headers: multipartHeaders,
					body: form
				}, resolveProviderOperationTimeoutMs({
					deadline,
					defaultTimeoutMs: DEFAULT_TIMEOUT_MS
				}), fetchFn).then((response) => ({
					response,
					release: async () => {}
				}));
			})() : await (() => {
				const jsonHeaders = new Headers(headers);
				jsonHeaders.set("Content-Type", "application/json");
				return postJsonRequest({
					url: requestUrl,
					headers: jsonHeaders,
					body: {
						prompt: req.prompt,
						model,
						...seconds ? { seconds } : {},
						...size ? { size } : {}
					},
					timeoutMs: resolveProviderOperationTimeoutMs({
						deadline,
						defaultTimeoutMs: DEFAULT_TIMEOUT_MS
					}),
					fetchFn,
					allowPrivateNetwork,
					dispatcherPolicy
				});
			})();
			try {
				await assertOkOrThrowHttpError(response, "OpenAI video generation failed");
				const submitted = await response.json();
				const videoId = normalizeOptionalString(submitted.id);
				if (!videoId) throw new Error("OpenAI video generation response missing video id");
				const completed = await pollOpenAIVideo({
					videoId,
					headers,
					timeoutMs: resolveProviderOperationTimeoutMs({
						deadline,
						defaultTimeoutMs: DEFAULT_TIMEOUT_MS
					}),
					baseUrl,
					fetchFn
				});
				return {
					videos: [await downloadOpenAIVideo({
						videoId,
						headers,
						timeoutMs: resolveProviderOperationTimeoutMs({
							deadline,
							defaultTimeoutMs: DEFAULT_TIMEOUT_MS
						}),
						baseUrl,
						fetchFn
					})],
					model: completed.model ?? submitted.model ?? model,
					metadata: {
						videoId,
						status: completed.status,
						seconds: completed.seconds ?? submitted.seconds,
						size: completed.size ?? submitted.size
					}
				};
			} finally {
				await release();
			}
		}
	};
}
//#endregion
export { buildOpenAIVideoGenerationProvider as t };
