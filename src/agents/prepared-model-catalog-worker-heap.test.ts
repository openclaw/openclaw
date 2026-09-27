import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCatalogWorkerHeapLimit,
  CATALOG_WORKER_HEAP_LIMIT_MB,
} from "./prepared-model-catalog-worker-heap.js";

describe("catalog worker retained heap", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("rejects retained overflow when a process-wide heap flag overrides resourceLimits", () => {
    vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=4096");
    expect(() =>
      assertCatalogWorkerHeapLimit((CATALOG_WORKER_HEAP_LIMIT_MB + 1) * 1024 * 1024),
    ).toThrow("catalog worker exceeded its retained heap limit");
  });

  it("recognizes Node's underscore heap-flag spelling", () => {
    vi.stubEnv("NODE_OPTIONS", "--max_old_space_size=4096");
    expect(() =>
      assertCatalogWorkerHeapLimit((CATALOG_WORKER_HEAP_LIMIT_MB + 1) * 1024 * 1024),
    ).toThrow("catalog worker exceeded its retained heap limit");
  });

  it("keeps the ordinary Worker resource limit as the owner without a process override", () => {
    vi.stubEnv("NODE_OPTIONS", "");
    expect(() => assertCatalogWorkerHeapLimit(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });
});
