import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMemoryEmbeddingProviders as clearRegistry,
  listMemoryEmbeddingProviders as listRegisteredAdapters,
  registerMemoryEmbeddingProvider as registerAdapter,
} from "../../../../src/plugins/memory-embedding-providers.js";
import "./test-runtime-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import {
  DEFAULT_LOCAL_MODEL,
  registerBuiltInMemoryEmbeddingProviders,
} from "./provider-adapters.js";

let embedBatchCalls = 0;
let embedBatchInputCalls = 0;
let embedBatchActive = 0;
let embedBatchMaxActive = 0;
let embedBatchDelayMs = 0;
let batchEmbedCalls = 0;
let batchEmbedActive = 0;
let batchEmbedMaxActive = 0;
let batchEmbedDelayMs = 0;
let enableBatchRuntime = false;
let providerCalls: Array<{ provider?: string; model?: string; outputDimensionality?: number }> = [];
let forceNoProvider = false;

vi.mock("./embeddings.js", () => {
  const embedText = (text: string) => {
    const lower = text.toLowerCase();
    const alpha = lower.split("alpha").length - 1;
    const beta = lower.split("beta").length - 1;
    const image = lower.split("image").length - 1;
    const audio = lower.split("audio").length - 1;
    return [alpha, beta, image, audio];
  };
  const wait = async (delayMs: number) => {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  };
  return {
    createEmbeddingProvider: async (options: {
      provider?: string;
      model?: string;
      outputDimensionality?: number;
    }) => {
      providerCalls.push({
        provider: options.provider,
        model: options.model,
        outputDimensionality: options.outputDimensionality,
      });
      if (forceNoProvider) {
        return {
          provider: null,
          requestedProvider: options.provider ?? "auto",
          providerUnavailableReason: "No API key found for provider",
        };
      }
      const providerId = options.provider === "gemini" ? "gemini" : "mock";
      const model = options.model ?? "mock-embed";
      return {
        requestedProvider: options.provider ?? "openai",
        provider: {
          id: providerId,
          model,
          embedQuery: async (text: string) => embedText(text),
          embedBatch: async (texts: string[]) => {
            embedBatchCalls += 1;
            embedBatchActive += 1;
            embedBatchMaxActive = Math.max(embedBatchMaxActive, embedBatchActive);
            try {
              await wait(embedBatchDelayMs);
              return texts.map(embedText);
            } finally {
              embedBatchActive -= 1;
            }
          },
          ...(providerId === "gemini"
            ? {
                embedBatchInputs: async (
                  inputs: Array<{
                    text: string;
                    parts?: Array<
                      | { type: "text"; text: string }
                      | { type: "inline-data"; mimeType: string; data: string }
                    >;
                  }>,
                ) => {
                  embedBatchInputCalls += 1;
                  return inputs.map((input) => {
                    const inlineData = input.parts?.find((part) => part.type === "inline-data");
                    if (inlineData?.type === "inline-data" && inlineData.data.length > 9000) {
                      throw new Error("payload too large");
                    }
                    const mimeType =
                      inlineData?.type === "inline-data" ? inlineData.mimeType : undefined;
                    if (mimeType?.startsWith("image/")) {
                      return [0, 0, 1, 0];
                    }
                    if (mimeType?.startsWith("audio/")) {
                      return [0, 0, 0, 1];
                    }
                    return embedText(input.text);
                  });
                },
              }
            : {}),
        },
        ...(enableBatchRuntime
          ? {
              runtime: {
                id: providerId,
                cacheKeyData: { provider: providerId, model },
                batchEmbed: async (batch: { chunks: Array<{ text: string }> }) => {
                  batchEmbedCalls += 1;
                  batchEmbedActive += 1;
                  batchEmbedMaxActive = Math.max(batchEmbedMaxActive, batchEmbedActive);
                  try {
                    await wait(batchEmbedDelayMs);
                    return batch.chunks.map((chunk) => embedText(chunk.text));
                  } finally {
                    batchEmbedActive -= 1;
                  }
                },
              },
            }
          : providerId === "gemini"
            ? {
                runtime: {
                  id: "gemini",
                  cacheKeyData: {
                    provider: "gemini",
                    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                    model,
                    outputDimensionality: options.outputDimensionality,
                    headers: [],
                  },
                },
              }
            : {}),
      };
    },
  };
});

