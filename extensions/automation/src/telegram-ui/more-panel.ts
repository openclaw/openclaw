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
          { label: "🔄 工作流程", value: "sc:wf", style: "primary" },
          { label: "⏰ 排程", value: "sc:cron", style: "primary" },
          { label: "🧠 切換模型", value: "sc:model", style: "primary" },
        ],
      },
      {
        type: "buttons",
        buttons: [
          { label: "📈 交易", value: "sc:trade", style: "primary" },
          { label: "🚀 維運", value: "sc:devops", style: "primary" },
          { label: "📊 智能體管理", value: "sc:agents", style: "primary" },
          { label: "🖥️ 儀表板", value: "sc:dash", style: "primary" },
        ],
      },
      {
        type: "buttons",
        buttons: [
          { label: "🔨 程式建置", value: "sc:build", style: "primary" },
          { label: "💬 工作階段", value: "sc:sess", style: "primary" },
          { label: "📜 對話歷史", value: "sc:history", style: "primary" },
        ],
      },
      {
        type: "buttons",
        buttons: [{ label: "🗑️ 重置對話", value: "sc:reset", style: "danger" }],
      },
      {
        type: "buttons",
        buttons: [{ label: "⭐ 升級專業版", value: "sc:pro", style: "primary" }],
      },
      {
        type: "buttons",
        buttons: [{ label: "← 首頁", value: "sc:home", style: "primary" }],
      },
    ],
  };
}
