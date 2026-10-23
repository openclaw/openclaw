import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  createDeliveredWake,
  observeSubagentRequesterWake,
  prepareSubagentRecoveryFixture,
} from "./subagent-registry.persistence.test-support.js";

type WakeParams = Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0];
type WakeState = WakeParams["settledEntry"]["requesterSettleWake"];

export function registerStaleRequesterWakeBatchTests({
  getModules,
  withRegistryState,
  settleOwnedWork,
}: {
  getModules: () => {
    mod: typeof import("./subagent-registry.test-helpers.js");
    requesterSettleModule: typeof import("../announce/subagent-announce.requester-settle-wake.js");
    bindGatewayContextResolver: typeof import("../../../plugins/runtime/gateway-request-scope.js").bindGatewayContextResolver;
  };
  withRegistryState: (run: (stateDir: string) => Promise<void>) => Promise<void>;
  settleOwnedWork: () => Promise<void> | undefined;
}) {
  it.each(["transition", "completion", "rejection", "closed-empty"] as const)(
    "rejects the whole stale batch when only a sibling closes or is replaced: %s",
    async (settlement) => {
      const { mod, requesterSettleModule, bindGatewayContextResolver } = getModules();
      const readPersistedRun = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);
      const expectWake = (runId: string, expected: WakeState) => {
        expect(mod.getSubagentRunByRunId(runId)?.requesterSettleWake).toEqual(expected);
        expect(readPersistedRun(runId)?.requesterSettleWake).toEqual(expected);
      };
      const oldDone = createDeferredCore<boolean>();
      let oldParams: WakeParams | undefined;
      let siblingGatewayOpen = true;
      const anchorGateway = {
        resolveGatewayContext: () => anchorGateway as never,
      };
      const nextGateway = {
        resolveGatewayContext: () => nextGateway as never,
      };
      vi.useFakeTimers();
      try {
        await withRegistryState(async (stateDir) => {
          try {
            const batch = ["run-batch-anchor", "run-batch-sibling"].map((runId, index) =>
              createDeliveredWake(runId, {
                status: "pending",
                attemptCount: 0,
                batchRunIds: ["run-batch-anchor", "run-batch-sibling"],
                rearmGeneration: 1,
                ...(index === 1 ? { nextAttemptAt: Date.now() + 30_000 } : {}),
              }),
            );
            for (const run of batch) {
              await prepareSubagentRecoveryFixture(run, { stateDir });
            }
            const { run: wakeRequester, waitForCalls } = observeSubagentRequesterWake((params) => {
              oldParams ??= params;
              return oldDone.promise;
            });
            vi.spyOn(
              requesterSettleModule,
              "maybeWakeRequesterAfterAllChildrenSettled",
            ).mockImplementation(wakeRequester);
            saveSubagentRegistryToSqlite(new Map(batch.map((entry) => [entry.runId, entry])));
            await mod.initSubagentRegistry();
            const anchor = mod.getSubagentRunByRunId("run-batch-anchor")!;
            const sibling = mod.getSubagentRunByRunId("run-batch-sibling")!;
            bindGatewayContextResolver(anchor, () => anchorGateway as never);
            bindGatewayContextResolver(sibling, () =>
              siblingGatewayOpen ? (anchorGateway as never) : undefined,
            );
            await mod.activateSubagentRegistry(() => anchorGateway as never).settled;
            await waitForCalls(1);
            expect(wakeRequester).toHaveBeenCalledOnce();
            expect(oldParams?.settledEntry).toBe(anchor);

            siblingGatewayOpen = false;
            const beforeActivation = settlement.startsWith("closed-");
            if (!beforeActivation) {
              await mod.activateSubagentRegistry(() => nextGateway as never).settled;
            }
            const replacement = mod.getSubagentRunByRunId(sibling.runId)!;
            expect(mod.getSubagentRunByRunId(anchor.runId)).toBe(anchor);
            expect(replacement === sibling).toBe(beforeActivation);
            const expected = [anchor, replacement].map((entry) =>
              structuredClone(entry.requesterSettleWake),
            );
            if (settlement.endsWith("transition")) {
              await oldParams!.transitionBatch(
                [anchor, sibling],
                { ...expected[0]!, attemptCount: 99 },
                () => {},
              );
            } else if (settlement === "rejection") {
              oldDone.reject(new Error("old mixed-owner dispatch failed"));
              await vi.advanceTimersByTimeAsync(0);
            } else {
              await oldParams!.completeBatch([anchor, sibling], 1);
            }
            [anchor, replacement].forEach((entry, index) =>
              expectWake(entry.runId, expected[index]),
            );
            if (settlement === "completion" || settlement === "closed-empty") {
              oldDone.resolve(false);
              await settleOwnedWork();
              if (beforeActivation) {
                await mod.activateSubagentRegistry(() => nextGateway as never).settled;
                await settleOwnedWork();
              }
              // The old no-wake decision must not clear only the surviving member
              // when a deferred commit crosses its first retry deadline.
              await vi.advanceTimersByTimeAsync(30_000);
              await settleOwnedWork();
              expectWake(anchor.runId, expected[0]);

              // Explicit resumption evaluates the surviving obligation before the next recovery sweep.
              mod.resumeSubagentRun(anchor.runId);
              await settleOwnedWork();
              const freshParams = wakeRequester.mock.calls.findLast(
                ([params]) => params.settledEntry === anchor,
              )?.[0];
              expect(freshParams).toBeDefined();
              expect(freshParams).not.toBe(oldParams);
              await freshParams!.completeBatch([anchor], 1);
              expectWake(anchor.runId, undefined);
              expect(readPersistedRun(sibling.runId)?.requesterSettleWake).toEqual(expected[1]);
            }
          } finally {
            oldDone.resolve(false);
            await vi.advanceTimersByTimeAsync(0);
          }
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );
}
