import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

describe("WorkboardStore attachments", () => {
  it("stores attachments in SQLite and adds worker context", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const card = await store.create({ title: "Review attached log" });

    const attached = await store.addAttachment(card.id, {
      fileName: "failure.log",
      mimeType: "text/plain",
      note: "Captured failing run",
      contentBase64: Buffer.from("stack trace").toString("base64"),
    });

    expect(attached.metadata?.attachments?.[0]).toMatchObject({
      fileName: "failure.log",
      byteSize: "stack trace".length,
      mimeType: "text/plain",
    });
    expect(attached.events?.at(-1)).toMatchObject({ kind: "attachment_added" });
    const attachment = attached.metadata?.attachments?.[0];
    if (!attachment) {
      throw new Error("expected attachment metadata");
    }
    const persisted = await store.getAttachment(attachment.id);
    if (!persisted) {
      throw new Error("expected persisted attachment");
    }
    expect(Buffer.from(persisted.contentBase64, "base64").toString("utf8")).toBe("stack trace");
    await expect(
      store.addAttachment(card.id, {
        fileName: "huge.bin",
        contentBase64: Buffer.alloc(256 * 1024 + 1).toString("base64"),
      }),
    ).rejects.toThrow(/attachment must be/);
    await expect(
      store.addAttachment(card.id, {
        fileName: "sqlite-sized.bin",
        contentBase64: Buffer.alloc(70 * 1024).toString("base64"),
      }),
    ).resolves.toMatchObject({
      metadata: {
        attachments: expect.arrayContaining([
          expect.objectContaining({ fileName: "sqlite-sized.bin" }),
        ]),
      },
    });
    await expect(
      store.addAttachment(card.id, {
        fileName: "padded.txt",
        contentBase64: `${Buffer.from("ok").toString("base64")}\n`,
      }),
    ).rejects.toThrow(/canonical base64/);

    const context = await store.buildWorkerContext(card.id);
    expect(context).toContain("failure.log");

    const deleted = await store.deleteAttachment(card.id, attachment.id);
    expect(deleted.metadata?.attachments).toEqual([
      expect.objectContaining({ fileName: "sqlite-sized.bin" }),
    ]);
    expect(deleted.events?.at(-1)).toMatchObject({ kind: "edited" });
    expect(await store.getAttachment(attachment.id)).toBeUndefined();

    const budgetCard = await store.create({
      title: "Attachment budget boundary",
      metadata: {
        comments: Array.from({ length: 12 }, (_, index) => ({
          id: `comment-${index}`,
          body: "x".repeat(1970),
          createdAt: 1,
        })),
      },
    });
    expect(budgetCard.metadata?.comments).toHaveLength(12);
    const deleteBlob = stores.attachments.delete.bind(stores.attachments);
    let rejectedAttachmentId: string | undefined;
    using deletion = vi.spyOn(stores.attachments, "delete").mockImplementation(async (id) => {
      if (rejectedAttachmentId) {
        throw new Error("attachment was already deleted");
      }
      rejectedAttachmentId = id;
      return deleteBlob(id);
    });
    await expect(
      store.addAttachment(budgetCard.id, {
        fileName: "f".repeat(240),
        note: "n".repeat(400),
        mimeType: "m".repeat(160),
        contentBase64: Buffer.from("proof").toString("base64"),
      }),
    ).rejects.toThrow("attachment metadata was trimmed before it could be indexed.");
    expect(deletion).toHaveBeenCalledTimes(1);
    expect(rejectedAttachmentId).toBeDefined();
    expect(await store.getAttachment(rejectedAttachmentId!)).toBeUndefined();
    await expect(store.get(budgetCard.id)).resolves.toMatchObject({
      metadata: { comments: budgetCard.metadata?.comments },
    });
  });

  it("removes attachment blobs when the card attachment index prunes old entries", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Many attachments", templateId: "docs" });
    let firstAttachmentId = "";

    for (let index = 0; index < 21; index += 1) {
      const updated = await store.addAttachment(card.id, {
        fileName: `log-${index}.txt`,
        contentBase64: Buffer.from(`log ${index}`).toString("base64"),
      });
      firstAttachmentId ||= updated.metadata?.attachments?.[0]?.id ?? "";
    }

    const saved = await store.get(card.id);
    expect(saved?.metadata?.attachments).toHaveLength(20);
    expect(await store.getAttachment(firstAttachmentId)).toBeUndefined();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT attachment_id FROM workboard_attachment_blobs WHERE attachment_id = ?")
          .get(firstAttachmentId),
      ).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS count FROM workboard_attachment_blobs").get()).toEqual({
        count: 20,
      });
    } finally {
      db.close();
    }
    const exported = await store.exportCards();
    expect(exported.cards).toEqual([
      expect.objectContaining({
        id: card.id,
        metadata: expect.objectContaining({ templateId: "docs" }),
      }),
    ]);
    expect(exported.exportedAt).toEqual(expect.any(Number));
    expect(exported.attachments).toHaveLength(20);
    expect(exported.attachments[0]).not.toHaveProperty("contentBase64");
  });
});
