import type { WorkboardLifecycle, WorkboardTaskSummary } from "./types.ts";

export type CardSessionState =
  | "unlinked"
  | "unknown"
  | "unavailable"
  | "ambiguous"
  | "idle"
  | "queued"
  | "running"
  | "stale"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "stopped";

export function taskMatchesLifecycle(
  task: WorkboardTaskSummary,
  lifecycle: WorkboardLifecycle,
): boolean {
  switch (task.status) {
    case "queued":
    case "running":
      return lifecycle.state === "running";
    case "completed":
      return lifecycle.state === "succeeded";
    case "failed":
    case "cancelled":
    case "timed_out":
      return lifecycle.state === "failed";
  }
  throw new Error("Unknown workboard task status.");
}

export function getCardSessionState(
  lifecycle: WorkboardLifecycle,
  task?: WorkboardTaskSummary,
): CardSessionState {
  if (task && taskMatchesLifecycle(task, lifecycle)) {
    return task.status === "completed" ? "succeeded" : task.status;
  }
  if (lifecycle.state === "failed") {
    if (lifecycle.session?.status === "timeout") {
      return "timed_out";
    }
    if (lifecycle.session?.status === "killed" || lifecycle.session?.abortedLastRun) {
      return "stopped";
    }
  }
  return lifecycle.state;
}
