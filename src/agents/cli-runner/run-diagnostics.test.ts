import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { runClaudeCliAgentTurnWithDiagnostics } from "./run-diagnostics.js";

const parentTrace: DiagnosticTraceContext = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: "01",
};
const modelEventTypes = [
  "harness.run.started",
  "run.started",
  "model.call.started",
  "model.call.completed",
  "run.completed",
  "harness.run.completed",
];
const success = (text = "ok", durationMs = 0) => ({
  payloads: [{ text }],
  meta: { durationMs, finalAssistantVisibleText: text },
});
function captureContent(enabled = true) {
  setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: enabled } } });
}
async function flushDiagnosticEvents() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function captureLifecycle(runId: string) {
  type Captured<T extends DiagnosticEventPayload = DiagnosticEventPayload> = {
    event: T;
    privateData: DiagnosticEventPrivateData;
  };
  const events: Captured[] = [];
  // afterEach clears listeners; keep this one subscribed through post-turn probes.
  onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
    if ("runId" in event && event.runId === runId) {
      events.push({ event, privateData });
    }
  });
  const record = <T extends DiagnosticEventPayload["type"]>(type: T) =>
    events.find(
      (entry): entry is Captured<Extract<DiagnosticEventPayload, { type: T }>> =>
        entry.event.type === type,
    );
  return {
    events,
    record,
    eventOf: <T extends DiagnosticEventPayload["type"]>(type: T) =>
      expectDefined(record(type), type).event,
    async run(
      callback: Parameters<typeof runClaudeCliAgentTurnWithDiagnostics>[1],
      overrides: Partial<Parameters<typeof runClaudeCliAgentTurnWithDiagnostics>[0]> = {},
    ) {
      try {
        return await runClaudeCliAgentTurnWithDiagnostics(
          {
            runId,
            sessionId: "session-test",
            modelProvider: "anthropic",
            model: "claude-opus-4-7",
            ...overrides,
          },
          callback,
        );
      } finally {
        await flushDiagnosticEvents();
      }
    },
  };
}

function emitModelCall(
  runId: string,
  sessionId: string,
  callId: string,
  durationMs: number,
  agentId?: string,
) {
  const base = {
    runId,
    sessionId,
    callId,
    ...(agentId ? { agentId } : {}),
    provider: "anthropic",
    model: "claude-opus-4-7",
    api: "claude-code",
    transport: "stdio-live",
    observationUnit: "turn" as const,
    trace: freezeDiagnosticTraceContext(createDiagnosticTraceContextFromActiveScope()),
  };
  emitTrustedDiagnosticEventWithPrivateData({ type: "model.call.started", ...base }, undefined);
  emitTrustedDiagnosticEventWithPrivateData(
    { type: "model.call.completed", ...base, durationMs },
    undefined,
  );
}

