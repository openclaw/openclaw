import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionContext } from "../../../../packages/agent-core/src/harness/session/session.js";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { SessionEntryCohortReader } from "../../../config/sessions/session-entry-read-runtime.types.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptReader,
} from "../../../config/sessions/transcript-write-context.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import {
  closeAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";
import type { SessionEntry } from "../../sessions/session-manager-types.js";

const mocks = vi.hoisted(() => ({
  createAnthropicPayloadLogger: vi.fn(),
  createCacheTrace: vi.fn(),
  createSessionSettleTracker: vi.fn(),
  retainSessionPromptState: vi.fn(),
  installContextGuards: vi.fn(),
  prepareAgentSession: vi.fn(),
  prepareSessionBoundary: vi.fn(),
  prepareSessionManager: vi.fn(),
  createTrajectory: vi.fn(),
  trajectoryMetadata: vi.fn((_input: unknown) => ({ trace: "metadata" })),
  trajectoryPath: vi.fn<
    typeof import("./attempt-transcript-helpers.js").resolveAttemptTrajectorySessionFile
  >(async () => "/tmp/trajectory.jsonl"),
  prepareTransport: vi.fn(),
  restoreProjections: vi.fn(),
}));

vi.mock("../../anthropic-payload-log.js", () => ({
  createAnthropicPayloadLogger: mocks.createAnthropicPayloadLogger,
}));
vi.mock("../../cache-trace.js", () => ({ createCacheTrace: mocks.createCacheTrace }));
vi.mock("../session-prompt-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-prompt-state.js")>()),
  retainEmbeddedSessionPromptState: mocks.retainSessionPromptState,
}));
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
// mock-isolation: Recorder persistence is outside the attempt metadata contract.
vi.mock("../../../trajectory/runtime.js", () => ({
  createTrajectoryRuntimeRecorder: mocks.createTrajectory,
}));
// mock-isolation: Capture attempt metadata without collecting real session/runtime metadata.
vi.mock("../../../trajectory/metadata.js", () => ({
  buildTrajectoryRunMetadata: mocks.trajectoryMetadata,
}));
// mock-isolation: Supply a synthetic transcript path without opening the session store.
vi.mock("./attempt-transcript-helpers.js", () => ({
  resolveAttemptTrajectorySessionFile: mocks.trajectoryPath,
}));

