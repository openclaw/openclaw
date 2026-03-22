import type { AssistantMessage, ToolCall } from "@mariozechner/pi-ai";
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

  it("deduplicates tool-call IDs across content blocks", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: `<minimax:tool_call><invoke name="T1" /></minimax:tool_call>`,
        },
        { type: "text", text: `<minimax:tool_call><invoke name="T2" /></minimax:tool_call>` },
      ],
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const calls = msg.content.filter((c): c is ToolCall =>
      Boolean(c && typeof c === "object" && c.type === "toolCall"),
    );
    expect(calls.length).toBe(2);
    expect(calls[0].id).not.toBe(calls[1].id);
    expect(calls[0].id).toBe("mc_mm_0_t1");
    expect(calls[1].id).toBe("mc_mm_1_t2");
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

  it("unescapes XML entities correctly without double-decoding", () => {
    const text = `<minimax:tool_call>
  <invoke name="Bash">
    <parameter name="command">ls &amp;&amp; echo &quot;done&quot; &gt; out.txt</parameter>
    <parameter name="code">Sample &amp;lt;div&amp;gt; &amp;#39; code</parameter>
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
      arguments: {
        command: 'ls && echo "done" > out.txt',
        code: "Sample &lt;div&gt; &#39; code",
      },
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

  it("skips code-fenced thinking tags but allows them inside real thinking", () => {
    const text =
      "Example: \n```xml\n<think>This should not be promoted</think>\n```\nActual: <think>Real thinking with ```code``` inside</think>";
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
    });

    promoteThinkingTagsToBlocks(msg);

    // Should result in: [text (up to <think>), thinking (Real thinking...), text (empty/remaining)]
    expect(msg.content.length).toBe(2);
    expect(msg.content[0]).toMatchObject({ type: "text" });
    const block0 = msg.content[0] as { type: "text"; text: string };
    expect(block0.text).toContain("<think>This should not be promoted</think>");
    expect(msg.content[1]).toMatchObject({
      type: "thinking",
      thinking: "Real thinking with ```code``` inside",
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
    const block0 = prose[0] as { type: "text"; text: string };
    expect(block0.text).toContain("<think>Internal thinking...");
  });

  it("handles inline <think> blocks preceded by ordinary prose", () => {
    const text = `Okay. <think>Internal thoughts...</think> <minimax:tool_call><invoke name="Bash"><parameter name="command">ls</parameter></invoke></minimax:tool_call>`;
    const msg = makeAssistantMessage({
      role: "assistant",
      content: text as unknown as AssistantMessage["content"],
      timestamp: Date.now(),
    });

    promoteMinimaxToolCallsToBlocks(msg);

    expect(msg.content.length).toBe(4);
    expect(msg.content[0]).toMatchObject({ type: "text", text: "Okay. " });
    expect(msg.content[1]).toMatchObject({ type: "thinking", thinking: "Internal thoughts..." });
    expect(msg.content[2]).toMatchObject({ type: "text", text: " " });
    expect(msg.content[3]).toMatchObject({ type: "toolCall", name: "exec" });
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
    const args = (toolCall as unknown as ToolCall)?.arguments;
    const textValue = args && typeof args === "object" && "text" in args ? args.text : "";
    expect(textValue).toBe("\n  line 1\n  line 2\n");
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

  it("generates deterministic tool-call IDs across blocks", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: `<minimax:tool_call><invoke name="Bash" /></minimax:tool_call>`,
        },
        { type: "text", text: `<minimax:tool_call><invoke name="Bash" /></minimax:tool_call>` },
      ],
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const calls = msg.content.filter((c): c is ToolCall =>
      Boolean(c && typeof c === "object" && c.type === "toolCall"),
    );
    expect(calls[0].id).toBe("mc_mm_0_exec");
    expect(calls[1].id).toBe("mc_mm_1_exec");
  });

  it("skips MiniMax wrappers inside Markdown code blocks", () => {
    const text =
      'Example code: ` <minimax:tool_call><invoke name="Test" /></minimax:tool_call> ` and then real one: <minimax:tool_call><invoke name="Bash" /></minimax:tool_call>';
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
    });

    promoteMinimaxToolCallsToBlocks(msg);

    const calls = msg.content.filter((c) => c && typeof c === "object" && c.type === "toolCall");
    expect(calls.length).toBe(1);
    const call0 =
      calls[0] && typeof calls[0] === "object" && "name" in calls[0] ? calls[0].name : "";
    expect(call0).toBe("exec");
  });

  it("skips thinking tags inside inline code", () => {
    const text = "Mentioning `<think>Internal</think>` in code.";
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text }],
    });

    promoteThinkingTagsToBlocks(msg);

    expect(msg.content.length).toBe(1);
    const type0 = msg.content[0] && typeof msg.content[0] === "object" ? msg.content[0].type : "";
    expect(type0).toBe("text");
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
