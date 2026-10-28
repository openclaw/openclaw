import {
  emitTrustedDiagnosticEventWithPrivateData as emit,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { generateSecureToken } from "openclaw/plugin-sdk/secure-random-runtime";
import { expect, test, vi } from "vitest";
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

test("masks a registered prefix in emitted log content after earlier masks shrink it", async () => {
  const secret = generateSecureToken({
    bytes: 16,
    redact: true,
    prefix: 'synthetic-private-prefix password="',
  });
  const head = `${Array.from({ length: 5 }, () => `sk-${"A1b2C3d4".repeat(124)}`).join(" ")} `;
  const message = `${head}${"x".repeat(8152 - head.length)}${secret}${"z".repeat(100_000)}`;
  const { service, ctx } = await startOtelService({
    logs: true,
    logsExporter: "stdout",
    captureContent: true,
  });
  const writes: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    emit({ type: "log.record", level: "INFO", message }, undefined);
    await waitForDiagnosticEventsDrained();
    await service.stop?.(ctx);

    expect(writes).toHaveLength(1);
    const record = JSON.parse(writes.join(""));
    expect(record.signal).toBe("openclaw.diagnostic.log");
    expect(record.body).not.toContain("private-prefix");
    expect(record.body).toContain(`synthe…${secret.slice(-4)}`);
    expect(record.body).toContain("x".repeat(100));
    expect(record.body.length).toBeLessThanOrEqual(4096 + "...(truncated)".length);
  } finally {
    stdout.mockRestore();
  }
});
