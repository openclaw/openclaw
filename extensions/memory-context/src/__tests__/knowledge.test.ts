import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Phase 2 -- Knowledge Store + Extractor + Updater tests
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extractKnowledge, __testing as extractorInternals } from "../core/knowledge-extractor.js";
import { KnowledgeStore } from "../core/knowledge-store.js";
import { applyKnowledgeUpdates, __testing as updaterInternals } from "../core/knowledge-updater.js";

// -- Knowledge Store Tests --

describe("KnowledgeStore", () => {
  let tmpDir: string;
  let store: KnowledgeStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-"));
    store = new KnowledgeStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("add and get a fact", async () => {
    const fact = await store.add({
      type: "decision",
      content: "Use PostgreSQL for the database",
      context: "architecture",
    });
    expect(fact.id).toBeTruthy();
    expect(fact.type).toBe("decision");

    const retrieved = store.get(fact.id);
    expect(retrieved).toEqual(fact);
  });

  it("dedup: same content is not added twice", async () => {
    const f1 = await store.add({ type: "decision", content: "Use PostgreSQL" });
    const f2 = await store.add({ type: "decision", content: "Use PostgreSQL" });

    expect(f1.id).toBe(f2.id);
    expect(store.size).toBe(1);
  });

  it("update changes content but keeps ID", async () => {
    const f = await store.add({ type: "config", content: "Port is 3000" });
    const updated = await store.update(f.id, "Port changed to 8080");

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(f.id);
    expect(updated!.content).toBe("Port changed to 8080");
    expect(store.size).toBe(1);
  });

  it("supersede marks old fact and keeps new active", async () => {
    const old = await store.add({ type: "decision", content: "Use MySQL" });
    const newer = await store.add({ type: "decision", content: "Switched to PostgreSQL" });
    await store.supersede(old.id, newer.id);

    const oldFact = store.get(old.id);
    expect(oldFact!.supersededBy).toBe(newer.id);
    // Active count should be 1 (only the new one)
    expect(store.size).toBe(1);

    const active = store.getActive();
    expect(active).toHaveLength(1);
    expect(active[0].content).toBe("Switched to PostgreSQL");
  });

  it("search finds matching facts", async () => {
    await store.add({ type: "decision", content: "Use Stripe for payment processing" });
    await store.add({ type: "config", content: "Redis runs on port 6379" });
    await store.add({ type: "architecture", content: "Microservice with Docker Compose" });

    const results = store.search("stripe payment");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("Stripe");
  });

  it("persistence: facts survive reload", async () => {
    await store.add({ type: "decision", content: "Use TypeScript" });
    await store.add({ type: "config", content: "Node 22 required" });

    // Create new store instance pointing to same path
    const store2 = new KnowledgeStore(tmpDir);
    await store2.init();

    expect(store2.size).toBe(2);
    const results = store2.search("TypeScript");
    expect(results).toHaveLength(1);
  });

  it("stats reports correct counts", async () => {
    const f1 = await store.add({ type: "decision", content: "Use Redis" });
    const f2 = await store.add({ type: "decision", content: "Use PostgreSQL" });
    await store.supersede(f1.id, f2.id);

    const s = store.stats();
    expect(s.active).toBe(1);
    expect(s.superseded).toBe(1);
    expect(s.total).toBe(2);
  });
});

// -- Knowledge Extractor Tests --

