import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionContext } from "../../../../packages/agent-core/src/harness/session/session.js";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import type { SessionEntryCohortReader } from "../../../config/sessions/session-entry-read-runtime.types.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptReader,
} from "../../../config/sessions/transcript-write-context.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { SessionEntry } from "../../sessions/session-manager-types.js";

const mocks = vi.hoisted(() => ({
  createAnthropicPayloadLogger: vi.fn(),
  createCacheTrace: vi.fn(),
  createSessionSettleTracker: vi.fn(),
  retainSessionPromptState: vi.fn(),
  beginSessionSystemPrompt: vi.fn(() => false),
  installContextGuards: vi.fn(),
  prepareAgentSession: vi.fn(),
  prepareSessionBoundary: vi.fn(),
  prepareSessionManager: vi.fn(),
  prepareTrajectory: vi.fn(),
  prepareTransport: vi.fn(),
  restoreProjections: vi.fn(),
}));

vi.mock("../../anthropic-payload-log.js", () => ({
  createAnthropicPayloadLogger: mocks.createAnthropicPayloadLogger,
}));
vi.mock("../../cache-trace.js", () => ({ createCacheTrace: mocks.createCacheTrace }));
vi.mock("../session-prompt-state.js", async (importOriginal) => {
  const { prepareSessionSystemPrompt, persistSessionSystemPrompt, retireSessionSystemPrompt } =
    await importOriginal<typeof import("../session-prompt-state.js")>();
  return {
    retainEmbeddedSessionPromptState: mocks.retainSessionPromptState,
    beginSessionSystemPrompt: mocks.beginSessionSystemPrompt,
    prepareSessionSystemPrompt,
    persistSessionSystemPrompt,
    retireSessionSystemPrompt,
  };
});
vi.mock("../tool-result-truncation.js", () => ({
  restoreCacheTtlToolResultProjections: mocks.restoreProjections,
}));
vi.mock("./attempt-setup.js", () => ({
  installEmbeddedAttemptContextGuards: mocks.installContextGuards,
}));
vi.mock("./attempt-session-prepare.js", () => ({
  prepareEmbeddedAttemptAgentSession: mocks.prepareAgentSession,
  prepareEmbeddedAttemptSessionBoundary: mocks.prepareSessionBoundary,
  prepareEmbeddedAttemptSessionManager: mocks.prepareSessionManager,
}));
vi.mock("./attempt-session-settle.js", () => ({
  createEmbeddedAttemptSessionSettleTracker: mocks.createSessionSettleTracker,
}));
vi.mock("./attempt-stream-settle.js", () => ({
  prepareEmbeddedAttemptTransport: mocks.prepareTransport,
}));
vi.mock("./attempt-trajectory.js", () => ({
  prepareEmbeddedAttemptTrajectory: mocks.prepareTrajectory,
}));

