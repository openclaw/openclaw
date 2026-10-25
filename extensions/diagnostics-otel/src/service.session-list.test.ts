import { metrics } from "@opentelemetry/api";
import type { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import {
  collectTestMetrics,
  createTestMeter,
  installRealOtelSdkTestHarness,
  installTestMeter,
} from "./service.real-sdk.test-support.js";
import { startOtelService, stopStartedOtelServices } from "./service.test-helpers.js";

installRealOtelSdkTestHarness();
const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});

test("preserves cumulative session-row totals across restarts, isolated by provider and prefix", async () => {
  const first = installTestMeter();
  const sample = (calls: number, resets: number) =>
    emit({
      type: "diagnostic.memory.sample",
      memory: {
        rssBytes: 100,
        heapUsedBytes: 40,
        heapTotalBytes: 80,
        externalBytes: 10,
        arrayBuffersBytes: 5,
        sessionRowSelections: {
          selections: [{ kind: "parent", task: "control-ui-pr", calls, rows: calls * 3 }],
          resets,
        },
      },
    });
  const expectTotals = async (
    reader: PeriodicExportingMetricReader,
    calls: number,
    resets: number,
    prefix = "openclaw.",
  ) => {
    await waitForDiagnosticEventsDrained();
    const recorded = await collectTestMetrics(reader, `${prefix}session.row.`);
    expect(
      Object.fromEntries(
        recorded.map((metric) => [
          metric.descriptor.name,
          metric.dataPoints.map((point) => point.value),
        ]),
      ),
    ).toEqual({
      [`${prefix}session.row.selections`]: [calls],
      [`${prefix}session.row.selection.rows`]: [calls * 3],
      [`${prefix}session.row.selection.resets`]: [resets],
    });
  };
  await startOtelService({ traces: false, metrics: true });
  sample(4, 2);
  await expectTotals(first.reader, 4, 2);
  await stopStartedOtelServices();

  await startOtelService({ traces: false, metrics: true });
  sample(6, 3);
  sample(6, 3);
  await expectTotals(first.reader, 6, 3);
  await stopStartedOtelServices();

  await startOtelService({
    traces: false,
    metrics: true,
    configure: (ctx) => {
      ctx.config.diagnostics!.otel!.metricNamePrefix = "alternate.";
    },
  });
  sample(6, 3);
  await expectTotals(first.reader, 6, 3, "alternate.");
  await stopStartedOtelServices();

  const second = installTestMeter();
  await startOtelService({ traces: false, metrics: true });
  sample(8, 4);
  await expectTotals(second.reader, 8, 4);
});

test("exports trusted session list retirements and base misses as bounded counters", async () => {
  const { reader, meterProvider } = createTestMeter();
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
