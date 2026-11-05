import { ComponentType, MessageReferenceType, StickerFormatType } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { Message } from "../internal/discord.js";
import { createInternalTestClient } from "../internal/test-builders.test-support.js";
import { createDiscordMessage } from "./message-handler.preflight.test-helpers.js";
import { resolveDiscordMessageHistoryText, resolveDiscordMessageText } from "./message-text.js";

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

const renderText = (payload: Record<string, unknown>) =>
  resolveDiscordMessageText(asMessage(payload));

function forwardedText(message: Record<string, unknown>) {
  const snapshot = {
    content: "",
    author: { id: "u2", username: "Bob", discriminator: "0" },
    ...message,
  };
  return resolveDiscordMessageText(
    asMessage({ content: "", rawData: { message_snapshots: [{ message: snapshot }] } }),
    { includeForwarded: true },
  );
}

function asReferencedForwardMessage(content: string, type: MessageReferenceType) {
  return asMessage({
    content: "",
    messageReference: { type },
    referencedMessage: asMessage({
      content,
      author: { id: "u2", username: "Bob", discriminator: "0" },
    }),
  });
}

describe("resolveDiscordMessageText", () => {
  it("renders definitive video MIME as video on history text carriers", () => {
    const message = asMessage({
      content: "",
      attachments: [{ filename: "clip.mp4", content_type: "video/mp4" }],
    });
    expect(resolveDiscordMessageHistoryText(message)).toBe("<media:video>");
  });

  it.each([
    [MessageReferenceType.Forward, "[Forwarded message from @Bob]\nforwarded"],
    [MessageReferenceType.Default, ""],
  ] as const)(
    "includes only forwarded reference text (type=%s)",
    (messageReferenceType, expected) => {
      const result = resolveDiscordMessageText(
        asReferencedForwardMessage("forwarded", messageReferenceType),
        { includeForwarded: true },
      );
      expect(result).toBe(expected);
    },
  );

  const label = "a$'b $& big$$money a$`b";
  it.each([
    [
      "literal replacement tokens",
      "Hello <@1> and <@!1>, meet <@2>!",
      [
        { id: "1", globalName: label, username: "fallback" },
        { id: "2", username: label },
      ],
      `Hello @${label} and @${label}, meet @${label}!`,
    ],
    ["user IDs when names are absent", "Hello <@1> and <@!1>!", [{ id: "1" }], "Hello @1 and @1!"],
  ] as const)("resolves mentions with %s", (_name, content, mentionedUsers, expected) => {
    expect(renderText({ content, mentionedUsers })).toBe(expected);
  });

  it.each(["", "look at this"])("renders forwarded media with caption %j", (content) => {
    const result = forwardedText({ content, attachments: [{ content_type: "image/png" }] });
    expect(result).toContain(content ? `${content}\n<media:image>` : "<media:image>");
    if (!content) {
      expect(result).toContain("[Forwarded message from @Bob]");
      expect(result).not.toContain("(1 image)");
    }
  });

  it("uses Components v2 text display content when normal message text is empty", () => {
    const client = createInternalTestClient();
    const text = resolveDiscordMessageText(
      createDiscordMessage(
        {
          id: "m",
          channelId: "c",
          content: "",
          author: { id: "u", bot: false },
          components: [
            {
              type: ComponentType.Container,
              components: [
                { type: ComponentType.TextDisplay, content: "Component headline" },
                {
                  type: ComponentType.Section,
                  components: [{ type: ComponentType.TextDisplay, content: "Component body" }],
                  accessory: {
                    type: ComponentType.Thumbnail,
                    media: { url: "attachment://x.png" },
                  },
                },
              ],
            },
          ],
        },
        client,
      ),
    );

    expect(text).toBe("Component headline\nComponent body");
    expect(resolveDiscordMessageText(new Message(client, "partial-message"))).toBe("");
  });

  it.each([
    [
      "empty sticker-only primary body",
      {
        content: "",
        stickers: [{ id: "sticker-3", name: "party", format_type: StickerFormatType.PNG }],
      },
      "",
    ],
    [
      "content before embed fallback",
      {
        content: "hello from content",
        embeds: [{ title: "Breaking", description: "Details" }],
      },
      "hello from content",
    ],
  ] as const)("renders %s", (_name, message, expected) => {
    expect(renderText(message)).toBe(expected);
  });
});
