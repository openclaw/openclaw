// Verifies Claude CLI synthetic harness/run hierarchy and terminal events.
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

function captureLifecycle(runId: string) {
  const events: Array<{
    event: DiagnosticEventPayload;
    privateData: DiagnosticEventPrivateData;
  }> = [];
  const unsubscribe = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
    if ("runId" in event && event.runId === runId) {
      events.push({ event, privateData });
    }
  });
  return { events, unsubscribe };
}

async function flushDiagnosticEvents(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("Claude CLI run diagnostics", () => {
  afterEach(() => {
    resetAgentEventsForTest();
    resetDiagnosticEventsForTest();
  });

  it("nests model calls beneath synthetic run and harness spans", async () => {
    const runId = "run-claude-hierarchy";
    const diagnostics = captureLifecycle(runId);
    let callbackTrace: DiagnosticTraceContext | undefined;
    let result: { diagnosticTrace?: DiagnosticTraceContext } | undefined;
    try {
      result = await runWithDiagnosticTraceContext(parentTrace, () =>
        runClaudeCliAgentTurnWithDiagnostics(
          {
            runId,
            agentId: "test-claude-agent",
            sessionId: "session-1",
            sessionKey: "agent:test-claude-agent:main",
            modelProvider: "anthropic",
            model: "claude-opus-4-7",
            trigger: "user",
            messageChannel: "webchat",
          },
          async () => {
            callbackTrace = getActiveDiagnosticTraceContext();
            const modelTrace = freezeDiagnosticTraceContext(
              createDiagnosticTraceContextFromActiveScope(),
            );
            emitTrustedDiagnosticEventWithPrivateData(
              {
                type: "model.call.started",
                runId,
                callId: "call-1",
                sessionId: "session-1",
                provider: "anthropic",
                model: "claude-opus-4-7",
                api: "claude-code",
                transport: "stdio-live",
                observationUnit: "turn",
                trace: modelTrace,
              },
              undefined,
            );
            emitTrustedDiagnosticEventWithPrivateData(
              {
                type: "model.call.completed",
                runId,
                callId: "call-1",
                sessionId: "session-1",
                provider: "anthropic",
                model: "claude-opus-4-7",
                api: "claude-code",
                transport: "stdio-live",
                observationUnit: "turn",
                durationMs: 5,
                trace: modelTrace,
              },
              undefined,
            );
            return {
              payloads: [{ text: "ok" }],
              meta: { durationMs: 5, finalAssistantVisibleText: "ok" },
            };
          },
        ),
      );
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    expect(diagnostics.events).toHaveLength(6);
    expect(diagnostics.events.map(({ event }) => event.type)).toEqual(
      expect.arrayContaining([
        "harness.run.started",
        "run.started",
        "model.call.started",
        "model.call.completed",
        "run.completed",
        "harness.run.completed",
      ]),
    );
    const harnessStarted = diagnostics.events.find(
      ({ event }) => event.type === "harness.run.started",
    )?.event as Extract<DiagnosticEventPayload, { type: "harness.run.started" }>;
    const runStarted = diagnostics.events.find(({ event }) => event.type === "run.started")
      ?.event as Extract<DiagnosticEventPayload, { type: "run.started" }>;
    const modelStarted = diagnostics.events.find(({ event }) => event.type === "model.call.started")
      ?.event as Extract<DiagnosticEventPayload, { type: "model.call.started" }>;
    expect(harnessStarted.harnessId).toBe("claude-cli");
    expect(harnessStarted.agentId).toBe("test-claude-agent");
    expect(harnessStarted.provider).toBe("anthropic");
    expect(harnessStarted.trace?.traceId).toBe(parentTrace.traceId);
    expect(harnessStarted.trace?.parentSpanId).toBe(parentTrace.spanId);
    expect(runStarted.trace?.parentSpanId).toBe(harnessStarted.trace?.spanId);
    expect(runStarted.agentId).toBe("test-claude-agent");
    expect(modelStarted.trace?.parentSpanId).toBe(runStarted.trace?.spanId);
    expect(modelStarted.observationUnit).toBe("turn");
    expect(callbackTrace).toEqual(runStarted.trace);
    expect(result?.diagnosticTrace).toEqual(harnessStarted.trace);
    expect(
      diagnostics.events.find(({ event }) => event.type === "run.completed")?.event,
    ).toMatchObject({
      type: "run.completed",
      outcome: "completed",
    });
    expect(
      diagnostics.events.find(({ event }) => event.type === "harness.run.completed")?.event,
    ).toMatchObject({
      type: "harness.run.completed",
      outcome: "completed",
    });
  });

  it("attributes post-preparation run and harness events to the resolved execution owner", async () => {
    // Distinct runtime-policy requester (worker) and session-resolved execution
    // owner (main): preparation publishes the owner through the lifecycle, and
    // model-call diagnostics read the prepared params. Run/harness events must
    // agree with the model-call attribution once the owner is known.
    const runId = "run-claude-execution-owner";
    const diagnostics = captureLifecycle(runId);
    try {
      await runClaudeCliAgentTurnWithDiagnostics(
        {
          runId,
          agentId: "worker",
          sessionId: "session-owner",
          sessionKey: "agent:main:main",
          modelProvider: "anthropic",
          model: "claude-opus-4-7",
          trigger: "user",
          messageChannel: "webchat",
        },
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
          const modelTrace = freezeDiagnosticTraceContext(
            createDiagnosticTraceContextFromActiveScope(),
          );
          emitTrustedDiagnosticEventWithPrivateData(
            {
              type: "model.call.started",
              runId,
              agentId: "main",
              callId: "call-owner-1",
              sessionId: "session-owner",
              provider: "anthropic",
              model: "claude-opus-4-7",
              api: "claude-code",
              transport: "stdio-live",
              observationUnit: "turn",
              trace: modelTrace,
            },
            undefined,
          );
          emitTrustedDiagnosticEventWithPrivateData(
            {
              type: "model.call.completed",
              runId,
              agentId: "main",
              callId: "call-owner-1",
              sessionId: "session-owner",
              provider: "anthropic",
              model: "claude-opus-4-7",
              api: "claude-code",
              transport: "stdio-live",
              observationUnit: "turn",
              durationMs: 4,
              trace: modelTrace,
            },
            undefined,
          );
          return {
            payloads: [{ text: "ok" }],
            meta: { durationMs: 5, finalAssistantVisibleText: "ok" },
          };
        },
      );
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    expect(diagnostics.events.map(({ event }) => event.type)).toEqual(
      expect.arrayContaining([
        "harness.run.started",
        "run.started",
        "model.call.started",
        "model.call.completed",
        "run.completed",
        "harness.run.completed",
      ]),
    );
    const eventOf = <T extends DiagnosticEventPayload["type"]>(type: T) =>
      diagnostics.events.find(({ event }) => event.type === type)?.event as Extract<
        DiagnosticEventPayload,
        { type: T }
      >;
    // Admission-time events carry the requester identity recorded at its producer.
    expect(eventOf("harness.run.started")?.agentId).toBe("worker");
    expect(eventOf("run.started")?.agentId).toBe("worker");
    // Post-preparation events attribute to the resolved execution owner.
    expect(eventOf("run.completed")?.agentId).toBe("main");
    expect(eventOf("harness.run.completed")?.agentId).toBe("main");
    // Run/harness attribution agrees with the model-call attribution.
    expect(eventOf("model.call.started")?.agentId).toBe("main");
    expect(eventOf("run.completed")?.agentId).toBe(eventOf("model.call.started")?.agentId);
    const commentary = diagnostics.events.find(({ event }) => event.type === "agent.commentary");
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
    try {
      await expect(
        runClaudeCliAgentTurnWithDiagnostics(
          {
            runId,
            sessionId: "session-2",
            modelProvider: "anthropic",
            model: "claude-opus-4-7",
          },
          async (lifecycle) => {
            lifecycle.setExecutionContext({ agentId: "main", config: {} });
            emitAgentEvent({
              runId,
              stream: "item",
              data: { kind: "preamble", phase: "end", progressText: "Before error." },
            });
            lifecycle.setPhase("cleanup");
            throw new Error("managed session cleanup failed");
          },
        ),
      ).rejects.toThrow("managed session cleanup failed");
      emitAgentEvent({
        runId,
        stream: "item",
        data: { kind: "preamble", phase: "end", progressText: "After error." },
      });
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

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
    expect(
      diagnostics.events.find(({ event }) => event.type === "run.completed")?.event,
    ).toMatchObject({
      type: "run.completed",
      outcome: "error",
    });
    expect(
      diagnostics.events.find(({ event }) => event.type === "harness.run.error")?.event,
    ).toMatchObject({
      type: "harness.run.error",
      phase: "cleanup",
    });
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
      harnessOutcome: "aborted" as const,
    },
    {
      label: "timeout",
      error: new Error("CLI exceeded timeout (30s) and was terminated"),
      harnessOutcome: "timed_out" as const,
    },
  ])("completes the harness once for a thrown $label", async ({ error, harnessOutcome }) => {
    const runId = `run-claude-hierarchy-${harnessOutcome}`;
    const diagnostics = captureLifecycle(runId);
    try {
      await expect(
        runClaudeCliAgentTurnWithDiagnostics(
          {
            runId,
            sessionId: "session-termination",
            modelProvider: "anthropic",
            model: "claude-opus-4-7",
          },
          async (lifecycle) => {
            lifecycle.setPhase("send");
            throw error;
          },
        ),
      ).rejects.toThrow(error.message);
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    expect(diagnostics.events).toHaveLength(4);
    expect(
      diagnostics.events.find(({ event }) => event.type === "run.completed")?.event,
    ).toMatchObject({
      type: "run.completed",
      outcome: "aborted",
    });
    expect(
      diagnostics.events.filter(
        ({ event }) => event.type === "harness.run.completed" || event.type === "harness.run.error",
      ),
    ).toHaveLength(1);
    expect(
      diagnostics.events.find(({ event }) => event.type === "harness.run.completed")?.event,
    ).toMatchObject({
      type: "harness.run.completed",
      outcome: harnessOutcome,
    });
    expect(diagnostics.events.some(({ event }) => event.type === "harness.run.error")).toBe(false);
  });

  it("keeps the captured prompt on terminal events when the turn fails", async () => {
    setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: true } } });
    const runId = "run-claude-failure-content";
    const diagnostics = captureLifecycle(runId);
    try {
      await expect(
        runClaudeCliAgentTurnWithDiagnostics(
          {
            runId,
            sessionId: "session-failure-content",
            modelProvider: "anthropic",
            model: "claude-opus-4-7",
          },
          async (lifecycle) => {
            lifecycle.publishCapturedContent({ userPrompt: "prepare the release" });
            lifecycle.setPhase("send");
            throw new Error("CLI crashed mid-turn");
          },
        ),
      ).rejects.toThrow("CLI crashed mid-turn");
      await flushDiagnosticEvents();
    } finally {
      clearRuntimeConfigSnapshot();
    }

    const runCompleted = diagnostics.events.find(({ event }) => event.type === "run.completed");
    expect(runCompleted?.privateData.messageContent).toMatchObject({
      userPrompt: "prepare the release",
    });

    const harnessError = diagnostics.events.find(({ event }) => event.type === "harness.run.error");
    expect(harnessError?.privateData.harnessContent).toMatchObject({
      userPrompt: "prepare the release",
    });
  });

  it("attaches published turn content to run and harness completed events", async () => {
    setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: true } } });
    const runId = "run-claude-content-capture";
    const diagnostics = captureLifecycle(runId);
    try {
      await runClaudeCliAgentTurnWithDiagnostics(
        {
          runId,
          sessionId: "session-content",
          modelProvider: "anthropic",
          model: "claude-opus-4-7",
          trigger: "user",
          messageChannel: "webchat",
        },
        async (lifecycle) => {
          lifecycle.publishCapturedContent({
            userPrompt: "prepare the release",
            finalResponse: "release prepared",
          });
          return {
            payloads: [{ text: "release prepared" }],
            meta: {},
          };
        },
      );
      await flushDiagnosticEvents();

      const runCompleted = diagnostics.events.find(({ event }) => event.type === "run.completed");
      expect(runCompleted?.privateData.messageContent).toMatchObject({
        userPrompt: "prepare the release",
        finalResponse: "release prepared",
      });

      const harnessCompleted = diagnostics.events.find(
        ({ event }) => event.type === "harness.run.completed",
      );
      expect(harnessCompleted?.privateData.harnessContent).toMatchObject({
        userPrompt: "prepare the release",
        finalResponse: "release prepared",
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("merges separately published prompt and response into the completed events", async () => {
    // The real caller publishes { userPrompt } after preparation and
    // { finalResponse } after settlement; the second publication must not
    // discard the first's captured prompt.
    setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: true } } });
    const runId = "run-claude-content-merge";
    const diagnostics = captureLifecycle(runId);
    try {
      await runClaudeCliAgentTurnWithDiagnostics(
        {
          runId,
          sessionId: "session-content-merge",
          modelProvider: "anthropic",
          model: "claude-opus-4-7",
          trigger: "user",
          messageChannel: "webchat",
        },
        async (lifecycle) => {
          lifecycle.publishCapturedContent({ userPrompt: "prepare the release" });
          lifecycle.publishCapturedContent({ finalResponse: "release prepared" });
          return {
            payloads: [{ text: "release prepared" }],
            meta: {},
          };
        },
      );
      await flushDiagnosticEvents();

      const runCompleted = diagnostics.events.find(({ event }) => event.type === "run.completed");
      expect(runCompleted?.privateData.messageContent).toMatchObject({
        userPrompt: "prepare the release",
        finalResponse: "release prepared",
      });

      const harnessCompleted = diagnostics.events.find(
        ({ event }) => event.type === "harness.run.completed",
      );
      expect(harnessCompleted?.privateData.harnessContent).toMatchObject({
        userPrompt: "prepare the release",
        finalResponse: "release prepared",
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("keeps published turn content off events without captureContent", async () => {
    setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: false } } });
    const runId = "run-claude-content-disabled";
    const diagnostics = captureLifecycle(runId);
    try {
      await runClaudeCliAgentTurnWithDiagnostics(
        {
          runId,
          sessionId: "session-content-off",
          modelProvider: "anthropic",
          model: "claude-opus-4-7",
          trigger: "user",
          messageChannel: "webchat",
        },
        async (lifecycle) => {
          lifecycle.publishCapturedContent({
            userPrompt: "prepare the release",
            finalResponse: "release prepared",
          });
          return {
            payloads: [{ text: "release prepared" }],
            meta: {},
          };
        },
      );
      await flushDiagnosticEvents();

      const runCompleted = diagnostics.events.find(({ event }) => event.type === "run.completed");
      expect(runCompleted?.privateData.messageContent).toBeUndefined();

      const harnessCompleted = diagnostics.events.find(
        ({ event }) => event.type === "harness.run.completed",
      );
      expect(harnessCompleted?.privateData.harnessContent).toBeUndefined();
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });
});
