import { Routes } from "discord-api-types/v10";
import { expect, it } from "vitest";
import * as api from "./discord.js";
import { createFakeRestClient } from "./test-builders.test-support.js";

const messageId = "18446744073709551615";
const paddedId = ` ${messageId} `;
const messagePath = `/channels/c1/messages/${messageId}`;
const pinPath = `/channels/c1/messages/pins/${messageId}`;
const emoji = "%F0%9F%91%8D";
const reactionPath = `${messagePath}/reactions/${emoji}`;

it("routes message helpers through the typed REST client", async () => {
  const rest = createFakeRestClient([{ id: "m2" }, { id: "t1" }, undefined, undefined]);
  const data = { body: { name: "thread" } };
  await expect(api.getChannelMessage(rest, "c1", paddedId)).resolves.toEqual({ id: "m2" });
  await expect(api.createThread(rest, "c1", data, paddedId)).resolves.toEqual({ id: "t1" });
  await api.pinChannelMessage(rest, "c1", paddedId);
  await api.deleteChannelMessage(rest, "c1", paddedId);
  expect(rest.calls).toEqual([
    { method: "GET", path: messagePath },
    { method: "POST", path: `${messagePath}/threads`, data },
    { method: "PUT", path: pinPath },
    { method: "DELETE", path: messagePath },
  ]);
});

it.each([
  [
    "edit message",
    (rest: ReturnType<typeof createFakeRestClient>) =>
      api.editChannelMessage(rest, "c1", "..", { body: { content: "hello" } }),
  ],
  [
    "unpin message",
    (rest: ReturnType<typeof createFakeRestClient>) => api.unpinChannelMessage(rest, "c1", ".."),
  ],
])("rejects a malformed message ID before the %s request", async (_label, invoke) => {
  const rest = createFakeRestClient();

  await expect(invoke(rest)).rejects.toThrow("Invalid Discord message ID");

  expect(rest.calls).toEqual([]);
});

it("accepts guild emoji responses at the Discord REST boundary", async () => {
  const emojis = [{ id: "emoji1", name: "party", animated: true }];
  const rest = createFakeRestClient([emojis]);
  await expect(api.listGuildEmojis(rest, "g1")).resolves.toEqual([
    { id: "emoji1", name: "party", animated: true },
  ]);
  expect(rest.calls).toEqual([{ method: "GET", path: "/guilds/g1/emojis" }]);
});

it("rejects malformed guild emoji responses at the Discord REST boundary", async () => {
  await expect(
    api.listGuildEmojis(createFakeRestClient([{ invalid: true }]), "g1"),
  ).rejects.toThrow("Invalid Discord guild emoji response.");
});

it("routes user helpers through the typed REST client", async () => {
  const rest = createFakeRestClient([{ id: "me" }, { id: "u1" }, { id: "dm1" }]);

  await expect(api.getCurrentUser(rest)).resolves.toEqual({ id: "me" });
  await expect(api.getUser(rest, "u1")).resolves.toEqual({ id: "u1" });
  await expect(api.createUserDmChannel(rest, "u1")).resolves.toEqual({ id: "dm1" });

  expect(rest.calls).toEqual([
    { method: "GET", path: Routes.user("@me") },
    { method: "GET", path: "/users/u1" },
    { method: "POST", path: "/users/@me/channels", data: { body: { recipient_id: "u1" } } },
  ]);
});

it("routes reaction helpers through the typed REST client", async () => {
  const rest = createFakeRestClient([undefined, [{ id: "u1" }], undefined]);
  const query = { limit: 10 };
  await api.createOwnMessageReaction(rest, "c1", paddedId, emoji);
  await expect(api.listMessageReactionUsers(rest, "c1", paddedId, emoji, query)).resolves.toEqual([
    { id: "u1" },
  ]);
  await api.deleteOwnMessageReaction(rest, "c1", paddedId, emoji);
  expect(rest.calls).toEqual([
    { method: "PUT", path: `${reactionPath}/@me` },
    { method: "GET", path: reactionPath, query },
    { method: "DELETE", path: `${reactionPath}/@me` },
  ]);
});
