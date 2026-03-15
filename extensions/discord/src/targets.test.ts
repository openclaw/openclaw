import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import * as directoryLive from "./directory-live.js";
import { normalizeDiscordMessagingTarget } from "./normalize.js";
import { parseDiscordTarget, resolveDiscordChannelId, resolveDiscordTarget } from "./targets.js";

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
