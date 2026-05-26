import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as extensionForMime } from "./mime-DppuT-pZ.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import { u as ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./media-mime-j2Nhr7Df.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/fal/video-generation-provider.ts
const DEFAULT_FAL_BASE_URL = "https://fal.run";
const DEFAULT_FAL_QUEUE_BASE_URL = "https://queue.fal.run";
const DEFAULT_FAL_VIDEO_MODEL = "fal-ai/minimax/video-01-live";
const HEYGEN_VIDEO_AGENT_MODEL = "fal-ai/heygen/v2/video-agent";
const SEEDANCE_2_TEXT_IMAGE_VIDEO_MODELS = [
	"bytedance/seedance-2.0/fast/text-to-video",
	"bytedance/seedance-2.0/fast/image-to-video",
	"bytedance/seedance-2.0/text-to-video",
	"bytedance/seedance-2.0/image-to-video"
];
const SEEDANCE_2_REFERENCE_VIDEO_MODELS = ["bytedance/seedance-2.0/fast/reference-to-video", "bytedance/seedance-2.0/reference-to-video"];
const SEEDANCE_2_VIDEO_MODELS = [...SEEDANCE_2_TEXT_IMAGE_VIDEO_MODELS, ...SEEDANCE_2_REFERENCE_VIDEO_MODELS];
const SEEDANCE_2_DURATION_SECONDS = [
	4,
	5,
	6,
	7,
	8,
	9,
	10,
	11,
	12,
	13,
	14,
	15
];
const SEEDANCE_REFERENCE_MAX_IMAGES = 9;
const SEEDANCE_REFERENCE_MAX_VIDEOS = 3;
const SEEDANCE_REFERENCE_MAX_AUDIOS = 3;
const SEEDANCE_REFERENCE_MAX_FILES = 12;
const SEEDANCE_REFERENCE_MAX_IMAGES_BY_MODEL = Object.fromEntries(SEEDANCE_2_REFERENCE_VIDEO_MODELS.map((model) => [model, SEEDANCE_REFERENCE_MAX_IMAGES]));
const SEEDANCE_REFERENCE_MAX_VIDEOS_BY_MODEL = Object.fromEntries(SEEDANCE_2_REFERENCE_VIDEO_MODELS.map((model) => [model, SEEDANCE_REFERENCE_MAX_VIDEOS]));
const SEEDANCE_REFERENCE_MAX_AUDIOS_BY_MODEL = Object.fromEntries(SEEDANCE_2_REFERENCE_VIDEO_MODELS.map((model) => [model, SEEDANCE_REFERENCE_MAX_AUDIOS]));
const DEFAULT_HTTP_TIMEOUT_MS = 3e4;
const DEFAULT_OPERATION_TIMEOUT_MS = 12e5;
const POLL_INTERVAL_MS = 5e3;
const FAL_VIDEO_MALFORMED_RESPONSE = "fal video generation response malformed";
const FAL_VIDEO_PENDING_STATUSES = new Set([
	"IN_QUEUE",
	"IN_PROGRESS",
	"PROCESSING",
	"QUEUED",
	"STARTED"
]);
let falFetchGuard = fetchWithSsrFGuard;
function setFalVideoFetchGuardForTesting(impl) {
	falFetchGuard = impl ?? fetchWithSsrFGuard;
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function normalizeFalVideoUrl(value) {
	const normalized = normalizeOptionalString(value);
	if (!normalized && value !== void 0 && value !== null) throw new Error(FAL_VIDEO_MALFORMED_RESPONSE);
	return normalized;
}
function readFalVideoPayload(payload) {
	if (!isRecord(payload)) throw new Error(FAL_VIDEO_MALFORMED_RESPONSE);
	const video = payload.video;
	const videos = payload.videos;
	if (video !== void 0 && video !== null && !isRecord(video)) throw new Error(FAL_VIDEO_MALFORMED_RESPONSE);
	if (videos !== void 0 && videos !== null && !Array.isArray(videos)) throw new Error(FAL_VIDEO_MALFORMED_RESPONSE);
	return {
		video: isRecord(video) ? {
			url: normalizeFalVideoUrl(video.url),
			content_type: normalizeOptionalString(video.content_type)
		} : void 0,
		videos: Array.isArray(videos) ? videos.map((entry) => {
			if (!isRecord(entry)) throw new Error(FAL_VIDEO_MALFORMED_RESPONSE);
			return {
				url: normalizeFalVideoUrl(entry.url),
				content_type: normalizeOptionalString(entry.content_type)
			};
		}) : void 0,
		prompt: normalizeOptionalString(payload.prompt),
		seed: typeof payload.seed === "number" ? payload.seed : void 0
	};
}
function readFalQueueResponse(payload) {
	if (!isRecord(payload)) throw new Error(FAL_VIDEO_MALFORMED_RESPONSE);
	const error = payload.error;
	if (error !== void 0 && error !== null && !isRecord(error)) throw new Error(FAL_VIDEO_MALFORMED_RESPONSE);
	return {
		status: normalizeOptionalString(payload.status),
		request_id: normalizeOptionalString(payload.request_id),
		response_url: normalizeOptionalString(payload.response_url),
		status_url: normalizeOptionalString(payload.status_url),
		cancel_url: normalizeOptionalString(payload.cancel_url),
		detail: normalizeOptionalString(payload.detail),
		response: payload.response === void 0 ? void 0 : readFalVideoPayload(payload.response),
		prompt: normalizeOptionalString(payload.prompt),
		error: isRecord(error) ? { message: normalizeOptionalString(error.message) } : void 0
	};
}
function toDataUrl(buffer, mimeType) {
	return `data:${mimeType};base64,${buffer.toString("base64")}`;
}
function buildPolicy(allowPrivateNetwork) {
	return allowPrivateNetwork ? ssrfPolicyFromDangerouslyAllowPrivateNetwork(true) : void 0;
}
function extractFalVideoEntry(payload) {
	if (normalizeOptionalString(payload.video?.url)) return payload.video;
	return payload.videos?.find((entry) => normalizeOptionalString(entry.url));
}
async function downloadFalVideo(url, policy) {
	const { response, release } = await falFetchGuard({
		url,
		timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
		policy,
		auditContext: "fal-video-download"
	});
	try {
		await assertOkOrThrowHttpError(response, "fal generated video download failed");
		const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
		const arrayBuffer = await response.arrayBuffer();
		return {
			url,
			buffer: Buffer.from(arrayBuffer),
			mimeType,
			fileName: `video-1.${extensionForMime(mimeType)?.slice(1) ?? "mp4"}`
		};
	} finally {
		await release();
	}
}
function resolveFalQueueBaseUrl(baseUrl) {
	try {
		const url = new URL(baseUrl);
		if (url.hostname === "fal.run") {
			url.hostname = "queue.fal.run";
			return url.toString().replace(/\/$/, "");
		}
		return baseUrl.replace(/\/$/, "");
	} catch {
		return DEFAULT_FAL_QUEUE_BASE_URL;
	}
}
function isFalMiniMaxLiveModel(model) {
	return normalizeLowercaseStringOrEmpty(model) === DEFAULT_FAL_VIDEO_MODEL;
}
function isFalSeedance2Model(model) {
	return SEEDANCE_2_VIDEO_MODELS.includes(model);
}
function isFalSeedance2ReferenceModel(model) {
	return SEEDANCE_2_REFERENCE_VIDEO_MODELS.includes(model);
}
function isFalHeyGenVideoAgentModel(model) {
	return normalizeLowercaseStringOrEmpty(model) === HEYGEN_VIDEO_AGENT_MODEL;
}
function resolveFalResolution(resolution, model) {
	if (!resolution) return;
	if (isFalSeedance2Model(model)) return resolution.toLowerCase();
	return resolution;
}
function resolveFalDuration(durationSeconds, model) {
	if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) return;
	const duration = Math.max(1, Math.round(durationSeconds));
	if (isFalSeedance2Model(model)) return String(duration);
	return duration;
}
function resolveFalReferenceUrl(asset, defaultMimeType, label) {
	const assetUrl = normalizeOptionalString(asset?.url);
	if (assetUrl) return assetUrl;
	if (!asset?.buffer) throw new Error(`fal ${label} is missing media data.`);
	return toDataUrl(asset.buffer, normalizeOptionalString(asset.mimeType) ?? defaultMimeType);
}
function resolveFalReferenceUrls(assets, defaultMimeType, label) {
	return (assets ?? []).map((asset) => resolveFalReferenceUrl(asset, defaultMimeType, label));
}
function applyFalSeedanceControls(params) {
	const aspectRatio = normalizeOptionalString(params.req.aspectRatio);
	if (aspectRatio) params.body.aspect_ratio = aspectRatio;
	const size = normalizeOptionalString(params.req.size);
	if (size) params.body.size = size;
	const resolution = resolveFalResolution(params.req.resolution, params.model);
	if (resolution) params.body.resolution = resolution;
	const duration = resolveFalDuration(params.req.durationSeconds, params.model);
	if (duration) params.body.duration = duration;
	if (isFalSeedance2Model(params.model) && typeof params.req.audio === "boolean") params.body.generate_audio = params.req.audio;
}
function buildFalVideoRequestBody(params) {
	const requestBody = { prompt: params.req.prompt };
	if (isFalSeedance2ReferenceModel(params.model)) {
		const imageUrls = resolveFalReferenceUrls(params.req.inputImages, "image/png", "reference image");
		const videoUrls = resolveFalReferenceUrls(params.req.inputVideos, "video/mp4", "reference video");
		const audioUrls = resolveFalReferenceUrls(params.req.inputAudios, "audio/mpeg", "reference audio");
		if (imageUrls.length > 0) requestBody.image_urls = imageUrls;
		if (videoUrls.length > 0) requestBody.video_urls = videoUrls;
		if (audioUrls.length > 0) requestBody.audio_urls = audioUrls;
		applyFalSeedanceControls({
			req: params.req,
			model: params.model,
			body: requestBody
		});
		return requestBody;
	}
	const input = params.req.inputImages?.[0];
	if (input) requestBody.image_url = normalizeOptionalString(input.url) ? normalizeOptionalString(input.url) : input.buffer ? toDataUrl(input.buffer, normalizeOptionalString(input.mimeType) ?? "image/png") : void 0;
	if (isFalMiniMaxLiveModel(params.model) || isFalHeyGenVideoAgentModel(params.model)) return requestBody;
	applyFalSeedanceControls({
		req: params.req,
		model: params.model,
		body: requestBody
	});
	return requestBody;
}
function validateFalVideoReferenceInputs(params) {
	const imageCount = params.req.inputImages?.length ?? 0;
	const videoCount = params.req.inputVideos?.length ?? 0;
	const audioCount = params.req.inputAudios?.length ?? 0;
	if (isFalSeedance2ReferenceModel(params.model)) {
		if (imageCount > SEEDANCE_REFERENCE_MAX_IMAGES) throw new Error(`fal Seedance reference-to-video supports at most ${SEEDANCE_REFERENCE_MAX_IMAGES} reference images.`);
		if (videoCount > SEEDANCE_REFERENCE_MAX_VIDEOS) throw new Error(`fal Seedance reference-to-video supports at most ${SEEDANCE_REFERENCE_MAX_VIDEOS} reference videos.`);
		if (audioCount > SEEDANCE_REFERENCE_MAX_AUDIOS) throw new Error(`fal Seedance reference-to-video supports at most ${SEEDANCE_REFERENCE_MAX_AUDIOS} reference audios.`);
		if (imageCount + videoCount + audioCount > SEEDANCE_REFERENCE_MAX_FILES) throw new Error(`fal Seedance reference-to-video supports at most ${SEEDANCE_REFERENCE_MAX_FILES} total reference files.`);
		if (audioCount > 0 && imageCount === 0 && videoCount === 0) throw new Error("fal Seedance reference-to-video requires at least one image or video reference when audio references are provided.");
		return;
	}
	if (videoCount > 0) throw new Error("fal video generation does not support video reference inputs.");
	if (audioCount > 0) throw new Error("fal video generation does not support audio reference inputs.");
	if (imageCount > 1) throw new Error("fal video generation supports at most one image reference.");
}
async function fetchFalJson(params) {
	const { response, release } = await falFetchGuard({
		url: params.url,
		init: params.init,
		timeoutMs: params.timeoutMs,
		policy: params.policy,
		dispatcherPolicy: params.dispatcherPolicy,
		auditContext: params.auditContext
	});
	try {
		await assertOkOrThrowHttpError(response, params.errorContext);
		try {
			return await response.json();
		} catch {
			throw new Error(FAL_VIDEO_MALFORMED_RESPONSE);
		}
	} finally {
		await release();
	}
}
async function waitForFalQueueResult(params) {
	const deadline = Date.now() + params.timeoutMs;
	let lastStatus = "unknown";
	while (Date.now() < deadline) {
		const payload = readFalQueueResponse(await fetchFalJson({
			url: params.statusUrl,
			init: {
				method: "GET",
				headers: params.headers
			},
			timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
			policy: params.policy,
			dispatcherPolicy: params.dispatcherPolicy,
			auditContext: "fal-video-status",
			errorContext: "fal video status request failed"
		}));
		const status = normalizeOptionalString(payload.status)?.toUpperCase();
		if (!status) throw new Error(FAL_VIDEO_MALFORMED_RESPONSE);
		lastStatus = status;
		if (status === "COMPLETED") return readFalQueueResponse(await fetchFalJson({
			url: params.responseUrl,
			init: {
				method: "GET",
				headers: params.headers
			},
			timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
			policy: params.policy,
			dispatcherPolicy: params.dispatcherPolicy,
			auditContext: "fal-video-result",
			errorContext: "fal video result request failed"
		}));
		if (status === "FAILED" || status === "CANCELLED") throw new Error(normalizeOptionalString(payload.detail) || normalizeOptionalString(payload.error?.message) || `fal video generation ${normalizeLowercaseStringOrEmpty(status)}`);
		if (!FAL_VIDEO_PENDING_STATUSES.has(status)) throw new Error(FAL_VIDEO_MALFORMED_RESPONSE);
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	throw new Error(`fal video generation did not finish in time (last status: ${lastStatus})`);
}
function extractFalVideoPayload(payload) {
	if (payload.response) return payload.response;
	return readFalVideoPayload(payload);
}
function buildFalVideoGenerationProvider() {
	return {
		id: "fal",
		label: "fal",
		defaultModel: DEFAULT_FAL_VIDEO_MODEL,
		models: [
			DEFAULT_FAL_VIDEO_MODEL,
			HEYGEN_VIDEO_AGENT_MODEL,
			...SEEDANCE_2_VIDEO_MODELS,
			"fal-ai/kling-video/v2.1/master/text-to-video",
			"fal-ai/wan/v2.2-a14b/text-to-video",
			"fal-ai/wan/v2.2-a14b/image-to-video"
		],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: "fal",
			agentDir
		}),
		capabilities: {
			generate: {
				maxVideos: 1,
				supportedDurationSecondsByModel: Object.fromEntries(SEEDANCE_2_VIDEO_MODELS.map((model) => [model, SEEDANCE_2_DURATION_SECONDS])),
				supportsAspectRatio: true,
				supportsResolution: true,
				supportsSize: true,
				supportsAudio: true
			},
			imageToVideo: {
				enabled: true,
				maxVideos: 1,
				maxInputImages: 1,
				maxInputImagesByModel: SEEDANCE_REFERENCE_MAX_IMAGES_BY_MODEL,
				maxInputAudiosByModel: SEEDANCE_REFERENCE_MAX_AUDIOS_BY_MODEL,
				supportedDurationSecondsByModel: Object.fromEntries(SEEDANCE_2_VIDEO_MODELS.map((model) => [model, SEEDANCE_2_DURATION_SECONDS])),
				supportsAspectRatio: true,
				supportsResolution: true,
				supportsSize: true,
				supportsAudio: true
			},
			videoToVideo: {
				enabled: true,
				maxVideos: 1,
				maxInputImages: 0,
				maxInputImagesByModel: SEEDANCE_REFERENCE_MAX_IMAGES_BY_MODEL,
				maxInputVideos: 0,
				maxInputVideosByModel: SEEDANCE_REFERENCE_MAX_VIDEOS_BY_MODEL,
				maxInputAudiosByModel: SEEDANCE_REFERENCE_MAX_AUDIOS_BY_MODEL,
				supportedDurationSecondsByModel: Object.fromEntries(SEEDANCE_2_REFERENCE_VIDEO_MODELS.map((model) => [model, SEEDANCE_2_DURATION_SECONDS])),
				supportsAspectRatio: true,
				supportsResolution: true,
				supportsSize: true,
				supportsAudio: true
			}
		},
		async generateVideo(req) {
			const model = normalizeOptionalString(req.model) || DEFAULT_FAL_VIDEO_MODEL;
			validateFalVideoReferenceInputs({
				req,
				model
			});
			const auth = await resolveApiKeyForProvider({
				provider: "fal",
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("fal API key missing");
			const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl: normalizeOptionalString(req.cfg?.models?.providers?.fal?.baseUrl),
				defaultBaseUrl: DEFAULT_FAL_BASE_URL,
				allowPrivateNetwork: false,
				defaultHeaders: {
					Authorization: `Key ${auth.apiKey}`,
					"Content-Type": "application/json"
				},
				provider: "fal",
				capability: "video",
				transport: "http"
			});
			const requestBody = buildFalVideoRequestBody({
				req,
				model
			});
			const policy = buildPolicy(allowPrivateNetwork);
			const submitted = readFalQueueResponse(await fetchFalJson({
				url: `${resolveFalQueueBaseUrl(baseUrl)}/${model}`,
				init: {
					method: "POST",
					headers,
					body: JSON.stringify(requestBody)
				},
				timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
				policy,
				dispatcherPolicy,
				auditContext: "fal-video-submit",
				errorContext: "fal video generation failed"
			}));
			const statusUrl = normalizeOptionalString(submitted.status_url);
			const responseUrl = normalizeOptionalString(submitted.response_url);
			if (!statusUrl || !responseUrl) throw new Error("fal video generation response missing queue URLs");
			const videoPayload = extractFalVideoPayload(await waitForFalQueueResult({
				statusUrl,
				responseUrl,
				headers,
				timeoutMs: req.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
				policy,
				dispatcherPolicy
			}));
			const url = normalizeOptionalString(extractFalVideoEntry(videoPayload)?.url);
			if (!url) throw new Error("fal video generation response missing output URL");
			return {
				videos: [await downloadFalVideo(url, policy)],
				model,
				metadata: {
					...normalizeOptionalString(submitted.request_id) ? { requestId: normalizeOptionalString(submitted.request_id) } : {},
					...videoPayload.prompt ? { prompt: videoPayload.prompt } : {},
					...typeof videoPayload.seed === "number" ? { seed: videoPayload.seed } : {}
				}
			};
		}
	};
}
//#endregion
export { setFalVideoFetchGuardForTesting as n, buildFalVideoGenerationProvider as t };
