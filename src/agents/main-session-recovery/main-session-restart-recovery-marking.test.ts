import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import {
  admitReplyTurn,
  runWithReplyOperationLifecycleAdmission,
} from "../../auto-reply/reply/reply-turn-admission.js";
import { updateSessionGoalStatus } from "../../config/sessions/goals.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  registerChatAbortController,
  type ChatAbortControllerEntry,
} from "../../gateway/chat-abort.js";
import { captureGatewayRestartRecoveryRuns } from "../../gateway/server-run-shutdown.js";
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
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionWorkAdmission,
  captureGatewaySessionWorkAdmissions,
  getSessionWorkAdmissionRelease,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../../state/openclaw-database-preflight.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { isMainSessionRecoveryPending } from "./main-session-recovery-state.js";
import { readStartupRecoveryWarning } from "./main-session-restart-recovery-diagnostics.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "./main-session-restart-recovery-marking.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery-runtime.js";
import { discoverRestartRecoveryStoreTargets } from "./main-session-restart-recovery-shared.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-restart-owner-");
it.each([
  "no goal",
  "active goal",
  "complete",
  "manual pause",
  "cancel",
  "revoked",
  "replacement",
  "unaccepted",
  "late revocation",
  "late acceptance",
] as const)("captures exact accepted drain intent and excludes %s", async (change) => {
  await withOpenClawTestState({ label: "accepted-drain-capture" }, async (state) => {
    const cfg = { session: { store: state.statePath("sessions.json") } };
    await state.writeConfig(cfg);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:drain",
      storePath: cfg.session.store,
    };
    const sessionId = "drain-session";
    const runId = "accepted-drain-run";
    await replaceSessionEntry(target, {
      sessionId,
      lifecycleRevision: "drain-life",
      status: "done",
      updatedAt: 1,
      ...(change === "active goal" || change === "manual pause"
        ? {
            goal: {
              schemaVersion: 1 as const,
              id: "drain-goal",
              objective: "Finish the accepted work",
              status: "active" as const,
              createdAt: 1,
              updatedAt: 1,
              tokenStart: 0,
              tokensUsed: 0,
              continuationTurns: 0,
            },
          }
        : {}),
    });
    const controllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers: controllers,
      ...target,
      sessionId,
      runId,
      kind: "agent",
      timeoutMs: 60_000,
    });
    if (!registration.registered) {
      throw new Error("Expected exact drain registration");
    }
    let actorCurrent = true;
    registration.entry.accepted = true;
    if (change === "late acceptance") {
      delete registration.entry.accepted;
    }
    registration.entry.assertSourceCurrent = () => {
      if (!actorCurrent) {
        throw new Error("actor revoked");
      }
    };
    const resolver = () => undefined;
    const admission = await beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [target.sessionKey, sessionId],
      resolveGatewayContext: resolver,
      assertAllowed: () => {},
    });
    const captured = captureGatewayRestartRecoveryRuns({
      chatAbortControllers: controllers,
      acceptedOnly: true,
    });
    const apply = sessionAccessor.applySessionEntryReplacements;
    let restore = () => {};
    let replacementRegistration: ReturnType<typeof registerChatAbortController> | undefined;
    try {
      if (change === "complete") {
        registration.entry.registrationCleanupRequested = true;
        registration.entry.projectSessionTerminalPersisted = true;
      } else if (change === "manual pause") {
        await updateSessionGoalStatus({ ...target, status: "paused" });
      } else if (change === "cancel") {
        registration.controller.abort(new Error("human cancelled"));
      } else if (change === "revoked") {
        actorCurrent = false;
      } else if (change === "replacement") {
        controllers.delete(runId);
        replacementRegistration = registerChatAbortController({
          chatAbortControllers: controllers,
          ...target,
          sessionId,
          runId,
          timeoutMs: 60_000,
        });
      } else if (change === "unaccepted") {
        delete registration.entry.accepted;
      } else if (change === "late acceptance") {
        registration.entry.accepted = true;
      } else if (change === "late revocation") {
        const spy = vi
          .spyOn(sessionAccessor, "applySessionEntryReplacements")
          .mockImplementationOnce((params) =>
            apply({
              ...params,
              update: async (entries) => {
                const planned = await params.update(entries);
                actorCurrent = false;
                return planned;
              },
            }),
          );
        restore = () => spy.mockRestore();
      }
      const result = await markRestartAbortedMainSessions({
        cfg,
        stateDir: state.stateDir,
        resolveGatewayContext: resolver,
        ...captured,
        captureGoals: true,
      });
      const eligible =
        change === "no goal" || change === "active goal" || change === "late acceptance";
      expect(result.marked).toBe(eligible ? 1 : 0);
      const saved = loadSessionEntry(target)!;
      expect(saved.sessionId).toBe(sessionId);
      expect(saved.abortedLastRun).toBe(eligible ? true : undefined);
      expect(saved.status).toBe(eligible ? "running" : "done");
      if (change === "active goal") {
        expect(saved.restartRecoveryGoal?.id).toBe("drain-goal");
      }
      if (change === "manual pause") {
        expect(saved.goal?.status).toBe("paused");
      }
      if (change === "no goal") {
        await persistGatewaySessionLifecycleEvent({
          ...target,
          event: {
            ts: Date.now(),
            sessionId,
            runId,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            data: { phase: "end", endedAt: Date.now() },
          },
        });
        // The captured interruption won before this old owner's terminal event.
        // Only fresh recovery admission may settle the retained handoff.
        expect(loadSessionEntry(target)).toMatchObject({
          status: "running",
          abortedLastRun: true,
          mainRestartRecovery: saved.mainRestartRecovery,
        });
        expect(loadSessionEntry(target)?.restartRecoveryRuns).toBeUndefined();
        expect(
          (await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir }))
            .marked,
        ).toBe(0);
      }
    } finally {
      restore();
      admission.release();
      for (const entry of controllers.values()) {
        entry.controller.abort();
      }
      replacementRegistration?.cleanup();
      registration.cleanup();
    }
  });
});

