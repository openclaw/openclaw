import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { r as resolveAgentConfig } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import "./defaults-BGwElg4C.js";
import { i as listOpenAIAuthProfileProvidersForAgentRuntime } from "./openai-codex-routing-kS7Ub1vB.js";
import { t as resolveAgentHarnessPolicy } from "./policy-AKMwD9k5.js";
import { d as parseConfiguredModelVisibilityEntries, r as buildConfiguredModelCatalog } from "./model-selection-shared-Dh1KrVmr.js";
import { n as modelKey, r as normalizeModelRef } from "./model-selection-normalize-B4tdZ1L4.js";
import { d as resolveReasoningDefault, l as resolvePersistedOverrideModelRef, m as resolveThinkingDefault } from "./model-selection-VRXWv5rs.js";
import "./selection-61FIEezO.js";
import { a as resolveContextTokensForModel } from "./context-ClRN35JE.js";
import { t as applyModelOverrideToSessionEntry } from "./model-overrides-BZTQYrDg.js";
import { t as createModelVisibilityPolicy } from "./model-visibility-policy-H_5vLqqk.js";
import { t as clearSessionAuthProfileOverride } from "./session-override-BdKkz8by.js";
import "./model-selection-directive-CN9PHsiW.js";
import { n as resolveStoredModelOverride, t as isStaleHeartbeatAutoFallbackOverride } from "./stored-model-override-IjcwakfK.js";
//#region src/auto-reply/reply/model-selection.ts
function createFastTestModelSelectionState(params) {
	return {
		provider: params.provider,
		model: params.model,
		allowedModelKeys: /* @__PURE__ */ new Set(),
		allowedModelCatalog: [],
		resetModelOverride: false,
		resetModelOverrideRef: void 0,
		resolveThinkingCatalog: async () => [],
		resolveDefaultThinkingLevel: async () => params.agentCfg?.thinkingDefault,
		resolveDefaultReasoningLevel: async () => "off",
		needsModelCatalog: false
	};
}
function shouldLogModelSelectionTiming() {
	return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}
