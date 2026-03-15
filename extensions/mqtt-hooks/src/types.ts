import type { HookMessageChannel } from "openclaw/plugin-sdk/mqtt-hooks";

export type MqttActionKind = "wake" | "agent";
export type MqttMessageClass = "telemetry" | "alert" | "state" | "event";

export type MqttSemanticContext = {
  description?: string;
  messageClass?: MqttMessageClass;
  entityName?: string;
  location?: string;
  payloadHint?: string;
  fieldMap?: Record<string, string>;
  thresholdHint?: {
    high?: number;
    low?: number;
  };
  intentHint?: string;
};

export type MqttBrokerConfig = {
  url: string;
  clientId?: string;
  username?: string;
  password?: string;
  keepaliveSeconds?: number;
  clean?: boolean;
  reconnectPeriodMs?: number;
  connectTimeoutMs?: number;
};

export type MqttRuntimeConfig = {
  maxPayloadBytes: number;
  maxConcurrentMessages: number;
  dedupeWindowMs: number;
  maxQueuedMessages: number;
};

export type MqttSubscriptionConfig = {
  id: string;
  enabled: boolean;
  topic: string;
  qos: 0 | 1 | 2;
  ignoreRetainedOnStartup: boolean;
  action: MqttActionKind;
  name: string;
  agentId?: string;
  sessionKey?: string;
  wakeMode: "now" | "next-heartbeat";
  deliver?: boolean;
  channel?: HookMessageChannel | string;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  textTemplate?: string;
  messageTemplate?: string;
  semantic?: MqttSemanticContext;
};

export type ResolvedMqttHooksPluginConfig = {
  broker: MqttBrokerConfig;
  runtime: MqttRuntimeConfig;
  subscriptions: MqttSubscriptionConfig[];
};

export type MqttMessageEnvelope = {
  subscriptionId: string;
  topic: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  duplicate: boolean;
  receivedAt: string;
  payloadSize: number;
  payloadText?: string;
  payloadJson?: unknown;
  payloadBase64?: string;
  semantic?: MqttSemanticContext;
};

export type MqttMessagePacket = {
  topic: string;
  payload: Buffer;
  qos: 0 | 1 | 2;
  retain: boolean;
  duplicate: boolean;
};
