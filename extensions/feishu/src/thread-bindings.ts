import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingRecord,
  resolveStateDir,
  logVerbose,
  writeJsonFileAtomically,
  resolveThreadBindingConversationIdFromBindingId,
  formatThreadBindingDurationLabel,
  isAcpSessionKey,
  readAcpSessionEntry,
} from "openclaw/plugin-sdk/feishu";

const DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THREAD_BINDING_MAX_AGE_MS = 0;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
const STORE_VERSION = 1;

type FeishuBindingTargetKind = "subagent" | "acp";

export type FeishuThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  targetKind: FeishuBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

type StoredFeishuBindingState = {
  version: number;
  bindings: FeishuThreadBindingRecord[];
};

export type FeishuThreadBindingManager = {
  accountId: string;
  shouldPersistMutations: () => boolean;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByConversationId: (conversationId: string) => FeishuThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => FeishuThreadBindingRecord[];
  listBindings: () => FeishuThreadBindingRecord[];
  touchConversation: (conversationId: string, at?: number) => FeishuThreadBindingRecord | null;
  unbindConversation: (params: {
    conversationId: string;
    reason?: string;
    sendFarewell?: boolean;
  }) => FeishuThreadBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    reason?: string;
    sendFarewell?: boolean;
  }) => FeishuThreadBindingRecord[];
  stop: () => void;
};

const MANAGERS_BY_ACCOUNT_ID = new Map<string, FeishuThreadBindingManager>();
const BINDINGS_BY_ACCOUNT_CONVERSATION = new Map<string, FeishuThreadBindingRecord>();

function normalizeDurationMs(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.floor(raw));
}

