import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { GatewayClient } from "../../../src/gateway/client.js";
import { createOperatorApprovalsGatewayClient } from "../../../src/gateway/operator-approvals-client.js";
import type { EventFrame } from "../../../src/gateway/protocol/index.js";
import { resolveExecApprovalCommandDisplay } from "../../../src/infra/exec-approval-command-display.js";
import {
  buildExecApprovalPendingReplyPayload,
  type ExecApprovalPendingReplyParams,
} from "../../../src/infra/exec-approval-reply.js";
import { resolveExecApprovalSessionTarget } from "../../../src/infra/exec-approval-session-target.js";
import type {
  ExecApprovalRequest,
  ExecApprovalResolved,
} from "../../../src/infra/exec-approvals.js";
import { createSubsystemLogger } from "../../../src/logging/subsystem.js";
import { normalizeAccountId, parseAgentSessionKey } from "../../../src/routing/session-key.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import { compileSafeRegex, testRegexWithBoundedInput } from "../../../src/security/safe-regex.js";
import {
  getSlackExecApprovalApprovers,
  resolveSlackExecApprovalConfig,
  resolveSlackExecApprovalTarget,
} from "./exec-approvals.js";

const log = createSubsystemLogger("slack/exec-approvals");

export const SLACK_EXEC_APPROVAL_ACTION_PREFIX = "openclaw:exec_approval:";

type PendingMessage = {
  channelId: string;
  ts: string;
};

type PendingApproval = {
  timeoutId: NodeJS.Timeout;
  messages: PendingMessage[];
};

type SlackApprovalTarget = {
  /** User ID for DM or channel ID for channel target. */
  id: string;
  kind: "user" | "channel";
  threadTs?: string;
};

export type SlackExecApprovalHandlerOpts = {
  botToken: string;
  accountId: string;
  cfg: OpenClawConfig;
  client: WebClient;
  gatewayUrl?: string;
  runtime?: RuntimeEnv;
};

export type SlackExecApprovalHandlerDeps = {
  nowMs?: () => number;
};

function matchesFilters(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ExecApprovalRequest;
}): boolean {
  const config = resolveSlackExecApprovalConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!config?.enabled) {
    return false;
  }
  const approvers = getSlackExecApprovalApprovers({
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
  const config = resolveSlackExecApprovalConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!config?.enabled) {
    return false;
  }
  return (
    getSlackExecApprovalApprovers({
      cfg: params.cfg,
      accountId: params.accountId,
    }).length > 0
  );
}

function resolveSlackSourceTarget(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ExecApprovalRequest;
}): SlackApprovalTarget | null {
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const turnSourceTo = params.request.request.turnSourceTo?.trim() || "";
  const turnSourceAccountId = params.request.request.turnSourceAccountId?.trim() || "";
  if (turnSourceChannel === "slack" && turnSourceTo) {
    if (
      turnSourceAccountId &&
      normalizeAccountId(turnSourceAccountId) !== normalizeAccountId(params.accountId)
    ) {
      return null;
    }
    return { id: turnSourceTo, kind: "channel" };
  }

  const sessionTarget = resolveExecApprovalSessionTarget({
    cfg: params.cfg,
    request: params.request,
    turnSourceChannel: params.request.request.turnSourceChannel ?? undefined,
    turnSourceTo: params.request.request.turnSourceTo ?? undefined,
    turnSourceAccountId: params.request.request.turnSourceAccountId ?? undefined,
    turnSourceThreadId: params.request.request.turnSourceThreadId ?? undefined,
  });
  if (!sessionTarget || sessionTarget.channel !== "slack") {
    return null;
  }
  if (
    sessionTarget.accountId &&
    normalizeAccountId(sessionTarget.accountId) !== normalizeAccountId(params.accountId)
  ) {
    return null;
  }
  return { id: sessionTarget.to, kind: "channel" };
}

