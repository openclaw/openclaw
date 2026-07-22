/**
 * Dependency-free HTML->text extraction for the unsandboxed fallback path
 * of fetchAndExtractSandboxed. Not full Mozilla-Readability-grade article
 * parsing -- strips markup and returns readable text; a JS-heavy SPA with
 * no server-rendered content will yield little or no text rather than
 * erroring, which is the intended graceful-degradation behavior, not a bug.
 *
 * Ported from the shagholam-system deployment's plugins/fuzul-research/
 * html-extract.ts, including two real bugs found and fixed there: (1)
 * entity decoding must be a single pass over the original string, not
 * sequential per-entity replace, or double-escaped content
 * ("&amp;amp;lt;") cascades past its correct single-level decode; (2) an
 * unclosed block tag (malformed/adversarial <script>) must be stripped to
 * end-of-string as a conservative fallback, or its raw body leaks
 * unstripped into the output.
 */

const STRIP_BLOCK_TAGS = ["script", "style", "nav", "header", "footer", "noscript"];

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

const ENTITY_PATTERN = new RegExp(
  `${Object.keys(ENTITY_MAP)
    .map((entity) => entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")}|&#(\\d+);`,
  "g",
);

function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (match, numericCode?: string) => {
    if (numericCode !== undefined) {
      return String.fromCharCode(Number(numericCode));
    }
    return ENTITY_MAP[match] ?? match;
  });
}

export function extractCleanTextCore(html: string, maxChars: number): string {
  let text = html;
  for (const tag of STRIP_BLOCK_TAGS) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
    // Unclosed opener fallback: strip from an unmatched opening tag to
    // end-of-string, rather than leaving its raw body entirely unstripped.
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*$`, "gi"), " ");
  }
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}... [truncated]`;
  }
  return text;
}
