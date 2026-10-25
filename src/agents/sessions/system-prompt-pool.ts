import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { LruCache } from "../../infra/lru-cache.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { FileEntry } from "./session-manager-types.js";

// Content is the immutable revision. Eviction only ends sharing, never changes a live prompt.
const prefixes = resolveGlobalSingleton(
  Symbol.for("openclaw.systemPromptPrefixes"),
  () => new LruCache<string>(128, { maxBytes: 32 * 1024 ** 2, sizeOf: (text) => text.length * 2 }),
  (cache) => cache.clear(),
);

export function shareSystemPromptPrefix(text: string): string {
  if (text.length < 1024) {
    return text;
  }
  const hash = sha256Hex(text);
  const existing = prefixes.get(hash);
  // UTF-8 hashing can map distinct lone surrogates to the same replacement character.
  if (existing === text) {
    return existing;
  }
  // Detach slices once, rather than retaining their potentially much larger source string.
  const owned = Buffer.from(text, "utf16le").toString("utf16le");
  prefixes.set(hash, owned);
  return owned;
}

/** JSON/worker cloning and append normalization otherwise duplicate these immutable strings. */
export function shareSessionSystemPrompt<T extends FileEntry>(entry: T): T {
  if (entry.type !== "custom" || entry.customType !== "openclaw.system-prompt") {
    return entry;
  }
  const data = entry.data;
  if (!isRecord(data)) {
    return entry;
  }
  return {
    ...entry,
    data: Object.freeze({
      ...data,
      ...(typeof data.prefix === "string" ? { prefix: shareSystemPromptPrefix(data.prefix) } : {}),
      ...(typeof data.renderedPrefix === "string"
        ? { renderedPrefix: shareSystemPromptPrefix(data.renderedPrefix) }
        : {}),
    }),
  };
}
