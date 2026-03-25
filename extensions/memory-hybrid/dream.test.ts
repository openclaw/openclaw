import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChatModel } from "./chat.js";
import { DreamService } from "./dream.js";
import type { Embeddings } from "./embeddings.js";
import type { GraphDB } from "./graph.js";
import type { MemoryDB } from "./index.js";

// Mock external dependencies
const mockApi = {
  logger: {
    info: vi.fn(),
    warn: vi.fn((msg) => console.log("API WARN:", msg)),
  },
};

// We intercept consolidate module to mock cluster logic which normally requires real embeddings
vi.mock("./consolidate.js", () => {
  return {
    clusterBySimilarity: vi.fn(),
    mergeFacts: vi.fn(),
    mergeFactsBatch: vi.fn().mockResolvedValue([]),
  };
});

import { clusterBySimilarity, mergeFacts, mergeFactsBatch } from "./consolidate.js";

describe("DreamService (Safe Pulsing Brain)", () => {
  let dreamService: DreamService;
  let mockDb: any;
  let mockChat: any;
  let mockEmbeddings: any;
  let mockGraph: any;

  beforeEach(() => {
    vi.useFakeTimers();

    mockDb = {
      cleanupTrash: vi.fn().mockResolvedValue(0),
      getMemoriesByCategory: vi.fn().mockResolvedValue([]),
      listAll: vi.fn().mockResolvedValue([]),
      store: vi.fn().mockResolvedValue(true),
      delete: vi.fn().mockResolvedValue(true),
      flushRecallCounts: vi.fn().mockResolvedValue(0),
      deleteOldUnused: vi.fn().mockResolvedValue(0),
    };

    mockChat = {
      complete: vi.fn().mockResolvedValue("YES"), // default to 'YES' for self-verification
    };

    mockEmbeddings = {
      embed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
      embedBatch: vi.fn().mockImplementation(async (texts: string[]) => {
        return texts.map(() => new Array(384).fill(0.1));
      }),
    };

    mockGraph = {
      findEdgesForTexts: vi.fn().mockReturnValue([]),
      compact: vi.fn().mockResolvedValue(true),
    };

    dreamService = new DreamService(
      mockDb as any as MemoryDB,
      mockChat as any as ChatModel,
      mockEmbeddings as any as Embeddings,
      mockGraph as any as GraphDB,
      mockApi as any,
    );
  });

  afterEach(() => {
    dreamService.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test("should NOT trigger dream if user interacted within idle threshold", async () => {
    dreamService.registerInteraction();
    // Fast forward exactly 5 mins (threshold is 10 mins)
    vi.advanceTimersByTime(5 * 60 * 1000);

    await (dreamService as any).tick(); // trigger manually

    expect(mockDb.cleanupTrash).not.toHaveBeenCalled();
  });

  test("should safely generate Empathy Profile without exceeding context limits", async () => {
    // Fast forward to active dream window
    vi.advanceTimersByTime(13 * 60 * 60 * 1000);

    const giantText = "A".repeat(20000);
    mockDb.getMemoriesByCategory.mockResolvedValue([
      { id: "1", text: giantText, category: "preference" },
      { id: "2", text: "dummy 2", category: "emotion" },
      { id: "3", text: "dummy 3", category: "decision" },
    ]);

    mockChat.complete.mockResolvedValue("Generated Profile");

    await (dreamService as any).tick();

    expect(mockChat.complete).toHaveBeenCalled();
    const promptCall = (mockChat.complete as any).mock.calls[0][0][0].content;

    // Ensure the prompt string is safely limited.
    expect(promptCall.length).toBeLessThan(12000);
  });

  test("Anti-Hallucination Guard: refuses to merge distinct graph entities", async () => {
    vi.advanceTimersByTime(13 * 60 * 60 * 1000);

    const fact1 = { id: "1", text: "Vova's favorite pizza is pepperoni", category: "fact" };
    const fact2 = { id: "2", text: "Ivan's favorite pizza is pepperoni", category: "fact" };
    // Add 3 padding facts to pass `all.length < 5` early exit check
    const pads = [1, 2, 3].map((i) => ({ id: `p${i}`, text: `pad ${i}`, category: "other" }));
    mockDb.listAll.mockResolvedValue([fact1, fact2, ...pads]);

    // Mock the clusterer to group them
    (clusterBySimilarity as any).mockReturnValue([[fact1, fact2]]);
    (mergeFactsBatch as any).mockResolvedValue(["Vova and Ivan's favorite pizza is pepperoni"]);

    // Mock GraphDB returning completely distinct entities
    mockGraph.findEdgesForTexts.mockImplementation((texts: string[]) => {
      if (texts.includes(fact1.text)) return [{ source: "vova", target: "pizza_1" }];
      if (texts.includes(fact2.text)) return [{ source: "ivan", target: "pizza_2" }];
      return [];
    });

    await (dreamService as any).tick();

    expect(mergeFactsBatch).not.toHaveBeenCalled();
  });

  test("Consolidates identical or highly compatible memories successfully", async () => {
    vi.advanceTimersByTime(13 * 60 * 60 * 1000);

    const fact1 = { id: "1", text: "Vova loves coding in TypeScript", category: "fact" };
    const fact2 = { id: "2", text: "Vova likes programming using TS", category: "fact" };
    const pads = [1, 2, 3].map((i) => ({ id: `p${i}`, text: `pad ${i}`, category: "other" }));

    mockDb.listAll.mockResolvedValue([fact1, fact2, ...pads]);
    (clusterBySimilarity as any).mockReturnValue([[fact1, fact2]]);
    (mergeFactsBatch as any).mockResolvedValue(["Vova loves programming in TypeScript"]);

    mockChat.complete.mockResolvedValue("YES");

    mockGraph.findEdgesForTexts.mockImplementation(() => [
      { source: "vova", target: "typescript" },
    ]);

    await (dreamService as any).tick();

    expect(mergeFactsBatch).toHaveBeenCalled();
    expect(mockDb.store).toHaveBeenCalled();
    expect(mockDb.delete).toHaveBeenCalledTimes(2);
  });
});
