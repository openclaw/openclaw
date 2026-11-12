import { describe, expect, it } from "vitest";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const createStore = () => createWorkboardSqliteTestStore({ createStores: createKernelStores });

describe("WorkboardStore completion proofId", () => {
  it("treats an empty proofId as omitted when inline proof is supplied", async () => {
    const store = createStore();
    const card = await store.create({ title: "Empty proofId" });
    const completed = await store.complete(card.id, {
      summary: "echo ok",
      proofId: "",
      proof: { status: "passed", command: "echo ok" },
    });
    expect(completed.status).toBe("done");
    expect(completed.metadata?.proof?.[0]?.status).toBe("passed");
    expect(completed.metadata?.proof?.[0]?.command).toBe("echo ok");
  });

  it.each([null, false, 7, "   "])("still rejects malformed proofId %s", async (proofId) => {
    const store = createStore();
    const card = await store.create({ title: "Malformed proofId" });
    await expect(
      store.complete(card.id, {
        summary: "echo ok",
        proofId: proofId as unknown as string,
        proof: { status: "passed", command: "echo ok" },
      }),
    ).rejects.toThrow("proofId must be a non-empty string.");
    expect((await store.get(card.id))?.status).not.toBe("done");
  });
});
