import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as extensionForMime } from "./mime-DppuT-pZ.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { a as fetchProviderOperationResponse, c as postJsonRequest, h as waitProviderOperationPollInterval, i as fetchProviderDownloadResponse, m as resolveProviderOperationTimeoutMs, n as createProviderOperationDeadline, p as resolveProviderHttpRequestConfig, r as createProviderOperationTimeoutResolver } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import "./media-mime-j2Nhr7Df.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/runway/video-generation-provider.ts
const DEFAULT_RUNWAY_BASE_URL = "https://api.dev.runwayml.com";
const DEFAULT_RUNWAY_MODEL = "gen4.5";
const RUNWAY_API_VERSION = "2024-11-06";
const DEFAULT_TIMEOUT_MS = 12e4;
const POLL_INTERVAL_MS = 5e3;
const MAX_POLL_ATTEMPTS = 120;
const MAX_DURATION_SECONDS = 10;
const TEXT_ONLY_MODELS = new Set([
	"gen4.5",
	"veo3.1",
	"veo3.1_fast",
	"veo3"
]);
const IMAGE_MODELS = new Set([
	"gen4.5",
	"gen4_turbo",
	"gen3a_turbo",
	"veo3.1",
	"veo3.1_fast",
	"veo3"
]);
const VIDEO_MODELS = new Set(["gen4_aleph"]);
const RUNWAY_TEXT_ASPECT_RATIOS = ["16:9", "9:16"];
const RUNWAY_EDIT_ASPECT_RATIOS = [
	"1:1",
	"16:9",
	"9:16",
	"3:4",
	"4:3",
	"21:9"
];
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function readRunwayJsonResponse(response, label) {
	let payload;
	try {
		payload = await response.json();
	} catch (cause) {
		throw new Error(`${label}: malformed JSON response`, { cause });
	}
	if (!isRecord(payload)) throw new Error(`${label}: malformed JSON response`);
	return payload;
}
function readRunwayTaskStatus(payload) {
	const status = normalizeOptionalString(payload.status);
	switch (status) {
		case "PENDING":
		case "RUNNING":
		case "THROTTLED":
		case "SUCCEEDED":
		case "FAILED":
		case "CANCELLED": return status;
		case void 0: throw new Error("Runway video status response missing task status");
		default: throw new Error(`Runway video status response returned unknown task status: ${status}`);
	}
}
function readRunwayFailureMessage(failure) {
	if (typeof failure === "string") return normalizeOptionalString(failure);
	if (isRecord(failure)) return normalizeOptionalString(failure.message);
}
function readRunwayOutputUrls(payload) {
	if (!Array.isArray(payload.output)) throw new Error("Runway video generation completed with malformed output URLs");
	const outputUrls = payload.output.map((value) => normalizeOptionalString(value)).filter((value) => Boolean(value));
	if (!outputUrls.length) throw new Error("Runway video generation completed without output URLs");
	return outputUrls;
}
function resolveRunwayBaseUrl(req) {
	return normalizeOptionalString(req.cfg?.models?.providers?.runway?.baseUrl) ?? DEFAULT_RUNWAY_BASE_URL;
}
function toDataUrl(buffer, mimeType) {
	return `data:${mimeType};base64,${buffer.toString("base64")}`;
}
function resolveSourceUri(asset, fallbackMimeType) {
	if (!asset) return;
	const url = normalizeOptionalString(asset.url);
	if (url) return url;
	if (!asset.buffer) return;
	return toDataUrl(asset.buffer, normalizeOptionalString(asset.mimeType) ?? fallbackMimeType);
}
function resolveDurationSeconds(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(2, Math.min(MAX_DURATION_SECONDS, Math.round(value)));
}
function resolveRunwayRatio(req) {
	const hasImageInput = (req.inputImages?.length ?? 0) > 0;
	const requested = normalizeOptionalString(req.size) || (() => {
		switch (normalizeOptionalString(req.aspectRatio)) {
			case "9:16": return "720:1280";
			case "16:9": return "1280:720";
			case "1:1": return "960:960";
			case "3:4": return "832:1104";
			case "4:3": return "1104:832";
			case "21:9": return "1584:672";
			default: return;
		}
	})();
	if (requested) {
		if (!hasImageInput && requested !== "1280:720" && requested !== "720:1280") throw new Error("Runway text-to-video currently supports only 16:9 or 9:16 output ratios.");
		return requested;
	}
	return "1280:720";
}
function resolveEndpoint(req) {
	const imageCount = req.inputImages?.length ?? 0;
	const videoCount = req.inputVideos?.length ?? 0;
	if (imageCount > 0 && videoCount > 0) throw new Error("Runway video generation does not support image and video inputs together.");
	if (imageCount > 1 || videoCount > 1) throw new Error("Runway video generation supports at most one input image or one input video.");
	if (videoCount > 0) return "/v1/video_to_video";
	if (imageCount > 0) return "/v1/image_to_video";
	return "/v1/text_to_video";
}
function buildCreateBody(req) {
	const endpoint = resolveEndpoint(req);
	const duration = resolveDurationSeconds(req.durationSeconds);
	const ratio = resolveRunwayRatio(req);
	const model = normalizeOptionalString(req.model) ?? DEFAULT_RUNWAY_MODEL;
	if (endpoint === "/v1/text_to_video") {
		if (!TEXT_ONLY_MODELS.has(model)) throw new Error(`Runway text-to-video does not support model ${model}. Use one of: ${[...TEXT_ONLY_MODELS].join(", ")}.`);
		return {
			model,
			promptText: req.prompt,
			ratio,
			duration
		};
	}
	if (endpoint === "/v1/image_to_video") {
		if (!IMAGE_MODELS.has(model)) throw new Error(`Runway image-to-video does not support model ${model}. Use one of: ${[...IMAGE_MODELS].join(", ")}.`);
		const promptImage = resolveSourceUri(req.inputImages?.[0], "image/png");
		if (!promptImage) throw new Error("Runway image-to-video input is missing image data.");
		return {
			model,
			promptText: req.prompt,
			promptImage,
			ratio,
			duration
		};
	}
	if (!VIDEO_MODELS.has(model)) throw new Error("Runway video-to-video currently requires model gen4_aleph.");
	const videoUri = resolveSourceUri(req.inputVideos?.[0], "video/mp4");
	if (!videoUri) throw new Error("Runway video-to-video input is missing video data.");
	return {
		model,
		promptText: req.prompt,
		videoUri,
		ratio
	};
}
async function pollRunwayTask(params) {
	const deadline = createProviderOperationDeadline({
		timeoutMs: params.timeoutMs,
		label: `Runway video generation task ${params.taskId}`
	});
	for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
		const payload = await readRunwayJsonResponse(await fetchProviderOperationResponse({
			stage: "poll",
			url: `${params.baseUrl}/v1/tasks/${params.taskId}`,
			init: {
				method: "GET",
				headers: params.headers
			},
			timeoutMs: createProviderOperationTimeoutResolver({
				deadline,
				defaultTimeoutMs: DEFAULT_TIMEOUT_MS
			}),
			fetchFn: params.fetchFn,
			provider: "runway",
			requestFailedMessage: "Runway video status request failed"
		}), "Runway video status request failed");
		const status = readRunwayTaskStatus(payload);
		switch (status) {
			case "SUCCEEDED": return payload;
			case "FAILED":
			case "CANCELLED": throw new Error(readRunwayFailureMessage(payload.failure) || `Runway video generation ${normalizeLowercaseStringOrEmpty(status)}`);
			default:
				await waitProviderOperationPollInterval({
					deadline,
					pollIntervalMs: POLL_INTERVAL_MS
				});
				break;
		}
	}
	throw new Error(`Runway video generation task ${params.taskId} did not finish in time`);
}
async function downloadRunwayVideos(params) {
	const videos = [];
	for (const [index, url] of params.urls.entries()) {
		const response = await fetchProviderDownloadResponse({
			url,
			init: { method: "GET" },
			timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			fetchFn: params.fetchFn,
			provider: "runway",
			requestFailedMessage: "Runway generated video download failed"
		});
		const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
		const arrayBuffer = await response.arrayBuffer();
		videos.push({
			buffer: Buffer.from(arrayBuffer),
			mimeType,
			fileName: `video-${index + 1}.${extensionForMime(mimeType)?.slice(1) ?? "mp4"}`,
			metadata: { sourceUrl: url }
		});
	}
	return videos;
}
function buildRunwayVideoGenerationProvider() {
	return {
		id: "runway",
		label: "Runway",
		defaultModel: DEFAULT_RUNWAY_MODEL,
		models: [
			"gen4.5",
			"gen4_turbo",
			"gen4_aleph",
			"gen3a_turbo",
			"veo3.1",
			"veo3.1_fast",
			"veo3"
		],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: "runway",
			agentDir
		}),
		capabilities: {
			generate: {
				maxVideos: 1,
				maxDurationSeconds: MAX_DURATION_SECONDS,
				aspectRatios: RUNWAY_TEXT_ASPECT_RATIOS,
				supportsAspectRatio: true
			},
			imageToVideo: {
				enabled: true,
				maxVideos: 1,
				maxInputImages: 1,
				maxDurationSeconds: MAX_DURATION_SECONDS,
				aspectRatios: RUNWAY_EDIT_ASPECT_RATIOS,
				supportsAspectRatio: true
			},
			videoToVideo: {
				enabled: true,
				maxVideos: 1,
				maxInputVideos: 1,
				aspectRatios: RUNWAY_EDIT_ASPECT_RATIOS,
				supportsAspectRatio: true
			}
		},
		async generateVideo(req) {
			const auth = await resolveApiKeyForProvider({
				provider: "runway",
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("Runway API key missing");
			const fetchFn = fetch;
			const deadline = createProviderOperationDeadline({
				timeoutMs: req.timeoutMs,
				label: "Runway video generation"
			});
			const requestBody = buildCreateBody(req);
			const endpoint = resolveEndpoint(req);
			const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl: resolveRunwayBaseUrl(req),
				defaultBaseUrl: DEFAULT_RUNWAY_BASE_URL,
				defaultHeaders: {
					Authorization: `Bearer ${auth.apiKey}`,
					"Content-Type": "application/json",
					"X-Runway-Version": RUNWAY_API_VERSION
				},
				provider: "runway",
				capability: "video",
				transport: "http"
			});
			const { response, release } = await postJsonRequest({
				url: `${baseUrl}${endpoint}`,
				headers,
				body: requestBody,
				timeoutMs: resolveProviderOperationTimeoutMs({
					deadline,
					defaultTimeoutMs: DEFAULT_TIMEOUT_MS
				}),
				fetchFn,
				allowPrivateNetwork,
				dispatcherPolicy
			});
			try {
				await assertOkOrThrowHttpError(response, "Runway video generation failed");
				const taskId = normalizeOptionalString((await readRunwayJsonResponse(response, "Runway video generation failed")).id);
				if (!taskId) throw new Error("Runway video generation response missing task id");
				const completed = await pollRunwayTask({
					taskId,
					headers,
					timeoutMs: resolveProviderOperationTimeoutMs({
						deadline,
						defaultTimeoutMs: DEFAULT_TIMEOUT_MS
					}),
					baseUrl,
					fetchFn
				});
				const outputUrls = readRunwayOutputUrls(completed);
				return {
					videos: await downloadRunwayVideos({
						urls: outputUrls,
						timeoutMs: createProviderOperationTimeoutResolver({
							deadline,
							defaultTimeoutMs: DEFAULT_TIMEOUT_MS
						}),
						fetchFn
					}),
					model: normalizeOptionalString(req.model) ?? DEFAULT_RUNWAY_MODEL,
					metadata: {
						taskId,
						status: normalizeOptionalString(completed.status),
						endpoint,
						outputUrls
					}
				};
			} finally {
				await release();
			}
		}
	};
}
//#endregion
export { buildRunwayVideoGenerationProvider as t };
