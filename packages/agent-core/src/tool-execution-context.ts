import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage } from "@openclaw/llm-core";
import type { AgentToolCall } from "./types.js";

/** Internal assistant-turn context for one concrete tool invocation. */
export interface AgentToolExecutionContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  /** Earlier async calls in this response have not reached a subsequent model request. */
  hasUnobservedAsyncToolResults?: boolean;
}

const activeToolExecution = new AsyncLocalStorage<AgentToolExecutionContext>();

export function getAgentToolExecutionContext(): AgentToolExecutionContext | undefined {
  return activeToolExecution.getStore();
}

// Provider tool-call ids are only unique within one assistant response.
export function getAgentToolAssistantTurnId(): string | undefined {
  const message = getAgentToolExecutionContext()?.assistantMessage;
  return message?.responseId?.trim() || message?.turnId?.trim() || undefined;
}

export function runWithAgentToolExecutionContext<T>(
  context: AgentToolExecutionContext,
  run: () => T,
): T {
  return activeToolExecution.run(context, run);
}
