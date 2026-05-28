import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CIStatus } from "./devops/ci-monitor.js";
import { callGatewayCompat, getGatewayRPC } from "./gateway-rpc.js";
import { buildAgentPanel } from "./telegram-ui/agent-panel.js";
import { getSystemState } from "./telegram-ui/agent-state.js";
import { buildCronPanel } from "./telegram-ui/cron-panel.js";
import { buildDashboard } from "./telegram-ui/dashboard.js";
import { buildDevOpsPanel } from "./telegram-ui/devops-panel.js";
import { buildMainMenu, buildStartMessage } from "./telegram-ui/main-menu.js";
import { buildModelPanel } from "./telegram-ui/model-panel.js";
import type { InteractiveReply, PanelButton } from "./telegram-ui/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function asProvider(value: unknown): CIStatus["provider"] {
  return value === "github-actions" || value === "gitlab-ci" || value === "other"
    ? value
    : "github-actions";
}

function asCiStatus(value: unknown): CIStatus["status"] {
  return value === "success" || value === "failure" || value === "pending" || value === "running"
    ? value
    : "pending";
}

/**
 * 將面板轉換為 PluginCommandResult (ReplyPayload) 格式。
 *
 * 面板的 text blocks 使用 HTML 格式（<b>, <code> 等），
 * 所以透過 channelData.telegram 直接指定 textMode: "html"，
 * 讓 Telegram renderer 跳過 markdown→html 轉換，直接用原始 HTML。
 * 按鈕也從 interactive blocks 提取放進 telegram buttons 格式。
 */
function toReply(panel: InteractiveReply) {
  // 提取文字
  const text = panel.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // 提取按鈕 → Telegram inline keyboard 格式 (2D array)
  const buttonBlocks = panel.blocks.filter(
    (b): b is { type: "buttons"; buttons: PanelButton[] } => b.type === "buttons",
  );
  const buttons = buttonBlocks.length
    ? buttonBlocks.map((b) =>
        b.buttons.map((btn) => ({
          text: btn.label,
          callback_data: btn.value,
        })),
      )
    : undefined;

  return {
    text: text || " ",
    channelData: {
      telegram: {
        textMode: "html",
        buttons,
      },
    },
  };
}

