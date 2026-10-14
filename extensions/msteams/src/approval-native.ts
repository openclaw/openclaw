import { createApproverRestrictedNativeApprovalCapabilityAsync } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapterAsync } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolverAsync,
  createChannelNativeOriginTargetResolverAsync,
  createNativeApprovalChannelRouteGatesAsync,
  createNativeApprovalMessagingTargetResolvers,
  shouldSuppressLocalNativeExecApprovalPrompt,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ChannelApprovalCapability,
  ChannelOutboundPayloadHint,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultMSTeamsAccountId, resolveMSTeamsAccount } from "./accounts.js";
import { getMSTeamsApprovalApprovers, msTeamsApprovalAuth } from "./approval-auth.js";
import { msteamsConfigAdapter } from "./channel-config.js";
import { normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";

type MSTeamsApprovalRequest =
  | ExecApprovalRequest
  | PluginApprovalRequest
  | SystemAgentApprovalRequest;

function isMSTeamsApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const account = resolveMSTeamsAccount(params);
  return account.enabled && account.configured && account.tokenStatus === "available";
}

const msTeamsMessagingTargetResolvers = createNativeApprovalMessagingTargetResolvers({
  channel: "msteams",
  normalizeTo: normalizeMSTeamsMessagingTarget,
});

const msTeamsApprovalTargetResolvers = {
  ...msTeamsMessagingTargetResolvers,
  resolveTurnSourceTarget: (request: MSTeamsApprovalRequest) => {
    const target = msTeamsMessagingTargetResolvers.resolveTurnSourceTarget(request);
    return target ? { ...target, threadId: request.request.turnSourceThreadId ?? null } : null;
  },
  resolveSessionTarget: (
    sessionTarget: Parameters<typeof msTeamsMessagingTargetResolvers.resolveSessionTarget>[0],
  ) => {
    const target = msTeamsMessagingTargetResolvers.resolveSessionTarget(sessionTarget);
    return target ? { ...target, threadId: sessionTarget.threadId ?? null } : null;
  },
};

const msTeamsApprovalRouteGates = createNativeApprovalChannelRouteGatesAsync({
  channel: "msteams",
  defaultForwardingMode: "session",
  isTransportEnabled: isMSTeamsApprovalTransportEnabled,
  listAccountIds: msteamsConfigAdapter.listAccountIds,
  resolveDefaultAccountId: resolveDefaultMSTeamsAccountId,
  normalizeForwardTarget: msTeamsApprovalTargetResolvers.normalizeForwardTarget,
  resolveTurnSourceTarget: msTeamsApprovalTargetResolvers.resolveTurnSourceTarget,
});

export function isMSTeamsNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return (
    msTeamsApprovalRouteGates.canAnyApprovalPotentiallyRouteToChannel({
      ...params,
      nativeSessionOnly: true,
    }) && getMSTeamsApprovalApprovers(params).length > 0
  );
}

export async function shouldHandleMSTeamsNativeApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ChannelApprovalKind;
  request: MSTeamsApprovalRequest;
}): Promise<boolean> {
  return (
    (await msTeamsApprovalRouteGates.shouldHandleApprovalRequest(params)) &&
    getMSTeamsApprovalApprovers(params).length > 0 &&
    Boolean(msTeamsApprovalTargetResolvers.resolveTurnSourceTarget(params.request))
  );
}

export function shouldSuppressLocalMSTeamsExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
}): boolean {
  return shouldSuppressLocalNativeExecApprovalPrompt({
    ...params,
    isNativeDeliveryEnabled: isMSTeamsNativeApprovalClientEnabled,
  });
}

const resolveMSTeamsOriginTarget = createChannelNativeOriginTargetResolverAsync({
  channel: "msteams",
  shouldHandleRequest: shouldHandleMSTeamsNativeApprovalRequest,
  resolveTurnSourceTarget: msTeamsApprovalTargetResolvers.resolveTurnSourceTarget,
  resolveSessionTarget: msTeamsApprovalTargetResolvers.resolveSessionTarget,
  normalizeTarget: msTeamsApprovalTargetResolvers.normalizeTarget,
});

const msTeamsLazyApprovalNativeRuntime = createLazyChannelApprovalNativeRuntimeAdapterAsync({
  capabilityBoundary: true,
  eventKinds: ["exec", "plugin", "system-agent"],
  isConfigured: ({ cfg, accountId }) => isMSTeamsNativeApprovalClientEnabled({ cfg, accountId }),
  shouldHandle: ({ cfg, accountId, approvalKind, request }) =>
    shouldHandleMSTeamsNativeApprovalRequest({ cfg, accountId, approvalKind, request }),
  load: async () => {
    const { msTeamsApprovalNativeRuntime } = await import("./approval-handler.runtime.js");
    return msTeamsApprovalNativeRuntime;
  },
});

const resolveMSTeamsApproverDmTargets = createChannelApproverDmTargetResolverAsync({
  shouldHandleRequest: shouldHandleMSTeamsNativeApprovalRequest,
  resolveApprovers: getMSTeamsApprovalApprovers,
  mapApprover: (approver, params) => ({
    to: `user:${approver}`,
    accountId: normalizeOptionalString(params.accountId),
  }),
});

const msTeamsNativeApprovalCapability = createApproverRestrictedNativeApprovalCapabilityAsync({
  channel: "msteams",
  channelLabel: "Microsoft Teams",
  describeExecApprovalSetup: () =>
    "Approve it from the Web UI for now. Microsoft Teams supports native approvals when the bot is configured. Configure `channels.msteams.allowFrom` or `channels.msteams.defaultTo` with Microsoft Entra object ID approvers.",
  listAccountIds: msteamsConfigAdapter.listAccountIds,
  hasApprovers: ({ cfg, accountId }) => getMSTeamsApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    msTeamsApprovalAuth.authorizeActorAction?.({
      cfg,
      accountId,
      senderId,
      action: "approve",
      approvalKind: "exec",
    })?.authorized ?? false,
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    msTeamsApprovalAuth.authorizeActorAction?.({
      cfg,
      accountId,
      senderId,
      action: "approve",
      approvalKind: "plugin",
    })?.authorized ?? false,
  isNativeDeliveryEnabled: async (params) => isMSTeamsNativeApprovalClientEnabled(params),
  resolveNativeDeliveryMode: () => "channel",
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId: ({ target, request }) =>
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId),
  resolveOriginTarget: resolveMSTeamsOriginTarget,
  resolveApproverDmTargets: resolveMSTeamsApproverDmTargets,
  nativeRuntimeAsync: msTeamsLazyApprovalNativeRuntime,
});

export const msTeamsApprovalCapability: ChannelApprovalCapability = {
  ...msTeamsNativeApprovalCapability,
  // Preserve implicit same-chat authorization when no explicit approvers exist.
  authorizeActorActionAsync: async (params) => msTeamsApprovalAuth.authorizeActorAction?.(params),
};
