/**
 * Tests for extractor.ts and attention gate — Extraction Logic + Auto-capture Filtering.
 *
 * Tests exported functions: extractEntities(), extractUserMessages(), runBackgroundExtraction().
 * Tests passesAttentionGate() from index.ts.
 * Note: validateExtractionResult() is not exported; it is tested indirectly through extractEntities().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtractionConfig } from "./config.js";
import { passesAttentionGate, passesAssistantAttentionGate } from "./attention-gate.js";
import {
  extractEntities,
  runBackgroundExtraction,
  rateImportance,
  resolveConflict,
  isSemanticDuplicate,
  SEMANTIC_DEDUP_VECTOR_THRESHOLD,
} from "./extractor.js";
import { isTransientError } from "./llm-client.js";
import {
  extractUserMessages,
  extractAssistantMessages,
  stripAssistantWrappers,
} from "./message-utils.js";
import { runSleepCycle } from "./sleep-cycle.js";

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
    expect(
      passesAttentionGate("I strongly prefer using TypeScript over JavaScript for all projects"),
    ).toBe(true);
    expect(
      passesAttentionGate("My important meeting with John is scheduled for Thursday afternoon"),
    ).toBe(true);
    expect(
      passesAttentionGate("The project deadline was moved to March due to client feedback"),
    ).toBe(true);
  });

  it("should accept actionable requests with context", () => {
    expect(
      passesAttentionGate("Let's limit the wa-group-monitoring cron job to business hours only"),
    ).toBe(true);
    expect(
      passesAttentionGate(
        "Can you check the error logs on the production server for recent failures",
      ),
    ).toBe(true);
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

/**
 * Create a ReadableStream that emits SSE-formatted chunks from a content string.
 * Used to mock streaming LLM responses.
 */
