import path from "path";
import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { apiResponse } from "@/lib/workspace";
import type { Repository } from "@/lib/types";

const execAsync = promisify(exec);

async function getGitInfo(repoPath: string): Promise<Partial<Repository> | null> {
  try {
    const gitDir = path.join(repoPath, ".git");
    const stat = await fs.stat(gitDir);
    if (!stat.isDirectory()) return null;

    let branch = "unknown";
    let lastCommit = "";
    let lastCommitMessage = "";
    let dirtyFiles = 0;

    try {
      const { stdout: branchOut } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath });
      branch = branchOut.trim();
    } catch { /* ignore */ }

    try {
      const { stdout: logOut } = await execAsync('git log -1 --format="%H|%s|%ai"', { cwd: repoPath });
      const parts = logOut.trim().split("|");
      lastCommit = parts[2] || "";
      lastCommitMessage = parts[1] || "";
    } catch { /* ignore */ }

    try {
      const { stdout: statusOut } = await execAsync("git status --porcelain", { cwd: repoPath });
      dirtyFiles = statusOut.trim().split("\n").filter(Boolean).length;
    } catch { /* ignore */ }

    return { branch, lastCommit, lastCommitMessage, dirtyFiles };
  } catch {
    return null;
  }
}

export async function GET() {
  const scanPaths = [
    path.join(process.env.USERPROFILE || process.env.HOME || "", "OpenClaw"),
    path.join(process.env.USERPROFILE || process.env.HOME || "", "Desktop", "Projects"),
  ];

  const repos: Repository[] = [];

  for (const scanPath of scanPaths) {
    let entries;
    try {
      entries = await fs.readdir(scanPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const fullPath = path.join(scanPath, entry.name);
      const gitInfo = await getGitInfo(fullPath);

      if (gitInfo) {
        repos.push({
          name: entry.name,
          path: fullPath,
          ...gitInfo,
        } as Repository);
      }
    }
  }

  return apiResponse(repos);
}
