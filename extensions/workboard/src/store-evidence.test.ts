import { expect, it } from "vitest";
import { expectRejected } from "./store-family.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

it("keeps result evidence store-owned and inside the room other records leave", async () => {
  const store = createWorkboardSqliteTestStore();
  // Twelve ~2 KB artifacts leave the card just under its 24 KiB metadata budget.
  const url = (index: number) => `https://example.com/${index}/${"x".repeat(1900)}`;
  const artifacts = Array.from({ length: 12 }, (_, i) => ({
    id: `a${i}`,
    createdAt: 1,
    url: url(i),
  }));
  const evidence = [{ kind: "claim", id: "forged" }];
  const card = await store.create({
    title: "Evidence",
    metadata: { artifacts, automation: { evidence } },
  });
  expect(card.metadata?.automation?.evidence).toBeUndefined();
  const checker = { ownerId: "reviewer" };
  const wide = { scope: "検".repeat(300), note: "検".repeat(300), outcome: "confirmed" };
  await expectRejected(store.verify(card.id, wide, checker), /no room/);
  await store.verify(card.id, { scope: "Read it.", outcome: "confirmed" }, checker);
  const later = await store.addComment(card.id, { body: "Later write." });
  expect(later.metadata?.artifacts).toHaveLength(12);
  expect(later.metadata?.automation?.evidence).toMatchObject([{ checkerId: "reviewer" }]);
});
