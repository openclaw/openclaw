import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../llm/types.js";
import * as codeRegions from "../shared/text/code-regions.js";
import { consumePendingAssistantReplyDirectivesIntoReply } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import { extractAssistantStreamSnapshot } from "./embedded-agent-subscribe.handlers.messages.snapshot.js";
import {
  createMessageUpdateContext,
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
];
const textPart = (text: string) => ({ type: "text" as const, text });
function expectVisible(
  message: AssistantMessage,
  text: string,
  ctx = createMessageUpdateContext(),
) {
  expect(extractAssistantStreamSnapshot(ctx, message)).toMatchObject({ text, blockText: text });
  expect(extractAssistantVisibleText(message)).toBe(text);
}

describe.each(["ollama", "anthropic-messages", "openai-completions", "openai-responses"] as const)(
  "%s tool markup delivery",
  (api) => {
    function message(content: string | AssistantMessage["content"]) {
      return makeAgentAssistantMessage({
        api,
        provider: "fixture",
        model: "fixture",
        ...(api === "openai-responses" ? { phase: "final_answer" as const } : {}),
        content: typeof content === "string" ? [textPart(content)] : content,
      });
    }

    function update(
      context: ReturnType<typeof createMessageUpdateContext>,
      text: string,
      type: "text_delta" | "text_end",
      delta = text,
    ) {
      const partial = message(text);
      return updateMessage(context, {
        message: partial,
        assistantMessageEvent: {
          type,
          ...(type === "text_delta" ? { delta } : { content: text }),
          partial,
          contentIndex: 0,
        },
      });
    }

    it("bounds Markdown parse work after quoted tool XML in token-sized deltas", async () => {
      const context = createMessageUpdateContext();
      const example = `\`\`\`xml\n${markup[2]}\n\`\`\`\n\n`;
      const continuation = "Explanation.\n\n- Item\n\n```python\nprint('hello')\n```\n\n".repeat(
        128,
      );
      const source = example + continuation;
      const regions = vi.spyOn(codeRegions, "findCodeRegions");
      try {
        let text = "";
        for (let offset = 0; offset < source.length; offset += 4) {
          const delta = source.slice(offset, offset + 4);
          text += delta;
          await update(context, text, "text_delta", delta);
        }
        expect(context.state.assistantStream?.text).toBe(source.trimEnd());
        const parsedCharacters = regions.mock.calls.reduce(
          (total, [parsed]) => total + parsed.length,
          0,
        );
        expect(parsedCharacters).toBeLessThan(source.length * 8);
      } finally {
        regions.mockRestore();
      }
    });

    it("keeps markup context across adjacent text and whitespace blocks", () => {
      const partial = message(
        [
          "Visible\n<tool_call>exec<arg_key>command</arg_key><arg_value>",
          " \n",
          "hidden</arg_value></tool_call>\nDone.",
        ].map(textPart),
      );
      expectVisible(partial, "Visible\n\nDone.");
    });

    it.each([
      { type: "toolCall", id: "call-1", name: "exec", arguments: {} },
      { type: "thinking", thinking: "Private reasoning." },
    ] as const)("ends XML context at a native $type block", (boundary) => {
      expectVisible(
        message([
          textPart('<tool_call>{"name":"exec","arguments":{}}'),
          boundary,
          textPart("Done."),
        ]),
        "Done.",
      );
    });

    it.each(markup)(
      "withholds every split of %s without losing surrounding prose",
      async (shadow) => {
        const onAgentEvent = vi.fn();
        const context = createMessageUpdateContext({ onAgentEvent });
        let text = "";
        for (const delta of ["Visible\n", ...shadow.split(""), "\nDone."]) {
          text += delta;
          await update(context, text, "text_delta", delta);
          expect(context.state.assistantStream?.text).toBe(
            text.endsWith("Done.") ? "Visible\n\nDone." : "Visible",
          );
        }
        const partial = message(text);
        await update(context, text, "text_end");
        expect(context.state.assistantStream?.text).toBe("Visible\n\nDone.");
        expectVisible(partial, "Visible\n\nDone.", context);
        if (api === "openai-responses") {
          expect(context.blockChunker.bufferedText).toBe("Visible\n\nDone.");
        }
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
        await update(context, text, "text_delta");
        expect(context.state.assistantStream?.text).toBe("Use");
        await update(context, text, "text_end");
        expect(context.state.assistantStream?.text).toBe(text);
        expect(extractAssistantStreamSnapshot(context, message(text)).blockText).toBe(text);
        if (api === "openai-responses") {
          expect(context.blockChunker.bufferedText).toBe(text);
        }
      },
    );
  },
);
