#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_CHANGELOG_THANKS_HANDLES = ["codex", "openclaw", "steipete", "clawsweeper"];

const THANKS_HANDLE_PATTERN = /\bThanks\b[^\n]*@([-_/A-Za-z0-9]+(?:\[bot\])?)/iu;

export function isForbiddenChangelogThanksHandle(handle) {
  const normalized = handle.toLowerCase();
  if (normalized === "null" || normalized.startsWith("app/")) {
    return true;
  }
  return FORBIDDEN_CHANGELOG_THANKS_HANDLES.some((forbidden) =>
    forbidden === "clawsweeper" ? normalized.includes(forbidden) : normalized === forbidden,
  );
}

export function findForbiddenChangelogThanks(content) {
  return content
    .split(/\r?\n/u)
    .map((text, index) => {
      const match = text.match(THANKS_HANDLE_PATTERN);
      if (!match || !isForbiddenChangelogThanksHandle(match[1])) {
        return null;
      }
      return { line: index + 1, handle: match[1].toLowerCase(), text };
    })
    .filter(Boolean);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--is-forbidden-handle") {
    process.exitCode = isForbiddenChangelogThanksHandle(argv[1] ?? "") ? 0 : 1;
    return;
  }

  const changelogPath = argv[0] ?? "CHANGELOG.md";
  const absolutePath = path.resolve(process.cwd(), changelogPath);
  const content = fs.readFileSync(absolutePath, "utf8");
  const violations = findForbiddenChangelogThanks(content);
  if (violations.length === 0) {
    return;
  }

  console.error("Forbidden changelog thanks attribution:");
  for (const violation of violations) {
    const relativePath = path.relative(process.cwd(), absolutePath) || changelogPath;
    console.error(`- ${relativePath}:${violation.line} uses Thanks @${violation.handle}`);
  }
  console.error(
    `Use a credited external GitHub username instead of ${FORBIDDEN_CHANGELOG_THANKS_HANDLES.map((handle) => `@${handle}`).join(", ")}.`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
