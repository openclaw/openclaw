// Feishu tests cover monitor.message handler plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

type DebouncerFactoryParams = {
  onFlush: (entries: FeishuMessageEvent[]) => Promise<void>;
};
type MessageReceiveHandlerContext = Parameters<typeof createFeishuMessageReceiveHandler>[0];
type HandleMessageParams = Parameters<MessageReceiveHandlerContext["handleMessage"]>[0];

function createTextEvent(params: {
  messageId: string;
  senderOpenId: string;
  senderType?: string;
  text?: string;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { open_id: params.senderOpenId },
      sender_type: params.senderType ?? "user",
    },
    message: {
      message_id: params.messageId,
      chat_id: "oc_chat_1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: params.text ?? "hello" }),
    },
  };
}

function createRuntime() {
  let debouncerParams: DebouncerFactoryParams | undefined;
  const enqueue = vi.fn(async (event: FeishuMessageEvent) => {
    await debouncerParams?.onFlush([event]);
  });
  const channelRuntime = {
    commands: {
      isControlCommandMessage: () => false,
    },
    debounce: {
      resolveInboundDebounceMs: () => 0,
      createInboundDebouncer: vi.fn((params: DebouncerFactoryParams) => {
        debouncerParams = params;
        return { enqueue };
      }),
    },
  } as unknown as PluginRuntime["channel"];
  return { channelRuntime, enqueue };
}

function createHandler(params?: { botOpenId?: string }) {
  const handleMessage = vi.fn(async (_params: HandleMessageParams) => {});
  const hasProcessedMessage = vi.fn(async () => false);
  const recordProcessedMessage = vi.fn(async () => true);
  const { channelRuntime, enqueue } = createRuntime();
  const log = vi.fn();

  const handler = createFeishuMessageReceiveHandler({
    cfg: {} as ClawdbotConfig,
    channelRuntime,
    accountId: "default",
    runtime: { log, error: vi.fn() } as unknown as RuntimeEnv,
    chatHistories: new Map(),
    handleMessage,
    resolveDebounceText: ({ event }) => {
      const parsed = JSON.parse(event.message.content) as { text?: string };
      return parsed.text ?? "";
    },
    hasProcessedMessage,
    recordProcessedMessage,
    getBotOpenId: () => params?.botOpenId,
  });

  return { handler, handleMessage, hasProcessedMessage, recordProcessedMessage, enqueue, log };
}

describe("createFeishuMessageReceiveHandler self-message filtering", () => {
  it("drops bot-open-id echoes before debounce and processing claims", async () => {
    const { handler, handleMessage, enqueue, log } = createHandler({ botOpenId: "ou_bot" });

    await handler(
      createTextEvent({
        messageId: "om_echo",
        senderOpenId: "ou_bot",
        senderType: "app",
        text: "bot reply",
      }),
    );
    await handler(
      createTextEvent({
        messageId: "om_echo",
        senderOpenId: "ou_user",
        senderType: "user",
        text: "user retry",
      }),
    );

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0]?.[0]?.event.sender.sender_id.open_id).toBe("ou_user");
    expect(log).toHaveBeenCalledWith("feishu[default]: dropping self-authored message om_echo");
  });

  it("keeps other app-authored messages flowing to dispatch", async () => {
    const { handler, handleMessage, enqueue } = createHandler({ botOpenId: "ou_bot" });

    await handler(
      createTextEvent({
        messageId: "om_other_app",
        senderOpenId: "ou_other_app",
        senderType: "app",
      }),
    );

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("drops user-shaped bot-open-id echoes before debounce", async () => {
    const { handler, handleMessage, enqueue } = createHandler({ botOpenId: "ou_bot" });

    await handler(
      createTextEvent({
        messageId: "om_bot_open_id",
        senderOpenId: "ou_bot",
        senderType: "user",
      }),
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("keeps ordinary user messages flowing to dispatch", async () => {
    const { handler, handleMessage, enqueue } = createHandler({ botOpenId: "ou_bot" });

    await handler(
      createTextEvent({
        messageId: "om_user",
        senderOpenId: "ou_user",
        senderType: "user",
      }),
    );

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});