import { persistSessionSystemPrompt } from "../session-prompt-state.js";
import { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";
import {
  buildRuntimeContextCustomMessage,
  buildSystemUpdateMessage,
} from "./runtime-context-prompt.js";

type PrepareInput = Parameters<typeof prepareEmbeddedAttemptSessionRuntime>[0];

function createFixture() {
  const order: string[] = [];
  const stage = <T>(mock: ReturnType<typeof vi.fn>, event: string, value: T) => {
    mock.mockImplementation(() => {
      order.push(event);
      return value;
    });
    return value;
  };
  const activeMarker = { type: "custom", customType: "openclaw.cache-ttl", data: "active" };
  const sessionManager = {
    getBranch: () => [activeMarker],
    getToolResultProjectionEntries: () => [activeMarker],
  };
  const activeSession = {
    messages: [{ role: "user" }, { role: "assistant" }],
    sessionId: "active-session",
  };
  const agentSession = {
    activeSession,
    clientToolDefs: [{ name: "read" }, { name: "write" }],
    setActiveSessionSystemPrompt: vi.fn(),
    settingsManager: {},
  };
  const promptState = { toolResults: { projected: true } };
  const promptStateLease = stage(mocks.retainSessionPromptState, "prompt-state", {
    state: promptState,
    [Symbol.dispose]: vi.fn(),
  });
  const settleTracker = stage(mocks.createSessionSettleTracker, "settle-tracker", {
    abortActiveSession: vi.fn(async () => undefined),
    buildAbortSettlePromise: vi.fn(() => null),
  });
  const runtimeValues = {
    boundary: stage(mocks.prepareSessionBoundary, "boundary", {
      setCurrentUserTimestampOverride: vi.fn(),
    }),
    contextGuards: stage(mocks.installContextGuards, "context-guards", { remove: vi.fn() }),
    cacheTrace: stage(mocks.createCacheTrace, "cache-trace", {}),
    anthropicPayloadLogger: stage(mocks.createAnthropicPayloadLogger, "payload-logger", {}),
    trajectoryRecorder: {},
    transport: { compactionReplayEnabled: true, effectivePromptCacheRetention: "long" },
    sessionManager,
    sessionPromptState: promptState,
    toolResultPromptProjectionState: promptState.toolResults,
  };
  const transcriptPolicy = { repairToolUseResultPairing: true, inHistorySystemUpdates: false };
  const getUserTranscriptContexts = vi.fn(() => []);
  const preparedUserTurnMessage = { role: "user", content: "hello" };

  mocks.prepareSessionManager.mockImplementation(async (input) => {
    order.push("manager");
    input.onSessionManagerCreated(sessionManager);
    return {
      isOpenAIResponsesApi: true,
      preparedUserTurnMessage,
      sessionManager,
      transcriptPolicy,
      userMessageBoundary: {
        getUserTranscriptContexts,
        preparedUserTurnMessage,
      },
    };
  });
  mocks.prepareAgentSession.mockImplementation(async (input) => {
    order.push("agent-session");
    input.onSessionCreated(activeSession);
    input.onSystemPromptChanged("runtime prompt");
    return agentSession;
  });
  for (const [mock, event, value] of [
    [mocks.prepareTrajectory, "trajectory", runtimeValues.trajectoryRecorder],
    [mocks.prepareTransport, "transport", runtimeValues.transport],
  ] as const) {
    mock.mockImplementation(async () => {
      order.push(event);
      return value;
    });
  }

  const resources = new Proxy<PrepareInput["resources"]>(
    { trajectoryRecorder: null, buildAbortSettlePromise: () => null },
    {
      set: (target, key, value) => {
        order.push(`own-${String(key)}`);
        return Reflect.set(target, key, value);
      },
    },
  );
  const onSessionYieldReady = vi.fn(() => order.push("own-yield"));
  const externalAbortController = {
    setActiveSessionAbort: vi.fn(() => order.push("arm-session-abort")),
  };
  const input = {
    attempt: {
      model: { api: "openai-responses", contextWindow: 128_000 },
      modelId: "gpt-5",
      provider: "openai",
      runId: "run-1",
      sessionId: "session-1",
      workspaceDir: "/workspace",
    },
    isRawModelRun: false,
    setup: {},
    toolBase: { codeModeControlsEnabledForRun: false },
    toolCatalog: {
      effectiveTools: Array.from({ length: 4 }, (_, i) => ({ name: `tool-${i}` })),
      toolSearchRunPlan: { replayAllowedToolNames: new Set(["read"]) },
    },
    bundleTools: { clientTools: [], uncompactedEffectiveTools: [] },
    systemPrompt: { systemPromptText: "initial prompt" },
    sessionLock: {
      transcriptLifecycle: {},
      ownedTranscriptWriteContext: {
        withTranscriptWrite: async (operation: () => unknown) => await operation(),
      },
      withOwnedTranscriptWrite: vi.fn(async (operation: () => unknown) => {
        order.push("owned-boundary");
        return await operation();
      }),
    },
    runAbortSignal: new AbortController().signal,
    externalAbortController,
    resources,
    onSessionYieldReady,
  } as unknown as PrepareInput;

  return {
    ...settleTracker,
    ...runtimeValues,
    activeSession,
    agentSession,
    externalAbortController,
    getUserTranscriptContexts,
    input,
    resources,
    runtimeValues,
    onSessionYieldReady,
    order,
    promptState,
    promptStateLease,
    transcriptPolicy,
  };
}

beforeEach(() => vi.clearAllMocks());

function createPromptFixture(sessionId: string, beforeAppend = () => {}, afterAppend = () => {}) {
  const fixture = createFixture();
  fixture.transcriptPolicy.inHistorySystemUpdates = true;
  const entries: SessionEntry[] = [];
  const appendCustomEntryAsync = async (customType: string, data: unknown) => {
    beforeAppend();
    entries.push({
      type: "custom",
      customType,
      data,
      id: `marker-${entries.length}`,
      parentId: null,
      timestamp: "2026-10-01T00:00:00Z",
    });
    afterAppend();
  };
  Object.assign(fixture.sessionManager, {
    getBranch: () => entries,
    getToolResultProjectionEntries: () => entries,
    getSessionTarget: () => undefined,
    getSessionId: () => sessionId,
    appendCustomEntryAsync,
  });
  const agentState = { messages: [] as ReturnType<typeof buildSystemUpdateMessage>[] };
  Object.assign(fixture.activeSession, { agent: { state: agentState } });
  Object.defineProperty(fixture.activeSession, "messages", { get: () => agentState.messages });
  const appendUpdate = (
    id: string,
    update: NonNullable<ReturnType<typeof buildSystemUpdateMessage>>,
  ) => {
    entries.push({
      type: "custom_message",
      customType: update.customType,
      content: update.content,
      details: update.details,
      display: false,
      id,
      parentId: null,
      timestamp: "2026-10-01T00:00:00Z",
    });
  };
  return { ...fixture, entries, agentState, appendCustomEntryAsync, appendUpdate };
}

describe("prepareEmbeddedAttemptSessionRuntime", () => {
  it("re-pins personal bootstrap when the selected profile changes between attempts", async () => {
    const fixture = createPromptFixture("shared-profile-session");
    mocks.retainSessionPromptState.mockImplementation(() => ({
      state: { toolResults: { projected: true } },
      [Symbol.dispose]: () => {},
    }));
    for (const profile of ["alice", "bob", undefined]) {
      fixture.input.attempt.bootstrapUserProfileId = profile;
      const runtime = await prepareEmbeddedAttemptSessionRuntime(fixture.input);
      const prompt = `## User\n${profile ?? "Shared"} guidance`;
      const prepared = await runtime.prepareSystemPromptUpdate!(prompt, true);
      expect(prepared).toMatchObject({ restart: true, systemPrompt: prompt });
      prepared.commit();
      await persistSessionSystemPrompt(runtime.sessionPromptState, fixture.appendCustomEntryAsync);
    }
  });

  it.each(["current", "run-revoked", "reader-revoked"] as const)(
    "keeps constructor transcript authority across preparation when %s",
    async (outcome) => {
      const fixture = createFixture();
      const run = new AbortController();
      const readerLifetime = new AbortController();
      const target = {
        agentId: "main",
        sessionKey: "agent:main:context-propagation",
        sessionId: "context-propagation",
        storePath: "/state/openclaw-agent.sqlite",
        env: { OPENCLAW_STATE_DIR: "/state" },
      };
      const rejectCohort = async () => {
        throw new Error("Constructor propagation does not execute a database cohort");
      };
      const reader: SessionEntryCohortReader = {
        database: { agentId: target.agentId, path: target.storePath, env: target.env },
        sessionKey: target.sessionKey,
        logicalAgentId: target.agentId,
        storePaths: [target.storePath],
        assertCurrent: () => readerLifetime.signal.throwIfAborted(),
        readEntry: rejectCohort,
        withRead: rejectCohort,
      };
      fixture.input.sessionLock.ownedTranscriptWriteContext = {
        sessionTarget: target,
        sessionReader: reader,
        assertCommitAllowed: () => run.signal.throwIfAborted(),
        withTranscriptWrite: async (operation) => await operation(),
      };
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      let assertOriginalWriter: (() => void) | undefined;
      mocks.prepareAgentSession.mockImplementationOnce(async (input) => {
        const selected = getOwnedSessionTranscriptReader(target);
        expect(selected).toBe(reader);
        expect(getOwnedSessionTranscriptReader({ ...target, sessionId: "other" })).toBeUndefined();
        assertOriginalWriter = captureOwnedTranscriptWriteAssertion(target);
        entered.resolve();
        await resume.promise;
        selected!.assertCurrent();
        assertOriginalWriter();
        input.onSessionCreated(fixture.activeSession);
        return fixture.agentSession;
      });
      const preparing = prepareEmbeddedAttemptSessionRuntime(fixture.input);
      const refused = new Error(`Transcript preparation ${outcome}`);
      try {
        await awaitGateBeforeSettlement(entered.promise, preparing, "Constructor was not reached");
        expect(getOwnedSessionTranscriptReader(target)).toBeUndefined();
        expect(fixture.resources.session).toBeUndefined();
        if (outcome === "run-revoked") {
          run.abort(refused);
        } else if (outcome === "reader-revoked") {
          readerLifetime.abort(refused);
        }
        resume.resolve();
        if (outcome === "current") {
          await preparing;
          expect(fixture.resources.session).toBe(fixture.activeSession);
          run.abort(refused);
          expect(() => assertOriginalWriter!()).toThrow(refused);
        } else {
          await expect(preparing).rejects.toBe(refused);
          expect(fixture.resources.session).toBeUndefined();
        }
      } finally {
        resume.resolve();
        await preparing.catch(() => {});
      }
    },
  );

  it.each(["unadmitted", "append-rejected", "committed-then-rejected"] as const)(
    "re-pins the current rendering after a route retirement is %s",
    async (interruption) => {
      let interruptRetirement = false;
      const rejectRetirement = (stage: typeof interruption) => () => {
        if (interruptRetirement && interruption === stage) {
          throw new Error("retirement append rejected");
        }
      };
      const fixture = createPromptFixture(
        "interrupted-route-retirement",
        rejectRetirement("append-rejected"),
        rejectRetirement("committed-then-rejected"),
      );
      const { entries, agentState, appendCustomEntryAsync, appendUpdate } = fixture;
      const routeR = fixture.input.attempt.modelId;
      const firstRuntime = await prepareEmbeddedAttemptSessionRuntime(fixture.input);
      const initial = await firstRuntime.prepareSystemPromptUpdate!("## Policy\nA");
      initial.commit();
      await persistSessionSystemPrompt(firstRuntime.sessionPromptState, appendCustomEntryAsync);
      const changed = await firstRuntime.prepareSystemPromptUpdate!("## Policy\nB", true);
      changed.commit();
      appendUpdate("update-B", changed.update!);
      agentState.messages.push(changed.update!);
      await persistSessionSystemPrompt(firstRuntime.sessionPromptState, appendCustomEntryAsync);
      expect(changed.systemPrompt).toBe("## Policy\nA");

      fixture.input.attempt.modelId = "route-S";
      const secondRuntime = await prepareEmbeddedAttemptSessionRuntime(fixture.input);
      interruptRetirement = true;
      const preparedS = secondRuntime.prepareSystemPromptUpdate!("## Policy\nS");
      if (interruption === "unadmitted") {
        await preparedS;
      } else {
        await expect(preparedS).rejects.toThrow("retirement append");
      }
      interruptRetirement = false;
      fixture.input.attempt.modelId = routeR;
      const resumedRuntime = await prepareEmbeddedAttemptSessionRuntime(fixture.input);
      const resumed = await resumedRuntime.prepareSystemPromptUpdate!("## Policy\nB", true);
      expect(resumed).toMatchObject({
        restart: true,
        systemPrompt: "## Policy\nB",
        update: undefined,
      });
      expect(agentState.messages).toEqual([]);
      resumed.commit();
      await persistSessionSystemPrompt(resumedRuntime.sessionPromptState, appendCustomEntryAsync);
      expect(entries.at(-1)).toMatchObject({
        data: { prefix: "## Policy\nB", renderedPrefix: "## Policy\nB" },
      });
      expect(buildSessionContext(entries).messages).toEqual([]);
    },
  );

  it("keeps permission admission retryable and restores a fresh rendering of the pinned policy", async () => {
    const fixture = createPromptFixture("restart-notice");
    const { entries, agentState, appendCustomEntryAsync, appendUpdate } = fixture;
    const runtimeContext = buildRuntimeContextCustomMessage("Retained facts", undefined, true)!;
    agentState.messages = [
      runtimeContext,
      buildSystemUpdateMessage("Retired override", "prompt-update", false),
    ];
    const permissionNotice = "## Permission change\nWrite access was removed.";
    const prompt = `## Tools\nread\n<!-- openclaw:attempt:PERMISSION -->\n${permissionNotice}\n<!-- /openclaw:attempt:PERMISSION -->`;
    const runtime = await prepareEmbeddedAttemptSessionRuntime(fixture.input);
    const prepare = runtime.prepareSystemPromptUpdate!;
    const first = await prepare(prompt);
    expect(first.update?.content).toBe(permissionNotice);
    expect(agentState.messages).toEqual([runtimeContext]);

    // Failed replay admission never calls the returned projection's commit.
    const retry = await prepare(prompt);
    expect(retry.update?.content).toBe(permissionNotice);
    retry.commit();
    appendUpdate("admitted-notice", retry.update!);
    await persistSessionSystemPrompt(runtime.sessionPromptState, appendCustomEntryAsync);
    expect(buildSessionContext(entries).messages).toContainEqual(
      expect.objectContaining({ role: "custom", content: permissionNotice }),
    );
    expect((await prepare(prompt)).update).toBeUndefined();

    const pinned = retry.systemPrompt;
    const restricted = await prepare("## Tools\nNo tools are available.");
    restricted.commit();
    await persistSessionSystemPrompt(runtime.sessionPromptState, appendCustomEntryAsync);
    expect((await prepare(pinned)).update).toBeUndefined();
    const restored = await prepare(pinned, true);
    expect(restored.systemPrompt).toBe(pinned);
    expect(restored.update?.content).toContain("## Tools\nread");
  });

  it("prepares the session runtime in ownership-safe order and keeps prompt state live", async () => {
    const fixture = createFixture();

    const result = await prepareEmbeddedAttemptSessionRuntime(fixture.input);

    expect(mocks.restoreProjections).toHaveBeenCalledWith(
      fixture.promptState.toolResults,
      fixture.sessionManager.getBranch(),
    );
    expect(fixture.order).toEqual(
      (
        "manager own-sessionManager prompt-state own-promptStateLease own-getUserTranscriptContexts " +
        "agent-session own-session owned-boundary boundary settle-tracker arm-session-abort " +
        "own-buildAbortSettlePromise own-yield context-guards own-removeToolResultContextGuard " +
        "cache-trace payload-logger trajectory own-trajectoryRecorder transport"
      ).split(" "),
    );
    for (const [key, value] of Object.entries(fixture.runtimeValues)) {
      expect(Reflect.get(result, key)).toBe(value);
    }
    expect(result.state).toEqual({
      currentTurnImageFailureCount: 0,
      prePromptMessageCount: 2,
      promptCache: undefined,
      systemPromptText: "runtime prompt",
    });
    expect(mocks.prepareSessionBoundary).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: fixture.input.runAbortSignal,
        getUserTranscriptContexts: fixture.getUserTranscriptContexts,
        preparedUserTurnMessage: { role: "user", content: "hello" },
      }),
    );
    expect(fixture.externalAbortController.setActiveSessionAbort).toHaveBeenCalledWith(
      fixture.abortActiveSession,
    );
    expect(fixture.resources.buildAbortSettlePromise).toBe(fixture.buildAbortSettlePromise);
    expect(fixture.resources.getUserTranscriptContexts).toBe(fixture.getUserTranscriptContexts);
    expect(fixture.onSessionYieldReady).toHaveBeenCalledWith({
      abortActiveSession: fixture.abortActiveSession,
      activeSession: fixture.activeSession,
    });

    result.state.prePromptMessageCount = 7;
    result.state.promptCache = { cacheRead: 3 } as never;
    result.state.systemPromptText = "updated prompt";
    const guardInput = mocks.installContextGuards.mock.calls[0]?.[0];
    expect(guardInput.getPrePromptMessageCount()).toBe(7);
    expect(guardInput.getPromptCache()).toEqual({ cacheRead: 3 });
    expect(guardInput.getPromptCacheRetention()).toBe("long");
    expect(guardInput.getCompactionReplayEnabled()).toBe(true);
    expect(guardInput.getSystemPrompt()).toBe("updated prompt");
    guardInput.onCurrentTurnImageFailure(2);
    guardInput.onCurrentTurnImageFailure(1);
    expect(result.state.currentTurnImageFailureCount).toBe(2);
  });

  it("publishes every cleanup owner before a later transport failure", async () => {
    const fixture = createFixture();
    mocks.prepareTransport.mockRejectedValueOnce(new Error("transport failed"));

    await expect(prepareEmbeddedAttemptSessionRuntime(fixture.input)).rejects.toThrow(
      "transport failed",
    );

    expect(fixture.resources.sessionManager).toBe(fixture.sessionManager);
    expect(fixture.resources.promptStateLease).toBe(fixture.promptStateLease);
    expect(fixture.resources.session).toBe(fixture.activeSession);
    expect(fixture.resources.removeToolResultContextGuard).toBe(fixture.contextGuards.remove);
    expect(fixture.resources.buildAbortSettlePromise).toBe(fixture.buildAbortSettlePromise);
    expect(fixture.resources.trajectoryRecorder).toBe(fixture.trajectoryRecorder);
  });

  it("settles pending user-turn persistence before reconciling the session boundary", async () => {
    const fixture = createFixture();
    const pendingPersistence = createDeferredCore();
    const waitForRuntimePersistence = vi.fn(async () => await pendingPersistence.promise);
    fixture.input.attempt.userTurnTranscriptRecorder = {
      waitForRuntimePersistence,
    } as unknown as PrepareInput["attempt"]["userTurnTranscriptRecorder"];

    const preparing = prepareEmbeddedAttemptSessionRuntime(fixture.input);
    await vi.waitFor(() => expect(waitForRuntimePersistence).toHaveBeenCalledOnce());
    expect(mocks.prepareSessionBoundary).not.toHaveBeenCalled();

    pendingPersistence.resolve();
    await preparing;

    expect(mocks.prepareSessionBoundary).toHaveBeenCalledOnce();
  });
});
