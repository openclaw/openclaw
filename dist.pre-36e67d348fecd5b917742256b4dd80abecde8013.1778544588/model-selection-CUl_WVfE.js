import { t as createLazyImportLoader } from "./lazy-promise-AiZRy56y.js";
import { v as resolveAgentConfig } from "./agent-scope-CcybJBoN.js";
import { r as normalizeProviderId } from "./provider-id-DIRgKpoh.js";
import "./defaults-xppxcKrw.js";
import { a as resolveContextTokensForModel } from "./context-D6_cAfsF.js";
import { S as normalizeModelRef, r as buildConfiguredModelCatalog, x as modelKey } from "./model-selection-shared-BQtX8Bw-.js";
import { c as resolvePersistedOverrideModelRef, p as resolveThinkingDefault, t as buildAllowedModelSet, u as resolveReasoningDefault } from "./model-selection-CyWx9aXc.js";
import { t as applyModelOverrideToSessionEntry } from "./model-overrides-D48g_2g-.js";
import { t as clearSessionAuthProfileOverride } from "./session-override-C1JZ5zv8.js";
import { t as resolveStoredModelOverride } from "./stored-model-override-D7NsWf9Z.js";
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
	const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
	const configuredModelCatalog = buildConfiguredModelCatalog({ cfg });
	const needsModelCatalog = params.hasModelDirective;
	let allowedModelKeys = /* @__PURE__ */ new Set();
	let allowedModelCatalog = configuredModelCatalog;
	let modelCatalog = null;
	let resetModelOverride = false;
	let resetModelOverrideRef;
	const agentEntry = params.agentId ? resolveAgentConfig(cfg, params.agentId) : void 0;
	const directStoredOverride = resolvePersistedOverrideModelRef({
		defaultProvider,
		overrideProvider: sessionEntry?.providerOverride,
		overrideModel: sessionEntry?.modelOverride
	});
	if (needsModelCatalog) {
		modelCatalog = await (await loadModelCatalogRuntime()).loadModelCatalog({ config: cfg });
		logStage("catalog-loaded", `entries=${modelCatalog.length}`);
		const allowed = buildAllowedModelSet({
			cfg,
			catalog: modelCatalog,
			defaultProvider,
			defaultModel,
			agentId: params.agentId
		});
		allowedModelCatalog = allowed.allowedCatalog;
		allowedModelKeys = allowed.allowedKeys;
		logStage("allowlist-built", `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`);
	} else if (hasAllowlist) {
		const allowed = buildAllowedModelSet({
			cfg,
			catalog: configuredModelCatalog,
			defaultProvider,
			defaultModel,
			agentId: params.agentId
		});
		allowedModelCatalog = allowed.allowedCatalog;
		allowedModelKeys = allowed.allowedKeys;
		logStage("configured-allowlist-built", `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`);
	} else if (configuredModelCatalog.length > 0) logStage("configured-catalog-ready", `entries=${configuredModelCatalog.length}`);
	if (sessionEntry && sessionStore && sessionKey && directStoredOverride) {
		const normalizedOverride = normalizeModelRef(directStoredOverride.provider, directStoredOverride.model);
		const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
		if (allowedModelKeys.size > 0 && !allowedModelKeys.has(key)) {
			const { updated } = applyModelOverrideToSessionEntry({
				entry: sessionEntry,
				selection: {
					provider: defaultProvider,
					model: defaultModel,
					isDefault: true
				}
			});
			if (updated) {
				const runtime = await loadSessionStoreRuntime();
				const memResolved = runtime.resolveSessionStoreEntry({
					store: sessionStore,
					sessionKey
				});
				sessionStore[memResolved.normalizedKey] = sessionEntry;
				for (const legacyKey of memResolved.legacyKeys) delete sessionStore[legacyKey];
				if (storePath) await runtime.updateSessionStore(storePath, (store) => {
					const resolved = runtime.resolveSessionStoreEntry({
						store,
						sessionKey
					});
					store[resolved.normalizedKey] = sessionEntry;
					for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
				});
			}
			resetModelOverride = updated;
			if (updated) resetModelOverrideRef = key;
		}
	}
	const storedOverride = resolveStoredModelOverride({
		sessionEntry,
		sessionStore,
		sessionKey,
		parentSessionKey,
		defaultProvider
	});
	const skipStoredOverride = params.hasResolvedHeartbeatModelOverride === true;
	if (storedOverride?.model && !skipStoredOverride) {
		const normalizedStoredOverride = normalizeModelRef(storedOverride.provider || defaultProvider, storedOverride.model);
		const key = modelKey(normalizedStoredOverride.provider, normalizedStoredOverride.model);
		if (allowedModelKeys.size === 0 || allowedModelKeys.has(key)) {
			provider = normalizedStoredOverride.provider;
			model = normalizedStoredOverride.model;
		}
	}
	if (sessionEntry && sessionStore && sessionKey && sessionEntry.authProfileOverride) {
		const { ensureAuthProfileStore } = await import("./agents/auth-profiles.runtime.js");
		const store = ensureAuthProfileStore(void 0, { allowKeychainPrompt: false });
		logStage("auth-profile-store-loaded", `profiles=${Object.keys(store.profiles).length}`);
		const profile = store.profiles[sessionEntry.authProfileOverride];
		const providerKey = normalizeProviderId(provider);
		if (!profile || normalizeProviderId(profile.provider) !== providerKey) await clearSessionAuthProfileOverride({
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
	return params.agentCfg?.contextTokens ?? resolveContextTokensForModel({
		cfg: params.cfg,
		provider: params.provider,
		model: params.model,
		allowAsyncLoad: false
	}) ?? 2e5;
}
//#endregion
export { createModelSelectionState as n, resolveContextTokens as r, createFastTestModelSelectionState as t };
