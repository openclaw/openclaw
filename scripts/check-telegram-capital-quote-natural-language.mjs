import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCapitalQuoteNaturalLanguageMatch } from "../extensions/telegram/src/capital-quote-natural-language.ts";

const repoRoot = process.cwd();
const detectorPath = path.join(
  repoRoot,
  "extensions",
  "telegram",
  "src",
  "capital-quote-natural-language.ts",
);
const handlerPath = path.join(repoRoot, "extensions", "telegram", "src", "bot-handlers.runtime.ts");
const packagePath = path.join(repoRoot, "package.json");

const [detector, handler, packageText] = await Promise.all([
  fs.readFile(detectorPath, "utf8"),
  fs.readFile(handlerPath, "utf8"),
  fs.readFile(packagePath, "utf8"),
]);
const pkg = JSON.parse(packageText);

assert.match(detector, /QUOTE_INTENT_RE/u);
assert.match(detector, /A50/u);
assert.match(detector, /TXF current-month/u);
assert.match(detector, /TXF next-month/u);
assert.match(detector, /台指期當月/u);
assert.match(detector, /台指期下個月/u);
assert.match(detector, /台指近/u);
assert.match(detector, /原油期貨/u);
assert.match(detector, /CL0000/u);
assert.match(detector, /黃金期貨/u);
assert.match(detector, /GC0000/u);
assert.match(detector, /標普期貨/u);
assert.match(detector, /ES0000/u);
assert.match(detector, /那指期貨/u);
assert.match(detector, /NQ0000/u);
assert.match(detector, /目前價/u);
assert.match(detector, /openclaw-capital-quote-telegram-reply\.mjs/u);
assert.match(detector, /OpenClaw 報價/u);
assert.match(
  await fs.readFile(
    path.join(repoRoot, "scripts", "openclaw-capital-quote-telegram-reply.mjs"),
    "utf8",
  ),
  /refreshCapitalReportableQuoteState/u,
);

assert.match(handler, /buildCapitalQuoteNaturalLanguageReplyText/u);
assert.match(handler, /canBypassModelForQuote/u);
assert.match(handler, /hasBotMention/u);
assert.match(handler, /reply_parameters/u);

assert.equal(
  pkg.scripts["capital:telegram:quote-natural:check"],
  "node --import tsx scripts/check-telegram-capital-quote-natural-language.mjs",
);
assert.equal(
  pkg.scripts["capital:telegram:quote-natural-reply:check"],
  "node --import tsx scripts/check-telegram-capital-quote-natural-reply.mjs",
);
assert.equal(
  pkg.scripts["capital:telegram:quote-handler:check"],
  "node --import tsx scripts/check-telegram-capital-quote-handler-dry-run.mjs",
);

assert.deepEqual(resolveCapitalQuoteNaturalLanguageMatch("A50目前報價"), {
  query: "/quote A50",
  symbol: "A50",
});
assert.deepEqual(resolveCapitalQuoteNaturalLanguageMatch("台指近最新價"), {
  query: "/quote TX00",
  symbol: "TX00",
});
assert.deepEqual(resolveCapitalQuoteNaturalLanguageMatch("台指期當月報價"), {
  query: "/quote TXF current-month",
  symbol: "TXF current-month",
});
assert.deepEqual(resolveCapitalQuoteNaturalLanguageMatch("台指期下個月報價"), {
  query: "/quote TXF next-month",
  symbol: "TXF next-month",
});
assert.deepEqual(resolveCapitalQuoteNaturalLanguageMatch("原油期貨報"), {
  query: "/quote CL0000",
  symbol: "CL0000",
});
assert.deepEqual(resolveCapitalQuoteNaturalLanguageMatch("布蘭特油報價"), {
  query: "/quote BZ0000",
  symbol: "BZ0000",
});
assert.deepEqual(resolveCapitalQuoteNaturalLanguageMatch("黃金期貨目前價"), {
  query: "/quote GC0000",
  symbol: "GC0000",
});
assert.deepEqual(resolveCapitalQuoteNaturalLanguageMatch("標普期貨報價"), {
  query: "/quote ES0000",
  symbol: "ES0000",
});
assert.deepEqual(resolveCapitalQuoteNaturalLanguageMatch("那指期貨最新價"), {
  query: "/quote NQ0000",
  symbol: "NQ0000",
});
assert.equal(resolveCapitalQuoteNaturalLanguageMatch("A50"), null);
assert.equal(resolveCapitalQuoteNaturalLanguageMatch("/quote A50"), null);

process.stdout.write("telegram capital quote natural language check PASS\n");
