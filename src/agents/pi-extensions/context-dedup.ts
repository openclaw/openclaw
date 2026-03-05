/**
 * Opt-in content deduplication to reduce token usage from repeated workspace files, etc.
 *
 * This replaces repeated content with reference tags, with the full content stored in a
 * reference table that's prepended to the context.
 */

export { default } from "./context-dedup/extension.js";

export {
  deduplicateMessages,
  cleanOrphanedRefs,
  serializeRefTable,
  buildRefTableExplanation,
  contentHash,
  makeRefTag,
  getRefTagSize,
  getRefDelimiters,
} from "./context-dedup/deduper.js";
export type {
  DedupConfig,
  EffectiveDedupSettings,
  RefTable,
  DedupResult,
  RefTagFormat,
} from "./context-dedup/deduper.js";
export { resolveEffectiveDedupSettings } from "./context-dedup/settings.js";
