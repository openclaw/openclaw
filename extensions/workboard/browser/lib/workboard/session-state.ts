import type { WorkboardLifecycle } from "./types.ts";

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

export function getCardSessionState(lifecycle: WorkboardLifecycle): CardSessionState {
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
