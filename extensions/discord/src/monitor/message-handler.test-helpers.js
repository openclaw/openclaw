import { vi } from "vitest";
import { createNoopThreadBindingManager } from "./thread-bindings.js";
const DEFAULT_DISCORD_BOT_USER_ID = "bot-123";
function createDiscordHandlerParams(overrides) {
  const cfg = {
    channels: {
      discord: {
        enabled: true,
        token: "test-token",
        groupPolicy: "allowlist"
      }
    },
    messages: {
      inbound: {
        debounceMs: 0
      }
    }
  };
  return {
    cfg,
    discordConfig: cfg.channels?.discord,
    accountId: "default",
    token: "test-token",
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code) => {
        throw new Error(`exit ${code}`);
      }
    },
    botUserId: overrides?.botUserId ?? DEFAULT_DISCORD_BOT_USER_ID,
    guildHistories: /* @__PURE__ */ new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1e4,
    textLimit: 2e3,
    replyToMode: "off",
    dmEnabled: true,
    groupDmEnabled: false,
    threadBindings: createNoopThreadBindingManager("default"),
    setStatus: overrides?.setStatus,
    abortSignal: overrides?.abortSignal,
    workerRunTimeoutMs: overrides?.workerRunTimeoutMs
  };
}
function createDiscordPreflightContext(channelId = "ch-1") {
  return {
    data: {
      channel_id: channelId,
      message: {
        id: `msg-${channelId}`,
        channel_id: channelId,
        attachments: []
      }
    },
    message: {
      id: `msg-${channelId}`,
      channel_id: channelId,
      attachments: []
    },
    route: {
      sessionKey: `agent:main:discord:channel:${channelId}`
    },
    baseSessionKey: `agent:main:discord:channel:${channelId}`,
    messageChannelId: channelId
  };
}
export {
  DEFAULT_DISCORD_BOT_USER_ID,
  createDiscordHandlerParams,
  createDiscordPreflightContext
};
