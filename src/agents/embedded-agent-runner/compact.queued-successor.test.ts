import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import {
  acquireAgentRunPreparedModelRuntimeMock,
  contextEngineCompactMock,
  hookRunner,
  loadCompactHooksHarness,
  maybeCompactAgentHarnessSessionMock,
  resetCompactHooksHarnessMocks,
  resolveContextEngineMock,
} from "./compact.hooks.harness.js";
import type { QueuedCompactionHostOptions } from "./compact.queued-execution.js";
import type { AcceptedCompactionSuccessor } from "./compaction-successor.js";

const { compactEmbeddedAgentSession: compact } = await loadCompactHooksHarness();
// The harness resets modules. Load every real owner afterward so the manager
// and queued compaction share the same private write context and database lifetime.
const [
  { incrementCompactionCount },
  {
    loadSessionEntry,
    loadTranscriptEventsSync,
    patchSessionEntryCore,
    replaceSessionEntrySync,
    upsertSessionEntryCore,
  },
  { closeOpenClawAgentDatabasesAsync, closeOpenClawAgentDatabasesForTest },
  { SessionManager: PersistentSessionManager },
  safetyTimeout,
  realSafetyTimeout,
  { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot },
  { readSessionTranscriptWatermarkAsync },
] = await Promise.all([
  import("../../auto-reply/reply/session-updates.js"),
  import("../../config/sessions/session-accessor.js"),
  import("../../state/openclaw-agent-db.js"),
  import("../sessions/session-manager.js"),
  import("./compaction-safety-timeout.js"),
  vi.importActual<typeof import("./compaction-safety-timeout.js")>(
    "./compaction-safety-timeout.js",
  ),
  import("../../config/runtime-snapshot.js"),
  import("../../config/sessions/session-transcript-watermark.js"),
]);

let restoreTranscriptBridge: (() => void) | undefined;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    restoreTranscriptBridge?.();
    restoreTranscriptBridge = undefined;
    // Native work can outlive cached handles; join it before removing the fixture root.
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    cleanup();
    clearRuntimeConfigSnapshot();
  }),
);
let workspaceDir: string;
const sessionId = "predecessor";
const sessionKey = "agent:main:queued-successor";
const owner = { sessionId, lifecycleRevision: "lifecycle", activeWriterRunId: "writer" };
const successor = { ...owner, sessionId: "successor", previousSessionId: sessionId };
const hostCommit = { entry: successor, tokensAfter: 40, compactionKind: "context-engine" };
const unchangedMaintenance = () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 });
const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () => unchangedMaintenance());
const target = () => ({
  agentId: "main",
  sessionId,
  sessionKey,
  storePath: join(workspaceDir, "sessions.sqlite"),
});
const latestEntry = () => loadSessionEntry({ ...target(), readConsistency: "latest" });
const entryForWriter = (activeWriterRunId?: string) => ({
  ...owner,
  updatedAt: 1,
  activeWriterRunId,
});
const engine = (ownsCompaction = true) => ({
  info: { id: "test-engine", name: "Test engine", ownsCompaction },
  compact: contextEngineCompactMock,
  maintain,
});
const success = { ok: true, compacted: true };

function expectUnchanged(transcript: unknown[], entry: unknown) {
  expect(loadTranscriptEventsSync(target())).toEqual(transcript);
  expect(latestEntry()).toEqual(entry);
}

function expectPostCompactionCalls(count = 0) {
  for (const effect of [
    maintain,
    hookRunner.runAfterCompaction,
    maybeCompactAgentHarnessSessionMock,
  ]) {
    expect(effect).toHaveBeenCalledTimes(count);
  }
}

async function waitForCheckpoint(checkpoint: Promise<unknown>, pending: Promise<unknown>) {
  await Promise.race([
    checkpoint,
    pending.then(() => {
      throw new Error("Queued compaction settled before the checkpoint");
    }),
  ]);
}
const compactParams = (abortSignal?: AbortSignal) => ({
  ...target(),
  sessionTarget: target(),
  sessionFile: sessionKey,
  sessionEntry: { ...owner, updatedAt: 1 },
  workspaceDir,
  provider: "codex",
  model: "test-model",
  agentHarnessId: "codex",
  abortSignal,
  enqueue: async <T>(task: () => Promise<T> | T) => await task(),
});
const completed = (resultSessionId = "successor") => ({
  ok: true,
  compacted: true,
  result: { sessionId: resultSessionId, summary: "summary", tokensBefore: 120, tokensAfter: 40 },
});

