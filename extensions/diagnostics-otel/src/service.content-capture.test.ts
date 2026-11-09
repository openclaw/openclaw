import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  type DiagnosticModelCallContent,
  emitTrustedDiagnosticEventWithPrivateData,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CHILD_SPAN_ID,
  MODEL_CALL_FIXTURE,
  createTestTrace,
  startOtelService,
  stopStartedOtelServices,
} from "./service.test-helpers.js";

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return { ...actual, redactSensitiveText: vi.fn(actual.redactSensitiveText) };
});

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

test("exports captured harness response on harness error spans under captureContent", async () => {
  const { service, ctx } = await startOtelService({ traces: true, captureContent: true });

  const traceContext = createTestTrace(CHILD_SPAN_ID);
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "harness.run.started",
      runId: "run-capture-error",
      harnessId: "claude-cli",
      provider: "anthropic",
      model: "claude-opus-4-6",
      trace: traceContext,
    },
    undefined,
  );
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "harness.run.error",
      runId: "run-capture-error",
      harnessId: "claude-cli",
      provider: "anthropic",
      model: "claude-opus-4-6",
      phase: "cleanup",
      errorCategory: "other",
      durationMs: 100,
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

const MAX_CONTENT_CHARS = 128 * 1024;

async function exportModelContent(content: DiagnosticModelCallContent) {
  exporter.reset();
  emitTrustedDiagnosticEventWithPrivateData(
    { type: "model.call.completed", ...MODEL_CALL_FIXTURE, durationMs: 80 },
    { modelContent: content },
  );
  await waitForDiagnosticEventsDrained();
  const attributes = finishedSpanAttributes("openclaw.model.call");
  if (!attributes) {
    throw new Error("expected completed model span");
  }
  return attributes;
}

test("bounds redaction work across large model attributes and isolates exports", async () => {
  await startOtelService({ traces: true, captureContent: true });
  const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"; // pragma: allowlist secret
  const outputs = Array.from({ length: 40 }, (_, i) => `tool output ${i} ${"z".repeat(20_000)}`);
  const messages = [
    { role: "user", content: [{ type: "text", text: `deploy with key ${secret}` }] },
    ...outputs.map((text) => ({ role: "toolResult", content: [{ type: "text", text }] })),
  ];
  // Repeat through the same service: a process/service-scoped memo would skip the
  // second export's leaf calls and retain private transcript strings indefinitely.
  for (let exportIndex = 0; exportIndex < 2; exportIndex++) {
    vi.mocked(redactSensitiveText).mockClear();
    const attrs = await exportModelContent({ inputMessages: messages });
    const calls = vi.mocked(redactSensitiveText).mock.calls.map(([value]) => value);
    for (const output of outputs) {
      expect(calls.filter((value) => value === output)).toHaveLength(1);
    }
    expect(Math.max(...calls.map((value) => value.length))).toBeLessThanOrEqual(
      4 * MAX_CONTENT_CHARS,
    );
    for (const key of ["gen_ai.input.messages", "input.value", "openclaw.content.input_messages"]) {
      const value = attrs[key];
      expect(typeof value).toBe("string");
      expect(String(value).length).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
      expect(String(value)).toContain("deploy with key sk-ant");
      expect(String(value)).not.toContain(secret);
      expect(() => JSON.parse(String(value))).not.toThrow();
    }
    expect(attrs["input.value"]).toBe(attrs["gen_ai.input.messages"]);
    expect(attrs["openclaw.provider"]).toBe(MODEL_CALL_FIXTURE.provider);
    expect(attrs["input.mime_type"]).toBe("application/json");
  }
});

test("serializes each ordinary mirrored message once and preserves masked whole values", async () => {
  await startOtelService({ traces: true, captureContent: true });
  const input = "ordinary input";
  const output = "ordinary output";
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    const attrs = await exportModelContent({
      inputMessages: [{ role: "user", content: input }],
      outputMessages: [{ role: "assistant", content: output }],
    });
    for (const text of [input, output]) {
      expect(
        stringify.mock.calls.filter(
          ([value]) => Array.isArray(value) && value[0]?.parts?.[0]?.content === text,
        ),
      ).toHaveLength(1);
    }
    expect(JSON.parse(String(attrs["input.value"]))).toEqual([
      { role: "user", parts: [{ type: "text", content: input }] },
    ]);
    expect(attrs["output.value"]).toBe(attrs["gen_ai.output.messages"]);
    expect(JSON.parse(String(attrs["output.value"]))).toEqual([
      { role: "assistant", parts: [{ type: "text", content: output }] },
    ]);
  } finally {
    stringify.mockRestore();
  }
  const attrs = await exportModelContent({
    inputMessages: [
      {
        role: "user",
        content: [{ type: "text", text: `sk-${"a".repeat(MAX_CONTENT_CHARS + 10_000)}` }],
      },
    ],
  });
  expect(JSON.parse(String(attrs["input.value"]))).toEqual([
    { role: "user", parts: [{ type: "text", content: "sk-aaa…aaaa" }] },
  ]);
});

test("drops oversized image bytes before export but retains small images and private-state removal", async () => {
  await startOtelService({ traces: true, captureContent: true });
  const image = (data: string) => ({ type: "image", mimeType: "image/png", data });
  const large = "A".repeat(MAX_CONTENT_CHARS + 1);
  vi.mocked(redactSensitiveText).mockClear();
  const attrs = await exportModelContent({
    inputMessages: [{ role: "user", content: [image("iVBORw0KGgo=")] }],
    outputMessages: [
      {
        role: "assistant",
        reasoning_content: "private-reasoning-canary",
        content: [
          image(large),
          { type: "thinking", thinking: "private-thinking-canary" },
          { type: "text", text: "visible", textSignature: "private-signature-canary" },
        ],
      },
    ],
  });
  const blob = { type: "blob", modality: "image", mime_type: "image/png" };
  expect(JSON.parse(String(attrs["input.value"]))[0].parts).toEqual([
    { ...blob, content: "iVBORw0KGgo=" },
  ]);
  expect(JSON.parse(String(attrs["output.value"]))[0].parts).toEqual([
    blob,
    { type: "text", content: "visible" },
  ]);
  expect(JSON.parse(String(attrs["openclaw.content.output_messages"]))[0].content).toEqual([
    { type: "image", mimeType: "image/png" },
    { type: "reasoning", redacted: true },
    { type: "text", text: "visible" },
  ]);
  expect(JSON.stringify(attrs)).not.toContain("private-");
  expect(vi.mocked(redactSensitiveText).mock.calls.some(([value]) => value.includes(large))).toBe(
    false,
  );
});

test("does no content redaction when capture is off", async () => {
  await startOtelService({ traces: true, captureContent: false });
  const text = "capture-disabled-private-canary";
  vi.mocked(redactSensitiveText).mockClear();
  const attrs = await exportModelContent({
    inputMessages: [{ role: "user", content: text }],
    outputMessages: [{ role: "assistant", content: text }],
  });
  expect(JSON.stringify(attrs)).not.toContain(text);
  expect(vi.mocked(redactSensitiveText).mock.calls.some(([value]) => value.includes(text))).toBe(
    false,
  );
  expect(attrs["openclaw.provider"]).toBe(MODEL_CALL_FIXTURE.provider);
  expect(attrs).not.toHaveProperty("input.value");
  expect(attrs).not.toHaveProperty("output.value");
});
