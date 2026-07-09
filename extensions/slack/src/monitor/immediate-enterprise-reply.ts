// Slack plugin module owns listener-scoped Enterprise Grid reply delivery.
import type { MessageMetadata } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildSlackBlocksFallbackText } from "../blocks-fallback.js";
import { postSlackMessageBestEffort, uploadSlackFile } from "../client-delivery.js";
import { SLACK_TEXT_LIMIT } from "../limits.js";
import { resolveSlackTextChunks } from "../slack-text-chunks.js";
import { truncateSlackText } from "../truncate.js";
import type { SlackEventScope } from "./event-scope.js";
import type { SlackSendIdentity, SlackSendResult } from "./send.runtime.js";

function resolveImmediateEnterpriseTarget(target: string): string {
  const match = /^(?:channel:)?([CDG][A-Z0-9]+)$/i.exec(target.trim());
  if (!match?.[1]) {
    throw new Error("unsupported_enterprise_slack_delivery_target");
  }
  return match[1];
}

/** Monitor-private sender. The validated Bolt client never leaves the listener-owned stack. */
export async function sendImmediateEnterpriseSlackReply(
  scope: SlackEventScope,
  params: {
    target: string;
    text: string;
    threadTs?: string | undefined;
    mediaUrl?: string | undefined;
    blocks?: (Block | KnownBlock)[] | undefined;
    metadata?: MessageMetadata | undefined;
    identity?: SlackSendIdentity | undefined;
    cfg: OpenClawConfig;
    accountId?: string | undefined;
    textLimit: number;
    mediaMaxBytes?: number | undefined;
    unfurlMedia?: boolean | undefined;
  },
): Promise<SlackSendResult> {
  const channelId = resolveImmediateEnterpriseTarget(params.target);
  if (params.mediaUrl && params.blocks?.length) {
    throw new Error("Slack send does not support blocks with mediaUrl");
  }

  const textChunks = params.blocks?.length
    ? [
        truncateSlackText(
          params.text || buildSlackBlocksFallbackText(params.blocks),
          SLACK_TEXT_LIMIT,
        ),
      ]
    : resolveSlackTextChunks({
        cfg: params.cfg,
        ...(params.accountId ? { accountId: params.accountId } : {}),
        text: params.text,
        textLimit: params.textLimit,
      });
  const chunksToPost = textChunks.length ? textChunks : [""];
  const platformResults: Array<{ channel: "slack"; messageId: string; channelId: string }> = [];
  let deliveredChannelId = channelId;
  let lastMessageId = "";
  let remainingChunks = chunksToPost;

  if (params.mediaUrl) {
    const [caption, ...rest] = chunksToPost;
    const fileId = await uploadSlackFile({
      client: scope.client,
      channelId,
      mediaUrl: params.mediaUrl,
      caption,
      threadTs: params.threadTs,
      maxBytes: params.mediaMaxBytes,
      auditContext: "slack-enterprise-immediate-upload",
    });
    lastMessageId = fileId;
    platformResults.push({ channel: "slack", messageId: fileId, channelId });
    remainingChunks = rest;
  }

  let sendIdentity = params.identity;
  for (const [index, chunk] of remainingChunks.entries()) {
    const posted = await postSlackMessageBestEffort({
      client: scope.client,
      channelId,
      text: chunk,
      threadTs: params.threadTs,
      identity: sendIdentity,
      ...(params.blocks?.length ? { blocks: params.blocks } : {}),
      ...(!params.mediaUrl && index === 0 && params.metadata ? { metadata: params.metadata } : {}),
      unfurl: {
        unfurlMedia: params.unfurlMedia,
      },
    });
    sendIdentity = posted.identity;
    const response = posted.response;
    if (!response.ok) {
      throw new Error(`Slack chat.postMessage failed: ${response.error ?? "unknown error"}`);
    }
    if (!response.ts) {
      throw new Error("Slack chat.postMessage returned no message timestamp");
    }
    lastMessageId = response.ts;
    deliveredChannelId =
      typeof response.channel === "string" ? response.channel : deliveredChannelId;
    platformResults.push({
      channel: "slack",
      messageId: response.ts,
      channelId: deliveredChannelId,
    });
  }

  return {
    messageId: lastMessageId,
    channelId: deliveredChannelId,
    ...(params.threadTs ? { threadTs: params.threadTs } : {}),
    receipt: createMessageReceiptFromOutboundResults({
      results: platformResults,
      kind: params.mediaUrl ? "media" : params.blocks?.length ? "card" : "text",
      threadId: params.threadTs,
    }),
  };
}
