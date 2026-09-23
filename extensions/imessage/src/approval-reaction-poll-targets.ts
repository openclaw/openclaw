import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
// Imessage plugin module owns persisted approval reaction poll targets.
import { readApprovalReactionDecisionList } from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  createPluginStateErrorReporter,
  type PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeConversationKey,
  type IMessageApprovalConversationKey,
} from "./approval-target-keys.js";
import { normalizeIMessageGuid } from "./message-guid.js";
import { getOptionalIMessageRuntime } from "./runtime.js";

const PERSISTENT_POLL_TARGET_NAMESPACE = "imessage.approval-reaction-poll-targets";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

export type PendingIMessageApprovalReactionPollTarget = {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  expiresAtMs: number;
};

const pendingReactionPollTargets = new Map<string, PendingIMessageApprovalReactionPollTarget>();

function prunePendingReactionPollTargets(nowMs = Date.now()): void {
  for (const [key, target] of pendingReactionPollTargets.entries()) {
    if (!isFutureDateTimestampMs(target.expiresAtMs, { nowMs })) {
      pendingReactionPollTargets.delete(key);
    }
  }
}

export function resolveIMessageApprovalReactionPollExpiry(
  ttlMs: number | undefined,
): { ttlMs: number; expiresAtMs: number } | undefined {
  const nowMs = asDateTimestampMs(Date.now());
  if (nowMs === undefined) {
    return undefined;
  }
  const expiresAtMs =
    resolveExpiresAtMsFromDurationMs(ttlMs ?? DEFAULT_REACTION_TARGET_TTL_MS, { nowMs }) ??
    resolveExpiresAtMsFromDurationMs(DEFAULT_REACTION_TARGET_TTL_MS, { nowMs });
  if (expiresAtMs === undefined) {
    return undefined;
  }
  return {
    ttlMs: expiresAtMs - nowMs,
    expiresAtMs,
  };
}

function mergePollTargetConversation(
  left: IMessageApprovalConversationKey,
  right: IMessageApprovalConversationKey,
): IMessageApprovalConversationKey {
  return {
    chatGuid: left.chatGuid ?? right.chatGuid,
    chatIdentifier: left.chatIdentifier ?? right.chatIdentifier,
    chatId: left.chatId ?? right.chatId,
    handle: left.handle ?? right.handle,
  };
}

const reportPersistentApprovalReactionError = createPluginStateErrorReporter(
  getOptionalIMessageRuntime,
  "imessage",
  "approval-reaction-state",
  "iMessage persistent approval reaction state failed",
);

let pendingReactionPollTargetStore:
  | PluginStateKeyedStore<PendingIMessageApprovalReactionPollTarget>
  | undefined;
let pendingReactionPollTargetStoreDisabled = false;

function disablePendingReactionPollTargetStore(error: unknown): void {
  pendingReactionPollTargetStoreDisabled = true;
  pendingReactionPollTargetStore = undefined;
  reportPersistentApprovalReactionError(error);
}

function getPendingReactionPollTargetStore():
  | PluginStateKeyedStore<PendingIMessageApprovalReactionPollTarget>
  | undefined {
  if (pendingReactionPollTargetStoreDisabled) {
    return undefined;
  }
  if (pendingReactionPollTargetStore) {
    return pendingReactionPollTargetStore;
  }
  try {
    pendingReactionPollTargetStore =
      getOptionalIMessageRuntime()?.state.openKeyedStore<PendingIMessageApprovalReactionPollTarget>(
        {
          namespace: PERSISTENT_POLL_TARGET_NAMESPACE,
          maxEntries: PERSISTENT_MAX_ENTRIES,
          defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
        },
      );
    return pendingReactionPollTargetStore;
  } catch (error) {
    disablePendingReactionPollTargetStore(error);
    return undefined;
  }
}

