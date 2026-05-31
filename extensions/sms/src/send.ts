import { chunkTextForOutbound, stripMarkdown } from "openclaw/plugin-sdk/text-chunking";
import { sendSmsViaTwilio } from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

export function toSmsPlainText(text: string): string {
  const withReadableLinks = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) => {
      const cleanLabel = label.trim();
      const cleanUrl = url.trim();
      return cleanLabel && cleanLabel !== cleanUrl ? `${cleanLabel} (${cleanUrl})` : cleanUrl;
    },
  );
  return stripMarkdown(withReadableLinks)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendSmsTextChunks(params: {
  account: ResolvedSmsAccount;
  to: string;
  text: string;
}): Promise<Array<{ sid: string; to: string }>> {
  const text = toSmsPlainText(params.text);
  if (!text) {
    throw new Error("SMS send requires non-empty text.");
  }
  const chunks = chunkTextForOutbound(text, params.account.textChunkLimit).filter(Boolean);
  const sendChunks = chunks.length ? chunks : [text];
  const results: Array<{ sid: string; to: string }> = [];
  for (const text of sendChunks) {
    results.push(
      await sendSmsViaTwilio({
        account: params.account,
        to: params.to,
        text,
      }),
    );
  }
  return results;
}
