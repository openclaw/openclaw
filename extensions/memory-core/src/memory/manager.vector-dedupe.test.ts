import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryIndexManager } from "./index.js";

vi.mock("./embeddings.js", () => {
  return {
    createEmbeddingProvider: async () => ({
      requestedProvider: "openai",
      provider: {
        id: "mock",
        model: "mock-embed",
        embedQuery: async () => [0.1, 0.2, 0.3],
        embedBatch: async (texts: string[]) => texts.map((_, index) => [index + 1, 0, 0]),
      },
    }),
  };
});

type MemoryStorageModule = typeof import("openclaw/plugin-sdk/memory-core-host-engine-storage");
type TestManagerModule = typeof import("./test-manager.js");
type MemoryIndexModule = typeof import("./index.js");

let buildFileEntry: MemoryStorageModule["buildFileEntry"];
let createMemoryManagerOrThrow: TestManagerModule["createMemoryManagerOrThrow"];
let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];

async function ensureProviderInitialized(manager: MemoryIndexManager): Promise<void> {
  await (
    manager as unknown as {
      ensureProviderInitialized: () => Promise<void>;
    }
  ).ensureProviderInitialized();
}

describe("memory vector dedupe", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  async function seedMemoryWorkspace(rootDir: string) {
    await fs.mkdir(path.join(rootDir, "memory"));
    await fs.writeFile(path.join(rootDir, "MEMORY.md"), "Hello memory.");
  }

  async function closeManagerIfOpen() {
    if (!manager) {
      return;
    }
    await manager.close();
    manager = null;
  }

  beforeEach(async () => {
    vi.resetModules();
    ({ buildFileEntry } = await import("openclaw/plugin-sdk/memory-core-host-engine-storage"));
    ({ createMemoryManagerOrThrow } = await import("./test-manager.js"));
    ({ closeAllMemorySearchManagers } = await import("./index.js"));
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await seedMemoryWorkspace(workspaceDir);
  });

  afterEach(async () => {
    await closeManagerIfOpen();
    await closeAllMemorySearchManagers();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("deletes existing vector rows before inserting replacements", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: true } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            cache: { enabled: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await createMemoryManagerOrThrow(cfg);
    await ensureProviderInitialized(manager);

    const db = (
      manager as unknown as {
        db: { exec: (sql: string) => void; prepare: (sql: string) => unknown };
      }
    ).db;
    db.exec("CREATE TABLE IF NOT EXISTS chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");

    (
      manager as unknown as { ensureVectorReady: (dims?: number) => Promise<boolean> }
    ).ensureVectorReady = async () => true;
    await (
      manager as unknown as { ensureProviderInitialized: () => Promise<void> }
    ).ensureProviderInitialized();

    const entry = await buildFileEntry(path.join(workspaceDir, "MEMORY.md"), workspaceDir);
    if (!entry) {
      throw new Error("entry missing");
    }
    await (
      manager as unknown as {
        indexFile: (entry: unknown, options: { source: "memory" }) => Promise<void>;
      }
    ).indexFile(entry, { source: "memory" });
    await (
      manager as unknown as {
        indexFile: (entry: unknown, options: { source: "memory" }) => Promise<void>;
      }
    ).indexFile(entry, { source: "memory" });

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS fail_if_vector_row_not_deleted
      BEFORE INSERT ON chunks_vec
      WHEN EXISTS (SELECT 1 FROM chunks_vec WHERE id = NEW.id)
      BEGIN
        SELECT RAISE(FAIL, 'vector row not deleted before insert');
      END;
    `);

    await expect(
      (
        manager as unknown as {
          indexFile: (entry: unknown, options: { source: "memory" }) => Promise<void>;
        }
      ).indexFile(entry, { source: "memory" }),
    ).resolves.toBeUndefined();
  });
});
