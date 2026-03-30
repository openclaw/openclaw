import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as directoryLive from "./directory-live.js";
import {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "./group-policy.js";
import { normalizeDiscordMessagingTarget } from "./normalize.js";
import {
  parseDiscordTarget,
  resolveDiscordChannelId,
  resolveDiscordTarget,
  resolveDiscordTargetForMessaging,
} from "./targets.js";

describe("parseDiscordTarget", () => {
  it("parses user mention and prefixes", () => {
    const cases = [
      { input: "<@123>", id: "123", normalized: "user:123" },
      { input: "<@!456>", id: "456", normalized: "user:456" },
      { input: "user:789", id: "789", normalized: "user:789" },
      { input: "discord:987", id: "987", normalized: "user:987" },
    ] as const;
    for (const testCase of cases) {
      expect(parseDiscordTarget(testCase.input), testCase.input).toMatchObject({
        kind: "user",
        id: testCase.id,
        normalized: testCase.normalized,
      });
    }
  });

  it("parses channel targets", () => {
    const cases = [
      { input: "channel:555", id: "555", normalized: "channel:555" },
      { input: "general", id: "general", normalized: "channel:general" },
    ] as const;
    for (const testCase of cases) {
      expect(parseDiscordTarget(testCase.input), testCase.input).toMatchObject({
        kind: "channel",
        id: testCase.id,
        normalized: testCase.normalized,
      });
    }
  });

  it("accepts numeric ids when a default kind is provided", () => {
    expect(parseDiscordTarget("123", { defaultKind: "channel" })).toMatchObject({
      kind: "channel",
      id: "123",
      normalized: "channel:123",
    });
  });

  it("rejects invalid parse targets", () => {
    const cases = [
      { input: "123", expectedMessage: /Ambiguous Discord recipient/ },
      { input: "@bob", expectedMessage: /Discord DMs require a user id/ },
    ] as const;
    for (const testCase of cases) {
      expect(() => parseDiscordTarget(testCase.input), testCase.input).toThrow(
        testCase.expectedMessage,
      );
    }
  });
});

describe("resolveDiscordChannelId", () => {
  it("strips channel: prefix and accepts raw ids", () => {
    expect(resolveDiscordChannelId("channel:123")).toBe("123");
    expect(resolveDiscordChannelId("123")).toBe("123");
  });

  it("rejects user targets", () => {
    expect(() => resolveDiscordChannelId("user:123")).toThrow(/channel id is required/i);
  });
});

describe("resolveDiscordTarget", () => {
  const cfg = { channels: { discord: {} } } as OpenClawConfig;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a resolved user for usernames", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([
      { kind: "user", id: "user:999", name: "Jane" } as const,
    ]);

    await expect(
      resolveDiscordTarget("jane", { cfg, accountId: "default" }),
    ).resolves.toMatchObject({ kind: "user", id: "999", normalized: "user:999" });
  });

  it("falls back to parsing when lookup misses", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([]);
    await expect(
      resolveDiscordTarget("general", { cfg, accountId: "default" }),
    ).resolves.toMatchObject({ kind: "channel", id: "general" });
  });

  it("does not call directory lookup for explicit user ids", async () => {
    const listPeers = vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive");
    await expect(
      resolveDiscordTarget("user:123", { cfg, accountId: "default" }),
    ).resolves.toMatchObject({ kind: "user", id: "123" });
    expect(listPeers).not.toHaveBeenCalled();
  });
});

describe("normalizeDiscordMessagingTarget", () => {
  it("defaults raw numeric ids to channels", () => {
    expect(normalizeDiscordMessagingTarget("123")).toBe("channel:123");
  });
});

