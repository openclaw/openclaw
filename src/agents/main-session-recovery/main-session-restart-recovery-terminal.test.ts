import path from "node:path";
import { expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/io.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
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
