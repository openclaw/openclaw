/** Content-free observations from one completed agent attempt, not a cause classification. */
export type AgentTerminalSnapshot = {
  version: 1;
  agentSuccess: "true" | "false" | "unknown";
  lastMessageRole: "assistant" | "tool_result" | "other" | "absent" | "unknown";
  finalTextState:
    | "visible"
    | "empty"
    | "silent"
    | "reasoning_only"
    | "non_text"
    | "oversized"
    | "not_assistant"
    | "unavailable"
    | "unknown";
  errorSource: "agent_hook" | "final_assistant" | "absent" | "unknown";
  lastAssistantStopReason:
    | "stop"
    | "length"
    | "tool_use"
    | "error"
    | "aborted"
    | "other"
    | "unavailable"
    | "not_assistant";
  mediaObserved: "true" | "false" | "unknown";
};

const selectedAgentTerminal = Symbol("openclaw.selectedAgentTerminal");
type SelectedAgentTerminalError = Error & { [selectedAgentTerminal]?: AgentTerminalSnapshot };

/** Preserve error identity and policy while carrying this exact producer's optional observations. */
export function withAgentTerminalSnapshot<T>(
  error: T,
  snapshot: AgentTerminalSnapshot | undefined,
): T {
  if (error instanceof Error && Object.isExtensible(error)) {
    Object.defineProperty(error, selectedAgentTerminal, { value: snapshot, configurable: true });
  }
  return error;
}

/** Read only the selected error itself; causes and earlier fallback errors are not selection. */
export function readAgentTerminalSnapshot(error: unknown): AgentTerminalSnapshot | undefined {
  if (!(error instanceof Error) || !Object.isExtensible(error)) {
    return undefined;
  }
  const selected: SelectedAgentTerminalError = error;
  return selected[selectedAgentTerminal];
}
