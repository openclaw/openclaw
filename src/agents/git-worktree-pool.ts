/**
 * git-worktree-pool.ts — 多 AI 並行 git worktree 隔離池（永不卡住核心）
 *
 * 目的：每個 AI／任務在獨立 worktree 寫碼，各自擁有獨立 index，
 *       不再搶主工作樹的 .git/index.lock（多方並行卡住的根因）。
 *
 * 設計原則（先實證既有碼後決定，不重造）：
 *   - 鎖／stale 清理／watchdog／fencing／timeout 已由 session-write-lock +
 *     file-lock-manager（@openclaw/fs-safe）提供，**複用不重寫**。
 *   - 本模組只補唯一缺口：用同一個 file-lock 序列化 `git worktree add/remove`，
 *     避免並行操作搶 .git/config.lock 與 .git/worktrees。
 *   - git add/commit 發生在各自 worktree 的獨立 index → 互不搶鎖。
 *
 * 安全：只做 worktree 建立／移除；不碰主分支、不刪 .git、不碰 trading。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { createFileLockManager } from "../infra/file-lock-manager.js";

const execFileAsync = promisify(execFile);

/** worktree add/remove 全走同一把鎖序列化（FIFO），防 .git/config.lock race。 */
const WORKTREE_LOCKS = createFileLockManager("openclaw.git-worktree");

/** 取鎖預設逾時：逾時即放棄並回報，不無限等（防卡住）。 */
const DEFAULT_WORKTREE_LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY = { minTimeout: 50, maxTimeout: 1000, factor: 1 } as const;

export interface WorktreeHandle {
  /** worktree 絕對路徑（各自獨立 index）。 */
  dir: string;
  /** 對應隔離分支名：ai/<owner>/<taskId>。 */
  branch: string;
  /** 用完移除 worktree（同樣序列化，防殘留卡住）。 */
  remove: () => Promise<void>;
}

export interface AcquireWorktreeOptions {
  /** repo 根目錄（主工作樹）。 */
  repoRoot: string;
  /** 任務擁有者：claude / codex / openclaw。 */
  owner: string;
  /** 任務 ID（唯一）。 */
  taskId: string;
  /** 基底 ref，預設 HEAD。 */
  base?: string;
  /** 取鎖逾時 ms，預設 30s。 */
  timeoutMs?: number;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  // -C 指定 repo，避免依賴行程 cwd（PowerShell／node 皆一致）
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args]);
  return stdout.trim();
}

async function withWorktreeLock<T>(
  repoRoot: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const repoHash = createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 24);
  const lock = await WORKTREE_LOCKS.acquire(`repo-${repoHash}-worktree-mutation`, {
    timeoutMs,
    retry: LOCK_RETRY,
    payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
  });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * 取得一個隔離 worktree（序列化建立，防搶 git 全域鎖）。
 * 路徑：<repoRoot>/.worktrees/<owner>-<taskId>；分支：ai/<owner>/<taskId>。
 */
export async function acquireWorktree(opts: AcquireWorktreeOptions): Promise<WorktreeHandle> {
  const branch = `ai/${opts.owner}/${opts.taskId}`;
  const dir = path.join(opts.repoRoot, ".worktrees", `${opts.owner}-${opts.taskId}`);
  const base = opts.base ?? "HEAD";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WORKTREE_LOCK_TIMEOUT_MS;

  await withWorktreeLock(opts.repoRoot, timeoutMs, async () => {
    await git(opts.repoRoot, ["worktree", "add", "-b", branch, dir, base]);
  });

  return {
    dir,
    branch,
    remove: () =>
      withWorktreeLock(opts.repoRoot, timeoutMs, async () => {
        await git(opts.repoRoot, ["worktree", "remove", "--force", dir]);
      }),
  };
}

/**
 * 在隔離 worktree 內執行 fn，結束自動移除（即使 fn 失敗也移除，防 stale worktree）。
 * fn 內的 git 操作用各自 index，與其他 AI 互不搶鎖。
 */
export async function withWorktree<T>(
  opts: AcquireWorktreeOptions,
  fn: (wt: WorktreeHandle) => Promise<T>,
): Promise<T> {
  const wt = await acquireWorktree(opts);
  try {
    return await fn(wt);
  } finally {
    await wt.remove();
  }
}
