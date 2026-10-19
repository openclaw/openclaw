import { expect, it, vi } from "vitest";
import { loadPendingSessionDeliveries } from "../../../infra/session-delivery-queue-storage.js";
import {
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  tryClaimSessionControllerTask,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { reserveRestoredSubagentControllerSources } from "../announce/subagent-announce-controller-source.js";
import * as requesterLookup from "../announce/subagent-announce-delivery.runtime.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { blockSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import {
  records,
  seedSubagentCompletionOwner,
  withSubagentCompletionWorkerState,
} from "./subagent-completion-admission.test-helpers.js";

async function withReservationState(
  wake: SubagentRunRecord["requesterSettleWake"],
  run: (fixture: {
    entry: SubagentRunRecord;
    inputs: SessionControllerInput[];
    reserve: (sourceTurnId: string) => SessionControllerInput;
    block: (reason: "expiry" | "permanent_failure") => Promise<boolean>;
    database: OpenClawStateDatabase;
  }) => Promise<void>,
) {
  await withSubagentCompletionWorkerState(async (database) => {
    const entry = records().subagent;
    entry.generation = 4;
    entry.requesterStorePath = "/private/tmp/completion-mailbox/main/sessions.json";
    entry.delivery = { status: "pending", generation: 1 };
    entry.requesterSettleWake = wake;
    seedSubagentCompletionOwner({ subagent: entry, databaseOptions: { database } });
    const target = captureSessionTarget({
      storeScope: entry.requesterStorePath,
      sessionKey: entry.requesterSessionKey,
      agentId: entry.requesterAgentId,
      incarnation: "requester-session",
    });
    const inputs: SessionControllerInput[] = [];
    const reserve = (sourceTurnId: string) => {
      const input = reserveSessionControllerSource(entry.requesterSessionKey, {
        sourceTurnId,
        target,
        policy: { mode: "followup" },
      });
      inputs.push(input);
      return input;
    };
    try {
      await run({
        entry,
        inputs,
        reserve,
        database,
        block: (reason) =>
          blockSubagentCompletionDelivery({
            subagent: entry,
            reason: "Synthetic terminal delivery failure",
            suspendedReason: reason,
          }),
      });
    } finally {
      for (const claim of new Set(inputs.flatMap((input) => (input.claim ? [input.claim] : [])))) {
        releaseSessionControllerClaim(claim);
      }
      for (const input of inputs) {
        retireSessionControllerInput(input);
      }
      await Promise.allSettled(inputs.map((input) => input.settlement.promise));
      vi.restoreAllMocks();
    }
  });
}

it.each(["expiry", "permanent_failure"] as const)(
  "admits the failure notice only after %s suspension commits",
  async (reason) => {
    await withReservationState(undefined, async ({ reserve, block, database }) => {
      const completion = reserve("subagent-completion:completion-run:4");
      const context = captureOpenClawStateWorkerContext();
      database.db.exec(
        "CREATE TRIGGER reject_suspension BEFORE UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'suspension rejected'); END",
      );
      try {
        await expect(block(reason)).rejects.toThrow("suspension rejected");
      } finally {
        database.db.exec("DROP TRIGGER reject_suspension");
      }
      expect(completion.abortSignal.aborted).toBe(false);
      expect(await loadPendingSessionDeliveries(context)).toEqual([]);

      await expect(block(reason)).resolves.toBe(true);
      expect(subagentRuns.get("completion-run")?.delivery?.status).toBe("suspended");
      const [notice] = await loadPendingSessionDeliveries(context);
      expect(notice).toMatchObject({
        kind: "systemEvent",
        text: expect.stringContaining("Synthetic terminal delivery failure"),
      });
      if (!notice) {
        throw new Error("Suspension did not retain its failure notice");
      }
      const noticeInput = reserve(notice.id);
      expect(tryClaimSessionControllerTask(noticeInput, "queued_followup")).toBeDefined();
    });
  },
);

it.each([false, true])(
  "keeps the requester cohort and claimed producer custody (claimed: %s)",
  async (claimed) => {
    await withReservationState(
      {
        status: "pending",
        attemptCount: 0,
        rearmGeneration: 2,
        requesterYieldBatch: true,
        batchRunIds: ["completion-run"],
      },
      async ({ reserve, block }) => {
        const completion = reserve("subagent-completion:completion-run:4");
        if (claimed) {
          expect(tryClaimSessionControllerTask(completion)).toBeDefined();
        }
        const cohort = reserve("requester-settle:main:agent:main:main:completion-run:yield-2");
        await expect(block("expiry")).resolves.toBe(true);
        expect(cohort.abortSignal.aborted).toBe(false);
        expect(completion.abortSignal.aborted).toBe(!claimed);
        expect(subagentRuns.get("completion-run")?.requesterSettleWake).toBeDefined();
        if (!claimed) {
          expect(tryClaimSessionControllerTask(cohort)).toBeDefined();
        }
      },
    );
  },
);

it("does not resurrect a suspended reservation after the requester lookup finishes", async () => {
  await withReservationState(undefined, async ({ entry, inputs, block }) => {
    const entered = createDeferredCore();
    const lookup =
      createDeferredCore<Awaited<ReturnType<typeof requesterLookup.loadRequesterSessionEntry>>>();
    vi.spyOn(requesterLookup, "loadRequesterSessionEntry").mockImplementationOnce(() => {
      entered.resolve();
      return lookup.promise;
    });
    const restoration = reserveRestoredSubagentControllerSources([entry]);
    try {
      await entered.promise;
      await expect(block("expiry")).resolves.toBe(true);
    } finally {
      lookup.resolve({
        cfg: {},
        entry: { sessionId: "requester-session", updatedAt: 1 },
        canonicalKey: entry.requesterSessionKey,
        agentId: entry.requesterAgentId,
        storePath: entry.requesterStorePath,
      });
      inputs.push(...(await restoration));
    }
    expect(await restoration).toEqual([]);
  });
});
