import {
  createChannelApprovalCapability,
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { getMatrixApprovalAuthApprovers, matrixApprovalAuth } from "./approval-auth.js";
import {
  getMatrixExecApprovalApprovers,
  isMatrixExecApprovalAuthorizedSender,
  isMatrixExecApprovalClientEnabled,
  resolveMatrixExecApprovalTarget,
  shouldHandleMatrixExecApprovalRequest,
} from "./exec-approvals.js";
import { listMatrixAccountIds } from "./matrix/accounts.js";
import { normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";
import { resolveMatrixTargetIdentity } from "./matrix/target-ids.js";
import type { CoreConfig } from "./types.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type MatrixOriginTarget = { to: string; threadId?: string };

function normalizeComparableTarget(value: string): string {
  const target = resolveMatrixTargetIdentity(value);
  if (!target) {
    return value.trim().toLowerCase();
  }
  if (target.kind === "user") {
    return `user:${normalizeMatrixUserId(target.id)}`;
  }
  return `${target.kind.toLowerCase()}:${target.id}`;
}

function resolveMatrixNativeTarget(raw: string): string | null {
  const target = resolveMatrixTargetIdentity(raw);
  if (!target) {
    return null;
  }
  return target.kind === "user" ? `user:${target.id}` : `room:${target.id}`;
}

function normalizeThreadId(value?: string | number | null): string | undefined {
  const trimmed = value == null ? "" : String(value).trim();
  return trimmed || undefined;
}

function resolveTurnSourceMatrixOriginTarget(request: ApprovalRequest): MatrixOriginTarget | null {
  const turnSourceChannel = request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const turnSourceTo = request.request.turnSourceTo?.trim() || "";
  const target = resolveMatrixNativeTarget(turnSourceTo);
  if (turnSourceChannel !== "matrix" || !target) {
    return null;
  }
  return {
    to: target,
    threadId: normalizeThreadId(request.request.turnSourceThreadId),
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
    threadId: normalizeThreadId(sessionTarget.threadId),
  };
}

function matrixTargetsMatch(a: MatrixOriginTarget, b: MatrixOriginTarget): boolean {
  return (
    normalizeComparableTarget(a.to) === normalizeComparableTarget(b.to) &&
    (a.threadId ?? "") === (b.threadId ?? "")
  );
}

const resolveMatrixOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "matrix",
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleMatrixExecApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveTurnSourceTarget: resolveTurnSourceMatrixOriginTarget,
  resolveSessionTarget: resolveSessionMatrixOriginTarget,
  targetsMatch: matrixTargetsMatch,
});

const resolveMatrixApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleMatrixExecApprovalRequest({
      cfg,
      accountId,
      request,
    }),
  resolveApprovers: getMatrixExecApprovalApprovers,
  mapApprover: (approver) => {
    const normalized = normalizeMatrixUserId(approver);
    return normalized ? { to: `user:${normalized}` } : null;
  },
});

const matrixNativeApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "matrix",
  channelLabel: "Matrix",
  listAccountIds: listMatrixAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    getMatrixExecApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isMatrixExecApprovalAuthorizedSender({ cfg, accountId, senderId }),
  isNativeDeliveryEnabled: ({ cfg, accountId }) =>
    isMatrixExecApprovalClientEnabled({ cfg, accountId }),
  resolveNativeDeliveryMode: ({ cfg, accountId }) =>
    resolveMatrixExecApprovalTarget({ cfg, accountId }),
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId: ({ target, request }) =>
    target.accountId?.trim() || request.request.turnSourceAccountId?.trim() || undefined,
  resolveOriginTarget: resolveMatrixOriginTarget,
  resolveApproverDmTargets: resolveMatrixApproverDmTargets,
});

const splitMatrixApprovalCapability = splitChannelApprovalCapability(
  matrixNativeApprovalCapability,
);
const matrixBaseNativeApprovalAdapter = splitMatrixApprovalCapability.native;
const matrixBaseDeliveryAdapter = splitMatrixApprovalCapability.delivery;
type MatrixForwardingSuppressionParams = Parameters<
  NonNullable<NonNullable<typeof matrixBaseDeliveryAdapter>["shouldSuppressForwardingFallback"]>
>[0];
const matrixDeliveryAdapter = matrixBaseDeliveryAdapter && {
  ...matrixBaseDeliveryAdapter,
  shouldSuppressForwardingFallback: (params: MatrixForwardingSuppressionParams) =>
    params.approvalKind === "plugin"
      ? false
      : (matrixBaseDeliveryAdapter.shouldSuppressForwardingFallback?.(params) ?? false),
};
const matrixExecOnlyNativeApprovalAdapter = matrixBaseNativeApprovalAdapter && {
  describeDeliveryCapabilities: (
    params: Parameters<typeof matrixBaseNativeApprovalAdapter.describeDeliveryCapabilities>[0],
  ) =>
    params.approvalKind === "plugin"
      ? {
          enabled: false,
          preferredSurface: "approver-dm" as const,
          supportsOriginSurface: false,
          supportsApproverDmSurface: false,
          notifyOriginWhenDmOnly: false,
        }
      : matrixBaseNativeApprovalAdapter.describeDeliveryCapabilities(params),
  resolveOriginTarget: async (
    params: Parameters<NonNullable<typeof matrixBaseNativeApprovalAdapter.resolveOriginTarget>>[0],
  ) =>
    params.approvalKind === "plugin"
      ? null
      : ((await matrixBaseNativeApprovalAdapter.resolveOriginTarget?.(params)) ?? null),
  resolveApproverDmTargets: async (
    params: Parameters<
      NonNullable<typeof matrixBaseNativeApprovalAdapter.resolveApproverDmTargets>
    >[0],
  ) =>
    params.approvalKind === "plugin"
      ? []
      : ((await matrixBaseNativeApprovalAdapter.resolveApproverDmTargets?.(params)) ?? []),
};

export const matrixApprovalCapability = createChannelApprovalCapability({
  authorizeActorAction: (params) =>
    params.approvalKind === "plugin"
      ? matrixApprovalAuth.authorizeActorAction(params)
      : (matrixNativeApprovalCapability.authorizeActorAction?.(params) ?? { authorized: true }),
  getActionAvailabilityState: (params) => {
    if (
      getMatrixApprovalAuthApprovers({
        cfg: params.cfg as CoreConfig,
        accountId: params.accountId,
      }).length > 0
    ) {
      return { kind: "enabled" } as const;
    }
    return (
      matrixNativeApprovalCapability.getActionAvailabilityState?.(params) ??
      ({ kind: "disabled" } as const)
    );
  },
  approvals: {
    delivery: matrixDeliveryAdapter,
    native: matrixExecOnlyNativeApprovalAdapter,
    render: matrixNativeApprovalCapability.render,
  },
});

export const matrixNativeApprovalAdapter = {
  auth: {
    authorizeActorAction: matrixApprovalCapability.authorizeActorAction,
    getActionAvailabilityState: matrixApprovalCapability.getActionAvailabilityState,
  },
  delivery: matrixDeliveryAdapter,
  render: matrixApprovalCapability.render,
  native: matrixExecOnlyNativeApprovalAdapter,
};
