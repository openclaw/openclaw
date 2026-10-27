import { metrics } from "@opentelemetry/api";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { emitInternalDiagnosticEventForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, test } from "vitest";
import { createTestMeter, installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { startOtelService } from "./service.test-helpers.js";

installRealOtelSdkTestHarness();
const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});
const gauge = (unit: string, value: number) => [unit, [[{}, value]]];
const resetCauses = ["close", "delivery-lost", "generation", "evicted", "projection"] as const;

test("exports trusted session retention gauges and wire baseline reset counts", async () => {
  const { reader, meterProvider } = createTestMeter();
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
        .filter(({ descriptor: { name } }) =>
          /^openclaw\.(sessions\.list\.retained_|session_event_rows_(retained_|reset$))/.test(name),
        )
        .map(
          ({ descriptor: { name, unit }, dataPoints }) =>
            [
              name,
              [unit, dataPoints.map(({ attributes, value }) => [attributes, value] as const)],
            ] as const,
        ),
    );
  };
  try {
    emit({ type: "sessions.list.retention", views: 3, refs: 17, estimatedBytes: 3_504 });
    emit({ type: "sessions.event.retention", entries: 25_600, estimatedBytes: 24_985_600 });
    for (const cause of resetCauses) {
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
      "openclaw.sessions.list.retained_views": gauge("1", 3),
      "openclaw.sessions.list.retained_refs": gauge("1", 17),
      "openclaw.sessions.list.retained_bytes": gauge("By", 3_504),
      "openclaw.session_event_rows_retained_entries": gauge("1", 25_600),
      "openclaw.session_event_rows_retained_bytes": gauge("By", 24_985_600),
      "openclaw.session_event_rows_reset": [
        "1",
        ["close", "delivery-lost", "generation", "evicted", "projection"].map((cause) => [
          { cause },
          5,
        ]),
      ],
    });
    emit({ type: "sessions.list.retention", views: 0, refs: 0, estimatedBytes: 0 });
    emit({ type: "sessions.event.retention", entries: 0, estimatedBytes: 0 });
    const cleared = await collectRetention();
    expect(Object.keys(cleared)).toHaveLength(6);
    for (const [name, [, points]] of Object.entries(cleared)) {
      if (name === "openclaw.session_event_rows_reset") {
        expect(points.map(([, value]) => value)).toEqual([5, 5, 5, 5, 5]);
        continue;
      }
      expect(points).toEqual([[{}, 0]]);
    }
  } finally {
    await service.stop?.(ctx);
    await meterProvider.shutdown();
  }
});
