import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { o as imageSourceUploadFileName, t as createOpenAiCompatibleImageGenerationProvider } from "./image-generation-Bda4L-l6.js";
import { t as DEEPINFRA_BASE_URL } from "./provider-models-wxUkQkYA.js";
import { g as normalizeDeepInfraModelRef, h as normalizeDeepInfraBaseUrl, l as DEFAULT_DEEPINFRA_IMAGE_MODEL, t as DEEPINFRA_IMAGE_MODELS } from "./media-models-Dp3VJEzX.js";
//#region extensions/deepinfra/image-generation-provider.ts
const DEEPINFRA_IMAGE_SIZES = [
	"512x512",
	"1024x1024",
	"1024x1792",
	"1792x1024"
];
const MAX_DEEPINFRA_INPUT_IMAGES = 1;
function buildDeepInfraImageGenerationProvider() {
	return createOpenAiCompatibleImageGenerationProvider({
		id: "deepinfra",
		label: "DeepInfra",
		defaultModel: DEFAULT_DEEPINFRA_IMAGE_MODEL,
		models: [...DEEPINFRA_IMAGE_MODELS],
		capabilities: {
			generate: {
				maxCount: 4,
				supportsSize: true,
				supportsAspectRatio: false,
				supportsResolution: false
			},
			edit: {
				enabled: true,
				maxCount: 1,
				maxInputImages: MAX_DEEPINFRA_INPUT_IMAGES,
				supportsSize: true,
				supportsAspectRatio: false,
				supportsResolution: false
			},
			geometry: { sizes: [...DEEPINFRA_IMAGE_SIZES] }
		},
		defaultBaseUrl: DEEPINFRA_BASE_URL,
		normalizeModel: normalizeDeepInfraModelRef,
		resolveBaseUrl: ({ providerConfig }) => normalizeDeepInfraBaseUrl(providerConfig?.baseUrl, DEEPINFRA_BASE_URL),
		resolveAllowPrivateNetwork: () => false,
		useConfiguredRequest: true,
		resolveCount: ({ req, mode }) => mode === "edit" ? 1 : req.count ?? 1,
		buildGenerateRequest: ({ req, model, count }) => ({
			kind: "json",
			body: {
				model,
				prompt: req.prompt,
				n: count,
				size: normalizeOptionalString(req.size) ?? "1024x1024",
				response_format: "b64_json"
			}
		}),
		buildEditRequest: ({ req, inputImages, model, count }) => {
			const image = inputImages[0];
			if (!image) throw new Error("DeepInfra image edit missing reference image.");
			const form = new FormData();
			form.set("model", model);
			form.set("prompt", req.prompt);
			form.set("n", String(count));
			form.set("size", normalizeOptionalString(req.size) ?? "1024x1024");
			form.set("response_format", "b64_json");
			const mimeType = normalizeOptionalString(image.mimeType) ?? "image/png";
			form.append("image", new Blob([new Uint8Array(image.buffer)], { type: mimeType }), imageSourceUploadFileName({
				image,
				index: 0
			}));
			return {
				kind: "multipart",
				form
			};
		},
		response: {
			defaultMimeType: "image/jpeg",
			sniffMimeType: true
		},
		tooManyInputImagesError: "DeepInfra image editing supports one reference image.",
		missingApiKeyError: "DeepInfra API key missing",
		emptyResponseError: "DeepInfra image response did not include generated image data",
		failureLabels: {
			generate: "DeepInfra image generation failed",
			edit: "DeepInfra image edit failed"
		}
	});
}
//#endregion
export { buildDeepInfraImageGenerationProvider as t };