it.each(["active", "terminal error", "complete", "manual pause", "cancel", "replacement"] as const)(
  "captures an idle active goal before drain and honors %s at startup",
  async (stateAtStartup) => {
    await withOpenClawTestState({ label: "restart-goal-capture" }, async (state) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:captured-goal" };
      await replaceSessionEntry(target, {
        sessionId: "captured-session",
        lifecycleRevision: "original-life",
        status: "done",
        updatedAt: 1,
        goal: {
          schemaVersion: 1,
          id: "original-goal",
          objective: "Finish accepted work",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      });
      const captured = await markRestartAbortedMainSessions({
        cfg,
        stateDir: state.stateDir,
        activeRuns: [],
        resolveGatewayContext: () => undefined,
        captureGoals: true,
      });
      expect(captured.marked).toBe(1);
      const entry = loadSessionEntry(target)!;
      expect(entry.status).toBe("done");
      expect(entry.restartRecoveryGoal).toMatchObject({
        id: "original-goal",
        sessionId: "captured-session",
        lifecycleRevision: "original-life",
      });
      if (stateAtStartup === "complete") {
        entry.goal = { ...entry.goal!, status: "complete" };
      } else if (stateAtStartup === "terminal error") {
        entry.goal = { ...entry.goal!, status: "paused" };
        entry.goalPauseOrigin = "terminal-error";
      } else if (stateAtStartup === "manual pause") {
        entry.goal = { ...entry.goal!, status: "paused" };
        entry.goalPauseOrigin = "manual";
      } else if (stateAtStartup === "cancel") {
        entry.goal = undefined;
      } else if (stateAtStartup === "replacement") {
        entry.lifecycleRevision = "replacement-life";
      }
      await replaceSessionEntry(target, entry);
      const marked = await markStartupOrphanedMainSessionsForRecovery({
        cfg,
        stateDir: state.stateDir,
      });
      const resumes = stateAtStartup === "active" || stateAtStartup === "terminal error";
      expect(marked.marked).toBe(resumes ? 1 : 0);
      expect(loadSessionEntry(target)?.abortedLastRun).toBe(resumes ? true : undefined);
      expect(loadSessionEntry(target)?.sessionId).toBe("captured-session");
      const preserved = loadSessionEntry(target)!;
      const dispatchAgent = vi.fn(() => {
        throw new Error("Unattributed goal must not dispatch");
      });
      await recoverRestartAbortedMainSessions({
        cfg,
        stateDir: state.stateDir,
        gatewayRuntime: {
          dispatchAgent: async () => dispatchAgent(),
          dispatchSessionMethod: async () => {
            throw new Error("Unexpected session dispatch");
          },
          waitForAgent: async () => {
            throw new Error("Unexpected agent wait");
          },
          sendRecoveryNotice: async () => ({ suppressed: true }),
        },
      });
      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(loadSessionEntry(target)?.goal).toEqual(preserved.goal);
      if (!resumes) {
        const active = await markRestartAbortedMainSessions({
          cfg,
          stateDir: state.stateDir,
          activeRuns: [
            {
              ...target,
              sessionId: "captured-session",
              runId: "later-unrelated-run",
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
            },
          ],
          resolveGatewayContext: () => undefined,
          captureGoals: true,
        });
        const withdrawn = stateAtStartup === "complete" || stateAtStartup === "manual pause";
        expect(active.marked).toBe(withdrawn ? 0 : 1);
        const later = loadSessionEntry(target)!;
        if (withdrawn) {
          expect(later).toEqual(preserved);
        } else if (stateAtStartup === "replacement") {
          expect(later.restartRecoveryGoal?.lifecycleRevision).toBe("replacement-life");
        } else {
          expect(later.restartRecoveryGoal).toBeUndefined();
        }
        expect(isMainSessionRecoveryPending(later, target.sessionKey)).toBe(!withdrawn);
      }
    });
  },
);

