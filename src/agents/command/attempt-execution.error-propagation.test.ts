import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const sessionKey = "agent:main:acp:child";
const token = "sk-abcdefghijklmnopqrstuvwxyz123456";

function emit(event: RuntimeParams["event"], params: Partial<Omit<RuntimeParams, "event">> = {}) {
  emitAcpRuntimeEvent({ runId, toolTracker, ...params, event });
}

function emitTool(
  event: Partial<ToolEvent> = {},
  params: Partial<Omit<RuntimeParams, "event">> = {},
) {
  emit(
    {
      type: "tool_call",
      text: "running",
      kind: "execute",
      toolCallId: "call",
      tag: "tool_call",
      status: "in_progress",
      ...event,
    },
    params,
  );
}
function update(status = "completed", toolCallId = "call") {
  emitTool({ tag: "tool_call_update", status, toolCallId });
}
function toolEvent(type: string, fields: object = {}) {
  return { type: `tool.execution.${type}`, toolCallId: "call", ...fields };
}

function end(
  resultStatus: "completed" | "cancelled" = "completed",
  abortSignal?: AbortSignal,
  stopReason?: string,
  context = { runId, toolTracker },
) {
  emitAcpLifecycleEnd({
    ...context,
    endFields: resolveAcpLifecycleEndFields(abortSignal, stopReason, resultStatus),
  });
}

function expectCompletedTools(offset = 0) {
  expect(capturedTools.slice(offset).map((event) => event.type)).toEqual([
    "tool.execution.started",
    "tool.execution.completed",
  ]);
}
function fail(error: Error, auditOnly = false) {
  emitAcpLifecycleError({ runId, toolTracker, error, auditOnly });
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
  vi.unstubAllEnvs();
});

it("preserves cancelled result metadata without a stop reason", () => {
  expect(
    buildAcpResult({
      payloadText: "",
      terminalReply: { disposition: "empty" },
      startedAt: Date.now(),
      resultStatus: "cancelled",
    }).meta,
  ).toMatchObject({ aborted: true, stopReason: "stop" });
});

it("emits prompt-submitted state with proxy env names but not values", () => {
  vi.stubEnv("HTTPS_PROXY", "http://proxy.example.invalid:8080");
  emitAcpPromptSubmitted({ runId, sessionKey, at: 123 });
  expect(captured[0]).toMatchObject({
    stream: "acp",
    sessionKey,
    data: {
      phase: "prompt_submitted",
      at: 123,
      proxyEnvKeys: expect.arrayContaining(["HTTPS_PROXY"]),
    },
  });
  expect(JSON.stringify(captured[0]?.data)).not.toContain("proxy.example.invalid");
});

it("emits sanitized non-text runtime events for parent relay diagnostics", () => {
  emit({ type: "status", text: `connecting token=${token}`, tag: "session_info_update" });
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
    emitAcpLifecycleStart({ runId, sessionKey, startedAt: 123, auditOnly: true });
    emitTool(
      { text: "private command payload", status: "completed" },
      { sessionKey, auditOnly: true },
    );
    fail(new Error(secret), true);
  } finally {
    stopAudit();
  }
  expect(captured).toEqual([]);
  expect(auditEvents.map((event) => [event.stream, event.data.phase])).toEqual([
    ["lifecycle", "start"],
    ["lifecycle", "error"],
  ]);
  expectCompletedTools();
  expect(JSON.stringify(auditEvents)).not.toContain("private command payload");
  expect(JSON.stringify(auditEvents)).not.toContain(secret);
});

it("emits metadata-only tool lifecycle events without ACP text or title", () => {
  const text = "secret tool payload";
  const event = { text, title: text, kind: "read" } satisfies Partial<ToolEvent>;
  const identity = { sessionKey, agentId: "main" };
  emitTool(event, identity);
  emitTool({ ...event, tag: "tool_call_update", status: "completed" }, identity);
  expect(capturedTools).toMatchObject([
    toolEvent("started", { runId, ...identity, toolName: "acp_read" }),
    toolEvent("completed", { runId, ...identity, toolName: "acp_read" }),
  ]);
  expect(JSON.stringify(capturedTools)).not.toContain(event.text);
});

