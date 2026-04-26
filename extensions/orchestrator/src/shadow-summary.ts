// Reads the shadow archive (`~/.openclaw/tasks/orchestrator/shadow/`)
// and summarises spawn outcomes — the live-flip gate from recon A-B4.
// `openclaw orchestrator shadow-summary` exits non-zero if any spawn
// failure is present in the last `--window` hours (default 24).

import type { Store } from "./store.js";
import type { Task, TaskState } from "./types/schema.js";

const FAILURE_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["failed"]);

export interface ShadowSummary {
  total: number;
  byState: Record<TaskState, number>;
  failures: number;
  meanDurationMs: number | null;
  oldestAt: string | null;
  newestAt: string | null;
  windowHours: number;
}

export interface SummariseShadowOptions {
  store: Store;
  /** Restrict to tasks created within the last N hours. Default 24. */
  windowHours?: number;
  now?: () => number;
}

const EMPTY_BY_STATE: Record<TaskState, number> = {
  queued: 0,
  assigned: 0,
  in_progress: 0,
  awaiting_approval: 0,
  done: 0,
  failed: 0,
  cancelled: 0,
  expired: 0,
};

export function summariseShadow(options: SummariseShadowOptions): ShadowSummary {
  const now = options.now ?? Date.now;
  const windowHours = options.windowHours ?? 24;
  const horizonMs = now() - windowHours * 60 * 60 * 1000;

  const tasks = options.store.list({ kind: "shadow" });
  const inWindow: Task[] = tasks.filter((t) => Date.parse(t.createdAt) >= horizonMs);

  const byState: Record<TaskState, number> = { ...EMPTY_BY_STATE };
  let durationSum = 0;
  let durationCount = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  let failures = 0;

  for (const task of inWindow) {
    byState[task.state] += 1;
    if (FAILURE_STATES.has(task.state)) {
      failures += 1;
    }
    if (task.completedAt) {
      const ms = Date.parse(task.completedAt) - Date.parse(task.createdAt);
      if (Number.isFinite(ms)) {
        durationSum += ms;
        durationCount += 1;
      }
    }
    if (oldest === null || task.createdAt < oldest) oldest = task.createdAt;
    if (newest === null || task.createdAt > newest) newest = task.createdAt;
  }

  return {
    total: inWindow.length,
    byState,
    failures,
    meanDurationMs: durationCount === 0 ? null : Math.round(durationSum / durationCount),
    oldestAt: oldest,
    newestAt: newest,
    windowHours,
  };
}

export function formatShadowSummary(summary: ShadowSummary): string {
  const lines: string[] = [];
  lines.push(`shadow window: ${summary.windowHours}h`);
  lines.push(`total:         ${summary.total}`);
  lines.push(`failures:      ${summary.failures}`);
  if (summary.meanDurationMs !== null) {
    lines.push(`mean duration: ${summary.meanDurationMs}ms`);
  }
  if (summary.oldestAt && summary.newestAt) {
    lines.push(`window span:   ${summary.oldestAt} → ${summary.newestAt}`);
  }
  lines.push("by state:");
  for (const state of Object.keys(summary.byState).sort() as TaskState[]) {
    const count = summary.byState[state];
    if (count > 0) {
      lines.push(`  ${state.padEnd(20)} ${count}`);
    }
  }
  return lines.join("\n");
}
