import path from "node:path";
import { resolveAgentSessionDirs } from "../../agents/session-dirs.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  canonicalizeMainSessionAlias,
  resolveMainSessionKey,
} from "../../config/sessions/main-session.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions/store.js";
import {
  mergeSessionEntry,
  type SessionAcpMeta,
  type SessionEntry,
} from "../../config/sessions/types.js";
import { normalizeMainKey, parseAgentSessionKey } from "../../routing/session-key.js";

export type AcpSessionStoreEntry = {
  cfg: OpenClawConfig;
  storePath: string;
  sessionKey: string;
  storeSessionKey: string;
  entry?: SessionEntry;
  acp?: SessionAcpMeta;
  storeReadFailed?: boolean;
};

function resolveStoreLookupKeys(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  rawSessionKey?: string;
}): string[] {
  const lookupKeys: string[] = [];
  const seen = new Set<string>();
  const pushKey = (key?: string) => {
    const normalized = key?.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    lookupKeys.push(normalized);
  };

  pushKey(params.sessionKey);
  pushKey(params.rawSessionKey);

  const mainSessionKey = resolveMainSessionKey(params.cfg);
  if (params.sessionKey === mainSessionKey) {
    pushKey("main");
    pushKey(normalizeMainKey(params.cfg.session?.mainKey));
    const parsed = parseAgentSessionKey(params.sessionKey);
    if (parsed) {
      pushKey(`agent:${parsed.agentId}:main`);
    }
  }

  return lookupKeys;
}

function resolveStoreSessionKey(
  store: Record<string, SessionEntry>,
  sessionKeys: string[],
): string {
  const lookupKeys: string[] = [];
  const seen = new Set<string>();
  for (const key of sessionKeys) {
    const normalized = key.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    lookupKeys.push(normalized);
  }
  for (const lookupKey of lookupKeys) {
    if (store[lookupKey]) {
      return lookupKey;
    }
    const lower = lookupKey.toLowerCase();
    if (store[lower]) {
      return lower;
    }
    for (const key of Object.keys(store)) {
      if (key.toLowerCase() === lower) {
        return key;
      }
    }
  }
  return lookupKeys[0]?.toLowerCase() ?? "";
}

function canonicalizeAcpSessionKey(params: { cfg: OpenClawConfig; sessionKey: string }): string {
  const normalized = params.sessionKey.trim();
  if (!normalized) {
    return "";
  }
  const lowered = normalized.toLowerCase();
  if (lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  const parsed = parseAgentSessionKey(lowered);
  if (parsed) {
    return canonicalizeMainSessionAlias({
      cfg: params.cfg,
      agentId: parsed.agentId,
      sessionKey: lowered,
    });
  }
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (lowered === "main" || lowered === mainKey) {
    return resolveMainSessionKey(params.cfg);
  }
  return lowered;
}

export function resolveSessionStorePathForAcp(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
}): { cfg: OpenClawConfig; storePath: string } {
  const cfg = params.cfg ?? loadConfig();
  const canonicalKey = canonicalizeAcpSessionKey({
    cfg,
    sessionKey: params.sessionKey,
  });
  const parsed = parseAgentSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: parsed?.agentId,
  });
  return { cfg, storePath };
}

export function readAcpSessionEntry(params: {
  sessionKey: string;
  rawSessionKey?: string;
  cfg?: OpenClawConfig;
}): AcpSessionStoreEntry | null {
  const cfg = params.cfg ?? loadConfig();
  const rawSessionKey = params.rawSessionKey ?? params.sessionKey;
  const sessionKey = canonicalizeAcpSessionKey({
    cfg,
    sessionKey: params.sessionKey,
  });
  if (!sessionKey) {
    return null;
  }
  const { storePath } = resolveSessionStorePathForAcp({
    sessionKey,
    cfg,
  });
  let store: Record<string, SessionEntry>;
  let storeReadFailed = false;
  try {
    store = loadSessionStore(storePath);
  } catch {
    storeReadFailed = true;
    store = {};
  }
  const storeSessionKey = resolveStoreSessionKey(
    store,
    resolveStoreLookupKeys({
      cfg,
      sessionKey,
      rawSessionKey,
    }),
  );
  const entry = store[storeSessionKey];
  return {
    cfg,
    storePath,
    sessionKey,
    storeSessionKey,
    entry,
    acp: entry?.acp,
    storeReadFailed,
  };
}

export async function listAcpSessionEntries(params: {
  cfg?: OpenClawConfig;
}): Promise<AcpSessionStoreEntry[]> {
  const cfg = params.cfg ?? loadConfig();
  const stateDir = resolveStateDir(process.env);
  const sessionDirs = await resolveAgentSessionDirs(stateDir);
  const entries: AcpSessionStoreEntry[] = [];

  for (const sessionsDir of sessionDirs) {
    const storePath = path.join(sessionsDir, "sessions.json");
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStore(storePath);
    } catch {
      continue;
    }
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!entry?.acp) {
        continue;
      }
      entries.push({
        cfg,
        storePath,
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
  rawSessionKey?: string;
  cfg?: OpenClawConfig;
  mutate: (
    current: SessionAcpMeta | undefined,
    entry: SessionEntry | undefined,
  ) => SessionAcpMeta | null | undefined;
}): Promise<SessionEntry | null> {
  const cfg = params.cfg ?? loadConfig();
  const sessionKey = canonicalizeAcpSessionKey({
    cfg,
    sessionKey: params.sessionKey,
  });
  if (!sessionKey) {
    return null;
  }
  const { storePath } = resolveSessionStorePathForAcp({
    sessionKey,
    cfg,
  });
  const activeStoreSessionKey =
    readAcpSessionEntry({
      cfg,
      sessionKey,
      rawSessionKey: params.rawSessionKey,
    })?.storeSessionKey ?? sessionKey;
  return await updateSessionStore(
    storePath,
    (store) => {
      const storeSessionKey = resolveStoreSessionKey(
        store,
        resolveStoreLookupKeys({
          cfg,
          sessionKey,
          rawSessionKey: params.rawSessionKey,
        }),
      );
      const currentEntry = store[storeSessionKey];
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
      store[storeSessionKey] = nextEntry;
      return nextEntry;
    },
    {
      activeSessionKey: activeStoreSessionKey.toLowerCase(),
    },
  );
}
