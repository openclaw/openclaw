import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import {
  admitReplyTurn,
  runWithReplyOperationLifecycleAdmission,
} from "../../auto-reply/reply/reply-turn-admission.js";
import { captureRuntimeConfigAsyncReader, setRuntimeConfigSnapshot } from "../../config/config.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import * as sessionEntryReader from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
  retainQueuedAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { controllerGate, controllerSource } from "../../sessions/controller-core.test-support.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  beginSessionEffect,
  captureGatewaySessionControllerWork,
  captureSessionControllerSettlement,
  captureSessionTarget,
  type SessionEffectRef,
} from "../../sessions/session-controller.lifecycle.js";
import {
  captureSessionControllerStop,
  stopSession,
} from "../../sessions/session-controller.stop.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { assertOpenClawDatabasesReady } from "../../state/openclaw-database-preflight.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createAgentRunDirectAbortError } from "../run-termination.js";
import { readStartupRecoveryWarning } from "./main-session-restart-recovery-diagnostics.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "./main-session-restart-recovery-marking.js";
import {
  discoverRestartRecoveryStoreTargets,
  mainSessionRecoveryLog,
} from "./main-session-restart-recovery-shared.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-restart-owner-");
afterEach(() => vi.restoreAllMocks());
type Entry = Parameters<typeof replaceSessionEntry>[1];

function createStore(directory = "") {
  const stateDir = sessionDirs.make();
  const storePath = path.join(stateDir, directory, "sessions.json");
  const resolveGatewayContext = () => undefined;
  const admissions: SessionEffectRef[] = [];
  return {
    stateDir,
    storePath,
    resolveGatewayContext,
    async session(name: string, entry: Partial<Entry> = {}, sourceStore = storePath) {
      const sessionKey = `agent:main:${name}`;
      const sessionId = `${name}-session`;
      const runId = `${name}-run`;
      const location = { agentId: "main", storePath: sourceStore, sessionKey };
      const run = {
        ...location,
        sessionId,
        runId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      };
      await replaceSessionEntry(location, { sessionId, updatedAt: 1, ...entry });
      return {
        ...run,
        read: () => loadSessionEntry(location),
        run,
        target: captureSessionTarget({
          storeScope: sourceStore,
          sessionKey,
          incarnation: sessionId,
        }),
        async admit(this: void, overrides: Partial<Parameters<typeof beginSessionEffect>[0]> = {}) {
          const admission = await beginSessionEffect({
            scope: sourceStore,
            identities: [sessionKey, sessionId],
            resolveGatewayContext,
            assertAllowed() {},
            ...overrides,
          });
          admissions.push(admission);
          return admission;
        },
      };
    },
    [Symbol.dispose]() {
      admissions.forEach((admission) => admission.release());
    },
    mark: (overrides: Partial<Parameters<typeof markRestartAbortedMainSessions>[0]> = {}) =>
      markRestartAbortedMainSessions({
        cfg: { session: { store: storePath } },
        stateDir,
        activeRuns: [],
        resolveGatewayContext,
        ...overrides,
      }),
    markStartup: () =>
      markStartupOrphanedMainSessionsForRecovery({
        cfg: { session: { store: storePath } },
        stateDir,
      }),
  };
}

function afterPlanning(callback: () => void) {
  const apply = sessionAccessor.applySessionEntryReplacements;
  return vi
    .spyOn(sessionAccessor, "applySessionEntryReplacements")
    .mockImplementationOnce((params) =>
      apply({
        ...params,
        update: async (entries) => {
          const prepared = await params.update(entries);
          callback();
          return prepared;
        },
      }),
    );
}

function twoAgentConfig(workspace: string, other: string): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { heartbeat: { agentId: "main" }, systemAgent: { agentId: "main" } },
      entries: { main: { workspace }, [other]: {} },
    },
    talk: { agentId: "main" },
  };
}

async function startRun(name: string, agentId = "main") {
  const sessionKey = `agent:${agentId}:main`;
  const sessionId = `${name}-session`;
  const runId = `${name}-run`;
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  await replaceSessionEntry(
    { agentId, sessionKey },
    { sessionId, updatedAt: 1, restartRecoveryDeliveryRunId: runId },
  );
  await persistGatewaySessionLifecycleEvent({
    agentId,
    sessionKey,
    event: { ts: 1, sessionId, runId, data: { phase: "start", startedAt: 1 } },
  });
  return { sessionKey, sessionId, runId, lifecycleGeneration };
}

function readMain(agentId = "main") {
  return loadSessionEntry({ agentId, sessionKey: `agent:${agentId}:main` });
}

