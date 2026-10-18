import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import {
  abortActiveCronTaskRuns,
  registerActiveCronTaskRun,
} from "../../cron/service/active-run-cancellation.js";
import { callGateway } from "../../gateway/call.js";
import { buildRestartSafeChatTranscriptState } from "../../gateway/server-methods/chat-restart-recovery.js";
import { prepareGatewayStartupSessions } from "../../gateway/server-startup-session-migration.js";
import { persistGatewaySessionLifecycleEvent as persistLifecycle } from "../../gateway/session-lifecycle-state.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { finishAgentCommandCleanup } from "../command/cleanup.js";
import {
  createAgentRunRestartAbortError,
  resolveAgentRunErrorLifecycleFields,
} from "../run-termination.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";
import {
  codeModeCheckpointMessage,
  codeModeWaitCallMessage,
  makeUserMessage,
} from "./main-session-restart-recovery-transcript.test-support.js";
import {
  markRestartAbortedMainSessions as markAborted,
  markStartupOrphanedMainSessionsForRecovery as markOrphans,
  recoverRestartAbortedMainSessions as recoverSessions,
} from "./main-session-restart-recovery.js";

vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: vi.fn(async () => ({ runId: "resumed-chat-run" })),
}));

afterEach(clearRuntimeConfigSnapshot);

async function migrateLegacyInterruption(sessionKey: string, stateDir: string) {
  const { db } = openOpenClawAgentDatabase({ agentId: "main" });
  // Retain certification with legacy bytes; startup must still normalize them.
  db.prepare(
    "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.status', 'running'), entry_valid = 1 WHERE session_key = ?",
  ).run(sessionKey);
  await closeOpenClawAgentDatabasesAsync(stateDir);
  await prepareGatewayStartupSessions({
    cfg: { agents: { entries: { main: {} } } },
    log: { info: vi.fn(), warn: vi.fn() },
  });
}

