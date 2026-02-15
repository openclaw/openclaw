/**
 * Memory Plugin (Milvus) E2E Tests
 *
 * Tests the memory plugin functionality including:
 * - Plugin registration and configuration
 * - Memory storage and retrieval via Milvus/Zilliz
 * - Auto-recall via hooks
 * - Auto-capture filtering
 */

import { randomUUID } from "node:crypto";
import { describe, test, expect } from "vitest";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-key";
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const MILVUS_ADDRESS = process.env.MILVUS_ADDRESS ?? process.env.MILVUS_URI ?? "";
const MILVUS_TOKEN = process.env.MILVUS_TOKEN ?? "";
const HAS_MILVUS = Boolean(MILVUS_ADDRESS);
const liveEnabled = HAS_OPENAI_KEY && HAS_MILVUS && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

describe("memory-milvus plugin e2e", () => {
  test("memory plugin registers and initializes correctly", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    expect(memoryPlugin.id).toBe("memory-milvus");
    expect(memoryPlugin.name).toBe("Memory (Milvus)");
    expect(memoryPlugin.kind).toBe("memory");
    expect(memoryPlugin.configSchema).toBeDefined();
    // oxlint-disable-next-line typescript/unbound-method
    expect(memoryPlugin.register).toBeInstanceOf(Function);
  });

  test("config schema parses valid config", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    const config = memoryPlugin.configSchema?.parse?.({
      embedding: {
        apiKey: OPENAI_API_KEY,
        model: "text-embedding-3-small",
      },
      milvus: {
        address: "localhost:19530",
      },
      autoCapture: true,
      autoRecall: true,
    });

    expect(config).toBeDefined();
    expect(config?.embedding?.apiKey).toBe(OPENAI_API_KEY);
    expect(config?.milvus?.address).toBe("localhost:19530");
    expect(config?.milvus?.ssl).toBe(false);
    expect(config?.milvus?.collectionName).toBe("openclaw_memories");
  });

  test("config schema auto-detects SSL from https prefix", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    const config = memoryPlugin.configSchema?.parse?.({
      embedding: {
        apiKey: OPENAI_API_KEY,
      },
      milvus: {
        address: "https://in03-xxx.serverless.gcp-us-west1.cloud.zilliz.com",
        token: "some-token",
      },
    });

    expect(config?.milvus?.ssl).toBe(true);
  });

  test("config schema resolves env vars", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    process.env.TEST_MILVUS_API_KEY = "test-key-123";
    process.env.TEST_MILVUS_TOKEN = "test-token-456";

    const config = memoryPlugin.configSchema?.parse?.({
      embedding: {
        apiKey: "${TEST_MILVUS_API_KEY}",
      },
      milvus: {
        address: "localhost:19530",
        token: "${TEST_MILVUS_TOKEN}",
      },
    });

    expect(config?.embedding?.apiKey).toBe("test-key-123");
    expect(config?.milvus?.token).toBe("test-token-456");

    delete process.env.TEST_MILVUS_API_KEY;
    delete process.env.TEST_MILVUS_TOKEN;
  });

  test("config schema rejects missing apiKey", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    expect(() => {
      memoryPlugin.configSchema?.parse?.({
        embedding: {},
        milvus: { address: "localhost:19530" },
      });
    }).toThrow("embedding.apiKey is required");
  });

  test("config schema rejects missing milvus.address", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    expect(() => {
      memoryPlugin.configSchema?.parse?.({
        embedding: { apiKey: "sk-test" },
        milvus: {},
      });
    }).toThrow("milvus.address is required");
  });

  test("config schema rejects missing milvus section", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    expect(() => {
      memoryPlugin.configSchema?.parse?.({
        embedding: { apiKey: "sk-test" },
      });
    }).toThrow("milvus.address is required");
  });

  test("shouldCapture filters correctly", async () => {
    const { shouldCapture } = await import("./index.js");

    const triggers = [
      { text: "I prefer dark mode", shouldMatch: true },
      { text: "Remember that my name is John", shouldMatch: true },
      { text: "My email is test@example.com", shouldMatch: true },
      { text: "Call me at +1234567890123", shouldMatch: true },
      { text: "We decided to use TypeScript", shouldMatch: false },
      { text: "I always want verbose output", shouldMatch: true },
      { text: "Just a random short message", shouldMatch: false },
      { text: "x", shouldMatch: false },
      { text: "<relevant-memories>injected</relevant-memories>", shouldMatch: false },
      { text: "<system>status update</system>", shouldMatch: false },
      { text: "**Summary**\n- bullet point here with important info", shouldMatch: false },
    ];

    for (const { text, shouldMatch } of triggers) {
      expect(shouldCapture(text)).toBe(shouldMatch);
    }
  });

  test("detectCategory classifies correctly", async () => {
    const { detectCategory } = await import("./index.js");

    const cases = [
      { text: "I prefer dark mode", expected: "preference" },
      { text: "We decided to use React", expected: "decision" },
      { text: "My email is test@example.com", expected: "entity" },
      { text: "The server is running on port 3000", expected: "fact" },
      { text: "Random note about nothing", expected: "other" },
    ];

    for (const { text, expected } of cases) {
      expect(detectCategory(text)).toBe(expected);
    }
  });
});

