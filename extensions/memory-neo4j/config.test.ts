/**
 * Tests for config.ts — Configuration Parsing.
 *
 * Tests memoryNeo4jConfigSchema.parse(), vectorDimsForModel(), and resolveExtractionConfig().
 */

import { describe, it, expect, afterEach } from "vitest";
import { memoryNeo4jConfigSchema, vectorDimsForModel, resolveExtractionConfig } from "./config.js";

// ============================================================================
// memoryNeo4jConfigSchema.parse()
// ============================================================================

describe("memoryNeo4jConfigSchema.parse", () => {
  // Store original env vars so we can restore them
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("valid complete configs", () => {
    it("should parse a minimal valid config with ollama provider", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test" },
        embedding: { provider: "ollama" },
      });

      expect(config.neo4j.uri).toBe("bolt://localhost:7687");
      expect(config.neo4j.username).toBe("neo4j");
      expect(config.neo4j.password).toBe("test");
      expect(config.embedding.provider).toBe("ollama");
      expect(config.embedding.model).toBe("mxbai-embed-large");
      expect(config.embedding.apiKey).toBeUndefined();
      expect(config.autoCapture).toBe(true);
      expect(config.autoRecall).toBe(true);
      expect(config.coreMemory.enabled).toBe(true);
      expect(config.coreMemory.maxEntries).toBe(50);
    });

    it("should parse a full config with openai provider", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: {
          uri: "neo4j+s://cloud.neo4j.io:7687",
          username: "admin",
          password: "secret",
        },
        embedding: {
          provider: "openai",
          apiKey: "sk-test-key",
          model: "text-embedding-3-large",
        },
        autoCapture: false,
        autoRecall: false,
        coreMemory: {
          enabled: false,
          maxEntries: 100,
          refreshAtContextPercent: 75,
        },
      });

      expect(config.neo4j.uri).toBe("neo4j+s://cloud.neo4j.io:7687");
      expect(config.neo4j.username).toBe("admin");
      expect(config.neo4j.password).toBe("secret");
      expect(config.embedding.provider).toBe("openai");
      expect(config.embedding.apiKey).toBe("sk-test-key");
      expect(config.embedding.model).toBe("text-embedding-3-large");
      expect(config.autoCapture).toBe(false);
      expect(config.autoRecall).toBe(false);
      expect(config.coreMemory.enabled).toBe(false);
      expect(config.coreMemory.maxEntries).toBe(100);
      expect(config.coreMemory.refreshAtContextPercent).toBe(75);
    });

    it("should support 'user' field as alias for 'username' in neo4j config", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", user: "custom-user", password: "pass" },
        embedding: { provider: "ollama" },
      });
      expect(config.neo4j.username).toBe("custom-user");
    });

    it("should support 'username' field in neo4j config", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", username: "custom-user", password: "pass" },
        embedding: { provider: "ollama" },
      });
      expect(config.neo4j.username).toBe("custom-user");
    });

    it("should default neo4j username to 'neo4j' when not specified", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "pass" },
        embedding: { provider: "ollama" },
      });
      expect(config.neo4j.username).toBe("neo4j");
    });
  });

  describe("missing required fields", () => {
    it("should throw when config is null", () => {
      expect(() => memoryNeo4jConfigSchema.parse(null)).toThrow("memory-neo4j config required");
    });

    it("should throw when config is undefined", () => {
      expect(() => memoryNeo4jConfigSchema.parse(undefined)).toThrow(
        "memory-neo4j config required",
      );
    });

    it("should throw when config is not an object", () => {
      expect(() => memoryNeo4jConfigSchema.parse("string")).toThrow("memory-neo4j config required");
    });

    it("should throw when config is an array", () => {
      expect(() => memoryNeo4jConfigSchema.parse([])).toThrow("memory-neo4j config required");
    });

    it("should throw when neo4j section is missing", () => {
      expect(() =>
        memoryNeo4jConfigSchema.parse({
          embedding: { provider: "ollama" },
        }),
      ).toThrow("neo4j config section is required");
    });

    it("should throw when neo4j.uri is missing", () => {
      expect(() =>
        memoryNeo4jConfigSchema.parse({
          neo4j: { password: "test" },
          embedding: { provider: "ollama" },
        }),
      ).toThrow("neo4j.uri is required");
    });

    it("should throw when neo4j.uri is empty string", () => {
      expect(() =>
        memoryNeo4jConfigSchema.parse({
          neo4j: { uri: "", password: "test" },
          embedding: { provider: "ollama" },
        }),
      ).toThrow("neo4j.uri is required");
    });
  });

  describe("environment variable resolution", () => {
    it("should resolve ${ENV_VAR} in neo4j.password", () => {
      process.env.TEST_NEO4J_PASSWORD = "resolved-password";
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: {
          uri: "bolt://localhost:7687",
          password: "${TEST_NEO4J_PASSWORD}",
        },
        embedding: { provider: "ollama" },
      });
      expect(config.neo4j.password).toBe("resolved-password");
    });

    it("should resolve ${ENV_VAR} in embedding.apiKey", () => {
      process.env.TEST_OPENAI_KEY = "sk-from-env";
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "openai", apiKey: "${TEST_OPENAI_KEY}" },
      });
      expect(config.embedding.apiKey).toBe("sk-from-env");
    });

    it("should throw when referenced env var is not set", () => {
      delete process.env.NONEXISTENT_VAR;
      expect(() =>
        memoryNeo4jConfigSchema.parse({
          neo4j: {
            uri: "bolt://localhost:7687",
            password: "${NONEXISTENT_VAR}",
          },
          embedding: { provider: "ollama" },
        }),
      ).toThrow("Environment variable NONEXISTENT_VAR is not set");
    });
  });

  describe("default values", () => {
    it("should default autoCapture to true", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
      });
      expect(config.autoCapture).toBe(true);
    });

    it("should default autoRecall to true", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
      });
      expect(config.autoRecall).toBe(true);
    });

    it("should default coreMemory.enabled to true", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
      });
      expect(config.coreMemory.enabled).toBe(true);
    });

    it("should default coreMemory.maxEntries to 50", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
      });
      expect(config.coreMemory.maxEntries).toBe(50);
    });

    it("should default refreshAtContextPercent to undefined", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBeUndefined();
    });

    it("should default embedding model to mxbai-embed-large for ollama", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
      });
      expect(config.embedding.model).toBe("mxbai-embed-large");
    });

    it("should default embedding model to text-embedding-3-small for openai", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "openai", apiKey: "sk-test" },
      });
      expect(config.embedding.model).toBe("text-embedding-3-small");
    });

    it("should default neo4j.password to empty string when not provided", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687" },
        embedding: { provider: "ollama" },
      });
      expect(config.neo4j.password).toBe("");
    });
  });

  describe("provider validation", () => {
    it("should require apiKey for openai provider", () => {
      expect(() =>
        memoryNeo4jConfigSchema.parse({
          neo4j: { uri: "bolt://localhost:7687", password: "" },
          embedding: { provider: "openai" },
        }),
      ).toThrow("embedding.apiKey is required for OpenAI provider");
    });

    it("should not require apiKey for ollama provider", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
      });
      expect(config.embedding.apiKey).toBeUndefined();
    });

    it("should default to openai when no provider is specified", () => {
      // No provider but has apiKey — should default to openai
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { apiKey: "sk-test" },
      });
      expect(config.embedding.provider).toBe("openai");
    });

    it("should accept embedding.baseUrl", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama", baseUrl: "http://my-ollama:11434" },
      });
      expect(config.embedding.baseUrl).toBe("http://my-ollama:11434");
    });
  });

  describe("unknown keys rejected", () => {
    it("should reject unknown top-level keys", () => {
      expect(() =>
        memoryNeo4jConfigSchema.parse({
          neo4j: { uri: "bolt://localhost:7687", password: "" },
          embedding: { provider: "ollama" },
          unknownKey: "value",
        }),
      ).toThrow("unknown keys: unknownKey");
    });

    it("should reject unknown neo4j keys", () => {
      expect(() =>
        memoryNeo4jConfigSchema.parse({
          neo4j: { uri: "bolt://localhost:7687", password: "", port: 7687 },
          embedding: { provider: "ollama" },
        }),
      ).toThrow("unknown keys: port");
    });

    it("should reject unknown embedding keys", () => {
      expect(() =>
        memoryNeo4jConfigSchema.parse({
          neo4j: { uri: "bolt://localhost:7687", password: "" },
          embedding: { provider: "ollama", temperature: 0.5 },
        }),
      ).toThrow("unknown keys: temperature");
    });

    it("should reject unknown coreMemory keys", () => {
      expect(() =>
        memoryNeo4jConfigSchema.parse({
          neo4j: { uri: "bolt://localhost:7687", password: "" },
          embedding: { provider: "ollama" },
          coreMemory: { unknownField: true },
        }),
      ).toThrow("unknown keys: unknownField");
    });
  });

  describe("refreshAtContextPercent edge cases", () => {
    it("should accept refreshAtContextPercent of 1 (minimum valid)", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
        coreMemory: { refreshAtContextPercent: 1 },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBe(1);
    });

    it("should accept refreshAtContextPercent of 100 (maximum valid)", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
        coreMemory: { refreshAtContextPercent: 100 },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBe(100);
    });

    it("should reject refreshAtContextPercent of 0", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
        coreMemory: { refreshAtContextPercent: 0 },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBeUndefined();
    });

    it("should reject refreshAtContextPercent over 100 by throwing", () => {
      expect(() =>
        memoryNeo4jConfigSchema.parse({
          neo4j: { uri: "bolt://localhost:7687", password: "" },
          embedding: { provider: "ollama" },
          coreMemory: { refreshAtContextPercent: 150 },
        }),
      ).toThrow("coreMemory.refreshAtContextPercent must be between 1 and 100");
    });

    it("should reject negative refreshAtContextPercent", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
        coreMemory: { refreshAtContextPercent: -10 },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBeUndefined();
    });

    it("should ignore non-number refreshAtContextPercent", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
        coreMemory: { refreshAtContextPercent: "50" },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBeUndefined();
    });
  });

  describe("extraction config section", () => {
    it("should parse extraction config when provided", () => {
      process.env.EXTRACTION_DUMMY = ""; // avoid env var issues
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
        extraction: {
          apiKey: "or-test-key",
          model: "google/gemini-2.0-flash-001",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      });
      expect(config.extraction).toBeDefined();
      expect(config.extraction!.apiKey).toBe("or-test-key");
      expect(config.extraction!.model).toBe("google/gemini-2.0-flash-001");
    });

    it("should not include extraction when section is empty", () => {
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", password: "" },
        embedding: { provider: "ollama" },
        extraction: {},
      });
      expect(config.extraction).toBeUndefined();
    });

    it("should reject unknown keys in extraction section", () => {
      expect(() =>
        memoryNeo4jConfigSchema.parse({
          neo4j: { uri: "bolt://localhost:7687", password: "" },
          embedding: { provider: "ollama" },
          extraction: { badKey: "value" },
        }),
      ).toThrow("unknown keys: badKey");
    });
  });
});

