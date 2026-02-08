#!/usr/bin/env node

/**
 * scripts/message-lint.mjs
 *
 * Lightweight linter for outbound messages destined for chat surfaces
 * (WhatsApp/Signal/etc.). Encodes the repo's "fast lint" rules from
 * BOOTSTRAP.md so humans/agents can sanity-check a draft before sending.
 *
 * Usage:
 *   node scripts/message-lint.mjs --file /path/to/message.txt
 *   node scripts/message-lint.mjs --text "Outcome: ..."
 */

import fs from "node:fs";

/** @param {string} msg */
function lintMessage(msg) {
  /** @type {{level: "error" | "warn"; code: string; message: string}[]} */
  const issues = [];

  const text = String(msg ?? "");
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  // Rule: No Markdown headings (avoid lines that start with #).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("#")) {
      issues.push({
        level: "error",
        code: "no_markdown_headings",
        message: `Line ${i + 1} starts with '#'. Use plain labels like 'Outcome:' instead.`,
      });
      break;
    }
  }

  // Rule: No fenced code blocks.
  if (text.includes("```")) {
    issues.push({
      level: "error",
      code: "no_code_fences",
      message: "Message contains ``` code fences. Avoid fenced blocks for chat surfaces.",
    });
  }

  // Rule: Max one question mark.
  const questionCount = (text.match(/\?/g) || []).length;
  if (questionCount > 1) {
    issues.push({
      level: "error",
      code: "max_one_question",
      message: `Message contains ${questionCount} question marks. Keep to at most 1 '?'.`,
    });
  }

  // Rule: First non-empty line should start with Outcome: or Done:
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? "";
  if (firstNonEmpty && !(firstNonEmpty.startsWith("Outcome:") || firstNonEmpty.startsWith("Done:"))) {
    issues.push({
      level: "error",
      code: "starts_with_outcome",
      message: "First non-empty line should start with 'Outcome:' (or 'Done:').",
    });
  }

  // Rule: Commands should be short, prefixed with "$ ", and limited.
  const commandLines = lines.filter((l) => l.startsWith("$ "));
  if (commandLines.length > 3) {
    issues.push({
      level: "error",
      code: "max_three_commands",
      message: `Message contains ${commandLines.length} '$ ' command lines. Keep to <= 3.`,
    });
  }

  // Heuristic: common commands missing "$ " prefix.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    if (trimmed.startsWith("$ ")) continue;
    if (/^(sudo|openclaw|pnpm|bunx?|git|curl|ssh)\b/.test(trimmed)) {
      issues.push({
        level: "warn",
        code: "command_missing_prefix",
        message: `Line ${i + 1} looks like a command but doesn't start with '$ '.`,
      });
    }
  }

  // Soft rule: keep lines reasonably short for SMS-y clients.
  const MAX_LEN = 110;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LEN) {
      issues.push({
        level: "warn",
        code: "line_too_long",
        message: `Line ${i + 1} is ${line.length} chars (>${MAX_LEN}). Consider wrapping for readability.`,
      });
      // One warning is enough; avoid noisy output.
      break;
    }
  }

  return issues;
}

function usage() {
  console.error("Usage:\n  node scripts/message-lint.mjs --file <path>\n  node scripts/message-lint.mjs --text <string>");
  process.exit(2);
}

const args = process.argv.slice(2);
let filePath;
let textArg;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--file") {
    filePath = args[i + 1];
    i++;
  } else if (a === "--text") {
    textArg = args[i + 1];
    i++;
  } else if (a === "--help" || a === "-h") {
    usage();
  }
}

if (!filePath && !textArg) {
  usage();
}

let msg = "";
if (filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`message-lint: file not found: ${filePath}`);
    process.exit(2);
  }
  msg = fs.readFileSync(filePath, "utf8");
} else {
  msg = String(textArg ?? "");
}

const issues = lintMessage(msg);
if (issues.length === 0) {
  console.log("OK");
  process.exit(0);
}

let hasError = false;
for (const it of issues) {
  if (it.level === "error") hasError = true;
  const prefix = it.level.toUpperCase();
  console.log(`${prefix}: ${it.code}: ${it.message}`);
}

process.exit(hasError ? 1 : 0);
