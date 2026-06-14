// Hub-delegated ACP worker close and maintenance helpers.
import {
  isHubDelegatedAcpSessionEntry,
  isHubDelegatedOwnedByRequester,
  resolveHubDelegatedAcpPolicy,
  resolveHubDelegatedExpiry,
  type HubDelegatedSessionMeta,
} from "@openclaw/acp-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDiscoveredAcpSessionStoreTargets } from "../agents/acp-subagent-targets.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toAcpRuntimeError } from "./runtime/errors.js";
import { readAcpSessionEntry, type AcpSessionStoreEntry } from "./runtime/session-meta.js";

export function isAcpBackendUnavailableForDelegateClose(error: unknown): boolean {
  const acpError = toAcpRuntimeError({
    error,
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP delegate close preparation failed.",
  });
  return acpError.code === "ACP_BACKEND_MISSING" || acpError.code === "ACP_BACKEND_UNAVAILABLE";
}

type HubDelegatedCloseSnapshot = {
  marker: HubDelegatedSessionMeta;
  label?: string;
  spawnedBy?: string;
  parentSessionKey?: string;
};

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
      // Close must be terminal for label routing; keep the row but drop delegate identity.
      delete next.hubDelegated;
      delete next.label;
      delete next.spawnedBy;
      delete next.parentSessionKey;
      store[params.storeSessionKey] = next;
      return next;
    },
    {
      skipMaintenance: true,
      activeSessionKey: params.storeSessionKey,
    },
  );
}

function readHubDelegatedCloseSnapshot(params: {
  storePath: string;
  storeSessionKey: string;
}): HubDelegatedCloseSnapshot | undefined {
  let store: Record<string, SessionEntry>;
  try {
    store = loadSessionStore(params.storePath, { clone: false });
  } catch {
    return undefined;
  }
  const entry = store[params.storeSessionKey];
  if (!isHubDelegatedAcpSessionEntry(entry) || !entry.hubDelegated) {
    return undefined;
  }
  return {
    marker: entry.hubDelegated,
    label: normalizeOptionalString(entry.label),
    spawnedBy: normalizeOptionalString(entry.spawnedBy),
    parentSessionKey: normalizeOptionalString(entry.parentSessionKey),
  };
}

export async function restoreHubDelegatedSessionMarker(params: {
  storePath: string;
  storeSessionKey: string;
  marker: HubDelegatedSessionMeta;
  label?: string;
  spawnedBy?: string;
  parentSessionKey?: string;
}): Promise<void> {
  const { updateSessionStore } = await import("../config/sessions/store.js");
  await updateSessionStore(
    params.storePath,
    (store) => {
      const entry = store[params.storeSessionKey];
      if (!entry) {
        return null;
      }
      const next: SessionEntry = { ...entry, hubDelegated: params.marker };
      if (params.label) {
        next.label = params.label;
      }
      if (params.spawnedBy) {
        next.spawnedBy = params.spawnedBy;
      }
      if (params.parentSessionKey) {
        next.parentSessionKey = params.parentSessionKey;
      }
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
  prepareRuntime?: (input: { cfg: OpenClawConfig; sessionKey: string }) => Promise<void>;
  closeRuntime: (input: {
    cfg: OpenClawConfig;
    sessionKey: string;
    reason: string;
  }) => Promise<void>;
  unbind?: (input: { targetSessionKey: string; reason: string }) => Promise<unknown>;
}): Promise<void> {
  // Missing ACP metadata must be repaired while the delegate marker still exists;
  // the repair classifier intentionally uses that marker as persistent evidence.
  await params.prepareRuntime?.({ cfg: params.cfg, sessionKey: params.sessionKey });
  const closeSnapshot = readHubDelegatedCloseSnapshot({
    storePath: params.storePath,
    storeSessionKey: params.storeSessionKey,
  });
  const closeDelegateRuntime = async (): Promise<void> => {
    if (closeSnapshot) {
      // Drop the delegate marker before runtime close so missing-metadata repair cannot
      // resurrect a worker whose sqlite metadata was already cleared.
      await clearHubDelegatedSessionMarker({
        storePath: params.storePath,
        storeSessionKey: params.storeSessionKey,
      });
    }
    try {
      await params.closeRuntime({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
      });
    } catch (err) {
      if (closeSnapshot) {
        try {
          await restoreHubDelegatedSessionMarker({
            storePath: params.storePath,
            storeSessionKey: params.storeSessionKey,
            marker: closeSnapshot.marker,
            label: closeSnapshot.label,
            spawnedBy: closeSnapshot.spawnedBy,
            parentSessionKey: closeSnapshot.parentSessionKey,
          });
        } catch {
          // Best-effort restore keeps maintenance/operator paths able to retry close.
        }
      }
      throw err;
    }
  };
  if (closeSnapshot) {
    const { withHubDelegatedLabelPatchLock } = await import("../gateway/sessions-patch.js");
    await withHubDelegatedLabelPatchLock(closeDelegateRuntime);
  } else {
    await closeDelegateRuntime();
  }
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
  for (const target of resolveDiscoveredAcpSessionStoreTargets(cfg)) {
    const storePath = target.storePath;
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
      let enriched: AcpSessionStoreEntry;
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

export async function listOwnedHubDelegatedSessionEntries(params: {
  cfg?: OpenClawConfig;
  requesterSessionKey: string;
}): Promise<AcpSessionStoreEntry[]> {
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  if (!requesterSessionKey) {
    return [];
  }
  const candidates = await listHubDelegatedMaintenanceCandidates({ cfg: params.cfg });
  return candidates.filter((entry) =>
    isHubDelegatedOwnedByRequester({
      entry: entry.entry,
      requesterSessionKey,
    }),
  );
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
        updatedAt: entry.entry.updatedAt,
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
