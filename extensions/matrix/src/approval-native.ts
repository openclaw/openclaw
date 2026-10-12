import {
  createChannelApprovalCapability,
  createApproverRestrictedNativeApprovalCapabilityAsync,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapterAsync } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelNativeOriginTargetResolver,
  resolveApprovalRequestSessionConversation,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMatrixApprovalAuthApprovers, matrixApprovalAuth } from "./approval-auth.js";
import { isMatrixApprovalReactionAuthorizedSender } from "./approval-reaction-auth.js";
import {
  getMatrixApprovalApprovers,
  getMatrixExecApprovalApprovers,
  isMatrixAnyApprovalClientEnabled,
  isMatrixApprovalClientEnabled,
  isMatrixExecApprovalAuthorizedSender,
  resolveMatrixExecApprovalTarget,
  shouldHandleMatrixApprovalRequest,
} from "./exec-approvals.js";
import { listMatrixAccountIds } from "./matrix/accounts.js";
import { normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";
import { resolveMatrixTargetIdentity } from "./matrix/target-ids.js";
import type { CoreConfig } from "./types.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;
type MatrixOriginTarget = { to: string; threadId?: string };

function normalizeComparableTarget(value: string): string {
  const target = resolveMatrixTargetIdentity(value);
  if (!target) {
    return normalizeLowercaseStringOrEmpty(value);
  }
  if (target.kind === "user") {
    return `user:${normalizeMatrixUserId(target.id)}`;
  }
  return `${normalizeLowercaseStringOrEmpty(target.kind)}:${target.id}`;
}

function resolveMatrixNativeTarget(raw: string): string | null {
  const target = resolveMatrixTargetIdentity(raw);
  if (!target) {
    return null;
  }
  return target.kind === "user" ? `user:${target.id}` : `room:${target.id}`;
}

function resolveTurnSourceMatrixOriginTarget(request: ApprovalRequest): MatrixOriginTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  const turnSourceTo = request.request.turnSourceTo?.trim() || "";
  const target = resolveMatrixNativeTarget(turnSourceTo);
  if (turnSourceChannel !== "matrix" || !target) {
    return null;
  }
  return {
    to: target,
    threadId: normalizeOptionalStringifiedId(request.request.turnSourceThreadId),
  };
}

function resolveSessionMatrixOriginTarget(sessionTarget: {
  to: string;
  threadId?: string | number | null;
}): MatrixOriginTarget | null {
  const target = resolveMatrixNativeTarget(sessionTarget.to);
  if (!target) {
    return null;
  }
  return {
    to: target,
    threadId: normalizeOptionalStringifiedId(sessionTarget.threadId),
  };
}

function normalizeMatrixOriginTarget(target: MatrixOriginTarget): MatrixOriginTarget {
  return {
    ...target,
    to: normalizeComparableTarget(target.to),
  };
}

function hasMatrixPluginApprovers(params: { cfg: CoreConfig; accountId?: string | null }): boolean {
  return getMatrixApprovalAuthApprovers(params).length > 0;
}

function availabilityState(enabled: boolean) {
  return enabled ? ({ kind: "enabled" } as const) : ({ kind: "disabled" } as const);
}

function hasMatrixApprovalApprovers(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
}): boolean {
  return getMatrixApprovalApprovers(params).length > 0;
}

function hasAnyMatrixApprovalApprovers(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): boolean {
  return (
    getMatrixExecApprovalApprovers(params).length > 0 ||
    getMatrixApprovalAuthApprovers(params).length > 0
  );
}

function resolveSuppressionAccountId(params: {
  target: { accountId?: string | null };
  request: { request: { turnSourceAccountId?: string | null } };
}): string | undefined {
  return (
    params.target.accountId?.trim() ||
    params.request.request.turnSourceAccountId?.trim() ||
    undefined
  );
}

const resolveMatrixOriginTargetBase = createChannelNativeOriginTargetResolver({
  channel: "matrix",
  resolveTurnSourceTarget: resolveTurnSourceMatrixOriginTarget,
  resolveSessionTarget: resolveSessionMatrixOriginTarget,
  normalizeTargetForMatch: normalizeMatrixOriginTarget,
  resolveFallbackTarget: (request) => {
    const sessionConversation = resolveApprovalRequestSessionConversation({
      request,
      channel: "matrix",
    });
    if (!sessionConversation) {
      return null;
    }
    return resolveSessionMatrixOriginTarget({
      to: sessionConversation.id,
      threadId: sessionConversation.threadId,
    });
  },
});

async function resolveMatrixOriginTarget(
  params: Parameters<typeof resolveMatrixOriginTargetBase>[0],
) {
  const approvalKind = params.approvalKind;
  if (!approvalKind) {
    return null;
  }
  return (await shouldHandleMatrixApprovalRequest({ ...params, approvalKind }))
    ? resolveMatrixOriginTargetBase(params)
    : null;
}

async function resolveMatrixApproverDmTargets(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
  request: ApprovalRequest;
}): Promise<{ to: string }[]> {
  if (!(await shouldHandleMatrixApprovalRequest(params))) {
    return [];
  }
  return getMatrixApprovalApprovers(params)
    .map((approver) => {
      const normalized = normalizeMatrixUserId(approver);
      return normalized ? { to: `user:${normalized}` } : null;
    })
    .filter((target): target is { to: string } => target !== null);
}

