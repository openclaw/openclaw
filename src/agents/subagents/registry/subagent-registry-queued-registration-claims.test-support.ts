import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { createCollectorLaunchCallbacks } from "../spawn/subagent-spawn-collector.js";
import { withQueuedRegistrationFixture } from "./subagent-registry-queued-registration.test-support.js";

export function registerQueuedRegistrationClaimCases() {
  it("waits outside row admission for released and reacquired kill claims before settlement", async () => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      const entry = f.current();
      const first = await f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry });
      expect(first).toBeDefined();
      if (!first) {
        throw new Error("Missing kill claim");
      }
      let completed = false;
      const settling = f.track(
        f.scope.settleFailedLaunch("launch failed").then(() => {
          completed = true;
        }),
      );
      expect(f.scope.canLaunch()).toBe(false);
      const released = f.track(
        f.manager.releaseSubagentRunKillClaim({
          runId: entry.runId,
          expected: entry,
          claim: first,
        }),
      );
      const reacquired = f.track(
        f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry }),
      );
      expect(await released).toBe(true);
      const second = await reacquired;
      expect(second).toBeDefined();
      expect(completed).toBe(false);
      expect(f.current().execution.status).toBe("queued");
      if (!second) {
        throw new Error("Missing reacquired claim");
      }
      expect(
        await f.manager.releaseSubagentRunKillClaim({
          runId: entry.runId,
          expected: entry,
          claim: second,
        }),
      ).toBe(true);
      await settling;
      expect(f.current().execution.status).toBe("terminal");
      expect(f.current().killIntent).toBeUndefined();
    });
  });

  it.each(["recovery intent", "terminal"] as const)(
    "retains an unknown %s settlement after a released claim without replay",
    async (stage) => {
      await withQueuedRegistrationFixture(async (f) => {
        await f.register();
        const entry = f.current();
        const claim = await f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry });
        if (!claim) {
          throw new Error("Missing claim");
        }
        const first = f.holdNextWrite();
        const recovery = f.holdNextWrite();
        const terminal = stage === "terminal" ? f.holdNextWrite() : undefined;
        const settling = f.track(f.scope.settleFailedLaunch("launch failed"));
        // Claim release itself is a separate admitted write, so release its ACK before settlement.
        const releasing = f.track(
          f.manager.releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim }),
        );
        await first.entered;
        first.release();
        await releasing;
        await recovery.entered;
        if (terminal) {
          recovery.release();
          await terminal.entered;
          terminal.loseReceipt(
            new SqliteWorkerError("settlement acknowledgement lost", "outcome-unknown"),
          );
        } else {
          recovery.loseReceipt(
            new SqliteWorkerError("settlement acknowledgement lost", "outcome-unknown"),
          );
        }
        const failure = await settling.catch((error: unknown) => error);
        expect(failure).toMatchObject({ cause: "launch failed" });
        const writes = f.writes;
        await expect(f.scope.settleFailedLaunch("repeated failure")).rejects.toBe(failure);
        expect(f.writes).toBe(writes);
        expect(f.scope.canCleanupSession()).toBe(false);
      });
    },
  );

  it.each(
    (["complete", "incomplete", "rejected"] as const).flatMap((cleanupResult) => [
      { cleanupResult, failure: new Error("transport failure"), errorText: "transport failure" },
      { cleanupResult, failure: null, errorText: "error" },
    ]),
  )(
    "retries only durable settlement after $cleanupResult cleanup of $errorText",
    async ({ cleanupResult, failure, errorText }) => {
      await withQueuedRegistrationFixture(async (f) => {
        await f.register();
        const launch = vi.fn(() => {
          const attempt = createDeferred<never>();
          attempt.reject(failure);
          return attempt.promise;
        });
        const cleanup = vi.fn(async () => {
          if (cleanupResult === "rejected") {
            throw new Error("cleanup acknowledgement unknown");
          }
          return {
            attachmentsRemoved: cleanupResult === "complete",
            sessionDeleted: cleanupResult === "complete",
          };
        });
        const rollback = vi.fn(async () => {});
        const callbacks = createCollectorLaunchCallbacks({
          childRunId: f.registration.runId,
          childSessionKey: f.registration.childSessionKey,
          requesterSessionKey: f.registration.requesterSessionKey,
          registrationScope: f.scope,
          preparation: { rollback, dispose: async () => {} },
          provisionalSessionIdentity: {},
          launchChildRun: launch,
          recordParticipant: vi.fn(),
          emitSpawnLifecycleHooks: async () => {},
          cleanupFailedSpawn: cleanup,
        });
        const error = await callbacks.start().catch((launchError: unknown) => launchError);
        const recovery = f.holdNextWrite();
        const terminal = f.holdNextWrite("before");
        const failed = f.track(callbacks.onStartFailure(error));
        await recovery.entered;
        recovery.release();
        await terminal.entered;
        terminal.reject(new Error("terminal refused"));
        await expect(failed).rejects.toThrow("could not be persisted");
        await callbacks.onStartFailure(error);
        expect(launch).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(rollback).toHaveBeenCalledOnce();
        expect(f.current()).toMatchObject({
          execution: {
            status: "terminal",
            outcome: { status: "error", error: errorText },
          },
        });
      });
    },
  );

  it("guards a late claim during failure cleanup without replaying admitted rollback", async () => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      const entry = f.current();
      const entered = createDeferred();
      const release = createDeferred();
      const rollback = vi.fn(async () => {
        entered.resolve();
        await release.promise;
      });
      const effect = vi.fn();
      const callbacks = createCollectorLaunchCallbacks({
        childRunId: entry.runId,
        childSessionKey: entry.childSessionKey,
        requesterSessionKey: entry.requesterSessionKey,
        registrationScope: f.scope,
        preparation: { rollback, dispose: async () => {} },
        provisionalSessionIdentity: {},
        launchChildRun: async () => {
          throw new Error("dispatch refused");
        },
        recordParticipant: vi.fn(),
        emitSpawnLifecycleHooks: async () => {},
        cleanupFailedSpawn: async () => {
          await release.promise;
          const current = f.scope.canCleanupSession();
          if (current) {
            effect();
          }
          return { attachmentsRemoved: current, sessionDeleted: current };
        },
      });
      const pending = f.track(callbacks.start().catch(callbacks.onStartFailure));
      await entered.promise;
      const claim = await f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry });
      if (!claim) {
        throw new Error("Missing late claim");
      }
      expect(f.scope.canCleanupSession()).toBe(false);
      release.resolve();
      expect(effect).not.toHaveBeenCalled();
      await f.manager.releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim });
      await pending;
      expect(rollback).toHaveBeenCalledOnce();
      expect(f.current().execution.status).toBe("terminal");
    });
  });
}
