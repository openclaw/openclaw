// Diagnostics Otel tests cover service plugin behavior.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const telemetryState = vi.hoisted(() => {
  type TestSpanContext = {
    traceId: string;
    spanId: string;
    traceFlags: number;
  };
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
  const spans: Array<{
    name: string;
    addEvent: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    setAttributes: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    spanContext: ReturnType<typeof vi.fn<() => TestSpanContext>>;
  }> = [];
  const tracer = {
    startSpan: vi.fn((name: string, _opts?: unknown, _ctx?: unknown) => {
      const spanNumber = spans.length + 1;
      const spanId = spanNumber.toString(16).padStart(16, "0");
      const span = {
        addEvent: vi.fn(),
        end: vi.fn(),
        setAttributes: vi.fn(),
        setStatus: vi.fn(),
        spanContext: vi.fn<() => TestSpanContext>(() => ({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId,
          traceFlags: 1,
        })),
      };
      spans.push({ name, ...span });
      return span;
    }),
    setSpanContext: vi.fn((_ctx: unknown, spanContext: unknown) => ({ spanContext })),
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
  return { counters, histograms, spans, tracer, meter };
});

const traceProviderCtor = vi.hoisted(() => vi.fn());
const traceProviderShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const meterProviderCtor = vi.hoisted(() => vi.fn());
const meterProviderShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const diagWarn = vi.hoisted(() => vi.fn());
const detectResourcesMock = vi.hoisted(() =>
  vi.fn((_options: { detectors?: unknown[] }) => ({
    attributes: { "openclaw.test.detected": "1" },
    merge: vi.fn((configured: { attributes?: Record<string, unknown> }) => ({
      attributes: {
        "openclaw.test.detected": "1",
        ...configured.attributes,
      },
    })),
  })),
);
const logEmit = vi.hoisted(() => vi.fn());
const logShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const traceExporterCtor = vi.hoisted(() => vi.fn());
const metricExporterCtor = vi.hoisted(() => vi.fn());
const logExporterCtor = vi.hoisted(() => vi.fn());
const traceExporterExport = vi.hoisted(() => vi.fn());
const metricExporterExport = vi.hoisted(() => vi.fn());
const logExporterExport = vi.hoisted(() => vi.fn());
const traceExporterShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const metricExporterShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const logExporterShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const exporterForceFlush = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const logProcessorCtor = vi.hoisted(() => vi.fn());
const spanProcessorCtor = vi.hoisted(() => vi.fn());
const metricReaderCtor = vi.hoisted(() => vi.fn());
const ownedSdkRuntimeCleanup = vi.hoisted(() => vi.fn());
const registerOwnedSdkRuntimeMock = vi.hoisted(() => vi.fn(() => ownedSdkRuntimeCleanup));
const nodeProxyAgent = vi.hoisted(() => ({ kind: "node-proxy-agent" }));
const createNodeProxyAgentMock = vi.hoisted(() => vi.fn());
const unhandledRejectionHandlerState = vi.hoisted(() => {
  let handlers: Array<(reason: unknown) => boolean> = [];
  return {
    getHandlers: () => handlers,
    register: vi.fn((handler: (reason: unknown) => boolean) => {
      handlers.push(handler);
      return () => {
        handlers = handlers.filter((candidate) => candidate !== handler);
      };
    }),
    reset: () => {
      handlers = [];
    },
  };
});

vi.mock("@opentelemetry/api", async (importOriginal) => ({
  createNoopMeter: (await importOriginal<typeof import("@opentelemetry/api")>()).createNoopMeter,
  ROOT_CONTEXT: (await importOriginal<typeof import("@opentelemetry/api")>()).ROOT_CONTEXT,
  context: {
    active: () => ({}),
  },
  diag: {
    warn: diagWarn,
  },
  metrics: {
    getMeter: () => telemetryState.meter,
  },
  isSpanContextValid: () => true,
  trace: {
    getTracer: () => telemetryState.tracer,
    setSpanContext: telemetryState.tracer.setSpanContext,
  },
  TraceFlags: {
    NONE: 0,
    SAMPLED: 1,
  },
  SpanStatusCode: {
    ERROR: 2,
  },
  SpanKind: {
    CLIENT: 2,
  },
}));

vi.mock("./service-propagation.js", () => ({
  registerOwnedSdkRuntime: registerOwnedSdkRuntimeMock,
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-proto", () => ({
  OTLPMetricExporter: function OTLPMetricExporter(options?: unknown) {
    metricExporterCtor(options);
    return {
      export: metricExporterExport,
      forceFlush: exporterForceFlush,
      shutdown: metricExporterShutdown,
    };
  },
}));

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: function OTLPTraceExporter(options?: unknown) {
    traceExporterCtor(options);
    return {
      export: traceExporterExport,
      forceFlush: exporterForceFlush,
      shutdown: traceExporterShutdown,
    };
  },
}));

vi.mock("@opentelemetry/exporter-logs-otlp-proto", () => ({
  OTLPLogExporter: function OTLPLogExporter(options?: unknown) {
    logExporterCtor(options);
    return {
      export: logExporterExport,
      forceFlush: exporterForceFlush,
      shutdown: logExporterShutdown,
    };
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  registerUnhandledRejectionHandler: unhandledRejectionHandlerState.register,
}));

vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({
  createNodeProxyAgent: createNodeProxyAgentMock,
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: function BatchLogRecordProcessor(options?: unknown) {
    logProcessorCtor(options);
  },
  LoggerProvider: class {
    getLogger = vi.fn(() => ({
      emit: logEmit,
    }));
    shutdown = logShutdown;
  },
}));

vi.mock("@opentelemetry/sdk-metrics", () => ({
  MeterProvider: class {
    constructor(options?: unknown) {
      meterProviderCtor(options);
    }

    getMeter = () => telemetryState.meter;
    shutdown = meterProviderShutdown;
  },
  PeriodicExportingMetricReader: function PeriodicExportingMetricReader(options?: unknown) {
    metricReaderCtor(options);
  },
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BasicTracerProvider: class {
    constructor(options?: unknown) {
      traceProviderCtor(options);
    }

    getTracer = () => telemetryState.tracer;
    shutdown = traceProviderShutdown;
  },
  BatchSpanProcessor: function BatchSpanProcessor(exporter?: unknown, options?: unknown) {
    spanProcessorCtor(exporter, options);
  },
  ParentBasedSampler: function ParentBasedSampler() {},
  TraceIdRatioBasedSampler: function TraceIdRatioBasedSampler() {},
}));

