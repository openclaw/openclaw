// Feishu tests cover message handler queue-key scheduling behavior.
import {
  createInboundDebouncer,
  type InboundDebounceCreateParams,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

function createTextEvent(params: {
  messageId: string;
  chatId?: string;
  rootId?: string;
  threadId?: string;
  text?: string;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: "ou_sender_1",
      },
    },
    message: {
      message_id: params.messageId,
      chat_id: params.chatId ?? "oc_group",
      chat_type: "topic_group",
      ...(params.rootId ? { root_id: params.rootId } : {}),
      ...(params.threadId ? { thread_id: params.threadId } : {}),
      message_type: "text",
      content: JSON.stringify({ text: params.text ?? params.messageId }),
    },
  };
}

function createRuntime(): PluginRuntime["channel"] {
  return {
    debounce: {
      resolveInboundDebounceMs: vi.fn(() => 0),
      createInboundDebouncer: vi.fn(
        (options: { onFlush: (entries: FeishuMessageEvent[]) => Promise<void> | void }) => ({
          enqueue: async (event: FeishuMessageEvent) => {
            await options.onFlush([event]);
          },
        }),
      ),
    },
    commands: {
      isControlCommandMessage: vi.fn(() => false),
    },
  } as unknown as PluginRuntime["channel"];
}

function createRuntimeWithControlCommands(): PluginRuntime["channel"] {
  return {
    debounce: {
      resolveInboundDebounceMs: vi.fn(() => 0),
      createInboundDebouncer: vi.fn(
        (options: { onFlush: (entries: FeishuMessageEvent[]) => Promise<void> | void }) => ({
          enqueue: async (event: FeishuMessageEvent) => {
            await options.onFlush([event]);
          },
        }),
      ),
    },
    commands: {
      isControlCommandMessage: vi.fn((text: string) => text.trim().startsWith("/")),
    },
  } as unknown as PluginRuntime["channel"];
}

function createRuntimeWithRealDebouncer(debounceMs: number): PluginRuntime["channel"] {
  return {
    debounce: {
      resolveInboundDebounceMs: vi.fn(() => debounceMs),
      createInboundDebouncer: vi.fn((options: InboundDebounceCreateParams<FeishuMessageEvent>) =>
        createInboundDebouncer(options),
      ),
    },
    commands: {
      isControlCommandMessage: vi.fn(() => false),
    },
  } as unknown as PluginRuntime["channel"];
}

