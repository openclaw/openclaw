import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDiscordDirectoryUserId } from "./directory-cache.js";
import { clearDiscordDirectoryCacheForTest } from "./directory-cache.test-support.js";
import * as directoryLive from "./directory-live.js";
import { parseDiscordTarget, resolveDiscordChannelId } from "./target-parsing.js";
import { resolveDiscordTarget } from "./target-resolver.js";

const config = (discord: NonNullable<OpenClawConfig["channels"]>["discord"]): OpenClawConfig => ({
  channels: { discord },
});

describe("parseDiscordTarget", () => {
  it("parses channel targets", () => {
    const cases = [
      { input: "channel:555", id: "555", normalized: "channel:555" },
      { input: "discord:channel:555", id: "555", normalized: "channel:555" },
      { input: "general", id: "general", normalized: "channel:general" },
    ] as const;
    for (const { input, id, normalized } of cases) {
      expect(parseDiscordTarget(input)).toMatchObject({ kind: "channel", id, normalized });
    }
  });

  it("rejects invalid parse targets", () => {
    const cases = [
      { input: "123", expectedMessage: /Ambiguous Discord recipient/ },
      { input: "@bob", expectedMessage: /Discord DMs require a user id/ },
    ] as const;
    for (const { input, expectedMessage } of cases) {
      expect(() => parseDiscordTarget(input), input).toThrow(expectedMessage);
    }
  });
});

it("resolveDiscordChannelId strips channel: prefix and accepts raw ids", () => {
  expect(resolveDiscordChannelId("channel:123")).toBe("123");
  expect(resolveDiscordChannelId("123")).toBe("123");
});

describe("resolveDiscordTarget", () => {
  const cfg = config({});

  beforeEach(() => {
    vi.restoreAllMocks();
    clearDiscordDirectoryCacheForTest();
  });

  it("returns a resolved user for usernames", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([
      { kind: "user", id: "user:999", name: "Jane" } as const,
    ]);

    expect(await resolveDiscordTarget("jane", { cfg, accountId: "default" })).toMatchObject({
      kind: "user",
      id: "999",
      normalized: "user:999",
    });
  });

  it("falls back to parsing when lookup misses", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([]);
    expect(await resolveDiscordTarget("general", { cfg, accountId: "default" })).toMatchObject({
      kind: "channel",
      id: "general",
    });
  });

  it("does not call directory lookup for explicit user ids", async () => {
    const listPeers = vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive");
    expect(await resolveDiscordTarget("user:123", { cfg, accountId: "default" })).toMatchObject({
      kind: "user",
      id: "123",
    });
    expect(listPeers).not.toHaveBeenCalled();
  });

  it("uses account allowFrom before inherited root allowFrom for bare numeric ids", async () => {
    const cfgValue = config({
      allowFrom: ["123"],
      accounts: { work: { allowFrom: ["456"] } },
    });
    const account = { cfg: cfgValue, accountId: "work" };

    expect(await resolveDiscordTarget("456", account, { defaultKind: "channel" })).toMatchObject({
      kind: "user",
      id: "456",
      normalized: "user:456",
    });
    expect(await resolveDiscordTarget("123", account, { defaultKind: "channel" })).toMatchObject({
      kind: "channel",
      id: "123",
      normalized: "channel:123",
    });
  });

  it("caches username lookups under the configured default account when accountId is omitted", async () => {
    const cfgLocal = config({
      defaultAccount: "work",
      accounts: { work: { token: "discord-work" } },
    });

    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([
      { kind: "user", id: "user:999", name: "Jane" } as const,
    ]);

    expect(await resolveDiscordTarget("jane", { cfg: cfgLocal })).toMatchObject({
      kind: "user",
      id: "999",
      normalized: "user:999",
    });
    expect(resolveDiscordDirectoryUserId({ accountId: "work", handle: "jane" })).toBe("999");
    expect(resolveDiscordDirectoryUserId({ accountId: "default", handle: "jane" })).toBeUndefined();
  });
});
