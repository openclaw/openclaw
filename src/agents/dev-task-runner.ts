/**
 * dev-task-runner.ts — dev 任務自動執行器（永不卡住・對話無關 L1 引擎核心）
 *
 * 職責：背景常駐，自動撿 repo 內 `CODEX_TASK_*.md`（status:pending, lane:dev）
 *       → 隔離 worktree → 派執行器（codex）→ 驗證 → 回寫 status → 合併/重派/升級。
 *       不綁任何對話：關掉所有對話也照跑。
 *
 * 安全：預設全自動（含交易的狀態/檢查/模擬/演化/讀寫皆可自動）；只有 front-matter
 *       `approval: required` 或 metadata 顯示真實交易執行才發通知等使用者同意。
 *       真實不可逆操作（下單/live/資金/付款/刪除/部署/secret）另由 runtime
 *       既有 hermes-gate/task_router 在執行那刻 manual_approval 兜底（不在此重造文字過濾）。
 *
 * 工程原則（不臆造 internal API）：派 codex 寫碼那段做成「可注入 executor」（穩固 seam）。
 *       本檔主體（掃描/解析/過濾/狀態機/等待）100% 自洽可測；
 *       Codex 落地時注入 runCliAgent（`src/agents/cli-runner.js`）即接通。
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createFileLockManager } from "../infra/file-lock-manager.js";
import type { RunCliAgentParams } from "./cli-runner/types.js";
import { acquireWorktree, type WorktreeHandle } from "./git-worktree-pool.js";

export type { WorktreeHandle } from "./git-worktree-pool.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "stuck"
  | "escalated"
  | "needs-approval";

export interface TaskCard {
  filePath: string;
  id: string;
  status: TaskStatus;
  lane: string;
  owner: string;
  approval: string; // auto(預設,自動跑) | required(重大/不可逆,需使用者同意)
  approved?: string;
  runner?: string;
  verify: string; // 驗證命令（可含 && 串接），全綠才算成功
  maxRetries: number;
  retries: number;
  execution?: string;
  operation?: string;
  risk?: string;
  liveTrading?: string;
  mode?: string;
}

/** 任務執行 seam：在隔離 worktree 內完成寫碼。預設用 runCliAgent 派 openai-codex。 */
export type TaskExecutor = (ctx: {
  task: TaskCard;
  worktreeDir: string;
  repoRoot: string;
}) => Promise<void>;

export type NotifyApproval = (task: TaskCard) => Promise<void>;

export type MergeQueue = (ctx: {
  task: TaskCard;
  worktree: WorktreeHandle;
  repoRoot: string;
  runVerify: (cmd: string, cwd: string) => Promise<boolean>;
  log: (msg: string) => void;
}) => Promise<void>;

export type RunCliAgentFn = (
  params: RunCliAgentParams,
) => ReturnType<typeof import("./cli-runner.js").runCliAgent>;

type GatewayApprovalCall = (opts: {
  method: "plugin.approval.request";
  params: unknown;
  expectFinal?: boolean;
  timeoutMs?: number;
}) => Promise<unknown>;

type GitCommand = (
  cwd: string,
  args: string[],
  input?: string,
) => Promise<{ stdout: string; stderr: string }>;

export interface DevTaskRunnerDeps {
  /** worktree 取得器（預設真 git；測試可注入）。 */
  acquireWorktree?: typeof acquireWorktree;
  /** 跑驗證命令；回傳是否全綠（預設 spawn shell）。 */
  runVerify?: (cmd: string, cwd: string) => Promise<boolean>;
  /** 派 codex 寫碼。 */
  executor?: TaskExecutor;
  /** 碰到 approval:required 或真實交易執行時發審批通知（複用既有 confirm gate）。 */
  notifyApproval?: NotifyApproval;
  /** 完成後把隔離 worktree 的 diff 依 FIFO 排回主工作樹。 */
  mergeQueue?: MergeQueue;
  /** 日誌。 */
  log?: (msg: string) => void;
}

