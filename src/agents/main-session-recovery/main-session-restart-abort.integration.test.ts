import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { callGateway } from "../../gateway/call.js";
import { buildRestartSafeChatTranscriptState } from "../../gateway/server-methods/chat-restart-recovery.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { clearCommandRecoveryClaim } from "../command/cleanup.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";
import {
  codeModeCheckpointMessage,
  codeModeWaitCallMessage,
  makeUserMessage,
} from "./main-session-restart-recovery-transcript.test-support.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
  recoverRestartAbortedMainSessions,
} from "./main-session-restart-recovery.js";

vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: vi.fn(async () => ({ runId: "resumed-chat-run" })),
}));

it.each(["before settlement", "after settlement", "persisted interruption"] as const)(
  "resumes restart-safe Control UI work when shutdown marking runs %s",
  async (order) => {
    await withOpenClawTestState({ label: "restart-aborted-chat" }, async (state) => {
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
        admission: { requestFingerprint: "synthetic-request" },
        clientRunId: runId,
        startedAt: 100,
      });
      const entry: SessionEntry = {
        sessionId,
        updatedAt: 100,
        permissionMode: "guarded",
        delivery: { kind: "internal" },
        spawnDepth: 0,
        ...admitted.sessionLifecyclePatch,
        activeWriterRunId: runId,
      };
      if (order === "persisted interruption") {
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
        await appendTranscriptMessage(
          { ...target, sessionId },
          { cwd: state.workspaceDir, message },
        );
      }
      const mark = (isActive: boolean) =>
        markRestartAbortedMainSessions({
          resolveGatewayContext: () => undefined,
          stateDir: state.stateDir,
          activeRuns: [{ sessionKey, sessionId, runId, lifecycleGeneration }],
          isActiveRun: () => isActive,
        });
      if (order !== "persisted interruption") {
        if (order === "before settlement") {
          await mark(true);
        }
        const error = createAgentRunRestartAbortError();
        // The command's finally can finish before the Gateway's queued lifecycle
        // publication and shutdown discovery; its outer signal need not be aborted.
        const cleanup = {
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
          terminalEvent: { data: { phase: "error", error, stopReason: "restart" } },
        };
        await clearCommandRecoveryClaim(cleanup);
        await persistGatewaySessionLifecycleEvent({
          sessionKey,
          event: {
            runId,
            sessionId,
            lifecycleGeneration,
            ts: 200,
            data: { phase: "error", error, aborted: true, stopReason: "restart" },
          },
        });
        if (order === "after settlement") {
          expect(await mark(false)).toEqual({ marked: 0, skipped: 0 });
        }
        const interrupted = loadSessionEntry(target);
        expect.soft(interrupted).toMatchObject({
          status: "running",
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
      try {
        if (order === "persisted interruption") {
          const info = vi.spyOn(mainSessionRecoveryLog, "info");
          try {
            await markStartupOrphanedMainSessionsForRecovery({
              stateDir: state.stateDir,
              activeSessionIds: [sessionId],
            });
            expect(
              await recoverRestartAbortedMainSessions({
                stateDir: state.stateDir,
                activeSessionIds: [sessionId],
                gatewayRuntime: runtime,
              }),
            ).toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });
            expect(dispatch).not.toHaveBeenCalled();
            expect(loadSessionEntry(target)?.restartRecoveryTerminalRunIds).toContain(runId);
            expect(info).toHaveBeenCalledWith(
              expect.stringContaining(
                "main-session restart recovery startup complete: started=0 settled=0 failed=0 skipped=1 skipReasons=live_owner:1",
              ),
            );
          } finally {
            info.mockRestore();
          }
        }
        await markStartupOrphanedMainSessionsForRecovery({ stateDir: state.stateDir });
        const result = await recoverRestartAbortedMainSessions({
          stateDir: state.stateDir,
          gatewayRuntime: runtime,
        });
        expect(result).toMatchObject({ started: 1, failed: 0, skipped: 0 });
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "agent",
            params: expect.objectContaining({
              sessionKey,
              forceRestartSafeTools: true,
            }),
          }),
        );
        expect(loadSessionEntry(target)).toMatchObject({
          abortedLastRun: false,
          lifecycleRunId: expect.any(String),
          restartRecoveryDeliverySourceRunId: runId,
          mainRestartRecovery: expect.objectContaining({ chargedAttempts: 1 }),
        });
        expect(loadSessionEntry(target)?.restartRecoveryTerminalRunIds ?? []).not.toContain(runId);
        if (order === "persisted interruption") {
          expect(loadSessionEntry(target)?.restartRecoveryTerminalRunIds).toEqual([
            "previous-completed-run",
          ]);
        }
      } finally {
        dispatchSettlement.resolve();
      }
    });
  },
);

it("preserves a terminal receipt recorded under the interrupted continuation's source", async () => {
  await withOpenClawTestState({ label: "restart-terminal-receipt" }, async (state) => {
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
      status: "running",
      abortedLastRun: true,
      activeWriterRunId: runId,
      lifecycleRunId: runId,
      delivery: { kind: "internal" },
      ...terminal,
    });

    expect(await markStartupOrphanedMainSessionsForRecovery({ stateDir: state.stateDir })).toEqual({
      marked: 0,
      skipped: 0,
    });
    const saved = loadSessionEntry(target);
    expect(saved).toMatchObject({
      restartRecoveryTerminalRunIds: ["completed-source", runId],
      restartRecoveryTerminalDeliveryEvidence: [
        expect.objectContaining({ runId: "completed-source", transcriptRunId: runId }),
      ],
    });
    expect(saved?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(saved?.mainRestartRecovery).toBeUndefined();
  });
});
