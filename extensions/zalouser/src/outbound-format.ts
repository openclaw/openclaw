/**
 * Outbound text post-processing for the Zalo personal-account channel.
 *
 * The Zalo client (both mobile + web) renders agent-style markdown poorly
 * in two specific ways:
 *
 *  1. Triple-dash horizontal rules (`---`, `***`) are rendered as literal
 *     dashes on their own line - never as a separator. They add visual
 *     noise without conveying structure.
 *
 *  2. List items separated by blank lines render with the blank line
 *     preserved, breaking the visual grouping a reader expects from a
 *     markdown list (`- foo\n- bar` reads as one list; `- foo\n\n- bar`
 *     reads as two unrelated items with extra vertical space).
 *
 *     LLM agents often emit lists with surrounding blank lines because
 *     that is what other channels (Slack, Discord, the web playground)
 *     render best. Zalo is the outlier here.
 *
 * This module normalizes outbound text to match what the Zalo client
 * actually renders well. It is intentionally conservative: the patterns
 * only match content that is unambiguously a markdown HR or a blank line
 * inside a list, so plain prose passes through unchanged.
 *
 * Idempotent: the transforms only remove characters, never add them, so
 * applying the function twice produces the same output as once.
 */

/**
 * Normalize agent-emitted markdown text for the Zalo personal-account
 * client. Returns the input unchanged for non-string or empty values so
 * callers do not have to guard.
 *
 *  - Strips lines that contain only 3+ dashes or asterisks (HR markers).
 *  - Collapses blank lines that sit between list items (`-`, `*`, `1.`
 *    style) into a single newline so the list renders as a tight group.
 *  - Collapses any remaining 3+ consecutive newlines down to 2.
 */
export function normalizeZalouserOutboundText(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;

  // Strip horizontal-rule lines (--- or ***): match a whole line that is
  // nothing but 3+ dashes / asterisks with optional leading/trailing
  // whitespace. Leaves the surrounding newlines in place so the do-while
  // collapse below normalizes the resulting blank run.
  let cleaned = text.replace(/^[ \t]*[-*]{3,}[ \t]*$/gm, "");

  // The blank-line-inside-list pattern: a list item followed by one or
  // more blank lines followed by another list item. We collapse the run
  // of blank lines down to a single newline so the items group visually.
  //
  // Three sub-patterns cover the failure modes the Zalo client exhibits:
  //   - between: blank line(s) between two list items
  //   - before:  blank line(s) between prose and the first list item
  //   - after:   blank line(s) between the last list item and following
  //              prose, when the prose does not itself look like a list
  //
  // Each iterates until convergence because a single replace pass may
  // expose another match (e.g. three list items separated by blank lines
  // need two passes). Convergence is guaranteed because every transform
  // strictly reduces the number of newline characters; it never adds.
  const between =
    /([ \t]*(?:\d+\.|[-*])[ \t]+[^\n]*)(?:\n[ \t]*)+\n(?=[ \t]*(?:\d+\.|[-*])[ \t]+[^\n]*)/g;
  const before = /([^\n])(?:\n[ \t]*)+\n(?=[ \t]*(?:\d+\.|[-*])[ \t]+[^\n]*)/g;
  const after = /([ \t]*(?:\d+\.|[-*])[ \t]+[^\n]*)(?:\n[ \t]*)+\n(?=[^\n -])/g;

  let prev: string;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(between, "$1\n");
    cleaned = cleaned.replace(before, "$1\n");
    cleaned = cleaned.replace(after, "$1\n");
  } while (cleaned !== prev);

  // Hard cap on consecutive newlines: 2. Defensive in case prose has
  // long blank-line runs that none of the list patterns caught.
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned;
}
