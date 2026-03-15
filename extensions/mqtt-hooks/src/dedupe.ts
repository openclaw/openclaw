import { createDedupeCache } from "openclaw/plugin-sdk/mqtt-hooks";

export type MqttMessageDedupe = {
  shouldSkip: (key: string, now?: number) => boolean;
  clear: () => void;
};

export function createMqttMessageDedupe(windowMs: number): MqttMessageDedupe {
  const cache = createDedupeCache({
    ttlMs: Math.max(1, windowMs),
    maxSize: 4096,
  });

  return {
    shouldSkip(key, now) {
      return cache.check(key, now);
    },
    clear() {
      cache.clear();
    },
  };
}

export function buildMqttDedupeKey(params: {
  subscriptionId: string;
  topic: string;
  retain: boolean;
  payloadHash: string;
}): string {
  return `${params.subscriptionId}:${params.topic}:${params.retain ? "retain" : "live"}:${params.payloadHash}`;
}
