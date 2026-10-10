import type { App } from "@slack/bolt";
import type { Block, KnownBlock, WebClient } from "@slack/web-api";
import {
  createChannelApprovalNativeRuntimeAdapter,
  type ChannelApprovalCapabilityHandlerContext,
  type ExpiredApprovalView,
  type PendingApprovalView,
  type ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import { buildApprovalPresentationFromActionDescriptors } from "openclaw/plugin-sdk/approval-reply-runtime";
import { formatChannelApprovalResolvedLabel } from "openclaw/plugin-sdk/approval-runtime";
import { logError } from "openclaw/plugin-sdk/logging-core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { SLACK_APPROVAL_HEADER_BLOCK_ID } from "./approval-actions.js";
import { runSlackApprovalMessageUpdate } from "./approval-message-updates.js";
import {
  isSlackAnyNativeApprovalClientEnabled,
  shouldHandleSlackNativeApprovalRequest,
} from "./approval-native-gates.js";
import { getSlackListenerWriteClient } from "./client.js";
import { normalizeSlackApproverId } from "./exec-approvals.js";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "./limits.js";
import { resolveSlackReplyBlocks } from "./reply-blocks.js";
import { sendMessageSlack } from "./send.js";
import { setSlackSessionStatus } from "./session-status.js";
import { parseSlackTarget } from "./target-parsing.js";
import { truncateSlackText, truncateSlackTextByUtf8Bytes } from "./truncate.js";

type SlackBlock = Block | KnownBlock;
type SlackPendingApproval = {
  channelId: string;
  messageTs: string;
  threadTs?: string;
  teamId?: string;
};
type SlackPendingDelivery = {
  text: string;
  blocks: SlackBlock[];
};
const SLACK_CONTEXT_ELEMENTS_MAX = 10;
const SLACK_TEXT_OBJECT_MAX = 3000;

type SlackApprovalHandlerContext = {
  app: App;
  resolveClient?: (teamId?: string) => WebClient | undefined;
  workspaceTeamId?: string;
  enterprise?: {
    enterpriseId: string;
  };
};

function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  accountId: string;
  context: SlackApprovalHandlerContext;
} | null {
  const context = params.context as SlackApprovalHandlerContext | undefined;
  const accountId = normalizeOptionalString(params.accountId) ?? "";
  if (!context?.app || !accountId) {
    return null;
  }
  return { accountId, context };
}

function truncateSlackMrkdwn(text: string, maxChars: number): string {
  return truncateSlackText(text, Math.max(0, Math.floor(maxChars)), "preserve");
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
  const trimmed = normalizeOptionalString(resolvedBy);
  return trimmed ? trimmed : null;
}

function buildSlackMetadataContextBlock(lines: readonly string[]): SlackBlock | undefined {
  const visibleLineCount =
    lines.length > SLACK_CONTEXT_ELEMENTS_MAX ? SLACK_CONTEXT_ELEMENTS_MAX - 1 : lines.length;
  const elements = lines.slice(0, visibleLineCount).map((line) => ({
    type: "mrkdwn" as const,
    text: truncateSlackMrkdwn(line, SLACK_TEXT_OBJECT_MAX),
  }));
  if (lines.length > SLACK_CONTEXT_ELEMENTS_MAX) {
    elements.push({
      type: "mrkdwn",
      text: `…+${lines.length - visibleLineCount} more`,
    });
  }
  return elements.length > 0 ? { type: "context", elements } : undefined;
}

type SlackApprovalRenderInput =
  | { phase: "pending"; view: PendingApprovalView }
  | { phase: "resolved"; view: ResolvedApprovalView }
  | { phase: "expired"; view: ExpiredApprovalView };

function buildSlackApprovalSection(text: string, blockId?: string): SlackBlock {
  return {
    type: "section",
    ...(blockId ? { block_id: blockId } : {}),
    text: { type: "mrkdwn", text },
  };
}

