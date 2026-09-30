import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

it("reopens a completed card through the real agent comment tool path", async () => {
  const store = createWorkboardSqliteTestStore();
  const card = await store.create({ title: "Reported preview failure", status: "done" });
  const tools = new Map(
    createWorkboardTools({ store, context: { agentId: "main" } }).map((tool) => [tool.name, tool]),
  );

  await expectDefined(tools.get("workboard_comment"), "workboard_comment").execute("feedback", {
    id: card.id,
    body: "The preview opens the wrong application.",
    kind: "failure-feedback",
  });

  await expect(store.get(card.id)).resolves.toMatchObject({
    status: "review",
    metadata: {
      comments: [expect.objectContaining({ body: "The preview opens the wrong application." })],
    },
  });
});