const OPENAI_CODEX_PROVIDER = "openai-codex";
const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";
const DEFAULT_EXECUTOR_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_GATEWAY_TIMEOUT_MS = 10_000;
const DEV_TASK_MERGE_LOCKS = createFileLockManager("openclaw.dev-task-runner.merge");

// ── front-matter 解析（簡易 yaml：key: value，無歧義）─────────────────────────
function parseFrontMatter(raw: string): Record<string, string> | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function toCard(filePath: string, raw: string): TaskCard | null {
  const fm = parseFrontMatter(raw);
  if (!fm || !fm.status) return null;
  return {
    filePath,
    id: fm.id ?? path.basename(filePath),
    status: fm.status as TaskStatus,
    lane: fm.lane ?? "dev",
    owner: fm.owner ?? "codex",
    approval: fm.approval ?? "auto",
    approved: fm.approved,
    runner: fm.runner,
    verify: fm.verify ?? "",
    maxRetries: Number.isFinite(Number(fm.maxRetries)) ? Number(fm.maxRetries) : 1,
    retries: Number.isFinite(Number(fm.retries)) ? Number(fm.retries) : 0,
    execution: fm.execution,
    operation: fm.operation,
    risk: fm.risk,
    liveTrading: fm.liveTrading ?? fm.live_trading,
    mode: fm.mode,
  };
}

/** 掃描 repo 根的 CODEX_TASK_*.md。 */
export async function scanTaskCards(repoRoot: string): Promise<TaskCard[]> {
  const entries = await fs.readdir(repoRoot, { withFileTypes: true }).catch(() => []);
  const cards: TaskCard[] = [];
  for (const e of entries) {
    if (!e.isFile() || !/^CODEX_TASK_.*\.md$/.test(e.name)) continue;
    const filePath = path.join(repoRoot, e.name);
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    const card = toCard(filePath, raw);
    if (card && normalizeTaskToken(card.runner) !== "ignore") cards.push(card);
  }
  return cards;
}

/** 回寫 front-matter 內某欄位（持久化狀態，跨重啟有效）。 */
async function patchFrontMatter(filePath: string, patch: Record<string, string>): Promise<void> {
  let raw = await fs.readFile(filePath, "utf8");
  const m = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) return;
  let body = m[2];
  for (const [k, rawValue] of Object.entries(patch)) {
    // 防多行值（如 git 多行錯誤訊息）撐破 front-matter YAML：壓成單行
    const v = rawValue.replace(/[\r\n]+/g, " ").trim();
    const re = new RegExp(`^${k}:.*$`, "m");
    body = re.test(body) ? body.replace(re, `${k}: ${v}`) : `${body}\n${k}: ${v}`;
  }
  raw = raw.replace(m[0], `${m[1]}${body}${m[3]}`);
  await fs.writeFile(filePath, raw, "utf8");
}

