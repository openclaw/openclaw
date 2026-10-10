import {
  resolveConfiguredBindingRecord,
  resolveConfiguredBindingRecordBySessionKey,
} from "../channels/plugins/configured-binding-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveConfiguredAcpBindingSpecFromRecord,
  type ConfiguredAcpBindingSpec,
  type ResolvedConfiguredAcpBinding,
} from "./persistent-bindings.types.js";

export function resolveConfiguredAcpBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ResolvedConfiguredAcpBinding | null {
  const resolved = resolveConfiguredBindingRecord(params);
  if (!resolved) {
    return null;
  }
  const spec = resolveConfiguredAcpBindingSpecFromRecord(resolved.record);
  return spec ? { spec, record: resolved.record } : null;
}

export function resolveConfiguredAcpBindingSpecBySessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): ConfiguredAcpBindingSpec | null {
  const resolved = resolveConfiguredBindingRecordBySessionKey(params);
  return resolved ? resolveConfiguredAcpBindingSpecFromRecord(resolved.record) : null;
}
