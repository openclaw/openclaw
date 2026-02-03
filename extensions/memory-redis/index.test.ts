/**
 * Redis Memory Plugin Tests
 *
 * Tests the memory plugin functionality including:
 * - Plugin registration and configuration
 * - Config schema validation
 * - Capture filtering logic
 */

import { describe, test, expect } from "vitest";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-key";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const HAS_REDIS = Boolean(process.env.REDIS_URL);
// Live tests require Redis and an embedding provider (OpenAI key OR local embeddings)
const liveEnabled = HAS_REDIS && process.env.LIVE === "1";
const describeLive = liveEnabled ? describe : describe.skip;

describe("memory-redis plugin", () => {
  test("plugin exports correct metadata", async () => {
    const { default: memoryRedisPlugin } = await import("./index.js");

    expect(memoryRedisPlugin.id).toBe("memory-redis");
    expect(memoryRedisPlugin.name).toBe("Memory (Redis)");
    expect(memoryRedisPlugin.kind).toBe("memory");
    expect(memoryRedisPlugin.configSchema).toBeDefined();
    // oxlint-disable-next-line typescript/unbound-method
    expect(memoryRedisPlugin.register).toBeInstanceOf(Function);
  });

  test("config schema parses valid config", async () => {
    const { default: memoryRedisPlugin } = await import("./index.js");

    const config = memoryRedisPlugin.configSchema?.parse?.({
      redis: {
        url: REDIS_URL,
      },
      embedding: {
        provider: "openai",
        apiKey: OPENAI_API_KEY,
        model: "text-embedding-3-small",
      },
      autoCapture: true,
      autoRecall: true,
    });

    expect(config).toBeDefined();
    expect(config?.redis?.url).toBe(REDIS_URL);
    expect(config?.embedding?.provider).toBe("openai");
    expect(config?.embedding?.apiKey).toBe(OPENAI_API_KEY);
    expect(config?.autoCapture).toBe(true);
    expect(config?.autoRecall).toBe(true);
  });

  test("config schema uses defaults", async () => {
    const { default: memoryRedisPlugin } = await import("./index.js");

    const config = memoryRedisPlugin.configSchema?.parse?.({
      redis: {
        url: REDIS_URL,
      },
      embedding: {
        provider: "local",
      },
    });

    expect(config?.indexName).toBe("idx:openclaw:memories");
    expect(config?.keyPrefix).toBe("openclaw:memory");
    expect(config?.autoCapture).toBe(false);
    expect(config?.autoRecall).toBe(false);
    expect(config?.embedding?.provider).toBe("local");
  });

  test("config schema resolves env vars", async () => {
    const { default: memoryRedisPlugin } = await import("./index.js");

    // Set test env vars
    process.env.TEST_REDIS_URL = "redis://test:6379";
    process.env.TEST_OPENAI_KEY = "sk-test-123";

    const config = memoryRedisPlugin.configSchema?.parse?.({
      redis: {
        url: "${TEST_REDIS_URL}",
      },
      embedding: {
        provider: "openai",
        apiKey: "${TEST_OPENAI_KEY}",
      },
    });

    expect(config?.redis?.url).toBe("redis://test:6379");
    expect(config?.embedding?.apiKey).toBe("sk-test-123");

    delete process.env.TEST_REDIS_URL;
    delete process.env.TEST_OPENAI_KEY;
  });

  test("config schema rejects missing redis.url", async () => {
    const { default: memoryRedisPlugin } = await import("./index.js");

    expect(() => {
      memoryRedisPlugin.configSchema?.parse?.({
        redis: {},
        embedding: {
          provider: "openai",
          apiKey: OPENAI_API_KEY,
        },
      });
    }).toThrow("redis.url is required");
  });

  test("config schema requires apiKey for openai provider", async () => {
    const { default: memoryRedisPlugin } = await import("./index.js");

    expect(() => {
      memoryRedisPlugin.configSchema?.parse?.({
        redis: {
          url: REDIS_URL,
        },
        embedding: {
          provider: "openai",
        },
      });
    }).toThrow("embedding.apiKey is required for openai provider");
  });

  test("config schema allows local provider without apiKey", async () => {
    const { default: memoryRedisPlugin } = await import("./index.js");

    const config = memoryRedisPlugin.configSchema?.parse?.({
      redis: {
        url: REDIS_URL,
      },
      embedding: {
        provider: "local",
      },
    });

    expect(config?.embedding?.provider).toBe("local");
    expect(config?.embedding?.apiKey).toBeUndefined();
  });

  test("config schema allows auto provider without apiKey", async () => {
    const { default: memoryRedisPlugin } = await import("./index.js");

    const config = memoryRedisPlugin.configSchema?.parse?.({
      redis: {
        url: REDIS_URL,
      },
      embedding: {
        provider: "auto",
        fallback: "local",
      },
    });

    expect(config?.embedding?.provider).toBe("auto");
    expect(config?.embedding?.fallback).toBe("local");
  });

  test("config schema supports baseUrl for Ollama/self-hosted embeddings", async () => {
    const { default: memoryRedisPlugin } = await import("./index.js");

    const config = memoryRedisPlugin.configSchema?.parse?.({
      redis: {
        url: REDIS_URL,
      },
      embedding: {
        provider: "openai",
        apiKey: "ollama",
        model: "nomic-embed-text",
        baseUrl: "http://192.168.178.10:11434/v1",
      },
    });

    expect(config?.embedding?.provider).toBe("openai");
    expect(config?.embedding?.baseUrl).toBe("http://192.168.178.10:11434/v1");
    expect(config?.embedding?.model).toBe("nomic-embed-text");
  });

  test("config schema resolves env vars in baseUrl", async () => {
    const { default: memoryRedisPlugin } = await import("./index.js");

    process.env.TEST_OLLAMA_URL = "http://my-server:11434/v1";

    const config = memoryRedisPlugin.configSchema?.parse?.({
      redis: {
        url: REDIS_URL,
      },
      embedding: {
        provider: "openai",
        apiKey: "ollama",
        baseUrl: "${TEST_OLLAMA_URL}",
      },
    });

    expect(config?.embedding?.baseUrl).toBe("http://my-server:11434/v1");

    delete process.env.TEST_OLLAMA_URL;
  });

  test("config schema rejects unknown keys", async () => {
    const { default: memoryRedisPlugin } = await import("./index.js");

    expect(() => {
      memoryRedisPlugin.configSchema?.parse?.({
        redis: {
          url: REDIS_URL,
          unknownKey: "value",
        },
        embedding: {
          provider: "openai",
          apiKey: OPENAI_API_KEY,
        },
      });
    }).toThrow("redis config has unknown keys: unknownKey");
  });

  test("config schema rejects invalid provider", async () => {
    const { default: memoryRedisPlugin } = await import("./index.js");

    expect(() => {
      memoryRedisPlugin.configSchema?.parse?.({
        redis: {
          url: REDIS_URL,
        },
        embedding: {
          provider: "invalid-provider",
          apiKey: OPENAI_API_KEY,
        },
      });
    }).toThrow("Invalid embedding provider");
  });
});

