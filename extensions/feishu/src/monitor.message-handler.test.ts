// Feishu tests cover monitor.message handler plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";
import { releaseFeishuMessageProcessing } from "./processing-claims.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

type MessageReceiveHandlerContext = Parameters<typeof createFeishuMessageReceiveHandler>[0];
type HandleMessageParams = Parameters<MessageReceiveHandlerContext["handleMessage"]>[0];

function createDeferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

function createTextEvent(params: {
  messageId: string;
  senderOpenId: string;
  senderType: "bot" | "user";
  text?: string;
  chatId?: string;
  chatType?: FeishuMessageEvent["message"]["chat_type"];
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
      ...(params.rootId ? { root_id: params.rootId } : {}),
      ...(params.threadId ? { thread_id: params.threadId } : {}),
      message_type: "text",
      content: JSON.stringify({ text: params.text ?? "hello" }),
    },
  };
}

function createHandler() {
  let onFlush: ((entries: FeishuMessageEvent[]) => Promise<void>) | undefined;
  const enqueue = vi.fn(async (event: FeishuMessageEvent) => {
    await onFlush?.([event]);
  });
  const channelRuntime = {
    commands: {
      isControlCommandMessage: () => false,
    },
    debounce: {
      resolveInboundDebounceMs: () => 0,
      createInboundDebouncer: vi.fn((params: { onFlush: typeof onFlush }) => {
        onFlush = params.onFlush;
        return { enqueue };
      }),
    },
  } as unknown as PluginRuntime["channel"];
  const handleMessage = vi.fn(async (params: HandleMessageParams) => {
    releaseFeishuMessageProcessing(
      params.messageDedupeKey ?? resolveFeishuMessageDedupeKey(params.event),
      params.accountId,
    );
  });

  const handler = createFeishuMessageReceiveHandler({
    cfg: {} as ClawdbotConfig,
    channelRuntime,
    accountId: "default",
    chatHistories: new Map(),
    handleMessage,
    resolveDebounceText: () => "hello",
    hasProcessedMessage: vi.fn(async () => false),
    recordProcessedMessage: vi.fn(async () => true),
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
});

describe("createFeishuMessageReceiveHandler topic queueing", () => {
  it("runs different Feishu thread ids concurrently even when websocket labels the chat as group", async () => {
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const order: string[] = [];
    const handleMessage = vi.fn(async (params: HandleMessageParams) => {
      const threadId = params.event.message.thread_id;
      order.push(`${threadId}:start`);
      try {
        await (threadId === "omt_thread_1" ? releaseFirst.promise : releaseSecond.promise);
      } finally {
        order.push(`${threadId}:end`);
        releaseFeishuMessageProcessing(
          params.messageDedupeKey ?? resolveFeishuMessageDedupeKey(params.event),
          params.accountId,
        );
      }
    });
    const channelRuntime = {
      commands: {
        isControlCommandMessage: () => false,
      },
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: (params: {
          onFlush: (entries: FeishuMessageEvent[]) => Promise<void>;
        }) => ({
          enqueue: async (event: FeishuMessageEvent) => {
            await params.onFlush([event]);
          },
        }),
      },
    } as unknown as PluginRuntime["channel"];
    const handler = createFeishuMessageReceiveHandler({
      cfg: {} as ClawdbotConfig,
      channelRuntime,
      accountId: "default",
      chatHistories: new Map(),
      handleMessage,
      resolveDebounceText: ({ event }) =>
        (JSON.parse(event.message.content) as { text: string }).text,
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
      resolveSequentialKey: getFeishuSequentialKey,
    });

    const first = handler(
      createTextEvent({
        messageId: "om_thread_1_message",
        senderOpenId: "ou_user",
        senderType: "user",
        chatId: "oc_topic_group",
        chatType: "group",
        threadId: "omt_thread_1",
      }),
    );
    const second = handler(
      createTextEvent({
        messageId: "om_thread_2_message",
        senderOpenId: "ou_user",
        senderType: "user",
        chatId: "oc_topic_group",
        chatType: "group",
        threadId: "omt_thread_2",
      }),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["omt_thread_1:start", "omt_thread_2:start"]);

    releaseSecond.resolve();
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "omt_thread_1:start",
      "omt_thread_2:start",
      "omt_thread_2:end",
      "omt_thread_1:end",
    ]);
  });

  it("runs different Feishu topic-group topics concurrently", async () => {
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const order: string[] = [];
    const handleMessage = vi.fn(async (params: HandleMessageParams) => {
      const threadId = params.event.message.thread_id;
      order.push(`${threadId}:start`);
      try {
        await (threadId === "omt_topic_1" ? releaseFirst.promise : releaseSecond.promise);
      } finally {
        order.push(`${threadId}:end`);
        releaseFeishuMessageProcessing(
          params.messageDedupeKey ?? resolveFeishuMessageDedupeKey(params.event),
          params.accountId,
        );
      }
    });
    const channelRuntime = {
      commands: {
        isControlCommandMessage: () => false,
      },
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: (params: {
          onFlush: (entries: FeishuMessageEvent[]) => Promise<void>;
        }) => ({
          enqueue: async (event: FeishuMessageEvent) => {
            await params.onFlush([event]);
          },
        }),
      },
    } as unknown as PluginRuntime["channel"];
    const handler = createFeishuMessageReceiveHandler({
      cfg: {} as ClawdbotConfig,
      channelRuntime,
      accountId: "default",
      chatHistories: new Map(),
      handleMessage,
      resolveDebounceText: ({ event }) =>
        (JSON.parse(event.message.content) as { text: string }).text,
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
      resolveSequentialKey: getFeishuSequentialKey,
    });

    const first = handler(
      createTextEvent({
        messageId: "om_topic_1_message",
        senderOpenId: "ou_user",
        senderType: "user",
        chatId: "oc_topic_group",
        chatType: "topic_group",
        rootId: "om_topic_1_root",
        threadId: "omt_topic_1",
      }),
    );
    const second = handler(
      createTextEvent({
        messageId: "om_topic_2_message",
        senderOpenId: "ou_user",
        senderType: "user",
        chatId: "oc_topic_group",
        chatType: "topic_group",
        rootId: "om_topic_2_root",
        threadId: "omt_topic_2",
      }),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["omt_topic_1:start", "omt_topic_2:start"]);

    releaseSecond.resolve();
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "omt_topic_1:start",
      "omt_topic_2:start",
      "omt_topic_2:end",
      "omt_topic_1:end",
    ]);
  });

  it("serializes messages from the same Feishu topic-group topic", async () => {
    const releaseFirst = createDeferred();
    const order: string[] = [];
    const handleMessage = vi.fn(async (params: HandleMessageParams) => {
      order.push(params.event.message.message_id);
      try {
        if (params.event.message.message_id === "om_topic_1_first") {
          await releaseFirst.promise;
        }
      } finally {
        releaseFeishuMessageProcessing(
          params.messageDedupeKey ?? resolveFeishuMessageDedupeKey(params.event),
          params.accountId,
        );
      }
    });
    const channelRuntime = {
      commands: {
        isControlCommandMessage: () => false,
      },
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: (params: {
          onFlush: (entries: FeishuMessageEvent[]) => Promise<void>;
        }) => ({
          enqueue: async (event: FeishuMessageEvent) => {
            await params.onFlush([event]);
          },
        }),
      },
    } as unknown as PluginRuntime["channel"];
    const handler = createFeishuMessageReceiveHandler({
      cfg: {} as ClawdbotConfig,
      channelRuntime,
      accountId: "default",
      chatHistories: new Map(),
      handleMessage,
      resolveDebounceText: ({ event }) =>
        (JSON.parse(event.message.content) as { text: string }).text,
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
      resolveSequentialKey: getFeishuSequentialKey,
    });

    const first = handler(
      createTextEvent({
        messageId: "om_topic_1_first",
        senderOpenId: "ou_user",
        senderType: "user",
        chatId: "oc_topic_group",
        chatType: "topic_group",
        rootId: "om_topic_1_root",
        threadId: "omt_topic_1",
      }),
    );
    const second = handler(
      createTextEvent({
        messageId: "om_topic_1_second",
        senderOpenId: "ou_user",
        senderType: "user",
        chatId: "oc_topic_group",
        chatType: "topic_group",
        rootId: "om_topic_1_root",
        threadId: "omt_topic_1",
      }),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["om_topic_1_first"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["om_topic_1_first", "om_topic_1_second"]);
  });

  it("serializes a topic starter that needs thread_id hydration with later same-topic replies", async () => {
    const releaseFetch = createDeferred();
    const releaseFirst = createDeferred();
    const order: string[] = [];
    const handleMessage = vi.fn(async (params: HandleMessageParams) => {
      order.push(`${params.event.message.message_id}:start:${params.event.message.thread_id}`);
      try {
        if (params.event.message.message_id === "om_topic_starter") {
          await releaseFirst.promise;
        }
      } finally {
        order.push(`${params.event.message.message_id}:end`);
        releaseFeishuMessageProcessing(
          params.messageDedupeKey ?? resolveFeishuMessageDedupeKey(params.event),
          params.accountId,
        );
      }
    });
    const channelRuntime = {
      commands: {
        isControlCommandMessage: () => false,
      },
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: (params: {
          onFlush: (entries: FeishuMessageEvent[]) => Promise<void>;
        }) => ({
          enqueue: async (event: FeishuMessageEvent) => {
            await params.onFlush([event]);
          },
        }),
      },
    } as unknown as PluginRuntime["channel"];
    const handler = createFeishuMessageReceiveHandler({
      cfg: {} as ClawdbotConfig,
      channelRuntime,
      accountId: "default",
      chatHistories: new Map(),
      handleMessage,
      resolveDebounceText: ({ event }) =>
        (JSON.parse(event.message.content) as { text: string }).text,
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
      fetchMessage: vi.fn(async () => {
        await releaseFetch.promise;
        return {
          messageId: "om_topic_starter",
          chatId: "oc_topic_group",
          chatType: "topic_group",
          content: "starter",
          contentType: "text",
          threadId: "omt_topic_1",
        };
      }),
      resolveSequentialKey: getFeishuSequentialKey,
    });

    const first = handler(
      createTextEvent({
        messageId: "om_topic_starter",
        senderOpenId: "ou_user",
        senderType: "user",
        chatId: "oc_topic_group",
        chatType: "topic_group",
      }),
    );
    const second = handler(
      createTextEvent({
        messageId: "om_topic_reply",
        senderOpenId: "ou_user",
        senderType: "user",
        chatId: "oc_topic_group",
        chatType: "topic_group",
        rootId: "om_topic_starter",
        threadId: "omt_topic_1",
      }),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);

    releaseFetch.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["om_topic_starter:start:omt_topic_1"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "om_topic_starter:start:omt_topic_1",
      "om_topic_starter:end",
      "om_topic_reply:start:omt_topic_1",
      "om_topic_reply:end",
    ]);
  });
});
