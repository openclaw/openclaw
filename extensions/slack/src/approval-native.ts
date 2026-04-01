import {
  createApproverRestrictedNativeApprovalAdapter,
  resolveApprovalRequestOriginTarget,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { listSlackAccountIds } from "./accounts.js";
import { isSlackApprovalAuthorizedSender } from "./approval-auth.js";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalAuthorizedSender,
  isSlackExecApprovalClientEnabled,
  resolveSlackExecApprovalTarget,
  shouldHandleSlackExecApprovalRequest,
} from "./exec-approvals.js";
import { parseSlackTarget } from "./targets.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type SlackOriginTarget = { to: string; threadId?: string };

function extractSlackSessionKind(
  sessionKey?: string | null,
): "direct" | "channel" | "group" | null {
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/slack:(direct|channel|group):/i);
  return match?.[1] ? (match[1].toLowerCase() as "direct" | "channel" | "group") : null;
}

function normalizeComparableTarget(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSlackThreadMatchKey(threadId?: string): string {
  const trimmed = threadId?.trim();
  if (!trimmed) {
    return "";
  }
  const leadingEpoch = trimmed.match(/^\d+/)?.[0];
  return leadingEpoch ?? trimmed;
}

function resolveTurnSourceSlackOriginTarget(request: ApprovalRequest): SlackOriginTarget | null {
  const turnSourceChannel = request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const turnSourceTo = request.request.turnSourceTo?.trim() || "";
  if (turnSourceChannel !== "slack" || !turnSourceTo) {
    return null;
  }
  const sessionKind = extractSlackSessionKind(request.request.sessionKey ?? undefined);
  const parsed = parseSlackTarget(turnSourceTo, {
    defaultKind: sessionKind === "direct" ? "user" : "channel",
  });
  if (!parsed) {
    return null;
  }
  const threadId =
    typeof request.request.turnSourceThreadId === "string"
      ? request.request.turnSourceThreadId.trim() || undefined
      : typeof request.request.turnSourceThreadId === "number"
        ? String(request.request.turnSourceThreadId)
        : undefined;
  return {
    to: `${parsed.kind}:${parsed.id}`,
    threadId,
  };
}

function resolveSessionSlackOriginTarget(sessionTarget: {
  to: string;
  threadId?: string | number | null;
}): SlackOriginTarget {
  return {
    to: sessionTarget.to,
    threadId:
      typeof sessionTarget.threadId === "string"
        ? sessionTarget.threadId
        : typeof sessionTarget.threadId === "number"
          ? String(sessionTarget.threadId)
          : undefined,
  };
}

function slackTargetsMatch(a: SlackOriginTarget, b: SlackOriginTarget): boolean {
  return (
    normalizeComparableTarget(a.to) === normalizeComparableTarget(b.to) &&
    normalizeSlackThreadMatchKey(a.threadId) === normalizeSlackThreadMatchKey(b.threadId)
  );
}

function resolveSlackOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ApprovalRequest;
}) {
  if (!shouldHandleSlackExecApprovalRequest(params)) {
    return null;
  }
  return resolveApprovalRequestOriginTarget({
    cfg: params.cfg,
    request: params.request,
    channel: "slack",
    accountId: params.accountId,
    resolveTurnSourceTarget: resolveTurnSourceSlackOriginTarget,
    resolveSessionTarget: resolveSessionSlackOriginTarget,
    targetsMatch: slackTargetsMatch,
  });
}

function resolveSlackApproverDmTargets(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}) {
  if (!shouldHandleSlackExecApprovalRequest(params)) {
    return [];
  }
  return getSlackExecApprovalApprovers({
    cfg: params.cfg,
    accountId: params.accountId,
  }).map((approver) => ({ to: `user:${approver}` }));
}

export const slackNativeApprovalAdapter = createApproverRestrictedNativeApprovalAdapter({
  channel: "slack",
  channelLabel: "Slack",
  listAccountIds: listSlackAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    getSlackExecApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isSlackExecApprovalAuthorizedSender({ cfg, accountId, senderId }),
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isSlackApprovalAuthorizedSender({ cfg, accountId, senderId }),
  isNativeDeliveryEnabled: ({ cfg, accountId }) =>
    isSlackExecApprovalClientEnabled({ cfg, accountId }),
  resolveNativeDeliveryMode: ({ cfg, accountId }) =>
    resolveSlackExecApprovalTarget({ cfg, accountId }),
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId: ({ target, request }) =>
    target.accountId?.trim() || request.request.turnSourceAccountId?.trim() || undefined,
  resolveOriginTarget: ({ cfg, accountId, request }) =>
    accountId ? resolveSlackOriginTarget({ cfg, accountId, request }) : null,
  resolveApproverDmTargets: ({ cfg, accountId, request }) =>
    resolveSlackApproverDmTargets({ cfg, accountId, request }),
  notifyOriginWhenDmOnly: true,
});
