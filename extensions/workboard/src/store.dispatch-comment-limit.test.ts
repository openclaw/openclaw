import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

describe("Workboard dispatch comment limits", () => {
  it("sweeps through the tool and preserves oversized stored comments without admitting new ones", async () => {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(600_000);
    const { store, stores } = createWorkboardSqliteTestHarness();
    const expired = await store.create({ title: "Expired claim", status: "ready" });
    const scheduled = await store.create({
      title: "Scheduled",
      status: "scheduled",
      scheduledAt: 1,
    });
    const running = await store.create({ title: "Expired run", status: "running" });
    const body = `  ${"x".repeat(2001)}\n`;
    for (const card of [expired, scheduled, running]) {
      // Seed legacy data through the persistence owner, below new-input validation.
      await stores.cards.register(card.id, {
        version: 1,
        card: {
          ...card,
          metadata: {
            ...card.metadata,
            comments: [{ id: `legacy-${card.id}`, body, createdAt: 1 }],
            ...(card === scheduled
              ? {}
              : {
                  claim: {
                    ownerId: "main",
                    token: "test-token",
                    claimedAt: 1,
                    lastHeartbeatAt: 1,
                    expiresAt: 2,
                  },
                }),
          },
        },
      });
    }
    const dispatch = expectDefined(
      createWorkboardTools({ store }).find((tool) => tool.name === "workboard_dispatch"),
      "dispatch tool",
    );
    const result = await dispatch.execute("dispatch", { boardId: "default" });
    expect(result.details).toMatchObject({
      reclaimed: [expect.objectContaining({ id: expired.id })],
      promoted: [expect.objectContaining({ id: scheduled.id, status: "ready" })],
      blocked: [expect.objectContaining({ id: running.id, status: "blocked" })],
      count: 3,
    });
    for (const card of [expired, scheduled, running]) {
      const saved = expectDefined(await store.get(card.id), "saved card");
      expect(saved.status).toBe(card === running ? "blocked" : "ready");
      expect(saved.metadata?.comments).toEqual([{ id: `legacy-${card.id}`, body, createdAt: 1 }]);
      expect(saved.metadata?.claim).toBeUndefined();
    }

    const updated = await store.addComment(expired.id, { body: "Recovered" });
    expect(updated.metadata?.comments?.map((comment) => comment.body)).toEqual([body, "Recovered"]);
    await expect(store.addComment(expired.id, { body })).rejects.toThrow(
      "comment body must be 2000 characters or fewer",
    );
    const stored = expectDefined(updated.metadata?.comments?.[0], "stored comment");
    for (const comment of [
      { ...stored, id: "new" },
      { ...stored, body: `${body} edited` },
    ]) {
      await expect(store.update(expired.id, { metadata: { comments: [comment] } })).rejects.toThrow(
        "comment body must be 2000 characters or fewer",
      );
    }
    await expect(store.update(scheduled.id, { metadata: { comments: [stored] } })).rejects.toThrow(
      "comment body must be 2000 characters or fewer",
    );
  });
});
