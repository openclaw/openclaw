/**
 * Opt-in content deduplication to reduce token usage from repeated workspace files, etc.
 *
 * Repeated message bodies are replaced with plain-language source pointers.
 */

export { default } from "./context-dedup/extension.js";

export { deduplicateMessages, contentHash } from "./context-dedup/deduper.js";
export type {
  DedupConfig,
  EffectiveDedupSettings,
  DedupResult,
  RefTagFormat,
} from "./context-dedup/deduper.js";
export { resolveEffectiveDedupSettings } from "./context-dedup/settings.js";
