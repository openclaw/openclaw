import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { d as normalizeSecretInputString, s as hasConfiguredSecretInput, t as DEFAULT_SECRET_PROVIDER_ALIAS } from "./types.secrets-BxqheYvy.js";
import { c as resolveEffectiveEnableState, s as normalizePluginsConfig } from "./config-state-BgyjpLHd.js";
import { t as enablePluginInConfig } from "./enable-Cnmqb24T.js";
import { t as resolveWebSearchInstallCatalogEntries } from "./web-search-install-catalog-BQeH4Lj_.js";
import { n as sortWebSearchProviders } from "./web-search-providers.shared-CBtkAMOu.js";
import { t as resolvePluginWebSearchProviders } from "./web-search-providers.runtime.js";
import { t as sortFlowContributionsByLabel } from "./types-DZV4ilD2.js";
//#region src/flows/search-setup.ts
const SEARCH_INSTALL_CATALOG_ENTRY = Symbol("search-install-catalog-entry");
function resolveSearchProviderCredentialLabel(entry) {
	if (entry.requiresCredential === false) return `${entry.label} setup`;
	return normalizeOptionalString(entry.credentialLabel) || `${entry.label} API key`;
}
function listSearchProviderOptions(config) {
	return resolveSearchProviderOptions(config);
}
function showsSearchProviderInSetup(entry) {
	return entry.onboardingScopes?.includes("text-inference") ?? false;
}
function resolveSearchProviderOptions(config) {
	return resolveSearchProviderSetupContributions(config).map((contribution) => contribution.provider);
}
function buildSearchProviderSetupContribution(params) {
	return {
		id: `search:setup:${params.provider.id}`,
		kind: "search",
		surface: "setup",
		provider: params.provider,
		option: {
			value: params.provider.id,
			label: params.provider.label,
			...params.provider.hint ? { hint: params.provider.hint } : {},
			...params.provider.docsUrl ? { docs: { path: params.provider.docsUrl } } : {}
		},
		source: params.source
	};
}
function resolveSearchProviderSetupContributions(config) {
	const runtimeProviders = sortWebSearchProviders(resolvePluginWebSearchProviders({
		config,
		env: process.env,
		mode: "setup"
	}));
	const seenProviderIds = new Set(runtimeProviders.map((provider) => provider.id));
	const seenPluginIds = new Set(runtimeProviders.map((provider) => provider.pluginId));
	const normalizedPluginsConfig = normalizePluginsConfig(config?.plugins);
	const installCatalogProviders = resolveWebSearchInstallCatalogEntries().filter((entry) => !seenProviderIds.has(entry.provider.id) && !seenPluginIds.has(entry.pluginId) && resolveEffectiveEnableState({
		id: entry.pluginId,
		origin: "global",
		config: normalizedPluginsConfig,
		rootConfig: config,
		enabledByDefault: true
	}).enabled).map((entry) => Object.assign({}, entry.provider, { [SEARCH_INSTALL_CATALOG_ENTRY]: entry }));
	return sortFlowContributionsByLabel(sortWebSearchProviders([...runtimeProviders, ...installCatalogProviders]).filter(showsSearchProviderInSetup).map((provider) => buildSearchProviderSetupContribution({
		provider,
		source: SEARCH_INSTALL_CATALOG_ENTRY in provider ? "install-catalog" : "runtime"
	})));
}
function resolveSearchProviderEntry(config, provider) {
	return resolveSearchProviderOptions(config).find((entry) => entry.id === provider);
}
function hasKeyInEnv(entry) {
	return entry.envVars.some((k) => Boolean(normalizeOptionalString(process.env[k])));
}
function providerNeedsCredential(entry) {
	return entry.requiresCredential !== false;
}
function providerIsReady(config, entry) {
	if (!providerNeedsCredential(entry)) return true;
	return hasExistingKey(config, entry.id) || hasKeyInEnv(entry);
}
function rawKeyValue(config, provider) {
	return resolveSearchProviderEntry(config, provider)?.getConfiguredCredentialValue?.(config);
}
function resolveExistingKey(config, provider) {
	return normalizeSecretInputString(rawKeyValue(config, provider));
}
function hasExistingKey(config, provider) {
	return hasConfiguredSecretInput(rawKeyValue(config, provider));
}
function buildSearchEnvRef(config, provider) {
	const entry = resolveSearchProviderEntry(config, provider) ?? listSearchProviderOptions(config).find((candidate) => candidate.id === provider) ?? listSearchProviderOptions().find((candidate) => candidate.id === provider);
	const resolvedEnvVar = entry?.envVars.find((k) => Boolean(normalizeOptionalString(process.env[k]))) ?? entry?.envVars[0];
	if (!resolvedEnvVar) throw new Error(`No env var mapping for search provider "${provider}" at ${entry?.credentialPath ?? "unknown path"} in secret-input-mode=ref.`);
	return {
		source: "env",
		provider: DEFAULT_SECRET_PROVIDER_ALIAS,
		id: resolvedEnvVar
	};
}
function resolveSearchSecretInput(config, provider, key, secretInputMode) {
	if (secretInputMode === "ref") return buildSearchEnvRef(config, provider);
	return key;
}
function applySearchKey(config, provider, key) {
	const providerEntry = resolveSearchProviderEntry(config, provider);
	if (!providerEntry) return config;
	const search = {
		...config.tools?.web?.search,
		provider,
		enabled: true
	};
	if (!providerEntry.setConfiguredCredentialValue) providerEntry.setCredentialValue(search, key);
	const next = applySearchProviderSelectionConfig({
		...config,
		tools: {
			...config.tools,
			web: {
				...config.tools?.web,
				search
			}
		}
	}, providerEntry);
	providerEntry.setConfiguredCredentialValue?.(next, key);
	return next;
}
function applySearchProviderSelectionConfig(config, providerEntry) {
	if (providerEntry.applySelectionConfig) return providerEntry.applySelectionConfig(config);
	if (providerEntry.pluginId) return enablePluginInConfig(config, providerEntry.pluginId).config;
	return config;
}
function applySearchProviderSelection(config, provider) {
	const providerEntry = resolveSearchProviderEntry(config, provider);
	if (!providerEntry) return config;
	const search = {
		...config.tools?.web?.search,
		provider,
		enabled: true
	};
	return applySearchProviderSelectionConfig({
		...config,
		tools: {
			...config.tools,
			web: {
				...config.tools?.web,
				search
			}
		}
	}, providerEntry);
}
function preserveDisabledState(original, result) {
	if (original.tools?.web?.search?.enabled !== false) return result;
	const next = {
		...result,
		tools: {
			...result.tools,
			web: {
				...result.tools?.web,
				search: {
					...result.tools?.web?.search,
					enabled: false
				}
			}
		}
	};
	const provider = next.tools?.web?.search?.provider;
	if (typeof provider !== "string") return next;
	const providerEntry = resolveSearchProviderEntry(original, provider);
	if (!providerEntry?.pluginId) return next;
	const pluginId = providerEntry.pluginId;
	const originalPluginEntry = (original.plugins?.entries)?.[pluginId];
	const resultPluginEntry = (next.plugins?.entries)?.[pluginId];
	const nextPlugins = { ...next.plugins };
	if (Array.isArray(original.plugins?.allow)) nextPlugins.allow = [...original.plugins.allow];
	else delete nextPlugins.allow;
	if (resultPluginEntry || originalPluginEntry) {
		const nextEntries = { ...nextPlugins.entries };
		const patchedEntry = { ...resultPluginEntry };
		if (typeof originalPluginEntry?.enabled === "boolean") patchedEntry.enabled = originalPluginEntry.enabled;
		else delete patchedEntry.enabled;
		nextEntries[pluginId] = patchedEntry;
		nextPlugins.entries = nextEntries;
	}
	return {
		...next,
		plugins: nextPlugins
	};
}
async function finalizeSearchProviderSetup(params) {
	let next = params.nextConfig;
	const installEntry = params.entry[SEARCH_INSTALL_CATALOG_ENTRY];
	if (installEntry && next.tools?.web?.search?.enabled !== false) {
		const { ensureOnboardingPluginInstalled } = await import("./onboarding-plugin-install-g9TNJuIb.js");
		const installed = await ensureOnboardingPluginInstalled({
			cfg: next,
			entry: {
				pluginId: installEntry.pluginId,
				label: installEntry.label,
				install: installEntry.install,
				...installEntry.trustedSourceLinkedOfficialInstall ? { trustedSourceLinkedOfficialInstall: true } : {}
			},
			prompter: params.prompter,
			runtime: params.runtime,
			autoConfirmSingleSource: true
		});
		if (!installed.installed) return params.originalConfig;
		next = installed.cfg;
	}
	next = preserveDisabledState(params.originalConfig, next);
	if (!params.entry.runSetup) return next;
	next = await params.entry.runSetup({
		config: next,
		runtime: params.runtime,
		prompter: params.prompter,
		quickstartDefaults: params.opts?.quickstartDefaults,
		secretInputMode: params.opts?.secretInputMode
	});
	return preserveDisabledState(params.originalConfig, next);
}
async function runSearchSetupFlow(config, runtime, prompter, opts) {
	const providerOptions = resolveSearchProviderOptions(config);
	if (providerOptions.length === 0) {
		await prompter.note([
			"No web search providers are currently available under this plugin policy.",
			"Enable plugins or remove deny rules, then run setup again.",
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");
		return config;
	}
	await prompter.note([
		"Web search lets your agent look things up online.",
		"Choose a provider. Some providers need an API key, and some work key-free.",
		"Docs: https://docs.openclaw.ai/tools/web"
	].join("\n"), "Web search");
	const existingProvider = config.tools?.web?.search?.provider;
	const options = providerOptions.map((entry) => {
		const hint = entry.requiresCredential === false ? `${entry.hint} · key-free` : providerIsReady(config, entry) ? `${entry.hint} · configured` : entry.hint;
		return {
			value: entry.id,
			label: entry.label,
			hint
		};
	});
	const defaultProvider = (() => {
		if (existingProvider && providerOptions.some((entry) => entry.id === existingProvider)) return existingProvider;
		const detected = providerOptions.find((entry) => providerIsReady(config, entry));
		if (detected) return detected.id;
		return providerOptions[0].id;
	})();
	const choice = await prompter.select({
		message: "Search provider",
		options: [...options, {
			value: "__skip__",
			label: "Skip for now",
			hint: "Configure later with openclaw configure --section web"
		}],
		initialValue: defaultProvider,
		searchable: true
	});
	if (choice === "__skip__") return config;
	const entry = resolveSearchProviderEntry(config, choice) ?? providerOptions.find((e) => e.id === choice);
	if (!entry) return config;
	const credentialLabel = resolveSearchProviderCredentialLabel(entry);
	const existingKey = resolveExistingKey(config, choice);
	const keyConfigured = hasExistingKey(config, choice);
	const envAvailable = hasKeyInEnv(entry);
	const needsCredential = providerNeedsCredential(entry);
	if (opts?.quickstartDefaults && (keyConfigured || envAvailable)) return await finalizeSearchProviderSetup({
		originalConfig: config,
		nextConfig: existingKey ? applySearchKey(config, choice, existingKey) : applySearchProviderSelection(config, choice),
		entry,
		runtime,
		prompter,
		opts
	});
	if (!needsCredential) {
		await prompter.note([
			`${entry.label} works without an API key.`,
			"OpenClaw will enable the plugin and use it as your web_search provider.",
			`Docs: ${entry.docsUrl ?? "https://docs.openclaw.ai/tools/web"}`
		].join("\n"), "Web search");
		return await finalizeSearchProviderSetup({
			originalConfig: config,
			nextConfig: applySearchProviderSelection(config, choice),
			entry,
			runtime,
			prompter,
			opts
		});
	}
	if (entry.credentialNote) await prompter.note(entry.credentialNote, entry.label);
	if (opts?.secretInputMode === "ref") {
		if (keyConfigured) return await finalizeSearchProviderSetup({
			originalConfig: config,
			nextConfig: applySearchProviderSelection(config, choice),
			entry,
			runtime,
			prompter,
			opts
		});
		const ref = buildSearchEnvRef(config, choice);
		await prompter.note([
			"Secret references enabled — OpenClaw will store a reference instead of the API key.",
			`Env var: ${ref.id}${envAvailable ? " (detected)" : ""}.`,
			...envAvailable ? [] : [`Set ${ref.id} in the Gateway environment.`],
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");
		return await finalizeSearchProviderSetup({
			originalConfig: config,
			nextConfig: applySearchKey(config, choice, ref),
			entry,
			runtime,
			prompter,
			opts
		});
	}
	const key = normalizeOptionalString(await prompter.text({
		message: keyConfigured ? `${credentialLabel} (leave blank to keep current)` : envAvailable ? `${credentialLabel} (leave blank to use env var)` : credentialLabel,
		placeholder: keyConfigured ? "Leave blank to keep current" : entry.placeholder,
		sensitive: true
	})) ?? "";
	if (key) return await finalizeSearchProviderSetup({
		originalConfig: config,
		nextConfig: applySearchKey(config, choice, resolveSearchSecretInput(config, choice, key, opts?.secretInputMode)),
		entry,
		runtime,
		prompter,
		opts
	});
	if (existingKey) return await finalizeSearchProviderSetup({
		originalConfig: config,
		nextConfig: applySearchKey(config, choice, existingKey),
		entry,
		runtime,
		prompter,
		opts
	});
	if (keyConfigured || envAvailable) return await finalizeSearchProviderSetup({
		originalConfig: config,
		nextConfig: applySearchProviderSelection(config, choice),
		entry,
		runtime,
		prompter,
		opts
	});
	await prompter.note([
		`No ${credentialLabel} stored — web_search won't work until a key is available.`,
		`Get your key at: ${entry.signupUrl}`,
		"Docs: https://docs.openclaw.ai/tools/web"
	].join("\n"), "Web search");
	const search = {
		...config.tools?.web?.search,
		provider: choice
	};
	return {
		...config,
		tools: {
			...config.tools,
			web: {
				...config.tools?.web,
				search
			}
		}
	};
}
//#endregion
export { applySearchKey, applySearchProviderSelection, hasExistingKey, hasKeyInEnv, listSearchProviderOptions, resolveExistingKey, resolveSearchProviderOptions, runSearchSetupFlow as setupSearch };
