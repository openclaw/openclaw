import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { preCompactionPrune } from "./pre-compaction-pruning.js";

// -- Helpers ------------------------------------------------------------------

function makeToolResult(
  overrides: Partial<{
    toolCallId: string;
    toolName: string;
    content: string;
  }> = {},
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: overrides.toolCallId ?? "tc-1",
    toolName: overrides.toolName ?? "Read",
    content: [{ type: "text", text: overrides.content ?? "file content" }],
  } as unknown as AgentMessage;
}

function makeAssistantWithToolCalls(
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>,
): AgentMessage {
  return {
    role: "assistant",
    model: "test-model",
    provider: "test",
    content: toolCalls.map((tc) => ({
      type: "toolCall" as const,
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    })),
  } as unknown as AgentMessage;
}

function makeUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function makeAssistantText(text: string): AgentMessage {
  return {
    role: "assistant",
    model: "test-model",
    provider: "test",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function getTextContent(msg: AgentMessage): string {
  const content = (msg as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((c) => c.type === "text")
      .map((c) => c.text as string)
      .join("\n");
  }
  return "";
}

const longContent = "x".repeat(300);
const shortContent = "short";

// -- Suite B: Pre-Compaction Pruning --

describe("preCompactionPrune -- sub-pass 1: deduplication", () => {
  it("replaces duplicate tool results with dedup placeholder", () => {
    const messages = [
      makeUserMessage("hi"),
      makeToolResult({ toolCallId: "tc-1", content: longContent }),
      makeUserMessage("again"),
      makeToolResult({ toolCallId: "tc-2", content: longContent }), // older dupe
      makeUserMessage("more"),
      makeToolResult({ toolCallId: "tc-3", content: longContent }), // newest
    ];
    // protectTailCount=1 -> boundary at 5, so index 5 is protected
    const { pruned, prunedCount } = preCompactionPrune(messages, 1);
    // Indices 1 and 3 should be deduped (older copies of content at index 5)
    const text1 = getTextContent(pruned[1]);
    const text3 = getTextContent(pruned[3]);
    expect(text1).toContain("Duplicate");
    expect(text3).toContain("Duplicate");
    expect(prunedCount).toBeGreaterThanOrEqual(2);
  });

  it("does not deduplicate content shorter than 200 chars", () => {
    const messages = [
      makeToolResult({ toolCallId: "tc-1", content: shortContent }),
      makeToolResult({ toolCallId: "tc-2", content: shortContent }),
    ];
    const { pruned } = preCompactionPrune(messages, 0);
    const text0 = getTextContent(pruned[0]);
    const text1 = getTextContent(pruned[1]);
    expect(text0).toBe(shortContent);
    expect(text1).toBe(shortContent);
  });

  it("deduplication uses content hash, not position", () => {
    const contentA = "a".repeat(300);
    const contentB = "b".repeat(300);
    const messages = [
      makeUserMessage("start"),
      makeToolResult({ toolCallId: "tc-1", content: contentA }),
      makeUserMessage("middle"),
      makeToolResult({ toolCallId: "tc-2", content: contentB }),
      makeToolResult({ toolCallId: "tc-3", content: contentA }), // same as index 1
    ];
    const { pruned } = preCompactionPrune(messages, 0);
    const text1 = getTextContent(pruned[1]);
    const text3 = getTextContent(pruned[3]);
    // Index 1 is older duplicate of A (index 4 is newer)
    expect(text1).toContain("Duplicate");
    // Index 3 is unique (B) -- should not be deduped
    expect(text3).not.toContain("Duplicate");
  });

  it("does not touch messages after prune boundary for dedup replacement", () => {
    const messages = [
      makeToolResult({ toolCallId: "tc-1", content: longContent }),
      makeUserMessage("mid"),
      makeToolResult({ toolCallId: "tc-2", content: longContent }),
    ];
    // protectTailCount=1 -> boundary at 2, index 2 is protected
    const { pruned } = preCompactionPrune(messages, 1);
    const textTail = getTextContent(pruned[2]);
    expect(textTail).toBe(longContent); // newest copy in tail, preserved
  });
});

describe("preCompactionPrune -- sub-pass 2: tool result summaries", () => {
  it("replaces old tool results with 1-line summaries", () => {
    const messages = [
      makeToolResult({ toolCallId: "tc-1", toolName: "Read", content: longContent }),
      makeUserMessage("continue"),
    ];
    const { pruned, prunedCount } = preCompactionPrune(messages, 1);
    const text = getTextContent(pruned[0]);
    expect(text).toContain("Read");
    expect(text.length).toBeLessThan(longContent.length);
    expect(prunedCount).toBeGreaterThanOrEqual(1);
  });

  it("preserves tool results after prune boundary", () => {
    const messages = [
      makeToolResult({ toolCallId: "tc-1", content: longContent }),
      makeUserMessage("mid"),
      makeToolResult({ toolCallId: "tc-2", content: longContent }),
    ];
    // protectTailCount=1 -> boundary at 2
    const { pruned } = preCompactionPrune(messages, 1);
    const tailText = getTextContent(pruned[2]);
    expect(tailText).toBe(longContent);
  });

  it("handles toolName='Bash' with command extraction", () => {
    const bashOutput = "Ran `npm test`\n```\nPASS 42 tests\n```\n" + "x".repeat(300);
    const messages = [
      makeToolResult({ toolCallId: "tc-1", toolName: "Bash", content: bashOutput }),
      makeUserMessage("done"),
    ];
    const { pruned } = preCompactionPrune(messages, 1);
    const text = getTextContent(pruned[0]);
    expect(text).toContain("Bash");
    expect(text.length).toBeLessThan(bashOutput.length);
  });

  it("handles toolName='Write' with write summary", () => {
    const writeOutput = "Wrote file /src/big.ts\n" + "x".repeat(500);
    const messages = [
      makeToolResult({ toolCallId: "tc-1", toolName: "Write", content: writeOutput }),
      makeUserMessage("next"),
    ];
    const { pruned } = preCompactionPrune(messages, 1);
    const text = getTextContent(pruned[0]);
    expect(text).toContain("Write");
    expect(text.length).toBeLessThan(writeOutput.length);
  });

  it("does not summarize tool results with content < 200 chars", () => {
    const messages = [
      makeToolResult({ toolCallId: "tc-1", content: shortContent }),
      makeUserMessage("next"),
    ];
    const { pruned } = preCompactionPrune(messages, 1);
    const text = getTextContent(pruned[0]);
    expect(text).toBe(shortContent);
  });

  it("preserves non-tool-result messages unchanged", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantText("world"),
      makeToolResult({ toolCallId: "tc-1", content: longContent }),
    ];
    const { pruned } = preCompactionPrune(messages, 0);
    expect(getTextContent(pruned[0])).toBe("hello");
    expect(getTextContent(pruned[1])).toBe("world");
  });

  it("reports accurate prunedCount", () => {
    const messages = [
      makeToolResult({ toolCallId: "tc-1", content: longContent }),
      makeToolResult({ toolCallId: "tc-2", content: longContent }),
      makeToolResult({ toolCallId: "tc-3", content: "short" }),
      makeUserMessage("next"),
    ];
    const { prunedCount } = preCompactionPrune(messages, 1);
    // Index 0 and 1 are long tool results (deduped + summarized)
    expect(prunedCount).toBeGreaterThanOrEqual(2);
  });

  it("handles empty message array", () => {
    const { pruned, prunedCount } = preCompactionPrune([], 0);
    expect(pruned).toEqual([]);
    expect(prunedCount).toBe(0);
  });

  it("handles pruneBoundaryIndex of 0 (all protected)", () => {
    const messages = [
      makeToolResult({ content: longContent }),
      makeToolResult({ content: longContent }),
    ];
    // protectTailCount >= messages.length -> nothing prunable
    const { pruned, prunedCount } = preCompactionPrune(messages, messages.length);
    expect(prunedCount).toBe(0);
    expect(getTextContent(pruned[0])).toBe(longContent);
  });

  it("handles pruneBoundaryIndex beyond array length", () => {
    const messages = [makeToolResult({ content: longContent })];
    // protectTailCount=0 -> all eligible
    const { pruned } = preCompactionPrune(messages, 0);
    const text = getTextContent(pruned[0]);
    expect(text.length).toBeLessThan(longContent.length);
  });
});

