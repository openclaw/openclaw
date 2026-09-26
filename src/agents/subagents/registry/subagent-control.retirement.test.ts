// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  persistSubagentRunsToDiskOrThrow,
  useSubagentControlFixture,
} from "./subagent-control.test-support.js";
/** Cancellation retains selected descendants across committed ancestor retirement. */
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveContextEngine } from "../../../context-engine/registry.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  records,
  requesterWakeDriver,
  seedSubagentCompletionDelivery,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { PROVISIONAL_KILL_RECONCILIATION_MS } from "./subagent-registry-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "./subagent-registry-state.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  markSubagentRunTerminated,
  registerSubagentRun,
  resumeSubagentRun,
} from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { upsertSubagentRunRowInDatabase } from "./subagent-registry.store.kernel.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import { releaseSubagentRun, testing } from "./subagent-registry.test-helpers.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
const { persist, gateway } = fixture;

it.each([
  { transition: "normal retirement", cancel: true },
  { transition: "retirement with retained predecessor", cancel: true },
  { transition: "retirement write rollback", cancel: true },
  { transition: "successor registration write rollback", cancel: true },
  { transition: "accepted successor released", cancel: false },
  { transition: "accepted successor released without retirement", cancel: false },
  { transition: "session replacement", cancel: false },
  { transition: "lifecycle rotation", cancel: false },
  { transition: "controller replacement", cancel: false },
  { transition: "explicit release without retirement", cancel: false },
  { transition: "new direct child after retirement", cancel: true },
])(
  "preserves captured cancellation ownership through $transition",
  async ({ transition, cancel }) => {
    const controllerSessionKey = "agent:main:main";
    const ancestorKey = "agent:main:subagent:retiring-ancestor";
    const childKey = "agent:main:subagent:captured-child";
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: ancestorKey,
      defaultSessionId: "ancestor-session",
    });
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childKey,
      defaultSessionId: "child-session",
    });
    if (transition === "retirement with retained predecessor") {
      await registerSubagentRun({
        runId: "predecessor",
        childSessionKey: ancestorKey,
        requesterSessionKey: controllerSessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: "older reservation",
        cleanup: "keep",
        expectsCompletionMessage: false,
        collect: true,
        queued: true,
      });
    }
    for (const [runId, childSessionKey, owner, collect] of [
      ["ancestor", ancestorKey, controllerSessionKey, false],
      ["child", childKey, ancestorKey, true],
    ] as const) {
      await registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: owner,
        controllerSessionKey: owner,
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: runId,
        cleanup: "keep",
        expectsCompletionMessage: false,
        collect,
        queued: collect,
      });
    }
    const ancestor = subagentRuns.get("ancestor")!;
    const child = subagentRuns.get("child")!;
    expect(markSubagentRunTerminated({ runId: "ancestor", suppressTaskDelivery: true })).toBe(1);
    expect(ancestor.killReconciliation).toMatchObject({
      killedAt: now,
      suppressTaskDelivery: true,
    });
    expect(subagentRuns.get("ancestor")).toBe(ancestor);
    const dispatch = vi.fn(async () => {});
    const lateDispatch = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "lane",
      runId: "child",
      maxConcurrent: 1,
      activeRunIds: ["blocker"],
      start: dispatch,
      onStartFailure: () => true,
    });
    try {
      const result = await killAllControlledSubagentRuns({
        cfg: getRuntimeConfig(),
        controller: {
          controllerSessionKey,
          controllerAgentId: "main",
          callerSessionKey: controllerSessionKey,
          callerIsSubagent: false,
          controlScope: "children",
        },
        runs: [ancestor],
        beforeKill: async () => {
          // The retry already holds the child. Real reconciliation, not a map edit,
          // now retires the aged keep-mode ancestor while partial persistence awaits.
          clock.mockReturnValue(now + PROVISIONAL_KILL_RECONCILIATION_MS);
          if (transition === "explicit release without retirement") {
            releaseSubagentRun("ancestor");
          } else if (transition === "accepted successor released without retirement") {
            expect(subagentRuns.get("ancestor")).toBe(ancestor);
          } else {
            let retirementRejected = false;
            if (transition === "retirement write rollback") {
              persist.mockImplementation((runs, ids) => {
                if (!runs.has("ancestor")) {
                  retirementRejected = true;
                  throw new Error("retirement write rejected");
                }
                persistSubagentRunsToDiskOrThrow(runs, ids);
              });
            }
            await testing.sweepOnceForTests();
            if (transition === "retirement write rollback") {
              await vi.waitFor(() => expect(retirementRejected).toBe(true));
              await fixture.settle();
              expect(subagentRuns.get("ancestor")).toBe(ancestor);
              persist.mockImplementation(persistSubagentRunsToDiskOrThrow);
            } else {
              await vi.waitFor(() => expect(subagentRuns.has("ancestor")).toBe(false));
            }
          }
          if (transition.includes("successor")) {
            persist.mockImplementation((runs, ids) => {
              if (
                transition === "successor registration write rollback" ||
                (transition === "retained successor after failed rollback" &&
                  !runs.has("successor"))
              ) {
                throw new Error("registration write rejected");
              }
              persistSubagentRunsToDiskOrThrow(runs, ids);
            });
            const register = () =>
              registerSubagentRun({
                runId: "successor",
                childSessionKey: ancestorKey,
                requesterSessionKey: controllerSessionKey,
                requesterAgentId: "main",
                requesterDisplayKey: "main",
                task: "successor",
                cleanup: "keep",
                queued: true,
                expectsCompletionMessage: false,
              });
            try {
              if (transition.startsWith("accepted successor")) {
                await register();
              } else {
                await expect(register()).rejects.toThrow(
                  "Queued subagent registry persistence failed",
                );
              }
              if (cancel) {
                expect(subagentRuns.has("successor")).toBe(false);
                expect(loadSubagentRegistryFromSqlite().has("successor")).toBe(false);
              } else {
                expect(subagentRuns.get("successor")?.childSessionKey).toBe(ancestorKey);
                persist.mockImplementation(persistSubagentRunsToDiskOrThrow);
                releaseSubagentRun("successor");
              }
            } finally {
              persist.mockImplementation(persistSubagentRunsToDiskOrThrow);
            }
          } else if (transition === "session replacement") {
            await replaceSessionEntry(
              { storePath, sessionKey: ancestorKey },
              {
                sessionId: "replacement-session",
                updatedAt: Date.now(),
              },
            );
          } else if (transition === "lifecycle rotation") {
            rotateAgentEventLifecycleGeneration();
          } else if (transition === "controller replacement") {
            ancestor.controllerSessionKey = "agent:other:main";
          } else if (transition === "new direct child after retirement") {
            await registerSubagentRun({
              runId: "late",
              childSessionKey: "agent:main:subagent:late-child",
              requesterSessionKey: ancestorKey,
              requesterAgentId: "main",
              requesterDisplayKey: "main",
              task: "late",
              cleanup: "keep",
              queued: true,
              expectsCompletionMessage: false,
              collect: true,
            });
            enqueueSwarmRun({
              groupId: "late-lane",
              runId: "late",
              maxConcurrent: 1,
              activeRunIds: [],
              start: lateDispatch,
              onStartFailure: () => true,
            });
          }
          expect(loadSessionEntry({ storePath, sessionKey: ancestorKey })).toBeDefined();
          expect(gateway.mock.calls.some(([request]) => request.method === "sessions.delete")).toBe(
            false,
          );
          expect(releaseSwarmRun("blocker")).toBe(true);
          await Promise.resolve();
          expect(dispatch).not.toHaveBeenCalled();
          return true;
        },
      });
      expect(result).toMatchObject({ status: "ok", killed: cancel ? 1 : 0 });
      if (cancel) {
        expect(child.collectorCompletion?.status).toBe("killed");
        expect(dispatch).not.toHaveBeenCalled();
      } else {
        expect(child.killIntent).toBeUndefined();
        expect(child.collectorCompletion).toBeUndefined();
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      }
      if (transition === "retirement with retained predecessor") {
        expect(subagentRuns.get("predecessor")?.execution.status).toBe("queued");
      }
      if (transition === "new direct child after retirement") {
        expect(lateDispatch).toHaveBeenCalledOnce();
        expect(subagentRuns.get("late")?.killIntent).toBeUndefined();
        expect(resolveSubagentSessionStatus(subagentRuns.get("late"))).toBe("queued");
      }
    } finally {
      releaseSwarmRun("blocker");
      releaseSwarmRun("child");
      releaseSwarmRun("late");
    }
  },
);

