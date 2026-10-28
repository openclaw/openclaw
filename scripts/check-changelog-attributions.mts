#!/usr/bin/env node

// Rejects changelog thanks entries that credit bots or internal handles.
import fs from "node:fs";
import path from "node:path";
import { listDirectoryTreeStrictSync } from "../src/infra/directory-walk.ts";
import { isReleaseChangelogPath } from "./lib/release-changelog.mjs";

const FORBIDDEN_INTERNAL_THANKS_HANDLES = new Set(["codex", "openclaw"]);
const CHANGELOG_THANKS_REQUIRE_HUMAN_CREDIT_HANDLES = new Set([
  "clawsweeper",
  "openclaw-clawsweeper",
  "steipete-oai",
]);

const THANKS_PATTERN = /\bThanks\b/iu;
const THANKED_HANDLE_PATTERN = /@([-_/A-Za-z0-9]+(?:\[bot\])?)/giu;
type ThanksOptions = { strictBotHandle?: boolean; docsMirror?: boolean };

export function isForbiddenChangelogThanksHandle(handle: string, _options: ThanksOptions = {}) {
  const normalized = handle.toLowerCase();
  // Human authors retain credit in initial notes, frozen records and docs mirrors.
  // Automation identities require an explicitly credited human instead.
  if (normalized === "" || normalized === "null") {
    // Empty/null input is not a GitHub handle, but the shell query path may pass it through.
    return true;
  }
  return (
    FORBIDDEN_INTERNAL_THANKS_HANDLES.has(normalized) ||
    requiresExplicitHumanChangelogThanks(normalized)
  );
}

export function requiresExplicitHumanChangelogThanks(handle: string) {
  const normalized = handle.toLowerCase();
  return (
    CHANGELOG_THANKS_REQUIRE_HUMAN_CREDIT_HANDLES.has(normalized) ||
    normalized.startsWith("app/") ||
    normalized.endsWith("[bot]")
  );
}

export function findForbiddenChangelogThanks(content: string, options: ThanksOptions = {}) {
  return content
    .split(/\r?\n/u)
    .map((text, index) => {
      if (!THANKS_PATTERN.test(text)) {
        return null;
      }
      // A single changelog line may thank multiple handles; scan all of them.
      for (const match of text.matchAll(THANKED_HANDLE_PATTERN)) {
        const handle = match[1];
        if (handle && isForbiddenChangelogThanksHandle(handle, options)) {
          return { line: index + 1, handle: handle.toLowerCase(), text };
        }
      }
      return null;
    })
    .filter((violation) => violation !== null);
}

export const CHANGELOG_ATTRIBUTION_NEXT_STEP =
  "Use verified human GitHub credits in initial notes, frozen records, and docs mirrors; never credit automation accounts.";

// Shared by pnpm check (working tree) and the release dispatch gate (candidate SHA),
// so both apply the same human-credit policy to every release-note surface.
export function findChangelogAttributionViolations(
  files: Iterable<{ path: string; content: string }>,
) {
  const violations: Array<{ path: string; line: number; handle: string }> = [];
  for (const file of files) {
    for (const violation of findForbiddenChangelogThanks(file.content)) {
      violations.push({ path: file.path, line: violation.line, handle: violation.handle });
    }
  }
  return violations;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--is-forbidden-handle") {
    process.exitCode = isForbiddenChangelogThanksHandle(argv[1] ?? "", {
      strictBotHandle: true,
    })
      ? 0
      : 1;
    return;
  }

  if (argv[0] === "--requires-explicit-human-thanks") {
    process.exitCode = requiresExplicitHumanChangelogThanks(argv[1] ?? "") ? 0 : 1;
    return;
  }

  const changelogPath = argv[0] ?? "CHANGELOG.md";
  const absolutePath = path.resolve(process.cwd(), changelogPath);
  const paths = [absolutePath];
  const root = path.dirname(absolutePath);
  const artifacts = path.join(root, "CHANGELOG");
  if (path.basename(absolutePath) === "CHANGELOG.md" && fs.existsSync(artifacts)) {
    for (const { relativePath: entry } of listDirectoryTreeStrictSync(artifacts)) {
      const relative = `CHANGELOG/${entry}`;
      if (isReleaseChangelogPath(relative)) {
        paths.push(path.join(root, relative));
      }
    }
  }
  const violations = findChangelogAttributionViolations(
    paths.map((file) => ({
      path: path.relative(process.cwd(), file),
      content: fs.readFileSync(file, "utf8"),
    })),
  );
  if (violations.length > 0) {
    console.error("Forbidden changelog thanks attribution:");
    for (const violation of violations) {
      console.error(`- ${violation.path}:${violation.line} uses Thanks @${violation.handle}`);
    }
    console.error(CHANGELOG_ATTRIBUTION_NEXT_STEP);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
