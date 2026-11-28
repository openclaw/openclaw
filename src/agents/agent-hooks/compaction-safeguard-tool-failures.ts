/** Collects failed tool results and renders the bounded Tool Failures summary section. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { copyString } from "../../../packages/agent-core/src/harness/utils/truncate.js";
import { normalizeAcceptedSessionSpawnResult } from "../accepted-session-spawn.js";
import { collectTextContentBlocks } from "../content-blocks.js";
import type { AgentMessage } from "../runtime/index.js";

const MAX_TOOL_FAILURES = 8;
const MAX_TOOL_FAILURE_CHARS = 240;

export type ToolFailure = {
  toolCallId: string;
  toolName: string;
  summary: string;
  meta?: string;
};

function formatToolFailureMeta(details: unknown): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  // SAFETY: the guard above proved a non-null object; every field read below is narrowed at use.
  const record = details as Record<string, unknown>;
  return (
    [
      typeof record.status === "string" && record.status ? `status=${record.status}` : "",
      typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
        ? `exitCode=${record.exitCode}`
        : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined
  );
}

/** Row-local contribution; accepted launches never consume a deduplication key. */
export function collectToolFailureFact(message: AgentMessage): ToolFailure | undefined {
  if (message.role !== "toolResult" || !message.isError) {
    return undefined;
  }
  // SAFETY: role is "toolResult" (checked above); each field is read as unknown and narrowed.
  const toolResult = message as {
    toolCallId?: unknown;
    toolName?: unknown;
    content?: unknown;
    details?: unknown;
    isError?: unknown;
  };
  // Accepted sessions_spawn launches are successes, not failures, even when a legacy
  // transcript persisted them with isError:true. Mirror the observer's detection
  // (toolName + accepted child-run identity, see embedded-agent-subscribe.handlers.tools)
  // so only real failures stay in the summary and non-spawn tools are never matched by shape.
  if (
    typeof toolResult.toolName === "string" &&
    toolResult.toolName.trim() === "sessions_spawn" &&
    normalizeAcceptedSessionSpawnResult(toolResult)
  ) {
    return undefined;
  }
  const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
  if (!toolCallId) {
    return undefined;
  }

  const toolName =
    typeof toolResult.toolName === "string" && toolResult.toolName.trim()
      ? toolResult.toolName
      : "tool";
  const meta = formatToolFailureMeta(toolResult.details);
  const failureText =
    collectTextContentBlocks(toolResult.content).join("\n").replace(/\s+/g, " ").trim() ||
    (meta ? "failed" : "failed (no output)");
  const summary =
    failureText.length > MAX_TOOL_FAILURE_CHARS
      ? `${truncateUtf16Safe(failureText, MAX_TOOL_FAILURE_CHARS - 3)}...`
      : failureText;
  return {
    toolCallId: copyString(toolCallId),
    toolName: copyString(toolName),
    summary: copyString(summary),
    meta: meta === undefined ? undefined : copyString(meta),
  };
}

/** Reduce only the selected history/prefix, preserving first-failure order and exact count. */
export function collectToolFailuresFromFacts(
  facts: Iterable<ToolFailure | undefined>,
): ToolFailure[] {
  const failures: ToolFailure[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    if (fact && !seen.has(fact.toolCallId)) {
      seen.add(fact.toolCallId);
      failures.push(fact);
    }
  }
  return failures;
}

export function collectToolFailures(messages: AgentMessage[]): ToolFailure[] {
  function* facts() {
    for (const message of messages) {
      yield collectToolFailureFact(message);
    }
  }
  return collectToolFailuresFromFacts(facts());
}

export function formatToolFailuresSection(failures: ToolFailure[]): string {
  if (failures.length === 0) {
    return "";
  }
  const lines = failures.slice(0, MAX_TOOL_FAILURES).map((failure) => {
    const meta = failure.meta ? ` (${failure.meta})` : "";
    return `- ${failure.toolName}${meta}: ${failure.summary}`;
  });
  if (failures.length > MAX_TOOL_FAILURES) {
    lines.push(`- ...and ${failures.length - MAX_TOOL_FAILURES} more`);
  }
  return `\n\n## Tool Failures\n${lines.join("\n")}`;
}
