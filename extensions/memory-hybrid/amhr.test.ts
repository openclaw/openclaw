import { describe, test, expect, vi } from "vitest";
import { GraphDB } from "./graph.js";
import { MemoryDB } from "./index.js";

describe("AMHR (Associative Multi-Hop Retrieval)", () => {
  test("should retrieve associative memories through the knowledge graph", async () => {
    // 1. Setup DBs
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const memoryDb = new MemoryDB("/tmp/amhr-test-db", 3072, undefined as any, mockLogger as any);
    const graphDb = new GraphDB("/tmp/amhr-test-graph.jsonl", undefined as any, mockLogger as any);

    // Mock graph data: Вова --[likes]--> Fishing, Fishing --[needs]--> Rod
    vi.spyOn(graphDb, "traverse").mockResolvedValue({
      nodes: ["Вова", "Fishing", "Rod"],
      edges: [
        { source: "Вова", target: "Fishing", relation: "likes", timestamp: Date.now() },
        { source: "Fishing", target: "Rod", relation: "needs", timestamp: Date.now() },
      ],
    });

    // Mock memory search: returns "Вова loves fishing"
    const mockVector = new Array(3072).fill(0);
    vi.spyOn(memoryDb, "search").mockResolvedValue([
      {
        entry: {
          id: "1",
          text: "Вова loves fishing",
          vector: mockVector,
          importance: 0.9,
          category: "preference",
          createdAt: Date.now(),
          recallCount: 0,
        },
        score: 0.9,
      },
    ]);

    // Mock the table.query() chain for AMHR discovery
    const mockEntry2 = {
      id: "2",
      text: "Fishing requires a rod and a reel",
      vector: mockVector,
      importance: 0.7,
      category: "fact",
      createdAt: Date.now(),
      recallCount: 0,
    };

    const mockTable = {
      search: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([mockEntry2]),
      }),
      vectorSearch: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
    } as any;

    (memoryDb as any).table = mockTable;
    (memoryDb as any).initialized = true;

    const results = await (memoryDb as any).searchWithAMHR(mockVector, 5, graphDb);

    // 3. Assertions
    const texts = results.map((r: any) => r.entry.text);
    expect(texts).toContain("Вова loves fishing");
    expect(texts).toContain("Fishing requires a rod and a reel"); // This is the associative jump
  });
});
