import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { listTelegramAccountIds } from "./accounts.js";
import {
  getTelegramExecApprovalApprovers,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalClientEnabled,
  resolveTelegramExecApprovalTarget,
  shouldHandleTelegramExecApprovalRequest,
} from "./exec-approvals.js";
import { normalizeTelegramChatId, parseTelegramTarget } from "./targets.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type TelegramOriginTarget = { to: string; threadId?: number };

function resolveTurnSourceTelegramOriginTarget(
  request: ApprovalRequest,
): TelegramOriginTarget | null {
  const turnSourceChannel = request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const rawTurnSourceTo = request.request.turnSourceTo?.trim() || "";
  const parsedTurnSourceTarget = rawTurnSourceTo ? parseTelegramTarget(rawTurnSourceTo) : null;
  const turnSourceTo = normalizeTelegramChatId(parsedTurnSourceTarget?.chatId ?? rawTurnSourceTo);
  if (turnSourceChannel !== "telegram" || !turnSourceTo) {
    return null;
  }
  const rawThreadId =
    request.request.turnSourceThreadId ?? parsedTurnSourceTarget?.messageThreadId ?? undefined;
  const threadId =
    typeof rawThreadId === "number"
      ? rawThreadId
      : typeof rawThreadId === "string"
        ? Number.parseInt(rawThreadId, 10)
        : undefined;
  return {
    to: turnSourceTo,
    threadId: Number.isFinite(threadId) ? threadId : undefined,
  };
}

function resolveSessionTelegramOriginTarget(sessionTarget: {
  to: string;
  threadId?: number | null;
}): TelegramOriginTarget {
  return {
    to: normalizeTelegramChatId(sessionTarget.to) ?? sessionTarget.to,
    threadId: sessionTarget.threadId ?? undefined,
  };
}

function telegramTargetsMatch(a: TelegramOriginTarget, b: TelegramOriginTarget): boolean {
  const normalizedA = normalizeTelegramChatId(a.to) ?? a.to;
  const normalizedB = normalizeTelegramChatId(b.to) ?? b.to;
  return normalizedA === normalizedB && a.threadId === b.threadId;
}

const resolveTelegramOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "telegram",
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleTelegramExecApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveTurnSourceTarget: resolveTurnSourceTelegramOriginTarget,
  resolveSessionTarget: resolveSessionTelegramOriginTarget,
  targetsMatch: telegramTargetsMatch,
});

const resolveTelegramApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleTelegramExecApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveApprovers: getTelegramExecApprovalApprovers,
  mapApprover: (approver) => ({ to: approver }),
});

const telegramNativeApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "telegram",
  channelLabel: "Telegram",
  listAccountIds: listTelegramAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    getTelegramExecApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isTelegramExecApprovalAuthorizedSender({ cfg, accountId, senderId }),
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isTelegramExecApprovalApprover({ cfg, accountId, senderId }),
  isNativeDeliveryEnabled: ({ cfg, accountId }) =>
    isTelegramExecApprovalClientEnabled({ cfg, accountId }),
  resolveNativeDeliveryMode: ({ cfg, accountId }) =>
    resolveTelegramExecApprovalTarget({ cfg, accountId }),
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId: ({ target, request }) =>
    target.accountId?.trim() || request.request.turnSourceAccountId?.trim() || undefined,
  resolveOriginTarget: resolveTelegramOriginTarget,
  resolveApproverDmTargets: resolveTelegramApproverDmTargets,
});

const resolveTelegramApproveCommandBehavior: NonNullable<
  ChannelApprovalCapability["resolveApproveCommandBehavior"]
> = ({ cfg, accountId, senderId, approvalKind }) => {
  if (approvalKind !== "exec") {
    return undefined;
  }
  if (isTelegramExecApprovalClientEnabled({ cfg, accountId })) {
    return undefined;
  }
  if (
    isTelegramExecApprovalAuthorizedSender({ cfg, accountId, senderId }) &&
    !isTelegramExecApprovalApprover({ cfg, accountId, senderId })
  ) {
    return { kind: "ignore" };
  }
  return {
    kind: "reply",
    text: "❌ Telegram exec approvals are not enabled for this bot account.",
  };
};

export const telegramApprovalCapability: ChannelApprovalCapability = {
  ...telegramNativeApprovalCapability,
  resolveApproveCommandBehavior: resolveTelegramApproveCommandBehavior,
};

export const telegramNativeApprovalAdapter = splitChannelApprovalCapability(
  telegramApprovalCapability,
);
