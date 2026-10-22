import { setTimeout as sleep } from "node:timers/promises";
import { diag, DiagLogLevel } from "@opentelemetry/api";
import type { DiagnosticTraceContext } from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import {
  type CapturedLogRecord,
  type CapturedSpan,
  startLocalOtlpReceiver,
} from "../../../test/e2e/qa-lab/runtime/otel-test-support.js";
import { createDiagnosticsOtelService } from "./service.js";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import {
  clearOtelGlobals,
  createOtelContext,
  emitRealSdkSignals,
  registeredOtelGlobals,
  registeredOtelLogs,
} from "./service.test-helpers.js";

installRealOtelSdkTestHarness();

const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
const OWNERSHIP_ENV_KEYS = [
  PRELOAD_ENV,
  "OTEL_SDK_DISABLED",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_LOG_LEVEL",
] as const;
function releaseOtelGlobals() {
  clearOtelGlobals();
  for (const key of OWNERSHIP_ENV_KEYS) {
    delete process.env[key];
  }
}

function assertCorrelatedGeneration(
  spans: CapturedSpan[],
  logRecords: CapturedLogRecord[],
  logTrace: DiagnosticTraceContext,
): void {
  const run = spans.find((span) => span.name === "openclaw.run");
  const model = spans.find((span) => span.name === "openclaw.model.call");
  const correlatedLog = logRecords.find(
    (record) => record.traceId === logTrace.traceId && record.spanId === logTrace.spanId,
  );
  expect(run?.traceId).toBeTruthy();
  expect(run?.spanId).toBeTruthy();
  expect(model?.traceId).toBe(run?.traceId);
  expect(model?.parentSpanId).toBe(run?.spanId);
  expect(correlatedLog).toBeDefined();
}

function captureOtelDiagnostics(): string[] {
  const messages: string[] = [];
  const capture = (...args: unknown[]) => {
    messages.push(args.map((value) => String(value)).join(" "));
  };
  diag.setLogger(
    {
      debug: () => {},
      error: capture,
      info: () => {},
      verbose: () => {},
      warn: capture,
    },
    { logLevel: DiagLogLevel.ALL, suppressOverrideMessage: true },
  );
  return messages;
}

test("flushes each private generation on restart and leaves global providers untouched", async () => {
  const receiverA = startLocalOtlpReceiver();
  const receiverB = startLocalOtlpReceiver();
  const portA = await receiverA.listen();
  const portB = await receiverB.listen();
  releaseOtelGlobals();
  const messages = captureOtelDiagnostics();
  const hostDiagOwner = registeredOtelGlobals()?.diag;
  process.env.OTEL_LOG_LEVEL = "debug";
  const globalProviders = {
    logs: registeredOtelLogs(),
    metrics: registeredOtelGlobals()?.metrics,
    trace: registeredOtelGlobals()?.trace,
  };
  function assertGeneration(receiver: typeof receiverA, logTrace: DiagnosticTraceContext) {
    expect(new Set(receiver.capturedRequests.map((request) => request.signal))).toEqual(
      new Set(["traces", "metrics", "logs"]),
    );
    expect(receiver.capturedMetrics.length).toBeGreaterThan(0);
    assertCorrelatedGeneration(receiver.capturedSpans, receiver.capturedLogRecords, logTrace);
    expect(registeredOtelGlobals()?.trace).toBe(globalProviders.trace);
    expect(registeredOtelGlobals()?.metrics).toBe(globalProviders.metrics);
    expect(registeredOtelLogs()).toBe(globalProviders.logs);
    expect(registeredOtelGlobals()?.diag).toBe(hostDiagOwner);
  }
  const service = createDiagnosticsOtelService();
  const flags = { traces: true, metrics: true, logs: true, flushIntervalMs: 60_000 };
  const ctxA = createOtelContext(`http://127.0.0.1:${portA}`, flags);
  const ctxB = createOtelContext(`http://127.0.0.1:${portB}`, flags);

  try {
    await service.start(ctxA);
    const traceA = await emitRealSdkSignals("generation-a");
    await service.stop?.(ctxA);
    const aRequestsAfterStop = receiverA.capturedRequests.length;

    assertGeneration(receiverA, traceA);

    await emitRealSdkSignals("after-a-stop");
    await sleep(50);
    expect(receiverA.capturedRequests).toHaveLength(aRequestsAfterStop);

    await service.start(ctxB);
    const traceB = await emitRealSdkSignals("generation-b");
    await service.stop?.(ctxB);
    const bRequestsAfterStop = receiverB.capturedRequests.length;

    expect(receiverA.capturedRequests).toHaveLength(aRequestsAfterStop);
    assertGeneration(receiverB, traceB);

    await emitRealSdkSignals("after-b-stop");
    await sleep(50);
    expect(receiverB.capturedRequests).toHaveLength(bRequestsAfterStop);
    diag.warn("host diagnostic logger remains active");
    expect(messages).toContain("host diagnostic logger remains active");
  } finally {
    await service.stop?.(ctxA);
    await service.stop?.(ctxB);
    await receiverA.close();
    await receiverB.close();
  }
}, 30_000);
