import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, vi } from "vitest";
import { sqliteOnly as test } from "./test/sqlite-only.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function createInputPolicy() {
  let enabled = true;
  const denied = new Error("client input commits are disabled");
  const assertInputCommitAllowed = vi.fn(() => {
    if (!enabled) {
      throw denied;
    }
  });
  // A lifecycle assertion is not a SQL-safe input-policy capability.
  const assertInvocationCurrent = vi.fn(() => {
    throw new Error("lifecycle authority must not be borrowed by SQLite");
  });
  return {
    denied,
    disable: () => {
      enabled = false;
    },
    context: { agentId: "main", assertInputCommitAllowed, assertInvocationCurrent },
  };
}

function uploadTool(params: Parameters<typeof createWorkboardTools>[0]) {
  const tool = createWorkboardTools(params).find(
    (entry) => entry.name === "workboard_attachment_add",
  );
  if (!tool) {
    throw new Error("Workboard attachment tool was not created");
  }
  return tool;
}

function uploadInput(id: string) {
  return { id, fileName: "proof.txt", contentBase64: "cHJvb2Y=" };
}

describe("Workboard tool input commit policy", () => {
  // Inspects uncommitted and orphaned blobs through a native SQLite file handle.
  test("rechecks input policy after waiting in the real mutation queue", async () => {
    const policy = createInputPolicy();
    const blocked = createDeferred<void>();
    const release = createDeferred<void>();
    const uploadQueued = createDeferred<void>();
    let holdNextWrite = false;
    const { store, dbPath } = createWorkboardSqliteTestHarness({
      beforeCardWrite: async () => {
        if (holdNextWrite) {
          holdNextWrite = false;
          blocked.resolve();
          await release.promise;
        }
      },
    });
    const card = await store.create({ title: "Queued client upload" });
    using db = new DatabaseSync(dbPath, { readOnly: true });
    const add = store.addAttachment.bind(store);
    using adding = vi.spyOn(store, "addAttachment").mockImplementation((...args) => {
      const pending = add(...args);
      uploadQueued.resolve();
      return pending;
    });
    const tool = uploadTool({ store, context: policy.context });
    holdNextWrite = true;
    const prior = store.update(card.id, { notes: "Unrelated admitted edit" });
    let uploading: Promise<unknown> | undefined;
    try {
      await blocked.promise;
      uploading = tool
        .execute("queued-upload", {
          ...uploadInput(card.id),
          // Raw arguments cannot replace the host-provided callback or claim an internal origin.
          assertInputCommitAllowed: "allow",
          internal: { syntheticClient: true },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await Promise.race([
        uploadQueued.promise,
        uploading.then(() => {
          throw new Error("Upload settled before reaching the mutation queue");
        }),
      ]);
      expect(adding).toHaveBeenCalledOnce();
      expect(db.prepare("SELECT attachment_id FROM workboard_attachment_blobs").all()).toEqual([]);
      policy.disable();
      release.resolve();
      await prior;
      expect.soft(await uploading).toBe(policy.denied);
      expect.soft((await store.listAttachments(card.id)).attachments).toEqual([]);
      expect
        .soft(db.prepare("SELECT attachment_id FROM workboard_attachment_blobs").all())
        .toEqual([]);
      expect(policy.context.assertInvocationCurrent).not.toHaveBeenCalled();
      await expect(store.get(card.id)).resolves.toMatchObject({ notes: "Unrelated admitted edit" });
    } finally {
      release.resolve();
      await Promise.allSettled([prior, uploading]);
    }
  });

  // Inspects committed and orphaned blobs through a native SQLite file handle.
  test.each(["blob-committed", "metadata-write"] as const)(
    "rechecks input policy at %s and removes the already committed blob",
    async (phase) => {
      const policy = createInputPolicy();
      let uploadStarted = false;
      const { store, stores, dbPath } = createWorkboardSqliteTestHarness({
        beforeCardWrite: async () => {
          if (uploadStarted && phase === "metadata-write") {
            policy.disable();
          }
        },
      });
      const card = await store.create({ title: "Late client upload" });
      using db = new DatabaseSync(dbPath, { readOnly: true });
      const register = stores.attachments.register.bind(stores.attachments);
      using registering = vi
        .spyOn(stores.attachments, "register")
        .mockImplementation(async (...args) => {
          await register(...args);
          // This read observes the real worker commit before card metadata can publish.
          expect(
            db.prepare("SELECT hex(content) AS content FROM workboard_attachment_blobs").all(),
          ).toEqual([{ content: "70726F6F66" }]);
          expect((await store.listAttachments(card.id)).attachments).toEqual([]);
          if (phase === "blob-committed") {
            policy.disable();
          }
        });
      const tool = uploadTool({ store, context: policy.context });
      uploadStarted = true;
      const error = await tool.execute("late-upload", uploadInput(card.id)).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect.soft(error).toBe(policy.denied);
      expect(registering).toHaveBeenCalledOnce();
      expect.soft((await store.listAttachments(card.id)).attachments).toEqual([]);
      // Attachment-store reads join metadata and would hide an orphaned blob.
      expect
        .soft(db.prepare("SELECT attachment_id FROM workboard_attachment_blobs").all())
        .toEqual([]);
      expect(policy.context.assertInvocationCurrent).not.toHaveBeenCalled();
    },
  );

  // Verifies the physical blob count through a native SQLite file handle.
  test.each(["enabled-client", "internal-without-context"] as const)(
    "keeps %s uploads working without borrowing lifecycle authority",
    async (origin) => {
      const policy = createInputPolicy();
      const { store, dbPath } = createWorkboardSqliteTestHarness();
      const card = await store.create({ title: "Allowed upload" });
      const tool = uploadTool({
        store,
        context: origin === "enabled-client" ? policy.context : undefined,
      });
      await tool.execute("allowed-upload", uploadInput(card.id));
      const { attachments } = await store.listAttachments(card.id);
      expect(attachments).toEqual([
        expect.objectContaining({ fileName: "proof.txt", byteSize: 5 }),
      ]);
      await expect(store.getAttachment(attachments[0]!.id)).resolves.toMatchObject({
        contentBase64: "cHJvb2Y=",
      });
      using db = new DatabaseSync(dbPath, { readOnly: true });
      expect(db.prepare("SELECT COUNT(*) AS count FROM workboard_attachment_blobs").get()).toEqual({
        count: 1,
      });
      if (origin === "enabled-client") {
        expect(policy.context.assertInputCommitAllowed).toHaveBeenCalled();
      } else {
        expect(policy.context.assertInputCommitAllowed).not.toHaveBeenCalled();
      }
      expect(policy.context.assertInvocationCurrent).not.toHaveBeenCalled();
    },
  );
});
