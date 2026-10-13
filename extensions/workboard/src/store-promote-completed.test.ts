import { expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.ts";
import { createWorkboardTools } from "./tools.ts";

it("keeps completed cards done while allowing blocked-card recovery through promote", async () => {
  const store = createWorkboardSqliteTestStore();
  const promote = createWorkboardTools({ store }).find((tool) => tool.name === "workboard_promote");
  expect(promote).toBeDefined();

  const done = await store.create({ title: "Completed card", status: "done" });
  const blocked = await store.create({ title: "Blocked recovery control", status: "blocked" });
  expect(done.completedAt).toBeDefined();

  await expect(promote!.execute("promote-done", { id: done.id })).rejects.toThrow(/completed/);
  await promote!.execute("promote-blocked", { id: blocked.id });

  await expect(store.get(done.id)).resolves.toMatchObject({
    status: "done",
    completedAt: done.completedAt,
  });
  await expect(store.get(blocked.id)).resolves.toMatchObject({ status: "ready" });
});
