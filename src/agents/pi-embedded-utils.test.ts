import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  extractAssistantText,
  formatReasoningMessage,
  promoteMinimaxToolCallsToBlocks,
  promoteThinkingTagsToBlocks,
  stripDowngradedToolCallText,
} from "./pi-embedded-utils.js";

function makeAssistantMessage(
  message: Omit<AssistantMessage, "api" | "provider" | "model" | "usage" | "stopReason"> &
    Partial<Pick<AssistantMessage, "api" | "provider" | "model" | "usage" | "stopReason">>,
): AssistantMessage {
  return {
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4o",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    stopReason: "stop",
    ...message,
  } as AssistantMessage;
}

describe("extractAssistantText", () => {
  it("extracts plain text", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
      timestamp: Date.now(),
    });
    expect(extractAssistantText(msg)).toBe("Hello world");
  });

  it("handles empty content", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [],
      timestamp: Date.now(),
    });
    expect(extractAssistantText(msg)).toBe("");
  });

  it("handles missing content", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: undefined as unknown as AssistantMessage["content"],
      timestamp: Date.now(),
    });
    expect(extractAssistantText(msg)).toBe("");
  });

  it("handles multiple text blocks", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        { type: "text", text: "First block." },
        { type: "text", text: "Third block." },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("First block.\nThird block.");
  });

  it("strips thinking tags from text", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text: "Hello <think>secret</think> world" }],
      timestamp: Date.now(),
    });
    // extractAssistantText joins text blocks with \n if they were split
    expect(extractAssistantText(msg).replace(/\s+/g, " ")).toBe("Hello world");
  });

  it("strips MiniMax tool call XML from text", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'Hello <invoke name="tool">payload</invoke></minimax:tool_call> world',
        },
      ],
      timestamp: Date.now(),
    });
    expect(extractAssistantText(msg).replace(/\s+/g, " ")).toBe("Hello world");
  });

  it("strips tool-only Minimax invocation XML from text", () => {
    const cases = [
      {
        name: "full wrapper",
        text: `<minimax:tool_call>
<invoke name="Bash">
<parameter name="command">netstat -tlnp | grep 18789</parameter>
</invoke>
</minimax:tool_call>`,
        expected: "",
      },
      {
        name: "stray closing tag",
        text: "Some text</minimax:tool_call>",
        expected: "Some text",
      },
      {
        name: "mixed text and tags",
        text: 'Before<invoke name="T">P</invoke></minimax:tool_call>After',
        expected: "BeforeAfter",
      },
    ];
    for (const testCase of cases) {
      const msg = makeAssistantMessage({
        role: "assistant",
        content: [{ type: "text", text: testCase.text }],
        timestamp: Date.now(),
      });
      expect(extractAssistantText(msg).trim(), testCase.name).toBe(testCase.expected);
    }
  });

  it("strips invoke blocks when minimax markers are present elsewhere", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Before<invoke>Drop</invoke><minimax:tool_call>After",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("BeforeAfter");
  });

  it("handles multiple text blocks with tool calls and results", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Here's what I found:" },
        {
          type: "toolCall",
          id: "call_1",
          name: "test",
          arguments: { arg: "val" },
        } as unknown as AssistantMessage["content"][number],
        {
          type: "toolResult",
          toolCallId: "call_1",
          result: "success",
        } as unknown as AssistantMessage["content"][number],
        { type: "text", text: "Done checking." },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Here's what I found:\nDone checking.");
  });
});