it("keeps healthy stores recoverable when an earlier startup mark fails", async () => {
  await withOpenClawTestState({ label: "recovery-mark-failure" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          heartbeat: { agentId: "main" },
          systemAgent: { agentId: "main" },
        },
        entries: { main: { workspace: state.statePath("workspace") }, worker: {} },
      },
      talk: { agentId: "main" },
    };
    await state.writeConfig(cfg);
    for (const agentId of ["main", "worker"]) {
      const sessionKey = `agent:${agentId}:main`;
      const sessionId = `${agentId}-session`;
      await replaceSessionEntry(
        { agentId, sessionKey },
        { sessionId, updatedAt: 1, restartRecoveryDeliveryRunId: `${agentId}-run` },
      );
      await persistGatewaySessionLifecycleEvent({
        agentId,
        sessionKey,
        event: {
          ts: 1,
          sessionId,
          runId: `${agentId}-run`,
          data: { phase: "start", startedAt: 1 },
        },
      });
      expect(loadSessionEntry({ agentId, sessionKey })).toMatchObject({
        lifecycleRunId: `${agentId}-run`,
        abortedLastRun: false,
      });
    }
    const startupCheckedStorePaths = new Set<string>();
    const apply = sessionAccessor.applySessionEntryReplacements;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockRejectedValueOnce(new Error("startup store temporarily locked"));
    try {
      const result = await markStartupOrphanedMainSessionsForRecovery({
        cfg,
        stateDir: state.stateDir,
        startupCheckedStorePaths,
      });
      expect(
        loadSessionEntry({ agentId: "worker", sessionKey: "agent:worker:main" })?.abortedLastRun,
      ).toBe(true);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main" })?.abortedLastRun,
      ).toBe(false);
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
      await markStartupOrphanedMainSessionsForRecovery({
        cfg,
        stateDir: state.stateDir,
        startupCheckedStorePaths,
      });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main" })?.abortedLastRun,
      ).toBe(true);
      expect(startupCheckedStorePaths.size).toBe(2);
      expect(readStartupRecoveryWarning()).toBeUndefined();
    } finally {
      replacementSpy.mockRestore();
    }
  });
});

