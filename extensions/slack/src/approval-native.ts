import {
  createApproverRestrictedNativeApprovalAdapter,
  resolveExecApprovalSessionTarget,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type {
  ExecApprovalRequest,
  ExecApprovalSessionTarget,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/infra-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
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
type SlackOriginTarget = { to: string; threadId?: string; accountId?: string };

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

function extractSlackSessionKind(sessionKey?: string | null): "direct" | "channel" | "group" | null {
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

function resolveTurnSourceSlackOriginTarget(params: {
  accountId: string;
  request: ApprovalRequest;
}): SlackOriginTarget | null {
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const turnSourceTo = params.request.request.turnSourceTo?.trim() || "";
  const turnSourceAccountId = params.request.request.turnSourceAccountId?.trim() || "";
  if (turnSourceChannel !== "slack" || !turnSourceTo) {
    return null;
  }
  if (
    turnSourceAccountId &&
    normalizeAccountId(turnSourceAccountId) !== normalizeAccountId(params.accountId)
  ) {
    return null;
  }
  const sessionKind = extractSlackSessionKind(params.request.request.sessionKey ?? undefined);
  const parsed = parseSlackTarget(turnSourceTo, {
    defaultKind: sessionKind === "direct" ? "user" : "channel",
  });
  if (!parsed) {
    return null;
  }
  const threadId =
    typeof params.request.request.turnSourceThreadId === "string"
      ? params.request.request.turnSourceThreadId.trim() || undefined
      : typeof params.request.request.turnSourceThreadId === "number"
        ? String(params.request.request.turnSourceThreadId)
        : undefined;
  return {
    to: `${parsed.kind}:${parsed.id}`,
    threadId,
    accountId: turnSourceAccountId || undefined,
  };
}

function resolveSessionSlackOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ApprovalRequest;
}): SlackOriginTarget | null {
  const sessionTarget = resolveRequestSessionTarget(params);
  if (!sessionTarget || sessionTarget.channel !== "slack") {
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
    threadId:
      typeof sessionTarget.threadId === "string"
        ? sessionTarget.threadId
        : typeof sessionTarget.threadId === "number"
          ? String(sessionTarget.threadId)
          : undefined,
    accountId: sessionTarget.accountId ?? undefined,
  };
}

function slackTargetsMatch(a: SlackOriginTarget, b: SlackOriginTarget): boolean {
  const accountMatches =
    !a.accountId ||
    !b.accountId ||
    normalizeAccountId(a.accountId) === normalizeAccountId(b.accountId);
  return (
    normalizeComparableTarget(a.to) === normalizeComparableTarget(b.to) &&
    normalizeSlackThreadMatchKey(a.threadId) === normalizeSlackThreadMatchKey(b.threadId) &&
    accountMatches
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
  const turnSourceTarget = resolveTurnSourceSlackOriginTarget(params);
  const sessionTarget = resolveSessionSlackOriginTarget(params);
  if (turnSourceTarget && sessionTarget && !slackTargetsMatch(turnSourceTarget, sessionTarget)) {
    return null;
  }
  const target = turnSourceTarget ?? sessionTarget;
  return target ? { to: target.to, threadId: target.threadId } : null;
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
