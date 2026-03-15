import { P as resolveConfiguredModelRef, Qx as DEFAULT_PROVIDER, T as buildModelAliasIndex, Zx as DEFAULT_MODEL, _b as hasUsableCustomProviderApiKey, bb as resolveEnvApiKey, eC as normalizeProviderId, jp as loadModelCatalog, k as modelKey, p as ensureAuthProfileStore, u as listProfilesForProvider, w as buildAllowedModelSet } from "./auth-profiles-DqxBs6Au.js";
import { P as resolveAgentModelPrimaryValue } from "./agent-scope-tkfLX5MZ.js";
import { i as formatTokenK } from "./shared-Sjx2CiAv.js";
//#region src/commands/model-picker.ts
const KEEP_VALUE = "__keep__";
const MANUAL_VALUE = "__manual__";
const PROVIDER_FILTER_THRESHOLD = 30;
const HIDDEN_ROUTER_MODELS = new Set(["openrouter/auto"]);
async function loadModelPickerRuntime() {
	return import("./model-picker.runtime-BMiWrpEo.js");
}
function hasAuthForProvider(provider, cfg, store) {
	if (listProfilesForProvider(store, provider).length > 0) {return true;}
	if (resolveEnvApiKey(provider)) {return true;}
	if (hasUsableCustomProviderApiKey(cfg, provider)) {return true;}
	return false;
}
function createProviderAuthChecker(params) {
	const authStore = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
	const authCache = /* @__PURE__ */ new Map();
	return (provider) => {
		const cached = authCache.get(provider);
		if (cached !== void 0) {return cached;}
		const value = hasAuthForProvider(provider, params.cfg, authStore);
		authCache.set(provider, value);
		return value;
	};
}
function resolveConfiguredModelRaw(cfg) {
	return resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ?? "";
}
function resolveConfiguredModelKeys(cfg) {
	const models = cfg.agents?.defaults?.models ?? {};
	return Object.keys(models).map((key) => String(key ?? "").trim()).filter((key) => key.length > 0);
}
function normalizeModelKeys(values) {
	const seen = /* @__PURE__ */ new Set();
	const next = [];
	for (const raw of values) {
		const value = String(raw ?? "").trim();
		if (!value || seen.has(value)) {continue;}
		seen.add(value);
		next.push(value);
	}
	return next;
}
function addModelSelectOption(params) {
	const key = modelKey(params.entry.provider, params.entry.id);
	if (params.seen.has(key)) {return;}
	if (HIDDEN_ROUTER_MODELS.has(key)) {return;}
	const hints = [];
	if (params.entry.name && params.entry.name !== params.entry.id) {hints.push(params.entry.name);}
	if (params.entry.contextWindow) {hints.push(`ctx ${formatTokenK(params.entry.contextWindow)}`);}
	if (params.entry.reasoning) {hints.push("reasoning");}
	const aliases = params.aliasIndex.byKey.get(key);
	if (aliases?.length) {hints.push(`alias: ${aliases.join(", ")}`);}
	if (!params.hasAuth(params.entry.provider)) {hints.push("auth missing");}
	params.options.push({
		value: key,
		label: key,
		hint: hints.length > 0 ? hints.join(" · ") : void 0
	});
	params.seen.add(key);
}
async function promptManualModel(params) {
	const modelInput = await params.prompter.text({
		message: params.allowBlank ? "Default model (blank to keep)" : "Default model",
		initialValue: params.initialValue,
		placeholder: "provider/model",
		validate: params.allowBlank ? void 0 : (value) => value?.trim() ? void 0 : "Required"
	});
	const model = String(modelInput ?? "").trim();
	if (!model) {return {};}
	return { model };
}
async function promptDefaultModel(params) {
	const cfg = params.config;
	const allowKeep = params.allowKeep ?? true;
	const includeManual = params.includeManual ?? true;
	const includeProviderPluginSetups = params.includeProviderPluginSetups ?? false;
	const ignoreAllowlist = params.ignoreAllowlist ?? false;
	const preferredProviderRaw = params.preferredProvider?.trim();
	const preferredProvider = preferredProviderRaw ? normalizeProviderId(preferredProviderRaw) : void 0;
	const configuredRaw = resolveConfiguredModelRaw(cfg);
	const resolved = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const resolvedKey = modelKey(resolved.provider, resolved.model);
	const configuredKey = configuredRaw ? resolvedKey : "";
	const catalog = await loadModelCatalog({
		config: cfg,
		useCache: false
	});
	if (catalog.length === 0) {return promptManualModel({
		prompter: params.prompter,
		allowBlank: allowKeep,
		initialValue: configuredRaw || resolvedKey || void 0
	});}
	const aliasIndex = buildModelAliasIndex({
		cfg,
		defaultProvider: DEFAULT_PROVIDER
	});
	let models = catalog;
	if (!ignoreAllowlist) {
		const { allowedCatalog } = buildAllowedModelSet({
			cfg,
			catalog,
			defaultProvider: DEFAULT_PROVIDER
		});
		models = allowedCatalog.length > 0 ? allowedCatalog : catalog;
	}
	if (models.length === 0) {return promptManualModel({
		prompter: params.prompter,
		allowBlank: allowKeep,
		initialValue: configuredRaw || resolvedKey || void 0
	});}
	const providerIds = Array.from(new Set(models.map((entry) => entry.provider))).toSorted((a, b) => a.localeCompare(b));
	const hasPreferredProvider = preferredProvider ? providerIds.includes(preferredProvider) : false;
	if (!hasPreferredProvider && providerIds.length > 1 && models.length > PROVIDER_FILTER_THRESHOLD) {
		const selection = await params.prompter.select({
			message: "Filter models by provider",
			options: [{
				value: "*",
				label: "All providers"
			}, ...providerIds.map((provider) => {
				const count = models.filter((entry) => entry.provider === provider).length;
				return {
					value: provider,
					label: provider,
					hint: `${count} model${count === 1 ? "" : "s"}`
				};
			})]
		});
		if (selection !== "*") {models = models.filter((entry) => entry.provider === selection);}
	}
	if (hasPreferredProvider && preferredProvider) {models = models.filter((entry) => {
		if (preferredProvider === "volcengine") return entry.provider === "volcengine" || entry.provider === "volcengine-plan";
		if (preferredProvider === "byteplus") return entry.provider === "byteplus" || entry.provider === "byteplus-plan";
		return entry.provider === preferredProvider;
	});}
	const agentDir = params.agentDir;
	const hasAuth = createProviderAuthChecker({
		cfg,
		agentDir
	});
	const options = [];
	if (allowKeep) {options.push({
		value: KEEP_VALUE,
		label: configuredRaw ? `Keep current (${configuredRaw})` : `Keep current (default: ${resolvedKey})`,
		hint: configuredRaw && configuredRaw !== resolvedKey ? `resolves to ${resolvedKey}` : void 0
	});}
	if (includeManual) {options.push({
		value: MANUAL_VALUE,
		label: "Enter model manually"
	});}
	if (includeProviderPluginSetups && agentDir) {
		const { resolveProviderModelPickerEntries } = await loadModelPickerRuntime();
		options.push(...resolveProviderModelPickerEntries({
			config: cfg,
			workspaceDir: params.workspaceDir,
			env: params.env
		}));
	}
	const seen = /* @__PURE__ */ new Set();
	for (const entry of models) {addModelSelectOption({
		entry,
		options,
		seen,
		aliasIndex,
		hasAuth
	});}
	if (configuredKey && !seen.has(configuredKey)) {options.push({
		value: configuredKey,
		label: configuredKey,
		hint: "current (not in catalog)"
	});}
	let initialValue = allowKeep ? KEEP_VALUE : configuredKey || void 0;
	if (allowKeep && hasPreferredProvider && preferredProvider && resolved.provider !== preferredProvider) {
		const firstModel = models[0];
		if (firstModel) {initialValue = modelKey(firstModel.provider, firstModel.id);}
	}
	const selection = await params.prompter.select({
		message: params.message ?? "Default model",
		options,
		initialValue
	});
	if (selection === KEEP_VALUE) {return {};}
	if (selection === MANUAL_VALUE) {return promptManualModel({
		prompter: params.prompter,
		allowBlank: false,
		initialValue: configuredRaw || resolvedKey || void 0
	});}
	let pluginResolution = null;
	let pluginProviders = [];
	if (selection.startsWith("provider-plugin:")) {pluginResolution = selection;}
	else if (!selection.includes("/")) {
		const { resolvePluginProviders } = await loadModelPickerRuntime();
		pluginProviders = resolvePluginProviders({
			config: cfg,
			workspaceDir: params.workspaceDir,
			env: params.env
		});
		pluginResolution = pluginProviders.some((provider) => normalizeProviderId(provider.id) === normalizeProviderId(selection)) ? selection : null;
	}
	if (pluginResolution) {
		if (!agentDir || !params.runtime) {
			await params.prompter.note("Provider setup requires agent and runtime context.", "Provider setup unavailable");
			return {};
		}
		const { resolvePluginProviders, resolveProviderPluginChoice, runProviderModelSelectedHook, runProviderPluginAuthMethod } = await loadModelPickerRuntime();
		if (pluginProviders.length === 0) {pluginProviders = resolvePluginProviders({
			config: cfg,
			workspaceDir: params.workspaceDir,
			env: params.env
		});}
		const resolved = resolveProviderPluginChoice({
			providers: pluginProviders,
			choice: pluginResolution
		});
		if (!resolved) {return {};}
		const applied = await runProviderPluginAuthMethod({
			config: cfg,
			runtime: params.runtime,
			prompter: params.prompter,
			method: resolved.method,
			agentDir,
			workspaceDir: params.workspaceDir
		});
		if (applied.defaultModel) {await runProviderModelSelectedHook({
			config: applied.config,
			model: applied.defaultModel,
			prompter: params.prompter,
			agentDir,
			workspaceDir: params.workspaceDir,
			env: params.env
		});}
		return {
			model: applied.defaultModel,
			config: applied.config
		};
	}
	const model = String(selection);
	const { runProviderModelSelectedHook } = await loadModelPickerRuntime();
	await runProviderModelSelectedHook({
		config: cfg,
		model,
		prompter: params.prompter,
		agentDir,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	return { model };
}
async function promptModelAllowlist(params) {
	const cfg = params.config;
	const existingKeys = resolveConfiguredModelKeys(cfg);
	const allowedKeys = normalizeModelKeys(params.allowedKeys ?? []);
	const allowedKeySet = allowedKeys.length > 0 ? new Set(allowedKeys) : null;
	const resolved = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const resolvedKey = modelKey(resolved.provider, resolved.model);
	const initialSeeds = normalizeModelKeys([
		...existingKeys,
		resolvedKey,
		...params.initialSelections ?? []
	]);
	const initialKeys = allowedKeySet ? initialSeeds.filter((key) => allowedKeySet.has(key)) : initialSeeds;
	const catalog = await loadModelCatalog({
		config: cfg,
		useCache: false
	});
	if (catalog.length === 0 && allowedKeys.length === 0) {
		const raw = await params.prompter.text({
			message: params.message ?? "Allowlist models (comma-separated provider/model; blank to keep current)",
			initialValue: existingKeys.join(", "),
			placeholder: "provider/model, other-provider/model"
		});
		const parsed = String(raw ?? "").split(",").map((value) => value.trim()).filter((value) => value.length > 0);
		if (parsed.length === 0) {return {};}
		return { models: normalizeModelKeys(parsed) };
	}
	const aliasIndex = buildModelAliasIndex({
		cfg,
		defaultProvider: DEFAULT_PROVIDER
	});
	const hasAuth = createProviderAuthChecker({
		cfg,
		agentDir: params.agentDir
	});
	const options = [];
	const seen = /* @__PURE__ */ new Set();
	const filteredCatalog = allowedKeySet ? catalog.filter((entry) => allowedKeySet.has(modelKey(entry.provider, entry.id))) : catalog;
	for (const entry of filteredCatalog) {addModelSelectOption({
		entry,
		options,
		seen,
		aliasIndex,
		hasAuth
	});}
	const supplementalKeys = allowedKeySet ? allowedKeys : existingKeys;
	for (const key of supplementalKeys) {
		if (seen.has(key)) {continue;}
		options.push({
			value: key,
			label: key,
			hint: allowedKeySet ? "allowed (not in catalog)" : "configured (not in catalog)"
		});
		seen.add(key);
	}
	if (options.length === 0) {return {};}
	const selected = normalizeModelKeys((await params.prompter.multiselect({
		message: params.message ?? "Models in /model picker (multi-select)",
		options,
		initialValues: initialKeys.length > 0 ? initialKeys : void 0,
		searchable: true
	})).map((value) => String(value)));
	if (selected.length > 0) {return { models: selected };}
	if (existingKeys.length === 0) {return { models: [] };}
	if (!await params.prompter.confirm({
		message: "Clear the model allowlist? (shows all models)",
		initialValue: false
	})) {return {};}
	return { models: [] };
}
function applyPrimaryModel(cfg, model) {
	const defaults = cfg.agents?.defaults;
	const existingModel = defaults?.model;
	const existingModels = defaults?.models;
	const fallbacks = typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel ? existingModel.fallbacks : void 0;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				model: {
					...fallbacks ? { fallbacks } : void 0,
					primary: model
				},
				models: {
					...existingModels,
					[model]: existingModels?.[model] ?? {}
				}
			}
		}
	};
}
function applyModelAllowlist(cfg, models) {
	const defaults = cfg.agents?.defaults;
	const normalized = normalizeModelKeys(models);
	if (normalized.length === 0) {
		if (!defaults?.models) {return cfg;}
		const { models: _ignored, ...restDefaults } = defaults;
		return {
			...cfg,
			agents: {
				...cfg.agents,
				defaults: restDefaults
			}
		};
	}
	const existingModels = defaults?.models ?? {};
	const nextModels = {};
	for (const key of normalized) {nextModels[key] = existingModels[key] ?? {};}
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				models: nextModels
			}
		}
	};
}
function applyModelFallbacksFromSelection(cfg, selection) {
	const normalized = normalizeModelKeys(selection);
	if (normalized.length <= 1) {return cfg;}
	const resolved = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const resolvedKey = modelKey(resolved.provider, resolved.model);
	if (!normalized.includes(resolvedKey)) {return cfg;}
	const defaults = cfg.agents?.defaults;
	const existingModel = defaults?.model;
	const existingPrimary = typeof existingModel === "string" ? existingModel : existingModel && typeof existingModel === "object" ? existingModel.primary : void 0;
	const fallbacks = normalized.filter((key) => key !== resolvedKey);
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				model: {
					...typeof existingModel === "object" ? existingModel : void 0,
					primary: existingPrimary ?? resolvedKey,
					fallbacks
				}
			}
		}
	};
}
//#endregion
export { promptModelAllowlist as a, promptDefaultModel as i, applyModelFallbacksFromSelection as n, applyPrimaryModel as r, applyModelAllowlist as t };