function defaultRunVerify(cmd: string, cwd: string): Promise<boolean> {
  if (!cmd) return Promise.resolve(true);
  return new Promise((resolve) => {
    // shell:true → Windows 走 PowerShell/cmd、CI 走 sh，皆可解析 && 串接
    const child = spawn(cmd, { cwd, shell: true, stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function isAffirmative(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "1";
}

function normalizeTaskToken(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_") ?? ""
  );
}

function taskHasToken(task: TaskCard, predicate: (token: string) => boolean): boolean {
  return [task.execution, task.operation, task.risk, task.mode]
    .map(normalizeTaskToken)
    .some((token) => token.length > 0 && predicate(token));
}

export function isRealTradingExecution(task: TaskCard): boolean {
  const tradingLane = /^(trading|trade|capital|okx|broker|live-trading)$/i.test(task.lane.trim());
  if (!tradingLane) {
    return false;
  }
  if (isAffirmative(task.liveTrading)) {
    return true;
  }
  return taskHasToken(task, (token) => {
    const realOrLive = token.includes("live") || token.includes("real") || token.includes("broker");
    const execution =
      token.includes("execute") ||
      token.includes("execution") ||
      token.includes("order") ||
      token.includes("trade");
    return realOrLive && execution;
  });
}

export function requiresManualApproval(task: TaskCard): boolean {
  return normalizeTaskToken(task.approval) === "required" || isRealTradingExecution(task);
}

function isApprovalGranted(task: TaskCard): boolean {
  return normalizeTaskToken(task.approved) === "granted";
}

function safeTaskId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}

function relativeTaskPath(task: TaskCard, repoRoot: string): string {
  return path.relative(repoRoot, task.filePath).replace(/\\/g, "/");
}

async function readTaskCardBodyFromWorktree(task: TaskCard, repoRoot: string, worktreeDir: string) {
  const rel = relativeTaskPath(task, repoRoot);
  const worktreePath = path.join(worktreeDir, rel);
  return (
    (await fs.readFile(worktreePath, "utf8").catch(() => undefined)) ??
    (await fs.readFile(task.filePath, "utf8").catch(() => ""))
  );
}

function buildTaskExecutorPrompt(params: {
  task: TaskCard;
  repoRoot: string;
  worktreeDir: string;
  taskText: string;
}): string {
  const taskPath = relativeTaskPath(params.task, params.repoRoot);
  return [
    "你是 OpenClaw dev-task-runner 的 Codex builder，已在隔離 git worktree 內執行。",
    `任務檔：${taskPath}`,
    `任務 ID：${params.task.id}`,
    `lane：${params.task.lane}`,
    `worktree：${params.worktreeDir}`,
    "只處理此任務直接相關檔案；不要切換分支、不要碰主工作樹、不要提交或推送。",
    "approval:required 或 metadata 顯示 live/real broker order execution 時不得自動執行；真實交易、付款、部署、刪除、secret 相關動作必須停下並回報需要使用者批准。",
    "完成後把檔案變更留在此 worktree，runner 會負責驗證與 FIFO merge queue。",
    "任務內容如下：",
    params.taskText.trim(),
  ].join("\n\n");
}

export function createRunCliAgentTaskExecutor(
  opts: {
    runCliAgent?: RunCliAgentFn;
    config?: OpenClawConfig;
    provider?: string;
    model?: string;
    timeoutMs?: number;
  } = {},
): TaskExecutor {
  return async ({ task, worktreeDir, repoRoot }) => {
    const runCliAgent = opts.runCliAgent ?? (await import("./cli-runner.js")).runCliAgent;
    const taskText = await readTaskCardBodyFromWorktree(task, repoRoot, worktreeDir);
    const safeId = safeTaskId(task.id);
    const sessionDir = path.join(worktreeDir, ".openclaw", "dev-task-runner");
    await fs.mkdir(sessionDir, { recursive: true });
    const runId = `dev-task-${safeId}-${randomUUID()}`;
    await runCliAgent({
      sessionId: runId,
      sessionKey: `dev-task:${safeId}`,
      agentId: task.owner || "codex",
      trigger: "cron",
      jobId: task.id,
      sessionFile: path.join(sessionDir, `${safeId}.jsonl`),
      workspaceDir: worktreeDir,
      config: opts.config,
      prompt: buildTaskExecutorPrompt({ task, repoRoot, worktreeDir, taskText }),
      provider: opts.provider ?? OPENAI_CODEX_PROVIDER,
      model: opts.model ?? DEFAULT_CODEX_MODEL,
      timeoutMs: opts.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS,
      runId,
      lane: task.lane,
      senderIsOwner: true,
      cleanupCliLiveSessionOnRunEnd: true,
      cleanupBundleMcpOnRunEnd: true,
    });
  };
}

async function defaultGatewayApprovalCall(
  opts: Parameters<GatewayApprovalCall>[0],
): Promise<unknown> {
  const { callGatewayCli } = await import("../gateway/call.js");
  return await callGatewayCli(opts);
}

function approvalSeverity(task: TaskCard): "high" | "critical" {
  return isRealTradingExecution(task) ? "critical" : "high";
}

export function createAutomationConfirmGateNotifyApproval(
  opts: {
    callGateway?: GatewayApprovalCall;
    timeoutMs?: number;
    gatewayTimeoutMs?: number;
    log?: (msg: string) => void;
  } = {},
): NotifyApproval {
  return async (task) => {
    const callGateway = opts.callGateway ?? defaultGatewayApprovalCall;
    try {
      await callGateway({
        method: "plugin.approval.request",
        expectFinal: false,
        timeoutMs: opts.gatewayTimeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS,
        params: {
          pluginId: "automation",
          title: `OpenClaw 任務需要批准：${task.id}`,
          description: [
            "automation_confirm_gate",
            `task=${task.id}`,
            `lane=${task.lane}`,
            `approval=${task.approval}`,
            `operation=${task.operation ?? task.execution ?? task.risk ?? "unspecified"}`,
          ].join("\n"),
          severity: approvalSeverity(task),
          toolName: "automation_confirm_gate",
          toolCallId: `dev-task:${safeTaskId(task.id)}`,
          agentId: task.owner || "codex",
          sessionKey: `dev-task:${safeTaskId(task.id)}`,
          timeoutMs: opts.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
          twoPhase: true,
        },
      });
    } catch (err) {
      opts.log?.(`[dev-task] approval notify failed for ${task.id}: ${(err as Error).message}`);
    }
  };
}

function runGit(
  cwd: string,
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`git ${args.join(" ")} failed (${code ?? "signal"}): ${stderr.trim()}`));
    });
    child.stdin.end(input ?? "");
  });
}

