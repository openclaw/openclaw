import type { WorkboardCard } from "@openclaw/workboard-contract";
import { expect, it } from "vitest";
import { syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

type Store = ReturnType<typeof createWorkboardSqliteTestStore>;
type Prepared = Awaited<ReturnType<Store["prepareExecutionLaunch"]>>;
function prepare(store: Store, claim: Awaited<ReturnType<Store["claim"]>>) {
  return store.prepareExecutionLaunch(claim.card.id, {
    requestedSessionKey: "subagent:workboard-default-requeue",
    now: claim.card.updatedAt + 1,
    scope: { ownerId: "workboard-dispatcher", token: claim.token },
  });
}
function sync(store: Store, card: WorkboardCard, now = card.updatedAt + 1, done = false) {
  return store.syncLifecycle(card.id, {
    targetStatus: "review",
    executionStatus: done ? "done" : "review",
    sourceUpdatedAt: now,
    stale: undefined,
    now,
    association: {
      expectedSessionKey: card.sessionKey,
      expectedRunId: card.runId,
      sessionKey: card.sessionKey!,
      ...(done ? { runId: card.runId } : {}),
    },
  });
}
function accept(store: Store, prepared: Prepared, sessionKey: string, runId: string) {
  return store.acceptExecutionLaunch(prepared.card.id, {
    expectedLaunch: prepared.launch,
    expectedSessionKey: prepared.launch.requestedSessionKey,
    expectedRunId: prepared.launch.provisionalRunId,
    sessionKey,
    runId,
    execution: { ...prepared.card.execution!, sessionKey, runId },
    acceptedAt: prepared.launch.preparedAt + 1,
  });
}
function end(store: Store, targetSessionKey: string, runId: string, endedAt: number) {
  return syncWorkboardSubagentEnded({
    store,
    event: { targetSessionKey, runId, endedAt, outcome: "ok" },
  });
}

async function createBlockedManagedCard() {
  const store = createWorkboardSqliteTestStore();
  const card = await store.create({ title: "Retry unfinished work", status: "ready" });
  const claim = await store.claim(card.id, { ownerId: "workboard-dispatcher" });
  const prepared = await prepare(store, claim);
  const sessionKey = "agent:main:subagent:workboard-default-requeue";
  const runId = "old-run";
  await accept(store, prepared, sessionKey, runId);
  const blocked = await store.block(card.id, {
    ownerId: "workboard-dispatcher",
    token: claim.token,
    reason: "Work remains unfinished.",
  });
  return { store, blocked, sessionKey, runId };
}

it.each([undefined, "shared-run"])(
  "persists terminal attempts for two cards sharing a session and run %s",
  async (runId) => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:main:shared-worker";
    const cards = [];
    for (let index = 0; index < 2; index += 1) {
      cards.push(
        await store.create({ title: "Shared worker", status: "running", sessionKey, runId }),
      );
    }
    const now = Math.max(...cards.map((card) => card.updatedAt)) + 1;
    for (const card of cards) {
      await sync(store, card, now, true);
    }
    const attempts = [];
    const identity = runId ? { sessionKey, runId } : { sessionKey };
    const attempt = { id: expect.any(String), status: "succeeded", ...identity };
    for (const card of cards) {
      const persisted = await store.get(card.id);
      expect(persisted).toMatchObject({ status: "review", metadata: { attempts: [attempt] } });
      attempts.push(persisted?.metadata?.attempts?.[0]?.id);
    }
    expect(new Set(attempts).size).toBe(2);
  },
);
it("keeps a released managed attempt blocked after its card is requeued", async () => {
  const { store, blocked: card, sessionKey, runId } = await createBlockedManagedCard();
  const blockedAttempt = { status: "blocked", runId, error: "Work remains unfinished." };
  await store.unblock(card.id);
  const requeued = await store.promote(card.id);

  await expect(end(store, sessionKey, runId, requeued.updatedAt + 1)).resolves.toBe(0);
  // Recovery sweeps have session identity but no run ID.
  await expect(
    sync(store, { ...requeued, sessionKey, runId }, requeued.updatedAt + 2),
  ).resolves.toBe(false);
  await expect(store.get(card.id)).resolves.toEqual(requeued);
  await expect(store.get(card.id)).resolves.toMatchObject({
    status: "ready",
    execution: { status: "blocked", runId },
    metadata: { failureCount: 1, attempts: [blockedAttempt] },
  });
  expect(card.metadata?.claim).toBeUndefined();
  const retryClaim = await store.claim(card.id, { ownerId: "workboard-dispatcher" });
  expect(retryClaim.card.status).toBe("running");
  const retry = await prepare(store, retryClaim);
  // A pending retry still carries a provisional run ID; the old hook must not adopt it.
  await expect(end(store, sessionKey, runId, retry.card.updatedAt + 1)).resolves.toBe(0);
  await expect(store.get(card.id)).resolves.toEqual(retry.card);
  await accept(store, retry, sessionKey, "retry-run");
  await expect(
    end(store, sessionKey, "retry-run", (await store.get(card.id))!.updatedAt + 1),
  ).resolves.toBe(1);
  await expect(store.get(card.id)).resolves.toMatchObject({
    status: "review",
    metadata: {
      attempts: [blockedAttempt, { status: "succeeded", runId: "retry-run" }],
    },
  });
});

it("synchronizes an explicitly linked replacement session after a managed attempt blocks", async () => {
  const { store, blocked } = await createBlockedManagedCard();
  const sessionKey = "agent:main:replacement-session";
  const linked = await store.update(blocked.id, { sessionKey, status: "todo" });
  await expect(sync(store, linked)).resolves.toBe(true);
  await expect(store.get(blocked.id)).resolves.toMatchObject({
    status: "review",
    sessionKey,
    execution: { sessionKey, status: "review" },
  });
});
