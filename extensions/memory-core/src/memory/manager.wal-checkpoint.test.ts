import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

const createEmbeddingProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    requestedProvider: "auto",
    provider: null,
    providerUnavailableReason: "No embeddings provider available.",
  })),
);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createEmbeddingProviderMock,
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
}));

describe("memory manager writeMeta WAL checkpoint and stale file cleanup", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-mem-wal-checkpoint-pr-"),
    );
  });

  beforeEach(async () => {
    createEmbeddingProviderMock.mockClear();
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Test content for WAL.\n");
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

  async function createManager(): Promise<MemoryIndexManager> {
    const cfg = {
      memory: { backend: "builtin" },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "auto",
            model: "",
            store: { path: indexPath },
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

  it("checkpoint ensures meta row is readable from a fresh read-only connection after sync", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync();

    // Open a fresh read-only connection — simulates a restart.
    // If WAL wasn't checkpointed, a new connection might see stale data.
    const roDb = new DatabaseSync(indexPath, { readOnly: true });
    const metaRow = roDb
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get("memory_index_meta_v1") as { value: string } | undefined;
    roDb.close();

    expect(metaRow).toBeDefined();
    const parsed = JSON.parse(metaRow!.value);
    expect(parsed.model).toBeDefined();
    expect(parsed.provider).toBeDefined();
  });

  it("cleans up stale .backup-* and .tmp-* files during sync", async () => {
    // Create fake stale files to simulate an interrupted atomic swap.
    await fs.writeFile(`${indexPath}.backup-stale1`, "stale backup");
    await fs.writeFile(`${indexPath}.tmp-stale2`, "stale temp");

    const memoryManager = await createManager();
    await memoryManager.sync();

    // Stale files should be cleaned up.
    await expect(fs.stat(`${indexPath}.backup-stale1`)).rejects.toThrow();
    await expect(fs.stat(`${indexPath}.tmp-stale2`)).rejects.toThrow();

    // Index should still be healthy.
    const roDb = new DatabaseSync(indexPath, { readOnly: true });
    const metaRow = roDb
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get("memory_index_meta_v1") as { value: string } | undefined;
    roDb.close();
    expect(metaRow).toBeDefined();
  });
});
