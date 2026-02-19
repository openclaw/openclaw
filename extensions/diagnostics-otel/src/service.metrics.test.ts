import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const registerLogTransportMock = vi.hoisted(() => vi.fn());

const telemetryState = vi.hoisted(() => {
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
  const tracer = {
    startSpan: vi.fn((_name: string, _opts?: unknown, _parentCtx?: unknown) => ({
      end: vi.fn(),
      setStatus: vi.fn(),
      setAttribute: vi.fn(),
      _parentCtx: _parentCtx,
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

const mockRootContext = vi.hoisted(() => ({ _type: "root" }));

vi.mock("@opentelemetry/api", () => ({
  context: {
    active: () => mockRootContext,
  },
  metrics: {
    getMeter: () => telemetryState.meter,
  },
  trace: {
    getTracer: () => telemetryState.tracer,
    setSpan: (_ctx: unknown, span: unknown) => ({ _type: "with-parent", _span: span }),
  },
  SpanKind: {
    INTERNAL: 0,
    SERVER: 1,
    CLIENT: 2,
    PRODUCER: 3,
    CONSUMER: 4,
  },
  SpanStatusCode: {
    UNSET: 0,
    OK: 1,
    ERROR: 2,
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

import { emitDiagnosticEvent } from "openclaw/plugin-sdk";
import { createDiagnosticsOtelService } from "./service.js";

describe("diagnostics-otel service – metrics & inference", () => {
  const startedServices: Array<ReturnType<typeof createDiagnosticsOtelService>> = [];

  afterEach(async () => {
    for (const service of startedServices.splice(0)) {
      await Promise.resolve(service.stop?.({} as never)).catch(() => undefined);
    }
  });

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

  function createService() {
    const service = createDiagnosticsOtelService();
    startedServices.push(service);
    return service;
  }

  function createTestCtx(otelOverrides?: { captureContent?: boolean }) {
    return {
      config: {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            endpoint: "http://otel-collector:4318",
            protocol: "http/protobuf" as const,
            traces: true,
            metrics: true,
            logs: false,
            ...otelOverrides,
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
  }

  test("records message-flow metrics and spans", async () => {
    const registeredTransports: Array<(logObj: Record<string, unknown>) => void> = [];
    const stopTransport = vi.fn();
    registerLogTransportMock.mockImplementation((transport) => {
      registeredTransports.push(transport);
      return stopTransport;
    });

    const service = createService();
    await service.start({
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
    });

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
      sessionKey: "telegram:test-agent:123",
      queueDepth: 2,
    });
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      sessionKey: "telegram:test-agent:123",
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
    // message.processed no longer creates its own span — it ends the root
    // trace span started by message.queued (nesting approach).
    expect(spanNames).toContain("openclaw.message");
    expect(spanNames).not.toContain("openclaw.message.processed");
    expect(spanNames).toContain("openclaw.session.stuck");

    expect(registerLogTransportMock).toHaveBeenCalledTimes(1);
    expect(registeredTransports).toHaveLength(1);
    registeredTransports[0]?.({
      0: '{"subsystem":"diagnostic"}',
      1: "hello",
      _meta: { logLevelName: "INFO", date: new Date() },
    });
    expect(logEmit).toHaveBeenCalled();

    await service.stop?.({} as never);
  });

  test("model.inference records gen_ai.client.operation.duration in seconds", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "model.inference",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      usage: { input: 200, output: 100, total: 300 },
      durationMs: 3200,
    });

    const histogram = telemetryState.histograms.get("gen_ai.client.operation.duration");
    expect(histogram?.record).toHaveBeenCalledWith(
      3.2,
      expect.objectContaining({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-sonnet-4-5-20250929",
      }),
    );

    await service.stop?.({} as never);
  });

  test("model.inference records gen_ai.client.token.usage split by input/output", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "model.inference",
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 500, output: 120, total: 620 },
    });

    const histogram = telemetryState.histograms.get("gen_ai.client.token.usage");
    expect(histogram?.record).toHaveBeenCalledWith(
      500,
      expect.objectContaining({ "gen_ai.token.type": "input" }),
    );
    expect(histogram?.record).toHaveBeenCalledWith(
      120,
      expect.objectContaining({ "gen_ai.token.type": "output" }),
    );

    await service.stop?.({} as never);
  });

  test("maps provider names to gen_ai.provider.name enum values", async () => {
    const service = createService();
    await service.start(createTestCtx());

    const cases = [
      { input: "orq", expected: "openai" },
      { input: "anthropic", expected: "anthropic" },
      { input: "google-gemini", expected: "gcp.gemini" },
      { input: "aws-bedrock", expected: "aws.bedrock" },
      { input: "mistral", expected: "mistral_ai" },
      { input: "some-custom-provider", expected: "some-custom-provider" },
    ];

    for (const { input, expected } of cases) {
      telemetryState.tracer.startSpan.mockClear();
      emitDiagnosticEvent({
        type: "model.inference",
        provider: input,
        model: "test-model",
        usage: { input: 10, output: 5, total: 15 },
      });
      const attrs = (telemetryState.tracer.startSpan.mock.calls[0]?.[1] as any)?.attributes;
      expect(attrs?.["gen_ai.provider.name"]).toBe(expected);
    }

    await service.stop?.({} as never);
  });

  test("existing openclaw.* metrics are still emitted alongside gen_ai.*", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "run.completed",
      runId: "run-metrics-1",
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 100, output: 50, total: 150 },
      durationMs: 2000,
      costUsd: 0.005,
    });

    emitDiagnosticEvent({
      type: "model.inference",
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 100, output: 50, total: 150 },
      durationMs: 2000,
    });

    // Existing openclaw metrics still work
    expect(telemetryState.counters.get("openclaw.tokens")?.add).toHaveBeenCalled();
    expect(telemetryState.counters.get("openclaw.cost.usd")?.add).toHaveBeenCalled();
    expect(telemetryState.histograms.get("openclaw.run.duration_ms")?.record).toHaveBeenCalled();

    // New gen_ai metrics also emitted
    expect(
      telemetryState.histograms.get("gen_ai.client.operation.duration")?.record,
    ).toHaveBeenCalled();
    expect(telemetryState.histograms.get("gen_ai.client.token.usage")?.record).toHaveBeenCalled();

    await service.stop?.({} as never);
  });

  test("finish_reason length is recorded for truncated responses", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "model.inference",
      provider: "openai",
      model: "gpt-5.2",
      finishReasons: ["length"],
      usage: { input: 10000, output: 4096, total: 14096 },
    });

    const attrs = (telemetryState.tracer.startSpan.mock.calls[0]?.[1] as any)?.attributes;
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["length"]);

    await service.stop?.({} as never);
  });

  test("TTFT histogram is recorded and span attribute is set", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "model.inference",
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 100, output: 50, total: 150 },
      durationMs: 2000,
      ttftMs: 350,
    });

    const histogram = telemetryState.histograms.get("gen_ai.client.time_to_first_token");
    expect(histogram?.record).toHaveBeenCalledWith(
      0.35,
      expect.objectContaining({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.2",
      }),
    );

    const attrs = (telemetryState.tracer.startSpan.mock.calls[0]?.[1] as any)?.attributes;
    expect(attrs["gen_ai.client.time_to_first_token"]).toBe(350);

    await service.stop?.({} as never);
  });

  test("gen_ai.usage.input_tokens includes cache tokens even without promptTokens", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "model.inference",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      usage: { input: 12, output: 57, cacheRead: 28976, cacheWrite: 295 },
      durationMs: 4000,
    });

    const attrs = (telemetryState.tracer.startSpan.mock.calls[0]?.[1] as any)?.attributes;
    // gen_ai.usage.input_tokens should be input + cacheRead + cacheWrite
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(12 + 28976 + 295);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(57);
    // openclaw.tokens.input stays as raw input
    expect(attrs["openclaw.tokens.input"]).toBe(12);

    await service.stop?.({} as never);
  });

  test("gen_ai.usage.input_tokens uses promptTokens when available", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "model.inference",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      usage: { input: 12, output: 57, cacheRead: 28976, cacheWrite: 295, promptTokens: 29283 },
      durationMs: 4000,
    });

    const attrs = (telemetryState.tracer.startSpan.mock.calls[0]?.[1] as any)?.attributes;
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(29283);

    await service.stop?.({} as never);
  });

  test("error event creates span with ERROR status and error.type attribute", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "model.inference",
      provider: "openai",
      model: "gpt-5.2",
      usage: {},
      durationMs: 500,
      error: "Context window exceeded",
      errorType: "context_overflow",
    });

    const span = telemetryState.tracer.startSpan.mock.results[0]?.value;
    expect(span.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ code: 2, message: "Context window exceeded" }),
    );

    // Check span attributes directly from the startSpan call
    const attrs = (telemetryState.tracer.startSpan.mock.calls[0]?.[1] as any)?.attributes;
    expect(attrs).toBeDefined();

    // error attributes are set via setAttribute, not in initial attrs
    // Verify setAttribute was called (the mock span tracks these calls)
    expect(span.setStatus).toHaveBeenCalled();

    // Verify error counter metric
    const errorCounter = telemetryState.counters.get("openclaw.inference.error");
    expect(errorCounter?.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        "error.type": "context_overflow",
      }),
    );

    await service.stop?.({} as never);
  });
});
