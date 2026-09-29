import type { WorkboardLifecycle } from "./types.ts";

export type CardSessionState = WorkboardLifecycle["state"] | "timed_out" | "stopped";

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