export function registerCommands(api: OpenClawPluginApi) {
  const rpc = getGatewayRPC(api);

  api.registerCommand({
    name: "start",
    description: "啟動 SuperClaw 控制台",
    channels: ["telegram"],
    handler: () => toReply(buildStartMessage()),
  });

  api.registerCommand({
    name: "menu",
    description: "開啟主選單面板",
    channels: ["telegram"],
    handler: async (ctx: unknown) => {
      const context = isRecord(ctx) ? ctx : {};
      const userId = Number(context.senderId) || 0;
      try {
        const snapshot = await rpc.fetchSystemSnapshot();
        return toReply(buildMainMenu(userId, snapshot));
      } catch {
        // Gateway 不可用時仍顯示主選單（用預設 snapshot）
        return toReply(
          buildMainMenu(userId, {
            agentStatus: "未知",
            activeWorkflows: 0,
            cronJobsEnabled: 0,
            pendingApprovals: 0,
          }),
        );
      }
    },
  });

  api.registerCommand({
    name: "dashboard",
    nativeNames: { default: "dash" },
    description: "顯示即時儀表板",
    channels: ["telegram"],
    handler: async () => {
      const state = getSystemState();
      return toReply(buildDashboard(state));
    },
  });

  api.registerCommand({
    name: "cron",
    description: "管理定時排程任務",
    channels: ["telegram"],
    handler: async () => {
      try {
        const jobs = await rpc.fetchCronJobs();
        return toReply(buildCronPanel(jobs));
      } catch {
        return toReply(buildCronPanel([]));
      }
    },
  });

  api.registerCommand({
    name: "sc_model",
    description: "切換 AI 模型",
    channels: ["telegram"],
    handler: async () => {
      try {
        const [models, current] = await Promise.all([rpc.fetchModels(), rpc.fetchCurrentModel()]);
        return toReply(buildModelPanel(models, current));
      } catch {
        return toReply(buildModelPanel([], "unknown"));
      }
    },
  });

  api.registerCommand({
    name: "sc_agents",
    description: "Agent 管理面板",
    channels: ["telegram"],
    handler: async () => {
      try {
        const [agents, activeId] = await Promise.all([rpc.fetchAgents(), rpc.fetchActiveAgentId()]);
        return toReply(buildAgentPanel(agents, activeId));
      } catch {
        return toReply(
          buildAgentPanel(
            [
              { id: "main", name: "Claude (Brain)", status: "idle" },
              { id: "coder", name: "Codex (Hands)", status: "idle" },
            ],
            "main",
          ),
        );
      }
    },
  });

  api.registerCommand({
    name: "devops",
    description: "DevOps / CI 狀態面板",
    channels: ["telegram"],
    handler: async () => {
      try {
        const statuses = await callGatewayCompat<unknown[]>(api, "ci.statuses");
        const mapped = statuses.map((s) => ({
          provider: asProvider(isRecord(s) ? s.provider : undefined),
          repo: asString(isRecord(s) ? s.repo : undefined, "unknown"),
          branch: asString(isRecord(s) ? s.branch : undefined, "main"),
          status: asCiStatus(isRecord(s) ? s.status : undefined),
          url: asString(isRecord(s) ? s.url : undefined, ""),
          updatedAt: asNumber(isRecord(s) ? s.updatedAt : undefined, Date.now()),
        }));
        return toReply(buildDevOpsPanel(mapped));
      } catch {
        return toReply(buildDevOpsPanel([]));
      }
    },
  });

  api.registerCommand({
    name: "sc_status",
    description: "系統狀態總覽",
    channels: ["telegram"],
    handler: async () => {
      try {
        const [health, usage, snapshot] = await Promise.all([
          rpc.fetchHealth(),
          rpc.fetchUsage(),
          rpc.fetchSystemSnapshot(),
        ]);
        const text =
          `📊 <b>系統狀態</b>\n\n` +
          `Agent: ${snapshot.agentStatus}\n` +
          `健康: ${health.ok ? "✅ 正常" : `❌ ${health.details ?? "異常"}`}\n` +
          `今日 Token: ${usage.tokensToday.toLocaleString()}\n` +
          `今日費用: $${usage.costToday.toFixed(2)}\n` +
          `排程: ${snapshot.cronJobsEnabled} 個啟用`;
        return {
          text,
          channelData: { telegram: { textMode: "html" } },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          text: `📊 <b>系統狀態</b>\n\n❌ 無法取得系統狀態\n\n<code>${msg.replace(/</g, "&lt;").slice(0, 200)}</code>`,
          channelData: { telegram: { textMode: "html" } },
        };
      }
    },
  });

  api.registerCommand({
    name: "sc_reset",
    description: "重置當前對話",
    channels: ["telegram"],
    requireAuth: true,
    handler: async () => {
      try {
        await rpc.resetSession();
        return { text: "✅ 對話已重置" };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          text: `❌ 重置失敗: ${msg.replace(/</g, "&lt;").slice(0, 200)}`,
          channelData: { telegram: { textMode: "html" } },
        };
      }
    },
  });

  // ── 每日回報 ──────────────────────────────────────────────────

  api.registerCommand({
    name: "report",
    description: "產生今日活動回報",
    channels: ["telegram"],
    handler: async () => {
      try {
        const report = await buildDailyReport(rpc);
        return {
          text: report,
          channelData: { telegram: { textMode: "html" } },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          text: `❌ <b>產生回報失敗</b>\n\n<code>${msg.replace(/</g, "&lt;").slice(0, 300)}</code>\n\n<i>請確認 Gateway 已啟動</i>`,
          channelData: { telegram: { textMode: "html" } },
        };
      }
    },
  });

  api.registerCommand({
    name: "setup_daily_report",
    description: "設定每日自動回報排程",
    channels: ["telegram"],
    handler: async () => {
      const result = await rpc.createCronJob({
        name: "每日活動回報",
        schedule: {
          kind: "cron",
          expr: "0 21 * * *",
          tz: "Asia/Taipei",
        },
        payload: {
          kind: "agentTurn",
          message: DAILY_REPORT_PROMPT,
          lightContext: true,
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
        },
        enabled: true,
      });

      if (result.ok) {
        return {
          text:
            `✅ <b>每日回報排程已建立</b>\n\n` +
            `⏰ 每天 21:00 (Asia/Taipei)\n` +
            `📋 自動產生：今日做了什麼、學了什麼、對話重點\n` +
            `📬 透過 Telegram 推送\n\n` +
            `<i>也可以隨時輸入 /report 立即產生回報</i>`,
          channelData: { telegram: { textMode: "html" } },
        };
      }
      const errorDetail = result.error
        ? `\n\n<code>${result.error.replace(/</g, "&lt;").slice(0, 300)}</code>`
        : "";
      return {
        text: `❌ <b>建立排程失敗</b>${errorDetail}\n\n<i>請確認 Gateway 已啟動且 cron 服務正常運作</i>`,
        channelData: { telegram: { textMode: "html" } },
      };
    },
  });
}

