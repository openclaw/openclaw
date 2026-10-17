import type { AgentRunTerminalOutcome } from "./agent-run-terminal-outcome.types.js";

function completedBeforeOrAtTimeout(params: {
  completed: AgentRunTerminalOutcome;
  timeout: AgentRunTerminalOutcome;
}): boolean {
  return (
    params.completed.reason === "completed" &&
    params.completed.endedAt !== undefined &&
    params.timeout.endedAt !== undefined &&
    params.completed.endedAt <= params.timeout.endedAt
  );
}

/** Merges observations without overwriting a proven cancellation or hard timeout. */
export function mergeAgentRunTerminalOutcome(
  current: AgentRunTerminalOutcome | undefined,
  incoming: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome {
  if (!current) {
    return incoming;
  }
  if (current.reason === "superseded" || current.reason === "cancelled") {
    // Timestamps, not callback ordering, decide whether an earlier provider timeout won.
    if (
      incoming.reason === "hard_timeout" &&
      incoming.endedAt !== undefined &&
      current.endedAt !== undefined &&
      incoming.endedAt <= current.endedAt
    ) {
      return incoming;
    }
    return current.reason === "superseded" || incoming.reason !== "superseded" ? current : incoming;
  }
  // A hard timeout owns the run unless an earlier completion or cancellation is proven.
  if (current.reason === "hard_timeout") {
    if (
      (incoming.reason === "superseded" || incoming.reason === "cancelled") &&
      incoming.endedAt !== undefined &&
      current.endedAt !== undefined &&
      incoming.endedAt < current.endedAt
    ) {
      return incoming;
    }
    return completedBeforeOrAtTimeout({ completed: incoming, timeout: current })
      ? incoming
      : current;
  }
  if (incoming.reason === "hard_timeout") {
    return completedBeforeOrAtTimeout({ completed: current, timeout: incoming })
      ? current
      : incoming;
  }
  return incoming;
}
