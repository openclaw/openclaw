import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { vi } from "vitest";

type TelegramDispatch = typeof import("./bot-message-dispatch.js").dispatchTelegramMessage;
type TelegramDispatchParams = Parameters<TelegramDispatch>[0];

export function createDirectDispatchContext(
  cfg: OpenClawConfig,
): TelegramDispatchParams["context"] {
  const msg = {
    chat: { id: 123, type: "private" },
    date: 1_736_380_800,
    from: { id: 9, is_bot: false, first_name: "Ada" },
    message_id: 456,
    text: "test turn",
  } as TelegramDispatchParams["context"]["msg"];
  return {
    cfg,
    ctxPayload: {
      Body: "test turn",
      BodyForAgent: "test turn",
      ChatType: "direct",
      CommandBody: "test turn",
      MessageSid: "456",
      RawBody: "test turn",
      SessionKey: "agent:default:telegram:direct:123",
    } as TelegramDispatchParams["context"]["ctxPayload"],
    turn: {
      storePath: "/tmp/openclaw/telegram-sessions.json",
      recordInboundSession: vi.fn(async () => undefined),
      record: { onRecordError: vi.fn() },
    } as TelegramDispatchParams["context"]["turn"],
    primaryCtx: { message: msg } as TelegramDispatchParams["context"]["primaryCtx"],
    msg,
    chatId: 123,
    isGroup: false,
    threadSpec: { scope: "none" },
    isForum: false,
    historyLimit: 0,
    skillFilter: undefined,
    route: {
      accountId: "default",
      agentId: "default",
      sessionKey: "agent:default:telegram:direct:123",
    } as TelegramDispatchParams["context"]["route"],
    sendTyping: vi.fn(async () => undefined),
    sendRecordVoice: vi.fn(async () => undefined),
    sendChatActionHandler: {
      sendChatAction: vi.fn(async () => undefined),
      isSuspended: () => false,
      reset: vi.fn(),
    },
    ackReactionPromise: null,
    reactionApi: null,
    statusReactionController: null,
    accountId: "default",
  };
}
