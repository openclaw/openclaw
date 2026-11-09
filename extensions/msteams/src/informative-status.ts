// Teams can run informative tool rows together. Keep visible separators and
// stay within its 1 KB / 1000-character limit without splitting graphemes.
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
