import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { l as sanitizeConfiguredModelProviderRequest } from "./provider-request-config-DxK6PUHR.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
import { n as generatedImageAssetFromBase64 } from "./image-generation-Bda4L-l6.js";
import { n as normalizeGoogleModelId } from "./model-id-CN9oH8ae.js";
import { t as resolveGoogleGenerativeAiHttpRequestConfig } from "./api-B6GzhKwj.js";
//#region extensions/google/image-generation-provider.ts
const DEFAULT_GOOGLE_IMAGE_MODEL = "gemini-3.1-flash-image-preview";
const DEFAULT_IMAGE_TIMEOUT_MS = 18e4;
const DEFAULT_OUTPUT_MIME = "image/png";
const GOOGLE_SUPPORTED_SIZES = [
	"1024x1024",
	"1024x1536",
	"1536x1024",
	"1024x1792",
	"1792x1024"
];
const GOOGLE_SUPPORTED_ASPECT_RATIOS = [
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
const GOOGLE_IMAGE_MALFORMED_RESPONSE = "Google image generation response malformed";
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function normalizeGoogleImageModel(model) {
	const trimmed = model?.trim();
	return normalizeGoogleModelId(trimmed || DEFAULT_GOOGLE_IMAGE_MODEL);
}
function mapSizeToImageConfig(size) {
	const trimmed = size?.trim();
	if (!trimmed) return;
	const normalized = normalizeLowercaseStringOrEmpty(trimmed);
	const aspectRatio = new Map([
		["1024x1024", "1:1"],
		["1024x1536", "2:3"],
		["1536x1024", "3:2"],
		["1024x1792", "9:16"],
		["1792x1024", "16:9"]
	]).get(normalized);
	const [widthRaw, heightRaw] = normalized.split("x");
	const longestEdge = Math.max(Number.parseInt(widthRaw ?? "", 10), Number.parseInt(heightRaw ?? "", 10));
	const imageSize = longestEdge >= 3072 ? "4K" : longestEdge >= 1536 ? "2K" : void 0;
	if (!aspectRatio && !imageSize) return;
	return {
		...aspectRatio ? { aspectRatio } : {},
		...imageSize ? { imageSize } : {}
	};
}
function googleResponseParts(payload) {
	if (!isRecord(payload)) throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
	const candidates = payload.candidates;
	if (candidates === void 0 || candidates === null) return [];
	if (!Array.isArray(candidates)) throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
	const parts = [];
	for (const candidate of candidates) {
		if (!isRecord(candidate)) throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
		const content = candidate.content;
		if (content === void 0 || content === null) continue;
		if (!isRecord(content)) throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
		const candidateParts = content.parts;
		if (candidateParts === void 0 || candidateParts === null) continue;
		if (!Array.isArray(candidateParts)) throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
		parts.push(...candidateParts);
	}
	return parts;
}
function googleInlineDataFromPart(part) {
	if (!isRecord(part)) throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
	const inline = part.inlineData ?? part.inline_data;
	if (inline === void 0 || inline === null) return;
	if (!isRecord(inline)) throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
	return inline;
}
function buildGoogleImageGenerationProvider() {
	return {
		id: "google",
		label: "Google",
		defaultModel: DEFAULT_GOOGLE_IMAGE_MODEL,
		models: [DEFAULT_GOOGLE_IMAGE_MODEL, "gemini-3-pro-image-preview"],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: "google",
			agentDir
		}),
		capabilities: {
			generate: {
				maxCount: 4,
				supportsSize: true,
				supportsAspectRatio: true,
				supportsResolution: true
			},
			edit: {
				enabled: true,
				maxCount: 4,
				maxInputImages: 5,
				supportsSize: true,
				supportsAspectRatio: true,
				supportsResolution: true
			},
			geometry: {
				sizes: [...GOOGLE_SUPPORTED_SIZES],
				aspectRatios: [...GOOGLE_SUPPORTED_ASPECT_RATIOS],
				resolutions: [
					"1K",
					"2K",
					"4K"
				]
			}
		},
		async generateImage(req) {
			const auth = await resolveApiKeyForProvider({
				provider: "google",
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("Google API key missing");
			const model = normalizeGoogleImageModel(req.model);
			const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveGoogleGenerativeAiHttpRequestConfig({
				apiKey: auth.apiKey,
				baseUrl: req.cfg?.models?.providers?.google?.baseUrl,
				request: sanitizeConfiguredModelProviderRequest(req.cfg?.models?.providers?.google?.request),
				capability: "image",
				transport: "http"
			});
			const imageConfig = mapSizeToImageConfig(req.size);
			const inputParts = (req.inputImages ?? []).map((image) => ({ inlineData: {
				mimeType: image.mimeType,
				data: image.buffer.toString("base64")
			} }));
			const resolvedImageConfig = {
				...imageConfig,
				...req.aspectRatio?.trim() ? { aspectRatio: req.aspectRatio.trim() } : {},
				...req.resolution ? { imageSize: req.resolution } : {}
			};
			const { response: res, release } = await postJsonRequest({
				url: `${baseUrl}/models/${model}:generateContent`,
				headers,
				body: {
					contents: [{
						role: "user",
						parts: [...inputParts, { text: req.prompt }]
					}],
					generationConfig: {
						responseModalities: ["TEXT", "IMAGE"],
						...Object.keys(resolvedImageConfig).length > 0 ? { imageConfig: resolvedImageConfig } : {}
					}
				},
				timeoutMs: req.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS,
				fetchFn: fetch,
				pinDns: false,
				allowPrivateNetwork,
				ssrfPolicy: req.ssrfPolicy,
				dispatcherPolicy
			});
			try {
				await assertOkOrThrowHttpError(res, "Google image generation failed");
				const payload = await res.json();
				let imageIndex = 0;
				const images = [];
				for (const part of googleResponseParts(payload)) {
					const inline = googleInlineDataFromPart(part);
					if (!inline) continue;
					const data = normalizeOptionalString(inline.data);
					if (!data) throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
					const image = generatedImageAssetFromBase64({
						base64: data,
						index: imageIndex,
						mimeType: normalizeOptionalString(inline.mimeType) ?? normalizeOptionalString(inline.mime_type) ?? DEFAULT_OUTPUT_MIME
					});
					if (!image) throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
					imageIndex += 1;
					images.push(image);
				}
				if (images.length === 0) throw new Error("Google image generation response missing image data");
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
export { buildGoogleImageGenerationProvider as t };
