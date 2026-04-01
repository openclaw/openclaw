import {
  buildExecApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  buildPluginApprovalResolvedMessage,
  getExecApprovalApproverDmNoticeText,
  resolveExecApprovalCommandDisplay,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createChannelNativeApprovalRuntime,
  type ExecApprovalChannelRuntime,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
} from "openclaw/plugin-sdk/infra-runtime";
import type {
  PluginApprovalRequest,
  PluginApprovalResolved,
} from "openclaw/plugin-sdk/infra-runtime";
import { matrixNativeApprovalAdapter } from "./approval-native.js";
import {
  isMatrixExecApprovalClientEnabled,
  shouldHandleMatrixExecApprovalRequest,
} from "./exec-approvals.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { deleteMatrixMessage, editMatrixMessage } from "./matrix/actions/messages.js";
import { repairMatrixDirectRooms } from "./matrix/direct-management.js";
import type { MatrixClient } from "./matrix/sdk.js";
import { sendMessageMatrix } from "./matrix/send.js";
import { resolveMatrixTargetIdentity } from "./matrix/target-ids.js";
import type { CoreConfig } from "./types.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
type ApprovalKind = "exec" | "plugin";
type PendingMessage = {
  roomId: string;
  messageId: string;
};

type PreparedMatrixTarget = {
  to: string;
  roomId: string;
  threadId?: string;
};

export type MatrixExecApprovalHandlerOpts = {
  client: MatrixClient;
  accountId: string;
  cfg: OpenClawConfig;
  gatewayUrl?: string;
};

export type MatrixExecApprovalHandlerDeps = {
  nowMs?: () => number;
  sendMessage?: typeof sendMessageMatrix;
  editMessage?: typeof editMatrixMessage;
  deleteMessage?: typeof deleteMatrixMessage;
  repairDirectRooms?: typeof repairMatrixDirectRooms;
};

function isHandlerConfigured(params: { cfg: OpenClawConfig; accountId: string }): boolean {
  return isMatrixExecApprovalClientEnabled(params);
}

function normalizeThreadId(value?: string | number | null): string | undefined {
  const trimmed = value == null ? "" : String(value).trim();
  return trimmed || undefined;
}

function resolveApprovalKind(request: ApprovalRequest): ApprovalKind {
  return request.id.startsWith("plugin:") ? "plugin" : "exec";
}

function buildPendingApprovalText(params: { request: ApprovalRequest; nowMs: number }): string {
  if (resolveApprovalKind(params.request) === "plugin") {
    return buildPluginApprovalPendingReplyPayload({
      request: params.request as PluginApprovalRequest,
      nowMs: params.nowMs,
    }).text!;
  }
  return buildExecApprovalPendingReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    approvalCommandId: params.request.id,
    command: resolveExecApprovalCommandDisplay((params.request as ExecApprovalRequest).request)
      .commandText,
    cwd: (params.request as ExecApprovalRequest).request.cwd ?? undefined,
    host: (params.request as ExecApprovalRequest).request.host === "node" ? "node" : "gateway",
    nodeId: (params.request as ExecApprovalRequest).request.nodeId ?? undefined,
    expiresAtMs: params.request.expiresAtMs,
    nowMs: params.nowMs,
  }).text!;
}

function buildResolvedApprovalText(params: {
  request: ApprovalRequest;
  resolved: ApprovalResolved;
}): string {
  if (resolveApprovalKind(params.request) === "plugin") {
    return buildPluginApprovalResolvedMessage(params.resolved as PluginApprovalResolved);
  }
  const command = resolveExecApprovalCommandDisplay(
    (params.request as ExecApprovalRequest).request,
  ).commandText;
  const decisionLabel =
    params.resolved.decision === "allow-once"
      ? "Allowed once"
      : params.resolved.decision === "allow-always"
        ? "Allowed always"
        : "Denied";
  return [`Exec approval: ${decisionLabel}`, "", "Command", "```", command, "```"].join("\n");
}

export class MatrixExecApprovalHandler {
  private readonly runtime: ExecApprovalChannelRuntime<ApprovalRequest, ApprovalResolved>;
  private readonly nowMs: () => number;
  private readonly sendMessage: typeof sendMessageMatrix;
  private readonly editMessage: typeof editMatrixMessage;
  private readonly deleteMessage: typeof deleteMatrixMessage;
  private readonly repairDirectRooms: typeof repairMatrixDirectRooms;

