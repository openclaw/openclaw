// Discord plugin module implements message text behavior.
import { ComponentType } from "discord-api-types/v10";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Message } from "../internal/discord.js";
import {
  formatDiscordSnapshotAuthor,
  normalizeDiscordMessageSnapshots,
  resolveDiscordMessageSnapshots,
  resolveDiscordMessageStickers,
  resolveDiscordReferencedForwardMessage,
  resolveDiscordSnapshotStickers,
  type DiscordSnapshotMessage,
} from "./message-forwarded.js";
import { buildDiscordMediaPlaceholder } from "./message-media.js";

// Wire-protocol markers from core internal-runtime-context. Keep in lockstep with
// src/agents/internal-runtime-context.ts so ingress strips the same envelopes.
const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

/**
 * Strip protected OpenClaw runtime-context envelopes from ingress text.
 * Line-anchored begin/end markers only (same delimiter contract as core).
 * Avoids a new plugin-sdk surface export for this single channel fix.
 */
function stripDiscordInternalRuntimeContext(text: string): string {
  if (!text || !text.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN)) {
    return text;
  }
  let next = text;
  for (;;) {
    const start = findLineAnchoredTokenIndex(next, INTERNAL_RUNTIME_CONTEXT_BEGIN, 0);
    if (start === -1) {
      return next;
    }
    let cursor = start + INTERNAL_RUNTIME_CONTEXT_BEGIN.length;
    let depth = 1;
    let finish = -1;
    while (depth > 0) {
      const nextBegin = findLineAnchoredTokenIndex(next, INTERNAL_RUNTIME_CONTEXT_BEGIN, cursor);
      const nextEnd = findLineAnchoredTokenIndex(next, INTERNAL_RUNTIME_CONTEXT_END, cursor);
      if (nextEnd === -1) {
        break;
      }
      if (nextBegin !== -1 && nextBegin < nextEnd) {
        depth += 1;
        cursor = nextBegin + INTERNAL_RUNTIME_CONTEXT_BEGIN.length;
        continue;
      }
      depth -= 1;
      finish = nextEnd;
      cursor = nextEnd + INTERNAL_RUNTIME_CONTEXT_END.length;
    }
    const before = next.slice(0, start).trimEnd();
    if (finish === -1 || depth !== 0) {
      return before;
    }
    const after = next.slice(finish + INTERNAL_RUNTIME_CONTEXT_END.length).trimStart();
    next = before && after ? `${before}\n\n${after}` : `${before}${after}`;
  }
}

function findLineAnchoredTokenIndex(text: string, token: string, from: number): number {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokenRe = new RegExp(`(?:^|\\r?\\n)${escaped}(?=\\r?\\n|$)`, "g");
  tokenRe.lastIndex = Math.max(0, from);
  const match = tokenRe.exec(text);
  if (!match) {
    return -1;
  }
  const prefixLength = match[0].length - token.length;
  return match.index + prefixLength;
}

export function resolveDiscordEmbedText(
  embed?: { title?: string | null; description?: string | null } | null,
): string {
  const title = normalizeOptionalString(embed?.title) ?? "";
  const description = normalizeOptionalString(embed?.description) ?? "";
  if (title && description) {
    return `${title}\n${description}`;
  }
  return title || description || "";
}

/**
 * Resolve Discord user-visible body text for ingress.
 * Sanitize each textual candidate before fallback precedence so wrapper-only
 * content cannot displace attachment/embed/component/fallback text, then resolve
 * mentions on the selected body.
 */
export function resolveDiscordMessageText(
  message: Message,
  options?: { fallbackText?: string; includeForwarded?: boolean },
): string {
  // Strip wrappers before precedence: non-empty wrapper content must not win the
  // candidate chain and later become empty, suppressing legitimate media/rich text.
  const contentText = stripDiscordInternalRuntimeContext(
    normalizeOptionalString(message.content) ?? "",
  );
  const embedText = stripDiscordInternalRuntimeContext(
    resolveDiscordEmbedText(
      (message.embeds?.[0] as { title?: string | null; description?: string | null } | undefined) ??
        null,
    ),
  );
  const componentText = stripDiscordInternalRuntimeContext(
    extractDiscordComponentsV2Text(resolveDiscordMessageComponents(message)),
  );
  const fallbackText = stripDiscordInternalRuntimeContext(
    normalizeOptionalString(options?.fallbackText) ?? "",
  );
  const rawText =
    normalizeOptionalString(contentText) ||
    buildDiscordMediaPlaceholder({
      attachments: message.attachments ?? undefined,
      stickers: resolveDiscordMessageStickers(message),
    }) ||
    normalizeOptionalString(embedText) ||
    normalizeOptionalString(componentText) ||
    normalizeOptionalString(fallbackText) ||
    "";
  const baseText = resolveDiscordMentions(rawText, message);
  if (!options?.includeForwarded) {
    return baseText;
  }
  const forwardedText = resolveDiscordForwardedMessagesText(message);
  if (!forwardedText) {
    return baseText;
  }
  if (!baseText) {
    return forwardedText;
  }
  return `${baseText}\n${forwardedText}`;
}