// ============================================================================
// vectorDimsForModel()
// ============================================================================

describe("vectorDimsForModel", () => {
  describe("known models", () => {
    it("should return 1536 for text-embedding-3-small", () => {
      expect(vectorDimsForModel("text-embedding-3-small")).toBe(1536);
    });

    it("should return 3072 for text-embedding-3-large", () => {
      expect(vectorDimsForModel("text-embedding-3-large")).toBe(3072);
    });

    it("should return 1024 for mxbai-embed-large", () => {
      expect(vectorDimsForModel("mxbai-embed-large")).toBe(1024);
    });

    it("should return 768 for nomic-embed-text", () => {
      expect(vectorDimsForModel("nomic-embed-text")).toBe(768);
    });

    it("should return 384 for all-minilm", () => {
      expect(vectorDimsForModel("all-minilm")).toBe(384);
    });
  });

  describe("prefix matching", () => {
    it("should match versioned model names via prefix", () => {
      // mxbai-embed-large:latest should match mxbai-embed-large
      expect(vectorDimsForModel("mxbai-embed-large:latest")).toBe(1024);
    });

    it("should match model with additional version suffix", () => {
      expect(vectorDimsForModel("nomic-embed-text:v1.5")).toBe(768);
    });
  });

  describe("unknown models", () => {
    it("should return default 1024 for unknown model", () => {
      expect(vectorDimsForModel("unknown-model")).toBe(1024);
    });

    it("should return default 1024 for empty string", () => {
      expect(vectorDimsForModel("")).toBe(1024);
    });

    it("should return default 1024 for unrecognized prefix", () => {
      expect(vectorDimsForModel("custom-embed-v2")).toBe(1024);
    });
  });
});

