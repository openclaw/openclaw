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
import { emitInternalDiagnosticEventForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { startOtelService } from "./service.test-helpers.js";

installRealOtelSdkTestHarness();
const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});

test("exports trusted session retention gauges and wire baseline reset counts", async () => {
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
  });
  const meterProvider = new MeterProvider({ readers: [reader] });
  metrics.disable();
  metrics.setGlobalMeterProvider(meterProvider);
  const { service, ctx } = await startOtelService({ metrics: true });
  const collectRetention = async () => {
    await waitForDiagnosticEventsDrained();
    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    return Object.fromEntries(
      resourceMetrics.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .filter(
          (metric) =>
            metric.descriptor.name.startsWith("openclaw.sessions.list.retained_") ||
            metric.descriptor.name.startsWith("openclaw.session_event_rows_retained_") ||
            metric.descriptor.name === "openclaw.session_event_rows_reset",
        )
        .map(
          (metric) =>
            [
              metric.descriptor.name,
              {
                unit: metric.descriptor.unit,
                points: metric.dataPoints.map(({ attributes, value }) => ({ attributes, value })),
              },
            ] as const,
        ),
    );
  };
  try {
    emit({ type: "sessions.list.retention", views: 3, refs: 17, estimatedBytes: 3_504 });
    emit({ type: "sessions.event.retention", entries: 25_600, estimatedBytes: 24_985_600 });
    for (const cause of [
      "close",
      "delivery-lost",
      "generation",
      "evicted",
      "projection",
    ] as const) {
      emit({ type: "sessions.event.rows.reset", cause, count: 3 });
      emit({ type: "sessions.event.rows.reset", cause, count: 2 });
    }
    for (const emitUntrusted of [emitDiagnosticEvent, emitInternalDiagnosticEventForTest]) {
      emitUntrusted({
        type: "sessions.list.retention",
        views: 99,
        refs: 999,
        estimatedBytes: 99_999,
      });
      emitUntrusted({ type: "sessions.event.retention", entries: 99_999, estimatedBytes: 99_999 });
      emitUntrusted({ type: "sessions.event.rows.reset", cause: "close", count: 99 });
    }
    expect(await collectRetention()).toEqual({
      "openclaw.sessions.list.retained_views": {
        unit: "1",
        points: [{ attributes: {}, value: 3 }],
      },
      "openclaw.sessions.list.retained_refs": {
        unit: "1",
        points: [{ attributes: {}, value: 17 }],
      },
      "openclaw.sessions.list.retained_bytes": {
        unit: "By",
        points: [{ attributes: {}, value: 3_504 }],
      },
      "openclaw.session_event_rows_retained_entries": {
        unit: "1",
        points: [{ attributes: {}, value: 25_600 }],
      },
      "openclaw.session_event_rows_retained_bytes": {
        unit: "By",
        points: [{ attributes: {}, value: 24_985_600 }],
      },
      "openclaw.session_event_rows_reset": {
        unit: "1",
        points: [
          { attributes: { cause: "close" }, value: 5 },
          { attributes: { cause: "delivery-lost" }, value: 5 },
          { attributes: { cause: "generation" }, value: 5 },
          { attributes: { cause: "evicted" }, value: 5 },
          { attributes: { cause: "projection" }, value: 5 },
        ],
      },
    });
    emit({ type: "sessions.list.retention", views: 0, refs: 0, estimatedBytes: 0 });
    emit({ type: "sessions.event.retention", entries: 0, estimatedBytes: 0 });
    const cleared = await collectRetention();
    expect(Object.keys(cleared)).toHaveLength(6);
    for (const [name, metric] of Object.entries(cleared)) {
      if (name === "openclaw.session_event_rows_reset") {
        expect(metric.points).toHaveLength(5);
        expect(metric.points.map(({ value }) => value)).toEqual([5, 5, 5, 5, 5]);
        continue;
      }
      expect(metric.points).toEqual([{ attributes: {}, value: 0 }]);
    }
  } finally {
    await service.stop?.(ctx);
    await meterProvider.shutdown();
  }
});
