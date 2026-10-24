import { realpathSync } from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { MAX_OVERFLOW_COMPACTION_ATTEMPTS } from "../agent-compaction-constants.js";
import { compactWithSafetyTimeout } from "../embedded-agent-runner/compaction-safety-timeout.js";
import { subscribeEmbeddedAgentSession } from "../embedded-agent-subscribe.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import { estimateContextTokens } from "../runtime/index.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import {
  compactionSettings,
  safeguardFixture,
  sessionTarget,
  textStream,
} from "./agent-session-boundary.test-support.js";
import {
  agentSessionAutomaticCompaction,
  agentSessionSetContextReplacementHook,
} from "./agent-session-compaction.js";
import {
  collectCompactionEnds,
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  createOverflowAssistant,
  createTestSession,
  mockInvalidThenTextSummary,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createCompactionExtension } from "./agent-session-loop-resource-loader.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import type { ExtensionFactory, ExtensionEvent } from "./extensions/types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  }),
);
registerAgentSessionLoopTestLifecycle();

function createStaleThinkingContent(): AssistantMessage["content"] {
  return [
    { type: "thinking", thinking: "old think", thinkingSignature: "stale-thinking" },
    { type: "thinking", thinking: "old think", signature: "stale-signature" },
    { type: "thinking", thinking: "old think", thought_signature: "stale-thought" },
    { type: "redacted_thinking", data: "stale-redacted" },
    { type: "text", text: "retained answer" },
  ] as unknown as AssistantMessage["content"];
}

function expectRetainedThinking(
  session: Awaited<ReturnType<typeof createTestSession>>["session"],
  resetUsage = false,
) {
  const retained = session.messages.find(
    (message) =>
      message.role === "assistant" &&
      message.content.some((block) => block.type === "text" && block.text === "retained answer"),
  );
  expect(retained).toMatchObject({
    role: "assistant",
    ...(resetUsage ? { usage: { input: 0, output: 0, totalTokens: 0 } } : {}),
    content: [
      { type: "thinking", thinking: "old think" },
      { type: "thinking", thinking: "old think" },
      { type: "thinking", thinking: "old think" },
      { type: "redacted_thinking" },
      { type: "text", text: "retained answer" },
    ],
  });
}

