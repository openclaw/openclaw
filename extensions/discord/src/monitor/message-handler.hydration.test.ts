import { describe, expect, it } from "vitest";
import { Message, MessageType } from "../internal/discord.js";
import {
  createFakeRestClient,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { hydrateDiscordMessageIfNeeded } from "./message-handler.hydration.js";

describe("hydrateDiscordMessageIfNeeded", () => {
  it("hydrates partial internal messages without assigning over getters", async () => {
    const client = createInternalTestClient();
    const rest = createFakeRestClient([
      {
        id: "m1",
        channel_id: "c1",
        content: "hello <@u2>",
        attachments: [{ id: "a1", filename: "note.txt" }],
        embeds: [{ title: "Embed" }],
        mentions: [
          {
            id: "u2",
            username: "bob",
            global_name: "Bob Builder",
            discriminator: "0",
            avatar: null,
          },
        ],
        mention_roles: ["role1"],
        mention_everyone: false,
        timestamp: new Date().toISOString(),
        author: {
          id: "u1",
          username: "alice",
          discriminator: "0",
          avatar: null,
        },
        referenced_message: {
          id: "m0",
          channel_id: "c1",
          content: "earlier",
          attachments: [],
          embeds: [],
          mentions: [],
          mention_roles: [],
          mention_everyone: false,
          timestamp: new Date().toISOString(),
          author: {
            id: "u3",
            username: "carol",
            discriminator: "0",
            avatar: null,
          },
          type: 0,
          tts: false,
          pinned: false,
          flags: 0 as never,
        },
        type: 0,
        tts: false,
        pinned: false,
        flags: 0 as never,
      },
    ]);
    const message = new Message<true>(client, { id: "m1", channelId: "c1" }) as unknown as Message;

    const hydrated = await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message,
      messageChannelId: "c1",
    });

    expect(hydrated).toBeInstanceOf(Message);
    expect(hydrated.content).toBe("hello <@u2>");
    expect(hydrated.attachments).toHaveLength(1);
    expect(hydrated.embeds).toHaveLength(1);
    expect(hydrated.mentionedUsers[0]?.globalName).toBe("Bob Builder");
    expect(hydrated.mentionedRoles).toEqual(["role1"]);
    expect(hydrated.referencedMessage?.content).toBe("earlier");
  });

  it("does not hydrate reply messages that already include referenced_message", async () => {
    const client = createInternalTestClient();
    const rest = createFakeRestClient([]);
    const message = new Message(client, {
      id: "m2",
      channel_id: "c1",
      content: "normal reply",
      attachments: [],
      embeds: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      timestamp: new Date().toISOString(),
      author: {
        id: "u1",
        username: "alice",
        discriminator: "0",
        global_name: null,
        avatar: null,
      },
      message_reference: {
        channel_id: "c1",
        message_id: "m1",
      },
      referenced_message: {
        id: "m1",
        channel_id: "c1",
        content: "bot reply",
        attachments: [],
        embeds: [],
        mentions: [],
        mention_roles: [],
        mention_everyone: false,
        timestamp: new Date().toISOString(),
        edited_timestamp: null,
        author: {
          id: "bot-1",
          username: "OpenClaw",
          discriminator: "0",
          global_name: null,
          avatar: null,
          bot: true,
        },
        type: 0,
        tts: false,
        pinned: false,
        flags: 0 as never,
      },
      type: MessageType.Reply,
      tts: false,
      pinned: false,
      flags: 0 as never,
    });

    const hydrated = await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message,
      messageChannelId: "c1",
    });

    expect(rest.calls).toHaveLength(0);
    expect(hydrated).toBe(message);
  });

  it("hydrates reply messages that have content but are missing referenced_message", async () => {
    const client = createInternalTestClient();
    const rest = createFakeRestClient([
      {
        id: "m2",
        channel_id: "c1",
        content: "why did this get ignored?",
        attachments: [],
        embeds: [],
        mentions: [],
        mention_roles: [],
        mention_everyone: false,
        timestamp: new Date().toISOString(),
        author: {
          id: "u1",
          username: "alice",
          discriminator: "0",
          avatar: null,
        },
        message_reference: {
          channel_id: "c1",
          message_id: "m1",
        },
        referenced_message: {
          id: "m1",
          channel_id: "c1",
          content: "bot reply",
          attachments: [],
          embeds: [],
          mentions: [],
          mention_roles: [],
          mention_everyone: false,
          timestamp: new Date().toISOString(),
          author: {
            id: "bot-1",
            username: "OpenClaw",
            discriminator: "0",
            global_name: null,
            avatar: null,
            bot: true,
          },
          type: 0,
          tts: false,
          pinned: false,
          flags: 0 as never,
        },
        type: MessageType.Reply,
        tts: false,
        pinned: false,
        flags: 0 as never,
      },
    ]);
    const message = new Message(client, {
      id: "m2",
      channel_id: "c1",
      content: "why did this get ignored?",
      attachments: [],
      embeds: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      timestamp: new Date().toISOString(),
      author: {
        id: "u1",
        username: "alice",
        discriminator: "0",
        global_name: null,
        avatar: null,
      },
      message_reference: {
        channel_id: "c1",
        message_id: "m1",
      },
      referenced_message: null,
      type: MessageType.Reply,
      tts: false,
      pinned: false,
      flags: 0 as never,
    });

    const hydrated = await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message,
      messageChannelId: "c1",
    });

    expect(rest.calls).toHaveLength(1);
    expect(hydrated.referencedMessage?.author?.id).toBe("bot-1");
    expect(hydrated.messageReference?.message_id).toBe("m1");
  });
});
