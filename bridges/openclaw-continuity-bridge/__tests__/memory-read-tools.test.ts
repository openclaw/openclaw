import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createMemoryReadToolDefinitions,
  type MemoryReadToolDefinition,
  type MemoryReadToolOptions,
} from "../memory-read-tools.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

describe("memory read tools", () => {
  let db: Database.Database;
  let tempDir: string | undefined;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
  });

  afterEach(() => {
    db.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("marks rollout denial as an error result", async () => {
    const result = await invoke(
      "memory_context",
      {},
      {
        env: {
          AIRYA_MEMORY_INTERNAL_ONLY: "1",
          AIRYA_MEMORY_INTERNAL_WORKSPACE_IDS: "99999999-9999-4999-8999-999999999999",
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: "Memory retrieval rollout restricted to internal workspaces",
      workspace_id: WORKSPACE_ID,
    });
  });

  it("marks blank search queries as an error result", async () => {
    const result = await invoke("memory_search", { query: "   " });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: "Query must contain non-whitespace characters",
      workspace_id: WORKSPACE_ID,
    });
  });

  it("marks missing memory reads as an error result", async () => {
    const result = await invoke("memory_read", {
      id: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: "Memory not found",
      id: "11111111-1111-4111-8111-111111111111",
      workspace_id: WORKSPACE_ID,
    });
  });

  it("returns a structured error when the shared retrieval module cannot be resolved", async () => {
    const definition = findTool(
      createMemoryReadToolDefinitions({
        db,
        defaultWorkspaceId: WORKSPACE_ID,
        allowTelemetryPersistence: false,
        memoryRetrievalLoader: async () => {
          throw new Error("Unable to locate shared memory retrieval module.");
        },
      }),
      "memory_read",
    );
    const schema = z.object(definition.schema);
    const parsedInput = schema.parse({
      id: "11111111-1111-4111-8111-111111111111",
    });
    const result = await definition.handler(parsedInput);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      code: "MEMORY_TOOL_EXECUTION_FAILED",
      tool: "memory_read",
      workspace_id: WORKSPACE_ID,
    });
    expect(JSON.parse(result.content[0].text).detail).toContain(
      "Unable to locate shared memory retrieval module.",
    );
  });

  it("reads from a file-backed readonly memory database", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaw-memory-db-"));
    const dbPath = join(tempDir, "airya.db");
    const fileDb = new Database(dbPath);
    createSchema(fileDb);
    fileDb
      .prepare(
        `INSERT INTO airya_memory_items (
          id, workspace_id, memory_class, memory_key, value_json, summary_text,
          confidence, priority, provenance, review_state, status,
          valid_from, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "11111111-1111-4111-8111-111111111111",
        WORKSPACE_ID,
        "decision_log",
        "decision_log/test",
        JSON.stringify({ value: "ok" }),
        "Test memory row",
        0.9,
        80,
        "human",
        "not_required",
        "active",
        "2026-03-28T00:00:00.000Z",
        "2026-03-28T00:00:00.000Z",
        "2026-03-28T00:00:00.000Z",
      );
    fileDb.close();

    const result = await invoke(
      "memory_read",
      { id: "11111111-1111-4111-8111-111111111111" },
      { db: undefined, dbPath },
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      workspace_id: WORKSPACE_ID,
      memory_key: "decision_log/test",
    });
  });

  async function invoke(
    toolName: string,
    input: Record<string, unknown>,
    overrides: Partial<MemoryReadToolOptions> = {},
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const definition = findTool(createDefinitions(overrides), toolName);
    const schema = z.object(definition.schema);
    const parsedInput = schema.parse(input);
    return definition.handler(parsedInput);
  }

  function createDefinitions(
    overrides: Partial<MemoryReadToolOptions> = {},
  ): MemoryReadToolDefinition[] {
    return createMemoryReadToolDefinitions({
      db,
      defaultWorkspaceId: WORKSPACE_ID,
      allowTelemetryPersistence: false,
      memoryRetrieval: createMemoryRetrievalStub(),
      ...overrides,
    });
  }
});

function findTool(definitions: MemoryReadToolDefinition[], name: string): MemoryReadToolDefinition {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) {
    throw new Error(`Tool not found: ${name}`);
  }
  return definition;
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE airya_memory_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      memory_class TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      confidence REAL NOT NULL,
      priority INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      review_state TEXT NOT NULL,
      status TEXT NOT NULL,
      memory_tier TEXT,
      scope_kind TEXT,
      scope_id TEXT,
      project_id TEXT,
      work_item_id TEXT,
      conversation_id TEXT,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE airya_memory_chunks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      memory_item_id TEXT NOT NULL,
      embedding_provider TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_dimension INTEGER NOT NULL,
      embedding TEXT,
      chunk_text TEXT
    );
  `);
}

function createMemoryRetrievalStub(): NonNullable<MemoryReadToolOptions["memoryRetrieval"]> {
  return {
    DEFAULT_SEARCH_LIMIT: 10,
    MAX_SEARCH_LIMIT: 100,
    DEFAULT_LIST_LIMIT: 20,
    MAX_LIST_LIMIT: 100,
    normalizeRole: (value) => (typeof value === "string" ? value : null),
    normalizeMaxAgeDays: (value) => (typeof value === "number" ? value : undefined),
    resolveMemoryRolloutState: (workspaceId, env) => ({
      internal_only: env.AIRYA_MEMORY_INTERNAL_ONLY === "1",
      workspace_allowed: (env.AIRYA_MEMORY_INTERNAL_WORKSPACE_IDS ?? "")
        .split(",")
        .includes(workspaceId),
    }),
    computeMemoryScore: () => 0,
    formatMemoryForMcp: () => ({}),
    selectRankedItemsWithinTokenBudget: () => ({
      results: [],
      selectedItems: [],
      truncated: false,
      tokensUsedEstimate: 0,
    }),
    normalizeTemporalField: () => null,
    buildActiveReadWhereClause: () => ({ clause: "1 = 1", params: [] }),
    summarizeCitationCoverage: (rows) => ({
      total: rows.length,
      required_present: rows.length,
      coverage_ratio: rows.length === 0 ? 1 : 1,
    }),
    buildRetrievalTelemetrySummary: () => ({}),
    clampInteger: (value, defaultValue, min, max) =>
      Math.min(Math.max(value ?? defaultValue, min), max),
    normalizeSearchQuery: (value) => value.trim(),
    buildMemorySearchHybridOptions: () => ({}),
    retrieveMemorySearch: () => ({
      rows: [],
      items: [],
      query: "",
      limitApplied: 10,
      searchMethod: "hybrid",
    }),
    retrieveMemoryList: () => ({ rows: [], items: [] }),
    retrieveMemoryContext: () => ({
      rows: [],
      items: [],
      tokenBudget: 4000,
      totalAvailable: 0,
      totalBeforeDedupe: 0,
    }),
  };
}
