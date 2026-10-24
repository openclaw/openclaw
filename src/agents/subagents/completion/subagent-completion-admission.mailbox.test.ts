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
  }));

// A yielded cohort still reports cancellation, but superseded work must not block new input.
// An ordinary wave owes nothing once its members retire.
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
] as const)(
  "restores only owed requester wakes before new human input (%s, yielded: %s)",
  async (scenario, yielded) => {
    await withMailbox(
      async ({ entry, inputs, reserve }) => {
        const superseded = scenario.startsWith("superseded");
        const duringLookup = scenario.endsWith("during lookup");
        const retireObligation = () => {
          const current = subagentRuns.get(entry.runId);
          if (!current) {
            throw new Error("Synthetic completion owner disappeared");
          }
          subagentRuns.set(entry.runId, {
            ...current,
            suppressCompletionDelivery: true,
            suppressAnnounceReason: "killed",
            endedReason: "subagent-killed",
            killReconciliation: {
              killedAt: 3_000,
              ...(superseded ? { supersededAt: 4_000 } : {}),
            },
          });
        };
        if (scenario === "killed" || scenario === "superseded") {
          retireObligation();
        } else if (scenario === "suppressed") {
          subagentRuns.set(entry.runId, { ...entry, suppressCompletionDelivery: true });
        }
        // Restore normally receives the currently published startup snapshot.
        const observed = subagentRuns.get(entry.runId);
        if (!observed) {
          throw new Error("Synthetic startup snapshot disappeared");
        }
        const requester = {
          cfg: {},
          entry: { sessionId: "requester-session", updatedAt: 1 },
          canonicalKey: entry.requesterSessionKey,
          agentId: entry.requesterAgentId,
          storePath: entry.requesterStorePath,
        };
        const entered = createDeferredCore();
        const lookup =
          createDeferredCore<
            Awaited<ReturnType<typeof requesterLookup.loadRequesterSessionEntry>>
          >();
        vi.spyOn(requesterLookup, "loadRequesterSessionEntry").mockImplementation(async () => {
          entered.resolve();
          return duringLookup ? await lookup.promise : requester;
        });
        const restoration = reserveRestoredSubagentControllerSources([observed]);
        if (duringLookup) {
          try {
            await entered.promise;
            retireObligation();
          } finally {
            lookup.resolve(requester);
          }
        }
        const restored = await restoration;
        inputs.push(...restored);
        const human = reserve("new-human-input");
        const claim = tryClaimSessionControllerTask(human, "visible");
        if (!superseded && (scenario === "owed" || yielded)) {
          expect(restored).toHaveLength(1);
          expect(restored[0]?.phase).toBe("preparing");
          expect(claim).toBeUndefined();
          for (const input of restored) {
            retireSessionControllerInput(input);
          }
          await Promise.all(restored.map((input) => input.settlement.promise));
          expect(tryClaimSessionControllerTask(human, "visible")).toBeDefined();
        } else {
          // The real mailbox selector must admit the human, not merely return fewer rows.
          expect(claim).toBeDefined();
          expect(restored).toEqual([]);
        }
      },
      {
        status: "dispatching",
        attemptCount: 1,
        rearmGeneration: 1,
        ...(yielded ? { requesterYieldBatch: true, yieldedFinalDeliverable: true } : {}),
        // The other member no longer has a retained wake, as after partial cleanup.
        batchRunIds: ["completion-run", "already-retired-sibling"],
      },
    );
  },
);

it.each([
  "leader already retired",
  "leader retires during lookup",
  "whole batch retires during lookup",
  "sibling replaced during lookup",
] as const)("preserves mixed-cohort mailbox custody (%s)", async (scenario) => {
  await withMailbox(
    async ({ entry, inputs, reserve, database }) => {
      const sibling: SubagentRunRecord = {
        ...structuredClone(entry),
        runId: "surviving-sibling",
        taskRunId: "sibling-task",
        childSessionKey: "agent:main:subagent:sibling",
      };
      seedSubagentCompletionOwner({ subagent: sibling, databaseOptions: { database } });
      const retire = (runId: string) => {
        const current = subagentRuns.get(runId);
        if (!current) {
          throw new Error("Synthetic cohort owner disappeared");
        }
        subagentRuns.set(runId, { ...current, suppressCompletionDelivery: true });
      };
      if (scenario === "leader already retired") {
        retire(entry.runId);
      }
      const requester = {
        cfg: {},
        entry: { sessionId: "requester-session", updatedAt: 1 },
        canonicalKey: entry.requesterSessionKey,
        agentId: entry.requesterAgentId,
        storePath: entry.requesterStorePath,
      };
      const entered = createDeferredCore();
      const lookup =
        createDeferredCore<Awaited<ReturnType<typeof requesterLookup.loadRequesterSessionEntry>>>();
      vi.spyOn(requesterLookup, "loadRequesterSessionEntry").mockImplementation(async () => {
        entered.resolve();
        return scenario === "leader already retired" ? requester : await lookup.promise;
      });
      const restoration = reserveRestoredSubagentControllerSources([...subagentRuns.values()]);
      if (scenario !== "leader already retired") {
        try {
          await entered.promise;
          retire(entry.runId);
          if (scenario === "whole batch retires during lookup") {
            retire(sibling.runId);
          } else if (scenario === "sibling replaced during lookup") {
            subagentRuns.set(sibling.runId, { ...sibling, generation: sibling.generation! + 1 });
          }
        } finally {
          lookup.resolve(requester);
        }
      }
      const restored = await restoration;
      inputs.push(...restored);
      const human = reserve("new-human-after-mixed-cohort");
      if (scenario === "sibling replaced during lookup") {
        expect(restored).toEqual([]);
        expect(tryClaimSessionControllerTask(human, "visible")).toBeDefined();
        return;
      }
      expect(restored).toHaveLength(1);
      // Retirement changes the representative, not the frozen reservation identity.
      expect(restored[0]?.sourceTurnId).toBe(
        "requester-settle:main:agent:main:main:completion-run,surviving-sibling:yield-3",
      );
      expect(tryClaimSessionControllerTask(human, "visible")).toBeUndefined();
      const claim = tryClaimSessionControllerTask(restored[0]!);
      expect(claim).toBeDefined();
      if (claim) {
        releaseSessionControllerClaim(claim);
        await claim.settlement.promise;
      }
      expect(tryClaimSessionControllerTask(human, "visible")).toBeDefined();
    },
    {
      status: "dispatching",
      attemptCount: 1,
      rearmGeneration: 3,
      requesterYieldBatch: true,
      yieldedFinalDeliverable: true,
      batchRunIds: ["completion-run", "surviving-sibling"],
    },
  );
});
