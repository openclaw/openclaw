import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNoopThreadBindingManager } from "./thread-bindings.js";
async function createBaseDiscordMessageContext(overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-"));
  const storePath = path.join(dir, "sessions.json");
  return {
    cfg: { messages: { ackReaction: "\u{1F440}" }, session: { store: storePath } },
    discordConfig: {},
    accountId: "default",
    token: "token",
    runtime: { log: () => {
    }, error: () => {
    } },
    guildHistories: /* @__PURE__ */ new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1024,
    textLimit: 4e3,
    sender: { label: "user" },
    replyToMode: "off",
    ackReactionScope: "group-mentions",
    groupPolicy: "open",
    data: { guild: { id: "g1", name: "Guild" } },
    client: { rest: {} },
    message: {
      id: "m1",
      channelId: "c1",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      attachments: []
    },
    messageChannelId: "c1",
    author: {
      id: "U1",
      username: "alice",
      discriminator: "0",
      globalName: "Alice"
    },
    channelInfo: { name: "general" },
    channelName: "general",
    isGuildMessage: true,
    isDirectMessage: false,
    isGroupDm: false,
    commandAuthorized: true,
    baseText: "hi",
    messageText: "hi",
    wasMentioned: false,
    shouldRequireMention: true,
    canDetectMention: true,
    effectiveWasMentioned: true,
    shouldBypassMention: false,
    threadChannel: null,
    threadParentId: void 0,
    threadParentName: void 0,
    threadParentType: void 0,
    threadName: void 0,
    displayChannelSlug: "general",
    guildInfo: null,
    guildSlug: "guild",
    channelConfig: null,
    baseSessionKey: "agent:main:discord:guild:g1",
    route: {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:guild:g1",
      mainSessionKey: "agent:main:main"
    },
    threadBindings: createNoopThreadBindingManager("default"),
    ...overrides
  };
}
function createDiscordDirectMessageContextOverrides() {
  return {
    data: { guild: null },
    channelInfo: null,
    channelName: void 0,
    isGuildMessage: false,
    isDirectMessage: true,
    isGroupDm: false,
    shouldRequireMention: false,
    canDetectMention: false,
    effectiveWasMentioned: false,
    displayChannelSlug: "",
    guildInfo: null,
    guildSlug: "",
    baseSessionKey: "agent:main:discord:direct:u1",
    route: {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:direct:u1",
      mainSessionKey: "agent:main:main"
    }
  };
}
export {
  createBaseDiscordMessageContext,
  createDiscordDirectMessageContextOverrides
};
