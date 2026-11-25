import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { prepareRestartCompletionCustody } from "../../../gateway/session-restart-resume-custody.js";
import { prepareRestartStores } from "../../../gateway/session-restart-resume-discovery.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { ensureGatewayOwnerProfile } from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import type { deliverSubagentAnnouncement } from "../announce/subagent-announce-delivery.js";
import { visibleCompletion } from "../announce/subagent-announce-fixtures.test-support.js";
import {
  createRequesterSettleContext,
  deliver,
  loadRequester,
  registryRead,
  readDescendantFacts,
  requesterSnapshot,
  useRequesterSettleDispatchFixture,
} from "../announce/subagent-announce.requester-settle-dispatch.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { createLifecycleControllerFixture } from "./subagent-registry-lifecycle-controller.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-persistence.js";
import { createSubagentSweeperHarness } from "./subagent-registry-sweeper.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";

useRequesterSettleDispatchFixture();

it("settles ready results from overlapping yielded batches without consuming message waits", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const descendants = await vi.importActual<
      typeof import("../announce/subagent-announce.requester-settle-descendants.js")
    >("../announce/subagent-announce.requester-settle-descendants.js");
    readDescendantFacts.mockImplementation((params) =>
      descendants.createRequesterDescendantReader(params)(),
    );
    const person = ensureGatewayOwnerProfile("Synthetic batch requester");
    const target = {
      agentId: "main",
      physicalAgentId: "main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    const sessionKey = "agent:main:main";
    const now = Date.now();
    const requester = {
      sessionId: "requester-session",
      lifecycleRevision: "requester-revision",
      updatedAt: now - 9.5 * 60 * 60_000,
      status: "done" as const,
      abortedLastRun: false,
      createdActor: { type: "human" as const, source: "profile" as const, id: person.id },
    };
    replaceSessionEntrySync({ ...target, sessionKey }, requester);
    loadRequester.mockResolvedValue(
      requesterSnapshot({}, requester, { sessionKey, storePath: target.storePath }),
    );
    const id = (index: number) => `owed-${index}`;
    const pausedIds = Array.from({ length: 9 }, (_, index) => id(59 + index));
    const batches = [0, 20, 35].map((start) =>
      Array.from({ length: 24 }, (_, index) => id(start + index)).concat(pausedIds),
    );
    const rows = Array.from({ length: 89 }, (_, index) => {
      const paused = index >= 59 && index < 68;
      const killed = index === 58;
      const member = index < 68;
      const outcome =
        index < 38 || !member
          ? { status: "ok" as const }
          : { status: "error" as const, error: killed ? "killed" : "Synthetic child error" };
      return createSubagentRunRecord({
        runId: id(index),
        childSessionKey: `agent:main:subagent:${id(index)}`,
        childSessionIdentity: {
          sessionId: `child-${index}`,
          lifecycleRevision: `revision-${index}`,
        },
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterStorePath: target.storePath,
        completionRequesterSessionId: requester.sessionId,
        completionRequesterLifecycleRevision: requester.lifecycleRevision,
        createdAt: now - 24 * 60 * 60_000 + index * 60_000,
        execution: {
          status: "terminal",
          startedAt: now - 20 * 60 * 60_000,
          endedAt: now - 10 * 60 * 60_000,
          ...(paused ? {} : { outcome }),
        },
        ...(paused
          ? { pauseReason: "sessions_yield", waitForMessage: true, cleanupHandled: false }
          : {
              endedReason: killed
                ? "subagent-killed"
                : index < 38 || !member
                  ? "subagent-complete"
                  : "subagent-error",
            }),
        expectsCompletionMessage: true,
        cleanup: "keep",
        spawnMode: "session",
        completion: paused ? { required: true } : visibleCompletion(`Saved result ${index}`),
        delivery: {
          status: index < 11 || !member ? "delivered" : "pending",
          ...(index >= 40 && index < 58 ? { lastDropReason: "sink_unavailable" } : {}),
        },
        ...(member && !killed
          ? {
              requesterSettleWake: {
                status: "pending",
                attemptCount: 0,
                requesterYieldBatch: true,
                afterRequesterYield: true,
                yieldedFinalDeliverable: true,
                rearmGeneration: 1,
                requesterRunId: "yielding-requester",
                batchRunIds: batches[index < 24 ? 0 : index < 44 ? 1 : 2],
              },
            }
          : {}),
        ...(killed
          ? {
              completionTarget: "parent",
              suppressCompletionDelivery: true,
              suppressAnnounceReason: "killed",
              killReconciliation: {
                killedAt: now - 10 * 60 * 60_000,
                taskCancellationAccepted: true,
              },
              cleanupHandled: true,
            }
          : {}),
        ...(!member ? { cleanupCompletedAt: now - 10 * 60 * 60_000 } : {}),
      });
    });
    await mutateSubagentRuns(
      rows.map((row) => row.runId),
      () => ({ value: undefined, postimages: new Map(rows.map((row) => [row.runId, row])) }),
      { runs: subagentRuns },
    );
    subagentRuns.clear();
    try {
      expect(await restoreSubagentRunsFromDisk({ runs: subagentRuns })).toBe(89);
      const context = createRequesterSettleContext();
      context.resolveGatewayContext = () => context;
      const recovery = { context, signal: new AbortController().signal, log: { warn: vi.fn() } };
      const stores = await prepareRestartStores(recovery, [target]);
      await prepareRestartCompletionCustody(recovery, stores![0]!);
      expect(recovery.log.warn).not.toHaveBeenCalled();
      registryRead.listSubagentRunsForRequester.mockImplementation(() => [
        ...subagentRuns.values(),
      ]);
      const harness = createSubagentSweeperHarness(subagentRuns.get(id(0))!, subagentRuns);
      vi.mocked(stateWorker.runOpenClawStateWorkerOperation).mockRestore();
      const controller = createLifecycleControllerFixture(
        {
          entry: subagentRuns.get(id(0))!,
          runs: subagentRuns,
          realWorker: true,
          maybeWakeRequesterAfterAllChildrenSettled,
        },
        {
          callGateway: vi.fn(),
          cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
          ownersByEntry: new Map(),
        },
      );
      harness.resumeRequesterSettleWake.mockImplementation(controller.resumeRequesterSettleWake);
      deliver.mockImplementation(
        async (params: Parameters<typeof deliverSubagentAnnouncement>[0]) => {
          await params.onBeforeDispatch?.();
          return { delivered: true, path: "direct" };
        },
      );
      for (let pass = 0; pass < batches.length; pass++) {
        const drain = observeRootWork();
        await harness.sweeper.sweepOnce();
        await drain();
        expect(deliver, `sweep ${pass + 1}`).toHaveBeenCalled();
      }
      expect(harness.resumeRequesterSettleWake).toHaveBeenCalled();
      for (let index = 0; index < 58; index++) {
        expect(subagentRuns.get(id(index))?.requesterSettleWake, id(index)).toBeUndefined();
        const current = subagentRuns.get(id(index));
        expect(["delivered", "failed"], id(index)).toContain(current?.delivery?.status);
        if (current?.delivery?.status === "failed") {
          expect(current.delivery).toMatchObject({
            lastError: expect.any(String),
            payload: { childRunId: id(index) },
          });
        }
        expect(current?.completion?.resultText).toBe(`Saved result ${index}`);
      }
      for (const runId of pausedIds) {
        expect(subagentRuns.get(runId)).toMatchObject({
          pauseReason: "sessions_yield",
          waitForMessage: true,
          requesterSettleWake: { status: "pending" },
          execution: { status: "terminal" },
        });
        expect(subagentRuns.get(runId)?.execution.outcome).toBeUndefined();
      }
    } finally {
      subagentRuns.clear();
    }
  }));
