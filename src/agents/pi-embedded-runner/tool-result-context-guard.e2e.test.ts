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

function makeLegacyToolResult(id: string, text: string): AgentMessage {
  return {
    role: "tool",
    tool_call_id: id,
    tool_name: "read",
    content: text,
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

function makeGuardableAgent(
  transformContext?: (
    messages: AgentMessage[],
    signal: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>,
) {
  return { transformContext };
}

describe("installToolResultContextGuard", () => {
  it("compacts oldest-first when total context overflows, even if each result fits individually", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [
      makeUser("u".repeat(2_000)),
      makeToolResult("call_old", "x".repeat(1_000)),
      makeToolResult("call_new", "y".repeat(1_000)),
    ];

    const transformed = await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    );

    expect(transformed).toBe(contextForNextCall);
    const oldResultText = getToolResultText(contextForNextCall[1] as AgentMessage);
    const newResultText = getToolResultText(contextForNextCall[2] as AgentMessage);

    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(newResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(newResultText).not.toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("keeps compacting oldest-first until context is back under budget", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [
      makeUser("u".repeat(2_200)),
      makeToolResult("call_1", "a".repeat(800)),
      makeToolResult("call_2", "b".repeat(800)),
      makeToolResult("call_3", "c".repeat(800)),
    ];

    await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    const first = getToolResultText(contextForNextCall[1] as AgentMessage);
    const second = getToolResultText(contextForNextCall[2] as AgentMessage);
    const third = getToolResultText(contextForNextCall[3] as AgentMessage);

    expect(first).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(second).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(third).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("survives repeated large tool results by compacting older outputs before later turns", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 100_000,
    });

    const contextForNextCall: AgentMessage[] = [makeUser("stress")];
    for (let i = 1; i <= 4; i++) {
      contextForNextCall.push(makeToolResult(`call_${i}`, String(i).repeat(95_000)));
      await agent.transformContext?.(contextForNextCall, new AbortController().signal);
    }

    const toolResultTexts = contextForNextCall
      .filter((msg) => msg.role === "toolResult")
      .map((msg) => getToolResultText(msg as AgentMessage));

    expect(toolResultTexts[0]).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(toolResultTexts[3]?.length).toBe(95_000);
    expect(toolResultTexts.join("\n")).not.toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("truncates an individually oversized tool result with a context-limit notice", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [makeToolResult("call_big", "z".repeat(5_000))];

    await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    const newResultText = getToolResultText(contextForNextCall[0] as AgentMessage);
    expect(newResultText.length).toBeLessThan(5_000);
    expect(newResultText).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("keeps compacting oldest-first until overflow clears, including the newest tool result when needed", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [
      makeUser("u".repeat(2_600)),
      makeToolResult("call_old", "x".repeat(700)),
      makeToolResult("call_new", "y".repeat(1_000)),
    ];

    await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    const oldResultText = getToolResultText(contextForNextCall[1] as AgentMessage);
    const newResultText = getToolResultText(contextForNextCall[2] as AgentMessage);

    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(newResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(newResultText).not.toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("wraps an existing transformContext and guards the transformed output", async () => {
    const agent = makeGuardableAgent((messages) => {
      return messages.map((msg) => ({
        ...(msg as unknown as Record<string, unknown>),
      })) as AgentMessage[];
    });

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [
      makeUser("u".repeat(2_000)),
      makeToolResult("call_old", "x".repeat(1_000)),
      makeToolResult("call_new", "y".repeat(1_000)),
    ];

    const transformed = await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    );

    expect(transformed).not.toBe(contextForNextCall);
    const transformedMessages = transformed as AgentMessage[];
    const oldResultText = getToolResultText(transformedMessages[1] as AgentMessage);
    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("handles legacy role=tool string outputs when enforcing context budget", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [
      makeUser("u".repeat(2_000)),
      makeLegacyToolResult("call_old", "x".repeat(1_000)),
      makeLegacyToolResult("call_new", "y".repeat(1_000)),
    ];

    await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    const oldResultText = (contextForNextCall[1] as { content?: unknown }).content;
    const newResultText = (contextForNextCall[2] as { content?: unknown }).content;

    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(newResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });
});
