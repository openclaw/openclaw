import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  createPumbleThreadBindingManager,
  getPumbleThreadBindingManager,
} from "./thread-bindings.manager.js";
import type { PumbleThreadBindingRecord } from "./thread-bindings.types.js";

function parseChannelIdFromTo(to: string | undefined): string | undefined {
  const trimmed = (to ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("channel:")) {
    return trimmed.slice("channel:".length).trim() || undefined;
  }
  // Bare IDs that don't look like user/email targets are treated as channel IDs
  if (!lower.startsWith("user:") && !lower.startsWith("pumble:") && !trimmed.includes("@")) {
    return trimmed;
  }
  return undefined;
}

export async function autoBindSpawnedPumbleSubagent(params: {
  accountId?: string;
  to?: string;
  threadId?: string;
  childSessionKey: string;
  agentId: string;
  label?: string;
  boundBy?: string;
}): Promise<PumbleThreadBindingRecord | null> {
  const accountId = normalizeAccountId(params.accountId);
  const manager = getPumbleThreadBindingManager(accountId);
  if (!manager) {
    return null;
  }

  const channelId = parseChannelIdFromTo(params.to);
  if (!channelId) {
    return null;
  }

  return manager.bindTarget({
    channelId,
    targetSessionKey: params.childSessionKey,
    agentId: params.agentId,
    label: params.label,
    boundBy: params.boundBy,
    replyToId: params.threadId,
    sendIntro: false,
  });
}

/**
 * Returns ` [Label]` suffix for a bound subagent thread, or empty string.
 */
export function resolveSubagentLabelSuffix(params: {
  threadRootId?: string;
  accountId?: string;
}): string {
  const threadRootId = params.threadRootId?.trim();
  if (!threadRootId) {
    return "";
  }
  const accountId = normalizeAccountId(params.accountId);
  const manager = getPumbleThreadBindingManager(accountId);
  if (!manager) {
    return "";
  }
  const binding = manager.getByThreadRootId(threadRootId);
  if (!binding?.label) {
    return "";
  }
  return ` [${binding.label}]`;
}

export function listPumbleThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
}): PumbleThreadBindingRecord[] {
  const accountId = normalizeAccountId(params.accountId);
  const manager = getPumbleThreadBindingManager(accountId);
  if (!manager) {
    return [];
  }
  return manager.listBySessionKey(params.targetSessionKey);
}

export function unbindPumbleThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  reason?: string;
  sendFarewell?: boolean;
}): PumbleThreadBindingRecord[] {
  const accountId = normalizeAccountId(params.accountId);
  const manager = getPumbleThreadBindingManager(accountId);
  if (!manager) {
    return [];
  }
  return manager.unbindBySessionKey({
    targetSessionKey: params.targetSessionKey,
    reason: params.reason,
    sendFarewell: params.sendFarewell,
  });
}
