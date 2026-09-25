import {
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createNativeApprovalChannelRouteGates,
  doesApprovalRequestSelectChannelAccount,
  resolveApprovalKind,
  resolveApprovalRequestSessionConversation,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import {
  channelRouteTargetsMatchExact,
  stringifyRouteThreadId,
} from "openclaw/plugin-sdk/channel-route";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isSlackPluginAccountConfigured } from "./account-configured.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
} from "./accounts.js";
import { getSlackApprovalApprovers, getSlackApprovalApproversForTeam } from "./approval-auth.js";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalClientEnabled,
} from "./exec-approvals.js";
import { getSlackInstallationKind } from "./installation-identity-state.js";
import {
  canonicalizeSlackApiTargetId,
  formatSlackTarget,
  parseSlackTarget,
} from "./target-parsing.js";

export type SlackNativeApprovalRequest =
  | ExecApprovalRequest
  | PluginApprovalRequest
  | SystemAgentApprovalRequest;
export type SlackOriginTarget = {
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

type SlackForwardTarget = Parameters<
  NonNullable<
    NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
  >
>[0]["target"];

const SLACK_DM_CHANNEL_ID_RE = /^D[A-Z0-9]{8,}$/i;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{8,}$/i;

function isSlackApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const account = resolveSlackAccount(params);
  return isSlackPluginAccountConfigured(account);
}

function resolveSlackNativeApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  return resolveSlackAccount(params).config.execApprovals;
}

function normalizeSlackThreadMatchKey(threadId?: string | number | null): string {
  return threadId == null ? "" : String(threadId).trim();
}

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

function resolveSlackTurnSourceDefaultKind(params: {
  turnSourceTo: string;
  sessionKind: "direct" | "channel" | "group" | null;
}): "user" | "channel" {
  // Slack app conversations arrive as the concrete D-channel plus the app
  // thread root, so keep that live target instead of rewriting it to a user id.
  if (SLACK_DM_CHANNEL_ID_RE.test(params.turnSourceTo)) {
    return "channel";
  }
  return params.sessionKind === "direct" ? "user" : "channel";
}

export function resolveTurnSourceSlackOriginTarget(
  request: SlackNativeApprovalRequest,
): SlackOriginTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  const turnSourceTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
  if (turnSourceChannel !== "slack" || !turnSourceTo) {
    return null;
  }
  const sessionKind = extractSlackSessionKind(request.request.sessionKey ?? undefined);
  const parsed = parseSlackTarget(turnSourceTo, {
    defaultKind: resolveSlackTurnSourceDefaultKind({ turnSourceTo, sessionKind }),
  });
  if (!parsed) {
    return null;
  }
  return {
    to: formatSlackTarget({ ...parsed, explicitKind: true }),
    threadId: stringifyRouteThreadId(request.request.turnSourceThreadId),
  };
}

export function resolveSessionSlackOriginTarget(sessionTarget: {
  to: string;
  threadId?: string | number | null;
}): SlackOriginTarget {
  return {
    to: sessionTarget.to,
    threadId: stringifyRouteThreadId(sessionTarget.threadId),
  };
}

export function resolveSlackFallbackOriginTarget(
  request: SlackNativeApprovalRequest,
): SlackOriginTarget | null {
  const sessionTarget = resolveApprovalRequestSessionConversation({
    request,
    channel: "slack",
    bundledFallback: false,
  });
  if (!sessionTarget) {
    return null;
  }
  const parsed = parseSlackTarget(sessionTarget.id, {
    defaultKind: "channel",
  });
  if (!parsed) {
    return null;
  }
  return {
    to: formatSlackTarget({
      ...parsed,
      id: canonicalizeSlackApiTargetId(parsed.kind, parsed.id),
      explicitKind: true,
    }),
    threadId: sessionTarget.threadId,
  };
}

export function normalizeSlackOriginTarget(target: SlackOriginTarget): SlackOriginTarget {
  return {
    ...target,
    to: normalizeLowercaseStringOrEmpty(target.to),
  };
}

function isSlackDmChannelToUserRoutePair(a: SlackOriginTarget, b: SlackOriginTarget): boolean {
  const left = parseSlackTarget(a.to, { defaultKind: "channel" });
  const right = parseSlackTarget(b.to, { defaultKind: "channel" });
  if (!left || !right) {
    return false;
  }
  if (left.teamId?.toLowerCase() !== right.teamId?.toLowerCase()) {
    return false;
  }
  return (
    (left.kind === "channel" && SLACK_DM_CHANNEL_ID_RE.test(left.id) && right.kind === "user") ||
    (right.kind === "channel" && SLACK_DM_CHANNEL_ID_RE.test(right.id) && left.kind === "user")
  );
}

export function slackTargetsMatch(a: SlackOriginTarget, b: SlackOriginTarget): boolean {
  const threadKey = normalizeSlackThreadMatchKey(a.threadId);
  if (threadKey !== normalizeSlackThreadMatchKey(b.threadId)) {
    return false;
  }
  if (
    channelRouteTargetsMatchExact({
      left: {
        channel: "slack",
        to: a.to,
      },
      right: {
        channel: "slack",
        to: b.to,
      },
    })
  ) {
    return true;
  }
  return Boolean(threadKey && isSlackDmChannelToUserRoutePair(a, b));
}