const backendCompactParams = (abortSignal?: AbortSignal) => ({
  ...compactParams(abortSignal),
  provider: "openai",
  agentHarnessId: "openclaw",
});

function createBackendAppend(firstKeptEntryId: string) {
  // Open exactly the portable target the backend receives; the test supplies no fence.
  const manager = PersistentSessionManager.open(target(), workspaceDir);
  return () => {
    try {
      manager.appendCompaction("backend summary", firstKeptEntryId, 120);
      return { written: true as const };
    } catch (error) {
      return { written: false as const, error };
    }
  };
}

type BackendAppendOutcome = ReturnType<ReturnType<typeof createBackendAppend>>;
type TranscriptRewrite = NonNullable<ContextEngineRuntimeContext["rewriteTranscriptEntries"]>;

async function transcriptFixture() {
  const { SessionManager } = await import("../sessions/index.js");
  const openAsync = vi.spyOn(SessionManager, "openAsync");
  const originalOpenAsync = expectDefined(
    openAsync.getMockImplementation(),
    "session-manager bridge",
  );
  const hooks: { beforeBranchRead?: () => void } = {};
  openAsync.mockImplementation(async (...args) => {
    const manager = await PersistentSessionManager.openAsync(...args);
    const getBranch = manager.getBranch.bind(manager);
    vi.spyOn(manager, "getBranch").mockImplementation((...branchArgs) => {
      hooks.beforeBranchRead?.();
      return getBranch(...branchArgs);
    });
    return manager;
  });
  restoreTranscriptBridge = () => openAsync.mockImplementation(originalOpenAsync);
  const manager = PersistentSessionManager.open(target(), workspaceDir);
  const entryId = manager.appendMessage({
    role: "user",
    content: "original history ".repeat(20),
    timestamp: 1,
  });
  const request: Parameters<TranscriptRewrite>[0] = {
    replacements: [{ entryId, message: { role: "user", content: "rewritten", timestamp: 2 } }],
  };
  return { entryId, request, transcriptBefore: loadTranscriptEventsSync(target()), hooks };
}

function observeHydration() {
  const calls = [
    vi.spyOn(PersistentSessionManager, "openAsync"),
    vi.spyOn(PersistentSessionManager.prototype, "reloadPersistedTranscriptAsync"),
  ];
  onTestFinished(() => calls.forEach((spy) => spy.mockRestore()));
  return (opens: number) => expect(calls.map((spy) => spy.mock.calls.length)).toEqual([opens, 0]);
}

beforeEach(async () => {
  workspaceDir = await realpath(tempDirs.make("openclaw-queued-successor-"));
  resetCompactHooksHarnessMocks(workspaceDir);
  setRuntimeConfigSnapshot({});
  maintain.mockReset();
  hookRunner.hasHooks.mockReturnValue(true);
  resolveContextEngineMock.mockResolvedValue(engine() as never);
  contextEngineCompactMock.mockResolvedValue(completed());
  await upsertSessionEntryCore(target(), { ...owner, updatedAt: 1 });
});

it.each(["compact", "maintain"] as const)(
  "does not dispatch plugin %s after its writer is replaced",
  async (effect) => {
    const pluginStore = ["retained history"];
    const replaceWriter = async () => {
      await patchSessionEntryCore(target(), () => ({ activeWriterRunId: "replacement-writer" }));
      return undefined;
    };
    contextEngineCompactMock.mockImplementationOnce(async () => {
      if (effect === "compact") {
        pluginStore.length = 0;
      }
      return completed(sessionId);
    });
    if (effect === "compact") {
      hookRunner.runBeforeCompaction.mockImplementationOnce(replaceWriter);
    } else {
      maintain.mockImplementationOnce(async () => {
        pluginStore.length = 0;
        return { changed: true, bytesFreed: 1, rewrittenEntries: 1 };
      });
    }

    await compact(
      backendCompactParams(),
      effect === "maintain" ? { onHostCompactionCommitted: replaceWriter } : {},
    ).catch(() => undefined);

    expect(pluginStore).toEqual(["retained history"]);
    expect(loadSessionEntry(target())?.activeWriterRunId).toBe("replacement-writer");
    expect(maintain).not.toHaveBeenCalled();
    if (effect === "compact") {
      expect(contextEngineCompactMock).not.toHaveBeenCalled();
    }
  },
);

