import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startOtelService, stopStartedOtelServices } from "./service.test-helpers.js";

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

test("exports the producing agent identity on run, harness, message, tool-loop, and model-call spans", async () => {
  const { service, ctx } = await startOtelService({ traces: true });

  emitTrustedDiagnosticEvent({
    type: "run.completed",
    runId: "run-agent-1",
    agentId: "ops",
    sessionId: "session-agent",
    provider: "anthropic",
    model: "claude-opus-4-7",
    durationMs: 100,
    outcome: "completed",
  });
  emitTrustedDiagnosticEvent({
    type: "harness.run.completed",
    runId: "run-agent-1",
    agentId: "ops",
    sessionId: "session-agent",
    harnessId: "claude-cli",
    provider: "anthropic",
    model: "claude-opus-4-7",
    durationMs: 100,
    outcome: "completed",
  });
  emitTrustedDiagnosticEvent({
    type: "message.processed",
    agentId: "ops",
    sessionId: "session-agent",
    channel: "webchat",
    durationMs: 5,
    outcome: "completed",
  });
  emitTrustedDiagnosticEvent({
    type: "tool.loop",
    agentId: "ops",
    sessionId: "session-agent",
    toolName: "read",
    level: "warning",
    action: "warn",
    detector: "generic_repeat",
    count: 3,
    message: "repeated read calls",
  });
  emitTrustedDiagnosticEvent({
    type: "model.call.completed",
    runId: "run-agent-1",
    callId: "call-agent-1",
    agentId: "ops",
    sessionId: "session-agent",
    provider: "anthropic",
    model: "claude-opus-4-7",
    api: "claude-code",
    transport: "stdio-live",
    observationUnit: "turn",
    durationMs: 80,
  });
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const spanAgent = (name: string) =>
    exporter
      .getFinishedSpans()
      .filter((span) => span.name === name)
      .map((span) => span.attributes["openclaw.agent"]);
  expect(spanAgent("openclaw.run")).toEqual(["ops"]);
  expect(spanAgent("openclaw.harness.run")).toEqual(["ops"]);
  expect(spanAgent("openclaw.message.processed")).toEqual(["ops"]);
  expect(spanAgent("openclaw.tool.loop")).toEqual(["ops"]);
  expect(spanAgent("openclaw.model.call")).toEqual(["ops"]);
});