it.each(["before", "after"] as const)(
  "preserves a registry-owned writer registered %s orphan planning",
  async (registration) => {
    await withOpenClawTestState({ label: "recovery-live-writer" }, async (state) => {
      const sessionKey = "agent:main:main";
      const sessionId = "owned-session";
      const runId = "owned-run";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      await replaceSessionEntry(
        { sessionKey },
        { sessionId, updatedAt: 1, restartRecoveryDeliveryRunId: runId },
      );
      await persistGatewaySessionLifecycleEvent({
        sessionKey,
        event: { ts: 1, sessionId, runId, data: { phase: "start", startedAt: 1 } },
      });
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
      const apply = sessionAccessor.applySessionEntryReplacements;
      const replacementSpy = vi.spyOn(sessionAccessor, "applySessionEntryReplacements");
      if (registration === "before") {
        register();
      } else {
        replacementSpy.mockImplementationOnce((params) =>
          apply({
            ...params,
            update: async (entries) => {
              const prepared = await params.update(entries);
              register();
              return prepared;
            },
          }),
        );
      }
      try {
        await markStartupOrphanedMainSessionsForRecovery({ stateDir: state.stateDir });
        expect(loadSessionEntry({ sessionKey })).toEqual(before);
      } finally {
        replacementSpy.mockRestore();
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
    const sessionKey = "agent:main:main";
    const sessionId = "retained-session";
    const runId = "retained-run";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await replaceSessionEntry(
      { sessionKey },
      { sessionId, updatedAt: 1, restartRecoveryDeliveryRunId: runId },
    );
    await persistGatewaySessionLifecycleEvent({
      sessionKey,
      event: { ts: 1, sessionId, runId, data: { phase: "start", startedAt: 1 } },
    });
    const context = { sessionKey, sessionId, lifecycleGeneration };
    registerAgentRunContext(runId, context);
    const claimId = claimAgentRunContext(runId, context, { trackOwner: true });
    releaseAgentRunContext(runId, claimId);
    expect(getAgentRunContext(runId)).toBeDefined();
    const releaseQueue = retainQueuedAgentRunContext(runId, lifecycleGeneration);
    expect(releaseQueue).toBeDefined();
    try {
      await expect(
        markStartupOrphanedMainSessionsForRecovery({ stateDir: state.stateDir }),
      ).resolves.toEqual({ marked: 0, skipped: 0 });
      expect(loadSessionEntry({ sessionKey })?.abortedLastRun).toBe(false);
      releaseQueue?.("abandoned");
      await expect(
        markStartupOrphanedMainSessionsForRecovery({ stateDir: state.stateDir }),
      ).resolves.toEqual({ marked: 1, skipped: 0 });
      expect(loadSessionEntry({ sessionKey })?.abortedLastRun).toBe(true);
    } finally {
      releaseQueue?.("abandoned");
      clearAgentRunContext(runId, lifecycleGeneration);
    }
  });
});

it("marks healthy startup orphans while leaving a refused secondary database untouched", async () => {
  await withOpenClawTestState({ label: "recovery-admission" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          heartbeat: { agentId: "main" },
          systemAgent: { agentId: "main" },
        },
        entries: { main: { workspace: state.statePath("workspace") }, cleaner: {} },
      },
      talk: { agentId: "main" },
    };
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
    await assertOpenClawDatabasesReady({
      config: cfg,
      env: state.env,
      operation: "gateway-startup",
    });
    const before = await fs.readFile(copyPath);
    expect(
      await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir }),
    ).toEqual({ marked: 1, skipped: 0 });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main" })?.abortedLastRun,
    ).toBe(true);
    expect(
      (
        await discoverRestartRecoveryStoreTargets({
          cfg,
          stateDir: state.stateDir,
        })
      ).map((target) => target.agentId),
    ).toEqual(["main"]);
    expect(await fs.readFile(copyPath)).toEqual(before);
  });
});

it("marks only the closing Gateway's exact active admissions", async () => {
  const stateDir = sessionDirs.make();
  const storePath = path.join(stateDir, "sessions.json");
  const resolveGatewayContext = () => undefined;
  const otherGatewayContext = () => undefined;
  const admissions: SessionWorkAdmissionLease[] = [];
  try {
    for (const [name, resolver] of [
      ["closing", resolveGatewayContext],
      ["other", otherGatewayContext],
    ] as const) {
      const sessionKey = `agent:main:${name}`;
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId: name, updatedAt: Date.now() },
      );
      admissions.push(
        await beginSessionWorkAdmission({
          scope: storePath,
          identities: [sessionKey, name],
          resolveGatewayContext: resolver,
          assertAllowed: () => {},
        }),
      );
    }
    await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir,
      activeRuns: [],
      resolveGatewayContext,
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:closing" })?.abortedLastRun).toBe(
      true,
    );
    expect(
      loadSessionEntry({ storePath, sessionKey: "agent:main:other" })?.abortedLastRun,
    ).toBeUndefined();
  } finally {
    admissions.forEach((admission) => admission.release());
  }
});

