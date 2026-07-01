// Covers ACP diagnostic event propagation and sanitized error formatting.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACP_TURN_TIMEOUT_DETAIL_CODE } from "../../acp/control-plane/manager.turn-timeout.js";
import { AcpRuntimeError, formatAcpErrorChain } from "../../acp/runtime/errors.js";
import {
  type AgentEventPayload,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import {
  onTrustedToolExecutionEvent,
  resetDiagnosticEventsForTest,
  type TrustedToolExecutionEvent,
} from "../../infra/diagnostic-events.js";
import {
  emitAcpLifecycleEnd,
  emitAcpLifecycleError,
  emitAcpPromptSubmitted,
  emitAcpRuntimeEvent,
} from "./attempt-execution.js";

let captured: AgentEventPayload[] = [];
let capturedTools: TrustedToolExecutionEvent[] = [];
let unsubscribe: (() => void) | undefined;
let unsubscribeTools: (() => void) | undefined;

beforeEach(() => {
  resetAgentEventsForTest();
  resetDiagnosticEventsForTest();
  captured = [];
  capturedTools = [];
  // Subscribe to the process-level event bus so tests observe exactly what
  // parent relay diagnostics would receive.
  unsubscribe = onAgentEvent((evt) => {
    captured.push(evt);
  });
  unsubscribeTools = onTrustedToolExecutionEvent((event) => {
    capturedTools.push(event);
  });
});

describe("ACP diagnostic events", () => {
  it("emits prompt-submitted state with proxy env names but not values", () => {
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://proxy.example.invalid:8080";
    try {
      emitAcpPromptSubmitted({
        runId: "run-prompt",
        sessionKey: "agent:codex:acp:child",
        at: 123,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.HTTPS_PROXY;
      } else {
        process.env.HTTPS_PROXY = previous;
      }
    }

    const event = captured[0];
    expect(event?.stream).toBe("acp");
    expect(event?.sessionKey).toBe("agent:codex:acp:child");
    expect(event?.data).toMatchObject({
      phase: "prompt_submitted",
      at: 123,
      proxyEnvKeys: expect.arrayContaining(["HTTPS_PROXY"]),
    });
    expect(JSON.stringify(event?.data)).not.toContain("proxy.example.invalid");
  });

  it("emits sanitized non-text runtime events for parent relay diagnostics", () => {
    emitAcpRuntimeEvent({
      runId: "run-status",
      event: {
        type: "status",
        text: "connecting token=sk-abcdefghijklmnopqrstuvwxyz123456",
        tag: "session_info_update",
      },
    });

    const event = captured[0];
    expect(event?.stream).toBe("acp");
    expect(event?.data).toMatchObject({
      phase: "runtime_event",
      eventType: "status",
      tag: "session_info_update",
    });
    expect(String(event?.data.text)).toContain("connecting");
    expect(String(event?.data.text)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("emits metadata-only tool lifecycle events without ACP text or title", () => {
    const secret = "secret tool payload";
    emitAcpRuntimeEvent({
      runId: "run-tool",
      sessionKey: "agent:main:acp:child",
      agentId: "main",
      event: {
        type: "tool_call",
        tag: "tool_call",
        text: secret,
        title: secret,
        kind: "read",
        toolCallId: "call-1",
        status: "in_progress",
      },
    });
    emitAcpRuntimeEvent({
      runId: "run-tool",
      sessionKey: "agent:main:acp:child",
      agentId: "main",
      event: {
        type: "tool_call",
        tag: "tool_call_update",
        text: secret,
        title: secret,
        kind: "read",
        toolCallId: "call-1",
        status: "completed",
      },
    });

    expect(capturedTools).toMatchObject([
      {
        type: "tool.execution.started",
        runId: "run-tool",
        sessionKey: "agent:main:acp:child",
        agentId: "main",
        toolCallId: "call-1",
        toolName: "acp_read",
      },
      {
        type: "tool.execution.completed",
        runId: "run-tool",
        sessionKey: "agent:main:acp:child",
        agentId: "main",
        toolCallId: "call-1",
        toolName: "acp_read",
      },
    ]);
    expect(JSON.stringify(capturedTools)).not.toContain(secret);
  });

  it("finishes outstanding tools when the ACP runtime ends", () => {
    const params = {
      runId: "run-incomplete-tool",
      sessionKey: "agent:main:acp:child",
    };
    emitAcpRuntimeEvent({
      ...params,
      event: {
        type: "tool_call",
        tag: "tool_call",
        text: "running",
        kind: "execute",
        toolCallId: "call-incomplete",
        status: "in_progress",
      },
    });
    emitAcpRuntimeEvent({
      ...params,
      event: { type: "done", stopReason: "end_turn" },
    });

    expect(capturedTools).toMatchObject([
      {
        type: "tool.execution.started",
        toolCallId: "call-incomplete",
      },
      {
        type: "tool.execution.error",
        toolCallId: "call-incomplete",
        errorCategory: "acp_tool_incomplete",
      },
    ]);

    emitAcpRuntimeEvent({
      ...params,
      event: {
        type: "tool_call",
        tag: "tool_call",
        text: "retry",
        kind: "execute",
        toolCallId: "call-incomplete",
        status: "completed",
      },
    });
    expect(capturedTools.slice(2)).toMatchObject([
      { type: "tool.execution.started", toolCallId: "call-incomplete" },
      { type: "tool.execution.completed", toolCallId: "call-incomplete" },
    ]);
  });

  it("cancels outstanding tools when the ACP result reports cancellation", () => {
    const params = {
      runId: "run-cancelled-tool",
      sessionKey: "agent:main:acp:child",
    };
    emitAcpRuntimeEvent({
      ...params,
      event: {
        type: "tool_call",
        tag: "tool_call",
        text: "running",
        kind: "execute",
        toolCallId: "call-cancelled",
        status: "in_progress",
      },
    });
    emitAcpRuntimeEvent({
      ...params,
      event: { type: "done", stopReason: "manual-cancel" },
    });

    expect(capturedTools).toMatchObject([
      { type: "tool.execution.started", toolCallId: "call-cancelled" },
      {
        type: "tool.execution.error",
        toolCallId: "call-cancelled",
        errorCategory: "aborted",
        terminalReason: "cancelled",
      },
    ]);

    emitAcpLifecycleEnd({
      runId: "run-cancelled-lifecycle",
      stopReason: "manual-cancel",
    });
    expect(captured.at(-1)?.data).toMatchObject({
      phase: "end",
      aborted: true,
      stopReason: "stop",
      status: "cancelled",
    });
  });

  it("times out outstanding tools when the enclosing ACP run times out", () => {
    const abortController = new AbortController();
    const params = {
      runId: "run-timeout-tool",
      sessionKey: "agent:main:acp:child",
      abortSignal: abortController.signal,
    };
    emitAcpRuntimeEvent({
      ...params,
      event: {
        type: "tool_call",
        tag: "tool_call",
        text: "running",
        kind: "execute",
        toolCallId: "call-timeout",
        status: "in_progress",
      },
    });
    abortController.abort(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    emitAcpRuntimeEvent({
      ...params,
      event: { type: "done", stopReason: "timeout" },
    });

    expect(capturedTools).toMatchObject([
      { type: "tool.execution.started", toolCallId: "call-timeout" },
      {
        type: "tool.execution.error",
        toolCallId: "call-timeout",
        terminalReason: "timed_out",
      },
    ]);
  });

  it("preserves manager-owned ACP timeout attribution without an aborted caller signal", () => {
    emitAcpRuntimeEvent({
      runId: "run-manager-timeout",
      event: {
        type: "tool_call",
        tag: "tool_call",
        text: "running",
        kind: "execute",
        toolCallId: "call-manager-timeout",
        status: "in_progress",
      },
    });

    emitAcpLifecycleError({
      runId: "run-manager-timeout",
      error: new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn timed out.", {
        detailCode: ACP_TURN_TIMEOUT_DETAIL_CODE,
      }),
    });

    expect(capturedTools.at(-1)).toMatchObject({
      type: "tool.execution.error",
      toolCallId: "call-manager-timeout",
      terminalReason: "timed_out",
    });
    expect(captured.at(-1)?.data).toMatchObject({
      phase: "error",
      aborted: true,
      stopReason: "timeout",
      status: "timed_out",
    });
  });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  unsubscribeTools?.();
  unsubscribeTools = undefined;
  resetAgentEventsForTest();
  resetDiagnosticEventsForTest();
});

describe("emitAcpLifecycleError preserves AcpRuntimeError detail (regression: openclaw-4a8)", () => {
  it("renders the AcpRuntimeError code into the error string so existing consumers surface it", () => {
    const acpError = new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn failed before completion.");

    emitAcpLifecycleError({ runId: "run-1", error: acpError });

    expect(captured).toHaveLength(1);
    const data = captured[0]?.data as Record<string, unknown> | undefined;
    expect(data?.phase).toBe("error");
    const text = data?.error as string;
    expect(text).toMatch(/ACP_TURN_FAILED/);
    expect(text).toMatch(/ACP turn failed before completion\./);
  });

  it("flattens the cause chain into the error string so the underlying RequestError is not lost", () => {
    // ACP callers historically surface a single string; flattening preserves
    // the useful nested RequestError without exposing structured internals.
    const rootCause = new Error('RequestError: "Method not found": nes/close (-32601)');
    const wrapped = new Error("Agent does not support session/close (oneshot:abc)", {
      cause: rootCause,
    });
    const acpError = new AcpRuntimeError("ACP_TURN_FAILED", "Internal error", {
      cause: wrapped,
    });

    emitAcpLifecycleError({ runId: "run-2", error: acpError });

    const data = captured[0]?.data as Record<string, unknown> | undefined;
    const text = data?.error as string;

    expect(text).toMatch(/ACP_TURN_FAILED/);
    expect(text).toMatch(/Internal error/);
    expect(text).toMatch(/Agent does not support session\/close/);
    expect(text).toMatch(/Method not found/);
    expect(text).toMatch(/nes\/close/);
    expect(text).toMatch(/-32601/);
  });

  it("falls back gracefully when given a plain Error without code or cause", () => {
    const plain = new Error("something went wrong");

    emitAcpLifecycleError({ runId: "run-3", error: plain });

    const data = captured[0]?.data as Record<string, unknown> | undefined;
    expect(data?.phase).toBe("error");
    expect(data?.error).toBe("Error: something went wrong");
  });

  it("formats non-Error values without crashing", () => {
    expect(formatAcpErrorChain("just a string")).toBe("just a string");
    expect(formatAcpErrorChain(42)).toBe("42");
    expect(formatAcpErrorChain(undefined)).toBe("undefined");

    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const text = formatAcpErrorChain(`upstream rejected token=${token}`);
    expect(text).toMatch(/upstream rejected/);
    expect(text).not.toContain(token);
  });

  it("caps cause-chain depth so a self-referential cause cannot loop", () => {
    const e: Error & { cause?: unknown } = new Error("loop");
    e.cause = e;

    const text = formatAcpErrorChain(e);

    // Should produce a finite string with the message, not hang.
    expect(text).toMatch(/loop/);
    expect(text.length).toBeLessThan(2000);
  });
});
