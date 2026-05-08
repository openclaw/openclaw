import { listSessionEntries } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSubagentDepth, parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { resolveDefaultAgentId } from "./agent-scope.js";
import { normalizeSubagentSessionKey } from "./subagent-session-key.js";

type SessionDepthEntry = {
  sessionId?: unknown;
  spawnDepth?: unknown;
  spawnedBy?: unknown;
};

function normalizeSpawnDepth(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const numeric = Number(trimmed);
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
  }
  return undefined;
}

function readSessionEntriesByAgent(agentId: string): Record<string, SessionDepthEntry> {
  try {
    const store: Record<string, SessionDepthEntry> = {};
    for (const row of listSessionEntries({ agentId })) {
      store[row.sessionKey] = row.entry;
    }
    return store;
  } catch {
    // ignore missing/invalid stores
  }
  return {};
}

function buildKeyCandidates(rawKey: string, cfg?: OpenClawConfig): string[] {
  if (!cfg) {
    return [rawKey];
  }
  if (rawKey === "global" || rawKey === "unknown") {
    return [rawKey];
  }
  if (parseAgentSessionKey(rawKey)) {
    return [rawKey];
  }
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const prefixed = `agent:${defaultAgentId}:${rawKey}`;
  return prefixed === rawKey ? [rawKey] : [rawKey, prefixed];
}

function findEntryBySessionId(
  store: Record<string, SessionDepthEntry>,
  sessionId: string,
): SessionDepthEntry | undefined {
  const normalizedSessionId = normalizeSubagentSessionKey(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  for (const entry of Object.values(store)) {
    const candidateSessionId = normalizeSubagentSessionKey(entry?.sessionId);
    if (candidateSessionId && candidateSessionId === normalizedSessionId) {
      return entry;
    }
  }
  return undefined;
}

function resolveEntryForSessionKey(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  store?: Record<string, SessionDepthEntry>;
  cache: Map<string, Record<string, SessionDepthEntry>>;
}): SessionDepthEntry | undefined {
  const candidates = buildKeyCandidates(params.sessionKey, params.cfg);

  if (params.store) {
    for (const key of candidates) {
      const entry = params.store[key];
      if (entry) {
        return entry;
      }
    }
    return findEntryBySessionId(params.store, params.sessionKey);
  }

  for (const key of candidates) {
    const parsed = parseAgentSessionKey(key);
    if (!parsed?.agentId) {
      continue;
    }
    let store = params.cache.get(parsed.agentId);
    if (!store) {
      store = readSessionEntriesByAgent(parsed.agentId);
      params.cache.set(parsed.agentId, store);
    }
    const entry = store[key] ?? findEntryBySessionId(store, params.sessionKey);
    if (entry) {
      return entry;
    }
  }

  return undefined;
}

export function getSubagentDepthFromSessionEntries(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: Record<string, SessionDepthEntry>;
  },
): number {
  const raw = (sessionKey ?? "").trim();
  const fallbackDepth = getSubagentDepth(raw);
  if (!raw) {
    return fallbackDepth;
  }

  const cache = new Map<string, Record<string, SessionDepthEntry>>();
  const visited = new Set<string>();

  const depthFromStore = (key: string): number | undefined => {
    const normalizedKey = normalizeSubagentSessionKey(key);
    if (!normalizedKey) {
      return undefined;
    }
    if (visited.has(normalizedKey)) {
      return undefined;
    }
    visited.add(normalizedKey);

    const entry = resolveEntryForSessionKey({
      sessionKey: normalizedKey,
      cfg: opts?.cfg,
      store: opts?.store,
      cache,
    });

    const storedDepth = normalizeSpawnDepth(entry?.spawnDepth);
    if (storedDepth !== undefined) {
      return storedDepth;
    }

    const spawnedBy = normalizeSubagentSessionKey(entry?.spawnedBy);
    if (!spawnedBy) {
      return undefined;
    }

    const parentDepth = depthFromStore(spawnedBy);
    if (parentDepth !== undefined) {
      return parentDepth + 1;
    }

    return getSubagentDepth(spawnedBy) + 1;
  };

  return depthFromStore(raw) ?? fallbackDepth;
}
