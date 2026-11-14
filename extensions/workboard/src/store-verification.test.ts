import { expect, it } from "vitest";
import { syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import { codexExecution } from "./test/execution.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

it("keeps verifications store-owned and inside the room other records leave", async () => {
  const store = createWorkboardSqliteTestStore();
  // Twelve ~2 KB artifacts leave the card just under its 24 KiB metadata budget.
  const url = (i: number) => `https://example.com/${i}/${"x".repeat(1900)}`;
  const artifactsFor = (prefix: string) =>
    [...Array(12).keys()].map((i) => ({ id: `${prefix}${i}`, createdAt: 1, url: url(i) }));
  const artifacts = artifactsFor("a");
  const [sessionKey, runId] = ["agent:worker:subagent:verify", "run-1"];
  const metadata = { artifacts, automation: { verifications: [{ id: "forged" }] } };
  const card = await store.create({ title: "E", agentId: "worker", sessionKey, metadata });
  expect(card.metadata?.automation?.verifications).toBeUndefined();
  const checker = { ownerId: "reviewer" };
  const worker = { ownerId: "worker" };
  const wide = { scope: "検".repeat(300), note: "検".repeat(300), outcome: "confirmed" };
  const refused = store.verify(card.id, wide, checker);
  await expect(refused).rejects.toMatchObject({ name: "ToolInputError" });
  await store.verify(card.id, { scope: "Read it.", outcome: "confirmed" }, checker);
  const kept = await store.addComment(card.id, { body: "w".repeat(400) });
  expect(kept.metadata?.automation?.verifications).toMatchObject([
    { checkerId: "reviewer", checkedOwnWork: false },
  ]);
  const own = await store.verify(card.id, { scope: "Mine.", outcome: "confirmed" }, worker);
  expect(own.metadata?.automation?.verifications?.at(-1)).toMatchObject({ checkedOwnWork: true });
  const event = { targetSessionKey: sessionKey, runId, endedAt: Date.now() + 1000 };
  await syncWorkboardSubagentEnded({ store, event: { ...event, outcome: "ok" } });
  const settled = await store.get(card.id);
  expect(settled?.metadata?.attempts).toMatchObject([{ runId, status: "succeeded" }]);
  expect(settled?.metadata?.artifacts).toHaveLength(12);
  // A manual move settles the run without a metadata patch; verifications still yield.
  const execution = codexExecution("exec", 1, { sessionKey, runId: "run-m" });
  const running = await store.create({
    title: "M",
    execution,
    metadata: { artifacts: artifactsFor("m") },
  });
  await store.verify(
    running.id,
    { scope: "s".repeat(300), note: "n".repeat(300), outcome: "confirmed" },
    checker,
  );
  const moved = await store.move(running.id, "done", undefined);
  expect(moved.metadata?.attempts).toMatchObject([{ runId: "run-m", status: "succeeded" }]);
  expect(moved.metadata?.artifacts).toHaveLength(12);
});

it("carries checker verdicts out of main's evidence list without evicting card records", async () => {
  // Cards written by main between #197471 and the verifications-only cutover.
  const verdict = { id: "v1", recordedAt: 3, checkerId: "reviewer", checkedOwnWork: false };
  const evidence = [
    { kind: "claim", id: "c1", recordedAt: 1, claimedBy: "worker", statement: "c".repeat(300) },
    { kind: "observation", id: "o1", recordedAt: 2, observedAt: 2, source: "session-lifecycle" },
    {
      kind: "verification",
      ...verdict,
      scope: "s".repeat(300),
      outcome: "confirmed",
      claimId: "c1",
    },
  ];
  const seeded = new Set<string>();
  const store = createWorkboardSqliteTestStore({
    beforeCardWrite: (_key, { card }) => {
      if (!seeded.has(card.id)) {
        seeded.add(card.id);
        // Main's shape, which the current contract type no longer has.
        const automation = { ...card.metadata?.automation };
        Reflect.set(automation, "evidence", evidence);
        card.metadata = { ...card.metadata, automation };
      }
    },
  });
  const url = (i: number) => `https://example.com/${i}/${"x".repeat(1900)}`;
  const artifacts = [...Array(12).keys()].map((i) => ({ id: `a${i}`, createdAt: 1, url: url(i) }));
  const execution = codexExecution("exec", 1, { sessionKey: "agent:w:subagent:l", runId: "run-l" });
  const running = await store.create({ title: "legacy move", execution, metadata: { artifacts } });
  const moved = await store.move(running.id, "done", undefined);
  expect(moved.metadata?.attempts).toMatchObject([{ runId: "run-l", status: "succeeded" }]);
  expect(moved.metadata?.artifacts).toHaveLength(12);
  const carried = [{ ...verdict, scope: "s".repeat(300), outcome: "confirmed" }];
  expect(moved.metadata?.automation).toMatchObject({ verifications: carried });
  expect(moved.metadata?.automation).not.toHaveProperty("evidence");
  const patched = await store.create({ title: "legacy patch" });
  const updated = await store.update(patched.id, { metadata: {} });
  expect(updated.metadata?.automation).toMatchObject({ verifications: carried });
});
