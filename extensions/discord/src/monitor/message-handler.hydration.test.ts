import { MessageReferenceType, MessageType } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { Message } from "../internal/discord.js";
import {
  createFakeRestClient,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import { hydrateDiscordMessageIfNeeded } from "./message-handler.hydration.js";
import { createDiscordMessage } from "./message-handler.preflight.test-helpers.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

function user(id: string, username: string) {
  return { id, username, global_name: null, discriminator: "0", avatar: null };
}
function payload(overrides = {}) {
  return {
    ...createDiscordMessage({
      id: "1001",
      channelId: "c1",
      content: "what did this mean?",
      timestamp: "2026-01-01T00:00:00.000Z",
      author: { id: "u1", username: "alice", bot: false },
    }).rawData,
    flags: 0,
    ...overrides,
  };
}
function reference(type = MessageReferenceType.Default, channel_id = "c1") {
  return { type, message_id: "1000", channel_id };
}
function reply(overrides = {}) {
  return payload({
    message_reference: reference(),
    type: MessageType.Reply,
    ...overrides,
  });
}
function referenced(content: string, overrides = {}) {
  return payload({
    id: "1000",
    content,
    author: { ...user("u2", "bob"), bot: true },
    ...overrides,
  });
}
function staleReply() {
  return reply({
    referenced_message: referenced("unrelated older context", { id: "stale-message" }),
  });
}
function fixture(raw: ConstructorParameters<typeof Message>[1], responses: unknown[] = []) {
  const client = createInternalTestClient();
  const rest = createFakeRestClient(responses);
  client.rest = rest;
  const message = new Message(client, raw);
  return {
    rest,
    message,
    hydrate: () => hydrateDiscordMessageIfNeeded({ client, message, messageChannelId: "c1" }),
  };
}
async function context(message: Message) {
  const ctx = await createBaseDiscordMessageContext({
    discordConfig: { allowBots: false },
    botUserId: "bot",
    message,
    author: message.author,
    baseText: message.content,
    messageText: message.content,
  });
  const result = await buildDiscordMessageProcessContext({
    ctx,
    text: message.content,
    mediaList: [],
  });
  if (!result) {
    throw new Error("expected a built Discord message context");
  }
  return result.ctxPayload;
}

describe("hydrateDiscordMessageIfNeeded", () => {
  it("hydrates partial internal messages without assigning over getters", async () => {
    const { hydrate } = fixture({ id: "1001", channelId: "c1" }, [
      payload({
        content: "hello <@u2>",
        attachments: [{ id: "a1", filename: "note.txt" }],
        embeds: [{ title: "Embed" }],
        mentions: [{ ...user("u2", "bob"), global_name: "Bob Builder" }],
        mention_roles: ["role1"],
        referenced_message: referenced("earlier"),
      }),
    ]);
    const { message } = await hydrate();
    expect(message).toBeInstanceOf(Message);
    expect(message.content).toBe("hello <@u2>");
    expect(message.attachments).toHaveLength(1);
    expect(message.embeds).toHaveLength(1);
    expect(message.mentionedUsers[0]?.globalName).toBe("Bob Builder");
    expect(message.mentionedRoles).toEqual(["role1"]);
    expect(message.referencedMessage?.content).toBe("earlier");
  });

  it("reports current-message hydration failures as unavailable", async () => {
    const { rest, message, hydrate } = fixture(payload({ content: "hello <@123>" }));
    rest.get = vi.fn().mockRejectedValue(new Error("Discord REST unavailable"));
    expect(await hydrate()).toEqual({ kind: "unavailable", message });
  });

  it("fetches empty bot reply context from its referenced channel", async () => {
    const text = "Release repair: https://github.com/example/project/pull/42";
    const { rest, hydrate } = fixture(
      reply({
        referenced_message: referenced(""),
        message_reference: reference(MessageReferenceType.Default, "c2"),
        content: "<@bot> ok do it",
        mentions: [user("bot", "openclaw")],
      }),
      [referenced(text)],
    );
    const { message } = await hydrate();
    expect(rest.calls.map((call) => call.path)).toEqual(["/channels/c2/messages/1000"]);
    expect(message.referencedMessage?.content).toBe(text);
    expect(await context(message)).toMatchObject({ ReplyToId: "1000", ReplyToBody: text });
  });

  it("replaces a mismatched nested reply with the canonical referenced message", async () => {
    const { rest, hydrate } = fixture(staleReply(), [referenced("the canonical reply target")]);
    const { message } = await hydrate();
    expect(rest.calls.map((call) => call.path)).toEqual(["/channels/c1/messages/1000"]);
    expect(message.referencedMessage?.id).toBe("1000");
    expect(message.referencedMessage?.content).toBe("the canonical reply target");
    expect(await context(message)).toMatchObject({
      ReplyToId: "1000",
      ReplyToBody: "the canonical reply target",
    });
  });

  it("discards a mismatched nested reply when canonical hydration fails", async () => {
    const { rest, hydrate } = fixture(staleReply());
    rest.get = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Missing Access"), { status: 403 }));
    const { message } = await hydrate();
    expect(message.referencedMessage).toBeNull();
    const result = await context(message);
    expect(result.ReplyToId).toBe("1000");
    expect(result.ReplyToBody).toBeUndefined();
  });

  it("keeps the original reply message when hydration fetch fails", async () => {
    const { rest, message, hydrate } = fixture(reply());
    const get = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Missing Access"), { status: 403 }));
    rest.get = get;
    const hydrated = await hydrate();
    expect(get).toHaveBeenCalledOnce();
    expect(hydrated.message).toBe(message);
    expect(hydrated.message.referencedMessage).toBeNull();
  });

  it("does not hydrate known-deleted or forwarded references", async () => {
    const deleted = fixture(reply({ referenced_message: null }));
    const forwarded = fixture(
      payload({ message_reference: reference(MessageReferenceType.Forward) }),
    );
    await deleted.hydrate();
    await forwarded.hydrate();
    expect(deleted.rest.calls).toHaveLength(0);
    expect(forwarded.rest.calls).toHaveLength(0);
  });
});
