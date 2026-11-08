import type { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import {
  collectTestMetrics,
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
          partitions: [],
          partitionRevisions: [],
          materialization: {
            created: 0,
            reused: 0,
            rebuilt: 0,
            skipped: 0,
            deepComparisons: 0,
            sampledFirstDifferences: {},
          },
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
  for (const [calls, resets, prefix] of [
    [4, 2, "openclaw."],
    [6, 3, "openclaw."],
    [6, 3, "alternate."],
  ] as const) {
    await startOtelService({
      traces: false,
      metrics: true,
      configure: (ctx) => {
        if (prefix === "alternate.") {
          ctx.config.diagnostics!.otel!.metricNamePrefix = prefix;
        }
      },
    });
    sample(calls, resets);
    if (calls === 6 && prefix === "openclaw.") {
      sample(calls, resets);
    }
    await expectTotals(first.reader, calls, resets, prefix);
    await stopStartedOtelServices();
  }

  const second = installTestMeter();
  await startOtelService({ traces: false, metrics: true });
  sample(8, 4);
  await expectTotals(second.reader, 8, 4);
});

test("exports trusted session list retirements and base misses as bounded counters", async () => {
  const { reader } = installTestMeter();
  await startOtelService({ traces: false, metrics: true });
  emit({ type: "sessions.list.baseline.retired", cause: "config" });
  emitDiagnosticEvent({ type: "sessions.list.baseline.retired", cause: "config" });
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
  const recorded = await collectTestMetrics(reader);
  const points = (name: string) =>
    recorded
      .find((metric) => metric.descriptor.name === `openclaw.sessions.list.${name}`)
      ?.dataPoints.map(({ attributes, value }) => [attributes, value]);
  expect(points("baseline_retirements")).toEqual([[{ cause: "config" }, 1]]);
  expect(points("base_misses")).toEqual(
    ["unknown-base", "all-rows-changed"].map((reason) => [{ reason }, 1]),
  );
});