function createResultHandlers(
  summary: string,
  firstKeptEntryId?: string,
  onPreparation?: (preparation: { latestUnresolvedUserRequest?: string }) => void,
) {
  const handlers: ExtensionFactory = (api) => {
    api.on("session_before_compact", async ({ preparation }) => {
      onPreparation?.(preparation);
      return {
        compaction: {
          summary,
          firstKeptEntryId: firstKeptEntryId ?? preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    });
  };
  return handlers;
}

function appendAnswer(manager: SessionManager, text = "old answer", at = 2) {
  return manager.appendMessage({ ...createAssistant(testModel, text), timestamp: at });
}

function oldHistory() {
  const manager = SessionManager.inMemory();
  manager.appendMessage(makeUserMessage("old prompt", 1));
  appendAnswer(manager);
  return manager;
}

function compactions(manager: SessionManager) {
  return manager.getBranch().filter((entry) => entry.type === "compaction");
}

type AgentEventHandler = NonNullable<
  Parameters<typeof subscribeEmbeddedAgentSession>[0]["onAgentEvent"]
>;

describe("AgentSession compaction", () => {
  it.each([
    {
      name: "long untrusted focus",
      instructions: `\nKeep <API>\r\n\u0000\u202E${"😀".repeat(900)}  `,
      expectedFocus: `Keep &lt;API&gt;\n${"😀".repeat(786)}`,
    },
    { name: "blank focus", instructions: " \n\t ", expectedFocus: undefined },
    { name: "absent focus", instructions: undefined, expectedFocus: undefined },
  ])(
    "prepares $name for core without changing the extension input",
    async ({ instructions, expectedFocus }) => {
      const sessionManager = oldHistory();
      sessionManager.appendMessage(makeUserMessage("split prompt", 3));
      appendAnswer(sessionManager, "retained answer", 4);
      const observedInstructions: Array<string | undefined> = [];
      const prompts: string[] = [];
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected network request in compaction test"));
      try {
        streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
          const message = context.messages[0];
          if (message?.role !== "user") {
            throw new Error("expected a user summary prompt");
          }
          prompts.push(
            typeof message.content === "string"
              ? message.content
              : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
          );
          return textStream(model, "compacted summary");
        });
        const { session } = await createTestSession({
          sessionManager,
          extension: (api) =>
            api.on("session_before_compact", (event) => {
              observedInstructions.push(event.customInstructions);
            }),
          settingsManager: compactionSettings({ reserveTokens: 1_000 }),
        });

        await session.compact(instructions);

        expect(observedInstructions).toEqual([instructions]);
        expect(prompts).toHaveLength(2);
        for (const prompt of prompts) {
          if (expectedFocus) {
            expect.soft(prompt).toContain(`<untrusted-text>\n${expectedFocus}\n</untrusted-text>`);
            expect.soft(prompt).not.toContain("\u0000");
            expect.soft(prompt).not.toContain("\u202E");
          } else {
            expect.soft(prompt).not.toContain("Additional focus:");
          }
        }
        expect(
          sessionManager
            .getEntries()
            .filter((entry) => entry.type === "compaction")
            .map((entry) => entry.fromHook),
        ).toEqual([false]);
        expect(network).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
      }
    },
  );

  it("preserves the automatic authentication failure as a reasoned skip", async () => {
    const { session, modelRegistry } = await createTestSession({
      settingsManager: createAutoCompactionSettings(),
    });
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockResolvedValue({
        ok: false,
        error: `No API key found for ${activeModel.provider}`,
      });
      return createAssistantResultStream(
        createAssistant(activeModel, "complete answer", "stop", activeModel.contextWindow),
      );
    });
    const compactionEvents = collectCompactionEnds(session);

    await session.prompt("continue");

    expect(compactionEvents.at(0)).toMatchObject({
      type: "compaction_end",
      reason: "threshold",
      outcome: { status: "skipped", reason: expect.stringContaining("No API key found") },
    });
  });

  it("sends a pre-persisted keyed user once after pre-prompt compaction", async () => {
    const dir = tempDirs.make("openclaw-agent-session-compaction-keyed-user-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-agent-session-compaction-keyed-user",
      sessionKey: "agent:main:dashboard:sqlite-agent-session-compaction-keyed-user",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, {
      sessionFile: formatSqliteSessionFileMarker(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    const sessionManager = SessionManager.open(scope, dir);
    sessionManager.appendMessage(makeUserMessage("old prompt", 1));
    sessionManager.appendMessage({
      ...createAssistant(testModel, "old answer", "stop", testModel.contextWindow),
      timestamp: 2,
    });
    const currentUser = {
      role: "user" as const,
      content: "current question",
      idempotencyKey: "agent-session-compaction-keyed-user:user",
      timestamp: 3,
    };
    const currentUserId = sessionManager.appendMessage(currentUser);
    guardSessionManager(sessionManager, { preparedUserTurnMessage: currentUser });
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return textStream(activeModel, "complete answer");
    });
    const { session } = await createTestSession({
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
      extension: createResultHandlers("condensed history"),
    });
    const compactionEvents = collectCompactionEnds(session);
    // Embedded attempt preparation removes the ingress-persisted user from model state.
    // Pre-prompt compaction rebuilds it from the durable branch before prompt submission.
    session.agent.state.messages = session.agent.state.messages.slice(0, -1);

    await session.prompt(currentUser.content, {
      persistedUserIdempotencyKey: currentUser.idempotencyKey,
    });

    expect(compactionEvents).toEqual([
      expect.objectContaining({
        reason: "threshold",
        outcome: expect.objectContaining({ status: "completed", willRetry: false }),
      }),
    ]);
    expect(requests).toHaveLength(1);
    expect(
      requests[0]?.messages.filter(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes(currentUser.content),
      ),
    ).toHaveLength(1);
    expect(
      sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            "idempotencyKey" in entry.message &&
            entry.message.idempotencyKey === currentUser.idempotencyKey,
        ),
    ).toHaveLength(1);
    expect(sessionManager.getEntry(currentUserId)).toBeDefined();
    expect(session.getLastAssistantText()).toBe("complete answer");
  });

  it("accounts every automatic compaction response before summary validation", async () => {
    const sessionManager = oldHistory();
    sessionManager.appendMessage(makeUserMessage("latest prompt", 3));
    const requestCount = mockInvalidThenTextSummary("condensed history");
    const { session } = await createTestSession({
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
    });
    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run-automatic-summary-usage",
    });

    const result = await session[agentSessionAutomaticCompaction]();

    expect(requestCount()).toBe(2);
    expect(result.status === "completed" && result.result.summary).toContain("condensed history");
    expect(compactions(sessionManager)).toHaveLength(1);
    expect(subscription.getUsageTotals()).toMatchObject({ input: 2, output: 2, total: 4 });
    subscription.unsubscribe();
  });

  it.each(["automatic", "manual"] as const)(
    "projects a rejected %s cancellation as aborted without recording compaction",
    async (mode) => {
      const manual = mode === "manual";
      const sessionManager = manual ? oldHistory() : SessionManager.inMemory();
      const syntheticError = new Error(
        manual ? "synthetic manual cancellation rejection" : "synthetic cancellation rejection",
      );
      let thresholdRequestState: string | undefined;
      const { session } = await createTestSession({
        sessionManager,
        settingsManager: manual ? undefined : createAutoCompactionSettings(),
        extension: manual
          ? undefined
          : (api) => {
              api.on("session_before_compact", async ({ preparation }) => {
                thresholdRequestState = preparation.latestUnresolvedUserRequest;
                session.abortCompaction();
                throw syntheticError;
              });
            },
      });
      streamMocks.streamSimple.mockImplementation(
        (activeModel: Model, _context: Context, options?: SimpleStreamOptions) => {
          if (manual) {
            expect(options?.signal?.aborted).toBe(false);
            session.abortCompaction();
            throw syntheticError;
          }
          if (options?.signal?.aborted) {
            throw syntheticError;
          }
          return textStream(activeModel, "complete answer", "stop", activeModel.contextWindow);
        },
      );
      const onAgentEvent = vi.fn<AgentEventHandler>();
      const subscription = subscribeEmbeddedAgentSession({
        session,
        runId: manual ? "run-rejected-manual-cancellation" : "run-rejected-cancellation",
        onAgentEvent,
      });
      if (manual) {
        await expect(session.compact()).rejects.toBe(syntheticError);
      } else {
        await session.prompt("continue");
        expect(thresholdRequestState).toBeUndefined();
      }
      const projected = onAgentEvent.mock.calls.filter(([event]) => event.stream === "compaction");
      expect(projected.map(([event]) => event.data)).toMatchObject([
        { phase: "start", itemId: expect.any(String) },
        {
          phase: "end",
          itemId: projected[0]?.[0].data.itemId,
          outcome: "aborted",
          completed: false,
          willRetry: false,
        },
      ]);
      if (manual) {
        expect(projected[0]?.[0]).toMatchObject({ transcriptStart: null });
      }
      expect(subscription.getCompactionCount()).toBe(0);
      expect(subscription.getLastCompactionTokensAfter()).toBeUndefined();
      expect(compactions(sessionManager)).toEqual([]);
      subscription.unsubscribe();
    },
  );

  it("caps extension summaries before persistence and manual return", async () => {
    const sessionManager = oldHistory();
    const oversizedSummary = "summary detail ".repeat(2_000);
    let manualRequestState: string | undefined;
    const { session } = await createTestSession({
      sessionManager,
      extension: createResultHandlers(oversizedSummary, undefined, (preparation) => {
        manualRequestState = preparation.latestUnresolvedUserRequest;
      }),
    });

    const result = await session.compact();
    const persisted = compactions(sessionManager).at(-1);

    expect(result.summary.length).toBeLessThanOrEqual(16_000);
    expect(result.summary).toContain("[Compaction summary truncated to fit budget]");
    expect(persisted).toMatchObject({ type: "compaction", summary: result.summary });
    expect(manualRequestState).toBeUndefined();
  });

  it("recovers through the overflow limit with context invalidated before every retry", async () => {
    const overflowCount = MAX_OVERFLOW_COMPACTION_ATTEMPTS;
    let agentRequests = 0;
    const contextState = new Map([["skill", true]]);
    const contextSizesAtCompactionEnd: number[] = [];
    const preparedRequests: Array<string | undefined> = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      agentRequests += 1;
      if (agentRequests > 1) {
        expect(contextState.size).toBe(0);
      }
      const response =
        agentRequests <= overflowCount
          ? createOverflowAssistant(activeModel)
          : createAssistant(activeModel, "complete retry");
      return createAssistantResultStream({ ...response, timestamp: Date.now() + agentRequests });
    });
    const handlers: ExtensionFactory = (api) => {
      api.on("session_before_compact", async ({ preparation }) => {
        preparedRequests.push(preparation.latestUnresolvedUserRequest);
        return {
          compaction: {
            summary: "condensed history",
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details: {
              readFiles: [],
              modifiedFiles: [],
              ...(preparation.latestUnresolvedUserRequest
                ? { latestUnresolvedUserRequest: preparation.latestUnresolvedUserRequest }
                : {}),
            },
          },
        };
      });
    };
    const { session } = await createTestSession({
      settingsManager: createAutoCompactionSettings(),
      extension: handlers,
    });
    const compactionEvents = collectCompactionEnds(session);
    session[agentSessionSetContextReplacementHook](() => contextState.clear());
    session.subscribe((event) => {
      if (event.type === "compaction_end" && event.outcome.status === "completed") {
        contextSizesAtCompactionEnd.push(contextState.size);
      }
    });

    await session.prompt("long request");

    expect(agentRequests).toBe(overflowCount + 1);
    expect(
      compactionEvents.filter(
        (event) =>
          event.type === "compaction_end" &&
          event.reason === "overflow" &&
          event.outcome.status === "completed" &&
          event.outcome.willRetry,
      ),
    ).toHaveLength(overflowCount);
    expect(session.getLastAssistantText()).toBe("complete retry");
    expect(preparedRequests).toEqual(Array.from({ length: overflowCount }, () => "long request"));
    expect(contextState.size).toBe(0);
    expect(contextSizesAtCompactionEnd).toEqual(Array(overflowCount).fill(0));
  });

  it("reports replacement tokens and the exact equal-summary entry before a post-commit hook finishes", async () => {
    const sessionManager = SessionManager.inMemory();
    const summary = "The same bounded summary";
    const oldUserId = sessionManager.appendMessage(makeUserMessage("old prompt", 1));
    appendAnswer(sessionManager);
    const oldCompactionId = sessionManager.appendCompaction(summary, oldUserId, 100);
    const recentUserId = sessionManager.appendMessage(makeUserMessage("recent prompt", 3));
    appendAnswer(sessionManager, "recent answer", 4);
    const hookEntered = createDeferred();
    const releaseHook = createDeferred();
    let reportedCompactionId: string | undefined;
    const replacementTokens: Array<number | undefined> = [];
    const { session } = await createTestSession({
      sessionManager,
      settingsManager: compactionSettings({ reserveTokens: 0 }),
      extension: (api) => {
        api.on("session_before_compact", ({ preparation }) => ({
          compaction: {
            summary,
            firstKeptEntryId: recentUserId,
            tokensBefore: preparation.tokensBefore,
          },
        }));
        api.on("session_compact", async (event) => {
          reportedCompactionId = event.compactionEntry.id;
          hookEntered.resolve();
          await releaseHook.promise;
        });
      },
    });
    session[agentSessionSetContextReplacementHook]((tokensAfter?: number) => {
      replacementTokens.push(tokensAfter);
    });
    const compactionEnds = collectCompactionEnds(session);
    const controller = new AbortController();
    const cancelled = new Error("caller stopped after the transcript replacement");
    const work = session.compact();
    const bounded = compactWithSafetyTimeout(() => work, 30_000, {
      abortSignal: controller.signal,
      onCancel: () => session.abortCompaction(),
    });
    try {
      await Promise.race([hookEntered.promise, bounded]);
      const committed = compactions(sessionManager).at(-1);
      if (!committed) {
        throw new Error("expected the replacement compaction entry");
      }
      const contextTokens = estimateContextTokens(session.messages).tokens;
      expect(contextTokens).toBeGreaterThan(0);
      expect(committed).toMatchObject({ summary, tokensAfter: contextTokens });
      expect(committed.id).not.toBe(oldCompactionId);
      expect.soft(reportedCompactionId).toBe(committed.id);
      expect.soft(replacementTokens).toEqual([contextTokens]);
      expect(compactionEnds).toEqual([]);

      controller.abort(cancelled);
      await expect(bounded).rejects.toBe(cancelled);

      expect(sessionManager.getEntry(committed.id)).toMatchObject({ summary });
      expect.soft(replacementTokens).toEqual([contextTokens]);
      expect(compactionEnds).toEqual([]);
    } finally {
      releaseHook.resolve();
      await Promise.allSettled([work, bounded]);
    }
    await expect(work).resolves.toMatchObject({ summary });
    expect(compactionEnds).toHaveLength(1);
    expect(compactionEnds[0]?.outcome.status).toBe("completed");
  });

  it("surfaces the shared overflow recovery limit after exhausting it", async () => {
    let agentRequests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      agentRequests += 1;
      return createAssistantResultStream({
        ...createOverflowAssistant(activeModel),
        timestamp: Date.now() + agentRequests,
      });
    });
    const { session } = await createTestSession({
      settingsManager: createAutoCompactionSettings(),
      extension: createCompactionExtension(),
    });
    const compactionEvents = collectCompactionEnds(session);

    await session.prompt("long request");

    expect(streamMocks.streamSimple).toHaveBeenCalledTimes(MAX_OVERFLOW_COMPACTION_ATTEMPTS + 1);
    expect(compactionEvents.at(-1)).toMatchObject({
      type: "compaction_end",
      reason: "overflow",
      outcome: {
        status: "failed",
        reason: `Context overflow recovery failed after ${MAX_OVERFLOW_COMPACTION_ATTEMPTS} compact-and-retry attempts. Try reducing context or switching to a larger-context model.`,
      },
    });
  });

  it("strips stale thinking signatures before continuing after auto-compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(makeUserMessage("old prompt", Date.now() - 3));
    const retainedAssistantId = sessionManager.appendMessage({
      ...createAssistant(testModel, createStaleThinkingContent()),
      timestamp: Date.now() - 2,
    });
    const handlers = createResultHandlers("condensed history", retainedAssistantId);
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return createAssistantResultStream(
        requests.length === 1
          ? createOverflowAssistant(activeModel)
          : createAssistant(activeModel, "complete retry"),
      );
    });
    const { session } = await createTestSession({
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
      extension: handlers,
    });

    await session.prompt("long request");

    expect(requests).toHaveLength(2);
    expectRetainedThinking(session);
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("stale-");
  });

  it("sanitizes restored compaction history before pre-prompt maintenance", async () => {
    const model = { ...testModel, contextWindow: 1_000 };
    const sessionManager = SessionManager.inMemory();
    const now = Date.now();
    sessionManager.appendMessage(makeUserMessage("old prompt", now - 2));
    const retainedAssistantId = sessionManager.appendMessage({
      ...createAssistant(model, createStaleThinkingContent(), "stop", 950),
      timestamp: now - 1,
    });
    sessionManager.appendCompaction("condensed history", retainedAssistantId, 950);
    sessionManager.appendMessage(makeUserMessage("post-compaction prompt", now + 1_000));
    sessionManager.appendMessage({
      ...createAssistant(model, [], "error"),
      usage: {
        ...createZeroUsageFixture(),
        contextUsage: { state: "unavailable" },
      },
      errorMessage: "temporary provider error",
      timestamp: now + 1_001,
    });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 },
      retry: { enabled: false },
    });
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      textStream(activeModel, "complete answer", "stop", 20),
    );
    const { session } = await createTestSession({
      model,
      sessionManager,
      settingsManager,
      extension: createCompactionExtension(),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    expectRetainedThinking(session, true);

    await session.prompt("continue restored session");

    expect(compactionEvents).toEqual([]);
    expect(session.getLastAssistantText()).toBe("complete answer");
  });
});