// ============================================================================
// resolveExtractionConfig()
// ============================================================================

describe("resolveExtractionConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("should return disabled config when no API key or explicit baseUrl", () => {
    delete process.env.OPENROUTER_API_KEY;
    const config = resolveExtractionConfig();
    expect(config.enabled).toBe(false);
    expect(config.apiKey).toBe("");
  });

  it("should enable when OPENROUTER_API_KEY env var is set", () => {
    process.env.OPENROUTER_API_KEY = "or-env-key";
    const config = resolveExtractionConfig();
    expect(config.enabled).toBe(true);
    expect(config.apiKey).toBe("or-env-key");
  });

  it("should enable when plugin config provides apiKey", () => {
    delete process.env.OPENROUTER_API_KEY;
    const config = resolveExtractionConfig({
      apiKey: "or-plugin-key",
      model: "custom-model",
      baseUrl: "https://custom.ai/api",
    });
    expect(config.enabled).toBe(true);
    expect(config.apiKey).toBe("or-plugin-key");
    expect(config.model).toBe("custom-model");
    expect(config.baseUrl).toBe("https://custom.ai/api");
  });

  it("should enable when baseUrl is explicitly set (local Ollama, no API key)", () => {
    delete process.env.OPENROUTER_API_KEY;
    const config = resolveExtractionConfig({
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(config.enabled).toBe(true);
    expect(config.apiKey).toBe("");
    expect(config.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("should use defaults for model and baseUrl", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.EXTRACTION_MODEL;
    delete process.env.EXTRACTION_BASE_URL;
    const config = resolveExtractionConfig();
    expect(config.model).toBe("google/gemini-2.0-flash-001");
    expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("should use EXTRACTION_MODEL env var", () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.EXTRACTION_MODEL = "meta/llama-3-70b";
    const config = resolveExtractionConfig();
    expect(config.model).toBe("meta/llama-3-70b");
  });

  it("should use EXTRACTION_BASE_URL env var", () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.EXTRACTION_BASE_URL = "https://my-proxy.ai/v1";
    const config = resolveExtractionConfig();
    expect(config.baseUrl).toBe("https://my-proxy.ai/v1");
  });

  it("should always set temperature to 0.0 and maxRetries to 2", () => {
    const config = resolveExtractionConfig();
    expect(config.temperature).toBe(0.0);
    expect(config.maxRetries).toBe(2);
  });
});
