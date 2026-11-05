import {
  emitTrustedDiagnosticEventWithPrivateData as emit,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { CHILD_SPAN_ID, createTestTrace, startOtelService } from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness({ replaceTraceProvider: true });
const content = { userPrompt: "run the task", finalResponse: "task complete" };
const run = {
  runId: "run-capture",
  trace: createTestTrace(CHILD_SPAN_ID),
};
const harness = { ...run, harnessId: "claude-cli" };

test.each([
  ["message", true, false],
  ["message", false, false],
  ["run", true, false],
  ["run", false, false],
  ["harness", true, true],
  ["harness", false, true],
  ["harness", true, false],
  ["harness-error", true, false],
] as const)(
  "exports %s content with capture=%s, startup prompt=%s",
  async (kind, captureContent, startupPrompt) => {
    const { service, ctx } = await startOtelService({ traces: true, captureContent });
    let name: string;
    if (kind === "message") {
      emit(
        {
          type: "message.processed",
          channel: "webchat",
          durationMs: 5,
          outcome: "completed",
        },
        { messageContent: content },
      );
      name = "openclaw.message.processed";
    } else if (kind === "run") {
      emit({ type: "run.started", ...run }, undefined);
      emit(
        { type: "run.completed", ...run, durationMs: 60, outcome: "completed" },
        { messageContent: content },
      );
      name = "openclaw.run";
    } else {
      emit(
        { type: "harness.run.started", ...harness },
        startupPrompt ? { harnessContent: { userPrompt: content.userPrompt } } : undefined,
      );
      const privateData = {
        harnessContent: startupPrompt ? { finalResponse: content.finalResponse } : content,
      };
      const terminal =
        kind === "harness-error"
          ? ({ type: "harness.run.error", phase: "cleanup", errorCategory: "other" } as const)
          : ({ type: "harness.run.completed", outcome: "completed" } as const);
      emit({ ...harness, ...terminal, durationMs: 100 }, privateData);
      name = "openclaw.harness.run";
    }
    await waitForDiagnosticEventsDrained();
    await service.stop?.(ctx);
    const attributes = sdk.exporter
      .getFinishedSpans()
      .find((span) => span.name === name)?.attributes;
    if (captureContent) {
      expect(attributes).toMatchObject({
        "input.value": content.userPrompt,
        "output.value": content.finalResponse,
      });
    } else {
      expect(Object.hasOwn(attributes ?? {}, "input.value")).toBe(false);
      expect(Object.hasOwn(attributes ?? {}, "output.value")).toBe(false);
    }
  },
);
