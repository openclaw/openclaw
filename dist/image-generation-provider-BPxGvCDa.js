import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-B_ZYSMaC.js";
import { a as postJsonRequest, u as resolveProviderHttpRequestConfig } from "./shared-BtBXLREr.js";
import { l as isProviderApiKeyConfigured } from "./provider-auth-D5QGE8z6.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { a as resolveApiKeyForProvider } from "./provider-auth-runtime-CNBotkGP.js";
import "./provider-http-BWEeBX6j.js";
import { n as generatedImageAssetFromBase64, r as generatedImageAssetFromDataUrl, u as toImageDataUrl } from "./image-generation-ZMBX1aqG.js";
import { t as OPENROUTER_BASE_URL } from "./provider-catalog-tLFRKrNL.js";
//#region extensions/openrouter/image-generation-provider.ts
const DEFAULT_MODEL = "google/gemini-3.1-flash-image-preview";
const DEFAULT_TIMEOUT_MS = 9e4;
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
function pushDataUrlImage(images, dataUrl) {
	const image = generatedImageAssetFromDataUrl({
		dataUrl,
		index: images.length
	});
	if (!image) return;
	images.push(image);
}
function extractImagesFromPart(images, part) {
	if (!part || typeof part !== "object") return;
	const value = part;
	if (value.type === "image_url") {
		const imageUrl = value.image_url ?? value.imageUrl;
		const url = typeof imageUrl?.url === "string" ? imageUrl.url : void 0;
		if (url) {
			pushDataUrlImage(images, url);
			return;
		}
	}
	const rawBase64 = typeof value.b64_json === "string" ? value.b64_json : void 0;
	if (rawBase64) {
		const image = generatedImageAssetFromBase64({
			base64: rawBase64,
			index: images.length
		});
		if (image) images.push(image);
		return;
	}
	const inlineData = value.inlineData ?? value.inline_data;
	const data = typeof inlineData?.data === "string" ? inlineData.data.trim() : void 0;
	if (!data) return;
	const mimeType = (typeof inlineData?.mimeType === "string" ? inlineData.mimeType : void 0) ?? (typeof inlineData?.mime_type === "string" ? inlineData.mime_type : void 0) ?? "image/png";
	const image = generatedImageAssetFromBase64({
		base64: data,
		index: images.length,
		mimeType
	});
	if (image) images.push(image);
}
function extractOpenRouterImagesFromResponse(body) {
	const images = [];
	for (const choice of body.choices ?? []) {
		const message = choice.message;
		if (!message) continue;
		for (const entry of message.images ?? []) {
			const url = entry.image_url?.url ?? entry.imageUrl?.url;
			if (typeof url === "string") pushDataUrlImage(images, url);
		}
		const content = message.content;
		if (typeof content === "string" && content.length > 0) for (const match of content.matchAll(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g)) pushDataUrlImage(images, match[0]);
		else if (Array.isArray(content)) for (const part of content) extractImagesFromPart(images, part);
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
				const images = extractOpenRouterImagesFromResponse(await response.json());
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
