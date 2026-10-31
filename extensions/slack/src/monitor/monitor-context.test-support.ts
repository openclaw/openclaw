import type { App } from "@slack/bolt";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createSlackMonitorContext, type CreateSlackMonitorContextParams } from "./context.js";

export function createMonitorTestContext(overrides: Partial<CreateSlackMonitorContextParams> = {}) {
  return createSlackMonitorContext({
    cfg: { channels: { slack: { enabled: true } }, session: { dmScope: "main" } },
    accountId: "default",
    botToken: "xoxb-test",
    app: { client: {} } as App,
    runtime: {} as RuntimeEnv,
    botUserId: "U_BOT",
    botId: "B_BOT",
    identityHealth: { lifecycle: "ready", lastError: null },
    teamId: "T_EXPECTED",
    apiAppId: "A_EXPECTED",
    historyLimit: 0,
    dmHistoryLimit: 0,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: [],
    allowNameMatching: false,
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    channelsConfig: undefined,
    groupPolicy: "allowlist",
    useAccessGroups: true,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: "off",
    threadHistoryScope: "thread",
    threadInheritParent: false,
    slashCommand: {
      enabled: true,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    typingReaction: "",
    mediaMaxBytes: 20 * 1024 * 1024,
    ...overrides,
    channelsConfigKeys: overrides.channelsConfigKeys ?? Object.keys(overrides.channelsConfig ?? {}),
  });
}
