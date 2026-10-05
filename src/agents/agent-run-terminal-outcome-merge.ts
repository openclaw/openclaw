import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentRunTerminalOutcome } from "./agent-run-terminal-outcome.types.js";

function completedBeforeOrAtTimeout(params: {
  completed: AgentRunTerminalOutcome;
  timeout: AgentRunTerminalOutcome;
}): boolean {
  return (
    params.completed.reason === "completed" &&
    typeof params.completed.endedAt === "number" &&
    typeof params.timeout.endedAt === "number" &&
    params.completed.endedAt <= params.timeout.endedAt
  );
}

/** Merges observations without overwriting a proven cancellation or hard timeout. */
export function selectAgentRunTerminalOutcome(
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
      typeof incoming.endedAt === "number" &&
      typeof current.endedAt === "number" &&
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
      typeof incoming.endedAt === "number" &&
      typeof current.endedAt === "number" &&
      incoming.endedAt < current.endedAt
    ) {
      return incoming;
    }
    return completedBeforeOrAtTimeout({ completed: incoming, timeout: current })
      ? incoming
      : current;
  }
  if (incoming.reason === "superseded" || incoming.reason === "cancelled") {
    return incoming;
  }
  if (incoming.reason === "hard_timeout") {
    return completedBeforeOrAtTimeout({ completed: current, timeout: incoming })
      ? current
      : incoming;
  }
  return incoming;
}

/** Cleanup uncertainty refines diagnostics, never the selected cancellation or timeout. */
export function mergeAgentRunTerminalOutcome(
  current: AgentRunTerminalOutcome | undefined,
  incoming: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome {
  const selected = selectAgentRunTerminalOutcome(current, incoming);
  const cleanupError = current?.cleanupError ?? incoming.cleanupError;
  if (!cleanupError) {
    return selected;
  }
  const details: string[] = [];
  for (const error of [
    selected.error,
    current?.error,
    incoming.cleanupError ? incoming.error : undefined,
  ]) {
    const detail = error?.endsWith(cleanupError)
      ? error.slice(0, -cleanupError.length).trim()
      : error;
    if (!detail || details.some((previous) => previous.includes(detail))) {
      continue;
    }
    for (let index = details.length - 1; index >= 0; index -= 1) {
      if (detail.includes(details[index]!)) {
        details.splice(index, 1);
      }
    }
    details.push(detail);
  }
  const boundedDetails = truncateUtf16Safe(details.join("\n\n"), 1_024);
  const error = boundedDetails.includes(cleanupError)
    ? boundedDetails
    : [boundedDetails, cleanupError].filter(Boolean).join("\n\n");
  return selected.cleanupError === cleanupError && selected.error === error
    ? selected
    : { ...selected, cleanupError, error };
}
