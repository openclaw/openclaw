import { AgentMailError, type AgentMail, type AgentMailClient } from "agentmail";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { htmlToMarkdown, markdownToText } from "openclaw/plugin-sdk/web-content-extractor";
import { createAgentMailClient } from "./client.js";
import { isAgentMailSenderAllowed, parseSingleFromMailbox } from "./mailbox.js";
import { AgentMailMediaPolicyError, loadAgentMailInboundAttachments } from "./media.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const CHANNEL_ID = "agentmail";
const HYDRATION_NOT_FOUND_RETRY_WINDOW_MS = 5 * 60_000;

type AgentMailLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type AgentMailChannelRuntime = Pick<
  PluginRuntime["channel"],
  "inbound" | "reply" | "routing" | "session"
>;

export function resolveAgentMailMessageText(message: AgentMail.Message): string {
  // AgentMail strips quoted reply/forward history in the extracted fields. Prefer those fields
  // so an email thread does not re-inject its accumulated transcript into every agent turn.
  const extractedText = message.extractedText?.trim();
  if (extractedText) {
    return extractedText;
  }
  const extractedHtml = message.extractedHtml?.trim();
  const extractedHtmlText = extractedHtml
    ? markdownToText(htmlToMarkdown(extractedHtml).text).trim()
    : "";
  if (extractedHtmlText) {
    return extractedHtmlText;
  }
  const text = message.text?.trim();
  if (text) {
    return text;
  }
  const html = message.html?.trim();
  const htmlText = html ? markdownToText(htmlToMarkdown(html).text).trim() : "";
  return htmlText || message.subject?.trim() || "";
}

function hasRejectedLabel(message: AgentMail.Message): boolean {
  const labels = message.labels.map((label) => label.toLocaleLowerCase("en-US"));
  return labels.some((label) => ["spam", "blocked", "unauthenticated"].includes(label));
}

function hasReceivedLabel(message: AgentMail.Message): boolean {
  return message.labels.some((label) => label.toLocaleLowerCase("en-US") === "received");
}

async function hydrateMessage(params: {
  account: ResolvedAgentMailAccount;
  record: AgentMailIngressRecord;
  client: AgentMailClient;
}): Promise<AgentMail.Message> {
  const message = await params.client.inboxes.messages.get(
    params.account.inboxId,
    params.record.messageId,
  );
  return message;
}

