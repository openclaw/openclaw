#!/usr/bin/env node
/**
 * OpenClaw message lint (external-chat guardrails)
 *
 * Purpose: catch common formatting pitfalls before a message is sent to
 * WhatsApp/Signal/Telegram/etc.
 *
 * Run examples:
 *   $ node --import tsx scripts/message-lint.ts --file /tmp/msg.txt
 *   $ pbpaste | node --import tsx scripts/message-lint.ts
 */

import fs from "node:fs/promises";

type Severity = "error" | "warn";

type Finding = {
  severity: Severity;
  message: string;
  line?: number;
};

function add(
  findings: Finding[],
  severity: Severity,
  message: string,
  line?: number,
) {
  findings.push({ severity, message, line });
}

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function lintExternalChat(text: string): Finding[] {
  const findings: Finding[] = [];
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmptyIdx === -1) {
    add(findings, "error", "Message is empty.");
    return findings;
  }

  const firstLine = lines[firstNonEmptyIdx].trim();
  if (!/^(Outcome|Done):\s*/.test(firstLine)) {
    add(
      findings,
      "warn",
      "First non-empty line should start with 'Outcome:' (or 'Done:') for chat surfaces.",
      firstNonEmptyIdx + 1,
    );
  }

  // Hard fails (often render badly / violate channel guardrails)

  // Safety: internal sentinel tokens should never leak into externally delivered messages.
  // If you need to mention them, rephrase (e.g. “the agent returned an empty reply”).
  if (/\bNO_REPLY\b/.test(normalized) || /\bHEARTBEAT_OK\b/.test(normalized)) {
    add(
      findings,
      "error",
      "Message contains an internal sentinel token (NO_REPLY/HEARTBEAT_OK). Remove it before sending externally.",
    );
  }

  if (normalized.includes("```")) {
    add(findings, "error", "Avoid fenced code blocks (``` ... ```) on chat surfaces.");
  }

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("#")) {
      add(
        findings,
        "error",
        "Avoid Markdown headings (lines starting with '#') on chat surfaces.",
        i + 1,
      );
    }
  }

  const qCount = (normalized.match(/\?/g) ?? []).length;
  if (qCount > 1) {
    add(
      findings,
      "error",
      `Found ${qCount} question marks. External replies should ask at most 1 question total.`,
    );
  }

  // Soft guidance
  const urlRegex = /https?:\/\/\S+/g;
  const urls = normalized.match(urlRegex) ?? [];
  for (const url of urls) {
    if (url.includes("?")) {
      add(
        findings,
        "warn",
        `URL contains a '?' (query params): ${url.replace(/\s/g, "")} — consider stripping params.`,
      );
    }
    if (url.length > 120) {
      add(findings, "warn", `Very long URL (${url.length} chars) may wrap badly: ${url}`);
    }
  }

  const maxLineLen = 100;
  let longest = { len: 0, line: 0 };
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length;
    if (len > longest.len) longest = { len, line: i + 1 };
    if (len > maxLineLen) {
      add(
        findings,
        "warn",
        `Line ${i + 1} is ${len} chars; consider wrapping to ~${maxLineLen} for pasteability.`,
        i + 1,
      );
    }
  }

  const nonEmptyLineCount = lines.filter((l) => l.trim().length > 0).length;
  if (nonEmptyLineCount > 18) {
    add(
      findings,
      "warn",
      `Message has ${nonEmptyLineCount} non-empty lines; consider shortening to ~12 lines (hard cap ~18).`,
    );
  }

  // Catch internal jargon that often confuses external recipients.
  const jargon = [
    "sandbox",
    "tool call",
    "allowlist",
    "pty",
    "TTY",
    "session",
    "exec",
    "jq",
  ];
  const lower = normalized.toLowerCase();
  for (const term of jargon) {
    if (lower.includes(term.toLowerCase())) {
      add(findings, "warn", `Contains internal jargon ('${term}'); consider rewriting.`);
    }
  }

  // If we emitted a line-length warning for many lines, add a single summary tip.
  const lineLenWarns = findings.filter((f) =>
    f.message.includes("consider wrapping to"),
  ).length;
  if (lineLenWarns >= 6 && longest.len > maxLineLen) {
    add(
      findings,
      "warn",
      `Many long lines detected (longest: ${longest.len} chars at line ${longest.line}).`,
    );
  }

  return findings;
}

function printFindings(findings: Finding[]) {
  for (const f of findings) {
    const where = f.line ? ` (line ${f.line})` : "";
    // Keep output grep-friendly.
    process.stdout.write(`[${f.severity}]${where} ${f.message}\n`);
  }
}

async function main() {
  const file = getArg("--file");
  const mode = (getArg("--mode") ?? "external").toLowerCase();

  if (hasFlag("--help") || hasFlag("-h")) {
    process.stdout.write(
      [
        "message-lint: quick checks for external-chat formatting",
        "",
        "Usage:",
        "  node --import tsx scripts/message-lint.ts [--file path] [--mode external]",
        "  cat /tmp/msg.txt | node --import tsx scripts/message-lint.ts",
        "",
        "Exit codes:",
        "  0 = OK (or warnings only)",
        "  1 = errors found",
      ].join("\n") + "\n",
    );
    return;
  }

  const text = file ? await fs.readFile(file, "utf8") : await readStdin();

  if (mode !== "external") {
    process.stderr.write(`Unknown --mode '${mode}'. Only 'external' is supported.\n`);
    process.exitCode = 1;
    return;
  }

  const findings = lintExternalChat(text);
  const errors = findings.filter((f) => f.severity === "error");

  if (findings.length === 0) {
    process.stdout.write("OK: message passes external-chat lint.\n");
    return;
  }

  printFindings(findings);

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exitCode = 1;
});