function startupMarker(stateDir: string, cfg?: OpenClawConfig) {
  return (startupCheckedStorePaths?: Set<string>) =>
    markStartupOrphanedMainSessionsForRecovery({ stateDir, cfg, startupCheckedStorePaths });
}

it.for(["before capture", "after capture"] as const)(
  "keeps a cancelled claimed turn terminal during managed restart (%s)",
  async (timing, { signal }) => {
    using store = createStore();
    const { storePath, resolveGatewayContext, mark } = store;
    const { sessionKey, sessionId, runId, target, read } = await store.session("cancelled-owner", {
      lifecycleRunId: "cancelled-owner-run",
    });
    setRuntimeConfigSnapshot({ session: { store: storePath } });
    const turn = controllerGate();
    const input = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      controllerSource(target, { protocolRunId: runId }),
    );
    const execution = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      withSessionTurn({ sessionKey, sessionId, target, controllerInput: input }, turn.run),
    );
    void execution.catch(() => {});
    try {
      await withinTest(turn.entered, signal);
      const captured =
        timing === "after capture"
          ? captureGatewaySessionControllerWork(resolveGatewayContext)
          : undefined;
      await stopSession({
        source: "client-run",
        capture: captureSessionControllerStop({ inputs: [input] }),
        hookContext: { sessionKey },
      }).completed;
      await persistGatewaySessionLifecycleEvent({
        sessionKey,
        event: {
          ts: 2,
          sessionId,
          runId,
          data: { phase: "error", endedAt: 2, aborted: true, stopReason: "aborted" },
        },
      });
      expect(read()?.status).toBe("killed");
      await mark({ activeAdmissions: captured });
      const persisted = read();
      expect(persisted).toMatchObject({ status: "killed", abortedLastRun: true });
      expect(persisted?.mainRestartRecovery).toBeUndefined();
    } finally {
      turn.release();
      await execution.catch(() => {});
      await input.settlement.promise;
    }
  },
);

it("loads only orphan candidates for main-session startup recovery", async () => {
  using store = createStore();
  const { storePath } = store;
  const { sessionKey, read } = await store.session("main", { abortedLastRun: true });
  for (let index = 0; index < 16; index++) {
    sessionAccessor.replaceSessionEntrySync(
      { storePath, sessionKey: `agent:main:subagent:retained-${index}` },
      { sessionId: `retained-${index}`, updatedAt: 1, abortedLastRun: true },
    );
    sessionAccessor.replaceSessionEntrySync(
      { storePath, sessionKey: `agent:main:settled-${index}` },
      { sessionId: `settled-${index}`, updatedAt: 1, status: "done" },
    );
  }
  const reader = vi.spyOn(sessionEntryReader, "readSessionEntrySummariesInWorker");
  vi.spyOn(mainSessionRecoveryLog, "warn").mockImplementation(() => {});
  expect(await store.markStartup()).toEqual({ marked: 1, skipped: 0 });
  expect(read()).toMatchObject({
    abortedLastRun: true,
    mainRestartRecovery: { chargedAttempts: 0 },
  });
  const batches = await Promise.all(reader.mock.results.map(({ value }) => value));
  expect(batches.flat().map((item) => item.sessionKey)).toEqual([sessionKey]);
});

it.each([false, true])(
  "reports skipped shutdown sessions when another is marked: %s",
  async (markOther) => {
    using store = createStore();
    const main = await store.session("main", { lifecycleRunId: "main-run" });
    const missing = {
      ...main.run,
      sessionKey: "agent:main:missing",
      sessionId: "missing-session",
      runId: "missing-run",
    };
    const other = markOther
      ? await store.session("other", { lifecycleRunId: "other-run" })
      : undefined;
    const warn = vi.spyOn(mainSessionRecoveryLog, "warn");
    expect(
      await store.mark({
        activeRuns: [main.run, missing, ...(other ? [other.run] : [])],
        isActiveRun: (activeRun) => activeRun.runId !== "main-run",
      }),
    ).toEqual({ marked: markOther ? 1 : 0, skipped: 0 });
    expect(warn).toHaveBeenCalledWith(
      'skipped restart recovery session: {"sessionKey":"agent:main:main","reason":"owner_changed"}',
    );
    expect(warn).toHaveBeenCalledWith(
      'skipped restart recovery session: {"sessionKey":"agent:main:missing","reason":"no_matching_session"}',
    );
    expect(main.read()?.mainRestartRecovery).toBeUndefined();
  },
);

