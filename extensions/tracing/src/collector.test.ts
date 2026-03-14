import { describe, it, expect, beforeEach, vi } from "vitest";
import { TraceCollector } from "./collector.js";
import type { TraceSpan } from "./types.js";

describe("TraceCollector", () => {
  let emitted: TraceSpan[];
  let emit: (span: TraceSpan) => void;
  let collector: TraceCollector;

  beforeEach(() => {
    emitted = [];
    emit = (span) => emitted.push(span);
    collector = new TraceCollector(emit);
  });

  describe("onSessionStart", () => {
    it("emits an open session span with a new traceId", () => {
      collector.onSessionStart(
        { sessionId: "s1", sessionKey: "sk1" },
        { sessionId: "s1", sessionKey: "sk1", agentId: "agent-1" },
      );

      expect(emitted).toHaveLength(1);
      const span = emitted[0]!;
      expect(span.kind).toBe("session");
      expect(span.name).toBe("session");
      expect(span.sessionKey).toBe("sk1");
      expect(span.agentId).toBe("agent-1");
      expect(span.traceId).toBeTruthy();
      expect(span.spanId).toBeTruthy();
      expect(span.parentSpanId).toBeUndefined();
      expect(span.startMs).toBeGreaterThan(0);
      expect(span.endMs).toBeUndefined();
      expect(span.durationMs).toBeUndefined();
    });
  });

  describe("onSessionEnd", () => {
    it("emits a closed session span with endMs and durationMs", () => {
      collector.onSessionStart(
        { sessionId: "s1", sessionKey: "sk1" },
        { sessionId: "s1", sessionKey: "sk1" },
      );
      emitted.length = 0;

      collector.onSessionEnd(
        { sessionId: "s1", sessionKey: "sk1", messageCount: 5, durationMs: 1000 },
        { sessionId: "s1", sessionKey: "sk1" },
      );

      expect(emitted).toHaveLength(1);
      const span = emitted[0]!;
      expect(span.kind).toBe("session");
      expect(span.endMs).toBeGreaterThan(0);
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
      expect(span.attributes.messageCount).toBe(5);
    });

    it("does nothing if no matching session was started", () => {
      collector.onSessionEnd(
        { sessionId: "s-unknown", sessionKey: "sk-unknown", messageCount: 0 },
        { sessionId: "s-unknown", sessionKey: "sk-unknown" },
      );
      expect(emitted).toHaveLength(0);
    });
  });

  describe("onLlmInput", () => {
    it("emits an open llm_call span parented to the session", () => {
      collector.onSessionStart(
        { sessionId: "s1", sessionKey: "sk1" },
        { sessionId: "s1", sessionKey: "sk1", agentId: "a1" },
      );
      emitted.length = 0;

      collector.onLlmInput(
        {
          runId: "r1",
          sessionId: "s1",
          provider: "anthropic",
          model: "claude-4",
          prompt: "hello",
          historyMessages: [],
          imagesCount: 0,
        },
        { agentId: "a1", sessionKey: "sk1", sessionId: "s1" },
      );

      expect(emitted).toHaveLength(1);
      const span = emitted[0]!;
      expect(span.kind).toBe("llm_call");
      expect(span.provider).toBe("anthropic");
      expect(span.model).toBe("claude-4");
      expect(span.parentSpanId).toBeTruthy();
      expect(span.endMs).toBeUndefined();
    });
  });

  describe("onLlmOutput", () => {
    it("closes the llm_call span with token counts", () => {
      collector.onSessionStart(
        { sessionId: "s1", sessionKey: "sk1" },
        { sessionId: "s1", sessionKey: "sk1" },
      );

      collector.onLlmInput(
        {
          runId: "r1",
          sessionId: "s1",
          provider: "anthropic",
          model: "claude-4",
          prompt: "hello",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "sk1", sessionId: "s1" },
      );
      emitted.length = 0;

      collector.onLlmOutput(
        {
          runId: "r1",
          sessionId: "s1",
          provider: "anthropic",
          model: "claude-4",
          assistantTexts: ["world"],
          usage: { input: 10, output: 20, total: 30 },
        },
        { sessionKey: "sk1", sessionId: "s1" },
      );

      expect(emitted).toHaveLength(1);
      const span = emitted[0]!;
      expect(span.kind).toBe("llm_call");
      expect(span.endMs).toBeGreaterThan(0);
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
      expect(span.tokensIn).toBe(10);
      expect(span.tokensOut).toBe(20);
    });

    it("does nothing if no matching run was opened", () => {
      collector.onLlmOutput(
        {
          runId: "r-unknown",
          sessionId: "s1",
          provider: "anthropic",
          model: "claude-4",
          assistantTexts: [],
        },
        { sessionKey: "sk1" },
      );
      expect(emitted).toHaveLength(0);
    });
  });

  describe("onBeforeToolCall / onAfterToolCall", () => {
    it("opens and closes a tool_call span parented to the llm run", () => {
      collector.onSessionStart(
        { sessionId: "s1", sessionKey: "sk1" },
        { sessionId: "s1", sessionKey: "sk1" },
      );
      collector.onLlmInput(
        {
          runId: "r1",
          sessionId: "s1",
          provider: "anthropic",
          model: "claude-4",
          prompt: "hi",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "sk1", sessionId: "s1" },
      );
      emitted.length = 0;

      collector.onBeforeToolCall(
        { toolName: "bash", params: { cmd: "ls" }, runId: "r1", toolCallId: "tc1" },
        { sessionKey: "sk1", sessionId: "s1", runId: "r1", toolName: "bash", toolCallId: "tc1" },
      );

      expect(emitted).toHaveLength(1);
      const openSpan = emitted[0]!;
      expect(openSpan.kind).toBe("tool_call");
      expect(openSpan.toolName).toBe("bash");
      expect(openSpan.toolParams).toEqual({ cmd: "ls" });
      expect(openSpan.endMs).toBeUndefined();

      emitted.length = 0;

      collector.onAfterToolCall(
        { toolName: "bash", params: { cmd: "ls" }, runId: "r1", toolCallId: "tc1", durationMs: 50 },
        { sessionKey: "sk1", sessionId: "s1", runId: "r1", toolName: "bash", toolCallId: "tc1" },
      );

      expect(emitted).toHaveLength(1);
      const closeSpan = emitted[0]!;
      expect(closeSpan.kind).toBe("tool_call");
      expect(closeSpan.endMs).toBeGreaterThan(0);
      expect(closeSpan.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("parents to session span if no active llm run", () => {
      collector.onSessionStart(
        { sessionId: "s1", sessionKey: "sk1" },
        { sessionId: "s1", sessionKey: "sk1" },
      );
      const sessionSpanId = emitted[0]!.spanId;
      emitted.length = 0;

      collector.onBeforeToolCall(
        { toolName: "bash", params: {}, toolCallId: "tc2" },
        { sessionKey: "sk1", sessionId: "s1", toolName: "bash", toolCallId: "tc2" },
      );

      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.parentSpanId).toBe(sessionSpanId);
    });
  });

  describe("onSubagentSpawning / onSubagentEnded", () => {
    it("opens and closes a subagent span", () => {
      collector.onSessionStart(
        { sessionId: "s1", sessionKey: "sk1" },
        { sessionId: "s1", sessionKey: "sk1" },
      );
      const sessionSpanId = emitted[0]!.spanId;
      emitted.length = 0;

      collector.onSubagentSpawning(
        {
          childSessionKey: "child-sk1",
          agentId: "sub-agent",
          label: "helper",
          mode: "run",
          threadRequested: false,
        },
        { requesterSessionKey: "sk1", childSessionKey: "child-sk1" },
      );

      expect(emitted).toHaveLength(1);
      const openSpan = emitted[0]!;
      expect(openSpan.kind).toBe("subagent");
      expect(openSpan.parentSpanId).toBe(sessionSpanId);
      expect(openSpan.childSessionKey).toBe("child-sk1");
      expect(openSpan.childAgentId).toBe("sub-agent");
      expect(openSpan.endMs).toBeUndefined();

      emitted.length = 0;

      collector.onSubagentEnded(
        {
          targetSessionKey: "child-sk1",
          targetKind: "subagent",
          reason: "completed",
          outcome: "ok",
        },
        { requesterSessionKey: "sk1", childSessionKey: "child-sk1" },
      );

      expect(emitted).toHaveLength(1);
      const closeSpan = emitted[0]!;
      expect(closeSpan.kind).toBe("subagent");
      expect(closeSpan.endMs).toBeGreaterThan(0);
      expect(closeSpan.durationMs).toBeGreaterThanOrEqual(0);
      expect(closeSpan.attributes.outcome).toBe("ok");
      expect(closeSpan.attributes.reason).toBe("completed");
    });

    it("does nothing on end if subagent was not tracked", () => {
      collector.onSubagentEnded(
        { targetSessionKey: "unknown", targetKind: "subagent", reason: "done" },
        { requesterSessionKey: "sk1", childSessionKey: "unknown" },
      );
      expect(emitted).toHaveLength(0);
    });
  });

  describe("parent chain", () => {
    it("links tool spans to their triggering llm run", () => {
      collector.onSessionStart(
        { sessionId: "s1", sessionKey: "sk1" },
        { sessionId: "s1", sessionKey: "sk1" },
      );
      collector.onLlmInput(
        {
          runId: "r1",
          sessionId: "s1",
          provider: "anthropic",
          model: "claude-4",
          prompt: "hi",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "sk1", sessionId: "s1" },
      );
      const llmSpanId = emitted[1]!.spanId;
      emitted.length = 0;

      collector.onBeforeToolCall(
        { toolName: "read", params: {}, runId: "r1", toolCallId: "tc1" },
        { sessionKey: "sk1", sessionId: "s1", runId: "r1", toolName: "read", toolCallId: "tc1" },
      );

      expect(emitted[0]!.parentSpanId).toBe(llmSpanId);
    });
  });

  describe("sub-agent traceId propagation", () => {
    it("child session inherits parent traceId and links to subagent span", () => {
      // Parent session
      collector.onSessionStart(
        { sessionId: "s1", sessionKey: "sk-parent" },
        { sessionId: "s1", sessionKey: "sk-parent", agentId: "parent-bot" },
      );
      const parentTraceId = emitted[0]!.traceId;

      // Spawn sub-agent
      collector.onSubagentSpawning(
        { childSessionKey: "sk-child", agentId: "child-bot", mode: "run", threadRequested: false },
        { requesterSessionKey: "sk-parent", childSessionKey: "sk-child" },
      );
      const subagentSpanId = emitted[1]!.spanId;

      // Child session starts — should inherit parent traceId
      collector.onSessionStart(
        { sessionId: "s2", sessionKey: "sk-child" },
        { sessionId: "s2", sessionKey: "sk-child", agentId: "child-bot" },
      );
      const childSessionSpan = emitted[2]!;
      expect(childSessionSpan.traceId).toBe(parentTraceId);
      expect(childSessionSpan.parentSpanId).toBe(subagentSpanId);
    });

    it("child tool calls share the same traceId as parent", () => {
      // Parent session
      collector.onSessionStart(
        { sessionId: "s1", sessionKey: "sk-parent" },
        { sessionId: "s1", sessionKey: "sk-parent" },
      );
      const parentTraceId = emitted[0]!.traceId;

      // Spawn + child session
      collector.onSubagentSpawning(
        { childSessionKey: "sk-child", agentId: "child-bot", mode: "run", threadRequested: false },
        { requesterSessionKey: "sk-parent", childSessionKey: "sk-child" },
      );
      collector.onSessionStart(
        { sessionId: "s2", sessionKey: "sk-child" },
        { sessionId: "s2", sessionKey: "sk-child" },
      );

      // Child LLM + tool call
      collector.onLlmInput(
        {
          runId: "r2",
          sessionId: "s2",
          provider: "openai",
          model: "gpt-4o",
          prompt: "translate",
          historyMessages: [],
          imagesCount: 0,
        },
        { sessionKey: "sk-child", sessionId: "s2" },
      );
      collector.onBeforeToolCall(
        { toolName: "translate", params: { text: "hello" }, runId: "r2", toolCallId: "tc-child" },
        {
          sessionKey: "sk-child",
          sessionId: "s2",
          runId: "r2",
          toolName: "translate",
          toolCallId: "tc-child",
        },
      );

      // All spans should share parent traceId
      const allTraceIds = emitted.map((s) => s.traceId);
      expect(allTraceIds.every((id) => id === parentTraceId)).toBe(true);
    });
  });

  describe("ID generation", () => {
    it("generates unique trace and span IDs", () => {
      collector.onSessionStart(
        { sessionId: "s1", sessionKey: "sk1" },
        { sessionId: "s1", sessionKey: "sk1" },
      );
      collector.onSessionStart(
        { sessionId: "s2", sessionKey: "sk2" },
        { sessionId: "s2", sessionKey: "sk2" },
      );

      expect(emitted[0]!.traceId).not.toBe(emitted[1]!.traceId);
      expect(emitted[0]!.spanId).not.toBe(emitted[1]!.spanId);
    });
  });

  describe("session key fallback", () => {
    it("uses sessionId as key when sessionKey is missing", () => {
      collector.onSessionStart({ sessionId: "s1" }, { sessionId: "s1" });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.sessionKey).toBe("s1");

      collector.onSessionEnd({ sessionId: "s1", messageCount: 1 }, { sessionId: "s1" });

      expect(emitted).toHaveLength(2);
      expect(emitted[1]!.endMs).toBeGreaterThan(0);
    });
  });
});
