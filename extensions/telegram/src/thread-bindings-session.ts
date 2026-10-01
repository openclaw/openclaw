import {
  formatThreadBindingDurationLabel,
  resolveThreadBindingEffectiveExpiresAt,
  type BindingTargetKind,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TelegramThreadBindingRecord } from "./thread-bindings-store.js";

export function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

export function toSessionBindingRecord(
  record: TelegramThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  return {
    bindingId: resolveBindingKey({
      accountId: record.accountId,
      conversationId: record.conversationId,
    }),
    targetSessionKey: record.targetSessionKey,
    targetKind: record.targetKind === "subagent" ? "subagent" : "session",
    conversation: {
      channel: "telegram",
      accountId: record.accountId,
      conversationId: record.conversationId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: resolveThreadBindingEffectiveExpiresAt({
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
      ...record.metadata,
    },
  };
}

export function fromSessionBindingInput(params: {
  accountId: string;
  existing?: TelegramThreadBindingRecord;
  input: {
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversationId: string;
    metadata?: Record<string, unknown>;
  };
}): TelegramThreadBindingRecord {
  const now = Date.now();
  const metadata = params.input.metadata ?? {};
  const existing = params.existing;
  const targetKind = params.input.targetKind === "subagent" ? "subagent" : "acp";
  // Runtime metadata follows the target; conversation lifecycle settings still carry forward below.
  const previous =
    existing?.targetSessionKey === params.input.targetSessionKey &&
    existing.targetKind === targetKind
      ? existing
      : undefined;

  const record: TelegramThreadBindingRecord = {
    accountId: params.accountId,
    conversationId: params.input.conversationId,
    targetKind,
    targetSessionKey: params.input.targetSessionKey,
    agentId: normalizeOptionalString(metadata.agentId) ?? previous?.agentId,
    label: normalizeOptionalString(metadata.label) ?? previous?.label,
    boundBy: normalizeOptionalString(metadata.boundBy) ?? previous?.boundBy,
    boundAt: now,
    lastActivityAt: now,
    metadata: {
      ...previous?.metadata,
      ...metadata,
    },
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

export function summarizeLifecycleForLog(
  record: TelegramThreadBindingRecord,
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

export function normalizeDurationMs(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.floor(raw));
}

export function normalizeTimestampMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return Date.now();
  }
  return Math.max(0, Math.floor(raw));
}
