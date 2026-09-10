// Memory Core plugin module owns durable native-batch submission quarantine state.
import type { DatabaseSync } from "node:sqlite";
import type { MemoryEmbeddingBatchSubmissionLifecycle } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import { upsertMemoryEmbeddingCache } from "./manager-embedding-cache.js";

const BATCH_SUBMISSION_QUARANTINE_META_KEY = "memory_batch_submission_quarantine_v1";

const MEMORY_BATCH_SUBMISSION_RECOVERY_ACTION =
  "Reconcile or cancel the listed provider jobs, then run openclaw memory index --force --clear-batch-quarantine.";

const MEMORY_BATCH_SUBMISSION_RESUME_ACTION =
  "Retry memory indexing; OpenClaw will resume acknowledged provider jobs only when their exact request fingerprints match.";

export type MemoryBatchSubmissionRecord = {
  provider: string;
  model?: string;
  providerKey?: string;
  submissionId: string;
  batchName?: string;
  requestFingerprint?: string;
  manifest?: Array<{ customId: string; chunkHash: string }>;
  startedAt: string;
};

type MemoryBatchSubmissionQuarantine = {
  version: 1 | 2;
  submissions: MemoryBatchSubmissionRecord[];
};

const MAX_BATCH_MANIFEST_ENTRIES = 50_000;
const RECOVERED_CACHE_WRITE_BATCH_SIZE = 128;

export type MemoryBatchSubmissionQuarantineStatus = {
  malformed: boolean;
  submissions: MemoryBatchSubmissionRecord[];
  recoveryAction: string;
};

function buildBatchSubmissionKey(provider: string, submissionId: string): string {
  return `${provider}\u0000${submissionId}`;
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isResumableSubmission(entry: MemoryBatchSubmissionRecord): boolean {
  return Boolean(entry.batchName && entry.requestFingerprint);
}

function parseBatchManifest(
  value: unknown,
): Array<{ customId: string; chunkHash: string }> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_MANIFEST_ENTRIES) {
    return null;
  }
  const manifest: Array<{ customId: string; chunkHash: string }> = [];
  const customIds = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    // SAFETY: the object guard above permits unknown manifest property inspection.
    const candidate = entry as Record<string, unknown>;
    if (
      !isNonEmptyBoundedString(candidate.customId, 200) ||
      !isNonEmptyBoundedString(candidate.chunkHash, 200) ||
      customIds.has(candidate.customId)
    ) {
      return null;
    }
    customIds.add(candidate.customId);
    manifest.push({ customId: candidate.customId, chunkHash: candidate.chunkHash });
  }
  return manifest;
}

function parseBatchSubmissionQuarantine(value: string): MemoryBatchSubmissionQuarantine | null {
  try {
    // SAFETY: parsed fields stay unknown and are validated below before use.
    const parsed = JSON.parse(value) as { version?: unknown; submissions?: unknown };
    if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.submissions)) {
      return null;
    }
    const submissions: MemoryBatchSubmissionRecord[] = [];
    for (const entry of parsed.submissions) {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      // SAFETY: the object guard above permits unknown property inspection.
      const candidate = entry as Record<string, unknown>;
      const manifest = parseBatchManifest(candidate.manifest);
      if (
        !isNonEmptyBoundedString(candidate.provider, 100) ||
        (candidate.model !== undefined && !isNonEmptyBoundedString(candidate.model, 500)) ||
        (candidate.providerKey !== undefined &&
          !isNonEmptyBoundedString(candidate.providerKey, 500)) ||
        !isNonEmptyBoundedString(candidate.submissionId, 200) ||
        !isNonEmptyBoundedString(candidate.startedAt, 100) ||
        (candidate.batchName !== undefined && !isNonEmptyBoundedString(candidate.batchName, 500)) ||
        (candidate.requestFingerprint !== undefined &&
          !isNonEmptyBoundedString(candidate.requestFingerprint, 100)) ||
        manifest === null ||
        (manifest !== undefined &&
          (candidate.model === undefined || candidate.providerKey === undefined))
      ) {
        return null;
      }
      submissions.push({
        provider: candidate.provider,
        ...(candidate.model ? { model: candidate.model } : {}),
        ...(candidate.providerKey ? { providerKey: candidate.providerKey } : {}),
        submissionId: candidate.submissionId,
        startedAt: candidate.startedAt,
        ...(candidate.batchName ? { batchName: candidate.batchName } : {}),
        ...(candidate.requestFingerprint
          ? { requestFingerprint: candidate.requestFingerprint }
          : {}),
        ...(manifest ? { manifest } : {}),
      });
    }
    return { version: parsed.version, submissions };
  } catch {
    return null;
  }
}