function buildSlackApprovalPayload(input: SlackApprovalRenderInput): SlackPendingDelivery {
  const { phase, view } = input;
  const isPlugin = view.approvalKind === "plugin";
  const isSystemAgent = view.approvalKind === "system-agent";
  const approvalName = isPlugin ? "Plugin" : isSystemAgent ? "OpenClaw change" : "Exec";
  let heading: string;
  let description: string;
  if (phase === "pending") {
    heading = `*${approvalName} approval required*`;
    description =
      view.approvalKind === "plugin"
        ? (normalizeOptionalString(view.description) ?? "A plugin action needs your approval.")
        : isSystemAgent
          ? "An OpenClaw change needs your approval."
          : "A command needs your approval.";
  } else if (phase === "resolved") {
    const decisionLabel = formatChannelApprovalResolvedLabel(view);
    heading = `*${approvalName} approval: ${decisionLabel}*`;
    const resolvedBy = formatSlackApprover(view.resolvedBy);
    description = resolvedBy ? `Resolved by ${resolvedBy}.` : "Resolved.";
  } else {
    heading = `*${approvalName} approval expired*`;
    description = "This approval request expired before it was resolved.";
  }

  const metadata = isPlugin
    ? [{ label: "Approval ID", value: view.approvalId }, ...view.metadata]
    : view.metadata;
  const bodyLabel = isPlugin ? "*Request*" : isSystemAgent ? "*Change*" : "*Command*";
  const bodyText = isPlugin ? view.title : view.commandText;
  const renderBody = (text: string) => (isPlugin ? text : buildSlackCodeBlock(text));
  const includeMetadata = isPlugin || phase === "pending";
  const metadataLines = includeMetadata
    ? metadata.map(({ label, value }) => `*${label}:* ${value}`)
    : [];
  const text = [heading, description, "", bodyLabel, renderBody(bodyText), ...metadataLines].join(
    "\n",
  );

  const headerDescription =
    isPlugin && phase === "pending" ? truncateSlackMrkdwn(description, 2600) : description;
  const blocks: SlackBlock[] = [
    buildSlackApprovalSection(
      `${heading}\n${headerDescription}`,
      phase === "pending" ? SLACK_APPROVAL_HEADER_BLOCK_ID : undefined,
    ),
    buildSlackApprovalSection(`${bodyLabel}\n${renderBody(truncateSlackMrkdwn(bodyText, 2600))}`),
  ];
  const metadataBlock = buildSlackMetadataContextBlock(metadataLines);
  if (metadataBlock) {
    blocks.push(metadataBlock);
  }
  if (phase === "pending") {
    blocks.push(
      ...(resolveSlackReplyBlocks({
        text: "",
        presentation: buildApprovalPresentationFromActionDescriptors(view.actions),
      }) ?? []),
    );
  }
  return { text, blocks };
}

async function updateMessage(
  client: WebClient,
  accountId: string,
  { channelId, messageTs }: SlackPendingApproval,
  { text, blocks }: SlackPendingDelivery,
): Promise<void> {
  try {
    await runSlackApprovalMessageUpdate({ accountId, channelId, messageTs }, () =>
      client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: truncateSlackTextByUtf8Bytes(text, SLACK_EDIT_TEXT_MAX_BYTES),
        blocks,
      }),
    );
  } catch (err) {
    logError(`slack approvals: failed to update message: ${String(err)}`);
  }
}

export const slackApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  SlackPendingDelivery,
  { to: string; threadTs?: string; teamId?: string },
  SlackPendingApproval,
  never,
  SlackPendingDelivery