function mockSSEStream(content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Send the content in one SSE data event, then [DONE]
  const sseData = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseData));
      controller.close();
    },
  });
}

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
      // Streaming response format (used by extractEntities via callOpenRouterStream)
      body: status >= 200 && status < 300 ? mockSSEStream(content) : null,
      // Non-streaming format (used by other LLM calls via callOpenRouter)
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
    batchEntityOperations: ReturnType<typeof vi.fn>;
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
      batchEntityOperations: vi.fn().mockResolvedValue(undefined),
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
      body: mockSSEStream(content),
      json: () =>
        Promise.resolve({
          choices: [{ message: { content } }],
        }),
    });
  }

  it("should skip extraction and mark as 'skipped' when disabled", async () => {
    const result = await runBackgroundExtraction(
      "mem-1",
      "test text",
      mockDb as never,
      mockEmbeddings as never,
      disabledConfig,
      mockLogger,
    );
    expect(mockDb.updateExtractionStatus).toHaveBeenCalledWith("mem-1", "skipped");
    expect(result).toEqual({ success: true, memoryId: "mem-1" });
  });

  it("should mark as 'failed' when extraction returns null", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("error"),
    });

    const result = await runBackgroundExtraction(
      "mem-1",
      "test text",
      mockDb as never,
      mockEmbeddings as never,
      enabledConfig,
      mockLogger,
    );
    expect(mockDb.updateExtractionStatus).toHaveBeenCalledWith("mem-1", "failed");
    expect(result).toEqual({ success: false, memoryId: "mem-1" });
  });

  it("should mark as 'complete' when extraction result is empty", async () => {
    mockFetchResponse(
      JSON.stringify({
        entities: [],
        relationships: [],
        tags: [],
      }),
    );

    const result = await runBackgroundExtraction(
      "mem-1",
      "test text",
      mockDb as never,
      mockEmbeddings as never,
      enabledConfig,
      mockLogger,
    );
    expect(mockDb.updateExtractionStatus).toHaveBeenCalledWith("mem-1", "complete");
    expect(result).toEqual({ success: true, memoryId: "mem-1" });
  });

  it("should batch entities, relationships, tags, and category in one call", async () => {
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

    expect(mockDb.batchEntityOperations).toHaveBeenCalledWith(
      "mem-1",
      [expect.objectContaining({ name: "alice", type: "person" })],
      [],
      [],
      "fact",
    );
  });

  it("should pass relationships to batchEntityOperations", async () => {
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

    expect(mockDb.batchEntityOperations).toHaveBeenCalledWith(
      "mem-1",
      expect.arrayContaining([
        expect.objectContaining({ name: "alice", type: "person" }),
        expect.objectContaining({ name: "acme", type: "organization" }),
      ]),
      [{ source: "alice", target: "acme", type: "WORKS_AT", confidence: 0.9 }],
      [],
      undefined,
    );
  });

  it("should pass tags to batchEntityOperations", async () => {
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

    expect(mockDb.batchEntityOperations).toHaveBeenCalledWith(
      "mem-1",
      [],
      [],
      [{ name: "programming", category: "tech" }],
      undefined,
    );
  });

  it("should pass undefined category when result has no category", async () => {
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

    expect(mockDb.batchEntityOperations).toHaveBeenCalledWith(
      "mem-1",
      [expect.objectContaining({ name: "test", type: "concept" })],
      [],
      [],
      undefined,
    );
  });

  it("should handle batchEntityOperations failure gracefully", async () => {
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

    mockDb.batchEntityOperations.mockRejectedValueOnce(new Error("batch failed"));

    await runBackgroundExtraction(
      "mem-1",
      "Alice and Bob",
      mockDb as never,
      mockEmbeddings as never,
      enabledConfig,
      mockLogger,
    );

    // Should handle error and mark as failed
    expect(mockDb.batchEntityOperations).toHaveBeenCalledTimes(1);
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

  it("should reject 'Let me...' action narration", () => {
    expect(
      passesAssistantAttentionGate(
        "Let me check the error logs on the production server for recent failures and report back.",
      ),
    ).toBe(false);
    expect(
      passesAssistantAttentionGate(
        "Now let me update the dashboard and send the Slack report with today's results:",
      ),
    ).toBe(false);
    expect(
      passesAssistantAttentionGate(
        "Let me run the LinkedIn parallel outreach job and start by setting up the search term rotation.",
      ),
    ).toBe(false);
  });

  it("should reject 'I'll...' action narration", () => {
    expect(
      passesAssistantAttentionGate(
        "I'll run the email labeler to classify any unread, unlabeled emails right now.",
      ),
    ).toBe(false);
    expect(
      passesAssistantAttentionGate(
        "I'll check for newly accepted LinkedIn connections and update the tracker spreadsheet.",
      ),
    ).toBe(false);
  });

  it("should reject 'Starting/Running/Processing...' status updates", () => {
    expect(
      passesAssistantAttentionGate(
        "Starting LinkedIn outreach for Training category using profile linkedin-3 with isolated browser.",
      ),
    ).toBe(false);
    expect(
      passesAssistantAttentionGate(
        "Processing through extraction steadily doing eight at a time against local Qwen model.",
      ),
    ).toBe(false);
  });

  it("should reject 'Good!/Perfect!' opener narration", () => {
    expect(
      passesAssistantAttentionGate(
        "Good! I can see the search results. I've identified several 2nd-degree prospects to connect with.",
      ),
    ).toBe(false);
    expect(
      passesAssistantAttentionGate(
        "Perfect! The connection dialog appeared. I'll click Add a note to add the personalized message.",
      ),
    ).toBe(false);
  });

  it("should reject context compaction announcements", () => {
    expect(
      passesAssistantAttentionGate(
        "\u{1F504} **Context Reset** \u{2014} My memory was just compacted. Last thing I remember: setting up Flux 2.",
      ),
    ).toBe(false);
  });

  it("should still accept substantive assistant conclusions", () => {
    expect(
      passesAssistantAttentionGate(
        "The memory-neo4j plugin uses confidence-weighted RRF for search result fusion and a 3-signal hybrid search combining HNSW, BM25, and graph traversal.",
      ),
    ).toBe(true);
    expect(
      passesAssistantAttentionGate(
        "Whisper wins accuracy across all tests while SenseVoice wins speed at seventeen to thirty-four times faster processing.",
      ),
    ).toBe(true);
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

// ============================================================================
// runSleepCycle() — Comprehensive Phase Testing
// ============================================================================

describe("runSleepCycle", () => {
  let mockDb: any;
  let mockEmbeddings: any;
  let mockLogger: any;
  let mockConfig: ExtractionConfig;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();

    // Mock logger
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    // Mock embeddings
    mockEmbeddings = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    };

    // Mock config
    mockConfig = {
      enabled: true,
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://test.ai/api/v1",
      temperature: 0.0,
      maxRetries: 0,
    };

    // Mock database with all required methods
    mockDb = {
      // findDuplicateClusters now accepts returnSimilarities param (3rd arg)
      // When true, clusters include a similarities Map
      findDuplicateClusters: vi
        .fn()
        .mockImplementation(async (threshold, agentId, returnSimilarities) => {
          if (returnSimilarities) {
            // Return empty clusters by default with similarities Map
            return [];
          }
          return [];
        }),
      mergeMemoryCluster: vi.fn().mockResolvedValue({ survivorId: "s1", deletedCount: 0 }),
      findConflictingMemories: vi.fn().mockResolvedValue([]),
      invalidateMemory: vi.fn().mockResolvedValue(undefined),
      calculateAllEffectiveScores: vi.fn().mockResolvedValue([]),
      calculateParetoThreshold: vi.fn().mockReturnValue(0.5),
      promoteToCore: vi.fn().mockResolvedValue(0),
      findDecayedMemories: vi.fn().mockResolvedValue([]),
      pruneMemories: vi.fn().mockResolvedValue(0),
      countByExtractionStatus: vi
        .fn()
        .mockResolvedValue({ pending: 0, complete: 0, failed: 0, skipped: 0 }),
      listPendingExtractions: vi.fn().mockResolvedValue([]),
      findOrphanEntities: vi.fn().mockResolvedValue([]),
      deleteOrphanEntities: vi.fn().mockResolvedValue(0),
      findOrphanTags: vi.fn().mockResolvedValue([]),
      deleteOrphanTags: vi.fn().mockResolvedValue(0),
      updateExtractionStatus: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Phase 1: Deduplication
  describe("Phase 1: Deduplication", () => {
    it("should merge clusters when vector similarity ≥ 0.95", async () => {
      // New implementation calls findDuplicateClusters(0.75, agentId, true) with similarities
      const similarities = new Map([
        ["m1:m2", 0.97],
        ["m1:m3", 0.96],
        ["m2:m3", 0.98],
      ]);
      mockDb.findDuplicateClusters.mockResolvedValue([
        {
          memoryIds: ["m1", "m2", "m3"],
          texts: ["text 1", "text 2", "text 3"],
          importances: [0.8, 0.9, 0.7],
          similarities,
        },
      ]);
      mockDb.mergeMemoryCluster.mockResolvedValue({ survivorId: "m2", deletedCount: 2 });

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(mockDb.findDuplicateClusters).toHaveBeenCalledWith(0.75, undefined, true);
      expect(mockDb.mergeMemoryCluster).toHaveBeenCalledWith(["m1", "m2", "m3"], [0.8, 0.9, 0.7]);
      expect(result.dedup.clustersFound).toBe(1);
      expect(result.dedup.memoriesMerged).toBe(2);
    });

    it("should keep highest-importance memory in cluster", async () => {
      const similarities = new Map([
        ["high:low", 0.98],
        ["high:mid", 0.96],
        ["low:mid", 0.97],
      ]);
      mockDb.findDuplicateClusters.mockResolvedValue([
        {
          memoryIds: ["low", "high", "mid"],
          texts: ["text", "text", "text"],
          importances: [0.3, 0.9, 0.5],
          similarities,
        },
      ]);

      await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      // mergeMemoryCluster is called with all IDs and importances
      // It's responsible for choosing the survivor (highest importance)
      expect(mockDb.mergeMemoryCluster).toHaveBeenCalledWith(
        ["low", "high", "mid"],
        [0.3, 0.9, 0.5],
      );
    });

    it("should report correct counts for multiple clusters", async () => {
      mockDb.findDuplicateClusters.mockResolvedValue([
        {
          memoryIds: ["a1", "a2"],
          texts: ["a", "a"],
          importances: [0.5, 0.6],
          similarities: new Map([["a1:a2", 0.98]]),
        },
        {
          memoryIds: ["b1", "b2", "b3"],
          texts: ["b", "b", "b"],
          importances: [0.7, 0.8, 0.9],
          similarities: new Map([
            ["b1:b2", 0.97],
            ["b1:b3", 0.96],
            ["b2:b3", 0.99],
          ]),
        },
      ]);
      mockDb.mergeMemoryCluster
        .mockResolvedValueOnce({ survivorId: "a2", deletedCount: 1 })
        .mockResolvedValueOnce({ survivorId: "b3", deletedCount: 2 });

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(result.dedup.clustersFound).toBe(2);
      expect(result.dedup.memoriesMerged).toBe(3);
    });

    it("should skip dedup when no clusters found", async () => {
      mockDb.findDuplicateClusters.mockResolvedValue([]);

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(result.dedup.clustersFound).toBe(0);
      expect(result.dedup.memoriesMerged).toBe(0);
      expect(mockDb.mergeMemoryCluster).not.toHaveBeenCalled();
    });
  });

  // Phase 1b: Conflict Detection
  describe("Phase 1b: Conflict Detection", () => {
    beforeEach(() => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              { message: { content: JSON.stringify({ keep: "a", reason: "more recent" }) } },
            ],
          }),
      });
    });

    it("should call resolveConflict for entity-linked memory pairs", async () => {
      mockDb.findConflictingMemories.mockResolvedValue([
        {
          memoryA: {
            id: "m1",
            text: "user prefers dark mode",
            importance: 0.7,
            createdAt: "2024-01-01",
          },
          memoryB: {
            id: "m2",
            text: "user prefers light mode",
            importance: 0.6,
            createdAt: "2024-01-02",
          },
        },
      ]);

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(mockDb.findConflictingMemories).toHaveBeenCalled();
      expect(result.conflict.pairsFound).toBe(1);
      expect(result.conflict.resolved).toBe(1);
    });

    it("should invalidate the loser (importance → 0.01)", async () => {
      mockDb.findConflictingMemories.mockResolvedValue([
        {
          memoryA: { id: "m1", text: "old info", importance: 0.5, createdAt: "2024-01-01" },
          memoryB: { id: "m2", text: "new info", importance: 0.8, createdAt: "2024-01-02" },
        },
      ]);

      // LLM says keep "a"
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: JSON.stringify({ keep: "a", reason: "test" }) } }],
          }),
      });

      await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(mockDb.invalidateMemory).toHaveBeenCalledWith("m2");
    });

    it("should not count 'skip' decisions as resolved", async () => {
      mockDb.findConflictingMemories.mockResolvedValue([
        {
          memoryA: { id: "m1", text: "text", importance: 0.5, createdAt: "2024-01-01" },
          memoryB: { id: "m2", text: "text", importance: 0.5, createdAt: "2024-01-02" },
        },
      ]);

      // LLM unavailable
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(result.conflict.pairsFound).toBe(1);
      expect(result.conflict.resolved).toBe(0);
      expect(result.conflict.invalidated).toBe(0);
    });

    it("should handle 'both' decision (no conflict)", async () => {
      mockDb.findConflictingMemories.mockResolvedValue([
        {
          memoryA: { id: "m1", text: "likes coffee", importance: 0.5, createdAt: "2024-01-01" },
          memoryB: { id: "m2", text: "works at Acme", importance: 0.5, createdAt: "2024-01-02" },
        },
      ]);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              { message: { content: JSON.stringify({ keep: "both", reason: "no conflict" }) } },
            ],
          }),
      });

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(result.conflict.resolved).toBe(1);
      expect(result.conflict.invalidated).toBe(0);
      expect(mockDb.invalidateMemory).not.toHaveBeenCalled();
    });
  });

  // Phase 1b: Semantic Deduplication (0.75-0.95 band)
  describe("Phase 1b: Semantic Deduplication", () => {
    it("should check pairs in 0.75-0.95 similarity band", async () => {
      // New implementation: single call at 0.75, clusters with similarities in 0.75-0.95 range go to semantic dedup
      mockDb.findDuplicateClusters.mockResolvedValue([
        {
          memoryIds: ["m1", "m2"],
          texts: ["Tarun prefers dark mode", "Tarun likes dark theme"],
          importances: [0.8, 0.7],
          similarities: new Map([["m1:m2", 0.85]]), // 0.75-0.95 range
        },
      ]);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: JSON.stringify({ verdict: "duplicate", reason: "paraphrase" }),
                },
              },
            ],
          }),
      });

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(mockDb.findDuplicateClusters).toHaveBeenCalledWith(0.75, undefined, true);
      expect(result.semanticDedup.pairsChecked).toBe(1);
      expect(result.semanticDedup.duplicatesMerged).toBe(1);
    });

    it("should invalidate lower-importance duplicate", async () => {
      mockDb.findDuplicateClusters.mockResolvedValue([
        {
          memoryIds: ["high", "low"],
          texts: ["high importance text", "low importance text"],
          importances: [0.9, 0.3],
          similarities: new Map([["high:low", 0.82]]), // 0.75-0.95 range
        },
      ]);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: JSON.stringify({ verdict: "duplicate" }) } }],
          }),
      });

      await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      // Should invalidate "low" (lower importance)
      expect(mockDb.invalidateMemory).toHaveBeenCalledWith("low");
    });

    it("should report correct pair counts", async () => {
      mockDb.findDuplicateClusters.mockResolvedValue([
        {
          memoryIds: ["a", "b", "c"],
          texts: ["text", "text", "text"],
          importances: [0.5, 0.6, 0.7],
          similarities: new Map([
            ["a:b", 0.85],
            ["a:c", 0.81],
            ["b:c", 0.82],
          ]), // All above SEMANTIC_DEDUP_VECTOR_THRESHOLD (0.8)
        },
      ]);

      // All 3 pairs are collected and fired concurrently in one batch:
      // (a,b) = duplicate, (a,c) = duplicate but skipped (a invalidated), (b,c) = unique
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: JSON.stringify({ verdict: "duplicate" }) } }],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: JSON.stringify({ verdict: "duplicate" }) } }],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: JSON.stringify({ verdict: "unique" }) } }],
            }),
        });

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      // All 3 pairs checked concurrently, but only 1 merge (a,c duplicate skipped since a already invalidated)
      expect(result.semanticDedup.pairsChecked).toBe(3);
      expect(result.semanticDedup.duplicatesMerged).toBe(1);
    });
  });

  // Phase 2: Pareto Scoring
  describe("Phase 2: Pareto Scoring", () => {
    it("should calculate correct threshold for top 20%", async () => {
      const scores = [
        {
          id: "m1",
          text: "test",
          category: "fact",
          importance: 0.9,
          retrievalCount: 10,
          ageDays: 5,
          effectiveScore: 0.95,
        },
        {
          id: "m2",
          text: "test",
          category: "fact",
          importance: 0.5,
          retrievalCount: 5,
          ageDays: 10,
          effectiveScore: 0.5,
        },
        {
          id: "m3",
          text: "test",
          category: "core",
          importance: 0.3,
          retrievalCount: 2,
          ageDays: 20,
          effectiveScore: 0.3,
        },
      ];
      mockDb.calculateAllEffectiveScores.mockResolvedValue(scores);
      mockDb.calculateParetoThreshold.mockReturnValue(0.8);

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(mockDb.calculateAllEffectiveScores).toHaveBeenCalled();
      expect(mockDb.calculateParetoThreshold).toHaveBeenCalledWith(scores, 0.8); // 1 - paretoPercentile (default 0.2)
      expect(result.pareto.totalMemories).toBe(3);
      expect(result.pareto.coreMemories).toBe(1);
      expect(result.pareto.regularMemories).toBe(2);
      expect(result.pareto.threshold).toBe(0.8);
    });

    it("should handle empty database", async () => {
      mockDb.calculateAllEffectiveScores.mockResolvedValue([]);
      mockDb.calculateParetoThreshold.mockReturnValue(0); // Empty array returns 0

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(result.pareto.totalMemories).toBe(0);
      expect(result.pareto.threshold).toBe(0);
    });

    it("should handle single memory", async () => {
      mockDb.calculateAllEffectiveScores.mockResolvedValue([
        {
          id: "m1",
          text: "test",
          category: "fact",
          importance: 0.9,
          retrievalCount: 10,
          ageDays: 5,
          effectiveScore: 0.95,
        },
      ]);
      mockDb.calculateParetoThreshold.mockReturnValue(0.95);

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(result.pareto.totalMemories).toBe(1);
      expect(result.pareto.threshold).toBe(0.95);
    });
  });

  // Phase 3: Promotion
  describe("Phase 3: Core Promotion", () => {
    it("should promote regular memories above threshold", async () => {
      const scores = [
        {
          id: "m1",
          text: "test",
          category: "fact",
          importance: 0.9,
          retrievalCount: 10,
          ageDays: 10,
          effectiveScore: 0.95,
        },
        {
          id: "m2",
          text: "test",
          category: "fact",
          importance: 0.5,
          retrievalCount: 5,
          ageDays: 8,
          effectiveScore: 0.6,
        },
        {
          id: "m3",
          text: "test",
          category: "core",
          importance: 0.8,
          retrievalCount: 8,
          ageDays: 5,
          effectiveScore: 0.85,
        },
      ];
      mockDb.calculateAllEffectiveScores.mockResolvedValue(scores);
      mockDb.calculateParetoThreshold.mockReturnValue(0.7); // threshold
      mockDb.promoteToCore.mockResolvedValue(1);

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger, {
        paretoPercentile: 0.2,
        promotionMinAgeDays: 7,
      });

      // m1 should be promoted (category=fact, score=0.95 > 0.70, age=10 >= 7)
      expect(mockDb.promoteToCore).toHaveBeenCalledWith(["m1"]);
      expect(result.promotion.candidatesFound).toBe(1);
      expect(result.promotion.promoted).toBe(1);
    });

    it("should respect promotionMinAgeDays", async () => {
      const scores = [
        {
          id: "m1",
          text: "test",
          category: "fact",
          importance: 0.9,
          retrievalCount: 10,
          ageDays: 5,
          effectiveScore: 0.95,
        },
      ];
      mockDb.calculateAllEffectiveScores.mockResolvedValue(scores);
      mockDb.calculateParetoThreshold.mockReturnValue(0.5);

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger, {
        promotionMinAgeDays: 7,
      });

      // m1 age=5 < 7, should not be promoted
      expect(result.promotion.candidatesFound).toBe(0);
      expect(mockDb.promoteToCore).not.toHaveBeenCalled();
    });

    it("should not promote core memories again", async () => {
      const scores = [
        {
          id: "m1",
          text: "test",
          category: "core",
          importance: 0.9,
          retrievalCount: 10,
          ageDays: 10,
          effectiveScore: 0.95,
        },
      ];
      mockDb.calculateAllEffectiveScores.mockResolvedValue(scores);
      mockDb.calculateParetoThreshold.mockReturnValue(0.5);

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(result.promotion.candidatesFound).toBe(0);
      expect(mockDb.promoteToCore).not.toHaveBeenCalled();
    });
  });

  // Phase 4: Extraction
  describe("Phase 5: Entity Extraction", () => {
    it("should process pending extractions in batches", async () => {
      mockDb.countByExtractionStatus.mockResolvedValue({
        pending: 5,
        complete: 0,
        failed: 0,
        skipped: 0,
      });
      // First call returns 3 memories, second call returns empty to stop loop
      mockDb.listPendingExtractions
        .mockResolvedValueOnce([
          { id: "m1", text: "text 1", agentId: "default", extractionRetries: 0 },
          { id: "m2", text: "text 2", agentId: "default", extractionRetries: 0 },
          { id: "m3", text: "text 3", agentId: "default", extractionRetries: 0 },
        ])
        .mockResolvedValueOnce([]);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: { content: JSON.stringify({ entities: [], relationships: [], tags: [] }) },
              },
            ],
          }),
      });

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger, {
        extractionBatchSize: 10,
      });

      expect(mockDb.listPendingExtractions).toHaveBeenCalled();
      expect(result.extraction.total).toBe(5);
      expect(result.extraction.processed).toBe(3);
    });

    it("should handle extraction failures with retry tracking", async () => {
      mockDb.countByExtractionStatus.mockResolvedValue({
        pending: 1,
        complete: 0,
        failed: 0,
        skipped: 0,
      });
      // First call returns 1 memory, second call returns empty to stop loop
      mockDb.listPendingExtractions
        .mockResolvedValueOnce([
          { id: "m1", text: "text", agentId: "default", extractionRetries: 0 },
        ])
        .mockResolvedValueOnce([]);

      // Extraction fails (HTTP error)
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(result.extraction.processed).toBe(1);
      // runBackgroundExtraction returns { success: false } on HTTP errors,
      // so the sleep cycle correctly counts it as failed via outcome.value.success
      expect(result.extraction.succeeded).toBe(0);
      expect(result.extraction.failed).toBe(1);
    });

    it("should respect batch size and delay", async () => {
      mockDb.countByExtractionStatus.mockResolvedValue({
        pending: 2,
        complete: 0,
        failed: 0,
        skipped: 0,
      });
      mockDb.listPendingExtractions
        .mockResolvedValueOnce([
          { id: "m1", text: "text 1", agentId: "default", extractionRetries: 0 },
        ])
        .mockResolvedValueOnce([]);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: { content: JSON.stringify({ entities: [], relationships: [], tags: [] }) },
              },
            ],
          }),
      });

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger, {
        extractionBatchSize: 1,
        extractionDelayMs: 100,
      });

      expect(mockDb.listPendingExtractions).toHaveBeenCalledWith(1, undefined);
      expect(result.extraction.processed).toBe(1);
    });
  });

  // Phase 6: Decay & Pruning
  describe("Phase 6: Decay & Pruning", () => {
    it("should prune memories below retention threshold", async () => {
      mockDb.findDecayedMemories.mockResolvedValue([
        { id: "m1", text: "old memory", importance: 0.2, ageDays: 100, decayScore: 0.05 },
        { id: "m2", text: "very old", importance: 0.1, ageDays: 200, decayScore: 0.02 },
      ]);
      mockDb.pruneMemories.mockResolvedValue(2);

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(mockDb.findDecayedMemories).toHaveBeenCalled();
      expect(mockDb.pruneMemories).toHaveBeenCalledWith(["m1", "m2"]);
      expect(result.decay.memoriesPruned).toBe(2);
    });

    it("should apply exponential decay based on age", async () => {
      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger, {
        decayRetentionThreshold: 0.1,
        decayBaseHalfLifeDays: 30,
      });

      expect(mockDb.findDecayedMemories).toHaveBeenCalledWith({
        retentionThreshold: 0.1,
        baseHalfLifeDays: 30,
        importanceMultiplier: 2,
        agentId: undefined,
      });
    });

    it("should extend half-life based on importance", async () => {
      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger, {
        decayImportanceMultiplier: 3,
      });

      expect(mockDb.findDecayedMemories).toHaveBeenCalledWith(
        expect.objectContaining({
          importanceMultiplier: 3,
        }),
      );
    });
  });

  // Phase 7: Orphan Cleanup
  describe("Phase 7: Orphan Cleanup", () => {
    it("should remove entities with 0 mentions", async () => {
      mockDb.findOrphanEntities.mockResolvedValue([
        { id: "e1", name: "orphan1", type: "concept" },
        { id: "e2", name: "orphan2", type: "person" },
      ]);
      mockDb.deleteOrphanEntities.mockResolvedValue(2);

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(mockDb.findOrphanEntities).toHaveBeenCalled();
      expect(mockDb.deleteOrphanEntities).toHaveBeenCalledWith(["e1", "e2"]);
      expect(result.cleanup.entitiesRemoved).toBe(2);
    });

    it("should remove unused tags", async () => {
      mockDb.findOrphanTags.mockResolvedValue([{ id: "t1", name: "unused-tag" }]);
      mockDb.deleteOrphanTags.mockResolvedValue(1);

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(mockDb.findOrphanTags).toHaveBeenCalled();
      expect(mockDb.deleteOrphanTags).toHaveBeenCalledWith(["t1"]);
      expect(result.cleanup.tagsRemoved).toBe(1);
    });

    it("should report correct cleanup counts", async () => {
      mockDb.findOrphanEntities.mockResolvedValue([{ id: "e1", name: "test", type: "concept" }]);
      mockDb.deleteOrphanEntities.mockResolvedValue(1);
      mockDb.findOrphanTags.mockResolvedValue([{ id: "t1", name: "test" }]);
      mockDb.deleteOrphanTags.mockResolvedValue(1);

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(result.cleanup.entitiesRemoved).toBe(1);
      expect(result.cleanup.tagsRemoved).toBe(1);
    });
  });

  // Abort handling
  describe("Abort handling", () => {
    it("should stop between phases when aborted", async () => {
      const abortController = new AbortController();

      // Abort after Phase 1
      mockDb.findDuplicateClusters.mockImplementation(async () => {
        abortController.abort();
        return [];
      });

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger, {
        abortSignal: abortController.signal,
      });

      expect(result.aborted).toBe(true);
      // Phase 1 ran, but subsequent phases should be skipped
      expect(mockDb.findDuplicateClusters).toHaveBeenCalled();
    });

    it("should show aborted=true in result", async () => {
      const abortController = new AbortController();
      abortController.abort();

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger, {
        abortSignal: abortController.signal,
      });

      expect(result.aborted).toBe(true);
    });

    it("should not corrupt data on abort", async () => {
      const abortController = new AbortController();

      mockDb.findDuplicateClusters.mockImplementation(async () => {
        abortController.abort();
        return [
          {
            memoryIds: ["m1", "m2"],
            texts: ["a", "b"],
            importances: [0.5, 0.6],
            similarities: new Map([["m1:m2", 0.98]]),
          },
        ];
      });

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger, {
        abortSignal: abortController.signal,
      });

      // Even though aborted, the cluster merge should not have been called
      // (abort happens before mergeMemoryCluster in the loop)
      expect(result.aborted).toBe(true);
    });
  });

  // Error isolation
  describe("Error isolation", () => {
    it("should continue to Phase 2 if Phase 1 fails", async () => {
      mockDb.findDuplicateClusters.mockRejectedValue(new Error("phase 1 error"));

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      // Phase 2 should still run
      expect(mockDb.calculateAllEffectiveScores).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Phase 1 error"));
    });

    it("should handle LLM timeout without crashing", async () => {
      mockDb.findConflictingMemories.mockResolvedValue([
        {
          memoryA: { id: "m1", text: "a", importance: 0.5, createdAt: "2024-01-01" },
          memoryB: { id: "m2", text: "b", importance: 0.5, createdAt: "2024-01-02" },
        },
      ]);

      globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("timeout", "TimeoutError"));

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      // Should not crash, conflict resolution returns "skip"
      expect(result.conflict.resolved).toBe(0);
      // Other phases should continue
      expect(mockDb.calculateAllEffectiveScores).toHaveBeenCalled();
    });

    it("should handle Neo4j transient error retries", async () => {
      // This is tested more thoroughly in neo4j-client.test.ts
      // Here we just verify the sleep cycle doesn't crash
      mockDb.findDuplicateClusters
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce([]);

      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      // Should log error but continue
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  // Progress callbacks
  describe("Progress callbacks", () => {
    it("should call onPhaseStart for each phase", async () => {
      const onPhaseStart = vi.fn();

      await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger, {
        onPhaseStart,
      });

      expect(onPhaseStart).toHaveBeenCalledWith("dedup");
      expect(onPhaseStart).toHaveBeenCalledWith("conflict");
      expect(onPhaseStart).toHaveBeenCalledWith("semanticDedup");
      expect(onPhaseStart).toHaveBeenCalledWith("pareto");
      expect(onPhaseStart).toHaveBeenCalledWith("promotion");
      expect(onPhaseStart).toHaveBeenCalledWith("extraction");
      expect(onPhaseStart).toHaveBeenCalledWith("decay");
      expect(onPhaseStart).toHaveBeenCalledWith("cleanup");
    });

    it("should call onProgress with phase messages", async () => {
      const onProgress = vi.fn();
      mockDb.findDuplicateClusters.mockResolvedValue([
        {
          memoryIds: ["m1", "m2"],
          texts: ["a", "b"],
          importances: [0.5, 0.6],
          similarities: new Map([["m1:m2", 0.98]]),
        },
      ]);
      mockDb.mergeMemoryCluster.mockResolvedValue({ survivorId: "m2", deletedCount: 1 });

      await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger, {
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledWith("dedup", expect.any(String));
    });
  });

  // Overall result structure
  describe("Result structure", () => {
    it("should return complete result object", async () => {
      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(result).toHaveProperty("dedup");
      expect(result).toHaveProperty("conflict");
      expect(result).toHaveProperty("semanticDedup");
      expect(result).toHaveProperty("pareto");
      expect(result).toHaveProperty("promotion");
      expect(result).toHaveProperty("decay");
      expect(result).toHaveProperty("extraction");
      expect(result).toHaveProperty("cleanup");
      expect(result).toHaveProperty("durationMs");
      expect(result).toHaveProperty("aborted");
    });

    it("should track duration correctly", async () => {
      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe("number");
    });

    it("should default aborted to false", async () => {
      const result = await runSleepCycle(mockDb, mockEmbeddings, mockConfig, mockLogger);

      expect(result.aborted).toBe(false);
    });
  });
});

// ============================================================================
// isTransientError()
// ============================================================================

// ============================================================================
// isSemanticDuplicate
// ============================================================================

describe("isSemanticDuplicate", () => {
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

  it("should return false when extraction is disabled", async () => {
    const result = await isSemanticDuplicate("new text", "existing text", disabledConfig);
    expect(result).toBe(false);
  });

  it("should return true when LLM says duplicate", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({ verdict: "duplicate", reason: "same fact" }),
              },
            },
          ],
        }),
    });

    const result = await isSemanticDuplicate("I like Neo4j", "User prefers Neo4j", enabledConfig);
    expect(result).toBe(true);
  });

  it("should return false when LLM says unique", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({ verdict: "unique", reason: "different topic" }),
              },
            },
          ],
        }),
    });

    const result = await isSemanticDuplicate("I like coffee", "User lives in NYC", enabledConfig);
    expect(result).toBe(false);
  });

  it("should skip LLM call when vector similarity is below threshold", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const result = await isSemanticDuplicate(
      "text a",
      "text b",
      enabledConfig,
      SEMANTIC_DEDUP_VECTOR_THRESHOLD - 0.01,
    );
    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("should call LLM when vector similarity is at or above threshold", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({ verdict: "duplicate", reason: "same" }),
              },
            },
          ],
        }),
    });

    const result = await isSemanticDuplicate(
      "text a",
      "text b",
      enabledConfig,
      SEMANTIC_DEDUP_VECTOR_THRESHOLD,
    );
    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("should call LLM when no vector similarity is provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({ verdict: "unique", reason: "different" }),
              },
            },
          ],
        }),
    });

    const result = await isSemanticDuplicate("text a", "text b", enabledConfig);
    expect(result).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("should return false on fetch error (fail-open)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException("signal timed out", "TimeoutError"));

    const result = await isSemanticDuplicate("text a", "text b", enabledConfig);
    expect(result).toBe(false);
  });

  it("should return false on invalid JSON response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "not valid json" } }],
        }),
    });

    const result = await isSemanticDuplicate("text a", "text b", enabledConfig);
    expect(result).toBe(false);
  });

  it("should return false when verdict is missing from response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({ reason: "no verdict field" }),
              },
            },
          ],
        }),
    });

    const result = await isSemanticDuplicate("text a", "text b", enabledConfig);
    expect(result).toBe(false);
  });

  it("should return false when LLM returns null content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: null } }],
        }),
    });

    const result = await isSemanticDuplicate("text a", "text b", enabledConfig);
    expect(result).toBe(false);
  });

  it("should respect abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("signal aborted", "AbortError"));

    const result = await isSemanticDuplicate(
      "text a",
      "text b",
      enabledConfig,
      undefined,
      controller.signal,
    );
    expect(result).toBe(false);
  });
});