export class MemoryBatchSubmissionOwner {
  private readonly keysPendingCommit = new Set<string>();

  constructor(private readonly getDatabase: () => DatabaseSync) {}

  readStatus(): MemoryBatchSubmissionQuarantineStatus | undefined {
    const rowValue = this.getDatabase()
      .prepare(`SELECT value FROM memory_index_meta WHERE key = ?`)
      .get(BATCH_SUBMISSION_QUARANTINE_META_KEY);
    // SAFETY: this query selects exactly one SQLite value column.
    const row = rowValue as { value?: unknown } | undefined;
    if (!row) {
      return undefined;
    }
    if (typeof row.value !== "string") {
      return this.malformedStatus();
    }
    const parsed = parseBatchSubmissionQuarantine(row.value);
    if (!parsed || parsed.submissions.length === 0) {
      return this.malformedStatus();
    }
    return {
      malformed: false,
      submissions: parsed.submissions,
      recoveryAction: parsed.submissions.every(isResumableSubmission)
        ? MEMORY_BATCH_SUBMISSION_RESUME_ACTION
        : MEMORY_BATCH_SUBMISSION_RECOVERY_ACTION,
    };
  }

  assertReady(): void {
    const quarantine = this.readStatus();
    if (!quarantine) {
      return;
    }
    if (!quarantine.malformed && quarantine.submissions.every(isResumableSubmission)) {
      return;
    }
    const detail = quarantine.malformed
      ? "the durable quarantine record is malformed"
      : `${quarantine.submissions.length} provider submission${quarantine.submissions.length === 1 ? "" : "s"} require reconciliation`;
    throw new Error(
      `memory embedding batch submission quarantined: ${detail}. ${quarantine.recoveryAction}`,
    );
  }

  clear(): boolean {
    const result = this.getDatabase()
      .prepare(`DELETE FROM memory_index_meta WHERE key = ?`)
      .run(BATCH_SUBMISSION_QUARANTINE_META_KEY);
    this.keysPendingCommit.clear();
    return result.changes > 0;
  }

