import { createHash } from "node:crypto";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/mqtt-hooks";
import {
  dispatchAgentIngressAction,
  dispatchWakeIngressAction,
  resolveHookIngressPolicies,
} from "openclaw/plugin-sdk/mqtt-hooks";
import { buildMqttDedupeKey, createMqttMessageDedupe } from "./dedupe.js";
import { dispatchMqttEnvelope } from "./dispatch.js";
import { assertMqttPayloadSize, buildMqttMessageEnvelope } from "./envelope.js";
import {
  closeMqttClient,
  createDefaultMqttClientFactory,
  subscribeTopic,
  type MqttClientFactory,
  type MqttClientLike,
} from "./mqtt-client.js";
import { matchesMqttTopicFilter } from "./topic-filter.js";
import type { MqttMessagePacket, ResolvedMqttHooksPluginConfig } from "./types.js";

const STARTUP_RETAINED_GUARD_MS = 1500;

function hashPayload(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

function redactBrokerUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) {
      parsed.username = "***";
    }
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return rawUrl.replace(/\/\/([^@/]+)@/u, "//***:***@");
  }
}

function normalizePacket(
  topic: string,
  payload: Buffer,
  packet: { qos?: number; retain?: boolean; dup?: boolean },
): MqttMessagePacket {
  const qos = packet.qos;
  return {
    topic,
    payload,
    qos: qos === 1 || qos === 2 ? qos : 0,
    retain: packet.retain === true,
    duplicate: packet.dup === true,
  };
}

function createMessageQueue(options: {
  concurrency: number;
  maxQueuedMessages: number;
  onDrop: () => void;
}) {
  const queue: Array<() => Promise<void>> = [];
  const inFlight = new Set<Promise<void>>();
  let active = 0;

  const onSettled = (taskPromise: Promise<void>) => {
    inFlight.delete(taskPromise);
    active = Math.max(0, active - 1);
    pump();
  };

  const runNext = () => {
    if (active >= options.concurrency) {
      return;
    }
    const task = queue.shift();
    if (!task) {
      return;
    }
    active += 1;
    const taskPromise = task()
      .catch(() => {})
      .finally(() => onSettled(taskPromise));
    inFlight.add(taskPromise);
  };

  const pump = () => {
    while (active < options.concurrency && queue.length > 0) {
      runNext();
    }
  };

  return {
    enqueue(task: () => Promise<void>): boolean {
      if (queue.length >= options.maxQueuedMessages) {
        options.onDrop();
        return false;
      }
      queue.push(task);
      pump();
      return true;
    },
    clear() {
      queue.length = 0;
    },
    async onIdle(): Promise<void> {
      await Promise.allSettled(Array.from(inFlight));
    },
  };
}

