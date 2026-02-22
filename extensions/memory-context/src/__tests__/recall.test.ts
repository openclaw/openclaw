import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Phase 4 -- recall and format tests
 *
 * Verifies: hybrid search recall, knowledge matching, hardcap enforcement,
 * recall-format output structure, code formatting preservation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEmbeddingProvider } from "../core/embedding.js";
import { KnowledgeStore } from "../core/knowledge-store.js";
import { buildRecalledContextBlock } from "../core/recall-format.js";
import { WarmStore } from "../core/store.js";

describe("recall + format", () => {
  let tmpDir: string;
  let rawStore: WarmStore;
  let knowledgeStore: KnowledgeStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "recall-"));
    rawStore = new WarmStore({
      sessionId: "test",
      embedding: await createEmbeddingProvider(undefined, "hash"),
      coldStore: { path: join(tmpDir, "raw") },
      maxSegments: 1000,
      vectorPersist: false,
    });

    knowledgeStore = new KnowledgeStore(join(tmpDir, "knowledge"));

    // Seed raw store with some segments
    await rawStore.addSegment({
      role: "user",
      content: "implement stripe webhook handler in src/payment/webhook.ts",
    });
    await rawStore.addSegment({
      role: "assistant",
      content:
        "I created src/payment/webhook.ts with:\nconst sig = req.headers['stripe-signature'];\nconst event = stripe.webhooks.constructEvent(body, sig, endpointSecret);",
    });
    await rawStore.addSegment({
      role: "user",
      content: "deploy the app to Hetzner server at 168.119.42.1 using Docker Compose",
    });

    // Seed knowledge store
    await knowledgeStore.add({ type: "decision", content: "Use Stripe for payment processing" });
    await knowledgeStore.add({ type: "config", content: "Deploy target: Hetzner 168.119.42.1" });
    await knowledgeStore.add({ type: "task_state", content: "Refund logic not yet implemented" });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- Raw Store recall --

  it("hybrid search finds relevant raw segments", async () => {
    const results = await rawStore.hybridSearch("webhook stripe", 5, 0.0, {
      vectorWeight: 0.7,
      bm25Weight: 0.3,
      timeDecay: 0.995,
    });

    expect(results.length).toBeGreaterThan(0);
    // At least one result should mention webhook or stripe
    const texts = results.map((r) => r.segment.content.toLowerCase());
    expect(texts.some((t) => t.includes("webhook") || t.includes("stripe"))).toBe(true);
  });

  it("BM25 search finds keyword matches", () => {
    const results = rawStore.searchByBM25("webhook", 5);
    expect(results.length).toBeGreaterThan(0);
  });

  // -- Knowledge Store matching --

  it("knowledge store search finds matching facts", () => {
    const results = knowledgeStore.search("stripe payment");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("Stripe");
  });

  it("knowledge store returns empty for unrelated queries", () => {
    const results = knowledgeStore.search("quantum computing");
    expect(results).toHaveLength(0);
  });

  // -- Recall format --

  it("buildRecalledContextBlock produces correct XML structure", () => {
    const knowledge = knowledgeStore.getActive();
    const details = [
      {
        segment: [...rawStore.getAllSegments()][0],
        score: 0.8,
      },
    ];

    const result = buildRecalledContextBlock(knowledge, details, 5000);

    expect(result.block).toContain("<recalled-context");
    expect(result.block).toContain("<knowledge>");
    expect(result.block).toContain("</knowledge>");
    expect(result.block).toContain("<detail>");
    expect(result.block).toContain("</detail>");
    expect(result.block).toContain("</recalled-context>");
    expect(result.knowledgeCount).toBeGreaterThan(0);
    expect(result.detailCount).toBe(1);
  });

  it("knowledge block groups facts by type with [type] prefix", () => {
    const knowledge = knowledgeStore.getActive();
    const result = buildRecalledContextBlock(knowledge, [], 5000);

    expect(result.block).toContain("[decision]");
    expect(result.block).toContain("[config]");
    expect(result.block).toContain("[task_state]");
  });

  it("detail block preserves code formatting (no whitespace collapse)", () => {
    const codeSegment = [...rawStore.getAllSegments()].find((s) =>
      s.content.includes("constructEvent"),
    )!;

    const result = buildRecalledContextBlock([], [{ segment: codeSegment, score: 0.9 }], 5000);

    // The original has newlines in the code -- they must be preserved
    expect(result.block).toContain("const sig = req.headers");
    expect(result.block).toContain("\n"); // Newlines preserved
    expect(result.block).not.toContain("const sig = req.headers['stripe-signature']; const event"); // NOT collapsed
  });

  // -- Hard cap enforcement --

  it("respects hardCap: truncates detail when over budget", () => {
    // Create many large segments
    const bigSegments = Array.from({ length: 20 }, (_, i) => ({
      segment: {
        id: `seg-${i}`,
        sessionId: "test",
        timestamp: Date.now() - i * 1000,
        role: "assistant" as const,
        content: `This is a very long response about topic ${i}. `.repeat(50),
        tokens: 500,
      },
      score: 0.9 - i * 0.01,
    }));

    const result = buildRecalledContextBlock([], bigSegments, 500);

    // Total tokens should be <= hardCap (or close to it -- at most 1 segment over)
    expect(result.tokens).toBeLessThanOrEqual(600); // Allow some overhead for XML tags
    expect(result.detailCount).toBeLessThan(20);
  });

  it("returns empty block when nothing matches", () => {
    const result = buildRecalledContextBlock([], [], 5000);
    expect(result.block).toBe("");
    expect(result.tokens).toBe(0);
    expect(result.knowledgeCount).toBe(0);
    expect(result.detailCount).toBe(0);
  });

  it("knowledge-only block works without detail", () => {
    const knowledge = knowledgeStore.getActive();
    const result = buildRecalledContextBlock(knowledge, [], 5000);

    expect(result.block).toContain("<knowledge>");
    expect(result.block).not.toContain("<detail>");
    expect(result.knowledgeCount).toBeGreaterThan(0);
    expect(result.detailCount).toBe(0);
  });

  it("detail-only block works without knowledge", () => {
    const segments = [...rawStore.getAllSegments()];
    const details = segments.map((s) => ({ segment: s, score: 0.8 }));
    const result = buildRecalledContextBlock([], details, 5000);

    expect(result.block).not.toContain("<knowledge>");
    expect(result.block).toContain("<detail>");
    expect(result.detailCount).toBeGreaterThan(0);
  });
});
