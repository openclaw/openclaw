import { LinkifyIt } from "linkify-it";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import tlds from "tlds" with { type: "json" };
import type { XApiClient, XAssertActive } from "./api.js";
import { normalizeXReplyTarget } from "./target.js";

export const DEFAULT_X_REPLY_SIGNATURE = "— Roboclaw 🦞 automated reply";
export type XVisibleWorkSession = { sessionKey: string; url: string; label?: string };
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const emojiSequence = new RegExp("^\\p{RGI_Emoji}$", "v");
const links = new LinkifyIt({ fuzzyLink: true, tlds });

function characterWeight(value: string): number {
  // Arbitrary ZWJ runs are graphemes too, but only standardized emoji collapse to weight two.
  if (emojiSequence.test(value) || /^\p{Extended_Pictographic}$/u.test(value)) {
    return 2;
  }
  return Array.from(value).reduce((total, char) => {
    const code = char.codePointAt(0)!;
    return (
      total +
      (code <= 0x10ff ||
      (code >= 0x2000 && code <= 0x200d) ||
      (code >= 0x2010 && code <= 0x201f) ||
      (code >= 0x2032 && code <= 0x2037)
        ? 1
        : 2)
    );
  }, 0);
}

function weightedTokens(text: string): { text: string; weight: number }[] {
  const tokens: { text: string; weight: number }[] = [];
  let offset = 0;
  const appendText = (value: string) => {
    tokens.push(
      ...Array.from(graphemes.segment(value), ({ segment }) => ({
        text: segment,
        weight: characterWeight(segment),
      })),
    );
  };
  for (const match of links.match(text) ?? []) {
    if (match.schema && !["http:", "https:", "//"].includes(match.schema)) {
      continue;
    }
    appendText(text.slice(offset, match.index));
    tokens.push({ text: match.raw, weight: 23 });
    offset = match.lastIndex;
  }
  appendText(text.slice(offset));
  return tokens;
}

export function xWeightedLength(text: string): number {
  return weightedTokens(text.normalize("NFC")).reduce((sum, token) => sum + token.weight, 0);
}

export function appendVisibleWorkSession(
  text: string,
  sessions: XVisibleWorkSession[] = [],
): string {
  const url = sessions[0]?.url;
  return url && !text.includes(url) ? `${text.trimEnd()}\n${url}` : text;
}

export function chunkXReply(text: string, signature = DEFAULT_X_REPLY_SIGNATURE): string[] {
  const normalized = text.normalize("NFC").trim();
  const suffix = signature.normalize("NFC").trim();
  if (!normalized) {
    throw new Error("X replies require nonempty text");
  }
  if (xWeightedLength(suffix) > 280) {
    throw new Error("X replySignature exceeds 280 weighted characters");
  }
  const tokens = weightedTokens(normalized);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < tokens.length) {
    let end = offset;
    let weight = 0;
    let boundary = -1;
    while (end < tokens.length) {
      const token = tokens[end];
      if (!token || weight + token.weight > 280) {
        break;
      }
      weight += token.weight;
      if (/\s/u.test(token.text)) {
        boundary = end;
      }
      end++;
    }
    if (end === offset) {
      throw new Error("X reply contains a character sequence longer than one post");
    }
    if (end < tokens.length && boundary > offset) {
      end = boundary;
    }
    const chunk = tokens
      .slice(offset, end)
      .map((token) => token.text)
      .join("")
      .trim();
    if (chunk) {
      chunks.push(chunk);
    }
    offset = end;
    while (offset < tokens.length && /^\s+$/u.test(tokens[offset]?.text ?? "")) {
      offset++;
    }
  }
  if (suffix) {
    const last = chunks.at(-1)!;
    if (xWeightedLength(`${last}\n${suffix}`) <= 280) {
      chunks[chunks.length - 1] = `${last}\n${suffix}`;
    } else {
      chunks.push(suffix);
    }
  }
  return chunks;
}

export class XPartialReplyError extends Error {
  constructor(
    public readonly postIds: string[],
    public readonly text: string,
    cause: unknown,
  ) {
    super("X reply chain failed after one or more posts were sent", { cause });
    this.name = "XPartialReplyError";
  }
}

export async function sendXReply(options: {
  api: XApiClient;
  text: string;
  replyToId: string;
  signature?: string;
  visibleWorkSessions?: XVisibleWorkSession[];
  signal?: AbortSignal;
  assertActive?: XAssertActive;
}): Promise<{ postIds: string[]; text: string }> {
  const replyToId = normalizeXReplyTarget(options.replyToId);
  if (!replyToId) {
    throw new PlatformMessageNotDispatchedError(
      "X target must be x:<postId> or an https://x.com/<handle>/status/<postId> URL",
      { cause: undefined, retryable: false },
    );
  }
  let chunks: string[];
  try {
    chunks = chunkXReply(
      appendVisibleWorkSession(options.text, options.visibleWorkSessions),
      options.signature,
    );
  } catch (cause) {
    throw new PlatformMessageNotDispatchedError(
      cause instanceof Error ? cause.message : "X reply text could not be prepared",
      { cause, retryable: false },
    );
  }
  const postIds: string[] = [];
  try {
    for (const text of chunks) {
      if (options.signal?.aborted) {
        throw new PlatformMessageNotDispatchedError("X reply was aborted before dispatch", {
          cause: options.signal.reason,
          retryable: false,
        });
      }
      const id = await options.api.reply({
        text,
        inReplyToId: postIds.at(-1) ?? replyToId,
        signal: options.signal,
        assertActive: options.assertActive,
      });
      postIds.push(id);
    }
  } catch (cause) {
    if (postIds.length) {
      throw new XPartialReplyError(postIds, chunks.slice(0, postIds.length).join("\n"), cause);
    }
    throw cause;
  }
  return { postIds, text: chunks.join("\n") };
}
