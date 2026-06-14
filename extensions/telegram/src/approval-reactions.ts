import {
  createApprovalReactionTargetStore,
  listApprovalReactionBindings,
  resolveApprovalReactionTarget,
  type ApprovalReactionTargetRecord,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import { getOptionalTelegramRuntime } from "./runtime.js";

const PERSISTENT_NAMESPACE = "telegram.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

type TelegramApprovalReactionTarget = ApprovalReactionTargetRecord;

type TelegramApprovalReactionResolution = {
  approvalId: string;
  decision: ExecApprovalReplyDecision;
};

const telegramApprovalReactionTargets =
  createApprovalReactionTargetStore<TelegramApprovalReactionTarget>({
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    openStore: (storeParams) => getOptionalTelegramRuntime()?.state.openKeyedStore(storeParams),
    logPersistentError: reportPersistentApprovalReactionError,
    readPersistedTarget,
  });

function buildReactionTargetKey(params: {
  accountId: string;
  chatId: string | number;
  messageId: string | number;
}): string | null {
  const accountId = params.accountId.trim();
  const chatId = String(params.chatId).trim();
  const messageId = String(params.messageId).trim();
  if (!accountId || !chatId || !messageId) {
    return null;
  }
  return `${accountId}:${chatId}:${messageId}`;
}

function reportPersistentApprovalReactionError(error: unknown): void {
  try {
    getOptionalTelegramRuntime()
      ?.logging.getChildLogger({ plugin: "telegram", feature: "approval-reaction-state" })
      .warn("Telegram persistent approval reaction state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break Telegram reactions.
  }
}

function readPersistedTarget(target: unknown): TelegramApprovalReactionTarget | null {
  const value = target as Partial<TelegramApprovalReactionTarget> | null | undefined;
  if (!value || typeof value.approvalId !== "string" || !Array.isArray(value.allowedDecisions)) {
    return null;
  }
  return {
    approvalId: value.approvalId,
    ...(value.approvalKind === "exec" || value.approvalKind === "plugin"
      ? { approvalKind: value.approvalKind }
      : {}),
    allowedDecisions: value.allowedDecisions,
  };
}

export function registerTelegramApprovalReactionTarget(params: {
  accountId: string;
  chatId: string | number;
  messageId: string | number;
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  ttlMs?: number;
}): TelegramApprovalReactionTarget | null {
  const key = buildReactionTargetKey(params);
  const approvalId = params.approvalId.trim();
  const allowedDecisions = listApprovalReactionBindings({
    allowedDecisions: params.allowedDecisions,
  }).map((binding) => binding.decision);
  if (!key || !approvalId || allowedDecisions.length === 0) {
    return null;
  }
  const target: TelegramApprovalReactionTarget = {
    approvalId,
    approvalKind: approvalId.startsWith("plugin:") ? "plugin" : "exec",
    allowedDecisions,
  };
  telegramApprovalReactionTargets.register(key, target, { ttlMs: params.ttlMs });
  return target;
}

export function unregisterTelegramApprovalReactionTarget(params: {
  accountId: string;
  chatId: string | number;
  messageId: string | number;
}): void {
  const key = buildReactionTargetKey(params);
  if (!key) {
    return;
  }
  telegramApprovalReactionTargets.delete(key);
}

function resolveTarget(params: {
  target: TelegramApprovalReactionTarget | null | undefined;
  reactionKey: string;
}): TelegramApprovalReactionResolution | null {
  const resolved = resolveApprovalReactionTarget({
    target: params.target,
    reactionKey: params.reactionKey,
  });
  return resolved
    ? {
        approvalId: resolved.approvalId,
        decision: resolved.decision,
      }
    : null;
}

export async function resolveTelegramApprovalReactionTargetWithPersistence(params: {
  accountId: string;
  chatId: string | number;
  messageId: string | number;
  reactionKey: string;
}): Promise<TelegramApprovalReactionResolution | null> {
  const key = buildReactionTargetKey(params);
  if (!key) {
    return null;
  }
  return resolveTarget({
    target: await telegramApprovalReactionTargets.lookup(key),
    reactionKey: params.reactionKey,
  });
}

export function clearTelegramApprovalReactionTargetsForTest(): void {
  telegramApprovalReactionTargets.clearForTest();
}