// ── 每日回報的 Prompt ────────────────────────────────────────────

const DAILY_REPORT_PROMPT = `請產生今日 OpenClaw 活動回報，包含以下三大部分：

## 1. 今日做了什麼
回顧今天所有 agent 的活動：
- 處理了哪些任務和請求
- 執行了哪些 cron 排程任務
- 完成了哪些程式碼修改或工作流
- 重要的系統事件（啟動、重啟、錯誤等）

## 2. 學習與新增
- 記憶系統新增了什麼（MEMORY.md 變更）
- 新學到的使用者偏好或工作模式
- 新發現的 codebase 知識或架構理解
- 任何自我改進或配置調整

## 3. 對話重點
- 與使用者的關鍵對話內容摘要
- 重要決策和共識
- 待辦事項或未完成的請求
- 使用者明確表達的需求或方向

請用繁體中文回覆，格式簡潔清晰，用 emoji 標記重點。如果某部分無資料，簡短說明即可。`;

// ── 即時回報產生器 ──────────────────────────────────────────────

async function buildDailyReport(rpc: ReturnType<typeof getGatewayRPC>): Promise<string> {
  const now = new Date();
  const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;

  // 並行取得各項資料
  const [health, usage, cronJobs, cronRuns, agents, snapshot] = await Promise.all([
    rpc.fetchHealth(),
    rpc.fetchUsage(),
    rpc.fetchCronJobs(),
    rpc.fetchCronRuns({ scope: "all", limit: 30 }),
    rpc.fetchAgents(),
    rpc.fetchSystemSnapshot(),
  ]);

  // 今日 cron 執行統計
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayRuns = cronRuns.filter((r) => r.ts >= todayStart);
  const successRuns = todayRuns.filter((r) => r.status === "ok" || r.status === "success");
  const failedRuns = todayRuns.filter((r) => r.status === "error" || r.status === "failure");

  // 組裝回報
  let report = `📊 <b>OpenClaw 每日回報</b>\n📅 ${dateStr}\n${"─".repeat(20)}\n\n`;

  // 系統狀態
  report +=
    `🏥 <b>系統狀態</b>\n` +
    `  健康: ${health.ok ? "✅ 正常" : "❌ 異常"}\n` +
    `  Agent: ${snapshot.agentStatus}\n` +
    `  Token 使用: ${usage.tokensToday.toLocaleString()}\n` +
    `  費用: $${usage.costToday.toFixed(2)}\n\n`;

  // 今日活動
  report += `📋 <b>今日活動</b>\n`;
  if (todayRuns.length === 0) {
    report += `  今天沒有排程任務執行\n`;
  } else {
    report +=
      `  排程執行: ${todayRuns.length} 次\n` +
      `  ✅ 成功: ${successRuns.length}\n` +
      (failedRuns.length > 0 ? `  ❌ 失敗: ${failedRuns.length}\n` : ``);

    // 列出有 summary 的任務
    const withSummary = todayRuns.filter((r) => r.summary);
    for (const run of withSummary.slice(0, 5)) {
      const jobName =
        cronJobs.find((j) => j.id === run.jobId)?.description ?? run.jobId.slice(0, 8);
      report += `  • ${jobName}: ${run.summary?.slice(0, 60)}\n`;
    }
  }
  report += `\n`;

  // Agent 狀態
  report += `🤖 <b>Agent 列表</b>\n`;
  for (const agent of agents) {
    const statusIcon = agent.status === "running" ? "🟢" : agent.status === "error" ? "🔴" : "⚪";
    report += `  ${statusIcon} ${agent.name}`;
    if (agent.model) {
      report += ` (${agent.model})`;
    }
    report += `\n`;
  }
  report += `\n`;

  // 排程概覽
  const enabledJobs = cronJobs.filter((j) => j.enabled);
  report += `⏰ <b>啟用排程</b>: ${enabledJobs.length} 個\n`;
  for (const job of enabledJobs.slice(0, 5)) {
    const name = job.description ?? job.id.slice(0, 12);
    report += `  • ${name} — ${job.schedule}\n`;
  }
  if (enabledJobs.length > 5) {
    report += `  ... 還有 ${enabledJobs.length - 5} 個\n`;
  }
  report += `\n`;

  report += `<i>💡 輸入 /setup_daily_report 設定每日自動推送</i>`;

  return report;
}
