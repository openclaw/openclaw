import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapFeishuEventDispatcher } from "./event.hijacker.js";
import {
  clearFeishuEventTopicBusForTest,
  subscribeFeishuEventTopicBus,
} from "./event.topic-bus.js";

type RegisteredHandlers = Record<string, (data: unknown) => Promise<unknown> | unknown>;

function createMockDispatcher() {
  const state: { handlers: RegisteredHandlers } = { handlers: {} };
  return {
    dispatcher: {
      register(handlers: RegisteredHandlers) {
        state.handlers = handlers;
      },
      invoke: vi.fn(),
    },
    getHandlers() {
      return state.handlers;
    },
  };
}

describe("event.hijacker", () => {
  afterEach(() => {
    clearFeishuEventTopicBusForTest();
  });

  it("keeps IM message events on the direct path", async () => {
    const { dispatcher, getHandlers } = createMockDispatcher();
    const directHandler = vi.fn(async () => {});
    const observeEvent = vi.fn(async () => {});

    const wrappedDispatcher = wrapFeishuEventDispatcher({
      eventDispatcher: dispatcher,
      accountId: "default",
      observeEvent,
    });

    wrappedDispatcher.register({
      "im.message.receive_v1": directHandler,
    });

    await getHandlers()["im.message.receive_v1"]({
      sender: { sender_id: { open_id: "ou_user_1" } },
      message: { message_id: "om_1", chat_id: "oc_1" },
    });

    expect(directHandler).toHaveBeenCalledTimes(1);
    expect(observeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "im.message.receive_v1",
        route: "direct",
        droppedAsDuplicate: false,
      }),
    );
  });

  it("deduplicates publish-path events before invoking legacy handlers", async () => {
    const { dispatcher, getHandlers } = createMockDispatcher();
    const publishHandler = vi.fn(async () => {});
    const hasProcessedEvent = vi
      .fn<
        Parameters<
          NonNullable<Parameters<typeof wrapFeishuEventDispatcher>[0]["hasProcessedEvent"]>
        >,
        ReturnType<
          NonNullable<Parameters<typeof wrapFeishuEventDispatcher>[0]["hasProcessedEvent"]>
        >
      >()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const recordProcessedEvent = vi.fn(async () => true);

    const wrappedDispatcher = wrapFeishuEventDispatcher({
      eventDispatcher: dispatcher,
      accountId: "default",
      hasProcessedEvent,
      recordProcessedEvent,
    });

    wrappedDispatcher.register({
      "im.chat.member.bot.added_v1": publishHandler,
    });

    const payload = {
      chat_id: "oc_chat_1",
      operator_id: { open_id: "ou_operator" },
    };
    await getHandlers()["im.chat.member.bot.added_v1"](payload);
    await getHandlers()["im.chat.member.bot.added_v1"](payload);

    expect(publishHandler).toHaveBeenCalledTimes(1);
    expect(recordProcessedEvent).toHaveBeenCalledTimes(1);
    expect(hasProcessedEvent).toHaveBeenCalledTimes(2);
  });

  it("publishes normalized publish-path events to the topic bus", async () => {
    const { dispatcher, getHandlers } = createMockDispatcher();
    const publishHandler = vi.fn(async () => {});
    const topicBusHandler = vi.fn(async () => {});
    subscribeFeishuEventTopicBus({
      id: "bot-added-subscriber",
      topics: ["feishu.im.chat.member.bot.added_v1"],
      onEvent: topicBusHandler,
    });

    const wrappedDispatcher = wrapFeishuEventDispatcher({
      eventDispatcher: dispatcher,
      accountId: "default",
    });

    wrappedDispatcher.register({
      "im.chat.member.bot.added_v1": publishHandler,
    });

    await getHandlers()["im.chat.member.bot.added_v1"]({
      chat_id: "oc_chat_1",
      operator_id: { open_id: "ou_operator" },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(publishHandler).toHaveBeenCalledTimes(1);
    expect(topicBusHandler).toHaveBeenCalledTimes(1);
    expect(topicBusHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "feishu.im.chat.member.bot.added_v1",
        event: expect.objectContaining({
          sourceId: "oc_chat_1",
          route: "publish",
          category: "im.chat",
        }),
      }),
    );
  });
});