it.each(
  (["bulk", "admin"] as const).flatMap((boundary) =>
    ["ordinary retirement", "session replacement", "lifecycle rotation", "owner replacement"].map(
      (transition) => ({ boundary, transition }),
    ),
  ),
)("handles $transition during $boundary admission drain", async ({ boundary, transition }) => {
  const controllerSessionKey = "agent:main:main";
  const ancestorKey = "agent:main:subagent:draining-ancestor";
  const childKey = "agent:main:subagent:draining-child";
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: ancestorKey,
    defaultSessionId: "draining-ancestor-session",
  });
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childKey,
    defaultSessionId: "draining-child-session",
  });
  for (const [runId, childSessionKey, owner, collect] of [
    ["draining-ancestor", ancestorKey, controllerSessionKey, false],
    ["draining-child", childKey, ancestorKey, true],
  ] as const) {
    await registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey: owner,
      controllerSessionKey: owner,
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: runId,
      cleanup: "keep",
      expectsCompletionMessage: false,
      collect,
      queued: collect,
    });
  }
  const ancestor = subagentRuns.get("draining-ancestor")!;
  const child = subagentRuns.get("draining-child")!;
  const entered = createDeferred();
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [ancestorKey, "draining-ancestor-session"],
    assertAllowed: () => {},
    onInterrupt: () => entered.resolve(),
  });
  const dispatch = vi.fn(async () => {});
  enqueueSwarmRun({
    groupId: "draining-lane",
    runId: child.runId,
    maxConcurrent: 1,
    activeRunIds: ["draining-blocker"],
    start: dispatch,
    onStartFailure: () => true,
  });
  const cfg = getRuntimeConfig();
  const controller = {
    controllerSessionKey,
    controllerAgentId: "main",
    callerSessionKey: controllerSessionKey,
    callerIsSubagent: false,
    controlScope: "children" as const,
  };
  const pending =
    boundary === "bulk"
      ? killAllControlledSubagentRuns({ cfg, controller, runs: [ancestor] })
      : killSubagentRunAdmin({
          cfg,
          sessionKey: ancestorKey,
          expectedRunId: ancestor.runId,
          expectedGeneration: ancestor.generation,
          expectedOwnerKey: controllerSessionKey,
        });
  try {
    await entered.promise;
    // Independent canonical termination during the drain, followed by modeled
    // reconciliation ageing. A fresh provisional kill must still retain its row.
    expect(markSubagentRunTerminated({ runId: ancestor.runId, suppressTaskDelivery: true })).toBe(
      1,
    );
    expect(subagentRuns.get(ancestor.runId)).toBe(ancestor);
    expect(ancestor.killReconciliation?.killedAt).toBe(now);
    clock.mockReturnValue(now + PROVISIONAL_KILL_RECONCILIATION_MS);
    await testing.sweepOnceForTests();
    await vi.waitFor(() => expect(subagentRuns.has(ancestor.runId)).toBe(false));
    expect(loadSessionEntry({ storePath, sessionKey: ancestorKey })?.sessionId).toBe(
      "draining-ancestor-session",
    );
    if (transition === "session replacement") {
      await replaceSessionEntry(
        { storePath, sessionKey: ancestorKey },
        { sessionId: "replacement-session", updatedAt: Date.now() },
      );
    } else if (transition === "lifecycle rotation") {
      rotateAgentEventLifecycleGeneration();
    } else if (transition === "owner replacement") {
      ancestor.controllerSessionKey = "agent:other:main";
      ancestor.requesterSessionKey = "agent:other:main";
    }
    expect(releaseSwarmRun("draining-blocker")).toBe(true);
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    admission.release();
    const result = await pending;
    expect(subagentRuns.has(ancestor.runId)).toBe(false);
    if (transition !== "ordinary retirement") {
      expect(child.killIntent).toBeUndefined();
      expect(child.collectorCompletion).toBeUndefined();
      expect(resolveSubagentSessionStatus(subagentRuns.get(child.runId))).toBe("queued");
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      return;
    }
    expect(child.collectorCompletion?.status, JSON.stringify(result)).toBe("killed");
    expect(resolveSubagentSessionStatus(subagentRuns.get(child.runId))).toBe("killed");
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject(
      boundary === "bulk"
        ? { status: "ok", killed: 1 }
        : { found: true, killed: true, cascadeKilled: 1 },
    );
  } finally {
    admission.release();
    await pending;
    releaseSwarmRun("draining-blocker");
    releaseSwarmRun(child.runId);
  }
});

