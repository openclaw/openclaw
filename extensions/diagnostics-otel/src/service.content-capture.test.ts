import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  CHILD_SPAN_ID,
  createTestTrace,
  startOtelService,
  stopStartedOtelServices,
} from "./service.test-helpers.js";

const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
const OTEL_GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");

type OtelGlobalRegistrations = {
  trace?: Parameters<typeof trace.setGlobalTracerProvider>[0];
};

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let originalPreloaded: string | undefined;
let originalTraceProvider: OtelGlobalRegistrations["trace"];

function registeredOtelGlobals(): OtelGlobalRegistrations | undefined {
  return (globalThis as unknown as Record<symbol, OtelGlobalRegistrations | undefined>)[
    OTEL_GLOBAL_API_KEY
  ];
}

beforeEach(() => {
  originalPreloaded = process.env[PRELOAD_ENV];
  originalTraceProvider = registeredOtelGlobals()?.trace;
  if (originalTraceProvider) {
    trace.disable();
  }
  process.env[PRELOAD_ENV] = "1";
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await stopStartedOtelServices();
  await provider.shutdown();
  trace.disable();
  if (originalTraceProvider) {
    trace.setGlobalTracerProvider(originalTraceProvider);
  }
  if (originalPreloaded === undefined) {
    delete process.env[PRELOAD_ENV];
  } else {
    process.env[PRELOAD_ENV] = originalPreloaded;
  }
  resetDiagnosticEventsForTest();
});

function finishedSpanAttributes(name: string): Record<string, unknown> | undefined {
  const span = exporter.getFinishedSpans().find((finished) => finished.name === name);
  return span?.attributes as Record<string, unknown> | undefined;
}

test("exports captured message content on message spans under captureContent", async () => {
  const { service, ctx } = await startOtelService({ traces: true, captureContent: true });

  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "message.processed",
      channel: "webchat",
      sessionId: "session-capture",
      durationMs: 5,
      outcome: "completed",
    },
    { messageContent: { userPrompt: "what happened", finalResponse: "all good" } },
  );
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  expect(finishedSpanAttributes("openclaw.message.processed")?.["input.value"]).toBe(
    "what happened",
  );
  expect(finishedSpanAttributes("openclaw.message.processed")?.["output.value"]).toBe("all good");
});

test("keeps captured message content off spans without captureContent", async () => {
  const { service, ctx } = await startOtelService({ traces: true });

  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "message.processed",
      channel: "webchat",
      sessionId: "session-capture",
      durationMs: 5,
      outcome: "completed",
    },
    { messageContent: { userPrompt: "what happened", finalResponse: "all good" } },
  );
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const messageAttributes = finishedSpanAttributes("openclaw.message.processed") ?? {};
  expect(Object.hasOwn(messageAttributes, "input.value")).toBe(false);
  expect(Object.hasOwn(messageAttributes, "output.value")).toBe(false);
});

test("exports captured harness run content under captureContent", async () => {
  const { service, ctx } = await startOtelService({ traces: true, captureContent: true });

  // Harness content spans the started/completed pair, so the trace context must be a
  // valid W3C identity; an all-zero trace id is OTel's invalid sentinel and never pairs.
  const traceContext = createTestTrace(CHILD_SPAN_ID);
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "harness.run.started",
      runId: "run-capture",
      harnessId: "claude-cli",
      provider: "anthropic",
      model: "claude-opus-4-6",
      trace: traceContext,
    },
    { harnessContent: { userPrompt: "run the task" } },
  );
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "harness.run.completed",
      runId: "run-capture",
      harnessId: "claude-cli",
      provider: "anthropic",
      model: "claude-opus-4-6",
      durationMs: 100,
      outcome: "completed",
      trace: traceContext,
    },
    { harnessContent: { finalResponse: "task complete" } },
  );
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const harnessAttributes = finishedSpanAttributes("openclaw.harness.run");
  expect(harnessAttributes?.["input.value"]).toBe("run the task");
  expect(harnessAttributes?.["output.value"]).toBe("task complete");
});

