import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { c as normalizeAgentId, l as normalizeMainKey, r as buildAgentMainSessionKey, t as DEFAULT_AGENT_ID, u as resolveAgentIdFromSessionKey } from "./session-key-C0K0uhmG.js";
import { S as resolveDefaultAgentId, _ as listAgentIds } from "./agent-scope-CcybJBoN.js";
import { r as resolveExplicitAgentSessionKey } from "./main-session-C7L7pyed.js";
import { u as resolveStorePath } from "./paths-B_upRR9g.js";
import { t as loadSessionStore } from "./store-load-DgTW9N4P.js";
import { o as updateSessionStore, p as resolveSessionStoreEntry } from "./store-D-yqyA6X.js";
import { s as resolveSessionLifecycleTimestamps } from "./sessions-BY1AKzIp.js";
import { c as resolveSessionResetPolicy, n as resolveChannelResetConfig, o as evaluateSessionFreshness, r as resolveSessionResetType } from "./reset-gBCpGv7M.js";
import { n as resolveSessionKey } from "./session-key-Cv9A6bMj.js";
import { f as normalizeThinkLevel, h as normalizeVerboseLevel } from "./thinking-DM5X6shA.js";
import { l as resolvePersistedSelectedModelRef, o as resolveDefaultModelForAgent, r as normalizeStoredOverrideModel } from "./model-selection-BWQiz_aq.js";
import "./runs-CpMIvPXz.js";
import { n as clearBootstrapSnapshotOnSessionRollover } from "./bootstrap-cache-CE0MU8xc.js";
import { n as resolveSessionIdMatchSelection } from "./session-id-resolution-DV3w03VE.js";
import crypto from "node:crypto";
//#region src/agents/command/session.ts
function buildExplicitSessionIdSessionKey(params) {
	return `agent:${normalizeAgentId(params.agentId)}:explicit:${params.sessionId.trim()}`;
}
function resolveLegacyMainStoreSessionForDefaultAgent(opts) {
	if (opts.defaultAgentId === "main" || !opts.sessionKey) return;
	const defaultMainSessionKey = buildAgentMainSessionKey({
		agentId: opts.defaultAgentId,
		mainKey: opts.mainKey
	});
	if (opts.sessionKey !== defaultMainSessionKey || opts.sessionStore[opts.sessionKey]) return;
	const legacyStorePath = resolveStorePath(opts.cfg.session?.store, { agentId: DEFAULT_AGENT_ID });
	const legacyKeys = [buildAgentMainSessionKey({
		agentId: DEFAULT_AGENT_ID,
		mainKey: opts.mainKey
	}), buildAgentMainSessionKey({
		agentId: DEFAULT_AGENT_ID,
		mainKey: "main"
	})];
	if (legacyStorePath === opts.storePath) {
		for (const legacyKey of legacyKeys) {
			const legacyEntry = opts.sessionStore[legacyKey];
			if (legacyEntry) {
				opts.sessionStore[opts.sessionKey] = { ...legacyEntry };
				return {
					sessionKey: opts.sessionKey,
					sessionStore: opts.sessionStore,
					storePath: opts.storePath
				};
			}
		}
		return;
	}
	const legacyStore = loadSessionStore(legacyStorePath);
	for (const legacyKey of legacyKeys) {
		const legacyEntry = legacyStore[legacyKey];
		if (legacyEntry) {
			opts.sessionStore[opts.sessionKey] = { ...legacyEntry };
			return {
				sessionKey: opts.sessionKey,
				sessionStore: opts.sessionStore,
				storePath: opts.storePath
			};
		}
	}
}
function collectSessionIdMatchesForRequest(opts) {
	const matches = [];
	const primaryStoreMatches = [];
	const storeByKey = /* @__PURE__ */ new Map();
	const addMatches = (candidateStore, candidateStorePath, options) => {
		for (const [candidateKey, candidateEntry] of Object.entries(candidateStore)) {
			if (candidateEntry?.sessionId !== opts.sessionId) continue;
			matches.push([candidateKey, candidateEntry]);
			if (options?.primary) primaryStoreMatches.push([candidateKey, candidateEntry]);
			storeByKey.set(candidateKey, {
				sessionKey: candidateKey,
				sessionStore: candidateStore,
				storePath: candidateStorePath
			});
		}
	};
	addMatches(opts.sessionStore, opts.storePath, { primary: true });
	if (!opts.searchOtherAgentStores) return {
		matches,
		primaryStoreMatches,
		storeByKey
	};
	for (const agentId of listAgentIds(opts.cfg)) {
		if (agentId === opts.storeAgentId) continue;
		const candidateStorePath = resolveStorePath(opts.cfg.session?.store, { agentId });
		addMatches(loadSessionStore(candidateStorePath), candidateStorePath);
	}
	return {
		matches,
		primaryStoreMatches,
		storeByKey
	};
}
/**
* Resolve an existing stored session key for a session id from a specific agent store.
* This scopes the lookup to the target store without implicitly converting `agentId`
* into that agent's main session key.
*/
function resolveStoredSessionKeyForSessionId(opts) {
	const sessionId = opts.sessionId.trim();
	const storeAgentId = opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : void 0;
	const storePath = resolveStorePath(opts.cfg.session?.store, { agentId: storeAgentId });
	const sessionStore = loadSessionStore(storePath);
	if (!sessionId) return {
		sessionKey: void 0,
		sessionStore,
		storePath
	};
	const selection = resolveSessionIdMatchSelection(Object.entries(sessionStore).filter(([, entry]) => entry?.sessionId === sessionId), sessionId);
	return {
		sessionKey: selection.kind === "selected" ? selection.sessionKey : void 0,
		sessionStore,
		storePath
	};
}
function resolveSessionKeyForRequest(opts) {
	const sessionCfg = opts.cfg.session;
	const scope = sessionCfg?.scope ?? "per-sender";
	const mainKey = normalizeMainKey(sessionCfg?.mainKey);
	const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(opts.cfg));
	const requestedAgentId = opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : void 0;
	const requestedSessionId = opts.sessionId?.trim() || void 0;
	const explicitSessionKey = opts.sessionKey?.trim() || (!requestedSessionId ? resolveExplicitAgentSessionKey({
		cfg: opts.cfg,
		agentId: requestedAgentId
	}) : void 0);
	const storeAgentId = explicitSessionKey ? resolveAgentIdFromSessionKey(explicitSessionKey) : requestedAgentId ?? defaultAgentId;
	const storePath = resolveStorePath(sessionCfg?.store, { agentId: storeAgentId });
	const sessionStore = loadSessionStore(storePath);
	const ctx = opts.to?.trim() ? { From: opts.to } : void 0;
	let sessionKey = explicitSessionKey ?? (ctx ? resolveSessionKey(scope, ctx, mainKey, storeAgentId) : void 0);
	if (ctx && !requestedAgentId && !requestedSessionId && !explicitSessionKey) {
		const legacyMainSession = resolveLegacyMainStoreSessionForDefaultAgent({
			cfg: opts.cfg,
			defaultAgentId,
			mainKey,
			sessionKey,
			sessionStore,
			storePath
		});
		if (legacyMainSession) return legacyMainSession;
	}
	if (requestedSessionId && !explicitSessionKey && (!sessionKey || sessionStore[sessionKey]?.sessionId !== requestedSessionId)) {
		const { matches, primaryStoreMatches, storeByKey } = collectSessionIdMatchesForRequest({
			cfg: opts.cfg,
			sessionStore,
			storePath,
			storeAgentId,
			sessionId: requestedSessionId,
			searchOtherAgentStores: requestedAgentId === void 0
		});
		const preferredSelection = resolveSessionIdMatchSelection(matches, requestedSessionId);
		const currentStoreSelection = preferredSelection.kind === "selected" ? preferredSelection : resolveSessionIdMatchSelection(primaryStoreMatches, requestedSessionId);
		if (currentStoreSelection.kind === "selected") {
			const preferred = storeByKey.get(currentStoreSelection.sessionKey);
			if (preferred) return preferred;
			sessionKey = currentStoreSelection.sessionKey;
		}
	}
	if (requestedSessionId && !sessionKey) sessionKey = buildExplicitSessionIdSessionKey({
		sessionId: requestedSessionId,
		agentId: opts.agentId
	});
	return {
		sessionKey,
		sessionStore,
		storePath
	};
}
function resolveSession(opts) {
	const sessionCfg = opts.cfg.session;
	const { sessionKey, sessionStore, storePath } = resolveSessionKeyForRequest({
		cfg: opts.cfg,
		to: opts.to,
		sessionId: opts.sessionId,
		sessionKey: opts.sessionKey,
		agentId: opts.agentId
	});
	const now = Date.now();
	const sessionEntry = sessionKey ? sessionStore[sessionKey] : void 0;
	const resetPolicy = resolveSessionResetPolicy({
		sessionCfg,
		resetType: resolveSessionResetType({ sessionKey }),
		resetOverride: resolveChannelResetConfig({
			sessionCfg,
			channel: sessionEntry?.lastChannel ?? sessionEntry?.channel ?? sessionEntry?.origin?.provider
		})
	});
	const fresh = sessionEntry ? evaluateSessionFreshness({
		updatedAt: sessionEntry.updatedAt,
		...resolveSessionLifecycleTimestamps({
			entry: sessionEntry,
			agentId: opts.agentId,
			storePath
		}),
		now,
		policy: resetPolicy
	}).fresh : false;
	const sessionId = opts.sessionId?.trim() || (fresh ? sessionEntry?.sessionId : void 0) || crypto.randomUUID();
	const isNewSession = !fresh && !opts.sessionId;
	clearBootstrapSnapshotOnSessionRollover({
		sessionKey,
		previousSessionId: isNewSession ? sessionEntry?.sessionId : void 0
	});
	return {
		sessionId,
		sessionKey,
		sessionEntry,
		sessionStore,
		storePath,
		isNewSession,
		persistedThinking: fresh && sessionEntry?.thinkingLevel ? normalizeThinkLevel(sessionEntry.thinkingLevel) : void 0,
		persistedVerbose: fresh && sessionEntry?.verboseLevel ? normalizeVerboseLevel(sessionEntry.verboseLevel) : void 0
	};
}
//#endregion
//#region src/agents/live-model-switch.ts
function resolveLiveSessionModelSelection(params) {
	const sessionKey = normalizeOptionalString(params.sessionKey);
	const cfg = params.cfg;
	if (!cfg || !sessionKey) return null;
	const agentId = normalizeOptionalString(params.agentId);
	const defaultModelRef = agentId ? resolveDefaultModelForAgent({
		cfg,
		agentId
	}) : {
		provider: params.defaultProvider,
		model: params.defaultModel
	};
	const entry = loadSessionStore(resolveStorePath(cfg.session?.store, { agentId }), { skipCache: true })[sessionKey];
	const normalizedSelection = normalizeStoredOverrideModel({
		providerOverride: entry?.providerOverride,
		modelOverride: entry?.modelOverride
	});
	const persisted = resolvePersistedSelectedModelRef({
		defaultProvider: defaultModelRef.provider,
		runtimeProvider: entry?.modelProvider,
		runtimeModel: entry?.model,
		overrideProvider: normalizedSelection.providerOverride,
		overrideModel: normalizedSelection.modelOverride
	});
	const provider = persisted?.provider ?? normalizedSelection.providerOverride ?? entry?.providerOverride?.trim() ?? defaultModelRef.provider;
	const model = persisted?.model ?? defaultModelRef.model;
	const authProfileId = normalizeOptionalString(entry?.authProfileOverride);
	return {
		provider,
		model,
		authProfileId,
		authProfileIdSource: authProfileId ? entry?.authProfileOverrideSource : void 0
	};
}
function hasDifferentLiveSessionModelSelection(current, next) {
	if (!next) return false;
	return current.provider !== next.provider || current.model !== next.model || normalizeOptionalString(current.authProfileId) !== next.authProfileId || (normalizeOptionalString(current.authProfileId) ? current.authProfileIdSource : void 0) !== next.authProfileIdSource;
}
/**
* Check whether a user-initiated live model switch is pending for the given
* session.  Returns the persisted model selection when the session's
* `liveModelSwitchPending` flag is `true` AND the persisted selection differs
* from the currently running model; otherwise returns `undefined`.
*
* When the flag is set but the current model already matches the persisted
* selection (e.g. the switch was applied as an override and the current
* attempt is already using the new model), the flag is consumed (cleared)
* eagerly to prevent it from persisting as stale state.
*
* **Deferral semantics:** The caller in `run.ts` only acts on the returned
* selection when `canRestartForLiveSwitch` is `true`.  If the run cannot
* restart (e.g. a tool call is in progress), the flag intentionally remains
* set so the switch fires on the next clean retry opportunity — even if that
* falls into a subsequent user turn.
*
* This replaces the previous approach that used an in-memory map
* (`consumeEmbeddedRunModelSwitch`) which could not distinguish between
* user-initiated `/model` switches and system-initiated fallback rotations.
*/
function shouldSwitchToLiveModel(params) {
	const sessionKey = params.sessionKey?.trim();
	const cfg = params.cfg;
	if (!cfg || !sessionKey) return;
	if (!loadSessionStore(resolveStorePath(cfg.session?.store, { agentId: params.agentId?.trim() }), { skipCache: true })[sessionKey]?.liveModelSwitchPending) return;
	const persisted = resolveLiveSessionModelSelection({
		cfg,
		sessionKey,
		agentId: params.agentId,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel
	});
	if (!hasDifferentLiveSessionModelSelection({
		provider: params.currentProvider,
		model: params.currentModel,
		authProfileId: params.currentAuthProfileId,
		authProfileIdSource: params.currentAuthProfileIdSource
	}, persisted)) {
		clearLiveModelSwitchPending({
			cfg,
			sessionKey,
			agentId: params.agentId
		}).catch(() => {});
		return;
	}
	return persisted ?? void 0;
}
/**
* Clear the `liveModelSwitchPending` flag from the session entry on disk so
* subsequent retry iterations do not re-trigger the switch.
*/
async function clearLiveModelSwitchPending(params) {
	const sessionKey = params.sessionKey?.trim();
	const cfg = params.cfg;
	if (!cfg || !sessionKey) return;
	const storePath = resolveStorePath(cfg.session?.store, { agentId: params.agentId?.trim() });
	if (!storePath) return;
	await updateSessionStore(storePath, (store) => {
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey
		});
		const entry = resolved.existing;
		if (entry) {
			delete entry.liveModelSwitchPending;
			store[resolved.normalizedKey] = entry;
			for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
		}
	});
}
//#endregion
export { resolveSessionKeyForRequest as a, resolveSession as i, shouldSwitchToLiveModel as n, resolveStoredSessionKeyForSessionId as o, buildExplicitSessionIdSessionKey as r, clearLiveModelSwitchPending as t };
