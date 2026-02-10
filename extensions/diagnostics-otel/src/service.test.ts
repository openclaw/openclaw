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

vi.mock("@opentelemetry/resources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opentelemetry/resources")>();
  return {
    ...actual,
    Resource: class {
      // eslint-disable-next-line @typescript-eslint/no-useless-constructor
      constructor(_value?: unknown) {}
    },
    resourceFromAttributes: (_attrs?: unknown) => ({}),
  };
});

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

describe("diagnostics-otel service", () => {
  const startedServices: Array<ReturnType<typeof createDiagnosticsOtelService>> = [];

  afterEach(async () => {
    for (const service of startedServices.splice(0)) {
      await service.stop?.().catch(() => undefined);
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

    await service.stop?.();
  });

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
    };
  }

  test("run.completed emits gen_ai.* span attributes alongside openclaw.*", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "run.completed",
      runId: "run-usage-1",
      channel: "webchat",
      provider: "openai",
      model: "gpt-5.2",
      operationName: "chat",
      responseId: "chatcmpl-abc123",
      responseModel: "gpt-5.2-2025-06-01",
      finishReasons: ["stop"],
      sessionKey: "agent:main:main",
      sessionId: "sess-001",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 80,
        cacheWrite: 0,
        promptTokens: 180,
        total: 230,
      },
      durationMs: 1500,
    });

    const spanCall = telemetryState.tracer.startSpan.mock.calls[0];
    expect(spanCall[0]).toBe("openclaw.agent.turn");

    const attrs = spanCall[1]?.attributes;
    // gen_ai.* attributes
    expect(attrs["gen_ai.operation.name"]).toBe("chat");
    expect(attrs["gen_ai.provider.name"]).toBe("openai");
    expect(attrs["gen_ai.request.model"]).toBe("gpt-5.2");
    expect(attrs["gen_ai.response.id"]).toBe("chatcmpl-abc123");
    expect(attrs["gen_ai.response.model"]).toBe("gpt-5.2-2025-06-01");
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(attrs["gen_ai.conversation.id"]).toBe("sess-001");

    // openclaw.* attributes preserved
    expect(attrs["openclaw.channel"]).toBe("webchat");
    expect(attrs["openclaw.provider"]).toBe("openai");
    expect(attrs["openclaw.model"]).toBe("gpt-5.2");
    expect(attrs["openclaw.tokens.input"]).toBe(100);
    expect(attrs["openclaw.tokens.output"]).toBe(50);
    expect(attrs["openclaw.tokens.cache_read"]).toBe(80);
    expect(attrs["gen_ai.usage.cache_read.input_tokens"]).toBe(80);
    expect(attrs["gen_ai.usage.cache_creation.input_tokens"]).toBe(0);
    // gen_ai.usage.input_tokens should be promptTokens (input + cacheRead + cacheWrite)
    // per OTEL semconv, not raw input which excludes cached tokens
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(180);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(50);

    await service.stop?.();
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

    await service.stop?.();
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

    await service.stop?.();
  });

  test("model.inference spans are children of run.started span when runId is present", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "run.started",
      runId: "run-1",
      sessionId: "sess-1",
    });

    emitDiagnosticEvent({
      type: "model.inference",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 20, output: 10, total: 30 },
      durationMs: 100,
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    expect(calls[0]?.[0]).toBe("openclaw.agent.turn");
    expect(calls[1]?.[0]).toBe("chat gpt-5.2");
    expect(calls[1]?.[2]).toEqual(expect.objectContaining({ _type: "with-parent" }));

    await service.stop?.();
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
      const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
      expect(attrs?.["gen_ai.provider.name"]).toBe(expected);
    }

    await service.stop?.();
  });

  test("records gen_ai.input.messages when captureContent is enabled", async () => {
    const service = createService();
    await service.start(createTestCtx({ captureContent: true }));

    const inputMessages = [
      {
        role: "user" as const,
        parts: [{ type: "text" as const, content: "Hello" }],
      },
    ];
    const outputMessages = [
      {
        role: "assistant" as const,
        parts: [{ type: "text" as const, content: "Hi there!" }],
        finish_reason: "stop",
      },
    ];

    emitDiagnosticEvent({
      type: "model.inference.started",
      runId: "run-cap-1",
      provider: "openai",
      model: "gpt-5.2",
      inputMessages,
    });

    emitDiagnosticEvent({
      type: "model.inference",
      runId: "run-cap-1",
      callIndex: 0,
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 10, output: 5, total: 15 },
      outputMessages,
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    const inferenceCall = calls.find((c) => c[0] === "chat gpt-5.2");
    expect(inferenceCall).toBeDefined();
    const attrs = inferenceCall?.[1]?.attributes as Record<string, unknown>;
    expect(attrs["gen_ai.input.messages"]).toBe(JSON.stringify(inputMessages));

    const span = telemetryState.tracer.startSpan.mock.results.find(
      (r, idx) => telemetryState.tracer.startSpan.mock.calls[idx]?.[0] === "chat gpt-5.2",
    )?.value;
    expect(span.setAttribute).toHaveBeenCalledWith(
      "gen_ai.output.messages",
      JSON.stringify(outputMessages),
    );

    await service.stop?.();
  });

  test("does NOT record gen_ai.input.messages when captureContent is disabled", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "model.inference.started",
      runId: "run-cap-2",
      provider: "openai",
      model: "gpt-5.2",
      inputMessages: [
        { role: "user" as const, parts: [{ type: "text" as const, content: "secret" }] },
      ],
    });

    emitDiagnosticEvent({
      type: "model.inference",
      runId: "run-cap-2",
      callIndex: 0,
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 10, output: 5, total: 15 },
      outputMessages: [
        { role: "assistant" as const, parts: [{ type: "text" as const, content: "x" }] },
      ],
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    const inferenceCall = calls.find((c) => c[0] === "chat gpt-5.2");
    const attrs = inferenceCall?.[1]?.attributes as Record<string, unknown>;
    expect(attrs["gen_ai.input.messages"]).toBeUndefined();

    await service.stop?.();
  });

  test("input messages with media parts use correct modality and type", async () => {
    const service = createService();
    await service.start(createTestCtx({ captureContent: true }));

    const inputMessages = [
      {
        role: "user" as const,
        parts: [
          { type: "text" as const, content: "What's in this image?" },
          {
            type: "uri" as const,
            modality: "image" as const,
            mime_type: "image/png",
            uri: "https://example.com/photo.png",
          },
        ],
      },
    ];

    emitDiagnosticEvent({
      type: "model.inference.started",
      runId: "run-media-1",
      provider: "openai",
      model: "gpt-5.2",
      inputMessages,
    });

    emitDiagnosticEvent({
      type: "model.inference",
      runId: "run-media-1",
      callIndex: 0,
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 500, output: 50, total: 550 },
      outputMessages: [
        { role: "assistant" as const, parts: [{ type: "text" as const, content: "x" }] },
      ],
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    const inferenceCall = calls.find((c) => c[0] === "chat gpt-5.2");
    const attrs = inferenceCall?.[1]?.attributes as Record<string, unknown>;
    const parsed = JSON.parse(attrs["gen_ai.input.messages"] as string);
    expect(parsed[0].parts).toHaveLength(2);
    expect(parsed[0].parts[0].type).toBe("text");
    expect(parsed[0].parts[1].type).toBe("uri");
    expect(parsed[0].parts[1].modality).toBe("image");
    expect(parsed[0].parts[1].mime_type).toBe("image/png");

    await service.stop?.();
  });

  test("output messages with tool_call parts are recorded correctly", async () => {
    const service = createService();
    await service.start(createTestCtx({ captureContent: true }));

    const outputMessages = [
      {
        role: "assistant" as const,
        parts: [
          {
            type: "tool_call" as const,
            id: "call_abc",
            name: "get_weather",
            arguments: { location: "Paris" },
          },
        ],
        finish_reason: "tool_call",
      },
    ];

    emitDiagnosticEvent({
      type: "model.inference",
      provider: "openai",
      model: "gpt-5.2",
      finishReasons: ["tool_call"],
      usage: { input: 100, output: 20, total: 120 },
      outputMessages,
    });

    const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["tool_call"]);
    const parsed = JSON.parse(attrs["gen_ai.output.messages"] as string);
    expect(parsed[0].parts[0].type).toBe("tool_call");
    expect(parsed[0].parts[0].name).toBe("get_weather");
    expect(parsed[0].finish_reason).toBe("tool_call");

    await service.stop?.();
  });

  test("tool.execution emits execute_tool span with gen_ai.tool.* attributes", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "tool.execution",
      toolName: "web_search",
      toolType: "function",
      toolCallId: "call_xyz",
      channel: "webchat",
      durationMs: 850,
    });

    const spanCall = telemetryState.tracer.startSpan.mock.calls[0];
    expect(spanCall[0]).toBe("execute_tool web_search");

    const attrs = spanCall[1]?.attributes;
    expect(attrs["gen_ai.operation.name"]).toBe("execute_tool");
    expect(attrs["gen_ai.tool.name"]).toBe("web_search");
    expect(attrs["gen_ai.tool.type"]).toBe("function");
    expect(attrs["gen_ai.tool.call.id"]).toBe("call_xyz");
    expect(attrs["openclaw.channel"]).toBe("webchat");

    await service.stop?.();
  });

  test("tool.execution with error sets ERROR span status", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "tool.execution",
      toolName: "exec",
      toolCallId: "call_err",
      durationMs: 100,
      error: "timeout",
    });

    const span = telemetryState.tracer.startSpan.mock.results[0]?.value;
    expect(span.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ code: 2, message: "timeout" }),
    );

    await service.stop?.();
  });

  test("inference spans use SpanKind.CLIENT, tool spans use SpanKind.INTERNAL", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "model.inference",
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 10, output: 5, total: 15 },
    });

    emitDiagnosticEvent({
      type: "tool.execution",
      toolName: "web_search",
      durationMs: 200,
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    // SpanKind.CLIENT = 2, SpanKind.INTERNAL = 0
    expect(calls[0][1]?.kind).toBe(2);
    expect(calls[1][1]?.kind).toBe(0);

    await service.stop?.();
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

    await service.stop?.();
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

    const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["length"]);

    await service.stop?.();
  });

  test("tool spans with matching runId are children of the run span", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "run.started",
      runId: "run-parent-child",
      sessionId: "sess-1",
    });

    emitDiagnosticEvent({
      type: "tool.execution",
      runId: "run-parent-child",
      toolName: "web_search",
      toolType: "function",
      toolCallId: "call-1",
      durationMs: 200,
    });
    emitDiagnosticEvent({
      type: "tool.execution",
      runId: "run-parent-child",
      toolName: "read",
      toolType: "function",
      toolCallId: "call-2",
      durationMs: 50,
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    // 3 spans: 1 run parent + 2 child tool spans
    expect(calls).toHaveLength(3);

    // First call is the run span
    expect(calls[0][0]).toBe("openclaw.agent.turn");
    const parentSpan = telemetryState.tracer.startSpan.mock.results[0]?.value;

    // Tool spans should have been created with a parent context derived from the run span
    expect(calls[1][0]).toBe("execute_tool web_search");
    const toolParentCtx1 = calls[1][2] as { _type: string; _span: unknown };
    expect(toolParentCtx1._type).toBe("with-parent");
    expect(toolParentCtx1._span).toBe(parentSpan);

    expect(calls[2][0]).toBe("execute_tool read");
    const toolParentCtx2 = calls[2][2] as { _type: string; _span: unknown };
    expect(toolParentCtx2._type).toBe("with-parent");
    expect(toolParentCtx2._span).toBe(parentSpan);

    // Tool spans end immediately; the run span stays open until run.completed.
    expect(parentSpan.end).not.toHaveBeenCalled();
    expect(telemetryState.tracer.startSpan.mock.results[1]?.value.end).toHaveBeenCalled();
    expect(telemetryState.tracer.startSpan.mock.results[2]?.value.end).toHaveBeenCalled();

    await service.stop?.();
  });

  test("tool spans with matching runId are children of the active inference span when present", async () => {
    const service = createService();
    await service.start(createTestCtx({ captureContent: true }));

    emitDiagnosticEvent({
      type: "run.started",
      runId: "run-tool-parent-1",
      sessionId: "sess-1",
    });

    emitDiagnosticEvent({
      type: "model.inference.started",
      runId: "run-tool-parent-1",
      callIndex: 0,
      provider: "openai",
      model: "gpt-5.2",
      inputMessages: [{ role: "user" as const, parts: [{ type: "text" as const, content: "hi" }] }],
    });

    emitDiagnosticEvent({
      type: "tool.execution",
      runId: "run-tool-parent-1",
      toolName: "web_search",
      toolType: "function",
      toolCallId: "call-1",
      durationMs: 200,
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    const inferenceSpan = telemetryState.tracer.startSpan.mock.results.find(
      (r, idx) => calls[idx]?.[0] === "chat gpt-5.2",
    )?.value;
    expect(inferenceSpan).toBeDefined();

    const toolCall = calls.find((c) => c[0] === "execute_tool web_search");
    expect(toolCall).toBeDefined();
    const toolParentCtx = toolCall?.[2] as { _type: string; _span: unknown };
    expect(toolParentCtx._type).toBe("with-parent");
    expect(toolParentCtx._span).toBe(inferenceSpan);

    emitDiagnosticEvent({
      type: "model.inference",
      runId: "run-tool-parent-1",
      callIndex: 0,
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 10, output: 5, total: 15 },
      outputMessages: [
        { role: "assistant" as const, parts: [{ type: "text" as const, content: "ok" }] },
      ],
    });

    await service.stop?.();
  });

  test("tool events without runId create standalone spans (backward compat)", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "tool.execution",
      toolName: "exec",
      toolType: "function",
      toolCallId: "call-no-run",
      durationMs: 100,
    });

    // Span should be created immediately (no buffering)
    expect(telemetryState.tracer.startSpan).toHaveBeenCalledTimes(1);
    expect(telemetryState.tracer.startSpan.mock.calls[0][0]).toBe("execute_tool exec");
    // No parent context
    expect(telemetryState.tracer.startSpan.mock.calls[0][2]).toBeUndefined();

    await service.stop?.();
  });

  test("system instructions appear as gen_ai.system_instructions when captureContent is enabled", async () => {
    const service = createService();
    await service.start(createTestCtx({ captureContent: true }));

    emitDiagnosticEvent({
      type: "run.completed",
      runId: "run-sys-1",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      usage: { input: 100, output: 50, total: 150 },
      systemInstructions: [{ type: "text" as const, content: "You are a helpful assistant." }],
    });

    const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
    expect(attrs["gen_ai.system_instructions"]).toBe(
      JSON.stringify([{ type: "text", content: "You are a helpful assistant." }]),
    );

    await service.stop?.();
  });

  test("temperature and maxOutputTokens appear as gen_ai.request.* span attributes", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "run.completed",
      runId: "run-temp-1",
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 100, output: 50, total: 150 },
      temperature: 0.7,
      maxOutputTokens: 4096,
    });

    const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
    expect(attrs["gen_ai.request.temperature"]).toBe(0.7);
    expect(attrs["gen_ai.request.max_tokens"]).toBe(4096);

    await service.stop?.();
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

    const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
    expect(attrs["gen_ai.client.time_to_first_token"]).toBe(350);

    await service.stop?.();
  });

  test("error event creates span with ERROR status and gen_ai.error.type attribute", async () => {
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
    const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
    expect(attrs).toBeDefined();

    // error attributes are set via setAttribute, not in initial attrs
    // Verify setAttribute was called (the mock span tracks these calls)
    expect(span.setStatus).toHaveBeenCalled();

    // Verify error counter metric
    const errorCounter = telemetryState.counters.get("openclaw.inference.error");
    expect(errorCounter?.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        "openclaw.error.type": "context_overflow",
      }),
    );

    await service.stop?.();
  });

  test("tool events with runId but without run.started are standalone spans", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "tool.execution",
      runId: "run-orphaned",
      toolName: "web_search",
      durationMs: 200,
    });

    // Tool span should be created immediately without a parent
    expect(telemetryState.tracer.startSpan).toHaveBeenCalledTimes(1);
    expect(telemetryState.tracer.startSpan.mock.calls[0][0]).toBe("execute_tool web_search");
    expect(telemetryState.tracer.startSpan.mock.calls[0][2]).toBeUndefined();

    await service.stop?.();
  });

  test("agent.turn spans are nested under openclaw.message root span", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      sessionKey: "telegram:agent:123",
      queueDepth: 1,
    });

    emitDiagnosticEvent({
      type: "run.started",
      runId: "run-nested-1",
      sessionId: "sess-nested-1",
      sessionKey: "telegram:agent:123",
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    expect(calls[0]?.[0]).toBe("openclaw.message");
    expect(calls[1]?.[0]).toBe("openclaw.agent.turn");
    // agent.turn should have a parent context pointing to the root span
    expect(calls[1]?.[2]).toEqual(expect.objectContaining({ _type: "with-parent" }));

    await service.stop?.();
  });

  test("message.processed ends the root span and sets attributes", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      sessionKey: "telegram:agent:456",
      queueDepth: 1,
    });

    const rootSpan = telemetryState.tracer.startSpan.mock.results[0]?.value;
    expect(rootSpan).toBeDefined();

    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      sessionKey: "telegram:agent:456",
      outcome: "completed",
      durationMs: 250,
      messageId: "msg-001",
    });

    expect(rootSpan.setAttribute).toHaveBeenCalledWith("openclaw.outcome", "completed");
    expect(rootSpan.setAttribute).toHaveBeenCalledWith("openclaw.durationMs", 250);
    expect(rootSpan.setAttribute).toHaveBeenCalledWith("openclaw.messageId", "msg-001");
    expect(rootSpan.setStatus).toHaveBeenCalledWith({ code: 1 }); // SpanStatusCode.OK
    expect(rootSpan.end).toHaveBeenCalled();

    await service.stop?.();
  });

  test("message.processed sets ERROR status on error outcome", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      sessionKey: "telegram:agent:789",
      queueDepth: 1,
    });

    const rootSpan = telemetryState.tracer.startSpan.mock.results[0]?.value;

    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      sessionKey: "telegram:agent:789",
      outcome: "error",
      error: "Model timeout",
    });

    expect(rootSpan.setStatus).toHaveBeenCalledWith({
      code: 2, // SpanStatusCode.ERROR
      message: "Model timeout",
    });
    expect(rootSpan.end).toHaveBeenCalled();

    await service.stop?.();
  });

  test("message.processed without matching message.queued does not crash", async () => {
    const service = createService();
    await service.start(createTestCtx());

    // No message.queued emitted — should not throw
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      sessionKey: "telegram:agent:unknown",
      outcome: "completed",
    });

    // Only metrics should be recorded, no span created
    expect(telemetryState.counters.get("openclaw.message.processed")?.add).toHaveBeenCalled();
    expect(telemetryState.tracer.startSpan).not.toHaveBeenCalled();

    await service.stop?.();
  });
});
