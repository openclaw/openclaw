/**
 * Sanitized tool-activity narration for frontend progress pushes.
 *
 * Translates agent `tool` stream events into generic, user-facing Chinese
 * status lines ("正在查询分析数据（第 2 步）…") and, in parallel, structured
 * timeline steps (label + category + status + duration) for the frontend's
 * collapsible "工作过程" panel. Only the tool NAME is consulted — tool args
 * (SQL text, file paths, shell commands, credentials) are deliberately never
 * read, so nothing sensitive can leak to the frontend.
 *
 * Twin copies live in the rabbitmq-consumer and report-generator extensions
 * (self-contained packages, no cross-extension imports). Keep them
 * byte-identical: mirror any change to the other copy.
 */

/** Sanitized step category — drives the frontend's icon, never raw content. */
export type StepCategory = "query" | "read" | "write" | "search" | "memory" | "default";

/** A structured timeline step emitted for the frontend "工作过程" panel. */
export type ActivityStep = {
  phase: "start" | "end";
  /** Stable id pairing a `start` with its `end` (from toolCallId/itemId). */
  stepId: string;
  /** Monotonic ordering index (independent of the collapsed string counter). */
  index: number;
  label: string;
  category: StepCategory;
  status: "running" | "completed" | "failed";
  /** Wall-clock duration in ms, present on `end`. */
  durationMs?: number;
};

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

/** Tool name → sanitized category (icon hint only; never echoes content). */
const TOOL_CATEGORIES: Readonly<Record<string, StepCategory>> = {
  exec: "query",
  process: "query",
  read: "read",
  write: "write",
  edit: "write",
  apply_patch: "write",
  web_search: "search",
  web_fetch: "search",
  browser: "search",
  memory_search: "memory",
  memory_get: "memory",
};

const DEFAULT_LABEL = "正在执行处理步骤";
const DEFAULT_CATEGORY: StepCategory = "default";

/**
 * Map a tool name to its sanitized activity label.
 * The name is only ever used as a lookup KEY — never echo it (or any other
 * event field) into the returned text, or unsanitized content could surface.
 */
export function resolveToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName.trim().toLowerCase()] ?? DEFAULT_LABEL;
}

/** Map a tool name to its sanitized category (lookup KEY only — never echoed). */
export function resolveToolCategory(toolName: string): StepCategory {
  return TOOL_CATEGORIES[toolName.trim().toLowerCase()] ?? DEFAULT_CATEGORY;
}

interface NarratorOptions {
  /** Receives each sanitized status line to push to the frontend. */
  push: (message: string) => void;
  /**
   * Receives structured timeline steps (start/end). Optional: when absent the
   * narrator behaves exactly like the legacy string-only version.
   */
  onStep?: (step: ActivityStep) => void;
  /** Minimum gap between pushes of the SAME label (burst collapse). */
  minIntervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface RunningStep {
  index: number;
  label: string;
  category: StepCategory;
  startedAt: number;
}

/**
 * Stateful narrator: feed it raw agent events, it emits sanitized status
 * lines for tool starts. Bursts of the same tool kind within `minIntervalMs`
 * collapse into one line; a different tool kind always pushes immediately.
 *
 * The structured `onStep` stream is independent of the string collapse: every
 * tool call surfaces as its own start/end pair (matched by stepId) so the
 * timeline shows real per-step status and duration.
 */
export class ToolActivityNarrator {
  private readonly push: (message: string) => void;
  private readonly onStep?: (step: ActivityStep) => void;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private step = 0;
  private lastPushAt = 0;
  private lastLabel = "";
  private stepSeq = 0;
  private readonly running = new Map<string, RunningStep>();

  constructor(options: NarratorOptions) {
    this.push = options.push;
    this.onStep = options.onStep;
    this.minIntervalMs = options.minIntervalMs ?? 2000;
    this.now = options.now ?? Date.now;
  }

  /** Feed an agent event; only `tool` start/end phases are acted on. */
  handleAgentEvent(evt: { stream: string; data?: Record<string, unknown> }): void {
    if (evt.stream !== "tool") {
      return;
    }
    const data = evt.data ?? {};
    if (data.phase === "start") {
      this.handleStart(data);
    } else if (data.phase === "end") {
      this.handleEnd(data);
    }
  }

  private handleStart(data: Record<string, unknown>): void {
    const name = typeof data.name === "string" ? data.name : "";
    const label = resolveToolLabel(name);
    const category = resolveToolCategory(name);
    const ts = this.now();

    // Structured step: one per tool call, never collapsed (the timeline keys
    // each by stepId so a missing `end` is reconciled by the frontend on done).
    if (this.onStep) {
      this.stepSeq += 1;
      const stepId = this.startStepId(data);
      const startedAt = readNumber(data.startedAt) ?? ts;
      this.running.set(stepId, { index: this.stepSeq, label, category, startedAt });
      this.onStep({ phase: "start", stepId, index: this.stepSeq, label, category, status: "running" });
    }

    // Legacy collapsed string push (unchanged behavior).
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

  private handleEnd(data: Record<string, unknown>): void {
    if (!this.onStep) {
      return;
    }
    const stepId = this.endStepId(data);
    if (stepId === null) {
      return;
    }
    const tracked = this.running.get(stepId);
    if (!tracked) {
      return;
    }
    this.running.delete(stepId);
    const status: ActivityStep["status"] = data.status === "failed" ? "failed" : "completed";
    const endedAt = readNumber(data.endedAt) ?? this.now();
    const startedAt = readNumber(data.startedAt) ?? tracked.startedAt;
    const durationMs = Math.max(0, endedAt - startedAt);
    this.onStep({
      phase: "end",
      stepId,
      index: tracked.index,
      label: tracked.label,
      category: tracked.category,
      status,
      durationMs,
    });
  }

  /** Stable id for a start: real toolCallId/itemId, else a unique synthetic id. */
  private startStepId(data: Record<string, unknown>): string {
    const id = data.toolCallId ?? data.itemId;
    if (typeof id === "string" && id) {
      return id;
    }
    if (typeof id === "number") {
      return String(id);
    }
    return `auto-${this.stepSeq}`;
  }

  /** Id for an end: only real ids can pair; synthetic starts complete on done. */
  private endStepId(data: Record<string, unknown>): string | null {
    const id = data.toolCallId ?? data.itemId;
    if (typeof id === "string" && id) {
      return id;
    }
    if (typeof id === "number") {
      return String(id);
    }
    return null;
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
