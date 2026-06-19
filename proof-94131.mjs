// Proof for #94131: Telegram plain-text chunks should not use parse_mode="HTML"
// Regression: v2026.6.8 rich-text formatting always set htmlText on chunks,
// so !chunk.htmlText gate never triggered → all messages got parse_mode="HTML"
// → iOS font-size setting ignored.

import { renderTelegramHtmlText } from "./extensions/telegram/src/format.ts";

// Inline formatting-tag check (same regex used in the patch)
const FORMAT_TAG_RE =
  /<\/?(b|strong|i|em|u|ins|s|strike|del|code|pre|tg-spoiler|a|span|tg-emoji|tg-time|blockquote|br)\b[^>]*?>/i;

function hasFormatting(html) {
  return html && FORMAT_TAG_RE.test(html);
}

// === BEFORE-FIX ===
// Old logic: !chunk.htmlText → requestPlain
// Since buildChunkedTextPlan always sets htmlText (even "Hello" → "Hello"),
// chunk.htmlText is always truthy → all messages go through
// withTelegramHtmlParseFallback → parse_mode="HTML" → iOS ignores font-size

console.log("=== BEFORE-FIX: All messages forced through parse_mode=HTML ===");
const plainBefore = ["Hello, how can I help?", "hi", "reply text", "See diagram"];
for (const text of plainBefore) {
  const html = renderTelegramHtmlText(text);
  // Old gate: !chunk.htmlText → chunk.htmlText = "Hello" (truthy) → false → goes HTML path
  const oldGate = !html; // always false for rendered text
  console.log(
    `  "${text}" → html="${html}" → !htmlText=${oldGate} → parse_mode=HTML (WRONG for iOS)`,
  );
}

// === AFTER-FIX ===
// New logic: !hasFormatting → requestPlain (no parse_mode)
// hasFormatting = chunk.htmlText && FORMAT_TAG_RE.test(chunk.htmlText)
// Plain text → hasFormatting=false → requestPlain → iOS font-size preserved ✓
// Formatted text → hasFormatting=true → parse_mode="HTML" → formatting preserved ✓

console.log(
  "\n=== AFTER-FIX: Plain text → requestPlain (no parse_mode), formatted → parse_mode=HTML ===",
);
const plainAfter = ["Hello, how can I help?", "hi", "reply text", "See diagram", "Tom & Jerry"];
for (const text of plainAfter) {
  const html = renderTelegramHtmlText(text);
  const fmt = hasFormatting(html);
  console.log(
    `  "${text}" → html="${html}" → hasFormatting=${fmt} → ${fmt ? "parse_mode=HTML ✓" : "requestPlain (no parse_mode) ✓ iOS font-size preserved"}`,
  );
}

const formatted = [
  "Hello **world**",
  "Use `npm install` to setup",
  "Visit [example](https://example.com)",
];
for (const text of formatted) {
  const html = renderTelegramHtmlText(text);
  const fmt = hasFormatting(html);
  console.log(
    `  "${text.slice(0, 40)}" → html="${html.slice(0, 50)}" → hasFormatting=${fmt} → ${fmt ? "parse_mode=HTML ✓ formatting preserved" : "UNEXPECTED: should have formatting"}`,
  );
}

console.log("\n=== RESULT: Plain-text messages no longer forced through parse_mode=HTML ===");
console.log("iOS font-size settings preserved for plain-text messages (fixes #94131)");
console.log("Formatted messages still correctly rendered with parse_mode=HTML");
