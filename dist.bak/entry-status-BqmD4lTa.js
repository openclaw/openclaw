//#region src/shared/entry-metadata.ts
function resolveEmojiAndHomepage(params) {
	const emoji = params.metadata?.emoji ?? params.frontmatter?.emoji;
	const homepageRaw = params.metadata?.homepage ?? params.frontmatter?.homepage ?? params.frontmatter?.website ?? params.frontmatter?.url;
	const homepage = homepageRaw?.trim() ? homepageRaw.trim() : void 0;
	return {
		...emoji ? { emoji } : {},
		...homepage ? { homepage } : {}
	};
}

//#endregion
//#region src/shared/requirements.ts
function resolveMissingBins(params) {
	const remote = params.hasRemoteBin;
	return params.required.filter((bin) => {
		if (params.hasLocalBin(bin)) return false;
		if (remote?.(bin)) return false;
		return true;
	});
}
function resolveMissingAnyBins(params) {
	if (params.required.length === 0) return [];
	if (params.required.some((bin) => params.hasLocalBin(bin))) return [];
	if (params.hasRemoteAnyBin?.(params.required)) return [];
	return params.required;
}
function resolveMissingOs(params) {
	if (params.required.length === 0) return [];
	if (params.required.includes(params.localPlatform)) return [];
	if (params.remotePlatforms?.some((platform) => params.required.includes(platform))) return [];
	return params.required;
}
function resolveMissingEnv(params) {
	const missing = [];
	for (const envName of params.required) {
		if (params.isSatisfied(envName)) continue;
		missing.push(envName);
	}
	return missing;
}
function buildConfigChecks(params) {
	return params.required.map((pathStr) => {
		return {
			path: pathStr,
			satisfied: params.isSatisfied(pathStr)
		};
	});
}
function evaluateRequirements(params) {
	const missingBins = resolveMissingBins({
		required: params.required.bins,
		hasLocalBin: params.hasLocalBin,
		hasRemoteBin: params.hasRemoteBin
	});
	const missingAnyBins = resolveMissingAnyBins({
		required: params.required.anyBins,
		hasLocalBin: params.hasLocalBin,
		hasRemoteAnyBin: params.hasRemoteAnyBin
	});
	const missingOs = resolveMissingOs({
		required: params.required.os,
		localPlatform: params.localPlatform,
		remotePlatforms: params.remotePlatforms
	});
	const missingEnv = resolveMissingEnv({
		required: params.required.env,
		isSatisfied: params.isEnvSatisfied
	});
	const configChecks = buildConfigChecks({
		required: params.required.config,
		isSatisfied: params.isConfigSatisfied
	});
	const missingConfig = configChecks.filter((check) => !check.satisfied).map((check) => check.path);
	const missing = params.always ? {
		bins: [],
		anyBins: [],
		env: [],
		config: [],
		os: []
	} : {
		bins: missingBins,
		anyBins: missingAnyBins,
		env: missingEnv,
		config: missingConfig,
		os: missingOs
	};
	return {
		missing,
		eligible: params.always || missing.bins.length === 0 && missing.anyBins.length === 0 && missing.env.length === 0 && missing.config.length === 0 && missing.os.length === 0,
		configChecks
	};
}
function evaluateRequirementsFromMetadata(params) {
	const required = {
		bins: params.metadata?.requires?.bins ?? [],
		anyBins: params.metadata?.requires?.anyBins ?? [],
		env: params.metadata?.requires?.env ?? [],
		config: params.metadata?.requires?.config ?? [],
		os: params.metadata?.os ?? []
	};
	return {
		required,
		...evaluateRequirements({
			always: params.always,
			required,
			hasLocalBin: params.hasLocalBin,
			hasRemoteBin: params.hasRemoteBin,
			hasRemoteAnyBin: params.hasRemoteAnyBin,
			localPlatform: params.localPlatform,
			remotePlatforms: params.remotePlatforms,
			isEnvSatisfied: params.isEnvSatisfied,
			isConfigSatisfied: params.isConfigSatisfied
		})
	};
}
function evaluateRequirementsFromMetadataWithRemote(params) {
	return evaluateRequirementsFromMetadata({
		always: params.always,
		metadata: params.metadata,
		hasLocalBin: params.hasLocalBin,
		hasRemoteBin: params.remote?.hasBin,
		hasRemoteAnyBin: params.remote?.hasAnyBin,
		localPlatform: params.localPlatform,
		remotePlatforms: params.remote?.platforms,
		isEnvSatisfied: params.isEnvSatisfied,
		isConfigSatisfied: params.isConfigSatisfied
	});
}

//#endregion
//#region src/shared/entry-status.ts
function evaluateEntryMetadataRequirements(params) {
	const { emoji, homepage } = resolveEmojiAndHomepage({
		metadata: params.metadata,
		frontmatter: params.frontmatter
	});
	const { required, missing, eligible, configChecks } = evaluateRequirementsFromMetadataWithRemote({
		always: params.always,
		metadata: params.metadata ?? void 0,
		hasLocalBin: params.hasLocalBin,
		localPlatform: params.localPlatform,
		remote: params.remote,
		isEnvSatisfied: params.isEnvSatisfied,
		isConfigSatisfied: params.isConfigSatisfied
	});
	return {
		...emoji ? { emoji } : {},
		...homepage ? { homepage } : {},
		required,
		missing,
		requirementsSatisfied: eligible,
		configChecks
	};
}
function evaluateEntryMetadataRequirementsForCurrentPlatform(params) {
	return evaluateEntryMetadataRequirements({
		...params,
		localPlatform: process.platform
	});
}
function evaluateEntryRequirementsForCurrentPlatform(params) {
	return evaluateEntryMetadataRequirementsForCurrentPlatform({
		always: params.always,
		metadata: params.entry.metadata,
		frontmatter: params.entry.frontmatter,
		hasLocalBin: params.hasLocalBin,
		remote: params.remote,
		isEnvSatisfied: params.isEnvSatisfied,
		isConfigSatisfied: params.isConfigSatisfied
	});
}

//#endregion
export { evaluateEntryRequirementsForCurrentPlatform as t };