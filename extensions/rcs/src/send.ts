// Rcs plugin module implements send behavior.
import {
  chunkTextForOutbound,
  sanitizeAssistantVisibleText,
  stripMarkdown,
} from "openclaw/plugin-sdk/text-chunking";
import { sendRcsViaTwilio } from "./twilio.js";
import type { RcsSendResult, ResolvedRcsAccount } from "./types.js";

export function toRcsPlainText(text: string): string {
  const visibleText = sanitizeAssistantVisibleText(text);
  const withoutFencedCodeMarkers = visibleText.replace(
    /```[^\n]*\n?([\s\S]*?)```/g,
    (_match, body: string) => body.trim(),
  );
  const withReadableLinks = withoutFencedCodeMarkers.replace(
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

export async function sendRcsTextChunks(params: {
  account: ResolvedRcsAccount;
  to: string;
  text: string;
}): Promise<RcsSendResult[]> {
  const text = toRcsPlainText(params.text);
  if (!text) {
    throw new Error("RCS send requires non-empty text.");
  }
  const chunks = chunkTextForOutbound(text, params.account.textChunkLimit).filter(Boolean);
  const sendChunks = chunks.length ? chunks : [text];
  const results: RcsSendResult[] = [];
  for (const textLocal of sendChunks) {
    results.push(
      await sendRcsViaTwilio({
        account: params.account,
        to: params.to,
        text: textLocal,
      }),
    );
  }
  return results;
}

export async function sendRcsMedia(params: {
  account: ResolvedRcsAccount;
  to: string;
  mediaUrls: string[];
  text?: string;
}): Promise<RcsSendResult[]> {
  const remote = params.mediaUrls.filter((url) => /^https?:\/\//i.test(url));
  if (!remote.length) {
    throw new Error(
      "RCS outbound media requires publicly reachable http(s) URLs; local file hosting is not supported yet.",
    );
  }
  const text = params.text ? toRcsPlainText(params.text) : "";
  return [
    await sendRcsViaTwilio({
      account: params.account,
      to: params.to,
      ...(text ? { text } : {}),
      mediaUrls: remote,
    }),
  ];
}
