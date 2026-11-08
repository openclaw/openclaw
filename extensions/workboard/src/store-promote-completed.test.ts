import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

it.each([
  "triage",
  "backlog",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
] as const)(
  "rejects normal and forced promotion from %s without changing the card",
  async (status) => {
    const store = createWorkboardSqliteTestStore();
    const promote = expectDefined(
      createWorkboardTools({ store }).find((tool) => tool.name === "workboard_promote"),
      "workboard_promote",
    );
    const card = await store.create({ title: "Not todo", status });

    for (const force of [false, true]) {
      await expect(
        promote.execute("promote-invalid", { id: card.id, force, reason: "Do not record this" }),
      ).rejects.toThrow(`Cannot promote Workboard card in ${status}; expected todo.`);
      await expect(store.get(card.id)).resolves.toEqual(card);
    }
  },
);

it("promotes todo cards and recovers blocked cards through unblock", async () => {
  const store = createWorkboardSqliteTestStore();
  const tools = createWorkboardTools({ store });
  const promote = expectDefined(
    tools.find((tool) => tool.name === "workboard_promote"),
    "workboard_promote",
  );
  const unblock = expectDefined(
    tools.find((tool) => tool.name === "workboard_unblock"),
    "workboard_unblock",
  );
  const todo = await store.create({ title: "Todo card", status: "todo" });
  const blocked = await store.create({ title: "Blocked recovery control", status: "blocked" });

  await promote.execute("promote-todo", { id: todo.id });
  await unblock.execute("unblock", { id: blocked.id });
  await promote.execute("promote-blocked", { id: blocked.id });

  await expect(store.get(todo.id)).resolves.toMatchObject({ status: "ready" });
  await expect(store.get(blocked.id)).resolves.toMatchObject({ status: "ready" });
});
