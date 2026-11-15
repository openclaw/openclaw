import type { WorkboardLifecycle } from "./types.ts";

export type CardSessionState = WorkboardLifecycle["state"] | "cancelled" | "timed_out" | "stopped";

export function getCardSessionState(
  lifecycle: WorkboardLifecycle,
): Exclude<CardSessionState, "cancelled"> {
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
