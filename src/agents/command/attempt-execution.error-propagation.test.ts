import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACP_TURN_TIMEOUT_DETAIL_CODE } from "../../acp/control-plane/manager.turn-timeout.js";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import {
  type AgentEventPayload,
  onAgentAuditEvent,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import {
  onTrustedToolExecutionEvent,
  resetDiagnosticEventsForTest,
  type TrustedToolExecutionEvent,
} from "../../infra/diagnostic-events.js";
import {
  buildAcpResult,
  createAcpToolLifecycleTracker,
  emitAcpLifecycleStart,
  emitAcpLifecycleEnd,
  emitAcpLifecycleError,
  emitAcpPromptSubmitted,
  emitAcpRuntimeEvent,
  resolveAcpLifecycleEndFields,
} from "./acp-lifecycle.js";

let captured: AgentEventPayload[];
let capturedTools: TrustedToolExecutionEvent[];
let unsubscribe: () => void;
let unsubscribeTools: () => void;
let toolTracker = createAcpToolLifecycleTracker();
const runId = "run-acp";
type RuntimeParams = Parameters<typeof emitAcpRuntimeEvent>[0];
type ToolEvent = Extract<RuntimeParams["event"], { type: "tool_call" }>;

function emitTool(
  event: Partial<ToolEvent> = {},
  params: Partial<Omit<RuntimeParams, "event">> = {},
) {
  emitAcpRuntimeEvent({
    runId,
    toolTracker,
    ...params,
    event: {
      type: "tool_call",
      text: "running",
      kind: "execute",
      toolCallId: "call",
      tag: "tool_call",
      status: "in_progress",
      ...event,
    },
  });
}

function end(
  resultStatus: "completed" | "cancelled" = "completed",
  abortSignal?: AbortSignal,
  stopReason?: string,
) {
  emitAcpLifecycleEnd({
    runId,
    toolTracker,
    endFields: resolveAcpLifecycleEndFields(abortSignal, stopReason, resultStatus),
  });
}

beforeEach(() => {
  resetAgentEventsForTest();
  resetDiagnosticEventsForTest();
  toolTracker = createAcpToolLifecycleTracker();
  captured = [];
  capturedTools = [];
  unsubscribe = onAgentEvent((event) => captured.push(event));
  unsubscribeTools = onTrustedToolExecutionEvent((event) => capturedTools.push(event));
});
afterEach(() => {
  unsubscribe();
  unsubscribeTools();
  resetAgentEventsForTest();
  resetDiagnosticEventsForTest();
});

describe("ACP diagnostic events", () => {
  it("preserves cancelled result metadata without a stop reason", () => {
    expect(
      buildAcpResult({ payloadText: "", startedAt: Date.now(), resultStatus: "cancelled" }).meta,
    ).toMatchObject({ aborted: true, stopReason: "stop" });
  });

  it("emits prompt-submitted state with proxy env names but not values", () => {
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://proxy.example.invalid:8080";
    try {
      emitAcpPromptSubmitted({ runId, sessionKey: "agent:main:acp:child", at: 123 });
    } finally {
      if (previous === undefined) {
        delete process.env.HTTPS_PROXY;
      } else {
        process.env.HTTPS_PROXY = previous;
      }
    }
    expect(captured[0]).toMatchObject({
      stream: "acp",
      sessionKey: "agent:main:acp:child",
      data: {
        phase: "prompt_submitted",
        at: 123,
        proxyEnvKeys: expect.arrayContaining(["HTTPS_PROXY"]),
      },
    });
    expect(JSON.stringify(captured[0]?.data)).not.toContain("proxy.example.invalid");
  });

  it("emits sanitized non-text runtime events for parent relay diagnostics", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    emitAcpRuntimeEvent({
      runId,
      toolTracker,
      event: { type: "status", text: `connecting token=${token}`, tag: "session_info_update" },
    });
    expect(captured[0]).toMatchObject({
      stream: "acp",
      data: { phase: "runtime_event", eventType: "status", tag: "session_info_update" },
    });
    expect(String(captured[0]?.data.text)).toContain("connecting");
    expect(String(captured[0]?.data.text)).not.toContain(token);
  });

  it("keeps audit-only ACP lifecycle and runtime events off the shared bus", () => {
    const secret = "private ACP cause chain";
    const auditEvents: AgentEventPayload[] = [];
    const stopAudit = onAgentAuditEvent((event) => auditEvents.push(event));
    try {
      emitAcpLifecycleStart({
        runId,
        sessionKey: "agent:main:acp:child",
        startedAt: 123,
        auditOnly: true,
      });
      emitTool(
        { text: "private command payload", status: "completed" },
        { sessionKey: "agent:main:acp:child", auditOnly: true },
      );
      emitAcpLifecycleError({ runId, toolTracker, error: new Error(secret), auditOnly: true });
    } finally {
      stopAudit();
    }
    expect(captured).toEqual([]);
    expect(auditEvents.map((event) => [event.stream, event.data.phase])).toEqual([
      ["lifecycle", "start"],
      ["lifecycle", "error"],
    ]);
    expect(capturedTools.map((event) => event.type)).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain("private command payload");
    expect(JSON.stringify(auditEvents)).not.toContain(secret);
  });

  it("emits metadata-only tool lifecycle events without ACP text or title", () => {
    const event = {
      text: "secret tool payload",
      title: "secret tool payload",
      kind: "read",
    } satisfies Partial<ToolEvent>;
    const identity = { sessionKey: "agent:main:acp:child", agentId: "main" };
    emitTool(event, identity);
    emitTool({ ...event, tag: "tool_call_update", status: "completed" }, identity);
    expect(capturedTools).toMatchObject([
      {
        type: "tool.execution.started",
        runId,
        ...identity,
        toolCallId: "call",
        toolName: "acp_read",
      },
      {
        type: "tool.execution.completed",
        runId,
        ...identity,
        toolCallId: "call",
        toolName: "acp_read",
      },
    ]);
    expect(JSON.stringify(capturedTools)).not.toContain(event.text);
  });

  it.each([
    { status: "failed", type: "tool.execution.error", terminalReason: "failed" },
    { status: "cancelled", type: "tool.execution.error", terminalReason: "cancelled" },
  ] as const)("finishes audit tracking for terminal tool status $status", (expected) => {
    emitTool();
    emitTool({ tag: "tool_call_update", text: expected.status, status: expected.status });
    end();
    expect(capturedTools).toHaveLength(2);
    expect(capturedTools[1]).toMatchObject({
      type: expected.type,
      toolCallId: "call",
      ...(expected.terminalReason ? { terminalReason: expected.terminalReason } : {}),
      ...(expected.status === "cancelled" ? { errorCategory: "aborted" } : {}),
    });
  });

  it("deduplicates repeated terminal tool updates until the ACP run ends", () => {
    emitTool();
    emitTool({ tag: "tool_call_update", status: "completed" });
    emitTool({ tag: "tool_call_update", status: "completed" });
    emitTool({ tag: "tool_call_update" });
    expect(capturedTools.map((event) => event.type)).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
    ]);
    end();
    emitTool({ tag: "tool_call_update", status: "completed" });
    expect(capturedTools.slice(2).map((event) => event.type)).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
    ]);
    end();
  });

  it("fails closed without evicting terminal identities at the tracking bound", () => {
    const terminal = (toolCallId: string) => ({
      toolCallId,
      tag: "tool_call_update",
      status: "completed",
    });
    for (let index = 0; index < 4096; index++) {
      emitTool(terminal(`call-${index}`));
    }
    expect(capturedTools).toHaveLength(8192);
    emitTool(terminal("call-0"));
    emitTool(terminal("call-overflow"));
    expect(capturedTools).toHaveLength(8192);
    const unrelatedTracker = createAcpToolLifecycleTracker();
    emitTool(terminal("call-unrelated"), { runId: "unrelated", toolTracker: unrelatedTracker });
    expect(capturedTools.slice(8192).map((event) => event.type)).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
    ]);
    emitAcpLifecycleEnd({
      runId: "unrelated",
      toolTracker: unrelatedTracker,
      endFields: resolveAcpLifecycleEndFields(undefined, undefined, "completed"),
    });
    end();
    emitTool(terminal("call-overflow"));
    expect(capturedTools.slice(8194).map((event) => event.type)).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
    ]);
    end();
  });

  it("waits for terminal evidence before recording a tool without a call id", () => {
    emitTool({ toolCallId: undefined });
    expect(capturedTools).toEqual([]);
    emitTool({ toolCallId: undefined, tag: "tool_call_update" });
    expect(capturedTools).toEqual([]);
    emitTool({ toolCallId: undefined, tag: "tool_call_update", status: "completed" });
    expect(capturedTools.map((event) => event.type)).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
    ]);
  });

  it.each([
    {
      status: "completed",
      stopReason: "end_turn",
      terminalReason: "failed",
      errorCategory: "acp_tool_incomplete",
    },
    {
      status: "cancelled",
      stopReason: undefined,
      terminalReason: "cancelled",
      errorCategory: "aborted",
    },
    {
      status: "cancelled",
      stopReason: "timeout",
      terminalReason: "timed_out",
      errorCategory: "acp_tool_incomplete",
    },
  ] as const)(
    "settles outstanding tools on $terminalReason termination",
    ({ status, stopReason, terminalReason, errorCategory }) => {
      const controller = new AbortController();
      emitTool({}, { sessionKey: "agent:main:acp:child" });
      if (stopReason === "timeout") {
        controller.abort(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
      }
      emitAcpRuntimeEvent({ runId, toolTracker, event: { type: "done", status, stopReason } });
      end(status, controller.signal, stopReason);
      expect(capturedTools).toMatchObject([
        { type: "tool.execution.started", toolCallId: "call" },
        { type: "tool.execution.error", toolCallId: "call", terminalReason, errorCategory },
      ]);
      if (terminalReason === "cancelled") {
        expect(captured.at(-1)?.data).toMatchObject({
          phase: "end",
          executionSettled: true,
          aborted: true,
          stopReason: "stop",
          status: "cancelled",
        });
      }
      emitTool({ status: "completed" });
      expect(capturedTools.slice(2)).toMatchObject([
        { type: "tool.execution.started", toolCallId: "call" },
        { type: "tool.execution.completed", toolCallId: "call" },
      ]);
    },
  );

  it("preserves manager-owned ACP timeout attribution without an aborted caller signal", () => {
    emitTool();
    emitAcpLifecycleError({
      runId,
      toolTracker,
      error: new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn timed out.", {
        detailCode: ACP_TURN_TIMEOUT_DETAIL_CODE,
      }),
    });
    expect(capturedTools.at(-1)).toMatchObject({
      type: "tool.execution.error",
      toolCallId: "call",
      terminalReason: "timed_out",
    });
    expect(captured.at(-1)?.data).toMatchObject({
      phase: "error",
      aborted: true,
      stopReason: "timeout",
      status: "timed_out",
    });
  });

  it("preserves and sanitizes nested ACP failure details (openclaw-4a8)", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const root = new Error(`RequestError: "Method not found": nes/close (-32601) token=${token}`);
    const cause = new Error("Agent does not support session/close (oneshot:abc)", { cause: root });
    emitAcpLifecycleError({
      runId,
      toolTracker,
      error: new AcpRuntimeError("ACP_TURN_FAILED", "Internal error", { cause }),
    });
    const text = String(captured[0]?.data.error);
    expect(text).toMatch(/ACP_TURN_FAILED/);
    expect(text).toMatch(/Internal error/);
    expect(text).toMatch(/Agent does not support session\/close/);
    expect(text).toMatch(/Method not found/);
    expect(text).toMatch(/nes\/close/);
    expect(text).toMatch(/-32601/);
    expect(text).not.toContain(token);
  });
});