it.each([false, true])(
  "reanchors CLI history across compaction bookkeeping without trusting a foreign prefix (%s)",
  async (foreignPrefix) => {
    const manager = await PersistentSessionManager.openAsync(target(), workspaceDir);
    await manager.appendMessageAsync({ role: "user", content: "older turn", timestamp: 1 });
    const retained = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "recent turn", timestamp: 2 }),
      "retained turn",
    );
    const before = await readSessionTranscriptWatermarkAsync(target());
    const boundary = {
      version: 1 as const,
      state: "known" as const,
      sessionId,
      writerRunId: "prior-cli-run",
      authFingerprint: "a".repeat(64),
      ...before,
    };
    await patchSessionEntryCore(target(), () => ({ cliHistoryBoundary: boundary }));
    if (foreignPrefix) {
      await manager.appendMessageAsync({ role: "user", content: "foreign turn", timestamp: 3 });
    }
    contextEngineCompactMock.mockImplementationOnce(async () => {
      const compactor = await PersistentSessionManager.openAsync(target(), workspaceDir);
      await compactor.appendThinkingLevelChange("off");
      await compactor.appendCustomEntryAsync("model-snapshot", { provider: "summary-fixture" });
      await compactor.appendCompactionAsync("account summary", retained, 120);
      return completed(sessionId);
    });
    await expect(compact(backendCompactParams())).resolves.toMatchObject(success);
    const after = await readSessionTranscriptWatermarkAsync(target());
    expect(latestEntry()?.cliHistoryBoundary).toEqual({
      ...boundary,
      ...(foreignPrefix ? before : after),
    });
  },
);

it("hydrates post-compaction history only once for a requested rewrite", async () => {
  const { request } = await transcriptFixture();
  const expectHydration = observeHydration();
  contextEngineCompactMock.mockResolvedValueOnce(completed(sessionId));
  maintain.mockImplementationOnce(
    async ({ runtimeContext }) => await runtimeContext!.rewriteTranscriptEntries!(request),
  );
  await expect(compact(compactParams())).resolves.toMatchObject(success);
  expect(maintain).toHaveBeenCalledOnce();
  expectHydration(1);
  expect(loadTranscriptEventsSync(target())).toContainEqual(
    expect.objectContaining({
      type: "message",
      message: { role: "user", content: "rewritten", timestamp: 2 },
    }),
  );
});

