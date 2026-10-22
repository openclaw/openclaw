import {
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { CHILD_SPAN_ID, createTestTrace, startOtelService } from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness({ replaceTraceProvider: true });

const finishedSpanAttributes = (name: string) =>
  sdk.exporter.getFinishedSpans().find((span) => span.name === name)?.attributes;

const content = { userPrompt: "run the task", finalResponse: "task complete" };
const run = {
  runId: "run-capture",
  provider: "anthropic",
  model: "claude-opus-4-6",
  // A real W3C identity is required to pair lifecycle spans.
  trace: createTestTrace(CHILD_SPAN_ID),
};
const harness = { ...run, harnessId: "claude-cli" };
const message = {
  type: "message.processed",
  channel: "webchat",
  sessionId: "session-capture",
  durationMs: 5,
  outcome: "completed",
} as const;

async function finish({ service, ctx }: Awaited<ReturnType<typeof startOtelService>>) {
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);
}

function expectContent(name: string) {
  expect(finishedSpanAttributes(name)).toMatchObject({
    "input.value": content.userPrompt,
    "output.value": content.finalResponse,
  });
}

function expectNoContent(name: string) {
  const attributes = finishedSpanAttributes(name) ?? {};
  expect(Object.hasOwn(attributes, "input.value")).toBe(false);
  expect(Object.hasOwn(attributes, "output.value")).toBe(false);
}

function emitHarnessContent(startupPrompt = true) {
  emitTrustedDiagnosticEventWithPrivateData(
    { type: "harness.run.started", ...harness },
    startupPrompt ? { harnessContent: { userPrompt: content.userPrompt } } : undefined,
  );
  emitTrustedDiagnosticEventWithPrivateData(
    { type: "harness.run.completed", ...harness, durationMs: 100, outcome: "completed" },
    { harnessContent: startupPrompt ? { finalResponse: content.finalResponse } : content },
  );
}

function emitRunContent() {
  emitTrustedDiagnosticEventWithPrivateData({ type: "run.started", ...run }, undefined);
  emitTrustedDiagnosticEventWithPrivateData(
    { type: "run.completed", ...run, durationMs: 60, outcome: "completed" },
    { messageContent: content },
  );
}

const captures = {
  message: () => {
    emitTrustedDiagnosticEventWithPrivateData(message, { messageContent: content });
    return "openclaw.message.processed";
  },
  harness: () => {
    emitHarnessContent();
    return "openclaw.harness.run";
  },
  run: () => {
    emitRunContent();
    return "openclaw.run";
  },
};
test.each([
  ["message", true],
  ["message", false],
  ["harness", true],
  ["harness", false],
  ["run", true],
  ["run", false],
] as const)("exports %s content only when captureContent=%s", async (kind, captureContent) => {
  const started = await startOtelService({ traces: true, captureContent });
  const name = captures[kind]();
  await finish(started);
  if (captureContent) {
    expectContent(name);
  } else {
    expectNoContent(name);
  }
});

test("consumes the completion-time prompt on harness spans when startup carried none", async () => {
  const started = await startOtelService({ traces: true, captureContent: true });
  emitHarnessContent(false);
  await finish(started);
  expectContent("openclaw.harness.run");
});

test("exports captured harness response on harness error spans under captureContent", async () => {
  const started = await startOtelService({ traces: true, captureContent: true });
  const failedHarness = { ...harness, runId: "run-capture-error" };
  emitTrustedDiagnosticEventWithPrivateData(
    { type: "harness.run.started", ...failedHarness },
    undefined,
  );
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "harness.run.error",
      ...failedHarness,
      phase: "cleanup",
      errorCategory: "other",
      durationMs: 100,
    },
    { harnessContent: content },
  );
  await finish(started);
  expectContent("openclaw.harness.run");
});
