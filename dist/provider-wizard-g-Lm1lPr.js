import { A as normalizeProviderId, B as resolvePluginProviders, Kv as DEFAULT_PROVIDER, j as parseModelRef } from "./reply-kqyKJg4x.js";
//#region src/plugins/provider-wizard.ts
const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";
function normalizeChoiceId(choiceId) {
	return choiceId.trim();
}
function resolveWizardOnboardingChoiceId(provider, wizard) {
	const explicit = wizard.choiceId?.trim();
	if (explicit) return explicit;
	const explicitMethodId = wizard.methodId?.trim();
	if (explicitMethodId) return buildProviderPluginMethodChoice(provider.id, explicitMethodId);
	if (provider.auth.length === 1) return provider.id;
	return buildProviderPluginMethodChoice(provider.id, provider.auth[0]?.id ?? "default");
}
function resolveMethodById(provider, methodId) {
	const normalizedMethodId = methodId?.trim().toLowerCase();
	if (!normalizedMethodId) return provider.auth[0];
	return provider.auth.find((method) => method.id.trim().toLowerCase() === normalizedMethodId);
}
function buildOnboardingOptionForMethod(params) {
	const normalizedGroupId = params.wizard.groupId?.trim() || params.provider.id;
	return {
		value: normalizeChoiceId(params.value),
		label: params.wizard.choiceLabel?.trim() || (params.provider.auth.length === 1 ? params.provider.label : params.method.label),
		hint: params.wizard.choiceHint?.trim() || params.method.hint,
		groupId: normalizedGroupId,
		groupLabel: params.wizard.groupLabel?.trim() || params.provider.label,
		groupHint: params.wizard.groupHint?.trim()
	};
}
function buildProviderPluginMethodChoice(providerId, methodId) {
	return `${PROVIDER_PLUGIN_CHOICE_PREFIX}${providerId.trim()}:${methodId.trim()}`;
}
function resolveProviderWizardOptions(params) {
	const providers = resolvePluginProviders(params);
	const options = [];
	for (const provider of providers) {
		const wizard = provider.wizard?.onboarding;
		if (!wizard) continue;
		const explicitMethod = resolveMethodById(provider, wizard.methodId);
		if (explicitMethod) {
			options.push(buildOnboardingOptionForMethod({
				provider,
				wizard,
				method: explicitMethod,
				value: resolveWizardOnboardingChoiceId(provider, wizard)
			}));
			continue;
		}
		for (const method of provider.auth) options.push(buildOnboardingOptionForMethod({
			provider,
			wizard,
			method,
			value: buildProviderPluginMethodChoice(provider.id, method.id)
		}));
	}
	return options;
}
function resolveModelPickerChoiceValue(provider, modelPicker) {
	const explicitMethodId = modelPicker.methodId?.trim();
	if (explicitMethodId) return buildProviderPluginMethodChoice(provider.id, explicitMethodId);
	if (provider.auth.length === 1) return provider.id;
	return buildProviderPluginMethodChoice(provider.id, provider.auth[0]?.id ?? "default");
}
function resolveProviderModelPickerEntries(params) {
	const providers = resolvePluginProviders(params);
	const entries = [];
	for (const provider of providers) {
		const modelPicker = provider.wizard?.modelPicker;
		if (!modelPicker) continue;
		entries.push({
			value: resolveModelPickerChoiceValue(provider, modelPicker),
			label: modelPicker.label?.trim() || `${provider.label} (custom)`,
			hint: modelPicker.hint?.trim()
		});
	}
	return entries;
}
function resolveProviderPluginChoice(params) {
	const choice = params.choice.trim();
	if (!choice) return null;
	if (choice.startsWith("provider-plugin:")) {
		const payload = choice.slice(16);
		const separator = payload.indexOf(":");
		const providerId = separator >= 0 ? payload.slice(0, separator) : payload;
		const methodId = separator >= 0 ? payload.slice(separator + 1) : void 0;
		const provider = params.providers.find((entry) => normalizeProviderId(entry.id) === normalizeProviderId(providerId));
		if (!provider) return null;
		const method = resolveMethodById(provider, methodId);
		return method ? {
			provider,
			method
		} : null;
	}
	for (const provider of params.providers) {
		const onboarding = provider.wizard?.onboarding;
		if (onboarding) {
			if (normalizeChoiceId(resolveWizardOnboardingChoiceId(provider, onboarding)) === choice) {
				const method = resolveMethodById(provider, onboarding.methodId);
				if (method) return {
					provider,
					method
				};
			}
		}
		if (normalizeProviderId(provider.id) === normalizeProviderId(choice) && provider.auth.length > 0) return {
			provider,
			method: provider.auth[0]
		};
	}
	return null;
}
async function runProviderModelSelectedHook(params) {
	const parsed = parseModelRef(params.model, DEFAULT_PROVIDER);
	if (!parsed) return;
	const provider = resolvePluginProviders({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}).find((entry) => normalizeProviderId(entry.id) === normalizeProviderId(parsed.provider));
	if (!provider?.onModelSelected) return;
	await provider.onModelSelected({
		config: params.config,
		model: params.model,
		prompter: params.prompter,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir
	});
}
//#endregion
export { runProviderModelSelectedHook as a, resolveProviderWizardOptions as i, resolveProviderModelPickerEntries as n, resolveProviderPluginChoice as r, PROVIDER_PLUGIN_CHOICE_PREFIX as t };