async function withMergeLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const repoHash = createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 24);
  const lock = await DEV_TASK_MERGE_LOCKS.acquire(`repo-${repoHash}-dev-task-merge`, {
    timeoutMs: 30_000,
    retry: { minTimeout: 50, maxTimeout: 1000, factor: 1 },
    payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
  });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export function createFifoMergeQueue(
  opts: {
    git?: GitCommand;
    verifyAfterMerge?: boolean;
  } = {},
): MergeQueue {
  const git = opts.git ?? runGit;
  let tail: Promise<void> = Promise.resolve();
  return (ctx) => {
    const run = async () =>
      await withMergeLock(ctx.repoRoot, async () => {
        const status = await git(ctx.worktree.dir, ["status", "--porcelain"]);
        if (!status.stdout.trim()) {
          ctx.log(`[dev-task] ${ctx.task.id} 無 worktree diff，merge queue 略過`);
          return;
        }
        await git(ctx.worktree.dir, ["add", "-N", "."]).catch(() => undefined);
        const diff = await git(ctx.worktree.dir, ["diff", "--binary", "HEAD", "--"]);
        if (!diff.stdout.trim()) {
          ctx.log(`[dev-task] ${ctx.task.id} 無可套用 diff，merge queue 略過`);
          return;
        }
        ctx.log(`[dev-task] ${ctx.task.id} 進入 Lead FIFO merge queue`);
        await git(
          ctx.repoRoot,
          ["apply", "--3way", "--binary", "--whitespace=nowarn", "-"],
          diff.stdout,
        );
        if (opts.verifyAfterMerge && ctx.task.verify) {
          const green = await ctx.runVerify(ctx.task.verify, ctx.repoRoot);
          if (!green) {
            throw new Error("post-merge-verify-failed");
          }
        }
      });
    const current = tail.then(run, run);
    tail = current.catch(() => undefined);
    return current;
  };
}

let defaultMergeQueue: MergeQueue | undefined;

function resolveMergeQueue(deps: DevTaskRunnerDeps): MergeQueue {
  if (deps.mergeQueue) {
    return deps.mergeQueue;
  }
  defaultMergeQueue ??= createFifoMergeQueue();
  return defaultMergeQueue;
}

/**
 * 處理單一任務卡：claim → 隔離 → 執行 → 驗證 → 結算（completed/stuck/escalated）。
 * 隔離 worktree 確保不搶主樹 .git/index；失敗自動移除 worktree（不殘留）。
 */
