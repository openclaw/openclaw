import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
  formatContextLimitTruncationNotice,
  installToolResultContextGuard,
} from "./tool-result-context-guard.js";

function makeUser(text: string): AgentMessage {
  return castAgentMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

function makeToolResult(id: string, text: string, toolName = "grep"): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  });
}

function makeReadToolResult(id: string, text: string): AgentMessage {
  return makeToolResult(id, text, "read");
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

async function applyGuardToContext(
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

function expectPiStyleTruncation(text: string): void {
  expect(text).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  expect(text).toMatch(/\[\.\.\. \d+ more characters truncated\]$/);
  expect(text).not.toContain("[compacted: tool output removed to free context]");
  expect(text).not.toContain("[compacted: tool output trimmed to free context]");
  expect(text).not.toContain("[truncated: output exceeded context limit]");
}

describe("formatContextLimitTruncationNotice", () => {
  it("formats pi-style truncation wording with a count", () => {
    expect(formatContextLimitTruncationNotice(123)).toBe("[... 123 more characters truncated]");
  });
});

describe("installToolResultContextGuard", () => {
  it("passes through unchanged context when under the per-tool and total budget", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeUser("hello"), makeToolResult("call_ok", "small output")];

    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).toBe(contextForNextCall);
  });

  it("does not preemptively overflow large non-tool context that is still under the high-water mark", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeUser("u".repeat(3_200))];

    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).toBe(contextForNextCall);
  });

  it("returns a cloned guarded context so original oversized tool output stays visible", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeToolResult("call_big", "z".repeat(5_000))];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];

    expect(transformed).not.toBe(contextForNextCall);
    const newResultText = getToolResultText(transformed[0]);
    expect(newResultText.length).toBeLessThan(5_000);
    expectPiStyleTruncation(newResultText);
    expect(getToolResultText(contextForNextCall[0])).toBe("z".repeat(5_000));
  });

  it("wraps an existing transformContext and guards the transformed output", async () => {
    const agent = makeGuardableAgent((messages) =>
      messages.map((msg) =>
        castAgentMessage({
          ...(msg as unknown as Record<string, unknown>),
        }),
      ),
    );
    const contextForNextCall = [makeToolResult("call_big", "x".repeat(5_000))];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];

    expect(transformed).not.toBe(contextForNextCall);
    expectPiStyleTruncation(getToolResultText(transformed[0]));
  });

  it("handles legacy role=tool string outputs with pi-style truncation wording", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeLegacyToolResult("call_big", "y".repeat(5_000))];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];
    const newResultText = getToolResultText(transformed[0]);

    expect(typeof (transformed[0] as { content?: unknown }).content).toBe("string");
    expectPiStyleTruncation(newResultText);
  });

  it("drops oversized tool-result details when truncating once", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeToolResultWithDetails("call_big", "x".repeat(900), "d".repeat(8_000)),
    ];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];
    const result = transformed[0] as { details?: unknown };
    const newResultText = getToolResultText(transformed[0]);

    expectPiStyleTruncation(newResultText);
    expect(result.details).toBeUndefined();
    expect((contextForNextCall[0] as { details?: unknown }).details).toBeDefined();
  });

  it("throws overflow when total context exceeds the budget after one-time truncation", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(2_800)),
      makeToolResult("call_ok", "x".repeat(500)),
    ];

    await expect(applyGuardToContext(agent, contextForNextCall)).rejects.toThrow(
      PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
    );

    expect(getToolResultText(contextForNextCall[1])).toBe("x".repeat(500));
  });

  it("throws overflow instead of historically rewriting older tool results", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(2_200)),
      makeToolResult("call_1", "a".repeat(500)),
      makeToolResult("call_2", "b".repeat(500)),
      makeToolResult("call_3", "c".repeat(500)),
    ];

    await expect(applyGuardToContext(agent, contextForNextCall)).rejects.toThrow(
      PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
    );

    expect(getToolResultText(contextForNextCall[1])).toBe("a".repeat(500));
    expect(getToolResultText(contextForNextCall[2])).toBe("b".repeat(500));
    expect(getToolResultText(contextForNextCall[3])).toBe("c".repeat(500));
  });

  it("throws overflow instead of special-casing the latest read result", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(2_900)),
      makeToolResult("call_old", "x".repeat(400)),
      makeReadToolResult("call_new", "y".repeat(500)),
    ];

    await expect(applyGuardToContext(agent, contextForNextCall)).rejects.toThrow(
      PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
    );

    expect(getToolResultText(contextForNextCall[1])).toBe("x".repeat(400));
    expect(getToolResultText(contextForNextCall[2])).toBe("y".repeat(500));
  });

  it("supports model-window-specific truncation for large but otherwise valid tool results", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeToolResult("call_big", "q".repeat(95_000))];

    const transformed = (await applyGuardToContext(
      agent,
      contextForNextCall,
      100_000,
    )) as AgentMessage[];

    expectPiStyleTruncation(getToolResultText(transformed[0]));
  });
});