function dedupeTargets(targets: SlackApprovalTarget[]): SlackApprovalTarget[] {
  const seen = new Set<string>();
  const deduped: SlackApprovalTarget[] = [];
  for (const target of targets) {
    const key = `${target.kind}:${target.id}:${target.threadTs ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

function buildSlackExecApprovalBlocks(params: {
  approvalId: string;
  text: string;
}): Array<Record<string, unknown>> {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: params.text,
      },
    },
    {
      type: "actions",
      block_id: `openclaw_exec_approval_${params.approvalId.slice(0, 8)}`,
      elements: [
        {
          type: "button",
          action_id: `${SLACK_EXEC_APPROVAL_ACTION_PREFIX}allow-once`,
          text: { type: "plain_text", text: "Allow Once", emoji: true },
          style: "primary",
          value: params.approvalId,
        },
        {
          type: "button",
          action_id: `${SLACK_EXEC_APPROVAL_ACTION_PREFIX}allow-always`,
          text: { type: "plain_text", text: "Allow Always", emoji: true },
          value: params.approvalId,
        },
        {
          type: "button",
          action_id: `${SLACK_EXEC_APPROVAL_ACTION_PREFIX}deny`,
          text: { type: "plain_text", text: "Deny", emoji: true },
          style: "danger",
          value: params.approvalId,
        },
      ],
    },
  ];
}

export class SlackExecApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private pending = new Map<string, PendingApproval>();
  private started = false;
  private readonly nowMs: () => number;

  constructor(
    private readonly opts: SlackExecApprovalHandlerOpts,
    deps: SlackExecApprovalHandlerDeps = {},
  ) {
    this.nowMs = deps.nowMs ?? Date.now;
  }

  shouldHandle(request: ExecApprovalRequest): boolean {
    return matchesFilters({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      request,
    });
  }

  async start(): Promise<void> {
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
      clientDisplayName: `Slack Exec Approvals (${this.opts.accountId})`,
      onEvent: (evt) => this.handleGatewayEvent(evt),
      onConnectError: (err) => {
        log.error(`slack exec approvals: connect error: ${err.message}`);
      },
    });
    this.gatewayClient.start();
  }

  async stop(): Promise<void> {
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

  async handleRequested(request: ExecApprovalRequest): Promise<void> {
    if (!this.shouldHandle(request)) {
      return;
    }

    const targetMode = resolveSlackExecApprovalTarget({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
    });
    const targets: SlackApprovalTarget[] = [];
    const sourceTarget = resolveSlackSourceTarget({
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
      for (const approver of getSlackExecApprovalApprovers({
        cfg: this.opts.cfg,
        accountId: this.opts.accountId,
      })) {
        targets.push({ id: approver, kind: "user" });
      }
    }

    const resolvedTargets = dedupeTargets(targets);
    if (resolvedTargets.length === 0) {
      return;
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
    const payload = buildExecApprovalPendingReplyPayload(payloadParams);
    const messageText = payload.text ?? "Exec approval required.";
    const blocks = buildSlackExecApprovalBlocks({
      approvalId: request.id,
      text: messageText,
    });
    const sentMessages: PendingMessage[] = [];

    for (const target of resolvedTargets) {
      try {
        let channelId: string;
        if (target.kind === "user") {
          // Open a DM channel with the approver.
          const dmResponse = await this.opts.client.conversations.open({ users: target.id });
          channelId = dmResponse.channel?.id ?? "";
          if (!channelId) {
            log.error(
              `slack exec approvals: failed to open DM for user ${target.id} request ${request.id}`,
            );
            continue;
          }
        } else {
          channelId = target.id;
        }

        const result = await this.opts.client.chat.postMessage({
          channel: channelId,
          text: messageText,
          blocks: blocks as never[],
          ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
        });
        if (result.ts) {
          sentMessages.push({ channelId, ts: result.ts });
        }
      } catch (err) {
        log.error(`slack exec approvals: failed to send request ${request.id}: ${String(err)}`);
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
      messages: sentMessages,
    });
  }

  async handleResolved(resolved: ExecApprovalResolved): Promise<void> {
    const pending = this.pending.get(resolved.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(resolved.id);

    const decisionLabel =
      resolved.decision === "allow-once"
        ? "Allowed (once)"
        : resolved.decision === "allow-always"
          ? "Allowed (always)"
          : "Denied";

    await Promise.allSettled(
      pending.messages.map(async (message) => {
        await this.opts.client.chat.update({
          channel: message.channelId,
          ts: message.ts,
          text: `Exec approval resolved: ${decisionLabel}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:white_check_mark: Exec approval resolved: *${decisionLabel}*`,
              },
            },
          ],
        });
      }),
    );
  }

  private handleGatewayEvent(evt: EventFrame): void {
    if (evt.event === "exec.approval.requested") {
      void this.handleRequested(evt.payload as ExecApprovalRequest);
      return;
    }
    if (evt.event === "exec.approval.resolved") {
      void this.handleResolved(evt.payload as ExecApprovalResolved);
    }
  }
}
