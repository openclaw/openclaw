#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";
import { runAsScript } from "./lib/ts-guard-utils.mjs";

const DEFAULT_BASE_REF = "origin/main";
const DEFAULT_HEAD_REF = "HEAD";
const CODE_FILE_PATTERN = /\.[cm]?[jt]sx?$/u;
const TEST_PATH_PATTERN =
  /(?:^|\/)(?:test|tests|__tests__|test-utils|test-helpers)\/|(?:^|\/)[^/]*(?:test|spec|e2e)[^/]*\.[cm]?[jt]sx?$/u;
const FINDING_PATTERNS = [
  {
    pattern: /\bmkdtemp(?:Sync)?\s*\(/u,
    reason: "new mkdtemp temp directory creation",
  },
  {
    pattern: /\btmp\s*\.\s*dir(?:Sync)?\s*\(/u,
    reason: "new tmp.dir temp directory creation",
  },
];

function usage() {
  return `Usage: node scripts/report-test-temp-creations.mjs [options]

Description:
  Reports new bare test temp-directory creation patterns in added diff lines.
  This is a low-noise migration aid, not a cleanup data-flow checker. It does
  not scan existing lines and does not decide whether cleanup is sufficient.

Options:
  --base <ref>       Base ref for branch diffs. Default: ${DEFAULT_BASE_REF}
  --head <ref>       Head ref for branch diffs. Default: ${DEFAULT_HEAD_REF}
  --staged           Inspect staged changes instead of a branch diff.
  --json             Print JSON findings to stdout.
  --fail-on-findings Exit 1 when findings are present. Default is report-only.
  -h, --help         Show this help.

Outputs:
  Human mode prints findings to stderr and exits 0 unless --fail-on-findings is set.
  JSON mode prints an array of { file, line, reason, source } to stdout.

Examples:
  node scripts/report-test-temp-creations.mjs --base origin/main --head HEAD
  node scripts/report-test-temp-creations.mjs --staged --json
`;
}

function normalizePath(filePath) {
  return String(filePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

function isTestFile(filePath) {
  const normalizedPath = normalizePath(filePath);
  return CODE_FILE_PATTERN.test(normalizedPath) && TEST_PATH_PATTERN.test(normalizedPath);
}

function parseArgs(argv) {
  const args = {
    base: DEFAULT_BASE_REF,
    failOnFindings: false,
    head: DEFAULT_HEAD_REF,
    help: false,
    json: false,
    staged: false,
  };
  return parseFlagArgs(argv, args, [
    stringFlag("--base", "base"),
    booleanFlag("--fail-on-findings", "failOnFindings"),
    stringFlag("--head", "head"),
    booleanFlag("-h", "help"),
    booleanFlag("--help", "help"),
    booleanFlag("--json", "json"),
    booleanFlag("--staged", "staged"),
  ]);
}

function readDiff(args, cwd = process.cwd()) {
  const diffArgs = args.staged
    ? ["diff", "--cached", "--unified=0", "--diff-filter=ACMR", "--"]
    : ["diff", "--unified=0", "--diff-filter=ACMR", `${args.base}...${args.head}`, "--"];
  return execFileSync("git", diffArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function collectTempCreationFindingsFromDiff(diffText) {
  const findings = [];
  let currentFile = null;
  let currentLine = 0;

  for (const line of diffText.split(/\r?\n/u)) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/u);
    if (fileMatch) {
      currentFile = normalizePath(fileMatch[1]);
      continue;
    }
    if (line === "+++ /dev/null") {
      currentFile = null;
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunkMatch) {
      currentLine = Number.parseInt(hunkMatch[1], 10);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (currentFile && isTestFile(currentFile)) {
        const source = line.slice(1);
        for (const { pattern, reason } of FINDING_PATTERNS) {
          if (pattern.test(source)) {
            findings.push({
              file: currentFile,
              line: currentLine,
              reason,
              source: source.trim(),
            });
            break;
          }
        }
      }
      currentLine += 1;
      continue;
    }

    if (line.startsWith(" ") || line === "") {
      currentLine += 1;
    }
  }

  return findings;
}

export async function main(argv, io) {
  const args = parseArgs(argv ?? process.argv.slice(2));
  const stdout = io?.stdout ?? process.stdout;
  const stderr = io?.stderr ?? process.stderr;
  if (args.help) {
    stdout.write(usage());
    return 0;
  }

  const findings = collectTempCreationFindingsFromDiff(readDiff(args));
  if (args.json) {
    stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  } else if (findings.length === 0) {
    stderr.write("No new bare test temp-directory creation patterns found.\n");
  } else {
    stderr.write("New bare test temp-directory creation patterns:\n");
    for (const finding of findings) {
      stderr.write(`- ${finding.file}:${finding.line} ${finding.reason}: ${finding.source}\n`);
    }
    stderr.write("Prefer test/helpers/temp-dir.ts for new test-owned temp directories.\n");
  }

  return args.failOnFindings && findings.length > 0 ? 1 : 0;
}

runAsScript(import.meta.url, async (argv, io) => {
  const exitCode = await main(argv, io);
  if (!io) {
    process.exitCode = exitCode;
  }
  return exitCode;
});
