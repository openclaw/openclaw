import { describe, it, expect } from "vitest";
import { producerConfigSchema, splitConfig } from "./config.js";

describe("producerConfigSchema.parse", () => {
  it("accepts valid minimal config", () => {
    const cfg = producerConfigSchema.parse({
      "bootstrap.servers": "localhost:9092",
      topic: "openclaw.events",
    });
    expect(cfg["bootstrap.servers"]).toBe("localhost:9092");
    expect(cfg.topic).toBe("openclaw.events");
  });

  it("accepts config with key", () => {
    const cfg = producerConfigSchema.parse({
      "bootstrap.servers": "localhost:9092",
      topic: "openclaw.events",
      key: "sessionKey",
    });
    expect(cfg.key).toBe("sessionKey");
  });

  it("accepts config with null key", () => {
    const cfg = producerConfigSchema.parse({
      "bootstrap.servers": "localhost:9092",
      topic: "openclaw.events",
      key: null,
    });
    expect(cfg.key).toBeNull();
  });

  it("preserves librdkafka properties", () => {
    const cfg = producerConfigSchema.parse({
      "bootstrap.servers": "pkc-xxx.confluent.cloud:9092",
      topic: "openclaw.events",
      "security.protocol": "SASL_SSL",
      "sasl.mechanisms": "PLAIN",
      "sasl.username": "mykey",
      "sasl.password": "mysecret",
    });
    expect(cfg["security.protocol"]).toBe("SASL_SSL");
    expect(cfg["sasl.mechanisms"]).toBe("PLAIN");
  });

  it("rejects null config", () => {
    expect(() => producerConfigSchema.parse(null)).toThrow("config is required");
  });

  it("rejects non-object config", () => {
    expect(() => producerConfigSchema.parse("string")).toThrow("config is required");
  });

  it("rejects missing bootstrap.servers", () => {
    expect(() => producerConfigSchema.parse({ topic: "openclaw.events" })).toThrow(
      "bootstrap.servers",
    );
  });

  it("rejects empty bootstrap.servers", () => {
    expect(() =>
      producerConfigSchema.parse({ "bootstrap.servers": "  ", topic: "openclaw.events" }),
    ).toThrow("bootstrap.servers");
  });

  it("rejects missing topic", () => {
    expect(() => producerConfigSchema.parse({ "bootstrap.servers": "localhost:9092" })).toThrow(
      "topic",
    );
  });

  it("rejects non-string key", () => {
    expect(() =>
      producerConfigSchema.parse({
        "bootstrap.servers": "localhost:9092",
        topic: "openclaw.events",
        key: 123,
      }),
    ).toThrow("key");
  });

  it("accepts schema.registry config", () => {
    const cfg = producerConfigSchema.parse({
      "bootstrap.servers": "localhost:9092",
      topic: "openclaw.events",
      "schema.registry": { url: "http://localhost:8081" },
    });
    expect(cfg["schema.registry"]).toEqual({ url: "http://localhost:8081" });
  });

  it("rejects schema.registry without url", () => {
    expect(() =>
      producerConfigSchema.parse({
        "bootstrap.servers": "localhost:9092",
        topic: "openclaw.events",
        "schema.registry": {},
      }),
    ).toThrow("schema.registry.url");
  });
});

describe("splitConfig", () => {
  it("separates plugin fields from kafka config", () => {
    const { topic, key, schemaRegistry, kafkaConfig } = splitConfig({
      "bootstrap.servers": "localhost:9092",
      topic: "openclaw.{agentId}.events",
      key: "sessionKey",
      "compression.type": "gzip",
      acks: "all",
    });
    expect(topic).toBe("openclaw.{agentId}.events");
    expect(key).toBe("sessionKey");
    expect(schemaRegistry).toBeNull();
    expect(kafkaConfig).toEqual({
      "bootstrap.servers": "localhost:9092",
      "compression.type": "gzip",
      acks: "all",
    });
    expect(kafkaConfig).not.toHaveProperty("topic");
    expect(kafkaConfig).not.toHaveProperty("key");
    expect(kafkaConfig).not.toHaveProperty("schema.registry");
  });

  it("defaults key to null", () => {
    const { key } = splitConfig({
      "bootstrap.servers": "localhost:9092",
      topic: "openclaw.events",
    });
    expect(key).toBeNull();
  });

  it("extracts schema registry config", () => {
    const { schemaRegistry } = splitConfig({
      "bootstrap.servers": "localhost:9092",
      topic: "openclaw.events",
      "schema.registry": { url: "http://localhost:8081", "api.key": "k", "api.secret": "s" },
    });
    expect(schemaRegistry).toEqual({
      url: "http://localhost:8081",
      "api.key": "k",
      "api.secret": "s",
    });
  });
});
