import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

const embedText = (text: string) => {
  const lower = text.toLowerCase();
  return [lower.includes("alpha") ? 1 : 0, lower.includes("topic") ? 1 : 0];
};

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async (options: { provider?: string; model?: string }) => {
    if (options.provider === "openai") {
      return {
        requestedProvider: "openai",
        provider: {
          id: "openai",
          model: options.model || "mock-embed",
          embedQuery: async (text: string) => embedText(text),
          embedBatch: async (texts: string[]) => texts.map(embedText),
        },
      };
    }
    return {
      requestedProvider: "auto",
      provider: null,
      providerUnavailableReason: "No embeddings provider available.",
    };
  },
  resolveEmbeddingProviderAdapterId: (provider: string) =>
    provider === "openai" ? "openai" : null,
  resolveEmbeddingProviderAdapterTransport: (provider: string) =>
    provider === "openai" ? "remote" : undefined,
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
  resolveEmbeddingProviderIndexIdentity: (options: { provider?: string; model?: string }) =>
    options.provider === "openai"
      ? {
          provider: {
            id: "openai",
            model: options.model || "mock-embed",
          },
          cacheKeyData: {
            provider: "openai",
            model: options.model || "mock-embed",
          },
        }
      : undefined,
}));

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("memory manager reindex read race", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-reindex-race-"));
  });

  beforeEach(async () => {
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "Alpha topic about durable index identity\n\nKeep this note for recall.",
    );
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

  async function createManager(params?: {
    provider?: string;
    model?: string;
  }): Promise<MemoryIndexManager> {
    const provider = params?.provider ?? "auto";
    const cfg = {
      memory: { backend: "builtin" },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider,
            model: params?.model ?? "",
            store: { databasePath: indexPath },
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

  // Pause a forced full reindex right after `this.db = tempDb` so concurrent
  // readers observe the half-built temp DB while the durable index is valid.
  function gateNextReindex(memoryManager: MemoryIndexManager): {
    entered: Promise<void>;
    release: () => void;
  } {
    const internal = memoryManager as unknown as {
      syncMemoryFiles(params: unknown): Promise<void>;
    };
    const original = internal.syncMemoryFiles.bind(internal);
    const enteredGate = deferred();
    const releaseGate = deferred();
    internal.syncMemoryFiles = async (params: unknown) => {
      enteredGate.resolve();
      await releaseGate.promise;
      internal.syncMemoryFiles = original;
      return original(params);
    };
    return { entered: enteredGate.promise, release: releaseGate.resolve };
  }

  it("status() reflects the stable durable index during an in-flight full reindex", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync({ force: true });

    const stable = memoryManager.status();
    expect(stable.chunks).toBeGreaterThan(0);

    const gate = gateNextReindex(memoryManager);
    const reindexing = memoryManager.sync({ force: true });
    await gate.entered;

    // While the temp DB is swapped in mid-build, status() must not report the
    // empty/unbuilt index. It should keep reflecting the valid durable index.
    const during = memoryManager.status();
    gate.release();
    await reindexing;

    expect(during.chunks).toBe(stable.chunks);
    expect(during.files).toBe(stable.files);
  });

  it("search() returns stable hits instead of reading the half-built temp index", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync({ force: true });

    const baseline = await memoryManager.search("Alpha topic");
    expect(baseline.length).toBeGreaterThan(0);

    const gate = gateNextReindex(memoryManager);
    const reindexing = memoryManager.sync({ force: true });
    await gate.entered;

    let settled = false;
    const searching = memoryManager.search("Alpha topic").then((hits) => {
      settled = true;
      return hits;
    });
    await Promise.resolve();
    // The search must wait for the reindex rather than read the temp index.
    expect(settled).toBe(false);

    gate.release();
    const hits = await searching;
    await reindexing;
    expect(hits.length).toBeGreaterThan(0);
  });

  it("required-provider search waits when provider initialization yields to a full reindex", async () => {
    const memoryManager = await createManager({ provider: "openai", model: "mock-embed" });
    await memoryManager.sync({ force: true });

    const internal = memoryManager as unknown as {
      ensureProviderInitialized(): Promise<void>;
    };
    const originalEnsureProviderInitialized = internal.ensureProviderInitialized.bind(internal);
    const gate = gateNextReindex(memoryManager);
    let reindexing: Promise<void> = Promise.resolve();
    internal.ensureProviderInitialized = async () => {
      internal.ensureProviderInitialized = originalEnsureProviderInitialized;
      reindexing = memoryManager.sync({ force: true });
      await gate.entered;
    };

    let settled = false;
    const searching = memoryManager.search("Alpha topic").then((hits) => {
      settled = true;
      return hits;
    });
    await gate.entered;
    await Promise.resolve();

    expect(settled).toBe(false);

    gate.release();
    const hits = await searching;
    await reindexing;
    internal.ensureProviderInitialized = originalEnsureProviderInitialized;
    expect(hits.length).toBeGreaterThan(0);
  });

  it("full reindex waits for active index readers before swapping the DB", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync({ force: true });

    const internal = memoryManager as unknown as {
      withIndexRead<T>(read: () => Promise<T>): Promise<T>;
    };
    const gate = gateNextReindex(memoryManager);
    let enteredTempBuild = false;
    void gate.entered.then(() => {
      enteredTempBuild = true;
    });
    let reindexing: Promise<void> = Promise.resolve();

    await internal.withIndexRead(async () => {
      reindexing = memoryManager.sync({ force: true });
      await Promise.resolve();
      await Promise.resolve();

      expect(enteredTempBuild).toBe(false);
    });

    await gate.entered;
    gate.release();
    await reindexing;
    expect(enteredTempBuild).toBe(true);
  });
});
