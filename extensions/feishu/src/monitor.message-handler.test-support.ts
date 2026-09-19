// Feishu test support covers monitor.message handler plugin behavior.
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

type MessageReceiveHandlerContext = Parameters<typeof createFeishuMessageReceiveHandler>[0];
type HandleMessageParams = Parameters<MessageReceiveHandlerContext["handleMessage"]>[0];
type InboundDebounceFlush = ReturnType<
  Parameters<PluginRuntime["channel"]["debounce"]["createInboundDebouncer"]>[0]["onFlush"]
>;

function createTextEvent(params: {
  messageId: string;
  senderOpenId: string;
  senderType: "bot" | "user";
  chatId?: string;
  chatType?: FeishuMessageEvent["message"]["chat_type"];
  text?: string;
  createTime?: string;
  rootId?: string;
  threadId?: string;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { open_id: params.senderOpenId },
      sender_type: params.senderType,
    },
    message: {
      message_id: params.messageId,
      chat_id: params.chatId ?? "oc_chat_1",
      chat_type: params.chatType ?? "p2p",
      message_type: "text",
      content: JSON.stringify({ text: params.text ?? "hello" }),
      create_time: params.createTime,
      root_id: params.rootId,
      thread_id: params.threadId,
    },
  };
}

function createHandler() {
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
    commands: {
      isControlCommandMessage: () => false,
    },
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

  return { handler, handleMessage, enqueue };
}

describe("createFeishuMessageReceiveHandler self-message filtering", () => {
  it("drops the current bot before debounce and processing claims", async () => {
    const { handler, handleMessage, enqueue } = createHandler();

    await handler(
      createTextEvent({
        messageId: "om_reused",
        senderOpenId: "ou_bot",
        senderType: "bot",
      }),
    );
    await handler(
      createTextEvent({
        messageId: "om_reused",
        senderOpenId: "ou_user",
        senderType: "user",
      }),
    );

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0]?.[0]?.event.sender.sender_id.open_id).toBe("ou_user");
  });

  it("keeps peer bot and user messages flowing to dispatch", async () => {
    const { handler, handleMessage, enqueue } = createHandler();

    await handler(
      createTextEvent({
        messageId: "om_other_bot",
        senderOpenId: "ou_other_bot",
        senderType: "bot",
      }),
    );
    await handler(
      createTextEvent({
        messageId: "om_user",
        senderOpenId: "ou_user",
        senderType: "user",
      }),
    );

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(
      handleMessage.mock.calls.map(([params]) => params.event.sender.sender_id.open_id),
    ).toEqual(["ou_other_bot", "ou_user"]);
  });

  it("admits route-distinct topic texts and still drops true redeliveries (#149313)", async () => {
    const { handler, handleMessage, enqueue } = createHandler();
    const shared = {
      senderOpenId: "ou-same-sender",
      senderType: "user" as const,
      chatId: "oc-topic-group",
      chatType: "topic_group" as const,
      text: "same text",
      createTime: "1710000000000",
    };

    await handler(
      createTextEvent({
        ...shared,
        messageId: "om_topic_a_child",
        rootId: "om_topic_a_root",
        threadId: "omt_topic_a",
      }),
    );
    await handler(
      createTextEvent({
        ...shared,
        messageId: "om_topic_b_child",
        rootId: "om_topic_b_root",
        threadId: "omt_topic_b",
      }),
    );
    await handler(
      createTextEvent({
        ...shared,
        messageId: "om_topic_a_retry",
        rootId: "om_topic_a_root",
        threadId: "omt_topic_a",
      }),
    );

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(handleMessage.mock.calls.map(([params]) => params.event.message.message_id)).toEqual([
      "om_topic_a_child",
      "om_topic_b_child",
    ]);
  });

  it("admits route-distinct topic texts through the real debounce path (#149313)", async () => {
    const handleMessage = vi.fn(async (_params: HandleMessageParams) => {});
    const channelRuntime = {
      commands: {
        isControlCommandMessage: () => false,
      },
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: (params: Parameters<typeof createInboundDebouncer>[0]) =>
          createInboundDebouncer(params),
      },
    } as unknown as PluginRuntime["channel"];

    const handler = createFeishuMessageReceiveHandler({
      cfg: {} as ClawdbotConfig,
      channelRuntime,
      accountId: "default",
      chatHistories: new Map(),
      handleMessage,
      resolveDebounceText: () => "same text",
      hasProcessedMessage: vi.fn(async () => false),
      getBotOpenId: () => "ou_bot",
    });
    const shared = {
      senderOpenId: "ou-proof-sender",
      senderType: "user" as const,
      chatId: "oc-transport-proof",
      chatType: "topic_group" as const,
      text: "same text",
      createTime: "1710000000000",
    };

    await handler(
      createTextEvent({
        ...shared,
        messageId: "om_proof_a_child",
        rootId: "om_proof_a_root",
        threadId: "omt_proof_a",
      }),
    );
    await handler(
      createTextEvent({
        ...shared,
        messageId: "om_proof_b_child",
        rootId: "om_proof_b_root",
        threadId: "omt_proof_b",
      }),
    );
    await handler(
      createTextEvent({
        ...shared,
        messageId: "om_proof_a_retry",
        rootId: "om_proof_a_root",
        threadId: "omt_proof_a",
      }),
    );

    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(handleMessage.mock.calls.map(([params]) => params.event.message.message_id)).toEqual([
      "om_proof_a_child",
      "om_proof_b_child",
    ]);
  });
});
