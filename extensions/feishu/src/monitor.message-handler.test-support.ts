import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { createFeishuTestEvent } from "./bot.test-support.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

type MessageReceiveHandlerContext = Parameters<typeof createFeishuMessageReceiveHandler>[0];
type HandleMessageParams = Parameters<MessageReceiveHandlerContext["handleMessage"]>[0];
type InboundDebounceFlush = ReturnType<
  Parameters<PluginRuntime["channel"]["debounce"]["createInboundDebouncer"]>[0]["onFlush"]
>;

const createTextEvent = (senderOpenId: string) =>
  createFeishuTestEvent({
    messageId: "om_reused",
    senderOpenId,
    senderType: "bot",
    chatId: "oc_chat_1",
  });

afterEach(() => closeOpenClawStateDatabaseAsync());

function createReceiver(accountId = "default") {
  let onFlush:
    | ((
        entries: ReturnType<typeof createTextEvent>[],
        createFlush: typeof createTestInboundDebounceFlush,
      ) => InboundDebounceFlush)
    | undefined;
  const enqueue = vi.fn(async (event: ReturnType<typeof createTextEvent>) => {
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
    cfg: {},
    channelRuntime,
    accountId,
    chatHistories: new Map(),
    handleMessage,
    resolveDebounceText: () => "hello",
    hasProcessedMessage: vi.fn(async () => false),
    getBotOpenId: () => "ou_bot",
  });

  return { handler, enqueue, handleMessage };
}

it("drops the current bot before debounce and processing claims", async () => {
  const { handler, enqueue, handleMessage } = createReceiver();
  await handler(createTextEvent("ou_bot"));
  await handler(createTextEvent("ou_other_bot"));

  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(handleMessage).toHaveBeenCalledTimes(1);
  expect(handleMessage.mock.calls[0]?.[0]?.event.sender.sender_id.open_id).toBe("ou_other_bot");
});

it("keeps same-id media variants distinct at receive time", async () => {
  const { handler, handleMessage } = createReceiver("receive-media-dedupe");
  const audioEvent = (fileKey: string) =>
    createFeishuTestEvent({
      messageId: "msg-audio-receive-reused-id",
      senderOpenId: "ou-audio-receive-dedup",
      messageType: "audio",
      content: JSON.stringify({ file_key: fileKey, duration: 1200 }),
    });
  const first = audioEvent("file_audio_receive_first");
  const second = audioEvent("file_audio_receive_second");
  await handler(first);
  await handler(second);
  await handler(audioEvent("file_audio_receive_first"));
  expect(handleMessage).toHaveBeenCalledTimes(2);
  expect(handleMessage.mock.calls.map(([call]) => call.event)).toEqual([first, second]);
  expect(handleMessage.mock.calls.map(([call]) => typeof call.processingClaim?.commit)).toEqual([
    "function",
    "function",
  ]);
});
