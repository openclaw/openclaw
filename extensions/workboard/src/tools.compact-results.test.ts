import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { toolsByName } from "./test/interaction-fixtures.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

describe("workboard write tool results", () => {
  it("answers a compact card that does not grow with the card's history", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = toolsByName(createWorkboardTools({ store, context: { agentId: "main" } }));
    const run = async (name: string, params: Record<string, unknown>) =>
      (await expectDefined(tools.get(`workboard_${name}`), name).execute(name, params))
        .details as Record<string, unknown>;
    const card = await store.create({ title: "Long thread", notes: "n".repeat(4_000) });
    for (let i = 0; i < 20; i++) {
      await store.addComment(card.id, { body: `${i} ${"x".repeat(700)}` });
    }

    const commented = await run("comment", { id: card.id, body: "one more" });
    const stored = expectDefined(await store.get(card.id), "stored card");
    expect(commented).toEqual({
      card: expect.objectContaining({ id: card.id, title: "Long thread", status: "todo" }),
      commentId: stored.metadata?.comments?.at(-1)?.id,
    });
    const { token } = await run("claim", { id: card.id });
    const writes = [
      commented,
      await run("move", { id: card.id, status: "review", token }),
      await run("heartbeat", { id: card.id, token }),
      await run("release", { id: card.id, token, status: "todo" }),
    ];
    for (const result of writes) {
      expect(result.card).not.toHaveProperty("metadata");
      expect(result.card).not.toHaveProperty("notes");
      expect(JSON.stringify(result).length).toBeLessThan(1_000);
    }

    const read = await run("read", { id: card.id });
    expect(read.card).toMatchObject({ notes: "n".repeat(4_000) });
    expect((read.card as typeof stored).metadata?.comments).toHaveLength(21);
  });
});