import { persistSessionSystemPrompt } from "../session-prompt-state.js";
import { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";
import {
  buildRuntimeContextCustomMessage,
  buildSystemUpdateMessage,
} from "./runtime-context-prompt.js";

type PrepareInput = Parameters<typeof prepareEmbeddedAttemptSessionRuntime>[0];
const trajectoryRoots = createTempDirTracker();
let trajectoryAdmission: ReturnType<typeof prepareSystemAgentRunAdmission>;
let admittedRunContext: PrepareInput["attempt"]["admittedRunContext"];

function createCheckpointWriter(entries: SessionEntry[], prefix: string) {
  return async (customType: string, data: unknown) => {
    entries.push({
      type: "custom",
      customType,
      data,
      id: `${prefix}-${entries.length}`,
      parentId: null,
      timestamp: "2026-10-01T00:00:00Z",
    });
  };
}

function createHistoryFixture(messages?: ReturnType<typeof buildSystemUpdateMessage>[]) {
  const fixture = createFixture();
  fixture.transcriptPolicy.inHistorySystemUpdates = true;
  const entries: SessionEntry[] = [];
  const appendCustomEntryAsync = createCheckpointWriter(entries, "marker");
  Object.assign(fixture.sessionManager, {
    getBranch: () => entries,
    getSessionTarget: () => undefined,
    getSessionId: () => "history-session",
    appendCustomEntryAsync,
  });
  const agentState = { messages: messages ?? [] };
  Object.assign(fixture.activeSession, { agent: { state: agentState } });
  if (messages) {
    Object.assign(fixture.sessionManager, { getToolResultProjectionEntries: () => entries });
    Object.defineProperty(fixture.activeSession, "messages", { get: () => agentState.messages });
  }
  const persist = (runtime: Awaited<ReturnType<typeof prepareEmbeddedAttemptSessionRuntime>>) =>
    persistSessionSystemPrompt(runtime.sessionPromptState, appendCustomEntryAsync);
  const recordUpdate = (update: ReturnType<typeof buildSystemUpdateMessage>) => {
    entries.push({
      type: "custom_message",
      customType: update.customType,
      content: update.content,
      details: update.details,
      display: false,
      id: `update-${entries.length}`,
      parentId: null,
      timestamp: "2026-10-01T00:00:00Z",
    });
  };
  return { ...fixture, entries, appendCustomEntryAsync, agentState, persist, recordUpdate };
}

function createFixture() {
  const order: string[] = [];
  const activeMarker = { type: "custom", customType: "openclaw.cache-ttl", data: "active" };
  const f = {
    order,
    sessionManager: {
      getBranch: () => [activeMarker],
      getToolResultProjectionEntries: () => [activeMarker],
    },
    activeSession: {
      messages: [{ role: "user" }, { role: "assistant" }],
      sessionId: "active-session",
    },
    promptState: { toolResults: { projected: true } },
    abortActiveSession: vi.fn(async () => undefined),
    buildAbortSettlePromise: vi.fn(() => null),
    contextGuards: { remove: vi.fn() },
    trajectoryRecorder: { kind: "trajectory", recordEvent: vi.fn() },
    transcriptPolicy: { repairToolUseResultPairing: true, inHistorySystemUpdates: false },
    getUserTranscriptContexts: vi.fn(() => []),
    onSessionYieldReady: vi.fn(() => order.push("own-yield")),
    externalAbortController: {
      setActiveSessionAbort: vi.fn(() => order.push("arm-session-abort")),
    },
  };
  const agentSession = {
    activeSession: f.activeSession,
    clientToolDefs: [{ name: "read" }, { name: "write" }],
    setActiveSessionSystemPrompt: vi.fn(),
  };
  const promptStateLease = { state: f.promptState, [Symbol.dispose]: vi.fn() };
  const transport = {
    compactionReplayEnabled: true,
    effectivePromptCacheRetention: "long",
  };
  mocks.prepareSessionManager.mockImplementation(async (input) => {
    order.push("manager");
    input.onSessionManagerCreated(f.sessionManager);
    return {
      isOpenAIResponsesApi: true,
      preparedUserTurnMessage: { role: "user", content: "hello" },
      sessionManager: f.sessionManager,
      transcriptPolicy: f.transcriptPolicy,
      userMessageBoundary: {
        getUserTranscriptContexts: f.getUserTranscriptContexts,
        preparedUserTurnMessage: { role: "user", content: "hello" },
      },
    };
  });
  mocks.prepareAgentSession.mockImplementation(async (input) => {
    order.push("agent-session");
    input.onSessionCreated(f.activeSession);
    input.onSystemPromptChanged("runtime prompt");
    return agentSession;
  });
  const stage =
    <T>(name: string, value: T) =>
    () => {
      order.push(name);
      return value;
    };
  mocks.prepareSessionBoundary.mockImplementation(stage("boundary", {}));
  mocks.retainSessionPromptState.mockImplementation(stage("prompt-state", promptStateLease));
  mocks.createSessionSettleTracker.mockImplementation(
    stage("settle-tracker", {
      abortActiveSession: f.abortActiveSession,
      buildAbortSettlePromise: f.buildAbortSettlePromise,
    }),
  );
  mocks.installContextGuards.mockImplementation(stage("context-guards", f.contextGuards));
  mocks.createCacheTrace.mockImplementation(stage("cache-trace", {}));
  mocks.createAnthropicPayloadLogger.mockImplementation(stage("payload-logger", {}));
  mocks.createTrajectory.mockImplementation(async () =>
    stage("trajectory", f.trajectoryRecorder)(),
  );
  mocks.prepareTransport.mockImplementation(async () => stage("transport", transport)());

  const resources = new Proxy<PrepareInput["resources"]>(
    { trajectoryRecorder: null, buildAbortSettlePromise: () => null },
    {
      set: (target, key, value) => {
        order.push(`own-${String(key)}`);
        return Reflect.set(target, key, value);
      },
    },
  );
  const input = {
    attempt: {
      config: {},
      admittedRunContext,
      fastMode: true,
      workspaceDir: "/tmp/workspace",
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:session-1",
      model: { api: "openai-responses" },
      modelId: "gpt-5",
      provider: "openai",
      runId: "run-1",
      sessionId: "session-1",
    },
    agentDir: "/agent",
    isRawModelRun: false,
    resolveActiveContextEnginePluginId: vi.fn(),
    setup: {
      prepStages: { mark: vi.fn() },
      sessionAgentId: "main",
      effectiveWorkspace: "/tmp/workspace",
    },
    toolBase: { codeModeControlsEnabledForRun: false },
    toolCatalog: {
      effectiveTools: [],
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
    externalAbortController: f.externalAbortController,
    resources,
    onSessionYieldReady: f.onSessionYieldReady,
  } as unknown as PrepareInput;

  const prepare = () => prepareEmbeddedAttemptSessionRuntime(input);
  return { ...f, agentSession, input, resources, promptStateLease, prepare };
}

beforeEach(async () => {
  vi.clearAllMocks();
  trajectoryAdmission = prepareSystemAgentRunAdmission({}, "run-1", "main", "trajectory-test");
  admittedRunContext = await trajectoryAdmission.admit("embedded");
});
afterEach(async () => {
  trajectoryAdmission.close();
  await closeOpenClawAgentDatabasesAsync();
  vi.unstubAllEnvs();
  trajectoryRoots.cleanup();
});

describe("prepareEmbeddedAttemptSessionRuntime", () => {
  it("clears an unsent prompt without reading history when prompt updates remain enabled", async () => {
    const fixture = createHistoryFixture();
    const first = await prepareEmbeddedAttemptSessionRuntime(fixture.input);
    const prompt = await first.prepareSystemPromptUpdate!("## Policy\nUnsent update");
    prompt.commit();
    expect(first.sessionPromptState.pendingSystemPrompt?.renderedPrefix).toBe(
      "## Policy\nUnsent update",
    );

    const getBranch = vi.spyOn(fixture.sessionManager, "getBranch");
    try {
      const next = await prepareEmbeddedAttemptSessionRuntime(fixture.input);
      expect(getBranch).not.toHaveBeenCalled();
      expect(next.sessionPromptState.pendingSystemPrompt).toBeUndefined();
    } finally {
      getBranch.mockRestore();
    }
  });

  it("re-pins personal bootstrap when the selected profile changes between attempts", async () => {
    const fixture = createHistoryFixture();
    mocks.retainSessionPromptState.mockImplementation(() => ({
      state: { toolResults: { projected: true } },
      [Symbol.dispose]: () => {},
    }));
    for (const profile of ["alice", "bob", undefined]) {
      fixture.input.attempt.bootstrapUserProfileId = profile;
      const runtime = await fixture.prepare();
      const prompt = `## User\n${profile ?? "Shared"} guidance`;
      const prepared = await runtime.prepareSystemPromptUpdate!(prompt, true);
      expect(prepared).toMatchObject({ restart: true, systemPrompt: prompt });
      prepared.commit();
      await fixture.persist(runtime);
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
      const reader: SessionEntryCohortReader = {
        database: { agentId: target.agentId, path: target.storePath, env: target.env },
        sessionKey: target.sessionKey,
        logicalAgentId: target.agentId,
        storePaths: [target.storePath],
        assertCurrent: () => readerLifetime.signal.throwIfAborted(),
        readEntry: async () => {
          throw new Error("Constructor propagation does not execute a database cohort");
        },
        withRead: async () => {
          throw new Error("Constructor propagation does not execute a database cohort");
        },
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
      const preparing = fixture.prepare();
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
      const fixture = createHistoryFixture([]);
      const { entries, agentState, recordUpdate } = fixture;
      let interruptRetirement = false;
      const appendCustomEntryAsync = async (customType: string, data: unknown) => {
        if (interruptRetirement && interruption === "append-rejected") {
          throw new Error("retirement append rejected");
        }
        await fixture.appendCustomEntryAsync(customType, data);
        if (interruptRetirement && interruption === "committed-then-rejected") {
          throw new Error("retirement append committed before rejection");
        }
      };
      Object.assign(fixture.sessionManager, {
        appendCustomEntryAsync,
      });
      const routeR = fixture.input.attempt.modelId;
      const firstRuntime = await fixture.prepare();
      const initial = await firstRuntime.prepareSystemPromptUpdate!("## Policy\nA");
      initial.commit();
      await persistSessionSystemPrompt(firstRuntime.sessionPromptState, appendCustomEntryAsync);
      const changed = await firstRuntime.prepareSystemPromptUpdate!("## Policy\nB", true);
      changed.commit();
      recordUpdate(changed.update!);
      agentState.messages.push(changed.update!);
      await persistSessionSystemPrompt(firstRuntime.sessionPromptState, appendCustomEntryAsync);
      expect(changed.systemPrompt).toBe("## Policy\nA");

      fixture.input.attempt.modelId = "route-S";
      const secondRuntime = await fixture.prepare();
      interruptRetirement = true;
      const preparedS = secondRuntime.prepareSystemPromptUpdate!("## Policy\nS");
      if (interruption === "unadmitted") {
        await preparedS;
      } else {
        await expect(preparedS).rejects.toThrow("retirement append");
      }
      interruptRetirement = false;
      fixture.input.attempt.modelId = routeR;
      const resumedRuntime = await fixture.prepare();
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
    const runtimeContext = buildRuntimeContextCustomMessage(
      "Retained turn facts",
      undefined,
      true,
    )!;
    const fixture = createHistoryFixture([
      runtimeContext,
      buildSystemUpdateMessage("Retired override", "prompt-update", false),
    ]);
    const { entries, agentState, recordUpdate, persist } = fixture;
    const permissionNotice = "## Permission change\nWrite access was removed.";
    const prompt = `## Tools\nread\n<!-- openclaw:attempt:PERMISSION -->\n${permissionNotice}\n<!-- /openclaw:attempt:PERMISSION -->`;
    const runtime = await fixture.prepare();
    const prepare = runtime.prepareSystemPromptUpdate!;
    const first = await prepare(prompt);
    expect(first.update?.content).toBe(permissionNotice);
    expect(agentState.messages).toEqual([runtimeContext]);

    // Failed replay admission never calls the returned projection's commit.
    const retry = await prepare(prompt);
    expect(retry.update?.content).toBe(permissionNotice);
    retry.commit();
    recordUpdate(retry.update!);
    await persist(runtime);
    expect(buildSessionContext(entries).messages).toContainEqual(
      expect.objectContaining({ role: "custom", content: permissionNotice }),
    );
    expect((await prepare(prompt)).update).toBeUndefined();

    const pinned = retry.systemPrompt;
    const restricted = await prepare("## Tools\nNo tools are available.");
    restricted.commit();
    await persist(runtime);
    expect((await prepare(pinned)).update).toBeUndefined();
    const restored = await prepare(pinned, true);
    expect(restored.systemPrompt).toBe(pinned);
    expect(restored.update?.content).toContain("## Tools\nread");
  });

  it("prepares the session runtime in ownership-safe order and keeps prompt state live", async () => {
    const fixture = createFixture();

    const result = await fixture.prepare();

    expect(mocks.restoreProjections).toHaveBeenCalledWith(
      fixture.promptState.toolResults,
      fixture.sessionManager.getBranch(),
    );
    expect(fixture.order.join(" ")).toBe(
      "manager own-sessionManager prompt-state own-promptStateLease own-getUserTranscriptContexts " +
        "agent-session own-session owned-boundary boundary settle-tracker arm-session-abort " +
        "own-buildAbortSettlePromise own-yield context-guards own-removeToolResultContextGuard cache-trace " +
        "payload-logger trajectory own-trajectoryRecorder transport",
    );
    expect(result.sessionPromptState).toBe(fixture.promptState);
    expect(result.toolResultPromptProjectionState).toBe(fixture.promptState.toolResults);
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

    await expect(fixture.prepare()).rejects.toThrow("transport failed");

    expect(fixture.resources.sessionManager).toBe(fixture.sessionManager);
    expect(fixture.resources.promptStateLease).toBe(fixture.promptStateLease);
    expect(fixture.resources.session).toBe(fixture.activeSession);
    expect(fixture.resources.removeToolResultContextGuard).toBe(fixture.contextGuards.remove);
    expect(fixture.resources.buildAbortSettlePromise).toBe(fixture.buildAbortSettlePromise);
    expect(fixture.resources.trajectoryRecorder).toBe(fixture.trajectoryRecorder);
  });

  it("settles pending user-turn persistence before reconciling the session boundary", async () => {
    const fixture = createFixture();
    const { promise: pendingPersistence, resolve: releasePersistence } = createDeferredCore();
    const waitForRuntimePersistence = vi.fn(async () => await pendingPersistence);
    fixture.input.attempt.userTurnTranscriptRecorder = {
      waitForRuntimePersistence,
    } as unknown as PrepareInput["attempt"]["userTurnTranscriptRecorder"];

    const preparing = fixture.prepare();
    await vi.waitFor(() => expect(waitForRuntimePersistence).toHaveBeenCalledOnce());
    expect(mocks.prepareSessionBoundary).not.toHaveBeenCalled();

    releasePersistence?.();
    await preparing;

    expect(mocks.prepareSessionBoundary).toHaveBeenCalledOnce();
  });
});

describe("trajectory preparation through the public runtime", () => {
  const sessionTarget = {
    agentId: "main",
    sessionId: "active-session",
    sessionKey: "agent:main:session-1",
    storePath: "/tmp/openclaw-agent.sqlite",
  };

  it.each([false, true])("records metadata with retained target: %s", async (retained) => {
    const f = createFixture();
    f.input.attempt.provider = "provider-1";
    f.input.toolCatalog.effectiveTools = Array.from({ length: 7 }, (_, index) => ({
      name: "trajectory-tool-" + index,
      label: "Trajectory fixture",
      description: "Supplies a nonzero tool count to public preparation.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    }));
    f.input.attempt.sessionTarget = sessionTarget;
    if (retained) {
      Object.assign(f.input.sessionLock.ownedTranscriptWriteContext, {
        sessionTarget,
        assertCommitAllowed: resolveAdmittedRunActiveAssertion(admittedRunContext),
      });
    }
    const result = await f.prepare();
    expect(result.trajectoryRecorder).toBe(f.trajectoryRecorder);
    if (retained) {
      expect(mocks.trajectoryPath).not.toHaveBeenCalled();
    } else {
      expect(mocks.trajectoryPath.mock.calls[0]?.[0]).toMatchObject({
        agentId: "main",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "active-session",
      });
    }
    expect(mocks.createTrajectory.mock.calls[0]?.[0]).toMatchObject({
      runId: "run-1",
      sessionId: "active-session",
      sessionTarget,
      sessionFile: retained ? f.input.attempt.sessionKey : "/tmp/trajectory.jsonl",
    });
    expect(f.trajectoryRecorder.recordEvent.mock.calls.slice(0, 2)).toEqual([
      ["session.started", expect.objectContaining({ toolCount: 7, clientToolCount: 2 })],
      ["trace.metadata", { trace: "metadata" }],
    ]);
    expect(mocks.trajectoryMetadata.mock.calls[0]?.[0]).toMatchObject({
      fastMode: true,
      provider: "provider-1",
    });
  });

  it.each(["revoke", "abort"])(
    "rejects metadata after %s during sink preparation",
    async (change) => {
      const f = createFixture();
      f.input.attempt.sessionTarget = sessionTarget;
      Object.assign(f.input.sessionLock.ownedTranscriptWriteContext, {
        sessionTarget,
        assertCommitAllowed: resolveAdmittedRunActiveAssertion(admittedRunContext),
      });
      const abort = new AbortController();
      f.input.attempt.abortSignal = abort.signal;
      mocks.createTrajectory.mockImplementationOnce(async () => {
        if (change === "revoke") {
          closeAdmittedRunDelegatedAuthority(admittedRunContext);
        } else {
          abort.abort();
        }
        return f.trajectoryRecorder;
      });
      await expect(f.prepare()).rejects.toThrow("admitted run authority is no longer active");
      expect(f.trajectoryRecorder.recordEvent).not.toHaveBeenCalled();
    },
  );

  it("resolves the transcript path but skips the recorder when disabled", async () => {
    const f = createFixture();
    f.input.attempt.disableTrajectory = true;
    const result = await f.prepare();
    expect(result.trajectoryRecorder).toBeNull();
    expect([
      mocks.trajectoryPath.mock.calls.length,
      mocks.createTrajectory.mock.calls.length,
      mocks.trajectoryMetadata.mock.calls.length,
    ]).toEqual([1, 0, 0]);
  });

  it("keeps detached trajectory resolution native and leaves agent storage absent", async () => {
    const root = trajectoryRoots.make("openclaw-trajectory-detached-");
    const stateDir = path.join(root, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const native = await vi.importActual<typeof import("./attempt-transcript-helpers.js")>(
      "./attempt-transcript-helpers.js",
    );
    mocks.trajectoryPath.mockImplementationOnce(native.resolveAttemptTrajectorySessionFile);
    const f = createFixture();
    f.input.attempt.sessionPersistence = "detached";
    f.input.attempt.workspaceDir = root;
    f.input.attempt.sessionFile = path.join(root, "detached.jsonl");
    const result = await f.prepare();
    expect(result.trajectoryRecorder).toBeNull();
    expect(mocks.trajectoryPath).toHaveBeenCalledOnce();
    expect(mocks.createTrajectory).not.toHaveBeenCalled();
    expect(mocks.trajectoryMetadata).not.toHaveBeenCalled();
    await expect(fs.access(path.join(stateDir, "agents"))).rejects.toThrow();
  });
});
