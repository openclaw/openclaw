#!/usr/bin/env bun
/**
 * Lightweight linter for outbound messages that will be delivered to external chat
 * surfaces (WhatsApp/Signal/Telegram/etc.).
 *
 * Why: it’s easy to accidentally violate the “pasteable” guardrails (extra `?`,
 * Markdown headings, code fences, too many lines, etc.). This script catches the
 * most common issues before sending.
 *
 * Usage:
 *   cat draft.txt | bun scripts/external-message-lint.ts
 *   bun scripts/external-message-lint.ts --file draft.txt
 *   bun scripts/external-message-lint.ts --json < draft.txt
 */

import { readFile } from "node:fs/promises";

type IssueLevel = "error" | "warn";

type Issue = {
  level: IssueLevel;
  code: string;
  message: string;
};

function usage(): string {
  return [
    "external-message-lint: validate an outbound chat message against OpenClaw guardrails",
    "",
    "Usage:",
    "  cat draft.txt | bun scripts/external-message-lint.ts",
    "  bun scripts/external-message-lint.ts --file draft.txt",
    "",
    "Options:",
    "  --file <path>   Read message from a file instead of stdin",
    "  --json          Emit machine-readable JSON",
    "  --strict        Treat line-count warnings as errors (12-line target)",
    "  --help          Show this help",
    "",
    "Exit codes:",
    "  0 = OK (no errors)",
    "  1 = Errors found",
    "  2 = Usage / no input",
  ].join("\n");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseArgs(argv: string[]) {
  const json = argv.includes("--json");
  const strict = argv.includes("--strict");
  const help = argv.includes("--help") || argv.includes("-h");

  const fileIndex = argv.indexOf("--file");
  const file = fileIndex >= 0 ? argv[fileIndex + 1] : undefined;

  return { json, strict, help, file } as const;
}

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

function firstNonEmptyLine(lines: string[]): string | undefined {
  return lines.find((l) => l.trim().length > 0);
}

const INTERNAL_JARGON = [
  "tool",
  "tools",
  "sandbox",
  "exec",
  "allowlist",
  "session",
  "sub-agent",
  "subagent",
];

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

let text = "";
if (args.file) {
  text = await readFile(args.file, "utf8");
} else {
  // If run interactively with no stdin, we’ll end up with an empty string.
  text = await readStdin();
}

if (!text.trim()) {
  console.error(usage());
  process.exit(2);
}

text = text.replaceAll("\r\n", "\n");
const lines = text.split("\n");
const nonEmptyLines = lines.filter((l) => l.trim().length > 0);

const issues: Issue[] = [];
const add = (level: IssueLevel, code: string, message: string) => {
  issues.push({ level, code, message });
};

// Hard errors (policy/format breakers)
if (lines.some((l) => l.startsWith("#"))) {
  add(
    "error",
    "markdown-heading",
    "A line starts with '#'. Avoid Markdown headings in external chat replies.",
  );
}

if (text.includes("```")) {
  add(
    "error",
    "code-fence",
    "Message contains ``` fenced code blocks. Use plain text; keep commands short.",
  );
}

// Helpful breakdown: question marks inside URL query strings still count towards the
// 1-'?' guardrail, and they're a common accidental violation.
const urls = [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
const urlsWithQuery = [...text.matchAll(/https?:\/\/\S+\?\S+/g)].map((m) => m[0]);
const qInUrls = urls.reduce((acc, url) => acc + countMatches(url, /\?/g), 0);

const qCount = countMatches(text, /\?/g);
if (qCount > 1) {
  const qOutsideUrls = Math.max(0, qCount - qInUrls);
  const urlList =
    urlsWithQuery.length > 0
      ? ` URL(s) with '?': ${urlsWithQuery.slice(0, 3).join(" ")}${
          urlsWithQuery.length > 3 ? " ..." : ""
        }`
      : "";

  add(
    "error",
    "too-many-questions",
    `Found ${qCount} question marks ('?') total. ` +
      `Breakdown: ${qOutsideUrls} outside URLs, ${qInUrls} inside URLs.` +
      urlList +
      " External replies should contain at most one. Strip URL query params and bundle clarifications into a single question.",
  );
}

// Length guidance
const hardCap = 18;
const target = 12;
if (nonEmptyLines.length > hardCap) {
  add(
    "error",
    "too-long-hardcap",
    `Too long: ${nonEmptyLines.length} non-empty lines (hard cap is ${hardCap}). ` +
      "Trim to Outcome/Changed + top bullets + Next.",
  );
} else if (nonEmptyLines.length > target) {
  add(
    args.strict ? "error" : "warn",
    "too-long-target",
    `Long: ${nonEmptyLines.length} non-empty lines (target is ${target}). ` +
      "Consider trimming.",
  );
}

// Soft warnings (common footguns)
const firstLine = firstNonEmptyLine(lines);
if (firstLine && !/^(Outcome|Done):\s*/.test(firstLine.trim())) {
  add(
    "warn",
    "missing-outcome",
    "First non-empty line should usually start with 'Outcome:' (or 'Done:') so it reads well in chat.",
  );
}

if (urlsWithQuery.length > 0) {
  add(
    "warn",
    "url-query",
    "Found URL(s) with '?'. Consider stripping query params to avoid breaking the 1-'?' rule.",
  );
}

const lower = text.toLowerCase();
const jargonHits = INTERNAL_JARGON.filter((w) => lower.includes(w));
if (jargonHits.length > 0) {
  add(
    "warn",
    "internal-jargon",
    `Contains internal jargon (${[...new Set(jargonHits)].join(", ")}). Consider rewriting for end-users.`,
  );
}

const result = {
  ok: !issues.some((i) => i.level === "error"),
  issues,
};

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  if (result.ok) {
    console.log("OK: no errors found.");
  } else {
    console.log("Errors found:");
  }

  for (const i of issues) {
    const prefix = i.level === "error" ? "ERROR" : "WARN";
    console.log(`- ${prefix} [${i.code}]: ${i.message}`);
  }

  if (issues.length === 0) {
    // Still show a minimal summary when OK, in non-JSON mode.
    console.log("(No warnings.)");
  }
}

process.exit(result.ok ? 0 : 1);
