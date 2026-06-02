import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearMemoryEmbeddingProviders as clearRegistry,
  registerMemoryEmbeddingProvider as registerAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  clearMemoryPluginState,
  registerMemoryRerankProvider,
  type MemoryRerankCandidate,
  type MemoryRerankScore,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-runtime-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { closeAllMemorySearchManagers } from "./index.js";
import { registerBuiltInMemoryEmbeddingProviders } from "./provider-adapters.js";

// Term-counting embedding so each fixture chunk gets a distinct vector; vector
// search is disabled in tests (sqlite-vec mocked off) so ranking comes from FTS,
// but the mock keeps the provider present so search() reaches the hybrid path.
const TERMS = ["alpha", "beta", "gamma", "delta"];
function embedText(text: string): number[] {
  const lower = text.toLowerCase();
  return TERMS.map((term) => lower.split(term).length - 1);
}

// Mock the embedding provider so search() reaches the hybrid merge path without
// real embeddings; sqlite-vec stays mocked off via test-runtime-mocks.
vi.mock("./embeddings.js", () => ({
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async (text: string) => embedText(text),
      embedBatch: async (texts: string[]) => texts.map(embedText),
      close: async () => {},
    },
  }),
}));

const RERANK_PLUGIN_ID = "test-reranker";

type ManagerStatusCustom = {
  rerank?: { state: string; failureCount: number; lastError?: string };
};

