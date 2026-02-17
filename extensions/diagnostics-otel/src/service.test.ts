import { beforeEach, describe, expect, test, vi } from "vitest";

const registerLogTransportMock = vi.hoisted(() => vi.fn());

const telemetryState = vi.hoisted(() => {
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
  const tracer = {
    startSpan: vi.fn((_name: string, _opts?: unknown) => ({
      end: vi.fn(),
      setStatus: vi.fn(),
    })),
  };
  const meter = {
    createCounter: vi.fn((name: string) => {
      const counter = { add: vi.fn() };
      counters.set(name, counter);
      return counter;
    }),
    createHistogram: vi.fn((name: string) => {
      const histogram = { record: vi.fn() };
      histograms.set(name, histogram);
      return histogram;
    }),
  };
  return { counters, histograms, tracer, meter };
});

const sdkStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const sdkShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const logEmit = vi.hoisted(() => vi.fn());
const logShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@opentelemetry/api", () => ({
  metrics: {
    getMeter: () => telemetryState.meter,
  },
  trace: {
    getTracer: () => telemetryState.tracer,
    setSpanContext: (_ctx: unknown, _spanContext: unknown) => ({
      __parentSpanContext: _spanContext,
    }),
  },
  context: {
    active: () => ({}),
  },
  SpanStatusCode: {
    ERROR: 2,
  },
  TraceFlags: {
    SAMPLED: 1,
  },
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    start = sdkStart;
    shutdown = sdkShutdown;
  },
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({
  OTLPMetricExporter: class {},
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {},
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: class {},
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: class {},
  LoggerProvider: class {
    addLogRecordProcessor = vi.fn();
    getLogger = vi.fn(() => ({
      emit: logEmit,
    }));
    shutdown = logShutdown;
  },
}));

vi.mock("@opentelemetry/sdk-metrics", () => ({
  PeriodicExportingMetricReader: class {},
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  ParentBasedSampler: class {},
  TraceIdRatioBasedSampler: class {},
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn((attrs: Record<string, unknown>) => attrs),
  Resource: class {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(_value?: unknown) {}
  },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  SemanticResourceAttributes: {
    SERVICE_NAME: "service.name",
  },
}));

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    registerLogTransport: registerLogTransportMock,
  };
});

import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { emitDiagnosticEvent } from "openclaw/plugin-sdk";
import { createDiagnosticsOtelService } from "./service.js";

