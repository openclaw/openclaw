import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

export type DocChunk = {
  id: string;
  documentId: string;
  documentName: string;
  text: string;
  section?: string;
  page?: number;
  createdAt: number;
};

export type DocMeta = {
  id: string;
  name: string;
  path: string;
  chunkCount: number;
  createdAt: number;
};

type SqliteDb = Awaited<ReturnType<typeof import("node:sqlite")["open"]>>;

export class DoclingStore {
  private db: SqliteDb | null = null;
  private openai: OpenAI | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  private async ensureDb(): Promise<SqliteDb> {
    if (this.db) return this.db;
    if (this.initPromise) {
      await this.initPromise;
      return this.db!;
    }
    this.initPromise = this.doInit();
    await this.initPromise;
    return this.db!;
  }

  private async doInit(): Promise<void> {
    const sqlite = await import("node:sqlite");
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = await sqlite.open(this.dbPath);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        document_name TEXT NOT NULL,
        text TEXT NOT NULL,
        section TEXT,
        page INTEGER,
        vector BLOB,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id)
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
    `);

    if (this.apiKey) {
      this.openai = new OpenAI({ apiKey: this.apiKey });
    }
  }

  private async embed(text: string): Promise<number[]> {
    if (!this.openai) {
      throw new Error("OpenAI API key required for embeddings");
    }
    const res = await this.openai.embeddings.create({
      model: this.model,
      input: text,
    });
    const vec = res.data[0]?.embedding;
    if (!vec || !Array.isArray(vec)) {
      throw new Error("Invalid embedding response");
    }
    return vec;
  }

  async ingest(
    documentId: string,
    documentName: string,
    documentPath: string,
    chunks: Array<{ text: string; section?: string }>,
  ): Promise<number> {
    const db = await this.ensureDb();
    const now = Date.now();

    await db.run(
      "INSERT OR REPLACE INTO documents (id, name, path, chunk_count, created_at) VALUES (?, ?, ?, ?, ?)",
      documentId,
      documentName,
      documentPath,
      chunks.length,
      now,
    );

    for (const c of chunks) {
      const id = randomUUID();
      const vector = await this.embed(c.text);
      const vectorBlob = Buffer.from(new Float32Array(vector).buffer);

      await db.run(
        "INSERT INTO chunks (id, document_id, document_name, text, section, vector, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        documentId,
        documentName,
        c.text,
        c.section ?? null,
        vectorBlob,
        now,
      );
    }
    return chunks.length;
  }

  async search(query: string, limit = 5): Promise<Array<{ chunk: DocChunk; score: number }>> {
    const db = await this.ensureDb();
    const queryVec = await this.embed(query);

    const rows = await db.all(
      "SELECT id, document_id, document_name, text, section, page, created_at, vector FROM chunks",
    );

    const results: Array<{ chunk: DocChunk; score: number }> = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      const vecBlob = row.vector as Buffer | null;
      if (!vecBlob) continue;
      const vec = Array.from(new Float32Array(vecBlob.buffer));
      const score = cosineSimilarity(queryVec, vec);
      results.push({
        chunk: {
          id: row.id as string,
          documentId: row.document_id as string,
          documentName: row.document_name as string,
          text: row.text as string,
          section: row.section as string | undefined,
          page: row.page as number | undefined,
          createdAt: row.created_at as number,
        },
        score,
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async listDocuments(): Promise<DocMeta[]> {
    const db = await this.ensureDb();
    const rows = await db.all(
      "SELECT id, name, path, chunk_count, created_at FROM documents ORDER BY created_at DESC",
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      path: r.path as string,
      chunkCount: r.chunk_count as number,
      createdAt: r.created_at as number,
    }));
  }

  async removeDocument(documentId: string): Promise<boolean> {
    const db = await this.ensureDb();
    await db.run("DELETE FROM chunks WHERE document_id = ?", documentId);
    const result = await db.run("DELETE FROM documents WHERE id = ?", documentId);
    return (result.changes ?? 0) > 0;
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
