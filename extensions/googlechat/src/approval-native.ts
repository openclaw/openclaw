import {
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  doesApprovalRequestMatchChannelAccount,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { listGoogleChatAccountIds, resolveGoogleChatAccount } from "./accounts.js";
import {
  getGoogleChatApprovalApprovers,
  googleChatApprovalAuth,
  normalizeGoogleChatApproverId,
} from "./approval-auth.js";
import { isGoogleChatSpaceTarget, normalizeGoogleChatTarget } from "./targets.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type GoogleChatOriginTarget = { to: string; threadId?: string | number | null };

function isGoogleChatAccountConfigured(params: {
  cfg: Parameters<typeof resolveGoogleChatAccount>[0]["cfg"];
  accountId?: string | null;
}): boolean {
  const account = resolveGoogleChatAccount(params);
  return account.enabled && account.credentialSource !== "none";
}

function hasGoogleChatWebhookApprovalAuthConfig(params: {
  cfg: Parameters<typeof resolveGoogleChatAccount>[0]["cfg"];
  accountId?: string | null;
}): boolean {
  const account = resolveGoogleChatAccount(params).config;
  const audience = normalizeOptionalString(account.audience);
  if (!audience) {
    return false;
  }
  if (account.audienceType === "project-number") {
    return true;
  }
  return account.audienceType === "app-url";
}

export function isGoogleChatNativeApprovalClientEnabled(params: {
  cfg: Parameters<typeof resolveGoogleChatAccount>[0]["cfg"];
  accountId?: string | null;
}): boolean {
  return (
    isGoogleChatAccountConfigured(params) &&
    hasGoogleChatWebhookApprovalAuthConfig(params) &&
    getGoogleChatApprovalApprovers(params).length > 0
  );
}

function resolveTurnSourceGoogleChatOriginTarget(
  request: ApprovalRequest,
): GoogleChatOriginTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  if (turnSourceChannel !== "googlechat") {
    return null;
  }
  const target = normalizeGoogleChatTarget(request.request.turnSourceTo ?? "");
  if (!target || !isGoogleChatSpaceTarget(target)) {
    return null;
  }
  return {
    to: target,
    threadId: request.request.turnSourceThreadId ?? null,
  };
}

function resolveSessionGoogleChatOriginTarget(sessionTarget: {
  to: string;
  threadId?: string | number | null;
}): GoogleChatOriginTarget | null {
  const target = normalizeGoogleChatTarget(sessionTarget.to);
  return target && isGoogleChatSpaceTarget(target)
    ? { to: target, threadId: sessionTarget.threadId ?? null }
    : null;
}

export function shouldHandleGoogleChatNativeApprovalRequest(params: {
  cfg: Parameters<typeof resolveGoogleChatAccount>[0]["cfg"];
  accountId?: string | null;
  request: ApprovalRequest;
}): boolean {
  if (
    !doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: "googlechat",
      accountId: params.accountId,
    })
  ) {
    return false;
  }
  return (
    isGoogleChatNativeApprovalClientEnabled(params) &&
    Boolean(resolveTurnSourceGoogleChatOriginTarget(params.request))
  );
}

const resolveGoogleChatOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "googlechat",
  shouldHandleRequest: shouldHandleGoogleChatNativeApprovalRequest,
  resolveTurnSourceTarget: resolveTurnSourceGoogleChatOriginTarget,
  resolveSessionTarget: resolveSessionGoogleChatOriginTarget,
});

const resolveGoogleChatApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: shouldHandleGoogleChatNativeApprovalRequest,
  resolveApprovers: getGoogleChatApprovalApprovers,
  mapApprover: (approver, params) => {
    const to = normalizeGoogleChatApproverId(approver);
    return to
      ? {
          to,
          accountId: normalizeOptionalString(params.accountId),
        }
      : null;
  },
});

export const googleChatApprovalCapability: ChannelApprovalCapability =
  createApproverRestrictedNativeApprovalCapability({
    channel: "googlechat",
    channelLabel: "Google Chat",
    describeExecApprovalSetup: ({ accountId }) => {
      const prefix =
        accountId && accountId !== "default"
          ? `channels.googlechat.accounts.${accountId}`
          : "channels.googlechat";
      return `Approve it from the Web UI or terminal UI for now. Google Chat supports native approvals for this account when the webhook and service account are configured. Configure \`${prefix}.dm.allowFrom\` or \`${prefix}.defaultTo\` with numeric \`users/{id}\` approvers.`;
    },
    listAccountIds: listGoogleChatAccountIds,
    hasApprovers: ({ cfg, accountId }) =>
      getGoogleChatApprovalApprovers({ cfg, accountId }).length > 0,
    isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
      googleChatApprovalAuth.authorizeActorAction?.({
        cfg,
        accountId,
        senderId,
        action: "approve",
        approvalKind: "exec",
      })?.authorized ?? false,
    isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
      googleChatApprovalAuth.authorizeActorAction?.({
        cfg,
        accountId,
        senderId,
        action: "approve",
        approvalKind: "plugin",
      })?.authorized ?? false,
    isNativeDeliveryEnabled: isGoogleChatNativeApprovalClientEnabled,
    resolveNativeDeliveryMode: () => "channel",
    requireMatchingTurnSourceChannel: true,
    resolveSuppressionAccountId: ({ target, request }) =>
      normalizeOptionalString(target.accountId) ??
      normalizeOptionalString(request.request.turnSourceAccountId),
    resolveOriginTarget: resolveGoogleChatOriginTarget,
    resolveApproverDmTargets: resolveGoogleChatApproverDmTargets,
    nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec", "plugin"],
      isConfigured: ({ cfg, accountId }) =>
        isGoogleChatNativeApprovalClientEnabled({ cfg, accountId }),
      shouldHandle: ({ cfg, accountId, request }) =>
        shouldHandleGoogleChatNativeApprovalRequest({ cfg, accountId, request }),
      load: async () =>
        (await import("./approval-handler.runtime.js"))
          .googleChatApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    }),
  });

export const googleChatNativeApprovalAdapter = splitChannelApprovalCapability(
  googleChatApprovalCapability,
);
