import crypto from "node:crypto";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  evaluateSessionFreshness,
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveChannelResetConfig,
  resolveExplicitAgentSessionKey,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveSessionIdMatchSelection } from "../../sessions/session-id-resolution.js";
import { listAgentIds } from "../agent-scope.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../bootstrap-cache.js";

export type SessionResolution = {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  storePath: string;
  isNewSession: boolean;
  persistedThinking?: ThinkLevel;
  persistedVerbose?: VerboseLevel;
};

type SessionKeyResolution = {
  sessionKey?: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
};

type SessionIdMatchSet = {
  matches: Array<[string, SessionEntry]>;
  primaryStoreMatches: Array<[string, SessionEntry]>;
  storeByKey: Map<string, SessionKeyResolution>;
};

function collectSessionIdMatchesForRequest(opts: {
  cfg: OpenClawConfig;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  storeAgentId?: string;
  sessionId: string;
}): SessionIdMatchSet {
  const matches: Array<[string, SessionEntry]> = [];
  const primaryStoreMatches: Array<[string, SessionEntry]> = [];
  const storeByKey = new Map<string, SessionKeyResolution>();

  const addMatches = (
    candidateStore: Record<string, SessionEntry>,
    candidateStorePath: string,
    options?: { primary?: boolean },
  ): void => {
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
  for (const agentId of listAgentIds(opts.cfg)) {
    if (agentId === opts.storeAgentId) {
      continue;
    }
    const candidateStorePath = resolveStorePath(opts.cfg.session?.store, { agentId });
    addMatches(loadSessionStore(candidateStorePath), candidateStorePath);
  }

  return { matches, primaryStoreMatches, storeByKey };
}

export function resolveSessionKeyForRequest(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionKeyResolution {
  const sessionCfg = opts.cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const explicitSessionKey =
    opts.sessionKey?.trim() ||
    resolveExplicitAgentSessionKey({
      cfg: opts.cfg,
      agentId: opts.agentId,
    });
  const storeAgentId = resolveAgentIdFromSessionKey(explicitSessionKey);
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: storeAgentId,
  });
  const sessionStore = loadSessionStore(storePath);

  const ctx: MsgContext | undefined = opts.to?.trim() ? { From: opts.to } : undefined;
  let sessionKey: string | undefined =
    explicitSessionKey ?? (ctx ? resolveSessionKey(scope, ctx, mainKey) : undefined);

  // If a session id was provided, prefer to re-use its entry (by id) even when no key was derived.
  // When duplicates exist across agent stores, pick the same deterministic best match used by the
  // shared gateway/session resolver helpers instead of whichever store happens to be scanned first.
  if (
    opts.sessionId &&
    !explicitSessionKey &&
    (!sessionKey || sessionStore[sessionKey]?.sessionId !== opts.sessionId)
  ) {
    const { matches, primaryStoreMatches, storeByKey } = collectSessionIdMatchesForRequest({
      cfg: opts.cfg,
      sessionStore,
      storePath,
      storeAgentId,
      sessionId: opts.sessionId,
    });
    const preferredSelection = resolveSessionIdMatchSelection(matches, opts.sessionId);
    const currentStoreSelection =
      preferredSelection.kind === "selected"
        ? preferredSelection
        : resolveSessionIdMatchSelection(primaryStoreMatches, opts.sessionId);
    if (currentStoreSelection.kind === "selected") {
      const preferred = storeByKey.get(currentStoreSelection.sessionKey);
      if (preferred) {
        return preferred;
      }
      sessionKey = currentStoreSelection.sessionKey;
    }
  }

  return { sessionKey, sessionStore, storePath };
}

export function resolveSession(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionResolution {
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
  const sessionId =
    opts.sessionId?.trim() || (fresh ? sessionEntry?.sessionId : undefined) || crypto.randomUUID();
  const isNewSession = !fresh && !opts.sessionId;

  clearBootstrapSnapshotOnSessionRollover({
    sessionKey,
    previousSessionId: isNewSession ? sessionEntry?.sessionId : undefined,
  });

  const persistedThinking =
    fresh && sessionEntry?.thinkingLevel
      ? normalizeThinkLevel(sessionEntry.thinkingLevel)
      : undefined;
  const persistedVerbose =
    fresh && sessionEntry?.verboseLevel
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
