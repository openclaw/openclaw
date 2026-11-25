import { RAW_TEXT_TAGS, readRawTextBounds } from "./html-scanner.js";
import { matchMarkdownHtmlTag, tokenizeHtmlTags } from "./html-tags.js";
import { parseMarkdownOwnership } from "./reasoning-tag-parser.js";

/** Removes authored HTML before block parsing while preserving code and escaped literals. */
export function stripHtmlFromMarkdown(markdown: string): string {
  const firstTagStart = markdown.indexOf("<");
  if (firstTagStart === -1) {
    return markdown;
  }
  const { textSpans } = parseMarkdownOwnership(markdown, { includeText: true });
  let output = "";
  let cursor = 0;
  let textSpanIndex = 0;
  for (let start = firstTagStart; start !== -1; start = markdown.indexOf("<", start + 1)) {
    // Text spans and tag candidates follow source order, so each span is retired once.
    let textSpan = textSpans[textSpanIndex];
    while (textSpan && textSpan[1] <= start) {
      textSpanIndex += 1;
      textSpan = textSpans[textSpanIndex];
    }
    if (!textSpan || start < textSpan[0]) {
      continue;
    }
    let escaped = false;
    for (let index = start - 1; markdown[index] === "\\"; index -= 1) {
      escaped = !escaped;
    }
    if (escaped) {
      continue;
    }
    const raw = matchMarkdownHtmlTag(markdown.slice(start));
    if (!raw) {
      continue;
    }
    const tag = tokenizeHtmlTags(raw).next().value;
    output += markdown.slice(cursor, start);
    cursor =
      tag && !tag.closing && RAW_TEXT_TAGS.has(tag.name)
        ? readRawTextBounds(markdown, tag.name, start + raw.length).end
        : start + raw.length;
    if (tag && (tag.name === "br" || tag.name === "hr")) {
      output += "\n";
    }
    start = cursor - 1;
  }
  return output + markdown.slice(cursor);
}
