import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { u as sanitizeConfiguredModelProviderRequest } from "./provider-request-config-Bca1NoEF.js";
import { c as isProviderApiKeyConfigured } from "./provider-auth-DRj3e0gZ.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-BbeichR4.js";
import { a as postJsonRequest } from "./shared-W-Rr8-V4.js";
import "./text-runtime-DCigKjjg.js";
import { a as resolveApiKeyForProvider } from "./provider-auth-runtime-TGEB-CFf.js";
import "./provider-http-D281sa7B.js";
import { n as normalizeGoogleModelId } from "./model-id-DmQzkbIH.js";
import { t as resolveGoogleGenerativeAiHttpRequestConfig } from "./api-Dpx_aD9z.js";
//#region extensions/google/image-generation-provider.ts
const DEFAULT_GOOGLE_IMAGE_MODEL = "gemini-3.1-flash-image-preview";
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
				timeoutMs: req.timeoutMs ?? 6e4,
				fetchFn: fetch,
				pinDns: false,
				allowPrivateNetwork,
				dispatcherPolicy
			});
			try {
				await assertOkOrThrowHttpError(res, "Google image generation failed");
				const payload = await res.json();
				let imageIndex = 0;
				const images = (payload.candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? []).map((part) => {
					const inline = part.inlineData ?? part.inline_data;
					const data = inline?.data?.trim();
					if (!data) return null;
					const mimeType = inline?.mimeType ?? inline?.mime_type ?? DEFAULT_OUTPUT_MIME;
					const extension = mimeType.includes("jpeg") ? "jpg" : mimeType.split("/")[1] ?? "png";
					imageIndex += 1;
					return {
						buffer: Buffer.from(data, "base64"),
						mimeType,
						fileName: `image-${imageIndex}.${extension}`
					};
				}).filter((entry) => entry !== null);
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
