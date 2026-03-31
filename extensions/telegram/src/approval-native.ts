import { createApproverRestrictedNativeApprovalAdapter } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type {
  ExecApprovalRequest,
  ExecApprovalSessionTarget,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/infra-runtime";
import { resolveExecApprovalSessionTarget } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { listTelegramAccountIds } from "./accounts.js";
import {
  getTelegramExecApprovalApprovers,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalClientEnabled,
  resolveTelegramExecApprovalTarget,
} from "./exec-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type TelegramOriginTarget = { to: string; threadId?: number; accountId?: string };

function isExecApprovalRequest(request: ApprovalRequest): request is ExecApprovalRequest {
  return "command" in request.request;
}

function toExecLikeRequest(request: ApprovalRequest): ExecApprovalRequest {
  if (isExecApprovalRequest(request)) {
    return request;
  }
  return {
    id: request.id,
    request: {
      command: request.request.title,
      sessionKey: request.request.sessionKey ?? undefined,
      turnSourceChannel: request.request.turnSourceChannel ?? undefined,
      turnSourceTo: request.request.turnSourceTo ?? undefined,
      turnSourceAccountId: request.request.turnSourceAccountId ?? undefined,
      turnSourceThreadId: request.request.turnSourceThreadId ?? undefined,
    },
    createdAtMs: request.createdAtMs,
    expiresAtMs: request.expiresAtMs,
  };
}

function resolveRequestSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequest;
}): ExecApprovalSessionTarget | null {
  const execLikeRequest = toExecLikeRequest(params.request);
  return resolveExecApprovalSessionTarget({
    cfg: params.cfg,
    request: execLikeRequest,
    turnSourceChannel: execLikeRequest.request.turnSourceChannel ?? undefined,
    turnSourceTo: execLikeRequest.request.turnSourceTo ?? undefined,
    turnSourceAccountId: execLikeRequest.request.turnSourceAccountId ?? undefined,
    turnSourceThreadId: execLikeRequest.request.turnSourceThreadId ?? undefined,
  });
}

function resolveTurnSourceTelegramOriginTarget(params: {
  accountId: string;
  request: ApprovalRequest;
}): TelegramOriginTarget | null {
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const turnSourceTo = params.request.request.turnSourceTo?.trim() || "";
  const turnSourceAccountId = params.request.request.turnSourceAccountId?.trim() || "";
  if (turnSourceChannel !== "telegram" || !turnSourceTo) {
    return null;
  }
  if (
    turnSourceAccountId &&
    normalizeAccountId(turnSourceAccountId) !== normalizeAccountId(params.accountId)
  ) {
    return null;
  }
  const threadId =
    typeof params.request.request.turnSourceThreadId === "number"
      ? params.request.request.turnSourceThreadId
      : typeof params.request.request.turnSourceThreadId === "string"
        ? Number.parseInt(params.request.request.turnSourceThreadId, 10)
        : undefined;
  return {
    to: turnSourceTo,
    threadId: Number.isFinite(threadId) ? threadId : undefined,
    accountId: turnSourceAccountId || undefined,
  };
}

function resolveSessionTelegramOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ApprovalRequest;
}): TelegramOriginTarget | null {
  const sessionTarget = resolveRequestSessionTarget(params);
  if (!sessionTarget || sessionTarget.channel !== "telegram") {
    return null;
  }
  if (
    sessionTarget.accountId &&
    normalizeAccountId(sessionTarget.accountId) !== normalizeAccountId(params.accountId)
  ) {
    return null;
  }
  return {
    to: sessionTarget.to,
    threadId: sessionTarget.threadId,
    accountId: sessionTarget.accountId,
  };
}

function telegramTargetsMatch(a: TelegramOriginTarget, b: TelegramOriginTarget): boolean {
  const accountMatches =
    !a.accountId ||
    !b.accountId ||
    normalizeAccountId(a.accountId) === normalizeAccountId(b.accountId);
  return a.to === b.to && a.threadId === b.threadId && accountMatches;
}

function resolveTelegramOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ApprovalRequest;
}) {
  const turnSourceTarget = resolveTurnSourceTelegramOriginTarget(params);
  const sessionTarget = resolveSessionTelegramOriginTarget(params);
  if (turnSourceTarget && sessionTarget && !telegramTargetsMatch(turnSourceTarget, sessionTarget)) {
    return null;
  }
  const target = turnSourceTarget ?? sessionTarget;
  return target ? { to: target.to, threadId: target.threadId } : null;
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
