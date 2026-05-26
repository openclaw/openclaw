import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { a as fetchProviderOperationResponse, c as postJsonRequest, h as waitProviderOperationPollInterval, i as fetchProviderDownloadResponse, m as resolveProviderOperationTimeoutMs, n as createProviderOperationDeadline, r as createProviderOperationTimeoutResolver } from "./shared-D8kCtbT2.js";
import "./provider-http-CYBE-CBM.js";
//#region src/video-generation/dashscope-compatible.ts
const DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL = "wan2.6-t2v";
const DASHSCOPE_WAN_VIDEO_MODELS = [
	DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
	"wan2.6-i2v",
	"wan2.6-r2v",
	"wan2.6-r2v-flash",
	"wan2.7-r2v"
];
const DASHSCOPE_WAN_VIDEO_CAPABILITIES = {
	generate: {
		maxVideos: 1,
		maxDurationSeconds: 10,
		supportsSize: true,
		supportsAspectRatio: true,
		supportsResolution: true,
		supportsAudio: true,
		supportsWatermark: true
	},
	imageToVideo: {
		enabled: true,
		maxVideos: 1,
		maxInputImages: 1,
		maxDurationSeconds: 10,
		supportsSize: true,
		supportsAspectRatio: true,
		supportsResolution: true,
		supportsAudio: true,
		supportsWatermark: true
	},
	videoToVideo: {
		enabled: true,
		maxVideos: 1,
		maxInputVideos: 4,
		maxDurationSeconds: 10,
		supportsSize: true,
		supportsAspectRatio: true,
		supportsResolution: true,
		supportsAudio: true,
		supportsWatermark: true
	}
};
const DEFAULT_VIDEO_GENERATION_DURATION_SECONDS = 5;
const DEFAULT_VIDEO_GENERATION_TIMEOUT_MS = 12e4;
const DEFAULT_VIDEO_RESOLUTION_TO_SIZE = {
	"480P": "832*480",
	"720P": "1280*720",
	"1080P": "1920*1080"
};
const DEFAULT_VIDEO_GENERATION_POLL_INTERVAL_MS = 2500;
const DEFAULT_VIDEO_GENERATION_MAX_POLL_ATTEMPTS = 120;
function buildDashscopeVideoGenerationInput(params) {
	if ([...params.req.inputImages ?? [], ...params.req.inputVideos ?? []].some((asset) => !asset.url?.trim() && asset.buffer)) throw new Error(`${params.providerLabel} video generation currently requires remote http(s) URLs for reference images/videos.`);
	const input = { prompt: params.req.prompt };
	const referenceUrls = resolveVideoGenerationReferenceUrls(params.req.inputImages, params.req.inputVideos);
	if (referenceUrls.length === 1 && (params.req.inputImages?.length ?? 0) === 1 && !params.req.inputVideos?.length) input.img_url = referenceUrls[0];
	else if (referenceUrls.length > 0) input.reference_urls = referenceUrls;
	return input;
}
function resolveVideoGenerationReferenceUrls(inputImages, inputVideos) {
	return [...inputImages ?? [], ...inputVideos ?? []].map((asset) => asset.url?.trim()).filter((value) => Boolean(value));
}
function buildDashscopeVideoGenerationParameters(req, resolutionToSize = DEFAULT_VIDEO_RESOLUTION_TO_SIZE) {
	const parameters = {};
	const size = req.size?.trim() || (req.resolution ? resolutionToSize[req.resolution] : void 0);
	if (size) parameters.size = size;
	if (req.aspectRatio?.trim()) parameters.aspect_ratio = req.aspectRatio.trim();
	if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) parameters.duration = Math.max(1, Math.round(req.durationSeconds));
	if (typeof req.audio === "boolean") parameters.enable_audio = req.audio;
	if (typeof req.watermark === "boolean") parameters.watermark = req.watermark;
	return Object.keys(parameters).length > 0 ? parameters : void 0;
}
function extractDashscopeVideoUrls(payload) {
	const urls = [...payload.output?.results?.map((entry) => entry.video_url).filter(Boolean) ?? [], payload.output?.video_url].filter((value) => typeof value === "string" && value.trim().length > 0);
	return [...new Set(urls)];
}
async function pollDashscopeVideoTaskUntilComplete(params) {
	const defaultTimeoutMs = params.defaultTimeoutMs ?? 12e4;
	const deadline = createProviderOperationDeadline({
		timeoutMs: params.timeoutMs,
		label: `${params.providerLabel} video generation task ${params.taskId}`
	});
	for (let attempt = 0; attempt < DEFAULT_VIDEO_GENERATION_MAX_POLL_ATTEMPTS; attempt += 1) {
		const payload = await (await fetchProviderOperationResponse({
			stage: "poll",
			url: `${params.baseUrl}/api/v1/tasks/${params.taskId}`,
			init: {
				method: "GET",
				headers: params.headers
			},
			timeoutMs: createProviderOperationTimeoutResolver({
				deadline,
				defaultTimeoutMs
			}),
			fetchFn: params.fetchFn,
			provider: params.providerLabel,
			requestFailedMessage: `${params.providerLabel} video-generation task poll failed`
		})).json();
		const status = payload.output?.task_status?.trim().toUpperCase();
		if (status === "SUCCEEDED") return payload;
		if (status === "FAILED" || status === "CANCELED") throw new Error(payload.output?.message?.trim() || payload.message?.trim() || `${params.providerLabel} video generation task ${params.taskId} ${normalizeLowercaseStringOrEmpty(status)}`);
		await waitProviderOperationPollInterval({
			deadline,
			pollIntervalMs: DEFAULT_VIDEO_GENERATION_POLL_INTERVAL_MS
		});
	}
	throw new Error(`${params.providerLabel} video generation task ${params.taskId} did not finish in time`);
}
async function runDashscopeVideoGenerationTask(params) {
	const defaultTimeoutMs = params.defaultTimeoutMs ?? 12e4;
	const deadline = createProviderOperationDeadline({
		timeoutMs: params.timeoutMs,
		label: `${params.providerLabel} video generation`
	});
	const { response, release } = await postJsonRequest({
		url: params.url,
		headers: params.headers,
		body: {
			model: params.model,
			input: buildDashscopeVideoGenerationInput({
				providerLabel: params.providerLabel,
				req: params.req
			}),
			parameters: buildDashscopeVideoGenerationParameters({
				...params.req,
				durationSeconds: params.req.durationSeconds ?? 5
			}, DEFAULT_VIDEO_RESOLUTION_TO_SIZE)
		},
		timeoutMs: resolveProviderOperationTimeoutMs({
			deadline,
			defaultTimeoutMs
		}),
		fetchFn: params.fetchFn,
		allowPrivateNetwork: params.allowPrivateNetwork,
		dispatcherPolicy: params.dispatcherPolicy
	});
	try {
		await assertOkOrThrowHttpError(response, `${params.providerLabel} video generation failed`);
		const submitted = await response.json();
		const taskId = submitted.output?.task_id?.trim();
		if (!taskId) throw new Error(`${params.providerLabel} video generation response missing task_id`);
		const completed = await pollDashscopeVideoTaskUntilComplete({
			providerLabel: params.providerLabel,
			taskId,
			headers: params.headers,
			timeoutMs: resolveProviderOperationTimeoutMs({
				deadline,
				defaultTimeoutMs
			}),
			fetchFn: params.fetchFn,
			baseUrl: params.baseUrl,
			defaultTimeoutMs
		});
		const urls = extractDashscopeVideoUrls(completed);
		if (urls.length === 0) throw new Error(`${params.providerLabel} video generation completed without output video URLs`);
		return {
			videos: await downloadDashscopeGeneratedVideos({
				providerLabel: params.providerLabel,
				urls,
				timeoutMs: createProviderOperationTimeoutResolver({
					deadline,
					defaultTimeoutMs
				}),
				fetchFn: params.fetchFn,
				defaultTimeoutMs
			}),
			model: params.model,
			metadata: {
				requestId: submitted.request_id,
				taskId,
				taskStatus: completed.output?.task_status
			}
		};
	} finally {
		await release();
	}
}
async function downloadDashscopeGeneratedVideos(params) {
	const videos = [];
	for (const [index, url] of params.urls.entries()) {
		const response = await fetchProviderDownloadResponse({
			url,
			init: { method: "GET" },
			timeoutMs: params.timeoutMs ?? params.defaultTimeoutMs ?? 12e4,
			fetchFn: params.fetchFn,
			provider: params.providerLabel,
			requestFailedMessage: `${params.providerLabel} generated video download failed`
		});
		const arrayBuffer = await response.arrayBuffer();
		videos.push({
			buffer: Buffer.from(arrayBuffer),
			mimeType: response.headers.get("content-type")?.trim() || "video/mp4",
			fileName: `video-${index + 1}.mp4`,
			metadata: { sourceUrl: url }
		});
	}
	return videos;
}
//#endregion
export { DEFAULT_VIDEO_GENERATION_TIMEOUT_MS as a, buildDashscopeVideoGenerationParameters as c, pollDashscopeVideoTaskUntilComplete as d, resolveVideoGenerationReferenceUrls as f, DEFAULT_VIDEO_GENERATION_DURATION_SECONDS as i, downloadDashscopeGeneratedVideos as l, DASHSCOPE_WAN_VIDEO_MODELS as n, DEFAULT_VIDEO_RESOLUTION_TO_SIZE as o, runDashscopeVideoGenerationTask as p, DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL as r, buildDashscopeVideoGenerationInput as s, DASHSCOPE_WAN_VIDEO_CAPABILITIES as t, extractDashscopeVideoUrls as u };
