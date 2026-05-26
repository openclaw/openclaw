import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { n as resolveBundledPluginsDir } from "./bundled-dir-CcqVVqEn.js";
import { t as loadPluginManifestRegistry } from "./manifest-registry-Cy1cBr1u.js";
import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-B6ofplrA.js";
//#region src/plugins/provider-public-artifacts.ts
const PROVIDER_POLICY_ARTIFACT_CANDIDATES = ["provider-policy-api.js"];
function hasProviderPolicyHook(mod) {
	return typeof mod.normalizeConfig === "function" || typeof mod.applyConfigDefaults === "function" || typeof mod.resolveConfigApiKey === "function" || typeof mod.resolveThinkingProfile === "function";
}
function tryLoadBundledProviderPolicySurface(pluginId) {
	for (const artifactBasename of PROVIDER_POLICY_ARTIFACT_CANDIDATES) try {
		const mod = loadBundledPluginPublicArtifactModuleSync({
			dirName: pluginId,
			artifactBasename
		});
		if (hasProviderPolicyHook(mod)) return mod;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Unable to resolve bundled plugin public surface ")) continue;
		throw error;
	}
	return null;
}
function resolveBundledProviderPolicyPluginId(providerId, options = {}) {
	const normalizedProviderId = normalizeProviderId(providerId);
	if (!normalizedProviderId) return null;
	if (!resolveBundledPluginsDir()) return null;
	const registry = options.manifestRegistry ?? loadPluginManifestRegistry();
	for (const plugin of registry.plugins.toSorted((left, right) => left.id.localeCompare(right.id))) {
		if (plugin.origin !== "bundled") continue;
		if (plugin.providers.some((provider) => normalizeProviderId(provider) === normalizedProviderId)) return plugin.id;
	}
	return null;
}
function resolveBundledProviderPolicySurface(providerId, options = {}) {
	const normalizedProviderId = normalizeProviderId(providerId);
	if (!normalizedProviderId) return null;
	const directSurface = tryLoadBundledProviderPolicySurface(normalizedProviderId);
	if (directSurface) return directSurface;
	const ownerPluginId = resolveBundledProviderPolicyPluginId(normalizedProviderId, options);
	if (!ownerPluginId || ownerPluginId === normalizedProviderId) return null;
	return tryLoadBundledProviderPolicySurface(ownerPluginId);
}
//#endregion
//#region src/auto-reply/thinking.shared.ts
const BASE_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high"
];
const THINKING_LEVEL_RANKS = {
	off: 0,
	minimal: 10,
	low: 20,
	medium: 30,
	high: 40,
	adaptive: 30,
	xhigh: 60,
	max: 70
};
function normalizeThinkLevel(raw) {
	const key = normalizeOptionalLowercaseString(raw);
	if (!key) return;
	const collapsed = key.replace(/[\s_-]+/g, "");
	if (collapsed === "adaptive" || collapsed === "auto") return "adaptive";
	if (collapsed === "max") return "max";
	if (collapsed === "xhigh" || collapsed === "extrahigh") return "xhigh";
	if (["off"].includes(key)) return "off";
	if ([
		"on",
		"enable",
		"enabled"
	].includes(key)) return "low";
	if (["min", "minimal"].includes(key)) return "minimal";
	if ([
		"low",
		"thinkhard",
		"think-hard",
		"think_hard"
	].includes(key)) return "low";
	if ([
		"mid",
		"med",
		"medium",
		"thinkharder",
		"think-harder",
		"harder"
	].includes(key)) return "medium";
	if ([
		"high",
		"ultra",
		"ultrathink",
		"think-hard",
		"thinkhardest",
		"highest"
	].includes(key)) return "high";
	if (["think"].includes(key)) return "minimal";
}
function isSessionDefaultDirectiveValue(raw) {
	const key = normalizeOptionalLowercaseString(raw);
	if (!key) return false;
	return [
		"default",
		"inherit",
		"inherited",
		"clear",
		"reset",
		"unpin"
	].includes(key);
}
function resolveThinkingDefaultForModel$1(params) {
	if ((params.catalog?.find((entry) => entry.provider === params.provider && entry.id === params.model))?.reasoning) return "low";
	return "off";
}
function normalizeOnOffFullLevel(raw) {
	const key = normalizeOptionalLowercaseString(raw);
	if (!key) return;
	if ([
		"off",
		"false",
		"no",
		"0"
	].includes(key)) return "off";
	if ([
		"full",
		"all",
		"everything"
	].includes(key)) return "full";
	if ([
		"on",
		"minimal",
		"true",
		"yes",
		"1"
	].includes(key)) return "on";
}
function normalizeVerboseLevel(raw) {
	return normalizeOnOffFullLevel(raw);
}
function normalizeTraceLevel(raw) {
	const key = normalizeOptionalLowercaseString(raw);
	if (!key) return;
	if ([
		"off",
		"false",
		"no",
		"0"
	].includes(key)) return "off";
	if ([
		"on",
		"true",
		"yes",
		"1"
	].includes(key)) return "on";
	if (["raw", "unfiltered"].includes(key)) return "raw";
}
function normalizeUsageDisplay(raw) {
	if (!raw) return;
	const key = normalizeLowercaseStringOrEmpty(raw);
	if ([
		"off",
		"false",
		"no",
		"0",
		"disable",
		"disabled"
	].includes(key)) return "off";
	if ([
		"on",
		"true",
		"yes",
		"1",
		"enable",
		"enabled"
	].includes(key)) return "tokens";
	if ([
		"tokens",
		"token",
		"tok",
		"minimal",
		"min"
	].includes(key)) return "tokens";
	if (["full", "session"].includes(key)) return "full";
}
function resolveResponseUsageMode(raw) {
	return normalizeUsageDisplay(raw) ?? "off";
}
function normalizeElevatedLevel(raw) {
	if (!raw) return;
	const key = normalizeLowercaseStringOrEmpty(raw);
	if ([
		"off",
		"false",
		"no",
		"0"
	].includes(key)) return "off";
	if ([
		"full",
		"auto",
		"auto-approve",
		"autoapprove"
	].includes(key)) return "full";
	if ([
		"ask",
		"prompt",
		"approval",
		"approve"
	].includes(key)) return "ask";
	if ([
		"on",
		"true",
		"yes",
		"1"
	].includes(key)) return "on";
}
function normalizeReasoningLevel(raw) {
	if (!raw) return;
	const key = normalizeLowercaseStringOrEmpty(raw);
	if ([
		"off",
		"false",
		"no",
		"0",
		"hide",
		"hidden",
		"disable",
		"disabled"
	].includes(key)) return "off";
	if ([
		"on",
		"true",
		"yes",
		"1",
		"show",
		"visible",
		"enable",
		"enabled"
	].includes(key)) return "on";
	if ([
		"stream",
		"streaming",
		"draft",
		"live"
	].includes(key)) return "stream";
}
//#endregion
//#region src/plugins/provider-thinking.ts
const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
function matchesProviderId(provider, providerId) {
	const normalized = normalizeProviderId(providerId);
	if (!normalized) return false;
	if (normalizeProviderId(provider.id) === normalized) return true;
	return [...provider.aliases ?? [], ...provider.hookAliases ?? []].some((alias) => normalizeProviderId(alias) === normalized);
}
function resolveActiveThinkingProvider(providerId) {
	const activeProvider = globalThis[PLUGIN_REGISTRY_STATE]?.activeRegistry?.providers?.find((entry) => {
		return matchesProviderId(entry.provider, providerId);
	})?.provider;
	if (activeProvider) return activeProvider;
}
function resolveProviderBinaryThinking(params) {
	return resolveActiveThinkingProvider(params.provider)?.isBinaryThinking?.(params.context);
}
function resolveProviderXHighThinking(params) {
	return resolveActiveThinkingProvider(params.provider)?.supportsXHighThinking?.(params.context);
}
function resolveProviderThinkingProfile(params) {
	const activeProfile = resolveActiveThinkingProvider(params.provider)?.resolveThinkingProfile?.(params.context);
	if (activeProfile) return activeProfile;
	return resolveBundledProviderPolicySurface(params.provider)?.resolveThinkingProfile?.(params.context);
}
function resolveProviderDefaultThinkingLevel(params) {
	return resolveActiveThinkingProvider(params.provider)?.resolveDefaultThinkingLevel?.(params.context);
}
//#endregion
//#region src/auto-reply/thinking.ts
function resolveThinkingPolicyContext(params) {
	const providerRaw = normalizeOptionalString(params.provider);
	const normalizedProvider = providerRaw ? normalizeProviderId(providerRaw) : "";
	const modelId = normalizeOptionalString(params.model) ?? "";
	const modelKey = normalizeOptionalLowercaseString(params.model) ?? "";
	const candidate = params.catalog?.find((entry) => normalizeProviderId(entry.provider) === normalizedProvider && entry.id === modelId);
	return {
		normalizedProvider,
		modelId,
		modelKey,
		reasoning: candidate?.reasoning,
		compat: candidate?.compat
	};
}
function catalogSupportsXHigh(compat) {
	const efforts = compat?.supportedReasoningEfforts;
	if (!Array.isArray(efforts)) return false;
	return efforts.some((effort) => normalizeThinkLevel(effort) === "xhigh");
}
function normalizeProfileLevel(level) {
	const normalized = normalizeThinkLevel(level.id);
	if (!normalized) return;
	return {
		id: normalized,
		label: normalizeOptionalString(level.label) ?? normalized,
		rank: Number.isFinite(level.rank) ? level.rank : THINKING_LEVEL_RANKS[normalized]
	};
}
function normalizeThinkingProfile(profile) {
	const byId = /* @__PURE__ */ new Map();
	for (const raw of profile.levels) {
		const level = normalizeProfileLevel(raw);
		if (level) byId.set(level.id, level);
	}
	const levels = [...byId.values()].toSorted((a, b) => a.rank - b.rank);
	const rawDefaultLevel = profile.defaultLevel ? normalizeThinkLevel(profile.defaultLevel) : void 0;
	return {
		levels,
		defaultLevel: rawDefaultLevel && byId.has(rawDefaultLevel) ? rawDefaultLevel : void 0
	};
}
function buildBaseThinkingProfile(defaultLevel) {
	return {
		levels: BASE_THINKING_LEVELS.map((id) => ({
			id,
			label: id,
			rank: THINKING_LEVEL_RANKS[id]
		})),
		defaultLevel
	};
}
function buildOffOnlyThinkingProfile() {
	return {
		levels: [{
			id: "off",
			label: "off",
			rank: THINKING_LEVEL_RANKS.off
		}],
		defaultLevel: "off"
	};
}
function buildBinaryThinkingProfile(defaultLevel) {
	return {
		levels: [{
			id: "off",
			label: "off",
			rank: THINKING_LEVEL_RANKS.off
		}, {
			id: "low",
			label: "on",
			rank: THINKING_LEVEL_RANKS.low
		}],
		defaultLevel
	};
}
function appendProfileLevel(profile, id) {
	if (profile.levels.some((level) => level.id === id)) return;
	profile.levels.push({
		id,
		label: id,
		rank: THINKING_LEVEL_RANKS[id]
	});
	profile.levels = profile.levels.toSorted((a, b) => a.rank - b.rank);
}
function resolveThinkingProfile(params) {
	const context = resolveThinkingPolicyContext(params);
	if (!context.normalizedProvider) return buildBaseThinkingProfile();
	const providerContext = {
		provider: context.normalizedProvider,
		modelId: context.modelId,
		reasoning: context.reasoning
	};
	const pluginProfile = resolveProviderThinkingProfile({
		provider: context.normalizedProvider,
		context: providerContext
	});
	if (pluginProfile) {
		const normalized = normalizeThinkingProfile(pluginProfile);
		if (normalized.levels.length > 0 && (context.reasoning !== false || pluginProfile.preserveWhenCatalogReasoningFalse === true)) return normalized;
	}
	if (context.reasoning === false) return buildOffOnlyThinkingProfile();
	const defaultLevel = resolveProviderDefaultThinkingLevel({
		provider: context.normalizedProvider,
		context: providerContext
	});
	const binaryDecision = resolveProviderBinaryThinking({
		provider: context.normalizedProvider,
		context: {
			provider: context.normalizedProvider,
			modelId: context.modelId
		}
	});
	const profile = binaryDecision === true ? buildBinaryThinkingProfile(defaultLevel) : buildBaseThinkingProfile(defaultLevel);
	if (binaryDecision !== true && catalogSupportsXHigh(context.compat)) appendProfileLevel(profile, "xhigh");
	const policyContext = {
		provider: context.normalizedProvider,
		modelId: context.modelKey || context.modelId
	};
	if (binaryDecision !== true && resolveProviderXHighThinking({
		provider: context.normalizedProvider,
		context: policyContext
	}) === true) appendProfileLevel(profile, "xhigh");
	return profile;
}
function supportsThinkingLevel(provider, model, level, catalog) {
	return resolveThinkingProfile({
		provider,
		model,
		catalog
	}).levels.some((entry) => entry.id === level);
}
function listThinkingLevels(provider, model, catalog) {
	return resolveThinkingProfile({
		provider,
		model,
		catalog
	}).levels.map((level) => level.id);
}
function listThinkingLevelOptions(provider, model, catalog) {
	return resolveThinkingProfile({
		provider,
		model,
		catalog
	}).levels.map(({ id, label }) => ({
		id,
		label
	}));
}
function listThinkingLevelLabels(provider, model, catalog) {
	return listThinkingLevelOptions(provider, model, catalog).map((level) => level.label);
}
function formatThinkingLevels(provider, model, separator = ", ", catalog) {
	return resolveThinkingProfile({
		provider,
		model,
		catalog
	}).levels.map(({ label }) => label).join(separator);
}
function resolveThinkingDefaultForModel(params) {
	const profile = resolveThinkingProfile({
		provider: params.provider,
		model: params.model,
		catalog: params.catalog
	});
	if (profile.defaultLevel) return profile.defaultLevel;
	if (resolveThinkingDefaultForModel$1(params) === "off") return "off";
	return resolveSupportedThinkingLevelFromProfile(profile, "medium");
}
function isThinkingLevelSupported(params) {
	return supportsThinkingLevel(params.provider, params.model, params.level, params.catalog);
}
function resolveSupportedThinkingLevelFromProfile(profile, level) {
	if (profile.levels.some((entry) => entry.id === level)) return level;
	const requestedRank = THINKING_LEVEL_RANKS[level];
	const ranked = profile.levels.toSorted((a, b) => b.rank - a.rank);
	return ranked.find((entry) => entry.id !== "off" && entry.rank <= requestedRank)?.id ?? ranked.find((entry) => entry.id !== "off")?.id ?? "off";
}
function resolveSupportedThinkingLevel(params) {
	return resolveSupportedThinkingLevelFromProfile(resolveThinkingProfile({
		provider: params.provider,
		model: params.model,
		catalog: params.catalog
	}), params.level);
}
//#endregion
export { resolveResponseUsageMode as _, listThinkingLevels as a, resolveThinkingProfile as c, normalizeElevatedLevel as d, normalizeReasoningLevel as f, normalizeVerboseLevel as g, normalizeUsageDisplay as h, listThinkingLevelOptions as i, BASE_THINKING_LEVELS as l, normalizeTraceLevel as m, isThinkingLevelSupported as n, resolveSupportedThinkingLevel as o, normalizeThinkLevel as p, listThinkingLevelLabels as r, resolveThinkingDefaultForModel as s, formatThinkingLevels as t, isSessionDefaultDirectiveValue as u, resolveBundledProviderPolicySurface as v };
