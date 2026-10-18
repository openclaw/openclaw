import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import type { Context, ImageContent, Model } from "../../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";
import { readBtwTranscriptMessages } from "../../btw-transcript.js";
import { RUNTIME_EVENT_USER_PROMPT } from "../../internal-runtime-context.js";
import { forgetPromptBuildDrainCacheForRun } from "../../plugin-turn-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  createOverflowAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  createCompactionHandlers,
  createResourceLoader,
} from "../../sessions/agent-session-loop-resource-loader.test-support.js";
import {
  createCompactionRequestBudget,
  estimateCompactedRequestTokens,
  withCompactionQueuedContext,
} from "../../sessions/compaction/request-budget.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  beginPromptCacheObservation,
  completePromptCacheObservation,
} from "../prompt-cache-observability.js";
import { getEmbeddedRunAttachment } from "../run-state.js";
import { getActiveEmbeddedRunSnapshot } from "../runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  createEmbeddedRunHandle,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../runs.test-support.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-build.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput, createSession, sessionId } from "./attempt-prompt-submit.test-support.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

registerAgentSessionLoopTestLifecycle();

type Submission = Parameters<typeof submitEmbeddedAttemptPrompt>[0];
type RealSession = Awaited<ReturnType<typeof createTestSession>>["session"];

function submitSession(session: RealSession, overrides: Partial<Submission> = {}) {
  return submitEmbeddedAttemptPrompt({
    ...createBaseInput(),
    activeSession: session,
    promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    ...overrides,
  });
}

function userMessage(content: string, timestamp = 1, idempotencyKey?: string) {
  return {
    role: "user" as const,
    content,
    timestamp,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function dispatchSession(session: Submission["activeSession"]) {
  return session.agent.streamFn({} as never, { messages: session.messages } as never, {} as never);
}

function collectRequests(requests: Context["messages"][], text: string, overflow = false) {
  streamMocks.streamSimple.mockImplementation((model, context) => {
    requests.push(structuredClone(context.messages));
    return createAssistantResultStream(
      overflow && requests.length === 1
        ? createOverflowAssistant(model)
        : createAssistant(model, text),
    );
  });
}

afterEach(() => {
  clearEmbeddedSessionPromptStates([sessionId]);
});

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  timestamp: number,
  details?: unknown,
): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
    ...(details ? { details } : {}),
  };
}

