import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER,
  installToolResultContextGuard,
} from "./tool-result-context-guard.js";

function makeUser(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeToolResult(id: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function getToolResultText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const block = content.find(
    (entry) => entry && typeof entry === "object" && (entry as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

function makeGuardableAgent(initialMessages: AgentMessage[] = []) {
  const state = { messages: [...initialMessages] };
  return {
    state,
    appendMessage(message: AgentMessage) {
      state.messages = [...state.messages, message];
    },
  };
}

describe("installToolResultContextGuard", () => {
  it("preemptively compacts older tool results before appending a new large result", () => {
    const agent = makeGuardableAgent([
      makeUser("u".repeat(2_500)),
      makeToolResult("call_old", "x".repeat(700)),
    ]);

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const incoming = makeToolResult("call_new", "y".repeat(1_000));
    agent.appendMessage(incoming);

    const oldResultText = getToolResultText(agent.state.messages[1] as AgentMessage);
    const newResultText = getToolResultText(agent.state.messages[2] as AgentMessage);

    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(newResultText.length).toBe(1_000);
    expect(newResultText).not.toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("truncates an individually oversized tool result with a context-limit notice", () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const incoming = makeToolResult("call_big", "z".repeat(5_000));
    agent.appendMessage(incoming);

    const newResultText = getToolResultText(agent.state.messages[0] as AgentMessage);
    expect(newResultText.length).toBeLessThan(5_000);
    expect(newResultText).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("truncates tool results when adding them would overflow remaining context budget", () => {
    const agent = makeGuardableAgent([makeUser("u".repeat(3_350))]);

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const incoming = makeToolResult("call_fit", "w".repeat(1_000));
    agent.appendMessage(incoming);

    const newResultText = getToolResultText(agent.state.messages[1] as AgentMessage);
    expect(newResultText.length).toBeLessThan(1_000);
    expect(newResultText).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("guards in-flight context via transformContext before the next model call", async () => {
    const oldResult = makeToolResult("call_old", "x".repeat(1_100));
    const pendingResult = makeToolResult("call_pending", "y".repeat(1_800));
    const agent = makeGuardableAgent([makeUser("u".repeat(1_600)), oldResult]);

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [...agent.state.messages, pendingResult];
    const transformed = await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    expect(transformed).toBe(contextForNextCall);
    const oldResultText = getToolResultText(contextForNextCall[1] as AgentMessage);
    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });
});
