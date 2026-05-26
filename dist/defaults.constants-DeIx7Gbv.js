import { r as resolvePluginCapabilityProviders } from "./capability-provider-runtime-BwiWIvn0.js";
import { n as normalizeMediaProviderId } from "./provider-id-BETgOIvU.js";
import { t as resolveImageCapableConfigProviderIds } from "./config-provider-models-DbsyMOsr.js";
import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-Dye6Uj6e.js";
//#region src/media-understanding/provider-registry.ts
function mergeProviderIntoRegistry(registry, provider, registryKey = provider.id) {
	const normalizedKey = normalizeMediaProviderId(registryKey);
	const existing = registry.get(normalizedKey);
	const merged = existing ? {
		...existing,
		...provider,
		capabilities: provider.capabilities ?? existing.capabilities,
		defaultModels: provider.defaultModels ?? existing.defaultModels,
		autoPriority: provider.autoPriority ?? existing.autoPriority,
		nativeDocumentInputs: provider.nativeDocumentInputs ?? existing.nativeDocumentInputs
	} : provider;
	registry.set(normalizedKey, hydrateModelBackedMediaProvider(merged));
}
function hydrateModelBackedMediaProvider(provider) {
	if (!provider.capabilities?.includes("image")) return provider;
	if (provider.describeImage && provider.describeImages) return provider;
	return {
		...provider,
		describeImage: provider.describeImage ?? describeImageWithModel,
		describeImages: provider.describeImages ?? describeImagesWithModel
	};
}
function buildMediaUnderstandingRegistry(overrides, cfg) {
	const registry = /* @__PURE__ */ new Map();
	for (const provider of resolvePluginCapabilityProviders({
		key: "mediaUnderstandingProviders",
		cfg
	})) mergeProviderIntoRegistry(registry, provider);
	for (const normalizedKey of resolveImageCapableConfigProviderIds(cfg)) if (!registry.has(normalizedKey)) mergeProviderIntoRegistry(registry, {
		id: normalizedKey,
		capabilities: ["image"],
		describeImage: describeImageWithModel,
		describeImages: describeImagesWithModel
	});
	if (overrides) for (const [key, provider] of Object.entries(overrides)) mergeProviderIntoRegistry(registry, provider, key);
	return registry;
}
function getMediaUnderstandingProvider(id, registry) {
	return registry.get(normalizeMediaProviderId(id));
}
//#endregion
//#region src/media-understanding/defaults.constants.ts
const MB = 1024 * 1024;
const DEFAULT_MAX_CHARS = 500;
const DEFAULT_MAX_CHARS_BY_CAPABILITY = {
	image: 500,
	audio: void 0,
	video: 500
};
const DEFAULT_MAX_BYTES = {
	image: 10 * MB,
	audio: 20 * MB,
	video: 50 * MB
};
const DEFAULT_TIMEOUT_SECONDS = {
	image: 60,
	audio: 60,
	video: 120
};
const DEFAULT_PROMPT = {
	image: "Describe the image.",
	audio: "Transcribe the audio.",
	video: "Describe the video."
};
const DEFAULT_VIDEO_MAX_BASE64_BYTES = 70 * MB;
const CLI_OUTPUT_MAX_BUFFER = 5 * MB;
const DEFAULT_MEDIA_CONCURRENCY = 2;
const MIN_AUDIO_FILE_BYTES = 1024;
//#endregion
export { DEFAULT_MEDIA_CONCURRENCY as a, DEFAULT_VIDEO_MAX_BASE64_BYTES as c, getMediaUnderstandingProvider as d, DEFAULT_MAX_CHARS_BY_CAPABILITY as i, MIN_AUDIO_FILE_BYTES as l, DEFAULT_MAX_BYTES as n, DEFAULT_PROMPT as o, DEFAULT_MAX_CHARS as r, DEFAULT_TIMEOUT_SECONDS as s, CLI_OUTPUT_MAX_BUFFER as t, buildMediaUnderstandingRegistry as u };
