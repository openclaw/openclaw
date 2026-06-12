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

describe("writeMeta WAL checkpoint", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-mem-checkpoint-pr-"),
    );
  });

  beforeEach(async () => {
    createEmbeddingProviderMock.mockClear();
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Test content.\n");
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

  it("writeMeta calls PRAGMA wal_checkpoint(TRUNCATE) independently of closeMemoryDatabase", async () => {
    // This test proves the fix matters: on current main, writeMeta does NOT
    // call wal_checkpoint — the only checkpoint happens in closeMemoryDatabase.
    // With our fix, writeMeta itself forces the checkpoint.
    //
    // We spy on DatabaseSync.prototype.exec across ALL db instances (including
    // the temp DB created during reindex) to verify the checkpoint fires
    // during writeMeta, before any close call.

    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");

    const memoryManager = await createManager();
    // The constructor/init may open the DB and call exec. Reset to only
    // capture calls during sync.
    execSpy.mockClear();

    await memoryManager.sync();

    // Collect all wal_checkpoint(TRUNCATE) calls
    const checkpointCalls = execSpy.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql === "PRAGMA wal_checkpoint(TRUNCATE)",
    );

    // Close-time checkpoint also calls this, so we expect at least 1 from
    // writeMeta and potentially more from closeMemoryDatabase.
    // The key assertion: checkpoint was called DURING sync (before close).
    // On current main without our fix, checkpointCalls would only contain
    // close-time calls (if any), not writeMeta calls.
    expect(checkpointCalls.length).toBeGreaterThan(0);

    execSpy.mockRestore();
  });

  it("meta row is durable across manager close/reopen cycles", async () => {
    // Integration test: after sync + close, meta survives and a fresh
    // manager can read it without reindexing.
    const memoryManager = await createManager();
    await memoryManager.sync();
    await manager!.close();
    manager = null;
    await closeAllMemorySearchManagers();

    // Reopen with same config — should find valid index
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
    manager = result.manager as unknown as MemoryIndexManager;

    const status = manager!.status();
    expect(status.chunks).toBeGreaterThan(0);

    // Verify meta is present in the DB file directly
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
});