export function normalizeSlackForwardTarget(
  target: Pick<SlackForwardTarget, "channel" | "to" | "accountId" | "threadId">,
): SlackOriginTarget | null {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  if (channel !== "slack") {
    return null;
  }
  const to = normalizeOptionalString(target.to);
  if (!to) {
    return null;
  }
  const parsed = parseSlackTarget(to, {
    defaultKind: SLACK_USER_ID_RE.test(to) ? "user" : "channel",
  });
  if (!parsed) {
    return null;
  }
  return {
    to: formatSlackTarget({ ...parsed, explicitKind: true }),
    accountId: normalizeOptionalString(target.accountId),
    threadId: stringifyRouteThreadId(target.threadId),
  };
}

const slackApprovalRouteGates = createNativeApprovalChannelRouteGates({
  channel: "slack",
  defaultForwardingMode: "session",
  isTransportEnabled: isSlackApprovalTransportEnabled,
  listAccountIds: listSlackAccountIds,
  resolveDefaultAccountId: resolveDefaultSlackAccountId,
  normalizeForwardTarget: normalizeSlackForwardTarget,
  resolveTurnSourceTarget: resolveTurnSourceSlackOriginTarget,
  targetsMatch: slackTargetsMatch,
});

const {
  canApprovalPotentiallyRouteToChannel: canApprovalPotentiallyRouteToSlack,
  isSessionApprovalEligible: isForwardedSlackSessionApprovalEligible,
  isExplicitTargetEligible: isForwardedSlackExplicitTargetEligible,
} = slackApprovalRouteGates;

function isSlackPluginNativeApprovalClientConfigEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const slackNativeConfig = resolveSlackNativeApprovalConfig(params);
  return isChannelExecApprovalClientEnabledFromConfig({
    enabled: slackNativeConfig?.enabled,
    approverCount: getSlackApprovalApprovers(params).length,
  });
}

function shouldHandleSlackViaNativeClientConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: SlackNativeApprovalRequest;
  approvalKind: ChannelApprovalKind;
}): boolean {
  if (
    !doesApprovalRequestSelectChannelAccount({
      ...params,
      channel: "slack",
      defaultAccountId: resolveDefaultSlackAccountId(params.cfg),
      eligibleAccountIds: listSlackNativeApprovalEligibleAccountIds(params),
    })
  ) {
    return false;
  }
  return isSlackNativeApprovalAccountEligible(params);
}

function isSlackNativeApprovalAccountEligible(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: SlackNativeApprovalRequest;
  approvalKind: ChannelApprovalKind;
}): boolean {
  const config = resolveSlackNativeApprovalConfig(params);
  const approverCount =
    params.approvalKind === "exec"
      ? getSlackExecApprovalApprovers(params).length
      : getSlackApprovalApproversForTeam({
          ...params,
          teamId: resolveEnterpriseApprovalTeamId(params.request),
        }).length;
  return (
    isSlackApprovalTransportEnabled(params) &&
    isChannelExecApprovalClientEnabledFromConfig({ enabled: config?.enabled, approverCount }) &&
    matchesApprovalRequestFilters({
      request: params.request.request,
      agentFilter: config?.agentFilter,
      sessionFilter: config?.sessionFilter,
    })
  );
}

function listSlackNativeApprovalEligibleAccountIds(
  params: Parameters<typeof isSlackNativeApprovalAccountEligible>[0],
): string[] {
  const accountId = params.accountId ?? resolveDefaultSlackAccountId(params.cfg);
  return isSlackNativeApprovalAccountEligible({ ...params, accountId }) ? [accountId] : [];
}

export function shouldHandleSlackPluginViaForwardingSession(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: SlackNativeApprovalRequest;
}): boolean {
  return isForwardedSlackSessionApprovalEligible({
    ...params,
    approvalKind: "plugin",
  });
}

export function isSlackAnyNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return (
    isSlackExecApprovalClientEnabled(params) ||
    isSlackPluginNativeApprovalClientConfigEnabled(params) ||
    canApprovalPotentiallyRouteToSlack({
      ...params,
      approvalKind: "plugin",
    })
  );
}

export function shouldHandleSlackNativeApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ChannelApprovalKind;
  request: SlackNativeApprovalRequest;
}): boolean {
  const account = resolveSlackAccount(params);
  if (
    getSlackInstallationKind(account.accountId) === "enterprise" &&
    !resolveEnterpriseApprovalTeamId(params.request)
  ) {
    return false;
  }
  const approvalKind = resolveApprovalKind(params.request, params.approvalKind);
  if (approvalKind === "plugin") {
    return (
      shouldHandleSlackViaNativeClientConfig({ ...params, approvalKind }) ||
      shouldHandleSlackPluginViaForwardingSession(params) ||
      (params.cfg.approvals?.plugin?.targets ?? []).some((target) =>
        isForwardedSlackExplicitTargetEligible({ ...params, approvalKind, target }),
      )
    );
  }
  const turnSourceChannel = normalizeMessageChannel(params.request.request.turnSourceChannel);
  if (turnSourceChannel && turnSourceChannel !== "slack") {
    return false;
  }
  return shouldHandleSlackViaNativeClientConfig({ ...params, approvalKind: "exec" });
}

export function resolveEnterpriseApprovalTeamId(
  request: SlackNativeApprovalRequest,
): string | undefined {
  try {
    const target = resolveTurnSourceSlackOriginTarget(request);
    return target ? parseSlackTarget(target.to)?.teamId : undefined;
  } catch {
    return undefined;
  }
}