const modelCatalogRuntimeLoader = createLazyImportLoader(() => import("./agents/model-catalog.runtime.js"));
const sessionStoreRuntimeLoader = createLazyImportLoader(() => import("./store.runtime.js"));
function loadModelCatalogRuntime() {
	return modelCatalogRuntimeLoader.load();
}
function loadSessionStoreRuntime() {
	return sessionStoreRuntimeLoader.load();
}
async function createModelSelectionState(params) {
	const timingEnabled = shouldLogModelSelectionTiming();
	const startMs = timingEnabled ? Date.now() : 0;
	const logStage = (stage, extra) => {
		if (!timingEnabled) return;
		const suffix = extra ? ` ${extra}` : "";
		console.log(`[model-selection] session=${params.sessionKey ?? "(no-session)"} stage=${stage} elapsedMs=${Date.now() - startMs}${suffix}`);
	};
	const { cfg, agentCfg, sessionEntry, sessionStore, sessionKey, parentSessionKey, storePath, defaultProvider, defaultModel } = params;
	let provider = params.provider;
	let model = params.model;
	const primaryProvider = params.primaryProvider ?? defaultProvider;
	const primaryModel = params.primaryModel ?? defaultModel;
	const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
	const visibility = parseConfiguredModelVisibilityEntries({ cfg });
	const defaultProviderVisibleByWildcard = visibility.providerWildcards.has(normalizeProviderId(defaultProvider));
	const configuredModelCatalog = buildConfiguredModelCatalog({ cfg });
	const needsModelCatalog = params.hasModelDirective || Boolean(hasAllowlist && visibility.providerWildcards.size > 0 && !defaultProviderVisibleByWildcard);
	let allowedModelKeys = /* @__PURE__ */ new Set();
	let allowedModelCatalog = configuredModelCatalog;
	let visibilityPolicy = createModelVisibilityPolicy({
		cfg,
		catalog: configuredModelCatalog,
		defaultProvider,
		defaultModel,
		agentId: params.agentId
	});
	let modelCatalog = null;
	let resetModelOverride = false;
	let resetModelOverrideRef;
	const agentEntry = params.agentId ? resolveAgentConfig(cfg, params.agentId) : void 0;
	const directStoredOverride = resolvePersistedOverrideModelRef({
		defaultProvider,
		overrideProvider: sessionEntry?.providerOverride,
		overrideModel: sessionEntry?.modelOverride
	});
	const directStoredModelOverride = directStoredOverride ? {
		...directStoredOverride,
		source: "session"
	} : null;
	const staleHeartbeatAutoFallbackOverride = isStaleHeartbeatAutoFallbackOverride({
		isHeartbeat: params.isHeartbeat,
		hasResolvedHeartbeatModelOverride: params.hasResolvedHeartbeatModelOverride,
		sessionEntry,
		storedOverride: directStoredModelOverride,
		defaultProvider,
		defaultModel,
		primaryProvider: params.primaryProvider,
		primaryModel: params.primaryModel
	});
	if (needsModelCatalog) {
		modelCatalog = await (await loadModelCatalogRuntime()).loadModelCatalog({ config: cfg });
		logStage("catalog-loaded", `entries=${modelCatalog.length}`);
		visibilityPolicy = createModelVisibilityPolicy({
			cfg,
			catalog: modelCatalog,
			defaultProvider,
			defaultModel,
			agentId: params.agentId
		});
		allowedModelCatalog = visibilityPolicy.allowedCatalog;
		allowedModelKeys = visibilityPolicy.allowedKeys;
		logStage("allowlist-built", `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`);
	} else if (hasAllowlist) {
		visibilityPolicy = createModelVisibilityPolicy({
			cfg,
			catalog: configuredModelCatalog,
			defaultProvider,
			defaultModel,
			agentId: params.agentId
		});
		allowedModelCatalog = visibilityPolicy.allowedCatalog;
		allowedModelKeys = visibilityPolicy.allowedKeys;
		logStage("configured-allowlist-built", `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`);
	} else if (configuredModelCatalog.length > 0) logStage("configured-catalog-ready", `entries=${configuredModelCatalog.length}`);
	if (sessionEntry && sessionStore && sessionKey && directStoredOverride) {
		const normalizedOverride = normalizeModelRef(directStoredOverride.provider, directStoredOverride.model);
		const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
		if (staleHeartbeatAutoFallbackOverride || !visibilityPolicy.allowsKey(key)) {
			const { updated } = applyModelOverrideToSessionEntry({
				entry: sessionEntry,
				selection: {
					provider: primaryProvider,
					model: primaryModel,
					isDefault: true
				},
				preserveAuthProfileOverride: staleHeartbeatAutoFallbackOverride
			});
			if (updated) {
				sessionStore[sessionKey] = sessionEntry;
				if (storePath) await (await loadSessionStoreRuntime()).updateSessionStore(storePath, (store) => {
					store[sessionKey] = sessionEntry;
				});
			}
			resetModelOverride = updated;
			if (updated) resetModelOverrideRef = key;
		}
	}
	if (staleHeartbeatAutoFallbackOverride) {
		const normalizedCurrentSelection = normalizeModelRef(provider, model);
		const currentSelectionKey = modelKey(normalizedCurrentSelection.provider, normalizedCurrentSelection.model);
		const normalizedDirectOverride = directStoredOverride ? normalizeModelRef(directStoredOverride.provider, directStoredOverride.model) : null;
		if (currentSelectionKey === (normalizedDirectOverride ? modelKey(normalizedDirectOverride.provider, normalizedDirectOverride.model) : void 0)) {
			provider = primaryProvider;
			model = primaryModel;
		}
	}
	const storedOverride = resolveStoredModelOverride({
		sessionEntry,
		sessionStore,
		sessionKey,
		parentSessionKey,
		defaultProvider
	});
	const skipStoredOverride = params.hasResolvedHeartbeatModelOverride === true || staleHeartbeatAutoFallbackOverride && storedOverride?.source === "session";
	if (storedOverride?.model && !skipStoredOverride) {
		const normalizedStoredOverride = normalizeModelRef(storedOverride.provider || defaultProvider, storedOverride.model);
		const key = modelKey(normalizedStoredOverride.provider, normalizedStoredOverride.model);
		if (visibilityPolicy.allowsKey(key)) {
			provider = normalizedStoredOverride.provider;
			model = normalizedStoredOverride.model;
		}
	}
	if (!params.hasModelDirective) {
		const allowedInitialSelection = visibilityPolicy.resolveSelection({
			provider,
			model
		});
		if (!allowedInitialSelection) throw new Error(`Configured default model "${modelKey(provider, model)}" is not allowed by agents.defaults.models, and no allowed model is available.`);
		provider = allowedInitialSelection.provider;
		model = allowedInitialSelection.model;
	}
	if (sessionEntry && sessionStore && sessionKey && sessionEntry.authProfileOverride) {
		const { ensureAuthProfileStore } = await import("./agents/auth-profiles.runtime.js");
		const store = ensureAuthProfileStore(void 0, { allowKeychainPrompt: false });
		logStage("auth-profile-store-loaded", `profiles=${Object.keys(store.profiles).length}`);
		const profile = store.profiles[sessionEntry.authProfileOverride];
		const profileProvider = profile ? normalizeProviderId(profile.provider) : void 0;
		const harnessPolicy = resolveAgentHarnessPolicy({
			provider,
			modelId: model,
			config: cfg,
			agentId: params.agentId,
			sessionKey
		});
		const acceptedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
			provider,
			harnessRuntime: harnessPolicy.runtime
		}).map(normalizeProviderId);
		if (!profile || !acceptedAuthProviders.includes(profileProvider ?? "")) await clearSessionAuthProfileOverride({
			sessionEntry,
			sessionStore,
			sessionKey,
			storePath
		});
	}
	let thinkingCatalog;
	const resolveThinkingCatalog = async () => {
		if (thinkingCatalog) return thinkingCatalog;
		let catalogForThinking = modelCatalog && modelCatalog.length > 0 ? modelCatalog : allowedModelCatalog;
		const selectedCatalogEntry = catalogForThinking?.find((entry) => entry.provider === provider && entry.id === model);
		if (!modelCatalog && (!selectedCatalogEntry || selectedCatalogEntry.reasoning === void 0)) {
			modelCatalog = await (await loadModelCatalogRuntime()).loadModelCatalog({ config: cfg });
			logStage("catalog-loaded-for-thinking", `entries=${modelCatalog.length}`);
			catalogForThinking = modelCatalog.find((entry) => entry.provider === provider && entry.id === model) || !catalogForThinking || catalogForThinking.length === 0 ? modelCatalog.length > 0 ? modelCatalog : allowedModelCatalog : allowedModelCatalog;
		}
		thinkingCatalog = catalogForThinking.length > 0 ? catalogForThinking : void 0;
		return thinkingCatalog;
	};
	let defaultThinkingLevel;
	const resolveDefaultThinkingLevel = async () => {
		if (defaultThinkingLevel) return defaultThinkingLevel;
		const agentThinkingDefault = agentEntry?.thinkingDefault;
		const configuredThinkingDefault = agentCfg?.thinkingDefault;
		const explicitThinkingDefault = agentThinkingDefault ?? configuredThinkingDefault;
		if (explicitThinkingDefault) {
			defaultThinkingLevel = explicitThinkingDefault;
			return defaultThinkingLevel;
		}
		const catalogForThinking = await resolveThinkingCatalog();
		defaultThinkingLevel = resolveThinkingDefault({
			cfg,
			provider,
			model,
			catalog: catalogForThinking
		}) ?? "off";
		return defaultThinkingLevel;
	};
	const resolveDefaultReasoningLevel = async () => {
		let catalogForReasoning = modelCatalog ?? allowedModelCatalog;
		if (!catalogForReasoning || catalogForReasoning.length === 0) {
			modelCatalog = await (await loadModelCatalogRuntime()).loadModelCatalog({ config: cfg });
			logStage("catalog-loaded-for-reasoning", `entries=${modelCatalog.length}`);
			catalogForReasoning = modelCatalog;
		}
		return resolveReasoningDefault({
			provider,
			model,
			catalog: catalogForReasoning
		});
	};
	return {
		provider,
		model,
		allowedModelKeys,
		allowedModelCatalog,
		resetModelOverride,
		resetModelOverrideRef,
		resolveThinkingCatalog,
		resolveDefaultThinkingLevel,
		resolveDefaultReasoningLevel,
		needsModelCatalog
	};
}
function resolveContextTokens(params) {
	const modelContextTokens = resolveContextTokensForModel({
		cfg: params.cfg,
		provider: params.provider,
		model: params.model,
		allowAsyncLoad: false
	});
	const agentContextTokens = typeof params.agentCfg?.contextTokens === "number" && params.agentCfg.contextTokens > 0 ? Math.floor(params.agentCfg.contextTokens) : void 0;
	if (agentContextTokens !== void 0) return modelContextTokens !== void 0 ? Math.min(agentContextTokens, modelContextTokens) : agentContextTokens;
	return modelContextTokens ?? 2e5;
}
//#endregion
export { createModelSelectionState as n, resolveContextTokens as r, createFastTestModelSelectionState as t };
