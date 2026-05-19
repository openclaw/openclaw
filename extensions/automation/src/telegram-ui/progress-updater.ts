export interface ProgressStep {
  label: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
}

const STATUS_EMOJI: Record<string, string> = {
  pending: "⏳",
  running: "🔄",
  done: "✅",
  error: "❌",
};

const REACTION_MAP: Record<string, string> = {
  thinking: "🤔",
  coding: "👨‍💻",
  testing: "🔬",
  reviewing: "🔍",
  done: "🎉",
  error: "😱",
};

export function getReactionEmoji(phase: string): string {
  return REACTION_MAP[phase] ?? "🤖";
}

export function formatProgressMessage(
  title: string,
  steps: ProgressStep[],
  elapsed?: number,
): string {
  const lines = [`<b>${title}</b>\n`];
  for (const step of steps) {
    const emoji = STATUS_EMOJI[step.status];
    const detail = step.detail ? ` — <i>${step.detail}</i>` : "";
    lines.push(`${emoji} ${step.label}${detail}`);
  }
  if (elapsed !== undefined) {
    lines.push(`\n⏱ ${(elapsed / 1000).toFixed(1)}s`);
  }
  return lines.join("\n");
}

export function formatStreamChunk(buffer: string, maxLen = 4000): string {
  if (buffer.length <= maxLen) return `<pre><code>${escapeHtml(buffer)}</code></pre>`;
  const truncated = buffer.slice(-maxLen);
  return `<pre><code>...\n${escapeHtml(truncated)}</code></pre>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
