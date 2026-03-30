import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createExecApprovalChannelRuntime,
  type ExecApprovalChannelRuntime,
} from "openclaw/plugin-sdk/infra-runtime";
import { resolveExecApprovalCommandDisplay } from "openclaw/plugin-sdk/infra-runtime";
import {
  buildExecApprovalInteractiveReply,
  buildExecApprovalPendingReplyPayload,
  type ExecApprovalPendingReplyParams,
} from "openclaw/plugin-sdk/infra-runtime";
import { resolveExecApprovalSessionTarget } from "openclaw/plugin-sdk/infra-runtime";
import type { ExecApprovalRequest, ExecApprovalResolved } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeAccountId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { compileSafeRegex, testRegexWithBoundedInput } from "openclaw/plugin-sdk/security-runtime";
import { resolveTelegramInlineButtons } from "./button-types.js";
import {
  getTelegramExecApprovalApprovers,
  resolveTelegramExecApprovalConfig,
  resolveTelegramExecApprovalTarget,
} from "./exec-approvals.js";
import { editMessageReplyMarkupTelegram, sendMessageTelegram, sendTypingTelegram } from "./send.js";

const log = createSubsystemLogger("telegram/exec-approvals");

type PendingMessage = {
  chatId: string;
  messageId: string;
};

type TelegramApprovalTarget = {
  to: string;
  threadId?: number;
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

function matchesFilters(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ExecApprovalRequest;
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

function resolveRequestSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): { to: string; accountId?: string; threadId?: number; channel?: string } | null {
  return resolveExecApprovalSessionTarget({
    cfg: params.cfg,
    request: params.request,
    turnSourceChannel: params.request.request.turnSourceChannel ?? undefined,
    turnSourceTo: params.request.request.turnSourceTo ?? undefined,
    turnSourceAccountId: params.request.request.turnSourceAccountId ?? undefined,
    turnSourceThreadId: params.request.request.turnSourceThreadId ?? undefined,
  });
}

function resolveTelegramSourceTarget(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ExecApprovalRequest;
}): TelegramApprovalTarget | null {
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const turnSourceTo = params.request.request.turnSourceTo?.trim() || "";
  const turnSourceAccountId = params.request.request.turnSourceAccountId?.trim() || "";
  if (turnSourceChannel === "telegram" && turnSourceTo) {
    if (
      turnSourceAccountId &&
      normalizeAccountId(turnSourceAccountId) !== normalizeAccountId(params.accountId)
    ) {
      return null;
    }
    const threadId =
      typeof params.request.request.turnSourceThreadId === "number"
        ? params.request.request.turnSourceThreadId
        : typeof params.request.request.turnSourceThreadId === "string"
          ? Number.parseInt(params.request.request.turnSourceThreadId, 10)
          : undefined;
    return { to: turnSourceTo, threadId: Number.isFinite(threadId) ? threadId : undefined };
  }

  const sessionTarget = resolveRequestSessionTarget(params);
  if (!sessionTarget || sessionTarget.channel !== "telegram") {
    return null;
  }
  if (
    sessionTarget.accountId &&
    normalizeAccountId(sessionTarget.accountId) !== normalizeAccountId(params.accountId)
  ) {
    return null;
  }
  return {
    to: sessionTarget.to,
    threadId: sessionTarget.threadId,
  };
}

function dedupeTargets(targets: TelegramApprovalTarget[]): TelegramApprovalTarget[] {
  const seen = new Set<string>();
  const deduped: TelegramApprovalTarget[] = [];
  for (const target of targets) {
    const key = `${target.to}:${target.threadId ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

export class TelegramExecApprovalHandler {
  private readonly runtime: ExecApprovalChannelRuntime;
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
    this.runtime = createExecApprovalChannelRuntime<PendingMessage>({
      label: "telegram/exec-approvals",
      clientDisplayName: `Telegram Exec Approvals (${this.opts.accountId})`,
      cfg: this.opts.cfg,
      gatewayUrl: this.opts.gatewayUrl,
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

  shouldHandle(request: ExecApprovalRequest): boolean {
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

  async handleRequested(request: ExecApprovalRequest): Promise<void> {
    await this.runtime.handleRequested(request);
  }

  private async deliverRequested(request: ExecApprovalRequest): Promise<PendingMessage[]> {
    const targetMode = resolveTelegramExecApprovalTarget({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
    });
    const targets: TelegramApprovalTarget[] = [];
    const sourceTarget = resolveTelegramSourceTarget({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      request,
    });
    let fallbackToDm = false;
    if (targetMode === "channel" || targetMode === "both") {
      if (sourceTarget) {
        targets.push(sourceTarget);
      } else {
        fallbackToDm = true;
      }
    }
    if (targetMode === "dm" || targetMode === "both" || fallbackToDm) {
      for (const approver of getTelegramExecApprovalApprovers({
        cfg: this.opts.cfg,
        accountId: this.opts.accountId,
      })) {
        targets.push({ to: approver });
      }
    }

    const resolvedTargets = dedupeTargets(targets);
    if (resolvedTargets.length === 0) {
      return [];
    }

    const payloadParams: ExecApprovalPendingReplyParams = {
      approvalId: request.id,
      approvalSlug: request.id.slice(0, 8),
      approvalCommandId: request.id,
      command: resolveExecApprovalCommandDisplay(request.request).commandText,
      cwd: request.request.cwd ?? undefined,
      host: request.request.host === "node" ? "node" : "gateway",
      nodeId: request.request.nodeId ?? undefined,
      expiresAtMs: request.expiresAtMs,
      nowMs: this.nowMs(),
    };
    const payload = {
      ...buildExecApprovalPendingReplyPayload(payloadParams),
      interactive: buildExecApprovalInteractiveReply({
        approvalCommandId: request.id,
      }),
    };
    const buttons = resolveTelegramInlineButtons({
      interactive: payload.interactive,
    });
    const sentMessages: PendingMessage[] = [];

    for (const target of resolvedTargets) {
      try {
        await this.sendTyping(target.to, {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId,
          ...(typeof target.threadId === "number" ? { messageThreadId: target.threadId } : {}),
        }).catch(() => {});

        const result = await this.sendMessage(target.to, payload.text ?? "", {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId,
          buttons,
          ...(typeof target.threadId === "number" ? { messageThreadId: target.threadId } : {}),
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

  async handleResolved(resolved: ExecApprovalResolved): Promise<void> {
    await this.runtime.handleResolved(resolved);
  }

  private async finalizeResolved(
    _resolved: ExecApprovalResolved,
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
