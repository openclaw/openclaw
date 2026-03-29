import { describe, test, expect, beforeEach } from "vitest";
import { WorkingMemoryBuffer } from "./buffer.js";

describe("WorkingMemoryBuffer", () => {
  let buffer: WorkingMemoryBuffer;

  beforeEach(() => {
    buffer = new WorkingMemoryBuffer(5, 0.7, 3); // small buffer for testing
  });

  test("should add entry to buffer", async () => {
    await buffer.add("test fact", 0.5, "other");
    expect(buffer.size).toBe(1);
  });

  test("should promote high importance facts immediately", async () => {
    const result = await buffer.add("User's email is test@example.com", 0.9, "entity");
    expect(result.promoted).toBe(true);
    expect(result.reason).toContain("high importance");
  });

  test("should promote entity category immediately", async () => {
    const result = await buffer.add("User's phone is 555-1234", 0.5, "entity");
    expect(result.promoted).toBe(true);
    expect(result.reason).toContain("entity");
  });

  test("should promote decision category immediately", async () => {
    const result = await buffer.add("We decided to use Python", 0.5, "decision");
    expect(result.promoted).toBe(true);
    expect(result.reason).toContain("decision");
  });

  test("should NOT promote low importance non-entity facts", async () => {
    const result = await buffer.add("I had coffee today", 0.3, "other");
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("below threshold");
  });

  test("should promote after mention threshold reached", async () => {
    await buffer.add("Python is great", 0.4, "preference");
    await buffer.add("Python is great", 0.5, "preference"); // mention 2
    const result = await buffer.add("Python is great", 0.5, "preference"); // mention 3
    expect(result.promoted).toBe(true);
    expect(result.reason).toContain("frequency threshold");
  });

  test("should increment mention count for similar entries", async () => {
    await buffer.add("I like TypeScript", 0.4, "preference");
    const result = await buffer.add("I like TypeScript", 0.5, "preference");
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("count incremented");
  });

  test("forcePromote should always promote", async () => {
    const result = await buffer.forcePromote("Random unimportant thing");
    expect(result.promoted).toBe(true);
    expect(result.reason).toContain("explicit user request");
  });

  test("forcePromote should promote existing entry in buffer", async () => {
    await buffer.add("I live in Kyiv", 0.3, "other");
    const result = await buffer.forcePromote("I live in Kyiv");
    expect(result.promoted).toBe(true);
    expect(buffer.size).toBe(1); // should not duplicate
  });

  test("should evict oldest non-promoted when full", async () => {
    // Fill buffer (max 5) — use distinct strings to avoid fuzzy matching
    await buffer.add("the weather is cloudy today", 0.3, "other"); // non-promoted
    await buffer.add("python is a programming language", 0.3, "other"); // non-promoted
    await buffer.add("kyiv is the capital of ukraine", 0.3, "other"); // non-promoted
    await buffer.add("important thing", 0.9, "entity"); // promoted
    await buffer.add("another important", 0.8, "decision"); // promoted
    expect(buffer.size).toBe(5);

    // Add 6th — should evict oldest non-promoted ("the weather is cloudy today")
    await buffer.add("random unrelated new entry here", 0.3, "other");
    expect(buffer.size).toBe(5);

    // Oldest non-promoted should be gone
    const texts = buffer.entries.map((e) => e.text);
    expect(texts).not.toContain("the weather is cloudy today");
    expect(texts).toContain("important thing"); // promoted stays
  });

  test("stats should return correct values", async () => {
    await buffer.add("low", 0.3, "other");
    await buffer.add("high", 0.9, "entity");
    await buffer.add("decision", 0.5, "decision");

    const stats = buffer.stats();
    expect(stats.total).toBe(3);
    expect(stats.promoted).toBe(2); // high importance + decision
    expect(stats.pending).toBe(1);
    expect(stats.avgImportance).toBeGreaterThan(0);
  });

  test("clear should empty the buffer", async () => {
    await buffer.add("test", 0.5, "other");
    await buffer.add("test2", 0.5, "other");
    buffer.clear();
    expect(buffer.size).toBe(0);
  });

  test("findSimilar should match subsets", async () => {
    await buffer.add("User lives in Kyiv, Ukraine", 0.5, "other");
    const result = await buffer.add("User lives in Kyiv, Ukraine and works remotely", 0.6, "other");
    // Should find the existing entry since one contains the other
    expect(result.reason).toContain("count incremented");
  });

  test("should handle empty buffer stats", async () => {
    const stats = buffer.stats();
    expect(stats.total).toBe(0);
    expect(stats.avgImportance).toBe(0);
  });

  test("promotedCount getter should work", async () => {
    await buffer.add("low", 0.3, "other");
    await buffer.add("entity", 0.5, "entity");
    expect(buffer.promotedCount).toBe(1);
  });
});
