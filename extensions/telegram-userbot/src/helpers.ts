/**
 * Message conversion helpers for the telegram-userbot inbound handler.
 *
 * Extracts chat type, sender name, and media information from GramJS
 * entity/message objects without pulling in the full GramJS type tree
 * (uses className-based duck-typing where needed).
 */

import type { Api } from "telegram/tl/index.js";

export type ChatType = "private" | "group" | "supergroup" | "channel";

/**
 * Determine chat type from a GramJS entity class.
 */
export function resolveChatType(chat: Api.TypeChat | Api.User | undefined): ChatType {
  if (!chat) return "private";
  const cn = chat.className;
  if (cn === "User") return "private";
  if (cn === "Chat" || cn === "ChatForbidden") return "group";
  if (cn === "Channel" || cn === "ChannelForbidden") {
    // Megagroup flag distinguishes supergroups from broadcast channels
    if ("megagroup" in chat && chat.megagroup) return "supergroup";
    return "channel";
  }
  return "private";
}

/**
 * Resolve a human-readable sender display name from a GramJS entity.
 */
export function resolveSenderName(sender: Api.User | Api.Channel | Api.Chat | undefined): string {
  if (!sender) return "Unknown";
  if ("firstName" in sender) {
    return (
      [sender.firstName, sender.lastName].filter(Boolean).join(" ") || sender.username || "Unknown"
    );
  }
  if ("title" in sender) {
    return sender.title || "Unknown";
  }
  return "Unknown";
}

/**
 * Map a GramJS MessageMedia to a simple media type label.
 */
export function resolveMediaType(media: Api.TypeMessageMedia | undefined): string | undefined {
  if (!media) return undefined;
  const cn = media.className;
  if (cn === "MessageMediaPhoto") return "photo";
  if (cn === "MessageMediaDocument") {
    const doc = (media as Api.MessageMediaDocument).document;
    if (doc && "mimeType" in doc) {
      if (doc.mimeType.startsWith("audio/")) return "voice";
      if (doc.mimeType.startsWith("video/")) return "video";
    }
    return "document";
  }
  if (cn === "MessageMediaContact") return "contact";
  if (cn === "MessageMediaGeo" || cn === "MessageMediaGeoLive") return "location";
  if (cn === "MessageMediaVenue") return "venue";
  return undefined;
}

/**
 * Check whether a message's media is downloadable (photo or document).
 */
export function hasDownloadableMedia(media: Api.TypeMessageMedia | undefined): boolean {
  if (!media) return false;
  const cn = media.className;
  return cn === "MessageMediaPhoto" || cn === "MessageMediaDocument";
}
