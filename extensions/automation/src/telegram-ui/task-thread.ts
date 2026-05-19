import type { InteractiveReply } from "./types.js";
import type { AgentPhase } from "./agent-state.js";

const PHASE_EMOJI: Record<AgentPhase, string> = {
  idle: "🟢",
  thinking: "🤔",
  coding: "👨‍💻",
  testing: "🧪",
  reviewing: "🔍",
  deploying: "🚀",
  awaiting_input: "⏳",
  error: "🔴",
};

export function buildTaskRoot(
  taskId: string,
  title: string,
  agent: "claude" | "codex",
): InteractiveReply {
  const agentEmoji = agent === "claude" ? "🧠" : "💻";
  return {
    blocks: [
      {
        type: "text",
        text: `${agentEmoji} <b>${title}</b>\n\n🔄 啟動中...`,
      },
    ],
  };
}

export function buildTaskProgress(
  title: string,
  phase: AgentPhase,
  stepCurrent: number,
  stepTotal: number,
  currentAction: string,
  elapsed: number,
  thinkingLine?: string,
): InteractiveReply {
  const emoji = PHASE_EMOJI[phase];
  const lines = [
    `${emoji} <b>${title}</b>`,
    "",
    `Step ${stepCurrent}/${stepTotal}: ${currentAction}`,
  ];

  if (thinkingLine) {
    lines.push(`<i>→ ${thinkingLine}</i>`);
  }

  lines.push("", `⏱ ${(elapsed / 1000).toFixed(0)}s`);

  const progressBar = buildProgressBar(stepCurrent, stepTotal);
  lines.splice(2, 0, progressBar);

  return {
    blocks: [
      { type: "text", text: lines.join("\n") },
      {
        type: "buttons",
        buttons: [
          { label: "📋 詳情", value: "sc:detail", style: "primary" },
          { label: "⏹ 停止", value: "sc:kill", style: "danger" },
        ],
      },
    ],
  };
}

export function buildTaskComplete(
  title: string,
  success: boolean,
  summary: string,
  elapsed: number,
  suggestedActions: Array<{ label: string; value: string }>,
): InteractiveReply {
  const emoji = success ? "🎉" : "❌";
  const status = success ? "完成" : "失敗";

  const lines = [
    `${emoji} <b>${title}</b> — ${status}`,
    "",
    summary,
    "",
    `⏱ ${(elapsed / 1000).toFixed(1)}s`,
  ];

  const buttons = suggestedActions.slice(0, 3).map((a) => ({
    label: a.label,
    value: a.value,
    style: "primary" as const,
  }));

  if (!success) {
    buttons.unshift({ label: "🔄 重試", value: "sc:retry", style: "primary" });
  }

  return {
    blocks: [
      { type: "text", text: lines.join("\n") },
      ...(buttons.length > 0
        ? [{ type: "buttons" as const, buttons: buttons.slice(0, 3) }]
        : []),
    ],
  };
}

export function buildTaskAwaitingInput(
  title: string,
  question: string,
  taskId: string,
  options?: Array<{ label: string; value: string }>,
): InteractiveReply {
  const defaultOptions = [
    { label: "✅ 批准", value: `sc:approve:${taskId}` },
    { label: "❌ 拒絕", value: `sc:deny:${taskId}` },
    { label: "✏️ 修改後批准", value: `sc:edit:${taskId}` },
  ];

  const buttons = (options ?? defaultOptions).map((o) => ({
    label: o.label,
    value: o.value,
    style: "primary" as const,
  }));

  return {
    blocks: [
      {
        type: "text",
        text: `⏳ <b>${title}</b>\n\n${question}`,
      },
      { type: "buttons", buttons },
    ],
  };
}

export function buildTaskError(
  title: string,
  errorMessage: string,
  taskId: string,
): InteractiveReply {
  const truncatedError =
    errorMessage.length > 300
      ? errorMessage.slice(0, 300) + "..."
      : errorMessage;

  return {
    blocks: [
      {
        type: "text",
        text: `🔴 <b>${title}</b> — 出錯了\n\n<code>${escapeHtml(truncatedError)}</code>`,
      },
      {
        type: "buttons",
        buttons: [
          { label: "🔄 重試", value: `sc:retry:${taskId}`, style: "primary" },
          { label: "🔍 分析錯誤", value: `sc:analyze:${taskId}`, style: "primary" },
          { label: "⏭ 跳過", value: `sc:skip:${taskId}`, style: "danger" },
        ],
      },
    ],
  };
}

function buildProgressBar(current: number, total: number, width = 12): string {
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  const pct = Math.round((current / total) * 100);
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${pct}%`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
