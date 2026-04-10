#!/usr/bin/env node

// Octopus Orchestrator — upstream-imports boundary check (OCTO-DEC-033, OCTO-DEC-040)
//
// Enforces the OCTO-DEC-033 rule: code outside `src/octo/adapters/openclaw/**`
// must NOT import from OpenClaw internals. Every upstream touch-point flows
// through a bridge file in adapters/openclaw/. Bridge files are the only
// place allowed to reach into OpenClaw's own `src/**` tree.
//
// The check walks every .ts file under `src/octo/**` (including tests), reads
// each file's import/export/dynamic-import specifiers, and classifies them:
//
//   - allowed: imports within `src/octo/**` (relative or TypeBox package import)
//   - allowed: bare package imports (node_modules — @sinclair/typebox, vitest, etc.)
//   - allowed: node builtins (node:fs, path, etc.)
//   - allowed: any import from a file under adapters/openclaw/** (that IS the
//     upstream bridge layer, by definition exempt from the rule)
//
//   - FORBIDDEN (outside adapters/openclaw/): relative imports that resolve
//     outside `src/octo/` — e.g., `../../gateway/foo`, `../../config/loader`
//   - FORBIDDEN (outside adapters/openclaw/): absolute imports that name
//     OpenClaw internal top-level directories (`src/gateway/...`,
//     `src/config/...`, etc.). NodeNext uses relative paths, so these are
//     rare in practice but still a possible escape hatch to plug.
//
// Files UNDER adapters/openclaw/** are whitelisted — they are the isolation
// layer itself and MUST be allowed to import whatever upstream surface they
// wrap. The rule is about who touches what, not whether the touch happens.
//
// Fixtures:
//   - src/octo/test-fixtures/bad-import.ts.fixture        — violates (outside adapters/openclaw/)
//   - src/octo/adapters/openclaw/test-fixtures/ok-import.ts.fixture — allowed (inside adapters/openclaw/)
//
// Fixtures use .ts.fixture (not .ts) so oxlint, tsc, and vitest all skip them.
// The checker treats .ts.fixture files the same as .ts for path purposes,
// but they are discovered via an explicit opt-in flag for the test harness
// and are NOT scanned in normal runs.
//
// Exit codes:
//   0 — no violations (or --fixtures mode and fixtures classify correctly)
//   1 — violations found; lines printed to stderr
//   2 — invocation error (bad args, missing src/octo/, etc.)
//
// Design notes (OCTO-DEC-040):
//
// Why a bespoke node script and not ESLint? This repo uses oxlint, which does
// not have the rule configurability for path-restricted imports. Adding
// ESLint as a second linter just for one rule would double the lint
// infrastructure. A bespoke script fits the repo's existing pattern
// (scripts/check-*.mjs) and keeps the enforcement logic readable in one
// place.
//
// Why regex instead of the typescript AST parser used in other check scripts?
// Import syntax is stable and narrow enough that a regex pass handles all
// real-world patterns (import/export/dynamic import with single or double
// quotes, with or without braces). Avoiding the typescript module keeps this
// script dependency-free and fast. If a future TS syntax change breaks the
// regex, we can migrate to the shared ts-guard-utils helpers.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTypeScriptFiles, runAsScript } from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const octoRoot = path.join(repoRoot, "src", "octo");
const adaptersOpenclawRoot = path.join(octoRoot, "adapters", "openclaw");

