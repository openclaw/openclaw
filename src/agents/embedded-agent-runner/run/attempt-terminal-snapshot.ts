import type { AgentTerminalSnapshot } from "../../agent-terminal-snapshot.js";
import { prepareTerminalAssistantReply } from "../../assistant-terminal-reply.js";
import type { AgentMessage } from "../../runtime/index.js";

/** The caller supplies only the terminal message anchored to this attempt's prompt boundary. */
export function captureAgentTerminalSnapshot(params: {
  terminalMessage: AgentMessage | undefined;
  reachedPromptBoundary: boolean;
  success: boolean;
  hasHookError: boolean;
}): AgentTerminalSnapshot {
  const message = params.reachedPromptBoundary ? params.terminalMessage : undefined;
  const assistant = message?.role === "assistant" ? message : undefined;
  const reply = assistant ? prepareTerminalAssistantReply(assistant) : undefined;
  const content = Array.isArray(assistant?.content) ? assistant.content : [];
  const hasReasoning = content.some((part) => part.type === "thinking");
  const hasNonText = content.some((part) => part.type !== "text");
  const stopReason = assistant?.stopReason;
  return {
    version: 1,
    agentSuccess: params.success ? "true" : "false",
    lastMessageRole: !params.reachedPromptBoundary
      ? "unknown"
      : !message
        ? "absent"
        : message.role === "assistant"
          ? "assistant"
          : message.role === "toolResult"
            ? "tool_result"
            : "other",
    finalTextState: !params.reachedPromptBoundary
      ? "unknown"
      : !message
        ? "unavailable"
        : !assistant
          ? "not_assistant"
          : reply?.terminalReply.disposition === "visible"
            ? "visible"
            : reply?.terminalReply.disposition === "silent"
              ? "silent"
              : hasReasoning
                ? "reasoning_only"
                : hasNonText
                  ? "non_text"
                  : "empty",
    errorSource: params.hasHookError
      ? "agent_hook"
      : stopReason === "error"
        ? "final_assistant"
        : params.reachedPromptBoundary
          ? "absent"
          : "unknown",
    lastAssistantStopReason:
      !params.reachedPromptBoundary || !message
        ? "unavailable"
        : !assistant
          ? "not_assistant"
          : stopReason === "toolUse"
            ? "tool_use"
            : stopReason === "stop" ||
                stopReason === "length" ||
                stopReason === "error" ||
                stopReason === "aborted"
              ? stopReason
              : "other",
    // This snapshot does not infer media delivery from transcript text or tool output.
    mediaObserved: "unknown",
  };
}
