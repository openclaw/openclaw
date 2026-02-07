/**
 * Tests for extractor.ts and attention gate — Extraction Logic + Auto-capture Filtering.
 *
 * Tests exported functions: extractEntities(), extractUserMessages(), runBackgroundExtraction().
 * Tests passesAttentionGate() from index.ts.
 * Note: validateExtractionResult() is not exported; it is tested indirectly through extractEntities().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtractionConfig } from "./config.js";
import {
  extractUserMessages,
  extractAssistantMessages,
  stripAssistantWrappers,
  extractEntities,
  runBackgroundExtraction,
  rateImportance,
  resolveConflict,
} from "./extractor.js";
import { passesAttentionGate, passesAssistantAttentionGate } from "./index.js";

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

  it("should reject system infrastructure messages", () => {
    // Heartbeat prompts
    expect(
      passesAttentionGate(
        "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      ),
    ).toBe(false);

    // Pre-compaction flush
    expect(passesAttentionGate("Pre-compaction memory flush. Store durable memories now.")).toBe(
      false,
    );

    // System cron/exec messages
    expect(
      passesAttentionGate(
        "System: [2026-02-06 10:25:00 UTC] Reminder: Check if wa-group-monitor updated",
      ),
    ).toBe(false);

    // Cron job wrappers
    expect(
      passesAttentionGate(
        "[cron:720b01aa-03d1-4888-a2d4-0f0a9e0d7b6c Memory Sleep Cycle] Run the sleep cycle",
      ),
    ).toBe(false);

    // Gateway restart payloads
    expect(passesAttentionGate('GatewayRestart:\n{ "kind": "restart", "status": "ok" }')).toBe(
      false,
    );

    // Background task completion
    expect(
      passesAttentionGate(
        "[Sat 2026-02-07 01:02 GMT+8] A background task just completed successfully.",
      ),
    ).toBe(false);
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

  it("should strip Telegram channel metadata and extract raw user text", () => {
    const messages = [
      {
        role: "user",
        content:
          "[Telegram Tarun (@ts1974_001) id:878224171 +1m 2026-02-06 23:18 GMT+8] I restarted the gateway but it still shows UTC time\n[message_id: 6363]",
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["I restarted the gateway but it still shows UTC time"]);
  });

  it("should strip Telegram wrapper and filter if remaining text is too short", () => {
    const messages = [
      {
        role: "user",
        content:
          "[Telegram Tarun (@ts1974_001) id:878224171 +1m 2026-02-06 13:32 UTC] Hi\n[message_id: 6302]",
      },
    ];
    const result = extractUserMessages(messages);
    // "Hi" is < 10 chars after stripping — should be filtered out
    expect(result).toEqual([]);
  });

  it("should strip media attachment preamble and keep user text", () => {
    const messages = [
      {
        role: "user",
        content:
          "[media attached: /path/to/file.jpg (image/jpeg) | /path/to/file.jpg]\nTo send an image back, prefer the message tool.\n[Telegram Tarun (@ts1974_001) id:878224171 +5m 2026-02-06 14:01 UTC] My claim for the business expense\n[message_id: 6334]",
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["My claim for the business expense"]);
  });

  it("should strip System exec output prefixes", () => {
    const messages = [
      {
        role: "user",
        content:
          "System: [2026-01-31 05:44:57 UTC] Exec completed (gentle-s, code 0)\n\n[Telegram User id:123 +1m 2026-01-31 05:46 UTC] I want 4k imax copy of Interstellar\n[message_id: 2098]",
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["I want 4k imax copy of Interstellar"]);
  });

  it("should strip <file> attachment blocks and keep surrounding user text", () => {
    const messages = [
      {
        role: "user",
        content:
          'Can you summarize this? <file name="doc.pdf" mime="application/pdf">Long PDF content here that would normally be very large</file>',
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["Can you summarize this?"]);
  });

  it("should filter out messages that are only a <file> block", () => {
    const messages = [
      {
        role: "user",
        content: '<file name="image.png" mime="image/png">base64data</file>',
      },
    ];
    const result = extractUserMessages(messages);
    // After stripping, nothing remains (< 10 chars)
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

// ============================================================================
// Auto-recall filtering logic (Feature 1 + Feature 2)
//
// These test the filtering patterns used in index.ts auto-recall hook:
//   - Feature 1: results.filter(r => r.score >= minScore)
//   - Feature 2: results.filter(r => !coreIds.has(r.id))
// ============================================================================

describe("auto-recall score filtering", () => {
  type FakeResult = { id: string; score: number; category: string; text: string };

  function makeResult(id: string, score: number): FakeResult {
    return { id, score, category: "fact", text: `Memory ${id}` };
  }

  it("should filter out results below the min score threshold", () => {
    const results = [makeResult("a", 0.1), makeResult("b", 0.25), makeResult("c", 0.5)];
    const minScore = 0.25;
    const filtered = results.filter((r) => r.score >= minScore);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("should keep all results when min score is 0", () => {
    const results = [makeResult("a", 0.01), makeResult("b", 0.5)];
    const filtered = results.filter((r) => r.score >= 0);
    expect(filtered).toHaveLength(2);
  });

  it("should filter all results when min score is 1 and no perfect scores", () => {
    const results = [makeResult("a", 0.99), makeResult("b", 0.5)];
    const filtered = results.filter((r) => r.score >= 1);
    expect(filtered).toHaveLength(0);
  });

  it("should keep results exactly at the threshold", () => {
    const results = [makeResult("a", 0.25)];
    const filtered = results.filter((r) => r.score >= 0.25);
    expect(filtered).toHaveLength(1);
  });
});

describe("auto-recall core memory deduplication", () => {
  type FakeResult = { id: string; score: number; category: string; text: string };

  function makeResult(id: string, score: number): FakeResult {
    return { id, score, category: "core", text: `Core memory ${id}` };
  }

  it("should filter out results whose IDs are in the core memory set", () => {
    const results = [
      makeResult("core-1", 0.8),
      makeResult("regular-1", 0.7),
      makeResult("core-2", 0.6),
    ];
    const coreIds = new Set(["core-1", "core-2"]);
    const filtered = results.filter((r) => !coreIds.has(r.id));
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("regular-1");
  });

  it("should keep all results when core set is empty", () => {
    const results = [makeResult("a", 0.8), makeResult("b", 0.7)];
    const coreIds = new Set<string>();
    const filtered = results.filter((r) => !coreIds.has(r.id));
    expect(filtered).toHaveLength(2);
  });

  it("should keep all results when core set is undefined", () => {
    const results = [makeResult("a", 0.8), makeResult("b", 0.7)];
    const coreIds: Set<string> | undefined = undefined;
    const filtered = coreIds ? results.filter((r) => !coreIds.has(r.id)) : results;
    expect(filtered).toHaveLength(2);
  });

  it("should remove all results when all are in core set", () => {
    const results = [makeResult("core-1", 0.8), makeResult("core-2", 0.7)];
    const coreIds = new Set(["core-1", "core-2"]);
    const filtered = results.filter((r) => !coreIds.has(r.id));
    expect(filtered).toHaveLength(0);
  });

  it("should work correctly when both score and core dedup filters are applied", () => {
    const results = [
      makeResult("core-1", 0.8), // core memory — should be deduped
      makeResult("regular-1", 0.1), // low score — should be filtered by score
      makeResult("regular-2", 0.5), // good score, not core — should survive
    ];
    const minScore = 0.25;
    const coreIds = new Set(["core-1"]);

    let filtered = results.filter((r) => r.score >= minScore);
    filtered = filtered.filter((r) => !coreIds.has(r.id));

    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("regular-2");
  });
});

// ============================================================================
// stripAssistantWrappers()
// ============================================================================

describe("stripAssistantWrappers", () => {
  it("should strip <tool_use> blocks", () => {
    const text = "Here is my analysis. <tool_use>some tool call</tool_use> And more text.";
    expect(stripAssistantWrappers(text)).toBe("Here is my analysis. And more text.");
  });

  it("should strip <tool_result> blocks", () => {
    const text = "<tool_result>result data</tool_result> The result shows X.";
    expect(stripAssistantWrappers(text)).toBe("The result shows X.");
  });

  it("should strip <function_call> blocks", () => {
    const text = "Let me check. <function_call>fn()</function_call> Done.";
    expect(stripAssistantWrappers(text)).toBe("Let me check. Done.");
  });

  it("should strip <thinking> blocks", () => {
    const text = "<thinking>Let me think about this deeply...</thinking> The answer is 42.";
    expect(stripAssistantWrappers(text)).toBe("The answer is 42.");
  });

  it("should strip <antThinking> blocks", () => {
    const text = "<antThinking>internal reasoning</antThinking> Here is the response.";
    expect(stripAssistantWrappers(text)).toBe("Here is the response.");
  });

  it("should strip <code_output> blocks", () => {
    const text = "Running the script: <code_output>stdout output</code_output> It succeeded.";
    expect(stripAssistantWrappers(text)).toBe("Running the script: It succeeded.");
  });

  it("should strip multiple wrapper types at once", () => {
    const text =
      "<thinking>hmm</thinking> I found that <tool_result>data</tool_result> the answer is clear.";
    expect(stripAssistantWrappers(text)).toBe("I found that the answer is clear.");
  });

  it("should return empty string when only wrappers exist", () => {
    const text = "<thinking>just thinking</thinking>";
    expect(stripAssistantWrappers(text)).toBe("");
  });

  it("should pass through text with no wrappers", () => {
    const text = "This is a normal assistant response with useful information.";
    expect(stripAssistantWrappers(text)).toBe(text);
  });
});

// ============================================================================
// extractAssistantMessages()
// ============================================================================

describe("extractAssistantMessages", () => {
  it("should extract string content from assistant messages", () => {
    const messages = [
      { role: "assistant", content: "I recommend using TypeScript for this project" },
      { role: "assistant", content: "The database migration completed successfully" },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toEqual([
      "I recommend using TypeScript for this project",
      "The database migration completed successfully",
    ]);
  });

  it("should filter out user messages", () => {
    const messages = [
      { role: "user", content: "This is a user message that should be skipped" },
      { role: "assistant", content: "This is an assistant message that should be kept" },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toEqual(["This is an assistant message that should be kept"]);
  });

  it("should extract text from content block arrays", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here is a content block response from assistant" },
          { type: "tool_use", id: "123" },
          { type: "text", text: "Another text block in the response" },
        ],
      },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toEqual([
      "Here is a content block response from assistant",
      "Another text block in the response",
    ]);
  });

  it("should strip thinking tags from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content:
          "<thinking>Let me think about this...</thinking> The best approach is to use a factory pattern for this use case.",
      },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toEqual(["The best approach is to use a factory pattern for this use case."]);
  });

  it("should filter out messages shorter than 10 chars after stripping", () => {
    const messages = [
      { role: "assistant", content: "<thinking>long thinking block</thinking> OK" },
      { role: "assistant", content: "Short" },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toEqual([]);
  });

  it("should handle null and non-object messages gracefully", () => {
    const messages = [
      null,
      undefined,
      42,
      { role: "assistant", content: "Valid assistant message with enough length" },
    ];
    const result = extractAssistantMessages(messages as unknown[]);
    expect(result).toEqual(["Valid assistant message with enough length"]);
  });

  it("should return empty array for empty input", () => {
    expect(extractAssistantMessages([])).toEqual([]);
  });
});

// ============================================================================
// passesAssistantAttentionGate()
// ============================================================================

describe("passesAssistantAttentionGate", () => {
  it("should reject short messages below min chars", () => {
    expect(passesAssistantAttentionGate("Hi there")).toBe(false);
  });

  it("should reject messages with fewer than 10 words", () => {
    // 9 words — just under the threshold
    expect(passesAssistantAttentionGate("I think we should use this approach here.")).toBe(false);
  });

  it("should accept messages with 10+ words and substantive content", () => {
    expect(
      passesAssistantAttentionGate(
        "Based on my analysis, the best approach would be to refactor the database layer to use connection pooling for better performance.",
      ),
    ).toBe(true);
  });

  it("should reject messages exceeding 1000 chars", () => {
    const longMsg = "word ".repeat(250); // ~1250 chars
    expect(passesAssistantAttentionGate(longMsg)).toBe(false);
  });

  it("should reject messages that are mostly code blocks", () => {
    const msg =
      "Here is the fix:\n```typescript\nconst x = 1;\nconst y = 2;\nconst z = x + y;\nconsole.log(z);\nfunction foo() { return bar; }\nclass Baz extends Qux {}\n```";
    expect(passesAssistantAttentionGate(msg)).toBe(false);
  });

  it("should accept messages with some code but mostly text", () => {
    const msg =
      "I recommend refactoring the authentication module to use JWT tokens instead of session-based auth. The key change would be in the middleware where we validate tokens. Here is a small example: ```const token = jwt.sign(payload, secret);``` This approach is more scalable.";
    expect(passesAssistantAttentionGate(msg)).toBe(true);
  });

  it("should reject messages containing tool_result tags", () => {
    const msg =
      "The <tool_result>some output from executing a tool that returned data</tool_result> result shows that the system is working correctly and we should continue.";
    expect(passesAssistantAttentionGate(msg)).toBe(false);
  });

  it("should reject messages containing tool_use tags", () => {
    const msg =
      "Let me check <tool_use>running some tool call right now</tool_use> and now we can see the output of the analysis clearly.";
    expect(passesAssistantAttentionGate(msg)).toBe(false);
  });

  it("should reject messages with injected memory context", () => {
    expect(
      passesAssistantAttentionGate(
        "<relevant-memories>some context here for the agent</relevant-memories> and here is a longer response with more than ten words to pass the word check.",
      ),
    ).toBe(false);
  });

  it("should reject noise patterns", () => {
    expect(passesAssistantAttentionGate("ok")).toBe(false);
    expect(passesAssistantAttentionGate("sounds good")).toBe(false);
  });
});

// ============================================================================
// rateImportance()
// ============================================================================

describe("rateImportance", () => {
  const originalFetch = globalThis.fetch;

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

  it("should return 0.5 when extraction is disabled", async () => {
    const result = await rateImportance("some text", disabledConfig);
    expect(result).toBe(0.5);
  });

  it("should return mapped score on happy path", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { content: JSON.stringify({ score: 8, reason: "important decision" }) } },
          ],
        }),
    });

    const result = await rateImportance("I decided to switch to Neo4j", enabledConfig);
    expect(result).toBe(0.8);
  });

  it("should clamp score to 1-10 range", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { content: JSON.stringify({ score: 15, reason: "very important" }) } },
          ],
        }),
    });

    const result = await rateImportance("test", enabledConfig);
    expect(result).toBe(1.0); // 15 clamped to 10, mapped to 1.0
  });

  it("should clamp low scores", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ score: 0, reason: "trivial" }) } }],
        }),
    });

    const result = await rateImportance("test", enabledConfig);
    expect(result).toBe(0.1); // 0 clamped to 1, mapped to 0.1
  });

  it("should return 0.5 on fetch timeout", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException("signal timed out", "TimeoutError"));

    const result = await rateImportance("test", enabledConfig);
    expect(result).toBe(0.5);
  });

  it("should return 0.5 on invalid JSON response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "not valid json" } }],
        }),
    });

    const result = await rateImportance("test", enabledConfig);
    expect(result).toBe(0.5);
  });

  it("should return 0.5 when API returns error status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await rateImportance("test", enabledConfig);
    expect(result).toBe(0.5);
  });

  it("should return 0.5 when response has no content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: null } }],
        }),
    });

    const result = await rateImportance("test", enabledConfig);
    expect(result).toBe(0.5);
  });

  it("should return 0.5 when score is not a number", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { content: JSON.stringify({ score: "high", reason: "important" }) } },
          ],
        }),
    });

    const result = await rateImportance("test", enabledConfig);
    expect(result).toBe(0.5);
  });
});

// ============================================================================
// resolveConflict()
// ============================================================================

describe("resolveConflict", () => {
  const originalFetch = globalThis.fetch;

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

  it("should return 'skip' when config is disabled", async () => {
    const result = await resolveConflict("mem A", "mem B", disabledConfig);
    expect(result).toBe("skip");
  });

  it("should return 'a' when LLM says keep a", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ keep: "a", reason: "more recent" }) } }],
        }),
    });

    const result = await resolveConflict(
      "user prefers dark mode",
      "user prefers light mode",
      enabledConfig,
    );
    expect(result).toBe("a");
  });

  it("should return 'b' when LLM says keep b", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { content: JSON.stringify({ keep: "b", reason: "more specific" }) } },
          ],
        }),
    });

    const result = await resolveConflict("old preference", "new preference", enabledConfig);
    expect(result).toBe("b");
  });

  it("should return 'both' when LLM says keep both", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { content: JSON.stringify({ keep: "both", reason: "no conflict" }) } },
          ],
        }),
    });

    const result = await resolveConflict("likes coffee", "works at Acme", enabledConfig);
    expect(result).toBe("both");
  });

  it("should return 'skip' on fetch timeout", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException("signal timed out", "TimeoutError"));

    const result = await resolveConflict("mem A", "mem B", enabledConfig);
    expect(result).toBe("skip");
  });

  it("should return 'skip' on invalid JSON response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "not valid json" } }],
        }),
    });

    const result = await resolveConflict("mem A", "mem B", enabledConfig);
    expect(result).toBe("skip");
  });

  it("should return 'skip' when API returns error status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const result = await resolveConflict("mem A", "mem B", enabledConfig);
    expect(result).toBe("skip");
  });

  it("should return 'skip' when response has no content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: null } }],
        }),
    });

    const result = await resolveConflict("mem A", "mem B", enabledConfig);
    expect(result).toBe("skip");
  });

  it("should return 'skip' when LLM returns unrecognized keep value", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { content: JSON.stringify({ keep: "neither", reason: "confusing" }) } },
          ],
        }),
    });

    const result = await resolveConflict("mem A", "mem B", enabledConfig);
    expect(result).toBe("skip");
  });
});