function resolveDiscordMentions(text: string, message: Message): string {
  if (!text.includes("<")) {
    return text;
  }
  const mentions = message.mentionedUsers ?? [];
  if (!Array.isArray(mentions) || mentions.length === 0) {
    return text;
  }
  let out = text;
  for (const user of mentions) {
    const label = user.globalName || user.username;
    out = out.replace(new RegExp(`<@!?${user.id}>`, "g"), `@${label}`);
  }
  return out;
}

function resolveDiscordForwardedMessagesText(message: Message): string {
  const snapshots = resolveDiscordMessageSnapshots(message);
  if (snapshots.length > 0) {
    return resolveDiscordForwardedMessagesTextFromSnapshots(snapshots);
  }
  const referencedForward = resolveDiscordReferencedForwardMessage(message);
  if (!referencedForward) {
    return "";
  }
  const referencedText = resolveDiscordMessageText(referencedForward);
  if (!referencedText) {
    return "";
  }
  const authorLabel = formatDiscordSnapshotAuthor(referencedForward.author);
  const heading = authorLabel ? `[Forwarded message from ${authorLabel}]` : "[Forwarded message]";
  return `${heading}\n${referencedText}`;
}

function resolveDiscordMessageComponents(message: Message): unknown {
  const components = (message as { components?: unknown }).components;
  if (components !== undefined) {
    return components;
  }
  try {
    return (message as { rawData?: { components?: unknown } }).rawData?.components;
  } catch {
    return undefined;
  }
}

function extractDiscordComponentsV2Text(components: unknown): string {
  const parts: string[] = [];
  collectDiscordTextDisplayContent(components, parts);
  return parts.join("\n");
}

function collectDiscordTextDisplayContent(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDiscordTextDisplayContent(entry, parts);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const component = value as {
    type?: unknown;
    content?: unknown;
    components?: unknown;
    component?: unknown;
  };
  if (component.type === ComponentType.TextDisplay) {
    const content = normalizeOptionalString(component.content);
    if (content) {
      parts.push(content);
    }
  }
  collectDiscordTextDisplayContent(component.components, parts);
  collectDiscordTextDisplayContent(component.component, parts);
}

export function resolveDiscordForwardedMessagesTextFromSnapshots(snapshots: unknown): string {
  const forwardedBlocks = normalizeDiscordMessageSnapshots(snapshots)
    .map((snapshot) => buildDiscordForwardedMessageBlock(snapshot.message))
    .filter((entry): entry is string => Boolean(entry));
  if (forwardedBlocks.length === 0) {
    return "";
  }
  return forwardedBlocks.join("\n\n");
}

function buildDiscordForwardedMessageBlock(
  snapshotMessage: DiscordSnapshotMessage | null | undefined,
): string | null {
  if (!snapshotMessage) {
    return null;
  }
  const text = resolveDiscordSnapshotMessageText(snapshotMessage);
  if (!text) {
    return null;
  }
  const authorLabel = formatDiscordSnapshotAuthor(snapshotMessage.author);
  const heading = authorLabel ? `[Forwarded message from ${authorLabel}]` : "[Forwarded message]";
  return `${heading}\n${text}`;
}

function resolveDiscordSnapshotMessageText(snapshot: DiscordSnapshotMessage): string {
  // Same pre-precedence strip as resolveDiscordMessageText so wrapper-only snapshot
  // content does not suppress attachment/embed/component fallbacks.
  const content = stripDiscordInternalRuntimeContext(
    normalizeOptionalString(snapshot.content) ?? "",
  );
  const attachmentText = buildDiscordMediaPlaceholder({
    attachments: snapshot.attachments ?? undefined,
    stickers: resolveDiscordSnapshotStickers(snapshot),
  });
  const embedText = stripDiscordInternalRuntimeContext(
    resolveDiscordEmbedText(snapshot.embeds?.[0]),
  );
  const componentText = stripDiscordInternalRuntimeContext(
    extractDiscordComponentsV2Text(snapshot.components),
  );
  return (
    normalizeOptionalString(content) ||
    attachmentText ||
    normalizeOptionalString(embedText) ||
    normalizeOptionalString(componentText) ||
    ""
  );
}