// Live tests that require OpenAI API key and Milvus/Zilliz credentials
describeLive("memory-milvus plugin live tests", () => {
  // Use a unique collection name per test run to avoid conflicts
  const testCollectionName = `test_memories_${randomUUID().slice(0, 8)}`;

  test("memory tools work end-to-end", async () => {
    const { default: memoryPlugin } = await import("./index.js");
    const liveApiKey = process.env.OPENAI_API_KEY ?? "";

    // Mock plugin API
    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredTools: any[] = [];
    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredClis: any[] = [];
    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredServices: any[] = [];
    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredHooks: Record<string, any[]> = {};
    const logs: string[] = [];

    const mockApi = {
      id: "memory-milvus",
      name: "Memory (Milvus)",
      source: "test",
      config: {},
      pluginConfig: {
        embedding: {
          apiKey: liveApiKey,
          model: "text-embedding-3-small",
        },
        milvus: {
          address: MILVUS_ADDRESS,
          token: MILVUS_TOKEN || undefined,
          collectionName: testCollectionName,
        },
        autoCapture: false,
        autoRecall: false,
      },
      runtime: {},
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
        error: (msg: string) => logs.push(`[error] ${msg}`),
        debug: (msg: string) => logs.push(`[debug] ${msg}`),
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerTool: (tool: any, opts: any) => {
        registeredTools.push({ tool, opts });
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerCli: (registrar: any, opts: any) => {
        registeredClis.push({ registrar, opts });
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerService: (service: any) => {
        registeredServices.push(service);
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      on: (hookName: string, handler: any) => {
        if (!registeredHooks[hookName]) {
          registeredHooks[hookName] = [];
        }
        registeredHooks[hookName].push(handler);
      },
      resolvePath: (p: string) => p,
    };

    // Register plugin
    // oxlint-disable-next-line typescript/no-explicit-any
    memoryPlugin.register(mockApi as any);

    // Check registration
    expect(registeredTools.length).toBe(3);
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_recall");
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_store");
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_forget");
    expect(registeredClis.length).toBe(1);
    expect(registeredServices.length).toBe(1);

    // Get tool functions
    const storeTool = registeredTools.find((t) => t.opts?.name === "memory_store")?.tool;
    const recallTool = registeredTools.find((t) => t.opts?.name === "memory_recall")?.tool;
    const forgetTool = registeredTools.find((t) => t.opts?.name === "memory_forget")?.tool;

    try {
      // Test store
      const storeResult = await storeTool.execute("test-call-1", {
        text: "The user prefers dark mode for all applications",
        importance: 0.8,
        category: "preference",
      });

      expect(storeResult.details?.action).toBe("created");
      expect(storeResult.details?.id).toBeDefined();
      const storedId = storeResult.details?.id;

      // Wait briefly for Milvus indexing (eventual consistency)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Test recall
      const recallResult = await recallTool.execute("test-call-2", {
        query: "dark mode preference",
        limit: 5,
      });

      expect(recallResult.details?.count).toBeGreaterThan(0);
      expect(recallResult.details?.memories?.[0]?.text).toContain("dark mode");

      // Test duplicate detection
      const duplicateResult = await storeTool.execute("test-call-3", {
        text: "The user prefers dark mode for all applications",
      });

      expect(duplicateResult.details?.action).toBe("duplicate");

      // Test forget
      const forgetResult = await forgetTool.execute("test-call-4", {
        memoryId: storedId,
      });

      expect(forgetResult.details?.action).toBe("deleted");

      // Wait for deletion to propagate
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Verify it's gone
      const recallAfterForget = await recallTool.execute("test-call-5", {
        query: "dark mode preference",
        limit: 5,
      });

      expect(recallAfterForget.details?.count).toBe(0);
    } finally {
      // Clean up: drop the test collection
      try {
        const { MilvusClient } = await import("@zilliz/milvus2-sdk-node");
        const client = new MilvusClient({
          address: MILVUS_ADDRESS,
          token: MILVUS_TOKEN || undefined,
          ssl: MILVUS_ADDRESS.startsWith("https"),
        });
        await client.dropCollection({ collection_name: testCollectionName });
      } catch {
        // best-effort cleanup
      }
    }
  }, 120000); // 120s timeout for live API calls + Milvus operations
});
