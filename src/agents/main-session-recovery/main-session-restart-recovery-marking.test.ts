import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import {
  admitReplyTurn,
  runWithReplyOperationLifecycleAdmission,
} from "../../auto-reply/reply/reply-turn-admission.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
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
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
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

it("reports why supplied shutdown candidates could not be marked", async () => {
  const stateDir = sessionDirs.make();
  const storePath = path.join(stateDir, "sessions.json");
  const sessionKey = "agent:main:main";
  await replaceSessionEntry(
    { storePath, sessionKey },
    {
      sessionId: "main-session",
      updatedAt: 1,
      lifecycleRunId: "main-run",
    },
  );
  const warn = vi.spyOn(mainSessionRecoveryLog, "warn");
  try {
    expect(
      await markRestartAbortedMainSessions({
        cfg: { session: { store: storePath } },
        stateDir,
        resolveGatewayContext: () => undefined,
        activeRuns: [
          {
            sessionKey,
            sessionId: "main-session",
            runId: "main-run",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          },
        ],
        isActiveRun: () => false,
      }),
    ).toEqual({ marked: 0, skipped: 0 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("activeRuns=1 skipped=0 skipReason=owner_changed"),
    );
    expect(loadSessionEntry({ storePath, sessionKey })?.mainRestartRecovery).toBeUndefined();
  } finally {
    warn.mockRestore();
  }
});

it("keeps healthy stores recoverable when an earlier startup mark fails", async () => {
  await withOpenClawTestState({ label: "recovery-mark-failure" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
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

it("marks only the closing Gateway's exact durable admissions and leaves host incognito volatile", async () => {
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
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const incognitoTarget = {
      agentId: "main",
      env,
      sessionKey: "agent:main:dashboard:incognito-closing",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
    };
    await replaceSessionEntry(incognitoTarget, {
      sessionId: "volatile",
      updatedAt: Date.now(),
      incognito: true,
    });
    admissions.push(
      await beginSessionWorkAdmission({
        scope: incognitoTarget.storePath,
        identities: [incognitoTarget.sessionKey, "volatile"],
        resolveGatewayContext,
        assertAllowed() {},
      }),
    );
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
    expect(loadSessionEntry(incognitoTarget)?.abortedLastRun).toBeUndefined();
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
  } finally {
    admissions.forEach((admission) => admission.release());
  }
});

it.each(["release", "completed", "cancelled", "rotation"] as const)(
  "does not commit a restart mark when %s invalidates its owner after planning",
  async (change) => {
    const stateDir = sessionDirs.make();
    const storePath = path.join(stateDir, "sessions.json");
    const sessionKey = "agent:main:closing";
    const sessionId = "closing";
    const resolveGatewayContext = () => undefined;
    let admission: SessionWorkAdmissionLease | undefined;
    let cancelled = false;
    const cancellation = createAgentRunDirectAbortError();
    const apply = sessionAccessor.applySessionEntryReplacements;
    let restoreSpy = () => {};
    try {
      await replaceSessionEntry({ storePath, sessionKey }, { sessionId, updatedAt: Date.now() });
      admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        resolveGatewayContext,
        isSettling: () => cancelled,
        getAbortReason: () => (cancelled ? cancellation : undefined),
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
              } else if (change === "cancelled") {
                cancelled = true;
                sessionAccessor.replaceSessionEntrySync(
                  { storePath, sessionKey },
                  { sessionId, status: "killed", updatedAt: Date.now(), endedAt: 123 },
                );
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
      if (change === "cancelled") {
        expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
          status: "killed",
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
