// Slack tests cover context plugin behavior.
import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it } from "vitest";
import { createSlackMonitorContext } from "./context.js";

function createTestContext(params?: {
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  groupDmEnabled?: boolean;
  groupDmChannels?: string[];
}) {
  return createSlackMonitorContext({
    cfg: {
      channels: { slack: { enabled: true } },
      session: { dmScope: params?.dmScope ?? "main" },
    } as OpenClawConfig,
    accountId: "default",
    botToken: "xoxb-test",
    app: { client: {} } as App,
    runtime: {} as RuntimeEnv,
    botUserId: "U_BOT",
    botId: "B_BOT",
    teamId: "T_EXPECTED",
    apiAppId: "A_EXPECTED",
    historyLimit: 0,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: [],
    allowNameMatching: false,
    groupDmEnabled: params?.groupDmEnabled ?? false,
    groupDmChannels: params?.groupDmChannels ?? [],
    defaultRequireMention: true,
    groupPolicy: "allowlist",
    useAccessGroups: true,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: "off",
    threadHistoryScope: "thread",
    threadInheritParent: false,
    threadRequireExplicitMention: false,
    slashCommand: {
      enabled: true,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    typingReaction: "",
    ackReactionScope: "group-mentions",
    mediaMaxBytes: 20 * 1024 * 1024,
    removeAckAfterReply: false,
  });
}

describe("createSlackMonitorContext shouldDropMismatchedSlackEvent", () => {
  it("drops mismatched top-level app/team identifiers", () => {
    const ctx = createTestContext();
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_WRONG",
        team_id: "T_EXPECTED",
      }),
    ).toBe(true);
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team_id: "T_WRONG",
      }),
    ).toBe(true);
  });

  it("drops mismatched nested team.id payloads used by interaction bodies", () => {
    const ctx = createTestContext();
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team: { id: "T_WRONG" },
      }),
    ).toBe(true);
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team: { id: "T_EXPECTED" },
      }),
    ).toBe(false);
  });
});

describe("createSlackMonitorContext isChannelAllowed", () => {
  it("normalizes channel-prefixed group DM allowlist entries", () => {
    const ctx = createTestContext({
      groupDmEnabled: true,
      groupDmChannels: ["channel:G456"],
    });

    expect(ctx.isChannelAllowed({ channelId: "G456", channelType: "mpim" })).toBe(true);
    expect(ctx.isChannelAllowed({ channelId: "G999", channelType: "mpim" })).toBe(false);
  });
});

describe("createSlackMonitorContext resolveSlackSystemEventSessionKey", () => {
  it("routes threaded interaction events to the Slack thread session", () => {
    const ctx = createTestContext();

    expect(
      ctx.resolveSlackSystemEventSessionKey({
        channelId: "C_THREAD",
        channelType: "channel",
        senderId: "U_CLICKER",
        threadTs: "1712345678.123456",
      }),
    ).toBe("agent:main:slack:channel:c_thread:thread:1712345678.123456");
  });

  it("routes channel-less direct interactions to the sender session", () => {
    const ctx = createTestContext({ dmScope: "per-channel-peer" });

    expect(
      ctx.resolveSlackSystemEventSessionKey({
        channelType: "im",
        senderId: "U_SHORTCUT",
      }),
    ).toBe("agent:main:slack:direct:u_shortcut");
  });

  it("uses recallSlackChannelType for system events missing channel_type (#102676)", () => {
    const ctx = createTestContext({ groupDmEnabled: true });

    // First, remember the mpDM type via the normal recall/remember path
    ctx.rememberSlackChannelType("C0MPDM42", "mpim");

    // Then resolve a system event (message_changed/message_deleted) that
    // omits channel_type — recall must supply the remembered "mpim" so
    // the session key is slack:group: instead of slack:channel:.
    const key = ctx.resolveSlackSystemEventSessionKey({
      channelId: "C0MPDM42",
      channelType: undefined,
      senderId: "U_BOT",
    });

    expect(key).toMatch(/^agent:main:slack:group:/);
  });

  it("falls back to C-prefix inference when recall has not been primed (#102676)", () => {
    const ctx = createTestContext();

    // No rememberSlackChannelType call — recall returns undefined,
    // so the session key falls through to C-prefix inference → "channel".
    const key = ctx.resolveSlackSystemEventSessionKey({
      channelId: "C0MPDM42",
      channelType: undefined,
      senderId: "U_BOT",
    });

    expect(key).toMatch(/^agent:main:slack:channel:/);
  });
});
