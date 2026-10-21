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
    expect(
      resolveDiscordMessageHistoryText(
        asMessage({
          content: "",
          attachments: [{ filename: "clip.mp4", content_type: "video/mp4" }],
        }),
      ),
    ).toBe("<media:video>");
  });

  it("falls back to referenced forward message text when snapshots are absent", () => {
    const text = resolveDiscordMessageText(
      asReferencedForwardMessage({ content: "forwarded from referenced message" }),
      { includeForwarded: true },
    );

    expect(text).toContain("[Forwarded message from @Bob]");
    expect(text).toContain("forwarded from referenced message");
  });

  it("does not treat ordinary replies as forwarded context", () => {
    const text = resolveDiscordMessageText(
      asReferencedForwardMessage({
        content: "quoted reply content",
        messageReferenceType: MessageReferenceType.Default,
      }),
      { includeForwarded: true },
    );

    expect(text).toBe("");
  });

  const label = "a$'b $& big$$money a$`b";
  it.each([
    {
      name: "global names and username fallbacks",
      content: "Hello <@123> and <@456>!",
      mentionedUsers: [
        { id: "123", username: "alice", globalName: "Alice Wonderland", discriminator: "0" },
        { id: "456", username: "bob", discriminator: "0" },
      ],
      expected: "Hello @Alice Wonderland and @bob!",
    },
    {
      name: "literal replacement tokens",
      content: "Hello <@1> and <@!1>, meet <@2>!",
      mentionedUsers: [
        { id: "1", globalName: label, username: "fallback" },
        { id: "2", username: label },
      ],
      expected: `Hello @${label} and @${label}, meet @${label}!`,
    },
    {
      name: "user IDs when names are absent",
      content: "Hello <@1> and <@!1>!",
      mentionedUsers: [{ id: "1" }],
      expected: "Hello @1 and @1!",
    },
  ])("resolves mentions with $name", ({ content, mentionedUsers, expected }) => {
    expect(resolveDiscordMessageText(asMessage({ content, mentionedUsers }))).toBe(expected);
  });

  it("renders forwarded media facts as text without the legacy single-item count", () => {
    const attachmentText = forwardedText({
      attachments: [forwardedImage],
    });

    expect(attachmentText).toContain("<media:image>");
    expect(attachmentText).not.toContain("(1 image)");
  });

  it("renders forwarded captions together with their media facts", () => {
    const text = forwardedText({
      content: "look at this",
      attachments: [forwardedImage],
    });

    expect(text).toContain("look at this\n<media:image>");
  });

  it("preserves audio classification in forwarded text-only previews", () => {
    const text = forwardedText({
      attachments: [
        {
          id: "forwarded-audio",
          filename: "voice.ogg",
          content_type: "audio/ogg",
          url: "https://cdn.discordapp.com/voice.ogg",
        },
      ],
    });

    expect(text).toContain("<media:audio>");
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
    {
      name: "empty sticker-only primary body",
      message: {
        content: "",
        stickers: [{ id: "sticker-3", name: "party", format_type: StickerFormatType.PNG }],
      },
      expected: "",
    },
    {
      name: "embed fallback",
      message: { content: "", embeds: [{ title: "Breaking", description: "Details" }] },
      expected: "Breaking\nDetails",
    },
    {
      name: "content before embed fallback",
      message: {
        content: "hello from content",
        embeds: [{ title: "Breaking", description: "Details" }],
      },
      expected: "hello from content",
    },
  ])("renders $name", ({ message, expected }) => {
    expect(resolveDiscordMessageText(asMessage(message))).toBe(expected);
  });

  it("preserves text from later embeds in forwarded message snapshots", () => {
    const text = forwardedText({
      embeds: [
        {},
        { title: "Forwarded title", description: "Forwarded details" },
        { description: "Forwarded follow-up" },
      ],
    });

    expect(text).toBe(
      "[Forwarded message from @Bob]\nForwarded title\nForwarded details\nForwarded follow-up",
    );
  });

  it("includes Components v2 text display content from forwarded snapshots", () => {
    const text = forwardedText({
      components: [
        {
          type: ComponentType.Container,
          components: [{ type: ComponentType.TextDisplay, content: "Forwarded component text" }],
        },
      ],
    });

    expect(text).toContain("[Forwarded message from @Bob]");
    expect(text).toContain("Forwarded component text");
  });
});
