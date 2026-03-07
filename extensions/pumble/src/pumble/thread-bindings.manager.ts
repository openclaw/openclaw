import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { createPumbleClient, postPumbleMessage } from "./client.js";
import {
  BINDINGS_BY_THREAD_ROOT_ID,
  MANAGERS_BY_ACCOUNT_ID,
  PERSIST_BY_ACCOUNT_ID,
  ensureBindingsLoaded,
  removeBindingRecord,
  resolveAgentIdFromSessionKey,
  resolveBindingIdsForSession,
  saveBindingsToDisk,
  setBindingRecord,
  shouldDefaultPersist,
  toBindingRecordKey,
} from "./thread-bindings.state.js";
import {
  DEFAULT_PUMBLE_FAREWELL_TEXT,
  DEFAULT_PUMBLE_THREAD_BINDING_TTL_MS,
  PUMBLE_THREAD_BINDINGS_SWEEP_INTERVAL_MS,
  type PumbleThreadBindingManager,
  type PumbleThreadBindingRecord,
} from "./thread-bindings.types.js";

function normalizeSessionTtlMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_PUMBLE_THREAD_BINDING_TTL_MS;
  }
  const ttlMs = Math.floor(raw);
  if (ttlMs < 0) {
    return DEFAULT_PUMBLE_THREAD_BINDING_TTL_MS;
  }
  return ttlMs;
}

function formatTtlLabel(ttlMs: number): string {
  if (ttlMs <= 0) {
    return "disabled";
  }
  if (ttlMs < 60_000) {
    return "<1m";
  }
  const totalMinutes = Math.floor(ttlMs / 60_000);
  if (totalMinutes % 60 === 0) {
    return `${Math.floor(totalMinutes / 60)}h`;
  }
  return `${totalMinutes}m`;
}

function resolveIntroText(params: {
  agentId?: string;
  label?: string;
  sessionTtlMs: number;
}): string {
  const label = params.label?.trim();
  const base =
    (label || params.agentId?.trim() || "agent").replace(/\s+/g, " ").trim().slice(0, 100) ||
    "agent";
  if (params.sessionTtlMs > 0) {
    return `${base} session active (auto-unfocus in ${formatTtlLabel(params.sessionTtlMs)}). Messages here go directly to this session.`;
  }
  return `${base} session active. Messages here go directly to this session.`;
}

function resolveFarewellText(params: { reason?: string; sessionTtlMs: number }): string {
  if (params.reason === "ttl-expired") {
    return `Session ended automatically after ${formatTtlLabel(params.sessionTtlMs)}. Messages here will no longer be routed.`;
  }
  return DEFAULT_PUMBLE_FAREWELL_TEXT;
}

function resolveBindingExpiresAt(params: {
  record: Pick<PumbleThreadBindingRecord, "boundAt" | "expiresAt">;
  sessionTtlMs: number;
}): number | undefined {
  if (typeof params.record.expiresAt === "number" && Number.isFinite(params.record.expiresAt)) {
    const explicitExpiresAt = Math.floor(params.record.expiresAt);
    if (explicitExpiresAt <= 0) {
      return undefined;
    }
    return explicitExpiresAt;
  }
  if (params.sessionTtlMs <= 0) {
    return undefined;
  }
  const boundAt = Math.floor(params.record.boundAt);
  if (!Number.isFinite(boundAt) || boundAt <= 0) {
    return undefined;
  }
  return boundAt + params.sessionTtlMs;
}

async function sendThreadMessage(params: {
  botToken: string;
  appKey?: string;
  channelId: string;
  threadRootId: string;
  text: string;
}) {
  try {
    const client = createPumbleClient({ botToken: params.botToken, appKey: params.appKey });
    await postPumbleMessage(client, {
      channelId: params.channelId,
      text: params.text,
      threadRootId: params.threadRootId,
    });
  } catch {
    // Best-effort: farewell/intro failures are non-fatal
  }
}

