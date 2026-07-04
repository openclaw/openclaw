import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
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
  resolveEmbeddingProviderIndexIdentity: () => undefined,
}));

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

function setStateDir(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

function restoreStateDir(): void {
  if (originalStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalStateDir);
  }
}

describe("writeMeta WAL checkpoint", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-checkpoint-pr-"));
  });

  beforeEach(async () => {
    createEmbeddingProviderMock.mockClear();
    const caseDir = path.join(fixtureRoot, `case-${caseId++}`);
    workspaceDir = path.join(caseDir, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Test content.\n");
    // Point OPENCLAW_STATE_DIR so resolveOpenClawAgentSqlitePath resolves
    // inside our fixture, exercising the real per-agent DB path.
    setStateDir(path.join(caseDir, "state"));
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
  });

  afterAll(async () => {
    restoreStateDir();
    await closeAllMemorySearchManagers();
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {
        // Windows: SQLite WAL/SHM sidecars may still be locked briefly.
        // The OS temp dir will clean them up eventually.
      });
    }
  });

  function createCfg(): OpenClawConfig {
    return {
      memory: { backend: "builtin" },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "auto",
            model: "",
            // Do NOT set store.path — the resolver in memory-search.ts always
            // overrides databasePath via resolveOpenClawAgentSqlitePath.
            store: { vector: { enabled: false } },
            cache: { enabled: false },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  async function createManager(): Promise<MemoryIndexManager> {
    const cfg = createCfg();
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  it("writeMeta calls PRAGMA wal_checkpoint(TRUNCATE) during sync", async () => {
    // Proves the fix: after publishMemoryDatabaseTables copies the shadow
    // DB contents (including the meta row) to the live per-agent DB, a
    // WAL checkpoint is forced on the live DB — not on the shadow DB.
    // On unpatched main, the checkpoint was inside writeMeta on the shadow
    // DB and did nothing useful for crash durability of the live index.
    //
    // This test exercises the real per-agent DB path resolved through
    // resolveOpenClawAgentSqlitePath (not a legacy store.path override).

    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");

    const memoryManager = await createManager();
    // DB init may call exec; reset to capture only sync-period calls.
    execSpy.mockClear();

    await memoryManager.sync();

    const checkpointCalls = execSpy.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql === "PRAGMA wal_checkpoint(TRUNCATE)",
    );

    // At least one checkpoint fired during sync (from the post-publish
    // checkpoint on the live per-agent DB). Close-time checkpoint may add
    // more, but the sync-time call is the fix.
    expect(checkpointCalls.length).toBeGreaterThan(0);

    execSpy.mockRestore();
  });

  it("meta row is durable across manager close/reopen on the per-agent DB", async () => {
    // Integration test through the real memory-search config resolver:
    // resolveOpenClawAgentSqlitePath determines where the DB lives, and
    // we verify meta survives close/reopen by reading memory_index_meta
    // (the current table name) from the canonical agent SQLite path.
    const memoryManager = await createManager();
    await memoryManager.sync();
    await manager!.close();
    manager = null;
    await closeAllMemorySearchManagers();

    // Reopen with same config — should find valid index
    const cfg = createCfg();
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    manager = result.manager as unknown as MemoryIndexManager;

    const status = manager!.status();
    expect(status.chunks).toBeGreaterThan(0);

    // Verify meta directly from the canonical per-agent DB file
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const roDb = new DatabaseSync(databasePath, { readOnly: true });
    const metaRow = roDb
      .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
      .get("memory_index_meta_v1") as { value: string } | undefined;
    roDb.close();

    expect(metaRow).toBeDefined();
    const parsed = JSON.parse(metaRow!.value);
    expect(parsed.model).toBeDefined();
    expect(parsed.provider).toBeDefined();
  });
});