it.each([
  "before settlement",
  "after settlement",
  "persisted interruption",
  "unclaimed legacy",
  "automation drain",
] as const)("resumes restart-safe work across shutdown and upgrade (%s)", async (order) => {
  await withOpenClawTestState({ label: "restart-aborted-chat" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const automationDrain = order === "automation drain";
    const unclaimed = order === "unclaimed legacy";
    const persisted = order === "persisted interruption";
    const sessionKey = "agent:main:dashboard:restart-chat";
    const sessionId = "restart-chat-session";
    const runId = "interrupted-chat-run";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const target = {
      agentId: "main",
      sessionKey,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const admitted = buildRestartSafeChatTranscriptState({
      sourceIngress: "control-ui",
      admission: { requestFingerprint: "synthetic-request" },
      clientRunId: runId,
      startedAt: 100,
    });
    const entry: SessionEntry = {
      sessionId,
      updatedAt: 100,
      permissionMode: "guarded",
      delivery: { kind: unclaimed ? "none" : "internal" },
      spawnDepth: 0,
      ...(unclaimed ? { lifecycleRunId: runId, startedAt: 100 } : admitted.sessionLifecyclePatch),
      activeWriterRunId: runId,
    };
    if (persisted) {
      // An older cleanup terminalized the source before its restart snapshot.
      delete entry.restartRecoveryDeliveryRunId;
      delete entry.restartRecoveryDeliverySourceRunId;
      delete entry.restartRecoveryDeliveryRequestFingerprint;
      delete entry.restartRecoverySourceIngress;
      entry.restartRecoveryTerminalRunIds = ["previous-completed-run", runId];
      entry.abortedLastRun = true;
    }
    await replaceSessionEntry(target, entry);
    for (const message of [
      makeUserMessage("Finish the interrupted work", { idempotencyKey: runId }),
      codeModeWaitCallMessage(),
      codeModeCheckpointMessage(),
    ]) {
      await appendTranscriptMessage({ ...target, sessionId }, { cwd: state.workspaceDir, message });
    }
    if (persisted || unclaimed) {
      await migrateLegacyInterruption(sessionKey, state.stateDir);
    }
    if (unclaimed) {
      const migrated = loadSessionEntry(target);
      expect(migrated).toMatchObject({
        status: "interrupted",
        mainRestartRecovery: { cycleId: expect.any(String), revision: 1, chargedAttempts: 0 },
      });
      expect(migrated?.restartRecoveryDeliveryRunId).toBeUndefined();
    }
    const mark = (isActive: boolean) =>
      markAborted({
        resolveGatewayContext: () => undefined,
        stateDir: state.stateDir,
        activeRuns: [{ sessionKey, sessionId, runId, lifecycleGeneration }],
        isActiveRun: () => isActive,
      });
    if (order === "before settlement" || order === "after settlement" || automationDrain) {
      if (order === "before settlement") {
        await mark(true);
      }
      const controller = new AbortController();
      if (automationDrain) {
        const release = registerActiveCronTaskRun({ runId, controller });
        try {
          expect(abortActiveCronTaskRuns()).toBe(1);
        } finally {
          release?.();
        }
      }
      const error = automationDrain
        ? new Error("Provider request cancelled during drain")
        : createAgentRunRestartAbortError();
      const abortSignal = automationDrain ? controller.signal : undefined;
      const terminalData = {
        phase: "error",
        error,
        ...resolveAgentRunErrorLifecycleFields(error, abortSignal),
      };
      // The command's finally can finish before the Gateway's queued lifecycle
      // publication and shutdown discovery; its outer signal need not be aborted.
      await finishAgentCommandCleanup({
        prepared: {
          ...target,
          sessionAgentId: "main",
          runId,
          sessionStore: { [sessionKey]: entry },
        },
        sessionEntry: entry,
        runOwnedSessionId: sessionId,
        sessionReboundDuringRun: false,
        trackedRestartRecoveryDeliveryClaim: true,
        terminalEvent: { data: terminalData },
        abortSignal,
        lifecycleGeneration,
        beforeTerminalDelivery: undefined,
        reportCommitted: () => {},
        preparedRunAdmission: undefined,
        sessionWorkAdmission: undefined,
        cleanupInternalModelRunTargets: async () => {},
        releaseForeground: undefined,
      });
      await persistLifecycle({
        sessionKey,
        event: {
          runId,
          sessionId,
          lifecycleGeneration,
          ts: 200,
          // Shutdown may publish the embedded owner's restart after caller cleanup.
          data: automationDrain
            ? { ...terminalData, aborted: true, stopReason: "restart" }
            : terminalData,
        },
      });
      if (order === "after settlement" || automationDrain) {
        expect(await mark(false)).toEqual({ marked: 0, skipped: 0 });
      }
      const interrupted = loadSessionEntry(target);
      expect.soft(interrupted).toMatchObject({
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: runId,
        restartRecoveryDeliverySourceRunId: runId,
      });
      expect.soft(interrupted?.restartRecoveryTerminalRunIds ?? []).not.toContain(runId);
    }

    rotateAgentEventLifecycleGeneration();
    const dispatchSettlement = createDeferred();
    const dispatch = vi.mocked(callGateway);
    dispatch.mockClear();
    const runtime = createRecoveryRuntimeFixture({
      callGateway,
      getDispatchSettlement: () => dispatchSettlement.promise,
      sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
    });
    const recover = (activeSessionIds?: string[]) =>
      recoverSessions({
        stateDir: state.stateDir,
        gatewayRuntime: runtime,
        ...(activeSessionIds ? { activeSessionIds } : {}),
      });
    try {
      if (persisted) {
        const info = vi.spyOn(mainSessionRecoveryLog, "info");
        try {
          await markOrphans({ stateDir: state.stateDir, activeSessionIds: [sessionId] });
          expect(await recover([sessionId])).toEqual({
            started: 0,
            settled: 0,
            failed: 0,
            skipped: 1,
          });
          expect(dispatch).not.toHaveBeenCalled();
          expect(loadSessionEntry(target)?.restartRecoveryTerminalRunIds).toEqual([
            "previous-completed-run",
          ]);
          expect(info).toHaveBeenCalledWith(
            expect.stringContaining(
              "main-session restart recovery startup complete: started=0 settled=0 failed=0 skipped=1 skipReasons=live_owner:1",
            ),
          );
        } finally {
          info.mockRestore();
        }
      }
      await markOrphans({ stateDir: state.stateDir });
      const result = await recover();
      expect(result).toMatchObject({ started: 1, failed: 0, skipped: 0 });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({ sessionKey, forceRestartSafeTools: true }),
        }),
      );
      expect(loadSessionEntry(target)).toMatchObject({
        abortedLastRun: false,
        lifecycleRunId: expect.any(String),
        ...(unclaimed ? {} : { restartRecoveryDeliverySourceRunId: runId }),
        mainRestartRecovery: expect.objectContaining({ chargedAttempts: 1 }),
      });
      expect(loadSessionEntry(target)?.restartRecoveryTerminalRunIds ?? []).not.toContain(runId);
      if (automationDrain) {
        expect(await recover()).toMatchObject({ started: 0, failed: 0 });
        expect(dispatch).toHaveBeenCalledTimes(1);
      }
      if (persisted) {
        expect(loadSessionEntry(target)?.restartRecoveryTerminalRunIds).toEqual([
          "previous-completed-run",
        ]);
      }
    } finally {
      dispatchSettlement.resolve();
    }
  });
});

it("preserves a terminal receipt recorded under the interrupted continuation's source", async () => {
  await withOpenClawTestState({ label: "restart-terminal-receipt" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const sessionKey = "agent:main:dashboard:delivered-chat";
    const sessionId = "delivered-chat-session";
    const runId = "interrupted-continuation";
    const target = {
      agentId: "main",
      sessionKey,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const terminal = buildRestartRecoveryClaimCleanupPatch({
      entry: {
        sessionId,
        updatedAt: 100,
        restartRecoveryDeliveryRunId: runId,
        restartRecoveryDeliverySourceRunId: "completed-source",
      },
      recordTerminalSource: true,
      terminalRunId: runId,
      terminalDeliveryEvidence: { captured: true, payloads: [{ visible: true }] },
    });
    await replaceSessionEntry(target, {
      sessionId,
      updatedAt: 100,
      status: "interrupted",
      abortedLastRun: true,
      activeWriterRunId: runId,
      lifecycleRunId: runId,
      delivery: { kind: "internal" },
      ...terminal,
    });
    await migrateLegacyInterruption(sessionKey, state.stateDir);

    expect(await markOrphans({ stateDir: state.stateDir })).toEqual({ marked: 0, skipped: 0 });
    const saved = loadSessionEntry(target);
    expect(saved?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(saved?.mainRestartRecovery).toBeUndefined();
    expect(saved).toMatchObject({
      restartRecoveryTerminalRunIds: ["completed-source", runId],
      restartRecoveryTerminalDeliveryEvidence: [
        expect.objectContaining({ runId: "completed-source", transcriptRunId: runId }),
      ],
    });
  });
});
