import { describe, expect, it, vi } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("workboard cards.specify revisions", () => {
  it("returns a redacted conflict and keeps the card when the revision is stale", async () => {
    const { api, invoke } = createGatewayMethodCapture();
    const store = createWorkboardSqliteTestStore();
    registerWorkboardGatewayMethods({ api, store });
    const base = await store.create({ title: "Rough card", status: "triage" });
    await store.addComment(base.id, { body: "caller-visible comment" });
    const readCopy = (await store.get(base.id))!;
    const newer = await store.update(base.id, { notes: "Host edit" });

    const response = await invoke("workboard.cards.specify", {
      id: base.id,
      title: "Specified from the stale read",
      summary: "stale summary",
      expectedUpdatedAt: readCopy.updatedAt,
    });

    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "workboard_conflict",
        details: {
          type: "workboard_card_conflict",
          card: expect.objectContaining({ id: base.id, status: "triage" }),
        },
      }),
    );
    await expect(store.get(base.id)).resolves.toEqual(newer);
    await expect(store.get(base.id)).resolves.toMatchObject({
      metadata: { comments: [expect.objectContaining({ body: "caller-visible comment" })] },
    });
  });

  it("rejects a non-numeric expectedUpdatedAt and preserves the card", async () => {
    const { api, methods } = createGatewayMethodCapture();
    const store = createWorkboardSqliteTestStore();
    registerWorkboardGatewayMethods({ api, store });
    const card = await store.create({ title: "Rough card", status: "triage" });

    const respond = vi.fn();
    await methods.get("workboard.cards.specify")!.handler({
      params: { id: card.id, title: "Specified", expectedUpdatedAt: "stale" },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[2]?.message).toBe("expectedUpdatedAt must be a finite number.");
    await expect(store.get(card.id)).resolves.toEqual(card);
  });

  it("still specifies when the caller revision matches", async () => {
    const { api, invoke } = createGatewayMethodCapture();
    const store = createWorkboardSqliteTestStore();
    registerWorkboardGatewayMethods({ api, store });
    const card = await store.create({ title: "Rough card", status: "triage" });
    const readCopy = (await store.get(card.id))!;

    const response = await invoke("workboard.cards.specify", {
      id: card.id,
      title: "Specified",
      expectedUpdatedAt: readCopy.updatedAt,
    });

    expect(response.mock.calls[0]?.[0]).toBe(true);
    await expect(store.get(card.id)).resolves.toMatchObject({ title: "Specified", status: "todo" });
  });
});
