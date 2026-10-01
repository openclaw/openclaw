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
  resolveSlackApprovalTeamId,
} from "./approval-auth.js";
import {
  isSlackAnyNativeApprovalClientEnabled,
  isSlackPluginApprovalRequest,
  normalizeSlackForwardTarget,
  normalizeSlackOriginTarget,
  resolveSlackApproverDmTargets,
  resolveSessionSlackOriginTarget,
  resolveSlackFallbackOriginTarget,
  resolveTurnSourceSlackOriginTarget,
  shouldHandleSlackNativeApprovalRequest,
  shouldHandleSlackPluginViaForwardingSession,
  slackTargetsMatch,
  type SlackNativeApprovalRequest,
  type SlackOriginTarget,
} from "./approval-native-gates.js";
import { resolvePluginApprovalSlackApprovers } from "./approval-plugin-policy.js";
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
  describePluginApprovalSetup: () =>
    "Check `approvals.plugin.slack` for a reviewer in the bot's workspace and confirm the Slack bot is connected, or connect an approval-capable Gateway client. Then retry the request.",
  listAccountIds: listSlackAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    getSlackExecApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: isSlackExecApprovalAuthorizedSender,
  isPluginAuthorizedSender: (params) =>
    isSlackPluginApprovalAuthorizedSender(params) &&
    (!params.request ||
      resolvePluginApprovalSlackApprovers(params.cfg, params.request) === undefined ||
      // Custody must use the same account eligibility as delivery so a dormant
      // sibling account cannot make an unbound request impossible to approve.
      shouldHandleSlackNativeApprovalRequest({
        cfg: params.cfg,
        accountId: params.accountId,
        approvalKind: "plugin",
        request: params.request,
      })),
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
  supportsScopedPluginApprovalApprovers: true,
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
    params.approvalKind === "plugin" &&
    params.cfg.approvals?.plugin?.slack &&
    // An unmatched override retains legacy /approve availability even when
    // native exec delivery is off; only a selected list changes that route.
    (!params.request ||
      !isSlackPluginApprovalRequest(params.request) ||
      resolvePluginApprovalSlackApprovers(params.cfg, params.request) !== undefined)
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
    shouldBlockForwardingFallback: (input) =>
      shouldConsiderSlackNativeForwardingSuppression(input) &&
      input.approvalKind === "plugin" &&
      isSlackPluginApprovalRequest(input.request) &&
      // Selected reviewers receive native DMs. A generic target might be a
      // different user or channel, and cannot enforce that recipient list.
      resolvePluginApprovalSlackApprovers(input.cfg, input.request) !== undefined,
    shouldSuppressForwardingFallback: (input) => {
      if (!shouldConsiderSlackNativeForwardingSuppression(input)) {
        return false;
      }
      if (input.approvalKind === "plugin" && !isSlackPluginApprovalRequest(input.request)) {
        return true;
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
          const described = {
            ...capabilities,
            enabled: shouldHandleSlackNativeApprovalRequest({
              cfg: params.cfg,
              accountId: params.accountId,
              approvalKind,
              request,
            }),
          };
          if (approvalKind !== "plugin" || !isSlackPluginApprovalRequest(request)) {
            return described;
          }
          // A selected reviewer list owns the card destination even when
          // forwarding would otherwise use the origin session.
          if (resolvePluginApprovalSlackApprovers(params.cfg, request) !== undefined) {
            return {
              ...described,
              preferredSurface: "approver-dm",
              supportsApproverDmSurface: true,
            };
          }
          if (
            !shouldHandleSlackPluginViaForwardingSession({
              cfg: params.cfg,
              accountId: params.accountId,
              request,
            })
          ) {
            return described;
          }
          return {
            ...described,
            preferredSurface: "origin",
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
          };
        },
      }
    : undefined,
};