it.each([
  { nativePinned: false, observedHarness: "openclaw" },
  { nativePinned: true, observedHarness: "codex" },
])(
  "keeps manual compaction with its transcript owner after authored runtime fallback (nativePinned=$nativePinned, observed=$observedHarness)",
  async ({ nativePinned, observedHarness }) => {
    const [
      { resolveManualCompactionCliTarget },
      registry,
      selection,
      actualSelection,
      { requireActivePluginRegistry },
    ] = await Promise.all([
      import("../session-runtime-compat.js"),
      import("../harness/registry.js"),
      import("../harness/selection.js"),
      vi.importActual<typeof import("../harness/selection.js")>("../harness/selection.js"),
      import("../../plugins/runtime.js"),
    ]);
    const select = vi.mocked(selection.selectAgentHarness);
    const selectPrepared = vi.mocked(selection.selectAgentHarnessForPreparedModelProviders);
    const previousSelect = select.getMockImplementation()!;
    const previousSelectPrepared = selectPrepared.getMockImplementation()!;
    select.mockImplementation(actualSelection.selectAgentHarness);
    selectPrepared.mockImplementation(actualSelection.selectAgentHarnessForPreparedModelProviders);
    registry.registerAgentHarness({
      id: "codex",
      label: "Native compaction owner",
      authBootstrap: "harness",
      supports: (context) =>
        context.modelProvider?.requestTransportOverrides === "present"
          ? {
              supported: false,
              reason: "authored request requires host transport",
              fallbackRuntime: "openclaw",
            }
          : { supported: true },
      runAttempt: vi.fn(),
    });
    const pluginRegistry = requireActivePluginRegistry();
    const previousAcquire = acquireAgentRunPreparedModelRuntimeMock.getMockImplementation()!;
    // Prepared generations own registry lookup; an omitted registry deliberately means empty.
    acquireAgentRunPreparedModelRuntimeMock.mockImplementation(async (input) => {
      const lease = await previousAcquire(input);
      return { ...lease, snapshot: { ...lease.snapshot, pluginRegistry } };
    });
    const provider = {
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      models: [],
      ...(!nativePinned ? { headers: { "X-Compaction-Fixture": "preserve" } } : {}),
    };
    const config: OpenClawConfig = { models: { providers: { openai: provider } } };
    if (!nativePinned) {
      config.agents = {
        defaults: { models: { "openai/gpt-5.6-luna": { params: { temperature: 0.2 } } } },
      };
    }
    setRuntimeConfigSnapshot(config, config);
    const entry: SessionEntry = {
      ...owner,
      updatedAt: 1,
      modelSelectionLocked: true,
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      agentRuntimeOverride: nativePinned ? "openclaw" : "codex",
      agentHarnessId: observedHarness,
      ...(!nativePinned ? { pluginOwnerId: "model-owner" } : {}),
    };
    try {
      replaceSessionEntrySync(target(), entry);
      contextEngineCompactMock.mockResolvedValueOnce(completed(sessionId));
      const manualTarget = resolveManualCompactionCliTarget({
        provider: "openai",
        entry,
        cfg: config,
      });
      const result = await compact({
        ...compactParams(),
        ...manualTarget,
        provider: "openai",
        model: "gpt-5.6-luna",
        authProfileId: "openai:test",
        authProfileIdSource: "user",
        // A stale caller cannot add or remove the durable native owner.
        sessionEntry: { ...entry, pluginOwnerId: nativePinned ? "stale-owner" : undefined },
        agentHarnessId: nativePinned ? "openclaw" : manualTarget.agentHarnessId,
        modelSelectionLocked: true,
        config,
        trigger: "manual",
      });

      expect(result).toMatchObject(
        nativePinned
          ? { ok: false, compacted: false, failure: { reason: "model_selection_locked" } }
          : success,
      );
      expect(contextEngineCompactMock).toHaveBeenCalledTimes(nativePinned ? 0 : 1);
      expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(nativePinned ? 1 : 0);
      if (!nativePinned) {
        expect(contextEngineCompactMock.mock.calls[0]?.[0].runtimeContext).toMatchObject({
          config,
          provider: "openai",
          model: "gpt-5.6-luna",
          agentHarnessId: "openclaw",
          modelSelectionLocked: true,
        });
      }
      expect(loadSessionEntry(target())).toMatchObject({
        sessionId,
        modelSelectionLocked: true,
        agentRuntimeOverride: entry.agentRuntimeOverride,
        agentHarnessId: entry.agentHarnessId,
        ...(!nativePinned ? { pluginOwnerId: "model-owner" } : {}),
      });
    } finally {
      acquireAgentRunPreparedModelRuntimeMock.mockImplementation(previousAcquire);
      registry.clearAgentHarnesses();
      select.mockImplementation(previousSelect);
      selectPrepared.mockImplementation(previousSelectPrepared);
    }
  },
);

