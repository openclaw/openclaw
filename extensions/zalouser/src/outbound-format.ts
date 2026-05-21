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
 * Block-aware: the normalizer walks the text fence-by-fence so content
 * inside ``` / ~~~ fenced code blocks passes through verbatim. A `---`
 * line that is part of a YAML / config snippet inside a code fence is
 * NEVER touched, only freestanding HR lines in prose are.
 *
 * Idempotent: the prose transforms only remove characters, never add
 * them, so applying the function twice produces the same output as once.
 */

// Matches a line that opens or closes a fenced code block: 3+ backticks
// or 3+ tildes, with optional leading whitespace and optional info
// string (e.g. ```typescript). We toggle inFence on every match.
const FENCE_LINE_RE = /^[ \t]*(?:`{3,}|~{3,})[^\n]*$/;

/**
 * Normalize agent-emitted markdown text for the Zalo personal-account
 * client. Returns the input unchanged for non-string or empty values so
 * callers do not have to guard.
 *
 *  - Strips lines that contain only 3+ dashes or asterisks (HR markers)
 *    outside fenced code blocks.
 *  - Collapses blank lines that sit between list items (`-`, `*`, `1.`
 *    style) into a single newline so the list renders as a tight group.
 *  - Collapses any remaining 3+ consecutive newlines down to 2.
 *  - Leaves the content of ``` / ~~~ fenced code blocks untouched so
 *    YAML frontmatter, config snippets, or any code containing a `---`
 *    line keeps that line intact.
 */
export function normalizeZalouserOutboundText(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  // Split the text into alternating prose / fenced-code segments. Each
  // prose run is normalized independently; fenced runs pass through
  // verbatim including their opening + closing fence lines. We rejoin
  // with a single newline because the splitter consumed them as line
  // separators.
  const lines = text.split("\n");
  const out: string[] = [];
  let proseBuf: string[] = [];
  let inFence = false;

  const flushProse = (): void => {
    if (proseBuf.length === 0) {
      return;
    }
    out.push(normalizeProseSegment(proseBuf.join("\n")));
    proseBuf = [];
  };

  for (const line of lines) {
    if (FENCE_LINE_RE.test(line)) {
      // Fence boundary: flush any prose accumulated before this line,
      // then emit the fence line itself and flip the in-fence flag.
      flushProse();
      out.push(line);
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      // Inside a code fence: pass through verbatim. Crucially we do NOT
      // append to proseBuf so the normalizer never sees this line.
      out.push(line);
    } else {
      proseBuf.push(line);
    }
  }
  flushProse();

  return out.join("\n");
}

/**
 * Apply the prose-specific transforms (HR strip + list blank-line
 * collapse + newline cap) to a single prose segment. Callers are
 * responsible for ensuring the segment contains NO fenced code blocks.
 */
function normalizeProseSegment(text: string): string {
  if (text.length === 0) {
    return text;
  }

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
