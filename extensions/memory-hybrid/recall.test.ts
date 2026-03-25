import { describe, test, expect, vi } from "vitest";
import { GraphDB, type GraphEdge } from "./graph.js";
import { hybridScore, getGraphEnrichment, type MemoryEntry } from "./recall.js";

function createMockEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "uuid-1234",
    text: "Default test memory",
    vector: [0.1, 0.2, 0.3],
    importance: 0.5,
    category: "other",
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 7, // 7 days ago
    ...overrides,
  };
}

describe("hybridScore (7-Channel Formula)", () => {
  test("prioritizes highly important memories over standard ones", async () => {
    const mockGraph = { findEdgesForTexts: vi.fn().mockResolvedValue([]) } as unknown as GraphDB;

    const results = [
      { entry: createMockEntry({ importance: 0.2 }), score: 0.8 },
      { entry: createMockEntry({ importance: 0.9, id: "important-1" }), score: 0.8 },
    ];

    const scored = await hybridScore(results, mockGraph);
    expect(scored[0].entry.id).toBe("important-1");
    expect(scored[0].importanceScore).toBe(0.9);
  });

  test("applies temporal relevance (happenedAt)", async () => {
    const mockGraph = { findEdgesForTexts: vi.fn().mockResolvedValue([]) } as unknown as GraphDB;
    // Event that happened closer to today should score higher
    const results = [
      {
        entry: createMockEntry({ happenedAt: new Date(Date.now() - 86400000).toISOString() }),
        score: 0.8,
      }, // 1 day ago
      {
        entry: createMockEntry({
          happenedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
          id: "old-event",
        }),
        score: 0.8,
      }, // 10 days ago
    ];

    const scored = await hybridScore(results, mockGraph);
    expect(scored[0].entry.id).not.toBe("old-event");
    expect(scored[0].temporalScore).toBeGreaterThan(scored[1].temporalScore);
  });

  test("boosts memories with graph connections", async () => {
    const mockGraphWithEdges = {
      findEdgesForTexts: vi.fn().mockImplementation(async (texts) => {
        if (texts[0] === "Connected text") return [{} as GraphEdge, {} as GraphEdge];
        return [];
      }),
    } as unknown as GraphDB;

    const results = [
      { entry: createMockEntry({ text: "Connected text", id: "graph-boosted" }), score: 0.8 },
      { entry: createMockEntry({ text: "Isolated text" }), score: 0.8 },
    ];

    const scored = await hybridScore(results, mockGraphWithEdges);
    expect(scored[0].entry.id).toBe("graph-boosted");
    expect(scored[0].graphScore).toBeGreaterThan(0);
  });

  test("factors in reinforcement score (recallCount)", async () => {
    const mockGraph = { findEdgesForTexts: vi.fn().mockResolvedValue([]) } as unknown as GraphDB;
    const results = [
      { entry: createMockEntry({ recallCount: 10, id: "well-known" }), score: 0.6 },
      { entry: createMockEntry({ recallCount: 0 }), score: 0.6 },
    ];

    const scored = await hybridScore(results, mockGraph);
    expect(scored[0].entry.id).toBe("well-known");
    expect(scored[0].reinforcementScore).toBeGreaterThan(0);
  });

  test("factors in emotional alignment", async () => {
    const mockGraph = { findEdgesForTexts: vi.fn().mockResolvedValue([]) } as unknown as GraphDB;
    const results = [
      { entry: createMockEntry({ emotionScore: 0.8, id: "emotional" }), score: 0.6 },
      { entry: createMockEntry({ emotionScore: 0 }), score: 0.6 },
    ];

    const scored = await hybridScore(results, mockGraph);
    expect(scored[0].entry.id).toBe("emotional");
    expect(scored[0].emotionalScore).toBeGreaterThan(0.3);
  });
});

describe("getGraphEnrichment", () => {
  test("generates human readable graph context", async () => {
    const mockGraph = {
      findEdgesForTexts: vi.fn().mockResolvedValue([{ source: "apple", target: "fruit" }]),
      traverse: vi.fn().mockReturnValue({
        edges: [
          { source: "apple", relation: "IS_A", target: "fruit" },
          { source: "fruit", relation: "RELATED_TO", target: "food" },
        ],
      }),
    } as unknown as GraphDB;

    const results = [{ entry: createMockEntry({ text: "I like apple" }) } as any];
    const enrichment = await getGraphEnrichment(results, mockGraph);

    expect(enrichment).toContain("Knowledge Graph Connections:");
    expect(enrichment).toContain("apple --[IS_A]--> fruit");
    expect(enrichment).toContain("fruit --[RELATED_TO]--> food");
  });

  test("returns empty string if no graph edges found", async () => {
    const mockGraph = { findEdgesForTexts: vi.fn().mockResolvedValue([]) } as unknown as GraphDB;
    const results = [{ entry: createMockEntry({ text: "Nothing here" }) } as any];
    const enrichment = await getGraphEnrichment(results, mockGraph);
    expect(enrichment).toBe("");
  });
});
