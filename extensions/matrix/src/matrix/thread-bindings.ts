import path from "node:path";
import {
  readJsonFileWithFallback,
  registerSessionBindingAdapter,
  resolveAgentIdFromSessionKey,
  resolveThreadBindingFarewellText,
  unregisterSessionBindingAdapter,
  writeJsonFileAtomically,
  type BindingTargetKind,
  type SessionBindingRecord,
} from "../runtime-api.js";
import { resolveMatrixStoragePaths } from "./client/storage.js";
import type { MatrixAuth } from "./client/types.js";
import type { MatrixClient } from "./sdk.js";
import { sendMessageMatrix } from "./send.js";

const STORE_VERSION = 1;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
const TOUCH_PERSIST_DELAY_MS = 30_000;

type MatrixThreadBindingTargetKind = "subagent" | "acp";

type MatrixThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetKind: MatrixThreadBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

type StoredMatrixThreadBindingState = {
  version: number;
  bindings: MatrixThreadBindingRecord[];
};

export type MatrixThreadBindingManager = {
  accountId: string;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByConversation: (params: {
    conversationId: string;
    parentConversationId?: string;
  }) => MatrixThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => MatrixThreadBindingRecord[];
  listBindings: () => MatrixThreadBindingRecord[];
  touchBinding: (bindingId: string, at?: number) => MatrixThreadBindingRecord | null;
  setIdleTimeoutBySessionKey: (params: {
    targetSessionKey: string;
    idleTimeoutMs: number;
  }) => MatrixThreadBindingRecord[];
  setMaxAgeBySessionKey: (params: {
    targetSessionKey: string;
    maxAgeMs: number;
  }) => MatrixThreadBindingRecord[];
  stop: () => void;
};

const MANAGERS_BY_ACCOUNT_ID = new Map<string, MatrixThreadBindingManager>();
const BINDINGS_BY_ACCOUNT_CONVERSATION = new Map<string, MatrixThreadBindingRecord>();

function normalizeDurationMs(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.floor(raw));
}

