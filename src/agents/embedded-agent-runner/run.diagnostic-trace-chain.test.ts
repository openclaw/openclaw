import type { IncomingMessage } from "node:http";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGatewayRequestDiagnosticTrace } from "../../gateway/request-diagnostic-trace.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;
let traceContext: typeof import("../../infra/diagnostic-trace-context.js");

function requestWithTraceparent(traceparent: string): IncomingMessage {
  return { headers: { traceparent } } as IncomingMessage;
}

describe("runEmbeddedAgent diagnostic trace chain", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    traceContext = await import("../../infra/diagnostic-trace-context.js");
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  it("passes a gateway trace into attempt diagnostics", async () => {
    const inboundTrace = traceContext.createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
    let activeAttemptTrace: ReturnType<typeof traceContext.getActiveDiagnosticTraceContext>;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      activeAttemptTrace = traceContext.getActiveDiagnosticTraceContext();
      return makeAttemptResult();
    });

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-trace-chain",
      sessionId: "session-trace-chain",
      sessionKey: "agent:main:trace-chain",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      messageChannel: "gateway-test",
      diagnosticTrace: inboundTrace,
    });

    expect(activeAttemptTrace?.traceId).toBe(inboundTrace.traceId);
    expect(activeAttemptTrace?.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(activeAttemptTrace?.parentSpanId).not.toBe(inboundTrace.spanId);
    expect(activeAttemptTrace?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(activeAttemptTrace?.spanId).not.toBe(inboundTrace.spanId);
  });

  it("creates a root invocation trace for non-gateway embedded runs", async () => {
    let activeAttemptTrace: ReturnType<typeof traceContext.getActiveDiagnosticTraceContext>;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      activeAttemptTrace = traceContext.getActiveDiagnosticTraceContext();
      return makeAttemptResult();
    });

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-local-trace-chain",
      sessionId: "session-local-trace-chain",
      sessionKey: "agent:main:local-trace-chain",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
    });

    expect(activeAttemptTrace?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(activeAttemptTrace?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(activeAttemptTrace?.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("captures the active gateway request trace for embedded runs", async () => {
    const parentTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentSpanId = "00f067aa0ba902b7";
    const requestTrace = createGatewayRequestDiagnosticTrace(
      requestWithTraceparent(`00-${parentTraceId}-${parentSpanId}-01`),
      { honorTraceparent: true },
    );
    let activeAttemptTrace: ReturnType<typeof traceContext.getActiveDiagnosticTraceContext>;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      activeAttemptTrace = traceContext.getActiveDiagnosticTraceContext();
      return makeAttemptResult();
    });

    await traceContext.runWithDiagnosticTraceContext(requestTrace, () =>
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        runId: "run-active-gateway-trace",
        sessionId: "session-active-gateway-trace",
        sessionKey: "agent:main:active-gateway-trace",
        provider: "anthropic",
        model: "claude-sonnet-4.6",
        messageChannel: "gateway-test",
      }),
    );

    expect(requestTrace.traceId).toBe(parentTraceId);
    expect(requestTrace.parentSpanId).toBe(parentSpanId);
    expect(activeAttemptTrace?.traceId).toBe(parentTraceId);
    expect(activeAttemptTrace?.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(activeAttemptTrace?.parentSpanId).not.toBe(requestTrace.spanId);
    expect(activeAttemptTrace?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(activeAttemptTrace?.spanId).not.toBe(requestTrace.spanId);
  });
});