it.each(["failed", "cancelled"] as const)("tracks terminal tool status %s", (status) => {
  emitTool();
  emitTool({ tag: "tool_call_update", text: status, status });
  end();
  expect(capturedTools).toHaveLength(2);
  expect(capturedTools[1]).toMatchObject(
    toolEvent("error", {
      terminalReason: status,
      ...(status === "cancelled" ? { errorCategory: "aborted" } : {}),
    }),
  );
});

it("deduplicates repeated terminal tool updates until the ACP run ends", () => {
  emitTool();
  update();
  update();
  update("in_progress");
  expectCompletedTools();
  end();
  update();
  expectCompletedTools(2);
});

it("fails closed without evicting terminal identities at the tracking bound", () => {
  for (let index = 0; index < 4096; index++) {
    update("completed", `call-${index}`);
  }
  expect(capturedTools).toHaveLength(8192);
  update("completed", "call-0");
  update("completed", "call-overflow");
  expect(capturedTools).toHaveLength(8192);
  const unrelated = { runId: "unrelated", toolTracker: createAcpToolLifecycleTracker() };
  emitTool(
    { toolCallId: "call-unrelated", tag: "tool_call_update", status: "completed" },
    unrelated,
  );
  expectCompletedTools(8192);
  end("completed", undefined, undefined, unrelated);
  end();
  update("completed", "call-overflow");
  expectCompletedTools(8194);
});

it("waits for terminal evidence before recording a tool without a call id", () => {
  emitTool({ toolCallId: undefined });
  expect(capturedTools).toEqual([]);
  emitTool({ toolCallId: undefined, tag: "tool_call_update" });
  expect(capturedTools).toEqual([]);
  emitTool({ toolCallId: undefined, tag: "tool_call_update", status: "completed" });
  expectCompletedTools();
});

it.each([
  [undefined, "cancelled", "aborted"],
  ["timeout", "timed_out", "acp_tool_incomplete"],
] as const)(
  "settles outstanding tools on %s / %s termination",
  (stopReason, terminalReason, errorCategory) => {
    const controller = new AbortController();
    emitTool({}, { sessionKey });
    if (stopReason === "timeout") {
      controller.abort(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    }
    emit({ type: "done", status: "cancelled", stopReason });
    end("cancelled", controller.signal, stopReason);
    expect(capturedTools).toMatchObject([
      toolEvent("started"),
      toolEvent("error", { terminalReason, errorCategory }),
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
    expect(capturedTools.slice(2)).toMatchObject([toolEvent("started"), toolEvent("completed")]);
  },
);

it("preserves manager-owned ACP timeout attribution without an aborted caller signal", () => {
  emitTool();
  fail(
    new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn timed out.", {
      detailCode: ACP_TURN_TIMEOUT_DETAIL_CODE,
    }),
  );
  expect(capturedTools.at(-1)).toMatchObject(toolEvent("error", { terminalReason: "timed_out" }));
  expect(captured.at(-1)?.data).toMatchObject({
    phase: "error",
    aborted: true,
    stopReason: "timeout",
    status: "timed_out",
  });
});

it("preserves and sanitizes nested ACP failure details (openclaw-4a8)", () => {
  const root = new Error(`RequestError: "Method not found": nes/close (-32601) token=${token}`);
  const cause = new Error("Agent does not support session/close (oneshot:abc)", { cause: root });
  fail(new AcpRuntimeError("ACP_TURN_FAILED", "Internal error", { cause }));
  const text = String(captured[0]?.data.error);
  for (const fragment of [
    "ACP_TURN_FAILED",
    "Internal error",
    "Agent does not support session/close",
    "Method not found",
    "nes/close",
    "-32601",
  ]) {
    expect(text).toContain(fragment);
  }
  expect(text).not.toContain(token);
});
