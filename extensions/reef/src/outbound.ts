import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  ChannelOutboundAdapter,
  OutboundDeliveryResult,
} from "openclaw/plugin-sdk/channel-send-result";
import { canonicalBytes, REEF_MAX_PLAINTEXT_BYTES } from "../protocol/index.js";
import { normalizeReefTarget } from "./config-schema.js";
import { prepareReefMessageId } from "./flow.js";
import { getActiveReef } from "./runtime.js";

const MAX_REEF_BODY_ID = "0".repeat(26);

function reefChunkFits(text: string, maxBytes: number): boolean {
  // Reserve both optional ids so the same chunk is valid with replies and threads.
  return (
    canonicalBytes({ text, replyTo: MAX_REEF_BODY_ID, thread: MAX_REEF_BODY_ID }).length <= maxBytes
  );
}

function chunkReefText(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }
  const maxBytes = Math.min(Math.max(1, limit), REEF_MAX_PLAINTEXT_BYTES);
  const boundaries = [0];
  for (let offset = 0; offset < text.length;) {
    const codePoint = text.codePointAt(offset);
    offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    boundaries.push(offset);
  }
  const chunks: string[] = [];
  let startIndex = 0;
  while (startIndex < boundaries.length - 1) {
    const start = boundaries[startIndex] ?? 0;
    if (text.length - start <= maxBytes && reefChunkFits(text.slice(start), maxBytes)) {
      chunks.push(text.slice(start));
      break;
    }
    let low = startIndex + 1;
    // Every complete code point costs at least one canonical byte, so no fitting
    // chunk can extend past this bounded search window.
    let high = Math.min(boundaries.length - 1, startIndex + maxBytes);
    let bestIndex = startIndex;
    while (low <= high) {
      const candidateIndex = Math.floor((low + high) / 2);
      const candidate = boundaries[candidateIndex] ?? start;
      if (reefChunkFits(text.slice(start, candidate), maxBytes)) {
        bestIndex = candidateIndex;
        low = candidateIndex + 1;
      } else {
        high = candidateIndex - 1;
      }
    }
    if (bestIndex === startIndex) {
      throw new Error("Reef message contains an unsplittable plaintext unit");
    }
    const end = boundaries[bestIndex] ?? start;
    chunks.push(text.slice(start, end));
    startIndex = bestIndex;
  }
  return chunks;
}

async function send(
  to: string,
  text: string,
  threadId?: string | number | null,
  replyToId?: string | null,
  preparedMessageId?: string,
): Promise<OutboundDeliveryResult> {
  const peer = normalizeReefTarget(to);
  if (!peer) {
    throw new Error("Reef target must be a handle");
  }
  if (
    preparedMessageId &&
    canonicalBytes({
      text,
      ...(threadId != null ? { thread: String(threadId) } : {}),
      ...(replyToId ? { replyTo: replyToId } : {}),
    }).length > REEF_MAX_PLAINTEXT_BYTES
  ) {
    // Correlated turns cannot be split after reserving one transport id. Check
    // here so response prefixes and other send-time transforms are included.
    throw new Error("Reef conversation turn exceeds the 32 KiB atomic message limit");
  }
  const id = await getActiveReef().flow.send(peer, text, {
    ...(threadId != null ? { thread: String(threadId) } : {}),
    ...(replyToId ? { replyTo: replyToId } : {}),
    ...(preparedMessageId ? { messageId: preparedMessageId } : {}),
  });
  return { channel: "reef", messageId: id, chatId: peer, toJid: `reef:${peer}` };
}

export const reefOutboundAdapter: ChannelOutboundAdapter = {
  // The encrypted flow belongs to the Gateway account lifecycle; other processes must delegate.
  deliveryMode: "gateway",
  textChunkLimit: REEF_MAX_PLAINTEXT_BYTES,
  chunker: chunkReefText,
  prepareConversationTurnMessageId: () => prepareReefMessageId(),
  deliveryCapabilities: { durableFinal: { text: true, replyTo: true, thread: true } },
  resolveTarget: ({ to }) => {
    const peer = normalizeReefTarget(to ?? "");
    return peer
      ? { ok: true, to: peer }
      : { ok: false, error: new Error("Reef target must be a handle") };
  },
  sendText: async ({ to, text, threadId, replyToId, preparedMessageId }) =>
    await send(to, text, threadId, replyToId, preparedMessageId),
};

export const reefMessageAdapter = defineChannelMessageAdapter({
  id: "reef",
  durableFinal: { capabilities: { text: true, replyTo: true, thread: true } },
  send: {
    text: async (ctx) => {
      const result = await send(
        ctx.to,
        ctx.text,
        ctx.threadId,
        ctx.replyToId,
        ctx.preparedMessageId,
      );
      const receipt = createMessageReceiptFromOutboundResults({
        results: [result],
        kind: "text",
        ...(ctx.threadId != null ? { threadId: String(ctx.threadId) } : {}),
        ...(ctx.replyToId ? { replyToId: ctx.replyToId } : {}),
      });
      return { receipt, messageId: result.messageId };
    },
  },
  receive: {
    defaultAckPolicy: "after_receive_record",
    supportedAckPolicies: ["after_receive_record"],
  },
});
