import { Routes } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
  createChannelWebhook,
  createOwnMessageReaction,
  createThread,
  createUserDmChannel,
  deleteChannelMessage,
  deleteOwnMessageReaction,
  getCurrentUser,
  getChannelMessage,
  getUser,
  editChannelMessage,
  listMessageReactionUsers,
  listGuildEmojis,
  pinChannelMessage,
  unpinChannelMessage,
} from "./discord.js";
import { createFakeRestClient } from "./test-builders.test-support.js";

describe("Discord REST API helpers", () => {
  it("routes message helpers through the typed REST client", async () => {
    const rest = createFakeRestClient([{ id: "m2" }, { id: "t1" }, undefined, undefined]);
    const messageId = "18446744073709551615";

    await expect(getChannelMessage(rest, "c1", ` ${messageId} `)).resolves.toEqual({ id: "m2" });
    await expect(
      createThread(rest, "c1", { body: { name: "thread" } }, ` ${messageId} `),
    ).resolves.toEqual({ id: "t1" });
    await pinChannelMessage(rest, "c1", ` ${messageId} `);
    await deleteChannelMessage(rest, "c1", ` ${messageId} `);

    expect(rest.calls).toEqual([
      { method: "GET", path: Routes.channelMessage("c1", messageId) },
      {
        method: "POST",
        path: Routes.threads("c1", messageId),
        data: { body: { name: "thread" } },
      },
      { method: "PUT", path: Routes.channelPin("c1", messageId) },
      { method: "DELETE", path: Routes.channelMessage("c1", messageId) },
    ]);
  });

  it.each([
    [
      "get message",
      (rest: ReturnType<typeof createFakeRestClient>) => getChannelMessage(rest, "c1", ".."),
    ],
    [
      "edit message",
      (rest: ReturnType<typeof createFakeRestClient>) =>
        editChannelMessage(rest, "c1", "..", { body: { content: "hello" } }),
    ],
    [
      "delete message",
      (rest: ReturnType<typeof createFakeRestClient>) => deleteChannelMessage(rest, "c1", ".."),
    ],
    [
      "pin message",
      (rest: ReturnType<typeof createFakeRestClient>) => pinChannelMessage(rest, "c1", ".."),
    ],
    [
      "unpin message",
      (rest: ReturnType<typeof createFakeRestClient>) => unpinChannelMessage(rest, "c1", ".."),
    ],
    [
      "create message-backed thread",
      (rest: ReturnType<typeof createFakeRestClient>) =>
        createThread(rest, "c1", { body: { name: "thread" } }, ".."),
    ],
    [
      "add reaction",
      (rest: ReturnType<typeof createFakeRestClient>) =>
        createOwnMessageReaction(rest, "c1", "..", "%E2%9C%85"),
    ],
    [
      "remove reaction",
      (rest: ReturnType<typeof createFakeRestClient>) =>
        deleteOwnMessageReaction(rest, "c1", "..", "%E2%9C%85"),
    ],
    [
      "list reactions",
      (rest: ReturnType<typeof createFakeRestClient>) =>
        listMessageReactionUsers(rest, "c1", "..", "%E2%9C%85"),
    ],
  ])("rejects a malformed message ID before the %s request", async (_label, invoke) => {
    const rest = createFakeRestClient();

    await expect(invoke(rest)).rejects.toThrow("Invalid Discord message ID");

    expect(rest.calls).toEqual([]);
  });

  it("accepts guild emoji responses at the Discord REST boundary", async () => {
    const rest = createFakeRestClient([[{ id: "emoji1", name: "party", animated: true }]]);
    await expect(listGuildEmojis(rest, "g1")).resolves.toEqual([
      { id: "emoji1", name: "party", animated: true },
    ]);
    expect(rest.calls).toEqual([{ method: "GET", path: Routes.guildEmojis("g1") }]);
  });

  it("rejects malformed guild emoji responses at the Discord REST boundary", async () => {
    await expect(listGuildEmojis(createFakeRestClient([{ invalid: true }]), "g1")).rejects.toThrow(
      "Invalid Discord guild emoji response.",
    );
  });

  it("routes user helpers through the typed REST client", async () => {
    const rest = createFakeRestClient([{ id: "me" }, { id: "u1" }, { id: "dm1" }]);

    await expect(getCurrentUser(rest)).resolves.toEqual({ id: "me" });
    await expect(getUser(rest, "u1")).resolves.toEqual({ id: "u1" });
    await expect(createUserDmChannel(rest, "u1")).resolves.toEqual({ id: "dm1" });

    expect(rest.calls).toEqual([
      { method: "GET", path: Routes.user("@me") },
      { method: "GET", path: Routes.user("u1") },
      {
        method: "POST",
        path: Routes.userChannels(),
        data: { body: { recipient_id: "u1" } },
      },
    ]);
  });

  it("routes reaction helpers through the typed REST client", async () => {
    const rest = createFakeRestClient([undefined, [{ id: "u1" }], undefined]);
    const query = { limit: 10 };
    const messageId = "18446744073709551615";

    await createOwnMessageReaction(rest, "c1", ` ${messageId} `, "%F0%9F%91%8D");
    await expect(
      listMessageReactionUsers(rest, "c1", ` ${messageId} `, "%F0%9F%91%8D", query),
    ).resolves.toEqual([{ id: "u1" }]);
    await deleteOwnMessageReaction(rest, "c1", ` ${messageId} `, "%F0%9F%91%8D");

    expect(rest.calls).toEqual([
      {
        method: "PUT",
        path: Routes.channelMessageOwnReaction("c1", messageId, "%F0%9F%91%8D"),
      },
      {
        method: "GET",
        path: Routes.channelMessageReaction("c1", messageId, "%F0%9F%91%8D"),
        query,
      },
      {
        method: "DELETE",
        path: Routes.channelMessageOwnReaction("c1", messageId, "%F0%9F%91%8D"),
      },
    ]);
  });

  it("routes webhook helper through the typed REST client", async () => {
    const rest = createFakeRestClient([{ id: "wh1", token: "token1" }]);

    await expect(createChannelWebhook(rest, "c1", { body: { name: "OpenClaw" } })).resolves.toEqual(
      {
        id: "wh1",
        token: "token1",
      },
    );

    expect(rest.calls).toEqual([
      {
        method: "POST",
        path: Routes.channelWebhooks("c1"),
        data: { body: { name: "OpenClaw" } },
      },
    ]);
  });
});