// Matches the module specifier string in these forms:
//   import X from "foo"
//   import { X } from "foo"
//   import * as X from "foo"
//   import "foo"                 (side-effect)
//   import type { X } from "foo"
//   export { X } from "foo"
//   export * from "foo"
//   export type { X } from "foo"
//   import("foo")                (dynamic)
//
// Captures the quoted specifier in group 1 (or 2 for import+side-effect).
// Regex is anchored to the beginning of a logical statement via the leading
// (?:^|\n|;) so it doesn't match comment-embedded strings.
const IMPORT_REGEXES = [
  // import ... from "specifier"  |  export ... from "specifier"
  /(?:^|\n|;)\s*(?:import|export)\s+(?:[^"';]*?\sfrom\s+)["']([^"']+)["']/g,
  // import "specifier" (side-effect only)
  /(?:^|\n|;)\s*import\s+["']([^"']+)["']/g,
  // dynamic import("specifier")
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

// Top-level OpenClaw internal directories under src/ that we must never
// import from outside adapters/openclaw/. This list is the observed set on
// the current tree — if upstream adds new top-level dirs, the regex
// `^(?:\.\.\/)*src\/[^/]+\/` also catches them via the absolute form below.
const OPENCLAW_INTERNAL_DIR_PATTERN = /^src\//;

function isBarePackageSpecifier(specifier) {
  // "foo", "@scope/bar", "@scope/bar/sub" — all bare packages
  if (specifier.startsWith(".")) {
    return false;
  }
  if (specifier.startsWith("/")) {
    return false;
  }
  // node: builtins, file: URLs, data: URLs
  if (/^(?:node|file|data):/.test(specifier)) {
    return true;
  }
  return true;
}

function isNodeBuiltin(specifier) {
  return /^(?:node:|(?:fs|path|os|url|crypto|stream|http|https|child_process|events|util|process|assert)$)/.test(
    specifier,
  );
}

function isInsideOctoRoot(absolutePath) {
  const normalized = path.resolve(absolutePath);
  const rootWithSep = octoRoot + path.sep;
  return normalized === octoRoot || normalized.startsWith(rootWithSep);
}

function isInsideAdaptersOpenclaw(absolutePath) {
  const normalized = path.resolve(absolutePath);
  const rootWithSep = adaptersOpenclawRoot + path.sep;
  return normalized === adaptersOpenclawRoot || normalized.startsWith(rootWithSep);
}

function extractSpecifiers(sourceText) {
  const specifiers = [];
  for (const regex of IMPORT_REGEXES) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(sourceText)) !== null) {
      const specifier = match[1];
      if (specifier) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

function classifySpecifier(specifier, fromFileAbs) {
  // Bare package imports and node builtins are always allowed. TypeBox,
  // vitest, typescript, etc.
  if (isBarePackageSpecifier(specifier)) {
    if (isNodeBuiltin(specifier)) {
      return { ok: true, reason: "node builtin" };
    }
    // A bare specifier starting with "src/" would be a project root-relative
    // absolute import — forbidden from outside adapters/openclaw/ even though
    // the bare-package classifier accepted it syntactically. Check that.
    if (OPENCLAW_INTERNAL_DIR_PATTERN.test(specifier)) {
      return {
        ok: false,
        reason: `absolute import of OpenClaw internal path "${specifier}"`,
      };
    }
    return { ok: true, reason: "bare package import" };
  }

  // Relative specifier — resolve against the importing file.
  const fromDir = path.dirname(fromFileAbs);
  // Strip trailing .ts / .js for resolution comparison — we only care about
  // the resolved DIRECTORY shape, not whether the file itself exists on disk
  // (the TypeScript compiler is the authority on extension resolution).
  const resolved = path.resolve(fromDir, specifier);
  if (isInsideOctoRoot(resolved)) {
    return { ok: true, reason: "relative import inside src/octo/" };
  }
  return {
    ok: false,
    reason: `relative import escapes src/octo/ (resolves to ${path.relative(repoRoot, resolved)})`,
  };
}

export async function runCheck({ includeFixtures = false } = {}) {
  const files = await collectTypeScriptFiles(octoRoot, { includeTests: true });

  if (includeFixtures) {
    // Recursively gather *.ts.fixture files too.
    const fixtures = [];
    async function walk(dir) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") {
            continue;
          }
          await walk(full);
        } else if (entry.isFile() && full.endsWith(".ts.fixture")) {
          fixtures.push(full);
        }
      }
    }
    await walk(octoRoot);
    files.push(...fixtures);
  }

  const violations = [];

  for (const fileAbs of files) {
    // Whitelisted: bridges are allowed to touch upstream.
    if (isInsideAdaptersOpenclaw(fileAbs)) {
      continue;
    }

    const content = await fs.readFile(fileAbs, "utf8");
    const specifiers = extractSpecifiers(content);

    for (const specifier of specifiers) {
      const classification = classifySpecifier(specifier, fileAbs);
      if (!classification.ok) {
        violations.push({
          file: path.relative(repoRoot, fileAbs),
          specifier,
          reason: classification.reason,
        });
      }
    }
  }

  return violations;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const includeFixtures = args.has("--include-fixtures");

  try {
    const violations = await runCheck({ includeFixtures });
    if (violations.length === 0) {
      if (!args.has("--quiet")) {
        console.log(
          `check-octo-upstream-imports: OK (no violations under src/octo/${includeFixtures ? ", including fixtures" : ""})`,
        );
      }
      process.exit(0);
    }

    console.error(`check-octo-upstream-imports: ${violations.length} violation(s) — OCTO-DEC-033`);
    console.error(
      "Files outside src/octo/adapters/openclaw/ must NOT import from OpenClaw internals.",
    );
    console.error("Route the import through a bridge file in src/octo/adapters/openclaw/.\n");
    for (const v of violations) {
      console.error(`  ${v.file}`);
      console.error(`    import: ${v.specifier}`);
      console.error(`    reason: ${v.reason}`);
    }
    process.exit(1);
  } catch (error) {
    console.error("check-octo-upstream-imports: invocation error:", error);
    process.exit(2);
  }
}

runAsScript(import.meta.url, main);
