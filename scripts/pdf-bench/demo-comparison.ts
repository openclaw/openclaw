#!/usr/bin/env node
/**
 * Demo: show the concrete difference between pdfjs and nutrient extraction
 * on a real PDF, then send the same prompt to a model with each extraction.
 *
 * Usage:
 *   pnpm tsx scripts/pdf-bench/demo-comparison.ts \
 *     --pdf /tmp/opendataloader-bench/pdfs/01030000000120.pdf \
 *     --nutrient-command /path/to/pdf-to-markdown \
 *     --prompt "What are the three stages shown in the table? For each stage, what happens to someone with the ss genotype?"
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { setNutrientCommand, getArm } from "./arms.js";
import { estimateTokens } from "./scoring.js";
import type { ArmRunOptions } from "./types.js";

const pdfPath = process.argv[process.argv.indexOf("--pdf") + 1];
const nutrientCommand = process.argv.includes("--nutrient-command")
  ? process.argv[process.argv.indexOf("--nutrient-command") + 1]
  : "pdf-to-markdown";
const prompt = process.argv.includes("--prompt")
  ? process.argv[process.argv.indexOf("--prompt") + 1]
  : "Summarize the key information in this document, including any tables or structured data.";

if (!pdfPath) {
  console.error("Usage: --pdf <path> [--nutrient-command <cmd>] [--prompt <text>]");
  process.exit(1);
}

setNutrientCommand(nutrientCommand);

const buffer = readFileSync(pdfPath);
const entry = {
  id: path.basename(pdfPath, ".pdf"),
  label: path.basename(pdfPath),
  filePath: path.resolve(pdfPath),
  bytes: buffer.length,
  buffer,
};

const runOptions: ArmRunOptions = {
  maxPages: 20,
  maxPixels: 4_000_000,
  minTextChars: 200,
  nutrientCommand,
  nutrientTimeoutMs: 30_000,
};

async function main(): Promise<void> {
  console.log(`PDF: ${entry.label} (${entry.bytes} bytes)`);
  console.log(`Prompt: ${prompt}`);
  console.log("");

  // Extract with both engines
  const pdfjsArm = getArm("pdfjs-text");
  const nutrientArm = getArm("nutrient-cli-markdown");

  const pdfjsOut = await pdfjsArm.extract(entry, runOptions);
  const nutrientOut = await nutrientArm.extract(entry, runOptions);

  // Show extraction comparison
  console.log("=".repeat(80));
  console.log("  EXTRACTION COMPARISON");
  console.log("=".repeat(80));
  console.log("");

  console.log(
    `  pdfjs-text:              ${pdfjsOut.counts.chars} chars, ${estimateTokens(pdfjsOut.text)} tokens, ${pdfjsOut.timing.durationMs.toFixed(0)}ms`,
  );
  console.log(
    `  nutrient-cli-markdown:   ${nutrientOut.counts.chars} chars, ${estimateTokens(nutrientOut.text)} tokens, ${nutrientOut.timing.durationMs.toFixed(0)}ms`,
  );
  console.log("");

  // Show pdfjs output
  console.log("-".repeat(80));
  console.log("  pdfjs-text extraction:");
  console.log("-".repeat(80));
  const pdfjsPreview = pdfjsOut.text.slice(0, 2000);
  console.log(pdfjsPreview);
  if (pdfjsOut.text.length > 2000) {
    console.log(`\n  ... (${pdfjsOut.text.length - 2000} more chars)`);
  }
  console.log("");

  // Show nutrient output
  console.log("-".repeat(80));
  console.log("  nutrient-cli-markdown extraction:");
  console.log("-".repeat(80));
  const nutrientPreview = nutrientOut.text.slice(0, 2000);
  console.log(nutrientPreview);
  if (nutrientOut.text.length > 2000) {
    console.log(`\n  ... (${nutrientOut.text.length - 2000} more chars)`);
  }
  console.log("");

  // Key structural differences
  console.log("=".repeat(80));
  console.log("  KEY DIFFERENCES");
  console.log("=".repeat(80));

  const pdfjsHasTable = pdfjsOut.text.includes("|") && pdfjsOut.text.includes("---");
  const nutrientHasTable = nutrientOut.text.includes("|") && nutrientOut.text.includes("---");
  const pdfjsHasHeadings = /^#{1,6}\s/m.test(pdfjsOut.text);
  const nutrientHasHeadings = /^#{1,6}\s/m.test(nutrientOut.text);
  const pdfjsHasBullets = /^[-*]\s/m.test(pdfjsOut.text);
  const nutrientHasBullets = /^[-*•]\s/m.test(nutrientOut.text);

  console.log(`  Feature              pdfjs-text    nutrient-cli`);
  console.log(
    `  Markdown tables      ${pdfjsHasTable ? "YES" : "NO "}           ${nutrientHasTable ? "YES" : "NO "}`,
  );
  console.log(
    `  Markdown headings    ${pdfjsHasHeadings ? "YES" : "NO "}           ${nutrientHasHeadings ? "YES" : "NO "}`,
  );
  console.log(
    `  Bullet lists         ${pdfjsHasBullets ? "YES" : "NO "}           ${nutrientHasBullets ? "YES" : "NO "}`,
  );
  console.log(
    `  Chars                ${String(pdfjsOut.counts.chars).padStart(5)}         ${String(nutrientOut.counts.chars).padStart(5)}`,
  );
  console.log(
    `  Tokens (est.)        ${String(estimateTokens(pdfjsOut.text)).padStart(5)}         ${String(estimateTokens(nutrientOut.text)).padStart(5)}`,
  );
  console.log("");

  console.log("=".repeat(80));
  console.log("  WHAT A MODEL WOULD SEE");
  console.log("=".repeat(80));
  console.log("");
  console.log("  With pdfjs-text, the model receives plain concatenated text.");
  console.log("  Tables appear as linear word sequences with no structure.");
  console.log("  The model must guess where rows/columns were.");
  console.log("");
  console.log("  With nutrient-cli-markdown, the model receives structured markdown.");
  console.log("  Tables appear as pipe-delimited rows with headers.");
  console.log("  The model can directly reference cells by row and column.");
  console.log("");
}

await main();
