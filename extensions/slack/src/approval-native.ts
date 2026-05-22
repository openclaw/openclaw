import {
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelNativeOriginTargetResolver,
  resolveApprovalRequestSessionConversation,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import {
  channelRouteTargetsMatchExact,
  stringifyRouteThreadId,
} from "openclaw/plugin-sdk/channel-route";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { listSlackAccountIds } from "./accounts.js";
import { getSlackApprovalApprovers, isSlackApprovalAuthorizedSender } from "./approval-auth.js";
import {
  isSlackAnyNativeApprovalClientEnabled,
  resolveSlackApprovalKind,
  shouldDeliverSlackNativeApprovalRequest,
  shouldHandleSlackNativeApprovalRequest,
  type SlackApprovalKind,
  type SlackNativeApprovalRequest,
} from "./approval-native-gates.js";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalAuthorizedSender,
  isSlackExecApprovalClientEnabled,
  resolveSlackExecApprovalTarget,
} from "./exec-approvals.js";
import { parseSlackTarget } from "./targets.js";

type ApprovalRequest = SlackNativeApprovalRequest;
type ApprovalKind = SlackApprovalKind;
type SlackOriginTarget = { to: string; threadId?: string };
type SlackDeliverySuppressionInput = {
  cfg: Parameters<typeof shouldHandleSlackNativeApprovalRequest>[0]["cfg"];
  approvalKind: ApprovalKind;
  target: { channel: string; accountId?: string | null };
  request: {
    request: {
      turnSourceChannel?: string | null;
      turnSourceAccountId?: string | null;
    };
  };
};

function extractSlackSessionKind(
  sessionKey?: string | null,
): "direct" | "channel" | "group" | null {
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/slack:(direct|channel|group):/i);
  const kind = normalizeLowercaseStringOrEmpty(match?.[1]);
  return kind ? (kind as "direct" | "channel" | "group") : null;
}

function normalizeComparableTarget(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
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
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  const turnSourceTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
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
  const threadId = stringifyRouteThreadId(request.request.turnSourceThreadId);
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
    threadId: stringifyRouteThreadId(sessionTarget.threadId),
  };
}

function resolveSlackFallbackOriginTarget(request: ApprovalRequest): SlackOriginTarget | null {
  const sessionTarget = resolveApprovalRequestSessionConversation({
    request,
    channel: "slack",
    bundledFallback: false,
  });
  if (!sessionTarget) {
    return null;
  }
  const parsed = parseSlackTarget(sessionTarget.id.toUpperCase(), {
    defaultKind: "channel",
  });
  if (!parsed) {
    return null;
  }
  return {
    to: `${parsed.kind}:${parsed.id}`,
    threadId: sessionTarget.threadId,
  };
}

function normalizeSlackOriginTarget(target: SlackOriginTarget): SlackOriginTarget {
  return {
    ...target,
    to: normalizeComparableTarget(target.to),
  };
}

function slackTargetsMatch(a: SlackOriginTarget, b: SlackOriginTarget): boolean {
  return (
    channelRouteTargetsMatchExact({
      left: {
        channel: "slack",
        to: a.to,
      },
      right: {
        channel: "slack",
        to: b.to,
      },
    }) && normalizeSlackThreadMatchKey(a.threadId) === normalizeSlackThreadMatchKey(b.threadId)
  );
}

function resolveSlackNativeSuppressionAccountId({
  target,
  request,
}: SlackDeliverySuppressionInput): string | undefined {
  return (
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId)
  );
}

function shouldConsiderSlackNativeForwardingSuppression(
  input: SlackDeliverySuppressionInput,
): boolean {
  const channel = normalizeMessageChannel(input.target.channel) ?? input.target.channel;
  if (channel !== "slack") {
    return false;
  }
  if (input.approvalKind === "plugin") {
    return true;
  }
  const turnSourceChannel = normalizeMessageChannel(input.request.request.turnSourceChannel);
  return turnSourceChannel === "slack";
}

const resolveSlackOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "slack",
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleSlackNativeApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveTurnSourceTarget: resolveTurnSourceSlackOriginTarget,
  resolveSessionTarget: resolveSessionSlackOriginTarget,
  normalizeTargetForMatch: normalizeSlackOriginTarget,
  targetsMatch: slackTargetsMatch,
  resolveFallbackTarget: resolveSlackFallbackOriginTarget,
});

function resolveSlackApproverDmTargets(params: {
  cfg: Parameters<typeof shouldHandleSlackNativeApprovalRequest>[0]["cfg"];
  accountId?: string | null;
  approvalKind: ApprovalKind;
  request: ApprovalRequest;
}): SlackOriginTarget[] {
  if (
    !shouldHandleSlackNativeApprovalRequest({
      cfg: params.cfg,
      accountId: params.accountId,
      request: params.request,
    })
  ) {
    return [];
  }
  const approvers =
    params.approvalKind === "plugin"
      ? getSlackApprovalApprovers(params)
      : getSlackExecApprovalApprovers(params);
  return approvers.map((approver) => ({ to: `user:${approver}` }));
}

const baseSlackApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "slack",
  channelLabel: "Slack",
  describeExecApprovalSetup: ({
    accountId,
  }: Parameters<NonNullable<ChannelApprovalCapability["describeExecApprovalSetup"]>>[0]) => {
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
  resolveSuppressionAccountId: resolveSlackNativeSuppressionAccountId,
  resolveOriginTarget: resolveSlackOriginTarget,
  resolveApproverDmTargets: resolveSlackApproverDmTargets,
  notifyOriginWhenDmOnly: true,
  nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
    eventKinds: ["exec", "plugin"],
    isConfigured: ({ cfg, accountId }) =>
      isSlackAnyNativeApprovalClientEnabled({
        cfg,
        accountId,
      }),
    shouldHandle: ({ cfg, accountId, request }) =>
      shouldDeliverSlackNativeApprovalRequest({
        cfg,
        accountId,
        approvalKind: resolveSlackApprovalKind(request),
        request,
      }),
    load: async () =>
      (await import("./approval-handler.runtime.js"))
        .slackApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
  }),
});

const baseSlackNativeAdapter = baseSlackApprovalCapability.native;

export const slackApprovalCapability: ChannelApprovalCapability = {
  ...baseSlackApprovalCapability,
  delivery: {
    ...baseSlackApprovalCapability.delivery,
    shouldSuppressForwardingFallback: (input) => {
      const slackInput = input as SlackDeliverySuppressionInput;
      if (!shouldConsiderSlackNativeForwardingSuppression(slackInput)) {
        return false;
      }
      return shouldDeliverSlackNativeApprovalRequest({
        cfg: slackInput.cfg,
        accountId: resolveSlackNativeSuppressionAccountId(slackInput),
        approvalKind: slackInput.approvalKind,
        request: slackInput.request as ApprovalRequest,
      });
    },
  },
  native: baseSlackNativeAdapter
    ? {
        ...baseSlackNativeAdapter,
        describeDeliveryCapabilities: (params) => {
          const capabilities = baseSlackNativeAdapter.describeDeliveryCapabilities(params);
          return {
            ...capabilities,
            enabled: shouldHandleSlackNativeApprovalRequest({
              cfg: params.cfg,
              accountId: params.accountId,
              approvalKind: params.approvalKind,
              request: params.request as ApprovalRequest,
            }),
          };
        },
      }
    : undefined,
};

export const slackNativeApprovalAdapter = splitChannelApprovalCapability(slackApprovalCapability);
