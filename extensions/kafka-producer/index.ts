import Confluent from "@confluentinc/kafka-javascript";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const { Kafka } = Confluent.KafkaJS;

import type { ProducerConfig, SchemaRegistryConfig } from "./config.js";
import { producerConfigSchema, splitConfig } from "./config.js";
import { ENVELOPE_SCHEMA_STRING } from "./schemas.js";
import { parseSessionKey, resolveKey, resolveTopic, type EventContext } from "./topic-resolver.js";

const HOOKS = [
  "message_sent",
  "message_received",
  "after_tool_call",
  "session_start",
  "session_end",
  "agent_end",
] as const;

type Serializer = {
  serialize: (topic: string, data: unknown) => Promise<Buffer>;
};

async function initSchemaRegistry(
  cfg: SchemaRegistryConfig,
  logger: { info: (m: string) => void; error: (m: string) => void },
): Promise<Serializer> {
  const { SchemaRegistryClient, JsonSerializer, SerdeType } =
    await import("@confluentinc/schemaregistry");

  const clientConfig: Record<string, unknown> = {
    baseURLs: [cfg.url],
  };

  if (cfg["api.key"] && cfg["api.secret"]) {
    (clientConfig as any).basicAuthCredentials = {
      credentialsSource: "USER_INFO",
      userInfo: `${cfg["api.key"]}:${cfg["api.secret"]}`,
    };
  }

  const registry = new SchemaRegistryClient(clientConfig as any);

  const schemaId = await registry.register("openclaw-events-value", {
    schemaType: "JSON",
    schema: ENVELOPE_SCHEMA_STRING,
  });

  const serializer = new JsonSerializer(registry, SerdeType.VALUE, {
    autoRegisterSchemas: true,
    useSchemaId: schemaId,
  });

  logger.info(`kafka-producer: schema registry initialized (schemaId=${schemaId})`);

  return serializer;
}

// Module-level state — survives plugin re-registration during agent runs.
let producer: ReturnType<InstanceType<typeof Kafka>["producer"]> | null = null;
let serializer: Serializer | null = null;
let startupPromise: Promise<void> | null = null;
let shuttingDown = false;
const inflight = new Set<Promise<unknown>>();

export default definePluginEntry({
  id: "kafka-producer",
  name: "Kafka Producer",
  description: "Publishes OpenClaw agent events to Apache Kafka",
  configSchema: producerConfigSchema,

  register(api) {
    const raw = api.pluginConfig as ProducerConfig;
    const {
      topic: topicPattern,
      key: keyField,
      schemaRegistry: srConfig,
      kafkaConfig,
    } = splitConfig(raw);

    const kafka = new Kafka();

    api.on("gateway_start", async () => {
      // Skip if already connected (re-registration during agent run)
      if (producer || startupPromise) return;

      startupPromise = (async () => {
        producer = kafka.producer(kafkaConfig);
        try {
          await producer.connect();
          api.logger.info(`kafka-producer: connected to ${kafkaConfig["bootstrap.servers"]}`);
        } catch (err) {
          producer = null;
          api.logger.error(`kafka-producer: failed to connect — ${err}`);
          throw err;
        }

        if (srConfig) {
          try {
            serializer = await initSchemaRegistry(srConfig, api.logger);
          } catch (err) {
            api.logger.error(
              `kafka-producer: schema registry init failed, disabling producer — ${err}`,
            );
            await producer.disconnect().catch(() => {});
            producer = null;
          }
        }
      })();

      try {
        await startupPromise;
      } finally {
        startupPromise = null;
      }
    });

    api.on("gateway_stop", async () => {
      // Block new publishes immediately
      shuttingDown = true;

      if (startupPromise) {
        await startupPromise.catch(() => {});
        startupPromise = null;
      }
      if (!producer) {
        shuttingDown = false;
        return;
      }
      try {
        // Drain until no more in-flight — hooks may still fire
        // concurrently during shutdown, but shuttingDown gate
        // prevents new sends from being added.
        while (inflight.size > 0) {
          await Promise.allSettled([...inflight]);
        }
        await producer.flush({ timeout: 10_000 });
        await producer.disconnect();
        api.logger.info("kafka-producer: disconnected");
      } catch (err) {
        api.logger.error(`kafka-producer: error during shutdown — ${err}`);
      }
      producer = null;
      serializer = null;
      shuttingDown = false;
    });

    for (const hookName of HOOKS) {
      api.on(hookName, (event: unknown, ctx: unknown) => {
        const p = producer;
        if (!p || shuttingDown) return;

        const c = (ctx ?? {}) as Record<string, unknown>;
        const sessionKey = (c.sessionKey as string) || null;
        const parsed = sessionKey ? parseSessionKey(sessionKey) : null;

        const agentId = parsed?.agentId ?? (c.agentId as string) ?? "unknown";
        const runId = (c.runId as string) ?? "";
        const accountId = parsed?.accountId ?? (c.accountId as string) ?? null;
        const channelId = (c.channelId as string) ?? parsed?.channel ?? null;
        const channel = parsed?.channel ?? channelId;

        const eventCtx: EventContext = {
          agentId,
          channel,
          accountId,
          peerKind: parsed?.peerKind ?? null,
          peerId: parsed?.peerId ?? null,
          channelId,
          stream: hookName,
          runId,
          sessionKey: sessionKey ?? "",
        };

        const topic = resolveTopic(topicPattern, eventCtx);
        const key = resolveKey(keyField, eventCtx);

        const envelope = {
          stream: hookName,
          ts: Date.now(),
          agentId,
          sessionKey: sessionKey ?? "",
          runId,
          channelId,
          accountId,
          data: event,
        };

        const headers = {
          stream: hookName,
          "agent-id": agentId,
          "run-id": runId,
          ...(channelId ? { channel: channelId } : {}),
          ...(accountId ? { "account-id": accountId } : {}),
        };

        const publishPromise = (
          serializer
            ? serializer.serialize(topic, envelope)
            : Promise.resolve(JSON.stringify(envelope))
        )
          .then((value) =>
            p.send({
              topic,
              messages: [{ key: key ?? undefined, value, headers }],
            }),
          )
          .catch((err: unknown) => {
            api.logger.error(`kafka-producer: failed to publish to ${topic} — ${err}`);
          })
          .finally(() => {
            inflight.delete(publishPromise);
          });

        inflight.add(publishPromise);
      });
    }
  },
});
