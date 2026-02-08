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
 *
 * URL autofix:
 *   bun scripts/external-message-lint.ts --sanitize-urls < draft.txt > draft.sanitized.txt
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
    "  --json           Emit machine-readable JSON",
    "  --strict         Treat line-count warnings as errors (12-line target)",
    "  --sanitize-urls  Strip URL query+fragment (stdout); print lint to stderr",
    "  --help           Show this help",
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
  const sanitizeUrls = argv.includes("--sanitize-urls");
  const help = argv.includes("--help") || argv.includes("-h");

  const fileIndex = argv.indexOf("--file");
  const file = fileIndex >= 0 ? argv[fileIndex + 1] : undefined;

  return { json, strict, sanitizeUrls, help, file } as const;
}

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

function firstNonEmptyLine(lines: string[]): string | undefined {
  return lines.find((l) => l.trim().length > 0);
}

function splitUrlAndSuffix(rawUrl: string): { url: string; suffix: string } {
  // Common in chat drafts: URLs are wrapped in parentheses or followed by punctuation.
  // Keep a separate suffix so we can sanitize the URL itself without losing punctuation.
  let i = rawUrl.length;
  while (i > 0 && /[).,;:!?"'\]]/.test(rawUrl[i - 1] ?? "")) {
    i -= 1;
  }
  return { url: rawUrl.slice(0, i), suffix: rawUrl.slice(i) };
}

function trimUrlPunctuation(url: string): string {
  return splitUrlAndSuffix(url).url;
}

function stripUrlQueryAndFragment(url: string): string {
  const cleaned = trimUrlPunctuation(url);

  const hashIdx = cleaned.indexOf("#");
  const withoutFrag = hashIdx >= 0 ? cleaned.slice(0, hashIdx) : cleaned;

  const qIdx = withoutFrag.indexOf("?");
  const withoutQuery = qIdx >= 0 ? withoutFrag.slice(0, qIdx) : withoutFrag;

  return withoutQuery;
}

