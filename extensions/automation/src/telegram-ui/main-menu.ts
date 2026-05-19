import type { InteractiveReply } from "./types.js";
import { getQuickActions, getContextualGreeting, type RecentAction } from "./user-state.js";

export type SystemSnapshot = {
  agentStatus: string;
  activeWorkflows: number;
  pendingApprovals: number;
  cronJobsEnabled: number;
};

export function buildMainMenu(
  userId: number,
  snapshot?: SystemSnapshot,
): InteractiveReply {
  const greeting = getContextualGreeting(userId);
  const recent = getQuickActions(userId);

  const statusLine = snapshot
    ? `\n🤖 ${snapshot.agentStatus}` +
      (snapshot.activeWorkflows > 0 ? ` · 🔄 ${snapshot.activeWorkflows} 執行中` : "") +
      (snapshot.pendingApprovals > 0 ? ` · ⚠️ ${snapshot.pendingApprovals} 待批准` : "") +
      (snapshot.cronJobsEnabled > 0 ? ` · ⏰ ${snapshot.cronJobsEnabled} 排程` : "")
    : "";

  const blocks: InteractiveReply["blocks"] = [
    {
      type: "text",
      text: `${greeting}\n<b>SuperClaw 控制台</b>${statusLine}`,
    },
  ];

  if (recent.length > 0) {
    blocks.push({
      type: "buttons",
      buttons: recent.map((r) => ({
        label: `🕐 ${r.label}`,
        value: r.callbackData,
        style: "primary" as const,
      })),
    });
  }

  blocks.push(
    {
      type: "buttons",
      buttons: [
        { label: "💬 對話", value: "sc:chat", style: "primary" },
        { label: "💻 寫碼", value: "sc:code", style: "primary" },
        { label: "🔄 Workflow", value: "sc:wf", style: "primary" },
      ],
    },
    {
      type: "buttons",
      buttons: [
        { label: "⏰ 排程", value: "sc:cron", style: "primary" },
        { label: "🧠 Model", value: "sc:model", style: "primary" },
        { label: "📊 狀態", value: "sc:stat", style: "primary" },
      ],
    },
    {
      type: "buttons",
      buttons: [
        { label: "🚀 DevOps", value: "sc:devops", style: "primary" },
        { label: "🖥️ 儀表板", value: "sc:dash", style: "success" },
      ],
    },
  );

  return { blocks };
}

export function buildStartMessage(): InteractiveReply {
  return {
    blocks: [
      {
        type: "text",
        text:
          "🤖 <b>SuperClaw</b> — AI 自動化操控台\n\n" +
          "Claude 🧠 分析規劃 + Codex 💻 寫碼執行\n" +
          "直接打字開始對話，或選擇功能：",
      },
      {
        type: "buttons",
        buttons: [
          { label: "📋 功能選單", value: "sc:home", style: "primary" },
          { label: "🖥️ 儀表板", value: "sc:dash", style: "success" },
        ],
      },
    ],
  };
}

function buildBreadcrumb(...path: string[]): string {
  return path.join(" › ");
}

export { buildBreadcrumb };
