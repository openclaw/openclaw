import { unlink, writeFile } from "fs/promises";
import { join } from "path";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { WorkingMemoryBuffer } from "./buffer";
import { Embeddings } from "./embeddings";
import { GraphDB } from "./graph";

describe("Verification of Critical Fixes", () => {
  const testDir = __dirname;
  const graphPath = join(testDir, "graph.json");

  // Cleanup before tests
  beforeAll(async () => {
    try {
      await unlink(graphPath);
    } catch {}
  });

  it("should prevent race conditions in GraphDB (Fix #2)", async () => {
    const graph = new GraphDB(join(testDir, "dummy.db"));

    // Simulate 5 parallel writes
    const actions = Array.from({ length: 5 }).map(async (_, i) => {
      await graph.load();
      graph.addNode({ id: `Node${i}`, type: "Test" });
      await graph.save();
    });

    await Promise.all(actions);

    // Reload and check
    const newGraph = new GraphDB(join(testDir, "dummy.db"));
    await newGraph.load();

    expect(newGraph.nodeCount).toBe(5);
  });

  it("should fuzzy match similar strings in Buffer (Fix #3)", () => {
    const buffer = new WorkingMemoryBuffer(50, 0.7, 3);

    buffer.add("I love artificial intelligence", 0.5, "fact");

    // 1 edit distance (change 'l' to 'L') - should match
    const res1 = (buffer as any).findSimilar("I Love artificial intelligence");
    expect(res1).toBeDefined();

    // Small typo "inteligence" - should match
    const res2 = (buffer as any).findSimilar("I love artificial inteligence");
    expect(res2).toBeDefined();

    // Completely different - should not match
    const res3 = (buffer as any).findSimilar("I hate bananas");
    expect(res3).toBeUndefined();
  });

  it("should retry on 429 errors in Embeddings (Fix #4)", async () => {
    const embeddings = new Embeddings("fake-key", "gemini-embedding-001", "google");

    let callCount = 0;
    // Mock the global fetch
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return { ok: false, status: 429, text: async () => "Too Many Requests" };
      }
      return {
        ok: true,
        json: async () => ({ embedding: { values: [0.1, 0.2, 0.3] } }),
      };
    });

    const vector = await embeddings.embed("test");
    expect(callCount).toBe(3); // Should hold at 3rd attempt
    expect(vector).toHaveLength(3);
  });

  it("should cache redundant embedding calls (Myelination)", async () => {
    const embeddings = new Embeddings("fake-key", "gemini-embedding-001", "google");

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({ embedding: { values: [0.9, 0.9, 0.9] } }),
      };
    });

    // First call - should hit API
    await embeddings.embed("redundant");
    expect(callCount).toBe(1);

    // Second call - should hit cache
    await embeddings.embed("redundant");
    expect(callCount).toBe(1); // Still 1

    // Different text - should hit API
    await embeddings.embed("new");
    expect(callCount).toBe(2);
  });
});
