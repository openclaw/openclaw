import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { createCollectorLaunchCallbacks } from "../spawn/subagent-spawn-collector.js";
import {
  withQueuedRegistrationFixture,
  type QueuedRegistrationFixture,
} from "./subagent-registry-queued-registration.test-support.js";

function killControls(f: QueuedRegistrationFixture) {
  const expected = f.current();
  const request = { runId: expected.runId, expected };
  return {
    claim: async () => expectDefined(await f.manager.claimSubagentRunKill(request), "kill claim"),
    release: (claim: NonNullable<Awaited<ReturnType<typeof f.manager.claimSubagentRunKill>>>) =>
      f.manager.releaseSubagentRunKillClaim({ ...request, claim }),
  };
}
type Collector = Parameters<typeof createCollectorLaunchCallbacks>[0];
function collector(
  f: QueuedRegistrationFixture,
  rollback: NonNullable<Collector["preparation"]>["rollback"],
  cleanupFailedSpawn: Collector["cleanupFailedSpawn"],
  launchChildRun: Collector["launchChildRun"] = async () => {
    throw new Error("dispatch refused");
  },
) {
  const { runId: childRunId, childSessionKey, requesterSessionKey } = f.registration;
  return createCollectorLaunchCallbacks({
    childRunId,
    childSessionKey,
    requesterSessionKey,
    registrationScope: f.scope,
    preparation: { rollback, dispose: async () => {} },
    provisionalSessionIdentity: {},
    launchChildRun,
    cleanupFailedSpawn,
    recordParticipant: vi.fn(),
    emitSpawnLifecycleHooks: async () => {},
  });
}

export function registerQueuedRegistrationClaimCases() {
  it("waits outside row admission for released and reacquired kill claims before settlement", async () => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      const kill = killControls(f);
      const first = await kill.claim();
      let completed = false;
      const settling = f.track(
        f.scope.settleFailedLaunch("launch failed").then(() => {
          completed = true;
        }),
      );
      expect(f.scope.canLaunch()).toBe(false);
      const released = f.track(kill.release(first));
      const reacquired = f.track(kill.claim());
      expect(await released).toBe(true);
      const second = await reacquired;
      expect(completed).toBe(false);
      expect(f.current().execution.status).toBe("queued");
      expect(await kill.release(second)).toBe(true);
      await settling;
      expect(f.current().execution.status).toBe("terminal");
      expect(f.current().killIntent).toBeUndefined();
    });
  });

  it("retains an unknown terminal settlement after a released claim without replay", async () => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      const kill = killControls(f);
      const claim = await kill.claim();
      const releaseAck = f.holdNextWrite();
      const terminal = f.holdNextWrite();
      const settling = f.track(f.scope.settleFailedLaunch("launch failed"));
      const releasing = f.track(kill.release(claim));
      await releaseAck.entered;
      releaseAck.release();
      await releasing;
      await terminal.entered;
      terminal.loseReceipt(
        new SqliteWorkerError("settlement acknowledgement lost", "outcome-unknown"),
      );
      const failure = await settling.catch((error: unknown) => error);
      expect(failure).toMatchObject({ cause: "launch failed" });
      const writes = f.writes;
      await expect(f.scope.settleFailedLaunch("repeated failure")).rejects.toBe(failure);
      expect(f.writes).toBe(writes);
      expect(f.scope.canCleanupSession()).toBe(false);
    });
  });

  it("retries only durable settlement after complete cleanup of error", async () => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      const launch = vi.fn(() => {
        const attempt = createDeferred<never>();
        attempt.reject(null);
        return attempt.promise;
      });
      const cleanup = vi.fn(async () => ({ attachmentsRemoved: true, sessionDeleted: true }));
      const rollback = vi.fn(async () => {});
      const callbacks = collector(f, rollback, cleanup, launch);
      const error = await callbacks.start().catch((launchError: unknown) => launchError);
      const terminal = f.holdNextWrite("before");
      const failed = f.track(callbacks.onStartFailure(error));
      await terminal.entered;
      terminal.reject(new Error("terminal refused"));
      await expect(failed).rejects.toThrow("could not be persisted");
      await callbacks.onStartFailure(error);
      expect(launch).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(rollback).toHaveBeenCalledOnce();
      expect(f.current().execution).toMatchObject({
        status: "terminal",
        outcome: { status: "error", error: "error" },
      });
    });
  });

  it("guards a late claim during failure cleanup without replaying admitted rollback", async () => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      const kill = killControls(f);
      const entered = createDeferred();
      const release = createDeferred();
      const rollback = vi.fn(async () => {
        entered.resolve();
        await release.promise;
      });
      const effect = vi.fn();
      const callbacks = collector(f, rollback, async () => {
        await release.promise;
        const current = f.scope.canCleanupSession();
        if (current) {
          effect();
        }
        return { attachmentsRemoved: current, sessionDeleted: current };
      });
      const pending = f.track(callbacks.start().catch(callbacks.onStartFailure));
      await entered.promise;
      const claim = await kill.claim();
      expect(f.scope.canCleanupSession()).toBe(false);
      release.resolve();
      expect(effect).not.toHaveBeenCalled();
      await kill.release(claim);
      await pending;
      expect(rollback).toHaveBeenCalledOnce();
      expect(f.current().execution.status).toBe("terminal");
    });
  });
}
