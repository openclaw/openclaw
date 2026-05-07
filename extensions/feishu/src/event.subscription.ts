import type { RuntimeEnv } from "../runtime-api.js";
import type { NormalizedFeishuEventCategory } from "./event.model.js";
import type {
  FeishuEventBusDelivery,
  FeishuEventTopic,
  FeishuEventBusSubscriber,
} from "./event.topic-bus.js";
import { subscribeFeishuEventTopicBus } from "./event.topic-bus.js";
import {
  resolveFeishuEventTriggerPlan,
  type FeishuEventTriggerSpec,
  type ResolvedFeishuEventTriggerPlan,
} from "./event.trigger.js";

export type FeishuEventSubscriptionDefinition = {
  id: string;
  topics?: readonly string[];
  eventTypes?: readonly string[];
  categories?: readonly NormalizedFeishuEventCategory[];
  subtypes?: readonly string[];
  concurrencyLimit?: number;
  predicate?: (delivery: FeishuEventBusDelivery) => boolean;
  trigger?: FeishuEventTriggerSpec;
};

export type FeishuEventSubscriptionMatch = {
  subscriptionId: string;
  delivery: FeishuEventBusDelivery;
  triggerPlan?: ResolvedFeishuEventTriggerPlan;
};

type SubscriptionRuntime = Pick<RuntimeEnv, "log" | "error">;

function resolveSubscriptionTopics(
  subscription: FeishuEventSubscriptionDefinition,
): readonly string[] {
  if (subscription.topics && subscription.topics.length > 0) {
    return subscription.topics;
  }
  if (subscription.eventTypes && subscription.eventTypes.length > 0) {
    return subscription.eventTypes.map((eventType) => `feishu.${eventType}`);
  }
  return ["feishu.*"];
}

export function matchesFeishuEventSubscription(
  subscription: FeishuEventSubscriptionDefinition,
  delivery: FeishuEventBusDelivery,
): boolean {
  if (
    subscription.eventTypes &&
    subscription.eventTypes.length > 0 &&
    !subscription.eventTypes.includes(delivery.event.eventType)
  ) {
    return false;
  }
  if (
    subscription.categories &&
    subscription.categories.length > 0 &&
    !subscription.categories.includes(delivery.event.category)
  ) {
    return false;
  }
  if (
    subscription.subtypes &&
    subscription.subtypes.length > 0 &&
    !subscription.subtypes.includes(delivery.event.subtype)
  ) {
    return false;
  }
  return subscription.predicate ? subscription.predicate(delivery) : true;
}

export function buildFeishuEventSubscriptionSubscriber(params: {
  subscription: FeishuEventSubscriptionDefinition;
  runtime?: SubscriptionRuntime;
  onMatch?: (match: FeishuEventSubscriptionMatch) => Promise<void> | void;
  defaultAgentId?: string;
}): FeishuEventBusSubscriber {
  const { subscription } = params;
  const error = params.runtime?.error ?? console.error;
  return {
    id: subscription.id,
    topics: resolveSubscriptionTopics(subscription),
    concurrencyLimit: subscription.concurrencyLimit,
    filter: (delivery) => matchesFeishuEventSubscription(subscription, delivery),
    onEvent: async (delivery) => {
      const triggerPlan = subscription.trigger
        ? resolveFeishuEventTriggerPlan({
            event: delivery.event,
            trigger: subscription.trigger,
            agentId: params.defaultAgentId,
          })
        : undefined;
      try {
        await params.onMatch?.({
          subscriptionId: subscription.id,
          delivery,
          triggerPlan,
        });
      } catch (err) {
        error(`feishu event subscription "${subscription.id}" failed: ${String(err)}`);
        throw err;
      }
    },
  };
}

export function subscribeFeishuEventSubscriptions(params: {
  subscriptions: readonly FeishuEventSubscriptionDefinition[];
  runtime?: SubscriptionRuntime;
  onMatch?: (match: FeishuEventSubscriptionMatch) => Promise<void> | void;
  defaultAgentId?: string;
}): () => void {
  const unsubscribers = params.subscriptions.map((subscription) =>
    subscribeFeishuEventTopicBus(
      buildFeishuEventSubscriptionSubscriber({
        subscription,
        runtime: params.runtime,
        onMatch: params.onMatch,
        defaultAgentId: params.defaultAgentId,
      }),
    ),
  );
  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}

export type FeishuEventSubscriptionRegistry = {
  register: (subscription: FeishuEventSubscriptionDefinition) => () => void;
  list: () => readonly FeishuEventSubscriptionDefinition[];
  clear: () => void;
};

export function createFeishuEventSubscriptionRegistry(): FeishuEventSubscriptionRegistry {
  const subscriptions = new Map<string, FeishuEventSubscriptionDefinition>();
  return {
    register(subscription) {
      subscriptions.set(subscription.id, subscription);
      return () => {
        subscriptions.delete(subscription.id);
      };
    },
    list() {
      return Array.from(subscriptions.values());
    },
    clear() {
      subscriptions.clear();
    },
  };
}
