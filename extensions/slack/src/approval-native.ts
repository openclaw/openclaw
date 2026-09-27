import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelNativeOriginTargetResolver,
  createNativeApprovalForwardingFallbackSuppressor,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listSlackAccountIds } from "./accounts.js";
import {
  getSlackApprovalApproversForTeam,
  isSlackPluginApprovalAuthorizedSender,
} from "./approval-auth.js";
import {
  isSlackAnyNativeApprovalClientEnabled,
  isSlackPluginApprovalPolicyRouteEligible,
  isSlackPluginApprovalRequest,
  normalizeSlackForwardTarget,
  normalizeSlackOriginTarget,
  resolveSessionSlackOriginTarget,
  resolveSlackFallbackOriginTarget,
  resolveSlackApprovalTeamId,
  resolveTurnSourceSlackOriginTarget,
  shouldHandleSlackNativeApprovalRequest,
  shouldHandleSlackPluginViaForwardingSession,
  slackTargetsMatch,
  type SlackNativeApprovalRequest,
  type SlackOriginTarget,
} from "./approval-native-gates.js";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalAuthorizedSender,
  isSlackExecApprovalClientEnabled,
  resolveSlackExecApprovalTarget,
} from "./exec-approvals.js";
import { formatSlackTarget, parseSlackTarget } from "./target-parsing.js";

type SlackSuppressionAccountInput = {
  target: { channel: string; accountId?: string | null };
  request: {
    request: {
      turnSourceChannel?: string | null;
      turnSourceAccountId?: string | null;
    };
  };
};

function resolveSlackNativeSuppressionAccountId({
  target,
  request,
}: SlackSuppressionAccountInput): string | undefined {
  return (
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId)
  );
}

function shouldConsiderSlackNativeForwardingSuppression(
  input: SlackSuppressionAccountInput & { approvalKind: ChannelApprovalKind },
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
  shouldHandleRequest: shouldHandleSlackNativeApprovalRequest,
  resolveTurnSourceTarget: resolveTurnSourceSlackOriginTarget,
  resolveSessionTarget: resolveSessionSlackOriginTarget,
  normalizeTargetForMatch: normalizeSlackOriginTarget,
  targetsMatch: slackTargetsMatch,
  resolveFallbackTarget: resolveSlackFallbackOriginTarget,
});

function resolveSlackApproverDmTargets(params: {
  cfg: Parameters<typeof shouldHandleSlackNativeApprovalRequest>[0]["cfg"];
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
  request: SlackNativeApprovalRequest;
}): SlackOriginTarget[] {
  if (!shouldHandleSlackNativeApprovalRequest(params)) {
    return [];
  }
  const teamId = resolveSlackApprovalTeamId(params);
  const approvers =
    params.approvalKind === "plugin"
      ? isSlackPluginApprovalRequest(params.request)
        ? getSlackApprovalApproversForTeam({ ...params, teamId, request: params.request })
        : []
      : getSlackExecApprovalApprovers(params);
  return approvers.map((approver) => {
    const target = parseSlackTarget(approver, { defaultKind: "user" });
    if (!target || target.kind !== "user") {
      throw new Error("Slack approval approver target must be a user");
    }
    return {
      to: formatSlackTarget({
        kind: "user",
        id: target.id,
        teamId: target.teamId ?? teamId,
        explicitKind: true,
      }),
    };
  });
}