it.each(["default", "template", "fixed JSON-style", "exact SQLite"])(
  "signals the non-main runtime owner in a %s session store",
  async (layout) => {
    const store =
      layout === "default"
        ? undefined
        : layout === "template"
          ? path.join(fixture.stateDir, "stores", "{agentId}", "sessions.json")
          : path.join(
              fixture.stateDir,
              "fixed",
              layout === "exact SQLite" ? "shared.sqlite" : "sessions.json",
            );
    const storePath = resolveSessionStorePathCore(store, { agentId: "other" });
    const mainStorePath = resolveSessionStorePathCore(store, { agentId: "main" });
    const childSessionKey = "agent:other:subagent:fixed-store-child";
    const sessionId = "fixed-store-child-session";
    await replaceSessionEntry(
      { storePath: mainStorePath, sessionKey: "agent:main:main" },
      { sessionId: "main-session", updatedAt: Date.now() },
    );
    await replaceSessionEntry(
      { storePath, sessionKey: childSessionKey },
      { sessionId, updatedAt: Date.now() },
    );
    await registerSubagentRun({
      runId: "fixed-store-child",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "cross-agent child",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ abort, runId: "fixed-store-child" });
    setActiveEmbeddedRun(sessionId, handle, childSessionKey);
    try {
      const result = await killAllControlledSubagentRuns({
        cfg: { ...getRuntimeConfig(), session: { store } },
        controller: {
          controllerSessionKey: "agent:main:main",
          controllerAgentId: "main",
          callerSessionKey: "agent:main:main",
          callerIsSubagent: false,
          controlScope: "children",
        },
        runs: [subagentRuns.get("fixed-store-child")!],
      });
      expect(abort, JSON.stringify(result)).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ status: "ok", killed: 1 });
      expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })?.abortedLastRun).toBe(
        true,
      );
      expect(
        loadSessionEntry({ storePath: mainStorePath, sessionKey: "agent:main:main" })
          ?.abortedLastRun,
      ).toBeUndefined();
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, childSessionKey);
    }
  },
);

