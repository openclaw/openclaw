import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const { createFixture, mocks } = await vi.hoisted(
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
  mocks.applyPromptToolsAllow.mockReturnValue({
    activeToolNames: ["read"],
    callableToolNames: ["read"],
    effectiveTools: [{ name: "read" }],
    uncompactedEffectiveTools: [{ name: "read" }],
    tools: [{ name: "read" }],
  });
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
});

registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  clearEmbeddedSessionPromptStates([
    "phase-context-replay",
    "phase-system-update",
    "phase-finalization",
  ]);
});

describe("runEmbeddedAttemptPromptPhase", () => {
  it.each([false, true])(
    "wires final Decision withdrawal with in-history updates %s",
    async (inHistorySystemUpdates) => {
      const f = createFixture();
      const ownedSession = f.input.prepared.sessionRuntime.agentSession;
      const session = ownedSession.activeSession;
      session.agent.state.systemPrompt = "pruned prompt";
      session.agent.state.tools = [];
      using promptStateLease = retainEmbeddedSessionPromptState("phase-system-update");
      if (inHistorySystemUpdates) {
        const state = promptStateLease.state;
        const project = (systemPrompt: string) =>
          prepareSessionSystemPrompt({
            state,
            routeKey: "anthropic/claude-opus-5/anthropic-messages",
            systemPrompt,
            entries: [],
          });
        project("pruned prompt").commit();
        f.input.prepared.sessionRuntime.prepareSystemPromptUpdate = vi.fn(
          async (prompt: string, _freshlyRendered?: boolean) => project(prompt),
        );
      }
      let withdrawals = 0;
      f.input.prepared.promptToolPolicy.prepareForDispatch = (prepare) => {
        withdrawals++;
        return prepare();
      };
      const refresh = Object.assign(
        vi.fn((current: string) => current + " / permitted tools"),
        {
          freshlyRendered: true,
        },
      );
      const preparePrompt = vi.fn(async () => refresh);
      f.input.prepared.systemPrompt.prepareToolPrompt = preparePrompt;
      vi.mocked(ownedSession.setActiveSessionSystemPrompt).mockImplementation((prompt) => {
        session.agent.state.systemPrompt = prompt;
        return prompt;
      });
      const ordinaryAssembly = expectDefined(
        mocks.preparePromptAssembly.getMockImplementation(),
        "prompt assembly fixture implementation",
      );
      mocks.preparePromptAssembly.mockImplementation(async (input) => ({
        ...(await ordinaryAssembly(input)),
        decisionPrefilter: {
          shouldPruneTools: true,
          restrictionApplied: true,
          status: "proposed",
          reason: "conversational",
          isCurrent: () => false,
        },
      }));
      mocks.submitPrompt.mockImplementation(async (input: PromptSubmissionCall) => {
        const readContext = await expectDefined(
          input.preparePrimaryModelRequest?.(),
          "foreground restoration preparation",
        );
        const context = readContext();
        if (inHistorySystemUpdates) {
          expect(context).toMatchObject({
            tools: [],
            systemPrompt: "pruned prompt",
            promptUpdate: {
              update: {
                customType: "openclaw.system-update",
                content: expect.stringContaining("pruned prompt / permitted tools"),
              },
            },
          });
          context.promptUpdate?.commit();
          expect(session.agent.state.systemPrompt).toBe("pruned prompt");
        } else {
          expect(context).toEqual({ tools: [], systemPrompt: "pruned prompt / permitted tools" });
        }
      });
      await runEmbeddedAttemptPromptPhase(f.input, f.promptState);
      expect(f.readState().promptError).toBeNull();
      expect(withdrawals).toBe(1);
      expect(preparePrompt).toHaveBeenCalledWith(
        f.input.prepared.promptToolPolicy.current.effectiveTools,
      );
      expect(refresh).toHaveBeenCalledWith("pruned prompt");
      if (inHistorySystemUpdates) {
        expect(f.input.prepared.sessionRuntime.prepareSystemPromptUpdate).toHaveBeenCalledWith(
          "pruned prompt / permitted tools",
          true,
        );
      }
      const assembly = await mocks.preparePromptAssembly.mock.results[0]!.value;
      expect(assembly.decisionPrefilter).toMatchObject({
        restrictionApplied: false,
        status: "retained",
        reason: "selection-changed",
      });
    },
  );

  it.each([
    { appendOnlyRuntimeContext: true, queued: false, debugEnabled: true },
    { appendOnlyRuntimeContext: false, queued: false, debugEnabled: false },
    { appendOnlyRuntimeContext: true, queued: true, debugEnabled: false },
    { appendOnlyRuntimeContext: false, queued: true, debugEnabled: true },
  ])(
    "budgets submitted context with a recorded carrier (appendOnly=$appendOnlyRuntimeContext, queued=$queued)",
    async ({ appendOnlyRuntimeContext, queued, debugEnabled }) => {
      const fixture = createFixture({ pendingPrompt: "hello", pendingImageCount: 0 });
      // Cover both diagnostics modes without multiplying the four replay/compaction cases.
      mocks.isEnabled.mockReturnValue(debugEnabled);
      const currentUser = {
        role: "user" as const,
        content: "hello",
        timestamp: 1,
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
        manager.appendMessage({
          role: "user",
          content: "Earlier project archive. ".repeat(1_500),
          timestamp: 1,
        });
        manager.appendMessage(
          createAssistant(testModel, [
            { type: "text", text: "Recorded project facts. ".repeat(900) },
          ]),
        );
        manager.appendMessage({
          role: "user",
          content: "Current project archive. ".repeat(1_500),
          timestamp: 3,
        });
        const priorInput = Math.ceil(
          JSON.stringify(
            manager.buildSessionContext().messages.map((message) => {
              if (message.role !== "user" && message.role !== "assistant") {
                throw new Error("Expected seeded user/assistant history");
              }
              return { role: message.role, content: message.content };
            }),
          ).length / 4,
        );
        const priorText = "Recorded current facts. ".repeat(800);
        const prior = createAssistant(
          testModel,
          [{ type: "text", text: priorText }],
          "stop",
          priorInput,
        );
        prior.usage.output = Math.ceil(priorText.length / 4);
        prior.usage.totalTokens = priorInput + prior.usage.output;
        prior.usage.contextUsage = {
          state: "available",
          promptTokens: priorInput,
          totalTokens: prior.usage.totalTokens,
        };
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
        ...(queued
          ? {
              settingsManager: SettingsManager.inMemory({
                compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 20_000 },
                retry: { enabled: false },
              }),
            }
          : {}),
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
      const budgets: CompactionRequestBudget[] = [];
      fixture.input.attempt.onCompactionRequestBudget = (budget) => {
        if (budget) {
          budgets.push(budget);
        }
      };
      const { submitEmbeddedAttemptPrompt } = await vi.importActual<
        typeof import("./attempt-prompt-submit.js")
      >("./attempt-prompt-submit.js");
      mocks.submitPrompt.mockImplementation(submitEmbeddedAttemptPrompt);
      const requests: string[] = [];
      const requestToolCounts: number[] = [];
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
            requestToolCounts.push(providerContext.tools?.length ?? 0);
            requestTokens.push(tokens);
          }
          const text = foreground
            ? "done"
            : "Project archive summary. "
                .repeat(700)
                .slice(0, (options?.maxTokens ?? model.maxTokens) * 4);
          const response = createAssistant(model, [{ type: "text", text }], "stop", tokens);
          response.usage.output = Math.ceil(text.length / 4);
          response.usage.totalTokens = tokens + response.usage.output;
          response.usage.contextUsage = {
            state: "available",
            promptTokens: tokens,
            totalTokens: response.usage.totalTokens,
          };
          expect(response.usage.totalTokens).toBeLessThanOrEqual(model.contextWindow!);
          return createAssistantResultStream(response);
        },
      );

      await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

      expect(mocks.handlePromptError.mock.calls.map(([input]) => input.error)).toEqual([]);
      expect(fixture.readState().promptError).toBeNull();
      expect(requests).toHaveLength(1);
      const diagnostics = mocks.debug.mock.calls.filter(
        ([message]) => message === "Decision tool surface at primary dispatch",
      );
      expect(diagnostics).toHaveLength(debugEnabled ? 1 : 0);
      if (debugEnabled) {
        expect(diagnostics[0]?.[1]).toMatchObject({
          decisionStatus: "skipped",
          reason: "fixture-baseline",
          restrictionApplied: false,
          baselineVisibleTools: null,
          finalVisibleTools: requestToolCounts[0],
          definitionCharsSaved: null,
        });
      }
      if (queued) {
        const captured = budgets[0]!;
        const completePendingTokens =
          captured.pendingTokens + estimateCompactionHistoryTokens([queuedMessage]);
        expect(
          captured.contextWindow -
            captured.reserveTokens -
            captured.fixedTokens -
            completePendingTokens,
        ).toBeGreaterThan(0);
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

  it.each([
    {
      persisted: true,
      skip: false,
      pendingPrompt: "",
      pendingImageCount: 1,
      expectedKey: "current:user",
    },
  ])(
    "captures pending text/images and exact ingress identity (persisted=$persisted, skip=$skip, images=$pendingImageCount)",
    async ({ persisted, skip, pendingPrompt, pendingImageCount, expectedKey }) => {
      const fixture = createFixture({ pendingPrompt, pendingImageCount });
      const { activeSession } = fixture.input.prepared.sessionRuntime.agentSession;
      const currentUser = {
        role: "user" as const,
        content: pendingPrompt,
        timestamp: 1,
        idempotencyKey: "current:user",
      };
      const recorder = createUserTurnTranscriptRecorder({
        message: { ...currentUser, idempotencyKey: "draft:user" },
        target: async () => undefined,
      });
      if (persisted) {
        recorder.markRuntimePersisted(currentUser);
      }
      fixture.input.attempt.userTurnTranscriptRecorder = recorder;
      fixture.input.attempt.skipPreparedUserTurnMessage = skip;
      const budgets: CompactionRequestBudget[] = [];
      fixture.input.attempt.onCompactionRequestBudget = (budget) => {
        if (budget) {
          budgets.push(budget);
        }
      };
      const tool = {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: Type.Object({ path: Type.String() }),
        execute: async () => ({ content: [], details: {} }),
      };
      activeSession.agent.state.tools = [tool];
      let compacting = false;
      Object.defineProperty(activeSession, "isCompacting", { get: () => compacting });
      mocks.preparePromptPreflight.mockImplementation(async (input: PromptPreflightCall) => {
        expect(budgets).toHaveLength(1);
        expect(budgets[0]).toMatchObject({ contextWindow: 32_000, reserveTokens: 77 });
        expect(budgets[0]?.pendingTokens).toBeGreaterThan(0);
        expect(budgets[0]?.pendingUserIdempotencyKey).toBe(expectedKey);
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
        expect(budgets[1]).toMatchObject({
          contextWindow: 32_000,
          reserveTokens: 77,
          pendingTokens: 0,
        });
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
    },
  );

  it("withholds prompt hooks and submission after its owner retires during context lookup", async () => {
    const fixture = createFixture();
    const admission = prepareSystemAgentRunAdmission({}, "prompt-owner", "main", "prompt-session");
    try {
      const admitted = await admission.admit("embedded");
      const prepareAssembly = expectDefined(
        mocks.preparePromptAssembly.getMockImplementation(),
        "prompt assembly fixture",
      );
      mocks.preparePromptAssembly.mockImplementationOnce(async (...args) => ({
        ...(await prepareAssembly(...args)),
        assertHostActive: resolveAdmittedRunActiveAssertion(admitted),
      }));
      const prepareContext = expectDefined(
        mocks.preparePromptContext.getMockImplementation(),
        "prompt context fixture",
      );
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
    } finally {
      admission.close();
    }
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
    const before = structuredClone({
      series: state.systemPrompt,
      pending: state.pendingSystemPrompt,
    });
    const runtime = fixture.input.prepared.sessionRuntime;
    runtime.sessionManager = sessionManager;
    runtime.sessionPromptState = state;
    runtime.toolResultPromptProjectionState = state.toolResults;
    runtime.transcriptPolicy.inHistorySystemUpdates = true;
    const submit = expectDefined(
      mocks.submitPrompt.getMockImplementation(),
      "prompt submission fixture",
    );
    mocks.submitPrompt.mockImplementation(async (input: PromptSubmissionCall) => {
      await input.persistToolResultProjections();
      return submit(input);
    });

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBeNull();
    expect(mocks.beforeAgentRun).not.toHaveBeenCalled();
    expect({ series: state.systemPrompt, pending: state.pendingSystemPrompt }).toEqual(before);
    expect(
      sessionManager
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
        ),
    ).toHaveLength(1);
    expect(fixture.order).toEqual([
      "assembly",
      "context",
      "google-cache",
      "images",
      "observe",
      "preflight",
      "submit",
      "stop-steering",
    ]);
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
      expect(input.yieldDetected).toBe(true);
      expect(input.yieldAbortSettled).toBe(yieldAbortSettled);
      expect(input.yieldMessage).toBe("yield context");
      input.releaseLeasedSteering(input.error);
      input.markYieldAborted();
      expect(fixture.readState()).toMatchObject({ aborted: false, cleanupYieldAborted: true });
      return {};
    });

    await expect(
      runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState),
    ).resolves.toEqual({
      promptStartedAt: expect.any(Number),
      transcriptLeafId: "leaf-1",
    });

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

  it("keeps a run-budget timeout failure-free for partial-output salvage", async () => {
    const fixture = createFixture();
    fixture.input.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };
    fixture.input.runAbortController.abort(new Error("request timed out"));
    mocks.handlePromptError.mockImplementationOnce(async (input: PromptErrorCall) => ({
      promptFailure: { error: input.error, source: "prompt" },
    }));

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(mocks.submitPrompt).not.toHaveBeenCalled();
    expect(fixture.readState().promptError).toBeNull();
    expect(fixture.readState().promptErrorSource).toBeNull();
  });

  it("records a provider failure that races a run-budget timeout", async () => {
    const fixture = createFixture();
    const providerError = new Error("provider failed");
    mocks.submitPrompt.mockImplementationOnce(async () => {
      fixture.input.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };
      fixture.input.runAbortController.abort(new Error("request timed out"));
      throw providerError;
    });
    mocks.handlePromptError.mockResolvedValueOnce({
      promptFailure: { error: providerError, source: "prompt" },
    });

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBe(providerError);
    expect(fixture.readState().promptErrorSource).toBe("prompt");
  });

  it("releases transferred steering when prompt assembly rejects an invalidated result", async () => {
    const fixture = createFixture();
    const invalidationError = new Error("queued child result lost authority");
    const prepareAssembly = expectDefined(
      mocks.preparePromptAssembly.getMockImplementation(),
      "prompt assembly fixture",
    );
    mocks.preparePromptAssembly.mockImplementationOnce(async (...args) => {
      await prepareAssembly(...args);
      throw invalidationError;
    });
    mocks.handlePromptError.mockImplementationOnce(async (input: PromptErrorCall) => {
      fixture.order.push("prompt-error");
      input.releaseLeasedSteering(input.error);
      return { promptFailure: { error: input.error, source: "prompt" } };
    });

    await expect(
      runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState),
    ).resolves.toEqual({
      promptStartedAt: expect.any(Number),
      transcriptLeafId: null,
    });

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

  it("publishes preflight state before a submission failure", async () => {
    const fixture = createFixture();
    const promptError = new Error("admission warning");
    const submitError = new Error("provider failed");
    mocks.preparePromptPreflight.mockImplementationOnce(
      async (preflightInput: PromptPreflightCall) => {
        fixture.order.push("preflight");
        return {
          ...preflightInput.state,
          promptError,
          promptErrorSource: "precheck",
        };
      },
    );
    mocks.submitPrompt.mockImplementationOnce(async () => {
      fixture.order.push("submit");
      expect(fixture.readState().promptError).toBe(promptError);
      throw submitError;
    });
    mocks.handlePromptError.mockImplementationOnce(async (errorInput: PromptErrorCall) => {
      fixture.order.push("prompt-error");
      expect(errorInput.error).toBe(submitError);
      return {};
    });

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.order.slice(-4)).toEqual([
      "preflight",
      "submit",
      "prompt-error",
      "stop-steering",
    ]);
  });
});
