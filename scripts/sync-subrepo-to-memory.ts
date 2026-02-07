/**
 * sync-subrepo-to-memory.ts
 *
 * Called from sub-repo post-commit hooks (MAIOSS, MAIBEAUTY).
 * Updates the corresponding MAIBOT memory file with recent commits,
 * then commits + pushes MAIBOT so that:
 *   MAIBOT post-commit hook → Obsidian sync (dashboards + Kanban)
 *
 * Usage:
 *   node --import tsx scripts/sync-subrepo-to-memory.ts <project-key>
 *
 * Project keys: maioss | maibeauty
 */

import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const maibotRoot = path.resolve(here, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SubRepoConfig {
  key: string;
  repoPath: string;
  memoryFile: string; // relative to maibotRoot
  commitCountInMemory: number;
}

const SUBREPO_MAP: Record<string, SubRepoConfig> = {
  maioss: {
    key: "maioss",
    repoPath: "C:\\TEST\\MAIOSS",
    memoryFile: "memory/maioss.md",
    commitCountInMemory: 5,
  },
  maibeauty: {
    key: "maibeauty",
    repoPath: "C:\\TEST\\MAIBEAUTY",
    memoryFile: "memory/vietnam-beauty.md",
    commitCountInMemory: 5,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function getRecentCommits(repoPath: string, count: number): string[] {
  try {
    const log = git(
      ["log", `--oneline`, `-${count}`, "--format=%h %s (%ci)"],
      repoPath,
    );
    return log
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        // Shorten the date: "2026-02-07 17:30:00 +0900" → "2026-02-07"
        return line.replace(/\s*\(\d{4}-(\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}\s+[+-]\d{4}\)/, " ($1)");
      });
  } catch {
    return [];
  }
}

function getLastCommitDate(repoPath: string): string {
  try {
    const date = git(["log", "-1", "--format=%ci"], repoPath);
    return date.slice(0, 10); // "2026-02-07"
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Memory file updaters
// ---------------------------------------------------------------------------

function updateLastUpdated(text: string, date: string): string {
  // Match "*Last updated: YYYY-MM-DD*" at end of file
  return text.replace(
    /^\*Last updated:\s*.+\*\s*$/m,
    `*Last updated: ${date}*`,
  );
}

function updateRecentCommitsSection(
  text: string,
  commits: string[],
  projectKey: string,
): string {
  // Look for existing auto-generated recent commits block
  const startMarker = `<!-- AUTO:subrepo-commits:START -->`;
  const endMarker = `<!-- AUTO:subrepo-commits:END -->`;

  const commitLines = commits.map((c) => `- \`${c}\``);
  const block = [
    startMarker,
    ...commitLines,
    endMarker,
  ].join("\n");

  const startIdx = text.indexOf(startMarker);
  if (startIdx !== -1) {
    // Replace existing block
    const endIdx = text.indexOf(endMarker, startIdx);
    if (endIdx !== -1) {
      const endLineEnd = text.indexOf("\n", endIdx);
      const endPos = endLineEnd === -1 ? text.length : endLineEnd + 1;
      return text.slice(0, startIdx) + block + "\n" + text.slice(endPos);
    }
  }

  // No existing block — insert before "*Last updated:" line
  const lastUpdatedIdx = text.search(/^\*Last updated:/m);
  if (lastUpdatedIdx !== -1) {
    const sectionHeader =
      projectKey === "maioss"
        ? "### 최근 커밋 (자동 동기화)"
        : "### 최근 커밋 (자동 동기화)";

    const insertion = `${sectionHeader}\n${block}\n\n`;
    return text.slice(0, lastUpdatedIdx) + insertion + text.slice(lastUpdatedIdx);
  }

  // Fallback — append to end
  return text + `\n\n### 최근 커밋 (자동 동기화)\n${block}\n`;
}

// ---------------------------------------------------------------------------
// MAIBOT git operations
// ---------------------------------------------------------------------------

function maibotHasChanges(): boolean {
  const status = git(["status", "--porcelain", "--"], maibotRoot);
  return status.length > 0;
}

function maibotCommitAndPush(memoryFile: string, projectKey: string): void {
  const commitMsg = `chore: auto-sync ${projectKey} recent commits to memory`;

  git(["add", memoryFile], maibotRoot);

  // Check if there are staged changes
  const diff = git(["diff", "--cached", "--name-only"], maibotRoot);
  if (!diff.includes(memoryFile)) {
    console.log("  [no change] memory file content unchanged — skip commit");
    return;
  }

  git(
    ["commit", "-m", `${commitMsg}\n\nCo-Authored-By: MAIBOT Auto-Sync <noreply@maibot.local>`],
    maibotRoot,
  );
  console.log(`  [committed] ${memoryFile}`);

  try {
    git(["push", "origin", "main"], maibotRoot);
    console.log("  [pushed] origin/main");
  } catch (err) {
    console.warn(`  [warn] push failed (will retry on next commit): ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectKey = process.argv[2]?.toLowerCase();

  if (!projectKey || !SUBREPO_MAP[projectKey]) {
    console.error(
      `Usage: node --import tsx scripts/sync-subrepo-to-memory.ts <maioss|maibeauty>`,
    );
    process.exit(1);
  }

  const config = SUBREPO_MAP[projectKey];
  console.log(`[sync-subrepo] ${config.key} → ${config.memoryFile}`);

  // 1. Gather data from sub-repo
  const commits = getRecentCommits(config.repoPath, config.commitCountInMemory);
  const lastDate = getLastCommitDate(config.repoPath);

  if (commits.length === 0) {
    console.log("  [skip] no commits found in sub-repo");
    process.exit(0);
  }

  console.log(`  [found] ${commits.length} recent commits, last: ${lastDate}`);

  // 2. Update memory file
  const memoryPath = path.join(maibotRoot, config.memoryFile);
  let text: string;
  try {
    text = await readFile(memoryPath, "utf-8");
  } catch (err) {
    console.error(`  [error] cannot read ${memoryPath}: ${err}`);
    process.exit(1);
  }

  let updated = updateLastUpdated(text, lastDate);
  updated = updateRecentCommitsSection(updated, commits, config.key);

  if (updated === text) {
    console.log("  [no change] memory file already up to date");
    process.exit(0);
  }

  await writeFile(memoryPath, updated);
  console.log(`  [updated] ${config.memoryFile}`);

  // 3. Commit and push MAIBOT
  try {
    maibotCommitAndPush(config.memoryFile, config.key);
  } catch (err) {
    console.warn(`  [warn] MAIBOT commit/push failed: ${err}`);
    // Don't block the sub-repo workflow
  }
}

main().catch((err) => {
  console.error(`[sync-subrepo] error: ${err}`);
  process.exit(0); // Never block sub-repo git workflow
});
