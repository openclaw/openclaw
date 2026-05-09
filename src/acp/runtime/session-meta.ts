import { getRuntimeConfig } from "../../config/config.js";
import {
  getSessionEntry,
  listSessionEntries,
  upsertSessionEntry,
} from "../../config/sessions/store.js";
import { resolveAllAgentSessionDatabaseTargets } from "../../config/sessions/targets.js";
import {
  mergeSessionEntry,
  type SessionAcpMeta,
  type SessionEntry,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

export type AcpSessionStoreEntry = {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  storeSessionKey: string;
  entry?: SessionEntry;
  acp?: SessionAcpMeta;
  readFailed?: boolean;
};

function resolveStoreSessionKey(store: Record<string, SessionEntry>, sessionKey: string): string {
  const normalized = sessionKey.trim();
  if (!normalized) {
    return "";
  }
  if (store[normalized]) {
    return normalized;
  }
  const lower = normalizeLowercaseStringOrEmpty(normalized);
  if (store[lower]) {
    return lower;
  }
  for (const key of Object.keys(store)) {
    if (normalizeLowercaseStringOrEmpty(key) === lower) {
      return key;
    }
  }
  return lower;
}

function readSessionEntryWithAlias(params: { agentId: string; sessionKey: string }): {
  storeSessionKey: string;
  entry?: SessionEntry;
  readFailed?: boolean;
} {
  try {
    const entry = getSessionEntry(params);
    if (entry) {
      return { storeSessionKey: params.sessionKey, entry };
    }
    const store: Record<string, SessionEntry> = {};
    for (const row of listSessionEntries({ agentId: params.agentId })) {
      store[row.sessionKey] = row.entry;
    }
    const storeSessionKey = resolveStoreSessionKey(store, params.sessionKey);
    return {
      storeSessionKey,
      entry: store[storeSessionKey],
    };
  } catch {
    return { storeSessionKey: params.sessionKey, readFailed: true };
  }
}

function resolveSessionAgentForAcp(params: { sessionKey: string; cfg?: OpenClawConfig }): {
  cfg: OpenClawConfig;
  agentId?: string;
} {
  const cfg = params.cfg ?? getRuntimeConfig();
  const parsed = parseAgentSessionKey(params.sessionKey);
  return { cfg, agentId: parsed?.agentId };
}

export function readAcpSessionEntry(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
}): AcpSessionStoreEntry | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const { cfg, agentId } = resolveSessionAgentForAcp({
    sessionKey,
    cfg: params.cfg,
  });
  let storeSessionKey = sessionKey;
  let entry: SessionEntry | undefined;
  let readFailed = false;
  if (agentId) {
    const resolved = readSessionEntryWithAlias({ agentId, sessionKey });
    storeSessionKey = resolved.storeSessionKey;
    entry = resolved.entry;
    readFailed = resolved.readFailed === true;
  }
  return {
    cfg,
    agentId,
    sessionKey,
    storeSessionKey,
    entry,
    acp: entry?.acp,
    readFailed,
  };
}

export async function listAcpSessionEntries(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<AcpSessionStoreEntry[]> {
  const cfg = params.cfg ?? getRuntimeConfig();
  const storeTargets = await resolveAllAgentSessionDatabaseTargets(
    cfg,
    params.env ? { env: params.env } : undefined,
  );
  const entries: AcpSessionStoreEntry[] = [];

  for (const target of storeTargets) {
    let rows: Array<{ sessionKey: string; entry: SessionEntry }>;
    try {
      rows = listSessionEntries({
        agentId: target.agentId,
        ...(params.env ? { env: params.env } : {}),
      });
    } catch {
      continue;
    }
    for (const { sessionKey, entry } of rows) {
      if (!entry?.acp) {
        continue;
      }
      entries.push({
        cfg,
        agentId: target.agentId,
        sessionKey,
        storeSessionKey: sessionKey,
        entry,
        acp: entry.acp,
      });
    }
  }

  return entries;
}

export async function upsertAcpSessionMeta(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  mutate: (
    current: SessionAcpMeta | undefined,
    entry: SessionEntry | undefined,
  ) => SessionAcpMeta | null | undefined;
}): Promise<SessionEntry | null> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const agentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (!agentId) {
    return null;
  }
  const { storeSessionKey, entry: currentEntry } = readSessionEntryWithAlias({
    agentId,
    sessionKey,
  });
  const nextMeta = params.mutate(currentEntry?.acp, currentEntry);
  if (nextMeta === undefined) {
    return currentEntry ?? null;
  }
  if (nextMeta === null && !currentEntry) {
    return null;
  }

  const nextEntry = mergeSessionEntry(currentEntry, {
    acp: nextMeta ?? undefined,
  });
  if (nextMeta === null) {
    delete nextEntry.acp;
  }
  upsertSessionEntry({
    agentId,
    sessionKey: storeSessionKey,
    entry: nextEntry,
  });
  return nextEntry;
}
