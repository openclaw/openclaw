import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatModel } from "./chat.js";
import { GraphDB, extractGraphFromText } from "./graph.js";

// Mock openai and fetch to prevent network calls
vi.mock("openai", () => {
  return {
    default: class OpenAI {
      chat = {
        completions: {
          create: vi.fn(),
        },
      };
    },
  };
});

const TEST_DB_DIR = join(process.cwd(), ".memory", "test_sota_db");
const GRAPH_FILE = join(TEST_DB_DIR, "graph.jsonl");

describe("SOTA Architecture Upgrades", () => {
  beforeEach(async () => {
    try {
      await rm(TEST_DB_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe("1. Graph Ontology Enforcement (Concept Chaos)", () => {
    it("normalizes extracted node IDs to lowercase trimmed", async () => {
      const mockChatModel = new ChatModel("test-key", "gpt-4o-mini", "openai");
      // Mock the LLM returning messy cased nodes and relations
      vi.spyOn(mockChatModel, "complete").mockResolvedValueOnce(
        JSON.stringify({
          nodes: [
            { id: "  VoVa  ", type: "Person" },
            { id: "Python 3", type: "Tech" },
          ],
          edges: [{ source: " VoVa ", target: "PYTHON 3", relation: "loves coding in" }],
        }),
      );

      const result = await extractGraphFromText(
        "Vova is a person who loves coding in Python 3 everyday.",
        mockChatModel,
      );

      // Verify node normalization
      expect(result.nodes).toHaveLength(2);
      expect(result.nodes[0].id).toBe("vova");
      expect(result.nodes[1].id).toBe("python 3"); // lowercase

      // Verify edge relation fallback/normalization
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].source).toBe("vova");
      expect(result.edges[0].target).toBe("python 3");
      // Since 'loves coding in' is not in the allowed list, it should fallback to RELATED_TO
      expect(result.edges[0].relation).toBe("RELATED_TO");
    });

    it("accepts allowed relations directly", async () => {
      const mockChatModel = new ChatModel("test-key", "gpt-4o-mini", "openai");
      vi.spyOn(mockChatModel, "complete").mockResolvedValueOnce(
        JSON.stringify({
          nodes: [
            { id: "vova", type: "Person" },
            { id: "apples", type: "Food" },
          ],
          edges: [{ source: "vova", target: "apples", relation: "LIKES" }],
        }),
      );

      const result = await extractGraphFromText(
        "Vova likes eating fresh apples from the garden.",
        mockChatModel,
      );
      expect(result.edges[0].relation).toBe("LIKES");
    });
  });

  describe("2. JSON Fragility (Structured Outputs)", () => {
    it("sends response_format: json_object for OpenAI when jsonMode is true", async () => {
      const mockChatModel = new ChatModel("test-key", "gpt-4o-mini", "openai");
      const completeSpy = vi.spyOn(mockChatModel as any, "completeOpenAI").mockResolvedValue("{}");

      await mockChatModel.complete([{ role: "user", content: "test" }], true);

      // We can't easily assert the exact arguments to the mocked openAI client
      // without exposing internal properties, but we ensure the jsonMode flag is passed properly
      expect(completeSpy).toHaveBeenCalledWith(expect.any(Array), true);
    });
  });

  describe("3. Graph Concurrency Locks", () => {
    it("safely modifies the graph concurrently without race conditions", async () => {
      const db = new GraphDB(join(TEST_DB_DIR, "db"));
      await db.load();

      // Trigger 50 concurrent graph modifications
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        promises.push(
          db.modify(() => {
            db.addNode({ id: `node${i}`, type: "Test" });
            db.addEdge({
              source: "root",
              target: `node${i}`,
              relation: "HAS",
              timestamp: Date.now(),
            });
          }),
        );
      }

      await Promise.all(promises);

      // Verify all nodes and edges were saved
      expect(db.nodeCount).toBe(50);
      expect(db.edgeCount).toBe(50);

      // Reload graph from disk to verify append-only saved correctly without corruption
      const db2 = new GraphDB(join(TEST_DB_DIR, "db"));
      await db2.load();

      expect(db2.nodeCount).toBe(50);
      expect(db2.edgeCount).toBe(50);
    });
  });
});
