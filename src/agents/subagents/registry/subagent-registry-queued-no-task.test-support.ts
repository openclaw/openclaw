import { expect, it, vi } from "vitest";
import { holdQueuedSwarmRun, reserveSwarmRun } from "../swarm/swarm-scheduler.js";
import type { registerQueuedRegistrationClaimCases } from "./subagent-registry-queued-registration-claims.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerQueuedRegistrationNoTaskCases(
  params: Parameters<typeof registerQueuedRegistrationClaimCases>[0],
) {
  const { fixture, createTask } = params;
  it.each(["release", "reacquire", "confirmed Stop publication"] as const)(
    "retains no-task registration through a provisional claim until %s",
    async (transition) => {
      const f = fixture();
      expect(
        reserveSwarmRun({
          groupId: "null-task-claim",
          runId: f.registration.runId,
          maxConcurrent: 1,
          activeRunIds: [],
        }),
      ).toBe(true);
      const reservation = holdQueuedSwarmRun(f.registration.runId);
      if (!reservation) {
        throw new Error("missing original reservation");
      }
      let claim: SubagentRunRecord["killIntent"];
      let reacquired: Promise<void> | undefined;
      createTask.mockImplementation(() => {
        const entry = f.runs.get(f.registration.runId)!;
        claim = f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry });
        expect(claim).toBeDefined();
        if (transition === "reacquire") {
          const observed = f.scope.waitForClaim();
          if (!observed) {
            throw new Error("missing no-task claim waiter");
          }
          reacquired = observed.then(() => {
            claim = f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry });
            expect(claim).toBeDefined();
          });
        }
        return null;
      });
      const completion = f.register();
      let rejected = false;
      const rejection = expect(completion)
        .rejects.toThrow("created no task row")
        .then(() => {
          rejected = true;
        });
      f.writes[0]!.gate.resolve();
      const entry = f.runs.get(f.registration.runId)!;
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(createTask).toHaveBeenCalledOnce();
        expect(rejected).toBe(false);
        expect(reservation.isCurrent()).toBe(true);
        expect(f.scope.canRetireReservation()).toBe(true);
        expect(f.writes).toHaveLength(1);
        expect(f.scope.canCleanupSession()).toBe(false);
        if (!claim) {
          throw new Error("missing original no-task claim");
        }
        if (transition === "confirmed Stop publication") {
          entry.killIntent = undefined;
          entry.killReconciliation = { killedAt: 123 };
          const stopped = (entry.execution = {
            ...entry.execution,
            status: "terminal",
            endedAt: 123,
          });
          f.options.persistOrThrow(entry.runId);
          await rejection;
          expect(entry.execution).toBe(stopped);
          expect(f.writes).toHaveLength(1);
        } else {
          expect(
            f.manager.releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim }),
          ).toBe(true);
          if (reacquired) {
            await reacquired;
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(entry.killIntent).toBe(claim);
            expect(rejected).toBe(false);
            expect(f.writes).toHaveLength(1);
            expect(
              f.manager.releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim }),
            ).toBe(true);
          }
          await vi.waitFor(() => expect(f.writes).toHaveLength(2));
          expect(f.writes[1]!.snapshot.get(entry.runId)).toMatchObject({
            execution: { status: "terminal" },
          });
          expect(f.writes[1]!.snapshot.get(entry.runId)?.queuedLaunch).toBeUndefined();
          expect(entry.execution.status).toBe("queued");
          expect(rejected).toBe(false);
          expect(reservation.isCurrent()).toBe(true);
          f.writes[1]!.gate.resolve();
          await rejection;
          expect(entry.execution.status).toBe("terminal");
        }
        expect(createTask).toHaveBeenCalledOnce();
        expect(vi.mocked(params.finalizer())).not.toHaveBeenCalled();
      } finally {
        const pendingClaim = entry.killIntent;
        if (pendingClaim) {
          f.manager.releaseSubagentRunKillClaim({
            runId: entry.runId,
            expected: entry,
            claim: pendingClaim,
          });
        }
        await reacquired;
        const remainingClaim = entry.killIntent;
        if (remainingClaim) {
          f.manager.releaseSubagentRunKillClaim({
            runId: entry.runId,
            expected: entry,
            claim: remainingClaim,
          });
        }
        f.acknowledgeAllWrites();
        await rejection;
        reservation.withdraw();
        await reservation.release();
      }
    },
  );
}
