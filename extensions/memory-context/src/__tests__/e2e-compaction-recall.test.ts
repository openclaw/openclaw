import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Phase 5 -- End-to-end: compaction -> archive -> recall
 *
 * Simulates a full conversation lifecycle:
 * 1. Build 100 messages covering multiple topics
 * 2. Simulate compaction (archive first 60 messages)
 * 3. Query with different topics and verify recall accuracy
 * 4. Verify persistence across store restart
 * 5. Simulate multiple compactions
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { archiveCompactedMessages } from "../core/compaction-bridge.js";
import { createEmbeddingProvider } from "../core/embedding.js";
import { KnowledgeStore } from "../core/knowledge-store.js";
import { buildRecalledContextBlock } from "../core/recall-format.js";
import { type MemoryContextRuntime, type MemoryContextConfig } from "../core/runtime.js";
import { WarmStore } from "../core/store.js";

// -- Helpers --

function makeMessages(count: number, topicFn: (i: number) => string) {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: topicFn(i),
  }));
}

const PAYMENT_MESSAGES = makeMessages(20, (i) =>
  i % 2 === 0
    ? `Question about Stripe payment: how to handle webhook ${i} with endpointSecret whsec_test123`
    : `I implemented the webhook handler in src/payment/webhook.ts iteration ${i}`,
);

const DEPLOY_MESSAGES = makeMessages(20, (i) =>
  i % 2 === 0
    ? `Deploy question: how to set up Docker Compose on Hetzner 168.119.42.${i}`
    : `I configured docker-compose.yml with nginx reverse proxy on port 443 iteration ${i}`,
);

const AUTH_MESSAGES = makeMessages(20, (i) =>
  i % 2 === 0
    ? `Auth question: implement JWT authentication with bcrypt rounds 12 in iteration ${i}`
    : `Created src/auth/middleware.ts with Bearer token validation and refresh logic ${i}`,
);

