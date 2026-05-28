import { buildBreadcrumb } from "./main-menu.js";
import type { InteractiveReply } from "./types.js";

export type SessionListItem = {
  token: string;
  key: string;
  displayName?: string;
  updatedAt?: number | null;
  hasActiveRun?: boolean;
  model?: string;
};

export type SessionDetailItem = {
  token: string;
  key: string;
  displayName?: string;
  label?: string;
  modelProvider?: string;
  model?: string;
  totalTokens?: number;
  spawnedBy?: string;
  updatedAt?: number | null;
  hasActiveRun?: boolean;
};

export function buildSessionPanel(items: SessionListItem[]): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "對話工作階段");
  if (items.length === 0) {
    return {
      blocks: [
        {
          type: "text",
          text: `${nav}\n\n💬 <b>對話工作階段面板</b>\n\n目前沒有可用工作階段。`,
        },
        {
          type: "buttons",
          buttons: [
            { label: "🔄 重新整理", value: "sc:ss:rf", style: "primary" },
            { label: "← 更多", value: "sc:more", style: "primary" },
          ],
        },
      ],
    };
  }

  const lines = items.map((item, idx) => {
    const status = item.hasActiveRun ? "🟢" : "⚪";
    const title = escapeHtml(item.displayName?.trim() || shortenKey(item.key));
    const model = item.model ? ` · <code>${escapeHtml(item.model)}</code>` : "";
    const updated = formatUpdatedAt(item.updatedAt);
    return `${idx + 1}. ${status} <b>${title}</b>${model}\n   <code>${escapeHtml(item.key)}</code>\n   ${updated}`;
  });

  const buttons = items.map((item, idx) => ({
    label: `👁 ${idx + 1}`,
    value: `sc:ss:vw:${item.token}`,
    style: "primary" as const,
  }));

  const blocks: InteractiveReply["blocks"] = [
    {
      type: "text",
      text: `${nav}\n\n💬 <b>對話工作階段面板</b> (${items.length})\n\n${lines.join("\n\n")}`,
    },
  ];

  for (let i = 0; i < buttons.length; i += 3) {
    blocks.push({ type: "buttons", buttons: buttons.slice(i, i + 3) });
  }

  blocks.push({
    type: "buttons",
    buttons: [
      { label: "🔄 重新整理", value: "sc:ss:rf", style: "primary" },
      { label: "📜 對話歷史", value: "sc:history", style: "primary" },
      { label: "← 更多", value: "sc:more", style: "primary" },
    ],
  });

  return { blocks };
}

export function buildSessionDetailPanel(item: SessionDetailItem): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "對話工作階段", "詳情");
  const status = item.hasActiveRun ? "🟢 執行中" : "⚪ 閒置";
  const model =
    item.model || item.modelProvider
      ? `<code>${escapeHtml([item.modelProvider, item.model].filter(Boolean).join("/"))}</code>`
      : "未知";
  const tokens =
    typeof item.totalTokens === "number" ? item.totalTokens.toLocaleString("en-US") : "未知";
  const updated = formatUpdatedAt(item.updatedAt);
  const spawnedBy = item.spawnedBy ? `<code>${escapeHtml(item.spawnedBy)}</code>` : "—";
  const title = escapeHtml(item.displayName?.trim() || item.label?.trim() || shortenKey(item.key));

  const actions: Array<{ label: string; value: string; style?: "primary" | "success" | "danger" }> =
    [];
  if (item.hasActiveRun) {
    actions.push({ label: "⏹ 終止執行", value: `sc:ss:ab:${item.token}`, style: "danger" });
  }
  actions.push({ label: "🧹 壓縮", value: `sc:ss:cp:${item.token}`, style: "primary" });
  actions.push({ label: "🗑️ 刪除", value: `sc:ss:dly:${item.token}`, style: "danger" });

  return {
    blocks: [
      {
        type: "text",
        text:
          `${nav}\n\n` +
          `💬 <b>${title}</b>\n` +
          `狀態：${status}\n` +
          `模型：${model}\n` +
          `權杖：${tokens}\n` +
          `更新：${updated}\n` +
          `來源：${spawnedBy}\n` +
          `Key：<code>${escapeHtml(item.key)}</code>`,
      },
      {
        type: "buttons",
        buttons: actions,
      },
      {
        type: "buttons",
        buttons: [
          { label: "← 對話工作階段", value: "sc:sess", style: "primary" },
          { label: "← 首頁", value: "sc:home", style: "primary" },
        ],
      },
    ],
  };
}

export function buildSessionDeleteConfirmPanel(item: SessionDetailItem): InteractiveReply {
  const name = escapeHtml(item.displayName?.trim() || shortenKey(item.key));
  return {
    blocks: [
      {
        type: "text",
        text:
          `⚠️ <b>確認刪除對話工作階段</b>\n\n` +
          `${name}\n` +
          `<code>${escapeHtml(item.key)}</code>\n\n` +
          `刪除後無法復原。`,
      },
      {
        type: "buttons",
        buttons: [
          { label: "🗑️ 確認刪除", value: `sc:ss:dlok:${item.token}`, style: "danger" },
          { label: "↩ 取消", value: `sc:ss:vw:${item.token}`, style: "primary" },
        ],
      },
    ],
  };
}

export function buildSessionActionResult(
  title: string,
  success: boolean,
  detail: string,
): InteractiveReply {
  const emoji = success ? "✅" : "❌";
  const text = `${emoji} <b>${escapeHtml(title)}</b>\n\n${escapeHtml(detail)}`;
  return {
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          { label: "← 對話工作階段", value: "sc:sess", style: "primary" },
          { label: "← 首頁", value: "sc:home", style: "primary" },
        ],
      },
    ],
  };
}

function shortenKey(value: string, max = 34): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function formatUpdatedAt(ts: number | null | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
    return "更新時間未知";
  }
  return new Date(ts).toLocaleString("zh-TW", { hour12: false });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
