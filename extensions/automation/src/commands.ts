import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getSystemState } from "./telegram-ui/agent-state.js";
import { buildDashboard } from "./telegram-ui/dashboard.js";
import { buildMainMenu, buildStartMessage } from "./telegram-ui/main-menu.js";
import { buildCronPanel } from "./telegram-ui/cron-panel.js";
import { buildModelPanel } from "./telegram-ui/model-panel.js";
import { buildAgentPanel } from "./telegram-ui/agent-panel.js";
import { buildDevOpsPanel } from "./telegram-ui/devops-panel.js";
import { getGatewayRPC } from "./gateway-rpc.js";
import type { InteractiveReply } from "./telegram-ui/types.js";

/**
 * 將面板轉換為 PluginCommandResult (ReplyPayload) 格式。
 * 使用 `interactive` 欄位讓 Telegram channel renderer 正確渲染按鈕和 HTML。
 */
function toReply(panel: InteractiveReply) {
  return { interactive: panel };
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
    handler: async (ctx: any) => {
      const userId = Number(ctx.senderId) || 0;
      const snapshot = await rpc.fetchSystemSnapshot();
      return toReply(buildMainMenu(userId, snapshot));
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
      const jobs = await rpc.fetchCronJobs();
      return toReply(buildCronPanel(jobs));
    },
  });

  api.registerCommand({
    name: "model",
    description: "切換 AI 模型",
    channels: ["telegram"],
    handler: async () => {
      const [models, current] = await Promise.all([
        rpc.fetchModels(),
        rpc.fetchCurrentModel(),
      ]);
      return toReply(buildModelPanel(models, current));
    },
  });

  api.registerCommand({
    name: "agents",
    description: "Agent 管理面板",
    channels: ["telegram"],
    handler: async () => {
      const [agents, activeId] = await Promise.all([
        rpc.fetchAgents(),
        rpc.fetchActiveAgentId(),
      ]);
      return toReply(buildAgentPanel(agents, activeId));
    },
  });

  api.registerCommand({
    name: "devops",
    description: "DevOps / CI 狀態面板",
    channels: ["telegram"],
    handler: async () => {
      try {
        const statuses: any[] = await api.runtime.gateway.call("ci.statuses");
        const mapped = statuses.map((s) => ({
          provider: (s.provider ?? "github-actions") as "github-actions" | "gitlab-ci" | "other",
          repo: s.repo ?? "unknown",
          branch: s.branch ?? "main",
          status: s.status ?? "unknown",
          url: s.url ?? "",
          updatedAt: s.updatedAt ?? Date.now(),
        }));
        return toReply(buildDevOpsPanel(mapped));
      } catch {
        return toReply(buildDevOpsPanel([]));
      }
    },
  });

  api.registerCommand({
    name: "status",
    description: "系統狀態總覽",
    channels: ["telegram"],
    handler: async () => {
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
        interactive: {
          blocks: [{ type: "text" as const, text }],
        },
      };
    },
  });

  api.registerCommand({
    name: "reset",
    description: "重置當前對話",
    channels: ["telegram"],
    requireAuth: true,
    handler: async () => {
      await rpc.resetSession();
      return {
        interactive: {
          blocks: [{ type: "text" as const, text: "✅ 對話已重置" }],
        },
      };
    },
  });
}
