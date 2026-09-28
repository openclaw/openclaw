import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { describe, expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { startOtelService } from "./service.test-helpers.js";

describe("commentary trace events", () => {
  const sdk = installRealOtelSdkTestHarness();

  test.each([false, true])(
    "exports completed commentary with content capture %s",
    async (captureContent) => {
      await startOtelService({ traces: true, captureContent });
      const harness = { runId: "run-1", harnessId: "codex", trace: createDiagnosticTraceContext() };
      const run = { runId: harness.runId, trace: createChildDiagnosticTraceContext(harness.trace) };
      const commentary = {
        ...harness,
        type: "agent.commentary" as const,
        itemId: "private-item-id",
        sourceSequence: 7,
        sourceTimestampMs: Date.now(),
        textLength: 100,
        contentCaptured: true,
        contentTruncated: false,
      };
      const content = {
        modelContent: {
          outputMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Checking files. Bearer " + "a".repeat(80) }],
            },
          ],
        },
      };
      emitTrustedDiagnosticEvent({ ...harness, type: "harness.run.started" });
      emitTrustedDiagnosticEvent({ ...run, type: "run.started" });
      emitDiagnosticEvent(commentary);
      emitTrustedDiagnosticEventWithPrivateData(commentary, content);
      // run.completed is synchronous. Do not drain between it and the queued
      // harness completion: commentary must reach the real SDK before span.end.
      emitTrustedDiagnosticEvent({
        ...run,
        type: "run.completed",
        outcome: "completed",
        durationMs: 1,
      });
      emitTrustedDiagnosticEvent({
        ...harness,
        type: "harness.run.completed",
        outcome: "completed",
        durationMs: 1,
      });
      await waitForDiagnosticEventsDrained();
      const span = sdk.exporter
        .getFinishedSpans()
        .find((entry) => entry.name === "openclaw.harness.run");
      expect(span?.events).toHaveLength(1);
      expect(span?.events[0]).toMatchObject({
        name: "openclaw.agent.commentary",
        attributes: {
          "openclaw.harness.id": "codex",
          "openclaw.commentary.sequence": 7,
          "openclaw.commentary.text_length": 100,
        },
      });
      const exported = JSON.stringify(span?.events);
      expect(exported.includes("Checking files.")).toBe(captureContent);
      expect(exported).not.toContain("a".repeat(80));
      expect(exported).not.toContain("private-item-id");
      emitTrustedDiagnosticEventWithPrivateData(commentary, content);
      await waitForDiagnosticEventsDrained();
      expect(span?.events).toHaveLength(1);
      expect(sdk.exporter.getFinishedSpans()).toHaveLength(2);
    },
  );
});
