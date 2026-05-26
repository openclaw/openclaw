import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as createOpenAiCompatibleImageGenerationProvider, u as toImageDataUrl } from "./image-generation-Bda4L-l6.js";
import { t as LITELLM_BASE_URL } from "./onboard-K9C9_InP.js";
//#region extensions/litellm/image-generation-provider.ts
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_LITELLM_IMAGE_MODEL = "gpt-image-2";
const LITELLM_SUPPORTED_SIZES = [
	"256x256",
	"512x512",
	"1024x1024",
	"1024x1536",
	"1024x1792",
	"1536x1024",
	"1792x1024",
	"2048x2048",
	"2048x1152",
	"3840x2160",
	"2160x3840"
];
const LITELLM_MAX_INPUT_IMAGES = 5;
function resolveLitellmProviderConfig(cfg) {
	return cfg?.models?.providers?.litellm;
}
function resolveConfiguredLitellmBaseUrl(cfg) {
	return normalizeOptionalString(resolveLitellmProviderConfig(cfg)?.baseUrl) ?? "http://localhost:4000";
}
function imageToDataUrl(image) {
	return toImageDataUrl({
		buffer: image.buffer,
		mimeType: image.mimeType
	});
}
function isAutoAllowedLitellmHostname(hostname) {
	if (!hostname) return false;
	const lowered = (hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname).toLowerCase();
	if (lowered === "localhost" || lowered === "host.docker.internal" || lowered.endsWith(".localhost")) return true;
	if (lowered === "127.0.0.1" || lowered.startsWith("127.")) return true;
	if (lowered === "::1" || lowered === "0:0:0:0:0:0:0:1") return true;
	return false;
}
function shouldAutoAllowPrivateLitellmEndpoint(baseUrl) {
	try {
		const parsed = new URL(baseUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		return isAutoAllowedLitellmHostname(parsed.hostname);
	} catch {
		return false;
	}
}
function buildLitellmImageGenerationProvider() {
	return createOpenAiCompatibleImageGenerationProvider({
		id: "litellm",
		label: "LiteLLM",
		defaultModel: DEFAULT_LITELLM_IMAGE_MODEL,
		models: [DEFAULT_LITELLM_IMAGE_MODEL],
		capabilities: {
			generate: {
				maxCount: 4,
				supportsSize: true,
				supportsAspectRatio: false,
				supportsResolution: false
			},
			edit: {
				enabled: true,
				maxCount: 4,
				maxInputImages: LITELLM_MAX_INPUT_IMAGES,
				supportsSize: true,
				supportsAspectRatio: false,
				supportsResolution: false
			},
			geometry: { sizes: [...LITELLM_SUPPORTED_SIZES] }
		},
		defaultBaseUrl: LITELLM_BASE_URL,
		resolveBaseUrl: ({ req }) => resolveConfiguredLitellmBaseUrl(req.cfg),
		resolveAllowPrivateNetwork: ({ baseUrl }) => shouldAutoAllowPrivateLitellmEndpoint(baseUrl) ? true : void 0,
		useConfiguredRequest: true,
		buildGenerateRequest: ({ req, model, count }) => ({
			kind: "json",
			body: {
				model,
				prompt: req.prompt,
				n: count,
				size: req.size ?? DEFAULT_SIZE
			}
		}),
		buildEditRequest: ({ req, inputImages, model, count }) => ({
			kind: "json",
			body: {
				model,
				prompt: req.prompt,
				n: count,
				size: req.size ?? DEFAULT_SIZE,
				images: inputImages.map((image) => ({ image_url: imageToDataUrl(image) }))
			}
		}),
		missingApiKeyError: "LiteLLM API key missing",
		failureLabels: {
			generate: "LiteLLM image generation failed",
			edit: "LiteLLM image edit failed"
		}
	});
}
//#endregion
export { buildLitellmImageGenerationProvider as t };
