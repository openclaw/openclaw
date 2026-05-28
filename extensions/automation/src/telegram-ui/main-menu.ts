import { resolveTelegramAuthBadge } from "./pro-status.js";
import type { InteractiveReply } from "./types.js";
import { getQuickActions, getContextualGreeting } from "./user-state.js";

export type SystemSnapshot = {
  agentStatus: string;
  activeWorkflows: number;
  pendingApprovals: number;
  cronJobsEnabled: number;
};

const LEGACY_MAIN_MENU_LABEL_MAP: Array<[RegExp, string]> = [
  [/\bWorkfl(?:ow)?\b(?:\.\.\.)?/gi, "工作流程"],
  [/\bDevOp(?:s)?\b(?:\.\.\.)?/gi, "維運"],
  [/\bAgen(?:t)?\b(?:\.\.\.)?/gi, "智能體"],
  [/\bSess(?:ion)?\b(?:\.\.\.)?/gi, "工作階段"],
  [/\bMod(?:el)?\b(?:\.\.\.)?/gi, "模型"],
  [/\bDash(?:board)?\b(?:\.\.\.)?/gi, "儀表板"],
  [/\bMor(?:e)?\b(?:\.\.\.)?/gi, "更多功能"],
  [/\bCodex\b(?:\.\.\.)?/gi, "寫碼"],
];

export function buildMainMenu(userId: number, snapshot?: SystemSnapshot): InteractiveReply {
  const greeting = getContextualGreeting(userId);
  const recent = getQuickActions(userId);
  const authBadge = resolveTelegramAuthBadge(userId);

  const statusLine = snapshot
    ? `\n🤖 ${snapshot.agentStatus}` +
      (snapshot.activeWorkflows > 0 ? ` · 🔄 ${snapshot.activeWorkflows} 執行中` : "") +
      (snapshot.pendingApprovals > 0 ? ` · ⚠️ ${snapshot.pendingApprovals} 待批准` : "") +
      (snapshot.cronJobsEnabled > 0 ? ` · ⏰ ${snapshot.cronJobsEnabled} 排程` : "")
    : "";

  const blocks: InteractiveReply["blocks"] = [
    {
      type: "text",
      text: `${greeting}\n<b>SuperClaw 控制台</b> · ${authBadge}${statusLine}`,
    },
  ];

  if (recent.length > 0) {
    blocks.push({
      type: "buttons",
      buttons: recent.map((r) => ({
        label: `🕐 ${sanitizeButtonLabel(r.label)}`,
        value: safeCallbackData(r.callbackData),
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
        { label: "🔄 工作流程", value: "sc:wf", style: "primary" },
      ],
    },
    {
      type: "buttons",
      buttons: [
        { label: "⏰ 排程", value: "sc:cron", style: "primary" },
        { label: "🧠 切換模型", value: "sc:model", style: "primary" },
        { label: "📊 狀態", value: "sc:stat", style: "primary" },
      ],
    },
    {
      type: "buttons",
      buttons: [
        { label: "🚀 維運", value: "sc:devops", style: "primary" },
        { label: "💹 交易", value: "sc:trade", style: "primary" },
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

function safeCallbackData(value: string): string {
  return Buffer.byteLength(value, "utf8") <= 64 && value.length > 0 ? value : "sc:home";
}

function sanitizeButtonLabel(value: string): string {
  const cleaned = value.replace(/[\r\n\t]/g, " ").trim();
  let normalized = cleaned;
  for (const [pattern, localized] of LEGACY_MAIN_MENU_LABEL_MAP) {
    normalized = normalized.replace(pattern, localized);
  }
  return normalized;
}

export { buildBreadcrumb };