export async function processCard(
  card: TaskCard,
  repoRoot: string,
  deps: DevTaskRunnerDeps = {},
): Promise<TaskStatus> {
  const log = deps.log ?? (() => {});
  const acquire = deps.acquireWorktree ?? acquireWorktree;
  const runVerify = deps.runVerify ?? defaultRunVerify;
  const executor = deps.executor ?? createRunCliAgentTaskExecutor();
  const notifyApproval = deps.notifyApproval ?? createAutomationConfirmGateNotifyApproval({ log });
  const mergeQueue = resolveMergeQueue(deps);

  // 完成標記 → 跳過（防重跑）
  if (card.status === "completed" || card.status === "escalated") return card.status;
  if (card.status === "needs-approval" && !isApprovalGranted(card)) {
    return "needs-approval";
  }
  // 只有「重大/不可逆」任務（front-matter approval: required）與真實交易執行才需同意；
  // 其餘（含交易的狀態/檢查/模擬/演化/讀寫）自動執行。
  // 真實不可逆操作（下單/live/資金/付款/刪除/部署/secret）另由 runtime hermes-gate manual_approval 兜底。
  if (!isApprovalGranted(card) && requiresManualApproval(card)) {
    await patchFrontMatter(card.filePath, {
      status: "needs-approval",
      approved: "requested",
      reason: isRealTradingExecution(card) ? "real-trading-execution" : "approval-required",
    });
    await notifyApproval(card);
    log(`[dev-task] ${card.id} 標記需批准 → 已發通知，待使用者同意`);
    return "needs-approval";
  }

  await patchFrontMatter(card.filePath, { status: "running" });
  let wt: WorktreeHandle | null = null;
  try {
    wt = await acquire({ repoRoot, owner: card.owner, taskId: card.id });
    await executor({ task: card, worktreeDir: wt.dir, repoRoot });
    const green = await runVerify(card.verify, wt.dir);
    if (green) {
      await mergeQueue({ task: card, worktree: wt, repoRoot, runVerify, log });
      await patchFrontMatter(card.filePath, {
        status: "completed",
        completed_at: new Date().toISOString(),
      });
      log(`[dev-task] ${card.id} ✅ 驗證全綠且 merge queue 完成 → completed`);
      return "completed";
    }
    throw new Error("verify-failed");
  } catch (err) {
    const retries = card.retries + 1;
    const next: TaskStatus = retries > card.maxRetries ? "escalated" : "stuck";
    await patchFrontMatter(card.filePath, {
      status: next,
      retries: String(retries),
      reason: (err as Error).message,
    });
    log(`[dev-task] ${card.id} ✗ ${(err as Error).message} → ${next}（retries=${retries}）`);
    return next;
  } finally {
    await wt?.remove().catch(() => {}); // 失敗也移除，不殘留 stale worktree
  }
}

/** 掃一輪：處理所有 pending/stuck(可重派) 的 dev 任務。回傳處理數。 */
export async function runOnce(repoRoot: string, deps: DevTaskRunnerDeps = {}): Promise<number> {
  const cards = await scanTaskCards(repoRoot);
  let handled = 0;
  for (const card of cards) {
    if (
      card.status === "pending" ||
      (card.status === "stuck" && card.retries <= card.maxRetries) ||
      (card.status === "needs-approval" && isApprovalGranted(card))
    ) {
      await processCard(card, repoRoot, deps);
      handled += 1;
    }
  }
  return handled;
}

/**
 * 常駐迴圈（正確的「等」：有任務才跑，無則 idle sleep，不 busy-loop）。
 * @param opts.intervalMs 空佇列輪詢間隔（預設 5s）
 * @param opts.signal AbortSignal 可優雅停止
 */
export async function watchLoop(
  repoRoot: string,
  deps: DevTaskRunnerDeps = {},
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const log = deps.log ?? (() => {});
  while (!opts.signal?.aborted) {
    const handled = await runOnce(repoRoot, deps).catch((e) => {
      log(`[dev-task] runOnce error: ${(e as Error).message}`);
      return 0;
    });
    // 佇列空 → idle 等待（最正確：sleep，不空轉燒 CPU）
    if (handled === 0) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