describe("KnowledgeExtractor", () => {
  it("parseFactsResponse handles valid JSON", () => {
    const response =
      '{"facts": [{"type": "decision", "content": "Use PostgreSQL", "context": "db"}]}';
    const facts = extractorInternals.parseFactsResponse(response);
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe("decision");
    expect(facts[0].content).toBe("Use PostgreSQL");
  });

  it("parseFactsResponse handles markdown-fenced JSON", () => {
    const response = '```json\n{"facts": [{"type": "config", "content": "Port 8080"}]}\n```';
    const facts = extractorInternals.parseFactsResponse(response);
    expect(facts).toHaveLength(1);
  });

  it("parseFactsResponse returns empty for invalid JSON", () => {
    expect(extractorInternals.parseFactsResponse("not json")).toHaveLength(0);
    expect(extractorInternals.parseFactsResponse("")).toHaveLength(0);
    expect(extractorInternals.parseFactsResponse('{"facts": "not array"}')).toHaveLength(0);
  });

  it("parseFactsResponse filters invalid fact types", () => {
    const response =
      '{"facts": [{"type": "invalid_type", "content": "test"}, {"type": "decision", "content": "valid"}]}';
    const facts = extractorInternals.parseFactsResponse(response);
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe("decision");
  });

  it("extractKnowledge returns empty for too few messages", async () => {
    const mockLLM = async () => '{"facts": []}';
    const result = await extractKnowledge([{ role: "user", content: "hi" }], mockLLM);
    expect(result).toHaveLength(0);
  });

  it("extractKnowledge calls LLM and parses response", async () => {
    const mockLLM = async (_prompt: string) => {
      return '{"facts": [{"type": "decision", "content": "Use Stripe for payments", "context": "payment"}]}';
    };

    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message about payment processing ${i}`,
    }));

    const result = await extractKnowledge(messages, mockLLM);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("decision");
  });

  it("extractKnowledge handles LLM failure gracefully", async () => {
    const failingLLM = async () => {
      throw new Error("API error");
    };
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: "user",
      content: `message ${i}`,
    }));
    const result = await extractKnowledge(messages, failingLLM);
    expect(result).toHaveLength(0);
  });

  it("formatConversation handles array content blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will implement the webhook" },
          { type: "tool_use", id: "t1", name: "write" },
        ],
      },
    ];
    const formatted = extractorInternals.formatConversation(messages);
    expect(formatted).toContain("I will implement the webhook");
    expect(formatted).not.toContain("tool_use");
  });
});

// -- Knowledge Updater Tests --

describe("KnowledgeUpdater", () => {
  let tmpDir: string;
  let store: KnowledgeStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ku-"));
    store = new KnowledgeStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wordOverlap computes correctly", () => {
    expect(updaterInternals.wordOverlap("hello world", "hello world")).toBeCloseTo(1.0);
    expect(updaterInternals.wordOverlap("hello world", "goodbye world")).toBeCloseTo(0.33, 1);
    expect(updaterInternals.wordOverlap("", "hello")).toBe(0);
  });

  it("ADD: new fact with no match", async () => {
    const result = await applyKnowledgeUpdates(store, [
      { type: "decision", content: "Use PostgreSQL for the database" },
    ]);

    expect(result.added).toBe(1);
    expect(result.actions[0].op).toBe("ADD");
    expect(store.size).toBe(1);
  });

  it("NONE: exact duplicate skipped", async () => {
    await store.add({ type: "decision", content: "Use PostgreSQL" });

    const result = await applyKnowledgeUpdates(store, [
      { type: "decision", content: "Use PostgreSQL" },
    ]);

    expect(result.skipped).toBe(1);
    expect(result.actions[0].op).toBe("NONE");
    expect(store.size).toBe(1);
  });

  it("UPDATE: more detailed version replaces existing", async () => {
    await store.add({ type: "config", content: "Redis port" });

    const result = await applyKnowledgeUpdates(store, [
      { type: "config", content: "Redis port is 6379 on production server at redis.internal" },
    ]);

    expect(result.updated).toBe(1);
    expect(result.actions[0].op).toBe("UPDATE");
    expect(store.size).toBe(1);

    const facts = store.getActive("config");
    expect(facts[0].content).toContain("6379");
  });

  it("SUPERSEDE: contradictory fact supersedes old (default, no DELETE)", async () => {
    await store.add({ type: "decision", content: "Use MySQL database engine" });

    const result = await applyKnowledgeUpdates(store, [
      { type: "decision", content: "Switched to PostgreSQL database engine" },
    ]);

    expect(result.superseded).toBe(1);
    expect(result.actions[0].op).toBe("SUPERSEDE");
    // Active: only the new one
    expect(store.size).toBe(1);
    // Total: both exist (old is superseded, not deleted)
    expect(store.totalSize).toBe(2);

    const active = store.getActive("decision");
    expect(active[0].content).toContain("PostgreSQL");
  });

  it("batch: processes multiple facts correctly", async () => {
    await store.add({ type: "config", content: "Port 3000" });

    const result = await applyKnowledgeUpdates(store, [
      { type: "config", content: "Port 3000" }, // NONE (duplicate)
      { type: "decision", content: "Use Docker Compose" }, // ADD
      { type: "architecture", content: "Event-driven" }, // ADD
    ]);

    expect(result.skipped).toBe(1);
    expect(result.added).toBe(2);
    expect(store.size).toBe(3);
  });
});
