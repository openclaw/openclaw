import { a as resolveAgentModelTimeoutMsValue } from "./model-input-ChW9XXsQ.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { c as resolveClosestAspectRatio, f as resolveMediaProviderRequestTimeoutMs, i as hasMediaNormalizationEntry, l as resolveClosestResolution, n as buildNoCapabilityModelConfiguredMessage, o as recordCapabilityCandidateFailure, p as throwCapabilityGenerationFailure, s as resolveCapabilityModelCandidates, t as buildMediaGenerationNormalizationMetadata, u as resolveClosestSize } from "./runtime-shared-CXEq0Bjh.js";
import { a as resolveVideoGenerationModeCapabilities, n as resolveVideoGenerationSupportedDurations, t as normalizeVideoGenerationDuration } from "./duration-support-0igMBB1p.js";
import { t as parseVideoGenerationModelRef } from "./model-ref-Bmr4a8Ak.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-Cd-y3osH.js";
//#region src/video-generation/capability-overlays.ts
function isVideoGenerationTransformCapabilities(capabilities) {
	return Boolean(capabilities && "enabled" in capabilities);
}
function buildReferenceInputCapabilityFailure(params) {
	const { providerId, model, provider, inputImageCount, inputVideoCount, inputAudioCount } = params;
	const label = `${providerId}/${model}`;
	const { capabilities } = resolveVideoGenerationModeCapabilities({
		provider,
		model,
		inputImageCount,
		inputVideoCount
	});
	if (inputImageCount > 0 || inputVideoCount > 0) {
		const visualLabel = inputImageCount > 0 && inputVideoCount > 0 ? "combined image/video reference inputs" : inputImageCount > 0 ? "reference image inputs" : "reference video inputs";
		if (!capabilities || !isVideoGenerationTransformCapabilities(capabilities)) return `${label} does not support ${visualLabel}; skipping to avoid silent reference drop`;
		if (!capabilities.enabled) return `${label} does not support ${visualLabel}; skipping to avoid silent reference drop`;
	}
	if (inputImageCount > 0) {
		const maxImages = capabilities?.maxInputImages ?? provider.capabilities.maxInputImages ?? 0;
		if (inputImageCount > maxImages) return maxImages === 0 ? `${label} does not support reference image inputs; skipping to avoid silent image drop` : `${label} supports at most ${maxImages} reference image(s), ${inputImageCount} requested; skipping`;
	}
	if (inputVideoCount > 0) {
		const maxVideos = capabilities?.maxInputVideos ?? provider.capabilities.maxInputVideos ?? 0;
		if (inputVideoCount > maxVideos) return maxVideos === 0 ? `${label} does not support reference video inputs; skipping to avoid silent video drop` : `${label} supports at most ${maxVideos} reference video(s), ${inputVideoCount} requested; skipping`;
	}
	if (inputAudioCount > 0) {
		const maxAudio = capabilities?.maxInputAudios ?? provider.capabilities.maxInputAudios ?? 0;
		if (inputAudioCount > maxAudio) return maxAudio === 0 ? `${label} does not support reference audio inputs; skipping to avoid silent audio drop` : `${label} supports at most ${maxAudio} reference audio(s), ${inputAudioCount} requested; skipping`;
	}
}
function mergeVideoGenerationModeCapabilities(base, overlay) {
	if (!overlay) return base;
	if (!base) return overlay;
	const overlayOptions = overlay.providerOptions;
	const mergedProviderOptions = Object.hasOwn(overlay, "providerOptions") && overlayOptions && Object.keys(overlayOptions).length === 0 ? overlayOptions : base.providerOptions || overlayOptions ? {
		...base.providerOptions,
		...overlayOptions
	} : void 0;
	return {
		...base,
		...overlay,
		...mergedProviderOptions ? { providerOptions: mergedProviderOptions } : {}
	};
}
function mergeVideoGenerationProviderCapabilities(base, overlay) {
	const overlayOptions = overlay.providerOptions;
	const mergedProviderOptions = Object.hasOwn(overlay, "providerOptions") && overlayOptions && Object.keys(overlayOptions).length === 0 ? overlayOptions : base.providerOptions || overlayOptions ? {
		...base.providerOptions,
		...overlayOptions
	} : void 0;
	return {
		...base,
		...overlay,
		...mergedProviderOptions ? { providerOptions: mergedProviderOptions } : {},
		generate: mergeVideoGenerationModeCapabilities(base.generate, overlay.generate),
		imageToVideo: mergeVideoGenerationModeCapabilities(base.imageToVideo, overlay.imageToVideo),
		videoToVideo: mergeVideoGenerationModeCapabilities(base.videoToVideo, overlay.videoToVideo)
	};
}
async function resolveProviderWithModelCapabilities(params) {
	if (!params.provider.resolveModelCapabilities) return params.provider;
	try {
		const modelCapabilities = await params.provider.resolveModelCapabilities({
			provider: params.providerId,
			model: params.model,
			cfg: params.cfg,
			agentDir: params.agentDir,
			authStore: params.authStore,
			...params.timeoutMs !== void 0 ? { timeoutMs: params.timeoutMs } : {}
		});
		if (!modelCapabilities) return params.provider;
		return {
			...params.provider,
			capabilities: mergeVideoGenerationProviderCapabilities(params.provider.capabilities, modelCapabilities)
		};
	} catch (err) {
		params.log.debug(`video-generation model capability lookup failed for ${params.providerId}/${params.model}: ${err instanceof Error ? err.message : String(err)}`);
		return params.provider;
	}
}
//#endregion
//#region src/video-generation/normalization.ts
const VIDEO_RESOLUTION_ORDER = [
	"480P",
	"720P",
	"768P",
	"1080P"
];
function resolveVideoGenerationOverrides(params) {
	const { capabilities: caps } = resolveVideoGenerationModeCapabilities({
		provider: params.provider,
		model: params.model,
		inputImageCount: params.inputImageCount,
		inputVideoCount: params.inputVideoCount
	});
	const ignoredOverrides = [];
	const normalization = {};
	let size = params.size;
	let aspectRatio = params.aspectRatio;
	let resolution = params.resolution;
	let audio = params.audio;
	let watermark = params.watermark;
	if (caps) {
		if (size && (caps.sizes?.length ?? 0) > 0 && caps.supportsSize) {
			const normalizedSize = resolveClosestSize({
				requestedSize: size,
				requestedAspectRatio: aspectRatio,
				supportedSizes: caps.sizes
			});
			if (normalizedSize && normalizedSize !== size) normalization.size = {
				requested: size,
				applied: normalizedSize
			};
			size = normalizedSize;
		}
		if (!caps.supportsSize && size) {
			let translated = false;
			if (caps.supportsAspectRatio) {
				const normalizedAspectRatio = resolveClosestAspectRatio({
					requestedAspectRatio: aspectRatio,
					requestedSize: size,
					supportedAspectRatios: caps.aspectRatios
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
		if (aspectRatio && (caps.aspectRatios?.length ?? 0) > 0 && caps.supportsAspectRatio) {
			const normalizedAspectRatio = resolveClosestAspectRatio({
				requestedAspectRatio: aspectRatio,
				requestedSize: size,
				supportedAspectRatios: caps.aspectRatios
			});
			if (normalizedAspectRatio && normalizedAspectRatio !== aspectRatio) normalization.aspectRatio = {
				requested: aspectRatio,
				applied: normalizedAspectRatio
			};
			else if (!normalizedAspectRatio) ignoredOverrides.push({
				key: "aspectRatio",
				value: aspectRatio
			});
			aspectRatio = normalizedAspectRatio;
		} else if (!caps.supportsAspectRatio && aspectRatio) {
			const derivedSize = caps.supportsSize && !size ? resolveClosestSize({
				requestedSize: params.size,
				requestedAspectRatio: aspectRatio,
				supportedSizes: caps.sizes
			}) : void 0;
			if (derivedSize) {
				size = derivedSize;
				normalization.size = {
					applied: derivedSize,
					derivedFrom: "aspectRatio"
				};
			} else ignoredOverrides.push({
				key: "aspectRatio",
				value: aspectRatio
			});
			aspectRatio = void 0;
		}
		if (resolution && (caps.resolutions?.length ?? 0) > 0 && caps.supportsResolution) {
			const normalizedResolution = resolveClosestResolution({
				requestedResolution: resolution,
				supportedResolutions: caps.resolutions,
				order: VIDEO_RESOLUTION_ORDER
			});
			if (normalizedResolution && normalizedResolution !== resolution) normalization.resolution = {
				requested: resolution,
				applied: normalizedResolution
			};
			else if (!normalizedResolution) ignoredOverrides.push({
				key: "resolution",
				value: resolution
			});
			resolution = normalizedResolution;
		} else if (resolution && !caps.supportsResolution) {
			ignoredOverrides.push({
				key: "resolution",
				value: resolution
			});
			resolution = void 0;
		}
		if (typeof audio === "boolean" && !caps.supportsAudio) {
			ignoredOverrides.push({
				key: "audio",
				value: audio
			});
			audio = void 0;
		}
		if (typeof watermark === "boolean" && !caps.supportsWatermark) {
			ignoredOverrides.push({
				key: "watermark",
				value: watermark
			});
			watermark = void 0;
		}
	}
	if (caps && size && !caps.supportsSize) {
		ignoredOverrides.push({
			key: "size",
			value: size
		});
		size = void 0;
	}
	if (caps && aspectRatio && !caps.supportsAspectRatio) {
		ignoredOverrides.push({
			key: "aspectRatio",
			value: aspectRatio
		});
		aspectRatio = void 0;
	}
	if (caps && resolution && !caps.supportsResolution) {
		ignoredOverrides.push({
			key: "resolution",
			value: resolution
		});
		resolution = void 0;
	}
	if (!normalization.size && size && params.size && params.size !== size) normalization.size = {
		requested: params.size,
		applied: size
	};
	if (!normalization.aspectRatio && aspectRatio && (!params.aspectRatio && params.size || params.aspectRatio !== aspectRatio)) normalization.aspectRatio = {
		applied: aspectRatio,
		...params.aspectRatio ? { requested: params.aspectRatio } : {},
		...!params.aspectRatio && params.size ? { derivedFrom: "size" } : {}
	};
	if (!normalization.resolution && resolution && params.resolution && params.resolution !== resolution) normalization.resolution = {
		requested: params.resolution,
		applied: resolution
	};
	const requestedDurationSeconds = typeof params.durationSeconds === "number" && Number.isFinite(params.durationSeconds) ? Math.max(1, Math.round(params.durationSeconds)) : void 0;
	const durationSeconds = normalizeVideoGenerationDuration({
		provider: params.provider,
		model: params.model,
		durationSeconds: requestedDurationSeconds,
		inputImageCount: params.inputImageCount ?? 0,
		inputVideoCount: params.inputVideoCount ?? 0
	});
	const supportedDurationSeconds = resolveVideoGenerationSupportedDurations({
		provider: params.provider,
		model: params.model,
		inputImageCount: params.inputImageCount ?? 0,
		inputVideoCount: params.inputVideoCount ?? 0
	});
	if (typeof requestedDurationSeconds === "number" && typeof durationSeconds === "number" && requestedDurationSeconds !== durationSeconds) normalization.durationSeconds = {
		requested: requestedDurationSeconds,
		applied: durationSeconds,
		...supportedDurationSeconds?.length ? { supportedValues: supportedDurationSeconds } : {}
	};
	return {
		size,
		aspectRatio,
		resolution,
		durationSeconds,
		supportedDurationSeconds,
		audio,
		watermark,
		ignoredOverrides,
		normalization: hasMediaNormalizationEntry(normalization.size) || hasMediaNormalizationEntry(normalization.aspectRatio) || hasMediaNormalizationEntry(normalization.resolution) || hasMediaNormalizationEntry(normalization.durationSeconds) ? normalization : void 0
	};
}
//#endregion
//#region src/video-generation/runtime.ts
const log = createSubsystemLogger("video-generation");
const MODEL_CAPABILITY_LOOKUP_TIMEOUT_MS = 5e3;
const SUPPORTED_DURATIONS_HINT = Symbol.for("openclaw.videoGeneration.supportedDurations");
/**
* Validate agent-supplied providerOptions against the candidate's declared
* schema. Returns a human-readable skip reason when the candidate cannot
* accept the supplied options, or undefined when everything checks out.
*
* Backward-compatible behavior:
* - Provider declares no schema (undefined): pass options through as-is.
*   The provider receives them and may silently ignore unknown keys. This is
*   the safe default for legacy / not-yet-migrated providers.
* - Provider explicitly declares an empty schema ({}): rejects any options.
*   This is the opt-in signal that the provider has been audited and truly
*   supports no options.
* - Provider declares a typed schema: validates each key name and value type,
*   skipping the candidate on any mismatch.
*/
function validateProviderOptionsAgainstDeclaration(params) {
	const { providerId, model, providerOptions, declaration } = params;
	const keys = Object.keys(providerOptions);
	if (keys.length === 0) return;
	if (declaration === void 0) return;
	if (Object.keys(declaration).length === 0) return `${providerId}/${model} does not accept providerOptions (caller supplied: ${keys.join(", ")}); skipping`;
	const unknown = keys.filter((key) => !Object.hasOwn(declaration, key));
	if (unknown.length > 0) {
		const accepted = Object.keys(declaration).join(", ");
		return `${providerId}/${model} does not accept providerOptions keys: ${unknown.join(", ")} (accepted: ${accepted}); skipping`;
	}
	for (const key of keys) {
		const expected = declaration[key];
		const value = providerOptions[key];
		const actual = typeof value;
		if (expected === "number" && (actual !== "number" || !Number.isFinite(value))) return `${providerId}/${model} expects providerOptions.${key} to be a finite number, got ${actual}; skipping`;
		if (expected === "boolean" && actual !== "boolean") return `${providerId}/${model} expects providerOptions.${key} to be a boolean, got ${actual}; skipping`;
		if (expected === "string" && actual !== "string") return `${providerId}/${model} expects providerOptions.${key} to be a string, got ${actual}; skipping`;
	}
}
function buildNoVideoGenerationModelConfiguredMessage(cfg, deps) {
	return buildNoCapabilityModelConfiguredMessage({
		capabilityLabel: "video-generation",
		modelConfigKey: "videoGenerationModel",
		providers: (deps.listProviders ?? listVideoGenerationProviders)(cfg),
		getProviderEnvVars: deps.getProviderEnvVars
	});
}
function listRuntimeVideoGenerationProviders(params, deps = {}) {
	return (deps.listProviders ?? listVideoGenerationProviders)(params?.config);
}
async function generateVideo(params, deps = {}) {
	const getProvider = deps.getProvider ?? getVideoGenerationProvider;
	const listProviders = deps.listProviders ?? listVideoGenerationProviders;
	const logger = deps.log ?? log;
	const requestedTimeoutMs = params.timeoutMs ?? resolveAgentModelTimeoutMsValue(params.cfg.agents?.defaults?.videoGenerationModel);
	const candidates = resolveCapabilityModelCandidates({
		cfg: params.cfg,
		modelConfig: params.cfg.agents?.defaults?.videoGenerationModel,
		modelOverride: params.modelOverride,
		parseModelRef: parseVideoGenerationModelRef,
		agentDir: params.agentDir,
		listProviders,
		autoProviderFallback: params.autoProviderFallback
	});
	if (candidates.length === 0) throw new Error(buildNoVideoGenerationModelConfiguredMessage(params.cfg, deps));
	const attempts = [];
	let lastError;
	let skipWarnEmitted = false;
	const warnOnFirstSkip = (reason) => {
		if (!skipWarnEmitted) {
			skipWarnEmitted = true;
			logger.warn(`video-generation candidate skipped: ${reason}`);
		}
	};
	for (const candidate of candidates) {
		const provider = getProvider(candidate.provider, params.cfg);
		if (!provider) {
			const error = `No video-generation provider registered for ${candidate.provider}`;
			attempts.push({
				provider: candidate.provider,
				model: candidate.model,
				error
			});
			lastError = new Error(error);
			continue;
		}
		const timeoutMs = resolveMediaProviderRequestTimeoutMs({
			timeoutMs: requestedTimeoutMs,
			providerDefaultTimeoutMs: provider.defaultTimeoutMs
		});
		const activeProvider = await resolveProviderWithModelCapabilities({
			provider,
			providerId: candidate.provider,
			model: candidate.model,
			cfg: params.cfg,
			agentDir: params.agentDir,
			authStore: params.authStore,
			timeoutMs: MODEL_CAPABILITY_LOOKUP_TIMEOUT_MS,
			log: logger
		});
		const inputImageCount = params.inputImages?.length ?? 0;
		const inputVideoCount = params.inputVideos?.length ?? 0;
		const inputAudioCount = params.inputAudios?.length ?? 0;
		const referenceInputMismatch = buildReferenceInputCapabilityFailure({
			providerId: candidate.provider,
			model: candidate.model,
			provider: activeProvider,
			inputImageCount,
			inputVideoCount,
			inputAudioCount
		});
		if (referenceInputMismatch) {
			attempts.push({
				provider: candidate.provider,
				model: candidate.model,
				error: referenceInputMismatch
			});
			lastError = new Error(referenceInputMismatch);
			warnOnFirstSkip(referenceInputMismatch);
			logger.debug(`video-generation candidate skipped (reference input capability): ${candidate.provider}/${candidate.model}`);
			continue;
		}
		if (params.providerOptions && typeof params.providerOptions === "object" && Object.keys(params.providerOptions).length > 0) {
			const { capabilities: optCaps } = resolveVideoGenerationModeCapabilities({
				provider: activeProvider,
				model: candidate.model,
				inputImageCount,
				inputVideoCount
			});
			const declaredOptions = optCaps?.providerOptions ?? activeProvider.capabilities.providerOptions ?? void 0;
			const mismatch = validateProviderOptionsAgainstDeclaration({
				providerId: candidate.provider,
				model: candidate.model,
				providerOptions: params.providerOptions,
				declaration: declaredOptions
			});
			if (mismatch) {
				attempts.push({
					provider: candidate.provider,
					model: candidate.model,
					error: mismatch
				});
				lastError = new Error(mismatch);
				warnOnFirstSkip(mismatch);
				logger.debug(`video-generation candidate skipped (providerOptions): ${candidate.provider}/${candidate.model}`);
				continue;
			}
		}
		const supportedDurations = resolveVideoGenerationSupportedDurations({
			provider: activeProvider,
			model: candidate.model,
			inputImageCount,
			inputVideoCount
		});
		const requestedDuration = params.durationSeconds;
		if (typeof requestedDuration === "number" && Number.isFinite(requestedDuration)) {
			const { capabilities: durCaps } = resolveVideoGenerationModeCapabilities({
				provider: activeProvider,
				model: candidate.model,
				inputImageCount,
				inputVideoCount
			});
			const maxDuration = durCaps?.maxDurationSeconds ?? activeProvider.capabilities.maxDurationSeconds;
			if (!supportedDurations && typeof maxDuration === "number" && Math.round(requestedDuration) > maxDuration) {
				const error = `${candidate.provider}/${candidate.model} supports at most ${maxDuration}s per video, ${requestedDuration}s requested; skipping`;
				attempts.push({
					provider: candidate.provider,
					model: candidate.model,
					error
				});
				lastError = new Error(error);
				warnOnFirstSkip(error);
				logger.debug(`video-generation candidate skipped (duration capability): ${candidate.provider}/${candidate.model}`);
				continue;
			}
		}
		try {
			const sanitized = resolveVideoGenerationOverrides({
				provider: activeProvider,
				model: candidate.model,
				size: params.size,
				aspectRatio: params.aspectRatio,
				resolution: params.resolution,
				durationSeconds: params.durationSeconds,
				audio: params.audio,
				watermark: params.watermark,
				inputImageCount,
				inputVideoCount
			});
			const generationRequest = {
				provider: candidate.provider,
				model: candidate.model,
				prompt: params.prompt,
				cfg: params.cfg,
				agentDir: params.agentDir,
				authStore: params.authStore,
				size: sanitized.size,
				aspectRatio: sanitized.aspectRatio,
				resolution: sanitized.resolution,
				durationSeconds: sanitized.durationSeconds,
				audio: sanitized.audio,
				watermark: sanitized.watermark,
				inputImages: params.inputImages,
				inputVideos: params.inputVideos,
				inputAudios: params.inputAudios,
				providerOptions: params.providerOptions,
				...timeoutMs !== void 0 ? { timeoutMs } : {}
			};
			if (supportedDurations) generationRequest[SUPPORTED_DURATIONS_HINT] = supportedDurations;
			const result = await provider.generateVideo(generationRequest);
			if (!Array.isArray(result.videos) || result.videos.length === 0) throw new Error("Video generation provider returned no videos.");
			for (const [index, video] of result.videos.entries()) if (!video.buffer && !video.url) throw new Error(`Video generation provider returned an undeliverable asset at index ${index}: neither buffer nor url is set.`);
			return {
				videos: result.videos,
				provider: candidate.provider,
				model: result.model ?? candidate.model,
				attempts,
				normalization: sanitized.normalization,
				ignoredOverrides: sanitized.ignoredOverrides,
				metadata: {
					...result.metadata,
					...buildMediaGenerationNormalizationMetadata({
						normalization: sanitized.normalization,
						requestedSizeForDerivedAspectRatio: params.size,
						includeSupportedDurationSeconds: true
					})
				}
			};
		} catch (err) {
			lastError = err;
			recordCapabilityCandidateFailure({
				attempts,
				provider: candidate.provider,
				model: candidate.model,
				error: err
			});
			logger.debug(`video-generation candidate failed: ${candidate.provider}/${candidate.model}`);
		}
	}
	return throwCapabilityGenerationFailure({
		capabilityLabel: "video generation",
		attempts,
		lastError
	});
}
//#endregion
export { listRuntimeVideoGenerationProviders as n, generateVideo as t };
