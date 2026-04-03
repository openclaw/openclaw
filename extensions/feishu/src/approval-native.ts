import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { listFeishuAccountIds } from "./accounts.js";
import { parseFeishuTargetId } from "./conversation-id.js";
import {
  getFeishuExecApprovalApprovers,
  isFeishuExecApprovalApprover,
  isFeishuExecApprovalAuthorizedSender,
  isFeishuExecApprovalClientEnabled,
  resolveFeishuExecApprovalTarget,
  shouldHandleFeishuExecApprovalRequest,
} from "./exec-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type FeishuOriginTarget = { to: string };

function resolveTurnSourceFeishuOriginTarget(request: ApprovalRequest): FeishuOriginTarget | null {
  const turnSourceChannel = request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const rawTurnSourceTo = request.request.turnSourceTo?.trim() || "";
  const turnSourceTo = parseFeishuTargetId(rawTurnSourceTo);
  if (turnSourceChannel !== "feishu" || !turnSourceTo) {
    return null;
  }
  return { to: turnSourceTo };
}

function resolveSessionFeishuOriginTarget(sessionTarget: {
  to: string;
  threadId?: number | null;
}): FeishuOriginTarget {
  return { to: parseFeishuTargetId(sessionTarget.to) ?? sessionTarget.to };
}

function feishuTargetsMatch(a: FeishuOriginTarget, b: FeishuOriginTarget): boolean {
  const normalizedA = parseFeishuTargetId(a.to) ?? a.to;
  const normalizedB = parseFeishuTargetId(b.to) ?? b.to;
  return normalizedA === normalizedB;
}

const resolveFeishuOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "feishu",
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleFeishuExecApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveTurnSourceTarget: resolveTurnSourceFeishuOriginTarget,
  resolveSessionTarget: resolveSessionFeishuOriginTarget,
  targetsMatch: feishuTargetsMatch,
});

const resolveFeishuApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleFeishuExecApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveApprovers: getFeishuExecApprovalApprovers,
  mapApprover: (approver) => ({ to: `user:${approver}` }),
});

export const feishuApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "feishu",
  channelLabel: "Feishu",
  listAccountIds: listFeishuAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    getFeishuExecApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isFeishuExecApprovalAuthorizedSender({ cfg, accountId, senderId }),
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isFeishuExecApprovalApprover({ cfg, accountId, senderId }),
  isNativeDeliveryEnabled: ({ cfg, accountId }) =>
    isFeishuExecApprovalClientEnabled({ cfg, accountId }),
  resolveNativeDeliveryMode: ({ cfg, accountId }) =>
    resolveFeishuExecApprovalTarget({ cfg, accountId }),
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId: ({ target, request }) =>
    target.accountId?.trim() || request.request.turnSourceAccountId?.trim() || undefined,
  resolveOriginTarget: resolveFeishuOriginTarget,
  resolveApproverDmTargets: resolveFeishuApproverDmTargets,
});

export const feishuNativeApprovalAdapter = splitChannelApprovalCapability(feishuApprovalCapability);
