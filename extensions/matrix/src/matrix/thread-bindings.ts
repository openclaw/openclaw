import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  registerSessionBindingAdapter,
  resolveThreadBindingFarewellText,
  type SessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import type { MatrixAuth } from "./client/types.js";
import type { MatrixClient } from "./sdk.js";
import { sendMessageMatrix } from "./send.js";
import { resolveMatrixSqliteStateKey, withMatrixSqliteStateEnv } from "./sqlite-state.js";
import {
  deleteMatrixThreadBindingManagerEntry,
  getMatrixThreadBindingManager,
  getMatrixThreadBindingManagerEntry,
  listBindingsForAccount,
  removeBindingRecord,
  resetMatrixThreadBindingsForTests,
  resolveBindingKey,
  resolveEffectiveBindingExpiry,
  setBindingRecord,
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingManagerEntry,
  setMatrixThreadBindingMaxAgeBySessionKey,
  toMatrixBindingTargetKind,
  toSessionBindingRecord,
  type MatrixThreadBindingManager,
  type MatrixThreadBindingRecord,
} from "./thread-bindings-shared.js";

const MATRIX_PLUGIN_ID = "matrix";
const THREAD_BINDINGS_NAMESPACE = "thread-bindings";
const THREAD_BINDINGS_MAX_ENTRIES = 10_000;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
const threadBindingStore = createPluginStateSyncKeyedStore<MatrixThreadBindingRecord>(
  MATRIX_PLUGIN_ID,
  {
    namespace: THREAD_BINDINGS_NAMESPACE,
    maxEntries: THREAD_BINDINGS_MAX_ENTRIES,
  },
);

function _normalizeDurationMs(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.floor(raw));
}

function buildThreadBindingStoreKey(record: {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): string {
  const digest = createHash("sha256")
    .update(record.accountId)
    .update("\0")
    .update(record.parentConversationId ?? "")
    .update("\0")
    .update(record.conversationId)
    .digest("hex");
  return `${record.accountId}:${digest}`;
}

function normalizeBindingRecord(
  entry: unknown,
  accountId: string,
): MatrixThreadBindingRecord | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Partial<MatrixThreadBindingRecord>;
  if (record.accountId !== accountId) {
    return null;
  }
  const conversationId = normalizeOptionalString(record.conversationId);
  const parentConversationId = normalizeOptionalString(record.parentConversationId);
  const targetSessionKey = normalizeOptionalString(record.targetSessionKey) ?? "";
  if (!conversationId || !targetSessionKey) {
    return null;
  }
  const boundAt =
    typeof record.boundAt === "number" && Number.isFinite(record.boundAt)
      ? Math.floor(record.boundAt)
      : Date.now();
  const lastActivityAt =
    typeof record.lastActivityAt === "number" && Number.isFinite(record.lastActivityAt)
      ? Math.floor(record.lastActivityAt)
      : boundAt;
  return {
    accountId,
    conversationId,
    ...(parentConversationId ? { parentConversationId } : {}),
    targetKind: record.targetKind === "subagent" ? "subagent" : "acp",
    targetSessionKey,
    agentId: normalizeOptionalString(record.agentId) || undefined,
    label: normalizeOptionalString(record.label) || undefined,
    boundBy: normalizeOptionalString(record.boundBy) || undefined,
    boundAt,
    lastActivityAt: Math.max(lastActivityAt, boundAt),
    idleTimeoutMs:
      typeof record.idleTimeoutMs === "number" && Number.isFinite(record.idleTimeoutMs)
        ? Math.max(0, Math.floor(record.idleTimeoutMs))
        : undefined,
    maxAgeMs:
      typeof record.maxAgeMs === "number" && Number.isFinite(record.maxAgeMs)
        ? Math.max(0, Math.floor(record.maxAgeMs))
        : undefined,
  };
}

function loadBindingsFromSqlite(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): MatrixThreadBindingRecord[] {
  const loaded: MatrixThreadBindingRecord[] = [];
  const entries = withMatrixSqliteStateEnv(params, () => threadBindingStore.entries());
  for (const entry of entries) {
    const record = normalizeBindingRecord(entry.value, params.accountId);
    if (record) {
      loaded.push(record);
    }
  }
  return loaded;
}

