import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async (path: string) => {
    if (!store.has(path)) {
      throw new Error("ENOENT");
    }
    return store.get(path) ?? "";
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    store.set(path, content);
  }),
  rename: vi.fn(async (from: string, to: string) => {
    const value = store.get(from);
    if (value == null) throw new Error("ENOENT");
    store.set(to, value);
    store.delete(from);
  }),
}));

describe("discord instance claims", () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });

  it("treats guild-wide claims as owned even when channels are not enumerated", async () => {
    const claims = await import("./instance-claims.js");
    const botId = "1483062961550393496";
    const guildId = "1483039227997585439";

    await claims.refreshDiscordClaims({
      accountId: "default",
      configPath: "/Users/test/.openclaw/openclaw.json",
      botId,
      guildEntries: {
        [guildId]: {
          id: guildId,
          channels: {},
        },
      },
    });

    await expect(
      claims.resolveDiscordClaimOwnership({
        accountId: "default",
        configPath: "/Users/test/.openclaw/openclaw.json",
        botId,
        guildId,
        channelId: "1483321827781644319",
      }),
    ).resolves.toMatchObject({
      status: "owned",
      instanceKey: "openclaw-main",
      matchedChannelId: guildId,
    });

    await expect(
      claims.resolveDiscordClaimOwnership({
        accountId: "default",
        configPath: "/Users/test/.openclaw-rescue/openclaw.json",
        botId,
        guildId,
        channelId: "1483321827781644319",
      }),
    ).resolves.toMatchObject({
      status: "claimed-by-other",
      instanceKey: "openclaw-rescue",
      ownerInstanceKey: "openclaw-main",
      matchedChannelId: guildId,
    });
  });

  it("does not promote channel-scoped guild entries into guild-wide claims", async () => {
    const claims = await import("./instance-claims.js");
    const botId = "1483062961550393496";
    const guildId = "1483039227997585439";
    const mainChannel = "1483321827781644319";
    const rescueChannel = "1483059582044606557";

    await claims.refreshDiscordClaims({
      accountId: "default",
      configPath: "/Users/test/.openclaw/openclaw.json",
      botId,
      guildEntries: {
        [guildId]: { id: guildId, channels: { [mainChannel]: {} } },
      },
    });

    await claims.refreshDiscordClaims({
      accountId: "default",
      configPath: "/Users/test/.openclaw-rescue/openclaw.json",
      botId,
      guildEntries: {
        [guildId]: { id: guildId, channels: { [rescueChannel]: {} } },
      },
    });

    await expect(
      claims.resolveDiscordClaimOwnership({
        accountId: "default",
        configPath: "/Users/test/.openclaw-rescue/openclaw.json",
        botId,
        guildId,
        channelId: rescueChannel,
      }),
    ).resolves.toMatchObject({
      status: "owned",
      instanceKey: "openclaw-rescue",
      matchedChannelId: rescueChannel,
    });

    await expect(
      claims.resolveDiscordClaimOwnership({
        accountId: "default",
        configPath: "/Users/test/.openclaw-rescue/openclaw.json",
        botId,
        guildId,
        channelId: mainChannel,
      }),
    ).resolves.toMatchObject({
      status: "not-owned",
      instanceKey: "openclaw-rescue",
    });
  });
});
