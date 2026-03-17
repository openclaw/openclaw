import { createOperatorApprovalsGatewayClient } from "../../../src/gateway/operator-approvals-client.js";
import { resolveExecApprovalCommandDisplay } from "../../../src/infra/exec-approval-command-display.js";
import {
  buildExecApprovalPendingReplyPayload
} from "../../../src/infra/exec-approval-reply.js";
import { resolveExecApprovalSessionTarget } from "../../../src/infra/exec-approval-session-target.js";
import { createSubsystemLogger } from "../../../src/logging/subsystem.js";
import { normalizeAccountId, parseAgentSessionKey } from "../../../src/routing/session-key.js";
import { compileSafeRegex, testRegexWithBoundedInput } from "../../../src/security/safe-regex.js";
import { buildTelegramExecApprovalButtons } from "./approval-buttons.js";
import {
  getTelegramExecApprovalApprovers,
  resolveTelegramExecApprovalConfig,
  resolveTelegramExecApprovalTarget
} from "./exec-approvals.js";
import { editMessageReplyMarkupTelegram, sendMessageTelegram, sendTypingTelegram } from "./send.js";
const log = createSubsystemLogger("telegram/exec-approvals");
function matchesFilters(params) {
  const config = resolveTelegramExecApprovalConfig({
    cfg: params.cfg,
    accountId: params.accountId
  });
  if (!config?.enabled) {
    return false;
  }
  const approvers = getTelegramExecApprovalApprovers({
    cfg: params.cfg,
    accountId: params.accountId
  });
  if (approvers.length === 0) {
    return false;
  }
  if (config.agentFilter?.length) {
    const agentId = params.request.request.agentId ?? parseAgentSessionKey(params.request.request.sessionKey)?.agentId;
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
function isHandlerConfigured(params) {
  const config = resolveTelegramExecApprovalConfig({
    cfg: params.cfg,
    accountId: params.accountId
  });
  if (!config?.enabled) {
    return false;
  }
  return getTelegramExecApprovalApprovers({
    cfg: params.cfg,
    accountId: params.accountId
  }).length > 0;
}
function resolveRequestSessionTarget(params) {
  return resolveExecApprovalSessionTarget({
    cfg: params.cfg,
    request: params.request,
    turnSourceChannel: params.request.request.turnSourceChannel ?? void 0,
    turnSourceTo: params.request.request.turnSourceTo ?? void 0,
    turnSourceAccountId: params.request.request.turnSourceAccountId ?? void 0,
    turnSourceThreadId: params.request.request.turnSourceThreadId ?? void 0
  });
}
function resolveTelegramSourceTarget(params) {
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const turnSourceTo = params.request.request.turnSourceTo?.trim() || "";
  const turnSourceAccountId = params.request.request.turnSourceAccountId?.trim() || "";
  if (turnSourceChannel === "telegram" && turnSourceTo) {
    if (turnSourceAccountId && normalizeAccountId(turnSourceAccountId) !== normalizeAccountId(params.accountId)) {
      return null;
    }
    const threadId = typeof params.request.request.turnSourceThreadId === "number" ? params.request.request.turnSourceThreadId : typeof params.request.request.turnSourceThreadId === "string" ? Number.parseInt(params.request.request.turnSourceThreadId, 10) : void 0;
    return { to: turnSourceTo, threadId: Number.isFinite(threadId) ? threadId : void 0 };
  }
  const sessionTarget = resolveRequestSessionTarget(params);
  if (!sessionTarget || sessionTarget.channel !== "telegram") {
    return null;
  }
  if (sessionTarget.accountId && normalizeAccountId(sessionTarget.accountId) !== normalizeAccountId(params.accountId)) {
    return null;
  }
  return {
    to: sessionTarget.to,
    threadId: sessionTarget.threadId
  };
}
function dedupeTargets(targets) {
  const seen = /* @__PURE__ */ new Set();
  const deduped = [];
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
class TelegramExecApprovalHandler {
  constructor(opts, deps = {}) {
    this.opts = opts;
    this.gatewayClient = null;
    this.pending = /* @__PURE__ */ new Map();
    this.started = false;
    this.nowMs = deps.nowMs ?? Date.now;
    this.sendTyping = deps.sendTyping ?? sendTypingTelegram;
    this.sendMessage = deps.sendMessage ?? sendMessageTelegram;
    this.editReplyMarkup = deps.editReplyMarkup ?? editMessageReplyMarkupTelegram;
  }
  shouldHandle(request) {
    return matchesFilters({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      request
    });
  }
  async start() {
    if (this.started) {
      return;
    }
    this.started = true;
    if (!isHandlerConfigured({ cfg: this.opts.cfg, accountId: this.opts.accountId })) {
      return;
    }
    this.gatewayClient = await createOperatorApprovalsGatewayClient({
      config: this.opts.cfg,
      gatewayUrl: this.opts.gatewayUrl,
      clientDisplayName: `Telegram Exec Approvals (${this.opts.accountId})`,
      onEvent: (evt) => this.handleGatewayEvent(evt),
      onConnectError: (err) => {
        log.error(`telegram exec approvals: connect error: ${err.message}`);
      }
    });
    this.gatewayClient.start();
  }
  async stop() {
    if (!this.started) {
      return;
    }
    this.started = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pending.clear();
    this.gatewayClient?.stop();
    this.gatewayClient = null;
  }
  async handleRequested(request) {
    if (!this.shouldHandle(request)) {
      return;
    }
    const targetMode = resolveTelegramExecApprovalTarget({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId
    });
    const targets = [];
    const sourceTarget = resolveTelegramSourceTarget({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      request
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
        accountId: this.opts.accountId
      })) {
        targets.push({ to: approver });
      }
    }
    const resolvedTargets = dedupeTargets(targets);
    if (resolvedTargets.length === 0) {
      return;
    }
    const payloadParams = {
      approvalId: request.id,
      approvalSlug: request.id.slice(0, 8),
      approvalCommandId: request.id,
      command: resolveExecApprovalCommandDisplay(request.request).commandText,
      cwd: request.request.cwd ?? void 0,
      host: request.request.host === "node" ? "node" : "gateway",
      nodeId: request.request.nodeId ?? void 0,
      expiresAtMs: request.expiresAtMs,
      nowMs: this.nowMs()
    };
    const payload = buildExecApprovalPendingReplyPayload(payloadParams);
    const buttons = buildTelegramExecApprovalButtons(request.id);
    const sentMessages = [];
    for (const target of resolvedTargets) {
      try {
        await this.sendTyping(target.to, {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId,
          ...typeof target.threadId === "number" ? { messageThreadId: target.threadId } : {}
        }).catch(() => {
        });
        const result = await this.sendMessage(target.to, payload.text ?? "", {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId,
          buttons,
          ...typeof target.threadId === "number" ? { messageThreadId: target.threadId } : {}
        });
        sentMessages.push({
          chatId: result.chatId,
          messageId: result.messageId
        });
      } catch (err) {
        log.error(`telegram exec approvals: failed to send request ${request.id}: ${String(err)}`);
      }
    }
    if (sentMessages.length === 0) {
      return;
    }
    const timeoutMs = Math.max(0, request.expiresAtMs - this.nowMs());
    const timeoutId = setTimeout(() => {
      void this.handleResolved({ id: request.id, decision: "deny", ts: Date.now() });
    }, timeoutMs);
    timeoutId.unref?.();
    this.pending.set(request.id, {
      timeoutId,
      messages: sentMessages
    });
  }
  async handleResolved(resolved) {
    const pending = this.pending.get(resolved.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(resolved.id);
    await Promise.allSettled(
      pending.messages.map(async (message) => {
        await this.editReplyMarkup(message.chatId, message.messageId, [], {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId
        });
      })
    );
  }
  handleGatewayEvent(evt) {
    if (evt.event === "exec.approval.requested") {
      void this.handleRequested(evt.payload);
      return;
    }
    if (evt.event === "exec.approval.resolved") {
      void this.handleResolved(evt.payload);
    }
  }
}
export {
  TelegramExecApprovalHandler
};