const matrixNativeApprovalCapability = createApproverRestrictedNativeApprovalCapabilityAsync({
  channel: "matrix",
  channelLabel: "Matrix",
  describeExecApprovalSetup: ({
    accountId,
  }: Parameters<NonNullable<ChannelApprovalCapability["describeExecApprovalSetup"]>>[0]) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.matrix.accounts.${accountId}`
        : "channels.matrix";
    return `Approve it from the Web UI for now. Matrix supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`${prefix}.dm.allowFrom\`; leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
  },
  listAccountIds: listMatrixAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    hasAnyMatrixApprovalApprovers({
      cfg: cfg as CoreConfig,
      accountId,
    }),
  isExecAuthorizedSender: isMatrixExecApprovalAuthorizedSender,
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isMatrixApprovalReactionAuthorizedSender({
      cfg: cfg as CoreConfig,
      accountId,
      senderId,
      approvalKind: "plugin",
    }),
  isNativeDeliveryEnabled: ({ approvalKind, ...params }) =>
    isMatrixApprovalClientEnabled({ ...params, approvalKind: approvalKind ?? "exec" }),
  resolveNativeDeliveryMode: resolveMatrixExecApprovalTarget,
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId,
  resolveOriginTarget: resolveMatrixOriginTarget,
  resolveApproverDmTargets: resolveMatrixApproverDmTargets,
  notifyOriginWhenDmOnly: true,
  nativeRuntimeAsync: createLazyChannelApprovalNativeRuntimeAdapterAsync({
    capabilityBoundary: true,
    eventKinds: ["exec", "plugin", "system-agent"],
    isConfigured: isMatrixAnyApprovalClientEnabled,
    shouldHandle: shouldHandleMatrixApprovalRequest,
    load: async () => (await import("./approval-handler.runtime.js")).matrixApprovalNativeRuntime,
  }),
});

const splitMatrixApprovalCapability = splitChannelApprovalCapability(
  matrixNativeApprovalCapability,
);
const matrixBaseNativeApprovalAdapter = splitMatrixApprovalCapability.nativeAsync;
const matrixBaseDeliveryAdapter = splitMatrixApprovalCapability.delivery;
type MatrixForwardingSuppressionParams = Parameters<
  NonNullable<
    NonNullable<typeof matrixBaseDeliveryAdapter>["shouldSuppressForwardingFallbackAsync"]
  >
>[0];
const matrixDeliveryAdapter = matrixBaseDeliveryAdapter && {
  ...matrixBaseDeliveryAdapter,
  shouldSuppressForwardingFallbackAsync: async (params: MatrixForwardingSuppressionParams) => {
    const accountId = resolveSuppressionAccountId(params);
    if (
      !hasMatrixApprovalApprovers({
        cfg: params.cfg as CoreConfig,
        accountId,
        approvalKind: params.approvalKind,
      })
    ) {
      return false;
    }
    if (params.approvalKind === "plugin") {
      const targetChannel = normalizeLowercaseStringOrEmpty(params.target.channel);
      const turnSourceChannel = normalizeLowercaseStringOrEmpty(
        params.request.request.turnSourceChannel,
      );
      return (
        targetChannel === "matrix" &&
        turnSourceChannel === "matrix" &&
        (await shouldHandleMatrixApprovalRequest({
          cfg: params.cfg,
          accountId,
          approvalKind: "plugin",
          request: params.request,
        }))
      );
    }
    return matrixBaseDeliveryAdapter.shouldSuppressForwardingFallbackAsync?.(params) ?? false;
  },
};

export const matrixApprovalCapability = createChannelApprovalCapability({
  authorizeActorAction: (
    params: Parameters<NonNullable<ChannelApprovalCapability["authorizeActorAction"]>>[0],
  ) => {
    if (params.approvalKind !== "plugin") {
      return matrixNativeApprovalCapability.authorizeActorAction?.(params) ?? { authorized: true };
    }
    if (
      !hasMatrixPluginApprovers({
        cfg: params.cfg as CoreConfig,
        accountId: params.accountId,
      })
    ) {
      return {
        authorized: false,
        reason: "❌ Matrix plugin approvals are not enabled for this bot account.",
      } as const;
    }
    return matrixApprovalAuth.authorizeActorAction(params);
  },
  getActionAvailabilityState: (
    params: Parameters<NonNullable<ChannelApprovalCapability["getActionAvailabilityState"]>>[0],
  ) => {
    if (params.approvalKind === "plugin") {
      return availabilityState(
        hasMatrixPluginApprovers({
          cfg: params.cfg as CoreConfig,
          accountId: params.accountId,
        }),
      );
    }
    return (
      matrixNativeApprovalCapability.getActionAvailabilityState?.(params) ?? {
        kind: "disabled",
      }
    );
  },
  getExecInitiatingSurfaceStateAsync: async (
    params: Parameters<
      NonNullable<ChannelApprovalCapability["getExecInitiatingSurfaceStateAsync"]>
    >[0],
  ) =>
    (await matrixNativeApprovalCapability.getExecInitiatingSurfaceStateAsync?.(params)) ??
    ({ kind: "disabled" } as const),
  describeExecApprovalSetup: matrixNativeApprovalCapability.describeExecApprovalSetup,
  delivery: matrixDeliveryAdapter,
  nativeRuntimeAsync: matrixNativeApprovalCapability.nativeRuntimeAsync,
  nativeAsync: matrixBaseNativeApprovalAdapter,
  render: matrixNativeApprovalCapability.render,
});
