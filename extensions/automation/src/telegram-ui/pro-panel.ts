import { getProFeatures } from "./payments.js";
import type { InteractiveReply } from "./types.js";

export function buildProPanel(
  isPro: boolean,
  invoiceLink?: string,
  authSource: string = "none",
): InteractiveReply {
  const features = getProFeatures(true);
  const sourceLine = `授權來源：<code>${escapeHtmlAttr(authSource)}</code>`;
  const featureRows = [
    `${features.multiAgent ? "✅" : "❌"} 多智能體協作`,
    `${features.workflowEditor ? "✅" : "❌"} 流程視覺編輯`,
    `${features.devOpsIntegration ? "✅" : "❌"} 維運整合`,
    `${features.priorityExecution ? "✅" : "❌"} 優先執行`,
  ];

  if (isPro) {
    return {
      blocks: [
        {
          type: "text",
          text: [
            "⭐ <b>SuperClaw Pro</b>",
            "",
            "你目前已啟用 Pro。",
            sourceLine,
            "",
            ...featureRows,
          ].join("\n"),
        },
        {
          type: "buttons",
          buttons: [
            { label: "🛠 設定範例", value: "sc:pro:env", style: "primary" },
            { label: "← 更多功能", value: "sc:more", style: "primary" },
            { label: "← 首頁", value: "sc:home", style: "primary" },
          ],
        },
      ],
    };
  }

  const lines = ["⭐ <b>升級 SuperClaw Pro</b>", "", sourceLine, "", ...featureRows];
  if (invoiceLink?.trim()) {
    lines.push("", `付款連結：<a href="${escapeHtmlAttr(invoiceLink)}">點此升級</a>`);
  }

  return {
    blocks: [
      {
        type: "text",
        text: lines.join("\n"),
      },
      {
        type: "buttons",
        buttons: [
          { label: "⭐ 立即升級", value: "sc:pro:buy", style: "primary" },
          { label: "🛠 設定範例", value: "sc:pro:env", style: "primary" },
          { label: "← 更多功能", value: "sc:more", style: "primary" },
          { label: "← 首頁", value: "sc:home", style: "primary" },
        ],
      },
    ],
  };
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
