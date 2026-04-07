import {
  buildExecApprovalPendingReplyPayload,
  type ExecApprovalReplyDecision,
  getExecApprovalApproverDmNoticeText,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalCommandDisplay,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createChannelNativeApprovalRuntime,
  type ExecApprovalChannelRuntime,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
} from "openclaw/plugin-sdk/infra-runtime";
import { normalizeOptionalStringifiedId } from "openclaw/plugin-sdk/text-runtime";
import { matrixNativeApprovalAdapter } from "./approval-native.js";
import {
  buildMatrixApprovalReactionHint,
  listMatrixApprovalReactionBindings,
  registerMatrixApprovalReactionTarget,
  unregisterMatrixApprovalReactionTarget,
} from "./approval-reactions.js";
import {
  isMatrixExecApprovalClientEnabled,
  shouldHandleMatrixExecApprovalRequest,
} from "./exec-approvals.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { deleteMatrixMessage, editMatrixMessage } from "./matrix/actions/messages.js";
import { repairMatrixDirectRooms } from "./matrix/direct-management.js";
import type { MatrixClient } from "./matrix/sdk.js";
import { reactMatrixMessage, sendMessageMatrix } from "./matrix/send.js";
import { resolveMatrixTargetIdentity } from "./matrix/target-ids.js";
import type { CoreConfig } from "./types.js";

type ApprovalRequest = ExecApprovalRequest;
type ApprovalResolved = ExecApprovalResolved;
type PendingMessage = {
  roomId: string;
  messageIds: readonly string[];
  reactionEventId: string;
};

type PreparedMatrixTarget = {
  to: string;
  roomId: string;
  threadId?: string;
};
type PendingApprovalContent = {
  approvalId: string;
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};
type ReactionTargetRef = {
  roomId: string;
  eventId: string;
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
  reactMessage?: typeof reactMatrixMessage;
  editMessage?: typeof editMatrixMessage;
  deleteMessage?: typeof deleteMatrixMessage;
  repairDirectRooms?: typeof repairMatrixDirectRooms;
};

function normalizePendingMessageIds(entry: PendingMessage): string[] {
  return Array.from(new Set(entry.messageIds.map((messageId) => messageId.trim()).filter(Boolean)));
}

function normalizeReactionTargetRef(params: ReactionTargetRef): ReactionTargetRef | null {
  const roomId = params.roomId.trim();
  const eventId = params.eventId.trim();
  if (!roomId || !eventId) {
    return null;
  }
  return { roomId, eventId };
}

function buildReactionTargetRefKey(params: ReactionTargetRef): string | null {
  const normalized = normalizeReactionTargetRef(params);
  if (!normalized) {
    return null;
  }
  return `${normalized.roomId}\u0000${normalized.eventId}`;
}

function isHandlerConfigured(params: { cfg: OpenClawConfig; accountId: string }): boolean {
  return isMatrixExecApprovalClientEnabled(params);
}

function buildPendingApprovalContent(params: {
  request: ApprovalRequest;
  nowMs: number;
}): PendingApprovalContent {
  const allowedDecisions =
    params.request.request.allowedDecisions ??
    resolveExecApprovalAllowedDecisions({ ask: params.request.request.ask ?? undefined });
  const payload = buildExecApprovalPendingReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    approvalCommandId: params.request.id,
    ask: params.request.request.ask ?? undefined,
    agentId: params.request.request.agentId ?? undefined,
    allowedDecisions,
    command: resolveExecApprovalCommandDisplay(params.request.request).commandText,
    cwd: params.request.request.cwd ?? undefined,
    host: params.request.request.host === "node" ? "node" : "gateway",
    nodeId: params.request.request.nodeId ?? undefined,
    sessionKey: params.request.request.sessionKey ?? undefined,
    expiresAtMs: params.request.expiresAtMs,
    nowMs: params.nowMs,
  });
  const hint = buildMatrixApprovalReactionHint(allowedDecisions);
  const text = payload.text ?? "";
  return {
    approvalId: params.request.id,
    // Reactions are anchored to the first Matrix event for a chunked send, so keep
    // the reaction hint at the start of the message where that anchor always lives.
    text: hint ? (text ? `${hint}\n\n${text}` : hint) : text,
    allowedDecisions,
  };
}

function buildResolvedApprovalText(params: {
  request: ApprovalRequest;
  resolved: ApprovalResolved;
}): string {
  const command = resolveExecApprovalCommandDisplay(params.request.request).commandText;
  const decisionLabel =
    params.resolved.decision === "allow-once"
      ? "Allowed once"
      : params.resolved.decision === "allow-always"
        ? "Allowed always"
        : "Denied";
  return [`Exec approval: ${decisionLabel}`, "", "Command", "```", command, "```"].join("\n");
}

export class MatrixExecApprovalHandler {
  private readonly runtime: ExecApprovalChannelRuntime;
  private readonly trackedReactionTargets = new Map<string, ReactionTargetRef>();
  private readonly nowMs: () => number;
  private readonly sendMessage: typeof sendMessageMatrix;
  private readonly reactMessage: typeof reactMatrixMessage;
  private readonly editMessage: typeof editMatrixMessage;
  private readonly deleteMessage: typeof deleteMatrixMessage;
  private readonly repairDirectRooms: typeof repairMatrixDirectRooms;

