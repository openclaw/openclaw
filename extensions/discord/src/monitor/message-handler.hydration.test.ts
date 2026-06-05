// Discord tests cover message handler.hydration plugin behavior.
import { MessageReferenceType, MessageType } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { Message } from "../internal/discord.js";
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
          flags: 0,
        },
        type: 0,
        tts: false,
        pinned: false,
        flags: 0,
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

  it("hydrates reply references when Discord omits referenced_message", async () => {
    const client = createInternalTestClient();
    const rest = createFakeRestClient([
      {
        id: "m1",
        channel_id: "c1",
        content: "what did this mean?",
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
          type: MessageReferenceType.Default,
          message_id: "m0",
          channel_id: "c1",
        },
        referenced_message: {
          id: "m0",
          channel_id: "c1",
          content: "the replied-to message",
          attachments: [],
          embeds: [],
          mentions: [],
          mention_roles: [],
          mention_everyone: false,
          timestamp: new Date().toISOString(),
          author: {
            id: "u2",
            username: "bob",
            discriminator: "0",
            avatar: null,
          },
          type: MessageType.Default,
          tts: false,
          pinned: false,
          flags: 0,
        },
        type: MessageType.Reply,
        tts: false,
        pinned: false,
        flags: 0,
      },
    ]);
    const message = new Message(client, {
      id: "m1",
      channel_id: "c1",
      content: "what did this mean?",
      attachments: [],
      embeds: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      timestamp: new Date().toISOString(),
      author: {
        id: "u1",
        username: "alice",
        global_name: null,
        discriminator: "0",
        avatar: null,
      },
      message_reference: {
        type: MessageReferenceType.Default,
        message_id: "m0",
        channel_id: "c1",
      },
      type: MessageType.Reply,
      tts: false,
      pinned: false,
    });

    const hydrated = await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message,
      messageChannelId: "c1",
    });

    expect(rest.calls).toHaveLength(1);
    expect(hydrated.referencedMessage?.content).toBe("the replied-to message");
  });

  it("keeps the original reply message when hydration fetch fails", async () => {
    const client = createInternalTestClient();
    const rest = createFakeRestClient();
    rest.get = vi.fn(async () => {
      throw Object.assign(new Error("Missing Access"), { status: 403 });
    });
    const message = new Message(client, {
      id: "m1",
      channel_id: "c1",
      content: "what did this mean?",
      attachments: [],
      embeds: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      timestamp: new Date().toISOString(),
      author: {
        id: "u1",
        username: "alice",
        global_name: null,
        discriminator: "0",
        avatar: null,
      },
      message_reference: {
        type: MessageReferenceType.Default,
        message_id: "m0",
        channel_id: "c1",
      },
      type: MessageType.Reply,
      tts: false,
      pinned: false,
    });

    const hydrated = await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message,
      messageChannelId: "c1",
    });

    expect(rest.get).toHaveBeenCalledOnce();
    expect(hydrated).toBe(message);
    expect(hydrated.referencedMessage).toBeNull();
  });

  it("does not hydrate known-deleted or forwarded references", async () => {
    const client = createInternalTestClient();
    const rest = createFakeRestClient();
    const baseMessage = {
      id: "m1",
      channel_id: "c1",
      content: "what did this mean?",
      attachments: [],
      embeds: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      timestamp: new Date().toISOString(),
      author: {
        id: "u1",
        username: "alice",
        global_name: null,
        discriminator: "0",
        avatar: null,
      },
      tts: false,
      pinned: false,
    };

    const deletedReply = new Message(client, {
      ...baseMessage,
      message_reference: {
        type: MessageReferenceType.Default,
        message_id: "m0",
        channel_id: "c1",
      },
      referenced_message: null,
      type: MessageType.Reply,
    });
    const forwardedMessage = new Message(client, {
      ...baseMessage,
      message_reference: {
        type: MessageReferenceType.Forward,
        message_id: "m0",
        channel_id: "c1",
      },
      type: MessageType.Default,
    });

    await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message: deletedReply,
      messageChannelId: "c1",
    });
    await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message: forwardedMessage,
      messageChannelId: "c1",
    });

    expect(rest.calls).toHaveLength(0);
  });
});
