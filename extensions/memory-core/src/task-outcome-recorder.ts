import { promises as fs } from "node:fs";
import path from "node:path";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  addTaskRegistryEventListener,
  type TaskRecord,
  type TaskRegistryObserverEvent,
  type TaskStatus,
} from "openclaw/plugin-sdk/task-events";

const TASK_OUTCOME_LOG_RELATIVE_PATH = path.join("memory", ".dreams", "task-outcomes.jsonl");

const TERMINAL_STATUSES = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
]);

type TaskOutcomeRecord = {
  type: "task.outcome";
  timestamp: string;
  taskId: string;
  status: TaskStatus;
  runtime: TaskRecord["runtime"];
  agentId?: string;
  taskKind?: string;
  label?: string;
  summary: string;
  durationMs?: number;
  error?: string;
};

const MAX_LABEL_LENGTH = 240;
const MAX_ERROR_LENGTH = 480;

function shouldRecord(
  event: TaskRegistryObserverEvent,
): { task: TaskRecord; previous?: TaskRecord } | null {
  if (event.kind !== "upserted") {
    return null;
  }
  if (!TERMINAL_STATUSES.has(event.task.status)) {
    return null;
  }
  // Only record state transitions; if the task was already terminal we have
  // already logged the outcome on the original event.
  if (event.previous && TERMINAL_STATUSES.has(event.previous.status)) {
    return null;
  }
  return { task: event.task, previous: event.previous };
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function summarizeOutcome(task: TaskRecord): string {
  const label =
    truncate(task.label?.trim(), MAX_LABEL_LENGTH) ??
    truncate(task.task.split("\n", 1)[0]?.trim(), MAX_LABEL_LENGTH) ??
    task.taskId;
  if (task.status === "succeeded") {
    const trailing = task.terminalSummary ? ` — ${truncate(task.terminalSummary, 240)}` : "";
    return `Task succeeded: ${label}${trailing}`;
  }
  const error = task.error ? ` — ${truncate(task.error, MAX_ERROR_LENGTH)}` : "";
  return `Task ${task.status}: ${label}${error}`;
}

function buildOutcomeRecord(task: TaskRecord, nowMs: number): TaskOutcomeRecord {
  return {
    type: "task.outcome",
    timestamp: new Date(nowMs).toISOString(),
    taskId: task.taskId,
    status: task.status,
    runtime: task.runtime,
    ...(task.agentId ? { agentId: task.agentId } : {}),
    ...(task.taskKind ? { taskKind: task.taskKind } : {}),
    ...(task.label ? { label: truncate(task.label, MAX_LABEL_LENGTH) } : {}),
    summary: summarizeOutcome(task),
    ...(task.startedAt && task.endedAt
      ? { durationMs: Math.max(0, task.endedAt - task.startedAt) }
      : {}),
    ...(task.error ? { error: truncate(task.error, MAX_ERROR_LENGTH) } : {}),
  };
}

async function appendTaskOutcomeRecord(
  workspaceDir: string,
  record: TaskOutcomeRecord,
): Promise<void> {
  const target = path.join(workspaceDir, TASK_OUTCOME_LOG_RELATIVE_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Record terminal task outcomes (succeeded, failed, timed_out, cancelled, lost)
 * to the agent's workspace as JSONL events. Downstream dreaming can read these
 * to grow MEMORY entries about what worked and what didn't, closing the
 * task → memory feedback loop.
 *
 * Returns an unsubscribe function so the listener can be cleaned up in tests
 * or during plugin reloads.
 */
export function registerTaskOutcomeRecorder(api: OpenClawPluginApi): () => void {
  const log = api.logger;
  const unsubscribe = addTaskRegistryEventListener((event) => {
    const recordable = shouldRecord(event);
    if (!recordable) {
      return;
    }
    const { task } = recordable;
    const agentId = task.agentId ?? resolveDefaultAgentId(api.config);
    if (!agentId) {
      return;
    }
    let workspaceDir: string;
    try {
      workspaceDir = resolveAgentWorkspaceDir(api.config, agentId);
    } catch (error) {
      log.debug?.(
        `task-outcome-recorder: workspace resolution failed for agent ${agentId}: ${String(error)}`,
      );
      return;
    }
    if (!workspaceDir) {
      return;
    }
    const record = buildOutcomeRecord(task, Date.now());
    void appendTaskOutcomeRecord(workspaceDir, record).catch((error: unknown) => {
      log.debug?.(`task-outcome-recorder: append failed for ${task.taskId}: ${String(error)}`);
    });
  });
  return unsubscribe;
}

export const __testing = {
  buildOutcomeRecord,
  shouldRecord,
  summarizeOutcome,
  TASK_OUTCOME_LOG_RELATIVE_PATH,
};
