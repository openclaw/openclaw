import { createHash } from "node:crypto";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import { sanitizeAgentId } from "../routing/session-key.js";
import type { AcpRuntimeSessionMode } from "./runtime/types.js";

export type ConfiguredAcpBindingChannel = "discord" | "telegram" | "feishu";

export type ConfiguredAcpBindingSpec = {
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  /** Owning OpenClaw agent id (used for session identity/storage). */
  agentId: string;
  /** ACP harness agent id override (falls back to agentId when omitted). */
  acpAgentId?: string;
  mode: AcpRuntimeSessionMode;
  cwd?: string;
  backend?: string;
  label?: string;
};

export type ResolvedConfiguredAcpBinding = {
  spec: ConfiguredAcpBindingSpec;
  record: SessionBindingRecord;
};

export type AcpBindingConfigShape = {
  mode?: string;
  cwd?: string;
  backend?: string;
  label?: string;
};

export function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeMode(value: unknown): AcpRuntimeSessionMode {
  const raw = normalizeText(value)?.toLowerCase();
  return raw === "oneshot" ? "oneshot" : "persistent";
}

export function normalizeBindingConfig(raw: unknown): AcpBindingConfigShape {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const shape = raw as AcpBindingConfigShape;
  const mode = normalizeText(shape.mode);
  return {
    mode: mode ? normalizeMode(mode) : undefined,
    cwd: normalizeText(shape.cwd),
    backend: normalizeText(shape.backend),
    label: normalizeText(shape.label),
  };
}

function buildBindingHash(params: {
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
}): string {
  return createHash("sha256")
    .update(`${params.channel}:${params.accountId}:${params.conversationId}`)
    .digest("hex")
    .slice(0, 16);
}

export function buildConfiguredAcpSessionKey(spec: ConfiguredAcpBindingSpec): string {
  const hash = buildBindingHash({
    channel: spec.channel,
    accountId: spec.accountId,
    conversationId: spec.conversationId,
  });
  return `agent:${sanitizeAgentId(spec.agentId)}:acp:binding:${spec.channel}:${spec.accountId}:${hash}`;
}

export function toConfiguredAcpBindingRecord(spec: ConfiguredAcpBindingSpec): SessionBindingRecord {
  return {
    bindingId: `config:acp:${spec.channel}:${spec.accountId}:${spec.conversationId}`,
    targetSessionKey: buildConfiguredAcpSessionKey(spec),
    targetKind: "session",
    conversation: {
      channel: spec.channel,
      accountId: spec.accountId,
      conversationId: spec.conversationId,
      parentConversationId: spec.parentConversationId,
    },
    status: "active",
    boundAt: 0,
    metadata: {
      source: "config",
      mode: spec.mode,
      agentId: spec.agentId,
      ...(spec.acpAgentId ? { acpAgentId: spec.acpAgentId } : {}),
      label: spec.label,
      ...(spec.backend ? { backend: spec.backend } : {}),
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    },
  };
}
