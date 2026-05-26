import { c as resolveEffectiveEnableState, s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { i as resolveManifestProviderAuthChoices } from "./provider-auth-choices-BFWeF5vS.js";
import { t as resolveProviderInstallCatalogEntries } from "./provider-install-catalog-BboFtl6M.js";
import { t as sortFlowContributionsByLabel } from "./types-4-OhJSR5.js";
import { a as resolveLegacyAuthChoiceAliasesForCli } from "./auth-choice-legacy-CQCT2gkW.js";
//#region src/flows/provider-flow.ts
const DEFAULT_PROVIDER_FLOW_SCOPE = "text-inference";
function includesProviderFlowScope(scopes, scope) {
	return scopes ? scopes.includes(scope) : scope === DEFAULT_PROVIDER_FLOW_SCOPE;
}
function resolveInstallCatalogProviderSetupFlowContributions(params) {
	const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
	const normalizedPluginsConfig = normalizePluginsConfig(params?.config?.plugins);
	return resolveProviderInstallCatalogEntries({
		...params,
		includeUntrustedWorkspacePlugins: false
	}).filter((entry) => includesProviderFlowScope(entry.onboardingScopes, scope) && resolveEffectiveEnableState({
		id: entry.pluginId,
		origin: entry.origin,
		config: normalizedPluginsConfig,
		rootConfig: params?.config,
		enabledByDefault: true
	}).enabled).map((entry) => {
		const groupId = entry.groupId ?? entry.providerId;
		const groupLabel = entry.groupLabel ?? entry.label;
		return Object.assign({
			id: `provider:setup:${entry.choiceId}`,
			kind: `provider`,
			surface: `setup`,
			providerId: entry.providerId,
			pluginId: entry.pluginId,
			option: {
				value: entry.choiceId,
				label: entry.choiceLabel,
				...entry.choiceHint ? { hint: entry.choiceHint } : {},
				...entry.assistantPriority !== void 0 ? { assistantPriority: entry.assistantPriority } : {},
				...entry.assistantVisibility ? { assistantVisibility: entry.assistantVisibility } : {},
				group: {
					id: groupId,
					label: groupLabel,
					...entry.groupHint ? { hint: entry.groupHint } : {}
				}
			}
		}, entry.onboardingScopes ? { onboardingScopes: [...entry.onboardingScopes] } : {}, { source: `install-catalog` });
	});
}
function resolveManifestProviderSetupFlowContributions(params) {
	const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
	return resolveManifestProviderAuthChoices({
		...params,
		includeUntrustedWorkspacePlugins: false
	}).filter((choice) => includesProviderFlowScope(choice.onboardingScopes, scope)).map((choice) => {
		const groupId = choice.groupId ?? choice.providerId;
		const groupLabel = choice.groupLabel ?? choice.choiceLabel;
		return Object.assign({
			id: `provider:setup:${choice.choiceId}`,
			kind: `provider`,
			surface: `setup`,
			providerId: choice.providerId,
			pluginId: choice.pluginId,
			option: {
				value: choice.choiceId,
				label: choice.choiceLabel,
				...choice.choiceHint ? { hint: choice.choiceHint } : {},
				...choice.assistantPriority !== void 0 ? { assistantPriority: choice.assistantPriority } : {},
				...choice.assistantVisibility ? { assistantVisibility: choice.assistantVisibility } : {},
				...choice.onboardingFeatured ? { onboardingFeatured: true } : {},
				group: {
					id: groupId,
					label: groupLabel,
					...choice.groupHint ? { hint: choice.groupHint } : {}
				}
			}
		}, choice.onboardingScopes ? { onboardingScopes: [...choice.onboardingScopes] } : {}, { source: `manifest` });
	});
}
function resolveProviderSetupFlowContributions(params) {
	const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
	const manifestContributions = resolveManifestProviderSetupFlowContributions({
		...params,
		scope
	});
	const seenOptionValues = new Set(manifestContributions.map((contribution) => contribution.option.value));
	const installCatalogContributions = resolveInstallCatalogProviderSetupFlowContributions({
		...params,
		scope
	}).filter((contribution) => !seenOptionValues.has(contribution.option.value));
	return sortFlowContributionsByLabel([...manifestContributions, ...installCatalogContributions]);
}
//#endregion
//#region src/commands/auth-choice-options.static.ts
const CORE_AUTH_CHOICE_OPTIONS = [{
	value: "custom-api-key",
	label: "Custom Provider",
	hint: "Any OpenAI or Anthropic compatible endpoint",
	groupId: "custom",
	groupLabel: "Custom Provider",
	groupHint: "Any OpenAI or Anthropic compatible endpoint"
}];
function formatStaticAuthChoiceChoicesForCli(params) {
	const includeSkip = params?.includeSkip ?? true;
	const includeLegacyAliases = params?.includeLegacyAliases ?? false;
	const values = CORE_AUTH_CHOICE_OPTIONS.map((opt) => opt.value);
	if (includeSkip) values.push("skip");
	if (includeLegacyAliases) values.push(...resolveLegacyAuthChoiceAliasesForCli(params));
	return values.join("|");
}
//#endregion
//#region src/commands/auth-choice-options.ts
function compareOptionLabels(a, b) {
	return a.label.localeCompare(b.label);
}
const FEATURED_AUTH_GROUP_ORDER = new Map([
	["openai", 0],
	["anthropic", 1],
	["xai", 2],
	["google", 3]
]);
function compareAssistantOptions(a, b) {
	return (a.assistantPriority ?? 0) - (b.assistantPriority ?? 0) || compareOptionLabels(a, b);
}
function compareLabelsCaseInsensitive(a, b) {
	return a.localeCompare(b, void 0, { sensitivity: "base" });
}
function compareAuthChoiceGroups(a, b) {
	return (FEATURED_AUTH_GROUP_ORDER.get(a.value) ?? Number.POSITIVE_INFINITY) - (FEATURED_AUTH_GROUP_ORDER.get(b.value) ?? Number.POSITIVE_INFINITY) || compareLabelsCaseInsensitive(a.label, b.label) || compareLabelsCaseInsensitive(a.value, b.value);
}
function resolveProviderChoiceOptions(params) {
	return resolveProviderSetupFlowContributions({
		...params,
		scope: "text-inference"
	}).map((contribution) => Object.assign({}, {
		value: contribution.option.value,
		label: contribution.option.label
	}, contribution.option.hint ? { hint: contribution.option.hint } : {}, contribution.option.assistantPriority !== void 0 ? { assistantPriority: contribution.option.assistantPriority } : {}, contribution.option.assistantVisibility ? { assistantVisibility: contribution.option.assistantVisibility } : {}, contribution.option.group ? {
		groupId: contribution.option.group.id,
		groupLabel: contribution.option.group.label,
		...contribution.option.group.hint ? { groupHint: contribution.option.group.hint } : {}
	} : {}, contribution.option.onboardingFeatured ? { onboardingFeatured: true } : {}));
}
function formatAuthChoiceChoicesForCli(params) {
	const values = [...formatStaticAuthChoiceChoicesForCli(params).split("|"), ...resolveProviderSetupFlowContributions({
		...params,
		scope: "text-inference"
	}).map((contribution) => contribution.option.value)];
	return [...new Set(values)].join("|");
}
function buildAuthChoiceOptions(params) {
	params.store;
	const optionByValue = /* @__PURE__ */ new Map();
	for (const option of CORE_AUTH_CHOICE_OPTIONS) optionByValue.set(option.value, option);
	for (const option of resolveProviderChoiceOptions({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	})) optionByValue.set(option.value, option);
	const options = Array.from(optionByValue.values()).toSorted(compareOptionLabels).filter((option) => params.assistantVisibleOnly ? option.assistantVisibility !== "manual-only" : true);
	if (params.includeSkip) options.push({
		value: "skip",
		label: "Skip for now"
	});
	return options;
}
function buildAuthChoiceGroups(params) {
	const options = buildAuthChoiceOptions({
		...params,
		includeSkip: false,
		assistantVisibleOnly: true
	});
	const groupsById = /* @__PURE__ */ new Map();
	for (const option of options) {
		if (!option.groupId || !option.groupLabel) continue;
		const existing = groupsById.get(option.groupId);
		if (existing) {
			existing.options.push(option);
			continue;
		}
		groupsById.set(option.groupId, {
			value: option.groupId,
			label: option.groupLabel,
			...option.groupHint ? { hint: option.groupHint } : {},
			options: [option]
		});
	}
	return {
		groups: Array.from(groupsById.values()).map((group) => Object.assign({}, group, { options: [...group.options].toSorted(compareAssistantOptions) })).toSorted(compareAuthChoiceGroups),
		skipOption: params.includeSkip ? {
			value: "skip",
			label: "Skip for now"
		} : void 0
	};
}
//#endregion
export { compareAuthChoiceGroups as n, formatAuthChoiceChoicesForCli as r, buildAuthChoiceGroups as t };
