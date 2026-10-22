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

function asReferencedForwardMessage(params: {
  content?: string;
  components?: Array<Record<string, unknown>>;
  embeds?: Array<{ title?: string; description?: string }>;
  attachments?: Array<Record<string, unknown>>;
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
      components: params.components ?? [],
      attachments: params.attachments ?? [],
      embeds: params.embeds ?? [],
      flags: params.components ? MessageFlags.IsComponentsV2 : 0,
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

  it("resolves user mentions in content", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "Hello <@123> and <@456>!",
        mentionedUsers: [
          { id: "123", username: "alice", globalName: "Alice Wonderland", discriminator: "0" },
          { id: "456", username: "bob", discriminator: "0" },
        ],
      }),
    );
    expect(text).toBe("Hello @Alice Wonderland and @bob!");
  });

  it("preserves literal replacement tokens in mention labels", () => {
    const label = "a$'b $& big$$money a$`b";
    const text = resolveDiscordMessageText(
      asMessage({
        content: "Hello <@1> and <@!1>, meet <@2>!",
        mentionedUsers: [
          { id: "1", globalName: label, username: "fallback" },
          { id: "2", username: label },
        ],
      }),
    );
    expect(text).toBe(`Hello @${label} and @${label}, meet @${label}!`);
  });

  it("uses the user ID when mention names are absent", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "Hello <@1> and <@!1>!",
        mentionedUsers: [{ id: "1" }],
      }),
    );
    expect(text).toBe("Hello @1 and @1!");
  });

  it("keeps the primary body empty for sticker-only messages", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        stickers: [{ id: "sticker-3", name: "party", format_type: StickerFormatType.PNG }],
      }),
    );

    expect(text).toBe("");
  });

  it("renders forwarded media facts as text without the legacy single-item count", () => {
    const attachmentText = forwardedText({
      attachments: [
        {
          id: "forwarded-image",
          filename: "forwarded.png",
          content_type: "image/png",
          url: "https://cdn.discordapp.com/forwarded.png",
        },
      ],
    });

    expect(attachmentText).toContain("<media:image>");
    expect(attachmentText).not.toContain("(1 image)");
  });

  it("renders forwarded captions together with their media facts", () => {
    const text = forwardedText({
      content: "look at this",
      embeds: [],
      attachments: [
        {
          id: "forwarded-image",
          filename: "forwarded.png",
          content_type: "image/png",
          url: "https://cdn.discordapp.com/forwarded.png",
        },
      ],
    });

    expect(text).toContain("look at this\n<media:image>");
  });

  it("preserves audio classification in forwarded text-only previews", () => {
    const text = forwardedText({
      content: "",
      embeds: [],
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

  it("joins embed title and description when content is empty", () => {
    expect(
      resolveDiscordMessageText(
        asMessage({ content: "", embeds: [{ title: "Breaking", description: "Details" }] }),
      ),
    ).toBe("Breaking\nDetails");
  });

  it("prefers message content over embed fallback text", () => {
    expect(
      resolveDiscordMessageText(
        asMessage({
          content: "hello from content",
          embeds: [{ title: "Breaking", description: "Details" }],
        }),
      ),
    ).toBe("hello from content");
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
