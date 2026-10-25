import { createServer, type IncomingHttpHeaders } from "node:http";
import { context, diag, metrics as otelMetrics, propagation, trace } from "@opentelemetry/api";
import { logs as otelLogs } from "@opentelemetry/api-logs";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticEventPayload,
  type DiagnosticTraceContext,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  onTrustedInternalDiagnosticEvent,
  registerDiagnosticTracePropagationBridge,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import type { ExporterHealthUpdate } from "./service-exporter-health.js";
import { createDiagnosticsOtelService } from "./service.js";

const OTEL_TEST_STATE_DIR = "/tmp/openclaw-diagnostics-otel-test";
export const OTEL_TEST_ENDPOINT = "http://otel-collector:4318";
export const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
export const SPAN_ID = "00f067aa0ba902b7";
export const CHILD_SPAN_ID = "1111111111111111";
export const GRANDCHILD_SPAN_ID = "2222222222222222";
export const TOOL_SPAN_ID = "3333333333333333";
export const MODEL_CALL_SPAN_ID = "4444444444444444";
export const MODEL_USAGE_SPAN_ID = "5555555555555555";
export const MODEL_FIXTURE = { provider: "openai", model: "gpt-5.4" } as const;
export const RUN_FIXTURE = { runId: "run-1", ...MODEL_FIXTURE } as const;
export const MODEL_CALL_FIXTURE = { ...RUN_FIXTURE, callId: "call-1" } as const;

const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});

export async function emitRealSdkSignals(generation = "1") {
  // Private providers require the real diagnostic recorders, not global APIs.
  const traceContext = createDiagnosticTraceContext();
  const modelTraceContext = createChildDiagnosticTraceContext(traceContext);
  const run = { ...RUN_FIXTURE, runId: `run-${generation}` };
  emit({ type: "run.started", ...run, trace: traceContext });
  const call = { ...run, callId: `call-${generation}`, trace: modelTraceContext };
  emit({ type: "model.call.started", ...call });
  emit({
    type: "model.call.completed",
    ...call,
    durationMs: 10,
    usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, total: 8 },
  });
  emit({
    type: "log.record",
    level: "INFO",
    message: `OTLP routing test ${generation}`,
    trace: traceContext,
  });
  emit({
    type: "run.completed",
    ...run,
    outcome: "completed",
    durationMs: 25,
    trace: traceContext,
  });
  await waitForDiagnosticEventsDrained();
  return traceContext;
}
type OtelConfig = NonNullable<
  NonNullable<OpenClawPluginServiceContext["config"]["diagnostics"]>["otel"]
>;
export type OtelContextFlags = Pick<
  OtelConfig,
  "traces" | "metrics" | "logs" | "protocol" | "logsExporter" | "captureContent" | "flushIntervalMs"
>;

type StartOtelServiceOptions = OtelContextFlags & {
  endpoint?: string;
  configure?: (ctx: OpenClawPluginServiceContext) => void;
};
type InternalDiagnosticListener = Parameters<
  NonNullable<OpenClawPluginServiceContext["internalDiagnostics"]>["onEvent"]
>[0];
export type ReportedExporterHealth = Omit<ExporterHealthUpdate, "exporter">;
type TrustedExporterInternalDiagnostics = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth?: (update: ReportedExporterHealth) => void;
};
type ModelUsageEventInput = Omit<
  Extract<DiagnosticEventPayload, { type: "model.usage" }>,
  "seq" | "ts"
>;

type StartedService = {
  service: ReturnType<typeof createDiagnosticsOtelService>;
  ctx: OpenClawPluginServiceContext;
};

const startedServices = new Set<StartedService>();
const exporterHealthReports = new WeakMap<OpenClawPluginServiceContext, ReportedExporterHealth[]>();

export function createOtelContext(
  endpoint: string,
  flags: OtelContextFlags = {},
): OpenClawPluginServiceContext {
  const reports: ReportedExporterHealth[] = [];
  const internalDiagnostics: TrustedExporterInternalDiagnostics = {
    emit: emitTrustedDiagnosticEventWithPrivateData,
    onEvent: onTrustedInternalDiagnosticEvent,
    registerTracePropagationBridge: registerDiagnosticTracePropagationBridge,
    reportExporterHealth: (update) => reports.push(update),
  };
  const ctx: OpenClawPluginServiceContext = {
    config: {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          endpoint,
          ...flags,
          protocol: flags.protocol ?? "http/protobuf",
          traces: flags.traces ?? false,
          metrics: flags.metrics ?? false,
          logs: flags.logs ?? false,
        },
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    stateDir: OTEL_TEST_STATE_DIR,
    internalDiagnostics,
  };
  exporterHealthReports.set(ctx, reports);
  return ctx;
}

