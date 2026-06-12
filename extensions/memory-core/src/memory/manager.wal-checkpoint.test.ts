import fs from "node:fs/promises";
import fsSync from "node:fs";
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

  it("checkpoint writes meta into the main DB file, not just the WAL", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync();
    await manager!.close();
    manager = null;

    // Move the WAL and SHM sidecars away so SQLite cannot replay them.
    // If the meta row is only in the WAL, reading the main file alone will fail.
    const walPath = `${indexPath}-wal`;
    const shmPath = `${indexPath}-shm`;
    const walBackup = `${walPath}.bak`;
    const shmBackup = `${shmPath}.bak`;

    let walExisted = false;
    if (fsSync.existsSync(walPath)) {
      walExisted = true;
      await fs.rename(walPath, walBackup);
    }
    if (fsSync.existsSync(shmPath)) {
      await fs.rename(shmPath, shmBackup);
    }

    try {
      // Open ONLY the main DB file — no WAL to replay.
      const roDb = new DatabaseSync(indexPath, { readOnly: true });
      const metaRow = roDb
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get("memory_index_meta_v1") as { value: string } | undefined;
      roDb.close();

      // If the checkpoint worked, meta is in the main file and we can read it.
      expect(metaRow).toBeDefined();
      const parsed = JSON.parse(metaRow!.value);
      expect(parsed.model).toBeDefined();
      expect(parsed.provider).toBeDefined();
    } finally {
      // Restore sidecars for cleanup.
      if (walExisted && fsSync.existsSync(walBackup)) {
        await fs.rename(walBackup, walPath);
      }
      if (fsSync.existsSync(shmBackup)) {
        await fs.rename(shmBackup, shmPath);
      }
    }
  });

  it("cleans up stale .backup-* and .tmp-* files older than the threshold", async () => {
    // Create fake stale files with old mtime to simulate abandoned artifacts.
    const staleBackup = `${indexPath}.backup-old`;
    const staleTemp = `${indexPath}.tmp-old`;
    await fs.writeFile(staleBackup, "stale backup");
    await fs.writeFile(staleTemp, "stale temp");

    // Set mtime to 10 minutes ago (past the STALE_INDEX_AGE_MS threshold).
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    fsSync.utimesSync(staleBackup, oldTime, oldTime);
    fsSync.utimesSync(staleTemp, oldTime, oldTime);

    // Also create a recent file that should NOT be deleted.
    const freshTemp = `${indexPath}.tmp-fresh`;
    await fs.writeFile(freshTemp, "fresh active temp");

    const memoryManager = await createManager();
    await memoryManager.sync();

    // Old stale files should be gone.
    expect(fsSync.existsSync(staleBackup)).toBe(false);
    expect(fsSync.existsSync(staleTemp)).toBe(false);

    // Fresh file should still exist (it's younger than the threshold).
    expect(fsSync.existsSync(freshTemp)).toBe(true);
  });
});
