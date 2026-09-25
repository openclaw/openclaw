import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import {
  admitReplyTurn,
  runWithReplyOperationLifecycleAdmission,
} from "../../auto-reply/reply/reply-turn-admission.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
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
import { readStartupRecoveryWarning } from "./main-session-restart-recovery-diagnostics.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "./main-session-restart-recovery-marking.js";
import { discoverRestartRecoveryStoreTargets } from "./main-session-restart-recovery-shared.js";

it("keeps healthy stores recoverable when an earlier startup mark fails", async () => {
  await withOpenClawTestState({ label: "recovery-mark-failure" }, async (state) => {
    const cfg = { agents: { entries: { main: { default: true }, worker: {} } } };
    await state.writeConfig(cfg);
    for (const agentId of ["main", "worker"]) {
      const sessionKey = `agent:${agentId}:main`;
      const sessionId = `${agentId}-session`;
      await replaceSessionEntry({ agentId, sessionKey }, { sessionId, updatedAt: 1 });
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
        status: "running",
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
      await replaceSessionEntry({ sessionKey }, { sessionId, updatedAt: 1 });
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
    await replaceSessionEntry({ sessionKey }, { sessionId, updatedAt: 1 });
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
    const cfg = { agents: { entries: { main: { default: true }, cleaner: {} } } };
    for (const agentId of ["main", "cleaner"]) {
      await replaceSessionEntry(
        { agentId, sessionKey: `agent:${agentId}:main` },
        { sessionId: `${agentId}-orphan`, status: "running", updatedAt: 1 },
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
          statuses: ["running"],
        })
      ).map((target) => target.agentId),
    ).toEqual(["main"]);
    expect(await fs.readFile(copyPath)).toEqual(before);
  });
});

it("marks only the closing Gateway's exact active admissions", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-owner-"));
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
        { sessionId: name, status: "running", updatedAt: Date.now() },
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
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

it.each(["release", "completed", "rotation"] as const)(
  "does not commit a restart mark when %s invalidates its owner after planning",
  async (change) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-commit-"));
    const storePath = path.join(stateDir, "sessions.json");
    const sessionKey = "agent:main:closing";
    const sessionId = "closing";
    const resolveGatewayContext = () => undefined;
    let admission: SessionWorkAdmissionLease | undefined;
    const apply = sessionAccessor.applySessionEntryReplacements;
    let restoreSpy = () => {};
    try {
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId, status: "running", updatedAt: Date.now() },
      );
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
      closeOpenClawAgentDatabasesForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  },
);

it("does not adopt an ambient Gateway when moving an unbound reply owner", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-adoption-"));
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
    await replaceSessionEntry(
      { storePath, sessionKey },
      { sessionId, status: "running", updatedAt: Date.now() },
    );
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
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

it("keeps another active session recoverable when one owner releases after batch planning", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-batch-"));
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
      survivingStatus: "running",
      survivingRestartMarker: true,
    });
  } finally {
    restoreSpy();
    admissions.forEach((admission) => admission.release());
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
