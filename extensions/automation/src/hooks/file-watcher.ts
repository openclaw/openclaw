/**
 * file-watcher.ts — 監控 CODEX_TASKS.md 變更，自動觸發 Codex 執行
 *
 * 當 CODEX_TASKS.md 被修改時：
 * 1. 讀取檔案內容
 * 2. 解析出所有 `- [ ]` 未完成任務
 * 3. 取第一個未完成任務，派發給 Codex subagent
 * 4. 完成後將任務標記為 `[x]`
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const TASK_FILE = "CODEX_TASKS.md";
const POLL_INTERVAL_MS = 30_000; // 30 秒檢查一次
const CODEX_TIMEOUT_MS = 300_000; // 5 分鐘超時

let lastModifiedMs = 0;
let isProcessing = false;

interface ParsedTask {
  line: number;
  raw: string;
  description: string;
  done: boolean;
}

function resolveTaskFilePath(): string {
  // extensions/automation/CODEX_TASKS.md
  return path.resolve(path.dirname(path.dirname(new URL(import.meta.url).pathname)), TASK_FILE);
}

function parseTasksFromContent(content: string): ParsedTask[] {
  const lines = content.split("\n");
  const tasks: ParsedTask[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const undoneMatch = line.match(/^- \[ \] (.+)$/);
    const doneMatch = line.match(/^- \[x\] (.+)$/i);

    if (undoneMatch) {
      tasks.push({
        line: i,
        raw: line,
        description: undoneMatch[1].trim(),
        done: false,
      });
    } else if (doneMatch) {
      tasks.push({
        line: i,
        raw: line,
        description: doneMatch[1].trim(),
        done: true,
      });
    }
  }

  return tasks;
}

function markTaskDone(filePath: string, task: ParsedTask): void {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  if (lines[task.line] === task.raw) {
    lines[task.line] = task.raw.replace("- [ ]", "- [x]");
    fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
  }
}

function getNextTask(filePath: string): ParsedTask | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const tasks = parseTasksFromContent(content);
    return tasks.find((t) => !t.done) ?? null;
  } catch {
    return null;
  }
}

function getFileModifiedTime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

async function executeTask(
  api: OpenClawPluginApi,
  task: ParsedTask,
  filePath: string,
): Promise<boolean> {
  const sessionKey = `codex-auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // 建立完整的 Codex 指令
  const instruction = [
    `## 自動化任務`,
    ``,
    `請完成以下任務：`,
    ``,
    `${task.description}`,
    ``,
    `### 規範`,
    `- 專案根目錄: extensions/automation/`,
    `- 使用 TypeScript strict mode`,
    `- 註解使用繁體中文`,
    `- 完成後回報修改了哪些檔案`,
    ``,
    `### 上下文`,
    `- 這是 OpenClaw 的 SuperClaw Telegram 操控介面專案`,
    `- 詳細規格參考: extensions/automation/CODEX_TASKS.md`,
    `- 現有程式碼在: extensions/automation/src/`,
  ].join("\n");

  try {
    const { runId } = await api.runtime.subagent.run({
      sessionKey,
      message: instruction,
      provider: "codex",
      extraSystemPrompt:
        "你是 SuperClaw 專案的自動化建置 agent。" +
        "按照 CODEX_TASKS.md 的規格完成任務。" +
        "所有程式碼放在 extensions/automation/ 下。" +
        "使用 TypeScript，註解用繁體中文。" +
        "完成後清楚回報你修改/建立了哪些檔案。",
    });

    const result = await api.runtime.subagent.waitForRun({
      runId,
      timeoutMs: CODEX_TIMEOUT_MS,
    });

    // 清理 session
    try {
      await api.runtime.subagent.deleteSession({ sessionKey });
    } catch {
      // 清理失敗不影響結果
    }

    if (result.status === "ok") {
      // 標記任務完成
      markTaskDone(filePath, task);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function pollAndExecute(api: OpenClawPluginApi): Promise<void> {
  if (isProcessing) return;

  const filePath = resolveTaskFilePath();
  const modifiedMs = getFileModifiedTime(filePath);

  // 檔案沒有變更，跳過
  if (modifiedMs <= lastModifiedMs) return;
  lastModifiedMs = modifiedMs;

  const task = getNextTask(filePath);
  if (!task) return;

  isProcessing = true;

  try {
    const success = await executeTask(api, task, filePath);

    if (success) {
      // 成功後檢查是否有下一個任務
      const nextTask = getNextTask(filePath);
      if (nextTask) {
        // 遞迴執行下一個
        lastModifiedMs = 0; // 強制重新檢查
      }
    }
  } finally {
    isProcessing = false;
  }
}

export function registerFileWatcher(api: OpenClawPluginApi): void {
  // 啟動時初始化 lastModifiedMs
  const filePath = resolveTaskFilePath();
  lastModifiedMs = getFileModifiedTime(filePath);

  // 定時輪詢檢查檔案變更
  const interval = setInterval(() => {
    pollAndExecute(api).catch(() => {
      // 靜默處理錯誤，下次輪詢再試
    });
  }, POLL_INTERVAL_MS);

  // Gateway 停止時清除 interval
  api.on("gateway_stop", async () => {
    clearInterval(interval);
  });

  // 也可以透過 Gateway RPC 手動觸發
  api.registerGatewayMethod(
    "automation.codex.runNextTask",
    async () => {
      const task = getNextTask(filePath);
      if (!task) {
        return { status: "no_tasks", message: "沒有待執行的任務" };
      }

      // 不等待完成，立即返回
      executeTask(api, task, filePath).catch(() => {});

      return {
        status: "started",
        task: task.description,
        message: `開始執行: ${task.description}`,
      };
    },
  );

  // 查詢任務狀態
  api.registerGatewayMethod(
    "automation.codex.taskStatus",
    async () => {
      const tasks = (() => {
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          return parseTasksFromContent(content);
        } catch {
          return [];
        }
      })();

      const done = tasks.filter((t) => t.done).length;
      const pending = tasks.filter((t) => !t.done).length;
      const next = tasks.find((t) => !t.done);

      return {
        total: tasks.length,
        done,
        pending,
        isProcessing,
        nextTask: next?.description ?? null,
      };
    },
  );
}
