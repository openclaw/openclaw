import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { Context, Model, SimpleStreamOptions } from "../../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";
import type { AgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  estimateCompactionHistoryTokens,
  type CompactionRequestBudget,
} from "../../sessions/compaction/request-budget.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import { makeAgentUserMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import {
  retainEmbeddedSessionPromptState,
  clearEmbeddedSessionPromptStates,
  prepareSessionSystemPrompt,
  persistSessionSystemPrompt,
} from "../session-prompt-state.js";
import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import type {
  PromptPreflightCall,
  PromptSubmissionCall,
} from "./attempt-prompt-phase.test-support.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

// Register the shared module mocks before importing any runtime dependency.
const { createFixture, createReadToolPolicy, mocks } = await vi.hoisted(
  async () => await import("./attempt-prompt-phase.test-support.js"),
);

type PromptErrorCall = {
  error: unknown;
  markYieldAborted: () => void;
  releaseLeasedSteering: (error?: unknown) => void;
  yieldAbortSettled: Promise<void> | null;
  yieldDetected: boolean;
  yieldMessage: string | null;
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.applyPromptToolsAllow.mockReturnValue(createReadToolPolicy());
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
});

registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  clearEmbeddedSessionPromptStates(["phase-context-replay", "phase-finalization"]);
});

function assistantWithUsage(model: Model, text: string, promptTokens: number) {
  const response = createAssistant(model, text, "stop", promptTokens);
  response.usage.output = Math.ceil(text.length / 4);
  response.usage.totalTokens = promptTokens + response.usage.output;
  response.usage.contextUsage = {
    state: "available",
    promptTokens,
    totalTokens: response.usage.totalTokens,
  };
  return response;
}

function collectBudgets(fixture: ReturnType<typeof createFixture>) {
  const budgets: CompactionRequestBudget[] = [];
  fixture.input.attempt.onCompactionRequestBudget = (budget) => {
    if (budget) {
      budgets.push(budget);
    }
  };
  return budgets;
}

function implementation<T extends (...args: never[]) => unknown>(mock: Mock<T>): T {
  return expectDefined(mock.getMockImplementation(), "fixture implementation");
}