const shouldSuppressSlackForwardingFallback =
  createNativeApprovalForwardingFallbackSuppressor<SlackOriginTarget>({
    channel: "slack",
    normalizeForwardTarget: normalizeSlackForwardTarget,
    resolveAccountId: resolveSlackNativeSuppressionAccountId,
    isSessionRouteEligible: shouldHandleSlackNativeApprovalRequest,
    isExplicitTargetEligible: shouldHandleSlackNativeApprovalRequest,
    resolveOriginTarget: resolveSlackOriginTarget,
    resolveApproverDmTargets: resolveSlackApproverDmTargets,
    targetsMatch: slackTargetsMatch,
  });

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
    return `Approve it from the Web UI for now. Slack supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; set \`${prefix}.execApprovals.enabled\` to \`auto\` or \`true\`. Unset or \`false\` disables native exec approval delivery.`;
  },
  listAccountIds: listSlackAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    getSlackExecApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: isSlackExecApprovalAuthorizedSender,
  isPluginAuthorizedSender: isSlackPluginApprovalAuthorizedSender,
  isNativeDeliveryEnabled: isSlackExecApprovalClientEnabled,
  resolveNativeDeliveryMode: resolveSlackExecApprovalTarget,
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId: resolveSlackNativeSuppressionAccountId,
  resolveOriginTarget: resolveSlackOriginTarget,
  resolveApproverDmTargets: resolveSlackApproverDmTargets,
  notifyOriginWhenDmOnly: true,
  nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
    capabilityBoundary: true,
    eventKinds: ["exec", "plugin", "system-agent"],
    isConfigured: isSlackAnyNativeApprovalClientEnabled,
    shouldHandle: shouldHandleSlackNativeApprovalRequest,
    load: async () => (await import("./approval-handler.runtime.js")).slackApprovalNativeRuntime,
  }),
});

const baseSlackNativeAdapter = baseSlackApprovalCapability.native;

export const slackApprovalCapability: ChannelApprovalCapability = {
  ...baseSlackApprovalCapability,
  resolveReviewerSenderId: ({ senderId, spaceId }) => {
    try {
      const parsed = senderId ? parseSlackTarget(senderId, { defaultKind: "user" }) : undefined;
      return parsed?.kind === "user" && spaceId
        ? formatSlackTarget({ kind: "user", id: parsed.id, teamId: spaceId })
        : (senderId ?? undefined);
    } catch {
      return senderId ?? undefined;
    }
  },
  getActionAvailabilityState: (params) =>
    params.approvalKind === "plugin" && params.cfg.approvals?.plugin?.slack
      ? {
          kind:
            params.request &&
            !shouldHandleSlackNativeApprovalRequest({
              ...params,
              approvalKind: "plugin",
              request: params.request,
            })
              ? "disabled"
              : "enabled",
        }
      : (baseSlackApprovalCapability.getActionAvailabilityState?.(params) ?? { kind: "disabled" }),
  delivery: {
    ...baseSlackApprovalCapability.delivery,
    shouldSuppressForwardingFallback: (input) => {
      if (!shouldConsiderSlackNativeForwardingSuppression(input)) {
        return false;
      }
      if (input.approvalKind === "plugin") {
        if (!isSlackPluginApprovalRequest(input.request)) {
          return true;
        }
        if (
          !isSlackPluginApprovalPolicyRouteEligible({
            cfg: input.cfg,
            accountId: resolveSlackNativeSuppressionAccountId(input),
            request: input.request,
          })
        ) {
          return true;
        }
      }
      const canHandleNative = shouldHandleSlackNativeApprovalRequest({
        cfg: input.cfg,
        accountId: resolveSlackNativeSuppressionAccountId(input),
        approvalKind: input.approvalKind,
        request: input.request,
      });
      if (!canHandleNative || input.approvalKind !== "plugin") {
        return canHandleNative;
      }
      return shouldSuppressSlackForwardingFallback(input);
    },
  },
  native: baseSlackNativeAdapter
    ? {
        ...baseSlackNativeAdapter,
        describeDeliveryCapabilities: (params) => {
          const capabilities = baseSlackNativeAdapter.describeDeliveryCapabilities(params);
          const request = params.request as SlackNativeApprovalRequest;
          const approvalKind = params.approvalKind;
          return {
            ...capabilities,
            enabled: shouldHandleSlackNativeApprovalRequest({
              cfg: params.cfg,
              accountId: params.accountId,
              approvalKind,
              request,
            }),
            ...(approvalKind === "plugin" &&
            isSlackPluginApprovalRequest(request) &&
            shouldHandleSlackPluginViaForwardingSession({
              cfg: params.cfg,
              accountId: params.accountId,
              request,
            })
              ? {
                  preferredSurface: "origin" as const,
                  supportsApproverDmSurface:
                    getSlackApprovalApproversForTeam({
                      cfg: params.cfg,
                      accountId: params.accountId,
                      teamId: resolveSlackApprovalTeamId({
                        cfg: params.cfg,
                        accountId: params.accountId,
                        request,
                      }),
                      request,
                    }).length > 0,
                }
              : {}),
          };
        },
      }
    : undefined,
};