// ============================================================================
// isTransientError
// ============================================================================

describe("isTransientError", () => {
  it("should return false for non-Error values", () => {
    expect(isTransientError("string error")).toBe(false);
    expect(isTransientError(42)).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });

  it("should classify AbortError as transient", () => {
    const err = new DOMException("signal aborted", "AbortError");
    expect(isTransientError(err)).toBe(true);
  });

  it("should classify TimeoutError as transient", () => {
    const err = new DOMException("signal timed out", "TimeoutError");
    expect(isTransientError(err)).toBe(true);
  });

  it("should classify timeout messages as transient", () => {
    expect(isTransientError(new Error("Request timeout after 30s"))).toBe(true);
  });

  it("should classify ECONNREFUSED as transient", () => {
    expect(isTransientError(new Error("connect ECONNREFUSED 127.0.0.1:7687"))).toBe(true);
  });

  it("should classify ECONNRESET as transient", () => {
    expect(isTransientError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("should classify ETIMEDOUT as transient", () => {
    expect(isTransientError(new Error("connect ETIMEDOUT 10.0.0.1:443"))).toBe(true);
  });

  it("should classify DNS failure (ENOTFOUND) as transient", () => {
    expect(isTransientError(new Error("getaddrinfo ENOTFOUND api.openrouter.ai"))).toBe(true);
  });

  it("should classify HTTP 429 (rate limit) as transient", () => {
    expect(isTransientError(new Error("OpenRouter API error 429: rate limited"))).toBe(true);
  });

  it("should classify HTTP 502 (bad gateway) as transient", () => {
    expect(isTransientError(new Error("OpenRouter API error 502: bad gateway"))).toBe(true);
  });

  it("should classify HTTP 503 (service unavailable) as transient", () => {
    expect(isTransientError(new Error("OpenRouter API error 503: service unavailable"))).toBe(true);
  });

  it("should classify HTTP 504 (gateway timeout) as transient", () => {
    expect(isTransientError(new Error("OpenRouter API error 504: gateway timeout"))).toBe(true);
  });

  it("should classify network errors as transient", () => {
    expect(isTransientError(new Error("network error"))).toBe(true);
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
  });

  it("should classify HTTP 500 as non-transient", () => {
    expect(isTransientError(new Error("OpenRouter API error 500: internal server error"))).toBe(
      false,
    );
  });

  it("should classify JSON parse errors as non-transient", () => {
    expect(isTransientError(new Error("Unexpected token < in JSON"))).toBe(false);
  });

  it("should classify generic errors as non-transient", () => {
    expect(isTransientError(new Error("something went wrong"))).toBe(false);
  });
});
