import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { i as resolvePluginSetupProvider } from "./setup-registry-DHllMAAd.js";
import { n as resolvePluginProviders } from "./providers.runtime-CsXUlav0.js";
import "./model-selection-P-81eBKx.js";
//#region src/plugins/provider-wizard.ts
const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";
let providerWizardProvidersResolverForTest;
function setProviderWizardProvidersResolverForTest(resolver) {
	const previous = providerWizardProvidersResolverForTest;
	providerWizardProvidersResolverForTest = resolver;
	return () => {
		providerWizardProvidersResolverForTest = previous;
	};
}
function resolveWizardSetupChoiceId(provider, wizard) {
	const explicit = normalizeOptionalString(wizard.choiceId);
	if (explicit) return explicit;
	const explicitMethodId = normalizeOptionalString(wizard.methodId);
	if (explicitMethodId) return buildProviderPluginMethodChoice(provider.id, explicitMethodId);
	if (provider.auth.length === 1) return provider.id;
	return buildProviderPluginMethodChoice(provider.id, provider.auth[0]?.id ?? "default");
}
function resolveMethodById(provider, methodId) {
	const normalizedMethodId = normalizeOptionalLowercaseString(methodId);
	if (!normalizedMethodId) return provider.auth[0];
	return provider.auth.find((method) => normalizeOptionalLowercaseString(method.id) === normalizedMethodId);
}
function listMethodWizardSetups(provider) {
	return provider.auth.map((method) => method.wizard ? {
		method,
		wizard: method.wizard
	} : null).filter((entry) => Boolean(entry));
}
function buildSetupOptionForMethod(params) {
	const normalizedGroupId = normalizeOptionalString(params.wizard.groupId) || params.provider.id;
	return {
		value: normalizeOptionalString(params.value) ?? "",
		label: normalizeOptionalString(params.wizard.choiceLabel) || (params.provider.auth.length === 1 ? params.provider.label : params.method.label),
		hint: normalizeOptionalString(params.wizard.choiceHint) || params.method.hint,
		groupId: normalizedGroupId,
		groupLabel: normalizeOptionalString(params.wizard.groupLabel) || params.provider.label,
		groupHint: normalizeOptionalString(params.wizard.groupHint),
		...params.wizard.onboardingScopes ? { onboardingScopes: params.wizard.onboardingScopes } : {},
		...typeof params.wizard.assistantPriority === "number" && Number.isFinite(params.wizard.assistantPriority) ? { assistantPriority: params.wizard.assistantPriority } : {},
		...params.wizard.assistantVisibility ? { assistantVisibility: params.wizard.assistantVisibility } : {},
		...params.wizard.onboardingFeatured ? { onboardingFeatured: true } : {}
	};
}
function buildProviderPluginMethodChoice(providerId, methodId) {
	return `${PROVIDER_PLUGIN_CHOICE_PREFIX}${normalizeOptionalString(providerId) ?? ""}:${normalizeOptionalString(methodId) ?? ""}`;
}
function resolveProviderWizardProviders(params) {
	if (providerWizardProvidersResolverForTest) return providerWizardProvidersResolverForTest(params);
	return resolvePluginProviders({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		mode: "setup"
	});
}
function resolveProviderWizardOptions(params) {
	const providers = resolveProviderWizardProviders(params);
	const options = [];
	for (const provider of providers) {
		const methodSetups = listMethodWizardSetups(provider);
		for (const { method, wizard } of methodSetups) options.push(buildSetupOptionForMethod({
			provider,
			wizard,
			method,
			value: normalizeOptionalString(wizard.choiceId) || buildProviderPluginMethodChoice(provider.id, method.id)
		}));
		if (methodSetups.length > 0) continue;
		const setup = provider.wizard?.setup;
		if (!setup) continue;
		const explicitMethod = resolveMethodById(provider, setup.methodId);
		if (explicitMethod) {
			options.push(buildSetupOptionForMethod({
				provider,
				wizard: setup,
				method: explicitMethod,
				value: resolveWizardSetupChoiceId(provider, setup)
			}));
			continue;
		}
		for (const method of provider.auth) options.push(buildSetupOptionForMethod({
			provider,
			wizard: setup,
			method,
			value: buildProviderPluginMethodChoice(provider.id, method.id)
		}));
	}
	return options;
}
function resolveModelPickerChoiceValue(provider, modelPicker) {
	const explicitMethodId = normalizeOptionalString(modelPicker.methodId);
	if (explicitMethodId) return buildProviderPluginMethodChoice(provider.id, explicitMethodId);
	if (provider.auth.length === 1) return provider.id;
	return buildProviderPluginMethodChoice(provider.id, provider.auth[0]?.id ?? "default");
}
function resolveProviderModelPickerEntries(params) {
	const providers = resolveProviderWizardProviders(params);
	const entries = [];
	for (const provider of providers) {
		const modelPicker = provider.wizard?.modelPicker;
		if (!modelPicker) continue;
		entries.push({
			value: resolveModelPickerChoiceValue(provider, modelPicker),
			label: normalizeOptionalString(modelPicker.label) || `${provider.label} (custom)`,
			hint: normalizeOptionalString(modelPicker.hint)
		});
	}
	return entries;
}
function resolveProviderPluginChoice(params) {
	const choice = normalizeOptionalString(params.choice) ?? "";
	if (!choice) return null;
	if (choice.startsWith(PROVIDER_PLUGIN_CHOICE_PREFIX)) {
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
		for (const { method, wizard } of listMethodWizardSetups(provider)) if ((normalizeOptionalString(normalizeOptionalString(wizard.choiceId) || buildProviderPluginMethodChoice(provider.id, method.id)) ?? "") === choice) return {
			provider,
			method,
			wizard
		};
		const setup = provider.wizard?.setup;
		if (setup) {
			if ((normalizeOptionalString(resolveWizardSetupChoiceId(provider, setup)) ?? "") === choice) {
				const method = resolveMethodById(provider, setup.methodId);
				if (method) return {
					provider,
					method,
					wizard: setup
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
	const rawModel = params.model.trim();
	if (!rawModel) return;
	const slashIndex = rawModel.indexOf("/");
	const selectedProviderId = slashIndex === -1 ? DEFAULT_PROVIDER : normalizeProviderId(rawModel.slice(0, slashIndex).trim());
	if (!selectedProviderId || slashIndex !== -1 && !rawModel.slice(slashIndex + 1).trim()) return;
	const provider = resolvePluginSetupProvider({
		provider: selectedProviderId,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}) ?? resolveProviderWizardProviders({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}).find((entry) => normalizeProviderId(entry.id) === selectedProviderId);
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
export { runProviderModelSelectedHook as a, resolveProviderWizardOptions as i, resolveProviderModelPickerEntries as n, setProviderWizardProvidersResolverForTest as o, resolveProviderPluginChoice as r, buildProviderPluginMethodChoice as t };
