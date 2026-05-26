import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { i as resolveAgentModelPrimaryValue, n as normalizeAgentModelRefForConfig, r as resolveAgentModelFallbackValues, t as normalizeAgentModelMapForConfig } from "./model-input-ChW9XXsQ.js";
import { t as formatLiteralProviderPrefixedModelRef } from "./model-ref-shared-BkjJfDrJ.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { h as resolveOwningPluginIdsForProvider } from "./plugin-auto-enable-CuCUT4Z1.js";
import { i as buildModelAliasIndex, r as buildConfiguredModelCatalog, v as resolveConfiguredModelRef, x as resolveModelRefFromString } from "./model-selection-shared-ClxdEp4X.js";
import { n as modelKey, r as normalizeModelRef } from "./model-selection-normalize-CBfQo-Fd.js";
import "./model-selection-P-81eBKx.js";
import { n as loadModelCatalog } from "./model-catalog-DhWpNp70.js";
import { a as createLazyRuntimeSurface } from "./lazy-runtime-D-7_JraP.js";
import { n as t } from "./i18n-CWNhN747.js";
import { i as formatTokenK } from "./shared-CXerptPG.js";
import { n as createProviderAuthChecker } from "./model-provider-auth-DAG1ddFR.js";
import { t as resolveVisibleModelCatalog } from "./model-catalog-visibility-kfqhTKJH.js";
import { n as isModelPickerVisibleProvider, t as isModelPickerVisibleModelRef } from "./model-picker-visibility-BzELkrLo.js";
import { t as loadStaticManifestCatalogRowsForList } from "./list.manifest-catalog-CYfhguU2.js";
//#region src/flows/model-picker.ts
const KEEP_VALUE = "__keep__";
const MANUAL_VALUE = "__manual__";
const BROWSE_VALUE = "__browse__";
const PROVIDER_FILTER_THRESHOLD = 30;
const EMPTY_LITERAL_PREFIX_PROVIDERS = /* @__PURE__ */ new Set();
const HIDDEN_ROUTER_MODELS = new Set(["openrouter/auto"]);
function formatKeepCurrentModelLabel(params) {
	return params.configuredRaw ? t("wizard.model.keepCurrent", { value: params.configuredLabel }) : t("wizard.model.keepCurrentDefault", { value: params.resolvedKey });
}
async function loadModelPickerRuntime() {
	return import("./model-picker.runtime.js");
}
const loadResolvedModelPickerRuntime = createLazyRuntimeSurface(loadModelPickerRuntime, ({ modelPickerRuntime }) => modelPickerRuntime);
function resolveConfiguredModelRaw(cfg) {
	return resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ?? "";
}
function resolveConfiguredModelKeys(cfg) {
	const models = cfg.agents?.defaults?.models ?? {};
	return Object.keys(models).map((key) => key.trim()).filter((key) => key.length > 0);
}
function toPickerCatalogEntry(row) {
	return {
		id: row.id,
		name: row.name,
		provider: row.provider,
		...row.contextWindow !== void 0 ? { contextWindow: row.contextWindow } : {},
		reasoning: row.reasoning,
		input: row.input
	};
}
function loadPickerModelCatalog(cfg, opts = {}) {
	if (cfg.models?.mode === "replace") return Promise.resolve(buildConfiguredModelCatalog({ cfg }));
	if (opts.preferredProvider) {
		const manifestRows = loadStaticManifestCatalogRowsForList({
			cfg,
			providerFilter: opts.preferredProvider
		});
		if (manifestRows.length > 0) return Promise.resolve(manifestRows.map(toPickerCatalogEntry));
	}
	return loadModelCatalog({ config: cfg });
}
function normalizeModelKeys(values) {
	const seen = /* @__PURE__ */ new Set();
	const next = [];
	for (const raw of values) {
		const value = normalizeAgentModelRefForConfig(raw);
		if (!value || seen.has(value)) continue;
		seen.add(value);
		next.push(value);
	}
	return next;
}
function resolveFallbackModelKey(params) {
	const raw = normalizeOptionalString(params.raw);
	if (!raw) return;
	const resolved = resolveModelRefFromString({
		cfg: params.cfg,
		raw,
		defaultProvider: params.defaultProvider,
		aliasIndex: params.aliasIndex
	});
	if (!resolved) return;
	return modelKey(resolved.ref.provider, resolved.ref.model);
}
function resolveFallbackModelKeys(params) {
	return normalizeModelKeys(params.rawFallbacks.map((raw) => resolveFallbackModelKey({
		cfg: params.cfg,
		raw,
		defaultProvider: params.defaultProvider,
		aliasIndex: params.aliasIndex
	})).filter((key) => Boolean(key)));
}
function resolveModelRouteHint(provider) {
	const normalized = normalizeProviderId(provider);
	if (normalized === "openai") return "Codex runtime route";
	if (normalized === "openai-codex") return "legacy Codex OAuth route";
}
async function resolveLiteralPrefixProviderIds(params) {
	const { resolvePluginProviders } = await loadResolvedModelPickerRuntime();
	const providers = resolvePluginProviders({
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		env: params.env,
		activate: false,
		cache: false,
		includeUntrustedWorkspacePlugins: false
	});
	const ids = /* @__PURE__ */ new Set();
	for (const provider of providers) {
		if (!provider.preserveLiteralProviderPrefix) continue;
		const id = normalizeProviderId(provider.id);
		if (id) ids.add(id);
		for (const alias of provider.aliases ?? []) {
			const aliasId = normalizeProviderId(alias);
			if (aliasId) ids.add(aliasId);
		}
	}
	return ids;
}
async function addModelSelectOption(params) {
	const normalizedRef = normalizeModelRef(params.entry.provider, params.entry.id);
	const key = modelKey(normalizedRef.provider, normalizedRef.model);
	if (params.seen.has(key) || HIDDEN_ROUTER_MODELS.has(key) || !isModelPickerVisibleProvider(normalizedRef.provider)) return;
	const hints = [];
	if (params.entry.name && params.entry.name !== params.entry.id) hints.push(params.entry.name);
	if (params.entry.contextWindow) hints.push(`ctx ${formatTokenK(params.entry.contextWindow)}`);
	if (params.entry.reasoning) hints.push("reasoning");
	const aliases = params.aliasIndex.byKey.get(key);
	if (aliases?.length) hints.push(`alias: ${aliases.join(", ")}`);
	const routeHint = resolveModelRouteHint(normalizedRef.provider);
	if (routeHint) hints.push(routeHint);
	if (!await params.hasAuth(normalizedRef.provider)) return;
	const label = params.literalPrefixProviders.has(normalizeProviderId(normalizedRef.provider)) ? formatLiteralProviderPrefixedModelRef(normalizedRef.provider, key) : key;
	params.options.push({
		value: key,
		label,
		hint: hints.length > 0 ? hints.join(" · ") : void 0
	});
	params.seen.add(key);
}
function splitModelKey(key) {
	const slashIndex = key.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= key.length - 1) return;
	return {
		provider: key.slice(0, slashIndex),
		id: key.slice(slashIndex + 1)
	};
}
async function addModelKeySelectOption(params) {
	const entry = splitModelKey(params.key);
	if (!entry) return;
	const before = params.seen.size;
	await addModelSelectOption({
		entry,
		options: params.options,
		seen: params.seen,
		aliasIndex: params.aliasIndex,
		hasAuth: params.hasAuth,
		literalPrefixProviders: params.literalPrefixProviders ?? EMPTY_LITERAL_PREFIX_PROVIDERS
	});
	if (params.seen.size > before) {
		const option = params.options.at(-1);
		if (option && !option.hint) option.hint = params.fallbackHint;
	}
}
function createPreferredProviderMatcher(params) {
	const normalizedPreferredProvider = normalizeProviderId(params.preferredProvider);
	const preferredOwnerPluginIds = resolveOwningPluginIdsForProvider({
		provider: normalizedPreferredProvider,
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	const preferredOwnerPluginIdSet = preferredOwnerPluginIds ? new Set(preferredOwnerPluginIds) : void 0;
	const entryProviderCache = /* @__PURE__ */ new Map();
	return (entryProvider) => {
		const normalizedEntryProvider = normalizeProviderId(entryProvider);
		if (normalizedEntryProvider === normalizedPreferredProvider) return true;
		const cached = entryProviderCache.get(normalizedEntryProvider);
		if (cached !== void 0) return cached;
		const value = !!preferredOwnerPluginIdSet && !!resolveOwningPluginIdsForProvider({
			provider: normalizedEntryProvider,
			config: params.cfg,
			workspaceDir: params.workspaceDir,
			env: params.env
		})?.some((pluginId) => preferredOwnerPluginIdSet.has(pluginId));
		entryProviderCache.set(normalizedEntryProvider, value);
		return value;
	};
}
async function promptManualModel(params) {
	const model = (await params.prompter.text({
		message: params.allowBlank ? t("wizard.model.defaultModelBlankToKeep") : t("wizard.model.defaultModel"),
		initialValue: params.initialValue,
		placeholder: "provider/model",
		validate: params.allowBlank ? void 0 : (value) => normalizeOptionalString(value) ? void 0 : t("common.required")
	}) ?? "").trim();
	if (!model) return {};
	return { model: normalizeAgentModelRefForConfig(model) };
}
function buildModelProviderFilterOptions(models) {
	return Array.from(new Set(models.map((entry) => entry.provider))).toSorted((a, b) => a.localeCompare(b)).map((provider) => {
		const count = models.filter((entry) => entry.provider === provider).length;
		return {
			value: provider,
			label: provider,
			hint: t("wizard.model.modelCount", {
				count,
				plural: count === 1 ? "" : "s"
			})
		};
	});
}
async function maybeFilterModelsByProvider(params) {
	let next = params.models.filter((entry) => isModelPickerVisibleProvider(entry.provider));
	const providerIds = Array.from(new Set(next.map((entry) => entry.provider))).toSorted((a, b) => a.localeCompare(b));
	const hasPreferredProvider = !!params.preferredProvider;
	const shouldPromptProvider = !hasPreferredProvider && providerIds.length > 1 && next.length > PROVIDER_FILTER_THRESHOLD;
	const matchesPreferredProvider = params.preferredProvider ? createPreferredProviderMatcher({
		preferredProvider: params.preferredProvider,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	}) : void 0;
	if (shouldPromptProvider) {
		const selection = await params.prompter.select({
			message: t("wizard.model.filterByProvider"),
			options: [{
				value: "*",
				label: t("wizard.model.allProviders")
			}, ...buildModelProviderFilterOptions(next)],
			searchable: true
		});
		if (selection !== "*") next = next.filter((entry) => entry.provider === selection);
	}
	if (hasPreferredProvider && params.preferredProvider) {
		const filtered = next.filter((entry) => matchesPreferredProvider?.(entry.provider));
		if (filtered.length > 0) next = filtered;
	}
	return next;
}
async function resolveProviderPluginSetupOptions(params) {
	const runtime = await loadResolvedModelPickerRuntime();
	return ("resolveProviderModelPickerContributions" in runtime && typeof runtime.resolveProviderModelPickerContributions === "function" ? runtime.resolveProviderModelPickerContributions({
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	}).map((contribution) => contribution.option) : runtime.resolveProviderModelPickerEntries({
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	})).map((entry) => Object.assign({
		value: entry.value,
		label: entry.label
	}, entry.hint ? { hint: entry.hint } : {}));
}
async function maybeHandleProviderPluginSelection(params) {
	let pluginResolution = null;
	let pluginProviders = [];
	if (params.selection.startsWith("provider-plugin:")) pluginResolution = params.selection;
	else if (!params.selection.includes("/")) {
		const { resolvePluginProviders } = await loadResolvedModelPickerRuntime();
		pluginProviders = resolvePluginProviders({
			config: params.cfg,
			workspaceDir: params.workspaceDir,
			env: params.env,
			mode: "setup"
		});
		pluginResolution = pluginProviders.some((provider) => normalizeProviderId(provider.id) === normalizeProviderId(params.selection)) ? params.selection : null;
	}
	if (!pluginResolution) return null;
	if (!params.agentDir || !params.runtime) {
		await params.prompter.note(t("wizard.model.providerSetupUnavailable"), t("wizard.model.providerSetupUnavailableTitle"));
		return {};
	}
	const { resolvePluginProviders, resolveProviderPluginChoice, runProviderModelSelectedHook, runProviderPluginAuthMethod } = await loadResolvedModelPickerRuntime();
	if (pluginProviders.length === 0) pluginProviders = resolvePluginProviders({
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		env: params.env,
		mode: "setup"
	});
	const resolved = resolveProviderPluginChoice({
		providers: pluginProviders,
		choice: pluginResolution
	});
	if (!resolved) return {};
	const applied = await runProviderPluginAuthMethod({
		config: params.cfg,
		runtime: params.runtime,
		prompter: params.prompter,
		method: resolved.method,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir
	});
	if (applied.defaultModel) await runProviderModelSelectedHook({
		config: applied.config,
		model: applied.defaultModel,
		prompter: params.prompter,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	return {
		model: applied.defaultModel,
		config: applied.config
	};
}
async function promptDefaultModel(params) {
	const cfg = params.config;
	const allowKeep = params.allowKeep ?? true;
	const includeManual = params.includeManual ?? true;
	const includeProviderPluginSetups = params.includeProviderPluginSetups ?? false;
	const loadCatalog = params.loadCatalog ?? true;
	const browseCatalogOnDemand = params.browseCatalogOnDemand ?? false;
	const ignoreAllowlist = params.ignoreAllowlist ?? false;
	const preferredProviderRaw = normalizeOptionalString(params.preferredProvider);
	const preferredProvider = preferredProviderRaw ? normalizeProviderId(preferredProviderRaw) : void 0;
	const configuredRaw = resolveConfiguredModelRaw(cfg);
	const resolved = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL,
		allowPluginNormalization: !loadCatalog || browseCatalogOnDemand ? false : void 0
	});
	const resolvedKey = modelKey(resolved.provider, resolved.model);
	const configuredKey = configuredRaw ? resolvedKey : "";
	let literalPrefixProvidersCache;
	const resolveCachedLiteralPrefixProviders = async () => {
		if (!literalPrefixProvidersCache) literalPrefixProvidersCache = await resolveLiteralPrefixProviderIds({
			cfg,
			workspaceDir: params.workspaceDir,
			env: params.env
		});
		return literalPrefixProvidersCache;
	};
	const resolveConfiguredDisplayLabel = async () => {
		const providerId = normalizeProviderId(resolved.provider);
		if (!providerId) return configuredRaw || resolvedKey;
		return (await resolveCachedLiteralPrefixProviders()).has(providerId) ? formatLiteralProviderPrefixedModelRef(resolved.provider, resolvedKey) : configuredRaw || resolvedKey;
	};
	if (loadCatalog && browseCatalogOnDemand && allowKeep && (!preferredProvider || normalizeProviderId(resolved.provider) === preferredProvider)) {
		const options = [{
			value: KEEP_VALUE,
			label: formatKeepCurrentModelLabel({
				configuredRaw,
				configuredLabel: await resolveConfiguredDisplayLabel(),
				resolvedKey
			}),
			hint: configuredRaw && configuredRaw !== resolvedKey ? t("wizard.model.resolvesTo", { value: resolvedKey }) : void 0
		}];
		if (includeManual) options.push({
			value: MANUAL_VALUE,
			label: t("wizard.model.enterManually")
		});
		options.push({
			value: BROWSE_VALUE,
			label: t("wizard.model.browseAll"),
			hint: t("wizard.model.loadsProviderCatalogs")
		});
		const selection = await params.prompter.select({
			message: params.message ?? t("wizard.model.defaultModel"),
			options,
			initialValue: KEEP_VALUE,
			searchable: false
		});
		if (selection === KEEP_VALUE) return {};
		if (selection === MANUAL_VALUE) return promptManualModel({
			prompter: params.prompter,
			allowBlank: false,
			initialValue: configuredRaw || resolvedKey || void 0
		});
		if (selection !== BROWSE_VALUE) return { model: selection };
	}
	if (!loadCatalog) {
		const configuredLabel = await resolveConfiguredDisplayLabel();
		const options = [];
		if (allowKeep) options.push({
			value: KEEP_VALUE,
			label: formatKeepCurrentModelLabel({
				configuredRaw,
				configuredLabel,
				resolvedKey
			}),
			hint: configuredRaw && configuredRaw !== resolvedKey ? t("wizard.model.resolvesTo", { value: resolvedKey }) : void 0
		});
		if (includeManual) options.push({
			value: MANUAL_VALUE,
			label: t("wizard.model.enterManually")
		});
		if (configuredKey && !options.some((option) => option.value === configuredKey)) options.push({
			value: configuredKey,
			label: configuredKey,
			hint: t("wizard.model.current")
		});
		if (options.length === 0) return promptManualModel({
			prompter: params.prompter,
			allowBlank: allowKeep,
			initialValue: configuredRaw || resolvedKey || void 0
		});
		const selection = await params.prompter.select({
			message: params.message ?? t("wizard.model.defaultModel"),
			options,
			initialValue: allowKeep ? KEEP_VALUE : configuredKey || MANUAL_VALUE,
			searchable: false
		});
		if (selection === KEEP_VALUE) return {};
		if (selection === MANUAL_VALUE) return promptManualModel({
			prompter: params.prompter,
			allowBlank: false,
			initialValue: configuredRaw || resolvedKey || void 0
		});
		return { model: selection };
	}
	const catalogProgress = params.prompter.progress(t("wizard.model.loadingModels"));
	let catalog;
	try {
		catalog = await loadPickerModelCatalog(cfg);
	} finally {
		catalogProgress.stop();
	}
	if (catalog.length === 0) return promptManualModel({
		prompter: params.prompter,
		allowBlank: allowKeep,
		initialValue: configuredRaw || resolvedKey || void 0
	});
	const aliasIndex = buildModelAliasIndex({
		cfg,
		defaultProvider: DEFAULT_PROVIDER
	});
	const models = ignoreAllowlist ? catalog : await resolveVisibleModelCatalog({
		cfg,
		catalog,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: resolved.model,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	if (models.length === 0) return promptManualModel({
		prompter: params.prompter,
		allowBlank: allowKeep,
		initialValue: configuredRaw || resolvedKey || void 0
	});
	const filteredModels = await maybeFilterModelsByProvider({
		models,
		preferredProvider,
		prompter: params.prompter,
		cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	if (filteredModels.length === 0) return promptManualModel({
		prompter: params.prompter,
		allowBlank: allowKeep,
		initialValue: configuredRaw || resolvedKey || void 0
	});
	const matchesPreferredProvider = preferredProvider ? createPreferredProviderMatcher({
		preferredProvider,
		cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	}) : void 0;
	const hasPreferredProvider = preferredProvider ? filteredModels.some((entry) => matchesPreferredProvider?.(entry.provider)) : false;
	const hasAuth = createProviderAuthChecker({
		cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	const literalPrefixProviders = await resolveCachedLiteralPrefixProviders();
	const configuredLabel = literalPrefixProviders.has(normalizeProviderId(resolved.provider)) ? formatLiteralProviderPrefixedModelRef(resolved.provider, resolvedKey) : configuredRaw || resolvedKey;
	const options = [];
	if (allowKeep) options.push({
		value: KEEP_VALUE,
		label: formatKeepCurrentModelLabel({
			configuredRaw,
			configuredLabel,
			resolvedKey
		})
	});
	if (includeManual) options.push({
		value: MANUAL_VALUE,
		label: t("wizard.model.enterManually")
	});
	if (includeProviderPluginSetups && params.agentDir) options.push(...await resolveProviderPluginSetupOptions({
		cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	}));
	const seen = /* @__PURE__ */ new Set();
	for (const entry of filteredModels) await addModelSelectOption({
		entry,
		options,
		seen,
		aliasIndex,
		hasAuth,
		literalPrefixProviders
	});
	if (configuredKey && !seen.has(configuredKey)) options.push({
		value: configuredKey,
		label: configuredLabel,
		hint: t("wizard.model.currentNotInCatalog")
	});
	let initialValue = allowKeep ? KEEP_VALUE : configuredKey || void 0;
	if (allowKeep && hasPreferredProvider && preferredProvider && !matchesPreferredProvider?.(resolved.provider)) {
		const firstModel = filteredModels[0];
		if (firstModel) initialValue = modelKey(firstModel.provider, firstModel.id);
	}
	const selectedValue = await params.prompter.select({
		message: params.message ?? t("wizard.model.defaultModel"),
		options,
		initialValue,
		searchable: true
	}) ?? "";
	if (selectedValue === KEEP_VALUE) return {};
	if (selectedValue === MANUAL_VALUE) return promptManualModel({
		prompter: params.prompter,
		allowBlank: false,
		initialValue: configuredRaw || resolvedKey || void 0
	});
	const providerPluginResult = await maybeHandleProviderPluginSelection({
		selection: selectedValue,
		cfg,
		prompter: params.prompter,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		env: params.env,
		runtime: params.runtime
	});
	if (providerPluginResult) return providerPluginResult;
	const model = normalizeAgentModelRefForConfig(selectedValue);
	const { runProviderModelSelectedHook } = await loadResolvedModelPickerRuntime();
	await runProviderModelSelectedHook({
		config: cfg,
		model,
		prompter: params.prompter,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	return { model };
}
async function promptModelAllowlist(params) {
	const cfg = params.config;
	const existingKeys = resolveConfiguredModelKeys(cfg);
	const configuredRaw = resolveConfiguredModelRaw(cfg);
	const allowedKeys = normalizeModelKeys(params.allowedKeys ?? []);
	const allowedKeySet = allowedKeys.length > 0 ? new Set(allowedKeys) : null;
	const preferredProviderRaw = normalizeOptionalString(params.preferredProvider);
	const preferredProvider = preferredProviderRaw ? normalizeProviderId(preferredProviderRaw) : void 0;
	const resolved = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const resolvedKey = modelKey(resolved.provider, resolved.model);
	const aliasIndex = buildModelAliasIndex({
		cfg,
		defaultProvider: DEFAULT_PROVIDER
	});
	const fallbackAliasIndex = resolved.provider === "openai" ? aliasIndex : buildModelAliasIndex({
		cfg,
		defaultProvider: resolved.provider
	});
	const fallbackKeys = resolveFallbackModelKeys({
		cfg,
		rawFallbacks: resolveAgentModelFallbackValues(cfg.agents?.defaults?.model),
		defaultProvider: resolved.provider,
		aliasIndex: fallbackAliasIndex
	});
	const initialSeeds = normalizeModelKeys([
		...existingKeys,
		resolvedKey,
		...fallbackKeys,
		...params.initialSelections ?? []
	]);
	const hasRealSeed = existingKeys.length > 0 || fallbackKeys.length > 0 || (params.initialSelections?.length ?? 0) > 0 || configuredRaw.length > 0;
	const matchesPreferredProvider = preferredProvider ? createPreferredProviderMatcher({
		preferredProvider,
		cfg
	}) : void 0;
	const loadCatalog = params.loadCatalog ?? true;
	const scopedFastKeys = allowedKeys.length > 0 ? allowedKeys : !loadCatalog && preferredProvider && hasRealSeed ? initialSeeds.filter((key) => {
		const entry = splitModelKey(key);
		return entry ? matchesPreferredProvider?.(entry.provider) === true : false;
	}) : [];
	if (scopedFastKeys.length > 0) {
		const scopeKeys = allowedKeys.length > 0 ? allowedKeys : scopedFastKeys;
		const scopeKeySet = new Set(scopeKeys);
		const initialKeys = normalizeModelKeys(initialSeeds.filter((key) => scopeKeySet.has(key)));
		const options = [];
		const seen = /* @__PURE__ */ new Set();
		const hasAuth = createProviderAuthChecker({
			cfg,
			workspaceDir: params.workspaceDir,
			env: params.env
		});
		for (const key of scopeKeys) await addModelKeySelectOption({
			key,
			options,
			seen,
			aliasIndex,
			hasAuth,
			fallbackHint: allowedKeys.length > 0 ? t("wizard.model.allowed") : t("wizard.model.configured")
		});
		if (options.length === 0) return {};
		const selected = normalizeModelKeys(await params.prompter.multiselect({
			message: params.message ?? t("wizard.model.allowlistPicker"),
			options,
			initialValues: initialKeys.length > 0 ? initialKeys : void 0,
			searchable: true
		}));
		if (selected.length > 0) return {
			models: selected,
			scopeKeys
		};
		if (!await params.prompter.confirm({
			message: t("wizard.model.removeProviderModels"),
			initialValue: false
		})) return {};
		return {
			models: [],
			scopeKeys
		};
	}
	if (!loadCatalog) return {};
	const allowlistProgress = params.prompter.progress(t("wizard.model.loadingModels"));
	let catalog;
	try {
		catalog = await loadPickerModelCatalog(cfg, { preferredProvider });
	} finally {
		allowlistProgress.stop();
	}
	if (preferredProvider) {
		const configuredCatalog = buildConfiguredModelCatalog({ cfg }).filter((entry) => matchesPreferredProvider?.(entry.provider) === true);
		const configuredKeys = new Set(configuredCatalog.map((entry) => modelKey(entry.provider, entry.id)));
		catalog = [...configuredCatalog, ...catalog.filter((entry) => !configuredKeys.has(modelKey(entry.provider, entry.id)))];
	}
	if (catalog.length === 0 && allowedKeys.length === 0) {
		const noCatalogInitialKeys = existingKeys.length > 0 ? normalizeModelKeys([...existingKeys, ...fallbackKeys]) : [];
		const parsed = (await params.prompter.text({
			message: params.message ?? t("wizard.model.allowlistText"),
			initialValue: noCatalogInitialKeys.join(", "),
			placeholder: "provider/model, other-provider/model"
		}) ?? "").split(",").map((value) => value.trim()).filter((value) => value.length > 0);
		if (parsed.length === 0) return {};
		return { models: normalizeModelKeys(parsed) };
	}
	const literalPrefixProviders = await resolveLiteralPrefixProviderIds({
		cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	const options = [];
	const seen = /* @__PURE__ */ new Set();
	const allowedCatalog = (allowedKeySet ? catalog.filter((entry) => allowedKeySet.has(modelKey(entry.provider, entry.id))) : catalog).filter((entry) => isModelPickerVisibleProvider(entry.provider));
	const filteredCatalog = preferredProvider && allowedCatalog.some((entry) => matchesPreferredProvider?.(entry.provider)) ? allowedCatalog.filter((entry) => matchesPreferredProvider?.(entry.provider)) : allowedCatalog;
	const hasAuth = createProviderAuthChecker({
		cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	const scopeKeys = allowedKeySet ? allowedKeys : preferredProvider ? filteredCatalog.map((entry) => modelKey(entry.provider, entry.id)) : void 0;
	const scopeKeySet = scopeKeys ? new Set(scopeKeys) : null;
	const selectableInitialSeeds = scopeKeySet && !allowedKeySet ? initialSeeds.filter((key) => scopeKeySet.has(key)) : initialSeeds;
	const initialKeys = allowedKeySet ? initialSeeds.filter((key) => allowedKeySet.has(key)) : selectableInitialSeeds.filter(isModelPickerVisibleModelRef);
	for (const entry of filteredCatalog) await addModelSelectOption({
		entry,
		options,
		seen,
		aliasIndex,
		hasAuth,
		literalPrefixProviders
	});
	const supplementalKeys = (allowedKeySet ? allowedKeys : selectableInitialSeeds).filter(isModelPickerVisibleModelRef);
	for (const key of supplementalKeys) {
		if (seen.has(key)) continue;
		options.push({
			value: key,
			label: key,
			hint: allowedKeySet ? t("wizard.model.allowedNotInCatalog") : t("wizard.model.configuredNotInCatalog")
		});
		seen.add(key);
	}
	if (options.length === 0) return {};
	const selected = normalizeModelKeys(await params.prompter.multiselect({
		message: params.message ?? t("wizard.model.allowlistPicker"),
		options,
		initialValues: initialKeys.length > 0 ? initialKeys : void 0,
		searchable: true
	}));
	if (selected.length > 0) return {
		models: selected,
		...scopeKeys ? { scopeKeys } : {}
	};
	if (scopeKeys) {
		if (!await params.prompter.confirm({
			message: t("wizard.model.removeProviderModels"),
			initialValue: false
		})) return {};
		return {
			models: [],
			scopeKeys
		};
	}
	if (existingKeys.length === 0) return { models: [] };
	if (!await params.prompter.confirm({
		message: t("wizard.model.clearAllowlist"),
		initialValue: false
	})) return {};
	return { models: [] };
}
function applyModelAllowlist(cfg, models, opts = {}) {
	const defaults = cfg.agents?.defaults;
	const normalized = normalizeModelKeys(models);
	const scopeKeys = opts.scopeKeys ? normalizeModelKeys(opts.scopeKeys) : [];
	const scopeKeySet = scopeKeys.length > 0 ? new Set(scopeKeys) : null;
	if (normalized.length === 0) {
		if (!defaults?.models) return cfg;
		if (scopeKeySet) {
			const nextModels = { ...defaults.models };
			for (const key of scopeKeySet) delete nextModels[key];
			const { models: _ignored, ...restDefaults } = defaults;
			return {
				...cfg,
				agents: {
					...cfg.agents,
					defaults: Object.keys(nextModels).length > 0 ? {
						...defaults,
						models: nextModels
					} : restDefaults
				}
			};
		}
		const { models: _ignored, ...restDefaults } = defaults;
		return {
			...cfg,
			agents: {
				...cfg.agents,
				defaults: restDefaults
			}
		};
	}
	const existingModels = normalizeAgentModelMapForConfig(defaults?.models ?? {});
	if (scopeKeySet) {
		const nextModels = { ...existingModels };
		for (const key of scopeKeySet) delete nextModels[key];
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
function applyModelFallbacksFromSelection(cfg, selection, opts = {}) {
	const normalized = normalizeModelKeys(selection);
	const scopeKeys = opts.scopeKeys ? normalizeModelKeys(opts.scopeKeys) : [];
	const scopeKeySet = scopeKeys.length > 0 ? new Set(scopeKeys) : null;
	if (normalized.length === 0 && !scopeKeySet) return cfg;
	const resolved = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const resolvedKey = modelKey(resolved.provider, resolved.model);
	const includesResolvedPrimary = normalized.includes(resolvedKey);
	if (!includesResolvedPrimary && !scopeKeySet) return cfg;
	const defaults = cfg.agents?.defaults;
	const existingModel = defaults?.model;
	const existingPrimary = typeof existingModel === "string" ? existingModel : existingModel && typeof existingModel === "object" ? existingModel.primary : void 0;
	const normalizedExistingPrimary = existingPrimary != null ? normalizeAgentModelRefForConfig(existingPrimary) : void 0;
	const preservedModelFields = existingModel && typeof existingModel === "object" ? (({ fallbacks: _oldFallbacks, ...rest }) => rest)(existingModel) : {};
	const aliasIndex = buildModelAliasIndex({
		cfg,
		defaultProvider: resolved.provider
	});
	const existingFallbacks = existingModel && typeof existingModel === "object" && Array.isArray(existingModel.fallbacks) ? resolveFallbackModelKeys({
		cfg,
		rawFallbacks: existingModel.fallbacks,
		defaultProvider: resolved.provider,
		aliasIndex
	}) : [];
	const existingFallbackSet = new Set(existingFallbacks);
	const rawSelectedFallbacks = normalized.filter((key) => key !== resolvedKey);
	const fallbacks = mergeFallbackSelection({
		existingFallbacks,
		selectedFallbacks: scopeKeySet && !includesResolvedPrimary ? rawSelectedFallbacks.filter((key) => existingFallbackSet.has(key)) : rawSelectedFallbacks,
		preserveExistingFallback: scopeKeySet ? (fallback) => !scopeKeySet.has(fallback) : (fallback) => !isModelPickerVisibleModelRef(fallback)
	});
	const nextModel = {
		...preservedModelFields,
		...normalizedExistingPrimary != null ? { primary: normalizedExistingPrimary } : {},
		...fallbacks.length > 0 ? { fallbacks } : {}
	};
	if (Object.keys(nextModel).length === 0) {
		if (!defaults || !Object.hasOwn(defaults, "model")) return cfg;
		const { model: _ignoredModel, ...restDefaults } = defaults;
		return {
			...cfg,
			agents: {
				...cfg.agents,
				defaults: restDefaults
			}
		};
	}
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				model: nextModel
			}
		}
	};
}
function mergeFallbackSelection(params) {
	const selected = new Set(params.selectedFallbacks);
	const fallbacks = [];
	for (const fallback of params.existingFallbacks) {
		if (params.preserveExistingFallback(fallback)) {
			fallbacks.push(fallback);
			continue;
		}
		if (selected.delete(fallback)) fallbacks.push(fallback);
	}
	for (const fallback of params.selectedFallbacks) if (selected.has(fallback)) fallbacks.push(fallback);
	return fallbacks;
}
//#endregion
export { promptModelAllowlist as i, applyModelFallbacksFromSelection as n, promptDefaultModel as r, applyModelAllowlist as t };