  constructor(
    private readonly opts: MatrixExecApprovalHandlerOpts,
    deps: MatrixExecApprovalHandlerDeps = {},
  ) {
    this.nowMs = deps.nowMs ?? Date.now;
    this.sendMessage = deps.sendMessage ?? sendMessageMatrix;
    this.editMessage = deps.editMessage ?? editMatrixMessage;
    this.deleteMessage = deps.deleteMessage ?? deleteMatrixMessage;
    this.repairDirectRooms = deps.repairDirectRooms ?? repairMatrixDirectRooms;
    this.runtime = createChannelNativeApprovalRuntime<
      PendingMessage,
      PreparedMatrixTarget,
      string,
      ApprovalRequest,
      ApprovalResolved
    >({
      label: "matrix/exec-approvals",
      clientDisplayName: `Matrix Exec Approvals (${this.opts.accountId})`,
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      gatewayUrl: this.opts.gatewayUrl,
      eventKinds: ["exec", "plugin"],
      nowMs: this.nowMs,
      nativeAdapter: matrixNativeApprovalAdapter.native,
      isConfigured: () =>
        isHandlerConfigured({ cfg: this.opts.cfg, accountId: this.opts.accountId }),
      shouldHandle: (request) =>
        shouldHandleMatrixExecApprovalRequest({
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
          request,
        }),
      buildPendingContent: ({ request, nowMs }) =>
        buildPendingApprovalText({
          request,
          nowMs,
        }),
      sendOriginNotice: async ({ originTarget }) => {
        const preparedTarget = await this.prepareTarget(originTarget);
        if (!preparedTarget) {
          return;
        }
        await this.sendMessage(preparedTarget.to, getExecApprovalApproverDmNoticeText(), {
          cfg: this.opts.cfg as CoreConfig,
          accountId: this.opts.accountId,
          client: this.opts.client,
          threadId: preparedTarget.threadId,
        });
      },
      prepareTarget: async ({ plannedTarget }) => {
        const preparedTarget = await this.prepareTarget(plannedTarget.target);
        if (!preparedTarget) {
          return null;
        }
        return {
          dedupeKey: `${preparedTarget.roomId}:${preparedTarget.threadId ?? ""}`,
          target: preparedTarget,
        };
      },
      deliverTarget: async ({ preparedTarget, pendingContent }) => {
        const result = await this.sendMessage(preparedTarget.to, pendingContent, {
          cfg: this.opts.cfg as CoreConfig,
          accountId: this.opts.accountId,
          client: this.opts.client,
          threadId: preparedTarget.threadId,
        });
        return {
          roomId: result.roomId,
          messageId: result.messageId,
        };
      },
      finalizeResolved: async ({ request, resolved, entries }) => {
        await this.finalizeResolved(request, resolved, entries);
      },
      finalizeExpired: async ({ entries }) => {
        await this.clearPending(entries);
      },
    });
  }

  async start(): Promise<void> {
    await this.runtime.start();
  }

  async stop(): Promise<void> {
    await this.runtime.stop();
  }

  async handleRequested(request: ApprovalRequest): Promise<void> {
    await this.runtime.handleRequested(request);
  }

  async handleResolved(resolved: ApprovalResolved): Promise<void> {
    await this.runtime.handleResolved(resolved);
  }

  private async prepareTarget(rawTarget: {
    to: string;
    threadId?: string | number | null;
  }): Promise<PreparedMatrixTarget | null> {
    const target = resolveMatrixTargetIdentity(rawTarget.to);
    if (!target) {
      return null;
    }
    const threadId = normalizeThreadId(rawTarget.threadId);
    if (target.kind === "user") {
      const account = resolveMatrixAccount({
        cfg: this.opts.cfg as CoreConfig,
        accountId: this.opts.accountId,
      });
      const repaired = await this.repairDirectRooms({
        client: this.opts.client,
        remoteUserId: target.id,
        encrypted: account.config.encryption === true,
      });
      if (!repaired.activeRoomId) {
        return null;
      }
      return {
        to: `room:${repaired.activeRoomId}`,
        roomId: repaired.activeRoomId,
        threadId,
      };
    }
    return {
      to: `room:${target.id}`,
      roomId: target.id,
      threadId,
    };
  }

  private async finalizeResolved(
    request: ApprovalRequest,
    resolved: ApprovalResolved,
    entries: PendingMessage[],
  ): Promise<void> {
    const text = buildResolvedApprovalText({ request, resolved });
    await Promise.allSettled(
      entries.map(async (entry) => {
        await this.editMessage(entry.roomId, entry.messageId, text, {
          cfg: this.opts.cfg as CoreConfig,
          accountId: this.opts.accountId,
          client: this.opts.client,
        });
      }),
    );
  }

  private async clearPending(entries: PendingMessage[]): Promise<void> {
    await Promise.allSettled(
      entries.map(async (entry) => {
        await this.deleteMessage(entry.roomId, entry.messageId, {
          cfg: this.opts.cfg as CoreConfig,
          accountId: this.opts.accountId,
          client: this.opts.client,
          reason: "approval expired",
        });
      }),
    );
  }
}
