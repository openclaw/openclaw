// Feishu plugin module inlines content_v2 image refs with downloaded local paths.

// content_v2 image merge: rewrite non-code-block ![alt](image_key) in place to
// ![alt](local_path). Same-shaped text inside code blocks (fenced/inline) stays
// literal; a key with no local path (download failed) keeps its original ref.
// Mirror post.ts extractMarkdownImageKeys code-block boundaries so extraction and
// replacement never disagree on which refs are real.
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

function maskCodeSpans(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length))
    .replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
}

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
    const key = match[1];
    const path = keyToPath.get(key);
    // Slice from the original text (masked only locates non-code-block matches) so
    // alt text and original characters are preserved.
    out += text.slice(last, start);
    if (path) {
      const original = text.slice(start, end);
      out += original.replace(`(${key})`, `(${path})`);
    } else {
      out += text.slice(start, end); // download failed: keep original ref
    }
    last = end;
  }
  out += text.slice(last);
  return out;
}
