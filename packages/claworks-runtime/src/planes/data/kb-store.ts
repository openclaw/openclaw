import { createHash, randomUUID } from "node:crypto";
import type { CwDatabase } from "./db-types.js";
import type {
  KbChunkRecord,
  KbCreateIngestJobParams,
  KbDocumentRecord,
  KbDocumentStatus,
  KbIngestJobRecord,
  KbIngestJobStatus,
  KbLayer,
  KbListDocumentsParams,
} from "./kb-types.js";

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToDocument(row: Record<string, unknown>): KbDocumentRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    source: row.source ? String(row.source) : undefined,
    layer: String(row.layer ?? "L2") as KbLayer,
    doc_type: row.doc_type ? String(row.doc_type) : undefined,
    namespace: row.namespace ? String(row.namespace) : undefined,
    status: String(row.status ?? "draft") as KbDocumentStatus,
    revision: Number(row.revision ?? 1),
    content_hash: row.content_hash ? String(row.content_hash) : undefined,
    metadata: parseJsonObject(row.metadata as string),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    published_at: row.published_at != null ? Number(row.published_at) : undefined,
  };
}

function rowToChunk(row: Record<string, unknown>): KbChunkRecord {
  return {
    id: String(row.id),
    document_id: String(row.document_id),
    seq: Number(row.seq),
    text: String(row.text),
    citation: row.citation ? String(row.citation) : undefined,
    metadata: parseJsonObject(row.metadata as string),
    created_at: Number(row.created_at),
  };
}

function rowToJob(row: Record<string, unknown>): KbIngestJobRecord {
  return {
    id: String(row.id),
    status: String(row.status ?? "pending") as KbIngestJobStatus,
    source_path: row.source_path ? String(row.source_path) : undefined,
    folder_path: row.folder_path ? String(row.folder_path) : undefined,
    namespace: row.namespace ? String(row.namespace) : undefined,
    layer: row.layer ? (String(row.layer) as KbLayer) : undefined,
    doc_type: row.doc_type ? String(row.doc_type) : undefined,
    report: parseJsonObject(row.report as string),
    error: row.error ? String(row.error) : undefined,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    completed_at: row.completed_at != null ? Number(row.completed_at) : undefined,
  };
}

