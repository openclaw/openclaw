// Memory Core tests cover manager embedding policy plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  buildMemoryEmbeddingBatches,
  filterNonEmptyMemoryChunks,
  isRetryableMemoryEmbeddingError,
  isSplittableMemoryEmbeddingTransportError,
  isRateLimitMemoryEmbeddingError,
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

  it("detects rate-limit errors (429 / resource exhausted)", () => {
    expect(isRateLimitMemoryEmbeddingError("429 rate limit exceeded")).toBe(true);
    expect(isRateLimitMemoryEmbeddingError("resource has been exhausted")).toBe(true);
    expect(isRateLimitMemoryEmbeddingError("too many requests, try again later")).toBe(true);
    expect(isRateLimitMemoryEmbeddingError("rate_limit: token quota reached")).toBe(false);
    expect(isRateLimitMemoryEmbeddingError("fetch failed | other side closed")).toBe(false);
    expect(isRateLimitMemoryEmbeddingError("502 Bad Gateway (cloudflare)")).toBe(false);
    expect(isRateLimitMemoryEmbeddingError("too many tokens per day")).toBe(false);
    // Canonical Google-style RESOURCE_EXHAUSTED with rate-limit keyword
    expect(isRateLimitMemoryEmbeddingError("RESOURCE_EXHAUSTED: rate limit exceeded")).toBe(true);
    // Pure quota/billing RESOURCE_EXHAUSTED without rate-limit keyword
    expect(
      isRateLimitMemoryEmbeddingError(
        "RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details",
      ),
    ).toBe(false);
  });

  it("uses longer backoff for rate-limit errors when rateLimitBaseDelayMs is set", async () => {
    const run = vi.fn(async () => {
      throw new Error("openai embeddings failed: 429 rate limit");
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
        rateLimitBaseDelayMs: 30_000,
      }),
    ).rejects.toThrow("429 rate limit");

    expect(run).toHaveBeenCalledTimes(3);
    // 30s → 60s; the 3rd attempt (120s) throws before queuing a wait
    expect(waits).toEqual([30_000, 60_000]);
  });

  it("still uses short backoff for non-rate-limit retryable errors even when rateLimitBaseDelayMs is set", async () => {
    let calls = 0;
    const waits: number[] = [];

    const result = await runMemoryEmbeddingRetryLoop({
      run: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("TypeError: fetch failed | other side closed");
        }
        return "ok";
      },
      isRetryable: isRetryableMemoryEmbeddingError,
      waitForRetry: async (delayMs) => {
        waits.push(delayMs);
      },
      maxAttempts: 3,
      baseDelayMs: 500,
      rateLimitBaseDelayMs: 30_000,
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    // Transient network errors still use the normal 500ms base delay
    expect(waits).toEqual([500]);
  });

  it("uses longer backoff for rate-limit errors in batch retry — 429 is not splittable, so it throws", async () => {
    const waits: number[] = [];
    const run = vi.fn(async (items: string[]) => {
      if (items.length > 1) {
        throw new Error("gemini embeddings failed: 429 resource has been exhausted");
      }
      return items.map((item) => [item.charCodeAt(0)]);
    });

    await expect(
      runMemoryEmbeddingBatchRetryWithSplit({
        items: ["a", "b", "c"],
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        isSplittable: isSplittableMemoryEmbeddingTransportError,
        waitForRetry: async (delayMs) => {
          waits.push(delayMs);
        },
        maxAttempts: 2,
        baseDelayMs: 500,
        rateLimitBaseDelayMs: 30_000,
      }),
    ).rejects.toThrow("429 resource has been exhausted");

    expect(run).toHaveBeenCalledTimes(2);
    // 1 retry with rate-limit backoff before exhausting maxAttempts=2
    expect(waits).toEqual([30_000]);
  });

  it("uses longer backoff for Google-style RESOURCE_EXHAUSTED with rate-limit keyword", async () => {
    const run = vi.fn(async () => {
      throw new Error("RESOURCE_EXHAUSTED: rate limit exceeded");
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
        rateLimitBaseDelayMs: 30_000,
      }),
    ).rejects.toThrow("RESOURCE_EXHAUSTED");

    expect(run).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([30_000, 60_000]);
  });

  it("uses short backoff for RESOURCE_EXHAUSTED with quota message (not rate-limit)", async () => {
    const waits: number[] = [];

    await expect(
      runMemoryEmbeddingRetryLoop({
        run: async () => {
          throw new Error(
            "RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details",
          );
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (delayMs) => {
          waits.push(delayMs);
        },
        maxAttempts: 3,
        baseDelayMs: 500,
        rateLimitBaseDelayMs: 30_000,
      }),
    ).rejects.toThrow("RESOURCE_EXHAUSTED");

    // The quota message does not match isRetryableMemoryEmbeddingError,
    // so the error is thrown immediately without any retry wait.
    expect(waits).toEqual([]);
  });
});