export function createMqttHooksService(params: {
  pluginConfig: ResolvedMqttHooksPluginConfig;
  clientFactory?: MqttClientFactory;
  now?: () => number;
  payloadHasher?: (payload: Buffer) => string;
}): OpenClawPluginService {
  let client: MqttClientLike | null = null;
  let startupRetainedGuard = true;
  let startupRetainedGuardTimer: ReturnType<typeof setTimeout> | null = null;
  let hasConnectedOnce = false;
  let stopped = true;
  let runToken = 0;
  let queue = createMessageQueue({
    concurrency: params.pluginConfig.runtime.maxConcurrentMessages,
    maxQueuedMessages: params.pluginConfig.runtime.maxQueuedMessages,
    onDrop: () => {},
  });
  let queuedDedupeKeys = new Set<string>();
  let stopPromise: Promise<void> | null = null;

  const clearStartupGuardTimer = () => {
    if (!startupRetainedGuardTimer) {
      return;
    }
    clearTimeout(startupRetainedGuardTimer);
    startupRetainedGuardTimer = null;
  };

  return {
    id: "mqtt-hooks",
    async start(ctx) {
      if (!stopped) {
        return;
      }
      runToken += 1;
      const activeRunToken = runToken;
      stopped = false;
      clearStartupGuardTimer();
      startupRetainedGuard = true;
      hasConnectedOnce = false;

      const clientFactory = params.clientFactory ?? createDefaultMqttClientFactory();
      const dedupe = createMqttMessageDedupe(params.pluginConfig.runtime.dedupeWindowMs);
      const policies = resolveHookIngressPolicies(ctx.config);
      const brokerLabel = redactBrokerUrl(params.pluginConfig.broker.url);
      const now = params.now ?? Date.now;
      const payloadHasher = params.payloadHasher ?? hashPayload;

      queue = createMessageQueue({
        concurrency: params.pluginConfig.runtime.maxConcurrentMessages,
        maxQueuedMessages: params.pluginConfig.runtime.maxQueuedMessages,
        onDrop: () => {
          ctx.logger.warn("mqtt-hooks: dropped message because the ingress queue is full");
        },
      });
      queuedDedupeKeys = new Set();

      const dispatchers = {
        dispatchWake: (value: { text: string; mode: "now" | "next-heartbeat" }) => {
          dispatchWakeIngressAction(value, {
            heartbeatReason: "mqtt-hooks:wake",
          });
        },
        dispatchAgent: (value: Parameters<typeof dispatchAgentIngressAction>[0]) =>
          dispatchAgentIngressAction(value, {
            logger: ctx.logger,
          }),
      };

      const activeSubscriptions = params.pluginConfig.subscriptions.filter(
        (subscription) => subscription.enabled,
      );
      if (activeSubscriptions.length === 0) {
        ctx.logger.info("mqtt-hooks: no enabled subscriptions configured");
        return;
      }

      client = clientFactory(params.pluginConfig.broker);
      const activeClient = client;
      const isActiveRun = () => !stopped && runToken === activeRunToken && client === activeClient;

      const subscribeAll = async (armStartupRetainedGuard: boolean) => {
        for (const subscription of activeSubscriptions) {
          if (!isActiveRun()) {
            return false;
          }
          await subscribeTopic(activeClient, subscription.topic, subscription.qos);
        }
        if (!armStartupRetainedGuard || !isActiveRun()) {
          return false;
        }
        clearStartupGuardTimer();
        startupRetainedGuardTimer = setTimeout(() => {
          if (!isActiveRun()) {
            return;
          }
          startupRetainedGuard = false;
          startupRetainedGuardTimer = null;
        }, STARTUP_RETAINED_GUARD_MS);
        return true;
      };

      activeClient.on("connect", () => {
        ctx.logger.info(
          `mqtt-hooks: connected to ${brokerLabel} with ${activeSubscriptions.length} subscription(s)`,
        );
        const armStartupRetainedGuard = !hasConnectedOnce;
        void subscribeAll(armStartupRetainedGuard)
          .then((guardArmed) => {
            if (guardArmed && isActiveRun()) {
              hasConnectedOnce = true;
            }
          })
          .catch((err) => {
            ctx.logger.warn(`mqtt-hooks: subscribe failed: ${String(err)}`);
          });
      });
      activeClient.on("reconnect", () => {
        ctx.logger.warn(`mqtt-hooks: reconnecting to ${brokerLabel}`);
      });
      activeClient.on("offline", () => {
        ctx.logger.warn(`mqtt-hooks: broker offline ${brokerLabel}`);
      });
      activeClient.on("close", () => {
        ctx.logger.info(`mqtt-hooks: broker connection closed ${brokerLabel}`);
      });
      activeClient.on("error", (err) => {
        ctx.logger.warn(`mqtt-hooks: client error: ${err.message}`);
      });
      activeClient.on("message", (topic, payload, packet) => {
        if (stopped) {
          return;
        }
        const matchingSubscriptions = activeSubscriptions.filter((subscription) =>
          matchesMqttTopicFilter(subscription.topic, topic),
        );
        if (matchingSubscriptions.length === 0) {
          return;
        }

        const normalizedPacket = normalizePacket(topic, payload, packet);
        const processableSubscriptions = matchingSubscriptions.filter(
          (subscription) =>
            !(
              startupRetainedGuard &&
              subscription.ignoreRetainedOnStartup &&
              normalizedPacket.retain
            ),
        );
        if (processableSubscriptions.length === 0) {
          return;
        }

        // Enforce payload size before computing dedupe hash to reject oversized payloads early
        try {
          assertMqttPayloadSize({
            subscriptionId: processableSubscriptions[0].id,
            payloadSize: normalizedPacket.payload.byteLength,
            maxPayloadBytes: params.pluginConfig.runtime.maxPayloadBytes,
          });
        } catch (err) {
          ctx.logger.warn(`mqtt-hooks: failed to process topic ${topic}: ${String(err)}`);
          return;
        }

        for (const subscription of processableSubscriptions) {
          const dedupeKey = buildMqttDedupeKey({
            subscriptionId: subscription.id,
            topic: normalizedPacket.topic,
            retain: normalizedPacket.retain,
            payloadHash: payloadHasher(normalizedPacket.payload),
          });
          if (queuedDedupeKeys.has(dedupeKey) || dedupe.peek(dedupeKey, now())) {
            continue;
          }

          queuedDedupeKeys.add(dedupeKey);
          const accepted = queue.enqueue(async () => {
            try {
              if (dedupe.shouldSkip(dedupeKey, now())) {
                return;
              }
              const envelope = buildMqttMessageEnvelope({
                subscription,
                packet: normalizedPacket,
                maxPayloadBytes: params.pluginConfig.runtime.maxPayloadBytes,
                receivedAt: new Date(now()),
              });
              const result = dispatchMqttEnvelope({
                subscription,
                envelope,
                policies,
                dispatchers,
              });
              if (!result.ok) {
                ctx.logger.warn(
                  `mqtt-hooks: dispatch rejected for ${subscription.id}: ${result.error}`,
                );
                return;
              }
              if (result.completion) {
                await result.completion;
              }
            } catch (err) {
              ctx.logger.warn(
                `mqtt-hooks: failed to process topic ${topic} for ${subscription.id}: ${String(err)}`,
              );
            } finally {
              queuedDedupeKeys.delete(dedupeKey);
            }
          });
          if (!accepted) {
            queuedDedupeKeys.delete(dedupeKey);
            ctx.logger.warn(
              `mqtt-hooks: queue full while handling subscription ${subscription.id}`,
            );
          }
        }
      });
    },
    async stop() {
      if (stopped) {
        if (stopPromise) {
          await stopPromise;
        }
        return;
      }
      runToken += 1;
      stopped = true;
      // Guard the startup retained timer during shutdown to prevent late timer firing
      clearStartupGuardTimer();
      startupRetainedGuard = false;

      const currentClient = client;
      client = null;

      stopPromise = (async () => {
        queue.clear();
        queuedDedupeKeys.clear();
        await queue.onIdle();
        if (!currentClient) {
          return;
        }
        currentClient.removeAllListeners();
        await closeMqttClient(currentClient).catch(() => {});
      })();

      await stopPromise;
      stopPromise = null;
    },
  };
}