function sanitizeUrlsInText(input: string): { text: string; changedCount: number } {
  let changedCount = 0;
  const out = input.replaceAll(/https?:\/\/\S+/g, (raw) => {
    const { url, suffix } = splitUrlAndSuffix(raw);
    const sanitizedUrl = stripUrlQueryAndFragment(url);
    if (sanitizedUrl !== url) changedCount += 1;
    return sanitizedUrl + suffix;
  });
  return { text: out, changedCount };
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

// Footguns: these can mass-notify channels on some platforms.
const MENTION_FOOTGUNS = ["@everyone", "@here", "<!channel>", "<!here>", "<!everyone>"];

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

const sanitized = args.sanitizeUrls ? sanitizeUrlsInText(text) : undefined;
if (sanitized) text = sanitized.text;
const sanitizedUrlCount = sanitized?.changedCount ?? 0;

const lines = text.split("\n");
const nonEmptyLines = lines.filter((l) => l.trim().length > 0);

const issues: Issue[] = [];
const add = (level: IssueLevel, code: string, message: string) => {
  issues.push({ level, code, message });
};

// Hard errors (policy/format breakers)

// Safety: internal sentinel tokens should never leak into external outbound messages.
// If you really need to discuss them, rephrase (e.g. “the agent returned an empty reply”).
if (/\bNO_REPLY\b/.test(text) || /\bHEARTBEAT_OK\b/.test(text)) {
  add(
    "error",
    "internal-sentinel",
    "Message contains an internal sentinel token (NO_REPLY/HEARTBEAT_OK). Remove it before sending externally.",
  );
}

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

// Markdown tables wrap badly in chat apps.
const pipeLines = lines
  .map((line, idx) => ({ line, lineNo: idx + 1, pipes: countMatches(line, /\|/g) }))
  .filter((x) => x.line.trim().length > 0)
  .filter((x) => x.pipes >= 2);

const looksLikeTableSeparator = lines.some((l) => /^\s*\|?\s*[-:]{3,}\s*\|/.test(l));

if (pipeLines.length >= 2 || looksLikeTableSeparator) {
  const sample = pipeLines
    .slice(0, 5)
    .map((x) => String(x.lineNo))
    .join(", ");

  add(
    "warn",
    "markdown-table",
    "Message looks like it contains a Markdown table (pipes '|'). Tables wrap badly in external chat. " +
      (sample ? `Examples on line(s): ${sample}. ` : "") +
      "Prefer short bullets instead.",
  );
}

const mentionHits = MENTION_FOOTGUNS.filter((m) => text.includes(m));
if (mentionHits.length > 0) {
  add(
    "warn",
    "mass-mention",
    `Message contains potential mass-mention token(s): ${mentionHits.join(", ")}. ` +
      "Consider removing to avoid notifying large groups.",
  );
}

// Helpful breakdown: question marks inside URL query strings still count towards the
// 1-'?' guardrail, and they're a common accidental violation.
const rawUrls = [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
const rawUrlsWithQuery = [...text.matchAll(/https?:\/\/\S+\?\S+/g)].map((m) => m[0]);

const urls = rawUrls.map(trimUrlPunctuation);
const urlsWithQuery = rawUrlsWithQuery.map(trimUrlPunctuation);

const urlQuerySuggestions = [...new Set(urlsWithQuery)]
  .map((u) => ({ original: u, suggested: stripUrlQueryAndFragment(u) }))
  .filter((x) => x.original !== x.suggested);

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

  const suggestions =
    urlQuerySuggestions.length > 0
      ? ` Suggested sanitized URL(s): ${urlQuerySuggestions
          .slice(0, 3)
          .map((x) => `${x.original} -> ${x.suggested}`)
          .join(" ")}${urlQuerySuggestions.length > 3 ? " ..." : ""}`
      : "";

  add(
    "error",
    "too-many-questions",
    `Found ${qCount} question marks ('?') total. ` +
      `Breakdown: ${qOutsideUrls} outside URLs, ${qInUrls} inside URLs.` +
      urlList +
      suggestions +
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

// Line wrapping guidance
// Chat surfaces wrap unpredictably; keep lines ~80–100 chars when possible.
const wrapTarget = 100;
const longLines = lines
  .map((line, idx) => ({ line, lineNo: idx + 1 }))
  .filter((x) => x.line.trim().length > 0)
  .filter((x) => x.line.length > wrapTarget);

if (longLines.length > 0) {
  const longest = Math.max(...longLines.map((x) => x.line.length));
  const sample = longLines
    .slice(0, 5)
    .map((x) => `${x.lineNo}(${x.line.length})`)
    .join(", ");

  add(
    "warn",
    "long-lines",
    `Found ${longLines.length} line(s) longer than ${wrapTarget} chars ` +
      `(longest is ${longest}). Examples: ${sample}. ` +
      "Consider inserting line breaks; put URLs on their own line.",
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
  const suggestionText =
    urlQuerySuggestions.length > 0
      ? ` Suggestions: ${urlQuerySuggestions
          .slice(0, 3)
          .map((x) => `${x.original} -> ${x.suggested}`)
          .join(" ")}${urlQuerySuggestions.length > 3 ? " ..." : ""}`
      : "";

  add(
    "warn",
    "url-query",
    "Found URL(s) with '?'. Consider stripping query params to avoid breaking the 1-'?' rule." +
      suggestionText,
  );
}

function escapeRegExp(s: string): string {
  // Keep this script dependency-free; escape for safe regex construction.
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function includesTokenLike(haystack: string, token: string): boolean {
  // Match as a standalone token to reduce false positives (e.g. "session" in "possession").
  // Still allow a simple plural (trailing "s") so we catch "sessions" / "sub-agents".
  const escaped = escapeRegExp(token);
  const maybePlural = token.toLowerCase().endsWith("s") ? "" : "s?";
  const re = new RegExp(`(^|[^a-z0-9])${escaped}${maybePlural}([^a-z0-9]|$)`, "i");
  return re.test(haystack);
}

const jargonHits = INTERNAL_JARGON.filter((w) => includesTokenLike(text, w));
if (jargonHits.length > 0) {
  add(
    "warn",
    "internal-jargon",
    `Contains internal jargon (${[...new Set(jargonHits)].join(", ")}). Consider rewriting for end-users.`,
  );
}

// Commands: keep to <= 3 short lines when possible (per external messaging guardrails).
const commandLines = lines
  .map((line, idx) => ({ line, lineNo: idx + 1 }))
  .filter((x) => x.line.trimStart().startsWith("$ "));

if (commandLines.length > 3) {
  const sample = commandLines
    .slice(0, 5)
    .map((x) => String(x.lineNo))
    .join(", ");

  add(
    args.strict ? "error" : "warn",
    "too-many-commands",
    `Found ${commandLines.length} command line(s) starting with '$ ' (target is <= 3). ` +
      `Examples on line(s): ${sample}${commandLines.length > 5 ? " ..." : ""}. ` +
      "Consider shortening or moving extra details to follow-up text.",
  );
}

const result = {
  ok: !issues.some((i) => i.level === "error"),
  issues,
  sanitizeUrls: args.sanitizeUrls
    ? { enabled: true, changedCount: sanitizedUrlCount, sanitizedText: text }
    : { enabled: false as const },
};

function printReport(stream: NodeJS.WritableStream) {
  if (result.ok) {
    stream.write("OK: no errors found.\n");
  } else {
    stream.write("Errors found:\n");
  }

  for (const i of issues) {
    const prefix = i.level === "error" ? "ERROR" : "WARN";
    stream.write(`- ${prefix} [${i.code}]: ${i.message}\n`);
  }

  if (issues.length === 0) {
    stream.write("(No warnings.)\n");
  }
}

if (args.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (args.sanitizeUrls) {
  // In sanitize mode, print the sanitized message to stdout (pipe-friendly), and
  // print the lint report to stderr.
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  printReport(process.stderr);
} else {
  printReport(process.stdout);
}

process.exit(result.ok ? 0 : 1);
