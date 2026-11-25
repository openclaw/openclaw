// Feishu identity header helpers keep card titles free of prose-only emoji config.

import type { OutboundIdentity } from "../runtime-api.js";
import type { CardHeaderConfig } from "./send.js";

type IdentityHeaderInput = {
  emoji?: string;
  name?: string;
};

const emojiSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const keycapEmojiPattern = /^[0-9#*]\uFE0F?\u20E3$/u;
const emojiLikeSegmentPattern =
  /[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

function isEmojiSegment(segment: string): boolean {
  return keycapEmojiPattern.test(segment) || emojiLikeSegmentPattern.test(segment);
}

function resolveFeishuIdentityEmoji(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const emoji = Array.from(emojiSegmenter.segment(trimmed), (segment) => segment.segment)
    .filter(isEmojiSegment)
    .join("");
  return emoji || undefined;
}

export function resolveFeishuIdentityHeaderTitle(identity: IdentityHeaderInput | undefined) {
  if (!identity) {
    return "";
  }
  const name = identity.name?.trim() ?? "";
  const emoji = resolveFeishuIdentityEmoji(identity.emoji);
  return (emoji ? `${emoji} ${name}` : name).trim();
}

export function resolveCardHeader(
  agentId: string,
  identity: OutboundIdentity | undefined,
): CardHeaderConfig | undefined {
  const name = identity?.name?.trim() || (agentId === "main" ? "" : agentId);
  const emoji = resolveFeishuIdentityEmoji(identity?.emoji);
  const title = (emoji ? `${emoji} ${name}` : name).trim();
  if (!title) {
    return undefined;
  }
  return {
    title,
    template: identity?.theme ?? "blue",
  };
}

export function resolveCardNote(
  agentId: string,
  identity: OutboundIdentity | undefined,
  prefixCtx: { model?: string; provider?: string },
): string {
  const name = identity?.name?.trim() || agentId;
  const parts: string[] = [`Agent: ${name}`];
  if (prefixCtx.model) {
    parts.push(`Model: ${prefixCtx.model}`);
  }
  if (prefixCtx.provider) {
    parts.push(`Provider: ${prefixCtx.provider}`);
  }
  return parts.join(" | ");
}
