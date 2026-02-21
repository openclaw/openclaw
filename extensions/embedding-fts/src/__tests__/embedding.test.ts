import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createNoopEmbeddingProvider,
  createHashEmbeddingProvider,
  withRetryBackoff,
  probeEmbeddingAvailability,
  isDimMismatch,
  type EmbeddingProvider,
} from "../src/embedding.js";

describe("noop embedding provider", () => {
  it("returns empty vectors", async () => {
    const p = createNoopEmbeddingProvider();
    expect(p.id).toBe("none");
    expect(p.dim).toBe(0);
    const q = await p.embedQuery("hello");
    expect(q).toEqual([]);
    const b = await p.embedBatch(["a", "b"]);
    expect(b).toEqual([[], []]);
  });
});

describe("hash embedding provider", () => {
  it("produces deterministic vectors of specified dim", async () => {
    const p = createHashEmbeddingProvider(64);
    expect(p.id).toBe("hash");
    expect(p.dim).toBe(64);
    const v1 = await p.embedQuery("hello world");
    const v2 = await p.embedQuery("hello world");
    expect(v1).toEqual(v2);
    expect(v1).toHaveLength(64);
  });

  it("L2-normalizes output", async () => {
    const p = createHashEmbeddingProvider(128);
    const v = await p.embedQuery("test text for normalization");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it("batch returns one vector per input", async () => {
    const p = createHashEmbeddingProvider(32);
    const batch = await p.embedBatch(["a", "b", "c"]);
    expect(batch).toHaveLength(3);
    for (const v of batch) {
      expect(v).toHaveLength(32);
    }
  });
});

describe("withRetryBackoff", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries on 429 error and succeeds", async () => {
    let calls = 0;
    const base: EmbeddingProvider = {
      id: "test",
      model: "test",
      dim: 3,
      embedQuery: async () => {
        calls++;
        if (calls < 3) {
          throw new Error("429 Too Many Requests");
        }
        return [1, 2, 3];
      },
      embedBatch: async () => [],
    };
    const retried = withRetryBackoff(base, { baseDelayMs: 10, maxAttempts: 3 });
    const result = await retried.embedQuery("hi");
    expect(result).toEqual([1, 2, 3]);
    expect(calls).toBe(3);
  });

  it("throws non-rate-limit errors immediately", async () => {
    const base: EmbeddingProvider = {
      id: "test",
      model: "test",
      dim: 3,
      embedQuery: async () => {
        throw new Error("auth failed");
      },
      embedBatch: async () => [],
    };
    const retried = withRetryBackoff(base, { baseDelayMs: 10, maxAttempts: 3 });
    await expect(retried.embedQuery("hi")).rejects.toThrow("auth failed");
  });
});

describe("probeEmbeddingAvailability", () => {
  it("ok when provider returns real vectors", async () => {
    const p = createHashEmbeddingProvider(64);
    const r = await probeEmbeddingAvailability(p);
    expect(r.ok).toBe(true);
    expect(r.dim).toBe(64);
  });

  it("not ok when provider returns empty vectors", async () => {
    const p = createNoopEmbeddingProvider();
    const r = await probeEmbeddingAvailability(p);
    expect(r.ok).toBe(false);
    expect(r.dim).toBe(0);
  });
});

describe("isDimMismatch", () => {
  it("detects mismatch", () => {
    expect(isDimMismatch(384, 768)).toBe(true);
  });

  it("ignores zero dims", () => {
    expect(isDimMismatch(0, 384)).toBe(false);
    expect(isDimMismatch(384, 0)).toBe(false);
  });

  it("no mismatch when equal", () => {
    expect(isDimMismatch(384, 384)).toBe(false);
  });
});
