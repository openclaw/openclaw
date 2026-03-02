/**
 * Vector store for tool execution results.
 *
 * Uses LanceDB for vector storage and retrieval.
 */

import { randomUUID } from "node:crypto";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import type { EmbeddingProvider } from "../../../memory/embeddings.js";
import { truncateContent } from "./tools.js";
import type { ToolResultEntry, ToolResultSearchResult, StorageConfig } from "./types.js";

/**
 * LanceDB types (loaded dynamically).
 */
type LanceDBConnection = Awaited<ReturnType<typeof import("@lancedb/lancedb").connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection["openTable"]>>;

const TABLE_NAME = "tool_results";

/**
 * Vector store for tool result summaries.
 */
export class ToolResultSummaryStore {
  private db: LanceDBConnection | null = null;
  private table: LanceDBTable | null = null;
  private initPromise: Promise<void> | null = null;
  private entryCount: number = 0;

  constructor(
    private config: StorageConfig,
    private embeddings: EmbeddingProvider,
    private resolvedDbPath: string,
  ) {}

  /**
   * Ensure the store is initialized.
   */
  async ensureInitialized(): Promise<void> {
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
    const lancedb = await this.loadLanceDB();
    this.db = await lancedb.connect(this.resolvedDbPath);

    const tables = await this.db.tableNames();
    // Default dimensions for common embedding models
    const dimensions = 1536; // OpenAI text-embedding-3-small

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      // Create table with schema
      const schemaEntry = this.createSchemaEntry(dimensions);
      this.table = await this.db.createTable(TABLE_NAME, [schemaEntry]);
      await this.table.delete("id = '__schema__'");
    }