describe("preCompactionPrune -- sub-pass 3: tool call arg truncation", () => {
  it("truncates string values > 200 chars in tool call arguments", () => {
    const bigContent = "x".repeat(500);
    const messages = [
      makeAssistantWithToolCalls([
        {
          id: "tc-1",
          name: "Write",
          arguments: { filePath: "/src/big.ts", content: bigContent },
        },
      ]),
      makeUserMessage("done"),
    ];
    const { pruned } = preCompactionPrune(messages, 1);
    const content = (pruned[0] as Record<string, unknown>).content as Array<
      Record<string, unknown>
    >;
    const tc = content[0];
    const args = tc.arguments as Record<string, unknown>;
    // filePath is short -> preserved
    expect(args.filePath).toBe("/src/big.ts");
    // content is long -> truncated
    expect(typeof args.content).toBe("string");
    expect((args.content as string).length).toBeLessThan(bigContent.length);
    expect(args.content as string).toContain("...[truncated]");
  });

  it("does not truncate arguments when serialized size < 500 chars", () => {
    const messages = [
      makeAssistantWithToolCalls([
        { id: "tc-1", name: "Read", arguments: { path: "/short.ts", line: 5 } },
      ]),
      makeUserMessage("done"),
    ];
    const { pruned } = preCompactionPrune(messages, 1);
    const content = (pruned[0] as Record<string, unknown>).content as Array<
      Record<string, unknown>
    >;
    const args = content[0].arguments as Record<string, unknown>;
    expect(args.path).toBe("/short.ts");
    expect(args.line).toBe(5);
  });

  it("preserves non-string values in arguments", () => {
    const messages = [
      makeAssistantWithToolCalls([
        {
          id: "tc-1",
          name: "Test",
          arguments: {
            count: 42,
            enabled: true,
            tags: ["a", "b"],
            content: "x".repeat(500),
          },
        },
      ]),
      makeUserMessage("done"),
    ];
    const { pruned } = preCompactionPrune(messages, 1);
    const content = (pruned[0] as Record<string, unknown>).content as Array<
      Record<string, unknown>
    >;
    const args = content[0].arguments as Record<string, unknown>;
    expect(args.count).toBe(42);
    expect(args.enabled).toBe(true);
    expect(args.tags).toEqual(["a", "b"]);
    expect(args.content as string).toContain("...[truncated]");
  });

  it("does not mutate the original message array", () => {
    const originalArgs = { content: "x".repeat(500) };
    const originalArgsCopy = { ...originalArgs };
    const messages = [
      makeAssistantWithToolCalls([{ id: "tc-1", name: "Write", arguments: originalArgs }]),
      makeUserMessage("done"),
    ];
    preCompactionPrune(messages, 1);
    // Original should be unchanged
    expect(originalArgs.content).toBe(originalArgsCopy.content);
  });

  it("handles assistant message with no tool calls", () => {
    const messages = [makeAssistantText("just text, no tool calls"), makeUserMessage("done")];
    const { pruned } = preCompactionPrune(messages, 1);
    expect(getTextContent(pruned[0])).toBe("just text, no tool calls");
  });

  it("handles mixed content blocks (text + toolCall)", () => {
    const messages = [
      {
        role: "assistant",
        model: "test-model",
        provider: "test",
        content: [
          { type: "text", text: "Let me write this file" },
          {
            type: "toolCall",
            id: "tc-1",
            name: "Write",
            arguments: { content: "x".repeat(600) },
          },
        ],
      } as unknown as AgentMessage,
      makeUserMessage("done"),
    ];
    const { pruned } = preCompactionPrune(messages, 1);
    const content = (pruned[0] as Record<string, unknown>).content as Array<
      Record<string, unknown>
    >;
    // Text block preserved
    expect(content[0].text).toBe("Let me write this file");
    // ToolCall args truncated
    const args = content[1].arguments as Record<string, unknown>;
    expect(args.content as string).toContain("...[truncated]");
  });
});