function readPersistedPollTarget(value: unknown): PendingIMessageApprovalReactionPollTarget | null {
  const target = asOptionalRecord(value);
  if (!target) {
    return null;
  }
  const accountId = typeof target.accountId === "string" ? target.accountId.trim() : "";
  const messageId = typeof target.messageId === "string" ? target.messageId.trim() : "";
  const approvalId = typeof target.approvalId === "string" ? target.approvalId.trim() : "";
  const expiresAtMs = asDateTimestampMs(target.expiresAtMs);
  const allowedDecisions = readApprovalReactionDecisionList(target.allowedDecisions);
  const rawConversation = asOptionalRecord(target.conversation) ?? {};
  const conversation: IMessageApprovalConversationKey = {
    ...(typeof rawConversation.chatGuid === "string"
      ? { chatGuid: rawConversation.chatGuid.trim() }
      : {}),
    ...(typeof rawConversation.chatIdentifier === "string"
      ? { chatIdentifier: rawConversation.chatIdentifier.trim() }
      : {}),
    ...(typeof rawConversation.chatId === "string" || typeof rawConversation.chatId === "number"
      ? { chatId: rawConversation.chatId }
      : {}),
    ...(typeof rawConversation.handle === "string"
      ? { handle: rawConversation.handle.trim() }
      : {}),
  };
  if (
    !accountId ||
    !messageId ||
    !approvalId ||
    expiresAtMs === undefined ||
    !allowedDecisions ||
    (target.approvalKind !== "exec" && target.approvalKind !== "plugin") ||
    !normalizeConversationKey(conversation)
  ) {
    return null;
  }
  return {
    accountId,
    conversation,
    messageId,
    approvalId,
    approvalKind: target.approvalKind,
    allowedDecisions,
    expiresAtMs,
  };
}

export async function recordIMessageApprovalReactionPollTarget(params: {
  keys: readonly string[];
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  expiry: { ttlMs: number; expiresAtMs: number };
}): Promise<void> {
  const { expiry } = params;
  const target: PendingIMessageApprovalReactionPollTarget = {
    accountId: params.accountId,
    conversation: params.conversation,
    messageId: params.messageId,
    approvalId: params.approvalId,
    approvalKind: params.approvalKind,
    allowedDecisions: params.allowedDecisions,
    expiresAtMs: expiry.expiresAtMs,
  };
  const store = getPendingReactionPollTargetStore();
  const writes: Promise<void>[] = [];
  for (const key of params.keys) {
    pendingReactionPollTargets.set(key, target);
    if (store) {
      writes.push(
        store
          .register(key, target, { ttlMs: expiry.ttlMs })
          .catch(disablePendingReactionPollTargetStore),
      );
    }
  }
  prunePendingReactionPollTargets();
  await Promise.all(writes);
}

export async function deleteIMessageApprovalReactionPollTargets(
  keys: readonly string[],
): Promise<void> {
  const store = getPendingReactionPollTargetStore();
  const deletions: Promise<boolean | void>[] = [];
  for (const key of keys) {
    pendingReactionPollTargets.delete(key);
    if (store) {
      deletions.push(store.delete(key).catch(disablePendingReactionPollTargetStore));
    }
  }
  await Promise.all(deletions);
}

export async function listPendingIMessageApprovalReactionPollTargets(params: {
  accountId: string;
}): Promise<PendingIMessageApprovalReactionPollTarget[]> {
  const accountId = params.accountId.trim();
  if (!accountId) {
    return [];
  }
  const nowMs = Date.now();
  const store = getPendingReactionPollTargetStore();
  if (store) {
    try {
      for (const entry of await store.entries()) {
        const target = readPersistedPollTarget(entry.value);
        if (!target || !isFutureDateTimestampMs(target.expiresAtMs, { nowMs })) {
          await store.delete(entry.key);
          continue;
        }
        pendingReactionPollTargets.set(entry.key, target);
      }
    } catch (error) {
      disablePendingReactionPollTargetStore(error);
    }
  }
  prunePendingReactionPollTargets(nowMs);
  const targetByApprovalAndMessage = new Map<string, PendingIMessageApprovalReactionPollTarget>();
  for (const target of pendingReactionPollTargets.values()) {
    if (target.accountId !== accountId) {
      continue;
    }
    const key = `${target.approvalId}:${normalizeIMessageGuid(target.messageId)}`;
    const existing = targetByApprovalAndMessage.get(key);
    if (!existing) {
      targetByApprovalAndMessage.set(key, target);
      continue;
    }
    targetByApprovalAndMessage.set(key, {
      ...existing,
      conversation: mergePollTargetConversation(existing.conversation, target.conversation),
      expiresAtMs: Math.max(existing.expiresAtMs, target.expiresAtMs),
    });
  }
  return [...targetByApprovalAndMessage.values()];
}

export function clearIMessageApprovalReactionPollTargetsForTest(): void {
  pendingReactionPollTargets.clear();
  pendingReactionPollTargetStore = undefined;
  pendingReactionPollTargetStoreDisabled = false;
}
