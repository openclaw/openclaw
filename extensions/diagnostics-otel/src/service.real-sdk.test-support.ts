import { context, diag, DiagLogLevel, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  type MeterProviderOptions,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resetDiagnosticEventsForTest } from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, expect, onTestFinished } from "vitest";
import {
  clearOtelGlobals,
  registeredOtelGlobals,
  snapshotOtelEnv,
  stopStartedOtelServices,
} from "./service.test-helpers.js";

export const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
const ENDPOINT_ENV_KEYS = [
  "OTEL_SDK_DISABLED",
  "OTEL_LOG_LEVEL",
  ...["TRACES", "METRICS", "LOGS"].map((signal) => `OTEL_${signal}_EXPORTER`),
  ...["", "_TRACES", "_METRICS", "_LOGS"].flatMap((signal) =>
    ["ENDPOINT", "PROTOCOL", "CERTIFICATE", "CLIENT_CERTIFICATE", "CLIENT_KEY"].map(
      (option) => `OTEL_EXPORTER_OTLP${signal}_${option}`,
    ),
  ),
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TIMEOUT",
  "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
] as const;
const OTEL_GLOBAL_LOGS_KEY = Symbol.for("io.opentelemetry.js.api.logs");

// Real-SDK suites share one owner for global registrations, providers, and environment cleanup.
export function installRealOtelSdkTestHarness({
  env = [],
  owned = false,
  replaceTraceProvider = false,
}: { env?: readonly string[]; owned?: boolean; replaceTraceProvider?: boolean } = {}) {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let restoreEnv: () => void;
  let originalOtelGlobals: NonNullable<ReturnType<typeof registeredOtelGlobals>>;
  let originalLogsProvider: ReturnType<typeof logs.getLoggerProvider> | undefined;

  beforeEach(() => {
    restoreEnv = snapshotOtelEnv([PRELOAD_ENV, ...ENDPOINT_ENV_KEYS, ...env]);
    for (const key of [...ENDPOINT_ENV_KEYS, ...env]) {
      delete process.env[key];
    }
    originalOtelGlobals = { ...registeredOtelGlobals() };
    originalLogsProvider = Object.hasOwn(globalThis, OTEL_GLOBAL_LOGS_KEY)
      ? logs.getLoggerProvider()
      : undefined;
    process.env[PRELOAD_ENV] = "1";
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    if (replaceTraceProvider) {
      trace.disable();
    }
    trace.setGlobalTracerProvider(provider);
    if (owned) {
      clearOtelGlobals();
      process.env[PRELOAD_ENV] = "0";
    }
  });

  afterEach(async () => {
    await stopStartedOtelServices();
    await provider.shutdown();
    const currentGlobals = registeredOtelGlobals();
    if (currentGlobals?.context !== originalOtelGlobals.context) {
      context.disable();
      if (originalOtelGlobals.context) {
        context.setGlobalContextManager(originalOtelGlobals.context);
      }
    }
    if (currentGlobals?.propagation !== originalOtelGlobals.propagation) {
      propagation.disable();
      if (originalOtelGlobals.propagation) {
        propagation.setGlobalPropagator(originalOtelGlobals.propagation);
      }
    }
    if (currentGlobals?.metrics !== originalOtelGlobals.metrics) {
      metrics.disable();
      if (originalOtelGlobals.metrics) {
        metrics.setGlobalMeterProvider(originalOtelGlobals.metrics);
      }
    }
    if (currentGlobals?.trace !== originalOtelGlobals.trace) {
      trace.disable();
      if (originalOtelGlobals.trace) {
        trace.setGlobalTracerProvider(originalOtelGlobals.trace);
      }
    }
    if (Object.hasOwn(globalThis, OTEL_GLOBAL_LOGS_KEY) || originalLogsProvider) {
      logs.disable();
      if (originalLogsProvider) {
        logs.setGlobalLoggerProvider(originalLogsProvider);
      }
    }
    exporter.reset();
    restoreEnv();
    diag.disable();
    if (originalOtelGlobals.diag) {
      diag.setLogger(originalOtelGlobals.diag, {
        logLevel: DiagLogLevel.ALL,
        suppressOverrideMessage: true,
      });
    }
    resetDiagnosticEventsForTest();
  });

  return {
    get exporter() {
      return exporter;
    },
    get provider() {
      return provider;
    },
  };
}

export function createTestMeter(providerOptions: Pick<MeterProviderOptions, "views"> = {}) {
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    ...(providerOptions.views ? { exportIntervalMillis: 60_000 } : {}),
  });
  const meterProvider = new MeterProvider({ readers: [reader], ...providerOptions });
  return { reader, meterProvider, metricExporter };
}

export function installTestMeter(views?: MeterProviderOptions["views"]) {
  const { reader, meterProvider, metricExporter } = createTestMeter({ views });
  metrics.disable();
  expect(metrics.setGlobalMeterProvider(meterProvider)).toBe(true);
  if (!views) {
    onTestFinished(async () => {
      try {
        await stopStartedOtelServices();
      } finally {
        await meterProvider.shutdown();
      }
    });
  }
  return { reader, meterProvider, metricExporter };
}

export async function collectTestMetrics(reader: PeriodicExportingMetricReader, prefix = "") {
  const { resourceMetrics, errors } = await reader.collect();
  expect(errors).toEqual([]);
  return resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name.startsWith(prefix));
}

export function captureOtelDiagnostics(): string[] {
  const messages: string[] = [];
  const capture = (...args: unknown[]) => messages.push(args.map(String).join(" "));
  const ignore = () => {};
  diag.setLogger(
    { debug: ignore, error: capture, info: ignore, verbose: ignore, warn: capture },
    { logLevel: DiagLogLevel.ALL, suppressOverrideMessage: true },
  );
  return messages;
}