describe("submitEmbeddedAttemptPrompt", () => {
  it("refreshes review source authority before continuing a model request and refuses revocation", async () => {
    const { activeSession } = createSession();
    let revision = 0;
    let validatedRevision = 0;
    let active = true;
    const assertReceipt = (expected: number) => {
      if (!active) {
        throw new Error("review source revoked");
      }
      if (expected !== revision) {
        throw new Error("review source needs preparation");
      }
    };
    const source = composeSessionSourceAssertion([
      Object.assign(() => assertReceipt(validatedRevision), {
        prepareSessionSourceScope: async () => {
          validatedRevision = revision;
          const expected = revision;
          return { assertCurrent: () => assertReceipt(expected), checks: [] };
        },
      }),
    ]);
    const admission = prepareSystemAgentRunAdmission(
      {},
      "model-review-continuation",
      "main",
      "test",
      source,
    );
    const admitted = await admission.admit("embedded");
    const assertHostActive = resolveAdmittedRunActiveAssertion(admitted);
    const requests: Context["messages"][] = [];
    activeSession.agent.streamFn = (model, context) => {
      requests.push(context.messages);
      return createAssistantResultStream(createAssistant(model, "review continues"));
    };
    try {
      await submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        activeSession,
        assertHostActive,
        promptActiveSession: async (_prompt, options) => {
          options?.preflightResult?.(true);
          const request = async () => {
            const messages = await activeSession.agent.transformContext(activeSession.messages);
            return activeSession.agent.streamFn(testModel, {
              messages: messages as Context["messages"],
            });
          };
          await request();
          // A denied tool does not enter its source wrapper; foreground appends may still land.
          revision += 1;
          await request();
          active = false;
          await expect(request()).rejects.toThrow("admitted run authority is no longer active");
        },
      });
      expect(requests).toHaveLength(2);
    } finally {
      admission.close();
    }
  });

  it("replaces queued context without charging it twice or changing user overlap credit", () => {
    const user = userMessage("hello", 1, "current:user");
    const queued = userMessage("queued context");
    const inputs = {
      contextWindow: 32_768,
      reserveTokens: 8_192,
      pendingPrompt: user.content,
      pendingUserIdempotencyKey: user.idempotencyKey,
    };
    const prepared = createCompactionRequestBudget({
      ...inputs,
      pendingQueuedContextMessages: [queued],
    });
    const replacing = (messages: (typeof queued)[]) => {
      const result = withCompactionQueuedContext(prepared, messages);
      const rebuilt = createCompactionRequestBudget(
        messages.length ? { ...inputs, pendingQueuedContextMessages: messages } : inputs,
      );
      expect(estimateCompactedRequestTokens([user], result)).toBe(
        estimateCompactedRequestTokens([user], rebuilt),
      );
      return result;
    };
    const unchanged = withCompactionQueuedContext(prepared, [queued]);
    expect(estimateCompactedRequestTokens([user], unchanged)).toBe(
      estimateCompactedRequestTokens([user], prepared),
    );
    replacing([queued, { ...queued, content: "Additional queued facts." }]);
    const removed = replacing([]);
    expect(removed.pendingUserTokens).toBe(prepared.pendingUserTokens);
    const userOnly = createCompactionRequestBudget(inputs);
    const added = withCompactionQueuedContext(userOnly, [queued]);
    expect(added.pendingUserTokens).toBe(userOnly.pendingTokens);
    expect(added.pendingTokens).toBeGreaterThan(userOnly.pendingTokens);
  });

  it("fits pre-prompt compaction around prepared model context", async () => {
    const model = { ...testModel, contextWindow: 4_096, maxTokens: 1_024 };
    const settingsManager = createAutoCompactionSettings({
      reserveTokens: 1_024,
      keepRecentTokens: 20_000,
    });
    const systemPrompt = "Preserve the project requirements.";
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(
      userMessage("Earlier archive decision: blue buttons. ".repeat(270)),
    );
    sessionManager.appendMessage(createAssistant(model, "Archived the decision."));
    sessionManager.appendMessage(userMessage("Current project detail. ".repeat(140), 3));
    const priorInputTokens = Math.ceil(
      JSON.stringify({
        system: systemPrompt,
        messages: sessionManager.buildSessionContext().messages,
      }).length / 4,
    );
    expect(priorInputTokens).toBeGreaterThan(3_072);
    expect(priorInputTokens).toBeLessThan(model.contextWindow);
    sessionManager.appendMessage(
      createAssistant(model, "Details recorded.", "stop", priorInputTokens),
    );
    const { session } = await createTestSession({
      model,
      settingsManager,
      sessionManager,
      systemPrompt,
      resourceLoader: createResourceLoader(),
    });
    const convert = session.agent.convertToLlm;
    session.agent.convertToLlm = (messages) =>
      convert(normalizeMessagesForLlmBoundary(messages, { includeTimestamp: false }));
    const transcriptPrompt = "Answer the new request with ACK.";
    const prependContext = "Prepared hook context. ".repeat(210);
    const appendContext = "End of prepared hook context.";
    const runtimeContextMessage = buildRuntimeContextCustomMessage("Prepared runtime context.");
    const pendingPrompt = [prependContext, transcriptPrompt, appendContext].join("\n\n");
    const compactionRequestBudget = createCompactionRequestBudget({
      contextWindow: model.contextWindow,
      reserveTokens: settingsManager.getCompactionReserveTokens(),
      systemPrompt,
      tools: session.state.tools,
      pendingPrompt,
      pendingAdditivePrompt: [prependContext, appendContext].join("\n\n"),
      pendingQueuedContextMessages: runtimeContextMessage ? [runtimeContextMessage] : [],
    });
    const requests: Array<{ text: string; tokens: number; committedBefore: number }> = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      const text =
        context.messages
          .filter((message) => message.role === "user")
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
          )
          .find((content) => content.includes(transcriptPrompt)) ?? "";
      const tokens = Math.ceil(
        JSON.stringify({
          system: context.systemPrompt,
          tools: context.tools,
          messages: context.messages.map(({ role, content }) => ({ role, content })),
        }).length / 4,
      );
      const foreground = !session.isCompacting;
      if (foreground) {
        requests.push({
          text,
          tokens,
          committedBefore: sessionManager
            .getEntries()
            .filter((entry) => entry.type === "compaction").length,
        });
      }
      return createAssistantResultStream(
        createAssistant(
          activeModel,
          foreground ? "ACK" : "The project retains accessible blue buttons. ".repeat(220),
          "stop",
          tokens,
        ),
      );
    });
    await submitSession(session, {
      contextTokenBudget: model.contextWindow,
      compactionRequestBudget,
      appendOnlyRuntimeContext: true,
      runtimeOnly: false,
      runtimeContextMessage,
      systemPrompt,
      transcriptPrompt,
      modelPrompt: pendingPrompt,
      prependContext,
      appendContext,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toBe(pendingPrompt);
    expect(requests[0]?.committedBefore).toBeGreaterThan(0);
    expect(requests[0]?.tokens).toBeLessThanOrEqual(3_072);
    expect(session.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "ACK" }] });
  });

  it.each(["handled", "rejected"] as const)(
    "retires runtime-only context and preserves the next user when preflight is %s",
    async (outcome) => {
      let calls = 0;
      const handlers = new Map<string, Array<() => Promise<unknown>>>([
        [
          "input",
          [
            async () => ({
              action: calls++ === 0 && outcome === "handled" ? "handled" : "continue",
            }),
          ],
        ],
      ]);
      streamMocks.streamSimple.mockImplementation((model) =>
        createAssistantResultStream(createAssistant(model, "done")),
      );
      const sessionManager = guardSessionManager(SessionManager.inMemory());
      const { session, modelRegistry } = await createTestSession({
        sessionManager,
        resourceLoader: createResourceLoader(handlers),
      });
      const authCheck = vi.spyOn(modelRegistry, "hasConfiguredAuth");
      if (outcome === "rejected") {
        authCheck.mockReturnValueOnce(false);
      }
      const submit = (text: string, runtimeOnly = false) =>
        submitSession(session, {
          appendOnlyRuntimeContext: true,
          runtimeOnly,
          setNextUserMessagePersistence: sessionManager.setNextUserMessagePersistence,
          transcriptPrompt: text,
          modelPrompt: text,
          compactionRequestBudget: createCompactionRequestBudget({
            contextWindow: 32_768,
            reserveTokens: 8_192,
            systemPrompt: session.systemPrompt,
            pendingPrompt: text,
          }),
          runtimeContextMessage: buildRuntimeContextCustomMessage(`context for ${text}`),
        });
      if (outcome === "rejected") {
        await expect(submit(RUNTIME_EVENT_USER_PROMPT, true)).rejects.toThrow("No API key");
      } else {
        await submit(RUNTIME_EVENT_USER_PROMPT, true);
      }
      authCheck.mockRestore();
      await submit("accepted");
      const carriers = sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom_message");
      expect(carriers).toHaveLength(1);
      expect(carriers[0]).toMatchObject({
        content: expect.stringContaining("context for accepted"),
      });
      expect(JSON.stringify(session.messages)).not.toContain(RUNTIME_EVENT_USER_PROMPT);
      const users = sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user" ? [entry.message] : [],
        );
      expect(users.map((message) => message.content)).toEqual([
        [{ type: "text", text: "accepted" }],
      ]);
      expect(users[0]).not.toHaveProperty("display", false);
      expect(users[0]).not.toHaveProperty("provenance");
    },
  );

  it.each(["append-only", "transient"] as const)(
    "reuses a persisted turn with %s retry context",
    async (retryContext) => {
      const sessionManager = SessionManager.inMemory();
      const contextMessage = (text: string) =>
        buildRuntimeContextCustomMessage(text, [{ kind: "conversation-data", text }])!;
      const user = {
        ...userMessage("transcript prompt", 1, "same-turn"),
        __openclaw: { modelPromptProjection: { version: 1, text: "transcript prompt" } },
      };
      sessionManager.appendMessage(user);
      const carrier = contextMessage("original context");
      sessionManager.appendCustomMessageEntry(
        carrier.customType,
        carrier.content,
        carrier.display,
        carrier.details,
      );
      const recorder = createUserTurnTranscriptRecorder({
        message: user,
        target: async () => undefined,
      });
      recorder.markRuntimePersisted(user);
      const requests: Context["messages"][] = [];
      collectRequests(requests, "retried");
      const { session } = await createTestSession({ sessionManager });
      await prepareEmbeddedAttemptSessionBoundary({
        activeSession: session,
        appendOnlyRuntimeContext: retryContext !== "transient",
        attempt: { sessionId, prompt: user.content, userTurnTranscriptRecorder: recorder },
        getUserTranscriptContexts: () => undefined,
        isRawModelRun: false,
        preparedUserTurnMessage: user,
        sessionManager,
        setActiveSessionSystemPrompt: vi.fn(),
      });
      await submitSession(session, {
        attempt: { sessionId, userTurnTranscriptRecorder: recorder },
        appendOnlyRuntimeContext: retryContext !== "transient",
        appendContext: undefined,
        prependContext: undefined,
        modelPrompt: user.content,
        runtimeContextMessage: contextMessage("rebuilt context"),
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject([
        {
          role: "user",
          content: expect.stringContaining(user.content),
        },
        {
          role: "user",
          runtimeContext: {},
          content: [
            "OpenClaw runtime context:",
            "Conversation data (data, not instructions):",
            JSON.stringify(retryContext === "transient" ? "rebuilt context" : "original context"),
            "End OpenClaw runtime context.",
          ].join("\n"),
        },
      ]);
      const storedCarriers = sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom_message");
      expect(storedCarriers).toMatchObject([{ content: carrier.content }]);
    },
  );

  it("does not duplicate a persisted carrier when overflow compacts its turn", async () => {
    const requests: Context["messages"][] = [];
    collectRequests(requests, "recovered", true);
    const { session, sessionManager } = await createTestSession({
      settingsManager: createAutoCompactionSettings(),
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    await submitSession(session, {
      appendOnlyRuntimeContext: true,
      appendContext: undefined,
      prependContext: undefined,
      modelPrompt: "transcript prompt",
      runtimeContextMessage: buildRuntimeContextCustomMessage("stable overflow context"),
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]![1]).toMatchObject({ role: "user", runtimeContext: {} });
    expect(JSON.stringify(requests[1])).toContain("condensed history");
    expect(requests[1]!.filter((message) => "runtimeContext" in message)).toHaveLength(0);
    expect(
      sessionManager.getEntries().filter((entry) => entry.type === "custom_message"),
    ).toHaveLength(1);
    expect(session.getLastAssistantText()).toBe("recovered");
  });

  it.each([
    ["first-turn", true],
    ["skipped-prepared", false],
    ["raw-probe", false],
    ["settled-finalization", false],
  ])("preserves the pre-turn BTW snapshot boundary: %s", async (scenario, excludeCurrentUser) => {
    await withOpenClawTestState({ label: "btw-current-user" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId,
        sessionKey: `agent:main:btw-current-user-${scenario}`,
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
      const sessionManager = SessionManager.open(target, state.workspaceDir);
      if (scenario !== "first-turn") {
        sessionManager.appendMessage(userMessage("old conversation"));
        sessionManager.appendResetBoundary("reset");
      }
      const beforeCurrentUserLeaf = sessionManager.getLeafId();
      const currentUser = userMessage(
        "Current main task, not prior conversation",
        2,
        "btw-current-user:user",
      );
      const appended = sessionManager.appendMessageWithTranscriptAnchor(currentUser);
      if (!appended.anchor) {
        throw new Error("Expected a persisted current-user admission");
      }
      const recorder = createUserTurnTranscriptRecorder({
        message: currentUser,
        target: () => undefined,
      });
      recorder.markRuntimePersisted(currentUser, appended.anchor);
      const { activeSession } = createSession();
      activeSession.agent.state.messages = sessionManager.buildSessionContext().messages;
      const input = createBaseInput();
      const isRawModelRun = scenario === "raw-probe";
      const isFinalization = scenario === "settled-finalization";
      const runId = "btw-current-user";
      const handle = createEmbeddedRunHandle({ runId });
      const admission = prepareSystemAgentRunAdmission(
        {},
        runId,
        target.agentId,
        "btw-snapshot-test",
      );
      try {
        const attempt = {
          admittedRunContext: await admission.admit("embedded"),
          config: {},
          operation: isFinalization ? "settled-tool-finalization" : "attempt",
          skipPreparedUserTurnMessage: isFinalization || scenario === "skipped-prepared",
          model: testModel,
          provider: "test-provider",
          prompt: currentUser.content,
          runId,
          sessionId,
          sessionKey: target.sessionKey,
          sessionTarget: target,
          trigger: "user",
          userTurnTranscriptRecorder: recorder,
          workspaceDir: state.workspaceDir,
        } satisfies Parameters<typeof prepareEmbeddedAttemptPromptAssembly>[0]["attempt"];
        await prepareEmbeddedAttemptSessionBoundary({
          activeSession: activeSession as unknown as Parameters<
            typeof prepareEmbeddedAttemptSessionBoundary
          >[0]["activeSession"],
          attempt,
          getUserTranscriptContexts: () => undefined,
          isRawModelRun,
          preparedUserTurnMessage: attempt.skipPreparedUserTurnMessage ? undefined : currentUser,
          sessionManager,
          setActiveSessionSystemPrompt: vi.fn(),
        });
        const expectedSnapshotMessages = isFinalization ? [currentUser] : [];
        expect(activeSession.messages).toEqual(expectedSnapshotMessages);
        expect(sessionManager.getLeafId()).toBe(appended.entryId);
        const persistedBefore = loadTranscriptEventsSync(target);
        const sessionFile = path.join(path.dirname(target.storePath), `${sessionId}.jsonl`);
        setActiveEmbeddedRun(sessionId, handle, target.sessionKey, sessionFile);
        const assembly = await prepareEmbeddedAttemptPromptAssembly({
          attempt,
          activeSession,
          sessionManager,
          hookRunner: null,
          hookAgentId: "main",
          diagnosticTrace: { traceId: "11111111111111111111111111111111" },
          isRawModelRun,
          sessionAgentId: "main",
          runtimeModel: "test-model",
          systemPromptText: input.systemPrompt,
          hasBaselineTools: () => false,
          applyPromptBuildToolsAllow: () => [],
          setActiveSessionSystemPrompt: vi.fn(),
          setLeasedSteering: vi.fn(),
        });
        await submitEmbeddedAttemptPrompt({
          ...input,
          attempt,
          registration: getEmbeddedRunAttachment(handle),
          activeSession,
          transcriptLeafId: assembly.transcriptLeafId,
          transcriptPrompt: currentUser.content,
          modelPrompt: currentUser.content,
          promptActiveSession: async () => undefined,
        });
        const snapshot = getActiveEmbeddedRunSnapshot(sessionFile);
        if (!snapshot) {
          throw new Error("Expected the submitted main-run snapshot");
        }
        expect(snapshot.messages).toEqual(expectedSnapshotMessages);
        expect(snapshot.inFlightPrompt).toBe(currentUser.content);
        const messages = await readBtwTranscriptMessages({
          ...target,
          sessionFile: target.sessionKey,
          snapshotLeafId: snapshot.transcriptLeafId,
        });
        expect(messages).toEqual(excludeCurrentUser ? [] : [currentUser]);
        expect(snapshot.transcriptLeafId).toBe(
          excludeCurrentUser ? beforeCurrentUserLeaf : sessionManager.getLeafId(),
        );
        expect(loadTranscriptEventsSync(target)).toEqual(persistedBefore);
      } finally {
        admission.close();
        clearActiveEmbeddedRun(sessionId, handle, target.sessionKey);
        forgetPromptBuildDrainCacheForRun(runId);
      }
    });
  });

  it.each([true, false])(
    "restores context and transforms after submission (runtime-only: %s)",
    async (runtimeOnly) => {
      const { activeSession, baseStreamFn, originalTransformContext } = createSession();
      const input = createBaseInput();
      const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
      const runtimeContextMessage = {
        ...buildRuntimeContextCustomMessage("runtime context")!,
        timestamp: 2,
      };
      const steering = { leaseId: "lease-1", runIds: ["missing-run"], isCurrent: () => true };
      const submitting = submitEmbeddedAttemptPrompt({
        ...input,
        activeSession,
        images: [image],
        leasedSteering: runtimeOnly ? steering : undefined,
        runtimeContextMessage: runtimeOnly ? undefined : runtimeContextMessage,
        runtimeOnly,
        promptActiveSession: async (prompt, options) => {
          expect(prompt).toBe("transcript prompt");
          expect(input.onFinalPromptText).toHaveBeenCalledWith("transcript prompt");
          expect(activeSession.agent.streamFn).not.toBe(baseStreamFn);
          expect(activeSession.agent.transformContext).not.toBe(originalTransformContext);
          if (runtimeOnly) {
            expect(options).not.toHaveProperty("images");
          } else {
            expect(activeSession.messages).toContain(runtimeContextMessage);
            expect(options?.images).toEqual([image]);
          }
          options?.preflightResult?.(true);
          if (!runtimeOnly) {
            throw new Error("provider failed");
          }
        },
      });
      if (runtimeOnly) {
        await submitting;
        expect(input.onSteeringAcknowledged).toHaveBeenCalledOnce();
      } else {
        await expect(submitting).rejects.toThrow("provider failed");
        expect(input.onSteeringAcknowledged).not.toHaveBeenCalled();
        expect(activeSession.messages).not.toContain(runtimeContextMessage);
      }
      expect(activeSession.agent).toMatchObject({
        streamFn: baseStreamFn,
        transformContext: originalTransformContext,
      });
    },
  );

  it("caps MCP results, records aggregate pruning once, and preserves original history", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    const oversized = "x".repeat(5 * 1024 * 1024);
    const small = "small MCP result";
    const promptCacheKey = `${sessionId}:aggregate-truncation`;
    const observation = {
      sessionId,
      promptCacheKey,
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: input.systemPrompt,
      tools: [],
    } as const;
    activeSession.agent.state.messages = [
      userMessage("call tools"),
      toolResult("large", "huge__return_text", oversized, 2, {
        mcpServer: "huge",
        mcpTool: "return_text",
      }),
      toolResult("second", "huge__return_text", "b".repeat(6_000), 3, {
        mcpServer: "huge",
        mcpTool: "return_text",
      }),
      toolResult("small", "huge__small_text", small, 4),
      {
        ...createAssistant(testModel, "results processed"),
        timestamp: 5,
      },
      userMessage("continue", 6),
    ];
    beginPromptCacheObservation({
      ...observation,
      messages: activeSession.messages as Context["messages"],
    });
    completePromptCacheObservation({ sessionId, promptCacheKey, usage: { cacheRead: 8_000 } });
    const changes: ReturnType<typeof beginPromptCacheObservation>["changes"][] = [];
    let providerMessages: Context["messages"] = [];
    activeSession.agent.streamFn = (_model, context) => {
      providerMessages = context.messages;
      changes.push(
        beginPromptCacheObservation({ ...observation, messages: context.messages }).changes,
      );
      return undefined as never;
    };

    const submit = () =>
      submitEmbeddedAttemptPrompt({
        ...input,
        attempt: { sessionId, promptCacheKey },
        activeSession,
        toolResultAggregateMaxChars: 6_000,
        promptActiveSession: async () => {
          await dispatchSession(activeSession);
        },
      });
    await withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, submit);
    expect(activeSession.messages[1]).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: oversized }],
    });
    const [, second, smallResult] = providerMessages.filter(
      (message) => message.role === "toolResult",
    );
    expect(second?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/more characters truncated/),
    });
    expect(second?.content[0]?.type === "text" ? second.content[0].text.length : 0).toBe(
      input.toolResultMaxChars,
    );
    expect(smallResult?.content).toEqual([{ type: "text", text: small }]);
    expect(
      completePromptCacheObservation({
        sessionId,
        promptCacheKey,
        usage: { cacheRead: 2_000 },
      }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: [
        {
          code: "aggregateToolResultTruncation",
          detail: "aggregate tool-result truncation changed provider prompt",
        },
        { code: "pruning", detail: "pruning changed provider history" },
      ],
    });
    await withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, submit);
    expect(changes).toEqual([
      [
        expect.objectContaining({ code: "aggregateToolResultTruncation" }),
        expect.objectContaining({ code: "pruning" }),
      ],
      null,
    ]);
  });
});

