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

describe("published metadata WAL checkpoint", () => {
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
    vi.restoreAllMocks();
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
            // Exercise the canonical per-agent database path rather than a store override.
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

  it("copies complete metadata from the main file while the manager remains open", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync();

    const status = memoryManager.status();
    expect(status.chunks).toBeGreaterThan(0);

    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const copiedDatabasePath = path.join(path.dirname(databasePath), "main-file-copy.sqlite");
    await fs.copyFile(databasePath, copiedDatabasePath);
    const roDb = new DatabaseSync(copiedDatabasePath, { readOnly: true });
    const metaRow = roDb
      .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
      .get("memory_index_meta_v1") as { value: string } | undefined;
    roDb.close();

    if (!metaRow) {
      throw new Error("copied main database is missing index metadata");
    }
    const parsed = JSON.parse(metaRow.value) as Record<string, unknown>;
    expect(parsed).toMatchObject({ model: "fts-only", provider: "none" });
  });
});
