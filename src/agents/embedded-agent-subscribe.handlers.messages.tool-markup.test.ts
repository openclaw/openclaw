import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../llm/types.js";
import { consumePendingAssistantReplyDirectivesIntoReply } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import { extractAssistantStreamSnapshot } from "./embedded-agent-subscribe.handlers.messages.snapshot.js";
import {
  createMessageUpdateContext,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { extractAssistantVisibleText } from "./embedded-agent-utils.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

const markup = [
  "<tool_call>exec<arg_key>command</arg_key><arg_value>echo hidden</arg_value></tool_call>",
  '<invoke name="exec"><parameter name="command">echo hidden</parameter></invoke>',
  '<function_calls><invoke name="exec"><parameter name="command">echo hidden</parameter></invoke></function_calls>',
  '<antml:invoke name="exec"><antml:parameter name="command">echo hidden</antml:parameter></antml:invoke>',
  '<mm:function_calls><mm:invoke name="exec"><mm:parameter name="command">echo hidden</mm:parameter></mm:invoke></mm:function_calls>',
  "<tool_call>exec<arg_key>command</arg_key><arg_value>[[reply_to:hidden]]\nMEDIA:/tmp/hidden.png</arg_value></tool_call>",
];

describe.each(["ollama", "openai-completions", "openai-responses"] as const)(
  "%s tool markup delivery",
  (api) => {
    function message(text: string) {
      return {
        role: "assistant" as const,
        api,
        provider: "fixture",
        model: "fixture",
        usage: createZeroUsageFixture(),
        timestamp: 0,
        stopReason: "stop" as const,
        ...(api === "openai-responses" ? { phase: "final_answer" as const } : {}),
        content: [{ type: "text" as const, text }],
      };
    }

    it("keeps markup context across adjacent text and whitespace blocks", () => {
      const partial = message("");
      partial.content = [
        { type: "text", text: "Visible\n<tool_call>exec<arg_key>command</arg_key><arg_value>" },
        { type: "text", text: " \n" },
        { type: "text", text: "hidden</arg_value></tool_call>\nDone." },
      ];
      const snapshot = extractAssistantStreamSnapshot(createMessageUpdateContext(), partial);
      expect(snapshot.text).toBe("Visible\n\nDone.");
      expect(snapshot.blockText).toBe("Visible\n\nDone.");
      expect(extractAssistantVisibleText(partial)).toBe("Visible\n\nDone.");
    });

    it.each([
      { type: "toolCall", id: "call-1", name: "exec", arguments: {} },
      { type: "thinking", thinking: "Private reasoning." },
    ] as const)("ends XML context at a native $type block", (boundary) => {
      const partial: AssistantMessage = {
        ...message(""),
        content: [
          { type: "text", text: '<tool_call>{"name":"exec","arguments":{}}' },
          boundary,
          { type: "text", text: "Done." },
        ],
      };
      const snapshot = extractAssistantStreamSnapshot(createMessageUpdateContext(), partial);
      expect(snapshot.text).toBe("Done.");
      expect(snapshot.blockText).toBe("Done.");
      expect(extractAssistantVisibleText(partial)).toBe("Done.");
    });

    it.each(markup)(
      "withholds every split of %s without losing surrounding prose",
      async (shadow) => {
        const onAgentEvent = vi.fn();
        const context = createMessageUpdateContext({ onAgentEvent });
        let text = "";
        for (const delta of ["Visible\n", ...shadow.split(""), "\nDone."]) {
          text += delta;
          const partial = message(text);
          await updateMessage(context, {
            message: partial,
            assistantMessageEvent: { type: "text_delta", delta, partial, contentIndex: 0 },
          });
          expect(context.state.assistantStream?.text).toBe(
            text.endsWith("Done.") ? "Visible\n\nDone." : "Visible",
          );
        }
        const partial = message(text);
        await updateMessage(context, {
          message: partial,
          assistantMessageEvent: { type: "text_end", content: text, partial, contentIndex: 0 },
        });
        expect(context.state.assistantStream?.text).toBe("Visible\n\nDone.");
        expect(extractAssistantStreamSnapshot(context, partial).blockText).toBe("Visible\n\nDone.");
        if (api === "openai-responses") {
          expect(context.blockChunker.bufferedText).toBe("Visible\n\nDone.");
        }
        expect(extractAssistantVisibleText(partial)).toBe("Visible\n\nDone.");
        expect(
          consumePendingAssistantReplyDirectivesIntoReply(context.state, {
            text: "Visible\n\nDone.",
          }),
        ).toEqual({ text: "Visible\n\nDone." });
        expect(onAgentEvent.mock.calls.map(([event]) => event.data.text)).toEqual([
          "Visible",
          "Visible\n\nDone.",
        ]);
      },
    );

    it.each(["Use <tool_call>exec", "Use <invoke", "Use <tool_"])(
      "restores the terminal literal %s after withholding its ambiguous suffix",
      async (text) => {
        const context = createMessageUpdateContext();
        const partial = message(text);
        await updateMessage(context, {
          message: partial,
          assistantMessageEvent: { type: "text_delta", delta: text, partial, contentIndex: 0 },
        });
        expect(context.state.assistantStream?.text).toBe("Use");
        await updateMessage(context, {
          message: partial,
          assistantMessageEvent: { type: "text_end", content: text, partial, contentIndex: 0 },
        });
        expect(context.state.assistantStream?.text).toBe(text);
        expect(extractAssistantStreamSnapshot(context, partial).blockText).toBe(text);
        if (api === "openai-responses") {
          expect(context.blockChunker.bufferedText).toBe(text);
        }
      },
    );
  },
);
