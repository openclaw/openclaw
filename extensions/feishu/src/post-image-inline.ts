// Feishu plugin module: single source for the content_v2 inline-image boundary.
// Extraction (which ![alt](image_key) refs are real) and replacement must agree on
// the same code-block boundary, else a key gets downloaded but its ref never
// rewritten (or vice versa). Keep both here so they can never drift.
import { normalizeFeishuExternalKey } from "./external-keys.js";

// image_key is the parenthesized URL: ![alt](image_key). Same-shaped text inside
// code blocks is a literal example and is excluded by masking spans first.
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

function maskCodeSpans(text: string): string {
  // Replace fenced ```...``` and inline `...` with equal-length spaces so the
  // remaining character offsets stay aligned with the original text.
  return text
    .replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length))
    .replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
}

/** Non-code-block image_keys in order, deduped (one image referenced twice is one download). */
export function extractMarkdownImageKeys(text: string): string[] {
  const masked = maskCodeSpans(text);
  const keys = new Set<string>();
  for (const match of masked.matchAll(MARKDOWN_IMAGE_RE)) {
    const key = normalizeFeishuExternalKey(match[1]);
    if (key) {
      keys.add(key);
    }
  }
  return [...keys];
}

/**
 * Rewrite non-code-block ![alt](image_key) to ![alt](local_path) in place. Code-block
 * text (fenced/inline) stays literal; a key with no path (download failed) keeps its
 * ref. Only the parenthesized URL segment is spliced — alt text containing "(key)" is
 * left intact, and the path is inserted literally (no String.replace pattern semantics,
 * so "$" in a local path can't corrupt output).
 */
export function inlineReplacePostImages(text: string, keyToPath: Map<string, string>): string {
  if (keyToPath.size === 0) {
    return text;
  }
  const masked = maskCodeSpans(text);
  let out = "";
  let last = 0;
  for (const match of masked.matchAll(MARKDOWN_IMAGE_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const rawKey = match[1];
    const path = keyToPath.get(normalizeFeishuExternalKey(rawKey) || rawKey);
    out += text.slice(last, start);
    if (path) {
      // URL is the final token: ![alt](URL). Splice only [urlStart, urlEnd) = the URL,
      // located by offset from the closing ")", so alt text is never touched.
      const urlEnd = end - 1;
      const urlStart = urlEnd - rawKey.length;
      out += text.slice(start, urlStart) + path + text.slice(urlEnd, end);
    } else {
      out += text.slice(start, end); // download failed: keep original ref
    }
    last = end;
  }
  out += text.slice(last);
  return out;
}
