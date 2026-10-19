// Slack tests cover monitor plugin behavior.
import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { createSlackMonitorContext, normalizeSlackChannelType } from "./context.js";

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

function createContext(overrides: Partial<Parameters<typeof createSlackMonitorContext>[0]> = {}) {
  return createSlackMonitorContext({
    cfg: {} as OpenClawConfig,
    accountId: "default",
    botToken: "token",
    app: { client: {} } as App,
    runtime: {} as RuntimeEnv,
    botUserId: "B1",
    botId: "B1",
    identityHealth: { lifecycle: "ready" as const, lastError: null },
    teamId: "T1",
    apiAppId: "A1",
    historyLimit: 0,
    sessionScope: "per-sender" as const,
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open" as const,
    allowFrom: [],
    allowNameMatching: false,
    groupDmEnabled: true,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: "open" as const,
    useAccessGroups: false,
    reactionMode: "off" as const,
    reactionAllowlist: [],
    replyToMode: "off" as const,
    slashCommand: {
      enabled: false,
      name: "openclaw",
      sessionPrefix: "slack:slash",
      ephemeral: true,
    },
    textLimit: 4000,
    typingReaction: "",
    mediaMaxBytes: 1,
    threadHistoryScope: "thread" as const,
    threadInheritParent: false,
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
    const ctx = createContext({
      cfg: {
        agents: { entries: { ops: {} } },
      },
    });
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
  it("repeats disabled-channel warnings on a fixed interval despite steady traffic", () => {
    vi.useFakeTimers();
    try {
      const ctx = createContext({
        groupPolicy: "open",
        channelsConfig: { C_DENIED: { enabled: false } },
      });
      const warnSpy = vi.spyOn(ctx.logger, "warn").mockImplementation(() => undefined);

      expect(ctx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(false);
      vi.advanceTimersByTime(4 * 60_000);
      expect(ctx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_000);
      expect(ctx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns for wildcard disablement under allowlist policy", () => {
    const ctx = createContext({
      groupPolicy: "allowlist",
      channelsConfig: { "*": { enabled: false } },
    });
    const warnSpy = vi.spyOn(ctx.logger, "warn").mockImplementation(() => undefined);

    expect(ctx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(false);

    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      {
        provider: "slack",
        accountId: "default",
        channelId: "C_DENIED",
        reason: "channel_not_allowed",
        cause: "channel_disabled",
        groupPolicy: "allowlist",
        matchSource: "wildcard",
        matchKey: "*",
      },
      "Slack channel denied by configuration",
    );
  });

  it("does not warn for allowlist misses or globally disabled groups", () => {
    const allowlistCtx = createContext({
      groupPolicy: "allowlist",
      channelsConfig: { C_LISTED: { requireMention: true } },
    });
    const allowlistWarnSpy = vi
      .spyOn(allowlistCtx.logger, "warn")
      .mockImplementation(() => undefined);
    expect(allowlistCtx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(
      false,
    );
    expect(allowlistWarnSpy).not.toHaveBeenCalled();

    const disabledCtx = createContext({
      groupPolicy: "disabled",
      channelsConfig: { C_DENIED: { enabled: false } },
    });
    const disabledWarnSpy = vi
      .spyOn(disabledCtx.logger, "warn")
      .mockImplementation(() => undefined);
    expect(disabledCtx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(
      false,
    );
    expect(disabledWarnSpy).not.toHaveBeenCalled();
  });

  it("allows all channels when groupPolicy is open and channelsConfig is empty", () => {
    const ctx = createContext({
      groupPolicy: "open",
      channelsConfig: undefined,
    });
    expect(ctx.isChannelAllowed({ channelId: "C_ANY", channelType: "channel" })).toBe(true);
  });
});
