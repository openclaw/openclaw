import { buildPluginApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createChannelNativeApprovalRuntime,
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalChannelRuntime,
} from "openclaw/plugin-sdk/infra-runtime";
import { resolveExecApprovalCommandDisplay } from "openclaw/plugin-sdk/infra-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  type ExecApprovalPendingReplyParams,
} from "openclaw/plugin-sdk/infra-runtime";
import type {
  ExecApprovalRequest,
  ExecApprovalResolved,
  PluginApprovalRequest,
  PluginApprovalResolved,
} from "openclaw/plugin-sdk/infra-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { telegramNativeApprovalAdapter } from "./approval-native.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import {
  getTelegramExecApprovalApprovers,
  resolveTelegramExecApprovalConfig,
  shouldHandleTelegramExecApprovalRequest,
} from "./exec-approvals.js";
import { editMessageReplyMarkupTelegram, sendMessageTelegram, sendTypingTelegram } from "./send.js";

const log = createSubsystemLogger("telegram/exec-approvals");

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
type PendingMessage = {
  chatId: string;
  messageId: string;
};
type TelegramPendingDelivery = {
  text: string;
  buttons: ReturnType<typeof resolveTelegramInlineButtons>;
};

export type TelegramExecApprovalHandlerOpts = {
  token: string;
  accountId: string;
  cfg: OpenClawConfig;
  gatewayUrl?: string;
  runtime?: RuntimeEnv;
};

export type TelegramExecApprovalHandlerDeps = {
  nowMs?: () => number;
  sendTyping?: typeof sendTypingTelegram;
  sendMessage?: typeof sendMessageTelegram;
  editReplyMarkup?: typeof editMessageReplyMarkupTelegram;
};

function isHandlerConfigured(params: { cfg: OpenClawConfig; accountId: string }): boolean {
  const config = resolveTelegramExecApprovalConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!config?.enabled) {
    return false;
  }
  return (
    getTelegramExecApprovalApprovers({
      cfg: params.cfg,
      accountId: params.accountId,
    }).length > 0
  );
}

export class TelegramExecApprovalHandler {
  private readonly runtime: ExecApprovalChannelRuntime<ApprovalRequest, ApprovalResolved>;
  private readonly nowMs: () => number;
  private readonly sendTyping: typeof sendTypingTelegram;
  private readonly sendMessage: typeof sendMessageTelegram;
  private readonly editReplyMarkup: typeof editMessageReplyMarkupTelegram;

  constructor(
    private readonly opts: TelegramExecApprovalHandlerOpts,
    deps: TelegramExecApprovalHandlerDeps = {},
  ) {
    this.nowMs = deps.nowMs ?? Date.now;
    this.sendTyping = deps.sendTyping ?? sendTypingTelegram;
    this.sendMessage = deps.sendMessage ?? sendMessageTelegram;
    this.editReplyMarkup = deps.editReplyMarkup ?? editMessageReplyMarkupTelegram;
    this.runtime = createChannelNativeApprovalRuntime<
      PendingMessage,
      { chatId: string; messageThreadId?: number },
      TelegramPendingDelivery,
      ApprovalRequest,
      ApprovalResolved
    >({
      label: "telegram/exec-approvals",
      clientDisplayName: `Telegram Exec Approvals (${this.opts.accountId})`,
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      gatewayUrl: this.opts.gatewayUrl,
      eventKinds: ["exec", "plugin"],
      nowMs: this.nowMs,
      nativeAdapter: telegramNativeApprovalAdapter.native,
      isConfigured: () =>
        isHandlerConfigured({ cfg: this.opts.cfg, accountId: this.opts.accountId }),
      shouldHandle: (request) =>
        shouldHandleTelegramExecApprovalRequest({
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
          request,
        }),
      buildPendingContent: ({ request, approvalKind, nowMs }) => {
        const payload =
          approvalKind === "plugin"
            ? buildPluginApprovalPendingReplyPayload({
                request: request as PluginApprovalRequest,
                nowMs,
              })
            : buildExecApprovalPendingReplyPayload({
                approvalId: request.id,
                approvalSlug: request.id.slice(0, 8),
                approvalCommandId: request.id,
                command: resolveExecApprovalCommandDisplay((request as ExecApprovalRequest).request)
                  .commandText,
                cwd: (request as ExecApprovalRequest).request.cwd ?? undefined,
                host: (request as ExecApprovalRequest).request.host === "node" ? "node" : "gateway",
                nodeId: (request as ExecApprovalRequest).request.nodeId ?? undefined,
                allowedDecisions: resolveExecApprovalRequestAllowedDecisions(
                  (request as ExecApprovalRequest).request,
                ),
                expiresAtMs: request.expiresAtMs,
                nowMs,
              } satisfies ExecApprovalPendingReplyParams);
        return {
          text: payload.text ?? "",
          buttons: resolveTelegramInlineButtons({
            interactive: payload.interactive,
          }),
        };
      },
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: `${plannedTarget.target.to}:${plannedTarget.target.threadId == null ? "" : String(plannedTarget.target.threadId)}`,
        target: {
          chatId: plannedTarget.target.to,
          messageThreadId:
            typeof plannedTarget.target.threadId === "number"
              ? plannedTarget.target.threadId
              : undefined,
        },
      }),
      deliverTarget: async ({ preparedTarget, pendingContent }) => {
        await this.sendTyping(preparedTarget.chatId, {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId,
          ...(preparedTarget.messageThreadId != null
            ? { messageThreadId: preparedTarget.messageThreadId }
            : {}),
        }).catch(() => {});

        const result = await this.sendMessage(preparedTarget.chatId, pendingContent.text, {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId,
          buttons: pendingContent.buttons,
          ...(preparedTarget.messageThreadId != null
            ? { messageThreadId: preparedTarget.messageThreadId }
            : {}),
        });
        return {
          chatId: result.chatId,
          messageId: result.messageId,
        };
      },
      onDeliveryError: ({ error, request }) => {
        log.error(
          `telegram exec approvals: failed to send request ${request.id}: ${String(error)}`,
        );
      },
      finalizeResolved: async ({ resolved, entries }) => {
        await this.finalizeResolved(resolved, entries);
      },
      finalizeExpired: async ({ entries }) => {
        await this.clearPending(entries);
      },
    });
  }

  shouldHandle(request: ApprovalRequest): boolean {
    return shouldHandleTelegramExecApprovalRequest({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      request,
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
    _resolved: ApprovalResolved,
    messages: PendingMessage[],
  ): Promise<void> {
    await this.clearPending(messages);
  }

  private async clearPending(messages: PendingMessage[]): Promise<void> {
    await Promise.allSettled(
      messages.map(async (message) => {
        await this.editReplyMarkup(message.chatId, message.messageId, [], {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId,
        });
      }),
    );
  }
}