export function hashKbContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function createKbStore(db: CwDatabase) {
  return {
    countDocuments(status?: KbDocumentStatus): number {
      if (status) {
        const row = db
          .prepare("SELECT COUNT(*) AS c FROM cw_kb_documents WHERE status = ?")
          .get(status) as { c: number };
        return Number(row.c ?? 0);
      }
      const row = db.prepare("SELECT COUNT(*) AS c FROM cw_kb_documents").get() as { c: number };
      return Number(row.c ?? 0);
    },

    countChunks(): number {
      const row = db.prepare("SELECT COUNT(*) AS c FROM cw_kb_chunks").get() as { c: number };
      return Number(row.c ?? 0);
    },

    countIngestJobs(status?: KbIngestJobStatus): number {
      if (status) {
        const row = db
          .prepare("SELECT COUNT(*) AS c FROM cw_kb_ingest_jobs WHERE status = ?")
          .get(status) as { c: number };
        return Number(row.c ?? 0);
      }
      const row = db.prepare("SELECT COUNT(*) AS c FROM cw_kb_ingest_jobs").get() as { c: number };
      return Number(row.c ?? 0);
    },

    insertDocument(input: {
      title: string;
      source?: string;
      layer: KbLayer;
      doc_type?: string;
      namespace?: string;
      status?: KbDocumentStatus;
      content_hash?: string;
      metadata?: Record<string, unknown>;
    }): KbDocumentRecord {
      const now = Date.now();
      const id = randomUUID();
      const doc: KbDocumentRecord = {
        id,
        title: input.title,
        source: input.source,
        layer: input.layer,
        doc_type: input.doc_type,
        namespace: input.namespace,
        status: input.status ?? "draft",
        revision: 1,
        content_hash: input.content_hash,
        metadata: input.metadata ?? {},
        created_at: now,
        updated_at: now,
      };
      db.prepare(
        `INSERT INTO cw_kb_documents
         (id, title, source, layer, doc_type, namespace, status, revision, content_hash, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        doc.id,
        doc.title,
        doc.source ?? null,
        doc.layer,
        doc.doc_type ?? null,
        doc.namespace ?? null,
        doc.status,
        doc.revision,
        doc.content_hash ?? null,
        JSON.stringify(doc.metadata),
        doc.created_at,
        doc.updated_at,
      );
      return doc;
    },

    getDocument(id: string): KbDocumentRecord | null {
      const row = db.prepare("SELECT * FROM cw_kb_documents WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToDocument(row) : null;
    },

    listDocuments(params: KbListDocumentsParams = {}): KbDocumentRecord[] {
      const clauses: string[] = [];
      const values: unknown[] = [];
      if (params.status) {
        clauses.push("status = ?");
        values.push(params.status);
      }
      if (params.layer) {
        clauses.push("layer = ?");
        values.push(params.layer);
      }
      if (params.namespace) {
        clauses.push("namespace = ?");
        values.push(params.namespace);
      }
      if (params.q?.trim()) {
        clauses.push("(title LIKE ? OR source LIKE ? OR metadata LIKE ?)");
        const like = `%${params.q.trim()}%`;
        values.push(like, like, like);
      }
      const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT * FROM cw_kb_documents ${where} ORDER BY updated_at DESC LIMIT ${limit}`)
        .all(...values) as Record<string, unknown>[];
      return rows.map(rowToDocument);
    },

    updateDocumentStatus(id: string, status: KbDocumentStatus): KbDocumentRecord | null {
      const existing = this.getDocument(id);
      if (!existing) {
        return null;
      }
      const now = Date.now();
      const revision = existing.revision + 1;
      const publishedAt = status === "published" ? now : existing.published_at;
      db.prepare(
        `UPDATE cw_kb_documents
         SET status = ?, revision = ?, updated_at = ?, published_at = COALESCE(?, published_at)
         WHERE id = ?`,
      ).run(status, revision, now, publishedAt ?? null, id);
      return this.getDocument(id);
    },

    patchDocumentMetadata(id: string, patch: Record<string, unknown>): KbDocumentRecord | null {
      const existing = this.getDocument(id);
      if (!existing) {
        return null;
      }
      const now = Date.now();
      const metadata = { ...existing.metadata, ...patch };
      const revision = existing.revision + 1;
      db.prepare(
        `UPDATE cw_kb_documents SET metadata = ?, revision = ?, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(metadata), revision, now, id);
      return this.getDocument(id);
    },

    deleteChunksForDocument(documentId: string): void {
      db.prepare("DELETE FROM cw_kb_chunks WHERE document_id = ?").run(documentId);
    },

    insertChunks(
      documentId: string,
      chunks: Array<{ text: string; citation?: string }>,
    ): KbChunkRecord[] {
      this.deleteChunksForDocument(documentId);
      const now = Date.now();
      const records: KbChunkRecord[] = [];
      for (const [seq, chunk] of chunks.entries()) {
        const record: KbChunkRecord = {
          id: randomUUID(),
          document_id: documentId,
          seq,
          text: chunk.text,
          citation: chunk.citation,
          metadata: {},
          created_at: now,
        };
        db.prepare(
          `INSERT INTO cw_kb_chunks (id, document_id, seq, text, citation, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          record.id,
          record.document_id,
          record.seq,
          record.text,
          record.citation ?? null,
          JSON.stringify(record.metadata),
          record.created_at,
        );
        records.push(record);
      }
      return records;
    },

    listChunks(documentId: string): KbChunkRecord[] {
      const rows = db
        .prepare("SELECT * FROM cw_kb_chunks WHERE document_id = ? ORDER BY seq ASC")
        .all(documentId) as Record<string, unknown>[];
      return rows.map(rowToChunk);
    },

    searchPublishedChunks(params: {
      query: string;
      limit?: number;
      namespace?: string;
      layer?: KbLayer;
    }): Array<{ chunk: KbChunkRecord; document: KbDocumentRecord; score: number }> {
      const tokens = params.query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0);
      if (tokens.length === 0) {
        return [];
      }
      const clauses = ["d.status = 'published'"];
      const values: unknown[] = [];
      if (params.namespace) {
        clauses.push("d.namespace = ?");
        values.push(params.namespace);
      }
      if (params.layer) {
        clauses.push("d.layer = ?");
        values.push(params.layer);
      }
      const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
      const rows = db
        .prepare(
          `SELECT c.*, d.id AS doc_id, d.title AS doc_title, d.source AS doc_source, d.layer AS doc_layer,
                  d.namespace AS doc_namespace, d.revision AS doc_revision, d.status AS doc_status,
                  d.doc_type AS doc_type, d.metadata AS doc_metadata, d.created_at AS doc_created_at,
                  d.updated_at AS doc_updated_at, d.published_at AS doc_published_at, d.content_hash AS doc_content_hash
           FROM cw_kb_chunks c
           JOIN cw_kb_documents d ON d.id = c.document_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY c.seq ASC
           LIMIT 500`,
        )
        .all(...values) as Record<string, unknown>[];

      const hits: Array<{ chunk: KbChunkRecord; document: KbDocumentRecord; score: number }> = [];
      for (const row of rows) {
        const text = String(row.text).toLowerCase();
        const fullMatch = text.includes(params.query.toLowerCase()) ? 1 : 0;
        const tokenHits = tokens.filter((tok) => text.includes(tok)).length;
        const score =
          fullMatch > 0 ? 1 : tokenHits === tokens.length ? tokenHits / tokens.length : 0;
        if (score <= 0) {
          continue;
        }
        hits.push({
          chunk: rowToChunk(row),
          document: rowToDocument({
            id: row.doc_id,
            title: row.doc_title,
            source: row.doc_source,
            layer: row.doc_layer,
            doc_type: row.doc_type,
            namespace: row.doc_namespace,
            status: row.doc_status,
            revision: row.doc_revision,
            content_hash: row.doc_content_hash,
            metadata: row.doc_metadata,
            created_at: row.doc_created_at,
            updated_at: row.doc_updated_at,
            published_at: row.doc_published_at,
          }),
          score,
        });
      }
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, limit);
    },

    createIngestJob(
      params: KbCreateIngestJobParams & { report?: Record<string, unknown> },
    ): KbIngestJobRecord {
      const now = Date.now();
      const job: KbIngestJobRecord = {
        id: randomUUID(),
        status: "pending",
        source_path: params.source_path,
        folder_path: params.folder_path,
        namespace: params.namespace,
        layer: params.layer,
        doc_type: params.doc_type,
        report: params.report ?? {},
        created_at: now,
        updated_at: now,
      };
      db.prepare(
        `INSERT INTO cw_kb_ingest_jobs
         (id, status, source_path, folder_path, namespace, layer, doc_type, report, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        job.id,
        job.status,
        job.source_path ?? null,
        job.folder_path ?? null,
        job.namespace ?? null,
        job.layer ?? null,
        job.doc_type ?? null,
        JSON.stringify(job.report),
        job.created_at,
        job.updated_at,
      );
      return job;
    },

    getIngestJob(id: string): KbIngestJobRecord | null {
      const row = db.prepare("SELECT * FROM cw_kb_ingest_jobs WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToJob(row) : null;
    },

    updateIngestJob(
      id: string,
      patch: Partial<Pick<KbIngestJobRecord, "status" | "report" | "error" | "completed_at">>,
    ): KbIngestJobRecord | null {
      const existing = this.getIngestJob(id);
      if (!existing) {
        return null;
      }
      const next: KbIngestJobRecord = {
        ...existing,
        ...patch,
        report: patch.report ?? existing.report,
        updated_at: Date.now(),
      };
      db.prepare(
        `UPDATE cw_kb_ingest_jobs
         SET status = ?, report = ?, error = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      ).run(
        next.status,
        JSON.stringify(next.report),
        next.error ?? null,
        next.updated_at,
        next.completed_at ?? null,
        id,
      );
      return this.getIngestJob(id);
    },
  };
}

export type KbStore = ReturnType<typeof createKbStore>;
