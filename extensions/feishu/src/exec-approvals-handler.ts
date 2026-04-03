import { buildPluginApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createChannelNativeApprovalRuntime,
  resolveExecApprovalCommandDisplay,
  type ExecApprovalChannelRuntime,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "openclaw/plugin-sdk/infra-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { feishuNativeApprovalAdapter } from "./approval-native.js";
import { createExecApprovalCard, createExecApprovalResolvedCard } from "./card-ux-exec-approval.js";
import {
  isFeishuExecApprovalHandlerConfigured,
  shouldHandleFeishuExecApprovalRequest,
} from "./exec-approvals.js";
import { sendCardFeishu, updateCardFeishu } from "./send.js";

const log = createSubsystemLogger("feishu/exec-approvals");

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;

type PendingMessage = {
  to: string;
  messageId: string;
};

type FeishuPendingDelivery = {
  card: Record<string, unknown>;
};

export type FeishuExecApprovalHandlerOpts = {
  accountId: string;
  cfg: OpenClawConfig;
  gatewayUrl?: string;
  runtime?: RuntimeEnv;
};

export class FeishuExecApprovalHandler {
  private readonly runtime: ExecApprovalChannelRuntime<ApprovalRequest, ApprovalResolved>;

  constructor(private readonly opts: FeishuExecApprovalHandlerOpts) {
    this.runtime = createChannelNativeApprovalRuntime<
      PendingMessage,
      { to: string },
      FeishuPendingDelivery,
      ApprovalRequest,
      ApprovalResolved
    >({
      label: "feishu/exec-approvals",
      clientDisplayName: `Feishu Exec Approvals (${this.opts.accountId})`,
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      gatewayUrl: this.opts.gatewayUrl,
      eventKinds: ["exec", "plugin"],
      nativeAdapter: feishuNativeApprovalAdapter.native,
      isConfigured: () =>
        isFeishuExecApprovalHandlerConfigured({
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
        }),
      shouldHandle: (request) =>
        shouldHandleFeishuExecApprovalRequest({
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
          request,
        }),
      buildPendingContent: ({ request, approvalKind, nowMs }) => {
        if (approvalKind === "plugin") {
          // For plugin approvals, fall back to text-based payload for now.
          const payload = buildPluginApprovalPendingReplyPayload({
            request: request as PluginApprovalRequest,
            nowMs,
          });
          return { card: buildFallbackTextCard(payload.text ?? "") };
        }
        const execRequest = request as ExecApprovalRequest;
        const commandDisplay = resolveExecApprovalCommandDisplay(execRequest.request);
        const host = execRequest.request.host ?? "gateway";
        const card = createExecApprovalCard({
          approvalId: request.id,
          command: commandDisplay.commandText,
          cwd: execRequest.request.cwd ?? undefined,
          host,
          nodeId: execRequest.request.nodeId ?? undefined,
          expiresAtMs: request.expiresAtMs,
        });
        return { card };
      },
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { to: plannedTarget.target.to },
      }),
      deliverTarget: async ({ preparedTarget, pendingContent }) => {
        const result = await sendCardFeishu({
          cfg: this.opts.cfg,
          to: preparedTarget.to,
          card: pendingContent.card,
          accountId: this.opts.accountId,
        });
        return {
          to: preparedTarget.to,
          messageId: result.messageId,
        };
      },
      onDeliveryError: ({ error, request }) => {
        log.error(`feishu exec approvals: failed to send request ${request.id}: ${String(error)}`);
      },
      finalizeResolved: async ({ request, resolved, entries }) => {
        await this.finalizeResolved(request, resolved, entries);
      },
      finalizeExpired: async ({ request, entries }) => {
        await this.finalizeExpired(request.id, entries);
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

  private async finalizeResolved(
    _request: ApprovalRequest,
    resolved: ApprovalResolved,
    messages: PendingMessage[],
  ): Promise<void> {
    await Promise.allSettled(
      messages.map(async (message) => {
        try {
          const resolvedCard = createExecApprovalResolvedCard({
            approvalId: resolved.id,
            decision: resolved.decision,
            resolvedBy: resolved.resolvedBy ?? undefined,
          });
          await updateCardFeishu({
            cfg: this.opts.cfg,
            messageId: message.messageId,
            card: resolvedCard,
            accountId: this.opts.accountId,
          });
        } catch (err) {
          log.error(
            `feishu exec approvals: failed to update card ${message.messageId}: ${String(err)}`,
          );
        }
      }),
    );
  }

  private async finalizeExpired(approvalId: string, messages: PendingMessage[]): Promise<void> {
    await Promise.allSettled(
      messages.map(async (message) => {
        try {
          const expiredCard = createExecApprovalResolvedCard({
            approvalId,
            decision: "expired",
          });
          await updateCardFeishu({
            cfg: this.opts.cfg,
            messageId: message.messageId,
            card: expiredCard,
            accountId: this.opts.accountId,
          });
        } catch (err) {
          log.error(
            `feishu exec approvals: failed to update expired card ${message.messageId}: ${String(err)}`,
          );
        }
      }),
    );
  }
}

function buildFallbackTextCard(text: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "审批请求" },
      template: "orange",
    },
    body: {
      elements: [{ tag: "markdown", content: text }],
    },
  };
}
