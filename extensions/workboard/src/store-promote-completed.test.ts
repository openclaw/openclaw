import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

it("keeps completed cards done while allowing blocked-card recovery through promote", async () => {
  const store = createWorkboardSqliteTestStore();
  const promote = expectDefined(
    createWorkboardTools({ store }).find((tool) => tool.name === "workboard_promote"),
    "workboard_promote",
  );

  const done = await store.create({ title: "Completed card", status: "done" });
  const blocked = await store.create({ title: "Blocked recovery control", status: "blocked" });
  expect(done.completedAt).toBeDefined();

  for (const force of [false, true]) {
    await expect(promote.execute("promote-done", { id: done.id, force })).rejects.toThrow(
      "Cannot promote a completed Workboard card.",
    );
  }
  await promote.execute("promote-blocked", { id: blocked.id });

  await expect(store.get(done.id)).resolves.toMatchObject({
    status: "done",
    completedAt: done.completedAt,
  });
  await expect(store.get(blocked.id)).resolves.toMatchObject({ status: "ready" });
});
