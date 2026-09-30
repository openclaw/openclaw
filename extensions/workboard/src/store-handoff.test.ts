import { describe, expect, it } from "vitest";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("Workboard canonical handoff", () => {
  it("keeps questions stable and requires structured approval, UAT, and proof", async () => {
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const card = await store.create({ title: "Approval-gated result" });
    const pending = await store.recordHandoff(card.id, {
      summary: "Preview is ready.",
      needsUser: "Run phone UAT.",
      approval: "pending",
      uat: "pending",
      deliveryStatus: "delivered",
      deliveryReceipt: "message-1",
      sourceUrl: "https://chat.example.test/thread/1",
    });
    await store.addComment(card.id, { body: "Looks approved to me." });
    await expect(
      store.complete(card.id, {
        summary: "Done",
        handoff: pending.metadata?.automation?.handoff,
      }),
    ).rejects.toThrow(/needs user input/);
    const stillPending = await store.get(card.id);
    expect(stillPending?.metadata?.automation?.handoff?.needsUser).toBe("Run phone UAT.");

    await store.addProof(card.id, { status: "passed", label: "phone UAT" });
    const ready = await store.recordHandoff(card.id, {
      summary: "Phone UAT passed.",
      approval: "approved",
      uat: "approved",
      deliveryStatus: "delivered",
      verifiedAt: Date.now(),
    });
    await expect(
      store.complete(card.id, {
        summary: "Done",
        handoff: ready.metadata?.automation?.handoff,
      }),
    ).resolves.toMatchObject({ status: "done" });
  });

  it("reopens only explicitly classified unresolved failure feedback", async () => {
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const card = await store.create({ title: "Late feedback", status: "done" });
    await expect(store.addComment(card.id, { body: "Status note only." })).resolves.toMatchObject({
      status: "done",
    });
    await expect(
      store.addComment(card.id, {
        body: "The preview opens the wrong app.",
        kind: "failure-feedback",
      }),
    ).resolves.toMatchObject({ status: "review" });
  });

  it("requires newer proof after a blocked attempt", async () => {
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const failureAt = Date.now();
    const card = await store.create({
      title: "Blocked attempt",
      metadata: {
        attempts: [
          { id: "attempt-1", status: "blocked", startedAt: failureAt - 10, endedAt: failureAt },
        ],
        artifacts: [{ id: "artifact-1", path: "/tmp/result", createdAt: failureAt - 20 }],
      },
    });
    const result = await store.recordHandoff(card.id, {
      summary: "Reported complete despite blocker.",
      approval: "not-required",
      uat: "not-required",
      deliveryStatus: "delivered",
    });
    const complete = () =>
      store.complete(card.id, {
        summary: "Done",
        handoff: result.metadata?.automation?.handoff,
      });
    await expect(complete()).rejects.toThrow(/failed or blocked/);
    await store.addProof(card.id, { status: "passed", label: "recovery proof" });
    await expect(complete()).resolves.toMatchObject({ status: "done" });
  });
});