it.each([false, true])(
  "commits the successor before observers, with caller abort=%s",
  async (abortAfterCommit) => {
    const controller = new AbortController();
    const hostCommitHeld = createDeferred();
    const releaseHostCommit = createDeferred();
    let observerReturned = false;
    const onCommitted = vi.fn((accepted: AcceptedCompactionSuccessor) => {
      expect(loadSessionEntry(target())).toMatchObject(successor);
      expect(accepted.entry).toMatchObject(successor);
      if (abortAfterCommit) {
        controller.abort(new Error("caller closed after commit"));
      }
      observerReturned = true;
    });
    const onHostCompactionCommitted = vi.fn<
      NonNullable<QueuedCompactionHostOptions["onHostCompactionCommitted"]>
    >(async (commit) => {
      expect(observerReturned).toBe(true);
      expect(commit).toMatchObject(hostCommit);
      hostCommitHeld.resolve();
      await releaseHostCommit.promise;
    });
    const onHostCompactionTranscriptSettled = vi.fn<
      NonNullable<QueuedCompactionHostOptions["onHostCompactionTranscriptSettled"]>
    >(async (commit) => {
      expect(commit).toMatchObject(hostCommit);
      expect(maintain).toHaveBeenCalledOnce();
      expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
      expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
    });
    const pending = compact(compactParams(controller.signal), {
      onCommitted,
      onHostCompactionCommitted,
      onHostCompactionTranscriptSettled,
    });
    try {
      await waitForCheckpoint(hostCommitHeld.promise, pending);
      expect(onHostCompactionCommitted).toHaveBeenCalledOnce();
      expect(onHostCompactionTranscriptSettled).not.toHaveBeenCalled();
      expectPostCompactionCalls();
      releaseHostCommit.resolve();

      const result = await pending;
      expect(result).toMatchObject({
        ...success,
        result: { sessionId: "successor", tokensAfter: 40 },
      });
      expect(onCommitted).toHaveBeenCalledOnce();
      expect(onHostCompactionCommitted).toHaveBeenCalledOnce();
      expect(onHostCompactionTranscriptSettled).toHaveBeenCalledTimes(abortAfterCommit ? 0 : 1);
      expect(loadSessionEntry(target())).toMatchObject(successor);
      expectPostCompactionCalls(abortAfterCommit ? 0 : 1);
      if (!abortAfterCommit) {
        expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
          expect.objectContaining({ previousSessionId: sessionId }),
          expect.objectContaining({ sessionId: "successor" }),
        );
      }
      const engineInput = contextEngineCompactMock.mock.calls[0]?.[0];
      expect(engineInput).toBeDefined();
      expect(engineInput?.runtimeContext).not.toHaveProperty("onCommitted");
      expect(engineInput?.runtimeContext?.sessionEntry).not.toHaveProperty("activeWriterRunId");
    } finally {
      releaseHostCommit.resolve();
      await pending.catch(() => undefined);
    }
  },
);

it.each([
  { name: "same-ID compaction", successorId: sessionId, tokensAfter: 40 },
  { name: "declared but unaccepted successor", successorId: "successor", tokensAfter: undefined },
])("preserves completed $name when the first post-backend gate closes", async (scenario) => {
  const controller = new AbortController();
  let backendCompleted = false;
  contextEngineCompactMock.mockImplementationOnce(async () => {
    backendCompleted = true;
    return completed(scenario.successorId);
  });
  const onCommitted = vi.fn();
  const pending = compact(compactParams(controller.signal), {
    onCommitted,
    assertActive: () => {
      if (backendCompleted) {
        controller.abort(new Error("caller closed after backend completion"));
      }
      controller.signal.throwIfAborted();
    },
  });

  const result = await pending;
  expect(result).toMatchObject(success);
  expect(controller.signal.aborted).toBe(true);
  expect(result.result?.sessionId).toBeUndefined();
  expect(result.result?.sessionFile).toBeUndefined();
  expect(result.result?.tokensAfter).toBe(scenario.tokensAfter);
  expect(onCommitted).not.toHaveBeenCalled();
  expect(loadSessionEntry(target())).toMatchObject(owner);
  expectPostCompactionCalls();

  // The ordinary caller counter can retain completion, but cannot attach an
  // unaccepted successor's context snapshot to the predecessor's identity.
  const count =
    result.ok && result.compacted
      ? await incrementCompactionCount({
          agentId: "main",
          sessionKey,
          storePath: target().storePath,
          sessionStore: { [sessionKey]: { ...owner, updatedAt: 1 } },
          expectedSession: owner,
          tokensAfter: result.result?.tokensAfter,
        })
      : undefined;
  expect(count).toBe(1);
  expect(loadSessionEntry(target())).toMatchObject({ ...owner, compactionCount: 1 });
  expect(loadSessionEntry(target())?.totalTokens).toBe(scenario.tokensAfter);
});

