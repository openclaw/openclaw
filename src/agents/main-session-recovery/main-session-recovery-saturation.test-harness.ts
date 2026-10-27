import path from "node:path";
import { expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  getQueueSize,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { type SessionEntryFixture, waitForFast } from "../subagent-test-fixtures.test-helpers.js";
import {
  mainSessionEntry,
  makePendingFinalDelivery,
} from "./main-session-restart-recovery-fixture.test-support.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery.js";

type SaturatedRecoveryFixture = {
  tmpDir: string;
  gatewayRuntime: GatewayRecoveryRuntime;
  makeStoreFixture: (
    entries: Record<string, SessionEntryFixture>,
    agentId?: string,
  ) => Promise<{ sessionsDir: string; storePath: string }>;
  writeUserTurn: (sessionsDir: string, text: string, sessionId?: string) => Promise<void>;
};

export function registerSaturatedRestartRecoveryCases(
  getFixture: () => SaturatedRecoveryFixture,
): void {
  it.for(["finish", "stop"] as const)(
    "starts recovery in interruption order across stores and preserves waiting work on %s",
    async (outcome, { signal }) => {
      const { tmpDir, makeStoreFixture, writeUserTurn, gatewayRuntime } = getFixture();
      const cfg = { agents: { entries: { main: {}, worker: {} } } };
      const sessions = Array.from({ length: 8 }, (_, index) => {
        const agentId = index % 2 === 0 ? "worker" : "main";
        return {
          agentId,
          sessionKey: `agent:${agentId}:dashboard:recovery-${7 - index}`,
          entry: mainSessionEntry({
            sessionId: `recovery-${index}`,
            endedAt: index + 1,
            updatedAt: 100 - index,
          }),
        };
      });
      const deliveredKey = "agent:main:dashboard:already-delivered";
      const delivered = mainSessionEntry({
        sessionId: "already-delivered",
        endedAt: 9,
        updatedAt: 9,
        restartRecoveryDeliveryRunId: "recovery-delivered",
        restartRecoveryDeliverySourceRunId: "source-delivered",
        pendingFinalDelivery: makePendingFinalDelivery("finished result", {
          deliveries: [{ id: "settled-delivery", state: "delivered" }],
        }),
      });
      for (const agentId of ["main", "worker"]) {
        const owned = sessions.filter((session) => session.agentId === agentId);
        const { sessionsDir } = await makeStoreFixture(
          {
            ...Object.fromEntries(owned.map(({ sessionKey, entry }) => [sessionKey, entry])),
            ...(agentId === "main" ? { [deliveredKey]: delivered } : {}),
          },
          agentId,
        );
        for (const { entry } of owned) {
          await writeUserTurn(sessionsDir, "finish the interrupted task", entry.sessionId);
        }
      }
      const originalConcurrency = getCommandLaneSnapshot(CommandLane.RestartRecovery).maxConcurrent;
      expect(originalConcurrency).toBe(4);
      const cancellation = new AbortController();
      const gates = sessions.map(() => createDeferred());
      const backgroundStarted = createDeferred();
      const releaseBackground = createDeferred();
      const background = enqueueCommandInLane(CommandLane.Background, async () => {
        backgroundStarted.resolve();
        await releaseBackground.promise;
      });
      await backgroundStarted.promise;
      const started: number[] = [];
      const firstFourStarted = createDeferred();
      let active = 0;
      let peak = 0;
      const runtime: GatewayRecoveryRuntime = {
        ...gatewayRuntime,
        dispatchAgent: <T>(
          request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
          _timeout?: number,
          options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
        ) => {
          const index = sessions.findIndex(({ sessionKey }) => sessionKey === request.sessionKey);
          let executionStarted = false;
          options?.onStartOwner?.({
            observe: () => ({ executionStarted, startDeadlineAtMs: Date.now() + 60_000 }),
            abort: () => false,
          });
          options?.onAccepted?.({ runId: request.idempotencyKey });
          return enqueueCommandInLane(request.lane ?? "main", async () => {
            active++;
            peak = Math.max(peak, active);
            started.push(index);
            executionStarted = true;
            options?.onExecutionStarted?.();
            if (started.length === 4) {
              firstFourStarted.resolve();
            }
            try {
              await gates[index]!.promise;
              return { runId: request.idempotencyKey, status: "ok" } as T;
            } finally {
              active--;
            }
          });
        },
      };
      const recovery = recoverRestartAbortedMainSessions({
        stateDir: tmpDir,
        cfg,
        signal: cancellation.signal,
        shouldContinue: () => !cancellation.signal.aborted,
        gatewayRuntime: runtime,
      });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            firstFourStarted.promise,
            recovery,
            "recovery settled before four interrupted sessions started",
          ),
          signal,
        );
        expect(started).toEqual([0, 1, 2, 3]);
        // Reconciliation must not wait for execution capacity held by long-running tasks.
        await waitForFast(() =>
          expect(
            loadSessionEntry({
              agentId: "main",
              storePath: path.join(tmpDir, "agents", "main", "sessions", "sessions.json"),
              sessionKey: deliveredKey,
            })?.status,
          ).toBe("done"),
        );
        await waitForFast(() => expect(getQueueSize(CommandLane.RestartRecovery)).toBe(5));
        const expectWaitingClaimsUnreserved = () => {
          for (const { agentId, sessionKey } of sessions.slice(4)) {
            const entry = loadSessionEntry({
              agentId,
              storePath: path.join(tmpDir, "agents", agentId, "sessions", "sessions.json"),
              sessionKey,
            });
            expect(entry).toMatchObject({
              status: "interrupted",
              abortedLastRun: true,
              mainRestartRecovery: { chargedAttempts: 0 },
            });
            expect(entry?.mainRestartRecovery).not.toHaveProperty("reservation");
          }
        };
        expectWaitingClaimsUnreserved();
        await expect(enqueueCommandInLane("main", async () => "interactive reply")).resolves.toBe(
          "interactive reply",
        );
        expect(peak).toBe(4);
        if (outcome === "stop") {
          cancellation.abort(new Error("recovery stopped"));
          await expect(recovery).rejects.toThrow("recovery stopped");
          expectWaitingClaimsUnreserved();
        } else {
          for (const gate of gates.slice(0, 4)) {
            gate.resolve();
          }
          await expect(recovery).resolves.toEqual({
            started: 8,
            settled: 1,
            failed: 0,
            skipped: 0,
          });
          expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        }
      } finally {
        cancellation.abort(new Error("recovery test finished"));
        releaseBackground.resolve();
        for (const gate of gates) {
          gate.resolve();
        }
        await Promise.all([background, recovery.catch(() => {})]);
        setCommandLaneConcurrency(CommandLane.RestartRecovery, originalConcurrency);
      }
      expect(started).toEqual(outcome === "finish" ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 1, 2, 3]);
      expect(peak).toBe(4);
    },
  );
}