describe("memory index", () => {
  it("registers the builtin local embedding provider", () => {
    const adapter = listRegisteredAdapters().find((entry) => entry.id === "local");

    expect(adapter).toBeDefined();
    expect(adapter).toEqual(
      expect.objectContaining({
        id: "local",
        defaultModel: DEFAULT_LOCAL_MODEL,
      }),
    );
  });

  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";
  let indexVectorPath = "";
  let indexMainPath = "";
  let indexMultimodalPath = "";

  const managersForCleanup = new Set<MemoryIndexManager>();

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fixtures-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    indexMainPath = path.join(workspaceDir, "index-main.sqlite");
    indexVectorPath = path.join(workspaceDir, "index-vector.sqlite");
    indexMultimodalPath = path.join(workspaceDir, "index-multimodal.sqlite");
  });

  afterAll(async () => {
    await Promise.all(Array.from(managersForCleanup).map((manager) => manager.close()));
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await closeAllMemorySearchManagers();
    clearRegistry();
    managersForCleanup.clear();
  });

  beforeEach(async () => {
    // Perf: most suites don't need atomic swap behavior for full reindexes.
    // Keep atomic reindex tests on the safe path.
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "1");
    clearRegistry();
    registerBuiltInMemoryEmbeddingProviders({ registerMemoryEmbeddingProvider: registerAdapter });
    embedBatchCalls = 0;
    embedBatchInputCalls = 0;
    embedBatchActive = 0;
    embedBatchMaxActive = 0;
    embedBatchDelayMs = 0;
    batchEmbedCalls = 0;
    batchEmbedActive = 0;
    batchEmbedMaxActive = 0;
    batchEmbedDelayMs = 0;
    enableBatchRuntime = false;
    providerCalls = [];
    forceNoProvider = false;

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
  });

  function resetManagerForTest(manager: MemoryIndexManager) {
    // These tests reuse managers for performance. Clear the index + embedding
    // cache to keep each test fully isolated.
    const db = (
      manager as unknown as {
        db: {
          exec: (sql: string) => void;
          prepare: (sql: string) => { get: (name: string) => { name?: string } | undefined };
        };
      }
    ).db;
    (manager as unknown as { resetIndex: () => void }).resetIndex();
    const embeddingCacheTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("embedding_cache");
    if (embeddingCacheTable?.name === "embedding_cache") {
      db.exec("DELETE FROM embedding_cache");
    }
    (manager as unknown as { dirty: boolean }).dirty = true;
    (manager as unknown as { sessionsDirty: boolean }).sessionsDirty = false;
  }

  type TestCfg = Parameters<typeof getMemorySearchManager>[0]["cfg"];

  function createCfg(params: {
    storePath: string;
    extraPaths?: string[];
    sources?: Array<"memory" | "sessions">;
    sessionMemory?: boolean;
    provider?: "openai" | "gemini";
    model?: string;
    outputDimensionality?: number;
    multimodal?: {
      enabled?: boolean;
      modalities?: Array<"image" | "audio" | "all">;
      maxFileBytes?: number;
    };
    vectorEnabled?: boolean;
    cacheEnabled?: boolean;
    minScore?: number;
    onSearch?: boolean;
    remote?: {
      concurrency?: number;
      batch?: { enabled?: boolean; concurrency?: number };
    };
    hybrid?: { enabled: boolean; vectorWeight?: number; textWeight?: number };
  }): TestCfg {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: params.provider ?? "openai",
            model: params.model ?? "mock-embed",
            outputDimensionality: params.outputDimensionality,
            store: { path: params.storePath, vector: { enabled: params.vectorEnabled ?? false } },
            // Perf: keep test indexes to a single chunk to reduce sqlite work.
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: params.onSearch ?? true },
            query: {
              minScore: params.minScore ?? 0,
              hybrid: params.hybrid ?? { enabled: false },
            },
            remote: params.remote,
            cache: params.cacheEnabled ? { enabled: true } : undefined,
            extraPaths: params.extraPaths,
            multimodal: params.multimodal,
            sources: params.sources,
            experimental: { sessionMemory: params.sessionMemory ?? false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  function requireManager(
    result: Awaited<ReturnType<typeof getMemorySearchManager>>,
    missingMessage = "manager missing",
  ): MemoryIndexManager {
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error(missingMessage);
    }
    return result.manager as MemoryIndexManager;
  }

  async function getPersistentManager(cfg: TestCfg): Promise<MemoryIndexManager> {
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    return manager;
  }

  async function getFreshManager(cfg: TestCfg): Promise<MemoryIndexManager> {
    const { getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js");
    return await getRequiredMemoryIndexManager({ cfg, agentId: "main" });
  }

  async function expectHybridKeywordSearchFindsMemory(cfg: TestCfg) {
    const manager = await getFreshManager(cfg);
    try {
      const status = manager.status();
      if (!status.fts?.available) {
        return;
      }

      await manager.sync({ reason: "test" });
      const results = await manager.search("zebra");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toContain("memory/2026-01-12.md");
    } finally {
      await manager.close?.();
    }
  }

  async function getFtsSessionManager(params: {
    stateDirName: string;
    storeFileName: string;
  }): Promise<MemoryIndexManager | null> {
    forceNoProvider = true;
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, params.stateDirName));
    const cfg = createCfg({
      storePath: path.join(workspaceDir, params.storeFileName),
      sources: ["memory", "sessions"],
      sessionMemory: true,
      minScore: 0,
      hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    return manager.status().fts?.available ? manager : null;
  }

  it.skip("indexes memory files and searches", async () => {
    const cfg = createCfg({
      storePath: indexMainPath,
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test" });
      const results = await manager.search("alpha");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toContain("memory/2026-01-12.md");
      const status = manager.status();
      expect(status.sourceCounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "memory",
            files: status.files,
            chunks: status.chunks,
          }),
        ]),
      );
    } finally {
      await manager.close?.();
    }
  });

  it("indexes multimodal image and audio files from extra paths with Gemini structured inputs", async () => {
    const mediaDir = path.join(workspaceDir, "media-memory");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(path.join(mediaDir, "diagram.png"), Buffer.from("png"));
    await fs.writeFile(path.join(mediaDir, "meeting.wav"), Buffer.from("wav"));

    const cfg = createCfg({
      storePath: indexMultimodalPath,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      extraPaths: [mediaDir],
      multimodal: { enabled: true, modalities: ["image", "audio"] },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    expect(embedBatchInputCalls).toBeGreaterThan(0);

    const imageResults = await manager.search("image");
    expect(imageResults.some((result) => result.path.endsWith("diagram.png"))).toBe(true);

    const audioResults = await manager.search("audio");
    expect(audioResults.some((result) => result.path.endsWith("meeting.wav"))).toBe(true);
  });

  it.skip("finds keyword matches via hybrid search when query embedding is zero", async () => {
    await expectHybridKeywordSearchFindsMemory(
      createCfg({
        storePath: indexMainPath,
        hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
      }),
    );
  });

  it.skip("preserves keyword-only hybrid hits when minScore exceeds text weight", async () => {
    await expectHybridKeywordSearchFindsMemory(
      createCfg({
        storePath: indexMainPath,
        minScore: 0.35,
        hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
      }),
    );
  });

  it("reports vector availability after probe", async () => {
    const cfg = createCfg({ storePath: indexVectorPath, vectorEnabled: true });
    const manager = await getPersistentManager(cfg);
    const available = await manager.probeVectorAvailability();
    const status = manager.status();
    expect(status.vector?.enabled).toBe(true);
    expect(typeof status.vector?.available).toBe("boolean");
    expect(status.vector?.available).toBe(available);
  });

  it("uses configured remote concurrency for non-batch indexing", async () => {
    embedBatchDelayMs = 20;
    await Promise.all(
      [13, 14, 15, 16].map(async (day) => {
        await fs.writeFile(
          path.join(memoryDir, `2026-01-${day}.md`),
          `# Log\nAlpha remote concurrency ${day}.`,
        );
      }),
    );
    const cfg = createCfg({
      storePath: path.join(workspaceDir, "index-remote-concurrency.sqlite"),
      remote: { concurrency: 2 },
    });
    const manager = await getPersistentManager(cfg);

    await manager.sync({ reason: "test", force: true });

    expect(embedBatchMaxActive).toBe(2);
    expect(batchEmbedCalls).toBe(0);
  });

  it("uses batch concurrency for batch indexing independently of remote concurrency", async () => {
    enableBatchRuntime = true;
    batchEmbedDelayMs = 20;
    await Promise.all(
      [13, 14, 15, 16, 17].map(async (day) => {
        await fs.writeFile(
          path.join(memoryDir, `2026-01-${day}.md`),
          `# Log\nAlpha batch concurrency ${day}.`,
        );
      }),
    );
    const cfg = createCfg({
      storePath: path.join(workspaceDir, "index-batch-concurrency.sqlite"),
      remote: { concurrency: 1, batch: { enabled: true, concurrency: 3 } },
    });
    const manager = await getPersistentManager(cfg);

    await manager.sync({ reason: "test", force: true });

    expect(batchEmbedMaxActive).toBe(3);
    expect(embedBatchCalls).toBe(0);
  });

  it("builds FTS index and returns search results when no embedding provider is available", async () => {
    forceNoProvider = true;

    const cfg = createCfg({
      storePath: path.join(workspaceDir, "index-fts-only.sqlite"),
      minScore: 0.35,
      hybrid: { enabled: true },
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    if (!manager.status().fts?.available) {
      return;
    }

    await fs.writeFile(
      path.join(memoryDir, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
    await manager.sync({ reason: "test" });

    const status = manager.status();
    expect(status.chunks).toBeGreaterThan(0);
    expect(embedBatchCalls).toBe(0);

    const results = await manager.search("Alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toMatch(/Alpha/i);

    const noResults = await manager.search("nonexistent_xyz_keyword");
    expect(noResults.length).toBe(0);
  });

  it("prefers exact session transcript hits in FTS-only mode", async () => {
    try {
      const manager = await getFtsSessionManager({
        stateDirName: ".state-session-ranking",
        storeFileName: "index-fts-session-ranking.sqlite",
      });
      if (!manager) {
        return;
      }

      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      await fs.writeFile(memoryPath, "Project Nebula stale codename: ORBIT-9.\n", "utf8");
      const staleAt = new Date("2020-01-01T00:00:00.000Z");
      await fs.utimes(memoryPath, staleAt, staleAt);

      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "session-ranking.jsonl");
      const now = Date.parse("2026-04-07T15:25:04.113Z");
      await fs.writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "session",
            id: "session-ranking",
            timestamp: new Date(now - 60_000).toISOString(),
          }),
          JSON.stringify({
            type: "message",
            message: {
              role: "user",
              timestamp: new Date(now - 30_000).toISOString(),
              content: [{ type: "text", text: "What is the current Project Nebula codename?" }],
            },
          }),
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              timestamp: new Date(now).toISOString(),
              content: [{ type: "text", text: "The current Project Nebula codename is ORBIT-10." }],
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      await manager.sync({ reason: "test", force: true });
      const results = await manager.search("current Project Nebula codename ORBIT-10", {
        minScore: 0,
        maxResults: 3,
      });

      expect(results[0]?.source).toBe("sessions");
      expect(results[0]?.snippet).toContain("ORBIT-10");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bootstraps an empty index on first search so session transcript hits are available", async () => {
    try {
      const manager = await getFtsSessionManager({
        stateDirName: ".state-session-bootstrap",
        storeFileName: "index-fts-session-bootstrap.sqlite",
      });
      if (!manager) {
        return;
      }

      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "session-bootstrap.jsonl");
      await fs.writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "session",
            id: "session-bootstrap",
            timestamp: "2026-04-07T15:24:04.113Z",
          }),
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              timestamp: "2026-04-07T15:25:04.113Z",
              content: [{ type: "text", text: "The current Project Nebula codename is ORBIT-10." }],
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const results = await manager.search("current Project Nebula codename ORBIT-10", {
        minScore: 0,
        maxResults: 3,
      });

      expect(results[0]?.source).toBe("sessions");
      expect(results[0]?.snippet).toContain("ORBIT-10");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