    // Count existing entries
    this.entryCount = await this.table.countRows();
  }

  private async loadLanceDB(): Promise<typeof import("@lancedb/lancedb")> {
    try {
      return await import("@lancedb/lancedb");
    } catch (err) {
      throw new Error(
        `Failed to load LanceDB. Ensure @lancedb/lancedb is installed. Error: ${String(err)}`,
        { cause: err },
      );
    }
  }

  private createSchemaEntry(dimensions: number): Record<string, unknown> {
    return {
      id: "__schema__",
      sessionId: "",
      toolCallId: "",
      toolName: "",
      inputJson: "",
      summary: "",
      originalContentJson: "",
      isError: false,
      detailsJson: "",
      vector: Array.from({ length: dimensions }).fill(0),
      createdAt: 0,
      accessCount: 0,
      lastAccessAt: 0,
    };
  }

  /**
   * Store a tool result entry.
   */
  async store(params: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    summary: string;
    originalContent: (TextContent | ImageContent)[];
    isError: boolean;
    details: unknown;
  }): Promise<ToolResultEntry> {
    await this.ensureInitialized();

    // Generate embedding for the summary
    const vector = await this.embeddings.embedQuery(params.summary);

    // Truncate content if needed
    const truncatedContent = truncateContent(
      params.originalContent as Array<{ type: string; text?: string }>,
      this.config.maxContentChars,
    );

    const entry: ToolResultEntry = {
      id: randomUUID(),
      sessionId: params.sessionId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      input: params.input,
      summary: params.summary,
      originalContent: truncatedContent as (TextContent | ImageContent)[],
      isError: params.isError,
      details: params.details,
      vector,
      createdAt: Date.now(),
      accessCount: 0,
      lastAccessAt: Date.now(),
    };

    // Convert to LanceDB row format
    const row = this.entryToRow(entry);
    await this.table!.add([row]);

    this.entryCount++;
    return entry;
  }

  /**
   * Search for relevant tool results.
   */
  async search(
    query: string,
    options: {
      limit: number;
      minScore: number;
      sessionId?: string;
      crossSession?: boolean;
    },
  ): Promise<ToolResultSearchResult[]> {
    await this.ensureInitialized();

    // Generate embedding for query
    const queryVector = await this.embeddings.embedQuery(query);

    // Perform vector search
    const results = await this.table!.vectorSearch(queryVector)
      .limit(options.limit * 2)
      .toArray();

    // Map results and filter
    const mapped: ToolResultSearchResult[] = [];
    for (const row of results) {
      const entry = this.rowToEntry(row as Record<string, unknown>);

      // Apply session filter
      if (!options.crossSession && options.sessionId && entry.sessionId !== options.sessionId) {
        continue;
      }

      // Calculate similarity score from L2 distance
      const distance = (row as { _distance?: number })._distance ?? 0;
      const score = 1 / (1 + distance);

      if (score >= options.minScore) {
        mapped.push({ entry, score });
      }
    }

    return mapped.slice(0, options.limit);
  }

  /**
   * Get a specific entry by ID.
   */
  async get(id: string): Promise<ToolResultEntry | null> {
    await this.ensureInitialized();

    try {
      // Validate UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(id)) {
        return null;
      }

      const results = await this.table!.query().where(`id = '${id}'`).toArray();
      if (results.length === 0) {
        return null;
      }

      return this.rowToEntry(results[0] as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  /**
   * Get a tool result entry by tool call ID.
   * Returns the most recent entry for the given toolCallId.
   */
  async getByToolCallId(toolCallId: string): Promise<ToolResultEntry | null> {
    await this.ensureInitialized();

    try {
      const results = await this.table!.query().where(`toolCallId = '${toolCallId}'`).toArray();

      if (results.length === 0) {
        return null;
      }

      // Sort by createdAt descending and get the most recent
      const sorted = results.toSorted(
        (a: unknown, b: unknown) =>
          ((b as Record<string, unknown>).createdAt as number) -
          ((a as Record<string, unknown>).createdAt as number),
      );

      return this.rowToEntry(sorted[0] as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  /**
   * Update access count for an entry.
   */
  async touch(id: string): Promise<void> {
    await this.ensureInitialized();

    try {
      const entry = await this.get(id);
      if (entry) {
        // In LanceDB, we need to delete and re-add to update
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(id)) {
          await this.table!.delete(`id = '${id}'`);
          entry.accessCount++;
          entry.lastAccessAt = Date.now();
          await this.table!.add([this.entryToRow(entry)]);
        }
      }
    } catch {
      // Ignore errors on touch
    }
  }

  /**
   * Delete old entries based on TTL.
   */
  async cleanup(ttlDays: number): Promise<number> {
    await this.ensureInitialized();

    if (ttlDays <= 0) {
      return 0;
    }

    const cutoffTime = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    const before = this.entryCount;

    try {
      await this.table!.delete(`createdAt < ${cutoffTime}`);
      this.entryCount = await this.table!.countRows();
    } catch {
      // Ignore cleanup errors
    }

    return before - this.entryCount;
  }

  /**
   * Get count of stored entries.
   */
  getCount(): number {
    return this.entryCount;
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    // LanceDB doesn't have explicit close, just drop references
    this.table = null;
    this.db = null;
    this.initPromise = null;
  }

  private entryToRow(entry: ToolResultEntry): Record<string, unknown> {
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      inputJson: JSON.stringify(entry.input),
      summary: entry.summary,
      originalContentJson: JSON.stringify(entry.originalContent),
      isError: entry.isError,
      detailsJson: JSON.stringify(entry.details),
      vector: entry.vector ?? [],
      createdAt: entry.createdAt,
      accessCount: entry.accessCount,
      lastAccessAt: entry.lastAccessAt,
    };
  }

  private rowToEntry(row: Record<string, unknown>): ToolResultEntry {
    return {
      id: row.id as string,
      sessionId: row.sessionId as string,
      toolCallId: row.toolCallId as string,
      toolName: row.toolName as string,
      input: JSON.parse((row.inputJson as string) || "{}"),
      summary: row.summary as string,
      originalContent: JSON.parse((row.originalContentJson as string) || "[]"),
      isError: row.isError as boolean,
      details: JSON.parse((row.detailsJson as string) || "null"),
      vector: row.vector as number[],
      createdAt: row.createdAt as number,
      accessCount: row.accessCount as number,
      lastAccessAt: row.lastAccessAt as number,
    };
  }
}