describe("resolveDiscordTargetForMessaging", () => {
  const cfg = { channels: { discord: {} } } as OpenClawConfig;

  it("resolves explicit user: prefixed targets", async () => {
    const result = await resolveDiscordTargetForMessaging({
      cfg,
      accountId: "default",
      input: "user:123",
      normalized: "user:123",
    });

    expect(result).toEqual({
      to: "user:123",
      kind: "user",
      display: "123",
      source: "normalized",
    });
  });

  it("resolves explicit channel: prefixed targets", async () => {
    const result = await resolveDiscordTargetForMessaging({
      cfg,
      accountId: "default",
      input: "channel:456",
      normalized: "channel:456",
    });

    expect(result).toEqual({
      to: "channel:456",
      kind: "channel",
      display: "456",
      source: "normalized",
    });
  });

  it("resolves user mentions (<@ID>)", async () => {
    const result = await resolveDiscordTargetForMessaging({
      cfg,
      accountId: "default",
      input: "<@789>",
      normalized: "<@789>",
    });

    expect(result).toEqual({
      to: "user:789",
      kind: "user",
      display: "789",
      source: "normalized",
    });
  });

  it("resolves user mentions with ! (<@!ID>)", async () => {
    const result = await resolveDiscordTargetForMessaging({
      cfg,
      accountId: "default",
      input: "<@!999>",
      normalized: "<@!999>",
    });

    expect(result).toEqual({
      to: "user:999",
      kind: "user",
      display: "999",
      source: "normalized",
    });
  });

  it("resolves discord: prefixed targets as users", async () => {
    const result = await resolveDiscordTargetForMessaging({
      cfg,
      accountId: "default",
      input: "discord:111",
      normalized: "discord:111",
    });

    expect(result).toEqual({
      to: "user:111",
      kind: "user",
      display: "111",
      source: "normalized",
    });
  });

  it("returns null for empty input", async () => {
    const result = await resolveDiscordTargetForMessaging({
      cfg,
      accountId: "default",
      input: "",
      normalized: "",
    });

    expect(result).toBeNull();
  });

  it("returns null for bare numeric input (not explicit)", async () => {
    const result = await resolveDiscordTargetForMessaging({
      cfg,
      accountId: "default",
      input: "123",
      normalized: "123",
    });

    expect(result).toBeNull();
  });

  it("returns null for channel names without prefix (not explicit)", async () => {
    const result = await resolveDiscordTargetForMessaging({
      cfg,
      accountId: "default",
      input: "general",
      normalized: "general",
    });

    expect(result).toBeNull();
  });

  it("respects preferredKind when parsing fails", async () => {
    // Even with preferredKind, explicit targets should still work
    const result = await resolveDiscordTargetForMessaging({
      cfg,
      accountId: "default",
      input: "user:222",
      normalized: "user:222",
      preferredKind: "channel",
    });

    expect(result?.kind).toBe("user");
  });
});

describe("discord group policy", () => {
  it("prefers channel policy, then guild policy, with sender-specific overrides", () => {
    const discordCfg = {
      channels: {
        discord: {
          token: "discord-test",
          guilds: {
            guild1: {
              requireMention: false,
              tools: { allow: ["message.guild"] },
              toolsBySender: {
                "id:user:guild-admin": { allow: ["sessions.list"] },
              },
              channels: {
                "123": {
                  requireMention: true,
                  tools: { allow: ["message.channel"] },
                  toolsBySender: {
                    "id:user:channel-admin": { deny: ["exec"] },
                  },
                },
              },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(
      resolveDiscordGroupRequireMention({ cfg: discordCfg, groupSpace: "guild1", groupId: "123" }),
    ).toBe(true);
    expect(
      resolveDiscordGroupRequireMention({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "missing",
      }),
    ).toBe(false);
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "123",
        senderId: "user:channel-admin",
      }),
    ).toEqual({ deny: ["exec"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "123",
        senderId: "user:someone",
      }),
    ).toEqual({ allow: ["message.channel"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "missing",
        senderId: "user:guild-admin",
      }),
    ).toEqual({ allow: ["sessions.list"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "missing",
        senderId: "user:someone",
      }),
    ).toEqual({ allow: ["message.guild"] });
  });
});
