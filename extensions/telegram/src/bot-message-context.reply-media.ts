import type { TelegramReplyChainEntry } from "./message-cache-codec.js";
import { isTelegramMediaKind } from "./message-cache-persistence.js";

export function resolveReplyChainMediaType(entry: TelegramReplyChainEntry) {
  const mediaType = entry.mediaType;
  const nativeKind = isTelegramMediaKind(mediaType) ? mediaType : undefined;
  const kind = entry.mediaKind || nativeKind;
  return {
    ...(kind ? { kind } : {}),
    ...(mediaType && !nativeKind ? { contentType: mediaType } : {}),
  };
}
