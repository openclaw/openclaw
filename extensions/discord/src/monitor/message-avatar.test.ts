import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const DISCORD_API_URL_ENV = "DISCORD_API_URL";

function avatarScenario(client = emptyClient, guildId?: string) {
  const resolver = createDiscordAvatarResolver();
  const params = {
    client,
    guildId,
    conversationId: guildId ? "channel-1" : "dm-1",
    author: { id: "user-1", avatar: guildId ? "sender-hash" : "hash-1" } as User,
  };
  return (author = params.author) => resolver.resolve({ ...params, author });
}

beforeEach(() => vi.resetAllMocks());

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[DISCORD_API_URL_ENV];
});

describe("createDiscordAvatarResolver", () => {
  it("downloads a DM avatar in the background and reuses it until the hash changes", async () => {
    const firstDownload = createDeferred<{ path: string }>();
    mocks.saveRemoteMedia.mockReturnValueOnce(firstDownload.promise);
    const resolve = avatarScenario();
    expect(resolve()).toBeUndefined();
    expect(resolve()).toBeUndefined();
    expect(mocks.saveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mocks.saveRemoteMedia).toHaveBeenCalledWith({
      url: "https://cdn.discordapp.com/avatars/user-1/hash-1.png?size=128",
      filePathHint: "conversation-avatar.png",
      maxBytes: 256 * 1024,
      ssrfPolicy: expect.objectContaining({
        hostnameAllowlist: expect.arrayContaining(["cdn.discordapp.com"]),
      }),
    });

    firstDownload.resolve({ path: "/media/inbound/dm-avatar.png" });
    await vi.waitFor(() => expect(resolve()).toBe("/media/inbound/dm-avatar.png"));

    mocks.saveRemoteMedia.mockResolvedValueOnce({ path: "/media/inbound/dm-avatar-new.png" });
    expect(resolve({ id: "user-1", avatar: "hash-2" } as User)).toBeUndefined();
    expect(mocks.saveRemoteMedia).toHaveBeenCalledTimes(2);
  });

  it("lazily reuses the guild icon across wall-clock steps instead of the sender avatar", async () => {
    const guildLookup = createDeferred<{ icon: string }>();
    const guildDownload = createDeferred<{ path: string }>();
    const fetchGuild = vi.fn(() => guildLookup.promise);
    const client = { fetchGuild } as unknown as Client;
    mocks.saveRemoteMedia.mockReturnValueOnce(guildDownload.promise);
    const resolve = avatarScenario(client, "guild-1");
    expect(resolve()).toBeUndefined();
    expect(fetchGuild).toHaveBeenCalledTimes(1);
    expect(mocks.saveRemoteMedia).not.toHaveBeenCalled();

    guildLookup.resolve({ icon: "guild-hash" });
    await vi.waitFor(() => expect(mocks.saveRemoteMedia).toHaveBeenCalledTimes(1));
    expect(mocks.saveRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://cdn.discordapp.com/icons/guild-1/guild-hash.png?size=128",
      }),
    );

    guildDownload.resolve({ path: "/media/inbound/guild-icon.png" });
    await vi.waitFor(() => expect(resolve()).toBe("/media/inbound/guild-icon.png"));
    expect(fetchGuild).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const wallClock = vi.spyOn(Date, "now");
    for (const offset of [-10 * 60_000, 10 * 60_000]) {
      wallClock.mockReturnValue(now + offset);
      expect(resolve()).toBe("/media/inbound/guild-icon.png");
      expect(fetchGuild).toHaveBeenCalledTimes(1);
    }
  });

  it("does not fall back to the public CDN when an API override is configured", async () => {
    const client = { fetchGuild: async () => ({ icon: "guild-hash" }) } as unknown as Client;
    process.env[DISCORD_API_URL_ENV] = "http://127.0.0.1:43210/api/v10";
    avatarScenario(client, "guild-1")();
    await vi.waitFor(() =>
      expect(mocks.logDebug).toHaveBeenCalledWith(
        expect.stringContaining("outside the configured REST origin"),
      ),
    );
    expect(mocks.saveRemoteMedia).not.toHaveBeenCalled();
  });

  it("swallows download failures and retries on the next message", async () => {
    mocks.saveRemoteMedia
      .mockRejectedValueOnce(new Error("download failed"))
      .mockResolvedValueOnce({ path: "/media/inbound/retried.png" });
    const resolve = avatarScenario();

    expect(resolve()).toBeUndefined();
    await vi.waitFor(() =>
      expect(mocks.logDebug).toHaveBeenCalledWith(expect.stringContaining("download failed")),
    );
    expect(resolve()).toBeUndefined();
    await vi.waitFor(() => expect(mocks.saveRemoteMedia).toHaveBeenCalledTimes(2));
  });
});
