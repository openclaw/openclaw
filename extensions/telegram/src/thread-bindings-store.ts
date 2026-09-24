import { createHash } from "node:crypto";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const TELEGRAM_THREAD_BINDINGS_NAMESPACE = "telegram.thread-bindings";
export const TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES = 5_000;

type TelegramBindingTargetKind = "subagent" | "acp";

export type TelegramThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  targetKind: TelegramBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  metadata?: Record<string, unknown>;
};

export type TelegramThreadBindingManager = {
  accountId: string;
  shouldPersistMutations: () => boolean;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByConversationId: (conversationId: string) => TelegramThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => TelegramThreadBindingRecord[];
  listBindings: () => TelegramThreadBindingRecord[];
  touchConversation: (conversationId: string, at?: number) => TelegramThreadBindingRecord | null;
  unbindConversation: (params: {
    conversationId: string;
    reason?: string;
    sendFarewell?: boolean;
    throwOnPersistError?: boolean;
  }) => TelegramThreadBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    reason?: string;
    sendFarewell?: boolean;
    throwOnPersistError?: boolean;
  }) => TelegramThreadBindingRecord[];
  stop: () => void;
};

export function resolveStoredBindingKey(params: {
  accountId: string;
  conversationId: string;
}): string {
  return createHash("sha256")
    .update(`${params.accountId}\0${params.conversationId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function normalizeMetadataForStore(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const serialized = JSON.stringify(metadata);
  if (!serialized) {
    return undefined;
  }
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function sanitizeStoredBinding(
  accountId: string,
  entry: Partial<TelegramThreadBindingRecord> | null | undefined,
): TelegramThreadBindingRecord | null {
  const conversationId = normalizeOptionalString(entry?.conversationId);
  const targetSessionKey = normalizeOptionalString(entry?.targetSessionKey) ?? "";
  const targetKind = entry?.targetKind === "subagent" ? "subagent" : "acp";
  if (!conversationId || !targetSessionKey) {
    return null;
  }
  const boundAt =
    typeof entry?.boundAt === "number" && Number.isFinite(entry.boundAt)
      ? Math.floor(entry.boundAt)
      : Date.now();
  const lastActivityAt =
    typeof entry?.lastActivityAt === "number" && Number.isFinite(entry.lastActivityAt)
      ? Math.floor(entry.lastActivityAt)
      : boundAt;
  const record: TelegramThreadBindingRecord = {
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
  const metadata = normalizeMetadataForStore(
    entry?.metadata && typeof entry.metadata === "object" ? { ...entry.metadata } : undefined,
  );
  if (metadata) {
    record.metadata = metadata;
  }
  return record;
}
