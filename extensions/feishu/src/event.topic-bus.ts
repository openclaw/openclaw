import type { RuntimeEnv } from "../runtime-api.js";
import type { NormalizedFeishuEvent } from "./event.model.js";

export const FEISHU_EVENT_TOPIC_BUS_TAG = "[managed-by=feishu.event-topic-bus]";

export type FeishuEventTopic = `feishu.${string}`;

export type FeishuEventBusDelivery = {
  topic: FeishuEventTopic;
  event: NormalizedFeishuEvent;
  publishedAt: number;
};

export type FeishuEventBusSubscriber = {
  id: string;
  topics: readonly string[];
  concurrencyLimit?: number;
  filter?: (delivery: FeishuEventBusDelivery) => boolean;
  onEvent: (delivery: FeishuEventBusDelivery) => Promise<void> | void;
};

type TopicBusRuntime = Pick<RuntimeEnv, "log" | "error">;

type SubscriberState = {
  subscriber: FeishuEventBusSubscriber;
  concurrencyLimit: number;
  inFlight: number;
  pending: FeishuEventBusDelivery[];
  drainScheduled: boolean;
};

export type FeishuEventTopicBus = {
  subscribe: (subscriber: FeishuEventBusSubscriber) => () => void;
  publish: (params: {
    event: NormalizedFeishuEvent;
    topic?: FeishuEventTopic;
    runtime?: TopicBusRuntime;
    publishedAt?: number;
  }) => { topic: FeishuEventTopic; matchedSubscribers: number };
  getSubscriberCount: () => number;
  clearForTest: () => void;
};

function normalizeConcurrencyLimit(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 1;
}

function matchesTopicPattern(topic: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) {
    return false;
  }
  if (normalizedPattern.endsWith(".*")) {
    return topic.startsWith(normalizedPattern.slice(0, -1));
  }
  return topic === normalizedPattern;
}

function scheduleDrain(state: SubscriberState, runtime: TopicBusRuntime | undefined): void {
  if (state.drainScheduled) {
    return;
  }
  state.drainScheduled = true;
  queueMicrotask(() => {
    state.drainScheduled = false;
    drainSubscriberQueue(state, runtime);
  });
}

function drainSubscriberQueue(state: SubscriberState, runtime: TopicBusRuntime | undefined): void {
  const error = runtime?.error ?? console.error;
  while (state.inFlight < state.concurrencyLimit) {
    const delivery = state.pending.shift();
    if (!delivery) {
      return;
    }
    state.inFlight += 1;
    Promise.resolve(state.subscriber.onEvent(delivery))
      .catch((err) => {
        error(
          `${FEISHU_EVENT_TOPIC_BUS_TAG} subscriber=${state.subscriber.id} topic=${delivery.topic} failed: ${String(err)}`,
        );
      })
      .finally(() => {
        state.inFlight -= 1;
        scheduleDrain(state, runtime);
      });
  }
}

export function buildFeishuEventTopic(event: NormalizedFeishuEvent): FeishuEventTopic {
  return `feishu.${event.eventType}`;
}

export function createFeishuEventTopicBus(): FeishuEventTopicBus {
  const subscribers = new Map<string, SubscriberState>();

  return {
    subscribe(subscriber) {
      const state: SubscriberState = {
        subscriber,
        concurrencyLimit: normalizeConcurrencyLimit(subscriber.concurrencyLimit),
        inFlight: 0,
        pending: [],
        drainScheduled: false,
      };
      subscribers.set(subscriber.id, state);
      return () => {
        subscribers.delete(subscriber.id);
      };
    },
    publish({ event, topic = buildFeishuEventTopic(event), runtime, publishedAt = Date.now() }) {
      const log = runtime?.log ?? console.log;
      let matchedSubscribers = 0;
      for (const state of subscribers.values()) {
        if (!state.subscriber.topics.some((pattern) => matchesTopicPattern(topic, pattern))) {
          continue;
        }
        const delivery: FeishuEventBusDelivery = { topic, event, publishedAt };
        if (state.subscriber.filter && !state.subscriber.filter(delivery)) {
          continue;
        }
        matchedSubscribers += 1;
        state.pending.push(delivery);
        scheduleDrain(state, runtime);
      }
      if (matchedSubscribers > 0) {
        log(
          `${FEISHU_EVENT_TOPIC_BUS_TAG} topic=${topic} matched=${matchedSubscribers} source=${event.sourceId}`,
        );
      }
      return { topic, matchedSubscribers };
    },
    getSubscriberCount() {
      return subscribers.size;
    },
    clearForTest() {
      subscribers.clear();
    },
  };
}

const defaultFeishuEventTopicBus = createFeishuEventTopicBus();

export function subscribeFeishuEventTopicBus(subscriber: FeishuEventBusSubscriber): () => void {
  return defaultFeishuEventTopicBus.subscribe(subscriber);
}

export function publishFeishuEventToTopicBus(params: {
  event: NormalizedFeishuEvent;
  topic?: FeishuEventTopic;
  runtime?: TopicBusRuntime;
  publishedAt?: number;
}): { topic: FeishuEventTopic; matchedSubscribers: number } {
  return defaultFeishuEventTopicBus.publish(params);
}

export function clearFeishuEventTopicBusForTest(): void {
  defaultFeishuEventTopicBus.clearForTest();
}

export function getFeishuEventTopicBusSubscriberCountForTest(): number {
  return defaultFeishuEventTopicBus.getSubscriberCount();
}
