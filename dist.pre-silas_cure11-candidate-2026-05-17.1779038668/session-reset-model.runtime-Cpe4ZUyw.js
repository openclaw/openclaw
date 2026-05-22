import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { r as resolveAgentModelFallbackValues } from "./model-input-B9p-bobB.js";
import { A as resolveSessionStoreEntry } from "./store-load-lvssy8TE.js";
import { s as updateSessionStore } from "./store-BqYSXyaO.js";
import "./sessions-BVCHk8wn.js";
import { u as isModelKeyAllowedBySet } from "./model-selection-shared-D-NMyYXW.js";
import { t as applyModelOverrideToSessionEntry } from "./model-overrides-BmTV12s2.js";
import { n as resolveModelDirectiveSelection, r as resolveModelRefFromDirectiveString, t as modelKey } from "./model-selection-directive-CkwDBQ8y.js";
//#region src/auto-reply/reply/session-reset-model.ts
function splitBody(body) {
	const tokens = body.split(/\s+/).filter(Boolean);
	return {
		tokens,
		first: tokens[0],
		second: tokens[1],
		rest: tokens.slice(2)
	};
}
async function loadResetModelCatalog(cfg) {
	const { loadModelCatalog } = await import("./model-catalog-CwKHZJVA.js");
	return loadModelCatalog({ config: cfg });
}
async function resolveResetFallbackModels(params) {
	if (params.agentId) {
		const { resolveAgentModelFallbacksOverride } = await import("./agent-scope-Cfm19yoq.js");
		const override = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
		if (override !== void 0) return override;
	}
	return resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
}
async function buildResetAllowedModelKeys(params) {
	if (Object.keys(params.cfg.agents?.defaults?.models ?? {}).length > 0 || params.cfg.models?.providers) {
		const { buildAllowedModelSetWithFallbacks } = await import("./model-selection-shared-DF4FgJOw.js");
		return buildAllowedModelSetWithFallbacks(params).allowedKeys;
	}
	const allowedKeys = /* @__PURE__ */ new Set();
	for (const entry of params.catalog) allowedKeys.add(modelKey(entry.provider, entry.id));
	const defaultModel = params.defaultModel?.trim();
	if (defaultModel) allowedKeys.add(modelKey(normalizeProviderId(params.defaultProvider), defaultModel));
	return allowedKeys;
}
function buildSelectionFromExplicit(params) {
	const resolved = resolveModelRefFromDirectiveString({
		raw: params.raw,
		defaultProvider: params.defaultProvider,
		aliasIndex: params.aliasIndex
	});
	if (!resolved) return;
	const key = modelKey(resolved.ref.provider, resolved.ref.model);
	if (params.allowedModelKeys.size > 0 && !isModelKeyAllowedBySet(params.allowedModelKeys, key)) return;
	const isDefault = resolved.ref.provider === params.defaultProvider && resolved.ref.model === params.defaultModel;
	return {
		provider: resolved.ref.provider,
		model: resolved.ref.model,
		isDefault,
		...resolved.alias ? { alias: resolved.alias } : void 0
	};
}
function applySelectionToSession(params) {
	const { selection, sessionEntry, sessionStore, sessionKey, storePath } = params;
	if (!sessionEntry || !sessionStore || !sessionKey) return;
	const { updated } = applyModelOverrideToSessionEntry({
		entry: sessionEntry,
		selection
	});
	if (!updated) return;
	const memResolved = resolveSessionStoreEntry({
		store: sessionStore,
		sessionKey
	});
	sessionStore[memResolved.normalizedKey] = sessionEntry;
	for (const legacyKey of memResolved.legacyKeys) delete sessionStore[legacyKey];
	if (storePath) updateSessionStore(storePath, (store) => {
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey
		});
		store[resolved.normalizedKey] = sessionEntry;
		for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
	}).catch(() => {});
}
async function applyResetModelOverride(params) {
	if (!params.resetTriggered) return {};
	const rawBody = normalizeOptionalString(params.bodyStripped);
	if (!rawBody) return {};
	const { tokens, first, second } = splitBody(rawBody);
	if (!first) return {};
	const catalog = params.modelCatalog ?? await loadResetModelCatalog(params.cfg);
	const allowedModelKeys = await buildResetAllowedModelKeys({
		cfg: params.cfg,
		catalog,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel,
		fallbackModels: await resolveResetFallbackModels({
			cfg: params.cfg,
			agentId: params.agentId
		})
	});
	if (allowedModelKeys.size === 0) return {};
	const providers = /* @__PURE__ */ new Set();
	for (const key of allowedModelKeys) {
		const slash = key.indexOf("/");
		if (slash <= 0) continue;
		providers.add(normalizeProviderId(key.slice(0, slash)));
	}
	const resolveSelection = (raw) => resolveModelDirectiveSelection({
		raw,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel,
		aliasIndex: params.aliasIndex,
		allowedModelKeys
	});
	let selection;
	let consumed = 0;
	if (providers.has(normalizeProviderId(first)) && second) {
		const resolved = resolveSelection(`${normalizeProviderId(first)}/${second}`);
		if (resolved.selection) {
			selection = resolved.selection;
			consumed = 2;
		}
	}
	if (!selection) {
		selection = buildSelectionFromExplicit({
			raw: first,
			defaultProvider: params.defaultProvider,
			defaultModel: params.defaultModel,
			aliasIndex: params.aliasIndex,
			allowedModelKeys
		});
		if (selection) consumed = 1;
	}
	if (!selection) {
		const resolved = resolveSelection(first);
		if (providers.has(normalizeProviderId(first)) || first.trim().length >= 6) {
			selection = resolved.selection;
			if (selection) consumed = 1;
		}
	}
	if (!selection) return {};
	const cleanedBody = tokens.slice(consumed).join(" ").trim();
	params.sessionCtx.BodyStripped = cleanedBody;
	params.sessionCtx.BodyForCommands = cleanedBody;
	applySelectionToSession({
		selection,
		sessionEntry: params.sessionEntry,
		sessionStore: params.sessionStore,
		sessionKey: params.sessionKey,
		storePath: params.storePath
	});
	return {
		selection,
		cleanedBody
	};
}
//#endregion
export { applyResetModelOverride };
