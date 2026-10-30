import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type TerminalReplySummary =
  | { disposition: "visible"; textLength: number; modelRouteChange?: string }
  | Exclude<AgentRunTerminalReplySnapshot, { disposition: "visible" }>;

const evictedPayloads = new WeakMap<SubagentRunRecord, TerminalReplySummary | undefined>();

/** Resident decisions need reply facts; only prepared full readers consume the text. */
export function getSubagentTerminalReplySummary(
  entry: SubagentRunRecord,
): TerminalReplySummary | undefined {
  if (evictedPayloads.has(entry)) {
    return evictedPayloads.get(entry);
  }
  const reply = entry.completion?.terminalReply;
  return reply?.disposition === "visible"
    ? {
        disposition: reply.disposition,
        textLength: reply.text.length,
        modelRouteChange: reply.modelRouteChange,
      }
    : reply;
}

export function recordSubagentRunPayloadEviction(
  compact: SubagentRunRecord,
  full: SubagentRunRecord,
): void {
  evictedPayloads.set(compact, getSubagentTerminalReplySummary(full));
}

export function isSubagentRunPayloadEvicted(entry: SubagentRunRecord): boolean {
  return evictedPayloads.has(entry);
}
