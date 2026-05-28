#!/usr/bin/env node
/**
 * openclaw-dev-task-runner.ts — dev 任務執行器常駐入口（永不卡住・對話無關 L1 引擎）
 *
 * 跑法（PowerShell）：
 *   node --import tsx scripts/openclaw-dev-task-runner.ts --repo-root D:\OpenClaw
 *   node --import tsx scripts/openclaw-dev-task-runner.ts --once   # 跑一輪即退出
 *
 * 行為：背景常駐，掃 repo `CODEX_TASK_*.md`(lane:dev) → 隔離 worktree → 驗證 → 回寫 status；
 *       碰非 dev（交易等）→ 標 needs-approval + 發通知等使用者同意。對話無關：關掉對話也照跑。
 *
 * 注意：runner 預設用 openai-codex runCliAgent 寫碼；approval:required/live trading execution
 *       會走 automation_confirm_gate/plugin approval，完成後再進 FIFO merge queue。
 */
import path from "node:path";
import { runOnce, watchLoop, type DevTaskRunnerDeps } from "../src/agents/dev-task-runner.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repoRoot = path.resolve(arg("repo-root", process.cwd()));
const intervalMs = Number(arg("interval-ms", "5000"));
const once = process.argv.includes("--once");

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.error(`[dev-task-runner] 收到 ${sig}，優雅停止…`);
    controller.abort();
  });
}

const deps: DevTaskRunnerDeps = {
  log: (m) => console.error(m),
  // executor / notifyApproval / mergeQueue 使用 src/agents/dev-task-runner.ts 的預設接線。
};

console.error(`[dev-task-runner] 啟動：repoRoot=${repoRoot} interval=${intervalMs}ms once=${once}`);

if (once) {
  const handled = await runOnce(repoRoot, deps);
  console.error(`[dev-task-runner] once 完成，處理 ${handled} 個任務`);
} else {
  await watchLoop(repoRoot, deps, { intervalMs, signal: controller.signal });
}
