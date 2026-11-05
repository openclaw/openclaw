// Memory Core tests cover provider-owned non-batch index concurrency.
import { expect, it } from "vitest";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";

type IndexGeneration = {
  kind: "semantic" | "fts-only";
  runtime?: { inlineIndexConcurrency?: number };
};

function getIndexConcurrency(
  inlineIndexConcurrency?: number,
  syncProviderGeneration?: IndexGeneration,
  batch = { enabled: false, concurrency: 8 },
): number {
  const manager = Object.assign(Object.create(MemoryManagerEmbeddingOps.prototype), {
    batch,
    provider: { id: "openai-compatible" },
    providerRuntime: { id: "openai-compatible", inlineIndexConcurrency },
    syncProviderGeneration,
  }) as { getIndexConcurrency: () => number };
  return manager.getIndexConcurrency();
}

it.each([1, 3])("uses provider-declared index concurrency %s", (declared) => {
  expect(getIndexConcurrency(declared)).toBe(declared);
});

it.each([undefined, 0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "keeps the host default for omitted or invalid index concurrency %s",
  (declared) => expect(getIndexConcurrency(declared)).toBe(4),
);

it.each<[IndexGeneration, number]>([
  [{ kind: "semantic", runtime: { inlineIndexConcurrency: 2 } }, 2],
  [{ kind: "semantic" }, 4],
  [{ kind: "fts-only" }, 4],
])("uses only the active sync generation's runtime: %j", (generation, expected) => {
  expect(getIndexConcurrency(1, generation)).toBe(expected);
});

it("keeps batch concurrency independent of the inline declaration", () => {
  expect(getIndexConcurrency(1, undefined, { enabled: true, concurrency: 3 })).toBe(3);
});
