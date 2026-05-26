//#region src/video-generation/capabilities.ts
function resolveVideoGenerationMode(params) {
	const inputImageCount = params.inputImageCount ?? 0;
	const inputVideoCount = params.inputVideoCount ?? 0;
	if (inputImageCount > 0 && inputVideoCount > 0) return null;
	if (inputVideoCount > 0) return "videoToVideo";
	if (inputImageCount > 0) return "imageToVideo";
	return "generate";
}
function listSupportedVideoGenerationModes(provider) {
	const modes = ["generate"];
	if (provider.capabilities.imageToVideo?.enabled) modes.push("imageToVideo");
	if (provider.capabilities.videoToVideo?.enabled) modes.push("videoToVideo");
	return modes;
}
function resolveVideoGenerationModeCapabilities(params) {
	const inputImageCount = params.inputImageCount ?? 0;
	const inputVideoCount = params.inputVideoCount ?? 0;
	const mode = resolveVideoGenerationMode(params);
	const capabilities = params.provider?.capabilities;
	const withModelLimits = (caps) => {
		const model = params.model?.trim();
		if (!caps || !model) return caps;
		const maxInputImages = caps.maxInputImagesByModel?.[model];
		const maxInputVideos = caps.maxInputVideosByModel?.[model];
		const maxInputAudios = caps.maxInputAudiosByModel?.[model];
		if (typeof maxInputImages !== "number" && typeof maxInputVideos !== "number" && typeof maxInputAudios !== "number") return caps;
		return {
			...caps,
			...typeof maxInputImages === "number" ? { maxInputImages } : {},
			...typeof maxInputVideos === "number" ? { maxInputVideos } : {},
			...typeof maxInputAudios === "number" ? { maxInputAudios } : {}
		};
	};
	if (!capabilities) return {
		mode,
		capabilities: void 0
	};
	if (mode === "generate") return {
		mode,
		capabilities: withModelLimits(capabilities.generate)
	};
	if (mode === "imageToVideo") return {
		mode,
		capabilities: withModelLimits(capabilities.imageToVideo)
	};
	if (mode === "videoToVideo") return {
		mode,
		capabilities: withModelLimits(capabilities.videoToVideo)
	};
	const videoToVideoCapabilities = withModelLimits(capabilities.videoToVideo);
	if (inputImageCount > 0 && inputVideoCount > 0 && videoToVideoCapabilities?.enabled && (videoToVideoCapabilities.maxInputImages ?? 0) > 0) return {
		mode,
		capabilities: videoToVideoCapabilities
	};
	return {
		mode,
		capabilities: void 0
	};
}
//#endregion
//#region src/video-generation/duration-support.ts
function normalizeSupportedDurationValues(values) {
	if (!Array.isArray(values) || values.length === 0) return;
	const normalized = [...new Set(values)].filter((value) => Number.isFinite(value) && value > 0).map((value) => Math.round(value)).filter((value) => value > 0).toSorted((left, right) => left - right);
	return normalized.length > 0 ? normalized : void 0;
}
function resolveVideoGenerationSupportedDurations(params) {
	const { capabilities: caps } = resolveVideoGenerationModeCapabilities({
		provider: params.provider,
		model: params.model,
		inputImageCount: params.inputImageCount,
		inputVideoCount: params.inputVideoCount
	});
	const model = params.model?.trim();
	return normalizeSupportedDurationValues((model && caps?.supportedDurationSecondsByModel ? caps.supportedDurationSecondsByModel[model] : void 0) ?? caps?.supportedDurationSeconds);
}
function normalizeVideoGenerationDuration(params) {
	if (typeof params.durationSeconds !== "number" || !Number.isFinite(params.durationSeconds)) return;
	const rounded = Math.max(1, Math.round(params.durationSeconds));
	const supported = resolveVideoGenerationSupportedDurations(params);
	if (!supported || supported.length === 0) return rounded;
	return supported.reduce((best, current) => {
		const currentDistance = Math.abs(current - rounded);
		const bestDistance = Math.abs(best - rounded);
		if (currentDistance < bestDistance) return current;
		if (currentDistance === bestDistance && current > best) return current;
		return best;
	});
}
//#endregion
export { resolveVideoGenerationModeCapabilities as a, resolveVideoGenerationMode as i, resolveVideoGenerationSupportedDurations as n, listSupportedVideoGenerationModes as r, normalizeVideoGenerationDuration as t };
