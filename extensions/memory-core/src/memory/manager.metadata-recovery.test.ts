// Memory Core tests cover transient index metadata recovery during search.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
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

type ManagerInternals = {
  readMeta: () => MemoryIndexMeta | null;
  openDatabase: () => unknown;
  resetVectorState: () => void;
  ensureSchema: () => void;
  hasIndexedContent: () => boolean;
};

function metadataRecoveryStatus(memoryManager: MemoryIndexManager) {
  return memoryManager.status().custom?.metadataRecovery as
    | {
        attempts?: number;
        successes?: number;
        failures?: number;
        lastError?: string;
      }
    | undefined;
}

function indexIdentityStatus(memoryManager: MemoryIndexManager) {
  return memoryManager.status().custom?.indexIdentity as
    | {
        status?: string;
        reason?: string;
      }
    | undefined;
}

describe("memory manager search metadata recovery", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-meta-recovery-"));
  });

  beforeEach(async () => {
    createEmbeddingProviderMock.mockClear();
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "Alpha topic\n\nKeep this note for search recovery.",
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  async function createIndexedFtsOnlyManager(): Promise<MemoryIndexManager> {
    const cfg = {
      memory: { backend: "builtin" },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "auto",
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
    await manager.sync({ reason: "test", force: true });
    expect(indexIdentityStatus(manager)?.status).toBe("valid");
    return manager;
  }

  it("reopens sqlite and retries once when search sees transient missing metadata", async () => {
    const memoryManager = await createIndexedFtsOnlyManager();
    const internals = memoryManager as unknown as ManagerInternals;
    const originalReadMeta = internals.readMeta.bind(memoryManager);
    let missingReads = 1;
    vi.spyOn(internals, "readMeta").mockImplementation(() =>
      missingReads-- > 0 ? null : originalReadMeta(),
    );
    const openDatabaseSpy = vi.spyOn(internals, "openDatabase");
    const resetVectorStateSpy = vi.spyOn(internals, "resetVectorState");
    const ensureSchemaSpy = vi.spyOn(internals, "ensureSchema");

    const results = await memoryManager.search("Alpha topic", { maxResults: 5 });

    expect(results.map((result) => result.path)).toContain("MEMORY.md");
    expect(openDatabaseSpy).toHaveBeenCalledTimes(1);
    expect(resetVectorStateSpy).toHaveBeenCalledTimes(1);
    expect(ensureSchemaSpy).toHaveBeenCalledTimes(1);
    expect(metadataRecoveryStatus(memoryManager)).toEqual({
      attempts: 1,
      successes: 1,
      failures: 0,
      lastError: "index metadata is missing",
    });
  });

  it("does not retry persistent provider/model/settings mismatches", async () => {
    const memoryManager = await createIndexedFtsOnlyManager();
    const internals = memoryManager as unknown as ManagerInternals;
    const originalMeta = internals.readMeta();
    if (!originalMeta) {
      throw new Error("expected indexed metadata");
    }
    vi.spyOn(internals, "readMeta").mockReturnValue({
      ...originalMeta,
      model: "other-model",
    });
    const openDatabaseSpy = vi.spyOn(internals, "openDatabase");

    await expect(memoryManager.search("Alpha topic", { maxResults: 5 })).resolves.toEqual([]);

    expect(openDatabaseSpy).not.toHaveBeenCalled();
    expect(indexIdentityStatus(memoryManager)).toEqual({
      status: "mismatched",
      reason: "index was built for model other-model, expected fts-only",
    });
    expect(metadataRecoveryStatus(memoryManager)).toEqual({
      attempts: 0,
      successes: 0,
      failures: 0,
      lastError: undefined,
    });
  });

  it("does not retry non-metadata search failures", async () => {
    const memoryManager = await createIndexedFtsOnlyManager();
    const internals = memoryManager as unknown as ManagerInternals;
    vi.spyOn(internals, "hasIndexedContent").mockImplementation(() => {
      throw new Error("search storage failed");
    });
    const openDatabaseSpy = vi.spyOn(internals, "openDatabase");

    await expect(memoryManager.search("Alpha topic", { maxResults: 5 })).rejects.toThrow(
      "search storage failed",
    );

    expect(openDatabaseSpy).not.toHaveBeenCalled();
    expect(metadataRecoveryStatus(memoryManager)).toEqual({
      attempts: 0,
      successes: 0,
      failures: 0,
      lastError: undefined,
    });
  });

  it("caps missing-metadata recovery at one retry", async () => {
    const memoryManager = await createIndexedFtsOnlyManager();
    const internals = memoryManager as unknown as ManagerInternals;
    vi.spyOn(internals, "readMeta").mockReturnValue(null);
    const openDatabaseSpy = vi.spyOn(internals, "openDatabase");

    await expect(memoryManager.search("Alpha topic", { maxResults: 5 })).resolves.toEqual([]);

    expect(openDatabaseSpy).toHaveBeenCalledTimes(1);
    expect(indexIdentityStatus(memoryManager)).toEqual({
      status: "missing",
      reason: "index metadata is missing",
    });
    expect(metadataRecoveryStatus(memoryManager)).toEqual({
      attempts: 1,
      successes: 0,
      failures: 1,
      lastError: "index metadata is missing",
    });
  });
});
