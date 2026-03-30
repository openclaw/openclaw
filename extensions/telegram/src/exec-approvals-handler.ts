import { buildPluginApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createExecApprovalChannelRuntime,
  type ExecApprovalChannelRuntime,
  resolveChannelNativeApprovalDeliveryPlan,
  resolveExecApprovalSessionTarget,
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
import { parseAgentSessionKey, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { compileSafeRegex, testRegexWithBoundedInput } from "openclaw/plugin-sdk/security-runtime";
import { telegramNativeApprovalAdapter } from "./approval-native.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import {
  getTelegramExecApprovalApprovers,
  resolveTelegramExecApprovalConfig,
} from "./exec-approvals.js";
import { editMessageReplyMarkupTelegram, sendMessageTelegram, sendTypingTelegram } from "./send.js";

const log = createSubsystemLogger("telegram/exec-approvals");

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
type ApprovalKind = "exec" | "plugin";

type PendingMessage = {
  chatId: string;
  messageId: string;
};

function isExecApprovalRequest(request: ApprovalRequest): request is ExecApprovalRequest {
  return "command" in request.request;
}

function toExecLikeRequest(request: ApprovalRequest): ExecApprovalRequest {
  if (isExecApprovalRequest(request)) {
    return request;
  }
  return {
    id: request.id,
    request: {
      command: request.request.title,
      agentId: request.request.agentId ?? undefined,
      sessionKey: request.request.sessionKey ?? undefined,
      turnSourceChannel: request.request.turnSourceChannel ?? undefined,
      turnSourceTo: request.request.turnSourceTo ?? undefined,
      turnSourceAccountId: request.request.turnSourceAccountId ?? undefined,
      turnSourceThreadId: request.request.turnSourceThreadId ?? undefined,
    },
    createdAtMs: request.createdAtMs,
    expiresAtMs: request.expiresAtMs,
  };
}

function resolveBoundTelegramAccountId(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequest;
}): string | null {
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase();
  if (turnSourceChannel === "telegram") {
    return params.request.request.turnSourceAccountId?.trim() || null;
  }
  const sessionTarget = resolveExecApprovalSessionTarget({
    cfg: params.cfg,
    request: toExecLikeRequest(params.request),
    turnSourceChannel: params.request.request.turnSourceChannel ?? undefined,
    turnSourceTo: params.request.request.turnSourceTo ?? undefined,
    turnSourceAccountId: params.request.request.turnSourceAccountId ?? undefined,
    turnSourceThreadId: params.request.request.turnSourceThreadId ?? undefined,
  });
  if (!sessionTarget || sessionTarget.channel !== "telegram") {
    return null;
  }
  return sessionTarget.accountId?.trim() || null;
}

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

function matchesFilters(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ApprovalRequest;
}): boolean {
  const config = resolveTelegramExecApprovalConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!config?.enabled) {
    return false;
  }
  const approvers = getTelegramExecApprovalApprovers({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (approvers.length === 0) {
    return false;
  }
  if (config.agentFilter?.length) {
    const agentId =
      params.request.request.agentId ??
      parseAgentSessionKey(params.request.request.sessionKey)?.agentId;
    if (!agentId || !config.agentFilter.includes(agentId)) {
      return false;
    }
  }
  if (config.sessionFilter?.length) {
    const sessionKey = params.request.request.sessionKey;
    if (!sessionKey) {
      return false;
    }
    const matches = config.sessionFilter.some((pattern) => {
      if (sessionKey.includes(pattern)) {
        return true;
      }
      const regex = compileSafeRegex(pattern);
      return regex ? testRegexWithBoundedInput(regex, sessionKey) : false;
    });
    if (!matches) {
      return false;
    }
  }
  const boundAccountId = resolveBoundTelegramAccountId({
    cfg: params.cfg,
    request: params.request,
  });
  if (
    boundAccountId &&
    normalizeAccountId(boundAccountId) !== normalizeAccountId(params.accountId)
  ) {
    return false;
  }
  return true;
}

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
    this.runtime = createExecApprovalChannelRuntime<
      PendingMessage,
      ApprovalRequest,
      ApprovalResolved
    >({
      label: "telegram/exec-approvals",
      clientDisplayName: `Telegram Exec Approvals (${this.opts.accountId})`,
      cfg: this.opts.cfg,
      gatewayUrl: this.opts.gatewayUrl,
      eventKinds: ["exec", "plugin"],
      nowMs: this.nowMs,
      isConfigured: () =>
        isHandlerConfigured({ cfg: this.opts.cfg, accountId: this.opts.accountId }),
      shouldHandle: (request) =>
        matchesFilters({
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
          request,
        }),
      deliverRequested: async (request) => await this.deliverRequested(request),
      finalizeResolved: async ({ resolved, entries }) => {
        await this.finalizeResolved(resolved, entries);
      },
      finalizeExpired: async ({ entries }) => {
        await this.clearPending(entries);
      },
    });
  }

  shouldHandle(request: ApprovalRequest): boolean {
    return matchesFilters({
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

  private async deliverRequested(request: ApprovalRequest): Promise<PendingMessage[]> {
    const approvalKind: ApprovalKind = request.id.startsWith("plugin:") ? "plugin" : "exec";
    const deliveryPlan = await resolveChannelNativeApprovalDeliveryPlan({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      approvalKind,
      request,
      adapter: telegramNativeApprovalAdapter.native,
    });
    if (deliveryPlan.targets.length === 0) {
      return [];
    }

    const payload =
      approvalKind === "plugin"
        ? buildPluginApprovalPendingReplyPayload({
            request: request as PluginApprovalRequest,
            nowMs: this.nowMs(),
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
            expiresAtMs: request.expiresAtMs,
            nowMs: this.nowMs(),
          } satisfies ExecApprovalPendingReplyParams);
    const buttons = resolveTelegramInlineButtons({
      interactive: payload.interactive,
    });
    const sentMessages: PendingMessage[] = [];

    for (const target of deliveryPlan.targets) {
      try {
        await this.sendTyping(target.target.to, {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId,
          ...(typeof target.target.threadId === "number"
            ? { messageThreadId: target.target.threadId }
            : {}),
        }).catch(() => {});

        const result = await this.sendMessage(target.target.to, payload.text ?? "", {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId,
          buttons,
          ...(typeof target.target.threadId === "number"
            ? { messageThreadId: target.target.threadId }
            : {}),
        });
        sentMessages.push({
          chatId: result.chatId,
          messageId: result.messageId,
        });
      } catch (err) {
        log.error(`telegram exec approvals: failed to send request ${request.id}: ${String(err)}`);
      }
    }
    return sentMessages;
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
