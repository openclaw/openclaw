// Discord plugin module implements self-reply context policy for sent bot messages.
import { listMessageReceiptPlatformIds } from "openclaw/plugin-sdk/channel-outbound";
import type { MessageReceipt } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

type DiscordSelfReplyContextDeliveryResult = {
  messageId?: string;
  receipt?: MessageReceipt;
};

const OPENCLAW_CHANNEL_DATA_KEY = "openclaw";
const REPLY_CONTEXT_POLICY_KEY = "replyContext";
const MAX_RECORDED_REPLY_CONTEXT_MESSAGES = 1000;
const preservedSelfQuoteBodyMessageIds = new Set<string>();

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function shouldPreservePayloadSelfQuoteBody(payload: Pick<ReplyPayload, "channelData">): boolean {
  const channelData = readRecord(payload.channelData);
  const openclawData = readRecord(channelData?.[OPENCLAW_CHANNEL_DATA_KEY]);
  const replyContext = readRecord(openclawData?.[REPLY_CONTEXT_POLICY_KEY]);
  return replyContext?.preserveSelfQuoteBody === true;
}

function rememberMessageId(messageId: string | undefined): void {
  const normalized = messageId?.trim();
  if (!normalized || normalized === "unknown") {
    return;
  }
  if (preservedSelfQuoteBodyMessageIds.size >= MAX_RECORDED_REPLY_CONTEXT_MESSAGES) {
    const oldest = preservedSelfQuoteBodyMessageIds.values().next().value;
    if (oldest) {
      preservedSelfQuoteBodyMessageIds.delete(oldest);
    }
  }
  preservedSelfQuoteBodyMessageIds.add(normalized);
}

export function recordDiscordSelfReplyContextPolicy(params: {
  payload: Pick<ReplyPayload, "channelData">;
  results: readonly DiscordSelfReplyContextDeliveryResult[];
}): void {
  if (!shouldPreservePayloadSelfQuoteBody(params.payload)) {
    return;
  }
  for (const result of params.results) {
    rememberMessageId(result.messageId);
    if (result.receipt) {
      for (const messageId of listMessageReceiptPlatformIds(result.receipt)) {
        rememberMessageId(messageId);
      }
    }
  }
}

export function shouldPreserveDiscordSelfReplyBody(messageId: string | undefined): boolean {
  const normalized = messageId?.trim();
  return Boolean(normalized && preservedSelfQuoteBodyMessageIds.has(normalized));
}

export function resetDiscordSelfReplyContextPolicyForTest(): void {
  preservedSelfQuoteBodyMessageIds.clear();
}