it.each(["release", "completed", "rotation"] as const)(
  "does not commit a restart mark when %s invalidates its owner after planning",
  async (change) => {
    const stateDir = sessionDirs.make();
    const storePath = path.join(stateDir, "sessions.json");
    const sessionKey = "agent:main:closing";
    const sessionId = "closing";
    const resolveGatewayContext = () => undefined;
    let admission: SessionWorkAdmissionLease | undefined;
    const apply = sessionAccessor.applySessionEntryReplacements;
    let restoreSpy = () => {};
    try {
      await replaceSessionEntry({ storePath, sessionKey }, { sessionId, updatedAt: Date.now() });
      admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        resolveGatewayContext,
        assertAllowed: () => {},
      });
      const spy = vi
        .spyOn(sessionAccessor, "applySessionEntryReplacements")
        .mockImplementationOnce((params) =>
          apply({
            ...params,
            update: async (entries) => {
              const prepared = await params.update(entries);
              if (change === "rotation") {
                rotateAgentEventLifecycleGeneration();
              } else {
                admission?.release();
                if (change === "completed") {
                  sessionAccessor.replaceSessionEntrySync(
                    { storePath, sessionKey },
                    { sessionId, status: "done", updatedAt: Date.now(), endedAt: 123 },
                  );
                }
              }
              return prepared;
            },
          }),
        );
      restoreSpy = () => spy.mockRestore();
      const marking = markRestartAbortedMainSessions({
        cfg: { session: { store: storePath } },
        stateDir,
        activeRuns: [],
        resolveGatewayContext,
      });
      if (change !== "rotation") {
        await expect(marking).resolves.toEqual({ marked: 0, skipped: 1 });
      } else {
        await expect(marking).rejects.toMatchObject({ code: "ERR_STALE_GATEWAY_LIFECYCLE" });
      }
      expect(loadSessionEntry({ storePath, sessionKey })?.abortedLastRun).toBeUndefined();
      if (change === "completed") {
        expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
          status: "done",
          endedAt: 123,
        });
      }
    } finally {
      restoreSpy();
      admission?.release();
    }
  },
);

it("does not adopt an ambient Gateway when moving an unbound reply owner", async () => {
  const stateDir = sessionDirs.make();
  const storePath = path.join(stateDir, "sessions.json");
  const sessionKey = "agent:main:adopted";
  const sessionId = "adopted";
  const otherGatewayContext = () => undefined;
  const operation = createReplyOperation({
    sessionKey: "agent:main:command",
    sessionId,
    resetTriggered: false,
  });
  try {
    await replaceSessionEntry({ storePath, sessionKey }, { sessionId, updatedAt: Date.now() });
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
        selected: captureGatewaySessionWorkAdmissions(otherGatewayContext).isActive({
          scope: storePath,
          sessionKey,
          sessionId,
        }),
        observedScope,
      }).toEqual({ selected: false, observedScope: undefined });
    });
  } finally {
    const released = getSessionWorkAdmissionRelease({ scope: storePath, identities: [sessionKey] });
    operation.complete();
    await released;
  }
});

it("keeps another active session recoverable when one owner releases after batch planning", async () => {
  const stateDir = sessionDirs.make();
  const storePath = path.join(stateDir, "sessions.json");
  const resolveGatewayContext = () => undefined;
  const admissions: SessionWorkAdmissionLease[] = [];
  const apply = sessionAccessor.applySessionEntryReplacements;
  let restoreSpy = () => {};
  try {
    for (const name of ["finishing", "still-active"]) {
      const sessionKey = `agent:main:${name}`;
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId: name, status: "done", updatedAt: Date.now() },
      );
      admissions.push(
        await beginSessionWorkAdmission({
          scope: storePath,
          identities: [sessionKey, name],
          resolveGatewayContext,
          assertAllowed: () => {},
        }),
      );
    }
    const spy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementationOnce((params) =>
        apply({
          ...params,
          update: async (entries) => {
            const prepared = await params.update(entries);
            admissions[0]!.release();
            return prepared;
          },
        }),
      );
    restoreSpy = () => spy.mockRestore();
    let error: unknown;
    let counts: { marked: number; skipped: number } | undefined;
    try {
      counts = await markRestartAbortedMainSessions({
        cfg: { session: { store: storePath } },
        stateDir,
        activeRuns: [],
        resolveGatewayContext,
      });
    } catch (caught) {
      error = caught;
    }
    const stillActive = loadSessionEntry({ storePath, sessionKey: "agent:main:still-active" });
    const observed = {
      counts,
      error: error instanceof Error ? error.message : error,
      survivingAdmissionActive: admissions[1]!.isActive(),
      survivingStatus: stillActive?.status,
      survivingRestartMarker: stillActive?.abortedLastRun,
    };
    expect(observed).toEqual({
      counts: { marked: 1, skipped: 1 },
      error: undefined,
      survivingAdmissionActive: true,
      survivingStatus: "interrupted",
      survivingRestartMarker: true,
    });
  } finally {
    restoreSpy();
    admissions.forEach((admission) => admission.release());
  }
});
