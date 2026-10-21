import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

type MessageReceiveHandlerContext = Parameters<typeof createFeishuMessageReceiveHandler>[0];
type HandleMessageParams = Parameters<MessageReceiveHandlerContext["handleMessage"]>[0];
type InboundDebounceFlush = ReturnType<
  Parameters<PluginRuntime["channel"]["debounce"]["createInboundDebouncer"]>[0]["onFlush"]
>;

function createTextEvent(senderOpenId: string): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: senderOpenId }, sender_type: "bot" },
    message: {
      message_id: "om_reused",
      chat_id: "oc_chat_1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
    },
  };
}

afterEach(() => closeOpenClawStateDatabaseAsync());

it("drops the current bot before debounce and processing claims", async () => {
  let onFlush:
    | ((
        entries: FeishuMessageEvent[],
        createFlush: typeof createTestInboundDebounceFlush,
      ) => InboundDebounceFlush)
    | undefined;
  const enqueue = vi.fn(async (event: FeishuMessageEvent) => {
    await onFlush?.([event], createTestInboundDebounceFlush).completion;
  });
  const channelRuntime = {
    commands: { isControlCommandMessage: () => false },
    debounce: {
      resolveInboundDebounceMs: () => 0,
      createInboundDebouncer: vi.fn((params: { onFlush: typeof onFlush }) => {
        onFlush = params.onFlush;
        return {
          enqueue,
          flushKey: async () => {},
          cancelKey: () => false,
          drain: async () => {},
        };
      }),
    },
  } as unknown as PluginRuntime["channel"];
  const handleMessage = vi.fn(async (_params: HandleMessageParams) => {});

  const handler = createFeishuMessageReceiveHandler({
    cfg: {} as ClawdbotConfig,
    channelRuntime,
    accountId: "default",
    chatHistories: new Map(),
    handleMessage,
    resolveDebounceText: () => "hello",
    hasProcessedMessage: vi.fn(async () => false),
    getBotOpenId: () => "ou_bot",
  });

  await handler(createTextEvent("ou_bot"));
  await handler(createTextEvent("ou_other_bot"));

  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(handleMessage).toHaveBeenCalledTimes(1);
  expect(handleMessage.mock.calls[0]?.[0]?.event.sender.sender_id.open_id).toBe("ou_other_bot");
});
