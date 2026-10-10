#!/usr/bin/env node

// Rejects changelog thanks entries that credit bots or internal handles.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogFormat, isReleaseChangelogPath } from "./lib/release-changelog.mjs";

const FORBIDDEN_INTERNAL_THANKS_HANDLES = new Set(["codex", "openclaw", "steipete"]);
const CHANGELOG_THANKS_REQUIRE_HUMAN_CREDIT_HANDLES = new Set([
  "clawsweeper",
  "openclaw-clawsweeper",
]);

const THANKS_PATTERN = /\bThanks\b/iu;
const THANKED_HANDLE_PATTERN = /@([-_/A-Za-z0-9]+(?:\[bot\])?)/giu;
type ThanksOptions = { strictBotHandle?: boolean; docsMirror?: boolean };

export function isForbiddenChangelogThanksHandle(handle: string, options: ThanksOptions = {}) {
  const normalized = handle.toLowerCase();
  // Approved docs mirrors retain every verified human, including the maintainer.
  // Initial notes, frozen accounting, and PR-author queries keep their existing policy.
  if (options.docsMirror && normalized === "steipete") {
    return false;
  }
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
    for (const entry of fs.readdirSync(artifacts, { recursive: true, encoding: "utf8" })) {
      const relative = `CHANGELOG/${entry}`;
      if (isReleaseChangelogPath(relative)) {
        paths.push(path.join(root, relative));
      }
    }
  }
  let failed = false;
  for (const file of paths) {
    const content = fs.readFileSync(file, "utf8");
    const relativePath = path.relative(process.cwd(), file);
    const docsMirror =
      /^CHANGELOG\/[^/]+\.md$/u.test(relativePath) &&
      isReleaseChangelogPath(relativePath) &&
      changelogFormat(content) === "docs-mirror";
    for (const violation of findForbiddenChangelogThanks(content, { docsMirror })) {
      if (!failed) {
        console.error("Forbidden changelog thanks attribution:");
      }
      failed = true;
      console.error(`- ${relativePath}:${violation.line} uses Thanks @${violation.handle}`);
    }
  }
  if (failed) {
    console.error(
      "Use verified human GitHub credits; retain the initial-note policy in frozen records.",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
