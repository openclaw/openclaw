import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeFeishuEvent } from "./event.model.js";
import {
  buildFeishuEventTopic,
  clearFeishuEventTopicBusForTest,
  createFeishuEventTopicBus,
  getFeishuEventTopicBusSubscriberCountForTest,
  publishFeishuEventToTopicBus,
  subscribeFeishuEventTopicBus,
} from "./event.topic-bus.js";

function createBitableEvent() {
  return normalizeFeishuEvent({
    accountId: "default",
    eventType: "drive.file.bitable_record_changed_v1",
    payload: {
      event_id: "evt_123",
      app_token: "bascn_123",
      table_id: "tbl_123",
      record: {
        record_id: "rec_123",
      },
    },
  });
}

afterEach(() => {
  clearFeishuEventTopicBusForTest();
});

describe("event.topic-bus", () => {
  it("builds a topic from the raw Feishu event type", () => {
    expect(buildFeishuEventTopic(createBitableEvent())).toBe(
      "feishu.drive.file.bitable_record_changed_v1",
    );
  });

  it("matches both exact topics and wildcard prefixes", async () => {
    const bus = createFeishuEventTopicBus();
    const received: string[] = [];

    bus.subscribe({
      id: "exact",
      topics: ["feishu.drive.file.bitable_record_changed_v1"],
      onEvent: async (delivery) => {
        received.push(`exact:${delivery.event.sourceId}`);
      },
    });
    bus.subscribe({
      id: "wildcard",
      topics: ["feishu.drive.file.*"],
      onEvent: async (delivery) => {
        received.push(`wildcard:${delivery.event.sourceId}`);
      },
    });

    const publishResult = bus.publish({ event: createBitableEvent() });

    expect(publishResult.matchedSubscribers).toBe(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual(["exact:rec_123", "wildcard:rec_123"]);
  });

  it("applies per-subscriber filtering before enqueueing", async () => {
    const bus = createFeishuEventTopicBus();
    const handler = vi.fn(async () => {});

    bus.subscribe({
      id: "filtered",
      topics: ["feishu.drive.file.*"],
      filter: (delivery) => delivery.event.subject?.tokens.tableId === "tbl_999",
      onEvent: handler,
    });

    const publishResult = bus.publish({ event: createBitableEvent() });

    expect(publishResult.matchedSubscribers).toBe(0);
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it("publishes through the default singleton bus", async () => {
    const handler = vi.fn(async () => {});
    const unsubscribe = subscribeFeishuEventTopicBus({
      id: "singleton",
      topics: ["feishu.drive.file.*"],
      onEvent: handler,
    });

    expect(getFeishuEventTopicBusSubscriberCountForTest()).toBe(1);
    publishFeishuEventToTopicBus({ event: createBitableEvent() });

    await Promise.resolve();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(getFeishuEventTopicBusSubscriberCountForTest()).toBe(0);
  });
});
