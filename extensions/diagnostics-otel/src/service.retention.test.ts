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

test("exports trusted session-list retention gauges and clears them on retirement", async () => {
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
        .filter((metric) => metric.descriptor.name.startsWith("openclaw.sessions.list.retained_"))
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
    for (const emitUntrusted of [emitDiagnosticEvent, emitInternalDiagnosticEventForTest]) {
      emitUntrusted({
        type: "sessions.list.retention",
        views: 99,
        refs: 999,
        estimatedBytes: 99_999,
      });
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
    });
    emit({ type: "sessions.list.retention", views: 0, refs: 0, estimatedBytes: 0 });
    const cleared = await collectRetention();
    expect(Object.keys(cleared)).toHaveLength(3);
    for (const metric of Object.values(cleared)) {
      expect(metric.points).toEqual([{ attributes: {}, value: 0 }]);
    }
  } finally {
    await service.stop?.(ctx);
    await meterProvider.shutdown();
  }
});
