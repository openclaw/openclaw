// Discord plugin module implements message text behavior.
import { ComponentType } from "discord-api-types/v10";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { stripCompleteInternalRuntimeContextBlocks } from "openclaw/plugin-sdk/text-utility-runtime";
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
import { formatDiscordMediaText } from "./message-media.js";

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

/** Resolves sanitized primary content without embed, component, or fallback text. */
export function resolveDiscordPrimaryContentText(message: Pick<Message, "content">): string {
  return resolveDiscordVisibleTextCandidate(message.content);
}

export function resolveDiscordMessageText(
  message: Message,
  options?: { fallbackText?: string; includeForwarded?: boolean },
): string {
  // Sanitize before precedence so an internal-only candidate cannot hide visible fallbacks.
  const contentText = resolveDiscordPrimaryContentText(message);
  const embedText = resolveDiscordVisibleTextCandidate(
    resolveDiscordEmbedText(
      (message.embeds?.[0] as { title?: string | null; description?: string | null } | undefined) ??
        null,
    ),
  );
  const componentText = resolveDiscordVisibleTextCandidate(
    extractDiscordComponentsV2Text(resolveDiscordMessageComponents(message)),
  );
  const rawText =
    contentText ||
    embedText ||
    componentText ||
    resolveDiscordVisibleTextCandidate(options?.fallbackText) ||
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

function resolveDiscordVisibleTextCandidate(value: string | null | undefined): string {
  return stripCompleteInternalRuntimeContextBlocks(normalizeOptionalString(value) ?? "");
}

/** Adds native media text only for history surfaces that cannot carry structured facts. */
export function resolveDiscordMessageHistoryText(
  message: Message,
  options?: { fallbackText?: string; includeForwarded?: boolean },
): string {
  const text = resolveDiscordMessageText(message, options);
  const mediaText = formatDiscordMediaText({
    attachments: message.attachments ?? undefined,
    stickers: resolveDiscordMessageStickers(message),
  });
  return [text, mediaText].filter(Boolean).join("\n");
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
  const referencedText = resolveDiscordMessageHistoryText(referencedForward);
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
  const content = resolveDiscordVisibleTextCandidate(snapshot.content);
  const attachmentText = formatDiscordMediaText({
    attachments: snapshot.attachments ?? undefined,
    stickers: resolveDiscordSnapshotStickers(snapshot),
  });
  const embedText = resolveDiscordVisibleTextCandidate(
    resolveDiscordEmbedText(snapshot.embeds?.[0]),
  );
  const componentText = resolveDiscordVisibleTextCandidate(
    extractDiscordComponentsV2Text(snapshot.components),
  );
  const text = content || embedText || componentText;
  return [text, attachmentText].filter(Boolean).join("\n");
}
