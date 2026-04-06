import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryIndexManager } from "./index.js";

let shouldFail = false;

type EmbeddingTestMocksModule = typeof import("./embedding.test-mocks.js");
type TestManagerHelpersModule = typeof import("./test-manager-helpers.js");
type MemoryIndexModule = typeof import("./index.js");

describe("memory manager atomic reindex", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;
  let embedBatch: ReturnType<EmbeddingTestMocksModule["getEmbedBatchMock"]>;
  let resetEmbeddingMocks: EmbeddingTestMocksModule["resetEmbeddingMocks"];
  let getRequiredMemoryIndexManager: TestManagerHelpersModule["getRequiredMemoryIndexManager"];
  let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];

  beforeAll(async () => {
    vi.resetModules();
    const embeddingMocks = await import("./embedding.test-mocks.js");
    embedBatch = embeddingMocks.getEmbedBatchMock();
    resetEmbeddingMocks = embeddingMocks.resetEmbeddingMocks;
    ({ getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js"));
    ({ closeAllMemorySearchManagers } = await import("./index.js"));
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-atomic-"));
  });

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "0");
    resetEmbeddingMocks();
    shouldFail = false;
    embedBatch.mockImplementation(async (texts: string[]) => {
      if (shouldFail) {
        throw new Error("embedding failure");
      }
      return texts.map((_, index) => [index + 1, 0, 0]);
    });
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello memory.");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      vi.resetModules();
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it("keeps the prior index when a full reindex fails", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            cache: { enabled: false },
            // Perf: keep test indexes to a single chunk to reduce sqlite work.
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    await manager.sync({ force: true });
    const beforeStatus = manager.status();
    expect(beforeStatus.chunks).toBeGreaterThan(0);

    shouldFail = true;
    await expect(manager.sync({ force: true })).rejects.toThrow("embedding failure");

    const afterStatus = manager.status();
    expect(afterStatus.chunks).toBeGreaterThan(0);
  });
});
