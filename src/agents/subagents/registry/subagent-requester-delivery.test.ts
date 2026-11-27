import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTempSessionsFixture } from "../../../config/sessions/test-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  closeOpenClawStateDatabaseForTest,
} from "../../../state/openclaw-state-db.js";
import { mutateSubagentCompletionInDatabase } from "../completion/subagent-completion-mutation.kernel.js";
import {
  createSubagentStoreRunFixture,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import { readSubagentRun } from "./subagent-registry.store.sqlite.js";

const fixture = useTempSessionsFixture("requester-delivery-");
const runId = "announce:synthetic-batch";
const raw = () =>
  createSubagentStoreRunFixture({
    completionTarget: "parent",
    delivery: {
      status: "pending",
      requesterDelivery: {
        state: "waiting",
        runId,
        blockingRunId: "settling-requester",
      },
    },
  });
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.resolve(fixture.sessionsDir(), "../../.."));
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it.for([
  { kind: "requesterBatch", visibleFinal: false },
  { kind: "requesterBatch", visibleFinal: true },
  { kind: "settleInHistory", visibleFinal: false },
  { kind: "settleInHistory", visibleFinal: true },
] as const)(
  "retains committed consumption when a continuation is cancelled (%j)",
  async ({ kind, visibleFinal }) => {
    const batch = [raw(), { ...raw(), runId: "second-result" }].map((entry) =>
      Object.assign(entry, {
        requesterSettleWake: {
          status: "dispatching" as const,
          attemptCount: 1,
          yieldedFinalDeliverable: visibleFinal || undefined,
          batchRunIds: [raw().runId, "second-result"],
        },
      }),
    );
    saveSubagentRegistryToSqlite(new Map(batch.map((entry) => [entry.runId, entry])));
    let database = openOpenClawStateDatabase();
    runOpenClawStateWriteTransaction(
      () =>
        mutateSubagentCompletionInDatabase(database, {
          kind: "requesterWake",
          entries: batch.map((subagent) => ({ subagent })),
          operation: { kind: "requesterDelivery", fact: { state: "consumed", runId, at: 50 } },
        }),
      { database },
    );
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase();
    for (const entry of batch) {
      expect(readSubagentRun(database, entry.runId)?.delivery?.requesterDelivery).toMatchObject({
        state: "consumed",
        runId,
      });
    }
    const result = runOpenClawStateWriteTransaction(
      () =>
        kind === "requesterBatch"
          ? mutateSubagentCompletionInDatabase(database, {
              kind,
              // Restart reads the committed registry fact without the requester transcript.
              entries: batch.map((entry) => ({
                subagent: readSubagentRun(database, entry.runId)!,
              })),
              now: 100,
              outcome: {
                delivered: false,
                path: "direct",
                reason: "delivery_suppressed",
              },
            })
          : {
              records: batch.flatMap(
                (subagent) =>
                  mutateSubagentCompletionInDatabase(database, {
                    kind,
                    subagent,
                    now: 100,
                  }).records,
              ),
            },
      { database },
    );
    expect(result.records).toHaveLength(2);
    for (const { subagent } of result.records) {
      expect(subagent.delivery).toMatchObject({
        status: "delivered",
        requesterDelivery: { state: "consumed", runId },
      });
      if (kind === "requesterBatch") {
        expect(subagent.requesterSettleWake).toBeUndefined();
      }
    }
  },
);
