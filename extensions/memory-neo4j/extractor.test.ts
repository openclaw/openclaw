/**
 * Tests for extractor.ts and attention gate — Extraction Logic + Auto-capture Filtering.
 *
 * Tests exported functions: extractEntities(), extractUserMessages(), runBackgroundExtraction().
 * Tests passesAttentionGate() from index.ts.
 * Note: validateExtractionResult() is not exported; it is tested indirectly through extractEntities().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtractionConfig } from "./config.js";
import { extractUserMessages, extractEntities, runBackgroundExtraction } from "./extractor.js";
import { passesAttentionGate } from "./index.js";

// ============================================================================
// passesAttentionGate()
// ============================================================================

describe("passesAttentionGate", () => {
  // --- Should REJECT ---

  it("should reject short messages below MIN_CAPTURE_CHARS", () => {
    expect(passesAttentionGate("Hi")).toBe(false);
    expect(passesAttentionGate("Yup")).toBe(false);
    expect(passesAttentionGate("yes")).toBe(false);
    expect(passesAttentionGate("ok")).toBe(false);
    expect(passesAttentionGate("")).toBe(false);
  });

  it("should reject noise greetings/acknowledgments", () => {
    expect(passesAttentionGate("sounds good")).toBe(false);
    expect(passesAttentionGate("Got it")).toBe(false);
    expect(passesAttentionGate("thanks!")).toBe(false);
    expect(passesAttentionGate("thank you!")).toBe(false);
    expect(passesAttentionGate("perfect.")).toBe(false);
  });

  it("should reject messages with fewer than MIN_WORD_COUNT words", () => {
    expect(passesAttentionGate("I need those")).toBe(false); // 3 words
    expect(passesAttentionGate("yes please do")).toBe(false); // 3 words
    expect(passesAttentionGate("that works fine")).toBe(false); // 3 words
  });

  it("should reject short contextual/deictic phrases", () => {
    expect(passesAttentionGate("Ok, let me test it out")).toBe(false);
    expect(passesAttentionGate("ok great")).toBe(false);
    expect(passesAttentionGate("yes please")).toBe(false);
    expect(passesAttentionGate("ok sure thanks")).toBe(false);
  });

  it("should reject two-word affirmations", () => {
    expect(passesAttentionGate("ok great")).toBe(false);
    expect(passesAttentionGate("yes please")).toBe(false);
    expect(passesAttentionGate("sure thanks")).toBe(false);
    expect(passesAttentionGate("cool noted")).toBe(false);
    expect(passesAttentionGate("alright fine")).toBe(false);
  });

  it("should reject pure emoji messages", () => {
    expect(passesAttentionGate("🎉🎉🎉🎉🎉")).toBe(false);
  });

  it("should reject messages exceeding MAX_CAPTURE_CHARS", () => {
    expect(passesAttentionGate("a ".repeat(1500))).toBe(false);
  });

  it("should reject messages with injected memory context tags", () => {
    expect(
      passesAttentionGate(
        "<relevant-memories>some context here for the agent</relevant-memories> and more text after that",
      ),
    ).toBe(false);
    expect(
      passesAttentionGate(
        "<core-memory-refresh>refreshed data here for the agent</core-memory-refresh> and more text",
      ),
    ).toBe(false);
  });

  it("should reject XML/system markup", () => {
    expect(passesAttentionGate("<system>You are a helpful assistant with context</system>")).toBe(
      false,
    );
  });

  // --- Should ACCEPT ---

  it("should accept substantive messages with enough words", () => {
    expect(passesAttentionGate("I noticed the LinkedIn posts are not auto-liking")).toBe(true);
    expect(passesAttentionGate("Please update the deployment script for the new server")).toBe(
      true,
    );
    expect(passesAttentionGate("The database migration failed on the staging environment")).toBe(
      true,
    );
  });

  it("should accept messages with specific information/preferences", () => {
    expect(passesAttentionGate("I prefer using TypeScript over JavaScript")).toBe(true);
    expect(passesAttentionGate("My meeting with John is on Thursday")).toBe(true);
    expect(passesAttentionGate("The project deadline was moved to March")).toBe(true);
  });

  it("should accept actionable requests with context", () => {
    expect(passesAttentionGate("Let's limit the wa-group-monitoring to business hours")).toBe(true);
    expect(passesAttentionGate("Can you check the error logs on the production server")).toBe(true);
  });
});

// ============================================================================
// extractUserMessages()
// ============================================================================

describe("extractUserMessages", () => {
  it("should extract string content from user messages", () => {
    const messages = [
      { role: "user", content: "I prefer TypeScript over JavaScript" },
      { role: "user", content: "My favorite color is blue" },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["I prefer TypeScript over JavaScript", "My favorite color is blue"]);
  });

  it("should extract text from content block arrays", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello, this is a content block message" },
          { type: "image", url: "http://example.com/img.png" },
          { type: "text", text: "Another text block in same message" },
        ],
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual([
      "Hello, this is a content block message",
      "Another text block in same message",
    ]);
  });

  it("should filter out assistant messages", () => {
    const messages = [
      { role: "user", content: "This is a user message that is long enough" },
      { role: "assistant", content: "This is an assistant message" },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["This is a user message that is long enough"]);
  });

  it("should filter out system messages", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant with context" },
      { role: "user", content: "This is a user message that is long enough" },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["This is a user message that is long enough"]);
  });

  it("should filter out messages shorter than 10 characters", () => {
    const messages = [
      { role: "user", content: "short" }, // 5 chars
      { role: "user", content: "1234567890" }, // exactly 10 chars
      { role: "user", content: "This is longer than ten characters" },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["1234567890", "This is longer than ten characters"]);
  });

  it("should strip <relevant-memories> blocks and keep user content", () => {
    const messages = [
      { role: "user", content: "Normal user message that is long enough here" },
      {
        role: "user",
        content:
          "<relevant-memories>Some injected context</relevant-memories>\n\nWhat does Tarun prefer for meetings?",
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual([
      "Normal user message that is long enough here",
      "What does Tarun prefer for meetings?",
    ]);
  });

  it("should drop message if only injected context remains after stripping", () => {
    const messages = [
      {
        role: "user",
        content:
          "<relevant-memories>Some injected context that should be ignored</relevant-memories>",
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual([]);
  });

  it("should strip <system> blocks and keep user content", () => {
    const messages = [
      {
        role: "user",
        content: "<system>System markup</system>\n\nNormal user message that is long enough here",
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["Normal user message that is long enough here"]);
  });

  it("should strip <core-memory-refresh> blocks and keep user content", () => {
    const messages = [
      {
        role: "user",
        content:
          "<core-memory-refresh>refreshed memories</core-memory-refresh>\n\nTell me about the project status",
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["Tell me about the project status"]);
  });

  it("should handle null and non-object messages gracefully", () => {
    const messages = [
      null,
      undefined,
      "not an object",
      42,
      { role: "user", content: "Valid message with enough length" },
    ];
    const result = extractUserMessages(messages as unknown[]);
    expect(result).toEqual(["Valid message with enough length"]);
  });

  it("should return empty array when no user messages exist", () => {
    const messages = [{ role: "assistant", content: "Only assistant messages" }];
    const result = extractUserMessages(messages);
    expect(result).toEqual([]);
  });

  it("should return empty array for empty input", () => {
    expect(extractUserMessages([])).toEqual([]);
  });

  it("should handle messages where content is neither string nor array", () => {
    const messages = [
      { role: "user", content: 42 },
      { role: "user", content: null },
      { role: "user", content: { nested: true } },
    ];
    const result = extractUserMessages(messages as unknown[]);
    expect(result).toEqual([]);
  });
});

// ============================================================================
// extractEntities() — tests validateExtractionResult() indirectly
// ============================================================================

describe("extractEntities", () => {
  // We need to mock `fetch` since callOpenRouter uses global fetch
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const enabledConfig: ExtractionConfig = {
    enabled: true,
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://test.ai/api/v1",
    temperature: 0.0,
    maxRetries: 0, // No retries in tests
  };

  const disabledConfig: ExtractionConfig = {
    ...enabledConfig,
    enabled: false,
  };

  function mockFetchResponse(content: string, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(content),
      json: () =>
        Promise.resolve({
          choices: [{ message: { content } }],
        }),
    });
  }

  it("should return null result when extraction is disabled", async () => {
    const { result, transientFailure } = await extractEntities("test text", disabledConfig);
    expect(result).toBeNull();
    expect(transientFailure).toBe(false);
  });

  it("should extract valid entities from LLM response", async () => {
    mockFetchResponse(
      JSON.stringify({
        category: "fact",
        entities: [
          { name: "Tarun", type: "person", aliases: ["boss"], description: "The CEO" },
          { name: "Abundent", type: "organization" },
        ],
        relationships: [
          { source: "Tarun", target: "Abundent", type: "WORKS_AT", confidence: 0.95 },
        ],
        tags: [{ name: "Leadership", category: "business" }],
      }),
    );

    const { result } = await extractEntities("Tarun works at Abundent", enabledConfig);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("fact");

    // Entities should be normalized to lowercase
    expect(result!.entities).toHaveLength(2);
    expect(result!.entities[0].name).toBe("tarun");
    expect(result!.entities[0].type).toBe("person");
    expect(result!.entities[0].aliases).toEqual(["boss"]);
    expect(result!.entities[0].description).toBe("The CEO");
    expect(result!.entities[1].name).toBe("abundent");
    expect(result!.entities[1].type).toBe("organization");

    // Relationships should be normalized to lowercase source/target
    expect(result!.relationships).toHaveLength(1);
    expect(result!.relationships[0].source).toBe("tarun");
    expect(result!.relationships[0].target).toBe("abundent");
    expect(result!.relationships[0].type).toBe("WORKS_AT");
    expect(result!.relationships[0].confidence).toBe(0.95);

    // Tags should be normalized to lowercase
    expect(result!.tags).toHaveLength(1);
    expect(result!.tags[0].name).toBe("leadership");
    expect(result!.tags[0].category).toBe("business");
  });

  it("should handle empty extraction result", async () => {
    mockFetchResponse(
      JSON.stringify({
        category: "other",
        entities: [],
        relationships: [],
        tags: [],
      }),
    );

    const { result } = await extractEntities("just a greeting", enabledConfig);
    expect(result).not.toBeNull();
    expect(result!.entities).toEqual([]);
    expect(result!.relationships).toEqual([]);
    expect(result!.tags).toEqual([]);
  });

  it("should handle missing fields in LLM response", async () => {
    mockFetchResponse(
      JSON.stringify({
        // No category, entities, relationships, or tags
      }),
    );

    const { result } = await extractEntities("some text", enabledConfig);
    expect(result).not.toBeNull();
    expect(result!.category).toBeUndefined();
    expect(result!.entities).toEqual([]);
    expect(result!.relationships).toEqual([]);
    expect(result!.tags).toEqual([]);
  });

  it("should filter out invalid entity types (fallback to concept)", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [
          { name: "Widget", type: "gadget" }, // invalid type -> concept
          { name: "Paris", type: "location" }, // valid type
        ],
        relationships: [],
        tags: [],
      }),
    );

    const { result } = await extractEntities("test", enabledConfig);
    expect(result!.entities).toHaveLength(2);
    expect(result!.entities[0].type).toBe("concept"); // invalid type falls back to concept
    expect(result!.entities[1].type).toBe("location");
  });

  it("should filter out invalid relationship types", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [],
        relationships: [
          { source: "a", target: "b", type: "WORKS_AT", confidence: 0.9 }, // valid
          { source: "a", target: "b", type: "HATES", confidence: 0.9 }, // invalid type
        ],
        tags: [],
      }),
    );

    const { result } = await extractEntities("test", enabledConfig);
    expect(result!.relationships).toHaveLength(1);
    expect(result!.relationships[0].type).toBe("WORKS_AT");
  });

  it("should clamp confidence to 0-1 range", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [],
        relationships: [
          { source: "a", target: "b", type: "KNOWS", confidence: 1.5 }, // over 1
          { source: "c", target: "d", type: "KNOWS", confidence: -0.5 }, // under 0
        ],
        tags: [],
      }),
    );

    const { result } = await extractEntities("test", enabledConfig);
    expect(result!.relationships[0].confidence).toBe(1);
    expect(result!.relationships[1].confidence).toBe(0);
  });

  it("should default confidence to 0.7 when not a number", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [],
        relationships: [{ source: "a", target: "b", type: "KNOWS", confidence: "high" }],
        tags: [],
      }),
    );

    const { result } = await extractEntities("test", enabledConfig);
    expect(result!.relationships[0].confidence).toBe(0.7);
  });

  it("should filter out entities without name", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [
          { name: "", type: "person" }, // empty name -> filtered
          { name: "   ", type: "person" }, // whitespace-only name -> filtered (after trim)
          { name: "valid", type: "person" }, // valid
        ],
        relationships: [],
        tags: [],
      }),
    );

    const { result } = await extractEntities("test", enabledConfig);
    expect(result!.entities).toHaveLength(1);
    expect(result!.entities[0].name).toBe("valid");
  });

  it("should filter out entities with non-object shape", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [null, "not an entity", 42, { name: "valid", type: "person" }],
        relationships: [],
        tags: [],
      }),
    );

    const { result } = await extractEntities("test", enabledConfig);
    expect(result!.entities).toHaveLength(1);
  });

  it("should filter out entities missing required fields", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [
          { type: "person" }, // missing name
          { name: "test" }, // missing type
          { name: "valid", type: "person" }, // has both
        ],
        relationships: [],
        tags: [],
      }),
    );

    const { result } = await extractEntities("test", enabledConfig);
    expect(result!.entities).toHaveLength(1);
    expect(result!.entities[0].name).toBe("valid");
  });

  it("should default tag category to 'topic' when missing", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [],
        relationships: [],
        tags: [{ name: "neo4j" }], // no category
      }),
    );

    const { result } = await extractEntities("test", enabledConfig);
    expect(result!.tags[0].category).toBe("topic");
  });

  it("should filter out tags with empty names", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [],
        relationships: [],
        tags: [
          { name: "", category: "tech" }, // empty -> filtered
          { name: "   ", category: "tech" }, // whitespace-only -> filtered
          { name: "valid", category: "tech" },
        ],
      }),
    );

    const { result } = await extractEntities("test", enabledConfig);
    expect(result!.tags).toHaveLength(1);
    expect(result!.tags[0].name).toBe("valid");
  });

  it("should reject invalid category values", async () => {
    mockFetchResponse(
      JSON.stringify({
        category: "invalid-category",
        entities: [],
        relationships: [],
        tags: [],
      }),
    );

    const { result } = await extractEntities("test", enabledConfig);
    expect(result!.category).toBeUndefined();
  });

  it("should accept valid category values", async () => {
    for (const category of ["preference", "fact", "decision", "entity", "other"]) {
      mockFetchResponse(
        JSON.stringify({
          category,
          entities: [],
          relationships: [],
          tags: [],
        }),
      );
      const { result } = await extractEntities(`test ${category}`, enabledConfig);
      expect(result!.category).toBe(category);
    }
  });

  it("should return null result for malformed JSON response (permanent failure)", async () => {
    mockFetchResponse("not valid json at all");

    const { result, transientFailure } = await extractEntities("test", enabledConfig);
    // callOpenRouter returns the raw string, JSON.parse fails, catch returns null
    expect(result).toBeNull();
    expect(transientFailure).toBe(false);
  });

  it("should return null result when API returns error status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const { result } = await extractEntities("test", enabledConfig);
    // API error 500 is not in the transient list (only 429, 502, 503, 504)
    expect(result).toBeNull();
  });

  it("should return null result when API returns no content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content: null } }] }),
    });

    const { result, transientFailure } = await extractEntities("test", enabledConfig);
    expect(result).toBeNull();
    expect(transientFailure).toBe(false);
  });

  it("should normalize alias strings to lowercase", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [{ name: "John", type: "person", aliases: ["Johnny", "JOHN", "j.doe"] }],
        relationships: [],
        tags: [],
      }),
    );

    const { result } = await extractEntities("test", enabledConfig);
    expect(result!.entities[0].aliases).toEqual(["johnny", "john", "j.doe"]);
  });

  it("should filter out non-string aliases", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [{ name: "John", type: "person", aliases: ["valid", 42, null, "also-valid"] }],
        relationships: [],
        tags: [],
      }),
    );

    const { result } = await extractEntities("test", enabledConfig);
    expect(result!.entities[0].aliases).toEqual(["valid", "also-valid"]);
  });
});

// ============================================================================
// runBackgroundExtraction()
// ============================================================================

describe("runBackgroundExtraction", () => {
  const originalFetch = globalThis.fetch;

  let mockLogger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  let mockDb: {
    updateExtractionStatus: ReturnType<typeof vi.fn>;
    mergeEntity: ReturnType<typeof vi.fn>;
    createMentions: ReturnType<typeof vi.fn>;
    createEntityRelationship: ReturnType<typeof vi.fn>;
    tagMemory: ReturnType<typeof vi.fn>;
    updateMemoryCategory: ReturnType<typeof vi.fn>;
  };

  let mockEmbeddings: {
    embed: ReturnType<typeof vi.fn>;
    embedBatch: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mockDb = {
      updateExtractionStatus: vi.fn().mockResolvedValue(undefined),
      mergeEntity: vi.fn().mockResolvedValue(undefined),
      createMentions: vi.fn().mockResolvedValue(undefined),
      createEntityRelationship: vi.fn().mockResolvedValue(undefined),
      tagMemory: vi.fn().mockResolvedValue(undefined),
      updateMemoryCategory: vi.fn().mockResolvedValue(undefined),
    };
    mockEmbeddings = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const enabledConfig: ExtractionConfig = {
    enabled: true,
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://test.ai/api/v1",
    temperature: 0.0,
    maxRetries: 0,
  };

  const disabledConfig: ExtractionConfig = {
    ...enabledConfig,
    enabled: false,
  };

  function mockFetchResponse(content: string) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content } }],
        }),
    });
  }

  it("should skip extraction and mark as 'skipped' when disabled", async () => {
    await runBackgroundExtraction(
      "mem-1",
      "test text",
      mockDb as never,
      mockEmbeddings as never,
      disabledConfig,
      mockLogger,
    );
    expect(mockDb.updateExtractionStatus).toHaveBeenCalledWith("mem-1", "skipped");
  });

  it("should mark as 'failed' when extraction returns null", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("error"),
    });

    await runBackgroundExtraction(
      "mem-1",
      "test text",
      mockDb as never,
      mockEmbeddings as never,
      enabledConfig,
      mockLogger,
    );
    expect(mockDb.updateExtractionStatus).toHaveBeenCalledWith("mem-1", "failed");
  });

  it("should mark as 'complete' when extraction result is empty", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [],
        relationships: [],
        tags: [],
      }),
    );

    await runBackgroundExtraction(
      "mem-1",
      "test text",
      mockDb as never,
      mockEmbeddings as never,
      enabledConfig,
      mockLogger,
    );
    expect(mockDb.updateExtractionStatus).toHaveBeenCalledWith("mem-1", "complete");
  });

  it("should merge entities, create mentions, and mark complete", async () => {
    mockFetchResponse(
      JSON.stringify({
        category: "fact",
        entities: [{ name: "Alice", type: "person" }],
        relationships: [],
        tags: [],
      }),
    );

    await runBackgroundExtraction(
      "mem-1",
      "Alice is a developer",
      mockDb as never,
      mockEmbeddings as never,
      enabledConfig,
      mockLogger,
    );

    expect(mockDb.mergeEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "alice",
        type: "person",
      }),
    );
    expect(mockDb.createMentions).toHaveBeenCalledWith("mem-1", "alice", "context", 1.0);
    expect(mockDb.updateMemoryCategory).toHaveBeenCalledWith("mem-1", "fact");
    expect(mockDb.updateExtractionStatus).toHaveBeenCalledWith("mem-1", "complete");
  });

  it("should create entity relationships", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [
          { name: "Alice", type: "person" },
          { name: "Acme", type: "organization" },
        ],
        relationships: [{ source: "Alice", target: "Acme", type: "WORKS_AT", confidence: 0.9 }],
        tags: [],
      }),
    );

    await runBackgroundExtraction(
      "mem-1",
      "Alice works at Acme",
      mockDb as never,
      mockEmbeddings as never,
      enabledConfig,
      mockLogger,
    );

    expect(mockDb.createEntityRelationship).toHaveBeenCalledWith("alice", "acme", "WORKS_AT", 0.9);
  });

  it("should tag memories", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [],
        relationships: [],
        tags: [{ name: "Programming", category: "tech" }],
      }),
    );

    await runBackgroundExtraction(
      "mem-1",
      "test text",
      mockDb as never,
      mockEmbeddings as never,
      enabledConfig,
      mockLogger,
    );

    expect(mockDb.tagMemory).toHaveBeenCalledWith("mem-1", "programming", "tech");
  });

  it("should not update category when result has no category", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [{ name: "Test", type: "concept" }],
        relationships: [],
        tags: [],
      }),
    );

    await runBackgroundExtraction(
      "mem-1",
      "test",
      mockDb as never,
      mockEmbeddings as never,
      enabledConfig,
      mockLogger,
    );

    expect(mockDb.updateMemoryCategory).not.toHaveBeenCalled();
  });

  it("should handle entity merge failure gracefully", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [
          { name: "Alice", type: "person" },
          { name: "Bob", type: "person" },
        ],
        relationships: [],
        tags: [],
      }),
    );

    // First entity merge fails, second succeeds
    mockDb.mergeEntity.mockRejectedValueOnce(new Error("merge failed"));
    mockDb.mergeEntity.mockResolvedValueOnce(undefined);

    await runBackgroundExtraction(
      "mem-1",
      "Alice and Bob",
      mockDb as never,
      mockEmbeddings as never,
      enabledConfig,
      mockLogger,
    );

    // Should still continue and complete
    expect(mockDb.mergeEntity).toHaveBeenCalledTimes(2);
    expect(mockDb.updateExtractionStatus).toHaveBeenCalledWith("mem-1", "complete");
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("should log extraction results", async () => {
    mockFetchResponse(
      JSON.stringify({
        category: "fact",
        entities: [{ name: "Test", type: "concept" }],
        relationships: [{ source: "a", target: "b", type: "RELATED_TO", confidence: 0.8 }],
        tags: [{ name: "tech" }],
      }),
    );

    await runBackgroundExtraction(
      "mem-12345678-abcd",
      "test",
      mockDb as never,
      mockEmbeddings as never,
      enabledConfig,
      mockLogger,
    );

    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("extraction complete"));
  });
});
