import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";

function createTmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gateway-probe-config-"));
}

describe("resolveConfig", () => {
  it("returns safe defaults when called with no arguments", () => {
    const cfg = resolveConfig(undefined, { stateDir: createTmpStateDir() });

    expect(cfg.probe.probeId).toBeTruthy();
    expect(cfg.probe.name).toMatch(/^probe-/);
    expect(cfg.kafka.enabled).toBe(false);
    expect(cfg.kafka.brokers).toEqual(["127.0.0.1:9092"]);
    expect(cfg.kafka.topic).toBe("openclaw.gateway.probe.events");
    expect(cfg.kafka.clientId).toBe("openclaw-gateway-probe");
    expect(cfg.kafka.flushIntervalMs).toBe(1000);
    expect(cfg.kafka.batchMaxSize).toBe(100);
    expect(cfg.kafka.maxQueueSize).toBe(5000);
    expect(cfg.labels).toHaveProperty("agent.type", "openclaw");
    expect(cfg.labels).toHaveProperty("hostname");
    expect(cfg.labels).not.toHaveProperty("host.ip");
    expect(cfg.labels).not.toHaveProperty("host.ips");
  });

  it("keeps persisted probe id stable for the same state dir", () => {
    const stateDir = createTmpStateDir();

    const first = resolveConfig(undefined, { stateDir }).probe.probeId;
    const second = resolveConfig(undefined, { stateDir }).probe.probeId;

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("merges user-provided probe config", () => {
    const cfg = resolveConfig(
      {
        probe: {
          probeId: "my-probe-1",
          name: "prod-probe",
        },
      },
      { stateDir: createTmpStateDir() },
    );

    expect(cfg.probe.probeId).toBe("my-probe-1");
    expect(cfg.probe.name).toBe("prod-probe");
  });

  it("merges user-provided kafka config", () => {
    const cfg = resolveConfig(
      {
        kafka: {
          enabled: true,
          brokers: ["kafka-a:9092", "kafka-b:9092"],
          topic: "probe.events",
          clientId: "probe-client",
          flushIntervalMs: 2500,
          batchMaxSize: 200,
          maxQueueSize: 10000,
        },
      },
      { stateDir: createTmpStateDir() },
    );

    expect(cfg.kafka.enabled).toBe(true);
    expect(cfg.kafka.brokers).toEqual(["kafka-a:9092", "kafka-b:9092"]);
    expect(cfg.kafka.topic).toBe("probe.events");
    expect(cfg.kafka.clientId).toBe("probe-client");
    expect(cfg.kafka.flushIntervalMs).toBe(2500);
    expect(cfg.kafka.batchMaxSize).toBe(200);
    expect(cfg.kafka.maxQueueSize).toBe(10000);
  });

  it("enforces minimum kafka limits", () => {
    const cfg = resolveConfig(
      {
        kafka: {
          flushIntervalMs: 1,
          batchMaxSize: 0,
          maxQueueSize: 1,
        },
      },
      { stateDir: createTmpStateDir() },
    );

    expect(cfg.kafka.flushIntervalMs).toBe(200);
    expect(cfg.kafka.batchMaxSize).toBe(1);
    expect(cfg.kafka.maxQueueSize).toBe(100);
  });

  it("merges labels with conservative auto-detected defaults", () => {
    const cfg = resolveConfig(
      {
        labels: { env: "production", team: "platform" },
      },
      { stateDir: createTmpStateDir() },
    );

    expect(cfg.labels).toHaveProperty("agent.type", "openclaw");
    expect(cfg.labels).toHaveProperty("hostname");
    expect(cfg.labels).toHaveProperty("env", "production");
    expect(cfg.labels).toHaveProperty("team", "platform");
  });

  it("user labels override auto-detected defaults", () => {
    const cfg = resolveConfig(
      {
        labels: { hostname: "custom-host" },
      },
      { stateDir: createTmpStateDir() },
    );

    expect(cfg.labels.hostname).toBe("custom-host");
  });

  it("accepts environment overrides", () => {
    const cfg = resolveConfig(undefined, {
      stateDir: createTmpStateDir(),
      env: {
        OPENCLAW_PROBE_NAME: "gateway-prod-01",
        OPENCLAW_PROBE_LABELS: JSON.stringify({ env: "prod" }),
        OPENCLAW_PROBE_KAFKA_ENABLED: "true",
        OPENCLAW_PROBE_KAFKA_BROKERS: "kafka-a:9092, kafka-b:9092",
        OPENCLAW_PROBE_KAFKA_TOPIC: "probe.prod",
        OPENCLAW_PROBE_KAFKA_CLIENT_ID: "gateway-probe-prod",
      },
    });

    expect(cfg.probe.name).toBe("gateway-prod-01");
    expect(cfg.labels.env).toBe("prod");
    expect(cfg.kafka.enabled).toBe(true);
    expect(cfg.kafka.brokers).toEqual(["kafka-a:9092", "kafka-b:9092"]);
    expect(cfg.kafka.topic).toBe("probe.prod");
    expect(cfg.kafka.clientId).toBe("gateway-probe-prod");
  });

  it("lets environment overrides win over file config", () => {
    const cfg = resolveConfig(
      {
        probe: {
          probeId: "file-probe",
          name: "file-name",
        },
        labels: {
          env: "staging",
          hostname: "file-host",
        },
        kafka: {
          enabled: false,
          brokers: ["file-kafka:9092"],
          topic: "file.topic",
          clientId: "file-client",
        },
      },
      {
        stateDir: createTmpStateDir(),
        env: {
          OPENCLAW_PROBE_ID: "env-probe",
          OPENCLAW_PROBE_NAME: "env-name",
          OPENCLAW_PROBE_LABELS: JSON.stringify({ env: "prod", hostname: "env-host" }),
          OPENCLAW_PROBE_KAFKA_ENABLED: "true",
          OPENCLAW_PROBE_KAFKA_BROKERS: "env-kafka-a:9092, env-kafka-b:9092",
          OPENCLAW_PROBE_KAFKA_TOPIC: "env.topic",
          OPENCLAW_PROBE_KAFKA_CLIENT_ID: "env-client",
        },
      },
    );

    expect(cfg.probe.probeId).toBe("env-probe");
    expect(cfg.probe.name).toBe("env-name");
    expect(cfg.labels.env).toBe("prod");
    expect(cfg.labels.hostname).toBe("env-host");
    expect(cfg.kafka.enabled).toBe(true);
    expect(cfg.kafka.brokers).toEqual(["env-kafka-a:9092", "env-kafka-b:9092"]);
    expect(cfg.kafka.topic).toBe("env.topic");
    expect(cfg.kafka.clientId).toBe("env-client");
  });
});
