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

function payload(overrides = {}) {
  return {
    ...createDiscordMessage({
      id: "1001",
      channelId: "c1",
      content: "what did this mean?",
      timestamp: "2026-01-01T00:00:00.000Z",
      author: { id: "u1", username: "alice", bot: false },
    }).rawData,
    ...overrides,
  };
}
function reference(type = MessageReferenceType.Default, channel_id = "c1") {
  return { type, message_id: "1000", channel_id };
}
function reply(overrides = {}) {
  return payload({ message_reference: reference(), type: MessageType.Reply, ...overrides });
}
function referenced(content: string, overrides = {}) {
  return payload({
    id: "1000",
    content,
    author: { id: "u2", username: "bob", bot: true },
    ...overrides,
  });
}
function staleReply() {
  return reply({ referenced_message: referenced("older context", { id: "stale" }) });
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
  const text = message.content;
  const ctx = await createBaseDiscordMessageContext({
    discordConfig: { allowBots: false },
    botUserId: "bot",
    message,
    author: message.author,
    baseText: text,
    messageText: text,
  });
  const result = await buildDiscordMessageProcessContext({ ctx, text, mediaList: [] });
  expect(result).not.toBeNull();
  return result!.ctxPayload;
}

describe("hydrateDiscordMessageIfNeeded", () => {
  it("hydrates partial internal messages without assigning over getters", async () => {
    const { hydrate } = fixture({ id: "1001", channelId: "c1" }, [
      payload({
        content: "hello <@u2>",
        attachments: [{ id: "a1", filename: "note.txt" }],
        embeds: [{ title: "Embed" }],
        mentions: [{ id: "u2", username: "bob", global_name: "Bob Builder" }],
        mention_roles: ["role1"],
        referenced_message: referenced("earlier"),
      }),
    ]);
    const { message } = await hydrate();
    expect(message).toBeInstanceOf(Message);
    expect(message).toMatchObject({
      content: "hello <@u2>",
      attachments: [expect.anything()],
      embeds: [expect.anything()],
      mentionedUsers: [{ globalName: "Bob Builder" }],
      mentionedRoles: ["role1"],
      referencedMessage: { content: "earlier" },
    });
  });

  it("fetches empty bot reply context from its referenced channel", async () => {
    const text = "Release repair: https://github.com/example/project/pull/42";
    const { rest, hydrate } = fixture(
      reply({
        referenced_message: referenced(""),
        message_reference: reference(MessageReferenceType.Default, "c2"),
        content: "<@bot> ok do it",
        mentions: [{ id: "bot", username: "openclaw" }],
      }),
      [referenced(text)],
    );
    const { message } = await hydrate();
    expect(rest.calls.map((call) => call.path)).toEqual(["/channels/c2/messages/1000"]);
    expect(message.referencedMessage?.content).toBe(text);
    expect(await context(message)).toMatchObject({ ReplyToId: "1000", ReplyToBody: text });
  });

  it("replaces a mismatched nested reply with the canonical referenced message", async () => {
    const text = "the canonical reply target";
    const { rest, hydrate } = fixture(staleReply(), [referenced(text)]);
    const { message } = await hydrate();
    expect(rest.calls.map((call) => call.path)).toEqual(["/channels/c1/messages/1000"]);
    expect(message.referencedMessage).toMatchObject({ id: "1000", content: text });
    expect(await context(message)).toMatchObject({ ReplyToId: "1000", ReplyToBody: text });
  });

  it.each(["missing", "mismatched"])("handles failed %s reply hydration", async (state) => {
    const test = fixture(state === "missing" ? reply() : staleReply());
    const error = Object.assign(new Error("Forbidden"), { status: 403 });
    const get = vi.fn().mockRejectedValue(error);
    test.rest.get = get;
    const { message } = await test.hydrate();
    expect(get).toHaveBeenCalledOnce();
    expect(message.referencedMessage).toBeNull();
    if (state === "missing") {
      expect(message).toBe(test.message);
    } else {
      const result = await context(message);
      expect({ id: result.ReplyToId, body: result.ReplyToBody }).toEqual({
        id: "1000",
        body: undefined,
      });
    }
  });

  it.each([
    () => reply({ referenced_message: null }),
    () => payload({ message_reference: reference(MessageReferenceType.Forward) }),
  ])("does not hydrate known-deleted or forwarded reference %#", async (raw) => {
    const test = fixture(raw());
    await test.hydrate();
    expect(test.rest.calls).toHaveLength(0);
  });
});