describe("Claude CLI run diagnostics", () => {
  afterEach(() => {
    resetAgentEventsForTest();
    resetDiagnosticEventsForTest();
    clearRuntimeConfigSnapshot();
  });

  it("attributes isolated run and harness events to their utility purpose", async () => {
    const diagnostics = captureLifecycle("utility-run");
    await diagnostics.run(async () => ({ payloads: [{ text: "done" }], meta: { durationMs: 1 } }), {
      sessionId: "utility-session",
      isolatedCompletionPurpose: "session-activity-summary",
      modelProvider: undefined,
      model: undefined,
    });
    expect(diagnostics.events.map(({ event }) => event.type)).toEqual([
      "harness.run.started",
      "run.started",
      "run.completed",
      "harness.run.completed",
    ]);
    for (const { event } of diagnostics.events) {
      expect(event).toMatchObject({ trigger: "session-activity-summary" });
    }
  });

  it("nests model calls beneath synthetic run and harness spans", async () => {
    const runId = "run-claude-hierarchy";
    const diagnostics = captureLifecycle(runId);
    let callbackTrace: DiagnosticTraceContext | undefined;
    const result = await runWithDiagnosticTraceContext(parentTrace, () =>
      diagnostics.run(
        async () => {
          callbackTrace = getActiveDiagnosticTraceContext();
          emitModelCall(runId, "session-1", "call-1", 5);
          return success("ok", 5);
        },
        {
          agentId: "test-claude-agent",
          sessionId: "session-1",
          sessionKey: "agent:test-claude-agent:main",
          trigger: "user",
          messageChannel: "webchat",
        },
      ),
    );

    expect(diagnostics.events).toHaveLength(6);
    expect(diagnostics.events.map(({ event }) => event.type)).toEqual(
      expect.arrayContaining(modelEventTypes),
    );
    const harnessStarted = diagnostics.eventOf("harness.run.started");
    const runStarted = diagnostics.eventOf("run.started");
    expect(harnessStarted).toMatchObject({
      harnessId: "claude-cli",
      agentId: "test-claude-agent",
      provider: "anthropic",
      trace: { traceId: parentTrace.traceId, parentSpanId: parentTrace.spanId },
    });
    expect(runStarted).toMatchObject({
      agentId: "test-claude-agent",
      trace: { parentSpanId: harnessStarted.trace?.spanId },
    });
    expect(diagnostics.eventOf("model.call.started")).toMatchObject({
      observationUnit: "turn",
      trace: { parentSpanId: runStarted.trace?.spanId },
    });
    expect(callbackTrace).toEqual(runStarted.trace);
    expect(result.diagnosticTrace).toEqual(harnessStarted.trace);
    expect(diagnostics.eventOf("run.completed").outcome).toBe("completed");
    expect(diagnostics.eventOf("harness.run.completed").outcome).toBe("completed");
  });

  it("attributes post-preparation run and harness events to the resolved execution owner", async () => {
    const runId = "run-claude-execution-owner";
    const diagnostics = captureLifecycle(runId);
    await diagnostics.run(
      async (lifecycle) => {
        lifecycle.setExecutionContext({
          agentId: "main",
          config: { diagnostics: { otel: { enabled: true, captureContent: true } } },
        });
        runWithDiagnosticTraceContext(undefined, () =>
          emitAgentEvent({
            runId,
            stream: "item",
            data: {
              kind: "preamble",
              itemId: "cli-1",
              phase: "end",
              progressText: "Checking files.",
            },
          }),
        );
        emitModelCall(runId, "session-owner", "call-owner-1", 4, "main");
        return success("ok", 5);
      },
      {
        agentId: "worker",
        sessionId: "session-owner",
        sessionKey: "agent:main:main",
        trigger: "user",
        messageChannel: "webchat",
      },
    );
    expect(diagnostics.events.map(({ event }) => event.type)).toEqual(
      expect.arrayContaining(modelEventTypes),
    );
    const { eventOf } = diagnostics;
    // Start events retain the requester; preparation owns subsequent attribution.
    expect(eventOf("harness.run.started").agentId).toBe("worker");
    expect(eventOf("run.started").agentId).toBe("worker");
    expect(eventOf("run.completed").agentId).toBe("main");
    expect(eventOf("harness.run.completed").agentId).toBe("main");
    expect(eventOf("model.call.started").agentId).toBe("main");
    expect(eventOf("run.completed").agentId).toBe(eventOf("model.call.started").agentId);
    const commentary = diagnostics.record("agent.commentary");
    expect(commentary?.event).toMatchObject({
      agentId: "main",
      harnessId: "claude-cli",
      trace: eventOf("harness.run.started").trace,
      contentCaptured: true,
    });
    expect(commentary?.privateData.modelContent?.outputMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Checking files." }] },
    ]);
  });

  it("emits one terminal run and harness event when the Claude turn fails", async () => {
    const runId = "run-claude-hierarchy-error";
    const diagnostics = captureLifecycle(runId);
    const commentary = (progressText: string) =>
      emitAgentEvent({
        runId,
        stream: "item",
        data: { kind: "preamble", phase: "end", progressText },
      });
    await expect(
      diagnostics.run(
        async (lifecycle) => {
          lifecycle.setExecutionContext({ agentId: "main", config: {} });
          commentary("Before error.");
          lifecycle.setPhase("cleanup");
          throw new Error("managed session cleanup failed");
        },
        { sessionId: "session-2" },
      ),
    ).rejects.toThrow("managed session cleanup failed");
    commentary("After error.");
    await flushDiagnosticEvents();
    expect(diagnostics.events).toHaveLength(5);
    expect(
      diagnostics.events.filter(({ event }) => event.type === "agent.commentary"),
    ).toHaveLength(1);
    expect(diagnostics.events.map(({ event }) => event.type)).toEqual(
      expect.arrayContaining([
        "harness.run.started",
        "run.started",
        "run.completed",
        "harness.run.error",
      ]),
    );
    expect(diagnostics.eventOf("run.completed").outcome).toBe("error");
    expect(diagnostics.eventOf("harness.run.error").phase).toBe("cleanup");
    expect(
      diagnostics.events
        .filter(({ event }) => event.type === "run.completed" || event.type === "harness.run.error")
        .every(({ privateData }) => privateData.errorMessage === "managed session cleanup failed"),
    ).toBe(true);
  });

  it.each([
    {
      label: "abort",
      error: Object.assign(new Error("operation was aborted"), { code: "ABORT_ERR" }),
      harnessOutcome: "aborted",
    },
    {
      label: "timeout",
      error: new Error("CLI exceeded timeout (30s) and was terminated"),
      harnessOutcome: "timed_out",
    },
  ])("completes the harness once for a thrown $label", async ({ error, harnessOutcome }) => {
    const diagnostics = captureLifecycle(`run-claude-hierarchy-${harnessOutcome}`);
    await expect(
      diagnostics.run(
        async (lifecycle) => {
          lifecycle.setPhase("send");
          throw error;
        },
        { sessionId: "session-termination" },
      ),
    ).rejects.toThrow(error.message);
    expect(diagnostics.events).toHaveLength(4);
    expect(diagnostics.eventOf("run.completed").outcome).toBe("aborted");
    expect(
      diagnostics.events.filter(
        ({ event }) => event.type === "harness.run.completed" || event.type === "harness.run.error",
      ),
    ).toHaveLength(1);
    expect(diagnostics.eventOf("harness.run.completed").outcome).toBe(harnessOutcome);
    expect(diagnostics.events.some(({ event }) => event.type === "harness.run.error")).toBe(false);
  });

  it("keeps the captured prompt on terminal events when the turn fails", async () => {
    captureContent();
    const diagnostics = captureLifecycle("run-claude-failure-content");
    await expect(
      diagnostics.run(
        async (lifecycle) => {
          lifecycle.publishCapturedContent({ userPrompt: "prepare the release" });
          lifecycle.setPhase("send");
          throw new Error("CLI crashed mid-turn");
        },
        { sessionId: "session-failure-content" },
      ),
    ).rejects.toThrow("CLI crashed mid-turn");
    expect(diagnostics.record("run.completed")?.privateData.messageContent).toMatchObject({
      userPrompt: "prepare the release",
    });
    expect(diagnostics.record("harness.run.error")?.privateData.harnessContent).toMatchObject({
      userPrompt: "prepare the release",
    });
  });

  it("captures raw CLI output before transformed payload text", async () => {
    captureContent();
    const diagnostics = captureLifecycle("run-claude-raw-content");
    await diagnostics.run(
      async (lifecycle) => {
        lifecycle.publishResultContent({
          payloads: [{ text: "goodbye from cli" }],
          meta: { durationMs: 0, finalAssistantRawText: "hello from cli" },
        });
        return { payloads: [], meta: { durationMs: 0 } };
      },
      { sessionId: "session-raw-content", model: "claude" },
    );
    expect(diagnostics.record("run.completed")?.privateData.messageContent).toMatchObject({
      finalResponse: "hello from cli",
    });
  });

  it("does not capture CLI error payloads", async () => {
    captureContent();
    const diagnostics = captureLifecycle("run-claude-error-payload");
    await diagnostics.run(
      async (lifecycle) => {
        lifecycle.publishResultContent({
          payloads: [{ text: "host failure", isError: true }],
          meta: { durationMs: 0, error: { kind: "incomplete_turn", message: "host failure" } },
        });
        return { payloads: [], meta: { durationMs: 0 } };
      },
      { sessionId: "session-error-payload", model: "claude" },
    );
    expect(diagnostics.record("run.completed")?.privateData.messageContent).toBeUndefined();
  });

  it.each([true, false])("merges turn content only with captureContent=%s", async (enabled) => {
    captureContent(enabled);
    const diagnostics = captureLifecycle(`run-claude-content-${enabled}`);
    const content = { userPrompt: "prepare the release", finalResponse: "release prepared" };
    await diagnostics.run(
      async (lifecycle) => {
        lifecycle.publishCapturedContent({ userPrompt: content.userPrompt });
        lifecycle.publishCapturedContent({ finalResponse: content.finalResponse });
        return { payloads: [{ text: content.finalResponse }], meta: { durationMs: 0 } };
      },
      { trigger: "user", messageChannel: "webchat" },
    );
    const expected = enabled ? expect.objectContaining(content) : undefined;
    expect(diagnostics.record("run.completed")?.privateData.messageContent).toEqual(expected);
    expect(diagnostics.record("harness.run.completed")?.privateData.harnessContent).toEqual(
      expected,
    );
  });
});
