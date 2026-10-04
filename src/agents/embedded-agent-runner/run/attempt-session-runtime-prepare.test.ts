import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionContext } from "../../../../packages/agent-core/src/harness/session/session.js";
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
  const activeMarker = { type: "custom", customType: "openclaw.cache-ttl", data: "active" };
  const sessionManager = {
    kind: "manager",
    getBranch: () => [activeMarker],
    getEntries: () => [activeMarker, { ...activeMarker, data: "sibling" }],
  };
  const activeSession = {
    messages: [{ role: "user" }, { role: "assistant" }],
    sessionId: "active-session",
  };
  const settingsManager = { kind: "settings" };
  const setActiveSessionSystemPrompt = vi.fn();
  const agentSession = {
    activeSession,
    clientToolDefs: [{ name: "read" }, { name: "write" }],
    setActiveSessionSystemPrompt,
    settingsManager,
  };
  const boundary = { setCurrentUserTimestampOverride: vi.fn() };
  const promptState = { toolResults: { projected: true } };
  const promptStateLease = { state: promptState, [Symbol.dispose]: vi.fn() };
  const abortActiveSession = vi.fn(async () => undefined);
  const buildAbortSettlePromise = vi.fn(() => null);
  const trackPromptSettlePromise = vi.fn((promise: Promise<void>) => promise);
  const settleTracker = {
    abortActiveSession,
    buildAbortSettlePromise,
    trackPromptSettlePromise,
  };
  const contextGuards = {
    getAfterTurnCheckpoint: vi.fn(() => null),
    remove: vi.fn(),
    takePendingMidTurnPrecheckRequest: vi.fn(() => null),
  };
  const cacheTrace = { kind: "cache-trace" };
  const anthropicPayloadLogger = { kind: "payload-logger" };
  const trajectoryRecorder = { kind: "trajectory" };
  const transport = {
    compactionReplayEnabled: true,
    effectiveAgentTransport: "sse",
    effectiveExtraParams: { cacheRetention: "long" },
    effectivePromptCacheRetention: "long",
    providerTextTransforms: undefined,
    streamStrategy: "provider",
  };
  const transcriptPolicy = { repairToolUseResultPairing: true, inHistorySystemUpdates: false };
  const getUserTranscriptContexts = vi.fn(() => []);

  mocks.prepareSessionManager.mockImplementation(async (input) => {
    order.push("manager");
    input.onSessionManagerCreated(sessionManager);
    return {
      isOpenAIResponsesApi: true,
      preparedUserTurnMessage: { role: "user", content: "hello" },
      sessionManager,
      transcriptPolicy,
      userMessageBoundary: {
        getUserTranscriptContexts,
        preparedUserTurnMessage: { role: "user", content: "hello" },
      },
    };
  });
  mocks.prepareAgentSession.mockImplementation(async (input) => {
    order.push("agent-session");
    input.onSessionCreated(activeSession);
    input.onSystemPromptChanged("runtime prompt");
    return agentSession;
  });
  mocks.prepareSessionBoundary.mockImplementation(() => {
    order.push("boundary");
    return boundary;
  });
  mocks.retainSessionPromptState.mockImplementation(() => {
    order.push("prompt-state");
    return promptStateLease;
  });
  mocks.createSessionSettleTracker.mockImplementation(() => {
    order.push("settle-tracker");
    return settleTracker;
  });
  mocks.installContextGuards.mockImplementation(() => {
    order.push("context-guards");
    return contextGuards;
  });
  mocks.createCacheTrace.mockImplementation(() => {
    order.push("cache-trace");
    return cacheTrace;
  });
  mocks.createAnthropicPayloadLogger.mockImplementation(() => {
    order.push("payload-logger");
    return anthropicPayloadLogger;
  });
  mocks.prepareTrajectory.mockImplementation(async () => {
    order.push("trajectory");
    return trajectoryRecorder;
  });
  mocks.prepareTransport.mockImplementation(async () => {
    order.push("transport");
    return transport;
  });

  const resourceEvents: Record<string, string> = {
    promptStateLease: "own-prompt-state",
    session: "own-session",
    sessionManager: "own-manager",
    getUserTranscriptContexts: "own-user-transcript-contexts",
    removeToolResultContextGuard: "own-context-guards",
    buildAbortSettlePromise: "own-settle-tracker",
    trajectoryRecorder: "own-trajectory",
  };
  const resources = new Proxy<PrepareInput["resources"]>(
    { trajectoryRecorder: null, buildAbortSettlePromise: () => null },
    {
      set: (target, key, value) => {
        order.push(resourceEvents[String(key)]!);
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
    agentDir: "/agent",
    isRawModelRun: false,
    resolveActiveContextEnginePluginId: vi.fn(),
    setup: {
      agentCoreThinkingLevel: "medium",
      effectiveCwd: "/workspace",
      effectiveWorkspace: "/workspace",
      getCurrentAttemptPluginMetadataSnapshot: vi.fn(),
      getProviderRuntimeHandle: vi.fn(),
      prepStages: { mark: vi.fn() },
      providerThinkingLevel: "medium",
      sessionAgentId: "main",
      sandboxSessionKey: "sandbox-1",
    },
    toolBase: {
      computerContextEpoch: { value: 0 },
      localModelLeanEnabled: false,
      codeModeControlsEnabledForRun: false,
    },
    toolCatalog: {
      effectiveTools: Array.from({ length: 4 }, (_, i) => ({ name: `tool-${i}` })),
      toolSearchRunPlan: { replayAllowedToolNames: new Set(["read"]) },
    },
    bundleTools: { clientTools: [], uncompactedEffectiveTools: [] },
    systemPrompt: { systemPromptText: "initial prompt" },
    sessionLock: {
      transcriptLifecycle: {},
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
    abortActiveSession,
    activeSession,
    anthropicPayloadLogger,
    boundary,
    buildAbortSettlePromise,
    cacheTrace,
    contextGuards,
    externalAbortController,
    getUserTranscriptContexts,
    input,
    resources,
    onSessionYieldReady,
    order,
    promptState,
    promptStateLease,
    sessionManager,
    settingsManager,
    trajectoryRecorder,
    transcriptPolicy,
    transport,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepareEmbeddedAttemptSessionRuntime", () => {
  it.each(["unadmitted", "append-rejected", "committed-then-rejected"] as const)(
    "re-pins the current rendering after a route retirement is %s",
    async (interruption) => {
      const fixture = createFixture();
      fixture.transcriptPolicy.inHistorySystemUpdates = true;
      const entries: SessionEntry[] = [];
      let interruptRetirement = false;
      const appendCustomEntryAsync = async (customType: string, data: unknown) => {
        if (interruptRetirement && interruption === "append-rejected") {
          throw new Error("retirement append rejected");
        }
        entries.push({
          type: "custom",
          customType,
          data,
          id: `marker-${entries.length}`,
          parentId: null,
          timestamp: "2026-10-01T00:00:00Z",
        });
        if (interruptRetirement && interruption === "committed-then-rejected") {
          throw new Error("retirement append committed before rejection");
        }
      };
      Object.assign(fixture.sessionManager, {
        getBranch: () => entries,
        getSessionTarget: () => undefined,
        getSessionId: () => "interrupted-route-retirement",
        appendCustomEntryAsync,
      });
      const agentState = { messages: [] as ReturnType<typeof buildSystemUpdateMessage>[] };
      Object.assign(fixture.activeSession, { agent: { state: agentState } });
      Object.defineProperty(fixture.activeSession, "messages", { get: () => agentState.messages });
      const routeR = fixture.input.attempt.modelId;
      const firstRuntime = await prepareEmbeddedAttemptSessionRuntime(fixture.input);
      const initial = await firstRuntime.prepareSystemPromptUpdate!("## Policy\nA");
      initial.commit();
      await persistSessionSystemPrompt(firstRuntime.sessionPromptState, appendCustomEntryAsync);
      const changed = await firstRuntime.prepareSystemPromptUpdate!("## Policy\nB", true);
      changed.commit();
      entries.push({
        type: "custom_message",
        customType: changed.update!.customType,
        content: changed.update!.content,
        details: changed.update!.details,
        display: false,
        id: "update-B",
        parentId: null,
        timestamp: "2026-10-01T00:00:00Z",
      });
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
      expect(resumed.restart).toBe(true);
      expect(resumed.systemPrompt).toBe("## Policy\nB");
      expect(resumed.update).toBeUndefined();
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
    const fixture = createFixture();
    fixture.transcriptPolicy.inHistorySystemUpdates = true;
    const entries: SessionEntry[] = [];
    const appendCustomEntryAsync = async (customType: string, data: unknown) => {
      entries.push({
        type: "custom",
        customType,
        data,
        id: `marker-${entries.length}`,
        parentId: null,
        timestamp: "2026-10-01T00:00:00Z",
      });
    };
    Object.assign(fixture.sessionManager, {
      getBranch: () => entries,
      getSessionTarget: () => undefined,
      getSessionId: () => "restart-notice",
      appendCustomEntryAsync,
    });
    const runtimeContext = buildRuntimeContextCustomMessage(
      "Retained turn facts",
      undefined,
      true,
    )!;
    const agentState = {
      messages: [
        runtimeContext,
        buildSystemUpdateMessage("Retired override", "prompt-update", false),
      ],
    };
    Object.assign(fixture.activeSession, { agent: { state: agentState } });
    Object.defineProperty(fixture.activeSession, "messages", { get: () => agentState.messages });
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
    entries.push({
      type: "custom_message",
      customType: retry.update!.customType,
      content: retry.update!.content,
      details: retry.update!.details,
      display: false,
      id: "admitted-notice",
      parentId: null,
      timestamp: "2026-10-01T00:00:00Z",
    });
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

  it.each([false, true])(
    "registers prompt series only outside settled finalization %s",
    async (finalization) => {
      const fixture = createFixture();
      fixture.transcriptPolicy.inHistorySystemUpdates = true;
      const existing = { prefix: "Ordinary pinned prefix" };
      const pending = { prefix: "Ordinary pending prefix" };
      Object.assign(fixture.promptState, { systemPrompt: existing, pendingSystemPrompt: pending });
      if (finalization) {
        fixture.input.attempt.operation = "settled-tool-finalization";
        fixture.input.systemPrompt.systemPromptText = "";
      }

      const result = await prepareEmbeddedAttemptSessionRuntime(fixture.input);
      const registered = mocks.prepareAgentSession.mock.calls[0]?.[0];
      if (finalization) {
        expect(mocks.beginSessionSystemPrompt).not.toHaveBeenCalled();
        expect(registered).toMatchObject({
          initialSystemPrompt: "",
          prepareSystemPromptUpdate: undefined,
        });
        expect(result.prepareSystemPromptUpdate).toBeUndefined();
        expect(fixture.promptState).toMatchObject({
          systemPrompt: existing,
          pendingSystemPrompt: pending,
        });
      } else {
        expect(mocks.beginSessionSystemPrompt).toHaveBeenCalledOnce();
        expect(registered.prepareSystemPromptUpdate).toBeTypeOf("function");
        expect(result.prepareSystemPromptUpdate).toBe(registered.prepareSystemPromptUpdate);
      }
    },
  );

  it("prepares the session runtime in ownership-safe order and keeps prompt state live", async () => {
    const fixture = createFixture();

    const result = await prepareEmbeddedAttemptSessionRuntime(fixture.input);

    expect(mocks.restoreProjections).toHaveBeenCalledWith(
      fixture.promptState.toolResults,
      fixture.sessionManager.getBranch(),
    );
    expect(fixture.order).toEqual([
      "manager",
      "own-manager",
      "prompt-state",
      "own-prompt-state",
      "own-user-transcript-contexts",
      "agent-session",
      "own-session",
      "owned-boundary",
      "boundary",
      "settle-tracker",
      "arm-session-abort",
      "own-settle-tracker",
      "own-yield",
      "context-guards",
      "own-context-guards",
      "cache-trace",
      "payload-logger",
      "trajectory",
      "own-trajectory",
      "transport",
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        anthropicPayloadLogger: fixture.anthropicPayloadLogger,
        boundary: fixture.boundary,
        cacheTrace: fixture.cacheTrace,
        contextGuards: fixture.contextGuards,
        sessionManager: fixture.sessionManager,
        sessionPromptState: fixture.promptState,
        toolResultPromptProjectionState: fixture.promptState.toolResults,
        trajectoryRecorder: fixture.trajectoryRecorder,
        transport: fixture.transport,
      }),
    );
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
    let releasePersistence: (() => void) | undefined;
    const pendingPersistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const waitForRuntimePersistence = vi.fn(async () => await pendingPersistence);
    fixture.input.attempt.userTurnTranscriptRecorder = {
      waitForRuntimePersistence,
    } as unknown as PrepareInput["attempt"]["userTurnTranscriptRecorder"];

    const preparing = prepareEmbeddedAttemptSessionRuntime(fixture.input);
    await vi.waitFor(() => expect(waitForRuntimePersistence).toHaveBeenCalledOnce());
    expect(mocks.prepareSessionBoundary).not.toHaveBeenCalled();

    releasePersistence?.();
    await preparing;

    expect(mocks.prepareSessionBoundary).toHaveBeenCalledOnce();
  });
});
