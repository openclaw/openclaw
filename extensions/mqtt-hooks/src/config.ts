import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/mqtt-hooks";
import { z } from "zod";
import type {
  MqttBrokerConfig,
  MqttSemanticContext,
  MqttSubscriptionConfig,
  ResolvedMqttHooksPluginConfig,
} from "./types.js";

const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_CONCURRENT_MESSAGES = 4;
const DEFAULT_DEDUPE_WINDOW_MS = 30_000;
const DEFAULT_QUEUE_MULTIPLIER = 8;
const DEFAULT_MIN_QUEUE = 32;

const nonEmptyString = z.string().trim().min(1);
const qosSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const wakeModeSchema = z.union([z.literal("now"), z.literal("next-heartbeat")]);

const MqttThresholdHintSchema = z
  .object({
    high: z.number().finite().optional(),
    low: z.number().finite().optional(),
  })
  .strict();

const MqttSemanticContextSchema = z
  .object({
    description: nonEmptyString.optional(),
    messageClass: z.enum(["telemetry", "alert", "state", "event"]).optional(),
    entityName: nonEmptyString.optional(),
    location: nonEmptyString.optional(),
    payloadHint: nonEmptyString.optional(),
    fieldMap: z.record(z.string(), nonEmptyString).optional(),
    thresholdHint: MqttThresholdHintSchema.optional(),
    intentHint: nonEmptyString.optional(),
  })
  .strict();

const MqttBrokerConfigSchema = z
  .object({
    url: nonEmptyString,
    clientId: nonEmptyString.optional(),
    username: nonEmptyString.optional(),
    password: nonEmptyString.optional(),
    keepaliveSeconds: z.number().int().positive().optional(),
    clean: z.boolean().optional(),
    reconnectPeriodMs: z.number().int().positive().optional(),
    connectTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const MqttSubscriptionBaseSchema = z
  .object({
    id: nonEmptyString,
    enabled: z.boolean().optional(),
    topic: nonEmptyString,
    qos: qosSchema.optional(),
    ignoreRetainedOnStartup: z.boolean().optional(),
    name: nonEmptyString.optional(),
    agentId: nonEmptyString.optional(),
    sessionKey: nonEmptyString.optional(),
    wakeMode: wakeModeSchema.optional(),
    deliver: z.boolean().optional(),
    channel: nonEmptyString.optional(),
    to: nonEmptyString.optional(),
    model: nonEmptyString.optional(),
    thinking: nonEmptyString.optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    semantic: MqttSemanticContextSchema.optional(),
  })
  .strict();

const MqttWakeSubscriptionSchema = MqttSubscriptionBaseSchema.extend({
  action: z.literal("wake"),
  textTemplate: z.string().optional(),
  messageTemplate: z.never().optional(),
}).superRefine((value, ctx) => {
  if (value.messageTemplate !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "wake subscriptions do not support messageTemplate",
      path: ["messageTemplate"],
    });
  }
});

const MqttAgentSubscriptionSchema = MqttSubscriptionBaseSchema.extend({
  action: z.literal("agent"),
  messageTemplate: z.string().optional(),
  textTemplate: z.never().optional(),
}).superRefine((value, ctx) => {
  if (value.textTemplate !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "agent subscriptions do not support textTemplate",
      path: ["textTemplate"],
    });
  }
});

const MqttSubscriptionSchema = z.discriminatedUnion("action", [
  MqttWakeSubscriptionSchema,
  MqttAgentSubscriptionSchema,
]);

