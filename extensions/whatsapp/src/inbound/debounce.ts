import { normalizeWebInboundMessage } from "./message-aliases.js";
import type { WebInboundMessageInput } from "./types.js";

export const MAX_WHATSAPP_PLUGIN_DEBOUNCE_MS = 5 * 60_000;

export function hasWhatsAppInboundMedia(msg: WebInboundMessageInput): boolean {
  const normalized = normalizeWebInboundMessage(msg);
  const mediaItems =
    normalized.payload.mediaItems ?? (normalized.payload.media ? [normalized.payload.media] : []);
  return mediaItems.some((entry) => Boolean(entry.path || entry.url || entry.type || entry.kind));
}

export function resolveWhatsAppInboundMaxBufferAgeMs(
  msg: WebInboundMessageInput,
): number | undefined {
  return hasWhatsAppInboundMedia(msg) ? MAX_WHATSAPP_PLUGIN_DEBOUNCE_MS : undefined;
}
