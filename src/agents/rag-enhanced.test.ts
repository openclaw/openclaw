/**
 * Enhanced RAG 单元测试
 */

import { describe, it, expect, vi } from "vitest";
import {
  createSelfRAGTool,
  createMultiHopRAGTool,
  createEnhancedRAGTools,
} from "./rag-enhanced.js";

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager: vi.fn().mockResolvedValue({
    manager: {
      search: vi.fn().mockResolvedValue([
        {
          snippet: "Test snippet about quantum computing",
          path: "MEMORY.md",
          startLine: 10,
          endLine: 15,
          score: 0.85,
        },
      ]),
    },
  }),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("Enhanced RAG", () => {
  describe("createSelfRAGTool", () => {
    it("should return null when no config provided", () => {
      const tool = createSelfRAGTool();
      expect(tool).toBeNull();
    });

    it("should create tool when config provided", () => {
      const tool = createSelfRAGTool({
        config: {} as Record<string, unknown>,
        agentSessionKey: "test",
      });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("self_rag");
      expect(tool!.label).toBe("Self-RAG");
      expect(tool!.description).toBeDefined();
      expect(tool!.parameters).toBeDefined();
      expect(tool!.execute).toBeDefined();
    });

    it("should have required parameters", () => {
      const tool = createSelfRAGTool({ config: {} as Record<string, unknown> });
      const params = tool?.parameters as {
        type: string;
        required: string[];
        properties: Record<string, unknown>;
      };

      expect(params.type).toBe("object");
      expect(params.required).toContain("query");
      expect(params.properties.query).toBeDefined();
      expect(params.properties.maxResults).toBeDefined();
      expect(params.properties.minScore).toBeDefined();
    });

    it("should return structured result on execution", async () => {
      const tool = createSelfRAGTool({
        config: {} as Record<string, unknown>,
        agentSessionKey: "test",
      });

      const result = await tool!.execute(
        "test-call-id",
        { query: "test query" },
        undefined,
        undefined,
      );

      expect(result).toBeDefined();
      expect(result.details).toBeDefined();

      const details = result.details as {
        results: unknown[];
        confidence: number;
        assessment: { relevance: number; support: number; utility: number };
        recommendation: string;
        actionItems: string[];
        suggestion: string;
      };

      expect(Array.isArray(details.results)).toBe(true);
      expect(typeof details.confidence).toBe("number");
      expect(details.assessment).toBeDefined();
      expect(details.recommendation).toBeDefined();
      expect(Array.isArray(details.actionItems)).toBe(true);
      expect(typeof details.suggestion).toBe("string");
    });
  });

  describe("createMultiHopRAGTool", () => {
    it("should return null when no config provided", () => {
      const tool = createMultiHopRAGTool();
      expect(tool).toBeNull();
    });

    it("should create tool when config provided", () => {
      const tool = createMultiHopRAGTool({
        config: {} as Record<string, unknown>,
        agentSessionKey: "test",
      });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("multihop_rag");
      expect(tool!.label).toBe("Multi-hop RAG");
      expect(tool!.description).toBeDefined();
    });

    it("should have required parameters", () => {
      const tool = createMultiHopRAGTool({ config: {} as Record<string, unknown> });
      const params = tool?.parameters as {
        type: string;
        required: string[];
        properties: Record<string, unknown>;
      };

      expect(params.type).toBe("object");
      expect(params.required).toContain("question");
      expect(params.properties.question).toBeDefined();
      expect(params.properties.maxHops).toBeDefined();
      expect(params.properties.subQuestions).toBeDefined();
    });

    it("should return structured reasoning chain on execution", async () => {
      const tool = createMultiHopRAGTool({
        config: {} as Record<string, unknown>,
        agentSessionKey: "test",
      });

      const result = await tool!.execute(
        "test-call-id",
        { question: "complex test question", maxHops: 2 },
        undefined,
        undefined,
      );

      expect(result).toBeDefined();
      const details = result.details as {
        reasoningChain: unknown[];
        hops: number;
        totalResults: number;
        avgConfidence: number;
        status: string;
        nextAction: string;
      };

      expect(Array.isArray(details.reasoningChain)).toBe(true);
      expect(typeof details.hops).toBe("number");
      expect(typeof details.totalResults).toBe("number");
      expect(typeof details.avgConfidence).toBe("number");
      expect(details.status).toBeDefined();
      expect(typeof details.nextAction).toBe("string");
    });
  });

  describe("createEnhancedRAGTools", () => {
    it("should return array of nulls when no config provided", () => {
      const tools = createEnhancedRAGTools();

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(2);
      expect(tools[0]).toBeNull();
      expect(tools[1]).toBeNull();
    });

    it("should return tools when config provided", () => {
      const tools = createEnhancedRAGTools({ config: {} as Record<string, unknown> });

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(2);
      expect(tools[0]).not.toBeNull();
      expect(tools[1]).not.toBeNull();
      expect(tools[0]!.name).toBe("self_rag");
      expect(tools[1]!.name).toBe("multihop_rag");
    });
  });

  describe("Confidence Assessment", () => {
    it("should calculate confidence from search results", async () => {
      const tool = createSelfRAGTool({
        config: {} as Record<string, unknown>,
        agentSessionKey: "test",
      });

      const result = await tool!.execute(
        "test-call-id",
        { query: "quantum computing algorithms" },
        undefined,
        undefined,
      );

      const details = result.details as { confidence: number };

      expect(details.confidence).toBeGreaterThanOrEqual(0);
      expect(details.confidence).toBeLessThanOrEqual(1);
    });

    it("should provide actionable recommendations", async () => {
      const tool = createSelfRAGTool({
        config: {} as Record<string, unknown>,
        agentSessionKey: "test",
      });

      const result = await tool!.execute(
        "test-call-id",
        { query: "test query" },
        undefined,
        undefined,
      );

      const details = result.details as {
        recommendation: string;
        actionItems: string[];
      };

      expect(details.recommendation).toBeDefined();
      expect(Array.isArray(details.actionItems)).toBe(true);
      expect(details.actionItems.length).toBeGreaterThan(0);
    });
  });
});
