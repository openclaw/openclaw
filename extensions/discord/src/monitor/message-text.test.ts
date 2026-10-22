import {
  ComponentType,
  MessageFlags,
  MessageReferenceType,
  MessageType,
  StickerFormatType,
} from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { Message } from "../internal/discord.js";
import { createInternalTestClient } from "../internal/test-builders.test-support.js";
import { resolveDiscordMessageHistoryText, resolveDiscordMessageText } from "./message-text.js";

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

const renderText = (payload: Record<string, unknown>) =>
  resolveDiscordMessageText(asMessage(payload));

function forwardedText(message: Record<string, unknown>) {
  const snapshot = {
    content: "",
    embeds: [],
    attachments: [],
    author: { id: "u2", username: "Bob", discriminator: "0" },
    ...message,
  };
  return resolveDiscordMessageText(
    asMessage({ content: "", rawData: { message_snapshots: [{ message: snapshot }] } }),
    { includeForwarded: true },
  );
}

const forwardedImage = {
  id: "forwarded-image",
  filename: "forwarded.png",
  content_type: "image/png",
  url: "https://cdn.discordapp.com/forwarded.png",
};

function asReferencedForwardMessage(params: {
  content?: string;
  messageReferenceType?: MessageReferenceType;
}) {
  return asMessage({
    content: "",
    messageReference: {
      type: params.messageReferenceType ?? MessageReferenceType.Forward,
      message_id: "m0",
      channel_id: "c1",
    },
    referencedMessage: asMessage({
      id: "m0",
      channelId: "c1",
      content: params.content ?? "",
      components: [],
      attachments: [],
      embeds: [],
      flags: 0,
      stickers: [],
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
    [MessageReferenceType.Forward, "forwarded from referenced message"],
    [MessageReferenceType.Default, "quoted reply content"],
  ] as const)(
    "includes only forwarded reference text (type=%s)",
    (messageReferenceType, content) => {
      const result = resolveDiscordMessageText(
        asReferencedForwardMessage({ content, messageReferenceType }),
        { includeForwarded: true },
      );
      if (messageReferenceType === MessageReferenceType.Default) {
        expect(result).toBe("");
      } else {
        expect(result).toContain("[Forwarded message from @Bob]");
        expect(result).toContain(content);
      }
    },
  );

  const label = "a$'b $& big$$money a$`b";
  it.each([
    [
      "global names and username fallbacks",
      "Hello <@123> and <@456>!",
      [
        { id: "123", username: "alice", globalName: "Alice Wonderland", discriminator: "0" },
        { id: "456", username: "bob", discriminator: "0" },
      ],
      "Hello @Alice Wonderland and @bob!",
    ],
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
    const result = forwardedText({ content, attachments: [forwardedImage] });
    expect(result).toContain(content ? `${content}\n<media:image>` : "<media:image>");
    if (!content) {
      expect(result).toContain("[Forwarded message from @Bob]");
      expect(result).not.toContain("(1 image)");
    }
  });

  it("uses Components v2 text display content when normal message text is empty", () => {
    const client = createInternalTestClient();
    const text = resolveDiscordMessageText(
      new Message(client, {
        id: "message-components",
        channel_id: "channel-components",
        content: "",
        type: MessageType.Default,
        author: {
          id: "user-components",
          username: "user",
          discriminator: "0",
          avatar: null,
          global_name: null,
        },
        timestamp: "2026-01-01T00:00:00.000Z",
        edited_timestamp: null,
        attachments: [],
        embeds: [],
        mentions: [],
        mention_roles: [],
        mention_everyone: false,
        pinned: false,
        tts: false,
        flags: MessageFlags.IsComponentsV2,
        components: [
          {
            type: ComponentType.Container,
            components: [
              { type: ComponentType.TextDisplay, content: "Component headline" },
              {
                type: ComponentType.Section,
                components: [{ type: ComponentType.TextDisplay, content: "Component body" }],
                accessory: { type: ComponentType.Thumbnail, media: { url: "attachment://x.png" } },
              },
            ],
          },
        ],
      }),
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
      "embed fallback",
      { content: "", embeds: [{ title: "Breaking", description: "Details" }] },
      "Breaking\nDetails",
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
