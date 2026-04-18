import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { findCodeRegions, isInsideCode } from "openclaw/plugin-sdk/text-runtime";
import type { createIMessageRpcClient } from "../client.js";
import { sendMessageIMessage } from "../send.js";
import {
  convertMarkdownTables,
  loadConfig,
  resolveMarkdownTableMode,
} from "./deliver.runtime.js";
import type { SentMessageCache } from "./echo-cache.js";
import { normalizeIMessageDeliveryText } from "./sanitize-outbound.js";

function findSafeChunkBoundary(text: string, limit: number): number {
  if (limit <= 0 || text.length <= limit) {
    return text.length;
  }
  const codeRegions = findCodeRegions(text);
  const preferredNeedles = ["\n\n", "\n", ". ", "! ", "? ", ", ", " "];
  for (const needle of preferredNeedles) {
    let searchFrom = Math.min(limit, text.length);
    for (;;) {
      const start = text.lastIndexOf(needle, searchFrom);
      if (start < 0) {
        break;
      }
      const boundary = start + needle.length;
      if (boundary > 0 && !isInsideCode(Math.max(0, boundary - 1), codeRegions)) {
        return boundary;
      }
      searchFrom = start - 1;
    }
  }
  return limit;
}

function splitIMessageTextSafely(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit && limit > 0) {
    const boundary = findSafeChunkBoundary(remaining, limit);
    const next = remaining.slice(0, boundary).trim();
    if (next) {
      chunks.push(next);
    }
    remaining = remaining.slice(Math.max(1, boundary)).trimStart();
  }
  if (remaining) {
    chunks.push(remaining.trim());
  }
  return chunks.filter(Boolean);
}

function chunkIMessageText(text: string, limit: number): string[] {
  const normalized = normalizeIMessageDeliveryText(text ?? "");
  if (!normalized) {
    return [];
  }
  if (limit <= 0 || normalized.length <= limit) {
    return [normalized];
  }
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length <= 1) {
    return splitIMessageTextSafely(normalized, limit);
  }
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    if (paragraph.length <= limit) {
      current = paragraph;
      continue;
    }
    const safeChunks = splitIMessageTextSafely(paragraph, limit);
    if (safeChunks.length === 0) {
      current = "";
      continue;
    }
    chunks.push(...safeChunks.slice(0, -1));
    current = safeChunks.at(-1) ?? "";
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  client: Awaited<ReturnType<typeof createIMessageRpcClient>>;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
  sentMessageCache?: Pick<SentMessageCache, "remember">;
}) {
  const { replies, target, client, runtime, maxBytes, textLimit, accountId, sentMessageCache } =
    params;
  const scope = `${accountId ?? ""}:${target}`;
  const cfg = loadConfig();
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "imessage",
    accountId,
  });
  for (const payload of replies) {
    const reply = resolveSendableOutboundReplyParts(payload, {
      text: convertMarkdownTables(normalizeIMessageDeliveryText(payload.text ?? ""), tableMode),
    });
    const delivered = await deliverTextOrMediaReply({
      payload,
      text: reply.text,
      chunkText: (value) => chunkIMessageText(value, textLimit),
      sendText: async (chunk) => {
        const sent = await sendMessageIMessage(target, chunk, {
          maxBytes,
          client,
          accountId,
          replyToId: payload.replyToId,
        });
        // Post-send cache population (#47830): caching happens after each chunk is sent,
        // not before. The window between send completion and cache write is sub-millisecond;
        // the next SQLite inbound poll is 1-2s away, so no echo can arrive before the
        // cache entry exists.
        sentMessageCache?.remember(scope, { text: sent.sentText, messageId: sent.messageId });
      },
      sendMedia: async ({ mediaUrl, caption }) => {
        const sent = await sendMessageIMessage(target, caption ?? "", {
          mediaUrl,
          maxBytes,
          client,
          accountId,
          replyToId: payload.replyToId,
        });
        sentMessageCache?.remember(scope, {
          text: sent.sentText || undefined,
          messageId: sent.messageId,
        });
      },
    });
    if (delivered !== "empty") {
      runtime.log?.(`imessage: delivered reply to ${target}`);
    }
  }
}
