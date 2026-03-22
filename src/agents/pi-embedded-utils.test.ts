import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, it, expect } from "vitest";
import {
  promoteMinimaxToolCallsToBlocks,
  formatReasoningMessage,
  stripDowngradedToolCallText,
  promoteThinkingTagsToBlocks,
} from "./pi-embedded-utils.js";

function makeAssistantMessage(msg: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    timestamp: Date.now(),
    ...msg,
  } as AssistantMessage;
}

describe("promoteMinimaxToolCallsToBlocks", () => {
  it("converts MiniMax XML tool calls into toolCall blocks", () => {
    const text = `<minimax:tool_call>
  <invoke name="Bash">
    <parameter name="command">ls -la</parameter>
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
      arguments: { command: "ls -la" },
    });
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

  it("handles malformed XML with only closing wrapper tag", () => {
    const text = `<invoke name="Bash"><parameter name="command">ls</parameter></invoke></minimax:tool_call>`;
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
      arguments: { command: "ls" },
    });
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
    <parameter name="json">{"key": "value", "num": 42}</parameter>
    <parameter name="list">[1, 2, 3]</parameter>
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
      arguments: {
        json: { key: "value", num: 42 },
        list: [1, 2, 3],
      },
    });
  });

  it("unescapes XML entities correctly", () => {
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

  it("handles invalid numeric XML entities gracefully without throwing", () => {
    const text = `<minimax:tool_call><invoke name="Test"><parameter name="p1">&#x110000;</parameter><parameter name="p2">&#99999999;</parameter></invoke></minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const toolCall = msg.content.find((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(toolCall).toMatchObject({
      arguments: {
        p1: "&#x110000;",
        p2: "&#99999999;",
      },
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
        n1: "123", // Reverted to string for stability per Codex P1
      },
    });
  });

  it("does not reclaim invokes that are far from the stray closing tag", () => {
    const text = `<invoke name="Evil">...</invoke> some explanation text </minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const hasToolCall = msg.content.some(
      (c) => c && typeof c === "object" && c.type === "toolCall",
    );
    expect(hasToolCall).toBe(false);
  });

  it("promotes all sibling invokes before a stray closing tag", () => {
    const text = `Prefix <invoke name="T1"><parameter name="p">1</parameter></invoke><invoke name="T2"><parameter name="p">2</parameter></invoke></minimax:tool_call> Suffix`;
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

    const texts = msg.content.filter((c) => c && typeof c === "object" && c.type === "text");
    expect(texts[0]).toMatchObject({ type: "text", text: "Prefix " });
    expect(texts[1]).toMatchObject({ type: "text", text: " Suffix" });
  });

  it("supports self-closing MiniMax <invoke /> tool calls", () => {
    const text = `<minimax:tool_call><invoke name="agents_list" /></minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const toolCall = msg.content.find((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "agents_list",
    });
  });

  it("handles unclosed thinking tags in string-form content (stream scenario)", () => {
    const text = `<think>Internal thinking... <minimax:tool_call><invoke name="Bash"><parameter name="command">ls</parameter></invoke></minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: text as unknown as AssistantMessage["content"],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    // With the new strict closing policy, unclosed think tags remain part of text.
    const toolCall = msg.content.find((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(toolCall).toMatchObject({ type: "toolCall", name: "exec" });

    const prose = msg.content.filter((c) => c && typeof c === "object" && c.type === "text");
    expect(prose.length).toBe(1);
    expect(
      prose[0] && typeof prose[0] === "object" && "text" in prose[0] ? prose[0].text : "",
    ).toContain("<think>Internal thinking...");
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

    const calls = msg.content.filter((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ type: "toolCall", name: "valid" });

    const textBlocks = msg.content.filter((c) => c && typeof c === "object" && c.type === "text");
    const fullText = textBlocks.map((b) => (b as { text: string }).text).join("");
    expect(fullText).not.toContain("<invoke>");
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

  it("handles string-form content", () => {
    const text = `<minimax:tool_call><invoke name="Bash"><parameter name="command">ls</parameter></invoke></minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: text as unknown as AssistantMessage["content"],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    expect(Array.isArray(msg.content)).toBe(true);
    const toolCall = (msg.content as unknown as Array<{ type: string } | string>).find(
      (c) => c && typeof c === "object" && c.type === "toolCall",
    );
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "exec",
    });
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

    promoteThinkingTagsToBlocks(msg);
    promoteMinimaxToolCallsToBlocks(msg);

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
