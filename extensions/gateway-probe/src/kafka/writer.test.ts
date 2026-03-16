import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProbeEvent, ResolvedProbeConfig } from "../types.js";

const sendMock = vi.fn();
const connectMock = vi.fn(async () => {});
const disconnectMock = vi.fn(async () => {});

vi.mock("kafkajs", () => ({
  Kafka: vi.fn().mockImplementation(function KafkaMock() {
    return {
      producer: () => ({
        connect: connectMock,
        disconnect: disconnectMock,
        send: sendMock,
      }),
    };
  }),
  logLevel: {
    NOTHING: 0,
  },
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeConfig(): ResolvedProbeConfig {
  return {
    probe: {
      probeId: "probe-1",
      name: "probe-main",
    },
    labels: {
      env: "test",
    },
    kafka: {
      enabled: true,
      brokers: ["127.0.0.1:9092"],
      topic: "probe.events",
      clientId: "gateway-probe-test",
      flushIntervalMs: 60_000,
      batchMaxSize: 1,
      maxQueueSize: 100,
    },
  };
}

function makeEvent(id: string): ProbeEvent {
  return {
    schemaVersion: "1.0",
    pluginVersion: "2026.3.2",
    eventId: id,
    probeId: "probe-1",
    probeName: "probe-main",
    labels: {},
    eventType: "audit.session.started",
    occurredAt: new Date("2026-03-17T00:00:00.000Z").toISOString(),
    source: "session_hook",
    severity: "info",
    sessionId: id,
    sessionKey: `session-${id}`,
    payload: {},
  };
}

describe("startKafkaWriter", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("drains the remaining queue on shutdown after an in-flight flush completes", async () => {
    const { startKafkaWriter } = await import("./writer.js");
    const firstSend = deferred<void>();

    sendMock.mockImplementationOnce(() => firstSend.promise);
    sendMock.mockResolvedValueOnce(undefined);

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const writer = await startKafkaWriter(makeConfig(), logger);
    writer.enqueue(makeEvent("event-1"));

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    writer.enqueue(makeEvent("event-2"));

    const stopPromise = writer.stop();
    firstSend.resolve();
    await stopPromise;

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("unsent events during shutdown"),
    );
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });
});
