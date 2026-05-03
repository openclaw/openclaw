import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { splitTelegramHtmlChunks } from "./format.js";

const chunkTelegramText: NonNullable<ChannelOutboundAdapter["chunker"]> = (text, limit, ctx) =>
  ctx?.formatting?.parseMode === "HTML"
    ? splitTelegramHtmlChunks(text, limit)
    : chunkMarkdownText(text, limit);

export const telegramOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: chunkTelegramText,
  chunkerMode: "text" as const,
  extractMarkdownImages: true,
  textChunkLimit: 4000,
  pollMaxOptions: 10,
};
