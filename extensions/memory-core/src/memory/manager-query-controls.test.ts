import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  MemorySearchConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEmbedQueryMock, resetEmbeddingMocks } from "./embedding.test-mocks.js";
import type { MemoryIndexManager } from "./manager.js";
import { getRequiredMemoryIndexManager } from "./test-manager-helpers.js";

describe("memory manager query reliability controls", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-query-controls-"));
  });

  beforeEach(async () => {
    resetEmbeddingMocks();
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "Alpha project marker\n\nKeep the memory query reliability note.",
    );
    indexPath = path.join(workspaceDir, "index.sqlite");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    resetEmbeddingMocks();
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function createManager(query: MemorySearchConfig["query"]) {
    const cfg = {
      memory: {
        backend: "builtin",
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            query,
            store: {
              path: indexPath,
              vector: { enabled: false },
            },
            cache: { enabled: false },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });
    await manager.sync({ force: true });
    return manager;
  }

  function queryCacheSize(memoryManager: MemoryIndexManager): number {
    return (
      memoryManager as unknown as {
        queryResultCache: Map<string, unknown>;
      }
    ).queryResultCache.size;
  }

  it("caches successful query results for the configured TTL", async () => {
    const memoryManager = await createManager({
      cacheTtlMs: 60000,
      retry: { attempts: 1 },
    });
    const embedQuery = getEmbedQueryMock();
    embedQuery.mockClear();

    const first = await memoryManager.search("alpha project");
    const second = await memoryManager.search("alpha project");

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(embedQuery).toHaveBeenCalledTimes(1);
  });

  it("clears cached query results when the index is refreshed", async () => {
    const memoryManager = await createManager({
      cacheTtlMs: 60000,
      retry: { attempts: 1 },
    });
    const embedQuery = getEmbedQueryMock();
    embedQuery.mockClear();

    await memoryManager.search("alpha project");
    await memoryManager.search("alpha project");
    await memoryManager.sync({ force: true });
    await memoryManager.search("alpha project");

    expect(embedQuery).toHaveBeenCalledTimes(2);
  });

  it("does not cache provider failure fallback results", async () => {
    const memoryManager = await createManager({
      cacheTtlMs: 60000,
      minScore: 0,
      retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });
    const embedQuery = getEmbedQueryMock();
    embedQuery.mockReset();
    embedQuery.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue([0, 1, 0]);

    const first = await memoryManager.search("alpha project");
    const second = await memoryManager.search("alpha project");

    if (memoryManager.status().fts?.available === true) {
      expect(first.length).toBeGreaterThan(0);
    } else {
      expect(first).toEqual([]);
    }
    expect(second.length).toBeGreaterThan(0);
    expect(embedQuery).toHaveBeenCalledTimes(2);
  });

  it("prunes expired query cache entries before storing new results", async () => {
    const memoryManager = await createManager({
      cacheTtlMs: 1,
      retry: { attempts: 1 },
    });

    await memoryManager.search("alpha project");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await memoryManager.search("reliability note");

    expect(queryCacheSize(memoryManager)).toBe(1);
  });

  it("retries transient query embedding failures", async () => {
    const memoryManager = await createManager({
      minScore: 0,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });
    const embedQuery = getEmbedQueryMock();
    embedQuery.mockReset();
    embedQuery.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce([0, 1, 0]);

    const results = await memoryManager.search("alpha project");

    expect(results.length).toBeGreaterThan(0);
    expect(embedQuery).toHaveBeenCalledTimes(2);
  });

  it("falls back to keyword results after transient query retries are exhausted", async () => {
    const memoryManager = await createManager({
      minScore: 0,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });
    const embedQuery = getEmbedQueryMock();
    embedQuery.mockReset();
    embedQuery.mockRejectedValue(new Error("fetch failed"));

    const results = await memoryManager.search("alpha project");

    if (memoryManager.status().fts?.available === true) {
      expect(results.length).toBeGreaterThan(0);
    } else {
      expect(results).toEqual([]);
    }
    expect(embedQuery).toHaveBeenCalledTimes(2);
  });
});
