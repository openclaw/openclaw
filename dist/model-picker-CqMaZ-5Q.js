import { t as __exportAll } from "./rolldown-runtime-DUslC3ob.js";
import { Av as DEFAULT_PROVIDER, B_ as hasUsableCustomProviderApiKey, Ct as openUrl, M as resolveConfiguredModelRef, O as normalizeProviderId, Pg as resolveOpenClawAgentDir, R as resolvePluginProviders, T as modelKey, U_ as resolveEnvApiKey, b as buildModelAliasIndex, f as upsertAuthProfile, jg as loadModelCatalog, kv as DEFAULT_MODEL, p as ensureAuthProfileStore, u as listProfilesForProvider, y as buildAllowedModelSet } from "./auth-profiles-CAw5gP6f.js";
import { P as resolveAgentModelPrimaryValue, a as resolveAgentDir, d as resolveAgentWorkspaceDir, f as resolveDefaultAgentId, j as resolveDefaultAgentWorkspaceDir } from "./agent-scope-DBEC2O3x.js";
import { t as enablePluginInConfig } from "./enable-4ooqBfl0.js";
import { Zt as formatTokenK, a as OPENAI_CODEX_DEFAULT_MODEL, c as isRemoteEnvironment, i as resolveProviderMatch, n as mergeConfigPatch, r as pickAuthMethod, s as createVpsAwareOAuthHandlers, t as applyDefaultModel, y as applyAuthProfileConfig } from "./provider-auth-helpers-BygHxwmm.js";
import { a as runProviderModelSelectedHook, n as resolveProviderModelPickerEntries, r as resolveProviderPluginChoice } from "./provider-wizard-D0dlzJPh.js";
//#region src/commands/auth-choice.apply.plugin-provider.ts
async function runProviderPluginAuthMethod(params) {
	const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
	const defaultAgentId = resolveDefaultAgentId(params.config);
	const agentDir = params.agentDir ?? (agentId === defaultAgentId ? resolveOpenClawAgentDir() : resolveAgentDir(params.config, agentId));
	const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.config, agentId) ?? resolveDefaultAgentWorkspaceDir();
	const isRemote = isRemoteEnvironment();
	const result = await params.method.run({
		config: params.config,
		agentDir,
		workspaceDir,
		prompter: params.prompter,
		runtime: params.runtime,
		isRemote,
		openUrl: async (url) => {
			await openUrl(url);
		},
		oauth: { createVpsAwareHandlers: (opts) => createVpsAwareOAuthHandlers(opts) }
	});
	let nextConfig = params.config;
	if (result.configPatch) nextConfig = mergeConfigPatch(nextConfig, result.configPatch);
	for (const profile of result.profiles) {
		upsertAuthProfile({
			profileId: profile.profileId,
			credential: profile.credential,
			agentDir
		});
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: profile.profileId,
			provider: profile.credential.provider,
			mode: profile.credential.type === "token" ? "token" : profile.credential.type,
			..."email" in profile.credential && profile.credential.email ? { email: profile.credential.email } : {}
		});
	}
	if (params.emitNotes !== false && result.notes && result.notes.length > 0) await params.prompter.note(result.notes.join("\n"), "Provider notes");
	return {
		config: nextConfig,
		defaultModel: result.defaultModel
	};
}
async function applyAuthChoiceLoadedPluginProvider(params) {
	const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
	const workspaceDir = resolveAgentWorkspaceDir(params.config, agentId) ?? resolveDefaultAgentWorkspaceDir();
	const resolved = resolveProviderPluginChoice({
		providers: resolvePluginProviders({
			config: params.config,
			workspaceDir
		}),
		choice: params.authChoice
	});
	if (!resolved) return null;
	const applied = await runProviderPluginAuthMethod({
		config: params.config,
		runtime: params.runtime,
		prompter: params.prompter,
		method: resolved.method,
		agentDir: params.agentDir,
		agentId: params.agentId,
		workspaceDir
	});
	let agentModelOverride;
	if (applied.defaultModel) {
		if (params.setDefaultModel) {
			const nextConfig = applyDefaultModel(applied.config, applied.defaultModel);
			await runProviderModelSelectedHook({
				config: nextConfig,
				model: applied.defaultModel,
				prompter: params.prompter,
				agentDir: params.agentDir,
				workspaceDir
			});
			await params.prompter.note(`Default model set to ${applied.defaultModel}`, "Model configured");
			return { config: nextConfig };
		}
		agentModelOverride = applied.defaultModel;
	}
	return {
		config: applied.config,
		agentModelOverride
	};
}
async function applyAuthChoicePluginProvider(params, options) {
	if (params.authChoice !== options.authChoice) return null;
	const enableResult = enablePluginInConfig(params.config, options.pluginId);
	let nextConfig = enableResult.config;
	if (!enableResult.enabled) {
		await params.prompter.note(`${options.label} plugin is disabled (${enableResult.reason ?? "blocked"}).`, options.label);
		return { config: nextConfig };
	}
	const agentId = params.agentId ?? resolveDefaultAgentId(nextConfig);
	const defaultAgentId = resolveDefaultAgentId(nextConfig);
	const agentDir = params.agentDir ?? (agentId === defaultAgentId ? resolveOpenClawAgentDir() : resolveAgentDir(nextConfig, agentId));
	const workspaceDir = resolveAgentWorkspaceDir(nextConfig, agentId) ?? resolveDefaultAgentWorkspaceDir();
	const provider = resolveProviderMatch(resolvePluginProviders({
		config: nextConfig,
		workspaceDir
	}), options.providerId);
	if (!provider) {
		await params.prompter.note(`${options.label} auth plugin is not available. Enable it and re-run the wizard.`, options.label);
		return { config: nextConfig };
	}
	const method = pickAuthMethod(provider, options.methodId) ?? provider.auth[0];
	if (!method) {
		await params.prompter.note(`${options.label} auth method missing.`, options.label);
		return { config: nextConfig };
	}
	const applied = await runProviderPluginAuthMethod({
		config: nextConfig,
		runtime: params.runtime,
		prompter: params.prompter,
		method,
		agentDir,
		agentId,
		workspaceDir
	});
	nextConfig = applied.config;
	let agentModelOverride;
	if (applied.defaultModel) {
		if (params.setDefaultModel) {
			nextConfig = applyDefaultModel(nextConfig, applied.defaultModel);
			await runProviderModelSelectedHook({
				config: nextConfig,
				model: applied.defaultModel,
				prompter: params.prompter,
				agentDir,
				workspaceDir
			});
			await params.prompter.note(`Default model set to ${applied.defaultModel}`, "Model configured");
		} else if (params.agentId) {
			agentModelOverride = applied.defaultModel;
			await params.prompter.note(`Default model set to ${applied.defaultModel} for agent "${params.agentId}".`, "Model configured");
		}
	}
	return {
		config: nextConfig,
		agentModelOverride
	};
}
//#endregion
//#region src/commands/model-picker.ts
var model_picker_exports = /* @__PURE__ */ __exportAll({
	applyModelAllowlist: () => applyModelAllowlist,
	applyModelFallbacksFromSelection: () => applyModelFallbacksFromSelection,
	applyPrimaryModel: () => applyPrimaryModel,
	promptDefaultModel: () => promptDefaultModel,
	promptModelAllowlist: () => promptModelAllowlist
});
const KEEP_VALUE = "__keep__";
const MANUAL_VALUE = "__manual__";
const PROVIDER_FILTER_THRESHOLD = 30;
const HIDDEN_ROUTER_MODELS = new Set(["openrouter/auto"]);
function hasAuthForProvider(provider, cfg, store) {
	if (listProfilesForProvider(store, provider).length > 0) return true;
	if (resolveEnvApiKey(provider)) return true;
	if (hasUsableCustomProviderApiKey(cfg, provider)) return true;
	return false;
}
function createProviderAuthChecker(params) {
	const authStore = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
	const authCache = /* @__PURE__ */ new Map();
	return (provider) => {
		const cached = authCache.get(provider);
		if (cached !== void 0) return cached;
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
		if (!value || seen.has(value)) continue;
		seen.add(value);
		next.push(value);
	}
	return next;
}
function addModelSelectOption(params) {
	const key = modelKey(params.entry.provider, params.entry.id);
	if (params.seen.has(key)) return;
	if (HIDDEN_ROUTER_MODELS.has(key)) return;
	const hints = [];
	if (params.entry.name && params.entry.name !== params.entry.id) hints.push(params.entry.name);
	if (params.entry.contextWindow) hints.push(`ctx ${formatTokenK(params.entry.contextWindow)}`);
	if (params.entry.reasoning) hints.push("reasoning");
	const aliases = params.aliasIndex.byKey.get(key);
	if (aliases?.length) hints.push(`alias: ${aliases.join(", ")}`);
	if (!params.hasAuth(params.entry.provider)) hints.push("auth missing");
	params.options.push({
		value: key,
		label: key,
		hint: hints.length > 0 ? hints.join(" · ") : void 0
	});
	params.seen.add(key);
}
function isAnthropicLegacyModel(entry) {
	return entry.provider === "anthropic" && typeof entry.id === "string" && entry.id.toLowerCase().startsWith("claude-3");
}
async function promptManualModel(params) {
	const modelInput = await params.prompter.text({
		message: params.allowBlank ? "Default model (blank to keep)" : "Default model",
		initialValue: params.initialValue,
		placeholder: "provider/model",
		validate: params.allowBlank ? void 0 : (value) => value?.trim() ? void 0 : "Required"
	});
	const model = String(modelInput ?? "").trim();
	if (!model) return {};
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
	if (catalog.length === 0) return promptManualModel({
		prompter: params.prompter,
		allowBlank: allowKeep,
		initialValue: configuredRaw || resolvedKey || void 0
	});
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
	if (models.length === 0) return promptManualModel({
		prompter: params.prompter,
		allowBlank: allowKeep,
		initialValue: configuredRaw || resolvedKey || void 0
	});
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
		if (selection !== "*") models = models.filter((entry) => entry.provider === selection);
	}
	if (hasPreferredProvider && preferredProvider) {
		models = models.filter((entry) => {
			if (preferredProvider === "volcengine") return entry.provider === "volcengine" || entry.provider === "volcengine-plan";
			if (preferredProvider === "byteplus") return entry.provider === "byteplus" || entry.provider === "byteplus-plan";
			return entry.provider === preferredProvider;
		});
		if (preferredProvider === "anthropic") models = models.filter((entry) => !isAnthropicLegacyModel(entry));
	}
	const agentDir = params.agentDir;
	const hasAuth = createProviderAuthChecker({
		cfg,
		agentDir
	});
	const options = [];
	if (allowKeep) options.push({
		value: KEEP_VALUE,
		label: configuredRaw ? `Keep current (${configuredRaw})` : `Keep current (default: ${resolvedKey})`,
		hint: configuredRaw && configuredRaw !== resolvedKey ? `resolves to ${resolvedKey}` : void 0
	});
	if (includeManual) options.push({
		value: MANUAL_VALUE,
		label: "Enter model manually"
	});
	if (includeProviderPluginSetups && agentDir) options.push(...resolveProviderModelPickerEntries({
		config: cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	}));
	const seen = /* @__PURE__ */ new Set();
	for (const entry of models) addModelSelectOption({
		entry,
		options,
		seen,
		aliasIndex,
		hasAuth
	});
	if (configuredKey && !seen.has(configuredKey)) options.push({
		value: configuredKey,
		label: configuredKey,
		hint: "current (not in catalog)"
	});
	let initialValue = allowKeep ? KEEP_VALUE : configuredKey || void 0;
	if (allowKeep && hasPreferredProvider && preferredProvider && resolved.provider !== preferredProvider) {
		const firstModel = models[0];
		if (firstModel) initialValue = modelKey(firstModel.provider, firstModel.id);
	}
	const selection = await params.prompter.select({
		message: params.message ?? "Default model",
		options,
		initialValue
	});
	if (selection === KEEP_VALUE) return {};
	if (selection === MANUAL_VALUE) return promptManualModel({
		prompter: params.prompter,
		allowBlank: false,
		initialValue: configuredRaw || resolvedKey || void 0
	});
	const pluginProviders = resolvePluginProviders({
		config: cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	const pluginResolution = selection.startsWith("provider-plugin:") ? selection : selection.includes("/") ? null : pluginProviders.some((provider) => normalizeProviderId(provider.id) === normalizeProviderId(selection)) ? selection : null;
	if (pluginResolution) {
		if (!agentDir || !params.runtime) {
			await params.prompter.note("Provider setup requires agent and runtime context.", "Provider setup unavailable");
			return {};
		}
		const resolved = resolveProviderPluginChoice({
			providers: pluginProviders,
			choice: pluginResolution
		});
		if (!resolved) return {};
		const applied = await runProviderPluginAuthMethod({
			config: cfg,
			runtime: params.runtime,
			prompter: params.prompter,
			method: resolved.method,
			agentDir,
			workspaceDir: params.workspaceDir
		});
		if (applied.defaultModel) await runProviderModelSelectedHook({
			config: applied.config,
			model: applied.defaultModel,
			prompter: params.prompter,
			agentDir,
			workspaceDir: params.workspaceDir,
			env: params.env
		});
		return {
			model: applied.defaultModel,
			config: applied.config
		};
	}
	const model = String(selection);
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
			placeholder: `${OPENAI_CODEX_DEFAULT_MODEL}, anthropic/claude-opus-4-6`
		});
		const parsed = String(raw ?? "").split(",").map((value) => value.trim()).filter((value) => value.length > 0);
		if (parsed.length === 0) return {};
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
	for (const entry of filteredCatalog) addModelSelectOption({
		entry,
		options,
		seen,
		aliasIndex,
		hasAuth
	});
	const supplementalKeys = allowedKeySet ? allowedKeys : existingKeys;
	for (const key of supplementalKeys) {
		if (seen.has(key)) continue;
		options.push({
			value: key,
			label: key,
			hint: allowedKeySet ? "allowed (not in catalog)" : "configured (not in catalog)"
		});
		seen.add(key);
	}
	if (options.length === 0) return {};
	const selected = normalizeModelKeys((await params.prompter.multiselect({
		message: params.message ?? "Models in /model picker (multi-select)",
		options,
		initialValues: initialKeys.length > 0 ? initialKeys : void 0,
		searchable: true
	})).map((value) => String(value)));
	if (selected.length > 0) return { models: selected };
	if (existingKeys.length === 0) return { models: [] };
	if (!await params.prompter.confirm({
		message: "Clear the model allowlist? (shows all models)",
		initialValue: false
	})) return {};
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
		if (!defaults?.models) return cfg;
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
	for (const key of normalized) nextModels[key] = existingModels[key] ?? {};
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
	if (normalized.length <= 1) return cfg;
	const resolved = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const resolvedKey = modelKey(resolved.provider, resolved.model);
	if (!normalized.includes(resolvedKey)) return cfg;
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
export { promptDefaultModel as a, applyAuthChoicePluginProvider as c, model_picker_exports as i, applyModelFallbacksFromSelection as n, promptModelAllowlist as o, applyPrimaryModel as r, applyAuthChoiceLoadedPluginProvider as s, applyModelAllowlist as t };