export function createPumbleThreadBindingManager(params: {
  accountId?: string;
  botToken?: string;
  appKey?: string;
  persist?: boolean;
  enableSweeper?: boolean;
  sessionTtlMs?: number;
}): PumbleThreadBindingManager {
  ensureBindingsLoaded();
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    return existing;
  }

  const persist = params.persist ?? shouldDefaultPersist();
  PERSIST_BY_ACCOUNT_ID.set(accountId, persist);
  const sessionTtlMs = normalizeSessionTtlMs(params.sessionTtlMs);
  const botToken = params.botToken?.trim() ?? "";
  const appKey = params.appKey?.trim();

  let sweepTimer: NodeJS.Timeout | null = null;

  const manager: PumbleThreadBindingManager = {
    accountId,
    getSessionTtlMs: () => sessionTtlMs,
    getByThreadRootId: (threadRootId) => {
      const key = toBindingRecordKey({ accountId, threadRootId: threadRootId.trim() });
      const entry = BINDINGS_BY_THREAD_ROOT_ID.get(key);
      if (!entry || entry.accountId !== accountId) {
        return undefined;
      }
      return entry;
    },
    listBySessionKey: (targetSessionKey) => {
      const ids = resolveBindingIdsForSession({ targetSessionKey, accountId });
      return ids
        .map((bindingKey) => BINDINGS_BY_THREAD_ROOT_ID.get(bindingKey))
        .filter((entry): entry is PumbleThreadBindingRecord => Boolean(entry));
    },
    listBindings: () =>
      [...BINDINGS_BY_THREAD_ROOT_ID.values()].filter((entry) => entry.accountId === accountId),
    bindTarget: async (bindParams) => {
      const channelId = bindParams.channelId?.trim();
      if (!channelId) {
        return null;
      }
      const targetSessionKey = bindParams.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }
      if (!botToken) {
        return null;
      }

      const replyToId = bindParams.replyToId?.trim() || undefined;
      let threadRootId: string;

      // When sendIntro is false and we have a replyToId, skip the intro POST
      // and use the replyToId directly as the thread root.
      if (bindParams.sendIntro === false && replyToId) {
        threadRootId = replyToId;
      } else {
        // Post intro message; when replyToId is set, post inside that thread
        // and bind to it instead of creating a new top-level thread.
        const client = createPumbleClient({ botToken, appKey });
        const introText =
          bindParams.introText?.trim() ||
          resolveIntroText({
            agentId: bindParams.agentId,
            label: bindParams.label,
            sessionTtlMs,
          });
        try {
          const introMsg = await postPumbleMessage(client, {
            channelId,
            text: introText,
            threadRootId: replyToId,
          });
          // If replying into an existing thread, bind to that thread root;
          // otherwise use the new message as the thread anchor.
          threadRootId = replyToId ?? introMsg.id;
        } catch {
          return null;
        }
      }
      if (!threadRootId) {
        return null;
      }

      const boundAt = Date.now();
      const record: PumbleThreadBindingRecord = {
        accountId,
        channelId,
        threadRootId,
        targetKind: "subagent",
        targetSessionKey,
        agentId: bindParams.agentId?.trim() || resolveAgentIdFromSessionKey(targetSessionKey),
        label: bindParams.label?.trim() || undefined,
        boundBy: bindParams.boundBy?.trim() || "system",
        boundAt,
        expiresAt: sessionTtlMs > 0 ? boundAt + sessionTtlMs : undefined,
      };

      setBindingRecord(record);
      if (persist) {
        saveBindingsToDisk();
      }
      return record;
    },
    unbindThread: (unbindParams) => {
      const key = toBindingRecordKey({
        accountId,
        threadRootId: unbindParams.threadRootId.trim(),
      });
      const existing = BINDINGS_BY_THREAD_ROOT_ID.get(key);
      if (!existing || existing.accountId !== accountId) {
        return null;
      }
      const removed = removeBindingRecord(key);
      if (!removed) {
        return null;
      }
      if (persist) {
        saveBindingsToDisk();
      }
      if (unbindParams.sendFarewell !== false && botToken) {
        const farewell = resolveFarewellText({
          reason: unbindParams.reason,
          sessionTtlMs,
        });
        void sendThreadMessage({
          botToken,
          appKey,
          channelId: removed.channelId,
          threadRootId: removed.threadRootId,
          text: farewell,
        });
      }
      return removed;
    },
    unbindBySessionKey: (unbindParams) => {
      const ids = resolveBindingIdsForSession({
        targetSessionKey: unbindParams.targetSessionKey,
        accountId,
      });
      if (ids.length === 0) {
        return [];
      }
      // Unbind each thread without per-record disk writes, then save once at the end.
      const removed: PumbleThreadBindingRecord[] = [];
      for (const bindingKey of ids) {
        const binding = BINDINGS_BY_THREAD_ROOT_ID.get(bindingKey);
        if (!binding) {
          continue;
        }
        const key = toBindingRecordKey({
          accountId,
          threadRootId: binding.threadRootId.trim(),
        });
        const entry = removeBindingRecord(key);
        if (!entry) {
          continue;
        }
        removed.push(entry);
        if (unbindParams.sendFarewell !== false && botToken) {
          const farewell = resolveFarewellText({
            reason: unbindParams.reason,
            sessionTtlMs,
          });
          void sendThreadMessage({
            botToken,
            appKey,
            channelId: entry.channelId,
            threadRootId: entry.threadRootId,
            text: farewell,
          });
        }
      }
      if (persist && removed.length > 0) {
        saveBindingsToDisk();
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      const current = MANAGERS_BY_ACCOUNT_ID.get(accountId);
      if (current === manager) {
        MANAGERS_BY_ACCOUNT_ID.delete(accountId);
      }
    },
  };

  // TTL sweep: check for expired bindings at regular intervals
  if (params.enableSweeper !== false) {
    sweepTimer = setInterval(() => {
      // Collect expired bindings without spreading the full global map.
      const expired: PumbleThreadBindingRecord[] = [];
      for (const binding of BINDINGS_BY_THREAD_ROOT_ID.values()) {
        if (binding.accountId !== accountId) {
          continue;
        }
        const expiresAt = resolveBindingExpiresAt({ record: binding, sessionTtlMs });
        if (expiresAt != null && Date.now() >= expiresAt) {
          expired.push(binding);
        }
      }
      for (const binding of expired) {
        manager.unbindThread({
          threadRootId: binding.threadRootId,
          reason: "ttl-expired",
          sendFarewell: true,
        });
      }
    }, PUMBLE_THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  MANAGERS_BY_ACCOUNT_ID.set(accountId, manager);
  return manager;
}

export function getPumbleThreadBindingManager(
  accountId?: string,
): PumbleThreadBindingManager | undefined {
  const normalized = normalizeAccountId(accountId);
  return MANAGERS_BY_ACCOUNT_ID.get(normalized);
}
