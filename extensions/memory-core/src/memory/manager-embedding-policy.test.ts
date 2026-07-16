// Memory Core tests cover manager embedding policy plugin behavior.
import { createServer } from "node:http";
import { createProviderHttpError } from "openclaw/plugin-sdk/provider-http";
import { describe, expect, it, vi } from "vitest";
import {
  buildMemoryEmbeddingBatches,
  createMemoryEmbeddingRetryCooldown,
  filterNonEmptyMemoryChunks,
  isRetryableMemoryEmbeddingError,
  isSplittableMemoryEmbeddingTransportError,
  resolveMemoryEmbeddingRetryAfterMs,
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
      maxDelayMs: 8000,
      random: () => 0.5,
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
        maxDelayMs: 8000,
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
      maxDelayMs: 8000,
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
      maxDelayMs: 8000,
      random: () => 0.5,
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
        maxDelayMs: 8000,
        random: () => 0.5,
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
      maxDelayMs: 8000,
      random: () => 0.5,
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
        maxDelayMs: 8000,
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
        maxDelayMs: 8000,
        random: () => 0.5,
      }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reads finite non-negative provider retry delays", () => {
    expect(resolveMemoryEmbeddingRetryAfterMs({ retryAfterMs: 1500 })).toBe(1500);
    expect(resolveMemoryEmbeddingRetryAfterMs({ retryAfterMs: -1 })).toBeUndefined();
    expect(resolveMemoryEmbeddingRetryAfterMs({ retryAfterMs: Number.NaN })).toBeUndefined();
    expect(resolveMemoryEmbeddingRetryAfterMs(new Error("429"))).toBeUndefined();
  });

  it("honors bounded provider retry delays", async () => {
    const run = vi.fn(async () => {
      if (run.mock.calls.length === 1) {
        throw Object.assign(new Error("gemini embeddings failed: 429"), {
          retryAfterMs: 5000,
        });
      }
      return "ok";
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
        maxDelayMs: 8000,
        retryAfterMs: resolveMemoryEmbeddingRetryAfterMs,
        random: () => 0,
      }),
    ).resolves.toBe("ok");

    expect(waits).toEqual([5000]);
  });

  it("waits for Google RetryInfo before retrying an HTTP request", async () => {
    const requestTimes: number[] = [];
    const server = createServer((_request, response) => {
      requestTimes.push(Date.now());
      if (requestTimes.length === 1) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              message: "Quota exceeded",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.RetryInfo",
                  retryDelay: "1s",
                },
              ],
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test server did not expose a TCP address");
      }
      const cooldown = createMemoryEmbeddingRetryCooldown();
      const result = await runMemoryEmbeddingRetryLoop({
        run: async () => {
          const response = await fetch(`http://127.0.0.1:${address.port}/embed`);
          if (!response.ok) {
            throw await createProviderHttpError(response, "gemini embeddings failed");
          }
          return "ok";
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (delayMs) => await cooldown.wait(delayMs),
        maxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 2000,
        retryAfterMs: resolveMemoryEmbeddingRetryAfterMs,
        onRetry: (error) => cooldown.publish(resolveMemoryEmbeddingRetryAfterMs(error)),
        random: () => 0,
      });

      expect(result).toBe("ok");
      expect(requestTimes).toHaveLength(2);
      expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(1000);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails promptly when a provider retry delay exceeds the bounded wait", async () => {
    const error = Object.assign(new Error("gemini embeddings failed: 429"), {
      retryAfterMs: 120_000,
    });
    const run = vi.fn(async () => {
      throw error;
    });
    const waitForRetry = vi.fn(async () => {});

    await expect(
      runMemoryEmbeddingRetryLoop({
        run,
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry,
        maxAttempts: 7,
        baseDelayMs: 1000,
        maxDelayMs: 60_000,
        retryAfterMs: resolveMemoryEmbeddingRetryAfterMs,
      }),
    ).rejects.toBe(error);

    expect(run).toHaveBeenCalledTimes(1);
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it("extends concurrent waiters to the longest shared cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const cooldown = createMemoryEmbeddingRetryCooldown();
      let firstFinished = false;
      cooldown.publish(100);
      const first = cooldown.wait(100).then(() => {
        firstFinished = true;
      });

      await vi.advanceTimersByTimeAsync(50);
      cooldown.publish(200);
      const second = cooldown.wait(200);
      await vi.advanceTimersByTimeAsync(50);

      expect(firstFinished).toBe(false);
      await vi.advanceTimersByTimeAsync(150);
      await Promise.all([first, second]);
      expect(firstFinished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gates new attempts behind a published cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const cooldown = createMemoryEmbeddingRetryCooldown();
      cooldown.publish(200);
      let started = false;
      const attempt = cooldown.wait(0).then(() => {
        started = true;
      });

      await vi.advanceTimersByTimeAsync(199);
      expect(started).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await attempt;
      expect(started).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps per-waiter jitter independent when the provider gives no cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const cooldown = createMemoryEmbeddingRetryCooldown();
      let firstFinished = false;
      let secondFinished = false;
      const first = cooldown.wait(100).then(() => {
        firstFinished = true;
      });
      await vi.advanceTimersByTimeAsync(50);
      const second = cooldown.wait(200).then(() => {
        secondFinished = true;
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(firstFinished).toBe(true);
      expect(secondFinished).toBe(false);
      await vi.advanceTimersByTimeAsync(150);
      await Promise.all([first, second]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a shared cooldown wait with its caller", async () => {
    const cooldown = createMemoryEmbeddingRetryCooldown();
    const controller = new AbortController();
    const waiting = cooldown.wait(60_000, controller.signal);

    controller.abort(new Error("memory search cancelled"));

    await expect(waiting).rejects.toThrow("aborted");
  });
});