describe("config helpers", () => {
  test("getDefaultVectorDim returns sensible default", async () => {
    const { getDefaultVectorDim } = await import("./config.js");

    // Default dimension should be a positive integer
    const dim = getDefaultVectorDim();
    expect(dim).toBeGreaterThan(0);
    expect(Number.isInteger(dim)).toBe(true);
  });

  test("EmbeddingProviderType has expected types", async () => {
    const { redisMemoryConfigSchema } = await import("./config.js");

    // Verify valid providers are accepted
    const validProviders = ["openai", "gemini", "local", "auto"];
    for (const provider of validProviders) {
      const config =
        provider === "openai" || provider === "gemini"
          ? {
              redis: { url: "redis://localhost" },
              embedding: { provider, apiKey: "test-key" },
            }
          : { redis: { url: "redis://localhost" }, embedding: { provider } };

      expect(() => redisMemoryConfigSchema.parse(config)).not.toThrow();
    }
  });
});

describe("capture filtering", () => {
  // These test the shouldCapture logic indirectly via the patterns

  const MEMORY_TRIGGERS = [
    /zapamatuj si|pamatuj|remember/i,
    /preferuji|radši|nechci|prefer/i,
    /rozhodli jsme|budeme používat/i,
    /\+\d{10,}/,
    /[\w.-]+@[\w.-]+\.\w+/,
    /můj\s+\w+\s+je|je\s+můj/i,
    /my\s+\w+\s+is|is\s+my/i,
    /i (like|prefer|hate|love|want|need)/i,
    /always|never|important/i,
  ];

  function matchesTrigger(text: string): boolean {
    return MEMORY_TRIGGERS.some((r) => r.test(text));
  }

  test("triggers match preference statements", () => {
    expect(matchesTrigger("I prefer dark mode")).toBe(true);
    expect(matchesTrigger("I like TypeScript")).toBe(true);
    expect(matchesTrigger("I hate bugs")).toBe(true);
  });

  test("triggers match remember requests", () => {
    expect(matchesTrigger("Remember that my name is John")).toBe(true);
    expect(matchesTrigger("Zapamatuj si moje jméno")).toBe(true);
  });

  test("triggers match contact info", () => {
    expect(matchesTrigger("My email is test@example.com")).toBe(true);
    expect(matchesTrigger("Call me at +12025551234")).toBe(true);
  });

  test("triggers match important statements", () => {
    expect(matchesTrigger("This is always important")).toBe(true);
    expect(matchesTrigger("Never forget this")).toBe(true);
  });

  test("triggers do not match generic text", () => {
    expect(matchesTrigger("Hello world")).toBe(false);
    expect(matchesTrigger("What time is it?")).toBe(false);
  });
});

