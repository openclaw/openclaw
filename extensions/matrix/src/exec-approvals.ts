import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  createChannelExecApprovalProfileAsync,
  getExecApprovalReplyMetadata,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import { doesApprovalRequestSelectChannelAccountAsync } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { getMatrixApprovalAuthApprovers } from "./approval-auth.js";
import { normalizeMatrixApproverId } from "./approval-ids.js";
import {
  resolveDefaultMatrixAccountId,
  resolveMatrixAccountAsync,
  resolveMatrixAccountConfig,
} from "./matrix/accounts.js";
import type { CoreConfig } from "./types.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;
function normalizeMatrixExecApproverId(value: string | number): string | undefined {
  const normalized = normalizeMatrixApproverId(value);
  return normalized === "*" ? undefined : normalized;
}

function resolveMatrixExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  return resolveMatrixAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId ?? resolveDefaultMatrixAccountId(params.cfg),
  }).execApprovals;
}

function matchesMatrixApprovalConfig(
  params: Parameters<typeof shouldHandleMatrixApprovalRequest>[0],
): boolean {
  const config = resolveMatrixExecApprovalConfig(params);
  return (
    isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: getMatrixApprovalApprovers(params).length,
    }) &&
    matchesApprovalRequestFilters({
      request: params.request.request,
      agentFilter: config?.agentFilter,
      sessionFilter: config?.sessionFilter,
    })
  );
}

export function getMatrixExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveMatrixAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId ?? resolveDefaultMatrixAccountId(params.cfg),
  });
  return resolveApprovalApprovers({
    explicit: account.execApprovals?.approvers,
    allowFrom: account.dm?.allowFrom,
    normalizeApprover: normalizeMatrixExecApproverId,
  });
}

export function getMatrixApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
}): string[] {
  if (params.approvalKind === "plugin") {
    return getMatrixApprovalAuthApprovers({
      cfg: params.cfg as CoreConfig,
      accountId: params.accountId,
    });
  }
  return getMatrixExecApprovalApprovers(params);
}

const matrixExecApprovalProfile = createChannelExecApprovalProfileAsync({
  resolveConfig: resolveMatrixExecApprovalConfig,
  resolveApprovers: getMatrixExecApprovalApprovers,
  normalizeSenderId: normalizeMatrixApproverId,
  isTargetRecipient: (params) =>
    isChannelExecApprovalTargetRecipient({
      ...params,
      channel: "matrix",
      normalizeSenderId: normalizeMatrixApproverId,
      matchTarget: ({ target, normalizedSenderId }) =>
        normalizeMatrixApproverId(target.to) === normalizedSenderId,
    }),
});

export const isMatrixExecApprovalAuthorizedSender = matrixExecApprovalProfile.isAuthorizedSender;
export const resolveMatrixExecApprovalTarget = matrixExecApprovalProfile.resolveTarget;

export async function isMatrixApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
}): Promise<boolean> {
  const account = await resolveMatrixAccountAsync(params);
  if (!account.enabled || !account.configured) {
    return false;
  }
  const config = account.config.execApprovals;
  return isChannelExecApprovalClientEnabledFromConfig({
    enabled: config?.enabled,
    approverCount: getMatrixApprovalApprovers(params).length,
  });
}

export async function isMatrixAnyApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<boolean> {
  const account = await resolveMatrixAccountAsync(params);
  return (
    account.enabled &&
    account.configured &&
    isChannelExecApprovalClientEnabledFromConfig({
      enabled: account.config.execApprovals?.enabled,
      approverCount:
        getMatrixExecApprovalApprovers(params).length +
        getMatrixApprovalApprovers({
          ...params,
          approvalKind: "plugin",
        }).length,
    })
  );
}

export async function shouldHandleMatrixApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
  request: ApprovalRequest;
}): Promise<boolean> {
  if (
    params.approvalKind !== "exec" &&
    params.approvalKind !== "plugin" &&
    params.approvalKind !== "system-agent"
  ) {
    return false;
  }
  const accountId = params.accountId ?? resolveDefaultMatrixAccountId(params.cfg);
  const account = await resolveMatrixAccountAsync({ ...params, accountId });
  if (
    !(await doesApprovalRequestSelectChannelAccountAsync({
      ...params,
      channel: "matrix",
      defaultAccountId: resolveDefaultMatrixAccountId(params.cfg),
      eligibleAccountIds:
        account.enabled && account.configured && matchesMatrixApprovalConfig(params)
          ? [accountId]
          : [],
    }))
  ) {
    return false;
  }
  return matchesMatrixApprovalConfig(params);
}

export async function shouldSuppressLocalMatrixExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): Promise<boolean> {
  if (!matrixExecApprovalProfile.shouldSuppressLocalPrompt(params)) {
    return false;
  }
  const metadata = getExecApprovalReplyMetadata(params.payload);
  if (!metadata) {
    return false;
  }
  const request: ApprovalRequest =
    metadata.approvalKind === "plugin"
      ? {
          approvalKind: "plugin",
          id: metadata.approvalId,
          request: {
            title: "Plugin Approval Required",
            description: "",
            agentId: metadata.agentId ?? null,
            sessionKey: metadata.sessionKey ?? null,
          },
          createdAtMs: 0,
          expiresAtMs: 0,
        }
      : {
          approvalKind: "exec",
          id: metadata.approvalId,
          request: {
            command: "",
            agentId: metadata.agentId ?? null,
            sessionKey: metadata.sessionKey ?? null,
          },
          createdAtMs: 0,
          expiresAtMs: 0,
        };
  return shouldHandleMatrixApprovalRequest({
    cfg: params.cfg,
    accountId: params.accountId,
    approvalKind: metadata.approvalKind,
    request,
  });
}
