/**
 * Enhanced RAG 单元测试
 */

import { describe, it, expect } from "vitest";
import {
  EnhancedRAG,
  createSelfRAGTool,
  createMultiHopRAGTool,
  createEnhancedRAGTools,
  type SelfRAGResult,
} from "./rag-enhanced.js";

describe("Enhanced RAG", () => {
  describe("EnhancedRAG class", () => {
    it("should create instance with default config", () => {
      const rag = new EnhancedRAG();
      expect(rag).toBeDefined();
    });

    it("should create instance with custom config", () => {
      const rag = new EnhancedRAG({
        maxHops: 5,
        minConfidence: 0.8,
        enableSelfAssessment: true,
      });
      expect(rag).toBeDefined();
    });

    it("should execute self-RAG with mock retrieve and generate", async () => {
      const rag = new EnhancedRAG({ enableSelfAssessment: true });

      const mockRetrieve = async (_query: string): Promise<string[]> => {
        return [
          "Document 1: Quantum computing uses qubits",
          "Document 2: Qubits can be in superposition",
        ];
      };

      const mockGenerate = async (_query: string, _context: string): Promise<string> => {
        return "Quantum computing uses qubits which can be in superposition.";
      };

      const result = await rag.selfRAG(
        "What is quantum computing?",
        mockRetrieve,
        mockGenerate,
      );

      expect(result.answer).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.citations).toBeDefined();
      expect(result.citations.length).toBeGreaterThan(0);
    });

    it("should return low confidence when no retrieval results", async () => {
      const rag = new EnhancedRAG();

      const mockRetrieve = async (): Promise<string[]> => [];
      const mockGenerate = async (): Promise<string> => "Answer";

      const result = await rag.selfRAG(
        "Test query",
        mockRetrieve,
        mockGenerate,
      );

      expect(result.confidence).toBe(0);
      expect(result.citations).toHaveLength(0);
      expect(result.answer).toContain("No relevant information");
    });

    it("should assess relevance correctly", async () => {
      const rag = new EnhancedRAG();

      // Use reflection to test private method
      const assessRelevance = (rag as any).assessRelevance.bind(rag);

      const retrieved = [
        "Machine learning is a subset of artificial intelligence",
        "Deep learning uses neural networks",
      ];
      const query = "What is machine learning?";

      const relevance = await assessRelevance(retrieved, query);

      expect(relevance).toBeGreaterThanOrEqual(0);
      expect(relevance).toBeLessThanOrEqual(1);
    });

    it("should assess support correctly", async () => {
      const rag = new EnhancedRAG();

      const assessSupport = (rag as any).assessSupport.bind(rag);

      const retrieved = [
        "Paris is the capital of France",
        "France is in Europe",
      ];
      const answer = "Paris is the capital of France, which is in Europe.";

      const support = await assessSupport(retrieved, answer);

      expect(support).toBeGreaterThanOrEqual(0);
      expect(support).toBeLessThanOrEqual(1);
    });

    it("should assess utility correctly", async () => {
      const rag = new EnhancedRAG();

      const assessUtility = (rag as any).assessUtility.bind(rag);

      const answer = "Therefore, the answer is 42. This is because...";
      const query = "What is the answer?";

      const utility = await assessUtility(answer, query);

      expect(utility).toBeGreaterThanOrEqual(0);
      expect(utility).toBeLessThanOrEqual(1);
    });

    it("should extract citations", async () => {
      const rag = new EnhancedRAG();

      const extractCitations = (rag as any).extractCitations.bind(rag);

      const retrieved = [
        "Document 1 content",
        "Document 2 content",
        "Document 3 content",
      ];
      const answer = "Test answer";

      const citations = await extractCitations(retrieved, answer);

      expect(citations).toHaveLength(3);
      expect(citations[0].source).toBe("source-1");
      expect(citations[0].score).toBe(1);
    });

    it("should execute multi-hop RAG", async () => {
      const rag = new EnhancedRAG({ maxHops: 3 });

      const mockRetrieve = async (query: string): Promise<string[]> => {
        return [`Evidence for: ${query}`];
      };

      const mockGenerateSubQuestion = async (
        question: string,
        _context: string,
      ): Promise<string> => {
        return `Sub-question: ${question}`;
      };

      const mockGenerateFinalAnswer = async (
        question: string,
        _context: string,
      ): Promise<string> => {
        return `Final answer for: ${question}`;
      };

      const result = await rag.multiHopRAG(
        "Complex question",
        mockRetrieve,
        mockGenerateSubQuestion,
        mockGenerateFinalAnswer,
      );

      expect(result.answer).toBeDefined();
      expect(result.hops).toBeGreaterThanOrEqual(1);
      expect(result.hops).toBeLessThanOrEqual(3);
      expect(result.reasoningChain).toBeDefined();
    });
  });

  describe("createSelfRAGTool", () => {
    it("should create tool with correct schema", () => {
      const tool = createSelfRAGTool();

      expect(tool.name).toBe("self_rag");
      expect(tool.label).toBe("Self-RAG");
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeDefined();
    });

    it("should have required parameters", () => {
      const tool = createSelfRAGTool();
      const params = tool.parameters as any;

      expect(params.type).toBe("object");
      expect(params.required).toContain("query");
      expect(params.properties.query).toBeDefined();
      expect(params.properties.includeCitations).toBeDefined();
    });

    it("should execute successfully", async () => {
      const tool = createSelfRAGTool();

      const result = await tool.execute(
        "test-call-id",
        { query: "Test query" },
        undefined,
        undefined,
      );

      expect(result).toBeDefined();
      expect(result.details.frameworkReady).toBe(true);
    });
  });

  describe("createMultiHopRAGTool", () => {
    it("should create tool with correct schema", () => {
      const tool = createMultiHopRAGTool();

      expect(tool.name).toBe("multihop_rag");
      expect(tool.label).toBe("Multi-hop RAG");
      expect(tool.description).toBeDefined();
    });

    it("should execute successfully", async () => {
      const tool = createMultiHopRAGTool();

      const result = await tool.execute(
        "test-call-id",
        { question: "Test question", maxHops: 3 },
        undefined,
        undefined,
      );

      expect(result).toBeDefined();
      expect(result.details.frameworkReady).toBe(true);
    });
  });

  describe("createEnhancedRAGTools", () => {
    it("should return array of tools", () => {
      const tools = createEnhancedRAGTools();

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(2);
      expect(tools[0].name).toBe("self_rag");
      expect(tools[1].name).toBe("multihop_rag");
    });
  });

  describe("SelfRAGResult type", () => {
    it("should have all required fields", () => {
      const result: SelfRAGResult = {
        answer: "Test answer",
        confidence: 0.8,
        citations: [],
        relevance: 0.7,
        support: 0.9,
        utility: 0.8,
      };

      expect(result.answer).toBeDefined();
      expect(result.confidence).toBeDefined();
      expect(result.citations).toBeDefined();
      expect(result.relevance).toBeDefined();
      expect(result.support).toBeDefined();
      expect(result.utility).toBeDefined();
    });
  });
});