>({
  eventKinds: ["exec", "plugin", "system-agent"],
  availability: {
    isConfigured: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? isSlackAnyNativeApprovalClientEnabled({
            cfg: params.cfg,
            accountId: resolved.accountId,
          })
        : false;
    },
    shouldHandle: (params) => {
      const resolved = resolveHandlerContext(params);
      if (!resolved) {
        return false;
      }
      return shouldHandleSlackNativeApprovalRequest({
        cfg: params.cfg,
        accountId: resolved.accountId,
        approvalKind: params.approvalKind,
        request: params.request,
      });
    },
  },
  presentation: {
    buildPendingPayload: ({ view }) => buildSlackApprovalPayload({ phase: "pending", view }),
    buildResolvedResult: ({ view }) => ({
      kind: "update",
      payload: buildSlackApprovalPayload({ phase: "resolved", view }),
    }),
    buildExpiredResult: ({ view }) => ({
      kind: "update",
      payload: buildSlackApprovalPayload({ phase: "expired", view }),
    }),
  },
  transport: {
    prepareTarget: ({ plannedTarget }) => {
      const parsed = parseSlackTarget(plannedTarget.target.to, {
        defaultKind: "channel",
      });
      if (!parsed) {
        throw new Error("Slack approval delivery target is missing");
      }
      return {
        dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
        target: {
          to: `${parsed.kind}:${parsed.id}`,
          threadTs:
            plannedTarget.target.threadId != null
              ? String(plannedTarget.target.threadId)
              : undefined,
          teamId: parsed.teamId,
        },
      };
    },
    deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return null;
      }
      const client = resolveApprovalClient(resolved.context, preparedTarget.teamId);
      const to = await resolveApprovalChannel(client, preparedTarget.to, preparedTarget.teamId);
      const eventScope = preparedTarget.teamId
        ? {
            teamId: preparedTarget.teamId,
            client,
            writeClient: getSlackListenerWriteClient({
              listenerClient: client,
              teamId: preparedTarget.teamId,
              clientOptions: resolved.context.app.webClientOptions,
            }),
          }
        : undefined;
      const message = await sendMessageSlack(to, pendingPayload.text, {
        cfg,
        accountId: resolved.accountId,
        threadTs: preparedTarget.threadTs,
        blocks: pendingPayload.blocks,
        client,
        eventScope,
      });
      await setSlackSessionStatus({
        client,
        channelId: message.channelId,
        threadTs: preparedTarget.threadTs,
        status: "suspended",
      });
      return {
        channelId: message.channelId,
        messageTs: message.messageId,
        threadTs: preparedTarget.threadTs,
        teamId: preparedTarget.teamId,
      };
    },
    updateEntry: async ({ cfg, accountId, context, entry, payload, phase }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return;
      }
      const client = resolveApprovalClient(resolved.context, entry.teamId);
      await updateMessage(client, resolved.accountId, entry, payload);
      await setSlackSessionStatus({
        client,
        channelId: entry.channelId,
        threadTs: entry.threadTs,
        status: phase === "resolved" ? "processing" : "active",
      });
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      logError(`slack approvals: failed to deliver approval ${request.id}: ${String(error)}`);
    },
  },
});

function resolveApprovalClient(context: SlackApprovalHandlerContext, teamId?: string): WebClient {
  if (!teamId) {
    return context.app.client;
  }
  if (!context.enterprise) {
    if (
      !context.workspaceTeamId ||
      context.workspaceTeamId.toUpperCase() !== teamId.toUpperCase()
    ) {
      throw new Error("Slack approval workspace does not match the authenticated installation");
    }
    return context.app.client;
  }
  const client = context.resolveClient?.(teamId);
  if (!client) {
    throw new Error("Slack Enterprise Grid approval client is unavailable");
  }
  return client;
}

async function resolveApprovalChannel(client: WebClient, target: string, teamId?: string) {
  if (!teamId) {
    return target;
  }
  const parsed = parseSlackTarget(target, { defaultKind: "channel" });
  if (!parsed) {
    throw new Error("Slack approval delivery target is missing");
  }
  if (parsed.kind === "channel") {
    return `channel:${parsed.id}`;
  }
  const opened = await client.conversations.open({ users: parsed.id, return_im: true });
  const channelId = normalizeOptionalString(opened.channel?.id);
  if (!channelId) {
    throw new Error("Slack approval DM did not return a channel id");
  }
  return `channel:${channelId}`;
}
