import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBEDDING_PROBE_CACHE_TTL_MS } from "./manager.js";

type MemoryEmbeddingProbeResult = { ok: boolean; error?: string };

/**
 * Test harness that mirrors the caching logic in MemoryIndexManager.probeEmbeddingAvailability().
 *
 * We use a standalone harness rather than the real class because MemoryIndexManager requires
 * complex dependencies (database, config, filesystem, embedding providers). The harness imports
 * EMBEDDING_PROBE_CACHE_TTL_MS from the production module to keep the TTL value in sync, and
 * replicates the same caching pattern: check cache expiry on entry, call Date.now() at cache
 * write time (not before async work). The slow-probe test verifies this timing is correct.
 */
function createProbeCacheTestHarness() {
  let embeddingProbeCache: { result: MemoryEmbeddingProbeResult; expireAt: number } | null = null;
  let _providerInitialized = false;
  let provider: { id: string } | null = null;
  let providerUnavailableReason: string | undefined;
  const embedBatchWithRetry = vi.fn(async (_texts: string[]): Promise<number[][]> => {
    return [[0.1, 0.2, 0.3]];
  });

  function cacheProbeResult(result: MemoryEmbeddingProbeResult): MemoryEmbeddingProbeResult {
    embeddingProbeCache = { result, expireAt: Date.now() + EMBEDDING_PROBE_CACHE_TTL_MS };
    return result;
  }

  async function probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    const cached = embeddingProbeCache;
    if (cached && Date.now() < cached.expireAt) {
      return cached.result;
    }
    // Simulate ensureProviderInitialized
    _providerInitialized = true;
    if (!provider) {
      return cacheProbeResult({
        ok: false,
        error: providerUnavailableReason ?? "No embedding provider available (FTS-only mode)",
      });
    }
    try {
      await embedBatchWithRetry(["ping"]);
      return cacheProbeResult({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return cacheProbeResult({ ok: false, error: message });
    }
  }

  return {
    probeEmbeddingAvailability,
    embedBatchWithRetry,
    setProvider: (p: { id: string } | null) => {
      provider = p;
    },
    setProviderUnavailableReason: (reason: string | undefined) => {
      providerUnavailableReason = reason;
    },
    getCache: () => embeddingProbeCache,
    clearCache: () => {
      embeddingProbeCache = null;
    },
  };
}

describe("memory embedding probe cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches a successful probe result", async () => {
    const harness = createProbeCacheTestHarness();
    harness.setProvider({ id: "openai" });

    const result1 = await harness.probeEmbeddingAvailability();
    expect(result1).toEqual({ ok: true });
    expect(harness.embedBatchWithRetry).toHaveBeenCalledTimes(1);

    const result2 = await harness.probeEmbeddingAvailability();
    expect(result2).toEqual({ ok: true });
    expect(harness.embedBatchWithRetry).toHaveBeenCalledTimes(1);
  });

  it("caches a failed probe result", async () => {
    const harness = createProbeCacheTestHarness();
    harness.setProvider({ id: "openai" });
    harness.embedBatchWithRetry.mockRejectedValueOnce(new Error("connection timeout"));

    const result1 = await harness.probeEmbeddingAvailability();
    expect(result1).toEqual({ ok: false, error: "connection timeout" });
    expect(harness.embedBatchWithRetry).toHaveBeenCalledTimes(1);

    const result2 = await harness.probeEmbeddingAvailability();
    expect(result2).toEqual({ ok: false, error: "connection timeout" });
    expect(harness.embedBatchWithRetry).toHaveBeenCalledTimes(1);
  });

  it("caches FTS-only mode result without calling embedBatch", async () => {
    const harness = createProbeCacheTestHarness();
    harness.setProvider(null);
    harness.setProviderUnavailableReason("No API key configured");

    const result1 = await harness.probeEmbeddingAvailability();
    expect(result1).toEqual({ ok: false, error: "No API key configured" });
    expect(harness.embedBatchWithRetry).not.toHaveBeenCalled();

    const result2 = await harness.probeEmbeddingAvailability();
    expect(result2).toEqual({ ok: false, error: "No API key configured" });
    expect(harness.embedBatchWithRetry).not.toHaveBeenCalled();
  });

  it("re-probes after TTL expires", async () => {
    const harness = createProbeCacheTestHarness();
    harness.setProvider({ id: "openai" });

    const result1 = await harness.probeEmbeddingAvailability();
    expect(result1).toEqual({ ok: true });
    expect(harness.embedBatchWithRetry).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(EMBEDDING_PROBE_CACHE_TTL_MS + 1);

    const result2 = await harness.probeEmbeddingAvailability();
    expect(result2).toEqual({ ok: true });
    expect(harness.embedBatchWithRetry).toHaveBeenCalledTimes(2);
  });

  it("returns cached result within TTL window", async () => {
    const harness = createProbeCacheTestHarness();
    harness.setProvider({ id: "openai" });

    await harness.probeEmbeddingAvailability();
    expect(harness.embedBatchWithRetry).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(EMBEDDING_PROBE_CACHE_TTL_MS - 1000);

    await harness.probeEmbeddingAvailability();
    expect(harness.embedBatchWithRetry).toHaveBeenCalledTimes(1);
  });

  it("updates cache when probe status changes after expiry", async () => {
    const harness = createProbeCacheTestHarness();
    harness.setProvider({ id: "openai" });
    harness.embedBatchWithRetry.mockRejectedValueOnce(new Error("rate limited"));

    const result1 = await harness.probeEmbeddingAvailability();
    expect(result1).toEqual({ ok: false, error: "rate limited" });

    vi.advanceTimersByTime(EMBEDDING_PROBE_CACHE_TTL_MS + 1);
    harness.embedBatchWithRetry.mockResolvedValueOnce([[0.1, 0.2]]);

    const result2 = await harness.probeEmbeddingAvailability();
    expect(result2).toEqual({ ok: true });
  });

  it("caches result correctly even when probe takes longer than TTL", async () => {
    const harness = createProbeCacheTestHarness();
    harness.setProvider({ id: "local" });

    // Simulate a slow probe that takes 60s (longer than 30s TTL)
    harness.embedBatchWithRetry.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(60_000);
      return [[0.1, 0.2, 0.3]];
    });

    const result1 = await harness.probeEmbeddingAvailability();
    expect(result1).toEqual({ ok: true });
    expect(harness.embedBatchWithRetry).toHaveBeenCalledTimes(1);

    // Second call should still use cache (TTL starts after probe completes)
    const result2 = await harness.probeEmbeddingAvailability();
    expect(result2).toEqual({ ok: true });
    expect(harness.embedBatchWithRetry).toHaveBeenCalledTimes(1);
  });
});
