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

it("parses provider-prefixed channel targets", () => {
  expect(parseDiscordTarget("discord:channel:555")).toMatchObject({
    kind: "channel",
    id: "555",
    normalized: "channel:555",
  });
});

it.each([
  ["123", /Ambiguous Discord recipient/],
  ["@bob", /Discord DMs require a user id/],
] as const)("rejects invalid parse target %s", (input, message) => {
  expect(() => parseDiscordTarget(input)).toThrow(message);
});

it("resolveDiscordChannelId strips channel: prefix and accepts raw ids", () => {
  expect(resolveDiscordChannelId("channel:123")).toBe("123");
  expect(resolveDiscordChannelId("123")).toBe("123");
});

describe("resolveDiscordTarget", () => {
  const account = { cfg: config({}), accountId: "default" };
  const jane = { kind: "user", id: "user:999", name: "Jane" } as const;

  beforeEach(() => {
    vi.restoreAllMocks();
    clearDiscordDirectoryCacheForTest();
  });

  it("falls back to parsing when lookup misses", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([]);
    expect(await resolveDiscordTarget("general", account)).toMatchObject({
      kind: "channel",
      id: "general",
      normalized: "channel:general",
    });
  });

  it("does not call directory lookup for explicit user ids", async () => {
    const listPeers = vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive");
    expect(await resolveDiscordTarget("user:123", account)).toMatchObject({
      kind: "user",
      id: "123",
    });
    expect(listPeers).not.toHaveBeenCalled();
  });

  it("uses account allowFrom before inherited root allowFrom for bare numeric ids", async () => {
    const scoped = {
      cfg: config({ allowFrom: ["123"], accounts: { work: { allowFrom: ["456"] } } }),
      accountId: "work",
    };
    for (const [id, kind] of [
      ["456", "user"],
      ["123", "channel"],
    ] as const) {
      expect(await resolveDiscordTarget(id, scoped, { defaultKind: "channel" })).toMatchObject({
        kind,
        id,
        normalized: `${kind}:${id}`,
      });
    }
  });

  it("caches username lookups under the configured default account when accountId is omitted", async () => {
    const cfgLocal = config({
      defaultAccount: "work",
      accounts: { work: { token: "discord-work" } },
    });

    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([jane]);

    expect(await resolveDiscordTarget("jane", { cfg: cfgLocal })).toMatchObject({
      kind: "user",
      id: "999",
      normalized: "user:999",
    });
    expect(resolveDiscordDirectoryUserId({ accountId: "work", handle: "jane" })).toBe("999");
    expect(resolveDiscordDirectoryUserId({ accountId: "default", handle: "jane" })).toBeUndefined();
  });
});
