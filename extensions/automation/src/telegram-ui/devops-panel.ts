import type { InteractiveReply } from "./types.js";
import { buildBreadcrumb } from "./main-menu.js";
import { formatCIStatusBoard, type CIStatus } from "../devops/ci-monitor.js";

export function buildDevOpsPanel(statuses: CIStatus[]): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "DevOps");
  const board = formatCIStatusBoard(statuses);

  const failedCount = statuses.filter((s) => s.status === "failure").length;
  const runningCount = statuses.filter((s) => s.status === "running").length;

  const summaryLine =
    failedCount > 0
      ? `⚠️ ${failedCount} 失敗`
      : runningCount > 0
        ? `🔄 ${runningCount} 執行中`
        : "✅ 全部正常";

  return {
    blocks: [
      { type: "text", text: `${nav}\n\n${board}\n\n${summaryLine}` },
      {
        type: "buttons",
        buttons: [
          { label: "🔄 重新整理", value: "sc:dv:ref", style: "primary" },
          { label: "📋 PR 列表", value: "sc:dv:prs", style: "primary" },
        ],
      },
      ...(failedCount > 0
        ? [
            {
              type: "buttons" as const,
              buttons: [
                { label: "🔍 分析失敗", value: "sc:dv:fix", style: "danger" as const },
              ],
            },
          ]
        : []),
      {
        type: "buttons",
        buttons: [{ label: "← 首頁", value: "sc:home", style: "primary" }],
      },
    ],
  };
}

export function buildPRListPanel(
  prs: Array<{
    number: number;
    title: string;
    state: string;
    draft: boolean;
  }>,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "DevOps", "PR 列表");

  if (prs.length === 0) {
    return {
      blocks: [
        { type: "text", text: `${nav}\n\n📋 <b>Pull Requests</b>\n\n沒有 open PR。` },
        {
          type: "buttons",
          buttons: [{ label: "← DevOps", value: "sc:devops", style: "primary" }],
        },
      ],
    };
  }

  const lines = prs.slice(0, 8).map((pr) => {
    const draft = pr.draft ? " [Draft]" : "";
    return `  #${pr.number} ${pr.title.slice(0, 40)}${draft}`;
  });

  const reviewButtons = prs.slice(0, 3).map((pr) => ({
    label: `🔍 #${pr.number}`,
    value: `sc:dv:rv:${pr.number}`,
    style: "primary" as const,
  }));

  return {
    blocks: [
      {
        type: "text",
        text: `${nav}\n\n📋 <b>Open PRs</b> (${prs.length})\n\n${lines.join("\n")}`,
      },
      { type: "buttons", buttons: reviewButtons },
      {
        type: "buttons",
        buttons: [{ label: "← DevOps", value: "sc:devops", style: "primary" }],
      },
    ],
  };
}

export function buildDeployConfirm(env: string): InteractiveReply {
  const isCritical = env === "production" || env === "prod";
  const warning = isCritical
    ? "🔴 <b>正式環境部署</b>\n需要生物辨識驗證。"
    : `🟡 部署到 <b>${env}</b>`;

  return {
    blocks: [
      { type: "text", text: `⚠️ 確認部署\n\n${warning}` },
      {
        type: "buttons",
        buttons: [
          {
            label: "✅ 確認部署",
            value: `sc:dv:dep:${env}`,
            style: isCritical ? "danger" : "success",
          },
          { label: "❌ 取消", value: "sc:devops", style: "primary" },
        ],
      },
    ],
  };
}
