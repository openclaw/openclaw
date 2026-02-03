/**
 * LanceDB storage layer for docs-chat RAG pipeline.
 * Stores document chunks with vector embeddings for semantic search.
 */
import * as lancedb from "@lancedb/lancedb";

const TABLE_NAME = "docs_chunks";

export interface DocsChunk {
  id: string;
  path: string;
  title: string;
  content: string;
  url: string;
  vector: number[];
}

export interface SearchResult {
  chunk: DocsChunk;
  distance: number;
  similarity: number;
}

export class DocsStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) { }

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    }
    // Table will be created when first storing chunks
  }

  /**
   * Drop existing table and create fresh with new chunks.
   * Used during index rebuild.
   */
  async replaceAll(chunks: DocsChunk[]): Promise<void> {
    if (!this.db) {
      this.db = await lancedb.connect(this.dbPath);
    }

    const tables = await this.db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      await this.db.dropTable(TABLE_NAME);
    }

    if (chunks.length === 0) {
      // Create empty table with schema
      this.table = await this.db.createTable(TABLE_NAME, [
        {
          id: "__schema__",
          path: "",
          title: "",
          content: "",
          url: "",
          vector: Array.from({ length: this.vectorDim }).fill(0),
        },
      ]);
      await this.table.delete('id = "__schema__"');
      return;
    }

    this.table = await this.db.createTable(TABLE_NAME, chunks);
  }

  /**
   * Search for similar chunks using vector similarity.
   */
  async search(vector: number[], limit: number = 8): Promise<SearchResult[]> {
    await this.ensureInitialized();

    if (!this.table) {
      return [];
    }

    const results = await this.table.vectorSearch(vector).limit(limit).toArray();

    // LanceDB uses L2 distance by default; convert to similarity score
    return results.map((row) => {
      const distance = (row._distance as number) ?? 0;
      // Inverse for 0-1 range: sim = 1 / (1 + d)
      const similarity = 1 / (1 + distance);
      return {
        chunk: {
          id: row.id as string,
          path: row.path as string,
          title: row.title as string,
          content: row.content as string,
          url: row.url as string,
          vector: row.vector as number[],
        },
        distance,
        similarity,
      };
    });
  }

  /**
   * Get count of stored chunks.
   */
  async count(): Promise<number> {
    await this.ensureInitialized();
    if (!this.table) {
      return 0;
    }
    return this.table.countRows();
  }
}
