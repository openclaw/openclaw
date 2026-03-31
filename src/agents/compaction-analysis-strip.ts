/**
 * Utilities for the analysis-scratchpad technique in compaction summaries.
 *
 * The compaction prompt asks the model to produce a two-phase response:
 *   1. <analysis> … </analysis>  — chronological reasoning (stripped before use)
 *   2. <summary> … </summary>    — the actual summary that enters context
 *
 * This module provides the instruction fragment and the stripping logic.
 */

/**
 * Instruction fragment appended to the compaction prompt to request
 * the analysis + summary structure.
 */
export const ANALYSIS_SCRATCHPAD_INSTRUCTIONS = [
  "",
  "Structure your response in two phases:",
  "",
  "<analysis>",
  "Think through the conversation chronologically. Identify the key decisions,",
  "state changes, active tasks, unresolved questions, and any identifiers that",
  "must be preserved. Note what information is critical vs. what can be dropped.",
  "</analysis>",
  "",
  "<summary>",
  "Write the final compaction summary here, using the required section headings.",
  "Only the content inside <summary> tags will be kept.",
  "</summary>",
].join("\n");

/**
 * Strip the `<analysis>` scratchpad block from a compaction summary,
 * keeping only the `<summary>` block content.
 *
 * If the response contains `<summary>…</summary>` tags, returns the inner
 * content. Otherwise falls back to removing any `<analysis>…</analysis>`
 * block and returning whatever remains (defensive — the model may not
 * always follow the two-phase format perfectly).
 */
export function stripAnalysisBlock(text: string): string {
  // Prefer explicit <summary> tags when present.
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    return summaryMatch[1].trim();
  }

  // Fallback: remove <analysis> block and return what's left.
  const stripped = text.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();
  return stripped || text.trim();
}