vi.mock("@opentelemetry/resources", () => ({
  detectResources: detectResourcesMock,
  envDetector: { detector: "env" },
  hostDetector: { detector: "host" },
  osDetector: { detector: "os" },
  processDetector: { detector: "process" },
  serviceInstanceIdDetector: { detector: "serviceinstance" },
  resourceFromAttributes: vi.fn((attrs: Record<string, unknown>) => ({
    attributes: attrs,
    merge: vi.fn((other: unknown) => other ?? {}),
  })),
  Resource: function Resource(_value?: unknown) {
    // Constructor shape required by the mocked OpenTelemetry API.
  },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

import {
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  emitDiagnosticEventWithTrustedTraceContext,
  emitInternalDiagnosticEventForTest,
  emitTrustedSecurityEvent,
  logMessageDispatchStarted,
  logMessageProcessed,
  runWithDiagnosticTraceContext,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { emitDiagnosticEvent, type DiagnosticEventPayload } from "../api.js";
import { MAX_RETAINED_TRUSTED_SPAN_CONTEXTS } from "./service-constants.js";
import {
  createExporterHealthEventEmitter,
  type ExporterHealthUpdate,
} from "./service-exporter-health.js";
import { createDiagnosticsLogExporter } from "./service-logs.js";
import { createDiagnosticsOtelService } from "./service.js";
import {
  CHILD_SPAN_ID,
  createOtelContext,
  createTestTrace,
  getReportedExporterHealth,
  GRANDCHILD_SPAN_ID,
  MODEL_CALL_SPAN_ID,
  MODEL_CALL_FIXTURE,
  MODEL_FIXTURE,
  MODEL_USAGE_SPAN_ID,
  OTEL_TEST_ENDPOINT,
  RUN_FIXTURE,
  SPAN_ID,
  startOtelService,
  stopStartedOtelServices,
  TOOL_SPAN_ID,
  TRACE_ID,
} from "./service.test-helpers.js";

function numberedSpanId(index: number) {
  return (index + 0x1000).toString(16).padStart(16, "0");
}
// Longer than the default 30-minute background exec timeout.
const LATE_CHILD_ELAPSED_MS = 30 * 60_000 + 1_000;
const PROTO_KEY = "__proto__";
const MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS = 128 * 1024;
type TelemetryExporterEvent = Extract<DiagnosticEventPayload, { type: "telemetry.exporter" }>;
const OTEL_TRUNCATED_SUFFIX_MAX_CHARS = 20;
const OTEL_PROTOCOL_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
] as const;
const OTEL_PROVIDER_ENV_KEYS = [
  "OTEL_BSP_EXPORT_TIMEOUT",
  "OTEL_BSP_MAX_EXPORT_BATCH_SIZE",
  "OTEL_BSP_MAX_QUEUE_SIZE",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_METRIC_EXPORT_TIMEOUT",
  "OTEL_NODE_EXPERIMENTAL_SDK_METRICS",
  "OTEL_NODE_RESOURCE_DETECTORS",
  "OTEL_SERVICE_NAME",
  "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  "OTEL_SPAN_EVENT_COUNT_LIMIT",
  "OTEL_SPAN_LINK_COUNT_LIMIT",
  "OTEL_TRACES_SAMPLER",
  "OTEL_TRACES_SAMPLER_ARG",
] as const;
const OTEL_CERT_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_LOGS_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY",
] as const;
const OTEL_ENV_KEYS = [
  "OPENCLAW_OTEL_PRELOADED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_SEMCONV_STABILITY_OPT_IN",
  "OTEL_SDK_DISABLED",
  "OTEL_PROPAGATORS",
  ...OTEL_PROTOCOL_ENV_KEYS,
  ...OTEL_PROVIDER_ENV_KEYS,
  ...OTEL_CERT_ENV_KEYS,
];
const originalOtelEnv = new Map(OTEL_ENV_KEYS.map((key) => [key, process.env[key]]));

function startedSpanCall(name: string, index = 0) {
  const calls = telemetryState.tracer.startSpan.mock.calls as unknown as Array<
    [
      string,
      { attributes?: Record<string, unknown>; kind?: unknown; startTime?: unknown }?,
      unknown?,
    ]
  >;
  return calls.filter(([spanName]) => spanName === name)[index];
}

function startedSpanOptions(name: string, index = 0) {
  return startedSpanCall(name, index)?.[1];
}

function startedSpanParentContexts(name: string) {
  return telemetryState.tracer.startSpan.mock.calls
    .filter((call) => call[0] === name)
    .map(
      (call) =>
        (call[2] as { spanContext?: { traceId?: string; spanId?: string } } | undefined)
          ?.spanContext,
    );
}

function startedSpanParentContextsByName(name: string) {
  return telemetryState.tracer.startSpan.mock.calls
    .filter((call) => call[0] === name)
    .map((call) => ({
      attributes: (call[1] as { attributes?: Record<string, unknown> } | undefined)?.attributes,
      parentContext: (
        call[2] as { spanContext?: { traceId?: string; spanId?: string } } | undefined
      )?.spanContext,
    }));
}

function mockCall(mock: { mock: { calls: unknown[][] } }, callIndex = 0): unknown[] {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call at index ${callIndex}`);
  }
  return call;
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, argIndex: number, callIndex = 0) {
  return mockCall(mock, callIndex)[argIndex];
}

type TestExporterOptions = {
  url?: string;
  httpAgentOptions?: (protocol: string) => unknown;
};

function firstExporterOptions(mock: { mock: { calls: unknown[][] } }): TestExporterOptions {
  return mockCallArg(mock, 0) as TestExporterOptions;
}

function createNodeProxyAgentCalls(): Array<{
  mode?: string;
  targetUrl?: string;
  agentOptions?: {
    keepAlive?: boolean;
    ca?: Buffer;
    cert?: Buffer;
    key?: Buffer;
  };
}> {
  return createNodeProxyAgentMock.mock.calls.map(
    ([options]) =>
      options as {
        mode?: string;
        targetUrl?: string;
        agentOptions?: {
          keepAlive?: boolean;
          ca?: Buffer;
          cert?: Buffer;
          key?: Buffer;
        };
      },
  );
}

function findCreateNodeProxyAgentCall(targetUrl: string) {
  const call = createNodeProxyAgentCalls().find((candidate) => candidate.targetUrl === targetUrl);
  if (!call) {
    throw new Error(`Expected createNodeProxyAgent call for ${targetUrl}`);
  }
  return call;
}

type TestSpanProcessorOptions = {
  exportTimeoutMillis?: number;
  maxExportBatchSize?: number;
  maxQueueSize?: number;
  scheduledDelayMillis?: number;
  selfObsMeterProvider?: unknown;
};

function firstSpanProcessorOptions(): TestSpanProcessorOptions {
  return mockCallArg(spanProcessorCtor, 1) as TestSpanProcessorOptions;
}

function firstMetricReaderOptions(): {
  exportIntervalMillis?: number;
  exportTimeoutMillis?: number;
} {
  return mockCallArg(metricReaderCtor, 0) as {
    exportIntervalMillis?: number;
    exportTimeoutMillis?: number;
  };
}

function firstLogProcessorOptions(): { exporter?: unknown; scheduledDelayMillis?: number } {
  return mockCallArg(logProcessorCtor, 0) as {
    exporter?: unknown;
    scheduledDelayMillis?: number;
  };
}

function firstSetSpanContext(): Record<string, unknown> {
  return mockCallArg(telemetryState.tracer.setSpanContext, 1) as Record<string, unknown>;
}

function spanByName(name: string): (typeof telemetryState.spans)[number] {
  const span = telemetryState.spans.find((candidate) => candidate.name === name);
  if (!span) {
    throw new Error(`Expected span ${name}`);
  }
  return span;
}

function firstSpanAttributes(name: string): Record<string, unknown> {
  return mockCallArg(spanByName(name).setAttributes, 0) as Record<string, unknown>;
}

function expectAbsent(attributes: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    expect(Object.hasOwn(attributes ?? {}, key)).toBe(false);
  }
}

function stringAttribute(attrs: Record<string, unknown> | undefined, key: string): string {
  const value = attrs?.[key];
  expect(value).toEqual(expect.any(String));
  return value as string;
}

function firstSpanEndTime(name: string): unknown {
  return mockCallArg(spanByName(name).end, 0);
}

function firstCounterAddCall(name: string): [unknown, Record<string, unknown>?] {
  const counter = telemetryState.counters.get(name);
  if (!counter) {
    throw new Error(`Expected counter ${name}`);
  }
  return mockCall(counter.add) as [unknown, Record<string, unknown>?];
}

function lastHistogramRecord(name: string) {
  return telemetryState.histograms.get(name)?.record.mock.calls.at(-1) as
    | [unknown, Record<string, unknown>?]
    | undefined;
}

type StdoutDiagnosticLogLine = {
  ts?: string;
  signal?: string;
  "service.name"?: string;
  severityText?: string;
  severityNumber?: number;
  body?: unknown;
  attributes?: Record<string, unknown>;
  trace_id?: string;
  span_id?: string;
  trace_flags?: string;
};

function captureStdoutWrites() {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  return { writes, spy };
}

function parseSingleStdoutDiagnosticLogLine(writes: string[]): StdoutDiagnosticLogLine {
  expect(writes).toHaveLength(1);
  expect(writes[0]?.endsWith("\n")).toBe(true);
  const line = writes[0]?.slice(0, -1) ?? "";
  expect(line).not.toContain("\n");
  return JSON.parse(line) as StdoutDiagnosticLogLine;
}

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function emitAndFlush(event: Parameters<typeof emitDiagnosticEvent>[0]) {
  emitDiagnosticEvent(event);
  await flushDiagnosticEvents();
}

async function emitTrustedAndFlush(event: Parameters<typeof emitTrustedDiagnosticEvent>[0]) {
  emitTrustedDiagnosticEvent(event);
  await flushDiagnosticEvents();
}

type TrustedEvent = Parameters<typeof emitTrustedDiagnosticEvent>[0];
type TrustedEventOf<T extends TrustedEvent["type"]> = Extract<TrustedEvent, { type: T }>;
type EventFields<T extends TrustedEvent["type"]> = Omit<TrustedEventOf<T>, "type">;

const EVENT_FIXTURES = {
  "harness.run.completed": {
    ...RUN_FIXTURE,
    harnessId: "openclaw",
    outcome: "completed",
    durationMs: 90,
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
  } satisfies EventFields<"harness.run.completed">,
  "log.record": {
    level: "INFO",
    message: "test log",
  } satisfies EventFields<"log.record">,
  "model.call.completed": {
    ...MODEL_CALL_FIXTURE,
    durationMs: 80,
    trace: createTestTrace(MODEL_CALL_SPAN_ID, CHILD_SPAN_ID),
  } satisfies EventFields<"model.call.completed">,
  "model.call.started": {
    ...MODEL_CALL_FIXTURE,
    trace: createTestTrace(MODEL_CALL_SPAN_ID, CHILD_SPAN_ID),
  } satisfies EventFields<"model.call.started">,
  "model.usage": {
    ...MODEL_FIXTURE,
    usage: { input: 3, output: 2, total: 5 },
    durationMs: 10,
    trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
  } satisfies EventFields<"model.usage">,
  "run.completed": {
    ...RUN_FIXTURE,
    outcome: "completed",
    durationMs: 100,
    trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
  } satisfies EventFields<"run.completed">,
  "run.started": {
    ...RUN_FIXTURE,
    trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
  } satisfies EventFields<"run.started">,
  "tool.execution.completed": {
    runId: "run-1",
    toolName: "read",
    durationMs: 20,
    trace: createTestTrace(TOOL_SPAN_ID, GRANDCHILD_SPAN_ID),
  } satisfies EventFields<"tool.execution.completed">,
  "tool.execution.error": {
    runId: "run-1",
    toolName: "read",
    durationMs: 20,
    errorCategory: "TypeError",
    trace: createTestTrace(TOOL_SPAN_ID, GRANDCHILD_SPAN_ID),
  } satisfies EventFields<"tool.execution.error">,
  "tool.execution.started": {
    runId: "run-1",
    toolName: "read",
    trace: createTestTrace(TOOL_SPAN_ID, GRANDCHILD_SPAN_ID),
  } satisfies EventFields<"tool.execution.started">,
};

type FixtureEventType = keyof typeof EVENT_FIXTURES;

function buildEventFixture(
  type: TrustedEvent["type"],
  overrides: Record<string, unknown> = {},
  omitted: readonly string[] = [],
): TrustedEvent {
  const defaults = EVENT_FIXTURES[type as FixtureEventType];
  const event = { ...defaults, type, ...overrides } as Record<string, unknown>;
  for (const key of omitted) {
    delete event[key];
  }
  return event as TrustedEvent;
}

function eventFixture<T extends FixtureEventType>(
  type: T,
  overrides?: Partial<EventFields<T>>,
  omitted?: readonly (keyof EventFields<T>)[],
): TrustedEventOf<T>;
function eventFixture<T extends TrustedEvent["type"]>(
  type: T,
  event: EventFields<T>,
  omitted?: readonly (keyof EventFields<T>)[],
): TrustedEventOf<T>;
function eventFixture(
  type: TrustedEvent["type"],
  overrides: Record<string, unknown> = {},
  omitted: readonly string[] = [],
): TrustedEvent {
  return buildEventFixture(type, overrides, omitted);
}

type FixtureEmitter<TResult> = {
  <T extends FixtureEventType>(
    type: T,
    overrides?: Partial<EventFields<T>>,
    omitted?: readonly (keyof EventFields<T>)[],
  ): TResult;
  <T extends TrustedEvent["type"]>(
    type: T,
    event: EventFields<T>,
    omitted?: readonly (keyof EventFields<T>)[],
  ): TResult;
};

function createFixtureEmitter<TResult>(
  emit: (event: TrustedEvent) => TResult,
): FixtureEmitter<TResult> {
  return ((
    type: TrustedEvent["type"],
    overrides?: Record<string, unknown>,
    omitted?: readonly string[],
  ) => emit(buildEventFixture(type, overrides, omitted))) as FixtureEmitter<TResult>;
}

const emitEvent = createFixtureEmitter(emitDiagnosticEvent);
const emitEventAndFlush = createFixtureEmitter(emitAndFlush);
const emitTrustedEvent = createFixtureEmitter(emitTrustedDiagnosticEvent);
const emitTrustedEventAndFlush = createFixtureEmitter(emitTrustedAndFlush);
const emitInternalEvent = createFixtureEmitter(emitInternalDiagnosticEventForTest);

type OtelServiceOptions = NonNullable<Parameters<typeof startOtelService>[0]>;
type OtelSignal = "traces" | "metrics" | "logs";
const omitConfiguredProtocol: NonNullable<OtelServiceOptions["configure"]> = (ctx) => {
  delete ctx.config.diagnostics?.otel?.protocol;
};

function startServiceFixture(
  signals: readonly OtelSignal[],
  optionsOrConfigure:
    | Omit<OtelServiceOptions, OtelSignal>
    | NonNullable<OtelServiceOptions["configure"]> = {},
) {
  const options =
    typeof optionsOrConfigure === "function"
      ? { configure: optionsOrConfigure }
      : optionsOrConfigure;
  return startOtelService({
    traces: signals.includes("traces"),
    metrics: signals.includes("metrics"),
    logs: signals.includes("logs"),
    ...options,
  });
}

type RecorderCase = {
  name: string;
  signals: OtelSignal[];
  trusted?: boolean;
  events: TrustedEvent[];
  metrics: Array<
    [
      kind: "counter" | "histogram",
      name: string,
      calls: unknown[][],
      position?: "first" | "last",
      omittedText?: string[],
    ]
  >;
  span?: {
    name: string;
    attributes: Record<string, unknown>;
    status?: { code: number; message: string };
    omittedText?: string[];
  };
  stateOmits?: string[];
};

function captureExporterEvents() {
  const events: TelemetryExporterEvent[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event) => {
    if (event.type === "telemetry.exporter") {
      events.push(event);
    }
  });
  return { events, unsubscribe };
}

function emitTrustedModelCallCompletedWithContent(
  modelContent: NonNullable<DiagnosticEventPrivateData["modelContent"]>,
  overrides: Partial<EventFields<"model.call.completed">> = {},
) {
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      durationMs: 80,
      ...overrides,
    },
    { modelContent },
  );
}

async function captureModelContent(
  ...args: Parameters<typeof emitTrustedModelCallCompletedWithContent>
) {
  await startServiceFixture(["traces"], { captureContent: true });
  emitTrustedModelCallCompletedWithContent(...args);
  await flushDiagnosticEvents();
  return firstSpanAttributes("openclaw.model.call");
}

function emitTrustedToolExecutionCompletedWithContent(
  toolContent: NonNullable<DiagnosticEventPrivateData["toolContent"]>,
  overrides: Partial<EventFields<"tool.execution.completed">> = {},
) {
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "tool.execution.completed",
      runId: "run-1",
      toolName: "read",
      durationMs: 20,
      ...overrides,
    },
    { toolContent },
  );
}

afterAll(() => {
  vi.doUnmock("@opentelemetry/api");
  vi.doUnmock("@opentelemetry/exporter-metrics-otlp-proto");
  vi.doUnmock("@opentelemetry/exporter-trace-otlp-proto");
  vi.doUnmock("@opentelemetry/exporter-logs-otlp-proto");
  vi.doUnmock("@opentelemetry/sdk-logs");
  vi.doUnmock("@opentelemetry/sdk-metrics");
  vi.doUnmock("@opentelemetry/sdk-trace-base");
  vi.doUnmock("openclaw/plugin-sdk/fetch-runtime");
  vi.doUnmock("@opentelemetry/resources");
  vi.doUnmock("@opentelemetry/semantic-conventions");
  vi.resetModules();
});

describe("diagnostics-otel service", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    for (const key of OTEL_ENV_KEYS) {
      delete process.env[key];
    }
    telemetryState.counters.clear();
    telemetryState.histograms.clear();
    telemetryState.spans.length = 0;
    for (const mock of [
      telemetryState.tracer.startSpan,
      telemetryState.tracer.setSpanContext,
      telemetryState.meter.createCounter,
      telemetryState.meter.createHistogram,
      traceProviderCtor,
      traceProviderShutdown,
      meterProviderCtor,
      meterProviderShutdown,
      diagWarn,
      logShutdown,
      traceExporterCtor,
      metricExporterCtor,
      logExporterCtor,
    ]) {
      mock.mockClear();
    }
    for (const mock of [logEmit, traceExporterExport, metricExporterExport, logExporterExport]) {
      mock.mockReset();
    }
    traceExporterShutdown.mockReset();
    traceExporterShutdown.mockResolvedValue(undefined);
    metricExporterShutdown.mockReset();
    metricExporterShutdown.mockResolvedValue(undefined);
    logExporterShutdown.mockReset();
    logExporterShutdown.mockResolvedValue(undefined);
    exporterForceFlush.mockReset();
    exporterForceFlush.mockResolvedValue(undefined);
    logProcessorCtor.mockClear();
    spanProcessorCtor.mockClear();
    metricReaderCtor.mockClear();
    ownedSdkRuntimeCleanup.mockClear();
    registerOwnedSdkRuntimeMock.mockClear();
    registerOwnedSdkRuntimeMock.mockReturnValue(ownedSdkRuntimeCleanup);
    createNodeProxyAgentMock.mockReset();
    createNodeProxyAgentMock.mockReturnValue(undefined);
    unhandledRejectionHandlerState.reset();
    unhandledRejectionHandlerState.register.mockClear();
  });

  afterEach(async () => {
    await stopStartedOtelServices();
    resetDiagnosticEventsForTest();
    for (const [key, value] of originalOtelEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("records message-flow metrics and spans", async () => {
    await startServiceFixture(["traces", "metrics", "logs"]);

    emitEvent("webhook.received", {
      channel: "telegram",
      updateType: "telegram-post",
    });
    emitEvent("webhook.processed", {
      channel: "telegram",
      updateType: "telegram-post",
      chatId: "chat-should-not-export",
      durationMs: 120,
    });
    emitEvent("message.queued", {
      channel: "telegram",
      source: "telegram",
      queueDepth: 2,
    });
    emitEvent("message.received", {
      channel: "telegram",
      source: "webhook",
    });
    emitEvent("message.dispatch.started", {
      channel: "telegram",
      source: "webhook",
    });
    emitEvent("message.dispatch.completed", {
      channel: "telegram",
      source: "webhook",
      durationMs: 25,
      outcome: "completed",
    });
    emitEvent("message.received", {
      channel: "telegram/custom",
      source: "webhook with secret sk-test",
    });
    emitEvent("message.dispatch.started", {
      channel: "telegram/custom",
      source: "webhook with secret sk-test",
    });
    emitEvent("message.dispatch.completed", {
      channel: "telegram/custom",
      source: "webhook with secret sk-test",
      durationMs: 30,
      outcome: "completed",
      reason: "progress draft / message tool 123",
    });
    emitEvent("message.processed", {
      channel: "telegram",
      chatId: "chat-should-not-export",
      messageId: "message-should-not-export",
      outcome: "completed",
      reason: "progress draft / message tool 123",
      durationMs: 55,
    });
    emitEvent("queue.lane.dequeue", {
      lane: "main",
      queueSize: 3,
      waitMs: 10,
    });
    emitEvent("session.stuck", {
      state: "processing",
      ageMs: 125_000,
      classification: "stale_session_state",
    });
    emitEvent("run.attempt", {
      runId: "run-1",
      attempt: 2,
    });

    expect(telemetryState.counters.get("openclaw.webhook.received")?.add).toHaveBeenCalledWith(1, {
      "openclaw.channel": "telegram",
      "openclaw.webhook": "telegram-post",
    });
    expect(
      telemetryState.histograms.get("openclaw.webhook.duration_ms")?.record,
    ).toHaveBeenCalledWith(120, {
      "openclaw.channel": "telegram",
      "openclaw.webhook": "telegram-post",
    });
    expect(telemetryState.counters.get("openclaw.message.queued")?.add).toHaveBeenCalledWith(1, {
      "openclaw.channel": "telegram",
      "openclaw.source": "telegram",
    });
    expect(telemetryState.histograms.get("openclaw.queue.depth")?.record).toHaveBeenCalledTimes(2);
    expect(telemetryState.histograms.get("openclaw.queue.depth")?.record).toHaveBeenCalledWith(2, {
      "openclaw.channel": "telegram",
      "openclaw.source": "telegram",
    });
    expect(telemetryState.histograms.get("openclaw.queue.depth")?.record).toHaveBeenCalledWith(3, {
      "openclaw.lane": "main",
    });
    expect(telemetryState.counters.get("openclaw.message.processed")?.add).toHaveBeenCalledWith(1, {
      "openclaw.channel": "telegram",
      "openclaw.outcome": "completed",
    });
    expect(telemetryState.counters.get("openclaw.message.received")?.add).toHaveBeenCalledWith(1, {
      "openclaw.channel": "telegram",
      "openclaw.source": "webhook",
    });
    expect(telemetryState.counters.get("openclaw.message.received")?.add).toHaveBeenCalledWith(1, {
      "openclaw.channel": "unknown",
      "openclaw.source": "unknown",
    });
    expect(
      telemetryState.counters.get("openclaw.message.dispatch.started")?.add,
    ).toHaveBeenCalledWith(1, {
      "openclaw.channel": "telegram",
      "openclaw.source": "webhook",
    });
    expect(
      telemetryState.counters.get("openclaw.message.dispatch.started")?.add,
    ).toHaveBeenCalledWith(1, {
      "openclaw.channel": "unknown",
      "openclaw.source": "unknown",
    });
    expect(
      telemetryState.counters.get("openclaw.message.dispatch.completed")?.add,
    ).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        "openclaw.channel": "telegram",
        "openclaw.outcome": "completed",
        "openclaw.source": "webhook",
      }),
    );
    expect(
      telemetryState.counters.get("openclaw.message.dispatch.completed")?.add,
    ).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        "openclaw.channel": "unknown",
        "openclaw.reason": "none",
        "openclaw.source": "unknown",
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.message.dispatch.duration_ms")?.record,
    ).toHaveBeenCalledWith(
      25,
      expect.objectContaining({
        "openclaw.channel": "telegram",
        "openclaw.outcome": "completed",
        "openclaw.source": "webhook",
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.message.dispatch.duration_ms")?.record,
    ).toHaveBeenCalledWith(
      30,
      expect.objectContaining({
        "openclaw.channel": "unknown",
        "openclaw.reason": "none",
        "openclaw.source": "unknown",
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.message.duration_ms")?.record,
    ).toHaveBeenCalledWith(55, {
      "openclaw.channel": "telegram",
      "openclaw.outcome": "completed",
    });
    expect(telemetryState.histograms.get("openclaw.queue.wait_ms")?.record).toHaveBeenCalledWith(
      10,
      {
        "openclaw.lane": "main",
      },
    );
    expect(telemetryState.counters.get("openclaw.session.stuck")?.add).toHaveBeenCalledTimes(1);
    expect(telemetryState.counters.get("openclaw.session.stuck")?.add).toHaveBeenCalledWith(1, {
      "openclaw.state": "processing",
    });
    expect(
      telemetryState.histograms.get("openclaw.session.stuck_age_ms")?.record,
    ).toHaveBeenCalledWith(125_000, {
      "openclaw.state": "processing",
    });
    expect(telemetryState.counters.get("openclaw.run.attempt")?.add).toHaveBeenCalledWith(1, {
      "openclaw.attempt": 2,
    });

    emitEvent("session.turn.created", {
      runId: "run-1",
      agentId: "agent.default",
      channel: "telegram",
      trigger: "user",
    });
    expect(telemetryState.counters.get("openclaw.session.turn.created")?.add).toHaveBeenCalledWith(
      1,
      {
        "openclaw.agent": "agent.default",
        "openclaw.channel": "telegram",
        "openclaw.trigger": "user",
      },
    );

    const spanNames = telemetryState.tracer.startSpan.mock.calls.map((call) => call[0]);
    expect(spanNames).toContain("openclaw.webhook.processed");
    expect(spanNames).toContain("openclaw.message.processed");
    expect(spanNames).toContain("openclaw.session.stuck");
    const webhookSpanOptions = startedSpanOptions("openclaw.webhook.processed");
    expect(webhookSpanOptions?.attributes).not.toHaveProperty("openclaw.chatId");
    expect(webhookSpanOptions?.startTime).toBeTypeOf("number");
    const messageSpanOptions = startedSpanOptions("openclaw.message.processed");
    expect(messageSpanOptions?.attributes).toMatchObject({
      "openclaw.channel": "telegram",
      "openclaw.outcome": "completed",
      "openclaw.reason": "unknown",
    });
    expect(messageSpanOptions?.attributes).not.toHaveProperty("openclaw.chatId");
    expect(messageSpanOptions?.attributes).not.toHaveProperty("openclaw.messageId");
    expect(messageSpanOptions?.startTime).toBeTypeOf("number");

    await emitEventAndFlush("log.record", {
      message: "hello",
      attributes: { subsystem: "diagnostic" },
    });
    expect(logEmit).toHaveBeenCalled();
  });

  test("surfaces bridge cleanup failure after attempting every shutdown phase", async () => {
    const cleanupError = new Error("bridge cleanup failed");
    const unregisterBridge = vi.fn(() => {
      throw cleanupError;
    });
    const cleanupOrder: string[] = [];
    logShutdown.mockImplementationOnce(async () => {
      cleanupOrder.push("log-provider");
    });
    traceProviderShutdown.mockImplementationOnce(async () => {
      cleanupOrder.push("trace-provider");
    });
    meterProviderShutdown.mockImplementationOnce(async () => {
      cleanupOrder.push("meter-provider");
    });
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, {
      traces: true,
      metrics: true,
      logs: true,
    });
    const onEvent = ctx.internalDiagnostics!.onEvent;
    ctx.internalDiagnostics = {
      ...ctx.internalDiagnostics!,
      onEvent: (listener) => {
        const unsubscribe = onEvent(listener);
        return () => {
          cleanupOrder.push("listener");
          unsubscribe();
        };
      },
      registerTracePropagationBridge: () => () => {
        cleanupOrder.push("bridge");
        unregisterBridge();
      },
    };
    await service.start(ctx);
    emitTrustedEvent("run.started");
    const runSpan = spanByName("openclaw.run");

    const stopError = await Promise.resolve(service.stop?.(ctx)).catch((error: unknown) => error);

    expect(stopError).toBe(cleanupError);
    expect(unregisterBridge).toHaveBeenCalledOnce();
    expect(runSpan.end).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
    expect(traceProviderShutdown).toHaveBeenCalledOnce();
    expect(meterProviderShutdown).toHaveBeenCalledOnce();
    expect(unhandledRejectionHandlerState.getHandlers()).toEqual([]);
    expect(cleanupOrder.indexOf("bridge")).toBeLessThan(cleanupOrder.indexOf("log-provider"));
    expect(cleanupOrder.indexOf("listener")).toBeLessThan(cleanupOrder.indexOf("trace-provider"));
  });

  test("attempts every provider shutdown and reports every failure", async () => {
    const logError = new Error("log provider failed");
    const traceError = new Error("trace provider failed");
    const meterError = new Error("meter provider failed");
    logShutdown.mockRejectedValueOnce(logError);
    traceProviderShutdown.mockRejectedValueOnce(traceError);
    meterProviderShutdown.mockRejectedValueOnce(meterError);
    const { service, ctx } = await startServiceFixture(["traces", "metrics", "logs"]);

    const stopError = await Promise.resolve(service.stop?.(ctx)).catch((error: unknown) => error);

    expect(logShutdown).toHaveBeenCalledTimes(1);
    expect(traceProviderShutdown).toHaveBeenCalledTimes(1);
    expect(meterProviderShutdown).toHaveBeenCalledTimes(1);
    expect(stopError).toBeInstanceOf(AggregateError);
    expect(stopError).toMatchObject({
      errors: [logError, traceError, meterError],
      message: expect.stringContaining("log provider failed"),
    });
    expect(stopError).toMatchObject({
      message: expect.stringContaining("trace provider failed"),
    });
    expect(stopError).toMatchObject({
      message: expect.stringContaining("meter provider failed"),
    });
  });

  test("retires an exporter failure retained after shutdown rejects", async () => {
    const { events, unsubscribe } = captureExporterEvents();
    const { service, ctx } = await startServiceFixture(["traces"]);
    traceExporterShutdown.mockRejectedValueOnce(new TypeError("private shutdown details"));
    traceProviderShutdown.mockImplementationOnce(async () => {
      // Emulate the real provider shutdown chain: the exporter health wrapper
      // observes the failing exporter shutdown before the provider failure is
      // reported, so the shutdown_failed route is retained, not dropped.
      const exporter = spanProcessorCtor.mock.calls.at(-1)?.[0] as
        | { shutdown(): Promise<void> }
        | undefined;
      if (!exporter) {
        throw new Error("expected trace exporter");
      }
      await exporter.shutdown();
    });

    await expect(service.stop?.(ctx)).rejects.toThrow("private shutdown details");
    await waitForDiagnosticEventsDrained();
    expect(events.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: "started", reason: "configured" },
      { status: "failure", reason: "shutdown_failed" },
    ]);
    expect(
      getReportedExporterHealth(ctx).map(({ transport, status, reason }) => ({
        transport,
        status,
        reason,
      })),
    ).toEqual([
      {
        transport: "otlp-http-protobuf",
        status: "started",
        reason: "configured",
      },
      {
        transport: "otlp-http-protobuf",
        status: "failure",
        reason: "shutdown_failed",
      },
    ]);

    await expect(service.stop?.(ctx)).resolves.toBeUndefined();
    await waitForDiagnosticEventsDrained();
    expect(events.at(-1)).toMatchObject({ status: "dropped" });
    expect(getReportedExporterHealth(ctx).at(-1)).toMatchObject({
      transport: "otlp-http-protobuf",
      status: "dropped",
    });
    expect(JSON.stringify({ events, health: getReportedExporterHealth(ctx) })).not.toContain(
      "private shutdown details",
    );
    unsubscribe();
  });

  test("preserves SDK startup failure through host rollback when shutdown also fails", async () => {
    const { events, unsubscribe } = captureExporterEvents();
    const startupError = new Error("SDK startup failed");
    const rollbackError = new Error("SDK rollback failed");
    traceProviderCtor.mockImplementationOnce(() => {
      throw startupError;
    });
    meterProviderShutdown.mockRejectedValueOnce(rollbackError);
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });

    const startError = await Promise.resolve(service.start(ctx)).catch((error: unknown) => error);

    expect(startError).toBeInstanceOf(AggregateError);
    expect(startError).toMatchObject({
      message: "diagnostics-otel startup failed and rollback cleanup failed",
      cause: startupError,
      errors: [startupError, rollbackError],
    });
    expect(ctx.logger.error).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("diagnostics-otel: failed to start SDK: Error: SDK startup failed"),
    );
    expect(ctx.logger.error).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "diagnostics-otel: SDK startup rollback cleanup failed: Error: SDK rollback failed",
      ),
    );
    expect(meterProviderShutdown).toHaveBeenCalledOnce();
    await waitForDiagnosticEventsDrained();
    expect(events.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: "failure", reason: "start_failed" },
      { status: "failure", reason: "start_failed" },
    ]);
    expect(
      getReportedExporterHealth(ctx).map(({ signal, transport, endpointMode, status, reason }) => ({
        signal,
        transport,
        endpointMode,
        status,
        reason,
      })),
    ).toEqual([
      {
        signal: "traces",
        transport: "otlp-http-protobuf",
        endpointMode: "configured",
        status: "failure",
        reason: "start_failed",
      },
      {
        signal: "metrics",
        transport: "otlp-http-protobuf",
        endpointMode: "configured",
        status: "failure",
        reason: "start_failed",
      },
    ]);
    await expect(service.stop?.(ctx)).resolves.toBeUndefined();
    await waitForDiagnosticEventsDrained();
    expect(events.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: "failure", reason: "start_failed" },
      { status: "failure", reason: "start_failed" },
    ]);
    expect(getReportedExporterHealth(ctx).at(-1)).toMatchObject({
      transport: "otlp-http-protobuf",
      status: "failure",
      reason: "start_failed",
    });

    await expect(service.stop?.(ctx)).resolves.toBeUndefined();
    await waitForDiagnosticEventsDrained();
    expect(events.at(-1)).toMatchObject({ status: "dropped" });
    expect(getReportedExporterHealth(ctx).at(-1)).toMatchObject({
      transport: "otlp-http-protobuf",
      status: "dropped",
    });
    unsubscribe();
  });

  test("records dependency-default endpoint ownership when SDK startup fails", async () => {
    const { events, unsubscribe } = captureExporterEvents();
    traceProviderCtor.mockImplementationOnce(() => {
      throw new TypeError("private startup details");
    });
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext("", { traces: true, metrics: false, logs: false });
    delete ctx.config.diagnostics?.otel?.endpoint;
    await expect(service.start(ctx)).rejects.toThrow("private startup details");
    await waitForDiagnosticEventsDrained();
    expect(events.map(({ signal, status, reason }) => [signal, status, reason])).toEqual([
      ["traces", "failure", "start_failed"],
    ]);
    expect(
      getReportedExporterHealth(ctx).map(({ signal, transport, endpointMode, status, reason }) => [
        signal,
        transport,
        endpointMode,
        status,
        reason,
      ]),
    ).toEqual([["traces", "otlp-http-protobuf", "default_endpoint", "failure", "start_failed"]]);
    for (const privateText of [OTEL_TEST_ENDPOINT, "private startup details"]) {
      expect(JSON.stringify({ events, health: getReportedExporterHealth(ctx) })).not.toContain(
        privateText,
      );
    }
    await service.stop?.(ctx);
    await service.stop?.(ctx);
    unsubscribe();
  });

  test("registers and removes an OTLP exporter unhandled rejection handler", async () => {
    const { service, ctx } = await startServiceFixture(["traces", "metrics", "logs"]);

    expect(unhandledRejectionHandlerState.register).toHaveBeenCalledTimes(1);
    const handler = unhandledRejectionHandlerState.getHandlers()[0];
    expect(handler).toBeTypeOf("function");

    const errorInstance = Object.assign(new Error("collector gone"), {
      name: "OTLPExporterError",
      code: 410,
    });
    expect(handler?.(errorInstance)).toBe(true);
    expect(handler?.({ name: "OTLPExporterError", code: 410, data: "user_stop" })).toBe(true);
    expect(handler?.([{ name: "OTLPExporterError", code: 410, data: "user_stop" }])).toBe(true);
    expect(
      handler?.(
        new AggregateError(
          [{ name: "OTLPExporterError", code: 410, data: "user_stop" }],
          "export failed",
        ),
      ),
    ).toBe(true);
    expect(handler?.(new Error("other exporter error"))).toBe(false);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "diagnostics-otel: suppressed OTLP exporter unhandled rejection (code=410)",
    );

    await service.stop?.(ctx);
    expect(unhandledRejectionHandlerState.getHandlers()).toHaveLength(0);
  });

  test("cleans up existing providers and does not reinitialize without capability", async () => {
    const service = createDiagnosticsOtelService();
    const enabledCtx = createOtelContext(OTEL_TEST_ENDPOINT, {
      traces: true,
      metrics: true,
      logs: true,
    });
    await service.start(enabledCtx);

    traceProviderCtor.mockClear();
    meterProviderCtor.mockClear();
    logExporterCtor.mockClear();
    const deniedCtx = createOtelContext(OTEL_TEST_ENDPOINT, {
      traces: true,
      metrics: true,
      logs: true,
    });
    delete deniedCtx.internalDiagnostics;

    await service.start(deniedCtx);
    await service.stop?.(deniedCtx);

    expect(deniedCtx.logger.error).toHaveBeenCalledWith(
      "diagnostics-otel: internal diagnostics capability unavailable",
    );
    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();
    expect(logExporterCtor).not.toHaveBeenCalled();
    expect(traceProviderShutdown).toHaveBeenCalledOnce();
    expect(meterProviderShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
  });

  test("warns through the plugin logger and keeps the SDK enabled for an invalid value", async () => {
    process.env.OTEL_SDK_DISABLED = "invalid";

    const { service, ctx } = await startServiceFixture(["traces", "metrics", "logs"]);

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "diagnostics-otel: invalid OTEL_SDK_DISABLED value; expected true or false, using false",
    );
    expect(traceProviderCtor).toHaveBeenCalledOnce();
    expect(meterProviderCtor).toHaveBeenCalledOnce();
    expect(traceExporterCtor).toHaveBeenCalledOnce();
    expect(metricExporterCtor).toHaveBeenCalledOnce();
    expect(logExporterCtor).toHaveBeenCalledOnce();
    expect(registerOwnedSdkRuntimeMock).toHaveBeenCalledOnce();

    await service.stop?.(ctx);
  });

  test("skips malformed endpoint, protocol, and TLS settings while disabled", async () => {
    const { events, unsubscribe } = captureExporterEvents();
    process.env.OTEL_SDK_DISABLED = "true";
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = "/definitely-missing/otel-root.pem";
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext("not a collector URL", {
      traces: true,
      metrics: true,
      logs: true,
      logsExporter: "both",
    });

    await expect(service.start(ctx)).resolves.toBeUndefined();
    await waitForDiagnosticEventsDrained();

    expect(events).toEqual([]);
    expect(getReportedExporterHealth(ctx)).toEqual([]);
    expect(traceExporterCtor).not.toHaveBeenCalled();
    expect(metricExporterCtor).not.toHaveBeenCalled();
    expect(logExporterCtor).not.toHaveBeenCalled();
    expect(createNodeProxyAgentMock).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    await service.stop?.(ctx);
    unsubscribe();
  });

  test("preserves preloaded trace and metric ownership while disabling plugin logs", async () => {
    const { events, unsubscribe } = captureExporterEvents();
    process.env.OPENCLAW_OTEL_PRELOADED = "1";
    process.env.OTEL_SDK_DISABLED = "true";

    const { service, ctx } = await startServiceFixture(["traces", "metrics", "logs"], {
      logsExporter: "both",
    });
    emitEvent("run.completed", {}, ["trace"]);
    await emitEventAndFlush("log.record", {
      message: "disabled preloaded log",
    });
    await waitForDiagnosticEventsDrained();

    expect(events.map(({ signal, status }) => ({ signal, status }))).toEqual([
      { signal: "traces", status: "started" },
      { signal: "metrics", status: "started" },
    ]);
    expect(
      getReportedExporterHealth(ctx).map(({ signal, transport, status }) => ({
        signal,
        transport,
        status,
      })),
    ).toEqual([
      {
        signal: "traces",
        transport: "external-sdk",
        status: "started",
      },
      {
        signal: "metrics",
        transport: "external-sdk",
        status: "started",
      },
    ]);
    expect(traceExporterCtor).not.toHaveBeenCalled();
    expect(metricExporterCtor).not.toHaveBeenCalled();
    expect(logExporterCtor).not.toHaveBeenCalled();
    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();
    expect(unhandledRejectionHandlerState.register).not.toHaveBeenCalled();
    expect(lastHistogramRecord("openclaw.run.duration_ms")?.[0]).toBe(100);
    expect(startedSpanOptions("openclaw.run")?.attributes?.["openclaw.outcome"]).toBe("completed");
    expect(logEmit).not.toHaveBeenCalled();
    expect(registerOwnedSdkRuntimeMock).not.toHaveBeenCalled();
    await service.stop?.(ctx);
    unsubscribe();
  });

  test("retires unsupported OTLP failures on disabled restart and stop", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true });
    delete ctx.config.diagnostics!.otel!.protocol;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";

    try {
      await service.start(ctx);
      ctx.config.diagnostics!.enabled = false;
      await service.start(ctx);
      ctx.config.diagnostics!.enabled = true;
      await service.start(ctx);
      await service.stop?.(ctx);
      await waitForDiagnosticEventsDrained();

      expect(
        getReportedExporterHealth(ctx).map(({ transport, status, reason }) => ({
          transport,
          status,
          reason,
        })),
      ).toEqual([
        {
          transport: "otlp-http-protobuf",
          status: "failure",
          reason: "unsupported_protocol",
        },
        { transport: "otlp-http-protobuf", status: "dropped", reason: undefined },
        {
          transport: "otlp-http-protobuf",
          status: "failure",
          reason: "unsupported_protocol",
        },
        { transport: "otlp-http-protobuf", status: "dropped", reason: undefined },
      ]);
    } finally {
      await service.stop?.(ctx);
    }
  });

  test("rebuilds the current log route set while preserving logs both", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, {
      logs: true,
      logsExporter: "both",
    });

    try {
      await service.start(ctx);
      ctx.config.diagnostics!.otel!.logsExporter = "stdout";
      await service.start(ctx);
      ctx.config.diagnostics!.otel!.logsExporter = "both";
      await service.start(ctx);
      await waitForDiagnosticEventsDrained();

      expect(
        getReportedExporterHealth(ctx).map(({ transport, status }) => ({
          transport,
          status,
        })),
      ).toEqual([
        { transport: "otlp-http-protobuf", status: "started" },
        { transport: "stdout", status: "started" },
        { transport: "otlp-http-protobuf", status: "dropped" },
        { transport: "stdout", status: "dropped" },
        { transport: "stdout", status: "started" },
        { transport: "stdout", status: "dropped" },
        { transport: "otlp-http-protobuf", status: "started" },
        { transport: "stdout", status: "started" },
      ]);
    } finally {
      await service.stop?.(ctx);
    }
  });

  test.each(["otlp", "stdout"] as const)(
    "exports bounded trusted security logs over %s",
    async (logsExporter) => {
      await startServiceFixture(["logs"], {
        logsExporter,
        ...(logsExporter === "stdout" ? { endpoint: "" } : {}),
      });
      const stdout = logsExporter === "stdout" ? captureStdoutWrites() : undefined;
      try {
        const trace = createDiagnosticTraceContext(createTestTrace(SPAN_ID));

        emitTrustedSecurityEvent({
          eventId: logsExporter === "stdout" ? "security-event-stdout" : "security-event-1",
          category: "tool",
          action: "tool.execution.blocked",
          outcome: "denied",
          severity: "medium",
          reason: "tools.deny",
          ...(logsExporter === "otlp"
            ? {
                actor: {
                  kind: "agent",
                  idHash: "agent-hash-1",
                  role: "operator",
                  scopes: ["operator.read", "operator.approvals"],
                },
                target: {
                  kind: "plugin",
                  name: "@acme/security-event-plugin",
                  owner: "plugin-installer",
                },
                policy: {
                  id: "tools.exec",
                  decision: "deny",
                  reason: "allowlist.miss",
                },
                control: {
                  id: "exec-approval",
                  family: "approval",
                },
              }
            : {}),
          attributes: {
            ...(logsExporter === "otlp" ? { params_kind: "object" } : {}),
            secretish: "token sk-test-secret",
            [PROTO_KEY]: "blocked",
          },
          trace,
        });
        await flushDiagnosticEvents();

        const emitCall = stdout
          ? parseSingleStdoutDiagnosticLogLine(stdout.writes)
          : (mockCallArg(logEmit, 0) as {
              attributes?: Record<string, unknown>;
              body?: string;
              context?: unknown;
              severityNumber?: number;
              severityText?: string;
            });
        expect(emitCall.body).toBe("openclaw.security.event");
        expect(emitCall.severityText).toBe("WARN");
        expect(emitCall.severityNumber).toBe(13);
        expect(emitCall.attributes).toMatchObject({
          "openclaw.security.event_id":
            logsExporter === "stdout" ? "security-event-stdout" : "security-event-1",
          "openclaw.security.category": "tool",
          "openclaw.security.action": "tool.execution.blocked",
          "openclaw.security.outcome": "denied",
          "openclaw.security.severity": "medium",
          "openclaw.security.reason": "tools.deny",
          ...(logsExporter === "otlp"
            ? {
                "openclaw.security.actor.kind": "agent",
                "openclaw.security.actor.id_hash": "agent-hash-1",
                "openclaw.security.actor.role": "operator",
                "openclaw.security.actor.scopes": "operator.read,operator.approvals",
                "openclaw.security.target.kind": "plugin",
                "openclaw.security.target.name": "@acme/security-event-plugin",
                "openclaw.security.target.owner": "plugin-installer",
                "openclaw.security.policy.id": "tools.exec",
                "openclaw.security.policy.decision": "deny",
                "openclaw.security.policy.reason": "allowlist.miss",
                "openclaw.security.control.id": "exec-approval",
                "openclaw.security.control.family": "approval",
                "openclaw.security.attribute.params_kind": "object",
              }
            : {}),
          "openclaw.security.attribute.secretish": "unknown",
        });
        if (stdout) {
          expect(logExporterCtor).not.toHaveBeenCalled();
          expect(logEmit).not.toHaveBeenCalled();
          expect(emitCall).toMatchObject({
            trace_id: TRACE_ID,
            span_id: SPAN_ID,
            trace_flags: "01",
          });
        } else {
          expect("context" in emitCall ? emitCall.context : undefined).toEqual({
            spanContext: { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1, isRemote: true },
          });
        }
        expectAbsent(emitCall.attributes, "openclaw.security.attribute.__proto__");
        expect(JSON.stringify(emitCall)).not.toContain("sk-test-secret");
      } finally {
        stdout?.spy.mockRestore();
      }
    },
  );

  test("keeps stdout logs active when the OTLP branch of both is unsupported", async () => {
    const { events, unsubscribe } = captureExporterEvents();
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "grpc";
    const capture = captureStdoutWrites();

    try {
      const { ctx } = await startServiceFixture(["logs"], {
        logsExporter: "both",
        configure: omitConfiguredProtocol,
      });
      emitEvent("log.record", {
        message: "stdout fallback log",
      });
      await flushDiagnosticEvents();

      expect(logExporterCtor).not.toHaveBeenCalled();
      expect(parseSingleStdoutDiagnosticLogLine(capture.writes).body).toBe("log");
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        "diagnostics-otel: unsupported logs protocol grpc; OTLP export disabled",
      );
      expect(ctx.logger.info).toHaveBeenCalledWith(
        "diagnostics-otel: logs exporter enabled (stdout JSONL)",
      );
      expect(
        events.map((event) => ({
          signal: event.signal,
          status: event.status,
          reason: event.reason,
        })),
      ).toEqual([
        { signal: "logs", status: "failure", reason: "unsupported_protocol" },
        { signal: "logs", status: "started", reason: "configured" },
      ]);
    } finally {
      capture.spy.mockRestore();
      unsubscribe();
    }
  });

  test("ignores blank OTLP protocol env overrides", async () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "   ";
    const { ctx } = await startServiceFixture(["traces", "metrics"], omitConfiguredProtocol);
    expect(traceExporterCtor).toHaveBeenCalledTimes(1);
    expect(metricExporterCtor).toHaveBeenCalledTimes(1);
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });

  const payloadAttributes = {
    "openclaw.payload.action": "rejected",
    "openclaw.payload.surface": "gateway.frame",
    "openclaw.channel": "web",
    "openclaw.plugin": "none",
    "openclaw.reason": "body-too-large",
  };

  const skillAttributes = {
    "openclaw.agent": "main",
    "openclaw.skill.activation": "read",
    "openclaw.skill.name": "tiny-llm-brainstorm",
    "openclaw.skill.source": "workspace",
    "openclaw.toolName": "read",
  };

  const loopAttributes = {
    "openclaw.toolName": "process",
    "openclaw.loop.level": "critical",
    "openclaw.loop.action": "block",
    "openclaw.loop.detector": "known_poll_no_progress",
    "openclaw.loop.count": 20,
    "openclaw.loop.paired_tool": "read",
  };

  const audioAttributes = {
    "openclaw.talk.brain": "agent-consult",
    "openclaw.talk.event_type": "input.audio.delta",
    "openclaw.talk.mode": "realtime",
    "openclaw.talk.provider": "openai",
    "openclaw.talk.transport": "gateway-relay",
  };

  test.each<RecorderCase>([
    {
      name: "liveness warning",
      signals: ["traces", "metrics"],
      events: [
        {
          type: "diagnostic.liveness.warning",
          reasons: ["event_loop_delay", "cpu"],
          intervalMs: 30_000,
          eventLoopDelayP99Ms: 250,
          eventLoopDelayMaxMs: 900,
          eventLoopUtilization: 0.95,
          cpuUserMs: 1200,
          cpuSystemMs: 300,
          cpuTotalMs: 1500,
          cpuCoreRatio: 1.4,
          active: 2,
          waiting: 1,
          queued: 4,
        },
      ],
      metrics: [
        [
          "counter",
          "openclaw.liveness.warning",
          [[1, { "openclaw.liveness.reason": "event_loop_delay:cpu" }]],
        ],
        [
          "histogram",
          "openclaw.liveness.event_loop_delay_p99_ms",
          [[250, { "openclaw.liveness.reason": "event_loop_delay:cpu" }]],
        ],
        [
          "histogram",
          "openclaw.liveness.cpu_core_ratio",
          [[1.4, { "openclaw.liveness.reason": "event_loop_delay:cpu" }]],
        ],
      ],
      span: {
        name: "openclaw.liveness.warning",
        attributes: {
          "openclaw.liveness.reason": "event_loop_delay:cpu",
          "openclaw.liveness.active": 2,
          "openclaw.liveness.queued": 4,
        },
        status: { code: 2, message: "event_loop_delay:cpu" },
      },
    },
    {
      name: "oversized payload",
      signals: ["metrics"],
      trusted: true,
      events: [
        {
          type: "payload.large",
          surface: "gateway.frame",
          action: "rejected",
          bytes: 2048,
          limitBytes: 1024,
          channel: "web",
          pluginId: "agent:qa:otel-trace-smoke",
          reason: "body-too-large",
        },
      ],
      metrics: [
        ["counter", "openclaw.payload.large", [[1, payloadAttributes]]],
        ["histogram", "openclaw.payload.large_bytes", [[2048, payloadAttributes]]],
      ],
    },
    {
      name: "hook-blocked run",
      signals: ["traces", "metrics"],
      events: [
        {
          type: "run.completed",
          ...RUN_FIXTURE,
          outcome: "blocked",
          blockedBy: "policy-plugin",
          durationMs: 100,
        },
      ],
      metrics: [
        [
          "histogram",
          "openclaw.run.duration_ms",
          [
            [
              100,
              expect.objectContaining({
                "openclaw.outcome": "blocked",
                "openclaw.blocked_by": "policy-plugin",
              }),
            ],
          ],
          "last",
        ],
      ],
      stateOmits: ["matched secret prompt"],
    },
    {
      name: "skill usage",
      signals: ["traces", "metrics"],
      trusted: true,
      events: [
        {
          type: "skill.used",
          agentId: "main",
          runId: "run-should-not-export",
          sessionKey: "session-should-not-export",
          skillName: "tiny-llm-brainstorm",
          skillSource: "workspace",
          activation: "read",
          toolName: "read",
          trace: createTestTrace(TOOL_SPAN_ID, CHILD_SPAN_ID),
        },
      ],
      metrics: [["counter", "openclaw.skill.used", [[1, skillAttributes]]]],
      span: {
        name: "openclaw.skill.used",
        attributes: skillAttributes,
        omittedText: ["run-should-not-export", "session-should-not-export"],
      },
    },
    {
      name: "tool loop",
      signals: ["traces", "metrics"],
      events: [
        {
          type: "tool.loop",
          sessionKey: "session-key",
          sessionId: "session-id",
          toolName: "process",
          level: "critical",
          action: "block",
          detector: "known_poll_no_progress",
          count: 20,
          message: "CRITICAL: repeated secret-bearing tool output",
          pairedToolName: "read",
        },
      ],
      metrics: [["counter", "openclaw.tool.loop", [[1, loopAttributes]]]],
      span: {
        name: "openclaw.tool.loop",
        attributes: loopAttributes,
        status: { code: 2, message: "known_poll_no_progress:block" },
        omittedText: ["session-key", "secret-bearing"],
      },
    },
    {
      name: "memory pressure",
      signals: ["traces", "metrics"],
      events: [
        {
          type: "diagnostic.memory.sample",
          uptimeMs: 1234,
          memory: {
            rssBytes: 100,
            heapUsedBytes: 40,
            heapTotalBytes: 80,
            externalBytes: 10,
            arrayBuffersBytes: 5,
          },
        },
        {
          type: "diagnostic.memory.pressure",
          level: "critical",
          reason: "rss_growth",
          thresholdBytes: 512,
          rssGrowthBytes: 256,
          windowMs: 60_000,
          memory: {
            rssBytes: 200,
            heapUsedBytes: 50,
            heapTotalBytes: 90,
            externalBytes: 20,
            arrayBuffersBytes: 6,
          },
        },
      ],
      metrics: [
        [
          "histogram",
          "openclaw.memory.rss_bytes",
          [
            [100, {}],
            [200, { "openclaw.memory.level": "critical", "openclaw.memory.reason": "rss_growth" }],
          ],
        ],
        [
          "counter",
          "openclaw.memory.pressure",
          [[1, { "openclaw.memory.level": "critical", "openclaw.memory.reason": "rss_growth" }]],
        ],
      ],
      span: {
        name: "openclaw.memory.pressure",
        attributes: {
          "openclaw.memory.level": "critical",
          "openclaw.memory.reason": "rss_growth",
          "openclaw.memory.rss_bytes": 200,
          "openclaw.memory.heap_used_bytes": 50,
          "openclaw.memory.heap_total_bytes": 90,
          "openclaw.memory.external_bytes": 20,
          "openclaw.memory.array_buffers_bytes": 6,
          "openclaw.memory.threshold_bytes": 512,
          "openclaw.memory.rss_growth_bytes": 256,
          "openclaw.memory.window_ms": 60_000,
        },
        status: { code: 2, message: "rss_growth" },
        omittedText: ["session"],
      },
    },
    {
      name: "async queue drop summary",
      signals: ["metrics"],
      events: [
        {
          type: "diagnostic.async_queue.dropped",
          droppedEvents: 4,
          droppedTrustedEvents: 1,
          droppedUntrustedEvents: 2,
          droppedPriorityEvents: 1,
          queueLength: 0,
          maxQueueLength: 10_000,
          drainBatchSize: 100,
        },
      ],
      metrics: [
        [
          "counter",
          "openclaw.diagnostic.async_queue.dropped",
          [
            [4, { "openclaw.diagnostic.async_queue.drop_class": "total" }],
            [1, { "openclaw.diagnostic.async_queue.drop_class": "trusted" }],
            [2, { "openclaw.diagnostic.async_queue.drop_class": "untrusted" }],
            [1, { "openclaw.diagnostic.async_queue.drop_class": "priority" }],
          ],
        ],
      ],
    },
    {
      name: "session recovery and talk",
      signals: ["metrics"],
      trusted: true,
      events: [
        {
          type: "session.recovery.requested",
          sessionId: "session-should-not-export",
          sessionKey: "key-should-not-export",
          state: "processing",
          ageMs: 12_000,
          reason: "startup-sweep",
          activeWorkKind: "tool_call",
          allowActiveAbort: true,
        },
        {
          type: "session.recovery.completed",
          sessionId: "session-should-not-export",
          sessionKey: "key-should-not-export",
          state: "processing",
          ageMs: 13_000,
          reason: "startup-sweep",
          activeWorkKind: "tool_call",
          status: "released",
          action: "abort-active-run",
        },
        {
          type: "talk.event",
          sessionId: "talk-session-should-not-export",
          turnId: "turn-should-not-export",
          talkEventType: "input.audio.delta",
          mode: "realtime",
          transport: "gateway-relay",
          brain: "agent-consult",
          provider: "openai",
          byteLength: 320,
        },
        {
          type: "talk.event",
          sessionId: "talk-session-should-not-export",
          talkEventType: "latency.metrics",
          mode: "realtime",
          transport: "gateway-relay",
          brain: "agent-consult",
          provider: "openai",
          durationMs: 45,
        },
      ],
      metrics: [
        [
          "counter",
          "openclaw.session.recovery.requested",
          [
            [
              1,
              expect.objectContaining({
                "openclaw.state": "processing",
                "openclaw.action": "abort",
                "openclaw.active_work_kind": "tool_call",
              }),
            ],
          ],
          "first",
        ],
        [
          "counter",
          "openclaw.session.recovery.completed",
          [
            [
              1,
              expect.objectContaining({
                "openclaw.state": "processing",
                "openclaw.status": "released",
                "openclaw.action": "abort-active-run",
              }),
            ],
          ],
          "first",
        ],
        [
          "histogram",
          "openclaw.session.recovery.age_ms",
          [[13_000, expect.objectContaining({ "openclaw.status": "released" })]],
          "last",
        ],
        [
          "counter",
          "openclaw.talk.event",
          [[1, audioAttributes]],
          undefined,
          ["talk-session-should-not-export", "turn-should-not-export"],
        ],
        ["histogram", "openclaw.talk.audio.bytes", [[320, audioAttributes]]],
        [
          "histogram",
          "openclaw.talk.event.duration_ms",
          [
            [
              45,
              {
                "openclaw.talk.brain": "agent-consult",
                "openclaw.talk.event_type": "latency.metrics",
                "openclaw.talk.mode": "realtime",
                "openclaw.talk.provider": "openai",
                "openclaw.talk.transport": "gateway-relay",
              },
            ],
          ],
        ],
      ],
    },
    {
      name: "session state redaction",
      signals: ["metrics"],
      events: [
        {
          type: "session.state",
          state: "waiting",
          reason: "token=ghp_abcdefghijklmnopqrstuvwxyz123456",
        },
      ], // pragma: allowlist secret
      metrics: [
        [
          "counter",
          "openclaw.session.state",
          [[1, expect.objectContaining({ "openclaw.reason": expect.stringContaining("…") })]],
          "first",
          ["ghp_abcdefghijklmnopqrstuvwxyz123456"],
        ],
      ], // pragma: allowlist secret
    },
    {
      name: "session-shaped queue lane",
      signals: ["metrics"],
      events: [
        { type: "queue.lane.enqueue", lane: "session:Agent:qa:otel-trace-smoke", queueSize: 2 },
      ],
      metrics: [
        [
          "counter",
          "openclaw.queue.lane.enqueue",
          [[1, { "openclaw.lane": "session" }]],
          undefined,
          ["Agent:qa:otel-trace-smoke"],
        ],
      ],
    },
  ])(
    "records bounded $name metrics and spans",
    async ({ signals, trusted, events, metrics, span, stateOmits }) => {
      await startServiceFixture(signals);
      for (const event of events) {
        (trusted ? emitTrustedDiagnosticEvent : emitDiagnosticEvent)(event);
      }
      await flushDiagnosticEvents();
      for (const [kind, name, calls, position, omittedText] of metrics) {
        const record =
          kind === "counter"
            ? telemetryState.counters.get(name)?.add
            : telemetryState.histograms.get(name)?.record;
        for (const args of calls) {
          if (position) {
            expect(record?.mock.calls.at(position === "first" ? 0 : -1)).toEqual(args);
          } else {
            expect(record).toHaveBeenCalledWith(...args);
          }
        }
        for (const text of omittedText ?? []) {
          expect(JSON.stringify(record?.mock.calls)).not.toContain(text);
        }
      }
      if (span) {
        expect(startedSpanOptions(span.name)?.attributes).toMatchObject(span.attributes);
        if (span.status) {
          expect(spanByName(span.name).setStatus).toHaveBeenCalledWith(span.status);
        }
        for (const text of span.omittedText ?? []) {
          expect(JSON.stringify(startedSpanCall(span.name))).not.toContain(text);
        }
      }
      for (const text of stateOmits ?? []) {
        expect(JSON.stringify(telemetryState)).not.toContain(text);
      }
    },
  );

  test.each(["otlp", "stdout"] as const)(
    "recovers bounded %s emit health after repeated failures",
    async (logsExporter) => {
      const { events, unsubscribe } = captureExporterEvents();
      const stdout = logsExporter === "stdout" ? captureStdoutWrites() : undefined;
      if (stdout) {
        const failWrite = (() => {
          throw new TypeError("private stdout failure");
        }) as typeof process.stdout.write;
        stdout.spy.mockImplementationOnce(failWrite).mockImplementationOnce(failWrite);
      } else {
        logEmit
          .mockImplementationOnce(() => {
            throw new TypeError("token sk-test-secret should not leave as telemetry");
          })
          .mockImplementationOnce(() => {
            throw new TypeError("repeated private failure");
          });
      }
      try {
        const { ctx } = await startServiceFixture(stdout ? ["logs"] : ["metrics", "logs"], {
          logsExporter,
        });
        for (const message of ["first failure", "second failure", "recovery"]) {
          await emitEventAndFlush("log.record", { message });
        }
        const transport = stdout ? "stdout" : "otlp-http-protobuf";
        const health = getReportedExporterHealth(ctx).filter(
          (event) => event.transport === transport && event.reason === "emit_failed",
        );
        if (stdout) {
          expect(health.map(({ status, errorCategory }) => ({ status, errorCategory }))).toEqual([
            { status: "failure", errorCategory: "TypeError" },
            { status: "recovered", errorCategory: undefined },
          ]);
          expect(events.map((event) => event.status)).not.toContain("recovered");
          expect(stdout.writes).toHaveLength(1);
          expect(JSON.stringify({ events, health: getReportedExporterHealth(ctx) })).not.toContain(
            "private stdout failure",
          );
        } else {
          expect(events.find((event) => event.status === "failure")).toMatchObject({
            type: "telemetry.exporter",
            exporter: "diagnostics-otel",
            signal: "logs",
            status: "failure",
            reason: "emit_failed",
            errorCategory: "TypeError",
          });
          expect(
            telemetryState.counters.get("openclaw.telemetry.exporter.events")?.add,
          ).toHaveBeenCalledWith(1, {
            "openclaw.exporter": "diagnostics-otel",
            "openclaw.signal": "logs",
            "openclaw.status": "failure",
            "openclaw.reason": "emit_failed",
            "openclaw.errorCategory": "TypeError",
          });
          expect(
            events.filter((event) => event.reason === "emit_failed").map((event) => event.status),
          ).toEqual(["failure"]);
          expect(health.map((event) => event.status)).toEqual(["failure", "recovered"]);
          expect(JSON.stringify({ events, health: getReportedExporterHealth(ctx) })).not.toContain(
            "sk-test-secret",
          );
        }
      } finally {
        stdout?.spy.mockRestore();
        unsubscribe();
      }
    },
  );

  test("does not recover log OTLP health while an export failure remains active", async () => {
    const { events, unsubscribe } = captureExporterEvents();
    let completeExport: ((result: ExportResult) => void) | undefined;
    logExporterExport.mockImplementation(
      (_items: unknown, callback: (result: ExportResult) => void) => {
        completeExport = callback;
      },
    );
    logEmit
      .mockImplementationOnce(() => {
        throw new TypeError("private enqueue failure");
      })
      .mockImplementationOnce(() => {});
    const { ctx } = await startServiceFixture(["logs"]);
    const exporter = firstLogProcessorOptions().exporter as
      | {
          export(items: unknown, callback: (result: ExportResult) => void): void;
        }
      | undefined;
    if (!exporter) {
      throw new Error("expected log exporter");
    }

    exporter.export([], vi.fn());
    completeExport?.({
      code: ExportResultCode.FAILED,
      error: new Error("private collector failure"),
    });
    await emitAndFlush({ type: "log.record", level: "INFO", message: "enqueue failure" });
    await emitAndFlush({ type: "log.record", level: "INFO", message: "enqueue recovery" });
    exporter.export([], vi.fn());
    completeExport?.({
      code: ExportResultCode.FAILED,
      error: new Error("repeated private collector failure"),
    });
    await waitForDiagnosticEventsDrained();

    expect(
      getReportedExporterHealth(ctx)
        .filter((event) => event.transport === "otlp-http-protobuf")
        .map(({ status, reason }) => ({ status, reason })),
    ).toEqual([
      { status: "started", reason: "configured" },
      { status: "failure", reason: "export_failed" },
    ]);

    exporter.export([], vi.fn());
    completeExport?.({ code: ExportResultCode.SUCCESS });
    await waitForDiagnosticEventsDrained();
    expect(
      getReportedExporterHealth(ctx)
        .filter((event) => event.transport === "otlp-http-protobuf")
        .map(({ status, reason }) => ({ status, reason })),
    ).toEqual([
      { status: "started", reason: "configured" },
      { status: "failure", reason: "export_failed" },
      { status: "recovered", reason: "export_failed" },
    ]);
    expect(events.map((event) => event.status)).not.toContain("recovered");
    expect(JSON.stringify({ events, health: getReportedExporterHealth(ctx) })).not.toContain(
      "private",
    );

    unsubscribe();
  });

  test("preserves and recovers bounded exporter facts for log preparation failures", () => {
    const events: ExporterHealthUpdate[] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const diagnosticsLogs = createDiagnosticsLogExporter({
      captureContent: false,
      emitExporterEvent: createExporterHealthEventEmitter((event) => {
        events.push(event);
      }),
      logger,
      logsToOtlp: true,
      logsToStdout: false,
      resource: {} as never,
      serviceName: "openclaw-test",
    });
    const attributes = new Proxy<Record<string, string | number | boolean>>(
      {},
      {
        ownKeys() {
          throw new TypeError("private preparation details");
        },
      },
    );

    const recordLog = (
      seq: number,
      recordAttributes: Record<string, string | number | boolean>,
    ) => {
      diagnosticsLogs.recordLogEvent?.(
        {
          type: "log.record",
          seq,
          ts: seq,
          level: "INFO",
          message: "prepare me",
          attributes: recordAttributes,
        },
        { trusted: false },
      );
    };
    recordLog(1, attributes);
    recordLog(2, attributes);
    recordLog(3, {});

    expect(
      events.map(({ transport, status, reason, errorCategory }) => ({
        transport,
        status,
        reason,
        errorCategory,
      })),
    ).toEqual([
      {
        transport: "otlp-http-protobuf",
        status: "failure",
        reason: "emit_failed",
        errorCategory: "TypeError",
      },
      {
        transport: "otlp-http-protobuf",
        status: "recovered",
        reason: "emit_failed",
        errorCategory: undefined,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private preparation details");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("diagnostics-otel: log record export failed"),
    );
  });

  test("ignores untrusted telemetry exporter events for OTEL metrics", async () => {
    await startServiceFixture(["metrics"]);
    telemetryState.counters.get("openclaw.telemetry.exporter.events")?.add.mockClear();
    emitEvent("telemetry.exporter", {
      exporter: "spoofed-plugin-exporter",
      signal: "metrics",
      status: "failure",
      reason: "emit_failed",
    });

    expect(
      telemetryState.counters.get("openclaw.telemetry.exporter.events")?.add,
    ).not.toHaveBeenCalled();
  });

  test.each(["run", "harness"] as const)(
    "exports bounded private error messages on %s spans only",
    async (owner) => {
      await startServiceFixture(owner === "run" ? ["traces"] : ["traces", "metrics"]);
      const secret = "sk-1234567890abcdef";
      const message = "model run failed during resolve phase";
      emitTrustedDiagnosticEventWithPrivateData(
        owner === "run"
          ? {
              type: "run.completed",
              runId: "run-1",
              outcome: "error",
              errorCategory: "Error",
              durationMs: 100,
            }
          : eventFixture(
              "harness.run.completed",
              { runId: "run-1", provider: "openai", model: "gpt-5.4", outcome: "error" },
              ["trace"],
            ),
        {
          errorMessage:
            owner === "run" ? `OPENAI_API_KEY=${secret} ${"x".repeat(8 * 1024)}` : message,
        },
      );
      await flushDiagnosticEvents();
      if (owner === "run") {
        const status = mockCallArg(spanByName("openclaw.run").setStatus, 0) as { message?: string };
        expect(status.message).not.toContain(secret);
        expect(status.message).toMatch(/\.\.\.\(truncated\)$/u);
        expect(status.message?.length).toBeLessThanOrEqual(4 * 1024 + 20);
      } else {
        expect(startedSpanOptions("openclaw.harness.run")?.attributes?.["openclaw.error"]).toBe(
          message,
        );
        expect(spanByName("openclaw.harness.run").setStatus).toHaveBeenCalledWith({
          code: 2,
          message,
        });
        expectAbsent(lastHistogramRecord("openclaw.harness.duration_ms")?.[1], "openclaw.error");
      }
    },
  );

  test("lets explicit OpenClaw sampling override the inherited sampler environment", async () => {
    process.env.OTEL_TRACES_SAMPLER = "always_off";
    await startServiceFixture(["traces"], (ctx) => {
      ctx.config.diagnostics!.otel!.sampleRate = 1;
    });

    const traceOptions = mockCallArg(traceProviderCtor, 0) as Record<string, unknown>;
    expect(traceOptions.sampler).toBeDefined();
    expect(traceOptions).not.toHaveProperty("spanLimits");
  });

  test.each([false, true])(
    "validates metric intervals with SDK self-observation=%s",
    async (selfObservation) => {
      if (selfObservation) {
        process.env.OTEL_METRIC_EXPORT_INTERVAL = "2000";
        process.env.OTEL_METRIC_EXPORT_TIMEOUT = "3000";
        process.env.OTEL_NODE_EXPERIMENTAL_SDK_METRICS = "true";
      } else {
        for (const key of [
          "OTEL_BSP_MAX_QUEUE_SIZE",
          "OTEL_BSP_MAX_EXPORT_BATCH_SIZE",
          "OTEL_BSP_SCHEDULE_DELAY",
          "OTEL_BSP_EXPORT_TIMEOUT",
          "OTEL_METRIC_EXPORT_INTERVAL",
          "OTEL_METRIC_EXPORT_TIMEOUT",
        ]) {
          process.env[key] = "0";
        }
      }
      await startServiceFixture(["traces", "metrics"]);
      expect(firstMetricReaderOptions()).toMatchObject({
        exportIntervalMillis: selfObservation ? 2000 : 60_000,
        exportTimeoutMillis: selfObservation ? 2000 : 30_000,
      });
      if (selfObservation) {
        expect(mockCallArg(meterProviderCtor, 0)).toHaveProperty("sdkMetricsEnabled", true);
        expect(mockCallArg(traceProviderCtor, 0)).toHaveProperty(
          "meterProvider",
          expect.anything(),
        );
        expect(firstSpanProcessorOptions().selfObsMeterProvider).toBeDefined();
        expect(diagWarn).toHaveBeenCalledWith(
          "OTEL_METRIC_EXPORT_TIMEOUT (3000) is greater than the active metric export interval (2000). Clamping timeout to interval value.",
        );
      } else {
        expect(firstSpanProcessorOptions()).toMatchObject({
          exportTimeoutMillis: 30_000,
          maxExportBatchSize: 512,
          maxQueueSize: 2048,
          scheduledDelayMillis: 5000,
        });
      }
    },
  );

  test("ignores malformed shared OTLP env when valid signal endpoints shadow it", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://operator:qa-ignored-shared-password@[";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "https://trace-env.example.com/v1/traces";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "https://metric-env.example.com/v1/metrics";
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "https://log-env.example.com/v1/logs";

    await startServiceFixture(["traces", "metrics", "logs"]);

    expect(firstExporterOptions(traceExporterCtor).url).toBe(
      "https://trace-env.example.com/v1/traces",
    );
    expect(firstExporterOptions(metricExporterCtor).url).toBe(
      "https://metric-env.example.com/v1/metrics",
    );
    expect(firstExporterOptions(logExporterCtor).url).toBe("https://log-env.example.com/v1/logs");
  });

  test.each([
    { label: "none", env: "none", expected: [] },
    {
      label: "all",
      env: "all",
      expected: ["host", "os", "serviceinstance", "process", "env"],
    },
    {
      label: "subset with invalid name",
      env: "process,invalid-name",
      expected: ["process"],
    },
  ] as const)(
    "passes the $label resource detectors to detectResources",
    async ({ env, expected }) => {
      process.env.OTEL_NODE_RESOURCE_DETECTORS = env;
      await startServiceFixture(["traces"]);
      const call = detectResourcesMock.mock.calls.at(-1)?.[0] as
        | { detectors?: Array<{ detector: string }> }
        | undefined;
      expect(call?.detectors?.map((detector) => detector.detector)).toEqual(expected);
      if (env?.includes("invalid-name")) {
        expect(diagWarn).toHaveBeenCalledWith(
          'Invalid resource detector "invalid-name" specified in the environment variable OTEL_NODE_RESOURCE_DETECTORS',
        );
      }
    },
  );

  test.each([false, true])("preserves collector TLS material with proxy=%s", async (proxy) => {
    const certDir = mkdtempSync(path.join(tmpdir(), "openclaw-otel-tls-"));
    try {
      const rootCertificatePath = path.join(certDir, "root.pem");
      writeFileSync(rootCertificatePath, proxy ? "root-certificate" : "explicit-root-certificate");
      process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = rootCertificatePath;
      if (proxy) {
        for (const [file, value, env] of [
          [
            "client.pem",
            "trace-client-certificate",
            "OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE",
          ],
          [
            "shared-client.pem",
            "shared-client-certificate",
            "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",
          ],
          ["client-key.pem", "client-key", "OTEL_EXPORTER_OTLP_CLIENT_KEY"],
        ] as const) {
          const filePath = path.join(certDir, file);
          writeFileSync(filePath, value);
          process.env[env] = filePath;
        }
        createNodeProxyAgentMock.mockReturnValue(nodeProxyAgent);
      }
      await startOtelService({
        endpoint: "https://collector.example.com/otlp",
        traces: true,
        metrics: proxy,
        logs: proxy,
      });
      if (proxy) {
        for (const [signal, certificate] of [
          ["traces", "trace-client-certificate"],
          ["metrics", "shared-client-certificate"],
        ] as const) {
          expect(
            findCreateNodeProxyAgentCall(`https://collector.example.com/otlp/v1/${signal}`)
              .agentOptions,
          ).toEqual({
            keepAlive: true,
            ca: Buffer.from("root-certificate"),
            cert: Buffer.from(certificate),
            key: Buffer.from("client-key"),
          });
        }
      } else {
        expect(firstExporterOptions(traceExporterCtor).httpAgentOptions).toEqual({
          keepAlive: true,
          ca: Buffer.from("explicit-root-certificate"),
        });
      }
    } finally {
      rmSync(certDir, { force: true, recursive: true });
    }
  });

  test.each([
    {
      name: "validates log TLS before constructing any owner",
      env: {
        OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE: "/definitely-missing/qa-otel-log-root-atomic.pem",
      },
      options: {
        endpoint: "https://collector.example.com/otlp",
        traces: true,
        metrics: true,
        logs: true,
      },
      fails: true,
    },
    {
      name: "never falls back from unreadable signal TLS to shared trust",
      env: {
        OTEL_EXPORTER_OTLP_CERTIFICATE: process.execPath,
        OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE: "/definitely-missing/qa-otel-signal-override.pem",
      },
      options: { traces: true },
      fails: true,
    },
    {
      name: "validates plugin log TLS even with a preloaded trace SDK",
      env: {
        OPENCLAW_OTEL_PRELOADED: "1",
        OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE: "/definitely-missing/qa-otel-preloaded-log-root.pem",
      },
      options: { traces: true, logs: true },
      fails: true,
    },
    {
      name: "accepts valid ambient TLS for plain HTTP collectors",
      env: { OTEL_EXPORTER_OTLP_CERTIFICATE: process.execPath },
      options: { endpoint: "http://collector.example.com/otlp", traces: true },
      fails: false,
    },
  ])("$name", async ({ env, options, fails }) => {
    Object.assign(process.env, env);
    if (fails) {
      await expect(startOtelService(options)).rejects.toThrow(
        "Configured OpenTelemetry TLS root certificate file is missing, empty, or unreadable; refusing insecure export",
      );
      for (const owner of [
        traceExporterCtor,
        metricExporterCtor,
        logExporterCtor,
        traceProviderCtor,
        meterProviderCtor,
      ]) {
        expect(owner).not.toHaveBeenCalled();
      }
    } else {
      await startOtelService(options);
      expect(traceExporterCtor).toHaveBeenCalledTimes(1);
      expect(firstExporterOptions(traceExporterCtor).httpAgentOptions).toBeUndefined();
    }
  });

  test("redacts proxy credentials from telemetry startup failures", async () => {
    const proxyPassword = "qa-otel-proxy-password-sentinel";
    createNodeProxyAgentMock.mockImplementation(() => {
      throw new Error(`Invalid proxy URL: "https://operator:${proxyPassword}@proxy.example.com"`);
    });

    const failure = await startOtelService({
      endpoint: "https://collector.example.com/otlp",
      traces: true,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      message: "Configured telemetry proxy is invalid or unsupported; refusing direct export",
    });
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(proxyPassword);
    expect(traceExporterCtor).not.toHaveBeenCalled();
  });

  test("exports diagnostic logs as stdout JSONL without constructing the OTLP log exporter", async () => {
    await startServiceFixture(["logs"], {
      endpoint: "",
      logsExporter: "stdout",
      captureContent: true,
      configure: (ctx) => {
        ctx.config.diagnostics!.otel!.serviceName = "rovoclaw-openclaw";
      },
    });
    const stdout = captureStdoutWrites();

    try {
      expect(logExporterCtor).not.toHaveBeenCalled();
      emitDiagnosticEventWithTrustedTraceContext({
        type: "log.record",
        level: "WARN",
        message: "Using API key sk-1234567890abcdef1234567890abcdef",
        attributes: {
          token: "ghp_abcdefghijklmnopqrstuvwxyz123456", // pragma: allowlist secret
          subsystem: "diagnostic",
        },
        trace: createTestTrace(SPAN_ID),
      });
      await flushDiagnosticEvents();

      expect(logEmit).not.toHaveBeenCalled();
      const record = parseSingleStdoutDiagnosticLogLine(stdout.writes);
      expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(record.signal).toBe("openclaw.diagnostic.log");
      expect(record["service.name"]).toBe("rovoclaw-openclaw");
      expect(record.severityText).toBe("WARN");
      expect(record.severityNumber).toBe(13);
      expect(String(record.body)).not.toContain("sk-1234567890abcdef1234567890abcdef");
      expect(String(record.body)).toContain("sk-123");
      expect(record.attributes).toMatchObject({
        "openclaw.log.level": "WARN",
        "openclaw.subsystem": "diagnostic",
        "openclaw.traceFlags": "01",
      });
      const tokenAttr = record.attributes?.["openclaw.token"];
      expect(tokenAttr).not.toBe("ghp_abcdefghijklmnopqrstuvwxyz123456"); // pragma: allowlist secret
      expect(record.trace_id).toBe(TRACE_ID);
      expect(record.span_id).toBe(SPAN_ID);
      expect(JSON.stringify(record)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456"); // pragma: allowlist secret
    } finally {
      stdout.spy.mockRestore();
    }
  });

  test("bounds plugin-emitted log attributes and omits source paths", async () => {
    await startOtelService({ logs: true, captureContent: true });

    const boundaryMessage = `${"x".repeat(4095)}🚀tail`;
    const boundaryAttribute = `${"y".repeat(4095)}🚀tail`;
    const attributes = Object.create(null) as Record<string, string>;
    const diagnosticIdKeys = [
      "callId",
      "call_id",
      "chatId",
      "chat_id",
      "messageId",
      "message_id",
      "parentSpanId",
      "parent_span_id",
      "runId",
      "run_id",
      "sessionId",
      "session_id",
      "sessionKey",
      "session_key",
      "spanId",
      "span_id",
      "toolCallId",
      "tool_call_id",
      "traceId",
      "trace_id",
    ];
    for (const key of diagnosticIdKeys) {
      attributes[key] = `private-${key}`;
    }
    attributes.provider = "openai";
    attributes.good = boundaryAttribute;
    attributes["bad key"] = "drop-me";
    attributes[PROTO_KEY] = "pollute";
    attributes["constructor"] = "pollute";
    attributes["prototype"] = "pollute";
    attributes["sk-1234567890abcdef1234567890abcdef"] = "secret-key"; // pragma: allowlist secret

    emitDiagnosticEvent({
      type: "log.record",
      level: "INFO",
      message: boundaryMessage,
      attributes,
      trace: createTestTrace(SPAN_ID),
      code: {
        filepath: "/Users/alice/openclaw/src/private.ts",
        line: 42,
        functionName: "handler",
        location: "/Users/alice/openclaw/src/private.ts:42",
      },
    } as Parameters<typeof emitDiagnosticEvent>[0]);
    await flushDiagnosticEvents();

    const emitCall = mockCallArg(logEmit, 0) as {
      attributes: Record<string, unknown>;
      body: string;
      context?: unknown;
    };
    for (const key of [...diagnosticIdKeys, "traceFlags"]) {
      expect(Object.hasOwn(emitCall.attributes, `openclaw.${key}`)).toBe(false);
    }
    expect(emitCall.attributes["openclaw.provider"]).toBe("openai");
    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    expect(emitCall.context).toBeUndefined();
    expect(emitCall.body).toBe(`${"x".repeat(4095)}...(truncated)`);
    expect(emitCall.attributes["openclaw.good"]).toBe(`${"y".repeat(4095)}...(truncated)`);
    expect(emitCall.attributes).toMatchObject({
      "code.lineno": 42,
      "code.function": "handler",
    });
    expect(Object.hasOwn(emitCall.attributes, `openclaw.${PROTO_KEY}`)).toBe(false);
    expectAbsent(emitCall.attributes, "openclaw.constructor", "openclaw.prototype");
    expect(
      Object.hasOwn(
        emitCall.attributes,
        "openclaw.sk-1234567890abcdef1234567890abcdef", // pragma: allowlist secret
      ),
    ).toBe(false);
    expectAbsent(
      emitCall.attributes,
      "openclaw.bad key",
      "code.filepath",
      "openclaw.code.location",
    );
  });

  test("exports GenAI usage attributes on model usage spans without diagnostic identifiers", async () => {
    await startServiceFixture(["traces"]);

    await emitAndFlush({
      type: "model.usage",
      sessionKey: "session-key",
      sessionId: "session-id",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4.6",
      usage: {
        input: 100,
        output: 40,
        cacheRead: 30,
        cacheWrite: 20,
        promptTokens: 150,
        total: 190,
      },
      durationMs: 25,
    });

    const modelUsageOptions = startedSpanOptions("openclaw.model.usage");
    expect(modelUsageOptions?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "anthropic/claude-sonnet-4.6",
      "gen_ai.usage.input_tokens": 150,
      "gen_ai.usage.output_tokens": 40,
      "gen_ai.usage.cache_read.input_tokens": 30,
      "gen_ai.usage.cache_creation.input_tokens": 20,
    });
    expectAbsent(modelUsageOptions?.attributes, "openclaw.sessionKey", "openclaw.sessionId");
    expectAbsent(
      modelUsageOptions?.attributes,
      "gen_ai.provider.name",
      "gen_ai.input.messages",
      "gen_ai.output.messages",
    );
    expect(modelUsageOptions?.startTime).toBeTypeOf("number");
    expect(JSON.stringify(modelUsageOptions)).not.toContain("session-key");
  });

  test("exports run, model call, and tool execution lifecycle spans", async () => {
    await startServiceFixture(["traces", "metrics"]);

    emitEvent("run.completed", {
      runId: "run-1",
      sessionKey: "session-key",
      ...MODEL_FIXTURE,
      channel: "webchat",
      trace: createTestTrace(SPAN_ID),
    });
    emitEvent("model.call.completed", {
      api: "completions",
      transport: "http",
      requestPayloadBytes: 1234,
      responseStreamBytes: 567,
      timeToFirstByteMs: 45,
      promptStats: {
        inputMessagesCount: 2,
        inputMessagesChars: 3456,
        systemPromptChars: 789,
        toolDefinitionsCount: 4,
        toolDefinitionsChars: 2345,
        totalChars: 6590,
      },
      usage: {
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 5,
        reasoningTokens: 8,
        promptTokens: 135,
        total: 155,
      },
      trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
    });
    emitEvent("harness.run.completed", {
      runId: "run-1",
      sessionKey: "session-key",
      sessionId: "session-1",
      provider: "codex",
      model: "gpt-5.4",
      channel: "qa",
      harnessId: "codex",
      pluginId: "codex-plugin",
      resultClassification: "reasoning-only",
      yieldDetected: true,
      itemLifecycle: { startedCount: 3, completedCount: 2, activeCount: 1 },
    });
    await emitEventAndFlush("tool.execution.error", {
      toolCallId: "tool-1",
      paramsSummary: { kind: "object" },
      errorCode: "429",
      trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
    });

    const spanNames = telemetryState.tracer.startSpan.mock.calls.map((call) => call[0]);
    expect(spanNames).toContain("openclaw.run");
    expect(spanNames).toContain("openclaw.model.call");
    expect(spanNames).toContain("openclaw.harness.run");
    expect(spanNames).toContain("openclaw.tool.execution");

    const runOptions = startedSpanOptions("openclaw.run");
    expect(runOptions?.attributes).toMatchObject({
      "openclaw.outcome": "completed",
      "openclaw.provider": "openai",
      "openclaw.model": "gpt-5.4",
      "openclaw.channel": "webchat",
    });
    expectAbsent(runOptions?.attributes, "gen_ai.system", "gen_ai.request.model");
    expectAbsent(
      runOptions?.attributes,
      "openclaw.runId",
      "openclaw.sessionKey",
      "openclaw.traceId",
    );
    expect(runOptions?.startTime).toBeTypeOf("number");

    const modelCall = startedSpanCall("openclaw.model.call");
    const modelOptions = modelCall?.[1];
    expect(modelOptions?.attributes).toMatchObject({
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-5.4",
      "gen_ai.operation.name": "text_completion",
    });
    expectAbsent(modelOptions?.attributes, "gen_ai.provider.name", "openclaw.callId");
    expectAbsent(modelOptions?.attributes, "openclaw.runId", "openclaw.sessionKey");
    expect(modelOptions?.startTime).toBeTypeOf("number");
    expect(modelOptions?.kind).toBe(2);
    expect(modelCall?.[2]).toBeUndefined();

    const harnessCall = startedSpanCall("openclaw.harness.run");
    const harnessOptions = harnessCall?.[1];
    expect(harnessOptions?.attributes).toMatchObject({
      "openclaw.harness.id": "codex",
      "openclaw.harness.plugin": "codex-plugin",
      "openclaw.outcome": "completed",
      "openclaw.provider": "codex",
      "openclaw.model": "gpt-5.4",
      "openclaw.channel": "qa",
      "openclaw.harness.result_classification": "reasoning-only",
      "openclaw.harness.yield_detected": true,
      "openclaw.harness.items.started": 3,
      "openclaw.harness.items.completed": 2,
      "openclaw.harness.items.active": 1,
    });
    expectAbsent(harnessOptions?.attributes, "openclaw.runId", "openclaw.sessionId");
    expectAbsent(harnessOptions?.attributes, "openclaw.sessionKey", "openclaw.traceId");
    expect(harnessOptions?.startTime).toBeTypeOf("number");
    expect(harnessCall?.[2]).toBeUndefined();

    const toolCall = startedSpanCall("openclaw.tool.execution");
    const toolOptions = toolCall?.[1];
    expect(toolOptions?.attributes).toMatchObject({
      "openclaw.toolName": "read",
      "openclaw.tool.source": "core",
      "openclaw.errorCategory": "TypeError",
      "openclaw.errorCode": "429",
      "openclaw.tool.params.kind": "object",
      "gen_ai.tool.name": "read",
    });
    expectAbsent(
      toolOptions?.attributes,
      "openclaw.toolCallId",
      "openclaw.runId",
      "openclaw.sessionKey",
    );
    expect(toolOptions?.startTime).toBeTypeOf("number");
    expectAbsent(toolOptions, "kind");
    expect(toolCall?.[2]).toBeUndefined();

    const modelCallDuration = lastHistogramRecord("openclaw.model_call.duration_ms");
    expect(modelCallDuration?.[0]).toBe(80);
    expect(modelCallDuration?.[1]?.["openclaw.provider"]).toBe("openai");
    expect(modelCallDuration?.[1]?.["openclaw.model"]).toBe("gpt-5.4");
    const requestBytes = lastHistogramRecord("openclaw.model_call.request_bytes");
    expect(requestBytes?.[0]).toBe(1234);
    expect(requestBytes?.[1]?.["openclaw.provider"]).toBe("openai");
    expect(requestBytes?.[1]?.["openclaw.model"]).toBe("gpt-5.4");
    const responseBytes = lastHistogramRecord("openclaw.model_call.response_bytes");
    expect(responseBytes?.[0]).toBe(567);
    expect(responseBytes?.[1]?.["openclaw.provider"]).toBe("openai");
    expect(responseBytes?.[1]?.["openclaw.model"]).toBe("gpt-5.4");
    const timeToFirstByte = lastHistogramRecord("openclaw.model_call.time_to_first_byte_ms");
    expect(timeToFirstByte?.[0]).toBe(45);
    expect(timeToFirstByte?.[1]?.["openclaw.provider"]).toBe("openai");
    expect(timeToFirstByte?.[1]?.["openclaw.model"]).toBe("gpt-5.4");
    const modelSpanAttributes = firstSpanAttributes("openclaw.model.call");
    expect(modelSpanAttributes).toMatchObject({
      "openclaw.model_call.request_bytes": 1234,
      "openclaw.model_call.response_bytes": 567,
      "openclaw.model_call.time_to_first_byte_ms": 45,
      "openclaw.model_call.prompt.input_messages_count": 2,
      "openclaw.model_call.prompt.input_messages_chars": 3456,
      "openclaw.model_call.prompt.system_prompt_chars": 789,
      "openclaw.model_call.prompt.tool_definitions_count": 4,
      "openclaw.model_call.prompt.tool_definitions_chars": 2345,
      "openclaw.model_call.prompt.total_chars": 6590,
      "openclaw.model_call.usage.input_tokens": 100,
      "openclaw.model_call.usage.output_tokens": 20,
      "openclaw.model_call.usage.cache_read_input_tokens": 30,
      "openclaw.model_call.usage.cache_creation_input_tokens": 5,
      "openclaw.model_call.usage.reasoning_output_tokens": 8,
      "openclaw.model_call.usage.prompt_tokens": 135,
      "openclaw.model_call.usage.total_tokens": 155,
      "gen_ai.usage.input_tokens": 135,
      "gen_ai.usage.output_tokens": 20,
    });
    const runDuration = lastHistogramRecord("openclaw.run.duration_ms");
    expect(runDuration?.[0]).toBe(100);
    expectAbsent(runDuration?.[1], "openclaw.runId");
    const harnessDuration = lastHistogramRecord("openclaw.harness.duration_ms");
    expect(harnessDuration?.[0]).toBe(90);
    expect(harnessDuration?.[1]?.["openclaw.harness.id"]).toBe("codex");
    expect(harnessDuration?.[1]?.["openclaw.harness.plugin"]).toBe("codex-plugin");
    expect(harnessDuration?.[1]?.["openclaw.outcome"]).toBe("completed");
    expectAbsent(harnessDuration?.[1], "openclaw.runId", "openclaw.sessionKey");
    const toolDuration = lastHistogramRecord("openclaw.tool.execution.duration_ms");
    expect(toolDuration?.[0]).toBe(20);
    expect(toolDuration?.[1]?.["openclaw.tool.source"]).toBe("core");
    expectAbsent(toolDuration?.[1], "openclaw.errorCode", "openclaw.runId");

    const toolSpan = spanByName("openclaw.tool.execution");
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "TypeError",
    });
    expect(firstSpanEndTime("openclaw.tool.execution")).toBeTypeOf("number");
    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
  });

  test("closes a tracked blocked tool span once without creating a duplicate", async () => {
    await startServiceFixture(["traces", "metrics"]);

    emitTrustedEvent("tool.execution.started", {
      runId: "run-blocked",
      toolName: "exec",
      toolCallId: "call-blocked",
      sourceTimestampMs: 1_000,
      trace: createTestTrace(TOOL_SPAN_ID, CHILD_SPAN_ID),
    });
    await emitTrustedEventAndFlush("tool.execution.blocked", {
      runId: "run-blocked",
      toolName: "exec",
      toolCallId: "call-blocked",
      deniedReason: "tools.deny",
      reason: "policy denied",
      sourceTimestampMs: 1_250,
      trace: createTestTrace(TOOL_SPAN_ID, CHILD_SPAN_ID),
    });

    const toolSpans = telemetryState.spans.filter(
      (span) => span.name === "openclaw.tool.execution",
    );
    expect(toolSpans).toHaveLength(1);
    expect(startedSpanOptions("openclaw.tool.execution")?.startTime).toBe(1_000);
    expect(toolSpans[0]?.end).toHaveBeenCalledTimes(1);
    expect(toolSpans[0]?.end).toHaveBeenCalledWith(1_250);
  });

  test("uses authoritative source timestamps for terminal-only tool spans", async () => {
    await startServiceFixture(["traces", "metrics"]);

    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-completed",
      toolName: "read",
      toolCallId: "call-completed",
      durationMs: 250,
      sourceTimestampMs: 5_000,
    });
    await emitTrustedAndFlush({
      type: "tool.execution.error",
      runId: "run-error",
      toolName: "write",
      toolCallId: "call-error",
      durationMs: 500,
      errorCategory: "test",
      sourceTimestampMs: 7_000,
    });

    const toolSpanCalls = telemetryState.tracer.startSpan.mock.calls.filter(
      (call) => call[0] === "openclaw.tool.execution",
    );
    const toolSpans = telemetryState.spans.filter(
      (span) => span.name === "openclaw.tool.execution",
    );
    expect(toolSpanCalls).toHaveLength(2);
    expect((toolSpanCalls[0]?.[1] as { startTime?: number } | undefined)?.startTime).toBe(4_750);
    expect((toolSpanCalls[1]?.[1] as { startTime?: number } | undefined)?.startTime).toBe(6_500);
    expect(toolSpans[0]?.end).toHaveBeenCalledWith(5_000);
    expect(toolSpans[1]?.end).toHaveBeenCalledWith(7_000);
  });

  test.each([
    { lane: "main", expectedLane: "main", withDestination: true, trusted: true },
    {
      lane: "session:Agent:qa:otel-trace-smoke",
      expectedLane: "session",
      withDestination: false,
      trusted: false,
    },
  ])(
    "exports bounded model failover spans for $lane",
    async ({ lane, expectedLane, withDestination, trusted }) => {
      await startServiceFixture(["traces", "metrics"]);

      const emitFailover = trusted ? emitTrustedEventAndFlush : emitEventAndFlush;
      await emitFailover("model.failover", {
        sessionId: "session-1",
        lane,
        fromProvider: "anthropic",
        fromModel: "claude-opus-4-6",
        reason: "overloaded",
        ...(withDestination
          ? { toProvider: "openai", toModel: "gpt-5.4", suspended: true, cascadeDepth: 1 }
          : {}),
      });

      const failoverOptions = startedSpanOptions("openclaw.model.failover");
      expect(failoverOptions?.attributes).toMatchObject({
        "openclaw.provider": "anthropic",
        "openclaw.model": "claude-opus-4-6",
        "openclaw.failover.reason": "overloaded",
        "openclaw.lane": expectedLane,
        ...(withDestination
          ? {
              "openclaw.failover.to_provider": "openai",
              "openclaw.failover.to_model": "gpt-5.4",
              "openclaw.failover.suspended": true,
              "openclaw.failover.cascade_depth": 1,
            }
          : {}),
      });
      expectAbsent(failoverOptions?.attributes, "openclaw.sessionId", "openclaw.sessionKey");
      expect(failoverOptions?.startTime).toBeTypeOf("number");
      expect(firstSpanEndTime("openclaw.model.failover")).toBeTypeOf("number");
      expect(JSON.stringify(failoverOptions?.attributes)).not.toContain(
        "Agent:qa:otel-trace-smoke",
      );
      expect(firstCounterAddCall("openclaw.model.failover")).toStrictEqual([
        1,
        {
          "openclaw.failover.reason": "overloaded",
          "openclaw.failover.suspended": withDestination ? "true" : "unknown",
          "openclaw.lane": expectedLane,
          "openclaw.model": "claude-opus-4-6",
          "openclaw.provider": "anthropic",
          "openclaw.failover.to_model": withDestination ? "gpt-5.4" : "unknown",
          "openclaw.failover.to_provider": withDestination ? "openai" : "unknown",
        },
      ]);
    },
  );

  test("records blocked tool metrics even when traces are disabled", async () => {
    await startServiceFixture(["metrics"]);

    await emitTrustedEventAndFlush("tool.execution.blocked", {
      runId: "run-should-not-export",
      toolName: "browser",
      toolSource: "mcp",
      toolOwner: "browser-tools",
      deniedReason: "tools.deny",
      reason: "matched browser",
      paramsSummary: { kind: "object" },
    });

    expect(firstCounterAddCall("openclaw.tool.execution.blocked")).toStrictEqual([
      1,
      {
        "openclaw.toolName": "browser",
        "openclaw.tool.source": "mcp",
        "gen_ai.tool.name": "browser",
        "openclaw.tool.owner": "browser-tools",
        "openclaw.tool.params.kind": "object",
        "openclaw.deniedReason": "tools.deny",
      },
    ]);
    expect(telemetryState.tracer.startSpan).not.toHaveBeenCalledWith(
      "openclaw.tool.execution",
      expect.anything(),
      expect.anything(),
    );
  });

  test("maps model call APIs and preserves zero usage on terminal spans", async () => {
    await startServiceFixture(["traces", "metrics"]);
    const zeroUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
      total: 0,
    };

    emitDiagnosticEvent({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      api: "openai-completions",
      durationMs: 80,
      requestPayloadBytes: 0,
      responseStreamBytes: 0,
      timeToFirstByteMs: 0,
      usage: zeroUsage,
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-2",
      provider: "google",
      model: "gemini-2.5-flash",
      api: "google-generative-ai",
      durationMs: 90,
    });
    emitDiagnosticEvent({
      type: "model.call.error",
      runId: "run-1",
      callId: "call-3",
      ...MODEL_FIXTURE,
      api: "openai-responses",
      durationMs: 40,
      errorCategory: "TimeoutError",
      failureKind: "terminated",
      upstreamRequestIdHash: "sha256:123456abcdef",
      usage: zeroUsage,
    });
    await emitAndFlush({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      callId: "call-cache-only",
      durationMs: 30,
      usage: { cacheWrite: 7 },
    });

    const modelCallAttrs = telemetryState.tracer.startSpan.mock.calls
      .filter((call) => call[0] === "openclaw.model.call")
      .map((call) => (call[1] as { attributes?: Record<string, unknown> }).attributes);
    expect(modelCallAttrs).toHaveLength(4);
    expect(modelCallAttrs[0]?.["gen_ai.system"]).toBe("openai");
    expect(modelCallAttrs[0]?.["gen_ai.request.model"]).toBe("gpt-5.4");
    expect(modelCallAttrs[0]?.["gen_ai.operation.name"]).toBe("text_completion");
    expect(modelCallAttrs[1]?.["gen_ai.system"]).toBe("google");
    expect(modelCallAttrs[1]?.["gen_ai.request.model"]).toBe("gemini-2.5-flash");
    expect(modelCallAttrs[1]?.["gen_ai.operation.name"]).toBe("generate_content");
    expect(modelCallAttrs[2]?.["gen_ai.system"]).toBe("openai");
    expect(modelCallAttrs[2]?.["gen_ai.request.model"]).toBe("gpt-5.4");
    expect(modelCallAttrs[2]?.["gen_ai.operation.name"]).toBe("chat");
    expect(modelCallAttrs[2]?.["error.type"]).toBe("TimeoutError");
    expect(modelCallAttrs[2]?.["openclaw.failureKind"]).toBe("terminated");
    expectAbsent(modelCallAttrs[2], "openclaw.upstreamRequestIdHash");
    expect(startedSpanOptions("openclaw.model.call", 2)?.startTime).toBeTypeOf("number");
    const errorSpan = telemetryState.spans.filter((span) => span.name === "openclaw.model.call")[2];
    expect(errorSpan?.addEvent).toHaveBeenCalledWith("openclaw.provider.request", {
      "openclaw.upstreamRequestIdHash": "sha256:123456abcdef",
    });
    const errorDuration = telemetryState.histograms.get("openclaw.model_call.duration_ms")?.record
      .mock.calls[2];
    expect(errorDuration?.[0]).toBe(40);
    expect(errorDuration?.[1]?.["openclaw.failureKind"]).toBe("terminated");
    expectAbsent(errorDuration?.[1], "openclaw.upstreamRequestIdHash");
    for (const attrs of [modelCallAttrs[0], modelCallAttrs[2]]) {
      expect(attrs).toMatchObject({
        "openclaw.model_call.usage.input_tokens": 0,
        "openclaw.model_call.usage.output_tokens": 0,
        "openclaw.model_call.usage.cache_read_input_tokens": 0,
        "openclaw.model_call.usage.cache_creation_input_tokens": 0,
        "openclaw.model_call.usage.reasoning_output_tokens": 0,
        "openclaw.model_call.usage.prompt_tokens": 0,
        "openclaw.model_call.usage.total_tokens": 0,
        "gen_ai.usage.input_tokens": 0,
        "gen_ai.usage.output_tokens": 0,
        "gen_ai.usage.cache_read.input_tokens": 0,
        "gen_ai.usage.cache_creation.input_tokens": 0,
      });
    }
    for (const key of [
      "openclaw.model_call.request_bytes",
      "openclaw.model_call.response_bytes",
      "openclaw.model_call.time_to_first_byte_ms",
    ]) {
      expect(modelCallAttrs[0]).not.toHaveProperty(key);
    }
    expect(
      Object.keys(modelCallAttrs[1] ?? {}).filter(
        (key) => key.startsWith("openclaw.model_call.usage.") || key.startsWith("gen_ai.usage."),
      ),
    ).toEqual([]);
    expect(modelCallAttrs[3]).toMatchObject({
      "openclaw.model_call.usage.cache_creation_input_tokens": 7,
      "openclaw.model_call.usage.prompt_tokens": 7,
      "gen_ai.usage.input_tokens": 7,
      "gen_ai.usage.cache_creation.input_tokens": 7,
    });
    expect(modelCallAttrs[3]).not.toHaveProperty("openclaw.model_call.usage.input_tokens");
  });

  test("uses latest GenAI request and agent span shapes only when semconv opt-in is set", async () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "http,gen_ai_latest_experimental";

    await startServiceFixture(["traces", "metrics"]);

    emitDiagnosticEvent({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      api: "openai-completions",
      durationMs: 80,
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-2",
      provider: "anthropic",
      model: "claude-opus-4-7",
      api: "claude-code",
      transport: "stdio-live",
      observationUnit: "turn",
      durationMs: 90,
    });
    await emitAndFlush({
      type: "model.usage",
      ...MODEL_FIXTURE,
      usage: { input: 3, output: 2 },
      durationMs: 10,
    });

    expect(startedSpanOptions("openclaw.model.call")).toBeUndefined();
    const modelCallOptions = startedSpanOptions("text_completion gpt-5.4");
    expect(modelCallOptions?.attributes).toMatchObject({
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-5.4",
      "gen_ai.operation.name": "text_completion",
    });
    expectAbsent(modelCallOptions?.attributes, "gen_ai.system");
    expect(modelCallOptions?.startTime).toBeTypeOf("number");
    expect(modelCallOptions?.kind).toBe(2);
    const agentTurnOptions = startedSpanOptions("invoke_agent");
    expect(agentTurnOptions?.attributes).toMatchObject({
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-opus-4-7",
      "gen_ai.operation.name": "invoke_agent",
      "openclaw.model_call.observation_unit": "turn",
    });
    expect(agentTurnOptions?.startTime).toBeTypeOf("number");
    expect(agentTurnOptions?.kind).toBe(2);
    const modelUsageOptions = startedSpanOptions("openclaw.model.usage");
    expect(modelUsageOptions?.attributes).toMatchObject({
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-5.4",
      "gen_ai.operation.name": "chat",
    });
    expectAbsent(modelUsageOptions?.attributes, "gen_ai.system");
    expect(modelUsageOptions?.startTime).toBeTypeOf("number");
  });

  test("exports trusted context assembly spans without prompt content", async () => {
    await startServiceFixture(["traces", "metrics"]);

    emitTrustedEvent("run.started", {
      trace: createTestTrace(SPAN_ID),
    });
    await emitTrustedEventAndFlush("context.assembled", {
      runId: "run-1",
      sessionKey: "session-key",
      sessionId: "session-id",
      ...MODEL_FIXTURE,
      channel: "webchat",
      trigger: "message",
      messageCount: 12,
      historyTextChars: 1234,
      historyImageBlocks: 2,
      maxMessageTextChars: 456,
      systemPromptChars: 789,
      promptChars: 42,
      promptImages: 1,
      contextTokenBudget: 128_000,
      reserveTokens: 4096,
      trace: createTestTrace(GRANDCHILD_SPAN_ID, SPAN_ID),
    });

    const contextCall = startedSpanCall("openclaw.context.assembled");
    const contextOptions = contextCall?.[1];
    const runSpan = telemetryState.spans.find((span) => span.name === "openclaw.run");
    const runSpanId = runSpan?.spanContext.mock.results[0]?.value?.spanId;
    expect(contextOptions?.attributes).toMatchObject({
      "openclaw.provider": "openai",
      "openclaw.model": "gpt-5.4",
      "openclaw.channel": "webchat",
      "openclaw.trigger": "message",
      "openclaw.context.message_count": 12,
      "openclaw.context.history_text_chars": 1234,
      "openclaw.context.history_image_blocks": 2,
      "openclaw.context.max_message_text_chars": 456,
      "openclaw.context.system_prompt_chars": 789,
      "openclaw.context.prompt_chars": 42,
      "openclaw.context.prompt_images": 1,
      "openclaw.context.token_budget": 128_000,
      "openclaw.context.reserve_tokens": 4096,
    });
    expect(contextOptions?.attributes).toBeTypeOf("object");
    expect(contextOptions?.startTime).toBeTypeOf("number");
    expect(JSON.stringify(contextCall)).not.toContain("session-key");
    expect(JSON.stringify(contextCall)).not.toContain("prompt text");
    const linkedSpanContext = firstSetSpanContext();
    expect(linkedSpanContext.traceId).toBe(TRACE_ID);
    expect(linkedSpanContext.spanId).toBe(runSpanId);
    expect(
      (contextCall?.[2] as { spanContext?: { spanId?: string } } | undefined)?.spanContext?.spanId,
    ).toBe(runSpanId);
  });

  test("parents multi-batch late delivery spans from the retained message context", async () => {
    await startServiceFixture(["traces", "metrics"]);

    const messageTrace = createDiagnosticTraceContext(createTestTrace(CHILD_SPAN_ID, SPAN_ID));

    runWithDiagnosticTraceContext(messageTrace, () => {
      logMessageDispatchStarted({
        channel: "slack",
        sessionKey: "agent:main:slack:channel:c1",
        source: "replyResolver",
      });
      for (let index = 0; index < 125; index += 1) {
        emitInternalEvent("message.delivery.completed", {
          channel: "slack",
          deliveryKind: "text",
          sessionKey: `agent:main:slack:channel:c${index}`,
          durationMs: 15,
          resultCount: 1,
        });
      }
      logMessageProcessed({
        channel: "slack",
        sessionKey: "agent:main:slack:channel:c1",
        durationMs: 120,
        outcome: "completed",
      });
    });

    const messageSpan = spanByName("openclaw.message.processed");
    const messageSpanContext = messageSpan.spanContext();
    expect(messageSpan.end).toHaveBeenCalledTimes(1);
    await waitForDiagnosticEventsDrained();

    const deliveryParentContexts = startedSpanParentContexts("openclaw.message.delivery");
    expect(deliveryParentContexts).toHaveLength(125);
    expect(deliveryParentContexts.every((parent) => parent?.traceId === TRACE_ID)).toBe(true);
    expect(
      deliveryParentContexts.every((parent) => parent?.spanId === messageSpanContext.spanId),
    ).toBe(true);
  });

  test("correlates skipped duplicate message lifecycle helpers to the active inbound trace", async () => {
    await startServiceFixture(["traces", "metrics"]);

    const messageTrace = createDiagnosticTraceContext(createTestTrace(CHILD_SPAN_ID, SPAN_ID));

    runWithDiagnosticTraceContext(messageTrace, () => {
      logMessageProcessed({
        channel: "slack",
        messageId: "msg-duplicate",
        chatId: "c1",
        sessionKey: "agent:main:slack:channel:c1",
        durationMs: 5,
        outcome: "skipped",
        reason: "duplicate",
      });
    });
    await flushDiagnosticEvents();

    const messageSpan = spanByName("openclaw.message.processed");
    const messageSpanContext = messageSpan.spanContext();
    const parentContext = startedSpanParentContexts("openclaw.message.processed")[0];

    expect(messageSpanContext.traceId).toBe(TRACE_ID);
    expect(parentContext?.traceId).toBe(TRACE_ID);
    expect(parentContext?.spanId).toBe(SPAN_ID);
    expect(firstSpanAttributes("openclaw.message.processed")["openclaw.reason"]).toBe("duplicate");
    expect(messageSpan.end).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["does not parent sibling active runs through shared upstream aliases", false],
    ["does not parent sibling runs through retained upstream aliases", true],
  ])("%s", async (_name, completeFirstRun) => {
    await startServiceFixture(["traces", "metrics"]);

    emitTrustedEvent("run.started");
    if (completeFirstRun) {
      emitTrustedEvent("run.completed", {});
    }
    emitTrustedEvent("run.started", {
      runId: "run-2",
      ...MODEL_FIXTURE,
      trace: createTestTrace(GRANDCHILD_SPAN_ID, SPAN_ID),
    });

    const runContexts = startedSpanParentContextsByName("openclaw.run");

    expect(runContexts).toHaveLength(2);
    expect(runContexts[0]?.parentContext).toBeUndefined();
    expect(runContexts[1]?.parentContext).toBeUndefined();
  });

  test.each([false, true])(
    "parents owned model spans through late retained context=%s",
    async (late) => {
      if (late) {
        vi.useFakeTimers({ toFake: ["Date"] });
      }
      try {
        await startServiceFixture(["traces", "metrics"]);
        emitTrustedEvent("run.started");
        const runSpanContext = spanByName("openclaw.run").spanContext();
        if (late) {
          emitTrustedEvent("run.completed");
          vi.setSystemTime(Date.now() + LATE_CHILD_ELAPSED_MS);
          await flushDiagnosticEvents();
          await waitForDiagnosticEventsDrained();
          await flushDiagnosticEvents();
        }
        emitTrustedEvent("model.call.completed", {
          trace: createTestTrace(MODEL_CALL_SPAN_ID, late ? CHILD_SPAN_ID : SPAN_ID),
        });
        if (!late) {
          emitTrustedEvent("run.completed");
        }
        await flushDiagnosticEvents();
        const parentContext = startedSpanParentContexts("openclaw.model.call")[0];
        expect(parentContext?.traceId).toBe(TRACE_ID);
        expect(parentContext?.spanId).toBe(runSpanContext.spanId);
      } finally {
        if (late) {
          vi.useRealTimers();
        }
      }
    },
  );

  // Retained contexts outlive the turn, so this bound is what keeps a long-lived
  // gateway from growing the map without limit.
  test("bounds retained run contexts by evicting the oldest completed runs", async () => {
    await startServiceFixture(["traces", "metrics"]);

    // Each completed run retains its own span id plus its upstream alias, so
    // this comfortably overflows the bound and evicts the earliest run.
    for (let index = 0; index < MAX_RETAINED_TRUSTED_SPAN_CONTEXTS; index += 1) {
      const runId = `run-${index}`;
      const runTrace = createTestTrace(numberedSpanId(index), SPAN_ID);
      emitTrustedEvent("run.started", { runId, trace: runTrace });
      emitTrustedEvent("run.completed", { runId, trace: runTrace });
    }
    const newestRunSpanId = numberedSpanId(MAX_RETAINED_TRUSTED_SPAN_CONTEXTS - 1);
    const newestRunSpan = telemetryState.spans.findLast((span) => span.name === "openclaw.run");
    telemetryState.tracer.startSpan.mockClear();

    emitTrustedEvent("model.usage", {
      trace: createTestTrace(GRANDCHILD_SPAN_ID, newestRunSpanId),
    });
    emitTrustedEvent("model.usage", {
      trace: createTestTrace(MODEL_USAGE_SPAN_ID, numberedSpanId(0)),
    });

    const usageParents = startedSpanParentContexts("openclaw.model.usage");
    expect(usageParents[0]?.spanId).toBe(newestRunSpan?.spanContext().spanId);
    expect(usageParents[1]).toBeUndefined();
  });

  test("does not create live started spans for untrusted lifecycle diagnostics", async () => {
    await startServiceFixture(["traces", "metrics"]);

    emitEvent("run.started", {}, ["trace"]);
    emitEvent("run.completed", {}, ["trace"]);
    emitEvent("model.call.started", {}, ["trace"]);
    emitEvent("model.call.completed", {}, ["trace"]);
    emitEvent("tool.execution.started", {}, ["trace"]);
    emitEvent("tool.execution.error", {}, ["trace"]);
    emitDiagnosticEvent({
      type: "harness.run.started",
      runId: "run-1",
      provider: "codex",
      model: "gpt-5.4",
      harnessId: "codex",
      pluginId: "codex-plugin",
    });
    await emitAndFlush({
      type: "harness.run.completed",
      runId: "run-1",
      provider: "codex",
      model: "gpt-5.4",
      harnessId: "codex",
      pluginId: "codex-plugin",
      outcome: "completed",
      durationMs: 90,
    });

    expect(
      telemetryState.tracer.startSpan.mock.calls.filter((call) => call[0] === "openclaw.run"),
    ).toHaveLength(1);
    expect(
      telemetryState.tracer.startSpan.mock.calls.filter(
        (call) => call[0] === "openclaw.model.call",
      ),
    ).toHaveLength(1);
    expect(
      telemetryState.tracer.startSpan.mock.calls.filter(
        (call) => call[0] === "openclaw.tool.execution",
      ),
    ).toHaveLength(1);
    expect(
      telemetryState.tracer.startSpan.mock.calls.filter(
        (call) => call[0] === "openclaw.harness.run",
      ),
    ).toHaveLength(1);
  });

  // Exec spans used to always be roots, which stranded every shell command in its
  // own single-span trace instead of nesting it under the run that spawned it.
  test("nests exec spans under the run when the trace context is OpenClaw-owned", async () => {
    await startServiceFixture(["traces", "metrics"]);

    emitTrustedEvent("run.started");
    const runSpanContext = spanByName("openclaw.run").spanContext();
    const execEvent = {
      type: "exec.process.completed",
      target: "host",
      mode: "child",
      outcome: "completed",
      durationMs: 30,
      commandLength: 12,
      // Exec carries the ambient run scope, so its own span id is the run's.
      trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
    } as const;

    emitDiagnosticEventWithTrustedTraceContext(execEvent);
    emitDiagnosticEvent(execEvent);
    await flushDiagnosticEvents();

    const execParents = startedSpanParentContexts("openclaw.exec");
    expect(execParents[0]?.traceId).toBe(TRACE_ID);
    expect(execParents[0]?.spanId).toBe(runSpanContext.spanId);
    // A plain untrusted emitter must not be able to inject a parent link.
    expect(execParents[1]).toBeUndefined();
  });

  test("exports exec process spans without command text", async () => {
    await startServiceFixture(["traces", "metrics"]);

    await emitEventAndFlush("exec.process.completed", {
      target: "host",
      mode: "child",
      outcome: "failed",
      durationMs: 30,
      commandLength: 42,
      exitCode: 1,
      timedOut: false,
      failureKind: "runtime-error",
    });

    const execDuration = lastHistogramRecord("openclaw.exec.duration_ms");
    expect(execDuration?.[0]).toBe(30);
    expect(execDuration?.[1]?.["openclaw.exec.target"]).toBe("host");
    expect(execDuration?.[1]?.["openclaw.exec.mode"]).toBe("child");
    expect(execDuration?.[1]?.["openclaw.outcome"]).toBe("failed");
    expect(execDuration?.[1]?.["openclaw.failureKind"]).toBe("runtime-error");

    const execCall = startedSpanCall("openclaw.exec");
    const execOptions = execCall?.[1];
    expect(execOptions?.attributes).toMatchObject({
      "openclaw.exec.target": "host",
      "openclaw.exec.mode": "child",
      "openclaw.outcome": "failed",
      "openclaw.exec.command_length": 42,
      "openclaw.exec.exit_code": 1,
      "openclaw.exec.timed_out": false,
      "openclaw.failureKind": "runtime-error",
    });
    expectAbsent(
      execOptions?.attributes,
      "openclaw.exec.command",
      "openclaw.exec.workdir",
      "openclaw.sessionKey",
    );
    expect(execOptions?.startTime).toBeTypeOf("number");

    const execSpan = spanByName("openclaw.exec");
    expect(execSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "runtime-error",
    });
    expect(firstSpanEndTime("openclaw.exec")).toBeTypeOf("number");
  });

  test("exports message delivery spans and metrics with low-cardinality attributes", async () => {
    await startServiceFixture(["traces", "metrics"]);

    emitEvent("message.delivery.started", {
      channel: "matrix",
      deliveryKind: "text",
      sessionKey: "session-secret",
    });
    emitEvent("message.delivery.completed", {
      channel: "matrix",
      deliveryKind: "text",
      durationMs: 25,
      resultCount: 1,
      sessionKey: "session-secret",
    });
    await emitEventAndFlush("message.delivery.error", {
      channel: "discord",
      deliveryKind: "media",
      durationMs: 40,
      errorCategory: "TypeError",
      sessionKey: "session-secret",
    });

    expect(
      telemetryState.counters.get("openclaw.message.delivery.started")?.add,
    ).toHaveBeenCalledWith(1, {
      "openclaw.channel": "matrix",
      "openclaw.delivery.kind": "text",
    });
    const deliveryDurationRecords = telemetryState.histograms.get(
      "openclaw.message.delivery.duration_ms",
    )?.record.mock.calls as Array<[unknown, Record<string, unknown>]>;
    expect(deliveryDurationRecords[0]?.[0]).toBe(25);
    expect(deliveryDurationRecords[0]?.[1]["openclaw.channel"]).toBe("matrix");
    expect(deliveryDurationRecords[0]?.[1]["openclaw.delivery.kind"]).toBe("text");
    expect(deliveryDurationRecords[0]?.[1]["openclaw.outcome"]).toBe("completed");
    expect(deliveryDurationRecords[1]?.[0]).toBe(40);
    expect(deliveryDurationRecords[1]?.[1]["openclaw.channel"]).toBe("discord");
    expect(deliveryDurationRecords[1]?.[1]["openclaw.delivery.kind"]).toBe("media");
    expect(deliveryDurationRecords[1]?.[1]["openclaw.outcome"]).toBe("error");
    expect(deliveryDurationRecords[1]?.[1]["openclaw.errorCategory"]).toBe("TypeError");

    const deliverySpanCalls = telemetryState.tracer.startSpan.mock.calls.filter(
      (call) => call[0] === "openclaw.message.delivery",
    );
    expect(deliverySpanCalls).toHaveLength(2);
    const firstDeliveryOptions = deliverySpanCalls[0]?.[1] as
      | { attributes?: Record<string, unknown>; startTime?: unknown }
      | undefined;
    expect(firstDeliveryOptions?.attributes).toMatchObject({
      "openclaw.channel": "matrix",
      "openclaw.delivery.kind": "text",
      "openclaw.outcome": "completed",
      "openclaw.delivery.result_count": 1,
    });
    expect(firstDeliveryOptions?.startTime).toBeTypeOf("number");
    const secondDeliveryOptions = deliverySpanCalls[1]?.[1] as
      | { attributes?: Record<string, unknown>; startTime?: unknown }
      | undefined;
    expect(secondDeliveryOptions?.attributes).toMatchObject({
      "openclaw.channel": "discord",
      "openclaw.delivery.kind": "media",
      "openclaw.outcome": "error",
      "openclaw.errorCategory": "TypeError",
    });
    expect(secondDeliveryOptions?.startTime).toBeTypeOf("number");
    for (const call of deliverySpanCalls) {
      const options = call[1] as { attributes?: Record<string, unknown>; startTime?: unknown };
      expectAbsent(options.attributes, "openclaw.chatId", "openclaw.sessionKey");
      expectAbsent(options.attributes, "openclaw.messageId", "openclaw.conversationId");
      expectAbsent(options.attributes, "openclaw.content", "openclaw.to");
      expect(options.startTime).toBeTypeOf("number");
    }
    const errorSpan = telemetryState.spans.find(
      (span) => span.name === "openclaw.message.delivery" && span.setStatus.mock.calls.length > 0,
    );
    expect(errorSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "TypeError",
    });
  });

  test.each([false, true])(
    "exports model/tool content only with capture=%s",
    async (captureContent) => {
      await startServiceFixture(["traces", "metrics"], { captureContent });
      emitTrustedModelCallCompletedWithContent({
        inputMessages: [
          captureContent ? "use key sk-1234567890abcdef1234567890abcdef" : "private user prompt",
        ], // pragma: allowlist secret
        outputMessages: [captureContent ? "model reply" : "private model reply"],
        systemPrompt: captureContent ? "system prompt" : "private system prompt",
      });
      emitTrustedToolExecutionCompletedWithContent(
        {
          toolInput: captureContent ? "tool input" : "private tool input",
          toolOutput: captureContent
            ? `${"x".repeat(4077)} Bearer ${"a".repeat(80)}`
            : "private tool output", // pragma: allowlist secret
        },
        { toolCallId: "tool-1" },
      );
      await flushDiagnosticEvents();
      const model = startedSpanOptions("openclaw.model.call");
      const tool = startedSpanOptions("openclaw.tool.execution");
      const modelAttrs = model?.attributes;
      const toolAttrs = tool?.attributes;
      expectAbsent(modelAttrs, "openclaw.content.system_prompt");
      expect(toolAttrs).toMatchObject({
        "gen_ai.tool.call.id": "tool-1",
        "gen_ai.operation.name": "execute_tool",
      });
      if (captureContent) {
        expect(modelAttrs?.["openclaw.content.output_messages"]).toBe("model reply");
        expect(String(modelAttrs?.["openclaw.content.input_messages"])).not.toContain(
          "sk-1234567890abcdef1234567890abcdef",
        ); // pragma: allowlist secret
        expect(toolAttrs?.["openclaw.content.tool_input"]).toBe("tool input");
        expect(toolAttrs?.["gen_ai.tool.call.arguments"]).toBe(
          toolAttrs?.["openclaw.content.tool_input"],
        );
        expect(typeof toolAttrs?.["openclaw.content.tool_output"]).toBe("string");
        expect(String(toolAttrs?.["openclaw.content.tool_output"]).length).toBeLessThanOrEqual(
          MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS + OTEL_TRUNCATED_SUFFIX_MAX_CHARS,
        );
        expect(String(toolAttrs?.["openclaw.content.tool_output"])).not.toContain("a".repeat(11));
        expect(toolAttrs?.["gen_ai.tool.call.result"]).toBe(
          toolAttrs?.["openclaw.content.tool_output"],
        );
      } else {
        for (const key of ["input_messages", "output_messages"]) {
          expect(Object.hasOwn(modelAttrs ?? {}, `openclaw.content.${key}`)).toBe(false);
        }
        for (const key of [
          "openclaw.content.tool_input",
          "openclaw.content.tool_output",
          "gen_ai.tool.call.arguments",
          "gen_ai.tool.call.result",
        ]) {
          expect(Object.hasOwn(toolAttrs ?? {}, key)).toBe(false);
        }
        expect(model?.startTime).toBeTypeOf("number");
        expect(tool?.startTime).toBeTypeOf("number");
      }
    },
  );

  test("exports Phoenix-readable GenAI prompt, output, and tool definition attributes", async () => {
    const attrs = await captureModelContent({
      inputMessages: [
        { role: "user", content: "what changed?", timestamp: 1 },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "lookup",
              arguments: { q: "trace" },
              extraField: "leaked",
            },
          ],
        },
        { role: "toolResult", toolCallId: "call-1", content: { rows: 1 } },
      ],
      outputMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "the trace changed" }],
          stopReason: "stop",
        },
      ],
      systemPrompt: "be exact",
      toolDefinitions: [
        { name: "lookup", description: "Lookup data", parameters: { type: "object" } },
      ],
    });

    expectAbsent(attrs, "gen_ai.system_instructions");
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.input.messages"))).toEqual([
      { role: "user", parts: [{ type: "text", content: "what changed?" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            id: "call-1",
            name: "lookup",
            arguments: { q: "trace" },
          },
        ],
      },
      {
        role: "tool",
        parts: [{ type: "tool_call_response", id: "call-1", response: { rows: 1 } }],
      },
    ]);
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.output.messages"))).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "the trace changed" }],
        finish_reason: "stop",
      },
    ]);
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.tool.definitions"))).toEqual([
      {
        type: "function",
        name: "lookup",
        description: "Lookup data",
        parameters: { type: "object" },
      },
    ]);
    expect(attrs).toMatchObject({
      "input.mime_type": "application/json",
      "output.mime_type": "application/json",
    });
  });

  test("never exports provider-internal thinking payloads in model message attributes", async () => {
    const attrs = await captureModelContent(
      {
        inputMessages: [
          {
            role: "assistant",
            reasoning_content: "input-message-internal-canary",
            reasoning_details: [{ text: "input-details-internal-canary" }],
            content: [
              { type: "thinking", thinking: "input-internal-canary" },
              { type: "reasoning", content: "input-part-internal-canary" },
              {
                type: "text",
                text: "visible input",
                textSignature: "input-text-signature-internal-canary",
              },
            ],
          },
        ],
        outputMessages: [
          {
            role: "assistant",
            reasoning: "output-message-internal-canary",
            reasoning_text: "output-text-internal-canary",
            content: [
              { type: "redacted_thinking", data: "output-internal-canary" },
              { type: "text", text: "visible output" },
              {
                type: "toolCall",
                id: "tool-1",
                name: "lookup",
                arguments: { query: "visible" },
                thoughtSignature: "output-thought-signature-internal-canary",
              },
            ],
          },
        ],
      },
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    );

    const internalCanaries = [
      "input-internal-canary",
      "input-message-internal-canary",
      "input-details-internal-canary",
      "input-part-internal-canary",
      "output-internal-canary",
      "output-message-internal-canary",
      "output-text-internal-canary",
      "input-text-signature-internal-canary",
      "output-thought-signature-internal-canary",
    ];
    for (const key of [
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "openclaw.content.input_messages",
      "openclaw.content.output_messages",
    ]) {
      const value = stringAttribute(attrs, key);
      for (const canary of internalCanaries) {
        expect(value).not.toContain(canary);
      }
    }
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.input.messages"))[0]?.parts).toEqual([
      { type: "text", content: "visible input" },
    ]);
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.output.messages"))[0]?.parts).toEqual([
      { type: "text", content: "visible output" },
      {
        type: "tool_call",
        id: "tool-1",
        name: "lookup",
        arguments: { query: "visible" },
      },
    ]);
    expect(
      JSON.parse(stringAttribute(attrs, "openclaw.content.input_messages"))[0]?.content[0],
    ).toEqual({ type: "reasoning", redacted: true });
    expect(
      JSON.parse(stringAttribute(attrs, "openclaw.content.input_messages"))[0]?.content[1],
    ).toEqual({ type: "reasoning", redacted: true });
    expect(
      JSON.parse(stringAttribute(attrs, "openclaw.content.output_messages"))[0]?.content[0],
    ).toEqual({ type: "reasoning", redacted: true });
    expect(
      JSON.parse(stringAttribute(attrs, "openclaw.content.input_messages"))[0]?.content[2],
    ).toEqual({ type: "text", text: "visible input" });
    expect(
      JSON.parse(stringAttribute(attrs, "openclaw.content.output_messages"))[0]?.content[2],
    ).toEqual({
      type: "toolCall",
      id: "tool-1",
      name: "lookup",
      arguments: { query: "visible" },
    });
  });

  test.each([
    {
      name: "explicit and legacy text responses",
      inputMessages: [
        {
          role: "tool",
          parts: [
            {
              type: "tool_call_response",
              id: "call-1",
              result: [
                { type: "text", text: "first line" },
                { type: "text", text: "second line" },
              ],
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-2",
          content: [
            { type: "text", text: "alpha" },
            { type: "text", text: "beta" },
          ],
        },
      ],
      expected: [
        {
          role: "tool",
          parts: [
            { type: "tool_call_response", id: "call-1", response: "first line\nsecond line" },
          ],
        },
        {
          role: "tool",
          parts: [{ type: "tool_call_response", id: "call-2", response: "alpha\nbeta" }],
        },
      ],
    },
    {
      name: "oversized pure-text response",
      inputMessages: [
        {
          role: "toolResult",
          toolCallId: "call-1",
          content: Array.from({ length: 201 }, (_, index) => ({
            type: "text",
            text: `line-${index}`,
          })),
        },
      ],
      expected: [
        {
          role: "tool",
          parts: [
            {
              type: "tool_call_response",
              id: "call-1",
              response: `${Array.from({ length: 200 }, (_, index) => `line-${index}`).join("\n")}\n...(1 more text parts omitted)`,
            },
          ],
        },
      ],
    },
  ])("serializes $name as semconv response text", async ({ inputMessages, expected }) => {
    const attrs = await captureModelContent({ inputMessages });
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.input.messages"))).toEqual(expected);
  });

  test("keeps single oversized GenAI messages and tool definitions parseable", async () => {
    // The 8,192-character candidate budget leaves an 8,178-character text prefix;
    // place a surrogate pair across that boundary so serialized JSON must stay valid.
    const surrogateBoundaryPrefix = "x".repeat(8177);
    const attrs = await captureModelContent({
      inputMessages: [
        {
          role: "user",
          content: `${surrogateBoundaryPrefix}🚀${"y".repeat(
            MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS,
          )}`,
        },
      ],
      toolDefinitions: [
        {
          name: "huge_schema",
          description: "Huge schema",
          parameters: {
            type: "object",
            properties: {
              payload: {
                type: "string",
                description: "x".repeat(MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS),
              },
            },
          },
        },
      ],
    });

    const genAiInput = stringAttribute(attrs, "gen_ai.input.messages");
    const toolDefinitions = stringAttribute(attrs, "gen_ai.tool.definitions");
    expect(genAiInput.length).toBeLessThanOrEqual(MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS);
    expect(toolDefinitions.length).toBeLessThanOrEqual(MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS);
    expect(genAiInput).not.toContain("\\ud83d");
    expect(JSON.parse(genAiInput)).toEqual([
      {
        role: "user",
        parts: [
          {
            type: "text",
            content: `${surrogateBoundaryPrefix}...(truncated)`,
          },
        ],
      },
    ]);
    expect(JSON.parse(toolDefinitions)[0]).toMatchObject({
      type: "function",
      name: "huge_schema",
      parameters: {
        type: "object",
      },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
