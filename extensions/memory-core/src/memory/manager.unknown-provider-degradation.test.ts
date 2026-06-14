import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

const createEmbeddingProviderMock = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("Unknown memory embedding provider: nonexistent-provider");
  }),
);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createEmbeddingProviderMock,
  resolveEmbeddingProviderAdapterId: () => undefined,
  resolveEmbeddingProviderAdapterTransport: () => "remote" as const,
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
}));

describe("memory manager unknown provider graceful degradation", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-unknown-provider-"));
  });

  beforeEach(async () => {
    createEmbeddingProviderMock.mockClear();
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Test memory note.\n\nAlpha topic.");
    indexPath = path.join(workspaceDir, "index.sqlite");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
  });

  afterAll(async () => {
    await closeAllMemorySearchManagers();
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  async function createManager(
    params: { provider?: string; vectorEnabled?: boolean } = {},
  ): Promise<MemoryIndexManager> {
    const store =
      params.vectorEnabled === undefined
        ? { path: indexPath }
        : { path: indexPath, vector: { enabled: params.vectorEnabled } };
    const cfg = {
      memory: { backend: "builtin" },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: params.provider ?? "nonexistent-provider",
            model: "",
            store,
            cache: { enabled: false },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  it("does not crash on probeEmbeddingAvailability when provider is unknown", async () => {
    const memoryManager = await createManager();

    const probeResult = await memoryManager.probeEmbeddingAvailability();
    expect(probeResult.ok).toBe(false);
    expect(probeResult.error).toContain("Unknown memory embedding provider");
  });

  it("reports fts-only lifecycle after probe when provider is unknown", async () => {
    const memoryManager = await createManager();

    await memoryManager.probeEmbeddingAvailability();

    const status = memoryManager.status();
    expect(status.custom?.providerState?.mode).toBe("fts-only");
    expect(status.custom?.providerState?.reason).toContain("Unknown memory embedding provider");
  });
});
