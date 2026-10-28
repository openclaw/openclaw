import path from "node:path";
import { assert, expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/io.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { createSessionGoalFixture } from "../../gateway/session-goal.test-support.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { finishAgentCommandCleanup } from "../command/cleanup.js";
import { markStartupOrphanedMainSessionsForRecovery as markOrphans } from "./main-session-restart-recovery-marking.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";

it("does not replay a terminally failed legacy pending final on the next boot", async () => {
  await withOpenClawTestState({ label: "legacy-final-terminal" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    using warnings = vi.spyOn(mainSessionRecoveryLog, "warn");
    const target = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const pending = {
      kind: "replayable" as const,
      text: "The saved answer is still available.",
      createdAt: 100,
      context: { channel: "telegram", to: "123" },
    };
    await replaceSessionEntry(target, {
      sessionId: "legacy-final-session",
      updatedAt: 100,
      status: "failed",
      abortedLastRun: false,
      pendingFinalDelivery: pending,
    });
    const dispatch = vi.fn(async (request: Record<string, unknown>) => ({
      runId: String(request.idempotencyKey),
      status: "error",
      error: "synthetic terminal provider rejection",
    }));
    const unexpectedCall = async (): Promise<never> => {
      throw new Error("terminal recovery must not wait or deliver");
    };
    const gatewayRuntime: GatewayRecoveryRuntime = {
      prepareRestartRecovery: () => undefined,
      prepareFailedWorkerPlacement: async () => undefined,
      dispatchAgent: async <T>(request: Record<string, unknown>) => (await dispatch(request)) as T,
      dispatchSessionMethod: unexpectedCall,
      waitForAgent: unexpectedCall,
      sendRecoveryNotice: unexpectedCall,
      resumeChatInput: unexpectedCall,
    };
    const boot = async () => {
      await markOrphans({ stateDir: state.stateDir });
      return await recoverStore({
        ...target,
        stateDir: state.stateDir,
        gatewayRuntime,
        handledSessionKeys: new Set(),
      });
    };
    expect(await boot(), JSON.stringify(warnings.mock.calls)).toMatchObject({
      settled: 1,
      failed: 0,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    await boot();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(loadSessionEntry(target)).toMatchObject({
      sessionId: "legacy-final-session",
      status: "failed",
      abortedLastRun: false,
    });
    expect(loadSessionEntry(target)?.pendingFinalDelivery).toBeUndefined();
    const transcript = JSON.stringify(
      await loadTranscriptEvents({ ...target, sessionId: "legacy-final-session" }),
    );
    expect(transcript).toContain("Saved reply (delivery unconfirmed)");
    expect(transcript).toContain(pending.text);
  });
});

it.each(["none", "local", "channel", "channel-suppressed"] as const)(
  "records a failed worker placement once across two restarts (saved final=%s)",
  async (savedFinal) => {
    await withOpenClawTestState({ label: "failed-placement-recovery" }, async (state) => {
      await captureRuntimeConfigAsyncReader()();
      using info = vi.spyOn(mainSessionRecoveryLog, "info");
      const channel = savedFinal.startsWith("channel");
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:failed-worker",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const reason = "Worker setup failed. Use Stop cloud worker to finish cleanup, then retry.";
      await replaceSessionEntry(target, {
        sessionId: "failed-worker-session",
        updatedAt: 100,
        status: savedFinal !== "none" ? "failed" : "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: "failed-placement-cycle", revision: 1, chargedAttempts: 0 },
        goal: createSessionGoalFixture("placement-goal", "Finish the worker task"),
        ...(savedFinal !== "none"
          ? {
              pendingFinalDelivery: {
                kind: "replayable" as const,
                text: "Retained answer",
                createdAt: 100,
                ...(channel ? { context: { channel: "telegram", to: "synthetic-recipient" } } : {}),
              },
            }
          : {}),
      });
      const dispatch = vi.fn(async () => ({
        status: "error",
        error: "Worker turn rejected in placement failed",
      }));
      const unexpectedCall = async (): Promise<never> => {
        throw new Error("failed placement recovery must not wait or deliver");
      };
      const release = vi.fn();
      const sendRecoveryNotice = vi.fn<GatewayRecoveryRuntime["sendRecoveryNotice"]>(async () => ({
        suppressed: savedFinal === "channel-suppressed",
      }));
      const gatewayRuntime: GatewayRecoveryRuntime = {
        prepareRestartRecovery: () => undefined,
        prepareFailedWorkerPlacement: async () => ({ reason, isCurrent: () => true, release }),
        dispatchAgent: async <T>() => (await dispatch()) as T,
        dispatchSessionMethod: unexpectedCall,
        waitForAgent: unexpectedCall,
        sendRecoveryNotice,
        resumeChatInput: unexpectedCall,
      };
      for (let boot = 0; boot < 2; boot++) {
        await markOrphans({ stateDir: state.stateDir });
        await recoverStore({
          ...target,
          stateDir: state.stateDir,
          gatewayRuntime,
          handledSessionKeys: new Set(),
        });
        expect(dispatch).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)).toMatchObject({
          sessionId: "failed-worker-session",
          status: "failed",
          abortedLastRun: false,
          mainRestartRecovery: { tombstone: { reason } },
          goal: {
            id: "placement-goal",
            status: "paused",
            lastStatusNote: expect.stringContaining(reason),
          },
        });
      }
      expect(release).toHaveBeenCalledOnce();
      expect(sendRecoveryNotice).toHaveBeenCalledTimes(channel ? 1 : 0);
      const records = await loadTranscriptEvents({ ...target, sessionId: "failed-worker-session" });
      const transcript = JSON.stringify(records);
      expect(transcript.split(reason)).toHaveLength(2);
      expect(loadSessionEntry(target)?.pendingFinalDelivery).toBeUndefined();
      if (savedFinal !== "none") {
        expect(transcript).toContain("Saved reply (delivery unconfirmed)");
        expect(transcript).toContain("Retained answer");
      }
      if (channel) {
        const sent = sendRecoveryNotice.mock.calls[0]?.[0];
        assert(sent);
        const local = records
          .map(readTranscriptEventMessage)
          .find((message) => message?.idempotencyKey === sent.idempotencyKey);
        expect(local).toMatchObject({
          content: [
            { type: "text", text: sent.text },
            { type: "text", text: "\nSaved reply (delivery unconfirmed):\nRetained answer" },
          ],
          openclawDeliveryMirror: { noticeId: sent.idempotencyKey, noticePart: 0 },
        });
        expect(sent.text).not.toContain("Retained answer");
        expect(sent).toMatchObject({
          generation: { ...target, sessionId: "failed-worker-session", lifecycleRevision: null },
          provenance: {
            kind: "recovery-notice",
            noticeId: sent.idempotencyKey,
            localNotice: { entryId: expect.any(String), rawSeq: expect.any(Number) },
          },
        });
        expect(info).toHaveBeenCalledWith(
          expect.stringContaining(
            savedFinal === "channel-suppressed"
              ? "did not send restart recovery tombstone notice"
              : "sent restart recovery tombstone notice",
          ),
        );
      }
    });
  },
);

it("retires only the failed command's legacy final and retains terminal delivery evidence", async () => {
  await withOpenClawTestState({ label: "legacy-final-cleanup" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    for (const scenario of ["failed", "foreground", "replaced", "identified", "restart"] as const) {
      const target = {
        agentId: "main",
        sessionKey: `agent:main:cleanup-${scenario}`,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const runId = `recovery-${scenario}`;
      const pending: SessionEntry["pendingFinalDelivery"] = {
        kind: "replayable",
        text: "Saved answer before the terminal failure.",
        createdAt: 100,
        ...(scenario === "identified" ? { intentId: "owned-delivery" } : {}),
      };
      const currentPending =
        scenario === "replaced"
          ? { ...pending, text: "Newer saved answer.", createdAt: 200 }
          : pending;
      const entry: SessionEntry = {
        sessionId: `cleanup-${scenario}`,
        updatedAt: 100,
        status: "failed",
        abortedLastRun: scenario === "restart",
        lifecycleRunId: runId,
        restartRecoveryDeliveryRunId: runId,
        restartRecoveryDeliverySourceRunId: "original-source",
        restartRecoveryRuns: [{ runId, lifecycleGeneration }],
        pendingFinalDelivery: currentPending,
        ...(scenario === "foreground"
          ? {
              mainRestartRecovery: {
                cycleId: "queued-cycle",
                revision: 1,
                chargedAttempts: 1,
                foregroundClaims: { lifecycleGeneration, tokens: ["queued-foreground"] },
              },
            }
          : {}),
      };
      await replaceSessionEntry(target, entry);
      const beforeCleanup = loadSessionEntry(target);
      await finishAgentCommandCleanup({
        prepared: {
          ...target,
          runId,
          sessionAgentId: target.agentId,
          sessionStore: { [target.sessionKey]: entry },
        },
        sessionEntry: entry,
        runOwnedSessionId: entry.sessionId,
        sessionReboundDuringRun: false,
        trackedRestartRecoveryDeliveryClaim: true,
        pendingFinalRecovery: pending,
        terminalDeliveryEvidence: { captured: true, meta: { error: true } },
        terminalEvent: {
          data:
            scenario === "restart"
              ? { phase: "end", aborted: true, stopReason: "restart" }
              : { phase: "error", error: "synthetic provider failure" },
        },
        lifecycleGeneration,
        beforeTerminalDelivery: undefined,
        reportCommitted: () => {},
        preparedRunAdmission: undefined,
        sessionWorkAdmission: undefined,
        cleanupInternalModelRunTargets: async () => {},
        releaseForeground: undefined,
      });
      const settled = loadSessionEntry(target);
      expect(settled?.pendingFinalDelivery, scenario).toEqual(
        scenario === "failed" || scenario === "foreground" ? undefined : currentPending,
      );
      if (scenario === "foreground") {
        expect(settled?.mainRestartRecovery).toEqual(beforeCleanup?.mainRestartRecovery);
        expect(settled?.restartRecoveryTerminalRunIds).toContain(runId);
      }
      if (scenario === "restart") {
        expect(settled).toEqual(beforeCleanup);
      } else {
        expect(settled?.restartRecoveryTerminalDeliveryEvidence, scenario).toContainEqual({
          runId: "original-source",
          transcriptRunId: runId,
          captured: true,
          meta: { error: true },
        });
      }
    }
  });
});
