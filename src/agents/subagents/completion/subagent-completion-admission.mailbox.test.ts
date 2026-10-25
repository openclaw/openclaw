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

function requesterSession(entry: SubagentRunRecord) {
  return {
    cfg: {},
    entry: { sessionId: "requester-session", updatedAt: 1 },
    canonicalKey: entry.requesterSessionKey,
    agentId: entry.requesterAgentId,
    storePath: entry.requesterStorePath,
  };
}

function pauseRequesterLookup(entry: SubagentRunRecord, hold: boolean) {
  const requester = requesterSession(entry);
  const entered = createDeferredCore();
  const lookup = createDeferredCore<typeof requester>();
  vi.spyOn(requesterLookup, "loadRequesterSessionEntry").mockImplementation(async () => {
    entered.resolve();
    return hold ? await lookup.promise : requester;
  });
  return { entered: entered.promise, release: () => lookup.resolve(requester) };
}

function reservationState(
  database: OpenClawStateDatabase,
  wake?: SubagentRunRecord["requesterSettleWake"],
) {
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
  return {
    entry,
    inputs,
    reserve,
    database,
    block: (reason: "expiry" | "permanent_failure") =>
      blockSubagentCompletionDelivery({
        subagent: entry,
        reason: "Synthetic terminal delivery failure",
        suspendedReason: reason,
      }),
  };
}

async function withMailbox(
  run: (fixture: ReturnType<typeof reservationState>) => Promise<void>,
  wake?: SubagentRunRecord["requesterSettleWake"],
) {
  await withSubagentCompletionWorkerState(async (database) => {
    const fixture = reservationState(database, wake);
    const { inputs } = fixture;
    try {
      await run(fixture);
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
  (reason) =>
    withMailbox(async ({ reserve, block, database }) => {
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
    }),
);

it.each([false, true])(
  "keeps the requester cohort and claimed producer custody (claimed: %s)",
  (claimed) =>
    withMailbox(
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
      {
        status: "pending",
        attemptCount: 0,
        rearmGeneration: 2,
        requesterYieldBatch: true,
        batchRunIds: ["completion-run"],
      },
    ),
);
it("does not resurrect a suspended reservation after the requester lookup finishes", () =>
  withMailbox(async ({ entry, inputs, block }) => {
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
      lookup.resolve(requesterSession(entry));
      inputs.push(...(await restoration));
    }
    expect(await restoration).toEqual([]);
  }));

// A yielded cohort reports retired members; superseded work must never block human input.
it.each([
  ["owed", true],
  ["killed", true],
  ["suppressed", true],
  ["killed during lookup", true],
  ["superseded", true],
  ["superseded during lookup", true],
  ["killed", false],
  ["suppressed", false],
  ["killed during lookup", false],
  ["superseded", false],
  ["superseded during lookup", false],
  ["mixed leader retired", true],
  ["mixed leader retires during lookup", true],
  ["mixed batch retires during lookup", true],
  ["mixed sibling replaced during lookup", true],
] as const)("restores only owed mailbox custody (%s, yielded: %s)", async (scenario, yielded) => {
  const mixed = scenario.startsWith("mixed");
  const replaced = scenario === "mixed sibling replaced during lookup";
  const superseded = scenario.startsWith("superseded");
  const duringLookup = scenario.endsWith("during lookup");
  const batchRunIds = ["completion-run", mixed ? "surviving-sibling" : "already-retired-sibling"];
  await withMailbox(
    async ({ entry, inputs, reserve, database }) => {
      const sibling = {
        ...structuredClone(entry),
        runId: "surviving-sibling",
        taskRunId: "sibling-task",
        childSessionKey: "agent:main:subagent:sibling",
      };
      if (mixed) {
        seedSubagentCompletionOwner({ subagent: sibling, databaseOptions: { database } });
      }
      const retire = (runId: string) => {
        const current = subagentRuns.get(runId)!;
        subagentRuns.set(runId, {
          ...current,
          suppressCompletionDelivery: true,
          ...(!mixed && scenario !== "suppressed"
            ? {
                suppressAnnounceReason: "killed" as const,
                endedReason: "subagent-killed" as const,
                killReconciliation: {
                  killedAt: 3_000,
                  ...(superseded ? { supersededAt: 4_000 } : {}),
                },
              }
            : {}),
        });
      };
      const changeOwner = () => {
        retire(entry.runId);
        if (scenario === "mixed batch retires during lookup") {
          retire(sibling.runId);
        } else if (replaced) {
          subagentRuns.set(sibling.runId, { ...sibling, generation: sibling.generation! + 1 });
        }
      };
      if (scenario !== "owed" && !duringLookup) {
        changeOwner();
      }
      const lookup = pauseRequesterLookup(entry, duringLookup);
      const restoration = reserveRestoredSubagentControllerSources([...subagentRuns.values()]);
      if (duringLookup) {
        try {
          await lookup.entered;
          changeOwner();
        } finally {
          lookup.release();
        }
      }
      const restored = await restoration;
      inputs.push(...restored);
      const human = reserve("new-human-input");
      const claim = tryClaimSessionControllerTask(human, "visible");
      if (superseded || replaced || (!mixed && !yielded)) {
        expect(restored).toEqual([]);
        expect(claim).toBeDefined();
        return;
      }
      expect(restored).toHaveLength(1);
      expect(claim).toBeUndefined();
      if (mixed) {
        // Retirement changes the representative, not the frozen reservation identity.
        expect(restored[0]?.sourceTurnId).toBe(
          "requester-settle:main:agent:main:main:completion-run,surviving-sibling:yield-3",
        );
        const owner = tryClaimSessionControllerTask(restored[0]!);
        expect(owner).toBeDefined();
        if (owner) {
          releaseSessionControllerClaim(owner);
          await owner.settlement.promise;
        }
      } else {
        expect(restored[0]?.phase).toBe("preparing");
        for (const input of restored) {
          retireSessionControllerInput(input);
        }
        await Promise.all(restored.map((input) => input.settlement.promise));
      }
      expect(tryClaimSessionControllerTask(human, "visible")).toBeDefined();
    },
    {
      status: "dispatching",
      attemptCount: 1,
      rearmGeneration: mixed ? 3 : 1,
      ...(yielded ? { requesterYieldBatch: true, yieldedFinalDeliverable: true } : {}),
      batchRunIds,
    },
  );
});
