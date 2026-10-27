import { GatewayDispatchEvents } from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Client } from "./client.js";
import { attachRestMock, createInternalTestClient } from "./test-builders.test-support.js";

let client: Client;
const get = vi.fn(async (route: string) => ({ id: route.split("/").pop() ?? "x" }));
const emojis = [{ name: "party", identifier: "party:1" }];
const fetchEmojis = vi.fn(async () => emojis);
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  client = createInternalTestClient();
  attachRestMock(client, { get });
});
afterEach(() => vi.useRealTimers());

it("caps entries by dropping oldest on insert past 5,000 entries", async () => {
  for (let index = 0; index < 5_000; index += 1) {
    await client.fetchUser(`u${index}`);
  }
  await client.fetchUser("u0");
  await client.fetchUser("u4999");
  expect(get).toHaveBeenCalledTimes(5_000);
  await client.fetchUser("new-user");
  await client.fetchUser("u0");
  expect(get).toHaveBeenCalledTimes(5_002);
});

it("sweeps expired late responses before evicting fresh entries at capacity", async () => {
  await client.fetchUser("initial-expired");
  const delayed = createDeferred<{ id: string }>();
  get.mockImplementationOnce(() => delayed.promise);
  const slowFetch = client.fetchUser("delayed-expired");
  // A slow response inserts its already-expired entry after the fresh ones.
  // Sweeping must reclaim it before the capacity cap evicts a fresh survivor.
  vi.advanceTimersByTime(20_000);
  for (let index = 0; index < 4_999; index += 1) {
    await client.fetchUser(`fresh-${index}`);
  }
  vi.advanceTimersByTime(10_000);
  delayed.resolve({ id: "delayed-expired" });
  await slowFetch;
  await client.fetchUser("trigger-sweep");
  expect(get).toHaveBeenCalledTimes(5_002);
  await client.fetchUser("fresh-0");
  expect(get).toHaveBeenCalledTimes(5_002);
});

it("reuses normalized guild emojis until their cache entry expires", async () => {
  expect(await client.fetchGuildEmojis("g1", fetchEmojis)).toEqual([
    { name: "party", identifier: "party:1" },
  ]);
  await client.fetchGuildEmojis("g1", fetchEmojis);
  expect(fetchEmojis).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(30_000);
  await client.fetchGuildEmojis("g1", fetchEmojis);
  expect(fetchEmojis).toHaveBeenCalledTimes(2);
});

it("invalidates only the updated guild's normalized emoji list", async () => {
  await client.fetchGuildEmojis("g1", fetchEmojis);
  await client.fetchGuildEmojis("g2", fetchEmojis);
  await client.dispatchGatewayEvent(GatewayDispatchEvents.GuildEmojisUpdate, { guild_id: "g1" });
  await client.fetchGuildEmojis("g1", fetchEmojis);
  await client.fetchGuildEmojis("g2", fetchEmojis);

  expect(fetchEmojis).toHaveBeenCalledTimes(3);
});

it("invalidates member and user entries for GuildMemberUpdate", async () => {
  await client.fetchMember("g1", "u1");
  await client.fetchUser("u1");
  await client.fetchMember("g1", "u1");
  await client.fetchUser("u1");
  expect(get).toHaveBeenCalledTimes(2);

  await client.dispatchGatewayEvent(GatewayDispatchEvents.GuildMemberUpdate, {
    guild_id: "g1",
    user: { id: "u1" },
  });

  await client.fetchMember("g1", "u1");
  await client.fetchUser("u1");
  expect(get).toHaveBeenCalledTimes(4);
});