  constructor(
    private readonly opts: MatrixExecApprovalHandlerOpts,
    deps: MatrixExecApprovalHandlerDeps = {},
  ) {
    this.nowMs = deps.nowMs ?? Date.now;
    this.sendMessage = deps.sendMessage ?? sendMessageMatrix;
    this.reactMessage = deps.reactMessage ?? reactMatrixMessage;
    this.editMessage = deps.editMessage ?? editMatrixMessage;
    this.deleteMessage = deps.deleteMessage ?? deleteMatrixMessage;
    this.repairDirectRooms = deps.repairDirectRooms ?? repairMatrixDirectRooms;
    this.runtime = createChannelNativeApprovalRuntime<
      PendingMessage,
      PreparedMatrixTarget,
      PendingApprovalContent,
      ApprovalRequest,
      ApprovalResolved
    >({
      label: "matrix/exec-approvals",
      clientDisplayName: `Matrix Exec Approvals (${this.opts.accountId})`,
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      gatewayUrl: this.opts.gatewayUrl,
      eventKinds: ["exec"],
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
        buildPendingApprovalContent({
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
        const result = await this.sendMessage(preparedTarget.to, pendingContent.text, {
          cfg: this.opts.cfg as CoreConfig,
          accountId: this.opts.accountId,
          client: this.opts.client,
          threadId: preparedTarget.threadId,
        });
        const messageIds = Array.from(
          new Set(
            (result.messageIds ?? [result.messageId])
              .map((messageId) => messageId.trim())
              .filter(Boolean),
          ),
        );
        const reactionEventId =
          result.primaryMessageId?.trim() || messageIds[0] || result.messageId.trim();
        this.trackReactionTarget({
          roomId: result.roomId,
          eventId: reactionEventId,
          approvalId: pendingContent.approvalId,
          allowedDecisions: pendingContent.allowedDecisions,
        });
        await Promise.allSettled(
          listMatrixApprovalReactionBindings(pendingContent.allowedDecisions).map(
            async ({ emoji }) => {
              await this.reactMessage(result.roomId, reactionEventId, emoji, {
                cfg: this.opts.cfg as CoreConfig,
                accountId: this.opts.accountId,
                client: this.opts.client,
              });
            },
          ),
        );
        return {
          roomId: result.roomId,
          messageIds,
          reactionEventId,
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
    this.clearTrackedReactionTargets();
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
    const threadId = normalizeOptionalStringifiedId(rawTarget.threadId);
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
        this.untrackReactionTarget({
          roomId: entry.roomId,
          eventId: entry.reactionEventId,
        });
        const [primaryMessageId, ...staleMessageIds] = normalizePendingMessageIds(entry);
        if (!primaryMessageId) {
          return;
        }
        await Promise.allSettled([
          this.editMessage(entry.roomId, primaryMessageId, text, {
            cfg: this.opts.cfg as CoreConfig,
            accountId: this.opts.accountId,
            client: this.opts.client,
          }),
          ...staleMessageIds.map(async (messageId) => {
            await this.deleteMessage(entry.roomId, messageId, {
              cfg: this.opts.cfg as CoreConfig,
              accountId: this.opts.accountId,
              client: this.opts.client,
              reason: "approval resolved",
            });
          }),
        ]);
      }),
    );
  }

  private async clearPending(entries: PendingMessage[]): Promise<void> {
    await Promise.allSettled(
      entries.map(async (entry) => {
        this.untrackReactionTarget({
          roomId: entry.roomId,
          eventId: entry.reactionEventId,
        });
        await Promise.allSettled(
          normalizePendingMessageIds(entry).map(async (messageId) => {
            await this.deleteMessage(entry.roomId, messageId, {
              cfg: this.opts.cfg as CoreConfig,
              accountId: this.opts.accountId,
              client: this.opts.client,
              reason: "approval expired",
            });
          }),
        );
      }),
    );
  }

  private trackReactionTarget(
    params: ReactionTargetRef & {
      approvalId: string;
      allowedDecisions: readonly ExecApprovalReplyDecision[];
    },
  ): void {
    const normalized = normalizeReactionTargetRef(params);
    const key = normalized ? buildReactionTargetRefKey(normalized) : null;
    if (!normalized || !key) {
      return;
    }
    registerMatrixApprovalReactionTarget({
      roomId: normalized.roomId,
      eventId: normalized.eventId,
      approvalId: params.approvalId,
      allowedDecisions: params.allowedDecisions,
    });
    this.trackedReactionTargets.set(key, normalized);
  }

  private untrackReactionTarget(params: ReactionTargetRef): void {
    const normalized = normalizeReactionTargetRef(params);
    const key = normalized ? buildReactionTargetRefKey(normalized) : null;
    if (!normalized || !key) {
      return;
    }
    unregisterMatrixApprovalReactionTarget(normalized);
    this.trackedReactionTargets.delete(key);
  }

  private clearTrackedReactionTargets(): void {
    for (const target of this.trackedReactionTargets.values()) {
      unregisterMatrixApprovalReactionTarget(target);
    }
    this.trackedReactionTargets.clear();
  }
}
