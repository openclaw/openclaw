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
const traceExporterCtor = vi.hoisted(() => vi.fn());

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
  OTLPTraceExporter: class {
    constructor(options?: unknown) {
      traceExporterCtor(options);
    }
  },
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: class {},
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: class {},
  LoggerProvider: class {
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
  ATTR_SERVICE_NAME: "service.name",
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

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createTraceOnlyContext(endpoint: string): OpenClawPluginServiceContext {
  return {
    config: {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          endpoint,
          protocol: "http/protobuf",
          traces: true,
          metrics: false,
          logs: false,
        },
      },
    },
    logger: createLogger(),
    stateDir: "/tmp/openclaw-diagnostics-otel-test",
  };
}

describe("diagnostics-otel service – content capture & tools", () => {
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
    traceExporterCtor.mockClear();
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
      logger: createLogger(),
      stateDir: "/tmp/openclaw-diagnostics-otel-test",
    };
  }

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
    const attrs = (inferenceCall?.[1] as any)?.attributes as Record<string, unknown>;
    expect(attrs["gen_ai.input.messages"]).toBe(JSON.stringify(inputMessages));

    const span = telemetryState.tracer.startSpan.mock.results.find(
      (r, idx) => telemetryState.tracer.startSpan.mock.calls[idx]?.[0] === "chat gpt-5.2",
    )?.value;
    expect(span.setAttribute).toHaveBeenCalledWith(
      "gen_ai.output.messages",
      JSON.stringify(outputMessages),
    );

    await service.stop?.({} as never);
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
    const attrs = (inferenceCall?.[1] as any)?.attributes as Record<string, unknown>;
    expect(attrs["gen_ai.input.messages"]).toBeUndefined();

    await service.stop?.({} as never);
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
    const attrs = (inferenceCall?.[1] as any)?.attributes as Record<string, unknown>;
    const parsed = JSON.parse(attrs["gen_ai.input.messages"] as string);
    expect(parsed[0].parts).toHaveLength(2);
    expect(parsed[0].parts[0].type).toBe("text");
    expect(parsed[0].parts[1].type).toBe("uri");
    expect(parsed[0].parts[1].modality).toBe("image");
    expect(parsed[0].parts[1].mime_type).toBe("image/png");

    await service.stop?.({} as never);
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

    const attrs = (telemetryState.tracer.startSpan.mock.calls[0]?.[1] as any)?.attributes;
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["tool_call"]);
    const parsed = JSON.parse(attrs["gen_ai.output.messages"] as string);
    expect(parsed[0].parts[0].type).toBe("tool_call");
    expect(parsed[0].parts[0].name).toBe("get_weather");
    expect(parsed[0].finish_reason).toBe("tool_call");

    await service.stop?.({} as never);
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

    const attrs = (spanCall[1] as any)?.attributes;
    expect(attrs["gen_ai.operation.name"]).toBe("execute_tool");
    expect(attrs["gen_ai.tool.name"]).toBe("web_search");
    expect(attrs["gen_ai.tool.type"]).toBe("function");
    expect(attrs["gen_ai.tool.call.id"]).toBe("call_xyz");
    expect(attrs["openclaw.channel"]).toBe("webchat");

    await service.stop?.({} as never);
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

    await service.stop?.({} as never);
  });

  test("system instructions do NOT appear on agent.turn span (belong on child chat spans)", async () => {
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

    const attrs = (telemetryState.tracer.startSpan.mock.calls[0]?.[1] as any)?.attributes;
    expect(attrs["gen_ai.system_instructions"]).toBeUndefined();

    await service.stop?.({} as never);
  });

  test("temperature and maxOutputTokens do NOT appear on agent.turn span (belong on child chat spans)", async () => {
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

    const attrs = (telemetryState.tracer.startSpan.mock.calls[0]?.[1] as any)?.attributes;
    expect(attrs["gen_ai.request.temperature"]).toBeUndefined();
    expect(attrs["gen_ai.request.max_tokens"]).toBeUndefined();

    await service.stop?.({} as never);
  });

  test("appends signal path when endpoint contains non-signal /v1 segment", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createTraceOnlyContext("https://www.comet.com/opik/api/v1/private/otel");
    await service.start(ctx);

    const options = traceExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    expect(options?.url).toBe("https://www.comet.com/opik/api/v1/private/otel/v1/traces");
    await service.stop?.({} as never);
  });

  test("keeps already signal-qualified endpoint unchanged", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createTraceOnlyContext("https://collector.example.com/v1/traces");
    await service.start(ctx);

    const options = traceExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    expect(options?.url).toBe("https://collector.example.com/v1/traces");
    await service.stop?.({} as never);
  });

  test("keeps signal-qualified endpoint unchanged when it has query params", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createTraceOnlyContext("https://collector.example.com/v1/traces?timeout=30s");
    await service.start(ctx);

    const options = traceExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    expect(options?.url).toBe("https://collector.example.com/v1/traces?timeout=30s");
    await service.stop?.({} as never);
  });

  test("keeps signal-qualified endpoint unchanged when signal path casing differs", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createTraceOnlyContext("https://collector.example.com/v1/Traces");
    await service.start(ctx);

    const options = traceExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    expect(options?.url).toBe("https://collector.example.com/v1/Traces");
    await service.stop?.({} as never);
  });
});
