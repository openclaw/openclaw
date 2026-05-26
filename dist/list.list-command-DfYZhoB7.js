import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as theme, t as colorize } from "./theme-D58JpUfy.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { i as normalizeProviderIdForAuth } from "./provider-id-zTW9Rdln.js";
import { i as resolveAgentModelPrimaryValue, r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import { r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { m as loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-CgH_ZSlH.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { n as resolveProviderAuthAliasMap } from "./provider-auth-aliases-4jqi6Djx.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { s as openAIProviderUsesCodexRuntimeByDefault } from "./openai-codex-routing-DwRY-_VI.js";
import { i as buildModelAliasIndex, v as resolveConfiguredModelRef, x as resolveModelRefFromString } from "./model-selection-shared-ClxdEp4X.js";
import { i as parseModelRef, n as modelKey } from "./model-selection-normalize-CBfQo-Fd.js";
import { b as resolveProviderEnvAuthEvidence, v as listProviderEnvAuthLookupKeys, y as resolveProviderEnvApiKeyCandidates } from "./model-auth-markers-Cf78z2Zm.js";
import "./model-selection-P-81eBKx.js";
import { t as resolveEnvApiKey } from "./model-auth-env-CZ-LXyVa.js";
import { r as resolveAwsSdkEnvVarName } from "./model-auth-runtime-shared-cdTr1v5l.js";
import { c as hasSyntheticLocalProviderAuthConfig, l as hasUsableCustomProviderApiKey } from "./model-auth-Db-JGIrg.js";
import { i as formatTokenK, n as ensureFlagCompatibility } from "./shared-CXerptPG.js";
import { n as loadModelsConfigWithSource } from "./load-config-B1XseUf7.js";
import { n as formatErrorWithStack } from "./list.errors-BKEXWuM3.js";
import { i as truncate, n as isRich, r as pad, t as formatTag } from "./list.format-Bk2p2FnG.js";
//#region src/commands/models/list.auth-index.ts
function normalizeAuthProvider(provider, aliasMap) {
	const normalized = normalizeProviderIdForAuth(provider);
	return aliasMap[normalized] ?? normalized;
}
function listValidatedSyntheticAuthProviderRefs(params) {
	if (params.metadataSnapshot && (params.metadataSnapshot.registryDiagnostics?.length ?? 0) > 0) return [];
	const result = loadPluginRegistrySnapshotWithMetadata({
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		env: params.env,
		index: params.metadataSnapshot?.index
	});
	if (result.source !== "persisted" && result.source !== "provided") return [];
	return result.snapshot.plugins.filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.syntheticAuthRefs ?? []);
}
function createModelListAuthIndex(params) {
	const env = params.env ?? process.env;
	const lookupParams = {
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		env,
		metadataSnapshot: params.metadataSnapshot
	};
	const aliasMap = resolveProviderAuthAliasMap(lookupParams);
	const envCandidateMap = resolveProviderEnvApiKeyCandidates(lookupParams);
	const authEvidenceMap = resolveProviderEnvAuthEvidence(lookupParams);
	const skipSetupProviderFallback = params.metadataSnapshot !== void 0;
	const authenticatedProviders = /* @__PURE__ */ new Set();
	const syntheticAuthProviders = /* @__PURE__ */ new Set();
	const envProviderAuthCache = /* @__PURE__ */ new Map();
	const addProvider = (provider) => {
		if (!provider?.trim()) return;
		authenticatedProviders.add(normalizeAuthProvider(provider, aliasMap));
	};
	const addSyntheticProvider = (provider) => {
		const normalized = provider?.trim() ? normalizeProviderIdForAuth(provider) : "";
		if (!normalized) return;
		syntheticAuthProviders.add(normalized);
	};
	for (const credential of Object.values(params.authStore.profiles ?? {})) addProvider(credential.provider);
	for (const provider of listProviderEnvAuthLookupKeys({
		envCandidateMap,
		authEvidenceMap
	})) if (resolveEnvApiKey(provider, env, {
		aliasMap,
		candidateMap: envCandidateMap,
		authEvidenceMap,
		skipSetupProviderFallback,
		config: params.cfg,
		workspaceDir: params.workspaceDir
	})) addProvider(provider);
	if (resolveAwsSdkEnvVarName(env)) addProvider("amazon-bedrock");
	for (const provider of Object.keys(params.cfg.models?.providers ?? {})) if (hasUsableCustomProviderApiKey(params.cfg, provider, env) || hasSyntheticLocalProviderAuthConfig({
		cfg: params.cfg,
		provider
	})) addProvider(provider);
	const primaryModelProvider = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)?.split("/", 1)[0];
	if (primaryModelProvider === "openai-codex" || primaryModelProvider === "codex") addSyntheticProvider("codex");
	for (const provider of params.syntheticAuthProviderRefs ?? listValidatedSyntheticAuthProviderRefs({
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		env,
		metadataSnapshot: params.metadataSnapshot
	})) addSyntheticProvider(provider);
	const hasEnvProviderAuth = (provider) => {
		const normalized = normalizeAuthProvider(provider, aliasMap);
		const cached = envProviderAuthCache.get(normalized);
		if (cached !== void 0) return cached;
		const hasAuth = Boolean(resolveEnvApiKey(provider, env, {
			aliasMap,
			candidateMap: skipSetupProviderFallback || Object.hasOwn(envCandidateMap, normalized) ? envCandidateMap : void 0,
			authEvidenceMap: skipSetupProviderFallback || Object.hasOwn(authEvidenceMap, normalized) ? authEvidenceMap : void 0,
			skipSetupProviderFallback,
			config: params.cfg,
			workspaceDir: params.workspaceDir
		}));
		envProviderAuthCache.set(normalized, hasAuth);
		if (hasAuth) authenticatedProviders.add(normalized);
		return hasAuth;
	};
	const hasOpenAICodexRuntimeAuth = (provider) => {
		return openAIProviderUsesCodexRuntimeByDefault({
			provider: normalizeAuthProvider(provider, aliasMap),
			config: params.cfg
		}) && authenticatedProviders.has("openai-codex");
	};
	return {
		hasProviderAuth(provider) {
			const normalizedProvider = normalizeAuthProvider(provider, aliasMap);
			if (authenticatedProviders.has(normalizedProvider) || syntheticAuthProviders.has(normalizeProviderIdForAuth(provider)) || hasEnvProviderAuth(provider)) return true;
			return hasOpenAICodexRuntimeAuth(normalizedProvider);
		},
		allowsProviderAuthAvailabilityFallback(provider) {
			return hasOpenAICodexRuntimeAuth(provider);
		}
	};
}
//#endregion
//#region src/commands/models/list.configured.ts
const DISPLAY_MODEL_PARSE_OPTIONS$1 = { allowPluginNormalization: false };
function resolveConfiguredEntries(cfg) {
	const resolvedDefault = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL,
		...DISPLAY_MODEL_PARSE_OPTIONS$1
	});
	const aliasIndex = buildModelAliasIndex({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		...DISPLAY_MODEL_PARSE_OPTIONS$1
	});
	const order = [];
	const tagsByKey = /* @__PURE__ */ new Map();
	const aliasesByKey = /* @__PURE__ */ new Map();
	for (const [key, aliases] of aliasIndex.byKey.entries()) aliasesByKey.set(key, aliases);
	const addEntry = (ref, tag) => {
		const key = modelKey(ref.provider, ref.model);
		if (!tagsByKey.has(key)) {
			tagsByKey.set(key, /* @__PURE__ */ new Set());
			order.push(key);
		}
		tagsByKey.get(key)?.add(tag);
	};
	const addResolvedModelRef = (raw, tag) => {
		const resolved = resolveModelRefFromString({
			raw,
			defaultProvider: DEFAULT_PROVIDER,
			aliasIndex,
			...DISPLAY_MODEL_PARSE_OPTIONS$1
		});
		if (resolved) addEntry(resolved.ref, tag);
	};
	addEntry(resolvedDefault, "default");
	const modelFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
	const imageFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel);
	const imagePrimary = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel) ?? "";
	modelFallbacks.forEach((raw, idx) => {
		addResolvedModelRef(raw, `fallback#${idx + 1}`);
	});
	if (imagePrimary) addResolvedModelRef(imagePrimary, "image");
	imageFallbacks.forEach((raw, idx) => {
		addResolvedModelRef(raw, `img-fallback#${idx + 1}`);
	});
	for (const key of Object.keys(cfg.agents?.defaults?.models ?? {})) {
		const resolved = resolveModelRefFromString({
			cfg,
			raw: key,
			defaultProvider: DEFAULT_PROVIDER,
			aliasIndex,
			...DISPLAY_MODEL_PARSE_OPTIONS$1
		});
		if (!resolved) continue;
		addEntry(resolved.ref, "configured");
	}
	return { entries: order.map((key) => {
		const slash = key.indexOf("/");
		return {
			key,
			ref: {
				provider: slash === -1 ? key : key.slice(0, slash),
				model: slash === -1 ? "" : key.slice(slash + 1)
			},
			tags: tagsByKey.get(key) ?? /* @__PURE__ */ new Set(),
			aliases: aliasesByKey.get(key) ?? []
		};
	}) };
}
//#endregion
//#region src/commands/models/list.table.ts
const MODEL_PAD = 42;
const INPUT_PAD = 10;
const CTX_PAD = 11;
const LOCAL_PAD = 5;
const AUTH_PAD = 5;
function formatContextLabel(row) {
	if (typeof row.contextTokens === "number" && Number.isFinite(row.contextTokens) && row.contextTokens > 0 && row.contextTokens !== row.contextWindow) return `${formatTokenK(row.contextTokens)}/${formatTokenK(row.contextWindow)}`;
	return formatTokenK(row.contextWindow);
}
function printModelTable(rows, runtime, opts = {}) {
	if (opts.json) {
		writeRuntimeJson(runtime, {
			count: rows.length,
			models: rows
		});
		return;
	}
	if (opts.plain) {
		for (const row of rows) runtime.log(sanitizeTerminalText(row.key));
		return;
	}
	const rich = isRich(opts);
	const header = [
		pad("Model", MODEL_PAD),
		pad("Input", INPUT_PAD),
		pad("Ctx", CTX_PAD),
		pad("Local", LOCAL_PAD),
		pad("Auth", AUTH_PAD),
		"Tags"
	].join(" ");
	runtime.log(rich ? theme.heading(header) : header);
	for (const row of rows) {
		const keyLabel = pad(truncate(sanitizeTerminalText(row.key), MODEL_PAD), MODEL_PAD);
		const inputLabel = pad(sanitizeTerminalText(row.input) || "-", INPUT_PAD);
		const ctxLabel = pad(formatContextLabel(row), CTX_PAD);
		const localLabel = pad(row.local === null ? "-" : row.local ? "yes" : "no", LOCAL_PAD);
		const authLabel = pad(row.available === null ? "-" : row.available ? "yes" : "no", AUTH_PAD);
		const tags = row.tags.map(sanitizeTerminalText);
		const tagsLabel = tags.length > 0 ? rich ? tags.map((tag) => formatTag(tag, rich)).join(",") : tags.join(",") : "";
		const coloredInput = colorize(rich, row.input.includes("image") ? theme.accentBright : theme.info, inputLabel);
		const coloredLocal = colorize(rich, row.local === null ? theme.muted : row.local ? theme.success : theme.muted, localLabel);
		const coloredAuth = colorize(rich, row.available === null ? theme.muted : row.available ? theme.success : theme.error, authLabel);
		const line = [
			rich ? theme.accent(keyLabel) : keyLabel,
			coloredInput,
			ctxLabel,
			coloredLocal,
			coloredAuth,
			tagsLabel
		].join(" ");
		runtime.log(line);
	}
}
//#endregion
//#region src/commands/models/list.list-command.ts
const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false };
const registryLoadModuleLoader = createLazyImportLoader(() => import("./list.registry-load-D8UjnVWM.js"));
const rowSourcesModuleLoader = createLazyImportLoader(() => import("./list.row-sources-DhsljyiJ.js"));
const sourcePlanModuleLoader = createLazyImportLoader(() => import("./list.source-plan-CNQqY6IL.js"));
function loadRegistryLoadModule() {
	return registryLoadModuleLoader.load();
}
function loadRowSourcesModule() {
	return rowSourcesModuleLoader.load();
}
function loadSourcePlanModule() {
	return sourcePlanModuleLoader.load();
}
async function modelsListCommand(opts, runtime) {
	ensureFlagCompatibility(opts);
	const providerFilter = (() => {
		const raw = opts.provider?.trim();
		if (!raw) return;
		if (/\s/u.test(raw)) {
			runtime.error(`Invalid provider filter "${raw}". Use a provider id such as "moonshot", not a display label.`);
			process.exitCode = 1;
			return null;
		}
		return parseModelRef(`${raw}/_`, "openai", DISPLAY_MODEL_PARSE_OPTIONS)?.provider ?? normalizeLowercaseStringOrEmpty(raw);
	})();
	if (providerFilter === null) return;
	const [{ loadAuthProfileStoreWithoutExternalProfiles }, { resolveAgentWorkspaceDir, resolveDefaultAgentDir, resolveDefaultAgentId }, { resolveDefaultAgentWorkspaceDir }] = await Promise.all([
		import("./store-B8lw6Icl.js"),
		import("./agent-scope-CwTibfHH.js"),
		import("./workspace--gao0NyJ.js")
	]);
	const { resolvedConfig: cfg } = await loadModelsConfigWithSource({
		commandName: "models list",
		runtime
	});
	const agentDir = resolveDefaultAgentDir(cfg);
	const authStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
	const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)) ?? resolveDefaultAgentWorkspaceDir();
	const metadataSnapshot = loadManifestMetadataSnapshot({
		config: cfg,
		workspaceDir,
		env: process.env
	});
	const authIndex = createModelListAuthIndex({
		cfg,
		authStore,
		workspaceDir,
		metadataSnapshot
	});
	let modelRegistry;
	let registryModels = [];
	let discoveredKeys = /* @__PURE__ */ new Set();
	let availableKeys;
	let availabilityErrorMessage;
	const { entries } = resolveConfiguredEntries(cfg);
	const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));
	const enableSourcePlanCascade = Boolean(opts.all) || Boolean(providerFilter);
	const sourcePlanModule = enableSourcePlanCascade ? await loadSourcePlanModule() : void 0;
	const sourcePlan = sourcePlanModule ? await sourcePlanModule.planAllModelListSources({
		all: opts.all,
		enableCascade: enableSourcePlanCascade,
		providerFilter,
		cfg,
		metadataSnapshot
	}) : void 0;
	const shouldLoadRegistry = sourcePlan?.requiresInitialRegistry ?? false;
	const loadRegistryState = async (opts) => {
		const { loadListModelRegistry } = await loadRegistryLoadModule();
		const loaded = await loadListModelRegistry(cfg, {
			providerFilter,
			normalizeModels: opts?.normalizeModels ?? Boolean(providerFilter),
			loadAvailability: opts?.loadAvailability,
			workspaceDir
		});
		modelRegistry = loaded.registry;
		registryModels = loaded.models;
		discoveredKeys = loaded.discoveredKeys;
		availableKeys = loaded.availableKeys;
		availabilityErrorMessage = loaded.availabilityErrorMessage;
	};
	try {
		if (shouldLoadRegistry) await loadRegistryState();
		else if (!opts.all && opts.local) {
			const { loadConfiguredListModelRegistry } = await loadRegistryLoadModule();
			const loaded = loadConfiguredListModelRegistry(cfg, entries, {
				providerFilter,
				workspaceDir
			});
			modelRegistry = loaded.registry;
			discoveredKeys = loaded.discoveredKeys;
			availableKeys = loaded.availableKeys;
		}
	} catch (err) {
		runtime.error(`Model registry unavailable:\n${formatErrorWithStack(err)}`);
		process.exitCode = 1;
		return;
	}
	const buildRowContext = (skipRuntimeModelSuppression) => ({
		cfg,
		agentDir,
		authIndex,
		availableKeys,
		configuredByKey,
		discoveredKeys,
		filter: {
			provider: providerFilter,
			local: opts.local
		},
		skipRuntimeModelSuppression,
		metadataSnapshot,
		workspaceDir
	});
	const rows = [];
	if (enableSourcePlanCascade) {
		const { appendAllModelRowSources } = await loadRowSourcesModule();
		if (!sourcePlan || !sourcePlanModule) throw new Error("models list source plan was not initialized");
		let rowContext = buildRowContext(sourcePlan.skipRuntimeModelSuppression);
		if ((await appendAllModelRowSources({
			rows,
			entries,
			context: rowContext,
			modelRegistry,
			registryModels,
			sourcePlan
		})).requiresRegistryFallback) {
			const useScopedRegistryFallback = sourcePlan.kind === "provider-runtime-scoped";
			try {
				await loadRegistryState(useScopedRegistryFallback ? {
					normalizeModels: false,
					loadAvailability: false
				} : void 0);
			} catch (err) {
				runtime.error(`Model registry unavailable:\n${formatErrorWithStack(err)}`);
				process.exitCode = 1;
				return;
			}
			rows.length = 0;
			rowContext = buildRowContext(useScopedRegistryFallback);
			await appendAllModelRowSources({
				rows,
				entries,
				context: rowContext,
				modelRegistry,
				registryModels,
				sourcePlan: useScopedRegistryFallback ? sourcePlan : sourcePlanModule.createRegistryModelListSourcePlan()
			});
		}
	} else {
		const { appendConfiguredModelRowSources } = await loadRowSourcesModule();
		await appendConfiguredModelRowSources({
			rows,
			entries,
			modelRegistry,
			context: buildRowContext(!modelRegistry)
		});
	}
	if (availabilityErrorMessage !== void 0) runtime.error(`Model availability lookup failed; falling back to auth heuristics for discovered models: ${availabilityErrorMessage}`);
	if (rows.length === 0) {
		runtime.log("No models found.");
		return;
	}
	printModelTable(rows, runtime, opts);
}
//#endregion
export { modelsListCommand };
