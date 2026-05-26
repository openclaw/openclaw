import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as extensionForMime } from "./mime-DppuT-pZ.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { a as fetchProviderOperationResponse, c as postJsonRequest, h as waitProviderOperationPollInterval, i as fetchProviderDownloadResponse, m as resolveProviderOperationTimeoutMs, n as createProviderOperationDeadline, p as resolveProviderHttpRequestConfig, r as createProviderOperationTimeoutResolver } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import "./media-mime-j2Nhr7Df.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
import { t as BYTEPLUS_BASE_URL } from "./models-DL20u8f1.js";
//#region extensions/byteplus/video-generation-provider.ts
const DEFAULT_BYTEPLUS_VIDEO_MODEL = "seedance-1-0-lite-t2v-250428";
const DEFAULT_TIMEOUT_MS = 12e4;
const POLL_INTERVAL_MS = 5e3;
const MAX_POLL_ATTEMPTS = 120;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function readBytePlusJsonResponse(response, label) {
	let payload;
	try {
		payload = await response.json();
	} catch (cause) {
		throw new Error(`${label}: malformed JSON response`, { cause });
	}
	if (!isRecord(payload)) throw new Error(`${label}: malformed JSON response`);
	return payload;
}
function readBytePlusTaskStatus(payload) {
	const status = normalizeOptionalString(payload.status);
	switch (status) {
		case "running":
		case "failed":
		case "queued":
		case "succeeded":
		case "cancelled": return status;
		case void 0: throw new Error("BytePlus video status response missing task status");
		default: throw new Error(`BytePlus video status response returned unknown task status: ${status}`);
	}
}
function readBytePlusErrorMessage(error) {
	return isRecord(error) ? normalizeOptionalString(error.message) : void 0;
}
function readBytePlusVideoUrl(payload) {
	const content = payload.content;
	if (content !== void 0 && !isRecord(content)) throw new Error("BytePlus video generation completed with malformed content");
	const videoUrl = normalizeOptionalString(content?.video_url);
	if (!videoUrl) throw new Error("BytePlus video generation completed without a video URL");
	return videoUrl;
}
function resolveBytePlusVideoBaseUrl(req) {
	return normalizeOptionalString(req.cfg?.models?.providers?.byteplus?.baseUrl) ?? BYTEPLUS_BASE_URL;
}
function toDataUrl(buffer, mimeType) {
	return `data:${mimeType};base64,${buffer.toString("base64")}`;
}
function resolveBytePlusImageUrl(req) {
	const input = req.inputImages?.[0];
	if (!input) return;
	const inputUrl = normalizeOptionalString(input.url);
	if (inputUrl) return inputUrl;
	if (!input.buffer) throw new Error("BytePlus reference image is missing image data.");
	return toDataUrl(input.buffer, normalizeOptionalString(input.mimeType) ?? "image/png");
}
async function pollBytePlusTask(params) {
	const deadline = createProviderOperationDeadline({
		timeoutMs: params.timeoutMs,
		label: `BytePlus video generation task ${params.taskId}`
	});
	for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
		const payload = await readBytePlusJsonResponse(await fetchProviderOperationResponse({
			stage: "poll",
			url: `${params.baseUrl}/contents/generations/tasks/${params.taskId}`,
			init: {
				method: "GET",
				headers: params.headers
			},
			timeoutMs: createProviderOperationTimeoutResolver({
				deadline,
				defaultTimeoutMs: DEFAULT_TIMEOUT_MS
			}),
			fetchFn: params.fetchFn,
			provider: "byteplus",
			requestFailedMessage: "BytePlus video status request failed"
		}), "BytePlus video status request failed");
		switch (readBytePlusTaskStatus(payload)) {
			case "succeeded": return payload;
			case "failed":
			case "cancelled": throw new Error(readBytePlusErrorMessage(payload.error) || "BytePlus video generation failed");
			default:
				await waitProviderOperationPollInterval({
					deadline,
					pollIntervalMs: POLL_INTERVAL_MS
				});
				break;
		}
	}
	throw new Error(`BytePlus video generation task ${params.taskId} did not finish in time`);
}
async function downloadBytePlusVideo(params) {
	const response = await fetchProviderDownloadResponse({
		url: params.url,
		init: { method: "GET" },
		timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		fetchFn: params.fetchFn,
		provider: "byteplus",
		requestFailedMessage: "BytePlus generated video download failed"
	});
	const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
	const arrayBuffer = await response.arrayBuffer();
	return {
		buffer: Buffer.from(arrayBuffer),
		mimeType,
		fileName: `video-1.${extensionForMime(mimeType)?.slice(1) ?? "mp4"}`
	};
}
function buildBytePlusVideoGenerationProvider() {
	return {
		id: "byteplus",
		label: "BytePlus",
		defaultModel: DEFAULT_BYTEPLUS_VIDEO_MODEL,
		models: [
			DEFAULT_BYTEPLUS_VIDEO_MODEL,
			"seedance-1-0-lite-i2v-250428",
			"seedance-1-0-pro-250528",
			"seedance-1-5-pro-251215"
		],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: "byteplus",
			agentDir
		}),
		capabilities: {
			providerOptions: {
				seed: "number",
				draft: "boolean",
				camera_fixed: "boolean"
			},
			generate: {
				maxVideos: 1,
				maxDurationSeconds: 12,
				supportsAspectRatio: true,
				supportsResolution: true,
				supportsAudio: true,
				supportsWatermark: true
			},
			imageToVideo: {
				enabled: true,
				maxVideos: 1,
				maxInputImages: 1,
				maxDurationSeconds: 12,
				supportsAspectRatio: true,
				supportsResolution: true,
				supportsAudio: true,
				supportsWatermark: true
			},
			videoToVideo: { enabled: false }
		},
		async generateVideo(req) {
			if ((req.inputVideos?.length ?? 0) > 0) throw new Error("BytePlus video generation does not support video reference inputs.");
			const auth = await resolveApiKeyForProvider({
				provider: "byteplus",
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("BytePlus API key missing");
			const fetchFn = fetch;
			const deadline = createProviderOperationDeadline({
				timeoutMs: req.timeoutMs,
				label: "BytePlus video generation"
			});
			const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl: resolveBytePlusVideoBaseUrl(req),
				defaultBaseUrl: BYTEPLUS_BASE_URL,
				allowPrivateNetwork: false,
				defaultHeaders: {
					Authorization: `Bearer ${auth.apiKey}`,
					"Content-Type": "application/json"
				},
				provider: "byteplus",
				capability: "video",
				transport: "http"
			});
			const hasInputImages = (req.inputImages?.length ?? 0) > 0;
			const requestedModel = normalizeOptionalString(req.model) || DEFAULT_BYTEPLUS_VIDEO_MODEL;
			const resolvedModel = hasInputImages && requestedModel.includes("-t2v-") ? requestedModel.replace("-t2v-", "-i2v-") : requestedModel;
			const content = [{
				type: "text",
				text: req.prompt
			}];
			const imageUrl = resolveBytePlusImageUrl(req);
			if (imageUrl) content.push({
				type: "image_url",
				image_url: { url: imageUrl },
				role: "first_frame"
			});
			const body = {
				model: resolvedModel,
				content
			};
			const aspectRatio = normalizeOptionalString(req.aspectRatio);
			if (aspectRatio) body.ratio = aspectRatio;
			const resolution = normalizeOptionalString(req.resolution)?.toLowerCase();
			if (resolution) body.resolution = resolution;
			if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) body.duration = Math.max(1, Math.round(req.durationSeconds));
			if (typeof req.audio === "boolean") body.generate_audio = req.audio;
			if (typeof req.watermark === "boolean") body.watermark = req.watermark;
			const opts = req.providerOptions ?? {};
			const seed = typeof opts.seed === "number" ? opts.seed : void 0;
			const draft = opts.draft === true;
			const cameraFixed = typeof opts.camera_fixed === "boolean" ? opts.camera_fixed : void 0;
			if (seed != null) body.seed = seed;
			if (draft && !body.resolution) body.resolution = "480p";
			if (cameraFixed != null) body.camera_fixed = cameraFixed;
			const { response, release } = await postJsonRequest({
				url: `${baseUrl}/contents/generations/tasks`,
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
				await assertOkOrThrowHttpError(response, "BytePlus video generation failed");
				const taskId = normalizeOptionalString((await readBytePlusJsonResponse(response, "BytePlus video generation failed")).id);
				if (!taskId) throw new Error("BytePlus video generation response missing task id");
				const completed = await pollBytePlusTask({
					taskId,
					headers,
					timeoutMs: resolveProviderOperationTimeoutMs({
						deadline,
						defaultTimeoutMs: DEFAULT_TIMEOUT_MS
					}),
					baseUrl,
					fetchFn
				});
				const videoUrl = readBytePlusVideoUrl(completed);
				return {
					videos: [await downloadBytePlusVideo({
						url: videoUrl,
						timeoutMs: createProviderOperationTimeoutResolver({
							deadline,
							defaultTimeoutMs: DEFAULT_TIMEOUT_MS
						}),
						fetchFn
					})],
					model: normalizeOptionalString(completed.model) ?? resolvedModel,
					metadata: {
						taskId,
						status: normalizeOptionalString(completed.status),
						videoUrl,
						ratio: normalizeOptionalString(completed.ratio),
						resolution: normalizeOptionalString(completed.resolution),
						duration: typeof completed.duration === "number" ? completed.duration : void 0
					}
				};
			} finally {
				await release();
			}
		}
	};
}
//#endregion
export { buildBytePlusVideoGenerationProvider as t };
