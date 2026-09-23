import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { expect } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { installToolResultContextGuard } from "./tool-result-context-guard.js";

export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "more characters truncated";

export function makeUser(text: string): AgentMessage {
  return castAgentMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

export function makeToolResult(id: string, text: string, toolName = "grep"): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  });
}

export function makeAssistant(text: string, extras: Record<string, unknown> = {}): AgentMessage {
  return castAgentMessage({
    role: "assistant",
    content: text,
    timestamp: Date.now(),
    ...extras,
  });
}

export function makeReadToolResult(id: string, text: string): AgentMessage {
  return makeToolResult(id, text, "read");
}

export function makeLegacyToolResult(id: string, text: string): AgentMessage {
  return castAgentMessage({
    role: "tool",
    tool_call_id: id,
    tool_name: "read",
    content: text,
  });
}

export function makeToolResultWithDetails(
  id: string,
  text: string,
  detailText: string,
): AgentMessage {
  // details can be much larger than replay content; guards should drop them
  // only when rewriting the visible tool result.
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    details: {
      truncation: {
        truncated: true,
        outputLines: 100,
        content: detailText,
      },
    },
    isError: false,
    timestamp: Date.now(),
  });
}

export function getToolResultText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const block = content.find(
    (entry) => entry && typeof entry === "object" && (entry as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

export function makeGuardableAgent(
  transformContext?: (
    messages: AgentMessage[],
    signal: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>,
) {
  return { transformContext };
}

export async function applyGuardToContext(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  contextForNextCall: AgentMessage[],
  contextWindowTokens = 1_000,
) {
  installToolResultContextGuard({
    agent,
    contextWindowTokens,
  });
  return await agent.transformContext?.(contextForNextCall, new AbortController().signal);
}

export async function applyMidTurnPrecheckGuardToContext(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  contextForNextCall: AgentMessage[],
  options: {
    contextWindowTokens?: number;
    contextTokenBudget?: number;
    reserveTokens?: number;
    toolResultMaxChars?: number;
    prePromptMessageCount?: number;
    systemPrompt?: string;
  } = {},
) {
  // Mid-turn precheck simulates a new tool result being appended after the
  // original prompt fence; it raises structured signals instead of mutating history.
  const contextWindowTokens = options.contextWindowTokens ?? options.contextTokenBudget ?? 20_000;
  installToolResultContextGuard({
    agent,
    contextWindowTokens,
    midTurnPrecheck: {
      enabled: true,
      contextTokenBudget: options.contextTokenBudget ?? contextWindowTokens,
      reserveTokens: () => options.reserveTokens ?? 10_000,
      toolResultMaxChars: options.toolResultMaxChars,
      getSystemPrompt: () => options.systemPrompt,
      ...(options.prePromptMessageCount !== undefined
        ? { getPrePromptMessageCount: () => options.prePromptMessageCount as number }
        : {}),
    },
  });
  return await agent.transformContext?.(contextForNextCall, new AbortController().signal);
}

export function expectOpenClawTruncation(text: string): void {
  expect(text).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  expect(text).toMatch(
    /\[\.\.\. \d+ more characters truncated; rerun with narrower args if needed\]$/,
  );
  expect(text).not.toContain("[compacted: tool output removed to free context]");
  expect(text).not.toContain("[compacted: tool output trimmed to free context]");
  expect(text).not.toContain("[truncated: output exceeded context limit]");
}

export function sumToolResultTextChars(messages: AgentMessage[]): number {
  // Context-engine budget tests need deterministic text size accounting for
  // toolResult blocks.
  return messages.reduce((sum, message) => {
    if (message.role !== "toolResult") {
      return sum;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return sum;
    }
    return (
      sum +
      content.reduce((blockSum, block) => {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          return blockSum + (block as { text: string }).text.length;
        }
        return blockSum;
      }, 0)
    );
  }, 0);
}
