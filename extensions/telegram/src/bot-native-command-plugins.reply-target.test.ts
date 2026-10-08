import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTelegramPluginCommand } from "./bot-native-command-plugins.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  execute: vi.fn(),
}));

// mock-isolation: Keep Telegram transport and command dispatch effects synthetic for this adapter test.
vi.mock("./bot-native-command-dispatch.js", () => ({
  prepareTelegramCommandDispatch: mocks.prepare,
}));

describe("Telegram native plugin command message references", () => {
  beforeEach(() => {
    mocks.prepare.mockReset().mockImplementation(async (params: { msg: unknown }) => ({
      msg: params.msg,
      nativeCommandRuntime: { getSessionEntry: () => undefined },
      route: { agentId: "main" },
      targetSessionKey: "agent:main:telegram:group:-10042",
      isGroup: true,
      chatId: -10042,
      threadSpec: { scope: "none" },
      loadDeliveryRuntime: async () => ({
        deliverReplies: () => undefined,
        emitTelegramMessageSentHooks: () => undefined,
      }),
      runtimeCfg: {},
      runtimeTelegramCfg: {},
      senderId: "42",
      commandAuthorized: true,
      senderIsOwner: true,
      assertOwnerCurrent: () => undefined,
      accountId: "default",
    }));
    mocks.execute.mockReset().mockResolvedValue({ suppressReply: true });
  });

  it.each([
    { replyId: 17, expected: "17" },
    { replyId: undefined, expected: undefined },
  ])("passes explicit reply target $expected through native plugin dispatch", async (sample) => {
    const msg = {
      message_id: 42,
      chat: { id: -10042, type: "supergroup" },
      ...(sample.replyId === undefined ? {} : { reply_to_message: { message_id: sample.replyId } }),
    };
    await executeTelegramPluginCommand({
      commandName: "fork",
      rawText: "",
      msg,
      candidate: {
        requireAuth: true,
        prepareDispatch: () => ({ kind: "plugin", execute: mocks.execute }),
      },
    } as unknown as Parameters<typeof executeTelegramPluginCommand>[0]);

    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "42", replyToId: sample.expected, chatType: "group" }),
    );
  });
});
