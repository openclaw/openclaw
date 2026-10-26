import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Client, User } from "../internal/discord.js";

const mocks = vi.hoisted(() => ({
  saveRemoteMedia: vi.fn(),
  logDebug: vi.fn(),
}));

// mock-isolation: Deferred avatar downloads exclude real network and media-storage effects.
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({ saveRemoteMedia: mocks.saveRemoteMedia }));

// mock-isolation: Capture resolver diagnostics without writing to runtime log sinks.
vi.mock("openclaw/plugin-sdk/logging-core", () => ({ logDebug: mocks.logDebug }));

const { createDiscordAvatarResolver } = await import("./message-avatar.js");

const emptyClient = { fetchGuild: vi.fn() } as unknown as Client;

function avatarScenario(client = emptyClient, guildId?: string) {
  const resolver = createDiscordAvatarResolver();
  const params = {
    client,
    guildId,
    conversationId: guildId ? "channel-1" : "dm-1",
    author: { id: "user-1", avatar: guildId ? "sender-hash" : "hash-1" } as User,
  };
  return (avatar = params.author.avatar) =>
    resolver.resolve({ ...params, author: { ...params.author, avatar } });
}

beforeEach(() => {
  mocks.saveRemoteMedia.mockReset();
  mocks.logDebug.mockReset();
});

afterEach(() => {
  delete process.env.DISCORD_API_URL;
});

it("downloads a DM avatar in the background and reuses it until the hash changes", async () => {
  const firstDownload = createDeferred<{ path: string }>();
  mocks.saveRemoteMedia.mockReturnValueOnce(firstDownload.promise);
  const resolve = avatarScenario();
  expect(resolve()).toBeUndefined();
  expect(resolve()).toBeUndefined();
  expect(mocks.saveRemoteMedia).toHaveBeenCalledTimes(1);
  expect(mocks.saveRemoteMedia.mock.calls[0][0]).toMatchObject({
    url: "https://cdn.discordapp.com/avatars/user-1/hash-1.png?size=128",
    maxBytes: 256 * 1024,
    ssrfPolicy: expect.objectContaining({
      hostnameAllowlist: expect.arrayContaining(["cdn.discordapp.com"]),
    }),
  });

  firstDownload.resolve({ path: "/media/inbound/dm-avatar.png" });
  await vi.waitFor(() => expect(resolve()).toBe("/media/inbound/dm-avatar.png"));

  mocks.saveRemoteMedia.mockResolvedValueOnce({ path: "/media/inbound/dm-avatar-new.png" });
  expect(resolve("hash-2")).toBeUndefined();
  expect(mocks.saveRemoteMedia).toHaveBeenCalledTimes(2);
});

it("uses a lazily fetched guild icon instead of the sender avatar", async () => {
  const fetchGuild = vi.fn().mockResolvedValue({ icon: "guild-hash" });
  mocks.saveRemoteMedia.mockResolvedValueOnce({ path: "/media/inbound/guild-icon.png" });
  const resolve = avatarScenario({ fetchGuild } as unknown as Client, "guild-1");
  expect(resolve()).toBeUndefined();
  expect(mocks.saveRemoteMedia).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(resolve()).toBe("/media/inbound/guild-icon.png"));
  expect(mocks.saveRemoteMedia.mock.calls[0][0].url).toBe(
    "https://cdn.discordapp.com/icons/guild-1/guild-hash.png?size=128",
  );
  expect(fetchGuild).toHaveBeenCalledTimes(1);
});

it("does not fall back to the public CDN when an API override is configured", async () => {
  const client = {
    fetchGuild: vi.fn().mockResolvedValue({ icon: "guild-hash" }),
  } as unknown as Client;
  process.env.DISCORD_API_URL = "http://127.0.0.1:43210/api/v10";
  avatarScenario(client, "guild-1")();
  await vi.waitFor(() => expect(mocks.logDebug).toHaveBeenCalled());
  expect(mocks.saveRemoteMedia).not.toHaveBeenCalled();
});

it("swallows download failures and retries on the next message", async () => {
  mocks.saveRemoteMedia
    .mockRejectedValueOnce(new Error("download failed"))
    .mockResolvedValueOnce({ path: "/media/inbound/retried.png" });
  const resolve = avatarScenario();

  expect(resolve()).toBeUndefined();
  await vi.waitFor(() => expect(mocks.logDebug).toHaveBeenCalled());
  expect(resolve()).toBeUndefined();
  await vi.waitFor(() => expect(mocks.saveRemoteMedia).toHaveBeenCalledTimes(2));
});