const MqttHooksPluginConfigSchema = z
  .object({
    broker: MqttBrokerConfigSchema,
    runtime: z
      .object({
        maxPayloadBytes: z.number().int().positive().optional(),
        maxConcurrentMessages: z.number().int().positive().optional(),
        dedupeWindowMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    subscriptions: z
      .array(MqttSubscriptionSchema)
      .min(1, "subscriptions must contain at least one entry"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [index, subscription] of value.subscriptions.entries()) {
      if (ids.has(subscription.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate subscription id: ${subscription.id}`,
          path: ["subscriptions", index, "id"],
        });
      }
      ids.add(subscription.id);
    }
  });

const MQTT_HOOKS_PLUGIN_CONFIG_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["broker", "subscriptions"],
  properties: {
    broker: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string" },
        clientId: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        keepaliveSeconds: { type: "integer", minimum: 1 },
        clean: { type: "boolean" },
        reconnectPeriodMs: { type: "integer", minimum: 1 },
        connectTimeoutMs: { type: "integer", minimum: 1 },
      },
    },
    runtime: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxPayloadBytes: { type: "integer", minimum: 1 },
        maxConcurrentMessages: { type: "integer", minimum: 1 },
        dedupeWindowMs: { type: "integer", minimum: 1 },
      },
    },
    subscriptions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
      },
    },
  },
} as const;

const MQTT_HOOKS_PLUGIN_UI_HINTS = {
  "broker.url": {
    label: "Broker URL",
    help: "MQTT broker URL, for example mqtt://broker.local:1883 or wss://broker.example.com/mqtt.",
  },
  "broker.clientId": {
    label: "Client ID",
  },
  "broker.username": {
    label: "Username",
  },
  "broker.password": {
    label: "Password",
    sensitive: true,
  },
  "runtime.maxPayloadBytes": {
    label: "Max Payload Bytes",
    advanced: true,
  },
  "runtime.maxConcurrentMessages": {
    label: "Max Concurrent Messages",
    advanced: true,
  },
  "runtime.dedupeWindowMs": {
    label: "Dedupe Window (ms)",
    advanced: true,
  },
  subscriptions: {
    label: "Subscriptions",
  },
} as const;

const DEFAULT_WAKE_TEMPLATE = "MQTT {{topic}}\n{{payloadText}}";
const DEFAULT_AGENT_TEMPLATE =
  "Source: MQTT\nTopic: {{topic}}\nReceived: {{receivedAt}}\nDescription: {{semantic.description}}\nPayload hint: {{semantic.payloadHint}}\nIntent hint: {{semantic.intentHint}}\n\nPayload:\n{{payloadText}}";

function resolveQueueSize(maxConcurrentMessages: number): number {
  return Math.max(DEFAULT_MIN_QUEUE, maxConcurrentMessages * DEFAULT_QUEUE_MULTIPLIER);
}

function resolveSemanticContext(
  value: MqttSemanticContext | undefined,
): MqttSemanticContext | undefined {
  if (!value) {
    return undefined;
  }
  return {
    ...value,
    ...(value.fieldMap ? { fieldMap: { ...value.fieldMap } } : {}),
    ...(value.thresholdHint ? { thresholdHint: { ...value.thresholdHint } } : {}),
  };
}

function resolveBrokerConfig(value: MqttBrokerConfig): MqttBrokerConfig {
  return {
    ...value,
    ...(value.clientId ? { clientId: value.clientId.trim() } : {}),
    ...(value.username ? { username: value.username.trim() } : {}),
  };
}

function resolveSubscriptionConfig(
  value: z.infer<typeof MqttSubscriptionSchema>,
): MqttSubscriptionConfig {
  const common = {
    id: value.id,
    enabled: value.enabled !== false,
    topic: value.topic,
    qos: value.qos ?? 0,
    ignoreRetainedOnStartup: value.ignoreRetainedOnStartup !== false,
    name: value.name ?? `MQTT ${value.id}`,
    agentId: value.agentId,
    sessionKey: value.sessionKey,
    wakeMode: value.wakeMode ?? "now",
    deliver: value.deliver,
    channel: value.channel,
    to: value.to,
    model: value.model,
    thinking: value.thinking,
    timeoutSeconds: value.timeoutSeconds,
    semantic: resolveSemanticContext(value.semantic),
  };
  if (value.action === "wake") {
    return {
      ...common,
      action: "wake",
      textTemplate: value.textTemplate ?? DEFAULT_WAKE_TEMPLATE,
    };
  }
  return {
    ...common,
    action: "agent",
    messageTemplate: value.messageTemplate ?? DEFAULT_AGENT_TEMPLATE,
  };
}

export function resolveMqttHooksPluginConfig(rawConfig: unknown): ResolvedMqttHooksPluginConfig {
  const parsed = MqttHooksPluginConfigSchema.parse(rawConfig);
  const maxConcurrentMessages =
    parsed.runtime?.maxConcurrentMessages ?? DEFAULT_MAX_CONCURRENT_MESSAGES;

  return {
    broker: resolveBrokerConfig(parsed.broker),
    runtime: {
      maxPayloadBytes: parsed.runtime?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      maxConcurrentMessages,
      dedupeWindowMs: parsed.runtime?.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS,
      maxQueuedMessages: resolveQueueSize(maxConcurrentMessages),
    },
    subscriptions: parsed.subscriptions.map(resolveSubscriptionConfig),
  };
}

export function createMqttHooksPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    parse(value: unknown): ResolvedMqttHooksPluginConfig {
      return resolveMqttHooksPluginConfig(value);
    },
    safeParse(value: unknown) {
      const result = MqttHooksPluginConfigSchema.safeParse(value);
      if (!result.success) {
        return {
          success: false as const,
          error: {
            issues: result.error.issues.map((issue) => ({
              path: issue.path.filter(
                (entry): entry is string | number =>
                  typeof entry === "string" || typeof entry === "number",
              ),
              message: issue.message,
            })),
          },
        };
      }
      return {
        success: true as const,
        data: resolveMqttHooksPluginConfig(result.data),
      };
    },
    uiHints: { ...MQTT_HOOKS_PLUGIN_UI_HINTS },
    jsonSchema: MQTT_HOOKS_PLUGIN_CONFIG_JSON_SCHEMA,
  };
}

export {
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_DEDUPE_WINDOW_MS,
  DEFAULT_MAX_CONCURRENT_MESSAGES,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_WAKE_TEMPLATE,
  MqttBrokerConfigSchema,
  MqttHooksPluginConfigSchema,
  MqttSemanticContextSchema,
  MqttSubscriptionSchema,
};
export type { ResolvedMqttHooksPluginConfig } from "./types.js";
