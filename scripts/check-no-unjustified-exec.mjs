#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

// Forward-hygiene guard for SEC-1: prevent new unjustified shell-execution
// surfaces from entering production code.
//
// Triage of the audit's "185 exec/execSync sites" claim found the vast
// majority were method-call collisions (regex `.exec()`, SQLite `db.exec()`,
// etc.). The real production child_process surface is tiny, and every current
// site either (a) uses literal/hash-derived input with no injection vector,
// or (b) has a documented justification for shell semantics.
//
// This guard locks that state in. New src/** code that imports `exec` or
// `execSync` from `node:child_process`, or passes `shell: true` to a spawn
// family, fails CI unless the file is explicitly allowlisted below. The
// intent is to force reviewers to see the justification before a new raw
// shell surface lands.

export const CHILD_PROCESS_IMPORT_SOURCES = Object.freeze(["node:child_process", "child_process"]);

// Files in src/** where shell semantics are intentional. Each entry requires
// an inline justification comment in the file itself, not just this list.
export const EXEC_IMPORT_ALLOWLIST = Object.freeze([
  // Reads macOS Keychain via `security` CLI. `account` is a SHA-256 hex
  // digest and the service name is a compile-time constant — no caller
  // input is interpolated into the shell surface.
  "src/agents/cli-credentials.ts",
]);

export const SHELL_TRUE_ALLOWLIST = Object.freeze([
  // Operator-only local TUI `!`-prefixed shell. Gated behind an in-session
  // approval prompt; shell semantics are the feature.
  "src/tui/tui-local-shell.ts",
  // Windows .cmd/.bat wrapper invocation for bundled-plugin installs.
  // `npm.cmd` requires shell resolution on Windows.
  "src/plugins/bundled-runtime-deps.ts",
  // Windows spawn fallback when a Node entrypoint cannot be resolved.
  "src/plugin-sdk/windows-spawn.ts",
  // Core exec wrapper; shell is enabled only via the explicit
  // shouldSpawnWithShell(...) gate driven by resolver output, not user input.
  "src/process/exec.ts",
]);

const EXEC_IMPORT_ALLOWSET = new Set(EXEC_IMPORT_ALLOWLIST);
const SHELL_TRUE_ALLOWSET = new Set(SHELL_TRUE_ALLOWLIST);

const TEST_FILE_RE =
  /\.(test|e2e\.test|live\.test)\.tsx?$|[._-](test-harness|test-helpers|test-support)\.ts$/u;

function isTestPath(relativePath) {
  return TEST_FILE_RE.test(relativePath);
}

export function listSrcTypeScriptFiles(cwd = process.cwd()) {
  const output = execFileSync("git", ["ls-files", "-z", "--", "src/"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split("\0")
    .filter(Boolean)
    .filter((rel) => /\.(ts|tsx)$/u.test(rel))
    .map((rel) => ({
      relativePath: rel,
      absolutePath: path.join(cwd, rel),
    }));
}

function readFileSafely(absolutePath) {
  try {
    const st = statSync(absolutePath);
    if (!st.isFile()) {
      return null;
    }
    return readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }
}

// Match either a full import line or a from-statement capturing the specifier
// block so we can inspect which bindings are pulled out of child_process.
const CHILD_PROCESS_IMPORT_RE = /import[\s\S]*?from\s+["'](node:child_process|child_process)["']/gu;

function extractBindings(importStatement) {
  const braceMatch = importStatement.match(/\{([\s\S]*?)\}/u);
  if (!braceMatch) {
    return [];
  }
  return braceMatch[1]
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/\s+as\s+.*$/u, "")
        .trim(),
    )
    .filter(Boolean);
}

export function findExecImportViolations(contents) {
  const matches = contents.matchAll(CHILD_PROCESS_IMPORT_RE);
  const violations = [];
  for (const match of matches) {
    const bindings = extractBindings(match[0]);
    const risky = bindings.filter((b) => b === "exec" || b === "execSync");
    if (risky.length > 0) {
      violations.push({ bindings: risky });
    }
  }
  return violations;
}

const SHELL_TRUE_RE = /\bshell\s*:\s*true\b/gu;

export function findShellTrueViolations(contents) {
  const matches = [...contents.matchAll(SHELL_TRUE_RE)];
  return matches.length;
}

function formatViolation(kind, file, detail) {
  return `${kind}\t${file}\t${detail}`;
}

async function main() {
  process.stdout.on("error", (error) => {
    if (error?.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });

  const files = listSrcTypeScriptFiles();
  const violations = [];

  for (const file of files) {
    if (isTestPath(file.relativePath)) {
      continue;
    }
    const contents = readFileSafely(file.absolutePath);
    if (contents === null) {
      continue;
    }

    if (!EXEC_IMPORT_ALLOWSET.has(file.relativePath)) {
      const execViolations = findExecImportViolations(contents);
      for (const v of execViolations) {
        violations.push(formatViolation("exec-import", file.relativePath, v.bindings.join(",")));
      }
    }

    if (!SHELL_TRUE_ALLOWSET.has(file.relativePath)) {
      const shellCount = findShellTrueViolations(contents);
      if (shellCount > 0) {
        violations.push(formatViolation("shell-true", file.relativePath, String(shellCount)));
      }
    }
  }

  if (violations.length === 0) {
    return;
  }

  process.stderr.write(
    `check-no-unjustified-exec: ${violations.length} unjustified shell-surface site(s) found in src/**.\n` +
      `Either migrate to execFile/spawn with array args (preferred), or add an\n` +
      `inline justification comment and allowlist the file in\n` +
      `scripts/check-no-unjustified-exec.mjs (EXEC_IMPORT_ALLOWLIST / SHELL_TRUE_ALLOWLIST).\n\n`,
  );
  for (const v of violations) {
    process.stdout.write(`${v}\n`);
  }
  process.exitCode = 1;
}

const invokedAsScript =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedAsScript) {
  await main();
}