function normalizeConversationId(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

function toSessionBindingTargetKind(raw: FeishuBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toFeishuTargetKind(raw: BindingTargetKind): FeishuBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

function resolveEffectiveBindingExpiresAt(params: {
  record: FeishuThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? Math.max(0, Math.floor(params.record.idleTimeoutMs))
      : params.defaultIdleTimeoutMs;
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number"
      ? Math.max(0, Math.floor(params.record.maxAgeMs))
      : params.defaultMaxAgeMs;

  const inactivityExpiresAt =
    idleTimeoutMs > 0
      ? Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs
      : undefined;
  const maxAgeExpiresAt = maxAgeMs > 0 ? params.record.boundAt + maxAgeMs : undefined;

  if (inactivityExpiresAt != null && maxAgeExpiresAt != null) {
    return Math.min(inactivityExpiresAt, maxAgeExpiresAt);
  }
  return inactivityExpiresAt ?? maxAgeExpiresAt;
}

function toSessionBindingRecord(
  record: FeishuThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  return {
    bindingId: resolveBindingKey({
      accountId: record.accountId,
      conversationId: record.conversationId,
    }),
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "feishu",
      accountId: record.accountId,
      conversationId: record.conversationId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: resolveEffectiveBindingExpiresAt({
      record,
      defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      defaultMaxAgeMs: defaults.maxAgeMs,
    }),
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs:
        typeof record.idleTimeoutMs === "number"
          ? Math.max(0, Math.floor(record.idleTimeoutMs))
          : defaults.idleTimeoutMs,
      maxAgeMs:
        typeof record.maxAgeMs === "number"
          ? Math.max(0, Math.floor(record.maxAgeMs))
          : defaults.maxAgeMs,
    },
  };
}

function fromSessionBindingInput(params: {
  accountId: string;
  input: {
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversationId: string;
    metadata?: Record<string, unknown>;
  };
}): FeishuThreadBindingRecord {
  const now = Date.now();
  const metadata = params.input.metadata ?? {};
  const existing = BINDINGS_BY_ACCOUNT_CONVERSATION.get(
    resolveBindingKey({
      accountId: params.accountId,
      conversationId: params.input.conversationId,
    }),
  );

  const record: FeishuThreadBindingRecord = {
    accountId: params.accountId,
    conversationId: params.input.conversationId,
    targetKind: toFeishuTargetKind(params.input.targetKind),
    targetSessionKey: params.input.targetSessionKey,
    agentId:
      typeof metadata.agentId === "string" && metadata.agentId.trim()
        ? metadata.agentId.trim()
        : existing?.agentId,
    label:
      typeof metadata.label === "string" && metadata.label.trim()
        ? metadata.label.trim()
        : existing?.label,
    boundBy:
      typeof metadata.boundBy === "string" && metadata.boundBy.trim()
        ? metadata.boundBy.trim()
        : existing?.boundBy,
    boundAt: now,
    lastActivityAt: now,
  };

  if (typeof metadata.idleTimeoutMs === "number" && Number.isFinite(metadata.idleTimeoutMs)) {
    record.idleTimeoutMs = Math.max(0, Math.floor(metadata.idleTimeoutMs));
  } else if (typeof existing?.idleTimeoutMs === "number") {
    record.idleTimeoutMs = existing.idleTimeoutMs;
  }

  if (typeof metadata.maxAgeMs === "number" && Number.isFinite(metadata.maxAgeMs)) {
    record.maxAgeMs = Math.max(0, Math.floor(metadata.maxAgeMs));
  } else if (typeof existing?.maxAgeMs === "number") {
    record.maxAgeMs = existing.maxAgeMs;
  }

  return record;
}

function resolveBindingsPath(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "feishu", `thread-bindings-${accountId}.json`);
}

function summarizeLifecycleForLog(
  record: FeishuThreadBindingRecord,
  defaults: {
    idleTimeoutMs: number;
    maxAgeMs: number;
  },
) {
  const idleTimeoutMs =
    typeof record.idleTimeoutMs === "number" ? record.idleTimeoutMs : defaults.idleTimeoutMs;
  const maxAgeMs = typeof record.maxAgeMs === "number" ? record.maxAgeMs : defaults.maxAgeMs;
  const idleLabel = formatThreadBindingDurationLabel(Math.max(0, Math.floor(idleTimeoutMs)));
  const maxAgeLabel = formatThreadBindingDurationLabel(Math.max(0, Math.floor(maxAgeMs)));
  return `idle=${idleLabel} maxAge=${maxAgeLabel}`;
}

function loadBindingsFromDisk(accountId: string): FeishuThreadBindingRecord[] {
  const filePath = resolveBindingsPath(accountId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as StoredFeishuBindingState;
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.bindings)) {
      return [];
    }
    const bindings: FeishuThreadBindingRecord[] = [];
    for (const entry of parsed.bindings) {
      const conversationId = normalizeConversationId(entry?.conversationId);
      const targetSessionKey =
        typeof entry?.targetSessionKey === "string" ? entry.targetSessionKey.trim() : "";
      const targetKind = entry?.targetKind === "subagent" ? "subagent" : "acp";
      if (!conversationId || !targetSessionKey) {
        continue;
      }
      const boundAt =
        typeof entry?.boundAt === "number" && Number.isFinite(entry.boundAt)
          ? Math.floor(entry.boundAt)
          : Date.now();
      const lastActivityAt =
        typeof entry?.lastActivityAt === "number" && Number.isFinite(entry.lastActivityAt)
          ? Math.floor(entry.lastActivityAt)
          : boundAt;
      const record: FeishuThreadBindingRecord = {
        accountId,
        conversationId,
        targetSessionKey,
        targetKind,
        boundAt,
        lastActivityAt,
      };
      if (typeof entry?.idleTimeoutMs === "number" && Number.isFinite(entry.idleTimeoutMs)) {
        record.idleTimeoutMs = Math.max(0, Math.floor(entry.idleTimeoutMs));
      }
      if (typeof entry?.maxAgeMs === "number" && Number.isFinite(entry.maxAgeMs)) {
        record.maxAgeMs = Math.max(0, Math.floor(entry.maxAgeMs));
      }
      if (typeof entry?.agentId === "string" && entry.agentId.trim()) {
        record.agentId = entry.agentId.trim();
      }
      if (typeof entry?.label === "string" && entry.label.trim()) {
        record.label = entry.label.trim();
      }
      if (typeof entry?.boundBy === "string" && entry.boundBy.trim()) {
        record.boundBy = entry.boundBy.trim();
      }
      bindings.push(record);
    }
    return bindings;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      logVerbose(`feishu thread bindings load failed (${accountId}): ${String(err)}`);
    }
    return [];
  }
}

async function persistBindingsToDisk(params: {
  accountId: string;
  persist: boolean;
}): Promise<void> {
  if (!params.persist) {
    return;
  }
  const bindings = [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter(
    (entry) => entry.accountId === params.accountId,
  );
  const payload: StoredFeishuBindingState = {
    version: STORE_VERSION,
    bindings,
  };
  await writeJsonFileAtomically(resolveBindingsPath(params.accountId), payload);
}

function normalizeTimestampMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return Date.now();
  }
  return Math.max(0, Math.floor(raw));
}

