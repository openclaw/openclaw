import type { InteractiveReply } from "./types.js";
import { buildBreadcrumb } from "./main-menu.js";

export type CronJobInfo = {
  id: string;
  enabled: boolean;
  schedule: string;
  timezone?: string;
  nextRun?: string;
  description?: string;
  lastResult?: "success" | "failure";
};

export function buildCronPanel(jobs: CronJobInfo[]): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "排程管理");

  if (jobs.length === 0) {
    return {
      blocks: [
        {
          type: "text",
          text: `${nav}\n\n⏰ <b>定時任務</b>\n\n暫無排程任務。\n輸入描述來建立：\n<i>例：每天早上9點掃描 PR</i>`,
        },
        {
          type: "buttons",
          buttons: [{ label: "← 首頁", value: "sc:home", style: "primary" }],
        },
      ],
    };
  }

  const jobLines = jobs.map((j) => {
    const onOff = j.enabled ? "🟢" : "⏸";
    const lastEmoji =
      j.lastResult === "success" ? "✅" : j.lastResult === "failure" ? "❌" : "";
    const next = j.nextRun ? `\n  下次: ${j.nextRun}` : "";
    return `${onOff} <b>${j.id}</b> ${lastEmoji}\n  ${j.schedule}${j.timezone ? ` (${j.timezone})` : ""}${next}`;
  });

  const toggleButtons = jobs.slice(0, 3).map((j) => ({
    label: `${j.enabled ? "⏸" : "▶️"} ${j.id}`,
    value: `sc:cr:tg:${j.id}`,
    style: "primary" as const,
  }));

  return {
    blocks: [
      {
        type: "text",
        text: `${nav}\n\n⏰ <b>定時任務</b> (${jobs.length})\n\n${jobLines.join("\n\n")}`,
      },
      { type: "buttons", buttons: toggleButtons },
      {
        type: "buttons",
        buttons: [
          { label: "▶️ 立即執行", value: "sc:cr:pick", style: "success" },
          { label: "← 首頁", value: "sc:home", style: "primary" },
        ],
      },
    ],
  };
}

export function buildCronRunPicker(jobs: CronJobInfo[]): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "排程", "立即執行");
  const buttons = jobs.slice(0, 6).map((j) => ({
    label: `▶️ ${j.id}`,
    value: `sc:cr:run:${j.id}`,
    style: "primary" as const,
  }));

  const rows: InteractiveReply["blocks"] = [
    { type: "text", text: `${nav}\n\n選擇要立即執行的任務：` },
  ];

  for (let i = 0; i < buttons.length; i += 3) {
    rows.push({ type: "buttons", buttons: buttons.slice(i, i + 3) });
  }

  rows.push({
    type: "buttons",
    buttons: [{ label: "← 排程", value: "sc:cron", style: "primary" }],
  });

  return { blocks: rows };
}

export function buildCronRunResult(
  jobId: string,
  success: boolean,
  detail?: string,
): InteractiveReply {
  const emoji = success ? "✅" : "❌";
  const status = success ? "完成" : "失敗";
  const detailLine = detail ? `\n\n<i>${detail}</i>` : "";

  return {
    blocks: [
      {
        type: "text",
        text: `${emoji} <b>${jobId}</b> 手動執行${status}${detailLine}`,
      },
      {
        type: "buttons",
        buttons: [
          { label: "🔄 重新執行", value: `sc:cr:run:${jobId}`, style: "primary" },
          { label: "← 排程", value: "sc:cron", style: "primary" },
        ],
      },
    ],
  };
}
