import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "../../../../../src/config/config.js";
import type { RuntimeEnv } from "../../../../../src/runtime.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import { createSlackMonitorContext } from "../context.js";

export function createInboundSlackTestContext(params: {
  cfg: OpenClawConfig;
  appClient?: App["client"];
  defaultRequireMention?: boolean;
  replyToMode?: "off" | "all" | "first";
  channelsConfig?: Record<string, { systemPrompt: string }>;
}) {
  return createSlackMonitorContext({
    cfg: params.cfg,
    accountId: "default",
    botToken: "token",
    app: { client: params.appClient ?? {} } as App,
    runtime: {} as RuntimeEnv,
    botUserId: "B1",
    teamId: "T1",
    apiAppId: "A1",
    historyLimit: 0,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: [],
    allowNameMatching: false,
    groupDmEnabled: true,
    groupDmChannels: [],
    defaultRequireMention: params.defaultRequireMention ?? true,
    channelsConfig: params.channelsConfig,
    groupPolicy: "open",
    useAccessGroups: false,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: params.replyToMode ?? "off",
    threadHistoryScope: "thread",
    threadInheritParent: false,
    slashCommand: {
      enabled: false,
      name: "openclaw",
      sessionPrefix: "slack:slash",
      ephemeral: true,
    },
    textLimit: 4000,
    ackReactionScope: "group-mentions",
    typingReaction: "",
    mediaMaxBytes: 1024,
    removeAckAfterReply: false,
  });
}

export function createSlackTestAccount(
  config: ResolvedSlackAccount["config"] = {},
): ResolvedSlackAccount {
  return {
    accountId: "default",
    enabled: true,
    botTokenSource: "config",
    appTokenSource: "config",
    userTokenSource: "none",
    config,
    replyToMode: config.replyToMode,
    replyToModeByChatType: config.replyToModeByChatType,
    dm: config.dm,
  };
}
