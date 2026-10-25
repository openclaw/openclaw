import { describe, expect, it, vi } from "vitest";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { normalizeSlackChannelType } from "./context.js";
import { createMonitorTestContext } from "./monitor-context.test-support.js";

describe("resolveSlackChannelConfig", () => {
  it("does not match a bare channel ID when workspace scope is required", () => {
    const channels = { C01234567: { enabled: true, requireMention: false } };
    const params = { teamId: "T11111111", channelId: "C01234567", channels };
    expect(resolveSlackChannelConfig(params)).toMatchObject({
      allowed: false,
      requireMention: true,
    });
    expect(resolveSlackChannelConfig({ ...params, allowUnscoped: true })).toMatchObject({
      allowed: true,
      requireMention: false,
      matchKey: "C01234567",
      matchSource: "direct",
    });
  });

  it("preserves org-wide and workspace-qualified per-channel user identities", () => {
    const users = ["team:T11111111:user:U01234567", "team:T22222222:user:U12345678", "U23456789"];
    const channels = {
      "team:T11111111:channel:C01234567": { users },
      "team:T22222222:channel:C01234567": { users },
    };

    for (const teamId of ["T11111111", "T22222222"]) {
      expect(
        resolveSlackChannelConfig({ teamId, channelId: "C01234567", channels })?.users,
      ).toEqual(["team:t11111111:user:u01234567", "team:t22222222:user:u12345678", "u23456789"]);
    }
  });

  it.each([false, true])(
    "gates channel-name routes on dangerous name matching: %s",
    (allowNameMatching) => {
      const res = resolveSlackChannelConfig({
        channelId: "C1",
        channelName: "ops-room",
        channels: { "ops-room": { enabled: true, requireMention: false } },
        defaultRequireMention: true,
        allowNameMatching,
      });
      expect(res).toMatchObject(
        allowNameMatching
          ? { allowed: true, requireMention: false, matchKey: "ops-room", matchSource: "direct" }
          : { allowed: false, requireMention: true },
      );
    },
  );
});

function createContext(overrides: Parameters<typeof createMonitorTestContext>[0] = {}) {
  return createMonitorTestContext({
    cfg: {},
    teamId: "T1",
    apiAppId: "A1",
    groupPolicy: "open",
    ...overrides,
  });
}

describe("normalizeSlackChannelType", () => {
  it("infers channel types from ids when missing", () => {
    expect(normalizeSlackChannelType(undefined, "C123")).toBe("channel");
    expect(normalizeSlackChannelType(undefined, "D123")).toBe("im");
    expect(normalizeSlackChannelType(undefined, "G123")).toBe("group");
  });
});

describe("resolveSlackSystemEventRoute", () => {
  it("uses the sole configured agent for fallback system-event sessions", async () => {
    const ctx = createContext({ cfg: { agents: { entries: { ops: {} } } } });
    expect(await ctx.resolveSlackSystemEventRoute({ channelId: "C123" })).toEqual({
      agentId: "ops",
      sessionKey: "agent:ops:slack:channel:c123",
    });
  });

  it("routes DM system events through direct-peer bindings when sender is known", async () => {
    const ctx = createContext({
      accountId: "work",
      cfg: {
        bindings: [
          {
            agentId: "ops-dm",
            match: {
              channel: "slack",
              accountId: "work",
              peer: { kind: "direct", id: "U123" },
            },
          },
        ],
      },
    });
    expect(
      await ctx.resolveSlackSystemEventRoute({
        channelId: "D123",
        channelType: "im",
        senderId: "U123",
      }),
    ).toEqual({ agentId: "ops-dm", sessionKey: "agent:ops-dm:main" });
  });
});

describe("isChannelAllowed with groupPolicy and channelsConfig", () => {
  it.each([
    ["open", "C_DENIED", "direct"],
    ["allowlist", "*", "wildcard"],
  ] as const)(
    "repeats %s disabled-channel warnings on a fixed interval",
    (groupPolicy, key, source) => {
      vi.useFakeTimers();
      try {
        const ctx = createContext({
          groupPolicy,
          channelsConfig: { [key]: { enabled: false } },
        });
        const warnSpy = vi.spyOn(ctx.logger, "warn").mockImplementation(() => undefined);

        expect(ctx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(false);
        vi.advanceTimersByTime(4 * 60_000);
        expect(ctx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(false);
        expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
          {
            provider: "slack",
            accountId: "default",
            channelId: "C_DENIED",
            reason: "channel_not_allowed",
            cause: "channel_disabled",
            groupPolicy,
            matchSource: source,
            matchKey: key,
          },
          "Slack channel denied by configuration",
        );

        vi.advanceTimersByTime(60_000);
        expect(ctx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(false);
        expect(warnSpy).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["allowlist", { C_LISTED: { requireMention: true } }],
    ["disabled", { C_DENIED: { enabled: false } }],
  ] as const)("does not warn for a %s policy denial", (groupPolicy, channelsConfig) => {
    const ctx = createContext({ groupPolicy, channelsConfig });
    const warn = vi.spyOn(ctx.logger, "warn").mockImplementation(() => undefined);
    expect(ctx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("allows all channels when groupPolicy is open and channelsConfig is empty", () => {
    const ctx = createContext();
    expect(ctx.isChannelAllowed({ channelId: "C_ANY", channelType: "channel" })).toBe(true);
  });
});
