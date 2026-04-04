import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
  PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER,
  installToolResultContextGuard,
} from "./tool-result-context-guard.js";

function makeUser(text: string): AgentMessage {
  return castAgentMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

function makeToolResult(id: string, text: string): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  });
}

function makeLegacyToolResult(id: string, text: string): AgentMessage {
  return castAgentMessage({
    role: "tool",
    tool_call_id: id,
    tool_name: "read",
    content: text,
  });
}

function makeToolResultWithDetails(id: string, text: string, detailText: string): AgentMessage {
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

function makeTwoToolResultOverflowContext(): AgentMessage[] {
  return [
    makeUser("u".repeat(2_000)),
    makeToolResult("call_old", "x".repeat(1_000)),
    makeToolResult("call_new", "y".repeat(1_000)),
  ];
}

async function applyGuardToContext(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  contextForNextCall: AgentMessage[],
) {
  installToolResultContextGuard({
    agent,
    contextWindowTokens: 1_000,
  });
  return await agent.transformContext?.(contextForNextCall, new AbortController().signal);
}

function expectCompactedToolResultsWithoutContextNotice(
  contextForNextCall: AgentMessage[],
  oldIndex: number,
  newIndex: number,
) {
  const oldResultText = getToolResultText(contextForNextCall[oldIndex]);
  const newResultText = getToolResultText(contextForNextCall[newIndex]);
  expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  expect(newResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  expect(newResultText).not.toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
}

describe("installToolResultContextGuard", () => {
  it("compacts newest-first when total context overflows, even if each result fits individually", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = makeTwoToolResultOverflowContext();
    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).toBe(contextForNextCall);
    expectCompactedToolResultsWithoutContextNotice(contextForNextCall, 1, 2);
  });

  it("keeps compacting newest-first until context is back under budget", async () => {
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

    const first = getToolResultText(contextForNextCall[1]);
    const second = getToolResultText(contextForNextCall[2]);
    const third = getToolResultText(contextForNextCall[3]);

    expect(first).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(second).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(third).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("survives repeated large tool results by compacting the newest output each turn", async () => {
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

    // Newest-first compaction: oldest results stay intact to preserve the
    // cached prefix; the newest overflowing result is compacted.
    expect(toolResultTexts[0]?.length).toBe(95_000);
    expect(toolResultTexts[3]).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
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

    const newResultText = getToolResultText(contextForNextCall[0]);
    expect(newResultText.length).toBeLessThan(5_000);
    expect(newResultText).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("keeps compacting newest-first until overflow clears, reaching older tool results when needed", async () => {
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
    expectCompactedToolResultsWithoutContextNotice(contextForNextCall, 1, 2);
  });

  it("wraps an existing transformContext and guards the transformed output", async () => {
    const agent = makeGuardableAgent((messages) => {
      return messages.map((msg) =>
        castAgentMessage({
          ...(msg as unknown as Record<string, unknown>),
        }),
      );
    });
    const contextForNextCall = makeTwoToolResultOverflowContext();
    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).not.toBe(contextForNextCall);
    const transformedMessages = transformed as AgentMessage[];
    const oldResultText = getToolResultText(transformedMessages[1]);
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

  it("drops oversized read-tool details payloads when compacting tool results", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [
      makeUser("u".repeat(1_600)),
      makeToolResultWithDetails("call_old", "x".repeat(900), "d".repeat(8_000)),
      makeToolResultWithDetails("call_new", "y".repeat(900), "d".repeat(8_000)),
    ];

    await agent.transformContext?.(contextForNextCall, new AbortController().signal);

    const oldResult = contextForNextCall[1] as {
      details?: unknown;
    };
    const newResult = contextForNextCall[2] as {
      details?: unknown;
    };
    const oldResultText = getToolResultText(contextForNextCall[1]);
    const newResultText = getToolResultText(contextForNextCall[2]);

    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(newResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(oldResult.details).toBeUndefined();
    expect(newResult.details).toBeUndefined();
  });

  it("throws preemptive context overflow when context exceeds 90% after tool-result compaction", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      // contextBudgetChars = 1000 * 4 * 0.75 = 3000
      // preemptiveOverflowChars = 1000 * 4 * 0.9 = 3600
      contextWindowTokens: 1_000,
    });

    // Large user message (non-compactable) pushes context past 90% threshold.
    const contextForNextCall = [makeUser("u".repeat(3_700)), makeToolResult("call_1", "small")];

    await expect(
      agent.transformContext?.(contextForNextCall, new AbortController().signal),
    ).rejects.toThrow(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
  });

  it("does not throw when context is under 90% after tool-result compaction", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    // Context well under the 3600-char preemptive threshold.
    const contextForNextCall = [makeUser("u".repeat(1_000)), makeToolResult("call_1", "small")];

    await expect(
      agent.transformContext?.(contextForNextCall, new AbortController().signal),
    ).resolves.not.toThrow();
  });

  it("compacts tool results before checking the preemptive overflow threshold", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    // Large user message + large tool result. The guard should compact the tool
    // result first, then check the overflow threshold. Even after compaction the
    // user content alone pushes past 90%, so the overflow error fires.
    const contextForNextCall = [
      makeUser("u".repeat(3_700)),
      makeToolResult("call_old", "x".repeat(2_000)),
    ];

    await expect(
      agent.transformContext?.(contextForNextCall, new AbortController().signal),
    ).rejects.toThrow(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);

    // Tool result should have been compacted before the overflow check.
    const toolResultText = getToolResultText(contextForNextCall[1]);
    expect(toolResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });
});
