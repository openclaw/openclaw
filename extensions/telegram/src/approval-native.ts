import {
  createApproverRestrictedNativeApprovalAdapter,
  resolveApprovalRequestOriginTarget,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { listTelegramAccountIds } from "./accounts.js";
import {
  getTelegramExecApprovalApprovers,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalClientEnabled,
  resolveTelegramExecApprovalTarget,
} from "./exec-approvals.js";
import { normalizeTelegramChatId } from "./targets.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type TelegramOriginTarget = { to: string; threadId?: number };

function resolveTurnSourceTelegramOriginTarget(
  request: ApprovalRequest,
): TelegramOriginTarget | null {
  const turnSourceChannel = request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const rawTurnSourceTo = request.request.turnSourceTo?.trim() || "";
  const turnSourceTo = normalizeTelegramChatId(rawTurnSourceTo) ?? rawTurnSourceTo;
  if (turnSourceChannel !== "telegram" || !turnSourceTo) {
    return null;
  }
  const threadId =
    typeof request.request.turnSourceThreadId === "number"
      ? request.request.turnSourceThreadId
      : typeof request.request.turnSourceThreadId === "string"
        ? Number.parseInt(request.request.turnSourceThreadId, 10)
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

function resolveTelegramOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ApprovalRequest;
}) {
  return resolveApprovalRequestOriginTarget({
    cfg: params.cfg,
    request: params.request,
    channel: "telegram",
    accountId: params.accountId,
    resolveTurnSourceTarget: resolveTurnSourceTelegramOriginTarget,
    resolveSessionTarget: resolveSessionTelegramOriginTarget,
    targetsMatch: telegramTargetsMatch,
  });
}

function resolveTelegramApproverDmTargets(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  return getTelegramExecApprovalApprovers({
    cfg: params.cfg,
    accountId: params.accountId,
  }).map((approver) => ({ to: approver }));
}

export const telegramNativeApprovalAdapter = createApproverRestrictedNativeApprovalAdapter({
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
  resolveOriginTarget: ({ cfg, accountId, request }) =>
    accountId
      ? resolveTelegramOriginTarget({
          cfg,
          accountId,
          request,
        })
      : null,
  resolveApproverDmTargets: ({ cfg, accountId }) =>
    resolveTelegramApproverDmTargets({ cfg, accountId }),
});
