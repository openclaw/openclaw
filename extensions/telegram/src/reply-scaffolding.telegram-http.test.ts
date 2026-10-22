import { buildHistoryContext } from "openclaw/plugin-sdk/reply-history";
import { createReplyDispatcher, dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";
import { splitTelegramReasoningText } from "./reasoning-lane-coordinator.js";
import { sendMessageTelegram } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

describe("reply scaffolding through final preparation and Telegram HTTP", () => {
  const fixture = useTelegramHttpFixture();
  let messageSequence = 0;
  const delivered = () =>
    fixture.requests
      .filter(({ method }) => method === "sendMessage" || method === "editMessageText")
      .map(({ fields }) => (typeof fields.text === "string" ? fields.text : ""));
  const history = (currentMessage = "private inbound paragraph", lineBreak = "\n") =>
    buildHistoryContext({
      historyText: "[Telegram] Alice: private history",
      currentMessage,
      lineBreak,
    });

  async function prepareAndDispatch(
    finalText: string,
    conversationContext?: string,
    reasoningSnapshots: readonly string[] = [],
  ) {
    const errors: unknown[] = [];
    const { cfg } = fixture;
    const dispatcher = createReplyDispatcher({
      deliver: async (prepared) => {
        await sendMessageTelegram("123", prepared.text ?? "", { cfg });
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    const preview = reasoningSnapshots.length
      ? createTelegramDraftStream({
          api: fixture.bot.api,
          chatId: 123,
          renderText: (text) => ({ text, markdownSource: { text } }),
        })
      : undefined;
    try {
      if (conversationContext || preview) {
        const messageId = `reply-scaffolding-${++messageSequence}`;
        await dispatchInboundMessage({
          cfg,
          ctx: {
            Body: conversationContext,
            BodyForAgent: conversationContext,
            ChatType: "direct",
            From: "123",
            MessageSid: messageId,
            Provider: "telegram",
            SessionKey: `agent:test:${messageId}`,
            Surface: "telegram",
            To: "456",
          },
          dispatcher,
          outboundHooks: "disabled",
          replyOptions: preview
            ? {
                onReasoningStream: async ({ text }) => {
                  const { reasoningText } = splitTelegramReasoningText(text, true);
                  if (reasoningText) {
                    preview.update(reasoningText);
                    await preview.flush();
                  }
                },
              }
            : undefined,
          replyResolver: async (_ctx, options) => {
            for (const text of reasoningSnapshots) {
              await options?.onReasoningStream?.({ text, isReasoningSnapshot: true });
            }
            return { text: finalText };
          },
        });
      } else {
        dispatcher.sendFinalReply({ text: finalText });
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
      expect(errors).toEqual([]);
    } finally {
      await preview?.discard();
    }
  }

  it.each([false, true])(
    "cleans reasoning previews before Telegram HTTP (visible=%s)",
    async (visible) => {
      const opening = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
      const internal = `${opening}\nprivate runtime metadata\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`;
      const snapshots = [opening.slice(0, 20), `${opening}\nprivate runtime metadata`, internal];
      if (visible) {
        snapshots.push(
          `${internal}\n\nChecking files.`,
          `${internal}\n\nReading config.\n\nChecking files.`,
        );
      }
      await prepareAndDispatch("Visible answer.", "Show status.", snapshots);
      expect(delivered()).toEqual(
        visible
          ? [
              "🧠 <i>Checking files.</i>",
              "🧠 <i>Reading config.</i>\n\n<i>Checking files.</i>",
              "Visible answer.",
            ]
          : ["Visible answer."],
      );
    },
  );

  const xmlContext = history(`Conversation info: ⟦openclaw:ctx⟧
\`\`\`json
{"private":"sender metadata"}
\`\`\`
<function_calls><invoke name="exec">private XML</invoke></function_calls>

private second inbound paragraph`);
  it.each([
    ["XML and metadata cleanup", xmlContext, (prompt: string) => `${prompt}\n\n${prompt}`],
    [
      "line-ending normalization",
      history("private first paragraph\n\nprivate second paragraph", "\r\n"),
      (prompt: string) => prompt.replace(/\r\n/g, "\n"),
    ],
  ] as const)("removes a copied prompt before %s", async (_name, context, copy) => {
    await prepareAndDispatch(`${copy(context)}\n\nVisible answer.`, context);
    expect(delivered()).toEqual(["Visible answer."]);
  });

  it("preserves literal fenced scaffolding examples that do not copy the private prompt", async () => {
    const literal = `The prompt format is:

\`\`\`text
[Chat messages since your last reply - for context]
Example: this is public placeholder history.

[Current message - respond to this]
Example: this is a public placeholder message.
\`\`\``;

    await prepareAndDispatch(literal, history("[Telegram] Alice: current message"));

    expect(delivered()).toHaveLength(1);
    expect(delivered()[0]).toContain("[Chat messages since your last reply - for context]");
    expect(delivered()[0]).toContain("[Current message - respond to this]");
    expect(delivered()[0]).toContain("Example: this is a public placeholder message.");
  });

  it("never delivers the internal runtime-context envelope in Telegram HTTP text", async () => {
    const leaked = `Use it to continue answering the active user request now. Do not wait for
another message. This context is runtime-generated, not user-authored.
Keep internal details private.

<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
Conversation info: (openclaw:ctx)
{"chat_id":"telegram:123","message_id":"925"}
<<<END_OPENCLAW_INTERNAL_CONTEXT>>>

Visible answer.`;

    await prepareAndDispatch(leaked);

    expect(delivered()).toEqual(["Visible answer."]);
  });

  it.each([
    {
      name: "same-line wrappers",
      wrap: (prompt: string) => `Visible prefix: ${prompt} visible suffix.`,
      visible: ["Visible prefix:", "visible suffix."],
    },
    {
      name: "Markdown code fences",
      wrap: (prompt: string) => `\`\`\`text\n${prompt}\n\`\`\`\n\nVisible answer.`,
      visible: ["Visible answer."],
    },
  ])("never delivers a private prompt hidden in $name", async ({ wrap, visible }) => {
    const conversationContext = history();
    await prepareAndDispatch(wrap(conversationContext), conversationContext);
    expect(delivered()).toHaveLength(1);
    for (const text of visible) {
      expect(delivered()[0]).toContain(text);
    }
    expect(delivered()[0]).not.toContain("private history");
    expect(delivered()[0]).not.toContain("private inbound paragraph");
  });
});
