import {
  formatThreadBindingDurationLabel,
  resolveThreadBindingEffectiveExpiresAt,
  type BindingTargetKind,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { projectThreadBindingRecord } from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import type { TelegramThreadBindingRecord } from "./thread-bindings-store.js";

export function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

export function toSessionBindingRecord(
  record: TelegramThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  return projectThreadBindingRecord(record, {
    conversation: {
      channel: "telegram",
      conversationId: record.conversationId,
    },
    targetKind: record.targetKind === "subagent" ? "subagent" : "session",
    lifecycle: {
      expiresAt: resolveThreadBindingEffectiveExpiresAt({
        record,
        defaultIdleTimeoutMs: defaults.idleTimeoutMs,
        defaultMaxAgeMs: defaults.maxAgeMs,
      }),
      idleTimeoutMs:
        typeof record.idleTimeoutMs === "number"
          ? Math.max(0, Math.floor(record.idleTimeoutMs))
          : defaults.idleTimeoutMs,
      maxAgeMs:
        typeof record.maxAgeMs === "number"
          ? Math.max(0, Math.floor(record.maxAgeMs))
          : defaults.maxAgeMs,
    },
    metadata: (lifecycleMetadata) => ({ ...lifecycleMetadata, ...record.metadata }),
  });
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

  for (const key of ["idleTimeoutMs", "maxAgeMs"] as const) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      record[key] = Math.max(0, Math.floor(value));
    } else if (typeof existing?.[key] === "number") {
      record[key] = existing[key];
    }
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
