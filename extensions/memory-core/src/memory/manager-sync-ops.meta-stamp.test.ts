import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

const META_KEY = "memory_index_meta_v1";

describe("memory manager sync meta stamp", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-meta-stamp-"));
  });

  beforeEach(async () => {
    vi.useRealTimers();
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "0");
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    indexPath = path.join(workspaceDir, "index.sqlite");
    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Alpha topic\n\nKeep this note.");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
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
      memory: {
        backend: "builtin",
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "none",
            model: "",
            store: { path: indexPath, vector: { enabled: false } },
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

  function readStoredMeta(memoryManager: MemoryIndexManager): string | null {
    const row = (
      memoryManager as unknown as {
        db: {
          prepare(sql: string): {
            get(key: string): { value: string } | undefined;
          };
        };
      }
    ).db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(META_KEY);
    return row?.value ?? null;
  }

  it("writes the meta stamp when a byte-identical safe reindex swaps in a fresh DB", async () => {
    const memoryManager = await createManager();

    await memoryManager.sync({ force: true });

    const internals = memoryManager as unknown as {
      lastMetaSerialized: string | null;
      readMeta(): MemoryIndexMeta | null;
    };
    const firstMeta = internals.readMeta();
    expect(firstMeta).not.toBeNull();
    expect(internals.lastMetaSerialized).toBe(JSON.stringify(firstMeta));

    await memoryManager.sync({ force: true });

    expect(readStoredMeta(memoryManager)).toBe(JSON.stringify(firstMeta));
  });
});
