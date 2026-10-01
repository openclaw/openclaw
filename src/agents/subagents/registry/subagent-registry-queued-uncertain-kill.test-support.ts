import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db-cache.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-persistence.js";
import { withQueuedRegistrationFixture } from "./subagent-registry-queued-registration.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

export function registerQueuedUnknownKillAuthorityTest() {
  it("fences uncertain kill rows until canonical restore without blocking unrelated registration", async () => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      const entry = f.current();
      const ack = f.holdNextWrite();
      const killing = f.track(
        f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry }),
      );
      await ack.entered;
      ack.loseReceipt(new SqliteWorkerError("Kill acknowledgement lost", "outcome-unknown"));
      await expect(killing).rejects.toMatchObject({ outcome: "unknown" });
      expect(f.current().killIntent).toBeUndefined();
      expect(f.stored()?.killIntent).toBeDefined();
      expect([f.scope.canLaunch(), f.scope.canAcceptLaunch(), f.scope.canCleanupSession()]).toEqual(
        [false, false, false],
      );
      const unrelated = {
        ...f.registration,
        runId: "unrelated",
        childSessionKey: "agent:main:subagent:unrelated",
      };
      await f.manager.registerSubagentRun(unrelated);
      expect(f.runs.get(unrelated.runId)?.queuedLaunch).toBeDefined();
      await closeOpenClawStateDatabaseAsync();
      await expect(
        mutateSubagentRuns([entry.runId], () => ({ value: true }), { runs: f.runs }),
      ).rejects.toMatchObject({ outcome: "unknown" });
      await restoreSubagentRunsFromDisk({ runs: f.runs });
      expect(f.current().killIntent).toBeDefined();
      await expect(
        mutateSubagentRuns([entry.runId], () => ({ value: true }), { runs: f.runs }),
      ).resolves.toBe(true);
      expect(f.runs.get(unrelated.runId)?.execution.status).toBe("queued");
    });
  });

  it("restores an uncertain accepted address with its original runtime and completion custody", async () => {
    await withQueuedRegistrationFixture(async (f) => {
      expect(f.runs.size).toBe(0);
      const context = createContext();
      const resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
      const client = createOperatorClient({
        profileName: "collector-rekey",
        scopes: ["operator.write"],
      });
      const completion = await withPluginRuntimeGatewayRequestScope(
        { client, context, resolveGatewayContext, isWebchatConnect: () => false },
        () => captureOperatorToolGatewayContinuationContext(),
      );
      if (!completion?.operatorAuthority) {
        throw new Error("Expected captured operator completion custody");
      }
      f.registration.gatewayContextResolver = resolveGatewayContext;
      await f.register();
      const original = f.current();
      const runtimeKey = getSubagentRunRuntimeKey(original);
      subagentRuns.bindCompletionAuthority(original, completion);
      const retirement = subagentRuns.captureRetirement(
        original,
        (candidate) => candidate.runId !== original.runId,
      );
      const ack = f.holdNextWrite();
      const acceptedId = "accepted-after-unknown-ack";
      const accepting = f.track(f.manager.startQueuedSubagentRun(original.runId, acceptedId));
      try {
        await awaitGateBeforeSettlement(
          ack.entered,
          accepting,
          "Accepted rekey did not reach native ACK",
        );
        expect(loadSubagentRegistryFromSqlite().has(original.runId)).toBe(false);
        expect(loadSubagentRegistryFromSqlite().get(acceptedId)?.queuedLaunch).toBeUndefined();
        ack.loseReceipt(new SqliteWorkerError("Accepted address receipt lost", "outcome-unknown"));
        await expect(accepting).rejects.toMatchObject({ outcome: "unknown" });
        expect(f.runs.get(original.runId)).toBe(original);
        expect(f.runs.has(acceptedId)).toBe(false);
        const plan = vi.fn(() => ({ value: true }));
        for (const id of [original.runId, acceptedId]) {
          await expect(mutateSubagentRuns([id], plan, { runs: f.runs })).rejects.toMatchObject({
            outcome: "unknown",
          });
        }
        expect(plan).not.toHaveBeenCalled();
        await restoreSubagentRunsFromDisk({ runs: f.runs });
        const accepted = f.runs.get(acceptedId);
        if (!accepted) {
          throw new Error("Canonical accepted row was not restored");
        }
        expect(f.runs.has(original.runId)).toBe(false);
        expect(accepted).toMatchObject({
          swarmRunId: original.runId,
          taskRunId: original.taskRunId,
          execution: { status: "running" },
        });
        expect(accepted.queuedLaunch).toBeUndefined();
        expect(getSubagentRunRuntimeKey(accepted)).toBe(runtimeKey);
        expect(getCurrentSubagentRunOwner(f.runs, original)).toBe(accepted);
        expect(retirement.observation).toMatchObject({
          state: "selected",
          entry: { runId: acceptedId },
        });
        expect(retirement.observation.entry).toBe(accepted);
        expect(f.scope.canAcceptLaunch()).toBe(true);
        const readCompletionSource = () =>
          getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority?.source;
        expect(subagentRuns.runWithCompletionAuthority(original, readCompletionSource)).toBe(
          completion.operatorAuthority.source,
        );
        expect(subagentRuns.runWithCompletionBatchAuthority([original], readCompletionSource)).toBe(
          completion.operatorAuthority.source,
        );
        await expect(
          mutateSubagentRuns([original.runId, acceptedId], () => ({ value: true }), {
            runs: f.runs,
          }),
        ).resolves.toBe(true);
        const unrelated = structuredClone(accepted);
        await mutateSubagentRuns(
          [acceptedId],
          () => ({ value: undefined, postimages: new Map([[acceptedId, null]]) }),
          { runs: f.runs },
        );
        await mutateSubagentRuns(
          [acceptedId],
          () => ({ value: undefined, postimages: new Map([[acceptedId, unrelated]]) }),
          { runs: f.runs },
        );
        expect(isSameSubagentRunOwner(f.runs.get(acceptedId), original)).toBe(false);
        expect(getCurrentSubagentRunOwner(f.runs, original)).toBeUndefined();
      } finally {
        ack.release();
        await Promise.allSettled([accepting]);
        retirement.release();
        subagentRuns.releaseCompletionAuthority(original);
        completion.release();
      }
    }, subagentRuns);
  });
}
