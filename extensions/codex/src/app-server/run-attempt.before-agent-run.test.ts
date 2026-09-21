// Codex tests cover the before_agent_run admission gate in startCodexAttemptTurn.
import path from "node:path";
import type {
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CodexAppServerRpcError } from "./client.js";
import {
  assistantMessage,
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  fastWait,
  mockCall,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import { createContextEngine } from "./run-attempt.context-engine.test-support.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";

const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});
const requireRecord = createRequireRecord("record", "expected-label-object");

async function writeExistingCompactTurnBinding(sessionFile: string, workspaceDir: string) {
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-existing",
    cwd: workspaceDir,
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    historyCoveredThrough: new Date().toISOString(),
    webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
    dynamicToolsFingerprint: "[]",
  });
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt before_agent_run admission", () => {
  it("admits an allowed attempt once and starts exactly one native turn", async () => {
    const beforeAgentRun = vi.fn(async () => ({ outcome: "pass" as const }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));

    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    expect(harness.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  });

  it("blocks a denied attempt with zero native starts and a terminal blocked result", async () => {
    const beforeAgentRun = vi.fn(async () => ({
      outcome: "block" as const,
      reason: "unsafe input",
      message: "Request blocked.",
    }));
    const llmInput = vi.fn();
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_run", handler: beforeAgentRun, pluginId: "policy" },
        { hookName: "llm_input", handler: llmInput },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const result = await runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));

    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
    const terminal = readAttemptTerminal(result);
    expect(terminal.promptError).toBe(
      "Your message could not be sent: Request blocked. (blocked by policy)",
    );
    // Denial must settle as the canonical before_agent_run policy-block
    // terminal, not an ordinary "prompt" failure, so the outer harness
    // lifecycle (src/agents/harness/lifecycle.ts) reports it as blocked
    // rather than a generic error.
    expect(terminal.promptErrorSource).toBe("hook:before_agent_run");
    expect(llmInput).not.toHaveBeenCalled();
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [
      { success?: boolean; error?: string },
      unknown,
    ];
    expect(agentEndPayload.success).toBe(false);
    expect(agentEndPayload.error).toBe(
      "Your message could not be sent: Request blocked. (blocked by policy)",
    );
  });

  it("redacts the rejected prompt before the transcript owner, agent_end, or the returned snapshot see it", async () => {
    const sensitiveSentinel = "SENTINEL-4b2e-classified-prompt-payload";
    const beforeAgentRun = vi.fn(async () => ({
      outcome: "block" as const,
      reason: "unsafe input",
      message: "Request blocked.",
    }));
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_run", handler: beforeAgentRun, pluginId: "policy" },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    createStartedThreadHarness();
    const persistBlocked = vi.fn(async (_message: unknown) => undefined);
    const params = createParams(sessionFile, workspaceDir, { prompt: sensitiveSentinel });
    params.userTurnTranscriptRecorder = {
      message: undefined,
      resolveMessage: async () => undefined,
      getAdmissionReceipt: () => undefined,
      markRuntimePersistencePending() {},
      markRuntimePersisted() {},
      persistBlocked,
    } as unknown as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];

    const result = await runCodexAppServerAttempt(params);

    expect(readAttemptTerminal(result).promptErrorSource).toBe("hook:before_agent_run");

    // The transcript owner receives a redacted replacement, never the
    // original rejected prompt text.
    expect(persistBlocked).toHaveBeenCalledTimes(1);
    const [persistedMessage] = persistBlocked.mock.calls[0] as [unknown];
    expect(JSON.stringify(persistedMessage)).not.toContain(sensitiveSentinel);

    // agent_end never sees the original prompt either.
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [
      { messages?: unknown[] },
      unknown,
    ];
    expect(JSON.stringify(agentEndPayload.messages)).not.toContain(sensitiveSentinel);

    // Nor does the snapshot returned to the caller for persistence/future context.
    expect(
      JSON.stringify((result as { messagesSnapshot?: unknown[] }).messagesSnapshot),
    ).not.toContain(sensitiveSentinel);
  });

  it("keeps the loaded history's nested content unchanged when a hook mutates its snapshot, including on denial", async () => {
    // The gate must hand hooks an isolated copy of each message, not shared
    // nested objects: a hook that edits a prior message's content must not
    // alter the attempt's own history, which agent_end and the returned
    // snapshot subsequently expose, even when the attempt is denied.
    const originalMarker = "ORIGINAL-PRE-MUTATION-CONTENT-7f3d";
    const mutatedMarker = "MUTATED-BY-HOOK-CONTENT-91c8";
    const beforeAgentRun = vi.fn(async (...args: unknown[]) => {
      const event = args[0] as { messages?: Array<{ content?: Array<{ text?: string }> }> };
      const [firstMessage] = event.messages ?? [];
      if (firstMessage?.content?.[0]) {
        firstMessage.content[0].text = mutatedMarker;
      }
      return {
        outcome: "block" as const,
        reason: "test probe",
        message: "Request blocked.",
      };
    });
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_run", handler: beforeAgentRun, pluginId: "policy" },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    sessionManager.appendMessage(assistantMessage(originalMarker, Date.now()));
    createStartedThreadHarness();

    const result = await runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));

    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    // The hook did mutate the snapshot it was handed...
    const [event] = beforeAgentRun.mock.calls[0] as [{ messages?: unknown[] }];
    expect(JSON.stringify(event.messages)).toContain(mutatedMarker);
    // ...but the attempt's own loaded history must still carry the original
    // content wherever it is subsequently exposed.
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [
      { messages?: unknown[] },
      unknown,
    ];
    expect(JSON.stringify(agentEndPayload.messages)).toContain(originalMarker);
    expect(JSON.stringify(agentEndPayload.messages)).not.toContain(mutatedMarker);
    expect(JSON.stringify((result as { messagesSnapshot?: unknown[] }).messagesSnapshot)).toContain(
      originalMarker,
    );
    expect(
      JSON.stringify((result as { messagesSnapshot?: unknown[] }).messagesSnapshot),
    ).not.toContain(mutatedMarker);
  });

  it("derives the admission channel identity from the canonical per-conversation hook context", async () => {
    // Two distinct conversations on the same messaging provider must resolve
    // distinct admission channel identities. Deriving channelId from raw
    // messageChannel/messageProvider alone would collapse every conversation
    // on one provider into the same identity.
    // Block outcome keeps this test on the fast, zero-native-I/O path; the
    // event construction under test happens identically either way.
    const beforeAgentRun = vi.fn(async (..._args: unknown[]) => ({
      outcome: "block" as const,
      reason: "test probe",
      message: "Request blocked.",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );

    const runOneConversation = async (options: { sessionId: string; currentChannelId: string }) => {
      createStartedThreadHarness();
      const sessionFile = path.join(tempDir, options.sessionId, "session.jsonl");
      const workspaceDir = path.join(tempDir, options.sessionId, "workspace");
      const params = createParams(sessionFile, workspaceDir, {
        sessionId: options.sessionId,
        sessionKey: `agent:main:${options.sessionId}`,
      });
      params.messageProvider = "telegram";
      params.currentChannelId = options.currentChannelId;
      await runCodexAppServerAttempt(params);
    };

    await runOneConversation({ sessionId: "session-alpha", currentChannelId: "chat-alpha" });
    await runOneConversation({ sessionId: "session-beta", currentChannelId: "chat-beta" });

    expect(beforeAgentRun).toHaveBeenCalledTimes(2);
    const [firstEvent] = beforeAgentRun.mock.calls[0] as [{ channelId?: string }, unknown];
    const [secondEvent] = beforeAgentRun.mock.calls[1] as [{ channelId?: string }, unknown];
    expect(firstEvent.channelId).toBe("chat-alpha");
    expect(secondEvent.channelId).toBe("chat-beta");
    expect(firstEvent.channelId).not.toBe(secondEvent.channelId);
  });

  it("supplies the admission gate an isolated snapshot of the loaded session history, enabling history-dependent decisions", async () => {
    // The gate's `messages` field must carry the attempt's actual loaded
    // session history (readMirroredSessionHistoryMessages via historyState),
    // not the Codex llm_input event's historyMessages field, which is
    // deliberately empty for native Codex turns (see run-attempt.hooks.test.ts).
    // A policy that only ever sees an empty history array can never make a
    // history-dependent decision.
    const restrictedTopicMarker = "PRIOR-TURN-RESTRICTED-TOPIC-91a2";
    const beforeAgentRun = vi.fn(async (...args: unknown[]) => {
      const event = args[0] as { messages?: unknown[] };
      const historyContainsRestrictedTopic = (event.messages ?? []).some((message) =>
        JSON.stringify(message).includes(restrictedTopicMarker),
      );
      return historyContainsRestrictedTopic
        ? {
            outcome: "block" as const,
            reason: "restricted topic in history",
            message: "Request blocked.",
          }
        : { outcome: "pass" as const };
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    sessionManager.appendMessage(assistantMessage(restrictedTopicMarker, Date.now()));
    const harness = createStartedThreadHarness();

    const result = await runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));

    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    const [event] = beforeAgentRun.mock.calls[0] as [{ messages?: unknown[] }];
    expect(event.messages?.length).toBeGreaterThan(0);
    expect(JSON.stringify(event.messages)).toContain(restrictedTopicMarker);
    expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(readAttemptTerminal(result).promptErrorSource).toBe("hook:before_agent_run");
  });

  it("admits an attempt whose loaded history does not trip a history-dependent policy", async () => {
    const restrictedTopicMarker = "PRIOR-TURN-RESTRICTED-TOPIC-91a2";
    const beforeAgentRun = vi.fn(async (...args: unknown[]) => {
      const event = args[0] as { messages?: unknown[] };
      const historyContainsRestrictedTopic = (event.messages ?? []).some((message) =>
        JSON.stringify(message).includes(restrictedTopicMarker),
      );
      return historyContainsRestrictedTopic
        ? {
            outcome: "block" as const,
            reason: "restricted topic in history",
            message: "Request blocked.",
          }
        : { outcome: "pass" as const };
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    sessionManager.appendMessage(assistantMessage("unrelated prior turn", Date.now()));
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(readAttemptTerminal(result).promptError).toBeNull();
    const [event] = beforeAgentRun.mock.calls[0] as [{ messages?: unknown[] }];
    expect(JSON.stringify(event.messages)).not.toContain(restrictedTopicMarker);
    expect(harness.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  });

  it("fails closed with zero native starts when the admission hook throws", async () => {
    const beforeAgentRun = vi.fn(async () => {
      throw new Error("policy unavailable");
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const result = await runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));

    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBe(
      "Your message could not be sent: blocked by before_agent_run",
    );
  });

  it("holds diagnostics, llm_input, and the native turn until admission resolves", async () => {
    const admissionGate = createDeferred<{ outcome: "pass" }>();
    const beforeAgentRun = vi.fn(() => admissionGate.promise);
    const llmInput = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_run", handler: beforeAgentRun },
        { hookName: "llm_input", handler: llmInput },
      ]),
    );
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type === "model.call.started") {
        diagnosticEvents.push(event);
      }
    });
    try {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const harness = createStartedThreadHarness();
      const params = createParams(sessionFile, workspaceDir);
      params.config = {
        diagnostics: { enabled: true, otel: { enabled: true, traces: true } },
      } as never;
      const run = runCodexAppServerAttempt(params);

      await vi.waitFor(() => expect(beforeAgentRun).toHaveBeenCalledTimes(1), fastWait);
      // Nothing model-facing should start while admission is still pending.
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(llmInput).not.toHaveBeenCalled();
      expect(diagnosticEvents).toHaveLength(0);
      expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);

      admissionGate.resolve({ outcome: "pass" });
      await harness.waitForMethod("turn/start");
      await vi.waitFor(() => expect(llmInput).toHaveBeenCalledTimes(1), fastWait);
      await vi.waitFor(() => expect(diagnosticEvents).toHaveLength(1), fastWait);

      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    } finally {
      stopDiagnostics();
    }
  });

  it("starts no native turn when the run is cancelled while admission is still pending", async () => {
    const admissionGate = createDeferred<{ outcome: "pass" }>();
    const beforeAgentRun = vi.fn(() => admissionGate.promise);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const abortController = new AbortController();
    const params = createParams(sessionFile, workspaceDir);
    params.abortSignal = abortController.signal;

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() => expect(beforeAgentRun).toHaveBeenCalledTimes(1), fastWait);

    const abortReason = new Error("cancelled while admission pending");
    abortController.abort(abortReason);
    // Resolve admission after cancellation: neither a pass nor a block
    // decision computed for an already-cancelled attempt may start a turn.
    admissionGate.resolve({ outcome: "pass" });

    const rejection = await run.catch((error: unknown) => error);
    expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(rejection).toBe(abortReason);
  });
});