test("keeps captured harness run content off spans without captureContent", async () => {
  const { service, ctx } = await startOtelService({ traces: true });

  const traceContext = createTestTrace(CHILD_SPAN_ID);
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "harness.run.started",
      runId: "run-capture",
      harnessId: "claude-cli",
      provider: "anthropic",
      model: "claude-opus-4-6",
      trace: traceContext,
    },
    { harnessContent: { userPrompt: "run the task" } },
  );
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "harness.run.completed",
      runId: "run-capture",
      harnessId: "claude-cli",
      provider: "anthropic",
      model: "claude-opus-4-6",
      durationMs: 100,
      outcome: "completed",
      trace: traceContext,
    },
    { harnessContent: { finalResponse: "task complete" } },
  );
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const harnessAttributes = finishedSpanAttributes("openclaw.harness.run") ?? {};
  expect(Object.hasOwn(harnessAttributes, "input.value")).toBe(false);
  expect(Object.hasOwn(harnessAttributes, "output.value")).toBe(false);
});

test("exports captured run content on run spans under captureContent", async () => {
  const { service, ctx } = await startOtelService({ traces: true, captureContent: true });

  const traceContext = createTestTrace(CHILD_SPAN_ID);
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "run.started",
      runId: "run-capture",
      provider: "anthropic",
      model: "claude-opus-4-6",
      trace: traceContext,
    },
    undefined,
  );
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "run.completed",
      runId: "run-capture",
      provider: "anthropic",
      model: "claude-opus-4-6",
      durationMs: 60,
      outcome: "completed",
      trace: traceContext,
    },
    { messageContent: { userPrompt: "run the task", finalResponse: "task complete" } },
  );
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const runAttributes = finishedSpanAttributes("openclaw.run");
  expect(runAttributes?.["input.value"]).toBe("run the task");
  expect(runAttributes?.["output.value"]).toBe("task complete");
});

test("keeps captured run content off spans without captureContent", async () => {
  const { service, ctx } = await startOtelService({ traces: true });

  const traceContext = createTestTrace(CHILD_SPAN_ID);
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "run.started",
      runId: "run-capture",
      provider: "anthropic",
      model: "claude-opus-4-6",
      trace: traceContext,
    },
    undefined,
  );
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "run.completed",
      runId: "run-capture",
      provider: "anthropic",
      model: "claude-opus-4-6",
      durationMs: 60,
      outcome: "completed",
      trace: traceContext,
    },
    { messageContent: { userPrompt: "run the task", finalResponse: "task complete" } },
  );
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const runAttributes = finishedSpanAttributes("openclaw.run") ?? {};
  expect(Object.hasOwn(runAttributes, "input.value")).toBe(false);
  expect(Object.hasOwn(runAttributes, "output.value")).toBe(false);
});

test("consumes the completion-time prompt on harness spans when startup carried none", async () => {
  // CLI harnesses attach content at completion rather than startup; the
  // completed recorder must still map a completion-time prompt to input.value.
  const { service, ctx } = await startOtelService({ traces: true, captureContent: true });

  const traceContext = createTestTrace(CHILD_SPAN_ID);
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "harness.run.started",
      runId: "run-capture",
      harnessId: "claude-cli",
      provider: "anthropic",
      model: "claude-opus-4-6",
      trace: traceContext,
    },
    undefined,
  );
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "harness.run.completed",
      runId: "run-capture",
      harnessId: "claude-cli",
      provider: "anthropic",
      model: "claude-opus-4-6",
      durationMs: 100,
      outcome: "completed",
      trace: traceContext,
    },
    { harnessContent: { userPrompt: "run the task", finalResponse: "task complete" } },
  );
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const harnessAttributes = finishedSpanAttributes("openclaw.harness.run");
  expect(harnessAttributes?.["input.value"]).toBe("run the task");
  expect(harnessAttributes?.["output.value"]).toBe("task complete");
});
