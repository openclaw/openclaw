import { HEARTBEAT_TOKEN, isSilentReplyText } from "../../../auto-reply/tokens.js";
import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.types.js";

export function resolveSubagentCompletionResultText(entry: {
  completion?: {
    resultText?: string | null;
    fallbackResultText?: string | null;
    terminalReply?: AgentRunTerminalReplySnapshot;
  };
  execution: {
    outcome?: { status: "ok" | "error" | "timeout" | "unknown" };
  };
}): string | undefined {
  const terminalReply = entry.completion?.terminalReply;
  if (terminalReply) {
    return terminalReply.disposition === "visible" ? terminalReply.text : undefined;
  }
  const primary = entry.completion?.resultText?.trim();
  const fallback = entry.completion?.fallbackResultText?.trim();
  if (entry.execution.outcome?.status !== "ok") {
    return primary || fallback || undefined;
  }
  if (primary === HEARTBEAT_TOKEN) {
    return undefined;
  }
  if (primary && !isSilentReplyText(primary)) {
    return primary;
  }
  return fallback && fallback !== HEARTBEAT_TOKEN && !isSilentReplyText(fallback)
    ? fallback
    : undefined;
}
