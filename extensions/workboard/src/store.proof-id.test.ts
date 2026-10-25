import { describe, expect, it } from "vitest";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const createStore = () => createWorkboardSqliteTestStore({ createStores: createKernelStores });

describe("WorkboardStore completion proofId", () => {
  it("treats an empty proofId as omitted so OpenAI strict schemas can complete", async () => {
    const store = createStore();
    const card = await store.create({ title: "Empty proofId from strict schema" });

    const completed = await store.complete(card.id, {
      summary: "echo ok",
      proofId: "",
      proof: { status: "passed", command: "echo ok" },
    });

    expect(completed.status).toBe("done");
    expect(completed.metadata?.proof?.[0]?.status).toBe("passed");
  });

  it("still rejects a null proofId", async () => {
    const store = createStore();
    const card = await store.create({ title: "Null proofId" });

    await expect(
      store.complete(card.id, {
        summary: "echo ok",
        proofId: null as unknown as string,
        proof: { status: "passed", command: "echo ok" },
      }),
    ).rejects.toThrow("proofId must be a non-empty string.");
  });
});
