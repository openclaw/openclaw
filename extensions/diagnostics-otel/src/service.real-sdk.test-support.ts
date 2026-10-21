import { context, diag, DiagLogLevel, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resetDiagnosticEventsForTest } from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach } from "vitest";
import {
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
export function installRealOtelSdkTestHarness() {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let restoreEnv: () => void;
  let originalOtelGlobals: NonNullable<ReturnType<typeof registeredOtelGlobals>>;
  let originalLogsProvider: ReturnType<typeof logs.getLoggerProvider> | undefined;

  beforeEach(() => {
    restoreEnv = snapshotOtelEnv([PRELOAD_ENV, ...ENDPOINT_ENV_KEYS]);
    for (const key of ENDPOINT_ENV_KEYS) {
      delete process.env[key];
    }
    originalOtelGlobals = { ...registeredOtelGlobals() };
    originalLogsProvider = Object.hasOwn(globalThis, OTEL_GLOBAL_LOGS_KEY)
      ? logs.getLoggerProvider()
      : undefined;
    process.env[PRELOAD_ENV] = "1";
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
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