describe("e2e compaction-recall", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full lifecycle: archive 60 messages, recall by topic", async () => {
    const embedding = await createEmbeddingProvider(undefined, "hash");
    const rawStore = new WarmStore({
      sessionId: "e2e-session",
      embedding,
      coldStore: { path: join(tmpDir, "raw") },
      maxSegments: 10000,
      vectorPersist: false,
    });
    const knowledgeStore = new KnowledgeStore(join(tmpDir, "knowledge"));

    // Simulate compaction: archive 60 messages (20 payment + 20 deploy + 20 auth)
    const messagesToCompact = [...PAYMENT_MESSAGES, ...DEPLOY_MESSAGES, ...AUTH_MESSAGES];
    const archived = await archiveCompactedMessages(rawStore, messagesToCompact, {
      redaction: false,
    });
    expect(archived).toBe(60);
    expect(rawStore.stats().count).toBe(60);

    // Add knowledge facts manually (simulating what knowledge extractor would do)
    await knowledgeStore.add({ type: "decision", content: "Use Stripe for payment processing" });
    await knowledgeStore.add({
      type: "config",
      content: "Deploy to Hetzner 168.119.42.x with Docker Compose",
    });
    await knowledgeStore.add({
      type: "implementation",
      content: "JWT auth with bcrypt rounds 12 in src/auth/middleware.ts",
    });
    await knowledgeStore.add({ type: "task_state", content: "Refund logic not yet implemented" });

    // -- Recall: payment topic --
    const paymentResults = await rawStore.hybridSearch("stripe webhook payment", 5, 0.0, {
      vectorWeight: 0.7,
      bm25Weight: 0.3,
      timeDecay: 0.995,
    });
    const paymentKnowledge = knowledgeStore.search("stripe payment");

    const paymentRecall = buildRecalledContextBlock(paymentKnowledge, paymentResults, 2000);
    expect(paymentRecall.block).toContain("Stripe");
    expect(paymentRecall.knowledgeCount).toBeGreaterThan(0);
    expect(paymentRecall.detailCount).toBeGreaterThan(0);

    // -- Recall: deploy topic --
    const deployResults = await rawStore.hybridSearch("docker hetzner deploy", 5, 0.0, {
      vectorWeight: 0.7,
      bm25Weight: 0.3,
      timeDecay: 0.995,
    });
    const deployKnowledge = knowledgeStore.search("hetzner docker deploy");

    const deployRecall = buildRecalledContextBlock(deployKnowledge, deployResults, 2000);
    expect(deployRecall.block).toContain("Hetzner");
    expect(deployRecall.block).toContain("Docker");

    // -- Recall: unrelated topic --
    const unrelatedResults = await rawStore.hybridSearch("quantum computing physics", 5, 0.5, {
      vectorWeight: 0.7,
      bm25Weight: 0.3,
      timeDecay: 0.995,
    });
    const unrelatedKnowledge = knowledgeStore.search("quantum computing");

    const unrelatedRecall = buildRecalledContextBlock(unrelatedKnowledge, unrelatedResults, 2000);
    // Should have nothing or very little
    expect(unrelatedRecall.knowledgeCount).toBe(0);
  });

  it("persistence: recall works after store restart", async () => {
    const rawPath = join(tmpDir, "raw-persist");
    const knowledgePath = join(tmpDir, "knowledge-persist");

    // Session 1: archive messages
    {
      const store = new WarmStore({
        sessionId: "persist-test",
        embedding: await createEmbeddingProvider(undefined, "hash"),
        coldStore: { path: rawPath },
        maxSegments: 1000,
        vectorPersist: true,
      });
      await archiveCompactedMessages(store, PAYMENT_MESSAGES, { redaction: false });
      await store.flush(); // Ensure all JSONL writes complete before restart
      store.persistVectorsNow(); // Force sync persist

      const ks = new KnowledgeStore(knowledgePath);
      await ks.add({ type: "decision", content: "Stripe webhook with signature verification" });
    }

    // Session 2: new store instances, same paths
    {
      const store2 = new WarmStore({
        sessionId: "persist-test",
        embedding: await createEmbeddingProvider(undefined, "hash"),
        coldStore: { path: rawPath },
        maxSegments: 1000,
        vectorPersist: true,
        crossSession: true,
      });
      await store2.init();
      expect(store2.stats().count).toBe(20);

      const ks2 = new KnowledgeStore(knowledgePath);
      await ks2.init();
      expect(ks2.size).toBe(1);

      // Search should still work
      const results = store2.searchByBM25("webhook", 5);
      expect(results.length).toBeGreaterThan(0);
    }
  });

  it("multiple compactions: memory accumulates correctly", async () => {
    const embedding = await createEmbeddingProvider(undefined, "hash");
    const rawStore = new WarmStore({
      sessionId: "multi-compact",
      embedding,
      coldStore: { path: join(tmpDir, "raw-multi") },
      maxSegments: 10000,
      vectorPersist: false,
    });

    // Compaction 1: payment messages
    await archiveCompactedMessages(rawStore, PAYMENT_MESSAGES, { redaction: false });
    expect(rawStore.stats().count).toBe(20);

    // Compaction 2: deploy messages
    await archiveCompactedMessages(rawStore, DEPLOY_MESSAGES, { redaction: false });
    expect(rawStore.stats().count).toBe(40);

    // Compaction 3: auth messages
    await archiveCompactedMessages(rawStore, AUTH_MESSAGES, { redaction: false });
    expect(rawStore.stats().count).toBe(60);

    // All topics should be searchable
    expect(rawStore.searchByBM25("webhook", 3).length).toBeGreaterThan(0);
    expect(rawStore.searchByBM25("docker", 3).length).toBeGreaterThan(0);
    expect(rawStore.searchByBM25("jwt", 3).length).toBeGreaterThan(0);
  });

  it("hardcap prevents excessive context injection", async () => {
    const embedding = await createEmbeddingProvider(undefined, "hash");
    const rawStore = new WarmStore({
      sessionId: "hardcap-test",
      embedding,
      coldStore: { path: join(tmpDir, "raw-cap") },
      maxSegments: 10000,
      vectorPersist: false,
    });

    // Archive many detailed messages
    const bigMessages = makeMessages(50, (i) =>
      `This is a very detailed technical discussion about architecture topic ${i}. `.repeat(20),
    );
    await archiveCompactedMessages(rawStore, bigMessages, { redaction: false });

    // Search returns many results
    const results = await rawStore.hybridSearch("architecture", 20, 0.0, {
      vectorWeight: 0.7,
      bm25Weight: 0.3,
      timeDecay: 0.995,
    });

    // Build with a strict hardcap
    const recall = buildRecalledContextBlock([], results, 500);

    // Block should exist but be within budget
    expect(recall.tokens).toBeLessThanOrEqual(600); // Allow overhead for XML tags
    expect(recall.detailCount).toBeLessThan(results.length);
  });

  it("stats/observability: stores report useful metrics", async () => {
    const rawStore = new WarmStore({
      sessionId: "stats-test",
      embedding: await createEmbeddingProvider(undefined, "hash"),
      coldStore: { path: join(tmpDir, "raw-stats") },
      maxSegments: 1000,
      vectorPersist: false,
    });
    const knowledgeStore = new KnowledgeStore(join(tmpDir, "ks-stats"));

    await archiveCompactedMessages(rawStore, PAYMENT_MESSAGES.slice(0, 6), { redaction: false });
    await knowledgeStore.add({ type: "decision", content: "Use Stripe" });
    await knowledgeStore.add({ type: "config", content: "Port 8080" });

    const rawStats = rawStore.stats();
    expect(rawStats.count).toBe(6);
    expect(rawStats.bm25Size).toBe(6);

    const ksStats = knowledgeStore.stats();
    expect(ksStats.active).toBe(2);
    expect(ksStats.superseded).toBe(0);
    expect(ksStats.total).toBe(2);
  });
});