it.each(["store", "agent"] as const)(
  "keeps a matching session outside the captured recovery %s untouched",
  async (different) => {
    using store = createStore("configured");
    const { stateDir, storePath } = store;
    const sourceStore =
      different === "store" ? path.join(stateDir, "retained", "sessions.json") : storePath;
    const configured = await store.session("same", { lifecycleRunId: "same-run" });
    const source =
      sourceStore === storePath
        ? configured
        : await store.session("same", { lifecycleRunId: "same-run" }, sourceStore);

    await expect(
      store.mark({
        activeRuns: [
          {
            ...source.run,
            agentId: different === "agent" ? "other" : "main",
          },
        ],
      }),
    ).resolves.toEqual({ marked: different === "store" ? 1 : 0, skipped: 0 });
    expect(configured.read()?.abortedLastRun).not.toBe(true);
    if (different === "store") {
      expect(source.read()?.abortedLastRun).toBe(true);
    }
  },
);

it("keeps healthy stores recoverable when an earlier startup mark fails", async () => {
  await withOpenClawTestState({ label: "recovery-mark-failure" }, async (state) => {
    const cfg = twoAgentConfig(state.statePath("workspace"), "worker");
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const markStartup = startupMarker(state.stateDir, cfg);
    for (const agentId of ["main", "worker"]) {
      await startRun(agentId, agentId);
      expect(readMain(agentId)).toMatchObject({
        lifecycleRunId: `${agentId}-run`,
        abortedLastRun: false,
      });
    }
    const startupCheckedStorePaths = new Set<string>();
    const apply = sessionAccessor.applySessionEntryReplacements;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockRejectedValueOnce(new Error("startup store temporarily locked"));
    const result = await markStartup(startupCheckedStorePaths);
    expect(readMain("worker")?.abortedLastRun).toBe(true);
    expect(readMain()?.abortedLastRun).toBe(false);
    expect(startupCheckedStorePaths).toEqual(
      new Set([
        JSON.stringify(["worker", path.join(state.sessionsDir("worker"), "sessions.json")]),
      ]),
    );
    expect(result.failedTargets).toEqual([
      { agentId: "main", storePath: path.join(state.sessionsDir("main"), "sessions.json") },
    ]);
    expect(readStartupRecoveryWarning()).toContain("startup store temporarily locked");
    expect(readStartupRecoveryWarning(false)).not.toContain("startup store temporarily locked");

    replacementSpy.mockImplementation(apply);
    await markStartup(startupCheckedStorePaths);
    expect(readMain()?.abortedLastRun).toBe(true);
    expect(startupCheckedStorePaths.size).toBe(2);
    expect(readStartupRecoveryWarning()).toBeUndefined();
  });
});

it.each(["before", "after"] as const)(
  "preserves a registry-owned writer registered %s orphan planning",
  async (registration) => {
    await withOpenClawTestState({ label: "recovery-live-writer" }, async (state) => {
      await captureRuntimeConfigAsyncReader()();
      const { sessionKey, runId, lifecycleGeneration } = await startRun("owned");
      const before = loadSessionEntry({ sessionKey });
      let claimId: string | undefined;
      const register = () => {
        claimId = claimAgentRunContext(
          runId,
          {
            lifecycleGeneration,
            sessionKey: "agent:main:other",
            sessionId: "other-session",
          },
          { trackOwner: true },
        );
        expect(claimId).toBeDefined();
      };
      if (registration === "after") {
        afterPlanning(register);
      }
      try {
        if (registration === "before") {
          register();
        }
        await markStartupOrphanedMainSessionsForRecovery({ stateDir: state.stateDir });
        expect(loadSessionEntry({ sessionKey })).toEqual(before);
      } finally {
        releaseAgentRunContext(runId, claimId);
        clearAgentRunContext(runId, lifecycleGeneration);
        rotateAgentEventLifecycleGeneration();
        expect(readStartupRecoveryWarning()).toBeUndefined();
      }
    });
  },
);

