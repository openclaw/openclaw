// Dispatch comment-limit regressions split from store.test.ts (max-lines).
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { computeCardDiagnostics } from "./store-card-helpers.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

describe("WorkboardStore dispatch comment limits", () => {
  it("heals oversized diagnostic summary comments during dispatch without aborting reclaim", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const stranded = await Promise.all(
      Array.from({ length: 18 }, (_, index) =>
        store.create({
          title: `Stranded ${index + 1}`,
          status: "ready",
          agentId: "main",
        }),
      ),
    );
    const expired = await store.create({ title: "Expired claim", status: "ready" });
    await store.update(expired.id, {
      metadata: {
        ...expired.metadata,
        claim: {
          ownerId: "main",
          token: "token-1",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: 2,
        },
      },
    });
    const sibling = await store.create({ title: "Unaffected sibling", status: "ready" });
    const now = Date.now() + 2 * 60 * 60 * 1000;
    const oversized = stranded
      .flatMap((card) =>
        computeCardDiagnostics(card, now)
          .filter((entry) => entry.kind === "stranded_ready")
          .map((entry) => `- ${entry.kind} ${card.id}: ${entry.title}. ${entry.detail}`),
      )
      .join("\n");
    expect(oversized.length).toBeGreaterThan(2000);

    const rawDb = new DatabaseSync(dbPath);
    try {
      rawDb
        .prepare(
          "INSERT INTO workboard_card_comments (id, card_id, ordinal, body, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("oversized-summary", expired.id, 0, oversized, Date.now());
    } finally {
      rawDb.close();
    }

    expect((await store.get(expired.id))?.metadata?.comments?.[0]?.body).toBe(oversized);
    const dispatch = await store.dispatch(now);

    expect(dispatch.reclaimed).toEqual([expect.objectContaining({ id: expired.id })]);
    expect(dispatch.reclaimed[0]?.metadata?.claim).toBeUndefined();
    const repaired = await store.get(expired.id);
    expect(repaired?.metadata?.comments?.[0]?.body).toBe(`${oversized.slice(0, 1999)}…`);
    expect(repaired?.metadata?.comments?.[0]?.body.length).toBeLessThanOrEqual(2000);
    await expect(store.get(sibling.id)).resolves.toEqual(sibling);

    const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        verifyDb
          .prepare("SELECT body FROM workboard_card_comments WHERE id = ?")
          .get("oversized-summary"),
      ).toEqual({ body: `${oversized.slice(0, 1999)}…` });
    } finally {
      verifyDb.close();
    }
  });
});
