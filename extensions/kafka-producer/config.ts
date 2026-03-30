export type SchemaRegistryConfig = {
  url: string;
  "api.key"?: string;
  "api.secret"?: string;
};

export type ProducerConfig = {
  "bootstrap.servers": string;
  topic: string;
  key?: string | null;
  "schema.registry"?: SchemaRegistryConfig;
  [property: string]: unknown;
};

const PLUGIN_FIELDS = new Set(["topic", "key", "schema.registry"]);

export function splitConfig(raw: ProducerConfig): {
  topic: string;
  key: string | null;
  schemaRegistry: SchemaRegistryConfig | null;
  kafkaConfig: Record<string, unknown>;
} {
  const topic = raw.topic;
  const key = raw.key ?? null;
  const schemaRegistry = raw["schema.registry"] ?? null;
  const kafkaConfig: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(raw)) {
    if (!PLUGIN_FIELDS.has(k)) {
      kafkaConfig[k] = v;
    }
  }

  return { topic, key, schemaRegistry, kafkaConfig };
}

export const producerConfigSchema = {
  parse(value: unknown): ProducerConfig {
    if (!value || typeof value !== "object") {
      throw new Error("kafka-producer: config is required");
    }

    const cfg = value as Record<string, unknown>;

    if (typeof cfg["bootstrap.servers"] !== "string" || !cfg["bootstrap.servers"].trim()) {
      throw new Error(
        'kafka-producer: "bootstrap.servers" is required and must be a non-empty string',
      );
    }

    if (typeof cfg.topic !== "string" || !cfg.topic.trim()) {
      throw new Error('kafka-producer: "topic" is required and must be a non-empty string');
    }

    if (cfg.key !== undefined && cfg.key !== null && typeof cfg.key !== "string") {
      throw new Error('kafka-producer: "key" must be a string or null');
    }

    if (cfg["schema.registry"] !== undefined && cfg["schema.registry"] !== null) {
      const sr = cfg["schema.registry"] as Record<string, unknown>;
      if (typeof sr !== "object") {
        throw new Error('kafka-producer: "schema.registry" must be an object');
      }
      if (typeof sr.url !== "string" || !sr.url.trim()) {
        throw new Error(
          'kafka-producer: "schema.registry.url" is required when schema.registry is configured',
        );
      }
    }

    return cfg as ProducerConfig;
  },
};