it("rejects an owner changed while compaction awaited", async () => {
  const replacement = { lifecycleRevision: "replacement-lifecycle" };
  contextEngineCompactMock.mockImplementationOnce(async () => {
    await patchSessionEntryCore(target(), () => replacement);
    return completed();
  });
  const onCommitted = vi.fn();

  await expect(compact(compactParams(), { onCommitted })).rejects.toThrow();

  expect(loadSessionEntry(target())).toMatchObject({ ...owner, ...replacement });
  expect(onCommitted).not.toHaveBeenCalled();
  expectPostCompactionCalls();
});

it.each([
  { capturedWriter: "writer", takeover: false },
  { capturedWriter: undefined, takeover: true },
])(
  "binds backend append to the captured writer (captured=$capturedWriter, takeover=$takeover)",
  async ({ capturedWriter, takeover }) => {
    const capturedEntry = entryForWriter(capturedWriter);
    replaceSessionEntrySync(target(), capturedEntry);
    const { entryId, transcriptBefore } = await transcriptFixture();
    const entered = createDeferred();
    const release = createDeferred();
    const observed = createDeferred<BackendAppendOutcome>();
    contextEngineCompactMock.mockImplementationOnce(async () => {
      const append = createBackendAppend(entryId);
      entered.resolve();
      await release.promise;
      const outcome = append();
      observed.resolve(outcome);
      if (!outcome.written) {
        throw outcome.error;
      }
      return completed(sessionId);
    });
    const pending = compact({ ...backendCompactParams(), sessionEntry: capturedEntry }).catch(
      (error: unknown) => error,
    );
    try {
      await waitForCheckpoint(entered.promise, pending);
      if (takeover) {
        replaceSessionEntrySync(target(), {
          ...capturedEntry,
          updatedAt: 2,
          activeWriterRunId: "replacement-writer",
        });
      } else {
        await patchSessionEntryCore(target(), () => ({ label: "renamed while compacting" }));
      }
      const entryBeforeAppend = structuredClone(latestEntry());
      expect(entryBeforeAppend).toBeDefined();
      release.resolve();
      const result = await pending;
      const outcome = await observed.promise;
      const transcriptAfter = loadTranscriptEventsSync(target());
      const after = latestEntry();

      if (takeover) {
        expectUnchanged(transcriptBefore, entryBeforeAppend);
        expect(outcome).toMatchObject({ written: false, error: expect.any(Error) });
        expect(result).toMatchObject({ ok: false, compacted: false });
      } else {
        expect(transcriptAfter.slice(0, transcriptBefore.length)).toEqual(transcriptBefore);
        expect(transcriptAfter).toHaveLength(transcriptBefore.length + 1);
        expect(transcriptAfter.at(-1)).toMatchObject({
          type: "compaction",
          summary: "backend summary",
          firstKeptEntryId: entryId,
          tokensBefore: 120,
        });
        expect(after).toMatchObject({
          ...owner,
          activeWriterRunId: capturedWriter,
          label: "renamed while compacting",
        });
        expect(outcome).toEqual({ written: true });
        expect(result).toMatchObject(success);
      }
      expect(contextEngineCompactMock).toHaveBeenCalledOnce();
      expect(maintain).toHaveBeenCalledTimes(takeover ? 0 : 1);
    } finally {
      release.resolve();
      await pending;
    }
  },
);

