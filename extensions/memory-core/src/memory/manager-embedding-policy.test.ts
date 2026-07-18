// Memory Core tests cover manager embedding policy plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  buildMemoryEmbeddingBatches,
  filterNonEmptyMemoryChunks,
  isRetryableMemoryEmbeddingError,
  isSplittableMemoryEmbeddingTransportError,
  resolveMemoryEmbeddingRetryDelay,
  runMemoryEmbeddingBatchRetryWithSplit,
  runMemoryEmbeddingRetryLoop,
} from "./manager-embedding-policy.js";

function chunk(text: string) {
  return {
    startLine: 1,
    endLine: 1,
    text,
    hash: text,
  };
}

describe("memory embedding policy", () => {
  it("splits large files across multiple embedding batches", () => {
    const line = "a".repeat(4200);
    const batches = buildMemoryEmbeddingBatches([chunk(line), chunk(line)], 8000);

    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
  });

  it("keeps small files in a single embedding batch", () => {
    const line = "b".repeat(120);
    const batches = buildMemoryEmbeddingBatches(
      [chunk(line), chunk(line), chunk(line), chunk(line)],
      8000,
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(4);
  });

  it("filters empty chunks before embedding", () => {
    const chunks = filterNonEmptyMemoryChunks([chunk("\n\n"), chunk("hello"), chunk("   ")]);

    expect(chunks.map((entry) => entry.text)).toEqual(["hello"]);
  });

  it("retries transient rate limit and 5xx errors", async () => {
    const run = vi.fn(async () => {
      const call = run.mock.calls.length;
      if (call === 1) {
        throw new Error("openai embeddings failed: 429 rate limit");
      }
      if (call === 2) {
        throw new Error("openai embeddings failed: 502 Bad Gateway (cloudflare)");
      }
      return "ok";
    });
    const waits: number[] = [];

    const result = await runMemoryEmbeddingRetryLoop({
      run,
      isRetryable: isRetryableMemoryEmbeddingError,
      waitForRetry: async (delayMs) => {
        waits.push(delayMs);
      },
      maxAttempts: 3,
      baseDelayMs: 500,
    });

    expect(result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("stops retrying after the caller signal aborts, even for retryable-looking errors", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort(new Error("memory_search timed out after 15s"));
      // "timed out" matches the retryable transport pattern; abort must still win.
      throw new Error("memory embeddings query timed out after 60s");
    });
    const waitForRetry = vi.fn(async () => {});

    await expect(
      runMemoryEmbeddingRetryLoop({
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry,
        maxAttempts: 3,
        baseDelayMs: 500,
        signal: controller.signal,
      }),
    ).rejects.toThrow("memory embeddings query timed out after 60s");

    expect(run).toHaveBeenCalledTimes(1);
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it("retries transient socket/network embedding errors", () => {
    const splittableMessages = [
      "TypeError: fetch failed | other side closed",
      "undici error: UND_ERR_SOCKET",
      "read ECONNRESET",
      "socket hang up",
    ];

    for (const message of splittableMessages) {
      expect(isRetryableMemoryEmbeddingError(message)).toBe(true);
      expect(isSplittableMemoryEmbeddingTransportError(message)).toBe(true);
    }
    expect(isRetryableMemoryEmbeddingError("ECONNREFUSED")).toBe(true);
    expect(isSplittableMemoryEmbeddingTransportError("ECONNREFUSED")).toBe(false);
    expect(isRetryableMemoryEmbeddingError("EHOSTUNREACH")).toBe(true);
    expect(isSplittableMemoryEmbeddingTransportError("EHOSTUNREACH")).toBe(false);
    expect(isRetryableMemoryEmbeddingError("memory embeddings batch timed out")).toBe(true);
    expect(isSplittableMemoryEmbeddingTransportError("memory embeddings batch timed out")).toBe(
      false,
    );
    expect(isRetryableMemoryEmbeddingError("worker terminated by user")).toBe(false);
    expect(isRetryableMemoryEmbeddingError("embedding validation failed")).toBe(false);
  });

  it("splits OpenAI 431 oversized embedding batches without retrying the same request", async () => {
    const run = vi.fn(async (items: string[]) => {
      if (items.length > 1) {
        throw new Error(
          "openai embeddings failed: 431 request_headers_too_large: Request Header Fields Too Large",
        );
      }
      return items.map((item) => [item.charCodeAt(0)]);
    });

    const result = await runMemoryEmbeddingBatchRetryWithSplit({
      items: ["a", "b", "c", "d"],
      run,
      isRetryable: isRetryableMemoryEmbeddingError,
      isSplittable: isSplittableMemoryEmbeddingTransportError,
      waitForRetry: async () => {},
      maxAttempts: 3,
      baseDelayMs: 500,
    });

    expect(result).toEqual([[97], [98], [99], [100]]);
    expect(run.mock.calls.map(([items]) => items.length)).toEqual([4, 2, 1, 1, 2, 1, 1]);
    expect(isRetryableMemoryEmbeddingError("431 request_headers_too_large")).toBe(false);
    expect(isSplittableMemoryEmbeddingTransportError("431 request_headers_too_large")).toBe(true);
    expect(
      isSplittableMemoryEmbeddingTransportError("embedding validation failed at item 4312"),
    ).toBe(false);
  });

  it("retries too-many-tokens-per-day errors", async () => {
    let calls = 0;
    const waits: number[] = [];

    const result = await runMemoryEmbeddingRetryLoop({
      run: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("AWS Bedrock embeddings failed: Too many tokens per day");
        }
        return "ok";
      },
      isRetryable: isRetryableMemoryEmbeddingError,
      waitForRetry: async (delayMs) => {
        waits.push(delayMs);
      },
      maxAttempts: 3,
      baseDelayMs: 500,
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(waits).toEqual([500]);
  });

  it("stops after the configured maximum attempts", async () => {
    const run = vi.fn(async () => {
      throw new Error("TypeError: fetch failed | other side closed");
    });
    const waits: number[] = [];

    await expect(
      runMemoryEmbeddingRetryLoop({
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (delayMs) => {
          waits.push(delayMs);
        },
        maxAttempts: 3,
        baseDelayMs: 500,
      }),
    ).rejects.toThrow("fetch failed");

    expect(run).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("splits transport-failed batches after retries are exhausted", async () => {
    const waits: number[] = [];
    const splits: string[] = [];
    const run = vi.fn(async (items: string[]) => {
      if (items.length > 1) {
        throw new TypeError("fetch failed | other side closed");
      }
      return items.map((item) => [item.charCodeAt(0)]);
    });

    const result = await runMemoryEmbeddingBatchRetryWithSplit({
      items: ["a", "b", "c", "d"],
      run,
      isRetryable: isRetryableMemoryEmbeddingError,
      isSplittable: isSplittableMemoryEmbeddingTransportError,
      waitForRetry: async (delayMs) => {
        waits.push(delayMs);
      },
      maxAttempts: 2,
      baseDelayMs: 500,
      onSplit: ({ itemCount, splitAt }) => {
        splits.push(`${itemCount}:${splitAt}`);
      },
    });

    expect(result).toEqual([[97], [98], [99], [100]]);
    expect(run.mock.calls.map(([items]) => items.length)).toEqual([4, 4, 2, 2, 1, 1, 2, 2, 1, 1]);
    expect(waits).toEqual([500, 500, 500]);
    expect(splits).toEqual(["4:2", "2:1", "2:1"]);
  });

  it("does not split exhausted service retry errors", async () => {
    const run = vi.fn(async () => {
      throw new Error("openai embeddings failed: 429 rate limit");
    });

    await expect(
      runMemoryEmbeddingBatchRetryWithSplit({
        items: ["a", "b"],
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        isSplittable: isSplittableMemoryEmbeddingTransportError,
        waitForRetry: async () => {},
        maxAttempts: 1,
        baseDelayMs: 500,
      }),
    ).rejects.toThrow("429 rate limit");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not split whole-endpoint transport outages", async () => {
    const run = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    });

    await expect(
      runMemoryEmbeddingBatchRetryWithSplit({
        items: ["a", "b"],
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        isSplittable: isSplittableMemoryEmbeddingTransportError,
        waitForRetry: async () => {},
        maxAttempts: 2,
        baseDelayMs: 500,
      }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("caps retry jittered delays", () => {
    expect(resolveMemoryEmbeddingRetryDelay(500, 0, 8000)).toBe(500);
    expect(resolveMemoryEmbeddingRetryDelay(500, 1, 8000)).toBe(600);
    expect(resolveMemoryEmbeddingRetryDelay(10_000, 1, 8000)).toBe(8000);
  });

  describe("rate-limit detection (behavior)", () => {
    it("classifies 429 / rate-limit / quota-exhaustion as rate-limit → long backoff", async () => {
      const messages = [
        "429 rate limit exceeded",
        "too many requests: rate limit",
        "resource has been exhausted",
        "tokens per day exceeded",
        "Rate_Limit error from provider",
      ];
      for (const msg of messages) {
        let calls = 0;
        const waits: number[] = [];
        await runMemoryEmbeddingRetryLoop({
          run: async () => {
            calls += 1;
            if (calls === 1) {
              throw new Error(msg);
            }
            return "ok";
          },
          isRetryable: isRetryableMemoryEmbeddingError,
          waitForRetry: async (d) => {
            waits.push(d);
          },
          maxAttempts: 3,
          baseDelayMs: 500,
          rateLimitBaseDelayMs: 10_000,
          rateLimitMaxDelayMs: 60_000,
        });
        expect(waits, `"${msg}" should use long backoff`).toEqual([10_000]);
      }
    });

    it("does NOT classify 5xx / transport errors as rate-limit → standard backoff", async () => {
      const messages = ["502 Bad Gateway", "fetch failed | ECONNRESET", "socket hang up"];
      for (const msg of messages) {
        let calls = 0;
        const waits: number[] = [];
        await runMemoryEmbeddingRetryLoop({
          run: async () => {
            calls += 1;
            if (calls === 1) {
              throw new Error(msg);
            }
            return "ok";
          },
          isRetryable: isRetryableMemoryEmbeddingError,
          waitForRetry: async (d) => {
            waits.push(d);
          },
          maxAttempts: 3,
          baseDelayMs: 500,
          rateLimitBaseDelayMs: 10_000,
          rateLimitMaxDelayMs: 60_000,
        });
        expect(waits, `"${msg}" should use standard backoff`).toEqual([500]);
      }
    });
  });

  describe("rate-limit backoff", () => {
    it("uses longer backoff for 429 rate-limit errors", async () => {
      let calls = 0;
      const waits: number[] = [];

      const result = await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls <= 2) {
            throw new Error("openai embeddings failed: 429 rate limit");
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (delayMs) => {
          waits.push(delayMs);
        },
        maxAttempts: 3,
        baseDelayMs: 500,
        rateLimitBaseDelayMs: 10_000,
        rateLimitMaxDelayMs: 60_000,
      });

      expect(result).toBe("ok");
      expect(calls).toBe(3);
      // Rate-limit backoff: 10s, 20s (not the default 500ms, 1000ms)
      expect(waits).toEqual([10_000, 20_000]);
    });

    it("uses standard backoff for non-rate-limit transport errors", async () => {
      let calls = 0;
      const waits: number[] = [];

      const result = await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls <= 2) {
            throw new Error("fetch failed | ECONNRESET");
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (delayMs) => {
          waits.push(delayMs);
        },
        maxAttempts: 3,
        baseDelayMs: 500,
        rateLimitBaseDelayMs: 10_000,
        rateLimitMaxDelayMs: 60_000,
      });

      expect(result).toBe("ok");
      expect(calls).toBe(3);
      // Transport backoff: standard exponential (500ms, 1000ms)
      expect(waits).toEqual([500, 1000]);
    });

    it("caps rate-limit backoff at maxDelayMs", async () => {
      let calls = 0;
      const waits: number[] = [];

      await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls <= 4) {
            throw new Error("429 rate limit");
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (delayMs) => {
          waits.push(delayMs);
        },
        maxAttempts: 5,
        baseDelayMs: 500,
        rateLimitBaseDelayMs: 10_000,
        rateLimitMaxDelayMs: 30_000,
      });

      // With base 10s: 10s, 20s, 40s→capped 30s, 80s→capped 30s
      expect(waits).toEqual([10_000, 20_000, 30_000, 30_000]);
    });

    it("falls back to standard delay when rateLimitBaseDelayMs is not set", async () => {
      let calls = 0;
      const waits: number[] = [];

      const result = await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("429 rate limit");
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (delayMs) => {
          waits.push(delayMs);
        },
        maxAttempts: 3,
        baseDelayMs: 500,
      });

      expect(result).toBe("ok");
      // Without rateLimitBaseDelayMs, falls back to standard baseDelayMs
      expect(waits).toEqual([500]);
    });

    it("honors structured retryAfterSeconds from error object", async () => {
      let calls = 0;
      const waits: number[] = [];

      const result = await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls === 1) {
            const err = Object.assign(new Error("429 rate limit"), { retryAfterSeconds: 30 });
            throw err;
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (delayMs) => {
          waits.push(delayMs);
        },
        maxAttempts: 3,
        baseDelayMs: 500,
        rateLimitBaseDelayMs: 10_000,
        rateLimitMaxDelayMs: 60_000,
        extractRetryAfterMs: (err) => {
          const ra = (err as { retryAfterSeconds?: number }).retryAfterSeconds;
          return ra ? ra * 1000 : undefined;
        },
      });

      expect(result).toBe("ok");
      // 30s Retry-After > computed 10s → overrides to 30s
      expect(waits).toEqual([30_000]);
    });

    it("keeps computed backoff when Retry-After is shorter", async () => {
      let calls = 0;
      const waits: number[] = [];

      const result = await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls <= 2) {
            const err = Object.assign(new Error("429 rate limit"), { retryAfterSeconds: 5 });
            throw err;
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (delayMs) => {
          waits.push(delayMs);
        },
        maxAttempts: 3,
        baseDelayMs: 500,
        rateLimitBaseDelayMs: 10_000,
        rateLimitMaxDelayMs: 60_000,
        extractRetryAfterMs: (err) => {
          const ra = (err as { retryAfterSeconds?: number }).retryAfterSeconds;
          return ra ? ra * 1000 : undefined;
        },
      });

      expect(result).toBe("ok");
      // 5s Retry-After < computed 10s/20s → keeps computed
      expect(waits).toEqual([10_000, 20_000]);
    });

    it("caps Retry-After override at rateLimitMaxDelayMs", async () => {
      let calls = 0;
      const waits: number[] = [];

      await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls <= 4) {
            const err = Object.assign(new Error("429 rate limit"), { retryAfterSeconds: 120 });
            throw err;
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (delayMs) => {
          waits.push(delayMs);
        },
        maxAttempts: 5,
        baseDelayMs: 500,
        rateLimitBaseDelayMs: 10_000,
        rateLimitMaxDelayMs: 60_000,
        extractRetryAfterMs: (err) => {
          const ra = (err as { retryAfterSeconds?: number }).retryAfterSeconds;
          return ra ? ra * 1000 : undefined;
        },
      });

      // 120s Retry-After → capped at 60s each time
      expect(waits).toEqual([60_000, 60_000, 60_000, 60_000]);
    });
  });

  describe("production budget regression", () => {
    it("rate-limit schedule clears a 60s cooldown window", async () => {
      // Production constants: base=10s, cap=60s, 5 attempts.
      // Schedule: 10s, 20s, 40s, 60s, 60s = 190s span.
      const PROD_BASE = 10_000;
      const PROD_CAP = 60_000;
      const PROD_ATTEMPTS = 5;
      const expectedDelays = [10_000, 20_000, 40_000, 60_000];

      let calls = 0;
      const waits: number[] = [];

      await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls <= 4) {
            throw new Error("429 rate limit");
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (d) => {
          waits.push(d);
        },
        maxAttempts: PROD_ATTEMPTS,
        baseDelayMs: 500,
        rateLimitBaseDelayMs: PROD_BASE,
        rateLimitMaxDelayMs: PROD_CAP,
      });

      expect(calls).toBe(5);
      expect(waits).toEqual(expectedDelays);
      // Total wait must exceed the typical 60s rate-limit window.
      const totalWait = waits.reduce((a, b) => a + b, 0);
      expect(totalWait).toBeGreaterThan(60_000);
    });

    it("transport errors stay on the original budget", async () => {
      const TRANSPORT_ATTEMPTS = 3;
      const expectedDelays = [500, 1000];

      let calls = 0;
      const waits: number[] = [];

      await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls <= 2) {
            throw new Error("fetch failed | ECONNRESET");
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (d) => {
          waits.push(d);
        },
        maxAttempts: TRANSPORT_ATTEMPTS,
        baseDelayMs: 500,
        rateLimitBaseDelayMs: 10_000,
        rateLimitMaxDelayMs: 60_000,
        rateLimitMaxAttempts: 5,
      });

      expect(calls).toBe(3);
      expect(waits).toEqual(expectedDelays);
    });

    it("rate-limit uses separate maxAttempts budget", async () => {
      // Transport: 3 attempts. Rate-limit: 5 attempts.
      // With rateLimitMaxAttempts=5, rate-limit errors get 5 retries
      // instead of the shared 3.
      let calls = 0;
      const waits: number[] = [];

      await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls <= 4) {
            throw new Error("429 rate limit");
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (d) => {
          waits.push(d);
        },
        maxAttempts: 3, // transport ceiling
        baseDelayMs: 500,
        rateLimitBaseDelayMs: 10_000,
        rateLimitMaxDelayMs: 60_000,
        rateLimitMaxAttempts: 5, // rate-limit ceiling
      });

      expect(calls).toBe(5);
      expect(waits).toEqual([10_000, 20_000, 40_000, 60_000]);
    });
  });

  describe("production caller configuration regression", () => {
    // Mirrors the exact constants wired in manager-embedding-ops.ts call sites.
    const PROD = {
      maxAttempts: 3, // EMBEDDING_RETRY_MAX_ATTEMPTS
      baseDelayMs: 500, // EMBEDDING_RETRY_BASE_DELAY_MS
      rateLimitBaseDelayMs: 10_000, // EMBEDDING_RATE_LIMIT_BASE_DELAY_MS
      rateLimitMaxDelayMs: 60_000, // EMBEDDING_RATE_LIMIT_MAX_DELAY_MS
      rateLimitMaxAttempts: 5, // EMBEDDING_RATE_LIMIT_MAX_ATTEMPTS
    };

    // Mirrors extractEmbeddingRetryAfterMs from manager-embedding-ops.ts.
    function prodExtractRetryAfterMs(err: unknown): number | undefined {
      const ra = (err as { retryAfterSeconds?: number } | null | undefined)?.retryAfterSeconds;
      if (typeof ra === "number" && ra > 0) {
        return ra * 1000;
      }
      const msg = (err as { message?: string } | null | undefined)?.message ?? "";
      const m = msg.match(/retry[_ ]after[:\s]+(\d+)\s*s/i);
      if (m?.[1] !== undefined) {
        return Number.parseInt(m[1], 10) * 1000;
      }
      return undefined;
    }

    it("rate-limit with production config survives the 60s cooldown window", async () => {
      // The production budget gives rate-limit errors 5 attempts spanning
      // ~190s.  The total wait must exceed 60s to clear a typical window.
      let calls = 0;
      const waits: number[] = [];
      const t0 = Date.now();

      await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls <= 4) {
            throw new Error("openai embeddings failed: 429 rate limit exceeded");
          }
          return "embedded";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (d) => {
          waits.push(d);
        },
        maxAttempts: PROD.maxAttempts,
        baseDelayMs: PROD.baseDelayMs,
        rateLimitBaseDelayMs: PROD.rateLimitBaseDelayMs,
        rateLimitMaxDelayMs: PROD.rateLimitMaxDelayMs,
        rateLimitMaxAttempts: PROD.rateLimitMaxAttempts,
        extractRetryAfterMs: prodExtractRetryAfterMs,
      });

      const elapsed = Date.now() - t0;
      const totalWait = waits.reduce((a, b) => a + b, 0);

      // 5 total calls: 4 failures + 1 success.
      expect(calls).toBe(5);
      // Schedule: 10s, 20s, 40s, 60s.
      expect(waits).toEqual([10_000, 20_000, 40_000, 60_000]);
      // Aggregate wait clears a 60s rate-limit window.
      expect(totalWait).toBeGreaterThan(60_000);
      expect(totalWait).toBeLessThanOrEqual(200_000);
      // Elapsed wall time is capped at ~200ms per wait in tests.
      expect(elapsed).toBeLessThan(5000);
    });

    it("transport errors use production transport budget (unchanged)", async () => {
      let calls = 0;
      const waits: number[] = [];

      await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls <= 2) {
            throw new Error("fetch failed | ECONNRESET");
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (d) => {
          waits.push(d);
        },
        maxAttempts: PROD.maxAttempts,
        baseDelayMs: PROD.baseDelayMs,
        rateLimitBaseDelayMs: PROD.rateLimitBaseDelayMs,
        rateLimitMaxDelayMs: PROD.rateLimitMaxDelayMs,
        rateLimitMaxAttempts: PROD.rateLimitMaxAttempts,
        extractRetryAfterMs: prodExtractRetryAfterMs,
      });

      // Transport: 3 attempts, 500ms schedule, unchanged by rate-limit params.
      expect(calls).toBe(3);
      expect(waits).toEqual([500, 1000]);
    });

    it("production extractor honors structured retryAfterSeconds on error", async () => {
      let calls = 0;
      const waits: number[] = [];

      await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls === 1) {
            const err = Object.assign(new Error("429 rate limit"), { retryAfterSeconds: 45 });
            throw err;
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (d) => {
          waits.push(d);
        },
        maxAttempts: PROD.maxAttempts,
        baseDelayMs: PROD.baseDelayMs,
        rateLimitBaseDelayMs: PROD.rateLimitBaseDelayMs,
        rateLimitMaxDelayMs: PROD.rateLimitMaxDelayMs,
        rateLimitMaxAttempts: PROD.rateLimitMaxAttempts,
        extractRetryAfterMs: prodExtractRetryAfterMs,
      });

      // 45s Retry-After > computed 10s → overrides.
      expect(waits).toEqual([45_000]);
    });
  });

  describe("batch timeout alignment", () => {
    it("all 5 rate-limit attempts are reachable (per-attempt timeout not cumulative)", async () => {
      // The batch timeout is per-attempt (EMBEDDING_BATCH_TIMEOUT_REMOTE_MS =
      // 120s). Each retry starts a fresh timer. A 429 response takes ~100ms,
      // so the timeout is never at risk. The retry budget spans ~190s across
      // waits, but since waits happen *between* timed attempts, the cumulative
      // wait time does not count against any single attempt's deadline.
      let calls = 0;
      const waits: number[] = [];

      await runMemoryEmbeddingRetryLoop({
        run: async () => {
          calls += 1;
          if (calls <= 4) {
            throw new Error("429 rate limit exceeded");
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (d) => {
          waits.push(d);
        },
        maxAttempts: 3,
        baseDelayMs: 500,
        rateLimitBaseDelayMs: 10_000,
        rateLimitMaxDelayMs: 60_000,
        rateLimitMaxAttempts: 5,
      });

      // All 5 attempts execute — the rate-limit budget fully runs.
      expect(calls).toBe(5);
      expect(waits).toEqual([10_000, 20_000, 40_000, 60_000]);
      // Each delay is below the 120s per-attempt timeout.
      for (const w of waits) {
        expect(w).toBeLessThanOrEqual(60_000);
      }
    });
  });
});