function shouldExpireByIdle(params: {
  now: number;
  record: FeishuThreadBindingRecord;
  defaultIdleTimeoutMs: number;
}): boolean {
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? Math.max(0, Math.floor(params.record.idleTimeoutMs))
      : params.defaultIdleTimeoutMs;
  if (idleTimeoutMs <= 0) {
    return false;
  }
  return (
    params.now >= Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs
  );
}

function shouldExpireByMaxAge(params: {
  now: number;
  record: FeishuThreadBindingRecord;
  defaultMaxAgeMs: number;
}): boolean {
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number"
      ? Math.max(0, Math.floor(params.record.maxAgeMs))
      : params.defaultMaxAgeMs;
  if (maxAgeMs <= 0) {
    return false;
  }
  return params.now >= params.record.boundAt + maxAgeMs;
}

export function createFeishuThreadBindingManager(
  params: {
    accountId?: string;
    persist?: boolean;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
    enableSweeper?: boolean;
    cfg?: import("openclaw/plugin-sdk/feishu").OpenClawConfig;
  } = {},
): FeishuThreadBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    return existing;
  }

  const persist = params.persist ?? true;
  const idleTimeoutMs = normalizeDurationMs(
    params.idleTimeoutMs,
    DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, DEFAULT_THREAD_BINDING_MAX_AGE_MS);

  const loaded = loadBindingsFromDisk(accountId);
  for (const entry of loaded) {
    const key = resolveBindingKey({
      accountId,
      conversationId: entry.conversationId,
    });
    BINDINGS_BY_ACCOUNT_CONVERSATION.set(key, {
      ...entry,
      accountId,
    });
  }

  const listBindingsForAccount = () =>
    [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter((entry) => entry.accountId === accountId);

  let sweepTimer: NodeJS.Timeout | null = null;

  const manager: FeishuThreadBindingManager = {
    accountId,
    shouldPersistMutations: () => persist,
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    getByConversationId: (conversationIdRaw) => {
      const conversationId = normalizeConversationId(conversationIdRaw);
      if (!conversationId) {
        return undefined;
      }
      return BINDINGS_BY_ACCOUNT_CONVERSATION.get(
        resolveBindingKey({
          accountId,
          conversationId,
        }),
      );
    },
    listBySessionKey: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) {
        return [];
      }
      return listBindingsForAccount().filter(
        (entry) => entry.targetSessionKey === targetSessionKey,
      );
    },
    listBindings: () => listBindingsForAccount(),
    touchConversation: (conversationIdRaw, at) => {
      const conversationId = normalizeConversationId(conversationIdRaw);
      if (!conversationId) {
        return null;
      }
      const key = resolveBindingKey({ accountId, conversationId });
      const existing = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key);
      if (!existing) {
        return null;
      }
      const nextRecord: FeishuThreadBindingRecord = {
        ...existing,
        lastActivityAt: normalizeTimestampMs(at ?? Date.now()),
      };
      BINDINGS_BY_ACCOUNT_CONVERSATION.set(key, nextRecord);
      void persistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
      return nextRecord;
    },
    unbindConversation: (unbindParams) => {
      const conversationId = normalizeConversationId(unbindParams.conversationId);
      if (!conversationId) {
        return null;
      }
      const key = resolveBindingKey({ accountId, conversationId });
      const removed = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key) ?? null;
      if (!removed) {
        return null;
      }
      BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
      void persistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
      return removed;
    },
    unbindBySessionKey: (unbindParams) => {
      const targetSessionKey = unbindParams.targetSessionKey.trim();
      if (!targetSessionKey) {
        return [];
      }
      const removed: FeishuThreadBindingRecord[] = [];
      for (const entry of listBindingsForAccount()) {
        if (entry.targetSessionKey !== targetSessionKey) {
          continue;
        }
        const key = resolveBindingKey({
          accountId,
          conversationId: entry.conversationId,
        });
        BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
        removed.push(entry);
      }
      if (removed.length > 0) {
        void persistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      // Bindings are persisted to disk and survive restarts. Only clean up the
      // adapter registration and manager reference; in-memory bindings will be
      // reloaded from disk on the next startAccount.
      unregisterSessionBindingAdapter({ channel: "feishu", accountId });
      const existingManager = MANAGERS_BY_ACCOUNT_ID.get(accountId);
      if (existingManager === manager) {
        MANAGERS_BY_ACCOUNT_ID.delete(accountId);
      }
    },
  };

  registerSessionBindingAdapter({
    channel: "feishu",
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "feishu") {
        return null;
      }
      if (input.placement === "child") {
        return null;
      }
      const conversationId = normalizeConversationId(input.conversation.conversationId);
      const targetSessionKey = input.targetSessionKey.trim();
      if (!conversationId || !targetSessionKey) {
        return null;
      }
      const record = fromSessionBindingInput({
        accountId,
        input: {
          targetSessionKey,
          targetKind: input.targetKind,
          conversationId,
          metadata: input.metadata,
        },
      });
      BINDINGS_BY_ACCOUNT_CONVERSATION.set(
        resolveBindingKey({ accountId, conversationId }),
        record,
      );
      void persistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
      logVerbose(
        `feishu: bound conversation ${conversationId} -> ${targetSessionKey} (${summarizeLifecycleForLog(
          record,
          { idleTimeoutMs, maxAgeMs },
        )})`,
      );
      return toSessionBindingRecord(record, { idleTimeoutMs, maxAgeMs });
    },
    listBySession: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) {
        return [];
      }
      return manager
        .listBySessionKey(targetSessionKey)
        .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
    },
    resolveByConversation: (ref) => {
      if (ref.channel !== "feishu") {
        return null;
      }
      const conversationId = normalizeConversationId(ref.conversationId);
      if (!conversationId) {
        return null;
      }
      const record = manager.getByConversationId(conversationId);
      return record ? toSessionBindingRecord(record, { idleTimeoutMs, maxAgeMs }) : null;
    },
    touch: (bindingId, at) => {
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (!conversationId) {
        return;
      }
      manager.touchConversation(conversationId, at);
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = manager.unbindBySessionKey({
          targetSessionKey: input.targetSessionKey,
          reason: input.reason,
          sendFarewell: false,
        });
        return removed.map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
      }
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!conversationId) {
        return [];
      }
      const removed = manager.unbindConversation({
        conversationId,
        reason: input.reason,
        sendFarewell: false,
      });
      return removed ? [toSessionBindingRecord(removed, { idleTimeoutMs, maxAgeMs })] : [];
    },
  });

  const sweeperEnabled = params.enableSweeper !== false;
  if (sweeperEnabled) {
    // Capture cfg at creation time so the sweep timer never calls loadConfig()
    // from the plugin-sdk module (whose runtimeConfigSnapshot is always null).
    const sweepCfg = params.cfg;
    sweepTimer = setInterval(() => {
      try {
        const now = Date.now();
        for (const record of listBindingsForAccount()) {
          const idleExpired = shouldExpireByIdle({
            now,
            record,
            defaultIdleTimeoutMs: idleTimeoutMs,
          });
          const maxAgeExpired = shouldExpireByMaxAge({
            now,
            record,
            defaultMaxAgeMs: maxAgeMs,
          });
          let sessionDead = false;
          if (!idleExpired && !maxAgeExpired && isAcpSessionKey(record.targetSessionKey)) {
            try {
              const sessionEntry = readAcpSessionEntry({
                sessionKey: record.targetSessionKey,
                cfg: sweepCfg,
              });
              sessionDead =
                sessionEntry != null && !sessionEntry.storeReadFailed && !sessionEntry.acp;
            } catch {
              // Fallback: if readAcpSessionEntry still fails (e.g. I/O error),
              // skip cleanup rather than dropping valid bindings.
            }
          }
          if (!idleExpired && !maxAgeExpired && !sessionDead) {
            continue;
          }
          const reason = idleExpired
            ? "idle-expired"
            : maxAgeExpired
              ? "max-age-expired"
              : "session-dead";
          manager.unbindConversation({
            conversationId: record.conversationId,
            reason,
            sendFarewell: false,
          });
        }
      } catch {
        // Safety net: never let the sweep timer crash the gateway.
      }
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  MANAGERS_BY_ACCOUNT_ID.set(accountId, manager);
  return manager;
}

export function getFeishuThreadBindingManager(
  accountId?: string,
): FeishuThreadBindingManager | null {
  return MANAGERS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId)) ?? null;
}

export const __testing = {
  resetFeishuThreadBindingsForTests() {
    for (const manager of MANAGERS_BY_ACCOUNT_ID.values()) {
      manager.stop();
    }
    MANAGERS_BY_ACCOUNT_ID.clear();
    BINDINGS_BY_ACCOUNT_CONVERSATION.clear();
  },
};