function createRealDebounceHandler(params: {
  debounceMs?: number;
  resolveSequentialKey: (event: FeishuMessageEvent) => string;
}) {
  const handledEvents: FeishuMessageEvent[] = [];
  const recordProcessedMessage = vi.fn(async () => true);
  const handler = createFeishuMessageReceiveHandler({
    cfg: {} as ClawdbotConfig,
    channelRuntime: createRuntimeWithRealDebouncer(params.debounceMs ?? 25),
    accountId: "default",
    chatHistories: new Map(),
    handleMessage: vi.fn(async ({ event }: { event: FeishuMessageEvent }) => {
      handledEvents.push(event);
    }),
    resolveDebounceText: ({ event }) => JSON.parse(event.message.content).text,
    hasProcessedMessage: vi.fn(async () => false),
    recordProcessedMessage,
    resolveSequentialKey: vi.fn(({ event }) => params.resolveSequentialKey(event)),
  });
  return { handler, handledEvents, recordProcessedMessage };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createFeishuMessageReceiveHandler sequential key scheduling", () => {
  it("passes hydrated key-resolution events to message handling", async () => {
    const handledEvents: FeishuMessageEvent[] = [];
    const handler = createFeishuMessageReceiveHandler({
      cfg: {} as ClawdbotConfig,
      channelRuntime: createRuntime(),
      accountId: "default",
      chatHistories: new Map(),
      handleMessage: vi.fn(async ({ event }: { event: FeishuMessageEvent }) => {
        handledEvents.push(event);
      }),
      resolveDebounceText: ({ event }) => JSON.parse(event.message.content).text,
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
      resolveSequentialKey: vi.fn(({ event }) => ({
        key: "feishu:default:oc_group:topic:omt_topic",
        event: {
          ...event,
          message: {
            ...event.message,
            thread_id: "omt_topic",
          },
        },
      })),
    });

    await handler(createTextEvent({ messageId: "om_topic_starter" }));

    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]?.message.thread_id).toBe("omt_topic");
  });

  it("keeps same-chat enqueue order when the first key resolution is async", async () => {
    const firstKey = deferred<string>();
    const keyCalls: string[] = [];
    const handleOrder: string[] = [];
    const handler = createFeishuMessageReceiveHandler({
      cfg: {} as ClawdbotConfig,
      channelRuntime: createRuntime(),
      accountId: "default",
      chatHistories: new Map(),
      handleMessage: vi.fn(async ({ event }: { event: FeishuMessageEvent }) => {
        handleOrder.push(event.message.message_id);
      }),
      resolveDebounceText: ({ event }) => JSON.parse(event.message.content).text,
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
      resolveSequentialKey: vi.fn(({ event }) => {
        keyCalls.push(event.message.message_id);
        if (event.message.message_id === "om_first") {
          return firstKey.promise;
        }
        return "feishu:default:oc_group:topic:omt_topic";
      }),
    });

    const firstDispatch = handler(createTextEvent({ messageId: "om_first" }));
    const secondDispatch = handler(createTextEvent({ messageId: "om_second" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(keyCalls).toEqual(["om_first"]);
    firstKey.resolve("feishu:default:oc_group:topic:omt_topic");
    await Promise.all([firstDispatch, secondDispatch]);

    expect(keyCalls).toEqual(["om_first", "om_second"]);
    expect(handleOrder).toEqual(["om_first", "om_second"]);
  });

  it("keeps fallback hydrated starters ahead of later same-chat key resolution", async () => {
    const finishFirst = deferred<void>();
    const keyCalls: string[] = [];
    const started: string[] = [];
    const handler = createFeishuMessageReceiveHandler({
      cfg: {} as ClawdbotConfig,
      channelRuntime: createRuntime(),
      accountId: "default",
      chatHistories: new Map(),
      handleMessage: vi.fn(async ({ event }: { event: FeishuMessageEvent }) => {
        started.push(event.message.message_id);
        if (event.message.message_id === "om_fallback_first") {
          await finishFirst.promise;
        }
      }),
      resolveDebounceText: ({ event }) => JSON.parse(event.message.content).text,
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
      resolveSequentialKey: vi.fn(({ event }) => {
        keyCalls.push(event.message.message_id);
        if (event.message.message_id === "om_fallback_first") {
          return {
            key: "feishu:default:oc_group:topic:om_fallback_first",
            waitForTaskBeforeNextChatKey: true,
          };
        }
        return "feishu:default:oc_group:topic:omt_topic";
      }),
    });

    const firstDispatch = handler(createTextEvent({ messageId: "om_fallback_first" }));
    const secondDispatch = handler(
      createTextEvent({ messageId: "om_fallback_second", threadId: "omt_topic" }),
    );
    await vi.waitFor(() => {
      expect(started).toEqual(["om_fallback_first"]);
    });
    expect(keyCalls).toEqual(["om_fallback_first"]);

    finishFirst.resolve();
    await Promise.all([firstDispatch, secondDispatch]);

    expect(keyCalls).toEqual(["om_fallback_first", "om_fallback_second"]);
    expect(started).toEqual(["om_fallback_first", "om_fallback_second"]);
  });

  it("does not block control lanes behind fallback topic hydration", async () => {
    const finishFirst = deferred<void>();
    const keyCalls: string[] = [];
    const started: string[] = [];
    const handler = createFeishuMessageReceiveHandler({
      cfg: {} as ClawdbotConfig,
      channelRuntime: createRuntimeWithControlCommands(),
      accountId: "default",
      chatHistories: new Map(),
      handleMessage: vi.fn(async ({ event }: { event: FeishuMessageEvent }) => {
        started.push(event.message.message_id);
        if (event.message.message_id === "om_control_fallback_first") {
          await finishFirst.promise;
        }
      }),
      resolveDebounceText: ({ event }) => JSON.parse(event.message.content).text,
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
      resolveSequentialKey: vi.fn(({ event }) => {
        keyCalls.push(event.message.message_id);
        if (event.message.message_id === "om_control_fallback_first") {
          return {
            key: "feishu:default:oc_group:topic:om_control_fallback_first",
            waitForTaskBeforeNextChatKey: true,
          };
        }
        return "feishu:default:oc_group:control";
      }),
    });

    const firstDispatch = handler(createTextEvent({ messageId: "om_control_fallback_first" }));
    const stopDispatch = handler(createTextEvent({ messageId: "om_control_stop", text: "/stop" }));
    await vi.waitFor(() => {
      expect(started).toHaveLength(2);
      expect(started).toContain("om_control_fallback_first");
      expect(started).toContain("om_control_stop");
    });
    expect(keyCalls).toHaveLength(2);
    expect(keyCalls).toContain("om_control_fallback_first");
    expect(keyCalls).toContain("om_control_stop");

    finishFirst.resolve();
    await Promise.all([firstDispatch, stopDispatch]);
  });

  it("keeps session-mutating commands behind fallback topic ordering", async () => {
    const finishFirst = deferred<void>();
    const keyCalls: string[] = [];
    const started: string[] = [];
    const handler = createFeishuMessageReceiveHandler({
      cfg: {} as ClawdbotConfig,
      channelRuntime: createRuntimeWithControlCommands(),
      accountId: "default",
      chatHistories: new Map(),
      handleMessage: vi.fn(async ({ event }: { event: FeishuMessageEvent }) => {
        started.push(event.message.message_id);
        if (event.message.message_id === "om_command_fallback_first") {
          await finishFirst.promise;
        }
      }),
      resolveDebounceText: ({ event }) => JSON.parse(event.message.content).text,
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
      resolveSequentialKey: vi.fn(({ event }) => {
        keyCalls.push(event.message.message_id);
        if (event.message.message_id === "om_command_fallback_first") {
          return {
            key: "feishu:default:oc_group:topic:om_command_fallback_first",
            waitForTaskBeforeNextChatKey: true,
          };
        }
        return "feishu:default:oc_group:topic:omt_topic";
      }),
    });

    const firstDispatch = handler(createTextEvent({ messageId: "om_command_fallback_first" }));
    const resetDispatch = handler(
      createTextEvent({ messageId: "om_command_reset", text: "/reset" }),
    );
    await vi.waitFor(() => {
      expect(started).toEqual(["om_command_fallback_first"]);
    });
    expect(keyCalls).toEqual(["om_command_fallback_first"]);

    finishFirst.resolve();
    await Promise.all([firstDispatch, resetDispatch]);

    expect(keyCalls).toEqual(["om_command_fallback_first", "om_command_reset"]);
    expect(started).toEqual(["om_command_fallback_first", "om_command_reset"]);
  });

  it("allows different resolved topic keys to run concurrently after ordered enqueue", async () => {
    const finishFirst = deferred<void>();
    const started: string[] = [];
    const finished: string[] = [];
    const handler = createFeishuMessageReceiveHandler({
      cfg: {} as ClawdbotConfig,
      channelRuntime: createRuntime(),
      accountId: "default",
      chatHistories: new Map(),
      handleMessage: vi.fn(async ({ event }: { event: FeishuMessageEvent }) => {
        started.push(event.message.message_id);
        if (event.message.message_id === "om_topic_1") {
          await finishFirst.promise;
        }
        finished.push(event.message.message_id);
      }),
      resolveDebounceText: ({ event }) => JSON.parse(event.message.content).text,
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
      resolveSequentialKey: vi.fn(
        ({ event }) =>
          `feishu:default:oc_group:topic:${event.message.thread_id ?? event.message.message_id}`,
      ),
    });

    const firstDispatch = handler(
      createTextEvent({ messageId: "om_topic_1", threadId: "omt_topic_1" }),
    );
    const secondDispatch = handler(
      createTextEvent({ messageId: "om_topic_2", threadId: "omt_topic_2" }),
    );
    await vi.waitFor(() => {
      expect(started).toEqual(["om_topic_1", "om_topic_2"]);
    });
    expect(finished).toEqual(["om_topic_2"]);
    finishFirst.resolve();
    await Promise.all([firstDispatch, secondDispatch]);
    expect(finished).toEqual(["om_topic_2", "om_topic_1"]);
  });

  it("does not debounce unrelated native topic starters together before hydration", async () => {
    vi.useFakeTimers();
    try {
      const { handler, handledEvents } = createRealDebounceHandler({
        resolveSequentialKey: vi.fn(
          (event) => `feishu:default:oc_group:topic:${event.message.message_id}`,
        ),
      });

      await handler(createTextEvent({ messageId: "om_starter_a", text: "starter A" }));
      await handler(createTextEvent({ messageId: "om_starter_b", text: "starter B" }));
      await vi.advanceTimersByTimeAsync(25);

      expect(handledEvents.map((event) => event.message.message_id)).toEqual([
        "om_starter_a",
        "om_starter_b",
      ]);
      expect(handledEvents.map((event) => JSON.parse(event.message.content).text)).toEqual([
        "starter A",
        "starter B",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not debounce different hydrated topic replies together", async () => {
    vi.useFakeTimers();
    try {
      const { handler, handledEvents } = createRealDebounceHandler({
        resolveSequentialKey: vi.fn(
          (event) => `feishu:default:oc_group:topic:${event.message.thread_id}`,
        ),
      });

      await handler(
        createTextEvent({
          messageId: "om_reply_a",
          threadId: "omt_topic_a",
          text: "reply A",
        }),
      );
      await handler(
        createTextEvent({
          messageId: "om_reply_b",
          threadId: "omt_topic_b",
          text: "reply B",
        }),
      );
      await vi.advanceTimersByTimeAsync(25);

      expect(handledEvents.map((event) => event.message.message_id)).toEqual([
        "om_reply_a",
        "om_reply_b",
      ]);
      expect(handledEvents.map((event) => JSON.parse(event.message.content).text)).toEqual([
        "reply A",
        "reply B",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still debounces same-topic replies from the same sender", async () => {
    vi.useFakeTimers();
    try {
      const { handler, handledEvents, recordProcessedMessage } = createRealDebounceHandler({
        resolveSequentialKey: vi.fn(
          (event) => `feishu:default:oc_group:topic:${event.message.thread_id}`,
        ),
      });

      await handler(
        createTextEvent({
          messageId: "om_same_topic_1",
          threadId: "omt_same_topic",
          text: "first",
        }),
      );
      await handler(
        createTextEvent({
          messageId: "om_same_topic_2",
          threadId: "omt_same_topic",
          text: "second",
        }),
      );
      await vi.advanceTimersByTimeAsync(25);

      expect(handledEvents).toHaveLength(1);
      expect(handledEvents[0]?.message.message_id).toBe("om_same_topic_2");
      expect(JSON.parse(handledEvents[0]?.message.content ?? "{}")).toEqual({
        text: "first\nsecond",
      });
      expect(recordProcessedMessage).toHaveBeenCalledWith(
        "om_same_topic_1",
        "default",
        expect.any(Function),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