it("recovers an orphan after its owner releases retained run metadata", async () => {
  await withOpenClawTestState({ label: "recovery-retained-run" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const { sessionKey, sessionId, runId, lifecycleGeneration } = await startRun("retained");
    const markStartup = startupMarker(state.stateDir);
    const context = { sessionKey, sessionId, lifecycleGeneration };
    registerAgentRunContext(runId, context);
    const claimId = claimAgentRunContext(runId, context, { trackOwner: true });
    releaseAgentRunContext(runId, claimId);
    expect(getAgentRunContext(runId)).toBeDefined();
    const releaseQueue = retainQueuedAgentRunContext(runId, lifecycleGeneration);
    expect(releaseQueue).toBeDefined();
    try {
      await expect(markStartup()).resolves.toEqual({ marked: 0, skipped: 0 });
      expect(loadSessionEntry({ sessionKey })?.abortedLastRun).toBe(false);
      releaseQueue?.("abandoned");
      await expect(markStartup()).resolves.toEqual({ marked: 1, skipped: 0 });
      expect(loadSessionEntry({ sessionKey })).toMatchObject({
        abortedLastRun: true,
        restartRecoveryDeliverySourceRunId: runId,
      });
      expect(loadSessionEntry({ sessionKey })?.lifecycleRunId).toBeUndefined();
    } finally {
      releaseQueue?.("abandoned");
      clearAgentRunContext(runId, lifecycleGeneration);
    }
  });
});

it("preserves an explicit original source without selecting an ambiguous startup cohort", async () => {
  await withOpenClawTestState({ label: "recovery-source-cohort" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const runs = [
      { runId: "first", lifecycleGeneration: "previous-process" },
      { runId: "second", lifecycleGeneration: "previous-process" },
    ];
    for (const sourceRunId of [undefined, "original"] as const) {
      const sessionKey = `agent:main:${sourceRunId ?? "ambiguous"}`;
      await replaceSessionEntry(
        { sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: 1,
          lifecycleRunId: sourceRunId ? "second" : undefined,
          restartRecoveryRuns: runs,
          restartRecoveryDeliverySourceRunId: sourceRunId,
        },
      );
    }
    expect(await markStartupOrphanedMainSessionsForRecovery({ stateDir: state.stateDir })).toEqual({
      marked: 2,
      skipped: 0,
    });
    for (const sourceRunId of [undefined, "original"] as const) {
      const entry = loadSessionEntry({ sessionKey: `agent:main:${sourceRunId ?? "ambiguous"}` });
      expect(entry?.restartRecoveryDeliverySourceRunId).toBe(sourceRunId);
      expect(entry?.restartRecoveryRuns).toEqual(runs);
      expect(entry?.lifecycleRunId).toBeUndefined();
      expect(entry?.abortedLastRun).toBe(true);
    }
  });
});

it("marks healthy startup orphans while leaving a refused secondary database untouched", async () => {
  await withOpenClawTestState({ label: "recovery-admission" }, async (state) => {
    const cfg = twoAgentConfig(state.statePath("workspace"), "cleaner");
    setRuntimeConfigSnapshot(cfg);
    for (const agentId of ["main", "cleaner"]) {
      await replaceSessionEntry(
        { agentId, sessionKey: `agent:${agentId}:main` },
        {
          sessionId: `${agentId}-orphan`,
          restartRecoveryDeliveryRunId: `${agentId}-run`,
          updatedAt: 1,
        },
      );
    }
    const copyPath = openOpenClawAgentDatabase({ agentId: "cleaner" }).path;
    closeOpenClawAgentDatabasesForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const copy = new DatabaseSync(copyPath);
    copy.exec(
      "PRAGMA user_version = 16; UPDATE schema_meta SET agent_id = 'main', schema_version = 16;",
    );
    copy.close();
    revokeSqliteDatabaseAdmissionsForPath(copyPath);
    await assertOpenClawDatabasesReady({
      config: cfg,
      env: state.env,
      operation: "gateway-startup",
    });
    const before = await fs.readFile(copyPath);
    expect(
      await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir }),
    ).toEqual({ marked: 1, skipped: 0 });
    expect(readMain()?.abortedLastRun).toBe(true);
    const targets = await discoverRestartRecoveryStoreTargets({ cfg, stateDir: state.stateDir });
    expect(targets.map((target) => target.agentId)).toEqual(["main"]);
    expect(await fs.readFile(copyPath)).toEqual(before);
  });
});

