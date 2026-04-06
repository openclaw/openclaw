import type { App } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  buildApprovalInteractiveReply,
  createChannelNativeApprovalRuntime,
  getExecApprovalApproverDmNoticeText,
  resolveExecApprovalCommandDisplay,
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalChannelRuntime,
  type ExecApprovalDecision,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
} from "openclaw/plugin-sdk/infra-runtime";
import { logError } from "openclaw/plugin-sdk/text-runtime";
import { slackNativeApprovalAdapter } from "../approval-native.js";
import {
  isSlackExecApprovalClientEnabled,
  normalizeSlackApproverId,
  shouldHandleSlackExecApprovalRequest,
} from "../exec-approvals.js";
import { resolveSlackReplyBlocks } from "../reply-blocks.js";
import { sendMessageSlack } from "../send.js";

type SlackBlock = Block | KnownBlock;
type SlackPendingApproval = {
  channelId: string;
  messageTs: string;
};
type SlackPendingDelivery = {
  text: string;
  blocks: SlackBlock[];
};

type SlackExecApprovalConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>["execApprovals"]
>;

type SlackExecApprovalHandlerOpts = {
  app: App;
  accountId: string;
  config: SlackExecApprovalConfig;
  gatewayUrl?: string;
  cfg: OpenClawConfig;
};

function truncateSlackMrkdwn(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function buildSlackCodeBlock(text: string): string {
  let fence = "```";
  while (text.includes(fence)) {
    fence += "`";
  }
  return `${fence}\n${text}\n${fence}`;
}

function formatSlackApprover(resolvedBy?: string | null): string | null {
  const normalized = resolvedBy ? normalizeSlackApproverId(resolvedBy) : undefined;
  if (normalized) {
    return `<@${normalized}>`;
  }
  const trimmed = resolvedBy?.trim();
  return trimmed ? trimmed : null;
}

function buildSlackApprovalContextLines(request: ExecApprovalRequest): string[] {
  const lines: string[] = [];
  if (request.request.agentId) {
    lines.push(`*Agent:* ${request.request.agentId}`);
  }
  if (request.request.cwd) {
    lines.push(`*CWD:* ${request.request.cwd}`);
  }
  if (request.request.host) {
    lines.push(`*Host:* ${request.request.host}`);
  }
  return lines;
}

function buildSlackPendingApprovalText(request: ExecApprovalRequest): string {
  const { commandText } = resolveExecApprovalCommandDisplay(request.request);
  const lines = [
    "*Exec approval required*",
    "A command needs your approval.",
    "",
    "*Command*",
    buildSlackCodeBlock(commandText),
    ...buildSlackApprovalContextLines(request),
  ];
  return lines.join("\n");
}

function buildSlackPendingApprovalBlocks(request: ExecApprovalRequest): SlackBlock[] {
  const { commandText } = resolveExecApprovalCommandDisplay(request.request);
  const metadataLines = buildSlackApprovalContextLines(request);
  const interactiveBlocks =
    resolveSlackReplyBlocks({
      text: "",
      interactive: buildApprovalInteractiveReply({
        approvalId: request.id,
        ask: request.request.ask,
        allowedDecisions: resolveExecApprovalRequestAllowedDecisions(request.request),
      }),
    }) ?? [];
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Exec approval required*\nA command needs your approval.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(commandText, 2600))}`,
      },
    },
    ...(metadataLines.length > 0
      ? [
          {
            type: "context",
            elements: metadataLines.map((line) => ({
              type: "mrkdwn" as const,
              text: line,
            })),
          } satisfies SlackBlock,
        ]
      : []),
    ...interactiveBlocks,
  ];
}

function buildSlackResolvedText(params: {
  request: ExecApprovalRequest;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
}): string {
  const { commandText } = resolveExecApprovalCommandDisplay(params.request.request);
  const decisionLabel =
    params.decision === "allow-once"
      ? "Allowed once"
      : params.decision === "allow-always"
        ? "Allowed always"
        : "Denied";
  const resolvedBy = formatSlackApprover(params.resolvedBy);
  const lines = [
    `*Exec approval: ${decisionLabel}*`,
    resolvedBy ? `Resolved by ${resolvedBy}.` : "Resolved.",
    "",
    "*Command*",
    buildSlackCodeBlock(commandText),
  ];
  return lines.join("\n");
}

function buildSlackResolvedBlocks(params: {
  request: ExecApprovalRequest;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
}): SlackBlock[] {
  const { commandText } = resolveExecApprovalCommandDisplay(params.request.request);
  const decisionLabel =
    params.decision === "allow-once"
      ? "Allowed once"
      : params.decision === "allow-always"
        ? "Allowed always"
        : "Denied";
  const resolvedBy = formatSlackApprover(params.resolvedBy);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Exec approval: ${decisionLabel}*\n${resolvedBy ? `Resolved by ${resolvedBy}.` : "Resolved."}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(commandText, 2600))}`,
      },
    },
  ];
}

function buildSlackExpiredText(request: ExecApprovalRequest): string {
  const { commandText } = resolveExecApprovalCommandDisplay(request.request);
  return [
    "*Exec approval expired*",
    "This approval request expired before it was resolved.",
    "",
    "*Command*",
    buildSlackCodeBlock(commandText),
  ].join("\n");
}