describe("promoteMinimaxToolCallsToBlocks", () => {
  it("converts MiniMax XML tool calls into toolCall blocks", () => {
    const text = `Let me check that.
<minimax:tool_call>
  <invoke name="Bash">
    <parameter name="command">ls -la</parameter>
  </invoke>
</minimax:tool_call>
All done.`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const toolCall = msg.content.find((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "exec", // Normalized from Bash
      arguments: { command: "ls -la" },
    });

    const finalResult = extractAssistantText(msg).replace(/\s+/g, " ");
    expect(finalResult).toContain("Let me check that.");
    expect(finalResult).toContain("All done.");
  });

  it("handles multiple tool calls in one text block", () => {
    const text = `<minimax:tool_call><invoke name="T1"><parameter name="p">1</parameter></invoke></minimax:tool_call><minimax:tool_call><invoke name="T2"><parameter name="p">2</parameter></invoke></minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const calls = msg.content.filter((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatchObject({ type: "toolCall", name: "t1", arguments: { p: "1" } });
    expect(calls[1]).toMatchObject({ type: "toolCall", name: "t2", arguments: { p: "2" } });
  });

  it("handles multiple invoke blocks within a single MiniMax wrapper", () => {
    const text = `<minimax:tool_call>
  <invoke name="T1"><parameter name="p">1</parameter></invoke>
  <invoke name="T2"><parameter name="p">2</parameter></invoke>
</minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const calls = msg.content.filter((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatchObject({ type: "toolCall", name: "t1", arguments: { p: "1" } });
    expect(calls[1]).toMatchObject({ type: "toolCall", name: "t2", arguments: { p: "2" } });
  });

  it("parses JSON-like arguments correctly", () => {
    const text = `<minimax:tool_call>
  <invoke name="Config">
    <parameter name="settings">{"enabled": true, "count": 5}</parameter>
  </invoke>
</minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const toolCall = msg.content.find((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "config",
      arguments: { settings: { enabled: true, count: 5 } },
    });
  });

  it("unescapes XML entities in arguments", () => {
    const text = `<minimax:tool_call>
  <invoke name="Bash">
    <parameter name="command">ls &amp;&amp; echo &quot;done&quot; &gt; out.txt</parameter>
  </invoke>
</minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const toolCall = msg.content.find((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "exec",
      arguments: { command: 'ls && echo "done" > out.txt' },
    });
  });

  it("unescapes numeric XML entities", () => {
    const text = `<minimax:tool_call>
  <invoke name="Bash">
    <parameter name="command">echo &#39;hello&#39; &#60; world</parameter>
  </invoke>
</minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const toolCall = msg.content.find((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "exec",
      arguments: { command: "echo 'hello' < world" },
    });
  });

  it("parses scalar values correctly (bool)", () => {
    const text = `<minimax:tool_call>
  <invoke name="Test">
    <parameter name="b1">true</parameter>
    <parameter name="b2">false</parameter>
    <parameter name="n1">123</parameter>
  </invoke>
</minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const toolCall = msg.content.find((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "test",
      arguments: {
        b1: true,
        b2: false,
        n1: "123", // Numbers should remain strings
      },
    });
  });

  it("preserves leading/trailing whitespace in arguments", () => {
    const text = `<minimax:tool_call>
  <invoke name="Message">
    <parameter name="text">
  line 1
  line 2
</parameter>
  </invoke>
</minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const toolCall = msg.content.find((c) => c && typeof c === "object" && c.type === "toolCall");
    // The exact content inside <parameter> tags should be preserved (unescaped but not trimmed)
    const args = (toolCall as { arguments?: { text?: string } })?.arguments;
    expect(args?.text).toBe("\n  line 1\n  line 2\n");
  });

  it("strips malformed sibling invoke blocks inside wrapper", () => {
    const text = `<minimax:tool_call>
  <invoke name="Valid"><parameter name="p">1</parameter></invoke>
  <invoke>Malformed (no name)</invoke>
</minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    // The valid one should be promoted, the malformed one should be stripped entirely
    const calls = msg.content.filter((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ type: "toolCall", name: "valid" });

    const textBlocks = msg.content.filter((c) => c && typeof c === "object" && c.type === "text");
    const fullText = textBlocks.map((b) => (b as { text: string }).text).join("");
    expect(fullText).not.toContain("<invoke>");
    expect(fullText).not.toContain("Malformed");
  });

  it("preserves prose inside the MiniMax wrapper", () => {
    const text = `<minimax:tool_call>Checking system...<invoke name="Bash"><parameter name="cmd">ls</parameter></invoke>Done.</minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const call = msg.content.find((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(call).toBeDefined();
    const prose = msg.content
      .filter((c: unknown) => (c as { type: string }).type === "text")
      .map((c: unknown) => (c as { text: string }).text)
      .join("");
    expect(prose).toContain("Checking system...");
    expect(prose).toContain("Done.");
  });

  it("ignores non-MiniMax XML blocks", () => {
    const text = `<other:tag>data</other:tag>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    expect(msg.content.length).toBe(1);
    expect(msg.content[0]).toEqual({ type: "text", text: text });
  });

  it("normalizes tool names", () => {
    const text = `<minimax:tool_call><invoke name="Bash"><parameter name="command">ls</parameter></invoke></minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const toolCall = msg.content.find((c) => c && typeof c === "object" && c.type === "toolCall");
    // "Bash" should be normalized to "exec"
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "exec",
    });
  });

  it("handles tool calls inside thinking blocks", () => {
    const text = `<think>Internal thoughts... <minimax:tool_call><invoke name="Bash"><parameter name="command">ls</parameter></invoke></minimax:tool_call> End of thoughts.</think>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    // Step 1: Promote thinking tags first
    promoteThinkingTagsToBlocks(msg);
    expect(msg.content[0].type).toBe("thinking");

    // Step 2: Promote MiniMax tool calls from within thinking block
    promoteMinimaxToolCallsToBlocks(msg);

    // Should result in [thinking, toolCall, thinking]
    expect(msg.content.length).toBe(3);
    expect(msg.content[0]).toMatchObject({ type: "thinking", thinking: "Internal thoughts... " });
    expect(msg.content[1]).toMatchObject({ type: "toolCall", name: "exec" });
    expect(msg.content[2]).toMatchObject({ type: "thinking", thinking: " End of thoughts." });
  });
});

describe("formatReasoningMessage", () => {
  it("returns empty string for whitespace-only input", () => {
    expect(formatReasoningMessage("   \n  \t  ")).toBe("");
  });

  it("formats multi-line reasoning with italics and Reasoning prefix", () => {
    const text = "First line\n\nSecond line";
    const expected = "Reasoning:\n_First line_\n\n_Second line_";
    expect(formatReasoningMessage(text)).toBe(expected);
  });
});

describe("empty input handling", () => {
  it("returns empty string", () => {
    const helpers = [formatReasoningMessage, stripDowngradedToolCallText];
    for (const helper of helpers) {
      expect(helper("")).toBe("");
    }
  });
});
