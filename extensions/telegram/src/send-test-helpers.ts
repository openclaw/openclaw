import { splitTelegramPlainTextChunks } from "./rich-plain-fallback.js";

// Test-only handle: the plain-text splitter is internal, but its surrogate-safe
// chunk boundary needs direct behavior coverage.
export function splitTelegramPlainTextChunksForTests(text: string, limit: number): string[] {
  return splitTelegramPlainTextChunks(text, limit);
}
