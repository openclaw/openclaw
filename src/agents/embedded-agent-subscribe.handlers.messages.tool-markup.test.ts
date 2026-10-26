import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AssistantMessage } from "../llm/types.js";
import * as codeRegions from "../shared/text/code-regions.js";
import { consumePendingAssistantReplyDirectivesIntoReply } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import { extractAssistantStreamSnapshot } from "./embedded-agent-subscribe.handlers.messages.snapshot.js";
import {
  createMessageEndContext,
  createMessageUpdateContext,
  endMessage,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { extractAssistantVisibleText } from "./embedded-agent-utils.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const markup = [
  "<tool_call>exec<arg_key>command</arg_key><arg_value>echo hidden</arg_value></tool_call>",
  '<invoke name="exec"><parameter name="command">echo hidden</parameter></invoke>',
  '<function_calls><invoke name="exec"><parameter name="command">echo hidden</parameter></invoke></function_calls>',
  '<antml:invoke name="exec"><antml:parameter name="command">echo hidden</antml:parameter></antml:invoke>',
  '<mm:function_calls><mm:invoke name="exec"><mm:parameter name="command">echo hidden</mm:parameter></mm:invoke></mm:function_calls>',
  "<tool_call>exec<arg_key>command</arg_key><arg_value>[[reply_to:hidden]]\nMEDIA:/tmp/hidden.png</arg_value></tool_call>",
] as const;
const textPart = (text: string) => ({ type: "text" as const, text });

describe.each(["ollama", "anthropic-messages", "openai-completions", "openai-responses"] as const)(
  "%s tool markup delivery",
  (api) => {
    let ctx: ReturnType<typeof createMessageUpdateContext>;
    let events = vi.fn();
    beforeEach(() => {
      events = vi.fn();
      ctx = createMessageUpdateContext({ onAgentEvent: events });
      ctx.params.onBlockReply = vi.fn();
    });
    function message(content: string | AssistantMessage["content"]) {
      return makeAgentAssistantMessage({
        api,
        ...(api === "openai-responses" ? { phase: "final_answer" as const } : {}),
        content: typeof content === "string" ? [textPart(content)] : content,
      });
    }
    function expectVisible(partial: AssistantMessage, text: string) {
      expect(extractAssistantStreamSnapshot(ctx, partial)).toMatchObject({ text, blockText: text });
      expect(extractAssistantVisibleText(partial)).toBe(text);
    }

    function update(text: string, type: "text_delta" | "text_end", delta = text) {
      const partial = message(text);
      const chunk = type === "text_delta" ? { delta } : { content: text };
      return updateMessage(ctx, {
        message: partial,
        assistantMessageEvent: { type, ...chunk, partial, contentIndex: 0 },
      });
    }

    it("bounds unused block-delivery work after unfenced XML", async () => {
      ctx.params.onBlockReply = undefined;
      const source =
        `Visible\n${markup[2]}\n` +
        Array.from(
          { length: 100 },
          (_, index) => `Paragraph ${index}: the reply continues.\n`,
        ).join("");
      const regions = vi.spyOn(codeRegions, "findCodeRegions");
      onTestFinished(() => regions.mockRestore());
      let text = "";
      for (let offset = 0; offset < source.length; offset += 4) {
        const delta = source.slice(offset, offset + 4);
        text += delta;
        await update(text, "text_delta", delta);
      }
      expect(ctx.state.assistantStream?.text).toBe(source.replace(markup[2], "").trimEnd());
      expect(regions.mock.calls.reduce((total, [parsed]) => total + parsed.length, 0)).toBeLessThan(
        source.length * 8,
      );
    });

    it("bounds Markdown parse work after quoted tool XML in token-sized deltas", async () => {
      const example = `\`\`\`xml\n${markup[2]}\n\`\`\`\n\n`;
      const continuation = "Explanation.\n\n- Item\n\n```python\nprint('hello')\n```\n\n".repeat(
        128,
      );
      const source = example + continuation;
      const regions = vi.spyOn(codeRegions, "findCodeRegions");
      onTestFinished(() => {
        regions.mockRestore();
      });
      let text = "";
      for (let offset = 0; offset < source.length; offset += 4) {
        const delta = source.slice(offset, offset + 4);
        text += delta;
        await update(text, "text_delta", delta);
      }
      expect(ctx.state.assistantStream?.text).toBe(source.trimEnd());
      expect(regions.mock.calls.reduce((total, [parsed]) => total + parsed.length, 0)).toBeLessThan(
        source.length * 8,
      );
    });

    const open = "Visible\n<tool_call>exec<arg_key>command</arg_key><arg_value>";
    const close = "hidden</arg_value></tool_call>\nDone.";
    const nativeOpen = '<tool_call>{"name":"exec","arguments":{}}';
    const tool = { type: "toolCall", id: "call-1", name: "exec", arguments: {} } as const;
    const thinking = { type: "thinking", thinking: "Private reasoning." } as const;
    it.each([
      [open, textPart(" \n"), close, "Visible\n\nDone."],
      [nativeOpen, tool, "Done.", "Done."],
      [nativeOpen, thinking, "Done.", "Done."],
    ] as const)(
      "preserves XML context across native blocks %#",
      (before, boundary, after, visible) => {
        expectVisible(message([textPart(before), boundary, textPart(after)]), visible);
      },
    );

    it.each([
      ...markup.map((source) => ({ source, literal: false })),
      ...["Use <tool_call>exec", "Use <invoke", "Use <tool_"].map((source) => ({
        source,
        literal: true,
      })),
    ])("withholds ambiguous markup then finalizes $source", async ({ source, literal }) => {
      const visible = literal ? source : "Visible\n\nDone.";
      let text = "";
      for (const delta of literal ? [source] : ["Visible\n", ...source.split(""), "\nDone."]) {
        text += delta;
        await update(text, "text_delta", delta);
        expect(ctx.state.assistantStream?.text).toBe(
          literal ? "Use" : text.endsWith("Done.") ? visible : "Visible",
        );
      }
      const partial = message(text);
      await update(text, "text_end");
      expect(ctx.state.assistantStream?.text).toBe(visible);
      expectVisible(partial, visible);
      if (api === "openai-responses") {
        expect(ctx.blockChunker.bufferedText).toBe(visible);
      }
      if (!literal) {
        expect(
          consumePendingAssistantReplyDirectivesIntoReply(ctx.state, { text: visible }),
        ).toEqual({ text: visible });
        expect(events.mock.calls.map(([event]) => event.data.text)).toEqual(["Visible", visible]);
      }
    });
  },
);