it("does not create a missing child database while binding cancellation", async () => {
  const childSessionKey = "agent:missing:subagent:unprepared";
  const databasePath = path.join(fixture.stateDir, "agents/missing/agent/openclaw-agent.sqlite");
  await registerSubagentRun({
    runId: "unprepared",
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "missing session",
    cleanup: "keep",
    collect: true,
    queued: true,
    expectsCompletionMessage: false,
  });
  const dispatch = vi.fn(async () => {});
  enqueueSwarmRun({
    groupId: "missing-lane",
    runId: "unprepared",
    maxConcurrent: 1,
    activeRunIds: ["missing-blocker"],
    start: dispatch,
    onStartFailure: () => true,
  });
  expect(existsSync(databasePath)).toBe(false);
  try {
    await expect(
      killAllControlledSubagentRuns({
        cfg: getRuntimeConfig(),
        controller: {
          controllerSessionKey: "agent:main:main",
          controllerAgentId: "main",
          callerSessionKey: "agent:main:main",
          callerIsSubagent: false,
          controlScope: "children",
        },
        runs: [subagentRuns.get("unprepared")!],
        beforeKill: async () => {
          expect(existsSync(databasePath)).toBe(false);
          releaseSwarmRun("missing-blocker");
          await Promise.resolve();
          expect(dispatch).not.toHaveBeenCalled();
          throw new Error("partial persistence refused");
        },
      }),
    ).rejects.toThrow("partial persistence refused");
    expect(existsSync(databasePath)).toBe(false);
    expect(subagentRuns.get("unprepared")?.killIntent).toBeUndefined();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  } finally {
    releaseSwarmRun("missing-blocker");
    releaseSwarmRun("unprepared");
  }
});

