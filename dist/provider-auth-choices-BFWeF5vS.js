import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { c as resolveEffectiveEnableState, s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
//#region src/plugins/provider-auth-choices.ts
const PROVIDER_AUTH_CHOICE_ORIGIN_PRIORITY = {
	config: 0,
	bundled: 1,
	global: 2,
	workspace: 3
};
const DESCRIPTOR_LABEL_ACRONYMS = new Map([
	["api", "API"],
	["jwt", "JWT"],
	["oauth", "OAuth"],
	["oidc", "OIDC"],
	["pkce", "PKCE"],
	["saml", "SAML"],
	["sso", "SSO"]
]);
function resolveProviderAuthChoiceOriginPriority(origin) {
	if (!origin) return Number.MAX_SAFE_INTEGER;
	return PROVIDER_AUTH_CHOICE_ORIGIN_PRIORITY[origin] ?? Number.MAX_SAFE_INTEGER;
}
function toProviderAuthChoiceCandidate(params) {
	const { pluginId, origin, choice } = params;
	return {
		pluginId,
		origin,
		providerId: choice.provider,
		methodId: choice.method,
		choiceId: choice.choiceId,
		choiceLabel: choice.choiceLabel ?? choice.choiceId,
		...choice.choiceHint ? { choiceHint: choice.choiceHint } : {},
		...choice.assistantPriority !== void 0 ? { assistantPriority: choice.assistantPriority } : {},
		...choice.assistantVisibility ? { assistantVisibility: choice.assistantVisibility } : {},
		...choice.deprecatedChoiceIds ? { deprecatedChoiceIds: choice.deprecatedChoiceIds } : {},
		...choice.groupId ? { groupId: choice.groupId } : {},
		...choice.groupLabel ? { groupLabel: choice.groupLabel } : {},
		...choice.groupHint ? { groupHint: choice.groupHint } : {},
		...choice.onboardingFeatured ? { onboardingFeatured: true } : {},
		...choice.optionKey ? { optionKey: choice.optionKey } : {},
		...choice.cliFlag ? { cliFlag: choice.cliFlag } : {},
		...choice.cliOption ? { cliOption: choice.cliOption } : {},
		...choice.cliDescription ? { cliDescription: choice.cliDescription } : {},
		...choice.onboardingScopes ? { onboardingScopes: choice.onboardingScopes } : {}
	};
}
function formatDescriptorLabel(value) {
	return sanitizeForLog(value).trim().split(/[-_\s]+/gu).filter(Boolean).map((part) => {
		const lower = part.toLowerCase();
		const acronym = DESCRIPTOR_LABEL_ACRONYMS.get(lower);
		if (acronym) return acronym;
		return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
	}).join(" ");
}
function normalizeManifestAuthDescriptorId(value) {
	return sanitizeForLog(value).trim();
}
function toSetupProviderAuthChoiceCandidate(params) {
	const providerLabel = formatDescriptorLabel(params.providerId);
	const methodLabel = formatDescriptorLabel(params.methodId);
	const choiceLabel = params.methodId === "api-key" ? `${providerLabel} API key` : `${providerLabel} ${methodLabel}`;
	return {
		pluginId: params.plugin.id,
		origin: params.plugin.origin,
		providerId: params.providerId,
		methodId: params.methodId,
		choiceId: `${params.providerId}-${params.methodId}`,
		choiceLabel,
		groupId: params.providerId,
		groupLabel: providerLabel
	};
}
function listSetupProviderAuthChoiceCandidates(plugin) {
	if (plugin.setup?.requiresRuntime !== false && plugin.setupSource) return [];
	const explicitProviderMethods = new Set((plugin.providerAuthChoices ?? []).map((choice) => `${choice.provider}::${choice.method}`));
	return (plugin.setup?.providers ?? []).flatMap((provider) => {
		const providerId = normalizeManifestAuthDescriptorId(provider.id);
		if (!providerId) return [];
		return (provider.authMethods ?? []).map(normalizeManifestAuthDescriptorId).filter(Boolean).filter((methodId) => !explicitProviderMethods.has(`${providerId}::${methodId}`)).map((methodId) => toSetupProviderAuthChoiceCandidate({
			plugin,
			providerId,
			methodId
		}));
	});
}
function stripChoiceOrigin(choice) {
	const { origin: _origin, ...metadata } = choice;
	return metadata;
}
function resolveManifestProviderAuthChoiceCandidates(params) {
	const registry = loadManifestMetadataSnapshot({
		config: params?.config ?? {},
		workspaceDir: params?.workspaceDir,
		env: params?.env ?? process.env
	}).manifestRegistry;
	const normalizedConfig = normalizePluginsConfig(params?.config?.plugins);
	return registry.plugins.flatMap((plugin) => {
		if (plugin.origin === "workspace" && params?.includeUntrustedWorkspacePlugins === false && !resolveEffectiveEnableState({
			id: plugin.id,
			origin: plugin.origin,
			config: normalizedConfig,
			rootConfig: params?.config
		}).enabled) return [];
		const choices = [];
		for (const choice of plugin.providerAuthChoices ?? []) choices.push(toProviderAuthChoiceCandidate({
			pluginId: plugin.id,
			origin: plugin.origin,
			choice
		}));
		choices.push(...listSetupProviderAuthChoiceCandidates(plugin));
		return choices;
	});
}
function pickPreferredManifestAuthChoice(candidates) {
	let preferred;
	for (const candidate of candidates) {
		if (!preferred) {
			preferred = candidate;
			continue;
		}
		if (resolveProviderAuthChoiceOriginPriority(candidate.origin) < resolveProviderAuthChoiceOriginPriority(preferred.origin)) preferred = candidate;
	}
	return preferred;
}
function resolvePreferredManifestAuthChoicesByChoiceId(candidates) {
	const preferredByChoiceId = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const normalizedChoiceId = candidate.choiceId.trim();
		if (!normalizedChoiceId) continue;
		const existing = preferredByChoiceId.get(normalizedChoiceId);
		if (!existing || resolveProviderAuthChoiceOriginPriority(candidate.origin) < resolveProviderAuthChoiceOriginPriority(existing.origin)) preferredByChoiceId.set(normalizedChoiceId, candidate);
	}
	return [...preferredByChoiceId.values()];
}
function resolvePreferredManifestAuthChoiceMetadata(params) {
	const preferred = pickPreferredManifestAuthChoice(resolveManifestProviderAuthChoiceCandidates(params.config).filter(params.matches));
	return preferred ? stripChoiceOrigin(preferred) : void 0;
}
function resolveManifestProviderAuthChoices(params) {
	return resolvePreferredManifestAuthChoicesByChoiceId(resolveManifestProviderAuthChoiceCandidates(params)).map(stripChoiceOrigin);
}
function resolveManifestProviderAuthChoice(choiceId, params) {
	const normalized = choiceId.trim();
	if (!normalized) return;
	return resolvePreferredManifestAuthChoiceMetadata({
		config: params,
		matches: (choice) => choice.choiceId === normalized
	});
}
function resolveManifestProviderApiKeyChoice(params) {
	const normalizedProviderId = resolveProviderIdForAuth(params.providerId, params);
	if (!normalizedProviderId) return;
	return resolvePreferredManifestAuthChoiceMetadata({
		config: params,
		matches: (choice) => Boolean(choice.optionKey) && resolveProviderIdForAuth(choice.providerId, params) === normalizedProviderId
	});
}
function resolveManifestDeprecatedProviderAuthChoice(choiceId, params) {
	const normalized = choiceId.trim();
	if (!normalized) return;
	return resolvePreferredManifestAuthChoiceMetadata({
		config: params,
		matches: (choice) => choice.deprecatedChoiceIds?.includes(normalized) === true
	});
}
function resolveManifestProviderOnboardAuthFlags(params) {
	const preferredByFlag = /* @__PURE__ */ new Map();
	for (const choice of resolveManifestProviderAuthChoiceCandidates(params)) {
		if (!choice.optionKey || !choice.cliFlag || !choice.cliOption) continue;
		const normalizedChoice = {
			...choice,
			optionKey: choice.optionKey,
			cliFlag: choice.cliFlag,
			cliOption: choice.cliOption
		};
		const dedupeKey = `${choice.optionKey}::${choice.cliFlag}`;
		const existing = preferredByFlag.get(dedupeKey);
		if (existing && resolveProviderAuthChoiceOriginPriority(normalizedChoice.origin) >= resolveProviderAuthChoiceOriginPriority(existing.origin)) continue;
		preferredByFlag.set(dedupeKey, normalizedChoice);
	}
	const flags = [];
	for (const choice of preferredByFlag.values()) flags.push({
		optionKey: choice.optionKey,
		authChoice: choice.choiceId,
		cliFlag: choice.cliFlag,
		cliOption: choice.cliOption,
		description: choice.cliDescription ?? choice.choiceLabel
	});
	return flags;
}
//#endregion
export { resolveManifestProviderOnboardAuthFlags as a, resolveManifestProviderAuthChoices as i, resolveManifestProviderApiKeyChoice as n, resolveManifestProviderAuthChoice as r, resolveManifestDeprecatedProviderAuthChoice as t };
