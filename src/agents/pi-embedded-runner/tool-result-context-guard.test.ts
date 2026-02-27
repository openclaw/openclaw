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

function makeAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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

function makeToolResultWithDetails(id: string, text: string, detailText: string): AgentMessage {
  return {
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
  } as unknown as AgentMessage;
}

function getToolResultText(msg: AgentMessage): string {
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

function makeGuardableAgent(
  transformContext?: (
    messages: AgentMessage[],
    signal: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>,
) {
  return { transformContext };
}

describe("installToolResultContextGuard", () => {
  it("compacts older tool results but preserves trailing (most recent) ones", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    // Simulate: user -> old tool result -> assistant -> new trailing tool result
    const contextForNextCall = [
      makeUser("u".repeat(2_000)),
      makeToolResult("call_old", "x".repeat(1_000)),
      makeAssistant("response"),
      makeToolResult("call_new", "y".repeat(1_000)),
    ];

    const transformed = await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    );

    expect(transformed).toBe(contextForNextCall);
    // Old tool result (before assistant) should be compacted
    const oldResultText = getToolResultText(contextForNextCall[1]);
    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    // Trailing tool result should be preserved (truncated at most, not compacted)
    const newResultText = getToolResultText(contextForNextCall[3]);
    expect(newResultText).not.toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("keeps compacting oldest-first until context is back under budget, protecting trailing results", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    // 3 old tool results separated by assistant, then 1 trailing
    const contextForNextCall = [
      makeUser("u".repeat(1_400)),
      makeToolResult("call_1", "a".repeat(800)),
      makeAssistant("r1"),
      makeToolResult("call_2", "b".repeat(800)),
      makeAssistant("r2"),
      makeToolResult("call_3", "c".repeat(800)),
    ];

    await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    const first = getToolResultText(contextForNextCall[1]);
    const second = getToolResultText(contextForNextCall[3]);
    const third = getToolResultText(contextForNextCall[5]);

    // Old tool results should be compacted
    expect(first).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(second).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    // Trailing tool result is protected
    expect(third).not.toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(third.length).toBe(800);
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
      // After each transform, add an assistant response so next tool result is a new turn
      if (i < 4) {
        contextForNextCall.push(makeAssistant(`response ${i}`));
      }
    }

    const toolResultTexts = contextForNextCall
      .filter((msg) => (msg as { role?: string }).role === "toolResult")
      .map((msg) => getToolResultText(msg));

    expect(toolResultTexts[0]).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    // The last (trailing) tool result should be preserved
    expect(toolResultTexts[3]?.length).toBe(95_000);
    expect(toolResultTexts.join("\n")).not.toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("truncates an individually oversized tool result with a context-limit notice", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    // Single trailing tool result -- still gets individually truncated (not compacted)
    const contextForNextCall = [makeToolResult("call_big", "z".repeat(5_000))];

    await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    const newResultText = getToolResultText(contextForNextCall[0]);
    expect(newResultText.length).toBeLessThan(5_000);
    expect(newResultText).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("preserves trailing tool results even when context is over budget", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    // User message is huge, and trailing tool results are at the end
    const contextForNextCall = [
      makeUser("u".repeat(2_600)),
      makeToolResult("call_old", "x".repeat(700)),
      makeAssistant("response"),
      makeToolResult("call_new", "y".repeat(1_000)),
    ];

    await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    // Old tool result should be compacted
    const oldText = getToolResultText(contextForNextCall[1]);
    expect(oldText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    // Trailing tool result should be preserved (may be truncated, not compacted)
    const newText = getToolResultText(contextForNextCall[3]);
    expect(newText).not.toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("wraps an existing transformContext and guards the transformed output", async () => {
    const agent = makeGuardableAgent((messages) => {
      return messages.map(
        (msg) =>
          ({
            ...(msg as unknown as Record<string, unknown>),
          }) as unknown as AgentMessage,
      );
    });
    const contextForNextCall = [
      makeUser("u".repeat(2_000)),
      makeToolResult("call_old", "x".repeat(1_000)),
      makeAssistant("response"),
      makeToolResult("call_new", "y".repeat(1_000)),
    ];

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });
    const transformed = await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    );

    expect(transformed).not.toBe(contextForNextCall);
    const transformedMessages = transformed as AgentMessage[];
    // Old tool result should be compacted
    const oldResultText = getToolResultText(transformedMessages[1]);
    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    // Trailing tool result should be preserved
    const newResultText = getToolResultText(transformedMessages[3]);
    expect(newResultText).not.toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
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
      makeAssistant("response"),
      makeLegacyToolResult("call_new", "y".repeat(1_000)),
    ];

    await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    const oldResultText = (contextForNextCall[1] as { content?: unknown }).content;
    const newResultText = (contextForNextCall[3] as { content?: unknown }).content;

    // Old tool result should be compacted
    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    // Trailing legacy tool result should be preserved
    expect(newResultText).not.toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("drops oversized read-tool details payloads when compacting older tool results", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [
      makeUser("u".repeat(1_600)),
      makeToolResultWithDetails("call_old", "x".repeat(900), "d".repeat(8_000)),
      makeAssistant("response"),
      makeToolResultWithDetails("call_new", "y".repeat(900), "d".repeat(8_000)),
    ];

    await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    const oldResult = contextForNextCall[1] as unknown as {
      details?: unknown;
    };
    const oldResultText = getToolResultText(contextForNextCall[1]);

    // Old tool result should be compacted and details dropped
    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(oldResult.details).toBeUndefined();

    // Trailing tool result should be preserved (may be truncated but not compacted)
    const newResultText = getToolResultText(contextForNextCall[3]);
    expect(newResultText).not.toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("protects all trailing tool results when multiple results are at the end", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    // Pattern: user -> old tool -> assistant -> new_tool_1, new_tool_2 (both trailing)
    const contextForNextCall = [
      makeUser("u".repeat(2_000)),
      makeToolResult("call_old", "x".repeat(500)),
      makeAssistant("response"),
      makeToolResult("call_new_1", "a".repeat(300)),
      makeToolResult("call_new_2", "b".repeat(300)),
    ];

    await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    // Old tool result should be compacted
    const oldText = getToolResultText(contextForNextCall[1]);
    expect(oldText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    // Both trailing tool results should be preserved
    const new1Text = getToolResultText(contextForNextCall[3]);
    const new2Text = getToolResultText(contextForNextCall[4]);
    expect(new1Text).not.toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(new2Text).not.toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("does not compact when all tool results are trailing (no older turns exist)", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    // All tool results are trailing -- nothing older to compact
    const contextForNextCall = [
      makeUser("u".repeat(2_000)),
      makeToolResult("call_1", "x".repeat(500)),
      makeToolResult("call_2", "y".repeat(500)),
    ];

    await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    // Both trailing tool results should be preserved (not compacted)
    const text1 = getToolResultText(contextForNextCall[1]);
    const text2 = getToolResultText(contextForNextCall[2]);
    expect(text1).not.toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(text2).not.toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });
});