describe("diagnostics-otel service", () => {
  beforeEach(() => {
    telemetryState.counters.clear();
    telemetryState.histograms.clear();
    telemetryState.tracer.startSpan.mockClear();
    telemetryState.meter.createCounter.mockClear();
    telemetryState.meter.createHistogram.mockClear();
    sdkStart.mockClear();
    sdkShutdown.mockClear();
    logEmit.mockClear();
    logShutdown.mockClear();
    registerLogTransportMock.mockReset();
  });

  test("records message-flow metrics and spans", async () => {
    const registeredTransports: Array<(logObj: Record<string, unknown>) => void> = [];
    const stopTransport = vi.fn();
    registerLogTransportMock.mockImplementation((transport) => {
      registeredTransports.push(transport);
      return stopTransport;
    });

    const service = createDiagnosticsOtelService();
    const ctx: OpenClawPluginServiceContext = {
      config: {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            endpoint: "http://otel-collector:4318",
            protocol: "http/protobuf",
            traces: true,
            metrics: true,
            logs: true,
          },
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      stateDir: "/tmp/openclaw-diagnostics-otel-test",
    };
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
      updateType: "telegram-post",
    });
    emitDiagnosticEvent({
      type: "webhook.processed",
      channel: "telegram",
      updateType: "telegram-post",
      durationMs: 120,
    });
    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      queueDepth: 2,
    });
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "completed",
      durationMs: 55,
    });
    emitDiagnosticEvent({
      type: "queue.lane.dequeue",
      lane: "main",
      queueSize: 3,
      waitMs: 10,
    });
    emitDiagnosticEvent({
      type: "session.stuck",
      state: "processing",
      ageMs: 125_000,
    });
    emitDiagnosticEvent({
      type: "run.attempt",
      runId: "run-1",
      attempt: 2,
    });

    expect(telemetryState.counters.get("openclaw.webhook.received")?.add).toHaveBeenCalled();
    expect(
      telemetryState.histograms.get("openclaw.webhook.duration_ms")?.record,
    ).toHaveBeenCalled();
    expect(telemetryState.counters.get("openclaw.message.queued")?.add).toHaveBeenCalled();
    expect(telemetryState.counters.get("openclaw.message.processed")?.add).toHaveBeenCalled();
    expect(
      telemetryState.histograms.get("openclaw.message.duration_ms")?.record,
    ).toHaveBeenCalled();
    expect(telemetryState.histograms.get("openclaw.queue.wait_ms")?.record).toHaveBeenCalled();
    expect(telemetryState.counters.get("openclaw.session.stuck")?.add).toHaveBeenCalled();
    expect(
      telemetryState.histograms.get("openclaw.session.stuck_age_ms")?.record,
    ).toHaveBeenCalled();
    expect(telemetryState.counters.get("openclaw.run.attempt")?.add).toHaveBeenCalled();

    const spanNames = telemetryState.tracer.startSpan.mock.calls.map((call) => call[0]);
    expect(spanNames).toContain("openclaw.webhook.processed");
    expect(spanNames).toContain("openclaw.message.processed");
    expect(spanNames).toContain("openclaw.session.stuck");

    expect(registerLogTransportMock).toHaveBeenCalledTimes(1);
    expect(registeredTransports).toHaveLength(1);
    registeredTransports[0]?.({
      0: '{"subsystem":"diagnostic"}',
      1: "hello",
      _meta: { logLevelName: "INFO", date: new Date() },
    });
    expect(logEmit).toHaveBeenCalled();

    await service.stop?.(ctx);
  });

  test("model.usage spans include GenAI semantic convention attributes", async () => {
    const service = createDiagnosticsOtelService();
    const ctx: OpenClawPluginServiceContext = {
      config: {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            endpoint: "http://otel-collector:4318",
            protocol: "http/protobuf",
            traces: true,
            metrics: true,
            logs: false,
          },
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      stateDir: "/tmp/openclaw-diagnostics-otel-test",
    };
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.usage",
      channel: "telegram",
      provider: "anthropic",
      model: "claude-opus-4-6",
      usage: { input: 500, output: 200, total: 700 },
      durationMs: 3000,
    });

    const spanCalls = telemetryState.tracer.startSpan.mock.calls;
    const modelCall = spanCalls.find((call) => String(call[0]).startsWith("chat "));
    expect(modelCall).toBeDefined();
    expect(modelCall![0]).toBe("chat claude-opus-4-6");

    const spanAttrs = (modelCall![1] as { attributes?: Record<string, string | number> })
      ?.attributes;
    expect(spanAttrs).toBeDefined();
    // GenAI convention attributes
    expect(spanAttrs!["gen_ai.operation.name"]).toBe("chat");
    expect(spanAttrs!["gen_ai.system"]).toBe("anthropic");
    expect(spanAttrs!["gen_ai.request.model"]).toBe("claude-opus-4-6");
    expect(spanAttrs!["gen_ai.usage.input_tokens"]).toBe(500);
    expect(spanAttrs!["gen_ai.usage.output_tokens"]).toBe(200);
    // Backwards-compatible openclaw.* attributes still present
    expect(spanAttrs!["openclaw.provider"]).toBe("anthropic");
    expect(spanAttrs!["openclaw.model"]).toBe("claude-opus-4-6");
    expect(spanAttrs!["openclaw.tokens.input"]).toBe(500);
    expect(spanAttrs!["openclaw.tokens.output"]).toBe(200);

    await service.stop?.(ctx);
  });

  test("spans receive parent trace context when traceId is present", async () => {
    const service = createDiagnosticsOtelService();
    const ctx: OpenClawPluginServiceContext = {
      config: {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            endpoint: "http://otel-collector:4318",
            protocol: "http/protobuf",
            traces: true,
            metrics: true,
            logs: false,
          },
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      stateDir: "/tmp/openclaw-diagnostics-otel-test",
    };
    await service.start(ctx);

    const traceId = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    const parentSpanId = "abcdef0123456789";

    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "completed",
      durationMs: 1200,
      traceId,
    });

    emitDiagnosticEvent({
      type: "model.usage",
      channel: "telegram",
      provider: "anthropic",
      model: "claude-opus-4-6",
      usage: { input: 100, output: 50 },
      durationMs: 800,
      traceId,
      parentSpanId,
    });

    const spanCalls = telemetryState.tracer.startSpan.mock.calls as unknown as [
      string,
      unknown,
      { __parentSpanContext?: { traceId: string } | undefined } | undefined,
    ][];

    // message.processed span should NOT have parent context (it should be a root span)
    const msgCall = spanCalls.find((call) => call[0] === "openclaw.message.processed");
    expect(msgCall).toBeDefined();
    // message.processed is a root span — 3rd arg is context.active() with no parent span context
    expect(msgCall![2]?.__parentSpanContext).toBeUndefined();

    // model.usage span should have parent context
    const modelCall = spanCalls.find((call) => String(call[0]).startsWith("chat "));
    expect(modelCall).toBeDefined();
    expect(modelCall![2]).toBeDefined();
    expect(modelCall![2]!.__parentSpanContext?.traceId).toBe(traceId);

    await service.stop?.(ctx);
  });

  test("spans without traceId are created without parent context", async () => {
    const service = createDiagnosticsOtelService();
    const ctx: OpenClawPluginServiceContext = {
      config: {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            endpoint: "http://otel-collector:4318",
            protocol: "http/protobuf",
            traces: true,
            metrics: true,
            logs: false,
          },
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      stateDir: "/tmp/openclaw-diagnostics-otel-test",
    };
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.usage",
      channel: "telegram",
      provider: "openai",
      model: "gpt-4o",
      usage: { input: 100, output: 50 },
      durationMs: 500,
    });

    const spanCalls = telemetryState.tracer.startSpan.mock.calls as unknown as [
      string,
      unknown,
      { __parentSpanContext?: { traceId: string } | undefined } | undefined,
    ][];
    const modelCall = spanCalls.find((call) => String(call[0]).startsWith("chat "));
    expect(modelCall).toBeDefined();
    // 3rd arg should be the default context.active() (empty object), not a linked context
    expect(modelCall![2]?.__parentSpanContext).toBeUndefined();

    await service.stop?.(ctx);
  });
});