it("rejects an inherited backend continuation after the queued owner closes", async () => {
  const { entryId, transcriptBefore } = await transcriptFixture();
  const release = createDeferred();
  let continuation: Promise<BackendAppendOutcome> | undefined;
  contextEngineCompactMock.mockImplementationOnce(async () => {
    const append = createBackendAppend(entryId);
    // Create the continuation inside the backend so it inherits the actual
    // queued context, rather than injecting a private fence from this test.
    continuation = (async () => {
      await release.promise;
      return append();
    })();
    return { ok: true, compacted: false };
  });
  const pending = compact(backendCompactParams());
  try {
    await expect(pending).resolves.toMatchObject({ ok: true, compacted: false });
    const retained = expectDefined(continuation, "backend continuation");
    const closedEntry = structuredClone(latestEntry());
    expect(closedEntry).toBeDefined();
    release.resolve();
    const outcome = await retained;

    expectUnchanged(transcriptBefore, closedEntry);
    expect(outcome).toMatchObject({ written: false, error: expect.any(Error) });
    expect(contextEngineCompactMock).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await pending.catch(() => undefined);
    await continuation;
  }
});

it("fences a synchronous timeout-listener append while the caller remains active", async () => {
  const { entryId, transcriptBefore } = await transcriptFixture();
  const boundedCompact = vi.mocked(safetyTimeout.compactContextEngineWithSafetyTimeout);
  const previousImplementation = expectDefined(
    boundedCompact.getMockImplementation(),
    "safety-timeout mock",
  );
  const caller = new AbortController();
  const backendEntered = createDeferred();
  const releaseBackend = createDeferred();
  const observed = createDeferred<{
    outcome: BackendAppendOutcome;
    callerAborted: boolean;
    queuedSettled: boolean;
  }>();
  let backendSignal: AbortSignal | undefined;
  let backendWork: ReturnType<ContextEngine["compact"]> | undefined;
  let queuedSettled = false;
  resolveContextEngineMock.mockResolvedValueOnce(engine(false));
  contextEngineCompactMock.mockImplementationOnce((backendParams) => {
    const signal = expectDefined(backendParams.abortSignal, "composed backend signal");
    backendSignal = signal;
    const append = createBackendAppend(entryId);
    // Timer dispatch owns a different async context. Retain the backend's
    // actual context without constructing any OpenClaw authority in the fixture.
    const onAbort = AsyncLocalStorage.bind(() => {
      observed.resolve({ callerAborted: caller.signal.aborted, queuedSettled, outcome: append() });
    });
    signal.addEventListener("abort", onAbort, { once: true });
    backendWork = (async () => {
      try {
        await releaseBackend.promise;
        return { ok: true, compacted: false };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    })();
    backendEntered.resolve();
    return backendWork;
  });
  const entryBefore = structuredClone(latestEntry());
  expect(entryBefore).toBeDefined();
  // Override the existing mocked function, not the shared harness or module
  // epoch. The real helper owns composition, timer abortion, and the race.
  boundedCompact.mockImplementation((ownedCompactor, params, _timeoutMs, signal) =>
    realSafetyTimeout.compactContextEngineWithSafetyTimeout(ownedCompactor, params, 1, signal),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = compact(backendCompactParams(caller.signal)).finally(() => {
    queuedSettled = true;
  });
  try {
    await waitForCheckpoint(backendEntered.promise, pending);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ ok: false, compacted: false });
    expect(backendSignal).not.toBe(caller.signal);
    expect(backendSignal?.aborted).toBe(true);
    const observation = await observed.promise;

    expect(observation).toMatchObject({
      callerAborted: false,
      queuedSettled: false,
      outcome: { written: false, error: expect.any(Error) },
    });
    expect(caller.signal.aborted).toBe(false);
    expectUnchanged(transcriptBefore, entryBefore);
    expect(contextEngineCompactMock).toHaveBeenCalledOnce();
    expect(maintain).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    boundedCompact.mockImplementation(previousImplementation);
    releaseBackend.resolve();
    await pending.catch(() => undefined);
    await backendWork;
  }
});

it("does not resolve or adopt successor fields from a failed compaction", async () => {
  contextEngineCompactMock.mockResolvedValueOnce({
    ok: false,
    compacted: true,
    reason: "provider failed",
    result: {
      tokensBefore: 120,
      sessionTarget: { sessionId: "untrusted", sessionKey: "agent:other:other" },
    },
  });

  await expect(compact(compactParams())).resolves.toMatchObject({
    ok: false,
    reason: "provider failed",
  });

  expect(loadSessionEntry(target())).toMatchObject(owner);
  expect(maintain).not.toHaveBeenCalled();
  expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
});

