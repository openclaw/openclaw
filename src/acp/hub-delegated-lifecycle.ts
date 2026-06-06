// Hub-delegated ACP worker close and maintenance helpers.
import {
  isHubDelegatedAcpSessionEntry,
  resolveHubDelegatedAcpPolicy,
  resolveHubDelegatedExpiry,
} from "@openclaw/acp-core";
import { resolveConfiguredAcpSubagentTargetIds } from "../agents/acp-subagent-targets.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readAcpSessionEntry, type AcpSessionStoreEntry } from "./runtime/session-meta.js";

export async function clearHubDelegatedSessionMarker(params: {
  storePath: string;
  storeSessionKey: string;
}): Promise<void> {
  const { updateSessionStore } = await import("../config/sessions/store.js");
  await updateSessionStore(
    params.storePath,
    (store) => {
      const entry = store[params.storeSessionKey];
      if (!entry?.hubDelegated) {
        return entry ?? null;
      }
      const next = { ...entry };
      delete next.hubDelegated;
      store[params.storeSessionKey] = next;
      return next;
    },
    {
      skipMaintenance: true,
      activeSessionKey: params.storeSessionKey,
    },
  );
}

export async function closeHubDelegatedAcpWorker(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storePath: string;
  storeSessionKey: string;
  reason: string;
  closeRuntime: (input: {
    cfg: OpenClawConfig;
    sessionKey: string;
    reason: string;
  }) => Promise<void>;
  unbind?: (input: { targetSessionKey: string; reason: string }) => Promise<unknown>;
}): Promise<void> {
  // Drop the delegate marker before runtime close so missing-metadata repair cannot
  // resurrect a worker whose sqlite metadata was already cleared.
  await clearHubDelegatedSessionMarker({
    storePath: params.storePath,
    storeSessionKey: params.storeSessionKey,
  });
  await params.closeRuntime({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    reason: params.reason,
  });
  try {
    await params.unbind?.({
      targetSessionKey: params.sessionKey,
      reason: params.reason,
    });
  } catch {
    // Binding cleanup is best-effort once the delegate marker is gone.
  }
}

export async function listHubDelegatedMaintenanceCandidates(params: {
  cfg?: OpenClawConfig;
}): Promise<AcpSessionStoreEntry[]> {
  const cfg = params.cfg ?? getRuntimeConfig();
  const bySessionKey = new Map<string, AcpSessionStoreEntry>();
  for (const agentId of resolveConfiguredAcpSubagentTargetIds(cfg)) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStore(storePath, { clone: false });
    } catch {
      continue;
    }
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!isHubDelegatedAcpSessionEntry(entry) || !entry.hubDelegated) {
        continue;
      }
      const fallbackEntry = {
        cfg,
        storePath,
        sessionKey,
        storeSessionKey: sessionKey,
        entry,
        acp: undefined,
      } satisfies AcpSessionStoreEntry;
      let enriched: AcpSessionStoreEntry = fallbackEntry;
      try {
        enriched =
          readAcpSessionEntry({
            cfg,
            sessionKey,
            clone: false,
          }) ?? fallbackEntry;
      } catch {
        enriched = fallbackEntry;
      }
      bySessionKey.set(sessionKey, enriched);
    }
  }
  return Array.from(bySessionKey.values());
}

export function resolveExpiredHubDelegatedCandidates(params: {
  entries: AcpSessionStoreEntry[];
  cfg?: OpenClawConfig;
  now?: number;
}): AcpSessionStoreEntry[] {
  const cfg = params.cfg ?? getRuntimeConfig();
  const policy = resolveHubDelegatedAcpPolicy(cfg.acp?.delegate);
  const expired: AcpSessionStoreEntry[] = [];
  for (const entry of params.entries) {
    if (!isHubDelegatedAcpSessionEntry(entry.entry) || !entry.entry?.hubDelegated) {
      continue;
    }
    const expiry = resolveHubDelegatedExpiry({
      entry: {
        hubDelegated: entry.entry.hubDelegated,
        acp: entry.acp,
      },
      policy,
      now: params.now,
    });
    if (expiry.expired) {
      expired.push(entry);
    }
  }
  return expired;
}
