import { vi } from "vitest";
import {
  buildTelegramMessageContext
} from "./bot-message-context.js";
const baseTelegramMessageContextConfig = {
  agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
  channels: { telegram: {} },
  messages: { groupChat: { mentionPatterns: [] } }
};
async function buildTelegramMessageContextForTest(params) {
  return await buildTelegramMessageContext({
    primaryCtx: {
      message: {
        message_id: 1,
        date: 17e8,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
        ...params.message
      },
      me: { id: 7, username: "bot" }
    },
    allMedia: params.allMedia ?? [],
    storeAllowFrom: [],
    options: params.options ?? {},
    bot: {
      api: {
        sendChatAction: vi.fn(),
        setMessageReaction: vi.fn()
      }
    },
    cfg: params.cfg ?? baseTelegramMessageContextConfig,
    account: { accountId: params.accountId ?? "default" },
    historyLimit: 0,
    groupHistories: /* @__PURE__ */ new Map(),
    dmPolicy: "open",
    allowFrom: [],
    groupAllowFrom: [],
    ackReactionScope: "off",
    logger: { info: vi.fn() },
    resolveGroupActivation: params.resolveGroupActivation ?? (() => void 0),
    resolveGroupRequireMention: params.resolveGroupRequireMention ?? (() => false),
    resolveTelegramGroupConfig: params.resolveTelegramGroupConfig ?? (() => ({
      groupConfig: { requireMention: false },
      topicConfig: void 0
    })),
    sendChatActionHandler: { sendChatAction: vi.fn() }
  });
}
export {
  baseTelegramMessageContextConfig,
  buildTelegramMessageContextForTest
};