describe("compaction writer admission", () => {
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  });

  type BeforeCompactionEvent = Extract<ExtensionEvent, { type: "session_before_compact" }>;

  it("does not append when a compaction extension rejects the finalized summary", async () => {
    const dir = tempDirs.make("openclaw-rejected-compaction-");
    const target = sessionTarget(path.join(dir, "sessions.json"), "rejected-compaction-reopen");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(target, {
      cwd: dir,
      message: { role: "user", content: "authoritative question", timestamp: 1 },
    });
    const sessionManager = SessionManager.open(target, dir);
    sessionManager.appendMessage(createAssistant(testModel, "authoritative answer"));
    const handlers: ExtensionFactory = (api) => {
      api.on("session_before_compact", async () => ({ cancel: true }));
    };
    const { session } = await createTestSession({
      sessionManager,
      extension: handlers,
    });
    const persistedBefore = await loadTranscriptEvents(target);
    const contextBefore = sessionManager.buildSessionContext();

    await expect(session.compact()).rejects.toThrow("Compaction cancelled");

    sessionManager.flushPendingPersistence();
    expect(await loadTranscriptEvents(target)).toEqual(persistedBefore);

    const databasePath = resolveSqliteTargetFromSessionStorePath(target.storePath).path;
    expect(await closeOpenClawAgentDatabaseByPathAsync(databasePath)).toBe(true);
    const reopened = SessionManager.open(target, dir);
    expect(reopened.getBranch()).toEqual(persistedBefore.slice(1));
    expect(reopened.buildSessionContext()).toEqual(contextBefore);
  });

  it("does not publish a cancelled compaction while waiting for the writer", async () => {
    const root = realpathSync(tempDirs.make("openclaw-context-admission-"));
    const target = sessionTarget(path.join(root, "sessions.json"), "context-admission");
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(target, root);
    manager.appendMessage(makeUserMessage("old prompt", 1));
    manager.appendMessage(createAssistant(testModel, "old answer"));
    manager.appendMessage(makeUserMessage("recent prompt", 3));
    manager.appendMessage(createAssistant(testModel, "recent answer"));
    const summaryReady = createDeferred();
    const published: string[] = [];
    const beforeCompact = async (event: unknown) => {
      summaryReady.resolve();
      const { firstKeptEntryId, tokensBefore } = (event as BeforeCompactionEvent).preparation;
      return { compaction: { summary: "condensed history", firstKeptEntryId, tokensBefore } };
    };
    const handlers: ExtensionFactory = (api) => {
      api.on("session_before_compact", beforeCompact);
      api.on("session_compact", async () => {
        published.push("compaction");
      });
    };
    const { session } = await createTestSession({
      sessionManager: manager,
      settingsManager: compactionSettings(),
      extension: handlers,
    });
    const before = await loadTranscriptEvents(target);
    const messagesBefore = [...session.messages];
    const gate = createEnteredGate();
    const reservation = runOpenClawAgentWriteAdmission(
      toDatabaseOptions(resolveSqliteReadScope(target)),
      gate.wait,
    );
    await gate.entered;
    const work = session.compact();
    const outcome = work.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    try {
      await summaryReady.promise;
      // The summary continuations reach the held writer before cancellation.
      await nextTurn();
      session.abortCompaction();
      gate.release();
      const result = await outcome;
      expect(result).toMatchObject({
        status: "rejected",
        error: new Error("Compaction cancelled"),
      });
      expect(await loadTranscriptEvents(target)).toEqual(before);
      expect(session.messages).toEqual(messagesBefore);
      expect(published).toEqual([]);
    } finally {
      gate.release();
      await Promise.allSettled([reservation, work]);
    }
  });
});

