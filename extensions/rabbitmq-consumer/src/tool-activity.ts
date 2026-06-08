/**
 * Sanitized tool-activity narration for frontend progress pushes.
 *
 * Translates agent `tool` stream events into generic, user-facing Chinese
 * status lines ("正在查询分析数据（第 2 步）…"). Only the tool NAME is
 * consulted — tool args (SQL text, file paths, shell commands, credentials)
 * are deliberately never read, so nothing sensitive can leak to the frontend.
 *
 * Twin copies live in the rabbitmq-consumer and report-generator extensions
 * (self-contained packages, no cross-extension imports). Keep them
 * byte-identical: mirror any change to the other copy.
 */

/** Tool name (normalized by the agent runtime) → user-facing activity label. */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  exec: "正在查询分析数据",
  process: "正在查询分析数据",
  read: "正在查阅资料",
  write: "正在整理内容",
  edit: "正在整理内容",
  apply_patch: "正在整理内容",
  web_search: "正在检索网络信息",
  web_fetch: "正在检索网络信息",
  browser: "正在检索网络信息",
  memory_search: "正在回忆相关上下文",
  memory_get: "正在回忆相关上下文",
};

const DEFAULT_LABEL = "正在执行处理步骤";

/**
 * Map a tool name to its sanitized activity label.
 * The name is only ever used as a lookup KEY — never echo it (or any other
 * event field) into the returned text, or unsanitized content could surface.
 */
export function resolveToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName.trim().toLowerCase()] ?? DEFAULT_LABEL;
}

interface NarratorOptions {
  /** Receives each sanitized status line to push to the frontend. */
  push: (message: string) => void;
  /** Minimum gap between pushes of the SAME label (burst collapse). */
  minIntervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Stateful narrator: feed it raw agent events, it emits sanitized status
 * lines for tool starts. Bursts of the same tool kind within `minIntervalMs`
 * collapse into one line; a different tool kind always pushes immediately.
 */
export class ToolActivityNarrator {
  private readonly push: (message: string) => void;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private step = 0;
  private lastPushAt = 0;
  private lastLabel = "";

  constructor(options: NarratorOptions) {
    this.push = options.push;
    this.minIntervalMs = options.minIntervalMs ?? 2000;
    this.now = options.now ?? Date.now;
  }

  /** Feed an agent event; everything but `tool` start phases is ignored. */
  handleAgentEvent(evt: { stream: string; data?: Record<string, unknown> }): void {
    if (evt.stream !== "tool") {
      return;
    }
    const data = evt.data ?? {};
    if (data.phase !== "start") {
      return;
    }
    const name = typeof data.name === "string" ? data.name : "";
    const label = resolveToolLabel(name);
    const ts = this.now();
    if (label === this.lastLabel && ts - this.lastPushAt < this.minIntervalMs) {
      return;
    }
    // Increment only on actual pushes so visible step numbers stay contiguous
    // even when same-tool bursts are collapsed.
    this.step += 1;
    this.lastLabel = label;
    this.lastPushAt = ts;
    this.push(`${label}（第 ${this.step} 步）…`);
  }
}
