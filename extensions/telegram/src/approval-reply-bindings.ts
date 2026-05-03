import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/infra-runtime";

export type TelegramApprovalReplyBinding = {
  accountId: string;
  chatId: string;
  messageId: string;
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  createdAtMs: number;
  expiresAtMs: number;
  allowedDecisions: readonly ExecApprovalDecision[];
  commandText?: string | null;
};

export type TelegramApprovalReplyBindingLookupResult =
  | { ok: true; binding: TelegramApprovalReplyBinding }
  | { ok: false; reason: "missing" | "stale" };

const replyBindings = new Map<string, TelegramApprovalReplyBinding>();

function keyFor(params: { accountId: string; chatId: string; messageId: string }): string {
  return `${params.accountId}:${params.chatId}:${params.messageId}`;
}

function normalizeTextToken(text: string | null | undefined): string {
  return (text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, "")
    .replace(/\s+/gu, " ");
}

export function parseTelegramApprovalReplyDecision(
  text: string | null | undefined,
): ExecApprovalDecision | null {
  switch (normalizeTextToken(text)) {
    case "approve":
    case "approved":
    case "allow":
    case "allow once":
    case "allow-once":
      return "allow-once";
    case "allow always":
    case "allow-always":
      return "allow-always";
    case "deny":
    case "denied":
    case "reject":
    case "rejected":
      return "deny";
    default:
      return null;
  }
}

export function bindTelegramApprovalReply(
  binding: TelegramApprovalReplyBinding,
): TelegramApprovalReplyBinding {
  const normalized: TelegramApprovalReplyBinding = {
    ...binding,
    accountId: String(binding.accountId),
    chatId: String(binding.chatId),
    messageId: String(binding.messageId),
  };
  replyBindings.set(keyFor(normalized), normalized);
  return normalized;
}

export function unbindTelegramApprovalReply(binding: TelegramApprovalReplyBinding): void {
  replyBindings.delete(keyFor(binding));
}

export function resolveTelegramApprovalReplyBinding(params: {
  accountId: string;
  chatId: string;
  replyToMessageId: string;
  nowMs: number;
}): TelegramApprovalReplyBindingLookupResult {
  const key = keyFor({
    accountId: String(params.accountId),
    chatId: String(params.chatId),
    messageId: String(params.replyToMessageId),
  });
  const binding = replyBindings.get(key);
  if (!binding) {
    return { ok: false, reason: "missing" };
  }
  if (params.nowMs > binding.expiresAtMs) {
    replyBindings.delete(key);
    return { ok: false, reason: "stale" };
  }
  return { ok: true, binding };
}

export function clearTelegramApprovalReplyBindingsForTest(): void {
  replyBindings.clear();
}