export function getReportedExporterHealth(
  ctx: OpenClawPluginServiceContext,
): ReportedExporterHealth[] {
  return exporterHealthReports.get(ctx) ?? [];
}

export async function startOtelService({
  endpoint = OTEL_TEST_ENDPOINT,
  configure,
  ...flags
}: StartOtelServiceOptions = {}): Promise<StartedService> {
  const service = createDiagnosticsOtelService();
  const ctx = createOtelContext(endpoint, flags);
  configure?.(ctx);
  await service.start(ctx);
  const started = { service, ctx };
  startedServices.add(started);
  return started;
}

export async function startOtelServiceWithHostUsage() {
  let listener: InternalDiagnosticListener | undefined;
  const started = await startOtelService({
    traces: true,
    configure: (ctx) => {
      const internalDiagnostics = ctx.internalDiagnostics;
      if (!internalDiagnostics) {
        throw new Error("expected internal diagnostics for trusted OTel service");
      }
      const onEvent = internalDiagnostics.onEvent;
      ctx.internalDiagnostics = {
        ...internalDiagnostics,
        onEvent: (registeredListener) => {
          listener = registeredListener;
          return onEvent(registeredListener);
        },
      };
    },
  });
  if (!listener) {
    throw new Error("expected OTel service to register a diagnostics listener");
  }
  const registeredListener = listener;
  return {
    ...started,
    emitHostPluginUsage(event: ModelUsageEventInput, hostPluginId: string) {
      registeredListener({ ...event, seq: 1, ts: Date.now() }, { trusted: true, internal: true }, {
        hostPluginId,
      } as Parameters<InternalDiagnosticListener>[2] & {
        hostPluginId: string;
      });
    },
  };
}

export async function stopStartedOtelServices() {
  const services = [...startedServices];
  startedServices.clear();
  await Promise.all(services.map(({ service, ctx }) => Promise.resolve(service.stop?.(ctx))));
}

export async function startOtlpReceiver() {
  const requests: Array<{
    contentType: string | undefined;
    headers: IncomingHttpHeaders;
    method: string | undefined;
    url: string;
  }> = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push({
        contentType: request.headers["content-type"],
        headers: request.headers,
        method: request.method,
        url: request.url ?? "",
      });
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
  });
  const port = await listenOnLoopback(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
    },
  };
}

export function createTestTrace(spanId: string, parentSpanId?: string): DiagnosticTraceContext {
  return {
    traceId: TRACE_ID,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    traceFlags: "01",
  };
}

type OtelGlobals = {
  context?: Parameters<typeof context.setGlobalContextManager>[0];
  diag?: Parameters<typeof diag.setLogger>[0];
  metrics?: Parameters<typeof otelMetrics.setGlobalMeterProvider>[0];
  propagation?: Parameters<typeof propagation.setGlobalPropagator>[0];
  trace?: Parameters<typeof trace.setGlobalTracerProvider>[0];
};

export function registeredOtelGlobals(): OtelGlobals | undefined {
  return (globalThis as unknown as Record<symbol, OtelGlobals | undefined>)[
    Symbol.for("opentelemetry.js.api.1")
  ];
}

export function registeredOtelLogs(): unknown {
  return (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for("io.opentelemetry.js.api.logs")
  ];
}

export function clearOtelGlobals() {
  context.disable();
  otelLogs.disable();
  otelMetrics.disable();
  propagation.disable();
  trace.disable();
}

export function snapshotOtelEnv(keys: readonly string[]) {
  const original = keys.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export type MetricArgs = [
  name: string,
  value: number,
  attributes: unknown,
  position?: "first" | "last",
  omittedText?: string[],
];
export type MetricExpectation = [kind: "counter" | "histogram", ...MetricArgs];
export const counter = (...args: MetricArgs): MetricExpectation => ["counter", ...args];
export const histogram = (...args: MetricArgs): MetricExpectation => ["histogram", ...args];