describe("native tool-call marker boundaries", () => {
  const read = {
    type: "toolCall" as const,
    id: "read-fixture",
    name: "read",
    arguments: { path: "fixture.txt" },
  };

  it("keeps a hidden marker out of later prose in an unfinished snapshot", () => {
    const ctx = createMessageEndContext();
    const message = makeAgentAssistantMessage({
      api: "openai-completions",
      content: [textPart("<"), read, textPart("Done")],
    });
    const original = structuredClone(message);
    expect(extractAssistantStreamSnapshot(ctx, message, { final: false })).toMatchObject({
      rawText: "<Done",
      text: "Done",
      blockText: "Done",
    });
    expect(message).toEqual(original);
  });

  it("does not borrow a commentary fence to preserve a later unphased marker", () => {
    const ctx = createMessageUpdateContext();
    const commentary = {
      ...textPart("```"),
      textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
    };
    const message = makeAgentAssistantMessage({
      api: "openai-completions",
      content: [commentary, { ...read, id: "read-first" }, textPart("<tool_"), read],
    });
    const original = structuredClone(message);
    expect(extractAssistantStreamSnapshot(ctx, message)).toMatchObject({ text: "", blockText: "" });
    expect(message).toEqual(original);
  });

  it.each(["<", "<tool_"])(
    "keeps %j hidden through text_end and message_end before a native call",
    async (fragment) => {
      const onAgentEvent = vi.fn();
      const onBlockReply = vi.fn();
      const ctx = createMessageEndContext({ onAgentEvent, onBlockReply });
      const partial = makeAgentAssistantMessage({
        api: "openai-completions",
        content: [textPart(fragment)],
      });
      await updateMessage(ctx, {
        message: partial,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: fragment,
          partial,
        },
      });
      expect(onAgentEvent).not.toHaveBeenCalled();

      const message = {
        ...partial,
        content: [textPart(fragment), read],
        stopReason: "toolUse" as const,
      };
      const source = structuredClone(message);
      await updateMessage(ctx, {
        message,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: fragment,
          partial: message,
        },
      });
      expect.soft(ctx.state.assistantStream?.text).toBe("");
      expect.soft(extractAssistantStreamSnapshot(ctx, message)).toMatchObject({
        text: "",
        blockText: "",
      });
      await endMessage(ctx, { message });
      expect(onAgentEvent.mock.calls.map(([event]) => event.data.text).filter(Boolean)).toEqual([]);
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(message).toEqual(source);
    },
  );

  it.each([
    { content: [textPart("<")], expected: "<" },
    { content: [textPart("<tool_")], expected: "<tool_" },
    { content: [textPart("a < b"), read], expected: "a < b" },
    { content: [textPart("Use `<tool_` literally."), read], expected: "Use `<tool_` literally." },
    {
      content: [textPart("```xml\n"), textPart("<tool_"), textPart("\n```"), read],
      expected: "```xml\n<tool_\n```",
      blockText: "```xml\n\n<tool_\n\n```",
    },
    {
      content: [
        { ...textPart("Working"), textSignature: JSON.stringify({ v: 1, phase: "commentary" }) },
        { ...textPart("a < b"), textSignature: JSON.stringify({ v: 1, phase: "final_answer" }) },
        read,
      ],
      expected: "a < b",
    },
    { content: [textPart("<"), textPart("tool_"), read], expected: "" },
    {
      content: [textPart("Use "), textPart("<tool_"), read],
      expected: "Use\n<tool_",
      blockText: "Use \n<tool_",
    },
    { content: [textPart("    <tool_"), read], expected: "    <tool_" },
  ])("projects native-boundary control %#", ({ content, expected, blockText }) => {
    const ctx = createMessageUpdateContext();
    const message = makeAgentAssistantMessage({ api: "openai-completions", content });
    expect(extractAssistantVisibleText(message)).toBe(expected);
    expect(extractAssistantStreamSnapshot(ctx, message)).toMatchObject({
      text: expected,
      blockText: blockText ?? expected,
    });
  });
});
