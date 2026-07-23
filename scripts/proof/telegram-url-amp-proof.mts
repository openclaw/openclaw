// Real behavior proof for #102162: Telegram renders bare URLs containing `&`
// in their query string with the `&` HTML-escaped to `&amp;`, which Telegram
// clients display literally and navigate to incorrectly (query params dropped).
//
// This script exercises the PRODUCTION formatter code paths
// (markdownToTelegramHtml legacy + markdownToTelegramRichHtml rich) on a bare
// URL with a multi-parameter query string, and inspects the emitted anchor HTML
// to show whether the `&` reaches the href / visible text intact or as `&amp;`.
//
// Run: pnpm exec tsx scripts/proof/telegram-url-amp-proof.mts

import {
  markdownToTelegramHtml,
  markdownToTelegramRichHtml,
} from "../../extensions/telegram/src/format.js";

const URL_WITH_AMP = "https://example.com/wp-admin/post.php?post=100&action=edit";

function analyzeAnchor(html: string, label: string): void {
  // Pull the first <a href="...">...</a> the formatter emitted.
  const anchorMatch = html.match(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
  if (!anchorMatch) {
    console.log(`  [${label}] NO anchor emitted. Full output:`);
    console.log(`    ${html}`);
    return;
  }
  const hrefAttr = anchorMatch[1] ?? "";
  const visibleText = anchorMatch[2] ?? "";
  const hrefHasAmp = hrefAttr.includes("&amp;");
  const textHasAmp = visibleText.includes("&amp;");
  console.log(`  [${label}] href attr     : ${hrefAttr}`);
  console.log(`  [${label}] visible text  : ${visibleText}`);
  console.log(`  [${label}] href has &amp;     : ${hrefHasAmp ? "YES (BUG)" : "no"}`);
  console.log(
    `  [${label}] text has &amp;     : ${textHasAmp ? "yes (ok: Telegram decodes text content)" : "no"}`,
  );
  // A navigable link must keep the raw `&` separator after a single decode.
  const navigable = hrefAttr.includes("post=100&action=edit");
  console.log(`  [${label}] href navigable    : ${navigable ? "YES" : "NO (broken)"}`);
}

console.log("=== #102162 Telegram bare-URL amp proof ===");
console.log(`Input bare URL: ${URL_WITH_AMP}`);
console.log("(markdown linkify auto-detects the bare URL into a link span)");
console.log("");

console.log("--- markdownToTelegramHtml (legacy HTML mode, richMessages default) ---");
const legacy = markdownToTelegramHtml(`See ${URL_WITH_AMP} for details.`);
console.log(`  emitted html: ${legacy}`);
analyzeAnchor(legacy, "legacy");
console.log("");

console.log("--- markdownToTelegramRichHtml (rich HTML mode) ---");
const rich = markdownToTelegramRichHtml(`See ${URL_WITH_AMP} for details.`);
console.log(`  emitted html: ${rich}`);
analyzeAnchor(rich, "rich");
console.log("");

// Summary verdict — the bug (#102162) is that the <a href> attribute carries
// the query "&" as "&amp;", which Telegram does not decode, so navigation drops
// every parameter after the first "&". The bubble's visible text uses
// "&amp;", which Telegram DOES decode as text content, so only the href matters.
const extractHref = (html: string): string | null => html.match(/<a\s+href="([^"]*)"/)?.[1] ?? null;
const legacyHref = extractHref(legacy);
const richHref = extractHref(rich);
const hrefNavigable =
  legacyHref != null &&
  legacyHref.includes("post=100&action=edit") &&
  richHref != null &&
  richHref.includes("post=100&action=edit");
console.log(
  hrefNavigable
    ? "RESULT: FIXED — bare auto-link <a href> keeps the query '&' raw and is navigable."
    : "RESULT: BUG PRESENT — <a href> encodes '&' as '&amp;' and drops params.",
);
