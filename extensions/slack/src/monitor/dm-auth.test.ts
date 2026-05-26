import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { createSlackMonitorContext } from "./context.js";
import { authorizeSlackDirectMessage } from "./dm-auth.js";

function createDmAuthContext(dmPolicy: "open" | "allowlist" | "pairing" | "disabled") {
  return createSlackMonitorContext({
    cfg: { channels: { slack: { enabled: true } } } as OpenClawConfig,
    accountId: "soltea",
    botToken: "xoxb-test",
    app: { client: {} } as App,
    runtime: {} as RuntimeEnv,
    botUserId: "U_BOT",
    teamId: "T1",
    apiAppId: "A1",
    historyLimit: 0,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy,
    allowFrom: [],
    allowNameMatching: false,
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: "open",
    useAccessGroups: false,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: "off",
    threadHistoryScope: "thread",
    threadInheritParent: false,
    threadRequireExplicitMention: false,
    slashCommand: {
      enabled: false,
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

describe("authorizeSlackDirectMessage", () => {
  it("allows DMs from any sender when dmPolicy is open", async () => {
    const onUnauthorized = vi.fn();
    const allowed = await authorizeSlackDirectMessage({
      ctx: createDmAuthContext("open"),
      accountId: "soltea",
      senderId: "U_OUTSIDER",
      allowFromLower: [],
      resolveSenderName: async () => ({}),
      sendPairingReply: async () => {},
      onDisabled: () => {},
      onUnauthorized,
      log: () => {},
    });

    expect(allowed).toBe(true);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("blocks unknown senders when dmPolicy is allowlist", async () => {
    const onUnauthorized = vi.fn();
    const allowed = await authorizeSlackDirectMessage({
      ctx: createDmAuthContext("allowlist"),
      accountId: "soltea",
      senderId: "U_OUTSIDER",
      allowFromLower: [],
      resolveSenderName: async () => ({}),
      sendPairingReply: async () => {},
      onDisabled: () => {},
      onUnauthorized,
      log: () => {},
    });

    expect(allowed).toBe(false);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
