/**
 * Document and chunk storage for the Docling RAG extension.
 *
 * Uses JSON file storage for document metadata and chunk text.
 * Embedding-based search uses cosine similarity on stored vectors.
 *
 * A simple, dependency-free implementation that works without
 * any external database. Can be upgraded to SQLite-vec or LanceDB later.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DocumentRecord, DocumentChunk, SearchResult } from "./types.js";

export class DocumentStore {
  private readonly storePath: string;
  private readonly docsPath: string;
  private readonly chunksPath: string;
  private documents: Map<string, DocumentRecord> = new Map();
  private chunks: Map<string, DocumentChunk[]> = new Map();

  constructor(storePath: string) {
    this.storePath = storePath.replace(/^~/, process.env.HOME ?? "~");
    this.docsPath = path.join(this.storePath, "documents.json");
    this.chunksPath = path.join(this.storePath, "chunks");
    this.ensureDir();
    this.load();
  }

  private ensureDir(): void {
    fs.mkdirSync(this.storePath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.chunksPath, { recursive: true, mode: 0o700 });
  }

  private load(): void {
    try {
      if (fs.existsSync(this.docsPath)) {
        const data = JSON.parse(fs.readFileSync(this.docsPath, "utf-8")) as DocumentRecord[];
        for (const doc of data) {
          this.documents.set(doc.id, doc);
        }
      }
    } catch (err: unknown) {
      console.warn(
        `[docling-rag] Failed to load ${this.docsPath}: ${err instanceof Error ? err.message : String(err)}. Starting with empty document store.`,
      );
      this.documents = new Map();
    }

    for (const docId of Array.from(this.documents.keys())) {
      try {
        const chunkFile = path.join(this.chunksPath, `${docId}.json`);
        if (fs.existsSync(chunkFile)) {
          const data = JSON.parse(fs.readFileSync(chunkFile, "utf-8")) as DocumentChunk[];
          this.chunks.set(docId, data);
        }
      } catch (err: unknown) {
        console.warn(
          `[docling-rag] Failed to load chunks for ${docId}: ${err instanceof Error ? err.message : String(err)}. Skipping.`,
        );
      }
    }
  }

  private saveDocuments(): void {
    const data = Array.from(this.documents.values());
    fs.writeFileSync(this.docsPath, JSON.stringify(data, null, 2), "utf-8");
    fs.chmodSync(this.docsPath, 0o600);
  }

  private saveChunks(documentId: string): void {
    const chunks = this.chunks.get(documentId) ?? [];
    const chunkFile = path.join(this.chunksPath, `${documentId}.json`);
    fs.writeFileSync(chunkFile, JSON.stringify(chunks, null, 2), "utf-8");
    fs.chmodSync(chunkFile, 0o600);
  }

  addDocument(
    record: Omit<DocumentRecord, "id" | "ingestedAt" | "chunks">,
    chunks: Omit<DocumentChunk, "id" | "documentId">[],
  ): DocumentRecord {
    const id = randomUUID();
    const doc: DocumentRecord = {
      ...record,
      id,
      chunks: chunks.length,
      ingestedAt: new Date().toISOString(),
    };

    const storedChunks: DocumentChunk[] = chunks.map((c) => ({
      ...c,
      id: randomUUID(),
      documentId: id,
    }));

    this.documents.set(id, doc);
    this.chunks.set(id, storedChunks);
    this.saveDocuments();
    this.saveChunks(id);
    return doc;
  }

  removeDocument(documentId: string): boolean {
    if (!this.documents.has(documentId)) {
      return false;
    }
    this.documents.delete(documentId);
    this.chunks.delete(documentId);
    this.saveDocuments();

    const chunkFile = path.join(this.chunksPath, `${documentId}.json`);
    try {
      fs.unlinkSync(chunkFile);
    } catch {
      // File may not exist
    }
    return true;
  }

  getDocument(documentId: string): DocumentRecord | undefined {
    return this.documents.get(documentId);
  }

  findDocumentByName(name: string): DocumentRecord | undefined {
    for (const doc of Array.from(this.documents.values())) {
      if (doc.name === name) {
        return doc;
      }
    }
    return undefined;
  }

  listDocuments(): DocumentRecord[] {
    return Array.from(this.documents.values());
  }

  getChunks(documentId: string): DocumentChunk[] {
    return this.chunks.get(documentId) ?? [];
  }

  getAllChunks(): DocumentChunk[] {
    const all: DocumentChunk[] = [];
    for (const chunks of Array.from(this.chunks.values())) {
      all.push(...chunks);
    }
    return all;
  }

  /**
   * Simple keyword search across all chunks.
   * Returns chunks containing the query text, ranked by occurrence count.
   */
  searchByKeyword(query: string, limit = 5): SearchResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      return [];
    }

    const results: Array<{ chunk: DocumentChunk; score: number }> = [];

    for (const chunks of Array.from(this.chunks.values())) {
      for (const chunk of chunks) {
        const text = chunk.text.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (text.includes(term)) {
            score += 1;
          }
        }
        if (score > 0) {
          results.push({ chunk, score: score / terms.length });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit).map(({ chunk, score }) => {
      const doc = this.documents.get(chunk.documentId);
      return {
        chunk,
        document: doc ?? {
          id: chunk.documentId,
          name: "unknown",
          path: "",
          format: "",
          pages: 0,
          chunks: 0,
          ingestedAt: "",
          sizeBytes: 0,
        },
        score,
      };
    });
  }

  documentCount(): number {
    return this.documents.size;
  }

  chunkCount(): number {
    let count = 0;
    for (const chunks of Array.from(this.chunks.values())) {
      count += chunks.length;
    }
    return count;
  }
}