describe("embedded provider dispatch admission", () => {
  it.each(["committed", "failed", "sync-failed"] as const)(
    "waits for fresh runtime admission before provider dispatch (%s)",
    async (outcome) => {
      await withOpenClawTestState({ label: "prompt-admission" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:prompt-admission",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
        const message = userMessage("transcript prompt", 1, "prompt-admission:user");
        const recorder = createUserTurnTranscriptRecorder({
          message,
          target: { ...target, sessionEntry: { sessionId, updatedAt: 1 } },
        });
        const admission = createDeferred();
        recorder.setAdmissionHandler?.(() => {
          if (outcome === "sync-failed") {
            throw new Error("durable admission failed");
          }
          return admission.promise;
        });
        const dispatchBoundary = createDeferred();
        const waitForPersistence = recorder.waitForRuntimePersistence;
        vi.spyOn(recorder, "waitForRuntimePersistence").mockImplementation(() => {
          dispatchBoundary.resolve();
          return waitForPersistence();
        });
        streamMocks.streamSimple.mockImplementation((model) => {
          // The unfixed path reaches the provider instead of the persistence wait.
          dispatchBoundary.resolve();
          return createAssistantResultStream(createAssistant(model, "done"));
        });
        const sessionManager = guardSessionManager(
          SessionManager.open(target, state.workspaceDir),
          { preparedUserTurnMessage: message, preparedUserTurnTranscriptRecorder: recorder },
        );
        const { session } = await createTestSession({ sessionManager });
        expect(recorder.getAdmissionReceipt()).toBeUndefined();
        const submitting = submitSession(session, {
          modelPrompt: message.content,
          prependContext: undefined,
          appendContext: undefined,
          attempt: { sessionId, userTurnTranscriptRecorder: recorder },
        });
        try {
          // The actual user append starts admission; the test never calls the waiter.
          await Promise.race([dispatchBoundary.promise, submitting]);
          expect(recorder.getAdmissionReceipt()).toMatchObject({ sessionId });
          expect(streamMocks.streamSimple).not.toHaveBeenCalled();
        } finally {
          if (outcome === "failed") {
            admission.reject(new Error("durable admission failed"));
          } else {
            admission.resolve();
          }
          await submitting;
        }
        if (outcome !== "committed") {
          expect(streamMocks.streamSimple).not.toHaveBeenCalled();
          expect(session.messages.at(-1)).toMatchObject({
            role: "assistant",
            stopReason: "error",
            errorMessage: expect.stringContaining("durable admission failed"),
          });
        } else {
          expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
          expect(session.getLastAssistantText()).toBe("done");
        }
      });
    },
  );
});
