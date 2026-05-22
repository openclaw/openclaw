import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
//#region src/infra/update-channels.ts
const DEFAULT_PACKAGE_CHANNEL = "stable";
const DEV_BRANCH = "main";
function normalizeUpdateChannel(value) {
	const normalized = normalizeOptionalLowercaseString(value);
	if (!normalized) return null;
	if (normalized === "stable" || normalized === "beta" || normalized === "dev") return normalized;
	return null;
}
function channelToNpmTag(channel) {
	if (channel === "beta") return "beta";
	if (channel === "dev") return "dev";
	return "latest";
}
function isBetaTag(tag) {
	return /(?:^|[.-])beta(?:[.-]|$)/i.test(tag);
}
function isStableTag(tag) {
	return !isBetaTag(tag);
}
function resolveRegistryUpdateChannel(params) {
	if (params.currentVersion && isBetaTag(params.currentVersion) && params.configChannel !== "beta" && params.configChannel !== "dev") return "beta";
	return params.configChannel ?? "stable";
}
function resolveEffectiveUpdateChannel(params) {
	if (params.currentVersion && isBetaTag(params.currentVersion) && params.configChannel !== "beta" && params.configChannel !== "dev") return {
		channel: "beta",
		source: "installed-version"
	};
	if (params.configChannel) return {
		channel: params.configChannel,
		source: "config"
	};
	if (params.installKind === "git") {
		const tag = params.git?.tag;
		if (tag) return {
			channel: isBetaTag(tag) ? "beta" : "stable",
			source: "git-tag"
		};
		const branch = params.git?.branch;
		if (branch && branch !== "HEAD") return {
			channel: "dev",
			source: "git-branch"
		};
		return {
			channel: "dev",
			source: "default"
		};
	}
	if (params.installKind === "package") return {
		channel: DEFAULT_PACKAGE_CHANNEL,
		source: "default"
	};
	return {
		channel: DEFAULT_PACKAGE_CHANNEL,
		source: "default"
	};
}
function formatUpdateChannelLabel(params) {
	if (params.source === "config") return `${params.channel} (config)`;
	if (params.source === "git-tag") return params.gitTag ? `${params.channel} (${params.gitTag})` : `${params.channel} (tag)`;
	if (params.source === "git-branch") return params.gitBranch ? `${params.channel} (${params.gitBranch})` : `${params.channel} (branch)`;
	if (params.source === "installed-version") return "beta (installed version)";
	return `${params.channel} (default)`;
}
function resolveUpdateChannelDisplay(params) {
	const channelInfo = resolveEffectiveUpdateChannel({
		configChannel: params.configChannel,
		currentVersion: params.currentVersion,
		installKind: params.installKind,
		git: params.gitTag || params.gitBranch ? {
			tag: params.gitTag ?? null,
			branch: params.gitBranch ?? null
		} : void 0
	});
	return {
		channel: channelInfo.channel,
		source: channelInfo.source,
		label: formatUpdateChannelLabel({
			channel: channelInfo.channel,
			source: channelInfo.source,
			gitTag: params.gitTag ?? null,
			gitBranch: params.gitBranch ?? null
		})
	};
}
//#endregion
export { isBetaTag as a, resolveEffectiveUpdateChannel as c, formatUpdateChannelLabel as i, resolveRegistryUpdateChannel as l, DEV_BRANCH as n, isStableTag as o, channelToNpmTag as r, normalizeUpdateChannel as s, DEFAULT_PACKAGE_CHANNEL as t, resolveUpdateChannelDisplay as u };
