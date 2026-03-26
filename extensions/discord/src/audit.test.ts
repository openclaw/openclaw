import { describe, expect, it, vi } from "vitest";

const sendModule = await import("./send.js");
const fetchChannelPermissionsDiscordMock = vi.fn();
vi.spyOn(sendModule, "fetchChannelPermissionsDiscord").mockImplementation(
  fetchChannelPermissionsDiscordMock,
);

describe("discord audit", () => {
  it("collects numeric channel ids and counts unresolved keys", async () => {
    const { collectDiscordAuditChannelIds, auditDiscordChannelPermissions } =
      await import("./audit.js");

    const cfg = {
      channels: {
        discord: {
          enabled: true,
          token: "t",
          groupPolicy: "allowlist",
          guilds: {
            "123": {
              channels: {
                "111": { allow: true },
                general: { allow: true },
                "222": { allow: false },
              },
            },
          },
        },
      },
    } as unknown as import("../../../src/config/config.js").OpenClawConfig;

    const collected = collectDiscordAuditChannelIds({
      cfg,
      accountId: "default",
    });
    expect(collected.channelIds).toEqual(["111"]);
    expect(collected.unresolvedChannels).toBe(1);

    fetchChannelPermissionsDiscordMock.mockResolvedValueOnce({
      channelId: "111",
      permissions: ["ViewChannel"],
      raw: "0",
      isDm: false,
    });

    const audit = await auditDiscordChannelPermissions({
      token: "t",
      accountId: "default",
      channelIds: collected.channelIds,
      timeoutMs: 1000,
    });
    expect(audit.ok).toBe(false);
    expect(audit.channels[0]?.channelId).toBe("111");
    expect(audit.channels[0]?.missing).toContain("SendMessages");
  });

  it("does not count '*' wildcard key as unresolved channel", async () => {
    const { collectDiscordAuditChannelIds } = await import("./audit.js");

    const cfg = {
      channels: {
        discord: {
          enabled: true,
          token: "t",
          groupPolicy: "allowlist",
          guilds: {
            "123": {
              channels: {
                "111": { allow: true },
                "*": { allow: true },
              },
            },
          },
        },
      },
    } as unknown as import("../../../src/config/config.js").OpenClawConfig;

    const collected = collectDiscordAuditChannelIds({ cfg, accountId: "default" });
    expect(collected.channelIds).toEqual(["111"]);
    expect(collected.unresolvedChannels).toBe(0);
  });

  it("handles guild with only '*' wildcard and no numeric channel ids", async () => {
    const { collectDiscordAuditChannelIds } = await import("./audit.js");

    const cfg = {
      channels: {
        discord: {
          enabled: true,
          token: "t",
          groupPolicy: "allowlist",
          guilds: {
            "123": {
              channels: {
                "*": { allow: true },
              },
            },
          },
        },
      },
    } as unknown as import("../../../src/config/config.js").OpenClawConfig;

    const collected = collectDiscordAuditChannelIds({ cfg, accountId: "default" });
    expect(collected.channelIds).toEqual([]);
    expect(collected.unresolvedChannels).toBe(0);
  });

  it("collects audit channel ids without resolving SecretRef-backed Discord tokens", async () => {
    const { collectDiscordAuditChannelIds } = await import("./audit.js");

    const cfg = {
      channels: {
        discord: {
          enabled: true,
          token: {
            source: "env",
            provider: "default",
            id: "DISCORD_BOT_TOKEN",
          },
          guilds: {
            "123": {
              channels: {
                "111": { allow: true },
                general: { allow: true },
              },
            },
          },
        },
      },
    } as unknown as import("../../../src/config/config.js").OpenClawConfig;

    const collected = collectDiscordAuditChannelIds({ cfg, accountId: "default" });
    expect(collected.channelIds).toEqual(["111"]);
    expect(collected.unresolvedChannels).toBe(1);
  });
});