describe("runCodexAppServerAttempt before_agent_run admission reuse across native retries", () => {
  it("admits a compact-turn retry exactly once", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingCompactTurnBinding(sessionFile, workspaceDir);
    const beforeAgentRun = vi.fn(async () => ({ outcome: "pass" as const }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    let turnStartCalls = 0;
    const harnessRef: { current?: ReturnType<typeof createResumeHarness> } = {};
    const harness = createResumeHarness("thread-existing", async (method) => {
      if (method === "turn/start") {
        turnStartCalls += 1;
        if (turnStartCalls === 1) {
          queueMicrotask(() => {
            void harnessRef.current?.notify({
              method: "turn/completed",
              params: {
                threadId: "thread-existing",
                turnId: "compact-turn",
                turn: { id: "compact-turn", status: "completed", items: [] },
              },
            });
          });
          throw new CodexAppServerRpcError(
            {
              message: "cannot steer a compact turn",
              data: {
                message: "cannot steer a compact turn",
                codexErrorInfo: {
                  activeTurnNotSteerable: { turnKind: "compact" },
                },
                additionalDetails: null,
              },
            },
            "turn/start",
          );
        }
        return turnStartResult("turn-1");
      }
      return undefined;
    });
    harnessRef.current = harness;
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await vi.waitFor(
      () =>
        expect(harness.requests.filter((request) => request.method === "turn/start")).toHaveLength(
          2,
        ),
      fastWait,
    );
    // Both native turn/start attempts (the compact-blocked call and its retry)
    // share the one admission decision made before either call.
    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;
    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
  });

  it("admits a fresh-thread context-engine overflow retry exactly once", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-before",
        },
      },
    });
    const beforeAgentRun = vi.fn(async () => ({ outcome: "pass" as const }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const assemble = vi.fn(
      async ({ messages, prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: [
          ...messages,
          assistantMessage("context epoch-before", 10),
          userMessage(prompt ?? "", 11),
        ],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-before" },
      }),
    );
    const contextEngine = createContextEngine({ assemble });
    const freshTurnStarted = createDeferred<void>();
    const harness = createStartedThreadHarness(
      async (method, requestParams) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-old");
        }
        if (method === "thread/start") {
          return threadStartResult("thread-fresh");
        }
        if (method === "turn/start") {
          const request = requireRecord(requestParams, `${method} params`);
          if (request.threadId === "thread-old") {
            throw new Error("Codex ran out of room in the model's context window");
          }
          if (request.threadId === "thread-fresh") {
            freshTurnStarted.resolve();
            return turnStartResult("turn-fresh");
          }
        }
        return undefined;
      },
      { persistedThreads: ["thread-old"] },
    );
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;

    const run = runCodexAppServerAttempt(params);
    try {
      await Promise.race([
        freshTurnStarted.promise,
        run.then((result) => {
          throw new Error("Codex attempt settled before fresh turn/start", {
            cause: readAttemptTerminal(result),
          });
        }),
      ]);
      // Two native turn/start attempts (stale thread, then fresh thread) share
      // the one admission decision made before either call.
      expect(harness.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
      expect(beforeAgentRun).toHaveBeenCalledTimes(1);
      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-fresh",
          turnId: "turn-fresh",
          turn: {
            id: "turn-fresh",
            status: "completed",
            items: [{ type: "agentMessage", id: "msg-1", text: "fresh answer" }],
          },
        },
      });
      const result = await run;
      expect(result.assistantTexts).toContain("fresh answer");
      expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    } finally {
      await harness.client.closeAndWait();
      await run.catch(() => undefined);
    }
  });
});
