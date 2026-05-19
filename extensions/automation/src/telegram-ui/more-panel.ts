import type { InteractiveReply } from "./types.js";

export function buildMorePanel(): InteractiveReply {
  return {
    blocks: [
      {
        type: "text",
        text: "⚙️ <b>更多功能</b>",
      },
      {
        type: "buttons",
        buttons: [
          { label: "🔄 Workflow", value: "sc:wf", style: "primary" },
          { label: "⏰ 排程", value: "sc:cron", style: "primary" },
          { label: "🧠 切換模型", value: "sc:model", style: "primary" },
        ],
      },
      {
        type: "buttons",
        buttons: [
          { label: "🚀 DevOps", value: "sc:devops", style: "primary" },
          { label: "📊 Agent 管理", value: "sc:agents", style: "primary" },
          { label: "🖥️ 儀表板", value: "sc:dash", style: "primary" },
        ],
      },
      {
        type: "buttons",
        buttons: [
          { label: "🔨 Codex 建置", value: "sc:build", style: "primary" },
          { label: "📜 對話歷史", value: "sc:history", style: "primary" },
          { label: "🗑️ 重置對話", value: "sc:reset", style: "danger" },
        ],
      },
      {
        type: "buttons",
        buttons: [
          { label: "← 返回", value: "sc:home", style: "primary" },
        ],
      },
    ],
  };
}
