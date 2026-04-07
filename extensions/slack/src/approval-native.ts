import {
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
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

const resolveSlackOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "slack",
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleSlackExecApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveTurnSourceTarget: resolveTurnSourceSlackOriginTarget,
  resolveSessionTarget: resolveSessionSlackOriginTarget,
  targetsMatch: slackTargetsMatch,
});

const resolveSlackApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleSlackExecApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveApprovers: getSlackExecApprovalApprovers,
  mapApprover: (approver) => ({ to: `user:${approver}` }),
});

export const slackApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "slack",
  channelLabel: "Slack",
  describeExecApprovalSetup: ({ accountId }) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.slack.accounts.${accountId}`
        : "channels.slack";
    return `Approve it from the Web UI or terminal UI for now. Slack supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
  },
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
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId),
  resolveOriginTarget: resolveSlackOriginTarget,
  resolveApproverDmTargets: resolveSlackApproverDmTargets,
  notifyOriginWhenDmOnly: true,
});

export const slackNativeApprovalAdapter = splitChannelApprovalCapability(slackApprovalCapability);
