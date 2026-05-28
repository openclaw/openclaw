import { buildBreadcrumb } from "./main-menu.js";
import type { InteractiveReply } from "./types.js";

export type AgentInfo = {
  id: string;
  name: string;
  status: "running" | "idle" | "error";
  model?: string;
  sessionTurns?: number;
  uptime?: number;
};

const STATUS_EMOJI: Record<string, string> = {
  running: "🟢",
  idle: "💤",
  error: "🔴",
};

export function buildAgentPanel(agents: AgentInfo[], activeAgentId?: string): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "智能體管理");

  const lines = agents.map((a) => {
    const emoji = STATUS_EMOJI[a.status] ?? "❓";
    const active = a.id === activeAgentId ? " ← 當前" : "";
    const model = a.model ? `  模型: <code>${escapeHtml(a.model)}</code>` : "";
    const turns = a.sessionTurns != null ? `  對話: ${a.sessionTurns} 輪` : "";
    const uptime = a.uptime != null ? `  上線: ${formatDuration(a.uptime)}` : "";
    return `${emoji} <b>${escapeHtml(a.name)}</b>${active}\n${model}${turns}${uptime}`.trim();
  });

  const switchButtons = agents
    .filter((a) => a.id !== activeAgentId)
    .slice(0, 2)
    .map((a) => ({
      label: `切換 ${a.name}`,
      value: `sc:ag:sw:${a.id}`,
      style: "primary" as const,
    }));

  return {
    blocks: [
      {
        type: "text",
        text: `${nav}\n\n🧠 <b>智能體狀態</b>\n\n${lines.join("\n\n")}`,
      },
      ...(switchButtons.length > 0 ? [{ type: "buttons" as const, buttons: switchButtons }] : []),
      {
        type: "buttons",
        buttons: [
          { label: "🧠 切換模型", value: "sc:model", style: "primary" },
          { label: "🗑️ 重置對話", value: "sc:ag:rst", style: "danger" },
        ],
      },
      {
        type: "buttons",
        buttons: [{ label: "← 首頁", value: "sc:home", style: "primary" }],
      },
    ],
  };
}

export function buildResetConfirm(agentName: string): InteractiveReply {
  return {
    blocks: [
      {
        type: "text",
        text: `⚠️ 確認要重置 <b>${escapeHtml(agentName)}</b> 的對話？\n所有對話歷史將清除。`,
      },
      {
        type: "buttons",
        buttons: [
          { label: "✅ 確認重置", value: "sc:ag:rst:yes", style: "danger" },
          { label: "❌ 取消", value: "sc:stat", style: "primary" },
        ],
      },
    ],
  };
}

function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `${Math.floor(ms / 1000)} 秒`;
  }
  if (ms < 3_600_000) {
    return `${Math.floor(ms / 60_000)} 分`;
  }
  return `${Math.floor(ms / 3_600_000)} 小時`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
