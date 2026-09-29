// Teams shows informative stream updates as a one-line status next to the
// progress bar and drops newlines, so multi-row progress drafts (label,
// commentary, tool bullets, plan steps) would run together. Join the rows with
// a visible separator instead, keeping the newest rows within Teams' informative
// limit (1 KB and 1000 characters) without splitting an emoji or other grapheme.
const INFORMATIVE_MAX_CHARS = 1000;
const INFORMATIVE_MAX_BYTES = 1024;
const ELLIPSIS = "…";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const utf8 = new TextEncoder();

export function flattenInformativeStatus(text: string): string {
  const joined = text
    .split("\n")
    .map((line) => line.trim().replace(/^[•-]\s+/u, ""))
    .filter(Boolean)
    .join(" · ");
  if (
    joined.length <= INFORMATIVE_MAX_CHARS &&
    utf8.encode(joined).length <= INFORMATIVE_MAX_BYTES
  ) {
    return joined;
  }
  const graphemes = Array.from(segmenter.segment(joined), (s) => s.segment);
  let chars = ELLIPSIS.length;
  let bytes = utf8.encode(ELLIPSIS).length;
  let start = graphemes.length;
  while (start > 0) {
    const next = graphemes[start - 1]!;
    const nextBytes = utf8.encode(next).length;
    if (chars + next.length > INFORMATIVE_MAX_CHARS || bytes + nextBytes > INFORMATIVE_MAX_BYTES) {
      break;
    }
    chars += next.length;
    bytes += nextBytes;
    start -= 1;
  }
  return ELLIPSIS + graphemes.slice(start).join("");
}
