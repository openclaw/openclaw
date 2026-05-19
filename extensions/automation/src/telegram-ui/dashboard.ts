import type { InteractiveReply } from "./types.js";
import type { SystemState, AgentPhase } from "./agent-state.js";

const PHASE_DISPLAY: Record<AgentPhase, { emoji: string; label: string }> = {
  idle: { emoji: "🟢", label: "待命中" },
  thinking: { emoji: "🤔", label: "思考中" },
  coding: { emoji: "👨‍💻", label: "寫碼中" },
  testing: { emoji: "🧪", label: "測試中" },
  reviewing: { emoji: "🔍", label: "審查中" },
  deploying: { emoji: "🚀", label: "部署中" },
  awaiting_input: { emoji: "⏳", label: "等待你的決定" },
  error: { emoji: "🔴", label: "出錯了" },
};

export function buildDashboard(state: SystemState): InteractiveReply {
  const blocks: InteractiveReply["blocks"] = [];

  blocks.push({ type: "text", text: buildDashboardText(state) });

  const actionButtons = buildContextualActions(state);
  if (actionButtons.length > 0) {
    for (let i = 0; i < actionButtons.length; i += 3) {
      blocks.push({ type: "buttons", buttons: actionButtons.slice(i, i + 3) });
    }
  }

  return { blocks };
}

