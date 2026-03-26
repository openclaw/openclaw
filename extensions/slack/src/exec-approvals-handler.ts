import type { WebClient } from "@slack/web-api";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { createOperatorApprovalsGatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import type { EventFrame } from "openclaw/plugin-sdk/gateway-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  type ExecApprovalPendingReplyParams,
  resolveExecApprovalCommandDisplay,
  resolveExecApprovalSessionTarget,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
} from "openclaw/plugin-sdk/infra-runtime";
import { normalizeAccountId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { compileSafeRegex, testRegexWithBoundedInput } from "openclaw/plugin-sdk/security-runtime";
import {
  getSlackExecApprovalApprovers,
  resolveSlackExecApprovalConfig,
  resolveSlackExecApprovalTarget,
} from "./exec-approvals.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { parseSlackTarget } from "./targets.js";
import { truncateSlackText } from "./truncate.js";

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
    // Normalize prefixed targets (e.g. "user:U123", "channel:C456") to raw IDs.
    const parsed = parseSlackTarget(turnSourceTo, { defaultKind: "channel" });
    const targetId = parsed?.id ?? turnSourceTo;
    const targetKind: "user" | "channel" = parsed?.kind === "user" ? "user" : "channel";
    const rawThreadId = params.request.request.turnSourceThreadId;
    const threadTs =
      typeof rawThreadId === "string" && rawThreadId.trim()
        ? rawThreadId.trim()
        : typeof rawThreadId === "number"
          ? String(rawThreadId)
          : undefined;
    return { id: targetId, kind: targetKind, threadTs };
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
  // Normalize prefixed session targets the same way.
  const sessionParsed = parseSlackTarget(sessionTarget.to, { defaultKind: "channel" });
  const sessionTargetId = sessionParsed?.id ?? sessionTarget.to;
  const sessionTargetKind: "user" | "channel" = sessionParsed?.kind === "user" ? "user" : "channel";
  const sessionThreadTs =
    typeof sessionTarget.threadId === "number" ? String(sessionTarget.threadId) : undefined;
  return { id: sessionTargetId, kind: sessionTargetKind, threadTs: sessionThreadTs };
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
        text: truncateSlackText(params.text, 3000),
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

    // In multi-account setups, skip if the request is explicitly from a
    // different Slack account to avoid duplicate prompts / info leakage.
    const turnSourceChannel = request.request.turnSourceChannel?.trim().toLowerCase();
    const turnSourceAccountId = request.request.turnSourceAccountId?.trim();
    if (
      turnSourceChannel === "slack" &&
      turnSourceAccountId &&
      normalizeAccountId(turnSourceAccountId) !== normalizeAccountId(this.opts.accountId)
    ) {
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
        // When the source is a DM (kind === "user") and target mode is
        // "channel", also fall back to approver DMs. A DM-origin source
        // target only reaches the requester, who may not be an approver and
        // therefore cannot action the buttons.
        if (sourceTarget.kind === "user" && targetMode === "channel") {
          fallbackToDm = true;
        }
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

    // Sanitize backticks in the command text to prevent Slack mrkdwn code
    // block breakout. Slack only supports triple-backtick fences, so any
    // literal backticks in the command would prematurely close the block.
    // Insert a zero-width space before each backtick (same approach as Discord).
    const rawCommand = resolveExecApprovalCommandDisplay(request.request).commandText;
    const safeCommand = rawCommand.replace(/`/g, "\u200b`");

    const payloadParams: ExecApprovalPendingReplyParams = {
      approvalId: request.id,
      approvalSlug: request.id.slice(0, 8),
      approvalCommandId: request.id,
      command: safeCommand,
      cwd: request.request.cwd ?? undefined,
      host: request.request.host === "node" ? "node" : "gateway",
      nodeId: request.request.nodeId ?? undefined,
      expiresAtMs: request.expiresAtMs,
      nowMs: this.nowMs(),
      // Escape user-controlled fields interpolated outside code fences to
      // prevent mrkdwn injection (fake links, formatting breakout).
      escapeText: escapeSlackMrkdwn,
    };
    const payload = buildExecApprovalPendingReplyPayload(payloadParams);
    const messageText = payload.text ?? "Exec approval required.";
    const blocks = buildSlackExecApprovalBlocks({
      approvalId: request.id,
      text: messageText,
    });
    // Register pending entry before sending so a resolve event arriving
    // during the send window is not dropped.
    const timeoutMs = Math.max(0, request.expiresAtMs - this.nowMs());
    const timeoutId = setTimeout(() => {
      // Use a distinct expired path instead of synthetic deny so that a real
      // resolve event arriving just after expiry can still update messages
      // with the correct outcome instead of permanently showing "Denied".
      void this.handleExpired(request.id);
    }, timeoutMs);
    timeoutId.unref?.();
    const pendingEntry: PendingApproval = { timeoutId, messages: [] };
    this.pending.set(request.id, pendingEntry);

    for (const target of resolvedTargets) {
      // Abort remaining sends if a concurrent resolve already cleared us.
      if (!this.pending.has(request.id)) {
        break;
      }
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
          // If the pending entry was cleared during the await (concurrent
          // resolve or expiry), immediately update this stale message to
          // remove buttons. Use a neutral label since we don't know whether
          // the approval was resolved or expired.
          if (!this.pending.has(request.id)) {
            await this.opts.client.chat
              .update({
                channel: channelId,
                ts: result.ts,
                text: "Exec approval is no longer pending.",
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: "Exec approval is no longer pending.",
                    },
                  },
                ],
              })
              .catch(() => {});
          } else {
            pendingEntry.messages.push({ channelId, ts: result.ts });
          }
        }
      } catch (err) {
        log.error(`slack exec approvals: failed to send request ${request.id}: ${String(err)}`);
      }
    }

    if (pendingEntry.messages.length === 0) {
      clearTimeout(timeoutId);
      this.pending.delete(request.id);
    }
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
    // Escape resolvedBy to prevent mrkdwn injection in the resolved message.
    const safeResolvedBy = resolved.resolvedBy ? escapeSlackMrkdwn(resolved.resolvedBy) : "";
    const byLabel = safeResolvedBy ? ` by ${safeResolvedBy}` : "";

    await Promise.allSettled(
      pending.messages.map(async (message) => {
        await this.opts.client.chat.update({
          channel: message.channelId,
          ts: message.ts,
          text: `Exec approval resolved: ${decisionLabel}${byLabel}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:white_check_mark: Exec approval resolved: *${decisionLabel}*${byLabel}`,
              },
            },
          ],
        });
      }),
    );
  }

  /**
   * Mark a pending approval as expired without claiming a decision. The
   * pending entry is removed so we stop tracking it, and Slack messages are
   * updated to show "Expired" instead of "Denied". If a real resolve event
   * races with this, `handleResolved` will simply find no pending entry and
   * return early -- the worst case is the message stays "Expired" which is
   * accurate (the gateway timed out).
   */
  private async handleExpired(approvalId: string): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(approvalId);

    await Promise.allSettled(
      pending.messages.map(async (message) => {
        await this.opts.client.chat.update({
          channel: message.channelId,
          ts: message.ts,
          text: "Exec approval expired.",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: ":hourglass: Exec approval *expired* (no response before timeout).",
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
