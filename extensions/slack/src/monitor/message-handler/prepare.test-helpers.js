import { createSlackMonitorContext } from "../context.js";
function createInboundSlackTestContext(params) {
  return createSlackMonitorContext({
    cfg: params.cfg,
    accountId: "default",
    botToken: "token",
    app: { client: params.appClient ?? {} },
    runtime: {},
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
      ephemeral: true
    },
    textLimit: 4e3,
    ackReactionScope: "group-mentions",
    typingReaction: "",
    mediaMaxBytes: 1024,
    removeAckAfterReply: false
  });
}
function createSlackTestAccount(config = {}) {
  return {
    accountId: "default",
    enabled: true,
    botTokenSource: "config",
    appTokenSource: "config",
    userTokenSource: "none",
    config,
    replyToMode: config.replyToMode,
    replyToModeByChatType: config.replyToModeByChatType,
    dm: config.dm
  };
}
export {
  createInboundSlackTestContext,
  createSlackTestAccount
};
