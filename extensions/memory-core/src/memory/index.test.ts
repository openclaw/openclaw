import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMemoryEmbeddingProviders as clearRegistry,
  registerMemoryEmbeddingProvider as registerAdapter,
} from "../../../../src/plugins/memory-embedding-providers.js";
import "./test-runtime-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { getMemorySearchManager, closeAllMemorySearchManagers } from "./index.js";
import { registerBuiltInMemoryEmbeddingProviders } from "./provider-adapters.js";

let embedBatchCalls = 0;
let embedBatchInputCalls = 0;
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
            return texts.map(embedText);
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
        ...(providerId === "gemini"
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

  it("skips oversized multimodal inputs without aborting sync", async () => {
    const mediaDir = path.join(workspaceDir, "media-oversize");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(path.join(mediaDir, "huge.png"), Buffer.alloc(7000, 1));

    const cfg = createCfg({
      storePath: path.join(workspaceDir, `index-oversize-${randomUUID()}.sqlite`),
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      extraPaths: [mediaDir],
      multimodal: { enabled: true, modalities: ["image"] },
    });
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    await manager.sync({ reason: "test" });

    expect(embedBatchInputCalls).toBeGreaterThan(0);
    const imageResults = await manager.search("image");
    expect(imageResults.some((result) => result.path.endsWith("huge.png"))).toBe(false);

    const alphaResults = await manager.search("alpha");
    expect(alphaResults.some((result) => result.path.endsWith("memory/2026-01-12.md"))).toBe(true);

    await manager.close?.();
  });

  it("reindexes a multimodal file after a transient mid-sync disappearance", async () => {
    const mediaDir = path.join(workspaceDir, "media-race");
    const imagePath = path.join(mediaDir, "diagram.png");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(imagePath, Buffer.from("png"));

    const cfg = createCfg({
      storePath: path.join(workspaceDir, `index-race-${randomUUID()}.sqlite`),
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      extraPaths: [mediaDir],
      multimodal: { enabled: true, modalities: ["image"] },
    });
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    const realReadFile = fs.readFile.bind(fs);
    let imageReads = 0;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const [targetPath] = args;
      if (typeof targetPath === "string" && targetPath === imagePath) {
        imageReads += 1;
        if (imageReads === 2) {
          const err = Object.assign(
            new Error(`ENOENT: no such file or directory, open '${imagePath}'`),
            {
              code: "ENOENT",
            },
          ) as NodeJS.ErrnoException;
          throw err;
        }
      }
      return await realReadFile(...args);
    });

    await manager.sync({ reason: "test" });
    readSpy.mockRestore();

    const callsAfterFirstSync = embedBatchInputCalls;
    (manager as unknown as { dirty: boolean }).dirty = true;
    await manager.sync({ reason: "test" });

    expect(embedBatchInputCalls).toBeGreaterThan(callsAfterFirstSync);
    const results = await manager.search("image");
    expect(results.some((result) => result.path.endsWith("diagram.png"))).toBe(true);

    await manager.close?.();
  });

  it("targets explicit session files during post-compaction sync", async () => {
    const stateDir = path.join(fixtureRoot, `state-targeted-${randomUUID()}`);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const firstSessionPath = path.join(sessionDir, "targeted-first.jsonl");
    const secondSessionPath = path.join(sessionDir, "targeted-second.jsonl");
    const storePath = path.join(workspaceDir, `index-targeted-${randomUUID()}.sqlite`);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      firstSessionPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "first transcript v1" }] },
      })}\n`,
    );
    await fs.writeFile(
      secondSessionPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "second transcript v1" }] },
      })}\n`,
    );

    try {
      const result = await getMemorySearchManager({
        cfg: createCfg({
          storePath,
          sources: ["sessions"],
          sessionMemory: true,
        }),
        agentId: "main",
      });
      const manager = requireManager(result);
      await manager.sync?.({ reason: "test" });

      const db = (
        manager as unknown as {
          db: {
            prepare: (sql: string) => {
              get: (path: string, source: string) => { hash: string } | undefined;
              all?: (...args: unknown[]) => unknown;
            };
          };
        }
      ).db;
      const getSessionHash = (sessionPath: string) =>
        db
          .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
          .get(sessionPath, "sessions")?.hash;

      const firstOriginalHash = getSessionHash("sessions/targeted-first.jsonl");
      const secondOriginalHash = getSessionHash("sessions/targeted-second.jsonl");

      await fs.writeFile(
        firstSessionPath,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "first transcript v2 after compaction" }],
          },
        })}\n`,
      );
      await fs.writeFile(
        secondSessionPath,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "second transcript v2 should stay untouched" }],
          },
        })}\n`,
      );

      await manager.sync?.({
        reason: "post-compaction",
        sessionFiles: [firstSessionPath],
      });

      expect(getSessionHash("sessions/targeted-first.jsonl")).not.toBe(firstOriginalHash);
      expect(getSessionHash("sessions/targeted-second.jsonl")).toBe(secondOriginalHash);
      await manager.close?.();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes Gemini outputDimensionality from config into the provider", async () => {
    const cfg = createCfg({
      storePath: indexMainPath,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      outputDimensionality: 1536,
    });

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    await manager.probeEmbeddingAvailability();

    expect(
      providerCalls.some(
        (call) =>
          call.provider === "gemini" &&
          call.model === "gemini-embedding-2-preview" &&
          call.outputDimensionality === 1536,
      ),
    ).toBe(true);
    await manager.close?.();
  });

  it("does not initialize the provider when searching an empty index", async () => {
    const cfg = createCfg({
      storePath: path.join(workspaceDir, `index-empty-${randomUUID()}.sqlite`),
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      outputDimensionality: 1536,
      onSearch: false,
    });

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);

    const results = await manager.search("hello");

    expect(results).toEqual([]);
    expect(providerCalls).toEqual([]);
    await manager.close?.();
  });

  it("reuses cached embeddings on forced reindex", async () => {
    const cfg = createCfg({ storePath: indexMainPath, cacheEnabled: true });
    const manager = await getPersistentManager(cfg);
    // Seed the embedding cache once, then ensure a forced reindex doesn't
    // re-embed when the cache is enabled.
    await manager.sync({ reason: "test" });
    const afterFirst = embedBatchCalls;
    expect(afterFirst).toBeGreaterThan(0);

    await manager.sync({ force: true });
    expect(embedBatchCalls).toBe(afterFirst);
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

  it("triggers full reindex and cleans up old-model FTS rows when switching from provider to FTS-only", async () => {
    const sharedStorePath = path.join(workspaceDir, "index-provider-to-fts-only.sqlite");

    const providerCfg = createCfg({ storePath: sharedStorePath, hybrid: { enabled: true } });
    const providerResult = await getMemorySearchManager({ cfg: providerCfg, agentId: "main" });
    const providerManager = requireManager(providerResult);
    managersForCleanup.add(providerManager);
    resetManagerForTest(providerManager);

    await providerManager.sync({ reason: "test" });

    const providerDb = (
      providerManager as unknown as { db: { prepare: (s: string) => { get: () => { c: number } } } }
    ).db;
    const providerFtsRows = providerDb
      .prepare("SELECT COUNT(*) as c FROM chunks_fts WHERE model = 'mock-embed'")
      .get();
    expect(providerFtsRows.c).toBeGreaterThan(0);

    await providerManager.close();
    managersForCleanup.delete(providerManager);

    forceNoProvider = true;
    const ftsOnlyCfg = createCfg({ storePath: sharedStorePath, hybrid: { enabled: true } });
    const ftsOnlyResult = await getMemorySearchManager({ cfg: ftsOnlyCfg, agentId: "main" });
    const ftsOnlyManager = requireManager(ftsOnlyResult);
    managersForCleanup.add(ftsOnlyManager);

    await ftsOnlyManager.sync({ reason: "test" });

    const db = (
      ftsOnlyManager as unknown as { db: { prepare: (s: string) => { get: () => { c: number } } } }
    ).db;
    const oldRows = db
      .prepare("SELECT COUNT(*) as c FROM chunks_fts WHERE model = 'mock-embed'")
      .get();
    expect(oldRows.c).toBe(0);

    const newRows = db
      .prepare("SELECT COUNT(*) as c FROM chunks_fts WHERE model = 'fts-only'")
      .get();
    expect(newRows.c).toBeGreaterThan(0);
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
});
