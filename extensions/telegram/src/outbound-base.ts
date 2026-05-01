import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { splitTelegramHtmlChunks } from "./format.js";

export const telegramOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: (text: string, limit: number, ctx?: { formatting?: { parseMode?: "HTML" } }): string[] =>
    ctx?.formatting?.parseMode === "HTML"
      ? splitTelegramHtmlChunks(text, limit)
      : chunkMarkdownText(text, limit),
  chunkerMode: "text" as const,
  extractMarkdownImages: true,
  textChunkLimit: 4000,
  pollMaxOptions: 10,
};
