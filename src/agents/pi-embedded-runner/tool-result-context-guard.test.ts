import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
  PREEMPTIVE_TOOL_RESULT_COMPACTION_NOTICE,
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

function expectReadableCompaction(text: string, prefix: string) {
  expect(text.includes(PREEMPTIVE_TOOL_RESULT_COMPACTION_NOTICE)).toBe(true);
  expect(text).toContain(prefix.repeat(64));
  expect(text).not.toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  expect(text).not.toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
}

function expectReadableToolSlice(text: string, prefix: string) {
  expect(text).toContain(prefix.repeat(64));
  expect(text).not.toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  expect(
    text.includes(PREEMPTIVE_TOOL_RESULT_COMPACTION_NOTICE) ||
      text.includes(CONTEXT_LIMIT_TRUNCATION_NOTICE),
  ).toBe(true);
}

describe("installToolResultContextGuard", () => {
  it("returns a cloned guarded context so original tool output stays visible", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = makeTwoToolResultOverflowContext();
    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).not.toBe(contextForNextCall);
    const transformedMessages = transformed as AgentMessage[];
    expectReadableCompaction(getToolResultText(transformedMessages[1]), "x");
    expectReadableCompaction(getToolResultText(transformedMessages[2]), "y");
    expect(getToolResultText(contextForNextCall[1])).toBe("x".repeat(1_000));
    expect(getToolResultText(contextForNextCall[2])).toBe("y".repeat(1_000));
  });

  it("keeps readable slices of overflowing tool results before using a placeholder", async () => {
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

    const transformed = (await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    )) as AgentMessage[];

    const first = getToolResultText(transformed[1]);
    const second = getToolResultText(transformed[2]);
    const third = getToolResultText(transformed[3]);

    expectReadableCompaction(first, "a");
    expectReadableCompaction(second, "b");
    expect(third).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("survives repeated large tool results by compacting the newest output each turn", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 100_000,
    });

    const contextForNextCall: AgentMessage[] = [makeUser("stress")];
    let transformed: AgentMessage[] | undefined;
    for (let i = 1; i <= 4; i++) {
      contextForNextCall.push(makeToolResult(`call_${i}`, String(i).repeat(95_000)));
      transformed = (await agent.transformContext?.(
        contextForNextCall,
        new AbortController().signal,
      )) as AgentMessage[];
    }

    const toolResultTexts = (transformed ?? [])
      .filter((msg) => msg.role === "toolResult")
      .map((msg) => getToolResultText(msg as AgentMessage));

    // Large outputs are capped per-tool before aggregate compaction kicks in.
    expect(toolResultTexts[0]?.length).toBe(50_000);
    expect(toolResultTexts[0]).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
    expectReadableCompaction(toolResultTexts[3] ?? "", "4");
    expect(toolResultTexts[3]).not.toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("truncates an individually oversized tool result with a context-limit notice", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [makeToolResult("call_big", "z".repeat(5_000))];

    const transformed = (await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    )) as AgentMessage[];

    const newResultText = getToolResultText(transformed[0]);
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

    const transformed = (await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    )) as AgentMessage[];
    expectReadableCompaction(getToolResultText(transformed[1]), "x");
    expect(getToolResultText(transformed[2])).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
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
    expectReadableCompaction(oldResultText, "x");
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

    const transformed = (await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    )) as AgentMessage[];

    const oldResultText = (transformed[1] as { content?: unknown }).content;
    const newResultText = (transformed[2] as { content?: unknown }).content;

    expect(typeof oldResultText).toBe("string");
    expect(typeof newResultText).toBe("string");
    expect(oldResultText).toContain(PREEMPTIVE_TOOL_RESULT_COMPACTION_NOTICE);
    expect(newResultText).toContain(PREEMPTIVE_TOOL_RESULT_COMPACTION_NOTICE);
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

    const transformed = (await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    )) as AgentMessage[];

    const oldResult = transformed[1] as {
      details?: unknown;
    };
    const newResult = transformed[2] as {
      details?: unknown;
    };
    const oldResultText = getToolResultText(transformed[1]);
    const newResultText = getToolResultText(transformed[2]);

    expectReadableToolSlice(oldResultText, "x");
    expectReadableToolSlice(newResultText, "y");
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

    const guarded = agent.transformContext?.(contextForNextCall, new AbortController().signal);
    await expect(guarded).rejects.toThrow(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);

    // Tool result should have been compacted before the overflow check.
    const toolResultText = getToolResultText(contextForNextCall[1]);
    expect(toolResultText).toBe("x".repeat(2_000));
  });
});
