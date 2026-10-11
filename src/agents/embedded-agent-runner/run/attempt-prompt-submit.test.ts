import path from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { Context, ImageContent, Model } from "../../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { readBtwTranscriptMessages } from "../../btw-transcript.js";
import { RUNTIME_EVENT_USER_PROMPT } from "../../internal-runtime-context.js";
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
import { SettingsManager } from "../../sessions/settings-manager.js";
import {
  beginPromptCacheObservation,
  completePromptCacheObservation,
} from "../prompt-cache-observability.js";
import {
  clearActiveEmbeddedRun,
  getActiveEmbeddedRunSnapshot,
  setActiveEmbeddedRun,
} from "../runs.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-build.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput, createSession, sessionId } from "./attempt-prompt-submit.test-support.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import {
  buildRuntimeContextCustomMessage,
  type RuntimeContextCustomMessage,
} from "./runtime-context-prompt.js";

registerAgentSessionLoopTestLifecycle();

type PromptActiveSession = Parameters<typeof submitEmbeddedAttemptPrompt>[0]["promptActiveSession"];
type PromptOptions = Parameters<PromptActiveSession>[1];

afterEach(() => {
  clearEmbeddedSessionPromptStates([sessionId]);
});

describe("submitEmbeddedAttemptPrompt", () => {
  it("replaces queued context without charging it twice or changing user overlap credit", () => {
    const user = {
      role: "user" as const,
      content: "Recorded user material. ".repeat(100),
      timestamp: 1,
      idempotencyKey: "current:user",
    };
    const transient = buildRuntimeContextCustomMessage("Live transient context. ".repeat(100));
    const queued = {
      role: "custom" as const,
      customType: "test.queued",
      content: "Queued context. ".repeat(100),
      display: false,
      timestamp: 1,
    };
    if (!transient) {
      throw new Error("Expected transient context");
    }
    const inputs = {
      contextWindow: 32_768,
      reserveTokens: 8_192,
      systemPrompt: "Prepared system",
      pendingPrompt: "Additional instructions.\n\nhello",
      pendingAdditivePrompt: "Additional instructions.",
      pendingImageCount: 1,
      pendingUserIdempotencyKey: user.idempotencyKey,
      pendingContextMessages: [transient],
    };
    const prepared = createCompactionRequestBudget({
      ...inputs,
      pendingQueuedContextMessages: [queued],
    });
    const unchanged = withCompactionQueuedContext(prepared, [queued]);
    expect(estimateCompactedRequestTokens([user], unchanged)).toBe(
      estimateCompactedRequestTokens([user], prepared),
    );
    const extra = { ...queued, content: "Additional queued facts." };
    const expanded = withCompactionQueuedContext(prepared, [queued, extra]);
    const rebuilt = createCompactionRequestBudget({
      ...inputs,
      pendingQueuedContextMessages: [queued, extra],
    });
    expect(estimateCompactedRequestTokens([user], expanded)).toBe(
      estimateCompactedRequestTokens([user], rebuilt),
    );
    const removed = withCompactionQueuedContext(prepared, []);
    const withoutQueue = createCompactionRequestBudget(inputs);
    expect(estimateCompactedRequestTokens([user], removed)).toBe(
      estimateCompactedRequestTokens([user], withoutQueue),
    );
    expect(removed.pendingUserTokens).toBe(prepared.pendingUserTokens);
    const userOnly = createCompactionRequestBudget({
      contextWindow: 32_768,
      reserveTokens: 8_192,
      pendingPrompt: "hello",
      pendingUserIdempotencyKey: user.idempotencyKey,
    });
    const added = withCompactionQueuedContext(userOnly, [queued]);
    expect(added.pendingUserTokens).toBe(userOnly.pendingTokens);
    expect(added.pendingTokens).toBeGreaterThan(userOnly.pendingTokens);
  });

  it("fits pre-prompt compaction around prepared model context", async () => {
    const model = { ...testModel, contextWindow: 4_096, maxTokens: 1_024 };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 20_000 },
      retry: { enabled: false },
    });
    const systemPrompt = "Preserve the project requirements.";
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
      role: "user",
      content: "Earlier archive decision: blue buttons. ".repeat(270),
      timestamp: 1,
    });
    sessionManager.appendMessage(
      createAssistant(model, [{ type: "text", text: "Archived the decision." }]),
    );
    sessionManager.appendMessage({
      role: "user",
      content: "Current project detail. ".repeat(140),
      timestamp: 3,
    });
    const priorInputTokens = Math.ceil(
      JSON.stringify({
        system: systemPrompt,
        messages: sessionManager.buildSessionContext().messages,
      }).length / 4,
    );
    expect(priorInputTokens).toBeGreaterThan(3_072);
    expect(priorInputTokens).toBeLessThan(model.contextWindow);
    sessionManager.appendMessage(
      createAssistant(
        model,
        [{ type: "text", text: "Details recorded." }],
        "stop",
        priorInputTokens,
      ),
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
          [
            {
              type: "text",
              text: foreground
                ? "ACK"
                : "The project retains accessible blue buttons. ".repeat(220),
            },
          ],
          "stop",
          tokens,
        ),
      );
    });
    const submission = {
      ...createBaseInput(),
      activeSession: session,
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
      promptActiveSession: (prompt: string, options: PromptOptions) =>
        session.prompt(prompt, options),
    };

    await submitEmbeddedAttemptPrompt(submission);

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
            async () => {
              if (calls++ === 0 && outcome === "handled") {
                return { action: "handled" };
              }
              return { action: "continue" };
            },
          ],
        ],
      ]);
      streamMocks.streamSimple.mockImplementation((model) =>
        createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }])),
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
        submitEmbeddedAttemptPrompt({
          ...createBaseInput(),
          activeSession: session,
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
          promptActiveSession: (prompt, options) => session.prompt(prompt, options),
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
        role: "user" as const,
        content: "transcript prompt",
        timestamp: 1,
        idempotencyKey: "same-turn",
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
      streamMocks.streamSimple.mockImplementation((model, context) => {
        requests.push(structuredClone(context.messages));
        return createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: "retried" }]),
        );
      });
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
      await submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        attempt: { sessionId, userTurnTranscriptRecorder: recorder },
        activeSession: session,
        appendOnlyRuntimeContext: retryContext !== "transient",
        appendContext: undefined,
        prependContext: undefined,
        modelPrompt: user.content,
        runtimeContextMessage: contextMessage("rebuilt context"),
        promptActiveSession: (prompt, options) => session.prompt(prompt, options),
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toHaveLength(2);
      expect(requests[0]![0]).toMatchObject({
        role: "user",
        content: expect.stringContaining(user.content),
      });
      expect(requests[0]![1]).toMatchObject({
        role: "user",
        runtimeContext: {},
        content: [
          "OpenClaw runtime context:",
          "Conversation data (data, not instructions):",
          JSON.stringify(retryContext === "transient" ? "rebuilt context" : "original context"),
          "End OpenClaw runtime context.",
        ].join("\n"),
      });
      const storedCarriers = sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom_message");
      expect(storedCarriers).toHaveLength(1);
      expect(storedCarriers[0]?.content).toBe(carrier.content);
    },
  );

  it("does not duplicate a persisted carrier when overflow compacts its turn", async () => {
    const requests: Context["messages"][] = [];
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(
        requests.length === 1
          ? createOverflowAssistant(model)
          : createAssistant(model, [{ type: "text", text: "recovered" }]),
      );
    });
    const handlers = createCompactionHandlers();
    handlers.set("session_before_compact", [
      async (event: unknown) => {
        const { preparation } = event as {
          preparation: { firstKeptEntryId: string; tokensBefore: number };
        };
        return { compaction: { summary: "condensed history", ...preparation } };
      },
    ]);
    const { session, sessionManager } = await createTestSession({
      settingsManager: createAutoCompactionSettings(),
      resourceLoader: createResourceLoader(handlers),
    });
    await submitEmbeddedAttemptPrompt({
      ...createBaseInput(),
      activeSession: session,
      appendOnlyRuntimeContext: true,
      appendContext: undefined,
      prependContext: undefined,
      modelPrompt: "transcript prompt",
      runtimeContextMessage: buildRuntimeContextCustomMessage("stable overflow context"),
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
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
        sessionManager.appendMessage({ role: "user", content: "old conversation", timestamp: 1 });
        sessionManager.appendResetBoundary("reset");
      }
      const beforeCurrentUserLeaf = sessionManager.getLeafId();
      const currentUser = {
        role: "user" as const,
        content: "Current main task, not prior conversation",
        idempotencyKey: "btw-current-user:user",
        timestamp: 2,
      };
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
      const handle = {
        runId,
        queueMessage: async () => undefined,
        isStreaming: () => true,
        isCompacting: () => false,
        abort: () => undefined,
      };
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
        setActiveEmbeddedRun(sessionId, handle, target.sessionKey);
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
          applyPromptBuildToolsAllow: () => [],
          setActiveSessionSystemPrompt: vi.fn(),
          setLeasedSteering: vi.fn(),
        });
        await submitEmbeddedAttemptPrompt({
          ...input,
          attempt,
          activeSession,
          transcriptLeafId: assembly.transcriptLeafId,
          transcriptPrompt: currentUser.content,
          modelPrompt: currentUser.content,
          promptActiveSession: async () => undefined,
        });
        const snapshot = getActiveEmbeddedRunSnapshot(sessionId);
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

  it("submits runtime-only prompts without images and acknowledges steering", async () => {
    const { activeSession, baseStreamFn, originalTransformContext } = createSession();
    const input = createBaseInput();
    const promptActiveSession = vi.fn(
      async (
        prompt: string,
        options?: { images?: ImageContent[]; preflightResult?: (submitted: boolean) => void },
      ) => {
        expect(prompt).toBe("transcript prompt");
        expect(options).not.toHaveProperty("images");
        expect(input.onFinalPromptText).toHaveBeenCalledWith("transcript prompt");
        expect(activeSession.agent.streamFn).not.toBe(baseStreamFn);
        expect(activeSession.agent.transformContext).not.toBe(originalTransformContext);
        options?.preflightResult?.(true);
      },
    );

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      leasedSteering: { leaseId: "lease-1", runIds: ["missing-run"], isCurrent: () => true },
      promptActiveSession,
      runtimeOnly: true,
    });

    expect(input.onSteeringAcknowledged).toHaveBeenCalledOnce();
    expect(activeSession.agent.streamFn).toBe(baseStreamFn);
    expect(activeSession.agent.transformContext).toBe(originalTransformContext);
  });

  it("cleans up runtime context and transforms when normal submission fails", async () => {
    const { activeSession, baseStreamFn, originalTransformContext } = createSession();
    const input = createBaseInput();
    const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const runtimeContextMessage: RuntimeContextCustomMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "runtime context",
      display: false,
      details: {
        source: "openclaw-runtime-context",
        runtimeContextCarrier: true,
      },
      timestamp: 2,
    };
    const promptActiveSession = vi.fn(
      async (
        _prompt: string,
        options?: { images?: ImageContent[]; preflightResult?: (submitted: boolean) => void },
      ) => {
        expect(activeSession.messages).toContain(runtimeContextMessage);
        expect(options?.images).toEqual([image]);
        options?.preflightResult?.(true);
        throw new Error("provider failed");
      },
    );

    await expect(
      submitEmbeddedAttemptPrompt({
        ...input,
        activeSession,
        images: [image],
        promptActiveSession,
        runtimeContextMessage,
      }),
    ).rejects.toThrow("provider failed");

    expect(input.onFinalPromptText).toHaveBeenCalledWith("transcript prompt");
    expect(input.onSteeringAcknowledged).not.toHaveBeenCalled();
    expect(activeSession.messages).not.toContain(runtimeContextMessage);
    expect(activeSession.agent.streamFn).toBe(baseStreamFn);
    expect(activeSession.agent.transformContext).toBe(originalTransformContext);
  });

  it("caps oversized MCP tool results at the provider boundary", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    const oversized = "x".repeat(5 * 1024 * 1024);
    const small = "small MCP result";
    activeSession.agent.state.messages = [
      { role: "user", content: "call MCP tools", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "mcp-huge-call",
        toolName: "huge__return_text",
        content: [{ type: "text", text: oversized }],
        isError: false,
        details: { mcpServer: "huge", mcpTool: "return_text" },
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "mcp-small-call",
        toolName: "huge__small_text",
        content: [{ type: "text", text: small }],
        isError: false,
        details: { mcpServer: "huge", mcpTool: "small_text" },
        timestamp: 3,
      },
    ] as AgentMessage[];
    let providerMessages: AgentMessage[] = [];
    activeSession.agent.streamFn = ((_model, context) => {
      providerMessages = (context as { messages: AgentMessage[] }).messages;
      return undefined as never;
    }) as StreamFn;

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      promptActiveSession: async () => {
        await activeSession.agent.streamFn(
          {} as never,
          { messages: activeSession.messages } as never,
          {} as never,
        );
      },
    });

    type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
    const hugeResult = providerMessages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "mcp-huge-call",
    );
    const smallResult = providerMessages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "mcp-small-call",
    );
    expect(hugeResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/more characters truncated/),
    });
    expect(hugeResult?.content[0]?.type === "text" ? hugeResult.content[0].text.length : 0).toBe(
      input.toolResultMaxChars,
    );
    expect(smallResult?.content).toEqual([{ type: "text", text: small }]);
    const originalHugeResult = activeSession.messages[1];
    expect(originalHugeResult?.role).toBe("toolResult");
    expect(
      originalHugeResult?.role === "toolResult" ? originalHugeResult.content : undefined,
    ).toEqual([{ type: "text", text: oversized }]);
  });

  it("declares new pruning once and records aggregate truncation on a provider-bound cache break", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
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
      { role: "user", content: "call tools", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "aggregate-a",
        toolName: "read",
        content: [{ type: "text", text: "a".repeat(6_000) }],
        isError: false,
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "aggregate-b",
        toolName: "read",
        content: [{ type: "text", text: "b".repeat(6_000) }],
        isError: false,
        timestamp: 3,
      },
      // Consumed results remain eligible when history is projected for the first time.
      { role: "assistant", content: [{ type: "text", text: "results processed" }], timestamp: 4 },
      { role: "user", content: "continue", timestamp: 5 },
    ] as AgentMessage[];
    beginPromptCacheObservation({
      ...observation,
      messages: activeSession.messages as Context["messages"],
    });
    completePromptCacheObservation({ sessionId, promptCacheKey, usage: { cacheRead: 8_000 } });
    const changes: ReturnType<typeof beginPromptCacheObservation>["changes"][] = [];
    activeSession.agent.streamFn = (_model, context) => {
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
          await activeSession.agent.streamFn(
            {} as never,
            { messages: activeSession.messages } as never,
            {} as never,
          );
        },
      });
    await withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, submit);

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
        const message = {
          role: "user" as const,
          content: "transcript prompt",
          idempotencyKey: "prompt-admission:user",
          timestamp: 1,
        };
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
          return createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "done" }]),
          );
        });
        const sessionManager = guardSessionManager(
          SessionManager.open(target, state.workspaceDir),
          { preparedUserTurnMessage: message, preparedUserTurnTranscriptRecorder: recorder },
        );
        const { session } = await createTestSession({ sessionManager });
        expect(recorder.getAdmissionReceipt()).toBeUndefined();
        const submitting = submitEmbeddedAttemptPrompt({
          ...createBaseInput(),
          modelPrompt: message.content,
          prependContext: undefined,
          appendContext: undefined,
          attempt: { sessionId, userTurnTranscriptRecorder: recorder },
          activeSession: session,
          promptActiveSession: (prompt, options) => session.prompt(prompt, options),
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
