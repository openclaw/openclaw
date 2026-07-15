import { AgentMailError, type AgentMail, type AgentMailClient } from "agentmail";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { htmlToMarkdown, markdownToText } from "openclaw/plugin-sdk/web-content-extractor";
import { createAgentMailClient } from "./client.js";
import { isAgentMailSenderAllowed, parseSingleFromMailbox } from "./mailbox.js";
import { AgentMailMediaPolicyError, loadAgentMailInboundAttachments } from "./media.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const CHANNEL_ID = "agentmail";

type AgentMailLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type AgentMailChannelRuntime = Pick<
  PluginRuntime["channel"],
  "inbound" | "reply" | "routing" | "session"
>;

export function resolveAgentMailMessageText(message: AgentMail.Message): string {
  const plain = message.text?.trim() || message.extractedText?.trim();
  if (plain) {
    return plain;
  }
  const html = message.html?.trim() || message.extractedHtml?.trim();
  return html ? markdownToText(htmlToMarkdown(html).text).trim() : "";
}

function hasRejectedLabel(message: AgentMail.Message): boolean {
  const labels = message.labels.map((label) => label.toLocaleLowerCase("en-US"));
  return labels.some((label) => ["spam", "blocked", "unauthenticated"].includes(label));
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
      params.log?.warn?.(`AgentMail ignored deleted message ${params.record.messageId}`);
      return;
    }
    throw error;
  }
  if (
    message.inboxId !== params.account.inboxId ||
    message.messageId !== params.record.messageId ||
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
      params.log?.warn?.(`AgentMail rejected message ${message.messageId}: ${error.message}`);
      return;
    }
    throw error;
  }
  const body =
    resolveAgentMailMessageText(message) ||
    (inboundMedia.paths.length > 0 ? "[Email with attachments]" : "");
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