describe("runEmbeddedAttemptPromptPhase", () => {
  it.each([
    { appendOnlyRuntimeContext: true, queued: false },
    { appendOnlyRuntimeContext: false, queued: false },
    { appendOnlyRuntimeContext: true, queued: true },
    { appendOnlyRuntimeContext: false, queued: true },
  ])(
    "budgets submitted context with a recorded carrier (appendOnly=$appendOnlyRuntimeContext, queued=$queued)",
    async ({ appendOnlyRuntimeContext, queued }) => {
      const fixture = createFixture({ pendingPrompt: "hello", pendingImageCount: 0 });
      const currentUser = {
        ...makeAgentUserMessage({ content: "hello", timestamp: 1 }),
        idempotencyKey: "current:user",
        __openclaw: { modelPromptProjection: { version: 1, text: "hello" } },
      };
      const oldCarrier = buildRuntimeContextCustomMessage("Previously recorded context");
      const nextCarrier = buildRuntimeContextCustomMessage(
        "New transient context. ".repeat(queued ? 1 : 200),
      );
      if (!oldCarrier || !nextCarrier) {
        throw new Error("Expected both runtime carriers");
      }
      const manager = SessionManager.inMemory();
      if (queued) {
        const history = [
          makeAgentUserMessage({
            content: "Earlier project archive. ".repeat(1_500),
            timestamp: 1,
          }),
          createAssistant(testModel, "Recorded project facts. ".repeat(900)),
          makeAgentUserMessage({
            content: "Current project archive. ".repeat(1_500),
            timestamp: 3,
          }),
        ];
        for (const message of history) {
          manager.appendMessage(message);
        }
        const priorInput = Math.ceil(
          JSON.stringify(history.map(({ role, content }) => ({ role, content }))).length / 4,
        );
        const priorText = "Recorded current facts. ".repeat(800);
        const prior = assistantWithUsage(testModel, priorText, priorInput);
        expect(prior.usage.totalTokens).toBeGreaterThan(24_576);
        expect(prior.usage.totalTokens).toBeLessThan(testModel.contextWindow!);
        manager.appendMessage(prior);
      }
      manager.appendMessage(currentUser);
      manager.appendCustomMessageEntry(
        oldCarrier.customType,
        oldCarrier.content,
        oldCarrier.display,
        oldCarrier.details,
      );
      const { session, settingsManager } = await createTestSession({
        sessionManager: manager,
        settingsManager: queued
          ? SettingsManager.inMemory({
              compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 20_000 },
              retry: { enabled: false },
            })
          : undefined,
      });
      const queuedContext = "Queued project material. ".repeat(1_120).trim();
      const queuedMessage = {
        role: "custom" as const,
        customType: "test.ordinary-queued-context",
        content: queuedContext,
        display: false,
        timestamp: 1,
      };
      if (queued) {
        await session.sendCustomMessage(queuedMessage, { deliverAs: "nextTurn" });
      }
      const recorder = createUserTurnTranscriptRecorder({
        message: currentUser,
        target: () => undefined,
      });
      recorder.markRuntimePersisted(currentUser);
      const { sessionRuntime } = fixture.input.prepared;
      sessionRuntime.agentSession.activeSession = session;
      sessionRuntime.agentSession.settingsManager = settingsManager;
      sessionRuntime.sessionManager = manager;
      sessionRuntime.preparedUserTurnMessage = currentUser;
      sessionRuntime.state.systemPromptText = session.systemPrompt;
      fixture.input.attempt = {
        ...fixture.input.attempt,
        model: testModel,
        provider: testModel.provider,
        modelId: testModel.id,
        config: {},
        userTurnTranscriptRecorder: recorder,
      };
      fixture.input.attempt.sessionId = "phase-context-replay";
      using promptStateLease = retainEmbeddedSessionPromptState(fixture.input.attempt.sessionId);
      const sessionPromptState = promptStateLease.state;
      sessionRuntime.sessionPromptState = sessionPromptState;
      sessionRuntime.toolResultPromptProjectionState = sessionPromptState.toolResults;
      sessionRuntime.transcriptPolicy.appendOnlyRuntimeContext = appendOnlyRuntimeContext;
      fixture.input.preparedStreamRuntime.promptActiveSession = (prompt, options) =>
        session.prompt(prompt, options);
      await prepareEmbeddedAttemptSessionBoundary({
        activeSession: session,
        appendOnlyRuntimeContext,
        attempt: fixture.input.attempt,
        getUserTranscriptContexts: () => undefined,
        isRawModelRun: false,
        preparedUserTurnMessage: currentUser,
        sessionManager: manager,
        setActiveSessionSystemPrompt: (prompt) => {
          session.agent.state.systemPrompt = prompt;
        },
      });
      const context = mocks.preparePromptContext.getMockImplementation()!;
      mocks.preparePromptContext.mockImplementation((...args) => ({
        ...context(...args),
        contextTokenBudget: testModel.contextWindow,
        runtimeContextMessageForCurrentTurn: nextCarrier,
        systemPromptForHook: session.systemPrompt,
      }));
      const budgets = collectBudgets(fixture);
      const { submitEmbeddedAttemptPrompt } = await vi.importActual<
        typeof import("./attempt-prompt-submit.js")
      >("./attempt-prompt-submit.js");
      mocks.submitPrompt.mockImplementation(submitEmbeddedAttemptPrompt);
      const requests: string[] = [];
      const requestTokens: number[] = [];
      streamMocks.streamSimple.mockImplementation(
        (model: Model, providerContext: Context, options?: SimpleStreamOptions) => {
          const wire = JSON.stringify({
            system: providerContext.systemPrompt,
            tools: providerContext.tools,
            messages: providerContext.messages.map(({ role, content }) => ({ role, content })),
          });
          const tokens = Math.ceil(wire.length / 4);
          const foreground = !session.isCompacting;
          if (foreground) {
            requests.push(JSON.stringify(providerContext.messages));
            requestTokens.push(tokens);
          }
          const text = foreground
            ? "done"
            : "Project archive summary. "
                .repeat(700)
                .slice(0, (options?.maxTokens ?? model.maxTokens) * 4);
          const response = assistantWithUsage(model, text, tokens);
          expect(response.usage.totalTokens).toBeLessThanOrEqual(model.contextWindow!);
          return createAssistantResultStream(response);
        },
      );

      await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

      expect(mocks.handlePromptError.mock.calls.map(([input]) => input.error)).toEqual([]);
      expect(fixture.readState().promptError).toBeNull();
      expect(requests).toHaveLength(1);
      if (queued) {
        const captured = budgets[0]!;
        const available = captured.contextWindow - captured.reserveTokens - captured.fixedTokens;
        expect(
          captured.pendingTokens + estimateCompactionHistoryTokens([queuedMessage]),
        ).toBeLessThan(available);
        expect(requests[0]).toContain(queuedContext);
        expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
        expect(requestTokens[0], JSON.stringify({ requestTokens, budgets })).toBeLessThanOrEqual(
          testModel.contextWindow! - settingsManager.getCompactionReserveTokens(),
        );
      }
      expect(requests[0]).toContain(
        appendOnlyRuntimeContext ? "Previously recorded context" : "New transient context.",
      );
      expect(requests[0]).not.toContain(
        appendOnlyRuntimeContext ? "New transient context." : "Previously recorded context",
      );
      if (appendOnlyRuntimeContext) {
        expect(budgets[0]?.pendingTokens).toBeLessThan(nextCarrier.content.length / 4);
      } else {
        expect(budgets[0]?.pendingTokens).toBeGreaterThan(nextCarrier.content.length / 4);
      }
      expect(budgets.at(-1)).toMatchObject({ pendingTokens: 0, pendingQueuedContextTokens: 0 });
    },
  );

  it("captures pending images and exact persisted ingress identity", async () => {
    const fixture = createFixture({ pendingPrompt: "", pendingImageCount: 1 });
    const { activeSession } = fixture.input.prepared.sessionRuntime.agentSession;
    const currentUser = {
      ...makeAgentUserMessage({ content: "", timestamp: 1 }),
      idempotencyKey: "current:user",
    };
    const recorder = createUserTurnTranscriptRecorder({
      message: { ...currentUser, idempotencyKey: "draft:user" },
      target: async () => undefined,
    });
    recorder.markRuntimePersisted(currentUser);
    fixture.input.attempt.userTurnTranscriptRecorder = recorder;
    fixture.input.attempt.skipPreparedUserTurnMessage = false;
    const budgets = collectBudgets(fixture);
    const tool = createStubTool("read");
    activeSession.agent.state.tools = [tool];
    let compacting = false;
    Object.defineProperty(activeSession, "isCompacting", { get: () => compacting });
    const foregroundBudget = { contextWindow: 32_000, reserveTokens: 77 };
    mocks.preparePromptPreflight.mockImplementation(async (input: PromptPreflightCall) => {
      expect(budgets).toHaveLength(1);
      expect(budgets[0]).toMatchObject({
        ...foregroundBudget,
        pendingUserIdempotencyKey: "current:user",
      });
      expect(budgets[0]?.pendingTokens).toBeGreaterThan(0);
      return input.state;
    });
    mocks.submitPrompt.mockImplementation(async (submission: PromptSubmissionCall) => {
      expect(submission.compactionRequestBudget).toBe(budgets[0]);
      const model = fixture.input.attempt.model;
      const context = {
        systemPrompt: "Current foreground context. ".repeat(200),
        messages: [],
        tools: [{ ...tool, description: "Complete schema guidance. ".repeat(100) }],
      };
      await activeSession.agent.streamFn(model, context);
      expect(budgets).toHaveLength(2);
      expect(budgets[1]).toMatchObject({ ...foregroundBudget, pendingTokens: 0 });
      expect(budgets[1]?.fixedTokens).toBeGreaterThan(budgets[0]?.fixedTokens ?? 0);
      expect(budgets[1]?.pendingUserIdempotencyKey).toBeUndefined();
      compacting = true;
      await activeSession.agent.streamFn(
        { ...model, contextWindow: 200_000 },
        { systemPrompt: "Separate summarizer", messages: [], tools: [] },
      );
      expect(budgets).toHaveLength(2);
      compacting = false;
    });

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBeNull();
  });

  it("withholds prompt hooks and submission after its owner retires during context lookup", async () => {
    const fixture = createFixture();
    const admission = prepareSystemAgentRunAdmission({}, "prompt-owner", "main", "prompt-session");
    onTestFinished(admission.close);
    const admitted = await admission.admit("embedded");
    const assemble = implementation(mocks.preparePromptAssembly);
    mocks.preparePromptAssembly.mockImplementationOnce(async (...args) => ({
      ...(await assemble(...args)),
      assertHostActive: resolveAdmittedRunActiveAssertion(admitted),
    }));
    const prepareContext = implementation(mocks.preparePromptContext);
    const context = prepareContext();
    const lookup = createDeferred<typeof context>();
    const entered = createDeferred();
    mocks.preparePromptContext.mockImplementationOnce(() => {
      entered.resolve();
      return lookup.promise;
    });
    const pending = runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);
    await entered.promise;
    admission.close();
    lookup.resolve(context);
    await pending;
    expect(mocks.beforeAgentRun).not.toHaveBeenCalled();
    expect(mocks.submitPrompt).not.toHaveBeenCalled();
    expect(mocks.handlePromptError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: "admitted run authority is no longer active" }),
      }),
    );
  });

  it("keeps ordinary prompt state and ambient hooks out of settled-turn finalization", async () => {
    const fixture = createFixture();
    fixture.input.attempt.operation = "settled-tool-finalization";
    const sessionManager = SessionManager.inMemory();
    using promptStateLease = retainEmbeddedSessionPromptState("phase-finalization");
    const state = promptStateLease.state;
    const project = (systemPrompt: string) =>
      prepareSessionSystemPrompt({
        state,
        routeKey: "anthropic/claude-opus-5/anthropic-messages",
        systemPrompt,
        entries: sessionManager.getBranch(),
      });
    project("## Tools\nread, write").commit();
    await persistSessionSystemPrompt(state, (customType, data) =>
      sessionManager.appendCustomEntryAsync(customType, data),
    );
    project("## Tools\nread").commit();
    const snapshot = () => ({ series: state.systemPrompt, pending: state.pendingSystemPrompt });
    const before = structuredClone(snapshot());
    const runtime = fixture.input.prepared.sessionRuntime;
    runtime.sessionManager = sessionManager;
    runtime.sessionPromptState = state;
    runtime.toolResultPromptProjectionState = state.toolResults;
    runtime.transcriptPolicy.inHistorySystemUpdates = true;
    const submit = implementation(mocks.submitPrompt);
    mocks.submitPrompt.mockImplementation(async (input: PromptSubmissionCall) => {
      await input.persistToolResultProjections();
      return submit(input);
    });

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBeNull();
    expect(mocks.beforeAgentRun).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(
      sessionManager
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
        ),
    ).toHaveLength(1);
    expect(fixture.order).toEqual(
      "assembly context google-cache images observe preflight submit stop-steering".split(" "),
    );
  });

  it("honors a tool-policy failure published during prompt assembly", async () => {
    const fixture = createFixture();
    const failure = new Error("explicit tool allowlist is empty");
    mocks.applyPromptToolsAllow.mockImplementationOnce(() => {
      fixture.input.prepared.toolCatalog.emptyExplicitToolAllowlistError = failure;
      return fixture.input.prepared.promptToolPolicy.current;
    });
    mocks.observePrompt.mockImplementationOnce((input: { skipPromptSubmission: boolean }) => ({
      skipPromptSubmission: input.skipPromptSubmission,
    }));

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBe(failure);
    expect(fixture.readState().promptErrorSource).toBe("precheck");
    expect(mocks.submitPrompt).not.toHaveBeenCalled();
    expect(mocks.releasePendingSteering).toHaveBeenCalledWith(
      expect.objectContaining({ error: failure.message, leaseId: "lease-1" }),
    );
  });

  it("reads yield state after submission fails and publishes abort state before recovery", async () => {
    const fixture = createFixture();
    const submissionError = new Error("submission failed");
    const yieldAbortSettled = Promise.resolve();
    mocks.submitPrompt.mockImplementation(async () => {
      fixture.order.push("submit");
      fixture.yieldState.yieldDetected = true;
      fixture.yieldState.yieldAbortSettled = yieldAbortSettled;
      fixture.yieldState.yieldMessage = "yield context";
      throw submissionError;
    });
    mocks.handlePromptError.mockImplementation(async (input: PromptErrorCall) => {
      fixture.order.push("prompt-error");
      expect(input).toMatchObject({ yieldDetected: true, yieldMessage: "yield context" });
      expect(input.yieldAbortSettled).toBe(yieldAbortSettled);
      input.releaseLeasedSteering(input.error);
      input.markYieldAborted();
      expect(fixture.readState()).toMatchObject({ aborted: false, cleanupYieldAborted: true });
      return {};
    });

    const result = await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);
    expect(result).toEqual({ promptStartedAt: expect.any(Number), transcriptLeafId: "leaf-1" });

    expect(fixture.order.slice(-3)).toEqual(["submit", "prompt-error", "stop-steering"]);
    expect(fixture.promptState.yieldAborted).toBe(true);
    expect(mocks.releasePendingSteering).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1", runIds: ["run-1"] }),
    );
  });

  it.each([
    { kind: "timeout", phase: "prompt", source: "external" },
    { kind: "aborted", source: "external" },
  ] satisfies AgentRunAttemptTerminal[])(
    "preserves an external $kind when yield cleanup observes the same unwind",
    async (terminal) => {
      const fixture = createFixture();
      fixture.input.state.terminal = terminal;
      mocks.submitPrompt.mockRejectedValueOnce(new Error("yield unwind"));
      mocks.handlePromptError.mockImplementationOnce(async (input: PromptErrorCall) => {
        input.markYieldAborted();
        expect(fixture.input.state.terminal).toEqual(terminal);
        return {};
      });

      await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

      expect(fixture.input.state.terminal).toEqual(terminal);
      expect(fixture.promptState.yieldAborted).toBe(true);
    },
  );

  it.each([false, true])(
    "salvages a run-budget timeout unless a provider fails (failure=%s)",
    async (providerFails) => {
      const fixture = createFixture();
      const providerError = new Error("provider failed");
      const timeOut = () => {
        fixture.input.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };
        fixture.input.runAbortController.abort(new Error("request timed out"));
      };
      if (providerFails) {
        mocks.submitPrompt.mockImplementationOnce(async () => {
          timeOut();
          throw providerError;
        });
      } else {
        timeOut();
      }
      mocks.handlePromptError.mockImplementationOnce(async (input: PromptErrorCall) => ({
        promptFailure: { error: providerFails ? providerError : input.error, source: "prompt" },
      }));
      await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);
      expect(fixture.readState().promptError).toBe(providerFails ? providerError : null);
      expect(fixture.readState().promptErrorSource).toBe(providerFails ? "prompt" : null);
      if (!providerFails) {
        expect(mocks.submitPrompt).not.toHaveBeenCalled();
      }
    },
  );

  it("releases transferred steering when prompt assembly rejects an invalidated result", async () => {
    const fixture = createFixture();
    const invalidationError = new Error("queued child result lost authority");
    const assemble = implementation(mocks.preparePromptAssembly);
    mocks.preparePromptAssembly.mockImplementationOnce(async (...args) => {
      await assemble(...args);
      throw invalidationError;
    });
    mocks.handlePromptError.mockImplementationOnce(async (input: PromptErrorCall) => {
      fixture.order.push("prompt-error");
      input.releaseLeasedSteering(input.error);
      return { promptFailure: { error: input.error, source: "prompt" } };
    });

    const result = await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);
    expect(result).toEqual({ promptStartedAt: expect.any(Number), transcriptLeafId: null });

    expect(mocks.releasePendingSteering).toHaveBeenCalledExactlyOnceWith({
      error: invalidationError.message,
      leaseId: "lease-1",
      runIds: ["run-1"],
    });
    expect(fixture.readState().promptError).toBe(invalidationError);
    expect(mocks.preparePromptContext).not.toHaveBeenCalled();
    expect(mocks.submitPrompt).not.toHaveBeenCalled();
    expect(fixture.order).toEqual(["assembly", "prompt-error", "stop-steering"]);
  });
});
