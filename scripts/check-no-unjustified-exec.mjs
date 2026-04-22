#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Forward-hygiene guard: prevent new unjustified shell-execution surfaces
// from entering production code under src/**. The current tree funnels
// child_process use through spawn/execFile with array args; this check
// locks that in and flags any new `exec`/`execSync` import or `shell: true`
// option unless the file is explicitly allowlisted below.

export const CHILD_PROCESS_IMPORT_SOURCES = Object.freeze(["node:child_process", "child_process"]);

// Files in src/** where shell semantics are intentional. Each entry requires
// an inline justification comment in the file itself, not just this list.
export const EXEC_IMPORT_ALLOWLIST = Object.freeze([
  // Reads macOS Keychain via `security` CLI. Interpolated values are a
  // SHA-256 hex digest and compile-time constants — no caller input is
  // interpolated into the shell surface.
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

// Match each full `import ... from "node:child_process"` statement
// individually so multiple imports in a single file (named + namespace +
// default) are each inspected for their bindings. The `[^;]*?` specifier
// span prevents bleeding across other `import ... from "x";` statements
// that precede a real child_process import. The `(?!type\s)` lookahead
// skips `import type { ... }` — types compile away and never produce a
// runtime shell surface.
const CHILD_PROCESS_IMPORT_STMT_RE =
  /import\s+(?!type\s)([^;]*?)\s+from\s+["'](node:child_process|child_process)["']/gu;

function classifyImportSpecifier(specifier) {
  const trimmed = specifier.trim();
  if (!trimmed) {
    return { kind: "side-effect" };
  }
  // Default + named: `cp, { exec }` → classify both; flag default as namespace.
  // Namespace:       `* as cp`         → flag as namespace (grants cp.exec, cp.execSync).
  // Named only:      `{ exec, execSync }` → inspect brace contents.
  // Default only:    `cp`              → namespace.
  const parts = trimmed
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  let hasNamespace = false;
  const namedBindings = [];

  for (const part of parts) {
    if (part.startsWith("{")) {
      // Named brace block — may span whole `trimmed` or be the last comma-part.
      const start = trimmed.indexOf("{");
      const end = trimmed.indexOf("}", start);
      if (start !== -1 && end !== -1) {
        const inside = trimmed.slice(start + 1, end);
        for (const raw of inside.split(",")) {
          const name = raw
            .trim()
            // Strip inline `type ` prefix (e.g. `{ type Foo, exec }`). Types
            // compile away — only the runtime bindings matter.
            .replace(/^type\s+/u, "")
            .replace(/\s+as\s+.*$/u, "")
            .trim();
          if (name) {
            namedBindings.push(name);
          }
        }
      }
      // Once we've captured the brace contents we can stop iterating parts.
      break;
    }
    if (part.startsWith("* as ") || /^\*\s+as\s+/.test(part)) {
      hasNamespace = true;
      continue;
    }
    // Bare identifier — default import. Grants the full module namespace.
    hasNamespace = true;
  }

  return { kind: "named", namedBindings, hasNamespace };
}

export function findExecImportViolations(contents) {
  const violations = [];
  for (const match of contents.matchAll(CHILD_PROCESS_IMPORT_STMT_RE)) {
    const [, specifier] = match;
    const classified = classifyImportSpecifier(specifier);
    if (classified.kind === "side-effect") {
      continue;
    }
    const flags = [];
    if (classified.hasNamespace) {
      // Namespace/default imports grant access to every child_process binding
      // including exec/execSync — always require an allowlist entry.
      flags.push("namespace-or-default");
    }
    if (classified.namedBindings) {
      for (const name of classified.namedBindings) {
        if (name === "exec" || name === "execSync") {
          flags.push(name);
        }
      }
    }
    if (flags.length > 0) {
      violations.push({ bindings: flags });
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
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedAsScript) {
  await main();
}
