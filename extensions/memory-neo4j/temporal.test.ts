/**
 * Tests for OP-82 bi-temporal memory features:
 * supersedeMemory, migrateTemporalFields, detectConflicts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Neo4jMemoryClient } from "./neo4j-client.js";

// ============================================================================
// Mocks
// ============================================================================

vi.mock("./llm-client.js", () => ({
  callOpenRouter: vi.fn(),
}));

import { callOpenRouter } from "./llm-client.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockSession() {
  return {
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockDriver(session: ReturnType<typeof createMockSession>) {
  return {
    session: vi.fn().mockReturnValue(session),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeClient() {
  const logger = createMockLogger();
  const session = createMockSession();
  const driver = createMockDriver(session);
  const client = new Neo4jMemoryClient("bolt://localhost:7687", "neo4j", "password", 1024, logger);
  (client as any).driver = driver;
  (client as any).indexesReady = true;
  return { client, driver, session, logger };
}

// ============================================================================
// supersedeMemory
// ============================================================================

describe("supersedeMemory", () => {
  it("sets validUntil and supersededBy on the old memory", async () => {
    const { client, session } = makeClient();

    await client.supersedeMemory("old-id", "new-id");

    expect(session.run).toHaveBeenCalledWith(
      expect.stringContaining("SET m.validUntil = $now, m.supersededBy = $newId"),
      expect.objectContaining({ oldId: "old-id", newId: "new-id" }),
    );
    expect(session.close).toHaveBeenCalled();
  });
});

// ============================================================================
// migrateTemporalFields
// ============================================================================

describe("migrateTemporalFields", () => {
  it("returns the count of updated memories", async () => {
    const { client, session } = makeClient();

    session.run.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue(5) }],
    });

    const count = await client.migrateTemporalFields();

    expect(count).toBe(5);
    expect(session.run).toHaveBeenCalledWith(expect.stringContaining("WHERE m.validFrom IS NULL"));
  });

  it("returns 0 when no memories need migration", async () => {
    const { client, session } = makeClient();

    session.run.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue(0) }],
    });

    const count = await client.migrateTemporalFields();

    expect(count).toBe(0);
  });

  it("returns 0 when result has no records", async () => {
    const { client, session } = makeClient();

    session.run.mockResolvedValueOnce({ records: [] });

    const count = await client.migrateTemporalFields();

    expect(count).toBe(0);
  });
});

// ============================================================================
// detectConflicts
// ============================================================================

describe("detectConflicts", () => {
  const enabledConfig = {
    enabled: true,
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://openrouter.ai/api/v1",
    temperature: 0,
    maxRetries: 2,
  };

  const disabledConfig = { ...enabledConfig, enabled: false };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 0 immediately when config.enabled=false", async () => {
    const { client } = makeClient();

    const result = await client.detectConflicts(
      "new-id",
      "new memory text",
      [0.1, 0.2],
      "agent-1",
      disabledConfig,
    );

    expect(result).toBe(0);
    expect(callOpenRouter).not.toHaveBeenCalled();
  });

  it("returns 0 when no candidates found", async () => {
    const { client } = makeClient();

    vi.spyOn(client, "findSimilar" as any).mockResolvedValue([]);

    const result = await client.detectConflicts(
      "new-id",
      "new memory text",
      [0.1, 0.2],
      "agent-1",
      enabledConfig,
    );

    expect(result).toBe(0);
    expect(callOpenRouter).not.toHaveBeenCalled();
  });

  it("supersedes candidate when LLM returns SUPERSEDES", async () => {
    const { client } = makeClient();

    vi.spyOn(client, "findSimilar" as any).mockResolvedValue([
      { id: "old-id", text: "old memory text", score: 0.9 },
    ]);

    (callOpenRouter as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ classification: "SUPERSEDES" }),
    );

    const supersedeSpy = vi.spyOn(client, "supersedeMemory").mockResolvedValue(undefined);

    const result = await client.detectConflicts(
      "new-id",
      "new memory text",
      [0.1, 0.2],
      "agent-1",
      enabledConfig,
    );

    expect(result).toBe(1);
    expect(supersedeSpy).toHaveBeenCalledWith("old-id", "new-id");
  });

  it("does not supersede when LLM returns COMPLEMENTS", async () => {
    const { client } = makeClient();

    vi.spyOn(client, "findSimilar" as any).mockResolvedValue([
      { id: "old-id", text: "old memory text", score: 0.9 },
    ]);

    (callOpenRouter as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ classification: "COMPLEMENTS" }),
    );

    const supersedeSpy = vi.spyOn(client, "supersedeMemory").mockResolvedValue(undefined);

    const result = await client.detectConflicts(
      "new-id",
      "new memory text",
      [0.1, 0.2],
      "agent-1",
      enabledConfig,
    );

    expect(result).toBe(0);
    expect(supersedeSpy).not.toHaveBeenCalled();
  });

  it("excludes new memory itself from candidates", async () => {
    const { client } = makeClient();

    // findSimilar returns new memory itself + one real candidate
    vi.spyOn(client, "findSimilar" as any).mockResolvedValue([
      { id: "new-id", text: "new memory text", score: 1.0 },
      { id: "other-id", text: "other memory", score: 0.85 },
    ]);

    (callOpenRouter as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ classification: "SUPERSEDES" }),
    );

    const supersedeSpy = vi.spyOn(client, "supersedeMemory").mockResolvedValue(undefined);

    await client.detectConflicts("new-id", "new memory text", [0.1, 0.2], "agent-1", enabledConfig);

    // Should only call supersedeMemory for "other-id", not "new-id"
    expect(supersedeSpy).toHaveBeenCalledWith("other-id", "new-id");
    expect(supersedeSpy).not.toHaveBeenCalledWith("new-id", expect.anything());
  });
});
