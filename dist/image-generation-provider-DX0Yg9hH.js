import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as createOpenAiCompatibleImageGenerationProvider, u as toImageDataUrl } from "./image-generation-Bda4L-l6.js";
import { r as XAI_DEFAULT_IMAGE_MODEL, s as XAI_IMAGE_MODELS, t as XAI_BASE_URL } from "./model-definitions-hd9WbvLm.js";
//#region extensions/xai/image-generation-provider.ts
const DEFAULT_TIMEOUT_MS = 6e5;
const XAI_SUPPORTED_ASPECT_RATIOS = [
	"1:1",
	"16:9",
	"9:16",
	"4:3",
	"3:4",
	"2:3",
	"3:2"
];
function resolveImageForEdit(input) {
	if (!input) throw new Error("xAI image edit requires an input image.");
	const url = normalizeOptionalString(input.url);
	if (url) return url;
	if (!input.buffer) throw new Error("xAI image edit input is missing both URL and buffer data.");
	return toImageDataUrl({
		buffer: input.buffer,
		mimeType: input.mimeType
	});
}
function resolveXaiImageBaseUrl(req) {
	return normalizeOptionalString(req.cfg?.models?.providers?.xai?.baseUrl) ?? "https://api.x.ai/v1";
}
function buildBody(params) {
	const body = {
		model: params.model,
		prompt: params.req.prompt,
		n: Math.min(params.count, 4),
		response_format: "b64_json"
	};
	const aspect = normalizeOptionalString(params.req.aspectRatio);
	if (aspect && XAI_SUPPORTED_ASPECT_RATIOS.includes(aspect)) body.aspect_ratio = aspect;
	const resolution = normalizeOptionalLowercaseString(params.req.resolution);
	if (resolution) body.resolution = resolution;
	if (params.inputImages.length > 0) if (params.inputImages.length > 1) body.images = params.inputImages.map((input) => ({
		url: resolveImageForEdit(input),
		type: "image_url"
	}));
	else body.image = {
		url: resolveImageForEdit(params.inputImages[0]),
		type: "image_url"
	};
	return body;
}
function buildXaiImageGenerationProvider() {
	return createOpenAiCompatibleImageGenerationProvider({
		id: "xai",
		label: "xAI",
		defaultModel: XAI_DEFAULT_IMAGE_MODEL,
		models: [...XAI_IMAGE_MODELS],
		capabilities: {
			generate: {
				maxCount: 4,
				supportsAspectRatio: true,
				supportsResolution: true,
				supportsSize: false
			},
			edit: {
				enabled: true,
				maxCount: 4,
				maxInputImages: 5,
				supportsAspectRatio: true,
				supportsResolution: true,
				supportsSize: false
			},
			geometry: {
				aspectRatios: [...XAI_SUPPORTED_ASPECT_RATIOS],
				resolutions: ["1K", "2K"]
			}
		},
		defaultBaseUrl: XAI_BASE_URL,
		resolveBaseUrl: ({ req }) => resolveXaiImageBaseUrl(req),
		resolveAllowPrivateNetwork: () => false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		buildGenerateRequest: ({ req, inputImages, model, count }) => ({
			kind: "json",
			body: buildBody({
				req,
				inputImages,
				model,
				count
			})
		}),
		buildEditRequest: ({ req, inputImages, model, count }) => ({
			kind: "json",
			body: buildBody({
				req,
				inputImages,
				model,
				count
			})
		}),
		missingApiKeyError: "xAI API key missing",
		failureLabels: {
			generate: "xAI image generation failed",
			edit: "xAI image edit failed"
		}
	});
}
//#endregion
export { buildXaiImageGenerationProvider as t };
