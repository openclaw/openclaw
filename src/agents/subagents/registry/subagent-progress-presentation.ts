import type { createChannelProgressDraftCompositor } from "../../../channels/progress-draft-compositor.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type ProgressItem = Parameters<
  ReturnType<typeof createChannelProgressDraftCompositor>["pushItemEvent"]
>[0];

/** Only prepared operation names and outcomes cross a private child's audience boundary. */
export function projectSubagentProgressActivity(
  event: AgentEventPayload,
  lifecycle: string,
  itemId: string,
): ProgressItem | undefined {
  const data = event.data;
  if (
    event.lifecycleGeneration !== lifecycle ||
    event.stream !== "item" ||
    data.kind !== "tool" ||
    data.hideFromChannelProgress === true ||
    data.suppressChannelProgress === true ||
    typeof data.name !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,120}$/.test(data.name)
  ) {
    return undefined;
  }
  const status = data.status;
  if (
    status !== "running" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "blocked" &&
    status !== "skipped"
  ) {
    return undefined;
  }
  return {
    itemId,
    kind: "tool",
    name: data.name,
    phase: status === "running" ? "update" : "end",
    status,
  };
}

export function projectSubagentProgressState(entry: SubagentRunRecord): ProgressItem {
  const paused = entry.pauseReason === "sessions_yield";
  const ended = entry.execution.status === "terminal" && !paused;
  return {
    itemId: entry.runId,
    kind: "subagent",
    title: (entry.label ?? entry.taskName ?? "Delegated work").slice(0, 120),
    phase: ended ? "end" : "update",
    status: ended
      ? entry.execution.outcome?.status === "ok"
        ? "completed"
        : entry.execution.outcome?.status === "error" ||
            entry.execution.outcome?.status === "timeout"
          ? "failed"
          : undefined
      : paused
        ? undefined
        : "running",
    summary: paused
      ? "waiting"
      : ended && (!entry.execution.outcome || entry.execution.outcome.status === "unknown")
        ? "outcome unknown"
        : undefined,
  };
}