describe("memory rerank stage", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";
  let storePath = "";
  const managers = new Set<MemoryIndexManager>();

  async function getManager(): Promise<MemoryIndexManager> {
    const { MemoryIndexManager: ManagerCtor } = await import("./index.js");
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: storePath, vector: { enabled: false } },
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: {
              minScore: 0,
              // MMR disabled: keep the post-rerank order observable end-to-end.
              hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
            },
            sources: ["memory"],
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as unknown as Parameters<typeof ManagerCtor.get>[0]["cfg"];
    const manager = await ManagerCtor.get({ cfg, agentId: "main" });
    if (!manager) {
      throw new Error("manager missing");
    }
    managers.add(manager);
    return manager;
  }

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-rerank-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    storePath = path.join(workspaceDir, "index.sqlite");
    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(memoryDir, { recursive: true });
    // Three single-chunk files, each matching the query term so all survive FTS.
    await fs.writeFile(path.join(memoryDir, "a.md"), "alpha topic one alpha.");
    await fs.writeFile(path.join(memoryDir, "b.md"), "alpha topic two beta.");
    await fs.writeFile(path.join(memoryDir, "c.md"), "alpha topic three gamma.");
    clearRegistry();
    clearMemoryPluginState();
    registerBuiltInMemoryEmbeddingProviders({ registerMemoryEmbeddingProvider: registerAdapter });
  });

  afterEach(async () => {
    await Promise.all(Array.from(managers).map((m) => m.close()));
    await closeAllMemorySearchManagers();
    managers.clear();
    clearRegistry();
    clearMemoryPluginState();
  });

  function ftsAvailable(manager: MemoryIndexManager): boolean {
    return Boolean(manager.status().fts?.available);
  }

  it("(a) no reranker: results keep pre-rerank order and state is disabled", async () => {
    const manager = await getManager();
    if (!ftsAvailable(manager)) {
      return;
    }
    await manager.sync({ reason: "test" });
    const results = await manager.search("alpha", { maxResults: 10 });
    expect(results.length).toBeGreaterThan(1);
    // No reranker registered: rerankScore must stay unset.
    expect(results.every((r) => r.rerankScore === undefined)).toBe(true);
    const custom = manager.status().custom as ManagerStatusCustom;
    expect(custom.rerank?.state).toBe("disabled");
  });

  it("(b) reranker reorders by descending rerankScore and sets active state", async () => {
    const baseline = await getManager();
    if (!ftsAvailable(baseline)) {
      return;
    }
    await baseline.sync({ reason: "test" });
    const preRerank = await baseline.search("alpha", { maxResults: 10 });
    const preOrder = preRerank.map((r) => r.path);

    // Assign ascending scores in candidate (pre-rerank pool) order so descending
    // rerankScore reverses the merge order.
    registerMemoryRerankProvider(RERANK_PLUGIN_ID, {
      rerank: async ({
        candidates,
      }: {
        candidates: ReadonlyArray<MemoryRerankCandidate>;
      }): Promise<MemoryRerankScore[]> =>
        candidates.map((c, i) => ({ ref: c.ref, score: i / Math.max(1, candidates.length) })),
    });

    const results = await baseline.search("alpha", { maxResults: 10 });
    const postOrder = results.map((r) => r.path);
    expect(postOrder).toStrictEqual(preOrder.toReversed());
    expect(results.every((r) => typeof r.rerankScore === "number")).toBe(true);
    const custom = baseline.status().custom as ManagerStatusCustom;
    expect(custom.rerank?.state).toBe("active");
  });

  it("(c) reranker throws: pre-rerank order, degraded state, failureCount 1", async () => {
    const baseline = await getManager();
    if (!ftsAvailable(baseline)) {
      return;
    }
    await baseline.sync({ reason: "test" });
    const preOrder = (await baseline.search("alpha", { maxResults: 10 })).map((r) => r.path);

    registerMemoryRerankProvider(RERANK_PLUGIN_ID, {
      rerank: async (): Promise<MemoryRerankScore[]> => {
        throw new Error("reranker boom");
      },
    });

    const results = await baseline.search("alpha", { maxResults: 10 });
    expect(results.map((r) => r.path)).toStrictEqual(preOrder);
    const custom = baseline.status().custom as ManagerStatusCustom;
    expect(custom.rerank?.state).toBe("degraded");
    expect(custom.rerank?.failureCount).toBe(1);
    expect(custom.rerank?.lastError).toContain("reranker boom");
  });

  it("(d) reranker exceeds deadline: pre-rerank order and the signal aborts", async () => {
    const baseline = await getManager();
    if (!ftsAvailable(baseline)) {
      return;
    }
    await baseline.sync({ reason: "test" });
    const preOrder = (await baseline.search("alpha", { maxResults: 10 })).map((r) => r.path);

    let abortedFromSignal = false;
    registerMemoryRerankProvider(RERANK_PLUGIN_ID, {
      rerank: async ({ signal }: { signal: AbortSignal }): Promise<MemoryRerankScore[]> =>
        await new Promise<MemoryRerankScore[]>((_resolve, reject) => {
          // Never resolve on its own; only the core deadline can abort it.
          signal.addEventListener("abort", () => {
            abortedFromSignal = true;
            reject(new Error("aborted"));
          });
        }),
    });

    // Shrink the core deadline so the test does not wait the full 5s.
    (baseline as unknown as { rerankDeadlineMs: number }).rerankDeadlineMs = 25;

    const results = await baseline.search("alpha", { maxResults: 10 });
    expect(results.map((r) => r.path)).toStrictEqual(preOrder);
    expect(abortedFromSignal).toBe(true);
    const custom = baseline.status().custom as ManagerStatusCustom;
    expect(custom.rerank?.state).toBe("degraded");
    expect(custom.rerank?.lastError).toContain("deadline");
  });

  it("(e) invalid ref: rejected, pre-rerank order, degraded state", async () => {
    const baseline = await getManager();
    if (!ftsAvailable(baseline)) {
      return;
    }
    await baseline.sync({ reason: "test" });
    const preOrder = (await baseline.search("alpha", { maxResults: 10 })).map((r) => r.path);

    registerMemoryRerankProvider(RERANK_PLUGIN_ID, {
      rerank: async ({
        candidates,
      }: {
        candidates: ReadonlyArray<MemoryRerankCandidate>;
      }): Promise<MemoryRerankScore[]> => [
        // Out-of-range ref must be rejected as a failure.
        { ref: candidates.length + 5, score: 0.9 },
      ],
    });

    const results = await baseline.search("alpha", { maxResults: 10 });
    expect(results.map((r) => r.path)).toStrictEqual(preOrder);
    expect(results.every((r) => r.rerankScore === undefined)).toBe(true);
    const custom = baseline.status().custom as ManagerStatusCustom;
    expect(custom.rerank?.state).toBe("degraded");
  });

  it("(f) reranker returns [] with non-empty candidates: pre-rerank order, degraded state, failureCount 1", async () => {
    const baseline = await getManager();
    if (!ftsAvailable(baseline)) {
      return;
    }
    await baseline.sync({ reason: "test" });
    const preOrder = (await baseline.search("alpha", { maxResults: 10 })).map((r) => r.path);
    expect(preOrder.length).toBeGreaterThan(0);

    // Kill-switched or fail-open plugin returns [] without throwing.
    registerMemoryRerankProvider(RERANK_PLUGIN_ID, {
      rerank: async (): Promise<MemoryRerankScore[]> => [],
    });

    const results = await baseline.search("alpha", { maxResults: 10 });
    // Pre-rerank order preserved (fail-open).
    expect(results.map((r) => r.path)).toStrictEqual(preOrder);
    // No rerankScore applied since the provider returned no scores.
    expect(results.every((r) => r.rerankScore === undefined)).toBe(true);
    const custom = baseline.status().custom as ManagerStatusCustom;
    // A registered-but-not-reranking provider must report "degraded", not "active".
    expect(custom.rerank?.state).toBe("degraded");
    expect(custom.rerank?.failureCount).toBe(1);
    expect(custom.rerank?.lastError).toBeTruthy();
  });
});
