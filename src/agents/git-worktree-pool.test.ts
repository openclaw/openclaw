/**
 * git-worktree-pool.test.ts — 驗證 worktree 隔離與序列化（永不卡住核心）
 * 由本機 PowerShell：pnpm exec vitest run extensions 或 src/agents 跑。
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireWorktree, withWorktree } from "./git-worktree-pool.js";

const exec = promisify(execFile);
let repoRoot = "";

async function git(args: string[], cwd = repoRoot): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

beforeEach(async () => {
  // 建臨時 git repo + 初始 commit（CI 無全域 git 身分時就地設定）
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wt-pool-"));
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@openclaw.local"]);
  await git(["config", "user.name", "test"]);
  await fs.writeFile(path.join(repoRoot, "seed.txt"), "seed", "utf8");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe("git-worktree-pool", () => {
  it("acquireWorktree 建立獨立 worktree 與隔離分支", async () => {
    const wt = await acquireWorktree({ repoRoot, owner: "claude", taskId: "t1" });
    expect(wt.branch).toBe("ai/claude/t1");
    await expect(fs.stat(wt.dir)).resolves.toBeTruthy();
    const branches = await git(["worktree", "list"]);
    expect(branches.replace(/\\/g, "/")).toContain(wt.dir.replace(/\\/g, "/"));
    await wt.remove();
  });

  it("withWorktree 結束後自動移除（含 fn 失敗）", async () => {
    let dir = "";
    await expect(
      withWorktree({ repoRoot, owner: "codex", taskId: "t2" }, async (wt) => {
        dir = wt.dir;
        await fs.writeFile(path.join(wt.dir, "x.txt"), "x", "utf8");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // 即使失敗也應移除，不殘留 stale worktree
    await expect(fs.stat(dir)).rejects.toBeTruthy();
  });

  it("並行多 owner 不搶鎖、皆成功", async () => {
    const results = await Promise.all([
      acquireWorktree({ repoRoot, owner: "claude", taskId: "p1" }),
      acquireWorktree({ repoRoot, owner: "codex", taskId: "p2" }),
      acquireWorktree({ repoRoot, owner: "openclaw", taskId: "p3" }),
    ]);
    expect(new Set(results.map((r) => r.branch)).size).toBe(3);
    await Promise.all(results.map((r) => r.remove()));
  });
});