function normalizeText(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function normalizeConversationId(raw: unknown): string | undefined {
  const trimmed = normalizeText(raw);
  return trimmed || undefined;
}

function resolveBindingKey(params: {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): string {
  return `${params.accountId}:${params.parentConversationId?.trim() || "-"}:${params.conversationId}`;
}

function toSessionBindingTargetKind(raw: MatrixThreadBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toMatrixBindingTargetKind(raw: BindingTargetKind): MatrixThreadBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

function resolveEffectiveBindingExpiry(params: {
  record: MatrixThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): {
  expiresAt?: number;
  reason?: "idle-expired" | "max-age-expired";
} {
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
    return inactivityExpiresAt <= maxAgeExpiresAt
      ? { expiresAt: inactivityExpiresAt, reason: "idle-expired" }
      : { expiresAt: maxAgeExpiresAt, reason: "max-age-expired" };
  }
  if (inactivityExpiresAt != null) {
    return { expiresAt: inactivityExpiresAt, reason: "idle-expired" };
  }
  if (maxAgeExpiresAt != null) {
    return { expiresAt: maxAgeExpiresAt, reason: "max-age-expired" };
  }
  return {};
}

function toSessionBindingRecord(
  record: MatrixThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const lifecycle = resolveEffectiveBindingExpiry({
    record,
    defaultIdleTimeoutMs: defaults.idleTimeoutMs,
    defaultMaxAgeMs: defaults.maxAgeMs,
  });
  const idleTimeoutMs =
    typeof record.idleTimeoutMs === "number" ? record.idleTimeoutMs : defaults.idleTimeoutMs;
  const maxAgeMs = typeof record.maxAgeMs === "number" ? record.maxAgeMs : defaults.maxAgeMs;
  return {
    bindingId: resolveBindingKey(record),
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "matrix",
      accountId: record.accountId,
      conversationId: record.conversationId,
      parentConversationId: record.parentConversationId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: lifecycle.expiresAt,
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs,
      maxAgeMs,
    },
  };
}

function resolveBindingsPath(params: {
  auth: MatrixAuth;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const storagePaths = resolveMatrixStoragePaths({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    accountId: params.accountId,
    deviceId: params.auth.deviceId,
    env: params.env,
  });
  return path.join(storagePaths.rootDir, "thread-bindings.json");
}

async function loadBindingsFromDisk(filePath: string, accountId: string) {
  const { value } = await readJsonFileWithFallback<StoredMatrixThreadBindingState | null>(
    filePath,
    null,
  );
  if (value?.version !== STORE_VERSION || !Array.isArray(value.bindings)) {
    return [];
  }
  const loaded: MatrixThreadBindingRecord[] = [];
  for (const entry of value.bindings) {
    const conversationId = normalizeConversationId(entry?.conversationId);
    const parentConversationId = normalizeConversationId(entry?.parentConversationId);
    const targetSessionKey = normalizeText(entry?.targetSessionKey);
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
    loaded.push({
      accountId,
      conversationId,
      ...(parentConversationId ? { parentConversationId } : {}),
      targetKind: entry?.targetKind === "subagent" ? "subagent" : "acp",
      targetSessionKey,
      agentId: normalizeText(entry?.agentId) || undefined,
      label: normalizeText(entry?.label) || undefined,
      boundBy: normalizeText(entry?.boundBy) || undefined,
      boundAt,
      lastActivityAt: Math.max(lastActivityAt, boundAt),
      idleTimeoutMs:
        typeof entry?.idleTimeoutMs === "number" && Number.isFinite(entry.idleTimeoutMs)
          ? Math.max(0, Math.floor(entry.idleTimeoutMs))
          : undefined,
      maxAgeMs:
        typeof entry?.maxAgeMs === "number" && Number.isFinite(entry.maxAgeMs)
          ? Math.max(0, Math.floor(entry.maxAgeMs))
          : undefined,
    });
  }
  return loaded;
}

function toStoredBindingsState(
  bindings: MatrixThreadBindingRecord[],
): StoredMatrixThreadBindingState {
  return {
    version: STORE_VERSION,
    bindings: [...bindings].sort((a, b) => a.boundAt - b.boundAt),
  };
}

async function persistBindingsSnapshot(
  filePath: string,
  bindings: MatrixThreadBindingRecord[],
): Promise<void> {
  await writeJsonFileAtomically(filePath, toStoredBindingsState(bindings));
}

function setBindingRecord(record: MatrixThreadBindingRecord): void {
  BINDINGS_BY_ACCOUNT_CONVERSATION.set(resolveBindingKey(record), record);
}

function removeBindingRecord(record: MatrixThreadBindingRecord): MatrixThreadBindingRecord | null {
  const key = resolveBindingKey(record);
  const removed = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key) ?? null;
  if (removed) {
    BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
  }
  return removed;
}

function listBindingsForAccount(accountId: string): MatrixThreadBindingRecord[] {
  return [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter(
    (entry) => entry.accountId === accountId,
  );
}

function buildMatrixBindingIntroText(params: {
  metadata?: Record<string, unknown>;
  targetSessionKey: string;
}): string {
  const introText = normalizeText(params.metadata?.introText);
  if (introText) {
    return introText;
  }
  const label = normalizeText(params.metadata?.label);
  const agentId =
    normalizeText(params.metadata?.agentId) ||
    resolveAgentIdFromSessionKey(params.targetSessionKey);
  const base = label || agentId || "session";
  return `⚙️ ${base} session active. Messages here go directly to this session.`;
}

async function sendBindingMessage(params: {
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
    client: params.client,
    accountId: params.accountId,
    ...(params.threadId ? { threadId: params.threadId } : {}),
  });
  return result.messageId || null;
}

async function sendFarewellMessage(params: {
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
  accountId: string;
  auth: MatrixAuth;
  client: MatrixClient;
  env?: NodeJS.ProcessEnv;
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
  const existing = MANAGERS_BY_ACCOUNT_ID.get(params.accountId);
  if (existing) {
    return existing;
  }

  const filePath = resolveBindingsPath({
    auth: params.auth,
    accountId: params.accountId,
    env: params.env,
  });
  const loaded = await loadBindingsFromDisk(filePath, params.accountId);
  for (const record of loaded) {
    setBindingRecord(record);
  }

  let persistQueue: Promise<void> = Promise.resolve();
  const enqueuePersist = (bindings?: MatrixThreadBindingRecord[]) => {
    const snapshot = bindings ?? listBindingsForAccount(params.accountId);
    const next = persistQueue
      .catch(() => {})
      .then(async () => {
        await persistBindingsSnapshot(filePath, snapshot);
      });
    persistQueue = next;
    return next;
  };
  const persist = async () => await enqueuePersist();
  const persistSafely = (reason: string, bindings?: MatrixThreadBindingRecord[]) => {
    void enqueuePersist(bindings).catch((err) => {
      params.logVerboseMessage?.(
        `matrix: failed persisting thread bindings account=${params.accountId} action=${reason}: ${String(err)}`,
      );
    });
  };
  const defaults = {
    idleTimeoutMs: params.idleTimeoutMs,
    maxAgeMs: params.maxAgeMs,
  };
  let persistTimer: NodeJS.Timeout | null = null;
  const schedulePersist = (delayMs: number) => {
    if (persistTimer) {
      return;
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistSafely("delayed-touch");
    }, delayMs);
    persistTimer.unref?.();
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
    }
    persistSafely(input.persistReason);
    return nextBindings;
  };

  const manager: MatrixThreadBindingManager = {
    accountId: params.accountId,
    getIdleTimeoutMs: () => defaults.idleTimeoutMs,
    getMaxAgeMs: () => defaults.maxAgeMs,
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
      schedulePersist(TOUCH_PERSIST_DELAY_MS);
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
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
        persistSafely("shutdown-flush");
      }
      unregisterSessionBindingAdapter({
        channel: "matrix",
        accountId: params.accountId,
      });
      if (MANAGERS_BY_ACCOUNT_ID.get(params.accountId) === manager) {
        MANAGERS_BY_ACCOUNT_ID.delete(params.accountId);
      }
      for (const record of listBindingsForAccount(params.accountId)) {
        BINDINGS_BY_ACCOUNT_CONVERSATION.delete(resolveBindingKey(record));
      }
    },
  };

  let sweepTimer: NodeJS.Timeout | null = null;
  const removeRecords = (records: MatrixThreadBindingRecord[]) => {
    if (records.length === 0) {
      return [];
    }
    return records
      .map((record) => removeBindingRecord(record))
      .filter((record): record is MatrixThreadBindingRecord => Boolean(record));
  };
  const sendFarewellMessages = async (
    removed: MatrixThreadBindingRecord[],
    reason: string | ((record: MatrixThreadBindingRecord) => string | undefined),
  ) => {
    await Promise.all(
      removed.map(async (record) => {
        await sendFarewellMessage({
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

  registerSessionBindingAdapter({
    channel: "matrix",
    accountId: params.accountId,
    capabilities: { placements: ["current", "child"], bindSupported: true, unbindSupported: true },
    bind: async (input) => {
      const conversationId = input.conversation.conversationId.trim();
      const parentConversationId = input.conversation.parentConversationId?.trim() || undefined;
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
          normalizeText(input.metadata?.agentId) || resolveAgentIdFromSessionKey(targetSessionKey),
        label: normalizeText(input.metadata?.label) || undefined,
        boundBy: normalizeText(input.metadata?.boundBy) || "system",
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
  });

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

  MANAGERS_BY_ACCOUNT_ID.set(params.accountId, manager);
  return manager;
}

export function getMatrixThreadBindingManager(
  accountId: string,
): MatrixThreadBindingManager | null {
  return MANAGERS_BY_ACCOUNT_ID.get(accountId) ?? null;
}

export function setMatrixThreadBindingIdleTimeoutBySessionKey(params: {
  accountId: string;
  targetSessionKey: string;
  idleTimeoutMs: number;
}): SessionBindingRecord[] {
  const manager = MANAGERS_BY_ACCOUNT_ID.get(params.accountId);
  if (!manager) {
    return [];
  }
  return manager.setIdleTimeoutBySessionKey(params).map((record) =>
    toSessionBindingRecord(record, {
      idleTimeoutMs: manager.getIdleTimeoutMs(),
      maxAgeMs: manager.getMaxAgeMs(),
    }),
  );
}

export function setMatrixThreadBindingMaxAgeBySessionKey(params: {
  accountId: string;
  targetSessionKey: string;
  maxAgeMs: number;
}): SessionBindingRecord[] {
  const manager = MANAGERS_BY_ACCOUNT_ID.get(params.accountId);
  if (!manager) {
    return [];
  }
  return manager.setMaxAgeBySessionKey(params).map((record) =>
    toSessionBindingRecord(record, {
      idleTimeoutMs: manager.getIdleTimeoutMs(),
      maxAgeMs: manager.getMaxAgeMs(),
    }),
  );
}

export function resetMatrixThreadBindingsForTests(): void {
  for (const manager of MANAGERS_BY_ACCOUNT_ID.values()) {
    manager.stop();
  }
  MANAGERS_BY_ACCOUNT_ID.clear();
  BINDINGS_BY_ACCOUNT_CONVERSATION.clear();
}
