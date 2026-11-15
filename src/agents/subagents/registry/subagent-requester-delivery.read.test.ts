import path from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { readPreparedSessionTranscriptChange } from "../../../config/sessions/session-transcript-authority.js";
import { useTempSessionsFixture } from "../../../config/sessions/test-helpers.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import * as agentReads from "../../../state/openclaw-agent-db-readonly.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  closeOpenClawStateDatabaseForTest,
} from "../../../state/openclaw-state-db.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { mutateSubagentCompletionInDatabase } from "../completion/subagent-completion-mutation.kernel.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  createSubagentStoreRunFixture,
  saveSubagentRegistryToSqlite,
  loadSubagentRegistryFromSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  loadSubagentSessionListRunsFromSqlite,
  readSubagentRun,
} from "./subagent-registry.store.sqlite.js";
import { publishRequesterDeliveryReceipt } from "./subagent-requester-delivery.js";

const fixture = useTempSessionsFixture("requester-delivery-projection-");
const scope = () => ({
  agentId: "main",
  sessionKey: "agent:main:requester",
  sessionId: "requester-session",
  storePath: fixture.storePath(),
});
const runId = "announce:synthetic-batch";
const inputIdempotencyKey = `${runId}:user`;
const raw = () =>
  createSubagentStoreRunFixture({
    requesterAgentId: "main",
    requesterSessionKey: scope().sessionKey,
    requesterStorePath: scope().storePath,
    completionRequesterSessionId: scope().sessionId,
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
const source = {
  role: "user" as const,
  content: "Synthetic result",
  timestamp: 1,
  idempotencyKey: inputIdempotencyKey,
};
beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.resolve(fixture.sessionsDir(), "../../.."));
  await replaceSessionEntry(scope(), { sessionId: scope().sessionId, updatedAt: 1 });
  saveSubagentRegistryToSqlite(new Map([[raw().runId, raw()]]));
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const read = () =>
  loadSubagentSessionListRunsFromSqlite(undefined, openOpenClawStateDatabase()).get(raw().runId)!;

it("keeps a persisted trigger waiting until its result carrier commits, including after reopen", async () => {
  await appendTranscriptMessage(scope(), { message: source });
  expect(read().delivery?.requesterDelivery).toMatchObject({
    state: "waiting",
    blockingRunId: "settling-requester",
  });
  subagentRuns.set(raw().runId, raw());
  subagentRuns.set("second-result", { ...raw(), runId: "second-result" });
  const stop = sessionChanges.subscribeFacts((change) => {
    const fact = readPreparedSessionTranscriptChange(change);
    if (fact?.kind === "postimage") {
      for (const receipt of fact.value.requesterDeliveries ?? []) {
        publishRequesterDeliveryReceipt(subagentRuns, scope(), receipt);
      }
    }
  });
  onTestFinished(() => {
    stop();
    subagentRuns.clear();
  });
  const manager = await SessionManager.openAsync(scope());
  await manager.appendCustomMessageEntryAsync(
    "openclaw.runtime-context",
    "Synthetic child result",
    false,
    {
      source: "openclaw-runtime-context",
      runtimeContextCarrier: true,
      requesterDelivery: { runId, inputIdempotencyKey },
    },
  );
  expect(subagentRuns.get("second-result")?.delivery?.requesterDelivery).toMatchObject({
    state: "consumed",
    runId,
  });
  // Repeated context remains append-only; the receipt index keeps the first committed source.
  await manager.appendCustomMessageEntryAsync(
    "openclaw.runtime-context",
    "Synthetic later context",
    false,
    {
      source: "openclaw-runtime-context",
      runtimeContextCarrier: true,
      requesterDelivery: { runId, inputIdempotencyKey },
    },
  );
  expect(read().delivery?.requesterDelivery).toMatchObject({ state: "consumed", runId });
  expect(subagentRuns.get(raw().runId)?.delivery?.requesterDelivery).toMatchObject({
    state: "consumed",
    runId,
  });
  stop();
  subagentRuns.clear();
  await closeOpenClawAgentDatabasesAsync();
  expect(read().delivery?.requesterDelivery).toMatchObject({ state: "consumed", runId });
});

it("projects a result-bearing input while retaining raw waiting state", async () => {
  await appendTranscriptMessage(scope(), {
    message: {
      ...source,
      provenance: { kind: "inter_session", sourceTool: "subagent_settle" },
      __openclaw: { runId },
    },
  });
  expect(read().delivery?.requesterDelivery).toMatchObject({ state: "consumed", runId });
  expect(
    loadSubagentRegistryFromSqlite().get(raw().runId)?.delivery?.requesterDelivery?.state,
  ).toBe("waiting");
});

it.each(["missing", "unreadable"] as const)(
  "falls back to the raw row for a %s requester database",
  (failure) => {
    vi.spyOn(agentReads, "withOpenClawAgentDatabaseReadOnly").mockImplementation(() => {
      if (failure === "unreadable") {
        throw new Error("synthetic unreadable agent database");
      }
      return { found: false, reason: "database-missing" };
    });
    expect(read().delivery?.requesterDelivery).toMatchObject({
      state: "waiting",
      blockingRunId: "settling-requester",
    });
  },
);

it.for([
  { kind: "requesterBatch", visibleFinal: false },
  { kind: "requesterBatch", visibleFinal: true },
  { kind: "block", visibleFinal: false },
  { kind: "block", visibleFinal: true },
] as const)(
  "settles a restart-cancelled continuation from receipts (%j)",
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
    await appendTranscriptMessage(scope(), {
      message: { ...source, __openclaw: { requesterDelivery: { runId, inputIdempotencyKey } } },
    });
    const database = openOpenClawStateDatabase();
    const result = runOpenClawStateWriteTransaction(
      () =>
        kind === "requesterBatch"
          ? mutateSubagentCompletionInDatabase(database, {
              kind,
              // Restart restores the receipt-backed registry before dispatching its wake.
              entries: batch.map((entry) => ({
                subagent: readSubagentRun(database, entry.runId)!,
              })),
              now: 100,
              outcome: {
                delivered: false,
                path: "direct",
                reason: "delivery_suppressed",
                disposition: "intentional_non_delivery",
              },
            })
          : {
              records: batch.flatMap(
                (subagent) =>
                  mutateSubagentCompletionInDatabase(database, {
                    kind,
                    params: {
                      subagent,
                      operatorAuthorityUnavailable: true,
                      reason: "private requester continuation was cancelled",
                      disposition: "intentional_non_delivery",
                    },
                    now: 100,
                  }).records,
              ),
            },
      { database },
    );
    expect(result.records).toHaveLength(2);
    for (const { subagent } of result.records) {
      expect(subagent.delivery).toMatchObject({
        status: visibleFinal ? "failed" : "delivered",
        requesterDelivery: { state: "consumed", runId },
      });
      if (kind === "requesterBatch") {
        expect(subagent.requesterSettleWake).toBeUndefined();
      }
    }
  },
);
