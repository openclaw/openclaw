// Memory Core tests cover durable native-batch submission ownership.
import {
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { MemoryBatchSubmissionOwner } from "./manager-batch-submission.js";

describe("memory batch submission owner", () => {
  const { DatabaseSync } = requireNodeSqlite();
  const geminiIdentity = {
    provider: { id: "gemini", model: "gemini-embedding-2" },
    providerKey: "gemini-key",
  };

  function createDb() {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
    return db;
  }

  it("quarantines an accepted provider job across owner restart", async () => {
    const db = createDb();
    try {
      const owner = new MemoryBatchSubmissionOwner(() => db);
      const lifecycle = owner.createLifecycle(geminiIdentity);
      await lifecycle.started({ submissionId: "submission-1" });
      await lifecycle.accepted({ submissionId: "submission-1", batchName: "batches/job-1" });

      const restarted = new MemoryBatchSubmissionOwner(() => db);
      expect(restarted.readStatus()).toMatchObject({
        malformed: false,
        submissions: [
          {
            provider: "gemini",
            submissionId: "submission-1",
            batchName: "batches/job-1",
          },
        ],
      });
      expect(() => restarted.assertReady()).toThrow("require reconciliation");
    } finally {
      db.close();
    }
  });

  it("resumes an acknowledged provider job across owner restart by exact fingerprint", async () => {
    const db = createDb();
    try {
      const owner = new MemoryBatchSubmissionOwner(() => db);
      const lifecycle = owner.createLifecycle(geminiIdentity);
      await lifecycle.started({
        submissionId: "submission-1",
        requestFingerprint: "fingerprint-1",
      });
      await lifecycle.accepted({ submissionId: "submission-1", batchName: "batches/job-1" });

      const restarted = new MemoryBatchSubmissionOwner(() => db);
      expect(() => restarted.assertReady()).not.toThrow();
      const resumed = await restarted
        .createLifecycle(geminiIdentity)
        .resumeAccepted?.({ requestFingerprint: "fingerprint-1" });
      expect(resumed).toEqual({ submissionId: "submission-1", batchName: "batches/job-1" });

      restarted.commit();
      expect(restarted.readStatus()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("recovers an acknowledged job across source drift and atomically publishes its cache", async () => {
    const db = createDb();
    try {
      const owner = new MemoryBatchSubmissionOwner(() => db);
      const lifecycle = owner.createLifecycle(geminiIdentity);
      await lifecycle.started({
        submissionId: "submission-1",
        requestFingerprint: "fingerprint-old",
        manifest: [
          { customId: "chunk-a", chunkHash: "hash-a" },
          { customId: "chunk-b", chunkHash: "hash-b" },
        ],
      });
      await lifecycle.accepted({ submissionId: "submission-1", batchName: "batches/job-1" });

      const restarted = new MemoryBatchSubmissionOwner(() => db);
      const restartedLifecycle = restarted.createLifecycle(geminiIdentity);
      await expect(restartedLifecycle.listAccepted?.()).resolves.toEqual([
        {
          submissionId: "submission-1",
          batchName: "batches/job-1",
          requestFingerprint: "fingerprint-old",
          manifest: [
            { customId: "chunk-a", chunkHash: "hash-a" },
            { customId: "chunk-b", chunkHash: "hash-b" },
          ],
        },
      ]);
      await expect(
        restartedLifecycle.publishRecovered?.({
          submissionId: "submission-1",
          entries: [
            { customId: "chunk-a", embedding: [1, 0] },
            { customId: "chunk-b", embedding: [0, 1] },
          ],
        }),
      ).resolves.toEqual([
        { chunkHash: "hash-a", embedding: [1, 0] },
        { chunkHash: "hash-b", embedding: [0, 1] },
      ]);

      expect(
        db
          .prepare(
            `SELECT provider, model, provider_key, hash, embedding
             FROM memory_embedding_cache ORDER BY hash`,
          )
          .all(),
      ).toEqual([
        {
          provider: "gemini",
          model: "gemini-embedding-2",
          provider_key: "gemini-key",
          hash: "hash-a",
          embedding: "[1,0]",
        },
        {
          provider: "gemini",
          model: "gemini-embedding-2",
          provider_key: "gemini-key",
          hash: "hash-b",
          embedding: "[0,1]",
        },
      ]);
      expect(restarted.readStatus()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("keeps the reservation and cache unchanged when recovered output is incomplete", async () => {
    const db = createDb();
    try {
      const owner = new MemoryBatchSubmissionOwner(() => db);
      const lifecycle = owner.createLifecycle(geminiIdentity);
      await lifecycle.started({
        submissionId: "submission-1",
        requestFingerprint: "fingerprint-old",
        manifest: [
          { customId: "chunk-a", chunkHash: "hash-a" },
          { customId: "chunk-b", chunkHash: "hash-b" },
        ],
      });
      await lifecycle.accepted({ submissionId: "submission-1", batchName: "batches/job-1" });

      await expect(
        lifecycle.publishRecovered?.({
          submissionId: "submission-1",
          entries: [{ customId: "chunk-a", embedding: [1, 0] }],
        }),
      ).rejects.toThrow("output is incomplete");
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get()).toEqual({
        count: 0,
      });
      expect(owner.readStatus()?.submissions).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("never recovers a completed job under a different model or cache identity", async () => {
    const db = createDb();
    try {
      const owner = new MemoryBatchSubmissionOwner(() => db);
      const lifecycle = owner.createLifecycle(geminiIdentity);
      await lifecycle.started({
        submissionId: "submission-1",
        requestFingerprint: "fingerprint-old",
        manifest: [{ customId: "chunk-a", chunkHash: "hash-a" }],
      });
      await lifecycle.accepted({ submissionId: "submission-1", batchName: "batches/job-1" });

      const changedLifecycle = new MemoryBatchSubmissionOwner(() => db).createLifecycle({
        provider: { id: "gemini", model: "gemini-embedding-future" },
        providerKey: "future-key",
      });
      await expect(changedLifecycle.listAccepted?.()).resolves.toEqual([]);
      await expect(
        changedLifecycle.publishRecovered?.({
          submissionId: "submission-1",
          entries: [{ customId: "chunk-a", embedding: [1, 0] }],
        }),
      ).rejects.toThrow("different provider identity");
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get()).toEqual({
        count: 0,
      });
      expect(owner.readStatus()?.submissions).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("does not adopt or submit past an acknowledged job with a different fingerprint", async () => {
    const db = createDb();
    try {
      const owner = new MemoryBatchSubmissionOwner(() => db);
      const lifecycle = owner.createLifecycle(geminiIdentity);
      await lifecycle.started({
        submissionId: "submission-1",
        requestFingerprint: "fingerprint-1",
      });
      await lifecycle.accepted({ submissionId: "submission-1", batchName: "batches/job-1" });

      const restarted = new MemoryBatchSubmissionOwner(() => db);
      const restartedLifecycle = restarted.createLifecycle(geminiIdentity);
      await expect(
        restartedLifecycle.resumeAccepted?.({ requestFingerprint: "fingerprint-2" }),
      ).resolves.toBeNull();
      await expect(
        restartedLifecycle.started({
          submissionId: "submission-2",
          requestFingerprint: "fingerprint-2",
        }),
      ).rejects.toThrow("already reserved by another sync");
    } finally {
      db.close();
    }
  });

  it("removes a reservation after a definitive pre-submit rejection", async () => {
    const db = createDb();
    try {
      const owner = new MemoryBatchSubmissionOwner(() => db);
      const lifecycle = owner.createLifecycle(geminiIdentity);
      await lifecycle.started({ submissionId: "submission-1" });
      await lifecycle.rejected({ submissionId: "submission-1" });

      expect(owner.readStatus()).toBeUndefined();
      expect(() => owner.assertReady()).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("clears only this sync's reservations after local publication commits", async () => {
    const db = createDb();
    try {
      const owner = new MemoryBatchSubmissionOwner(() => db);
      const lifecycle = owner.createLifecycle(geminiIdentity);
      await lifecycle.started({ submissionId: "submission-1" });
      await lifecycle.accepted({ submissionId: "submission-1", batchName: "batches/job-1" });

      owner.commit();

      expect(owner.readStatus()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("serializes reservations across independent owners", async () => {
    const db = createDb();
    try {
      const first = new MemoryBatchSubmissionOwner(() => db);
      const second = new MemoryBatchSubmissionOwner(() => db);
      await first.createLifecycle(geminiIdentity).started({ submissionId: "submission-1" });

      await expect(
        second.createLifecycle(geminiIdentity).started({ submissionId: "submission-2" }),
      ).rejects.toThrow("already reserved by another sync");
    } finally {
      db.close();
    }
  });

  it("fails closed on malformed durable state until explicitly cleared", () => {
    const db = createDb();
    try {
      db.prepare(`INSERT INTO memory_index_meta (key, value) VALUES (?, ?)`).run(
        "memory_batch_submission_quarantine_v1",
        "not json",
      );
      const owner = new MemoryBatchSubmissionOwner(() => db);

      expect(owner.readStatus()).toMatchObject({ malformed: true, submissions: [] });
      expect(() => owner.assertReady()).toThrow("record is malformed");
      expect(owner.clear()).toBe(true);
      expect(owner.readStatus()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
