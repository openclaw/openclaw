import { findMarkdownCodeSpans } from "./markdown-code-regions.js";
import { reduceReasoningText, type ReductionState } from "./reasoning-tag-syntax.js";
export { REASONING_TAG_NAMES, scanReasoningTags } from "./reasoning-tag-syntax.js";

type ReasoningTagStripOptions = {
  mode: "strict" | "preserve";
  scope: "all" | "leading";
  recoverUnclosed?: boolean;
};

/** Strips reasoning tags using the same reducer as streamed partitioning. */
export function stripReasoningTagsFromMarkdown(
  text: string,
  options: ReasoningTagStripOptions,
): string {
  const state: ReductionState = { depth: 0, visibleEver: false };
  return reduceReasoningText(text, findMarkdownCodeSpans(text), state, {
    final: true,
    mode:
      options.recoverUnclosed === false
        ? "hide"
        : options.mode === "preserve"
          ? "static-preserve"
          : "static-strict",
    scope: options.scope,
  })
    .filter((delta) => delta.kind === "text")
    .map((delta) => delta.text)
    .join("");
}
