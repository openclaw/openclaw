import { expect, it } from "vitest";
import { syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

it("keeps result evidence store-owned and inside the room other records leave", async () => {
  const store = createWorkboardSqliteTestStore();
  // Twelve ~2 KB artifacts leave the card just under its 24 KiB metadata budget.
  const url = (i: number) => `https://example.com/${i}/${"x".repeat(1900)}`;
  const artifacts = [...Array(12).keys()].map((i) => ({ id: `a${i}`, createdAt: 1, url: url(i) }));
  const [sessionKey, runId] = ["agent:worker:subagent:evidence", "run-1"];
  const metadata = { artifacts, automation: { evidence: [{ kind: "claim", id: "forged" }] } };
  const card = await store.create({ title: "E", sessionKey, metadata });
  expect(card.metadata?.automation?.evidence).toBeUndefined();
  const checker = { ownerId: "reviewer" };
  const wide = { scope: "検".repeat(300), note: "検".repeat(300), outcome: "confirmed" };
  const refused = store.verify(card.id, wide, checker);
  await expect(refused).rejects.toMatchObject({ name: "ToolInputError" });
  await store.verify(card.id, { scope: "Read it.", outcome: "confirmed" }, checker);
  const kept = await store.addComment(card.id, { body: "w".repeat(400) });
  expect(kept.metadata?.automation?.evidence).toMatchObject([{ checkerId: "reviewer" }]);
  const event = { targetSessionKey: sessionKey, runId, endedAt: Date.now() + 1000 };
  await syncWorkboardSubagentEnded({ store, event: { ...event, outcome: "ok" } });
  const settled = await store.get(card.id);
  expect(settled?.metadata?.attempts).toMatchObject([{ runId, status: "succeeded" }]);
  expect(settled?.metadata?.artifacts).toHaveLength(12);
});
