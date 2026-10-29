import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import {
  collectTestMetrics,
  installRealOtelSdkTestHarness,
  installTestMeter,
} from "./service.real-sdk.test-support.js";
import { RUN_FIXTURE, startOtelService } from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness();
type RunCompletedEvent = Extract<
  Parameters<typeof emitTrustedDiagnosticEvent>[0],
  { type: "run.completed" }
>;

type Interruption = Pick<RunCompletedEvent, "abortCause" | "timeoutPhase" | "timeoutSource">;
test.each<[Interruption, boolean]>([
  [{}, true],
  [{ abortCause: "user_abort" }, true],
  [{ abortCause: "timeout", timeoutPhase: "tool_execution", timeoutSource: "idle" }, true],
  [
    {
      abortCause: "private-cause",
      timeoutPhase: "private-phase",
      timeoutSource: "private-source",
    } as unknown as Interruption,
    false,
  ],
])("exports only bounded interruption facts on spans: %j", async (interruption, trusted) => {
  const { reader } = installTestMeter();
  await startOtelService({ traces: true, metrics: true });
  const outcome = interruption.abortCause ? "aborted" : "completed";
  const emit = trusted ? emitTrustedDiagnosticEvent : emitDiagnosticEvent;
  emit({
    type: "run.completed",
    ...RUN_FIXTURE,
    durationMs: 100,
    outcome,
    ...interruption,
  });
  await waitForDiagnosticEventsDrained();

  const attributes = sdk.exporter
    .getFinishedSpans()
    .find((span) => span.name === "openclaw.run")?.attributes;
  expect(attributes).toMatchObject({ "openclaw.outcome": outcome });
  const duration = (await collectTestMetrics(reader)).find(
    (metric) => metric.descriptor.name === "openclaw.run.duration_ms",
  );
  expect(duration?.dataPoints).toHaveLength(1);
  for (const [field, attribute] of [
    ["abortCause", "openclaw.run.abort_cause"],
    ["timeoutPhase", "openclaw.run.timeout_phase"],
    ["timeoutSource", "openclaw.run.timeout_source"],
  ] as const) {
    expect(attributes?.[attribute]).toBe(trusted ? interruption[field] : undefined);
    expect(duration?.dataPoints[0]?.attributes).not.toHaveProperty(attribute);
  }
  expect(JSON.stringify(attributes)).not.toContain("private-");
});
