import { describe, test, expect, vi } from "vitest";
import { MemoryDB } from "./index.js";

describe("MemoryDB Result Limit", () => {
  test("should respect the limit parameter in search", async () => {
    // Mock enough data
    const mockData = Array.from({ length: 15 }).map((_, i) => ({
      id: `id-1234-abcd-${i}`,
      text: `Mock memory number ${i}`,
      vector: [0.1, 0.2],
      importance: 0.5,
      category: "fact",
      createdAt: Date.now() - i * 1000,
      recallCount: 0,
    }));

    // Create results object that implements chaining
    const mockResults = {
      limit: vi.fn().mockImplementation((n) => ({
        toArray: vi
          .fn()
          .mockResolvedValue(mockData.slice(0, n).map((d) => ({ ...d, _distance: 0.1 }))),
      })),
    };

    const mockTable = {
      vectorSearch: vi.fn().mockReturnValue(mockResults),
      query: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation((n) => ({
          toArray: vi.fn().mockResolvedValue(mockData.slice(0, n)),
        })),
      }),
      countRows: vi.fn().mockResolvedValue(15),
    } as any;

    const db = new MemoryDB("/tmp/fake-db-limit", 2);
    (db as any).table = mockTable;
    (db as any).initialized = true;

    // Call search with limit=3
    const results = await db.search([0.1, 0.2], 3);

    // Expect mathematically ONLY 3 results
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
