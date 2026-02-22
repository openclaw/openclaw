/**
 * Project status gathering for Claude Code session intelligence.
 *
 * Collects git state, GitHub PR/CI info, session data, and docs presence
 * for a repository. Used both as pre-flight before spawning CC and as
 * data source for the MCP bridge `openclaw_project_status` tool.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DiscoveredSession } from "./types.js";
import { discoverSessions } from "./sessions.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectStatus = {
  repo: { path: string; name: string; isGitRepo: boolean };
  git: {
    currentBranch: string;
    headCommitSha: string;
    headCommitMessage: string;
    uncommittedChanges: string[];
    stagedChanges: string[];
    stashCount: number;
    recentCommits: Array<{ sha: string; message: string; author: string; date: string }>;
  };
  github?: {
    openPrs: Array<{ number: number; title: string; branch: string; state: string }>;
    failingChecks: Array<{ name: string; status: string }>;
  };
  sessions: {
    active: DiscoveredSession[];
    recent: DiscoveredSession[];
    ownRecent: DiscoveredSession[];
  };
  docs: {
    hasClaudeMd: boolean;
    hasSpecs: boolean;
    specFiles: string[];
    hasTodo: boolean;
    hasReadme: boolean;
  };
  timestamp: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CMD_TIMEOUT_MS = 5_000;

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: CMD_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function runGh(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      cwd,
      timeout: CMD_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

function parseSettled<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Gather a structured project status for a repository.
 * Runs git commands in parallel with 5s timeout each.
 * `gh` CLI commands are optional (gracefully fails if gh not installed).
 */
export async function gatherProjectStatus(
  repoPath: string,
  agentId?: string,
): Promise<ProjectStatus> {
  const resolved = path.resolve(repoPath);
  const isGitRepo = fs.existsSync(path.join(resolved, ".git"));

  // Parallel execution — all commands are independent
  const [branch, headInfo, statusShort, stashList, recentLog, ghPrs, ghChecks, sessions] =
    await Promise.allSettled([
      runGit(["branch", "--show-current"], resolved),
      runGit(["log", "-1", "--format=%h %s"], resolved),
      runGit(["status", "--short"], resolved),
      runGit(["stash", "list"], resolved),
      runGit(["log", "--oneline", "-10", "--format=%h|%s|%an|%ar"], resolved),
      runGh(["pr", "list", "--json", "number,title,headRefName,state", "--limit", "5"], resolved),
      runGh(["pr", "checks", "--json", "name,state"], resolved),
      discoverSessions(resolved),
    ]);

  // Parse git status lines
  const statusLines = parseSettled(statusShort, "").split("\n").filter(Boolean);
  const staged = statusLines.filter((l) => /^[MADRC]/.test(l));
  const unstaged = statusLines.filter((l) => /^.[MADRC?]/.test(l));

  // Parse recent commits
  const commits = parseSettled(recentLog, "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|");
      return {
        sha: parts[0] ?? "",
        message: parts[1] ?? "",
        author: parts[2] ?? "",
        date: parts[3] ?? "",
      };
    });

  // Parse GitHub data
  let github: ProjectStatus["github"] | undefined;
  const prsRaw = parseSettled(ghPrs, "");
  const checksRaw = parseSettled(ghChecks, "");
  if (prsRaw || checksRaw) {
    let openPrs: Array<{ number: number; title: string; branch: string; state: string }> = [];
    let failingChecks: Array<{ name: string; status: string }> = [];
    try {
      if (prsRaw) {
        const parsed = JSON.parse(prsRaw) as Array<{
          number: number;
          title: string;
          headRefName: string;
          state: string;
        }>;
        openPrs = parsed.map((p) => ({
          number: p.number,
          title: p.title,
          branch: p.headRefName,
          state: p.state,
        }));
      }
    } catch {
      // ignore parse errors
    }
    try {
      if (checksRaw) {
        const parsed = JSON.parse(checksRaw) as Array<{ name: string; state: string }>;
        failingChecks = parsed
          .filter((c) => c.state === "FAILURE" || c.state === "failure")
          .map((c) => ({ name: c.name, status: c.state }));
      }
    } catch {
      // ignore parse errors
    }
    if (openPrs.length > 0 || failingChecks.length > 0) {
      github = { openPrs, failingChecks };
    }
  }

  // Parse sessions
  const allSessions = parseSettled(sessions, [] as DiscoveredSession[]);
  const active = allSessions.filter((s) => s.isRunning);
  const recent = allSessions.slice(0, 5);
  const ownRecent = agentId ? allSessions.filter((s) => s.agentId === agentId).slice(0, 3) : [];

  // Check docs
  const hasClaudeMd = fs.existsSync(path.join(resolved, "CLAUDE.md"));
  const specsDir = path.join(resolved, ".specs");
  const hasSpecs = fs.existsSync(specsDir);
  let specFiles: string[] = [];
  if (hasSpecs) {
    try {
      specFiles = fs.readdirSync(specsDir).filter((f) => f.endsWith(".md"));
    } catch {
      // ignore
    }
  }

  // Parse head commit
  const headRaw = parseSettled(headInfo, "");
  const headParts = headRaw.split(" ");
  const headSha = headParts[0] ?? "";
  const headMessage = headParts.slice(1).join(" ");

  return {
    repo: { path: resolved, name: path.basename(resolved), isGitRepo },
    git: {
      currentBranch: parseSettled(branch, "unknown"),
      headCommitSha: headSha,
      headCommitMessage: headMessage,
      uncommittedChanges: unstaged.map((l) => l.trim()),
      stagedChanges: staged.map((l) => l.trim()),
      stashCount: parseSettled(stashList, "").split("\n").filter(Boolean).length,
      recentCommits: commits,
    },
    github,
    sessions: { active, recent, ownRecent },
    docs: {
      hasClaudeMd,
      hasSpecs,
      specFiles,
      hasTodo: fs.existsSync(path.join(resolved, "TODO.md")),
      hasReadme: fs.existsSync(path.join(resolved, "README.md")),
    },
    timestamp: new Date().toISOString(),
  };
}