function persistBindingRecord(params: {
  record: MatrixThreadBindingRecord;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): void {
  withMatrixSqliteStateEnv(params, () => {
    threadBindingStore.register(
      buildThreadBindingStoreKey(params.record),
      toPluginJsonValue(params.record),
    );
  });
}

function persistBindingsSnapshot(params: {
  accountId: string;
  bindings: MatrixThreadBindingRecord[];
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): void {
  const liveKeys = new Set(params.bindings.map((record) => buildThreadBindingStoreKey(record)));
  withMatrixSqliteStateEnv(params, () => {
    for (const entry of threadBindingStore.entries()) {
      const record = normalizeBindingRecord(entry.value, params.accountId);
      if (record && !liveKeys.has(entry.key)) {
        threadBindingStore.delete(entry.key);
      }
    }
    for (const record of params.bindings) {
      threadBindingStore.register(buildThreadBindingStoreKey(record), toPluginJsonValue(record));
    }
  });
}

function deleteBindingRecordFromSqlite(params: {
  record: MatrixThreadBindingRecord;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): void {
  withMatrixSqliteStateEnv(params, () => {
    threadBindingStore.delete(buildThreadBindingStoreKey(params.record));
  });
}

function toPluginJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildMatrixBindingIntroText(params: {
  metadata?: Record<string, unknown>;
  targetSessionKey: string;
}): string {
  const introText = normalizeOptionalString(params.metadata?.introText);
  if (introText) {
    return introText;
  }
  const label = normalizeOptionalString(params.metadata?.label);
  const agentId =
    normalizeOptionalString(params.metadata?.agentId) ||
    resolveAgentIdFromSessionKey(params.targetSessionKey);
  const base = label || agentId || "session";
  return `⚙️ ${base} session active. Messages here go directly to this session.`;
}

async function sendBindingMessage(params: {
  cfg: OpenClawConfig;
  client: MatrixClient;
  accountId: string;
  roomId: string;
  threadId?: string;
  text: string;
}): Promise<string | null> {
  const trimmed = params.text.trim();
  if (!trimmed) {
    return null;
  }
  const result = await sendMessageMatrix(`room:${params.roomId}`, trimmed, {
    cfg: params.cfg,
    client: params.client,
    accountId: params.accountId,
    ...(params.threadId ? { threadId: params.threadId } : {}),
  });
  return result.messageId || null;
}

async function sendFarewellMessage(params: {
  cfg: OpenClawConfig;
  client: MatrixClient;
  accountId: string;
  record: MatrixThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
  reason?: string;
}): Promise<void> {
  const roomId = params.record.parentConversationId ?? params.record.conversationId;
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? params.record.idleTimeoutMs
      : params.defaultIdleTimeoutMs;
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number" ? params.record.maxAgeMs : params.defaultMaxAgeMs;
  const farewellText = resolveThreadBindingFarewellText({
    reason: params.reason,
    idleTimeoutMs,
    maxAgeMs,
  });
  await sendBindingMessage({
    cfg: params.cfg,
    client: params.client,
    accountId: params.accountId,
    roomId,
    threadId:
      params.record.parentConversationId &&
      params.record.parentConversationId !== params.record.conversationId
        ? params.record.conversationId
        : undefined,
    text: farewellText,
  }).catch(() => {});
}

export async function createMatrixThreadBindingManager(params: {
  cfg: OpenClawConfig;
  accountId: string;
  auth: MatrixAuth;
  client: MatrixClient;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  idleTimeoutMs: number;
  maxAgeMs: number;
  enableSweeper?: boolean;
  logVerboseMessage?: (message: string) => void;
}): Promise<MatrixThreadBindingManager> {
  if (params.auth.accountId !== params.accountId) {
    throw new Error(
      `Matrix thread binding account mismatch: requested ${params.accountId}, auth resolved ${params.auth.accountId}`,
    );
  }
  const storageKey = resolveMatrixSqliteStateKey(params);
  const existingEntry = getMatrixThreadBindingManagerEntry(params.accountId);
  if (existingEntry) {
    if (existingEntry.storageKey === storageKey) {
      return existingEntry.manager;
    }
    existingEntry.manager.stop();
  }
  const loaded = loadBindingsFromSqlite({
    accountId: params.accountId,
    env: params.env,
    stateDir: params.stateDir,
  });
  for (const record of loaded) {
    setBindingRecord(record);
  }

  const persist = async () => {
    persistBindingsSnapshot({
      accountId: params.accountId,
      bindings: listBindingsForAccount(params.accountId),
      env: params.env,
      stateDir: params.stateDir,
    });
  };
  const defaults = {
    idleTimeoutMs: params.idleTimeoutMs,
    maxAgeMs: params.maxAgeMs,
  };
  const updateBindingsBySessionKey = (input: {
    targetSessionKey: string;
    update: (entry: MatrixThreadBindingRecord, now: number) => MatrixThreadBindingRecord;
    persistReason: string;
  }): MatrixThreadBindingRecord[] => {
    const targetSessionKey = input.targetSessionKey.trim();
    if (!targetSessionKey) {
      return [];
    }
    const now = Date.now();
    const nextBindings = listBindingsForAccount(params.accountId)
      .filter((entry) => entry.targetSessionKey === targetSessionKey)
      .map((entry) => input.update(entry, now));
    if (nextBindings.length === 0) {
      return [];
    }
    for (const entry of nextBindings) {
      setBindingRecord(entry);
      persistBindingRecord({ record: entry, env: params.env, stateDir: params.stateDir });
    }
    return nextBindings;
  };

  const manager: MatrixThreadBindingManager = {
    accountId: params.accountId,
    getIdleTimeoutMs: () => defaults.idleTimeoutMs,
    getMaxAgeMs: () => defaults.maxAgeMs,
    persist,
    getByConversation: ({ conversationId, parentConversationId }) =>
      listBindingsForAccount(params.accountId).find((entry) => {
        if (entry.conversationId !== conversationId.trim()) {
          return false;
        }
        if (!parentConversationId) {
          return true;
        }
        return (entry.parentConversationId ?? "") === parentConversationId.trim();
      }),
    listBySessionKey: (targetSessionKey) =>
      listBindingsForAccount(params.accountId).filter(
        (entry) => entry.targetSessionKey === targetSessionKey.trim(),
      ),
    listBindings: () => listBindingsForAccount(params.accountId),
    touchBinding: (bindingId, at) => {
      const record = listBindingsForAccount(params.accountId).find(
        (entry) => resolveBindingKey(entry) === bindingId.trim(),
      );
      if (!record) {
        return null;
      }
      const nextRecord = {
        ...record,
        lastActivityAt:
          typeof at === "number" && Number.isFinite(at)
            ? Math.max(record.lastActivityAt, Math.floor(at))
            : Date.now(),
      };
      setBindingRecord(nextRecord);
      persistBindingRecord({ record: nextRecord, env: params.env, stateDir: params.stateDir });
      return nextRecord;
    },
    setIdleTimeoutBySessionKey: ({ targetSessionKey, idleTimeoutMs }) => {
      return updateBindingsBySessionKey({
        targetSessionKey,
        persistReason: "idle-timeout-update",
        update: (entry, now) => ({
          ...entry,
          idleTimeoutMs: Math.max(0, Math.floor(idleTimeoutMs)),
          lastActivityAt: now,
        }),
      });
    },
    setMaxAgeBySessionKey: ({ targetSessionKey, maxAgeMs }) => {
      return updateBindingsBySessionKey({
        targetSessionKey,
        persistReason: "max-age-update",
        update: (entry, now) => ({
          ...entry,
          maxAgeMs: Math.max(0, Math.floor(maxAgeMs)),
          lastActivityAt: now,
        }),
      });
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
      }
      unregisterSessionBindingAdapter({
        channel: "matrix",
        accountId: params.accountId,
        adapter: sessionBindingAdapter,
      });
      if (getMatrixThreadBindingManagerEntry(params.accountId)?.manager === manager) {
        deleteMatrixThreadBindingManagerEntry(params.accountId);
      }
      for (const record of listBindingsForAccount(params.accountId)) {
        removeBindingRecord(record);
      }
    },
  };

  let sweepTimer: NodeJS.Timeout | null = null;
  const removeRecords = (records: MatrixThreadBindingRecord[]) => {
    if (records.length === 0) {
      return [];
    }
    const removed = records
      .map((record) => removeBindingRecord(record))
      .filter((record): record is MatrixThreadBindingRecord => Boolean(record));
    for (const record of removed) {
      deleteBindingRecordFromSqlite({ record, env: params.env, stateDir: params.stateDir });
    }
    return removed;
  };
  const sendFarewellMessages = async (
    removed: MatrixThreadBindingRecord[],
    reason: string | ((record: MatrixThreadBindingRecord) => string | undefined),
  ) => {
    await Promise.all(
      removed.map(async (record) => {
        await sendFarewellMessage({
          cfg: params.cfg,
          client: params.client,
          accountId: params.accountId,
          record,
          defaultIdleTimeoutMs: defaults.idleTimeoutMs,
          defaultMaxAgeMs: defaults.maxAgeMs,
          reason: typeof reason === "function" ? reason(record) : reason,
        });
      }),
    );
  };
  const unbindRecords = async (records: MatrixThreadBindingRecord[], reason: string) => {
    const removed = removeRecords(records);
    if (removed.length === 0) {
      return [];
    }
    await persist();
    await sendFarewellMessages(removed, reason);
    return removed.map((record) => toSessionBindingRecord(record, defaults));
  };

  const sessionBindingAdapter: SessionBindingAdapter = {
    channel: "matrix",
    accountId: params.accountId,
    capabilities: { placements: ["current", "child"], bindSupported: true, unbindSupported: true },
    bind: async (input) => {
      const conversationId = input.conversation.conversationId.trim();
      const parentConversationId = normalizeOptionalString(input.conversation.parentConversationId);
      const targetSessionKey = input.targetSessionKey.trim();
      if (!conversationId || !targetSessionKey) {
        return null;
      }

      let boundConversationId = conversationId;
      let boundParentConversationId = parentConversationId;
      const introText = buildMatrixBindingIntroText({
        metadata: input.metadata,
        targetSessionKey,
      });

      if (input.placement === "child") {
        const roomId = parentConversationId || conversationId;
        const rootEventId = await sendBindingMessage({
          cfg: params.cfg,
          client: params.client,
          accountId: params.accountId,
          roomId,
          text: introText,
        });
        if (!rootEventId) {
          return null;
        }
        boundConversationId = rootEventId;
        boundParentConversationId = roomId;
      }

      const now = Date.now();
      const record: MatrixThreadBindingRecord = {
        accountId: params.accountId,
        conversationId: boundConversationId,
        ...(boundParentConversationId ? { parentConversationId: boundParentConversationId } : {}),
        targetKind: toMatrixBindingTargetKind(input.targetKind),
        targetSessionKey,
        agentId:
          normalizeOptionalString(input.metadata?.agentId) ||
          resolveAgentIdFromSessionKey(targetSessionKey),
        label: normalizeOptionalString(input.metadata?.label) || undefined,
        boundBy: normalizeOptionalString(input.metadata?.boundBy) || "system",
        boundAt: now,
        lastActivityAt: now,
        idleTimeoutMs: defaults.idleTimeoutMs,
        maxAgeMs: defaults.maxAgeMs,
      };
      setBindingRecord(record);
      await persist();

      if (input.placement === "current" && introText) {
        const roomId = boundParentConversationId || boundConversationId;
        const threadId =
          boundParentConversationId && boundParentConversationId !== boundConversationId
            ? boundConversationId
            : undefined;
        await sendBindingMessage({
          cfg: params.cfg,
          client: params.client,
          accountId: params.accountId,
          roomId,
          threadId,
          text: introText,
        }).catch(() => {});
      }

      return toSessionBindingRecord(record, defaults);
    },
    listBySession: (targetSessionKey) =>
      manager
        .listBySessionKey(targetSessionKey)
        .map((record) => toSessionBindingRecord(record, defaults)),
    resolveByConversation: (ref) => {
      const record = manager.getByConversation({
        conversationId: ref.conversationId,
        parentConversationId: ref.parentConversationId,
      });
      return record ? toSessionBindingRecord(record, defaults) : null;
    },
    touch: (bindingId, at) => {
      manager.touchBinding(bindingId, at);
    },
    unbind: async (input) => {
      const removed = await unbindRecords(
        listBindingsForAccount(params.accountId).filter((record) => {
          if (input.bindingId?.trim()) {
            return resolveBindingKey(record) === input.bindingId.trim();
          }
          if (input.targetSessionKey?.trim()) {
            return record.targetSessionKey === input.targetSessionKey.trim();
          }
          return false;
        }),
        input.reason,
      );
      return removed;
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);

  if (params.enableSweeper !== false) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      const expired = listBindingsForAccount(params.accountId)
        .map((record) => ({
          record,
          lifecycle: resolveEffectiveBindingExpiry({
            record,
            defaultIdleTimeoutMs: defaults.idleTimeoutMs,
            defaultMaxAgeMs: defaults.maxAgeMs,
          }),
        }))
        .filter(
          (
            entry,
          ): entry is {
            record: MatrixThreadBindingRecord;
            lifecycle: { expiresAt: number; reason: "idle-expired" | "max-age-expired" };
          } =>
            typeof entry.lifecycle.expiresAt === "number" &&
            entry.lifecycle.expiresAt <= now &&
            Boolean(entry.lifecycle.reason),
        );
      if (expired.length === 0) {
        return;
      }
      const reasonByBindingKey = new Map(
        expired.map(({ record, lifecycle }) => [resolveBindingKey(record), lifecycle.reason]),
      );
      void (async () => {
        const removed = removeRecords(expired.map(({ record }) => record));
        if (removed.length === 0) {
          return;
        }
        for (const record of removed) {
          const reason = reasonByBindingKey.get(resolveBindingKey(record));
          params.logVerboseMessage?.(
            `matrix: auto-unbinding ${record.conversationId} due to ${reason}`,
          );
        }
        await persist();
        await sendFarewellMessages(removed, (record) =>
          reasonByBindingKey.get(resolveBindingKey(record)),
        );
      })().catch((err) => {
        params.logVerboseMessage?.(
          `matrix: failed auto-unbinding expired bindings account=${params.accountId}: ${String(err)}`,
        );
      });
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  setMatrixThreadBindingManagerEntry(params.accountId, {
    storageKey,
    manager,
  });
  return manager;
}
export {
  getMatrixThreadBindingManager,
  resetMatrixThreadBindingsForTests,
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
};
