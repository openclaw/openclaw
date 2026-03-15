import { o as resolveManifestProviderAuthChoices, t as AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI } from "./auth-choice-legacy-aidPRzV-.js";
import { a as resolveProviderWizardOptions } from "./provider-wizard-C9NLHf1_.js";
//#region src/commands/auth-choice-options.static.ts
const CORE_AUTH_CHOICE_OPTIONS = [
	{
		value: "chutes",
		label: "Chutes (OAuth)",
		groupId: "chutes",
		groupLabel: "Chutes",
		groupHint: "OAuth"
	},
	{
		value: "litellm-api-key",
		label: "LiteLLM API key",
		hint: "Unified gateway for 100+ LLM providers",
		groupId: "litellm",
		groupLabel: "LiteLLM",
		groupHint: "Unified LLM gateway (100+ providers)"
	},
	{
		value: "custom-api-key",
		label: "Custom Provider",
		hint: "Any OpenAI or Anthropic compatible endpoint",
		groupId: "custom",
		groupLabel: "Custom Provider",
		groupHint: "Any OpenAI or Anthropic compatible endpoint"
	}
];
function formatStaticAuthChoiceChoicesForCli(params) {
	const includeSkip = params?.includeSkip ?? true;
	const includeLegacyAliases = params?.includeLegacyAliases ?? false;
	const values = CORE_AUTH_CHOICE_OPTIONS.map((opt) => opt.value);
	if (includeSkip) {values.push("skip");}
	if (includeLegacyAliases) {values.push(...AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI);}
	return values.join("|");
}
//#endregion
//#region src/commands/auth-choice-options.ts
function compareOptionLabels(a, b) {
	return a.label.localeCompare(b.label);
}
function compareGroupLabels(a, b) {
	return a.label.localeCompare(b.label);
}
function resolveManifestProviderChoiceOptions(params) {
	return resolveManifestProviderAuthChoices(params ?? {}).map((choice) => ({
		value: choice.choiceId,
		label: choice.choiceLabel,
		...choice.choiceHint ? { hint: choice.choiceHint } : {},
		...choice.groupId ? { groupId: choice.groupId } : {},
		...choice.groupLabel ? { groupLabel: choice.groupLabel } : {},
		...choice.groupHint ? { groupHint: choice.groupHint } : {}
	}));
}
function resolveRuntimeFallbackProviderChoiceOptions(params) {
	return resolveProviderWizardOptions(params ?? {}).map((option) => ({
		value: option.value,
		label: option.label,
		...option.hint ? { hint: option.hint } : {},
		groupId: option.groupId,
		groupLabel: option.groupLabel,
		...option.groupHint ? { groupHint: option.groupHint } : {}
	}));
}
function formatAuthChoiceChoicesForCli(params) {
	const values = [...formatStaticAuthChoiceChoicesForCli(params).split("|"), ...resolveManifestProviderChoiceOptions(params).map((option) => option.value)];
	return [...new Set(values)].join("|");
}
function buildAuthChoiceOptions(params) {
	params.store;
	const optionByValue = /* @__PURE__ */ new Map();
	for (const option of CORE_AUTH_CHOICE_OPTIONS) {optionByValue.set(option.value, option);}
	for (const option of resolveManifestProviderChoiceOptions({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	})) {optionByValue.set(option.value, option);}
	for (const option of resolveRuntimeFallbackProviderChoiceOptions({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	})) {if (!optionByValue.has(option.value)) optionByValue.set(option.value, option);}
	const options = Array.from(optionByValue.values()).toSorted(compareOptionLabels);
	if (params.includeSkip) {options.push({
		value: "skip",
		label: "Skip for now"
	});}
	return options;
}
function buildAuthChoiceGroups(params) {
	const options = buildAuthChoiceOptions({
		...params,
		includeSkip: false
	});
	const groupsById = /* @__PURE__ */ new Map();
	for (const option of options) {
		if (!option.groupId || !option.groupLabel) {continue;}
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
		groups: Array.from(groupsById.values()).map((group) => ({
			...group,
			options: [...group.options].toSorted(compareOptionLabels)
		})).toSorted(compareGroupLabels),
		skipOption: params.includeSkip ? {
			value: "skip",
			label: "Skip for now"
		} : void 0
	};
}
//#endregion
export { formatAuthChoiceChoicesForCli as n, buildAuthChoiceGroups as t };
