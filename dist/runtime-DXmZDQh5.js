import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { a as resolveAgentModelTimeoutMsValue } from "./model-input-ChW9XXsQ.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as isFailoverError, r as describeFailoverError } from "./failover-error-CZCIurQK.js";
import { n as listImageGenerationProviders, r as parseImageGenerationModelRef, t as getImageGenerationProvider } from "./provider-registry-B3fo_9Pr.js";
import { c as resolveClosestAspectRatio, f as resolveMediaProviderRequestTimeoutMs, i as hasMediaNormalizationEntry, l as resolveClosestResolution, n as buildNoCapabilityModelConfiguredMessage, p as throwCapabilityGenerationFailure, s as resolveCapabilityModelCandidates, t as buildMediaGenerationNormalizationMetadata, u as resolveClosestSize } from "./runtime-shared-CXEq0Bjh.js";
//#region src/image-generation/normalization.ts
function finalizeImageNormalization(normalization) {
	return hasMediaNormalizationEntry(normalization.size) || hasMediaNormalizationEntry(normalization.aspectRatio) || hasMediaNormalizationEntry(normalization.resolution) ? normalization : void 0;
}
function resolveImageGenerationOverrides(params) {
	const modeCaps = (params.inputImages?.length ?? 0) > 0 ? params.provider.capabilities.edit : params.provider.capabilities.generate;
	const geometry = params.provider.capabilities.geometry;
	const ignoredOverrides = [];
	const normalization = {};
	let size = params.size;
	let aspectRatio = params.aspectRatio;
	let resolution = params.resolution;
	let quality = params.quality;
	let outputFormat = params.outputFormat;
	let background = params.background;
	if (size && (geometry?.sizes?.length ?? 0) > 0 && modeCaps.supportsSize) {
		const normalizedSize = resolveClosestSize({
			requestedSize: size,
			supportedSizes: geometry?.sizes
		});
		if (normalizedSize && normalizedSize !== size) normalization.size = {
			requested: size,
			applied: normalizedSize
		};
		size = normalizedSize;
	}
	if (!modeCaps.supportsSize && size) {
		let translated = false;
		if (modeCaps.supportsAspectRatio) {
			const normalizedAspectRatio = resolveClosestAspectRatio({
				requestedAspectRatio: aspectRatio,
				requestedSize: size,
				supportedAspectRatios: geometry?.aspectRatios
			});
			if (normalizedAspectRatio) {
				aspectRatio = normalizedAspectRatio;
				normalization.aspectRatio = {
					applied: normalizedAspectRatio,
					derivedFrom: "size"
				};
				translated = true;
			}
		}
		if (!translated) ignoredOverrides.push({
			key: "size",
			value: size
		});
		size = void 0;
	}
	if (aspectRatio && (geometry?.aspectRatios?.length ?? 0) > 0 && modeCaps.supportsAspectRatio) {
		const normalizedAspectRatio = resolveClosestAspectRatio({
			requestedAspectRatio: aspectRatio,
			requestedSize: size,
			supportedAspectRatios: geometry?.aspectRatios
		});
		if (normalizedAspectRatio && normalizedAspectRatio !== aspectRatio) normalization.aspectRatio = {
			requested: aspectRatio,
			applied: normalizedAspectRatio
		};
		aspectRatio = normalizedAspectRatio;
	} else if (!modeCaps.supportsAspectRatio && aspectRatio) {
		const derivedSize = modeCaps.supportsSize && !size ? resolveClosestSize({
			requestedSize: params.size,
			requestedAspectRatio: aspectRatio,
			supportedSizes: geometry?.sizes
		}) : void 0;
		let translated = false;
		if (derivedSize) {
			size = derivedSize;
			normalization.size = {
				applied: derivedSize,
				derivedFrom: "aspectRatio"
			};
			translated = true;
		}
		if (!translated) ignoredOverrides.push({
			key: "aspectRatio",
			value: aspectRatio
		});
		aspectRatio = void 0;
	}
	if (resolution && (geometry?.resolutions?.length ?? 0) > 0 && modeCaps.supportsResolution) {
		const normalizedResolution = resolveClosestResolution({
			requestedResolution: resolution,
			supportedResolutions: geometry?.resolutions
		});
		if (normalizedResolution && normalizedResolution !== resolution) normalization.resolution = {
			requested: resolution,
			applied: normalizedResolution
		};
		resolution = normalizedResolution;
	} else if (!modeCaps.supportsResolution && resolution) {
		ignoredOverrides.push({
			key: "resolution",
			value: resolution
		});
		resolution = void 0;
	}
	if (size && !modeCaps.supportsSize) {
		ignoredOverrides.push({
			key: "size",
			value: size
		});
		size = void 0;
	}
	if (aspectRatio && !modeCaps.supportsAspectRatio) {
		ignoredOverrides.push({
			key: "aspectRatio",
			value: aspectRatio
		});
		aspectRatio = void 0;
	}
	if (resolution && !modeCaps.supportsResolution) {
		ignoredOverrides.push({
			key: "resolution",
			value: resolution
		});
		resolution = void 0;
	}
	const supportedQualities = params.provider.capabilities.output?.qualities;
	if (quality && !(supportedQualities ?? []).includes(quality)) {
		ignoredOverrides.push({
			key: "quality",
			value: quality
		});
		quality = void 0;
	}
	const supportedFormats = params.provider.capabilities.output?.formats;
	if (outputFormat && !(supportedFormats ?? []).includes(outputFormat)) {
		ignoredOverrides.push({
			key: "outputFormat",
			value: outputFormat
		});
		outputFormat = void 0;
	}
	const supportedBackgrounds = params.provider.capabilities.output?.backgrounds;
	if (background && !(supportedBackgrounds ?? []).includes(background)) {
		ignoredOverrides.push({
			key: "background",
			value: background
		});
		background = void 0;
	}
	if (!normalization.aspectRatio && aspectRatio && (!params.aspectRatio && params.size || params.aspectRatio !== aspectRatio)) normalization.aspectRatio = {
		applied: aspectRatio,
		...params.aspectRatio ? { requested: params.aspectRatio } : {},
		...!params.aspectRatio && params.size ? { derivedFrom: "size" } : {}
	};
	if (!normalization.size && size && params.size && params.size !== size) normalization.size = {
		requested: params.size,
		applied: size
	};
	if (!normalization.aspectRatio && !params.aspectRatio && params.size && aspectRatio) normalization.aspectRatio = {
		applied: aspectRatio,
		derivedFrom: "size"
	};
	if (!normalization.resolution && resolution && params.resolution && params.resolution !== resolution) normalization.resolution = {
		requested: params.resolution,
		applied: resolution
	};
	return {
		size,
		aspectRatio,
		resolution,
		quality,
		outputFormat,
		background,
		ignoredOverrides,
		normalization: finalizeImageNormalization(normalization)
	};
}
//#endregion
//#region src/image-generation/runtime.ts
const log = createSubsystemLogger("image-generation");
function buildNoImageGenerationModelConfiguredMessage(cfg, deps) {
	return buildNoCapabilityModelConfiguredMessage({
		capabilityLabel: "image-generation",
		modelConfigKey: "imageGenerationModel",
		providers: (deps.listProviders ?? listImageGenerationProviders)(cfg),
		getProviderEnvVars: deps.getProviderEnvVars
	});
}
function listRuntimeImageGenerationProviders(params, deps = {}) {
	return (deps.listProviders ?? listImageGenerationProviders)(params?.config);
}
async function generateImage(params, deps = {}) {
	const getProvider = deps.getProvider ?? getImageGenerationProvider;
	const listProviders = deps.listProviders ?? listImageGenerationProviders;
	const logger = deps.log ?? log;
	const requestedTimeoutMs = params.timeoutMs ?? resolveAgentModelTimeoutMsValue(params.cfg.agents?.defaults?.imageGenerationModel);
	const candidates = resolveCapabilityModelCandidates({
		cfg: params.cfg,
		modelConfig: params.cfg.agents?.defaults?.imageGenerationModel,
		modelOverride: params.modelOverride,
		parseModelRef: parseImageGenerationModelRef,
		agentDir: params.agentDir,
		listProviders,
		autoProviderFallback: params.autoProviderFallback
	});
	if (candidates.length === 0) throw new Error(buildNoImageGenerationModelConfiguredMessage(params.cfg, deps));
	const attempts = [];
	let lastError;
	for (const candidate of candidates) {
		const provider = getProvider(candidate.provider, params.cfg);
		if (!provider) {
			const error = `No image-generation provider registered for ${candidate.provider}`;
			attempts.push({
				provider: candidate.provider,
				model: candidate.model,
				error
			});
			lastError = new Error(error);
			logger.warn(`image-generation candidate failed: ${candidate.provider}/${candidate.model}: ${error}`);
			continue;
		}
		try {
			const timeoutMs = resolveMediaProviderRequestTimeoutMs({
				timeoutMs: requestedTimeoutMs,
				providerDefaultTimeoutMs: provider.defaultTimeoutMs
			});
			const sanitized = resolveImageGenerationOverrides({
				provider,
				size: params.size,
				aspectRatio: params.aspectRatio,
				resolution: params.resolution,
				quality: params.quality,
				outputFormat: params.outputFormat,
				background: params.background,
				inputImages: params.inputImages
			});
			const result = await provider.generateImage({
				provider: candidate.provider,
				model: candidate.model,
				prompt: params.prompt,
				cfg: params.cfg,
				agentDir: params.agentDir,
				authStore: params.authStore,
				count: params.count,
				size: sanitized.size,
				aspectRatio: sanitized.aspectRatio,
				resolution: sanitized.resolution,
				quality: sanitized.quality,
				outputFormat: sanitized.outputFormat,
				background: sanitized.background,
				inputImages: params.inputImages,
				...timeoutMs !== void 0 ? { timeoutMs } : {},
				providerOptions: params.providerOptions,
				ssrfPolicy: params.ssrfPolicy
			});
			if (!Array.isArray(result.images) || result.images.length === 0) throw new Error("Image generation provider returned no images.");
			return {
				images: result.images,
				provider: candidate.provider,
				model: result.model ?? candidate.model,
				attempts,
				normalization: sanitized.normalization,
				metadata: {
					...result.metadata,
					...buildMediaGenerationNormalizationMetadata({
						normalization: sanitized.normalization,
						requestedSizeForDerivedAspectRatio: params.size
					})
				},
				ignoredOverrides: sanitized.ignoredOverrides
			};
		} catch (err) {
			lastError = err;
			const described = isFailoverError(err) ? describeFailoverError(err) : void 0;
			attempts.push({
				provider: candidate.provider,
				model: candidate.model,
				error: described?.message ?? formatErrorMessage(err),
				reason: described?.reason,
				status: described?.status,
				code: described?.code
			});
			logger.warn(`image-generation candidate failed: ${candidate.provider}/${candidate.model}: ${described?.message ?? formatErrorMessage(err)}`);
		}
	}
	return throwCapabilityGenerationFailure({
		capabilityLabel: "image generation",
		attempts,
		lastError
	});
}
//#endregion
export { listRuntimeImageGenerationProviders as n, generateImage as t };
