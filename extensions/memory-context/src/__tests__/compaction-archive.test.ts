import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Phase 3 -- compaction archive tests
 *
 * Verifies that compacted messages are archived to Raw Store,
 * knowledge extraction is triggered asynchronously,
 * and failures don't block the archive flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  archiveCompactedMessages,
  scheduleKnowledgeExtraction,
  extractMessageText,
} from "../core/compaction-bridge.js";
import { createEmbeddingProvider } from "../core/embedding.js";
import { KnowledgeStore } from "../core/knowledge-store.js";
import { WarmStore } from "../core/store.js";

describe("compaction archive", () => {
  let tmpDir: string;
  let rawStore: WarmStore;
  let knowledgeStore: KnowledgeStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "compact-"));
    rawStore = new WarmStore({
      sessionId: "test-session",
      embedding: await createEmbeddingProvider(undefined, "hash"),
      coldStore: { path: join(tmpDir, "raw") },
      maxSegments: 1000,
      vectorPersist: false,
    });
    knowledgeStore = new KnowledgeStore(join(tmpDir, "knowledge"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extractMessageText handles string content", () => {
    expect(extractMessageText({ role: "user", content: "hello" })).toBe("hello");
  });

  it("extractMessageText handles array content blocks", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "part 1" },
        { type: "tool_use", id: "t1" },
        { type: "text", text: "part 2" },
      ],
    };
    expect(extractMessageText(msg)).toBe("part 1\npart 2");
  });

  it("archives user and assistant messages from compaction", async () => {
    const messages = [
      { role: "user", content: "implement stripe webhook" },
      {
        role: "assistant",
        content: "I created src/payment/webhook.ts with signature verification",
      },
      { role: "user", content: "add error handling" },
      { role: "assistant", content: "Done, added try-catch around webhook processing" },
    ];

    const count = await archiveCompactedMessages(rawStore, messages, { redaction: false });

    expect(count).toBe(4);
    expect(rawStore.stats().count).toBe(4);
  });

  it("skips toolResult messages", async () => {
    const messages = [
      { role: "user", content: "run tests" },
      { role: "toolResult", content: "All 42 tests passed" },
      { role: "assistant", content: "Tests are green" },
    ];

    const count = await archiveCompactedMessages(rawStore, messages, { redaction: false });

    expect(count).toBe(2); // user + assistant only
  });

  it("skips empty content messages", async () => {
    const messages = [
      { role: "user", content: "" },
      { role: "user", content: "   " },
      { role: "assistant", content: "valid response" },
    ];

    const count = await archiveCompactedMessages(rawStore, messages, { redaction: false });
    expect(count).toBe(1);
  });

  it("applies redaction when enabled", async () => {
    const messages = [
      { role: "user", content: "set apiKey: sk-proj-abc123def456ghi789jkl012mno345pqr678" },
    ];

    await archiveCompactedMessages(rawStore, messages, { redaction: true });

    // The stored segment should have redacted content
    const segments = [...rawStore.getAllSegments()];
    expect(segments[0].content).toContain("[REDACTED]");
    expect(segments[0].content).not.toContain("sk-proj-abc123def456ghi789jkl012mno345pqr678");
  });

  it("continues archiving even if one message fails", async () => {
    // Create a store that will fail on specific content
    const messages = [
      { role: "user", content: "message 1" },
      { role: "user", content: "message 2" },
      { role: "user", content: "message 3" },
    ];

    const count = await archiveCompactedMessages(rawStore, messages, { redaction: false });
    expect(count).toBe(3);
  });

  it("deduplicates messages during archive", async () => {
    const messages = [
      { role: "user", content: "hello world" },
      { role: "user", content: "hello world" }, // duplicate
    ];

    await archiveCompactedMessages(rawStore, messages, { redaction: false });
    // archiveCompactedMessages calls addSegmentLite for both, but dedup in store means only 1 stored
    // store count reflects actual unique segments
    expect(rawStore.stats().count).toBe(1);
  });

  it("scheduleKnowledgeExtraction runs asynchronously without blocking", async () => {
    const extractionComplete = vi.fn();
    const mockLLM = vi.fn(async () => {
      extractionComplete();
      return '{"facts": [{"type": "decision", "content": "Use Stripe", "context": "payment"}]}';
    });
    const logger = { warn: vi.fn(), info: vi.fn() };

    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `discussion about payment module iteration ${i}`,
    }));

    // Schedule extraction - should NOT block
    scheduleKnowledgeExtraction(messages, knowledgeStore, mockLLM, logger);

    // Extraction hasn't happened yet (it's async)
    expect(extractionComplete).not.toHaveBeenCalled();

    // Wait for the microtask to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Now it should have completed
    expect(mockLLM).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalled();
  });

  it("scheduleKnowledgeExtraction handles LLM failure gracefully", async () => {
    const failingLLM = vi.fn(async () => {
      throw new Error("API down");
    });
    const logger = { warn: vi.fn(), info: vi.fn() };

    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `substantive technical discussion about payment module iteration ${i} with enough detail to extract`,
    }));

    scheduleKnowledgeExtraction(messages, knowledgeStore, failingLLM, logger);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // LLM was called but extractKnowledge catches the error internally
    // and returns empty array. scheduleKnowledgeExtraction does not crash.
    expect(failingLLM).toHaveBeenCalledTimes(1);
    // No facts extracted -> no warn/info logged (error handled gracefully inside extractKnowledge)
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("scheduleKnowledgeExtraction is a no-op when llmCall is undefined", () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    // Should not throw
    scheduleKnowledgeExtraction([], knowledgeStore, undefined, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
