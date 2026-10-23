import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage } from "@openclaw/llm-core";
import type { AgentToolCall } from "./types.js";

/** Observation only: the exact runtime queue retains input and delivery custody. */
export type AgentToolPendingInput = {
  hasPending: () => boolean;
  subscribe: (listener: () => void) => () => void;
};

/** Internal assistant-turn context for one concrete tool invocation. */
export interface AgentToolExecutionContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  pendingInput?: AgentToolPendingInput;
  /** Earlier async calls in this response have not reached a subsequent model request. */
  hasUnobservedAsyncToolResults?: boolean;
}

const activeToolExecution = new AsyncLocalStorage<AgentToolExecutionContext>();
const inputScopeByInvocation = new WeakMap<AssistantMessage, WeakMap<AgentToolCall, object>>();

/** Bind before awaited admission; later input must not relabel an in-flight call. */
export function captureAgentToolInputScope(
  context: Pick<AgentToolExecutionContext, "assistantMessage" | "toolCall">,
  inputScope: object,
): void {
  let calls = inputScopeByInvocation.get(context.assistantMessage);
  if (!calls) {
    calls = new WeakMap();
    inputScopeByInvocation.set(context.assistantMessage, calls);
  }
  if (!calls.has(context.toolCall)) {
    calls.set(context.toolCall, inputScope);
  }
}

/** The same private identity is available during execution and after-tool publication. */
export function getAgentToolInputScope(
  context:
    | Pick<AgentToolExecutionContext, "assistantMessage" | "toolCall">
    | undefined = activeToolExecution.getStore(),
): object | undefined {
  return context
    ? inputScopeByInvocation.get(context.assistantMessage)?.get(context.toolCall)
    : undefined;
}

export function getAgentToolExecutionContext(): AgentToolExecutionContext | undefined {
  return activeToolExecution.getStore();
}

export function resolveAgentAssistantTurnId(message: AssistantMessage): string | undefined {
  return message.responseId?.trim() || message.turnId?.trim() || undefined;
}

// Provider tool-call ids are only unique within one assistant response.
export function getAgentToolAssistantTurnId(): string | undefined {
  const message = getAgentToolExecutionContext()?.assistantMessage;
  return message ? resolveAgentAssistantTurnId(message) : undefined;
}

export function runWithAgentToolExecutionContext<T>(
  context: AgentToolExecutionContext,
  run: () => T,
): T {
  return activeToolExecution.run(context, run);
}