it("rejects retained queued maintenance rewrites after normal closure", async () => {
  const { request, transcriptBefore } = await transcriptFixture();
  const expectHydration = observeHydration();
  const retained: { rewrite?: TranscriptRewrite } = {};
  contextEngineCompactMock.mockResolvedValueOnce(completed(sessionId));
  maintain.mockImplementationOnce(async ({ runtimeContext }) => {
    retained.rewrite = runtimeContext?.rewriteTranscriptEntries;
    return unchangedMaintenance();
  });

  await expect(compact(compactParams())).resolves.toMatchObject(success);
  expect(maintain).toHaveBeenCalledOnce();
  expectHydration(0);
  expect(loadTranscriptEventsSync(target())).toEqual(transcriptBefore);
  await expect(expectDefined(retained.rewrite, "retained rewrite")(request)).rejects.toThrow();

  expect(loadTranscriptEventsSync(target())).toEqual(transcriptBefore);
  expect(loadSessionEntry(target())).toMatchObject(owner);
});

it.each([
  { replacementPoint: "before rewrite", capturedWriter: "writer" },
  { replacementPoint: "during branch read", capturedWriter: undefined },
] as const)(
  "fences a queued maintenance writer replacement after acceptance: $replacementPoint (captured=$capturedWriter)",
  async ({ replacementPoint, capturedWriter }) => {
    const capturedEntry = entryForWriter(capturedWriter);
    replaceSessionEntrySync(target(), capturedEntry);
    const { request, transcriptBefore, hooks } = await transcriptFixture();
    const observed: { rewriteRejected?: boolean } = {};
    contextEngineCompactMock.mockResolvedValueOnce(completed(sessionId));
    maintain.mockImplementationOnce(async ({ runtimeContext }) => {
      const rewrite = expectDefined(runtimeContext?.rewriteTranscriptEntries, "active rewrite");
      const replaceWriter = () => {
        replaceSessionEntrySync(target(), {
          ...owner,
          updatedAt: 2,
          activeWriterRunId: "replacement-writer",
        });
      };
      if (replacementPoint === "before rewrite") {
        replaceWriter();
      } else {
        hooks.beforeBranchRead = () => {
          hooks.beforeBranchRead = undefined;
          replaceWriter();
        };
      }
      observed.rewriteRejected = await rewrite(request).then(
        () => false,
        () => true,
      );
      return unchangedMaintenance();
    });

    // The caller can validate its logical session without knowing the queued
    // operation's exact writer; that fence belongs to the queued owner.
    await compact(
      { ...compactParams(), sessionEntry: capturedEntry },
      {
        assertActive: () => {
          const current = loadSessionEntry(target());
          if (
            current?.sessionId !== owner.sessionId ||
            current.lifecycleRevision !== owner.lifecycleRevision
          ) {
            throw new Error("caller session changed");
          }
        },
      },
    ).catch(() => undefined);

    expect(observed.rewriteRejected).toBe(true);
    expect(loadSessionEntry(target())).toMatchObject({
      ...owner,
      activeWriterRunId: "replacement-writer",
    });
    expect(loadTranscriptEventsSync(target())).toEqual(transcriptBefore);
  },
);

it("refreshes host state when cancellation follows a committed maintenance rewrite", async () => {
  const { request, transcriptBefore } = await transcriptFixture();
  const controller = new AbortController();
  const onHostCompactionTranscriptSettled = vi.fn();
  contextEngineCompactMock.mockResolvedValueOnce(completed(sessionId));
  maintain.mockImplementationOnce(async ({ runtimeContext }) => {
    const rewrite = expectDefined(runtimeContext?.rewriteTranscriptEntries, "active rewrite");
    const result = await rewrite(request);
    controller.abort(new Error("cancel after maintenance rewrite"));
    return result;
  });

  await expect(
    compact(compactParams(controller.signal), { onHostCompactionTranscriptSettled }),
  ).resolves.toMatchObject({ ...success, result: { tokensAfter: 40 } });

  expect(loadTranscriptEventsSync(target())).not.toEqual(transcriptBefore);
  expect(onHostCompactionTranscriptSettled).toHaveBeenCalledOnce();
  expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
  expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
});
