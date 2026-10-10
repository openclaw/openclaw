import {
  projectThreadBindingRecord,
  resolveThreadBindingLifecycle,
  type AccountScopedConversationBindingRecord,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";

type MatrixThreadBindingTargetKind = "subagent" | "acp";

export type MatrixThreadBindingRecord =
  AccountScopedConversationBindingRecord<MatrixThreadBindingTargetKind> & {
    parentConversationId?: string;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
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
  persist: () => Promise<void>;
  stop: () => Promise<void>;
};

type MatrixThreadBindingManagerCacheEntry = {
  storageKey: string;
  manager: MatrixThreadBindingManager;
};

const MANAGERS_BY_ACCOUNT_ID = new Map<string, MatrixThreadBindingManagerCacheEntry>();
const BINDINGS_BY_ACCOUNT_CONVERSATION = new Map<string, MatrixThreadBindingRecord>();

export function resolveBindingKey(params: {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): string {
  return `${params.accountId}:${params.parentConversationId?.trim() || "-"}:${params.conversationId}`;
}

export function toSessionBindingRecord(
  record: MatrixThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const lifecycle = resolveThreadBindingLifecycle({
    record,
    defaultIdleTimeoutMs: defaults.idleTimeoutMs,
    defaultMaxAgeMs: defaults.maxAgeMs,
  });
  const idleTimeoutMs =
    typeof record.idleTimeoutMs === "number" ? record.idleTimeoutMs : defaults.idleTimeoutMs;
  const maxAgeMs = typeof record.maxAgeMs === "number" ? record.maxAgeMs : defaults.maxAgeMs;
  return projectThreadBindingRecord(record, {
    conversation: {
      channel: "matrix",
      conversationId: record.conversationId,
      parentConversationId: record.parentConversationId,
    },
    bindingId: resolveBindingKey(record),
    targetKind: record.targetKind === "subagent" ? "subagent" : "session",
    lifecycle: { ...lifecycle, idleTimeoutMs, maxAgeMs },
  });
}

export function setBindingRecord(record: MatrixThreadBindingRecord): void {
  BINDINGS_BY_ACCOUNT_CONVERSATION.set(resolveBindingKey(record), record);
}

export function removeBindingRecord(
  record: MatrixThreadBindingRecord,
): MatrixThreadBindingRecord | null {
  const key = resolveBindingKey(record);
  const removed = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key) ?? null;
  if (removed) {
    BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
  }
  return removed;
}

export function listBindingsForAccount(accountId: string): MatrixThreadBindingRecord[] {
  return [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter(
    (entry) => entry.accountId === accountId,
  );
}

export function listAllBindings(): MatrixThreadBindingRecord[] {
  return [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()];
}

export function getMatrixThreadBindingManagerEntry(
  accountId: string,
): MatrixThreadBindingManagerCacheEntry | null {
  return MANAGERS_BY_ACCOUNT_ID.get(accountId) ?? null;
}

export function setMatrixThreadBindingManagerEntry(
  accountId: string,
  entry: MatrixThreadBindingManagerCacheEntry,
): void {
  MANAGERS_BY_ACCOUNT_ID.set(accountId, entry);
}

export function deleteMatrixThreadBindingManagerEntry(accountId: string): void {
  MANAGERS_BY_ACCOUNT_ID.delete(accountId);
}

export function getMatrixThreadBindingManager(
  accountId: string,
): MatrixThreadBindingManager | null {
  return MANAGERS_BY_ACCOUNT_ID.get(accountId)?.manager ?? null;
}

function createMatrixThreadBindingTimeoutSetter<
  Params extends { accountId: string; targetSessionKey: string },
>(update: (manager: MatrixThreadBindingManager, params: Params) => MatrixThreadBindingRecord[]) {
  return (params: Params): SessionBindingRecord[] => {
    const manager = MANAGERS_BY_ACCOUNT_ID.get(params.accountId)?.manager;
    if (!manager) {
      return [];
    }
    return update(manager, params).map((record) =>
      toSessionBindingRecord(record, {
        idleTimeoutMs: manager.getIdleTimeoutMs(),
        maxAgeMs: manager.getMaxAgeMs(),
      }),
    );
  };
}

export const setMatrixThreadBindingIdleTimeoutBySessionKey = createMatrixThreadBindingTimeoutSetter(
  (manager, params: { accountId: string; targetSessionKey: string; idleTimeoutMs: number }) =>
    manager.setIdleTimeoutBySessionKey(params),
);

export const setMatrixThreadBindingMaxAgeBySessionKey = createMatrixThreadBindingTimeoutSetter(
  (manager, params: { accountId: string; targetSessionKey: string; maxAgeMs: number }) =>
    manager.setMaxAgeBySessionKey(params),
);