it("marks only the closing Gateway's exact durable admissions and leaves host incognito volatile", async () => {
  using store = createStore();
  const { stateDir, resolveGatewayContext, mark } = store;
  const otherGatewayContext = () => undefined;
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const incognitoTarget = {
    agentId: "main",
    env,
    sessionKey: "agent:main:dashboard:incognito-closing",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const memoryLocation = { agentId: incognitoTarget.agentId, path: incognitoTarget.storePath };
  try {
    const closing = await store.session("closing", { updatedAt: Date.now() });
    const other = await store.session("other", { updatedAt: Date.now() });
    await closing.admit();
    await other.admit({ resolveGatewayContext: otherGatewayContext });
    await replaceSessionEntry(incognitoTarget, {
      sessionId: "volatile",
      updatedAt: Date.now(),
      incognito: true,
    });
    const volatile = await beginSessionEffect({
      scope: incognitoTarget.storePath,
      identities: [incognitoTarget.sessionKey, "volatile"],
      resolveGatewayContext,
      assertAllowed() {},
    });
    using _ = { [Symbol.dispose]: () => volatile.release() };
    await mark();
    expect(closing.read()?.abortedLastRun).toBe(true);
    expect(other.read()?.abortedLastRun).toBeUndefined();
    const incognito = memorySessionActorOwners
      .read(memoryLocation)
      ?.readSession(incognitoTarget.sessionKey, { assertCurrent() {}, authorize() {} });
    expect(incognito?.entry).toMatchObject({ sessionId: "volatile", incognito: true });
    expect(incognito?.entry?.abortedLastRun).toBeUndefined();
    expect(getOpenClawAgentDatabaseIfOpen(memoryLocation)).toBeUndefined();
  } finally {
    memorySessionActorOwners.closeDatabase(memoryLocation);
  }
});

it.each([
  ["release", undefined],
  ["completed", "done"],
  ["cancelled", "killed"],
  ["rotation", undefined],
] as const)(
  "does not commit a restart mark when %s invalidates its owner after planning",
  async (change, terminalStatus) => {
    using store = createStore();
    const { storePath, sessionKey, sessionId, read, admit } = await store.session("closing", {
      updatedAt: Date.now(),
    });
    let cancelled = false;
    const cancellation = createAgentRunDirectAbortError();
    const admission = await admit({
      isSettling: () => cancelled,
      getAbortReason: () => (cancelled ? cancellation : undefined),
    });
    afterPlanning(() => {
      if (change === "rotation") {
        rotateAgentEventLifecycleGeneration();
      } else if (change === "cancelled") {
        cancelled = true;
      } else {
        admission.release();
      }
      if (terminalStatus) {
        sessionAccessor.replaceSessionEntrySync(
          { storePath, sessionKey },
          { sessionId, status: terminalStatus, updatedAt: Date.now(), endedAt: 123 },
        );
      }
    });
    const marking = store.mark();
    if (change !== "rotation") {
      await expect(marking).resolves.toEqual({ marked: 0, skipped: 1 });
    } else {
      await expect(marking).rejects.toMatchObject({ code: "ERR_STALE_GATEWAY_LIFECYCLE" });
    }
    expect(read()?.abortedLastRun).toBeUndefined();
    if (terminalStatus) {
      expect(read()).toMatchObject({ status: terminalStatus, endedAt: 123 });
    }
  },
);

it("does not adopt an ambient Gateway when moving an unbound reply owner", async () => {
  using store = createStore();
  const { storePath, sessionKey, sessionId } = await store.session("adopted", {
    updatedAt: Date.now(),
  });
  const otherGatewayContext = () => undefined;
  const operation = createReplyOperation({
    sessionKey: "agent:main:command",
    sessionId,
    resetTriggered: false,
  });
  try {
    await withPluginRuntimeGatewayContextResolver(otherGatewayContext, async () => {
      const admission = await admitReplyTurn({
        sessionKey,
        sessionId,
        storePath,
        kind: "visible",
        resetTriggered: false,
        adoptOperation: operation,
      });
      expect(admission.status).toBe("owned");
      const observedScope = await runWithReplyOperationLifecycleAdmission(
        operation,
        async () => getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
      );
      expect({
        selected: captureGatewaySessionControllerWork(otherGatewayContext).isActive({
          scope: storePath,
          sessionKey,
          sessionId,
        }),
        observedScope,
      }).toEqual({ selected: false, observedScope: undefined });
    });
  } finally {
    const released = captureSessionControllerSettlement({
      scope: storePath,
      identities: [sessionKey],
    });
    operation.complete();
    await released;
  }
});

it("keeps another active session recoverable when one owner releases after batch planning", async () => {
  using store = createStore();
  const finishing = await store.session("finishing", { status: "done", updatedAt: Date.now() });
  const active = await store.session("still-active", { status: "done", updatedAt: Date.now() });
  const finishingAdmission = await finishing.admit();
  const activeAdmission = await active.admit();
  afterPlanning(() => finishingAdmission.release());
  await expect(store.mark()).resolves.toEqual({ marked: 1, skipped: 1 });
  expect(activeAdmission.isActive()).toBe(true);
  expect(active.read()).toMatchObject({ status: "interrupted", abortedLastRun: true });
});
