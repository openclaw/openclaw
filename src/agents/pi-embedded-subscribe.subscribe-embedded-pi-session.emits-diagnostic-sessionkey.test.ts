import { describe, expect, it } from "vitest";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-events.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

type SessionEventHandler = (evt: unknown) => void;

describe("subscribeEmbeddedPiSession – sessionKey propagation", () => {
  it("includes sessionKey on model.inference when run context is registered", () => {
    resetDiagnosticEventsForTest();

    const runId = "run-sk-inference";
    registerAgentRunContext(runId, { sessionKey: "agent:main:sub:abc" });

    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId,
    });

    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      provider: "anthropic",
      model: "claude-opus-4-5",
      usage: { input: 5, output: 3, totalTokens: 8 },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    handler?.({ type: "message_start", message: assistantMessage });
    handler?.({ type: "message_end", message: assistantMessage });

    unsub();
    clearAgentRunContext(runId);

    const evt = events.find((e) => e.type === "model.inference");
    expect(evt).toBeDefined();
    expect(evt?.sessionKey).toBe("agent:main:sub:abc");
    expect(evt?.runId).toBe(runId);
  });

  it("omits sessionKey on model.inference when no run context exists", () => {
    resetDiagnosticEventsForTest();

    const runId = "run-sk-no-ctx";

    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId,
    });

    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      provider: "anthropic",
      model: "claude-opus-4-5",
      usage: { input: 5, output: 3, totalTokens: 8 },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    handler?.({ type: "message_start", message: assistantMessage });
    handler?.({ type: "message_end", message: assistantMessage });

    unsub();

    const evt = events.find((e) => e.type === "model.inference");
    expect(evt).toBeDefined();
    expect(evt?.sessionKey).toBeUndefined();
  });

  it("includes sessionKey on tool.execution when run context is registered", () => {
    resetDiagnosticEventsForTest();

    const runId = "run-sk-tool";
    registerAgentRunContext(runId, { sessionKey: "agent:main:sub:def" });

    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId,
    });

    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    handler?.({
      type: "tool_execution_start",
      toolName: "web_search",
      toolCallId: "call-sk-1",
      args: { query: "test" },
    });

    handler?.({
      type: "tool_execution_end",
      toolName: "web_search",
      toolCallId: "call-sk-1",
      isError: false,
      result: { output: "results" },
    });

    unsub();
    clearAgentRunContext(runId);

    const evt = events.find((e) => e.type === "tool.execution");
    expect(evt).toBeDefined();
    expect(evt?.sessionKey).toBe("agent:main:sub:def");
    expect(evt?.runId).toBe(runId);
  });

  it("omits sessionKey on tool.execution when no run context exists", () => {
    resetDiagnosticEventsForTest();

    const runId = "run-sk-tool-no-ctx";

    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId,
    });

    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    handler?.({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "call-sk-2",
      args: { path: "/tmp/test" },
    });

    handler?.({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "call-sk-2",
      isError: false,
      result: "contents",
    });

    unsub();

    const evt = events.find((e) => e.type === "tool.execution");
    expect(evt).toBeDefined();
    expect(evt?.sessionKey).toBeUndefined();
  });

  it("run.started includes sessionKey from run context", () => {
    resetDiagnosticEventsForTest();

    const runId = "run-sk-started";
    registerAgentRunContext(runId, { sessionKey: "agent:main:sub:ghi" });

    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId,
    });

    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    handler?.({ type: "agent_start" });

    unsub();
    clearAgentRunContext(runId);

    const evt = events.find((e) => e.type === "run.started");
    expect(evt).toBeDefined();
    expect(evt?.sessionKey).toBe("agent:main:sub:ghi");
  });
});