export async function dispatchAgentMailInboundEvent(params: {
  cfg: OpenClawConfig;
  account: ResolvedAgentMailAccount;
  record: AgentMailIngressRecord;
  channelRuntime: AgentMailChannelRuntime;
  client?: AgentMailClient;
  log?: AgentMailLog;
  onTurnAdopted?: () => void | Promise<void>;
  now?: () => number;
}): Promise<void> {
  const client = params.client ?? createAgentMailClient(params.account);
  let message: AgentMail.Message;
  try {
    message = await hydrateMessage({
      account: params.account,
      record: params.record,
      client,
    });
  } catch (error) {
    if (error instanceof AgentMailError && error.statusCode === 404) {
      const ageMs = Math.max(0, (params.now?.() ?? Date.now()) - params.record.receivedAt);
      if (ageMs >= HYDRATION_NOT_FOUND_RETRY_WINDOW_MS) {
        params.log?.warn?.(
          `AgentMail ignored unavailable message ${params.record.messageId} after the hydration retry window`,
        );
        return;
      }
      // A receive event can race the provider's REST projection. Keep the durable row pending
      // during a bounded window; treating the first 404 as deletion can permanently lose mail.
      throw error;
    }
    throw error;
  }
  if (
    message.inboxId !== params.account.inboxId ||
    message.messageId !== params.record.messageId ||
    !hasReceivedLabel(message) ||
    hasRejectedLabel(message)
  ) {
    params.log?.warn?.(
      `AgentMail rejected mismatched or unsafe hydrated message ${params.record.messageId}`,
    );
    return;
  }
  const sender = parseSingleFromMailbox(message.from);
  if (!sender) {
    params.log?.warn?.(
      `AgentMail rejected message ${message.messageId} with an ambiguous From mailbox`,
    );
    return;
  }
  if (
    !isAgentMailSenderAllowed({
      policy: params.account.dmPolicy,
      allowFrom: params.account.allowFrom,
      sender: sender.address,
    })
  ) {
    params.log?.warn?.(`AgentMail sender ${sender.address} is not authorized`);
    return;
  }

  let inboundMedia;
  let attachmentsOmitted = false;
  try {
    inboundMedia = await loadAgentMailInboundAttachments({
      client,
      inboxId: params.account.inboxId,
      messageId: message.messageId,
      attachments: message.attachments ?? [],
      maxBytes: params.account.mediaMaxBytes,
    });
  } catch (error) {
    if (error instanceof AgentMailMediaPolicyError) {
      params.log?.warn?.(
        `AgentMail omitted attachments from message ${message.messageId}: ${error.message}`,
      );
      inboundMedia = { paths: [], types: [] };
      attachmentsOmitted = true;
    } else {
      throw error;
    }
  }
  const content =
    resolveAgentMailMessageText(message) ||
    (inboundMedia.paths.length > 0 ? "[Email with attachments]" : "");
  const attachmentNotice = attachmentsOmitted
    ? "[Attachments omitted because they exceed the configured media limit]"
    : "";
  const body = [content, attachmentNotice].filter(Boolean).join("\n\n");
  if (!body) {
    params.log?.warn?.(`AgentMail ignored empty message ${message.messageId}`);
    return;
  }
  const conversationId = `${params.account.inboxId}:thread:${message.threadId}`;
  const route = params.channelRuntime.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: { kind: "direct", id: conversationId },
  });
  const sessionKey = params.channelRuntime.routing.buildAgentSessionKey({
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: { kind: "direct", id: conversationId },
    // Email threads must remain isolated even when the global DM scope collapses direct chats.
    dmScope: "per-account-channel-peer",
  });

  await params.channelRuntime.inbound.run({
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    raw: message,
    ...(params.onTurnAdopted ? { onTurnAdopted: params.onTurnAdopted } : {}),
    adapter: {
      ingest: (raw) => ({
        id: raw.messageId,
        timestamp: raw.timestamp.getTime(),
        rawText: body,
        textForAgent: body,
        textForCommands: body,
        raw,
      }),
      resolveTurn: async (input) => {
        const target = `message:${message.messageId}`;
        const ctxPayload = params.channelRuntime.inbound.buildContext({
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          timestamp: input.timestamp,
          from: `agentmail:${sender.address}`,
          sender: { id: sender.address, name: sender.name ?? sender.address },
          conversation: {
            kind: "direct",
            id: conversationId,
            label: message.subject || sender.address,
          },
          route: {
            agentId: route.agentId,
            accountId: params.account.accountId,
            routeSessionKey: sessionKey,
            dispatchSessionKey: sessionKey,
          },
          reply: { to: target, replyToId: message.messageId },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
          extra: {
            MessageSid: message.messageId,
            MessageThreadId: message.threadId,
            MediaPath: inboundMedia.paths[0],
            MediaPaths: inboundMedia.paths,
            MediaType: inboundMedia.types[0],
            MediaTypes: inboundMedia.types,
          },
        });
        const storePath = params.channelRuntime.session.resolveStorePath(
          params.cfg.session?.store,
          {
            agentId: route.agentId,
          },
        );
        return {
          cfg: params.cfg,
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          agentId: route.agentId,
          routeSessionKey: sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: params.channelRuntime.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            params.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            durable: () => ({
              to: target,
              replyToId: message.messageId,
              threadId: message.threadId,
              requiredCapabilities: {
                text: true,
                media: inboundMedia.paths.length > 0,
                payload: true,
                replyTo: true,
                thread: true,
                messageSendingHooks: true,
                reconcileUnknownSend: true,
              },
            }),
            deliver: async () => {
              throw new Error("AgentMail requires durable reply delivery");
            },
          },
          // AgentMail owns one durable atomic reply. Message-tool delivery is best-effort and
          // cannot carry the queue id used for the provider idempotency key.
          replyOptions: { disableBlockStreaming: true, sourceReplyDeliveryMode: "automatic" },
        };
      },
    },
  });
}
