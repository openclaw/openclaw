import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeFeishuEvent } from "./event.model.js";
import {
  buildFeishuEventSubscriptionSubscriber,
  createFeishuEventSubscriptionRegistry,
  matchesFeishuEventSubscription,
  subscribeFeishuEventSubscriptions,
} from "./event.subscription.js";
import {
  clearFeishuEventTopicBusForTest,
  publishFeishuEventToTopicBus,
} from "./event.topic-bus.js";

function createApprovalEvent() {
  return normalizeFeishuEvent({
    accountId: "default",
    eventType: "approval.approval.updated_v4",
    payload: {
      event_id: "evt_approval_1",
      approval_code: "approval_123",
      instance_code: "instance_123",
    },
  });
}

afterEach(() => {
  clearFeishuEventTopicBusForTest();
});

describe("event.subscription", () => {
  it("matches categories, subtypes, and explicit event types together", () => {
    const delivery = {
      topic: "feishu.approval.approval.updated_v4",
      event: createApprovalEvent(),
      publishedAt: Date.now(),
    } as const;

    expect(
      matchesFeishuEventSubscription(
        {
          id: "approval-updated",
          eventTypes: ["approval.approval.updated_v4"],
          categories: ["approval.instance"],
          subtypes: ["updated"],
        },
        delivery,
      ),
    ).toBe(true);
  });

  it("builds a topic-bus subscriber that emits trigger plans", async () => {
    const onMatch = vi.fn(async () => {});
    const subscriber = buildFeishuEventSubscriptionSubscriber({
      subscription: {
        id: "approval-trigger",
        eventTypes: ["approval.approval.updated_v4"],
        trigger: {
          mode: "isolated",
          agentId: "reviewer",
        },
      },
      onMatch,
    });

    await subscriber.onEvent({
      topic: "feishu.approval.approval.updated_v4",
      event: createApprovalEvent(),
      publishedAt: Date.now(),
    });

    expect(onMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: "approval-trigger",
        triggerPlan: expect.objectContaining({
          agentId: "reviewer",
          mode: "isolated",
          sessionKeyHint:
            "agent:reviewer:cron:feishu-event:default:approval.instance:evt_approval_1",
        }),
      }),
    );
  });

  it("subscribes definitions to the singleton topic bus", async () => {
    const onMatch = vi.fn(async () => {});
    const unsubscribe = subscribeFeishuEventSubscriptions({
      subscriptions: [
        {
          id: "approval-sub",
          categories: ["approval.instance"],
          trigger: {
            mode: "main",
          },
        },
      ],
      onMatch,
    });

    publishFeishuEventToTopicBus({ event: createApprovalEvent() });

    await Promise.resolve();
    await Promise.resolve();
    expect(onMatch).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("tracks registered definitions in the local registry", () => {
    const registry = createFeishuEventSubscriptionRegistry();
    const unregister = registry.register({
      id: "approval-registry",
      categories: ["approval.instance"],
    });

    expect(registry.list().map((entry) => entry.id)).toEqual(["approval-registry"]);
    unregister();
    expect(registry.list()).toEqual([]);
  });
});
