import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { startOtelService, stopStartedOtelServices } from "./service.test-helpers.js";

installRealOtelSdkTestHarness();
const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});

test("exports trusted session list retirements and base misses as bounded counters", async () => {
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
  });
  const meterProvider = new MeterProvider({ readers: [reader] });
  metrics.disable();
  metrics.setGlobalMeterProvider(meterProvider);
  try {
    await startOtelService({ traces: false, metrics: true });
    const causes = [
      "projection-revision",
      "config",
      "identity",
      "selection-reset",
      "view-evicted",
      "history-evicted",
    ] as const;
    for (const cause of causes) {
      const event = { type: "sessions.list.baseline.retired", cause } as const;
      emit(event);
      emitDiagnosticEvent(event);
    }
    for (const reason of ["unknown-base", "all-rows-changed"] as const) {
      const event = {
        type: "gateway.rpc",
        method: "sessions.list",
        phase: "response",
        outcome: "ok",
        durationMs: 1,
        sessionsList: {
          clientKind: "openclaw-control-ui",
          source: "wire",
          callerSource: "sidebar",
          rowMode: "sidebar",
          filter: "general",
          rowsOutcome: "full-with-base",
          baseMissReason: reason,
        },
      } as const;
      emit(event);
      emitDiagnosticEvent(event);
      emit({ ...event, firstResponse: false });
      emit({ ...event, outcome: "unavailable" });
    }
    await waitForDiagnosticEventsDrained();
    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    const recorded = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    expect(
      recorded.find(
        (metric) => metric.descriptor.name === "openclaw.sessions.list.baseline_retirements",
      )?.dataPoints,
    ).toEqual(causes.map((cause) => expect.objectContaining({ attributes: { cause }, value: 1 })));
    expect(
      recorded.find((metric) => metric.descriptor.name === "openclaw.sessions.list.base_misses")
        ?.dataPoints,
    ).toEqual(
      ["unknown-base", "all-rows-changed"].map((reason) =>
        expect.objectContaining({ attributes: { reason }, value: 1 }),
      ),
    );
  } finally {
    await stopStartedOtelServices();
    await meterProvider.shutdown();
  }
});