describe("degraded compaction reload", () => {
  const LATEST_ASK = "preserve the pending deployment status";
  const OVERSIZED_IDENTIFIER = `https://example.com/${"a".repeat(16_000)}`;
  const PRIOR_SUMMARY = [
    "## Decisions\nDeploy through the blue stack only.",
    "## Open TODOs\nNone.",
    "## Constraints/Rules\nNever restart the database during business hours.",
    "## Pending user asks\nNone.",
    "## Exact identifiers\nNone.",
  ].join("\n");
  const model: Model = { ...testModel, api: "compaction-test-api", contextWindow: 200_000 };

  async function reopen(target: { storePath: string }, dir: string): Promise<SessionManager> {
    const databasePath = resolveSqliteTargetFromSessionStorePath(target.storePath).path;
    expect(await closeOpenClawAgentDatabaseByPathAsync(databasePath)).toBe(true);
    return SessionManager.open(target as Parameters<typeof SessionManager.open>[0], dir);
  }

  function lastCompaction(sessionManager: SessionManager) {
    return expectDefined(
      compactions(sessionManager).at(-1),
      "expected a persisted compaction boundary",
    );
  }

  it.each([
    { name: "fresh session", priorBoundary: false },
    { name: "existing session", priorBoundary: true },
  ])("reopens and continues from a degraded boundary in a $name", async ({ priorBoundary }) => {
    const dir = tempDirs.make("openclaw-degraded-compaction-reload-");
    const target = sessionTarget(
      path.join(dir, "sessions.json"),
      `degraded-reload-${priorBoundary ? "existing" : "fresh"}`,
    );
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    let sessionManager = SessionManager.open(target, dir);
    if (priorBoundary) {
      // The boundary shape written before this change: no qualityDegraded field.
      sessionManager.appendMessage(makeUserMessage("earliest prompt", 1));
      const keptId = sessionManager.appendMessage({
        ...createAssistant(model, "earliest answer"),
        timestamp: 2,
      });
      sessionManager.appendCompaction(
        PRIOR_SUMMARY,
        keptId,
        1_000,
        { readFiles: [], modifiedFiles: [] },
        true,
      );
      sessionManager.flushPendingPersistence();
      sessionManager = await reopen(target, dir);
    }
    sessionManager.appendMessage(makeUserMessage(`${LATEST_ASK} ${OVERSIZED_IDENTIFIER}`, 3));
    sessionManager.appendMessage({ ...createAssistant(model, "old answer"), timestamp: 4 });
    sessionManager.appendMessage(makeUserMessage("latest prompt", 5));
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      textStream(activeModel, "Summary without headings"),
    );
    const fixture = await safeguardFixture(model, sessionManager);
    const { session, settingsManager, network } = fixture;
    try {
      const beforeCompaction = expectDefined(loadSessionEntry(target), "session fixture exists");
      expect(beforeCompaction.compactionQualityDegraded).toBeUndefined();
      const compactionEvents = collectCompactionEnds(session);
      await session.compact();
      expect(compactionEvents).toMatchObject([
        { outcome: { status: "completed", qualityDegraded: true } },
      ]);
      expect(loadSessionEntry(target)?.compactionQualityDegraded).toBe(true);
      // A stale accounting snapshot cannot clear a loss already committed by the transcript owner.
      await replaceSessionEntry(target, { ...beforeCompaction, updatedAt: 2 });
      expect(loadSessionEntry(target)?.compactionQualityDegraded).toBe(true);
      session.dispose();
      sessionManager.flushPendingPersistence();

      const reopened = await reopen(target, dir);
      expect(loadSessionEntry(target)?.compactionQualityDegraded).toBe(true);
      const boundary = lastCompaction(reopened);
      expect(boundary.details).toMatchObject({ qualityDegraded: true });
      expect(boundary.summary).toContain("## Pending user asks\nLatest user request context:");
      expect(boundary.summary).toContain(LATEST_ASK);
      expect(boundary.summary).not.toContain(OVERSIZED_IDENTIFIER);
      expect(boundary.summary).toContain("Summary without headings");
      const replay = JSON.stringify(reopened.buildSessionContext().messages);
      expect(replay).toContain(LATEST_ASK);
      expect(replay).not.toContain(OVERSIZED_IDENTIFIER);

      const requests: Context[] = [];
      streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
        requests.push(context);
        return textStream(activeModel, "continued answer");
      });
      const continued = await createTestSession({
        model,
        sessionManager: reopened,
        settingsManager,
      });
      await continued.session.prompt("next question");
      continued.session.dispose();
      expect(requests).toHaveLength(1);
      const request = JSON.stringify(requests[0]?.messages);
      expect(request).toContain("Latest user request context:");
      expect(request).toContain(LATEST_ASK);
      expect(request).toContain("next question");
      expect(request).not.toContain(OVERSIZED_IDENTIFIER);
      reopened.flushPendingPersistence();
      const afterTurn = await reopen(target, dir);
      expect(lastCompaction(afterTurn).id).toBe(boundary.id);
      expect(afterTurn.buildSessionContext().messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "continued answer" }],
      });
      expect(network).not.toHaveBeenCalled();
      await replaceSessionEntry(target, {
        ...beforeCompaction,
        lifecycleRevision: "fresh-lifecycle",
        updatedAt: 3,
      });
      expect(loadSessionEntry(target)?.compactionQualityDegraded).toBeUndefined();
    } finally {
      fixture.dispose();
    }
  });
});
