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

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
  });

  afterEach(() => {
    db.close();
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
