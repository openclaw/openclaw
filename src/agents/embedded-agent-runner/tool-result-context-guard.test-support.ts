import type { Agent, AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { expect } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { installToolResultContextGuard } from "./tool-result-context-guard.js";

export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "more characters truncated";

export function makeUser(text: string): AgentMessage {
  return castAgentMessage({ role: "user", content: text, timestamp: Date.now() });
}

export function makeToolResult(id: string, text: string, toolName = "grep"): AgentMessage {
  return makeTextToolResult(id, toolName, text, false, Date.now());
}

export function makeAssistant(text: string, extras: Record<string, unknown> = {}): AgentMessage {
  return castAgentMessage({ ...makeUser(text), role: "assistant", ...extras });
}

export function makeReadToolResult(id: string, text: string): AgentMessage {
  return makeToolResult(id, text, "read");
}

export function makeLegacyToolResult(id: string, text: string): AgentMessage {
  const legacy = { role: "tool", tool_call_id: id, tool_name: "read", content: text };
  return castAgentMessage(legacy);
}

export function makeToolResultWithDetails(
  id: string,
  text: string,
  detailText: string,
): AgentMessage {
  const truncation = { truncated: true, outputLines: 100, content: detailText };
  return castAgentMessage({
    ...makeReadToolResult(id, text),
    details: { truncation },
  });
}

export function getToolResultText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  const block = (Array.isArray(content) ? content : []).find(
    (entry) => entry && typeof entry === "object" && (entry as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

export function makeGuardableAgent(transformContext?: Agent["transformContext"]) {
  return { transformContext };
}

export async function applyGuardToContext(
  agent: Pick<Agent, "transformContext">,
  contextForNextCall: AgentMessage[],
  contextWindowTokens = 1_000,
) {
  installToolResultContextGuard({ agent, contextWindowTokens });
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
  let sum = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (message.role !== "toolResult" || !Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        sum += block.text.length;
      }
    }
  }
  return sum;
}
