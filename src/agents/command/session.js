import crypto from "node:crypto";
import { normalizeThinkLevel, normalizeVerboseLevel, } from "../../auto-reply/thinking.js";
import { resolveAgentIdFromSessionKey, resolveExplicitAgentSessionKey, } from "../../config/sessions/main-session.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy, } from "../../config/sessions/reset-policy.js";
import { resolveChannelResetConfig, resolveSessionResetType } from "../../config/sessions/reset.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { normalizeAgentId, normalizeMainKey } from "../../routing/session-key.js";
import { resolveSessionIdMatchSelection } from "../../sessions/session-id-resolution.js";
import { listAgentIds } from "../agent-scope.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../bootstrap-cache.js";
function buildExplicitSessionIdSessionKey(params) {
    return `agent:${normalizeAgentId(params.agentId)}:explicit:${params.sessionId.trim()}`;
}
function collectSessionIdMatchesForRequest(opts) {
    const matches = [];
    const primaryStoreMatches = [];
    const storeByKey = new Map();
    const addMatches = (candidateStore, candidateStorePath, options) => {
        for (const [candidateKey, candidateEntry] of Object.entries(candidateStore)) {
            if (candidateEntry?.sessionId !== opts.sessionId) {
                continue;
            }
            matches.push([candidateKey, candidateEntry]);
            if (options?.primary) {
                primaryStoreMatches.push([candidateKey, candidateEntry]);
            }
            storeByKey.set(candidateKey, {
                sessionKey: candidateKey,
                sessionStore: candidateStore,
                storePath: candidateStorePath,
            });
        }
    };
    addMatches(opts.sessionStore, opts.storePath, { primary: true });
    if (!opts.searchOtherAgentStores) {
        return { matches, primaryStoreMatches, storeByKey };
    }
    for (const agentId of listAgentIds(opts.cfg)) {
        if (agentId === opts.storeAgentId) {
            continue;
        }
        const candidateStorePath = resolveStorePath(opts.cfg.session?.store, { agentId });
        addMatches(loadSessionStore(candidateStorePath), candidateStorePath);
    }
    return { matches, primaryStoreMatches, storeByKey };
}
/**
 * Resolve an existing stored session key for a session id from a specific agent store.
 * This scopes the lookup to the target store without implicitly converting `agentId`
 * into that agent's main session key.
 */
export function resolveStoredSessionKeyForSessionId(opts) {
    const sessionId = opts.sessionId.trim();
    const storeAgentId = opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined;
    const storePath = resolveStorePath(opts.cfg.session?.store, {
        agentId: storeAgentId,
    });
    const sessionStore = loadSessionStore(storePath);
    if (!sessionId) {
        return { sessionKey: undefined, sessionStore, storePath };
    }
    const selection = resolveSessionIdMatchSelection(Object.entries(sessionStore).filter(([, entry]) => entry?.sessionId === sessionId), sessionId);
    return {
        sessionKey: selection.kind === "selected" ? selection.sessionKey : undefined,
        sessionStore,
        storePath,
    };
}
export function resolveSessionKeyForRequest(opts) {
    const sessionCfg = opts.cfg.session;
    const scope = sessionCfg?.scope ?? "per-sender";
    const mainKey = normalizeMainKey(sessionCfg?.mainKey);
    const requestedAgentId = opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined;
    const requestedSessionId = opts.sessionId?.trim() || undefined;
    const explicitSessionKey = opts.sessionKey?.trim() ||
        (!requestedSessionId
            ? resolveExplicitAgentSessionKey({
                cfg: opts.cfg,
                agentId: requestedAgentId,
            })
            : undefined);
    const storeAgentId = explicitSessionKey
        ? resolveAgentIdFromSessionKey(explicitSessionKey)
        : (requestedAgentId ?? normalizeAgentId(undefined));
    const storePath = resolveStorePath(sessionCfg?.store, {
        agentId: storeAgentId,
    });
    const sessionStore = loadSessionStore(storePath);
    const ctx = opts.to?.trim() ? { From: opts.to } : undefined;
    let sessionKey = explicitSessionKey ?? (ctx ? resolveSessionKey(scope, ctx, mainKey) : undefined);
    // If a session id was provided, prefer to re-use its existing entry (by id) even when no key was
    // derived. When duplicates exist across agent stores, pick the same deterministic best match used
    // by the shared gateway/session resolver helpers instead of whichever store happens to be scanned
    // first.
    if (requestedSessionId &&
        !explicitSessionKey &&
        (!sessionKey || sessionStore[sessionKey]?.sessionId !== requestedSessionId)) {
        const { matches, primaryStoreMatches, storeByKey } = collectSessionIdMatchesForRequest({
            cfg: opts.cfg,
            sessionStore,
            storePath,
            storeAgentId,
            sessionId: requestedSessionId,
            searchOtherAgentStores: requestedAgentId === undefined,
        });
        const preferredSelection = resolveSessionIdMatchSelection(matches, requestedSessionId);
        const currentStoreSelection = preferredSelection.kind === "selected"
            ? preferredSelection
            : resolveSessionIdMatchSelection(primaryStoreMatches, requestedSessionId);
        if (currentStoreSelection.kind === "selected") {
            const preferred = storeByKey.get(currentStoreSelection.sessionKey);
            if (preferred) {
                return preferred;
            }
            sessionKey = currentStoreSelection.sessionKey;
        }
    }
    if (requestedSessionId && !sessionKey) {
        sessionKey = buildExplicitSessionIdSessionKey({
            sessionId: requestedSessionId,
            agentId: opts.agentId,
        });
    }
    return { sessionKey, sessionStore, storePath };
}
export function resolveSession(opts) {
    const sessionCfg = opts.cfg.session;
    const { sessionKey, sessionStore, storePath } = resolveSessionKeyForRequest({
        cfg: opts.cfg,
        to: opts.to,
        sessionId: opts.sessionId,
        sessionKey: opts.sessionKey,
        agentId: opts.agentId,
    });
    const now = Date.now();
    const sessionEntry = sessionKey ? sessionStore[sessionKey] : undefined;
    const resetType = resolveSessionResetType({ sessionKey });
    const channelReset = resolveChannelResetConfig({
        sessionCfg,
        channel: sessionEntry?.lastChannel ?? sessionEntry?.channel ?? sessionEntry?.origin?.provider,
    });
    const resetPolicy = resolveSessionResetPolicy({
        sessionCfg,
        resetType,
        resetOverride: channelReset,
    });
    const fresh = sessionEntry
        ? evaluateSessionFreshness({ updatedAt: sessionEntry.updatedAt, now, policy: resetPolicy })
            .fresh
        : false;
    const sessionId = opts.sessionId?.trim() || (fresh ? sessionEntry?.sessionId : undefined) || crypto.randomUUID();
    const isNewSession = !fresh && !opts.sessionId;
    clearBootstrapSnapshotOnSessionRollover({
        sessionKey,
        previousSessionId: isNewSession ? sessionEntry?.sessionId : undefined,
    });
    const persistedThinking = fresh && sessionEntry?.thinkingLevel
        ? normalizeThinkLevel(sessionEntry.thinkingLevel)
        : undefined;
    const persistedVerbose = fresh && sessionEntry?.verboseLevel
        ? normalizeVerboseLevel(sessionEntry.verboseLevel)
        : undefined;
    return {
        sessionId,
        sessionKey,
        sessionEntry,
        sessionStore,
        storePath,
        isNewSession,
        persistedThinking,
        persistedVerbose,
    };
}
