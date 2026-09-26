import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
// Feishu plugin module shapes outbound send results and their partial failures.
import type { ChannelOutboundAdapter } from "../runtime-api.js";
import {
  createFeishuPartialReplyDeliveryError,
  createFeishuReplyDeliveryResult,
  type FeishuReplyDeliverySource,
} from "./reply-delivery-result.js";

export const FEISHU_TEXT_CHUNK_LIMIT = 4000;

export type FeishuSendTextContext = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];

export function toFeishuOutboundResult<T extends { chatId: string }>(result: T) {
  const { chatId, ...delivery } = result;
  return { ...delivery, target: { kind: "chat" as const, id: chatId } };
}

export async function reportFeishuOutboundDelivery<T extends { messageId: string; chatId: string }>(
  result: T,
  onDeliveryResult: FeishuSendTextContext["onDeliveryResult"],
): Promise<T> {
  await onDeliveryResult?.(attachChannelToResult("feishu", toFeishuOutboundResult(result)));
  return result;
}

export function aggregateFeishuSendResult<T extends FeishuReplyDeliverySource>(
  result: T,
  results: readonly FeishuReplyDeliverySource[],
) {
  return {
    ...result,
    receipt: {
      ...createMessageReceiptFromOutboundResults({ results }),
      // Keep the established edit/reply target while retaining every physical send.
      primaryPlatformMessageId: result.messageId,
    },
  };
}

export function partialFeishuSendError(
  error: unknown,
  results: readonly FeishuReplyDeliverySource[],
  acceptedContent?: string,
) {
  if (results.length === 0 && error instanceof Error) {
    return error;
  }
  const accepted = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
  return createFeishuPartialReplyDeliveryError(error, {
    ...accepted,
    ...createFeishuReplyDeliveryResult({
      results: [...results, accepted],
      visibleReplySent: results.length > 0 || accepted !== undefined,
    }),
    ...(acceptedContent ? { content: acceptedContent } : {}),
  });
}
