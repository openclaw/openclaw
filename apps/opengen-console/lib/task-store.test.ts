import { describe, expect, it } from "vitest";
import { createTaskStore } from "./task-store";

describe("task store", () => {
  it("persists and retrieves tasks by id", async () => {
    const store = createTaskStore(`/tmp/opengen-task-store-${Date.now()}.test.json`);
    await store.save({ task_id: "t1", status: "completed" } as never);
    const found = await store.getById("t1");
    expect(found?.task_id).toBe("t1");
  });
});