describeLive("memory-redis live tests", () => {
  // These tests require a real Redis Stack instance and an embedding provider
  // Run with: LIVE=1 REDIS_URL=redis://localhost:6379 pnpm test extensions/memory-redis
  // For Ollama: EMBEDDING_PROVIDER=openai EMBEDDING_API_KEY=ollama EMBEDDING_MODEL=nomic-embed-text EMBEDDING_BASE_URL=http://host:11434/v1

  // Build config from env vars
  const testConfig = {
    redis: { url: REDIS_URL },
    embedding: {
      provider: (process.env.EMBEDDING_PROVIDER ?? "openai") as "openai" | "gemini" | "local" | "auto",
      apiKey: process.env.EMBEDDING_API_KEY ?? OPENAI_API_KEY,
      model: process.env.EMBEDDING_MODEL,
      baseUrl: process.env.EMBEDDING_BASE_URL,
    },
    // Use unique prefix to avoid collisions with other tests
    keyPrefix: `openclaw:memory:test:${Date.now()}`,
    indexName: `idx:openclaw:memories:test:${Date.now()}`,
  };

  // Mock config for embedding provider
  const mockConfig = {
    get: (key: string) => {
      if (key === "anthropic.apiKey") return process.env.ANTHROPIC_API_KEY;
      if (key === "openai.apiKey") return process.env.OPENAI_API_KEY ?? OPENAI_API_KEY;
      if (key === "gemini.apiKey") return process.env.GEMINI_API_KEY;
      return undefined;
    },
  };

  const logger = {
    info: (msg: string) => console.log(`[test] ${msg}`),
    warn: (msg: string) => console.warn(`[test] ${msg}`),
  };

  test("stores and retrieves memories with vector similarity", async () => {
    const { RedisMemoryDB, Embeddings } = await import("./index.js");

    // Initialize embeddings
    let vectorDim = 1536; // Default, will be updated
    const embeddings = new Embeddings(
      testConfig,
      mockConfig,
      logger,
      (dim) => { vectorDim = dim; },
    );

    // Initialize the first embedding to get the dimension
    const testVector = await embeddings.embed("test initialization");
    console.log(`[test] Vector dimension: ${vectorDim}`);

    // Create Redis DB with the detected dimension
    const db = new RedisMemoryDB(
      testConfig.redis.url,
      undefined, // password
      undefined, // tls
      vectorDim,
      testConfig.indexName,
      testConfig.keyPrefix,
      logger,
    );

    try {
      // Store a memory
      const entry = await db.store({
        text: "The user's favorite color is blue",
        vector: await embeddings.embed("The user's favorite color is blue"),
        importance: 0.8,
        category: "preference",
      });
      expect(entry.id).toBeDefined();
      console.log(`[test] Stored memory: ${entry.id}`);

      // Search for it
      const queryVector = await embeddings.embed("what color does the user like");
      const results = await db.search(queryVector, 5, 0.1);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.text).toContain("blue");
      console.log(`[test] Search result: ${results[0].entry.text} (score: ${results[0].score.toFixed(2)})`);
    } finally {
      await db.disconnect();
    }
  });

  test("searches multiple memories with semantic similarity", async () => {
    const { RedisMemoryDB, Embeddings } = await import("./index.js");

    let vectorDim = 1536;
    const embeddings = new Embeddings(
      testConfig,
      mockConfig,
      logger,
      (dim) => { vectorDim = dim; },
    );

    await embeddings.embed("init");

    const db = new RedisMemoryDB(
      testConfig.redis.url,
      undefined,
      undefined,
      vectorDim,
      testConfig.indexName + "_multi",
      testConfig.keyPrefix + ":multi",
      logger,
    );

    try {
      // Store multiple memories
      await db.store({
        text: "User prefers dark mode theme",
        vector: await embeddings.embed("User prefers dark mode theme"),
        importance: 0.7,
        category: "preference",
      });
      await db.store({
        text: "User lives in New York City",
        vector: await embeddings.embed("User lives in New York City"),
        importance: 0.6,
        category: "fact",
      });
      await db.store({
        text: "User's email is test@example.com",
        vector: await embeddings.embed("User's email is test@example.com"),
        importance: 0.9,
        category: "contact",
      });

      // Search for theme preference - should find dark mode
      const themeVector = await embeddings.embed("theme settings");
      const themeResults = await db.search(themeVector, 3, 0.1);
      expect(themeResults.length).toBeGreaterThan(0);
      const themeMatch = themeResults.find((r) => r.entry.text.includes("dark mode"));
      expect(themeMatch).toBeDefined();
      console.log(`[test] Theme search found: ${themeMatch?.entry.text}`);

      // Search for location - should find NYC
      const locationVector = await embeddings.embed("where does user live");
      const locationResults = await db.search(locationVector, 3, 0.1);
      expect(locationResults.length).toBeGreaterThan(0);
      const locationMatch = locationResults.find((r) => r.entry.text.includes("New York"));
      expect(locationMatch).toBeDefined();
      console.log(`[test] Location search found: ${locationMatch?.entry.text}`);
    } finally {
      await db.disconnect();
    }
  });

  test("deletes memories", async () => {
    const { RedisMemoryDB, Embeddings } = await import("./index.js");

    let vectorDim = 1536;
    const embeddings = new Embeddings(
      testConfig,
      mockConfig,
      logger,
      (dim) => { vectorDim = dim; },
    );

    await embeddings.embed("init");

    const db = new RedisMemoryDB(
      testConfig.redis.url,
      undefined,
      undefined,
      vectorDim,
      testConfig.indexName + "_delete",
      testConfig.keyPrefix + ":delete",
      logger,
    );

    try {
      // Store a memory
      const entry = await db.store({
        text: "Secret: the password is hunter2",
        vector: await embeddings.embed("Secret: the password is hunter2"),
        importance: 0.5,
        category: "other",
      });

      // Verify it exists
      const beforeVector = await embeddings.embed("password secret");
      const beforeResults = await db.search(beforeVector, 5, 0.1);
      expect(beforeResults.some((r) => r.entry.text.includes("hunter2"))).toBe(true);

      // Delete it
      const deleted = await db.delete(entry.id);
      expect(deleted).toBe(true);
      console.log(`[test] Deleted memory: ${entry.id}`);

      // Verify it's gone
      const afterResults = await db.search(beforeVector, 5, 0.1);
      expect(afterResults.some((r) => r.entry.text.includes("hunter2"))).toBe(false);
    } finally {
      await db.disconnect();
    }
  });

  test("handles different categories", async () => {
    const { RedisMemoryDB, Embeddings } = await import("./index.js");

    let vectorDim = 1536;
    const embeddings = new Embeddings(
      testConfig,
      mockConfig,
      logger,
      (dim) => { vectorDim = dim; },
    );

    await embeddings.embed("init");

    const db = new RedisMemoryDB(
      testConfig.redis.url,
      undefined,
      undefined,
      vectorDim,
      testConfig.indexName + "_categories",
      testConfig.keyPrefix + ":categories",
      logger,
    );

    try {
      // Store memories in different categories
      await db.store({
        text: "User prefers TypeScript over JavaScript",
        vector: await embeddings.embed("User prefers TypeScript over JavaScript"),
        importance: 0.8,
        category: "preference",
      });
      await db.store({
        text: "Meeting scheduled for Friday at 2pm",
        vector: await embeddings.embed("Meeting scheduled for Friday at 2pm"),
        importance: 0.7,
        category: "event",
      });
      await db.store({
        text: "Project deadline is next Monday",
        vector: await embeddings.embed("Project deadline is next Monday"),
        importance: 0.9,
        category: "task",
      });

      const count = await db.count();
      expect(count).toBe(3);
      console.log(`[test] Stored ${count} memories in different categories`);

      // Search for programming preference
      const prefVector = await embeddings.embed("programming language preference");
      const prefResults = await db.search(prefVector, 5, 0.1);
      const tsMatch = prefResults.find((r) => r.entry.text.includes("TypeScript"));
      expect(tsMatch).toBeDefined();
      expect(tsMatch?.entry.category).toBe("preference");
    } finally {
      await db.disconnect();
    }
  });
});
