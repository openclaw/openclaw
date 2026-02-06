/**
 * Memory Plugin E2E Tests
 *
 * Tests the memory plugin functionality including:
 * - Plugin registration and configuration
 * - Memory storage and retrieval
 * - Auto-recall via hooks
 * - Auto-capture filtering
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { detectProvider, vectorDimsForModel } from "./config.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-key";
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const liveEnabled = HAS_OPENAI_KEY && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

describe("memory plugin e2e", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-test-"));
    dbPath = path.join(tmpDir, "lancedb");
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("memory plugin registers and initializes correctly", async () => {
    // Dynamic import to avoid loading LanceDB when not testing
    const { default: memoryPlugin } = await import("./index.js");

    expect(memoryPlugin.id).toBe("memory-lancedb");
    expect(memoryPlugin.name).toBe("Memory (LanceDB)");
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
      dbPath,
      autoCapture: true,
      autoRecall: true,
    });

    expect(config).toBeDefined();
    expect(config?.embedding?.apiKey).toBe(OPENAI_API_KEY);
    expect(config?.dbPath).toBe(dbPath);
  });

  test("config schema resolves env vars", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    // Set a test env var
    process.env.TEST_MEMORY_API_KEY = "test-key-123";

    const config = memoryPlugin.configSchema?.parse?.({
      embedding: {
        apiKey: "${TEST_MEMORY_API_KEY}",
      },
      dbPath,
    });

    expect(config?.embedding?.apiKey).toBe("test-key-123");

    delete process.env.TEST_MEMORY_API_KEY;
  });

  test("config schema rejects missing apiKey", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    expect(() => {
      memoryPlugin.configSchema?.parse?.({
        embedding: {},
        dbPath,
      });
    }).toThrow("embedding.apiKey is required");
  });

  test("shouldCapture applies real capture rules", async () => {
    const { shouldCapture } = await import("./index.js");

    expect(shouldCapture("I prefer dark mode")).toBe(true);
    expect(shouldCapture("Remember that my name is John")).toBe(true);
    expect(shouldCapture("My email is test@example.com")).toBe(true);
    expect(shouldCapture("Call me at +1234567890123")).toBe(true);
    expect(shouldCapture("I always want verbose output")).toBe(true);
    expect(shouldCapture("x")).toBe(false);
    expect(shouldCapture("<relevant-memories>injected</relevant-memories>")).toBe(false);
    expect(shouldCapture("<system>status</system>")).toBe(false);
    expect(shouldCapture("Here is a short **summary**\n- bullet")).toBe(false);
  });

  test("detectCategory classifies using production logic", async () => {
    const { detectCategory } = await import("./index.js");

    expect(detectCategory("I prefer dark mode")).toBe("preference");
    expect(detectCategory("We decided to use React")).toBe("decision");
    expect(detectCategory("My email is test@example.com")).toBe("entity");
    expect(detectCategory("The server is running on port 3000")).toBe("fact");
    expect(detectCategory("Random note")).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// Unit tests for detectProvider and vectorDimsForModel
// ---------------------------------------------------------------------------

describe("detectProvider", () => {
  test("returns explicit provider when set", () => {
    expect(detectProvider({ provider: "local" })).toBe("local");
    expect(detectProvider({ provider: "openai" })).toBe("openai");
  });

  test("detects local from .gguf model", () => {
    expect(detectProvider({ model: "nomic-embed-text-v1.5.f16.gguf" })).toBe("local");
    expect(detectProvider({ model: "~/models/my-model.gguf" })).toBe("local");
  });

  test("detects local from hf: prefix", () => {
    expect(
      detectProvider({
        model: "hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.f16.gguf",
      }),
    ).toBe("local");
  });

  test("detects openai from text-embedding- prefix", () => {
    expect(detectProvider({ model: "text-embedding-3-small" })).toBe("openai");
    expect(detectProvider({ model: "text-embedding-3-large" })).toBe("openai");
  });

  test("defaults to openai with no hints", () => {
    expect(detectProvider({})).toBe("openai");
    expect(detectProvider({ model: "some-unknown-model" })).toBe("openai");
  });
});

describe("vectorDimsForModel", () => {
  test("returns correct dims for OpenAI models", () => {
    expect(vectorDimsForModel("text-embedding-3-small")).toBe(1536);
    expect(vectorDimsForModel("text-embedding-3-large")).toBe(3072);
  });

  test("returns default 768 for local .gguf models", () => {
    expect(vectorDimsForModel("model.gguf")).toBe(768);
    expect(vectorDimsForModel("~/models/nomic.gguf")).toBe(768);
  });

  test("returns default 768 for hf: models", () => {
    expect(
      vectorDimsForModel("hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.f16.gguf"),
    ).toBe(768);
  });

  test("accepts custom localDimensions override", () => {
    expect(vectorDimsForModel("model.gguf", 1024)).toBe(1024);
    expect(vectorDimsForModel("hf:some/model", 384)).toBe(384);
  });

  test("throws for unknown non-local model", () => {
    expect(() => vectorDimsForModel("some-random-model")).toThrow("Unsupported embedding model");
  });
});

// ---------------------------------------------------------------------------
// Config schema tests for local provider
// ---------------------------------------------------------------------------

describe("config schema - local provider", () => {
  const dbPath = "/tmp/test-lancedb";

  test("config schema accepts local provider without apiKey", async () => {
    const { default: memoryPlugin } = await import("./index.js");
    const parsed = memoryPlugin.configSchema?.parse?.({
      embedding: {
        provider: "local",
        model: "nomic-embed-text-v1.5.f16.gguf",
      },
      dbPath,
      local: {
        modelPath: "~/models/nomic-embed.gguf",
      },
    });
    expect(parsed).toBeDefined();
    expect(parsed?.embedding?.provider).toBe("local");
    expect(parsed?.embedding?.apiKey).toBeUndefined();
    expect(parsed?.local?.modelPath).toBe("~/models/nomic-embed.gguf");
  });

  test("config schema auto-detects local from .gguf model", async () => {
    const { default: memoryPlugin } = await import("./index.js");
    const parsed = memoryPlugin.configSchema?.parse?.({
      embedding: {
        model: "my-embedding.gguf",
      },
      dbPath,
    });
    expect(parsed?.embedding?.provider).toBe("local");
  });

  test("config schema still requires apiKey for openai", async () => {
    const { default: memoryPlugin } = await import("./index.js");
    expect(() => {
      memoryPlugin.configSchema?.parse?.({
        embedding: {
          provider: "openai",
        },
        dbPath,
      });
    }).toThrow("embedding.apiKey is required");
  });
});

// ---------------------------------------------------------------------------
// Dimension mismatch detection tests
// ---------------------------------------------------------------------------

describe("dimension mismatch detection", () => {
  let tmpDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dim-test-"));
    testDbPath = path.join(tmpDir, "lancedb");
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("creates table with correct dimensions on fresh DB", async () => {
    const { MemoryDB } = await import("./index.js");
    const db = new MemoryDB(testDbPath, 768);
    // store triggers initialization
    await db.store({
      text: "test",
      vector: Array(768).fill(0.1),
      importance: 0.5,
      category: "fact",
    });
    expect(await db.count()).toBe(1);
  });

  test("opens existing table with matching dimensions", async () => {
    const { MemoryDB } = await import("./index.js");
    // Create with 768 dims
    const db1 = new MemoryDB(testDbPath, 768);
    await db1.store({
      text: "test",
      vector: Array(768).fill(0.1),
      importance: 0.5,
      category: "fact",
    });

    // Reopen with same dims — should succeed
    const db2 = new MemoryDB(testDbPath, 768);
    expect(await db2.count()).toBe(1);
  });

  test("throws DimensionMismatchError when dimensions differ", async () => {
    const { MemoryDB, DimensionMismatchError } = await import("./index.js");
    // Create table with 1536-dim vectors
    const db1 = new MemoryDB(testDbPath, 1536);
    await db1.store({
      text: "test",
      vector: Array(1536).fill(0.1),
      importance: 0.5,
      category: "fact",
    });

    // Try to open with 768-dim config
    const db2 = new MemoryDB(testDbPath, 768);
    await expect(db2.count()).rejects.toThrow(DimensionMismatchError);
    await expect(db2.count()).rejects.toThrow(/dimension mismatch/i);
  });

  test("initializeUnchecked skips dimension validation", async () => {
    const { MemoryDB } = await import("./index.js");
    // Create table with 1536-dim vectors
    const db1 = new MemoryDB(testDbPath, 1536);
    await db1.store({
      text: "test",
      vector: Array(1536).fill(0.1),
      importance: 0.5,
      category: "fact",
    });

    // Open unchecked with different dims — should NOT throw
    const db2 = new MemoryDB(testDbPath, 768);
    await db2.initializeUnchecked();
    const entries = await db2.listAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("test");
  });

  test("recreateTable drops and recreates with new dimensions", async () => {
    const { MemoryDB } = await import("./index.js");
    // Create table with 1536-dim vectors and add data
    const db1 = new MemoryDB(testDbPath, 1536);
    await db1.store({
      text: "old memory",
      vector: Array(1536).fill(0.1),
      importance: 0.5,
      category: "fact",
    });

    // Recreate with 768-dim
    const db2 = new MemoryDB(testDbPath, 768);
    await db2.initializeUnchecked();
    await db2.recreateTable();

    // New table should be empty and accept 768-dim vectors
    expect(await db2.count()).toBe(0);
    await db2.store({
      text: "new memory",
      vector: Array(768).fill(0.2),
      importance: 0.6,
      category: "preference",
    });
    expect(await db2.count()).toBe(1);
  });
});

// Live tests that require OpenAI API key and actually use LanceDB
describeLive("memory plugin live tests", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-live-"));
    dbPath = path.join(tmpDir, "lancedb");
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

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
      id: "memory-lancedb",
      name: "Memory (LanceDB)",
      source: "test",
      config: {},
      pluginConfig: {
        embedding: {
          apiKey: liveApiKey,
          model: "text-embedding-3-small",
        },
        dbPath,
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

    // Test store
    const storeResult = await storeTool.execute("test-call-1", {
      text: "The user prefers dark mode for all applications",
      importance: 0.8,
      category: "preference",
    });

    expect(storeResult.details?.action).toBe("created");
    expect(storeResult.details?.id).toBeDefined();
    const storedId = storeResult.details?.id;

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

    // Verify it's gone
    const recallAfterForget = await recallTool.execute("test-call-5", {
      query: "dark mode preference",
      limit: 5,
    });

    expect(recallAfterForget.details?.count).toBe(0);
  }, 60000); // 60s timeout for live API calls
});