function buildDashboardText(state: SystemState): string {
  const lines: string[] = [];
  const { emoji, label } = PHASE_DISPLAY[state.phase];

  lines.push(`${emoji} <b>${label}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━");

  if (state.activeTask) {
    const t = state.activeTask;
    const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
    const agentEmoji = t.agent === "claude" ? "🧠" : "💻";
    lines.push(`${agentEmoji} <b>${t.title}</b>`);
    lines.push(`Step ${t.stepCurrent}/${t.stepTotal}: ${t.currentAction} (${elapsed}s)`);
    if (t.thinkingLine) {
      lines.push(`<i>→ ${t.thinkingLine}</i>`);
    }
    lines.push("");
  }

  if (state.attentionItems.length > 0) {
    const urgent = state.attentionItems.filter((i) => i.urgency === "loud");
    const quiet = state.attentionItems.filter((i) => i.urgency !== "loud");

    if (urgent.length > 0) {
      lines.push(`⚠️ <b>需要你的注意</b> (${urgent.length})`);
      for (const item of urgent.slice(0, 3)) {
        const kindEmoji = getKindEmoji(item.kind);
        lines.push(`  ${kindEmoji} ${item.title}`);
      }
      lines.push("");
    }

    if (quiet.length > 0 && !state.activeTask) {
      lines.push(`📋 近期事件 (${quiet.length})`);
      for (const item of quiet.slice(0, 2)) {
        const kindEmoji = getKindEmoji(item.kind);
        lines.push(`  ${kindEmoji} ${item.title}`);
      }
      lines.push("");
    }
  }

  if (state.lastCompletedTask && !state.activeTask) {
    const t = state.lastCompletedTask;
    const ago = formatTimeAgo(Date.now() - t.completedAt);
    const resultEmoji = t.success ? "✅" : "❌";
    lines.push(`${resultEmoji} 上次: ${t.title} (${ago})`);
    lines.push("");
  }

  if (!state.activeTask && state.attentionItems.length === 0) {
    const hour = new Date().getHours();
    const greeting =
      hour < 6 ? "🌙 深夜了，有什麼需要處理的嗎？" :
      hour < 12 ? "☀️ 早安，今天要做什麼？" :
      hour < 18 ? "🌤 隨時可以開始工作。" :
      "🌆 晚上好，需要我做什麼？";
    lines.push(greeting);
    lines.push("");
  }

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━");
  const c = state.agents.claude;
  const x = state.agents.codex;
  const cStatus = c.status === "busy" ? "🟡" : c.status === "online" ? "🟢" : "⚫";
  const xStatus = x.status === "busy" ? "🟡" : x.status === "online" ? "🟢" : "⚫";
  lines.push(`${cStatus} Claude <code>${c.model}</code>  ${xStatus} Codex <code>${x.model}</code>`);

  if (state.stats.tasksToday > 0) {
    lines.push(`📊 今日: ${state.stats.tasksToday} 任務 · ${formatTokens(state.stats.tokensToday)} tokens`);
  }

  return lines.join("\n");
}

function buildContextualActions(state: SystemState): Array<{ label: string; value: string; style?: "primary" | "success" | "danger" }> {
  switch (state.phase) {
    case "idle": {
      const actions: Array<{ label: string; value: string; style?: "primary" | "success" | "danger" }> = [];

      if (state.attentionItems.some((i) => i.urgency === "loud")) {
        const first = state.attentionItems.find((i) => i.urgency === "loud")!;
        for (const a of first.actionCallbacks.slice(0, 2)) {
          actions.push({ label: a.label, value: a.data, style: "danger" });
        }
      }

      if (state.lastCompletedTask?.success) {
        actions.push(...getSuggestedNextActions(state));
      }

      actions.push(
        { label: "💬 對話", value: "sc:ask", style: "primary" },
        { label: "💻 寫碼", value: "sc:code", style: "primary" },
      );

      if (actions.length < 6) {
        actions.push({ label: "⚙️ 更多", value: "sc:more", style: "primary" });
      }

      return actions.slice(0, 6);
    }

    case "thinking":
    case "coding":
    case "testing":
    case "reviewing":
    case "deploying":
      return [
        { label: "📋 詳情", value: "sc:detail", style: "primary" },
        { label: "⏸ 暫停", value: "sc:pause", style: "primary" },
        { label: "⏹ 停止", value: "sc:kill", style: "danger" },
      ];

    case "awaiting_input": {
      const task = state.activeTask;
      if (!task) return [];
      return [
        { label: "✅ 批准", value: `sc:approve:${task.id}`, style: "success" },
        { label: "❌ 拒絕", value: `sc:deny:${task.id}`, style: "danger" },
        { label: "📋 詳情", value: "sc:detail", style: "primary" },
      ];
    }

    case "error":
      return [
        { label: "🔄 重試", value: "sc:retry", style: "primary" },
        { label: "📋 錯誤詳情", value: "sc:errlog", style: "danger" },
        { label: "⏭ 跳過", value: "sc:skip", style: "primary" },
      ];
  }
}

function getSuggestedNextActions(state: SystemState): Array<{ label: string; value: string; style?: "primary" | "success" | "danger" }> {
  const last = state.lastCompletedTask;
  if (!last) return [];

  const title = last.title.toLowerCase();

  if (title.includes("refactor") || title.includes("重構") || title.includes("fix")) {
    return [
      { label: "🧪 跑測試", value: "sc:do:test", style: "success" },
      { label: "📝 提交", value: "sc:do:commit", style: "primary" },
    ];
  }

  if (title.includes("test") || title.includes("測試")) {
    return [
      { label: "📝 提交", value: "sc:do:commit", style: "success" },
      { label: "🚀 建 PR", value: "sc:do:pr", style: "primary" },
    ];
  }

  if (title.includes("review") || title.includes("審查")) {
    return [
      { label: "✅ 合併", value: "sc:do:merge", style: "success" },
      { label: "💬 回饋", value: "sc:do:feedback", style: "primary" },
    ];
  }

  return [];
}

function getKindEmoji(kind: string): string {
  switch (kind) {
    case "approval": return "🔐";
    case "error": return "❌";
    case "ci_fail": return "🔴";
    case "pr_ready": return "📋";
    case "stale_pr": return "⏰";
    case "task_done": return "✅";
    default: return "📌";
  }
}

function formatTimeAgo(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s 前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m 前`;
  const hr = Math.round(min / 60);
  return `${hr}h 前`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
