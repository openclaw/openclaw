// Markdown Core owns block-aware incremental reasoning-tag partitioning.
import type { ReasoningTagTextDelta } from "./reasoning-tag-parser.js";
import { createLegacyReasoningTagTextPartitioner } from "./reasoning-tag-stream-owner.js";
export {
  findMarkdownCodeSpans,
  findMarkdownCodeRegions,
  parseMarkdownOwnership,
  scanReasoningTags,
  stripReasoningTagsFromMarkdown,
} from "./reasoning-tag-parser.js";
export type { ReasoningTagTextDelta } from "./reasoning-tag-parser.js";

export interface ReasoningTagTextPartitioner {
  markStrict(): void;
  push(chunk: string): ReasoningTagTextDelta[];
  pushVisible(chunk: string): ReasoningTagTextDelta[];
  flush(options?: { recoverUnclosed?: boolean }): ReasoningTagTextDelta[];
  hasPending(): boolean;
  /** Whether more input can change buffered Markdown or reasoning-tag ownership. */
  hasPendingSyntax(): boolean;
  isInsideReasoning(): boolean;
}

/** Creates a block-incremental parser that emits only Markdown-stable text. */
export function createReasoningTagTextPartitioner(): ReasoningTagTextPartitioner {
  return createLegacyReasoningTagTextPartitioner();
}
