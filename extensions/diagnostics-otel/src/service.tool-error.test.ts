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
import { startOtelService } from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness({ replaceTraceProvider: true });

const toolError = {
  type: "tool.execution.error",
  runId: "run-tool-error",
  toolName: "bash",
  toolCallId: "call-tool-error",
  durationMs: 20,
  errorCategory: "codex_native_tool_error",
} as const;

function toolSpanAttributes() {
  const span = sdk.exporter
    .getFinishedSpans()
    .find((candidate) => candidate.name === "openclaw.tool.execution");
  expect(span).toBeDefined();
  return span?.attributes ?? {};
}

test("exports why a tool failed on its error span, not on its metrics", async () => {
  const { reader } = installTestMeter();
  await startOtelService({ traces: true, metrics: true });

  emitTrustedDiagnosticEventWithPrivateData(
    { ...toolError, terminalReason: "timed_out", exitCode: 124 },
    {},
  );
  await waitForDiagnosticEventsDrained();

  expect(toolSpanAttributes()).toMatchObject({
    "openclaw.errorCategory": "codex_native_tool_error",
    "openclaw.tool.terminal_reason": "timed_out",
    "openclaw.tool.exit_code": 124,
  });
  // Metric labels stay bounded: the reason and exit code are span-only.
  const [duration] = await collectTestMetrics(reader, "openclaw.tool.execution.duration_ms");
  const labels = duration?.dataPoints.map((point) => Object.keys(point.attributes)) ?? [];
  expect(labels).toHaveLength(1);
  expect(labels[0]).toContain("openclaw.errorCategory");
  expect(labels[0]).not.toContain("openclaw.tool.terminal_reason");
  expect(labels[0]).not.toContain("openclaw.tool.exit_code");
});

test("exports only known tool terminal reasons and integer exit codes", async () => {
  await startOtelService({ traces: true });

  // Plugins can emit tool.execution.error with arbitrary values.
  emitDiagnosticEvent({ ...toolError, terminalReason: "rm -rf /secret" as never, exitCode: 1.5 });
  await waitForDiagnosticEventsDrained();

  const attributes = toolSpanAttributes();
  expect(attributes["openclaw.tool.terminal_reason"]).toBe("other");
  expect(Object.hasOwn(attributes, "openclaw.tool.exit_code")).toBe(false);
});