function buildSlackExpiredBlocks(request: ExecApprovalRequest): SlackBlock[] {
  const { commandText } = resolveExecApprovalCommandDisplay(request.request);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Exec approval expired*\nThis approval request expired before it was resolved.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(commandText, 2600))}`,
      },
    },
  ];
}

export class SlackExecApprovalHandler {
  private readonly runtime: ExecApprovalChannelRuntime;
  private readonly opts: SlackExecApprovalHandlerOpts;

  constructor(opts: SlackExecApprovalHandlerOpts) {
    this.opts = opts;
    this.runtime = createChannelNativeApprovalRuntime<
      SlackPendingApproval,
      { to: string; threadTs?: string },
      SlackPendingDelivery,
      ExecApprovalRequest,
      ExecApprovalResolved
    >({
      label: "slack/exec-approvals",
      clientDisplayName: "Slack Exec Approvals",
      cfg: opts.cfg,
      accountId: opts.accountId,
      gatewayUrl: opts.gatewayUrl,
      eventKinds: ["exec"],
      nativeAdapter: slackNativeApprovalAdapter.native,
      isConfigured: () =>
        isSlackExecApprovalClientEnabled({
          cfg: opts.cfg,
          accountId: opts.accountId,
        }),
      shouldHandle: (request) => this.shouldHandle(request),
      buildPendingContent: ({ request }) => ({
        text: buildSlackPendingApprovalText(request),
        blocks: buildSlackPendingApprovalBlocks(request),
      }),
      sendOriginNotice: async ({ originTarget }) => {
        await sendMessageSlack(originTarget.to, getExecApprovalApproverDmNoticeText(), {
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
          threadTs: originTarget.threadId != null ? String(originTarget.threadId) : undefined,
          client: this.opts.app.client,
        });
      },
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: `${plannedTarget.target.to}:${plannedTarget.target.threadId == null ? "" : String(plannedTarget.target.threadId)}`,
        target: {
          to: plannedTarget.target.to,
          threadTs:
            plannedTarget.target.threadId != null
              ? String(plannedTarget.target.threadId)
              : undefined,
        },
      }),
      deliverTarget: async ({ preparedTarget, pendingContent }) => {
        const message = await sendMessageSlack(preparedTarget.to, pendingContent.text, {
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
          threadTs: preparedTarget.threadTs,
          blocks: pendingContent.blocks,
          client: this.opts.app.client,
        });
        return {
          channelId: message.channelId,
          messageTs: message.messageId,
        };
      },
      onOriginNoticeError: ({ error }) => {
        logError(`slack exec approvals: failed to send DM redirect notice: ${String(error)}`);
      },
      onDeliveryError: ({ error, request }) => {
        logError(
          `slack exec approvals: failed to deliver approval ${request.id}: ${String(error)}`,
        );
      },
      finalizeResolved: async ({ request, resolved, entries }) => {
        await this.finalizeResolved(request, resolved, entries);
      },
      finalizeExpired: async ({ request, entries }) => {
        await this.finalizeExpired(request, entries);
      },
    });
  }

  shouldHandle(request: ExecApprovalRequest): boolean {
    return shouldHandleSlackExecApprovalRequest({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      request,
    })
      ? slackNativeApprovalAdapter.native?.describeDeliveryCapabilities({
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
          approvalKind: "exec",
          request,
        }).enabled === true
      : false;
  }

  async start(): Promise<void> {
    await this.runtime.start();
  }

  async stop(): Promise<void> {
    await this.runtime.stop();
  }

  async handleApprovalRequested(request: ExecApprovalRequest): Promise<void> {
    await this.runtime.handleRequested(request);
  }

  async handleApprovalResolved(resolved: ExecApprovalResolved): Promise<void> {
    await this.runtime.handleResolved(resolved);
  }

  async handleApprovalTimeout(approvalId: string): Promise<void> {
    await this.runtime.handleExpired(approvalId);
  }

  private async finalizeResolved(
    request: ExecApprovalRequest,
    resolved: ExecApprovalResolved,
    entries: SlackPendingApproval[],
  ): Promise<void> {
    const text = buildSlackResolvedText({
      request,
      decision: resolved.decision,
      resolvedBy: resolved.resolvedBy,
    });
    const blocks = buildSlackResolvedBlocks({
      request,
      decision: resolved.decision,
      resolvedBy: resolved.resolvedBy,
    });
    for (const entry of entries) {
      await this.updateMessage({
        channelId: entry.channelId,
        messageTs: entry.messageTs,
        text,
        blocks,
      });
    }
  }

  private async finalizeExpired(
    request: ExecApprovalRequest,
    entries: SlackPendingApproval[],
  ): Promise<void> {
    const blocks = buildSlackExpiredBlocks(request);
    const text = buildSlackExpiredText(request);
    for (const entry of entries) {
      await this.updateMessage({
        channelId: entry.channelId,
        messageTs: entry.messageTs,
        text,
        blocks,
      });
    }
  }

  private async updateMessage(params: {
    channelId: string;
    messageTs: string;
    text: string;
    blocks: SlackBlock[];
  }): Promise<void> {
    try {
      await this.opts.app.client.chat.update({
        channel: params.channelId,
        ts: params.messageTs,
        text: params.text,
        blocks: params.blocks,
      });
    } catch (err) {
      logError(`slack exec approvals: failed to update message: ${String(err)}`);
    }
  }
}
