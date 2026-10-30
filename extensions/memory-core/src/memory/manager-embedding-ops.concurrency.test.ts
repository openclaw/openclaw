// Memory Core tests cover manager non-batch index concurrency policy behavior.
import { describe, expect, it } from "vitest";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";

type IndexConcurrencyHarness = { getIndexConcurrency: () => number };

// Exercise the real concurrency policy without opening a memory index or
// acquiring an external embedding provider (same seam as
// manager-embedding-ops.retry.test.ts).
function createIndexConcurrencyHarness(params: {
  providerId: string;
  inlineIndexConcurrency?: number;
  batch?: { enabled: boolean; concurrency: number };
  /** Full rebuilds resolve the runtime through an active sync generation instead. */
  generationInlineIndexConcurrency?: number;
}): IndexConcurrencyHarness {
  const runtime = (inlineIndexConcurrency?: number) => ({
    id: params.providerId,
    ...(inlineIndexConcurrency === undefined ? {} : { inlineIndexConcurrency }),
  });
  const provider = { id: params.providerId, model: `${params.providerId}-model` };
  return Object.assign(Object.create(MemoryManagerEmbeddingOps.prototype), {
    batch: params.batch ?? { enabled: false, concurrency: 8 },
    provider,
    providerRuntime: runtime(params.inlineIndexConcurrency),
    syncProviderGeneration:
      params.generationInlineIndexConcurrency === undefined
        ? undefined
        : {
            kind: "semantic",
            provider,
            runtime: runtime(params.generationInlineIndexConcurrency),
          },
  }) as IndexConcurrencyHarness;
}

describe("memory index concurrency", () => {
  it("uses the concurrency the provider runtime declares", () => {
    expect(
      createIndexConcurrencyHarness({
        providerId: "openai-compatible",
        inlineIndexConcurrency: 1,
      }).getIndexConcurrency(),
    ).toBe(1);
  });

  it("keeps the parallel default when the provider declares none", () => {
    expect(createIndexConcurrencyHarness({ providerId: "openai" }).getIndexConcurrency()).toBe(4);
  });

  it("uses the active sync generation's runtime during a full rebuild", () => {
    expect(
      createIndexConcurrencyHarness({
        providerId: "openai-compatible",
        generationInlineIndexConcurrency: 1,
      }).getIndexConcurrency(),
    ).toBe(1);
  });

  it("keeps the batch concurrency when batch embedding is enabled", () => {
    expect(
      createIndexConcurrencyHarness({
        providerId: "local",
        inlineIndexConcurrency: 1,
        batch: { enabled: true, concurrency: 3 },
      }).getIndexConcurrency(),
    ).toBe(3);
  });
});