  createLifecycle(identity: {
    provider: { id: string; model: string };
    providerKey: string;
  }): MemoryEmbeddingBatchSubmissionLifecycle {
    const provider = identity.provider.id;
    const remove = (submissionId: string) => {
      this.update((current) =>
        current.filter(
          (entry) => entry.provider !== provider || entry.submissionId !== submissionId,
        ),
      );
      this.keysPendingCommit.delete(buildBatchSubmissionKey(provider, submissionId));
    };
    return {
      resumeAccepted: async ({ requestFingerprint }) => {
        if (!isNonEmptyBoundedString(requestFingerprint, 100)) {
          throw new Error("memory embedding provider supplied an invalid request fingerprint");
        }
        let resumed: { submissionId: string; batchName: string } | null = null;
        let resumedKey: string | null = null;
        this.update((current) => {
          const matches = current.filter(
            (entry) =>
              entry.provider === provider &&
              entry.requestFingerprint === requestFingerprint &&
              entry.batchName,
          );
          if (matches.length > 1) {
            throw new Error("memory embedding batch quarantine has duplicate request fingerprints");
          }
          const match = matches[0];
          if (!match?.batchName) {
            return current;
          }
          resumed = { submissionId: match.submissionId, batchName: match.batchName };
          resumedKey = buildBatchSubmissionKey(provider, match.submissionId);
          return current;
        });
        if (resumedKey) {
          this.keysPendingCommit.add(resumedKey);
        }
        return resumed;
      },
      listAccepted: async () => {
        const status = this.readStatus();
        if (!status || status.malformed) {
          return [];
        }
        return status.submissions.flatMap((entry) => {
          if (
            entry.provider !== provider ||
            entry.model !== identity.provider.model ||
            entry.providerKey !== identity.providerKey ||
            !entry.batchName ||
            !entry.requestFingerprint ||
            !entry.manifest
          ) {
            return [];
          }
          return [
            {
              submissionId: entry.submissionId,
              batchName: entry.batchName,
              requestFingerprint: entry.requestFingerprint,
              manifest: entry.manifest.map((item) => ({ ...item })),
            },
          ];
        });
      },
      publishRecovered: async ({ submissionId, entries }) => {
        if (!isNonEmptyBoundedString(submissionId, 200)) {
          throw new Error("memory embedding provider supplied an invalid batch submission id");
        }
        const byCustomId = new Map<string, number[]>();
        for (const entry of entries) {
          if (
            !isNonEmptyBoundedString(entry.customId, 200) ||
            !Array.isArray(entry.embedding) ||
            entry.embedding.length === 0 ||
            entry.embedding.some((value) => !Number.isFinite(value)) ||
            byCustomId.has(entry.customId)
          ) {
            throw new Error("memory embedding provider supplied invalid recovered output");
          }
          byCustomId.set(entry.customId, entry.embedding);
        }

        let recovered: Array<{ chunkHash: string; embedding: number[] }> = [];
        const db = this.getDatabase();
        const rowValue = db
          .prepare(`SELECT value FROM memory_index_meta WHERE key = ?`)
          .get(BATCH_SUBMISSION_QUARANTINE_META_KEY);
        // SAFETY: this query selects exactly one SQLite value column.
        const row = rowValue as { value?: unknown } | undefined;
        if (!row || typeof row.value !== "string") {
          throw new Error(
            `memory embedding batch submission is not durably owned: ${submissionId}`,
          );
        }
        const parsed = parseBatchSubmissionQuarantine(row.value);
        if (!parsed) {
          throw new Error("memory embedding batch quarantine record is malformed");
        }
        const record = parsed.submissions.find(
          (entry) => entry.provider === provider && entry.submissionId === submissionId,
        );
        if (!record?.manifest || !record.batchName) {
          throw new Error(
            `memory embedding batch submission has no restart-safe manifest: ${submissionId}`,
          );
        }
        if (
          record.model !== identity.provider.model ||
          record.providerKey !== identity.providerKey
        ) {
          throw new Error(
            `memory embedding batch submission belongs to a different provider identity: ${submissionId}`,
          );
        }
        recovered = record.manifest.map((item) => {
          const embedding = byCustomId.get(item.customId);
          if (!embedding) {
            throw new Error(`memory embedding recovered output is incomplete for ${item.customId}`);
          }
          return { chunkHash: item.chunkHash, embedding };
        });

        // Cache publication is idempotent. Bound each writer hold, and retain the
        // durable reservation until every row has landed so a restart safely retries.
        const now = Date.now();
        for (let start = 0; start < recovered.length; start += RECOVERED_CACHE_WRITE_BATCH_SIZE) {
          const entries = recovered.slice(start, start + RECOVERED_CACHE_WRITE_BATCH_SIZE);
          runSqliteImmediateTransactionSync(db, () => {
            upsertMemoryEmbeddingCache({
              db,
              enabled: true,
              provider: identity.provider,
              providerKey: identity.providerKey,
              entries: entries.map((entry) => ({
                hash: entry.chunkHash,
                embedding: entry.embedding,
              })),
              now,
            });
          });
        }

        runSqliteImmediateTransactionSync(db, () => {
          const currentValueRaw = db
            .prepare(`SELECT value FROM memory_index_meta WHERE key = ?`)
            .get(BATCH_SUBMISSION_QUARANTINE_META_KEY);
          // SAFETY: this query selects exactly one SQLite value column.
          const currentValue = currentValueRaw as { value?: unknown } | undefined;
          if (!currentValue || typeof currentValue.value !== "string") {
            throw new Error(
              `memory embedding batch submission ownership changed during recovery: ${submissionId}`,
            );
          }
          const current = parseBatchSubmissionQuarantine(currentValue.value);
          if (!current) {
            throw new Error("memory embedding batch quarantine record is malformed");
          }
          const stillOwned = current.submissions.some(
            (entry) => entry.provider === provider && entry.submissionId === submissionId,
          );
          if (!stillOwned) {
            throw new Error(
              `memory embedding batch submission ownership changed during recovery: ${submissionId}`,
            );
          }
          const next = current.submissions.filter(
            (entry) => entry.provider !== provider || entry.submissionId !== submissionId,
          );
          if (next.length === 0) {
            db.prepare(`DELETE FROM memory_index_meta WHERE key = ?`).run(
              BATCH_SUBMISSION_QUARANTINE_META_KEY,
            );
          } else {
            db.prepare(
              `INSERT INTO memory_index_meta (key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ).run(
              BATCH_SUBMISSION_QUARANTINE_META_KEY,
              JSON.stringify({ version: 2, submissions: next }),
            );
          }
        });
        this.keysPendingCommit.delete(buildBatchSubmissionKey(provider, submissionId));
        return recovered;
      },
      started: async ({ submissionId, requestFingerprint, manifest }) => {
        if (!isNonEmptyBoundedString(submissionId, 200)) {
          throw new Error("memory embedding provider supplied an invalid batch submission id");
        }
        if (requestFingerprint !== undefined && !isNonEmptyBoundedString(requestFingerprint, 100)) {
          throw new Error("memory embedding provider supplied an invalid request fingerprint");
        }
        const validatedManifest = parseBatchManifest(manifest);
        if (validatedManifest === null) {
          throw new Error("memory embedding provider supplied an invalid recovery manifest");
        }
        this.update((current) => {
          const foreignReservation = current.find(
            (entry) =>
              !this.keysPendingCommit.has(
                buildBatchSubmissionKey(entry.provider, entry.submissionId),
              ),
          );
          if (foreignReservation) {
            throw new Error(
              "memory embedding batch submission is already reserved by another sync",
            );
          }
          if (
            current.some(
              (entry) => entry.provider === provider && entry.submissionId === submissionId,
            )
          ) {
            throw new Error(`memory embedding batch submission id already exists: ${submissionId}`);
          }
          return [
            ...current,
            {
              provider,
              model: identity.provider.model,
              providerKey: identity.providerKey,
              submissionId,
              startedAt: new Date().toISOString(),
              ...(requestFingerprint ? { requestFingerprint } : {}),
              ...(validatedManifest ? { manifest: validatedManifest } : {}),
            },
          ];
        });
        this.keysPendingCommit.add(buildBatchSubmissionKey(provider, submissionId));
      },
      accepted: async ({ submissionId, batchName }) => {
        if (!isNonEmptyBoundedString(batchName, 500)) {
          throw new Error("memory embedding provider supplied an invalid batch resource name");
        }
        let found = false;
        this.update((current) =>
          current.map((entry) => {
            if (entry.provider !== provider || entry.submissionId !== submissionId) {
              return entry;
            }
            found = true;
            return { ...entry, batchName };
          }),
        );
        if (!found) {
          throw new Error(
            `memory embedding batch submission is not durably owned: ${submissionId}`,
          );
        }
      },
      rejected: async ({ submissionId }) => {
        remove(submissionId);
      },
    };
  }

  commit(): void {
    if (this.keysPendingCommit.size === 0) {
      return;
    }
    this.update((current) =>
      current.filter(
        (entry) =>
          !this.keysPendingCommit.has(buildBatchSubmissionKey(entry.provider, entry.submissionId)),
      ),
    );
    this.keysPendingCommit.clear();
  }

  private malformedStatus(): MemoryBatchSubmissionQuarantineStatus {
    return {
      malformed: true,
      submissions: [],
      recoveryAction: MEMORY_BATCH_SUBMISSION_RECOVERY_ACTION,
    };
  }

  private update(
    update: (current: MemoryBatchSubmissionRecord[]) => MemoryBatchSubmissionRecord[],
  ): void {
    const db = this.getDatabase();
    runSqliteImmediateTransactionSync(db, () => {
      const rowValue = db
        .prepare(`SELECT value FROM memory_index_meta WHERE key = ?`)
        .get(BATCH_SUBMISSION_QUARANTINE_META_KEY);
      // SAFETY: this query selects exactly one SQLite value column.
      const row = rowValue as { value?: unknown } | undefined;
      let current: MemoryBatchSubmissionRecord[] = [];
      if (row) {
        if (typeof row.value !== "string") {
          throw new Error("memory embedding batch quarantine record is malformed");
        }
        const parsed = parseBatchSubmissionQuarantine(row.value);
        if (!parsed) {
          throw new Error("memory embedding batch quarantine record is malformed");
        }
        current = parsed.submissions;
      }
      const next = update(current);
      if (next.length === 0) {
        db.prepare(`DELETE FROM memory_index_meta WHERE key = ?`).run(
          BATCH_SUBMISSION_QUARANTINE_META_KEY,
        );
        return;
      }
      const value = JSON.stringify({ version: 2, submissions: next });
      db.prepare(
        `INSERT INTO memory_index_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(BATCH_SUBMISSION_QUARANTINE_META_KEY, value);
    });
  }
}
