import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest, p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
import { n as generatedImageAssetFromBase64, r as generatedImageAssetFromDataUrl, u as toImageDataUrl } from "./image-generation-Bda4L-l6.js";
import { t as OPENROUTER_BASE_URL } from "./provider-catalog-Dya4CIwt.js";
//#region extensions/openrouter/image-generation-provider.ts
const DEFAULT_MODEL = "google/gemini-3.1-flash-image-preview";
const DEFAULT_TIMEOUT_MS = 18e4;
const MAX_IMAGE_RESULTS = 4;
const SUPPORTED_MODELS = [
	DEFAULT_MODEL,
	"google/gemini-3-pro-image-preview",
	"openai/gpt-5.4-image-2"
];
const SUPPORTED_ASPECT_RATIOS = [
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
	"21:9"
];
const OPENROUTER_IMAGE_MALFORMED_RESPONSE = "OpenRouter image generation response malformed";
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function throwMalformedOpenRouterImageResponse(message) {
	if (message) throw new Error(message);
}
function pushDataUrlImage(images, dataUrl, malformedResponseError) {
	const image = generatedImageAssetFromDataUrl({
		dataUrl,
		index: images.length
	});
	if (!image) {
		throwMalformedOpenRouterImageResponse(malformedResponseError);
		return;
	}
	images.push(image);
}
function extractImagesFromPart(images, part, malformedResponseError) {
	if (!isRecord(part)) {
		throwMalformedOpenRouterImageResponse(malformedResponseError);
		return;
	}
	if (part.type === "text") return;
	if (part.type === "image_url") {
		const imageUrl = part.image_url ?? part.imageUrl;
		if (!isRecord(imageUrl)) {
			throwMalformedOpenRouterImageResponse(malformedResponseError);
			return;
		}
		const url = normalizeOptionalString(imageUrl.url);
		if (url) {
			pushDataUrlImage(images, url, malformedResponseError);
			return;
		}
		throwMalformedOpenRouterImageResponse(malformedResponseError);
		return;
	}
	const rawBase64 = normalizeOptionalString(part.b64_json);
	if (rawBase64) {
		const image = generatedImageAssetFromBase64({
			base64: rawBase64,
			index: images.length
		});
		if (image) {
			images.push(image);
			return;
		}
		throwMalformedOpenRouterImageResponse(malformedResponseError);
		return;
	}
	if ("b64_json" in part) {
		throwMalformedOpenRouterImageResponse(malformedResponseError);
		return;
	}
	const inlineData = part.inlineData ?? part.inline_data;
	if (inlineData === void 0 || inlineData === null) return;
	if (!isRecord(inlineData)) {
		throwMalformedOpenRouterImageResponse(malformedResponseError);
		return;
	}
	const data = normalizeOptionalString(inlineData.data);
	if (!data) {
		throwMalformedOpenRouterImageResponse(malformedResponseError);
		return;
	}
	const mimeType = normalizeOptionalString(inlineData.mimeType) ?? normalizeOptionalString(inlineData.mime_type) ?? "image/png";
	const image = generatedImageAssetFromBase64({
		base64: data,
		index: images.length,
		mimeType
	});
	if (image) {
		images.push(image);
		return;
	}
	throwMalformedOpenRouterImageResponse(malformedResponseError);
}
function extractOpenRouterImagesFromResponse(body, options = {}) {
	if (!isRecord(body)) {
		throwMalformedOpenRouterImageResponse(options.malformedResponseError);
		return [];
	}
	const choices = body.choices;
	if (choices === void 0 || choices === null) return [];
	if (!Array.isArray(choices)) {
		throwMalformedOpenRouterImageResponse(options.malformedResponseError);
		return [];
	}
	const images = [];
	for (const choice of choices) {
		if (!isRecord(choice)) {
			throwMalformedOpenRouterImageResponse(options.malformedResponseError);
			continue;
		}
		const message = choice.message;
		if (message === void 0 || message === null) continue;
		if (!isRecord(message)) {
			throwMalformedOpenRouterImageResponse(options.malformedResponseError);
			continue;
		}
		const messageImages = message.images;
		if (messageImages !== void 0 && messageImages !== null) {
			if (!Array.isArray(messageImages)) {
				throwMalformedOpenRouterImageResponse(options.malformedResponseError);
				continue;
			}
			for (const entry of messageImages) {
				if (!isRecord(entry)) {
					throwMalformedOpenRouterImageResponse(options.malformedResponseError);
					continue;
				}
				const imageUrl = entry.image_url ?? entry.imageUrl;
				if (!isRecord(imageUrl)) {
					throwMalformedOpenRouterImageResponse(options.malformedResponseError);
					continue;
				}
				const url = normalizeOptionalString(imageUrl.url);
				if (!url) {
					throwMalformedOpenRouterImageResponse(options.malformedResponseError);
					continue;
				}
				pushDataUrlImage(images, url, options.malformedResponseError);
			}
		}
		const content = message.content;
		if (typeof content === "string" && content.length > 0) for (const match of content.matchAll(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g)) pushDataUrlImage(images, match[0]);
		else if (Array.isArray(content)) for (const part of content) extractImagesFromPart(images, part, options.malformedResponseError);
		else if (content !== void 0 && content !== null) throwMalformedOpenRouterImageResponse(options.malformedResponseError);
	}
	return images;
}
function resolveImageCount(count) {
	if (typeof count !== "number" || !Number.isFinite(count)) return 1;
	return Math.max(1, Math.min(MAX_IMAGE_RESULTS, Math.trunc(count)));
}
function isGeminiImageModel(model) {
	return model.startsWith("google/gemini-");
}
function buildMessageContent(req) {
	const inputImages = req.inputImages ?? [];
	if (inputImages.length === 0) return req.prompt;
	return [{
		type: "text",
		text: req.prompt
	}, ...inputImages.map((image) => ({
		type: "image_url",
		image_url: { url: toImageDataUrl(image) }
	}))];
}
function buildImageConfig(req, model) {
	if (!isGeminiImageModel(model)) return {};
	const imageConfig = {};
	const aspectRatio = normalizeOptionalString(req.aspectRatio);
	if (aspectRatio) imageConfig.aspect_ratio = aspectRatio;
	const resolution = normalizeOptionalString(req.resolution);
	if (resolution) imageConfig.image_size = resolution;
	return imageConfig;
}
function buildOpenRouterImageGenerationProvider() {
	return {
		id: "openrouter",
		label: "OpenRouter",
		defaultModel: DEFAULT_MODEL,
		models: [...SUPPORTED_MODELS],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: "openrouter",
			agentDir
		}),
		capabilities: {
			generate: {
				maxCount: MAX_IMAGE_RESULTS,
				supportsSize: false,
				supportsAspectRatio: true,
				supportsResolution: true
			},
			edit: {
				enabled: true,
				maxCount: MAX_IMAGE_RESULTS,
				maxInputImages: 5,
				supportsSize: false,
				supportsAspectRatio: true,
				supportsResolution: true
			},
			geometry: {
				aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
				resolutions: [
					"1K",
					"2K",
					"4K"
				]
			}
		},
		async generateImage(req) {
			const auth = await resolveApiKeyForProvider({
				provider: "openrouter",
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("OpenRouter API key missing");
			const model = normalizeOptionalString(req.model) ?? DEFAULT_MODEL;
			const imageConfig = buildImageConfig(req, model);
			const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl: req.cfg?.models?.providers?.openrouter?.baseUrl,
				defaultBaseUrl: OPENROUTER_BASE_URL,
				allowPrivateNetwork: false,
				defaultHeaders: {
					Authorization: `Bearer ${auth.apiKey}`,
					"HTTP-Referer": "https://openclaw.ai",
					"X-OpenRouter-Title": "OpenClaw"
				},
				provider: "openrouter",
				capability: "image",
				transport: "http"
			});
			const { response, release } = await postJsonRequest({
				url: `${baseUrl}/chat/completions`,
				headers,
				body: {
					model,
					messages: [{
						role: "user",
						content: buildMessageContent(req)
					}],
					modalities: ["image", "text"],
					n: resolveImageCount(req.count),
					...Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}
				},
				timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				fetchFn: fetch,
				allowPrivateNetwork,
				ssrfPolicy: req.ssrfPolicy,
				dispatcherPolicy
			});
			try {
				await assertOkOrThrowHttpError(response, "OpenRouter image generation failed");
				const images = extractOpenRouterImagesFromResponse(await response.json(), { malformedResponseError: OPENROUTER_IMAGE_MALFORMED_RESPONSE });
				if (images.length === 0) throw new Error("OpenRouter image generation response missing image data");
				return {
					images,
					model
				};
			} finally {
				await release();
			}
		}
	};
}
//#endregion
export { extractOpenRouterImagesFromResponse as n, buildOpenRouterImageGenerationProvider as t };