describe("restored historical cancellation ownership", () => {
  const { wake, announce, capture, cleanup } = fixture;
  let settleRootWork: ReturnType<typeof observeRootWork>;

  beforeEach(() => {
    settleRootWork = observeRootWork();
    vi.mocked(persistSubagentRunsToDiskAsyncOrThrow).mockReset();
    vi.mocked(resolveContextEngine).mockReset();
    wake.mockReset().mockImplementation(async (params) => {
      await params.completeBatch([params.settledEntry], 1, {
        delivered: false,
        path: "none",
        error: "requester unavailable",
      });
      return false;
    });
    announce.mockReset().mockResolvedValue("delivered");
    capture.mockReset().mockResolvedValue(undefined);
    cleanup.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await settleRootWork();
  });

  async function settle() {
    await settleRootWork(true);
    await fixture.settle();
  }

  function historicalCancellation() {
    const input = records();
    const endedAt = Date.now() - 9 * 24 * 60 * 60_000;
    input.subagent = createSubagentRunRecord({
      runId: input.subagent.runId,
      generation: 1,
      taskRunId: input.subagent.taskRunId,
      childSessionKey: input.subagent.childSessionKey,
      createdAt: endedAt - 60_000,
      startedAt: endedAt - 50_000,
      endedAt,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "stopped" },
      cleanup: "keep",
      cleanupHandled: true,
      cleanupCompletedAt: endedAt,
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: endedAt - 2 },
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: "pending" },
      requesterSettleWake: { status: "dispatching", attemptCount: 3, rearmGeneration: 1 },
    });
    return input;
  }

  function persistRetiredOwner(input: ReturnType<typeof records>) {
    const database = openOpenClawStateDatabase();
    seedSubagentCompletionDelivery({ ...input, databaseOptions: { database } });
  }

  function restore() {
    initSubagentRegistry();
    // These terminal-only fixtures need a live owner but never dispatch a model turn.
    const gatewayContext = { resolveGatewayContext: () => gatewayContext as never };
    activateSubagentRegistry(() => gatewayContext as never);
  }

  function expectNoExecutionReplay() {
    expect(announce).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(fixture.gateway).not.toHaveBeenCalled();
  }

  it("reconciles the kill owner before waking retained native completion without repeating cleanup", async () => {
    const input = historicalCancellation();
    persistRetiredOwner(input);
    restore();
    resumeSubagentRun(input.subagent.runId, "restore");
    await settle();
    await testing.sweepOnceForTests();
    await settle();

    const saved = loadSubagentRegistryFromSqlite().get(input.subagent.runId)!;
    expect(saved.killReconciliation).toBeUndefined();
    expect(saved.requesterSettleWake).toBeUndefined();
    expect(saved.execution).toEqual(input.subagent.execution);
    expect(saved.cleanupCompletedAt).toBe(input.subagent.cleanupCompletedAt);
    expect(saved.delivery).toMatchObject({ status: "failed", lastError: "requester unavailable" });
    expect(saved.completion).toEqual({
      required: true,
      capturedAt: input.subagent.execution.endedAt,
      resultText: null,
    });
    expect(wake).toHaveBeenCalledOnce();
    expectNoExecutionReplay();
  });

  it.each([false, true])(
    "settles an uncaptured retained cancellation wake before retiring it (yielded=%s)",
    async (yielded) => {
      const input = historicalCancellation();
      const endedAt = Date.now() - 2 * 24 * 60 * 60_000;
      input.subagent.createdAt = endedAt - 60_000;
      input.subagent.execution.startedAt = endedAt - 50_000;
      input.subagent.execution.endedAt = endedAt;
      input.subagent.cleanupCompletedAt = endedAt + 30_000;
      input.subagent.killReconciliation = {
        killedAt: endedAt + 30_000,
        taskCancellationAccepted: true,
      };
      input.subagent.completionTarget = "parent";
      input.subagent.requesterSettleWake = {
        status: "dispatching",
        attemptCount: 3,
        batchRunIds: [input.subagent.runId],
        rearmGeneration: 1,
        ...(yielded ? { requesterYieldBatch: true, afterRequesterYield: true } : {}),
      };
      persistRetiredOwner(input);
      restore();
      resumeSubagentRun(input.subagent.runId, "restore");
      await settle();
      await testing.sweepOnceForTests();
      await settle();

      expect(
        loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.requesterSettleWake,
      ).toBeUndefined();
      await testing.sweepOnceForTests();
      await settle();
      expect(loadSubagentRegistryFromSqlite().has(input.subagent.runId)).toBe(false);
      expect(wake).toHaveBeenCalledOnce();
      expectNoExecutionReplay();
    },
  );

  it("leaves a newer persisted kill marker untouched by the restored snapshot", async () => {
    const input = historicalCancellation();
    persistRetiredOwner(input);
    restore();
    const updated = structuredClone(input.subagent);
    updated.killReconciliation = { killedAt: Date.now() };
    upsertSubagentRunRowInDatabase(openOpenClawStateDatabase(), bindSubagentRunRecord(updated));

    resumeSubagentRun(input.subagent.runId, "restore");
    await settle();
    await testing.sweepOnceForTests();
    await settle();

    expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)).toEqual(updated);
    expect(wake).not.toHaveBeenCalled();
    expectNoExecutionReplay();
  });

  it("defers a rejected historical retirement write without aborting resume", async () => {
    const input = historicalCancellation();
    persistRetiredOwner(input);
    restore();
    const database = openOpenClawStateDatabase();
    database.db.exec(`CREATE TRIGGER reject_retired_cancellation
      BEFORE UPDATE ON subagent_runs
      BEGIN SELECT RAISE(ABORT, 'retirement write rejected'); END`);
    try {
      expect(() => resumeSubagentRun(input.subagent.runId, "restore")).not.toThrow();
      await settle();
      const saved = loadSubagentRegistryFromSqlite().get(input.subagent.runId)!;
      expect(saved.killReconciliation).toEqual(input.subagent.killReconciliation);
      expect(saved.requesterSettleWake).toEqual(input.subagent.requesterSettleWake);
      expect(wake).not.toHaveBeenCalled();
    } finally {
      database.db.exec("DROP TRIGGER reject_retired_cancellation");
    }

    resumeSubagentRun(input.subagent.runId, "restore");
    await settle();
    expect(
      loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.requesterSettleWake,
    ).toBeUndefined();
    expect(wake).toHaveBeenCalledOnce();
    expectNoExecutionReplay();
  });

  it.each(["before restore", "transaction", "commit"] as const)(
    "preserves a newer child generation instead of waking the retired cancellation (%s)",
    async (stage) => {
      const input = historicalCancellation();
      persistRetiredOwner(input);
      const successor = createSubagentRunRecord({
        runId: "successor-run",
        childSessionKey: input.subagent.childSessionKey,
        generation: 2,
        createdAt: input.subagent.createdAt + 1,
        endedAt: input.subagent.execution.endedAt,
        outcome: { status: "ok" },
        cleanup: "keep",
        cleanupHandled: true,
        cleanupCompletedAt: input.subagent.cleanupCompletedAt,
        expectsCompletionMessage: false,
        completion: { required: false, resultText: "completed", capturedAt: Date.now() },
        delivery: { status: "not_required" },
      });
      if (stage === "before restore") {
        upsertSubagentRunRowInDatabase(
          openOpenClawStateDatabase(),
          bindSubagentRunRecord(successor),
        );
      } else {
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (grantOwner, attachment) =>
            createAdmission((request, grant) => {
              if (request.stage === stage) {
                subagentRuns.set(successor.runId, successor);
              }
              grantOwner(request, grant);
            }, attachment),
        );
      }
      restore();
      const originalBefore = loadSubagentRegistryFromSqlite().get(input.subagent.runId);
      const successorBefore = structuredClone(
        stage === "before restore" ? subagentRuns.get(successor.runId) : successor,
      );
      resumeSubagentRun(input.subagent.runId, "restore");
      await settle();
      const before = loadSubagentRegistryFromSqlite().get(successor.runId);
      await testing.sweepOnceForTests();
      await settle();

      expect(loadSubagentRegistryFromSqlite().get(successor.runId)).toEqual(before);
      expect(subagentRuns.get(successor.runId)).toEqual(successorBefore);
      expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)).toEqual(originalBefore);
      expect(wake).not.toHaveBeenCalled();
      expectNoExecutionReplay();
    },
  );

  it("keeps ordinary yielded wakes ahead of terminal cleanup", async () => {
    const input = historicalCancellation();
    input.subagent.pauseReason = "sessions_yield";
    input.subagent.endedReason = undefined;
    input.subagent.killReconciliation = undefined;
    input.subagent.execution.outcome = undefined;
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.cleanupHandled = false;
    input.subagent.requesterSettleWake!.retireAfterSettle = true;
    persistRetiredOwner(input);
    restore();
    await settle();
    await testing.sweepOnceForTests();
    await settle();

    const saved = loadSubagentRegistryFromSqlite().get(input.subagent.runId)!;
    expect(saved.requesterSettleWake).toBeUndefined();
    expect(saved.execution).toEqual(input.subagent.execution);
    expect(saved.pauseReason).toBe("sessions_yield");
    expect(saved.delivery).toEqual(input.subagent.delivery);
    expect(wake).toHaveBeenCalledOnce();
    expectNoExecutionReplay();
  });

  it.each([-1, 0, 1])(
    "does not reopen a cleaned cancellation for a delayed killed callback (%ims)",
    async (offset) => {
      const input = historicalCancellation();
      input.subagent.killReconciliation = undefined;
      persistRetiredOwner(input);
      subagentRuns.set(input.subagent.runId, input.subagent);
      const driver = requesterWakeDriver([input]);
      const before = structuredClone(input.subagent);
      try {
        await driver.controller.completeSubagentRun({
          runId: input.subagent.runId,
          expectedEntry: input.subagent,
          endedAt: input.subagent.execution.endedAt! + offset,
          reason: SUBAGENT_ENDED_REASON_KILLED,
          outcome: { status: "error", error: "stopped" },
          triggerCleanup: true,
        });

        expect(input.subagent).toEqual(before);
        expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)).toEqual(before);
        expect(driver.wake).not.toHaveBeenCalled();
        expectNoExecutionReplay();
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );
});
