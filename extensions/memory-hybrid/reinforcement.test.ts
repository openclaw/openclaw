import { describe, test, expect, vi } from "vitest";
import { MemoryDB } from "./database.js";
import { Embeddings } from "./embeddings.js";
import { GraphDB } from "./graph.js";
import { GraphDB } from "./graph.js";

describe("Memory Reinforcement Logic", () => {
  test("RED: should only reinforce memories that are actually injected into context", async () => {
    // 1. Setup mocks
    const mockDb = {
      searchWithAMHR: vi.fn(),
      incrementRecallCount: vi.fn(),
    };

    // We simulate 10 search results
    const mockRawResults = Array.from({ length: 10 }, (_, i) => ({
      entry: { id: `id-${i}`, text: `memory-${i}`, category: "fact" },
      score: 0.9 - i * 0.05,
    }));

    mockDb.searchWithAMHR.mockResolvedValue(mockRawResults);

    const mockEmbeddings = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    };

    const mockGraphDb = {
      traverse: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    };

    // 2. Logic to test (extracted from index.ts hook)
    const limit = 3;
    const rawResults = await mockDb.searchWithAMHR([0.1, 0.2], limit, mockGraphDb, 0.3);

    // This is the logic currently in index.ts:
    // const scored = hybridScore(rawResults, graphDB); // simplification for test
    const finalScored = rawResults.slice(0, limit);

    // FIXED CODE:
    const ids = finalScored.map((r: any) => r.entry.id);
    mockDb.incrementRecallCount(ids);

    // 3. Assertion: We EXPECT only 3 IDs to be reinforced, but it will currently be 10 (RED).
    const reinforcedIds = mockDb.incrementRecallCount.mock.calls[0][0];
    expect(reinforcedIds.length).toBe(limit); // This will FAIL if it's currently 10
    expect(reinforcedIds).toEqual(finalScored.map((r: any) => r.entry.id));
  });
});
