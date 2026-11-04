// Memory Core tests cover manager embedding policy plugin behavior.
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import {
  buildMemoryEmbeddingBatches,
  formatMemoryEmbeddingProbeError,
  runMemoryEmbeddingBatchRetryWithSplit,
  runMemoryEmbeddingRetryLoop,
} from "./manager-embedding-policy.js";

it.each([
  new Error("HTTP 401 without structured status"),
  Object.assign(new Error("model 401 unavailable"), { status: 503 }),
])("preserves probe errors that do not report an authentication status: %s", (error) => {
  expect(formatMemoryEmbeddingProbeError(error)).toBe(error.message);
});

function expectDelayBetween(delayMs: number | undefined, min: number, max: number): void {
  expect(delayMs).toBeGreaterThanOrEqual(min);
  expect(delayMs).toBeLessThanOrEqual(max);
}

/** Capture actual retry settlement, provider calls, and delay receipts. */
async function expectRetryAttempts(
  scenario: string | Error | readonly (Error | "ok")[],
  expectedCalls: number,
  profile: "index" | "query" = "index",
): Promise<number[]> {
  const outcomes =
    typeof scenario === "string"
      ? [new Error(scenario)]
      : scenario instanceof Error
        ? [scenario]
        : scenario;
  const run = vi.fn<() => Promise<string>>();
  for (const outcome of outcomes) {
    if (outcome instanceof Error) {
      run.mockRejectedValueOnce(outcome);
    } else {
      run.mockResolvedValueOnce(outcome);
    }
  }
  const last = outcomes.at(-1);
  if (last instanceof Error) {
    run.mockRejectedValue(last);
  }
  const waits: number[] = [];
  const waitForRetry = vi.fn(async (delayMs: number) => void waits.push(delayMs));
  const result = runMemoryEmbeddingRetryLoop({ profile, run, waitForRetry });
  if (last instanceof Error) {
    await expect(result).rejects.toBe(last);
  } else {
    await expect(result).resolves.toBe(last);
  }
  expect(run).toHaveBeenCalledTimes(expectedCalls);
  expect(waitForRetry).toHaveBeenCalledTimes(expectedCalls - 1);
  return waits;
}

async function expectBatchSplit(message: string, shouldSplit: boolean): Promise<void> {
  const failure = new Error(message);
  const items = ["a", "b"];
  const result = runMemoryEmbeddingBatchRetryWithSplit({
    items,
    run: async (batch) => {
      if (batch.length > 1) {
        throw failure;
      }
      return batch;
    },
    waitForRetry: async () => {},
  });
  if (shouldSplit) {
    await expect(result).resolves.toEqual(items);
  } else {
    await expect(result).rejects.toBe(failure);
  }
}

function chunk(text: string) {
  return {
    startLine: 1,
    endLine: 1,
    text,
    hash: text,
  };
}

describe("memory embedding policy", () => {
  it.each([
    { size: 4200, count: 2, lengths: [1, 1] },
    { size: 120, count: 4, lengths: [4] },
  ])("batches $count chunks of $size bytes within the token budget", ({ size, count, lengths }) => {
    const batches = buildMemoryEmbeddingBatches(
      Array.from({ length: count }, () => chunk("a".repeat(size))),
      8000,
    );
    expect(batches).toHaveLength(lengths.length);
    expect(batches.map((batch) => batch.length)).toEqual(lengths);
  });

  it("budgets multibyte text and structured inline data by their actual UTF-8 bytes", () => {
    const textChunks = [chunk("é"), chunk("😀"), chunk("a")];
    expect(buildMemoryEmbeddingBatches(textChunks, 5).map((batch) => batch.length)).toEqual([1, 2]);

    const structuredChunks = [
      {
        ...chunk("this longer fallback text is ignored when parts are present"),
        embeddingInput: {
          text: "this fallback is also ignored",
          parts: [
            { type: "text" as const, text: "é" },
            { type: "inline-data" as const, mimeType: "a/b", data: "😀" },
          ],
        },
      },
      {
        ...chunk("the second fallback is ignored too"),
        embeddingInput: {
          text: "unused fallback",
          parts: [{ type: "text" as const, text: "é" }],
        },
      },
    ];

    expect(buildMemoryEmbeddingBatches(structuredChunks, 10).map((batch) => batch.length)).toEqual([
      1, 1,
    ]);
    expect(buildMemoryEmbeddingBatches(structuredChunks, 11)).toEqual([structuredChunks]);
  });

  // Profile, provider outcomes, independent delay bounds, and capped total wait.
  it.each([
    [
      "index",
      [
        new Error("openai embeddings failed: 429 rate limit"),
        new Error("openai embeddings failed: 502 Bad Gateway (cloudflare)"),
        "ok",
      ],
      [
        [4000, 6000],
        [800, 1200],
      ],
    ],
    [
      "index",
      [new Error("AWS Bedrock embeddings failed: Too many tokens per day"), "ok"],
      [[4000, 6000]],
    ],
    ...(
      [
        ["index", 30_000, 30_000, 36_000],
        ["index", Number.MAX_SAFE_INTEGER, 48_000, 60_000],
        ["query", 60_000, 6400, 8000],
      ] as const
    ).map(
      ([profile, retryAfterMs, min, max]) =>
        [
          profile,
          [
            Object.assign(new Error("gemini embeddings failed (429)"), {
              status: 429,
              retryAfterMs,
            }),
            "ok",
          ],
          [[min, max]],
        ] as const,
    ),
    [
      "index",
      Object.assign(new Error("gemini embeddings failed (429)"), { status: 429 }),
      [
        [4000, 6000],
        [8000, 12_000],
        [16_000, 24_000],
        [32_000, 48_000],
      ],
      undefined,
    ],
    [
      "query",
      Object.assign(new Error("gemini embeddings failed (429)"), {
        status: 429,
        retryAfterMs: 60_000,
      }),
      [
        [0, 8000],
        [0, 8000],
      ],
      8000,
    ],
    ...(["index", "query"] as const).map(
      (profile) =>
        [
          profile,
          Object.assign(new Error("gemini embeddings failed: upstream rate limit"), {
            status: 503,
            retryAfterMs: 60_000,
          }),
          [
            [400, 600],
            [800, 1200],
          ],
          undefined,
        ] as const,
    ),
  ] as const)(
    "bounds %s retries for %s (case %#)",
    async (profile, scenario, delays, total?: number) => {
      const waits = await expectRetryAttempts(scenario, delays.length + 1, profile);
      expect(waits).toHaveLength(delays.length);
      delays.forEach(([min, max], index) => expectDelayBetween(waits[index], min, max));
      if (total !== undefined) {
        expect(waits.reduce((sum, delayMs) => sum + delayMs, 0)).toBe(total);
      }
    },
  );

  it.each([
    { errorCode: "quota_exceeded" },
    { code: "insufficient_quota" },
    { errorType: "insufficient_quota" },
    { errorCode: "insufficient_quota", errorType: "rate_limit_error" },
  ])("fails fast for structured permanent quota without a cooldown: %j", async (fields) => {
    const quotaError = Object.assign(new Error("Too many tokens per day"), {
      status: 429,
      ...fields,
    });
    await expectRetryAttempts(quotaError, 1);
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
        profile: "index",
        run,
        waitForRetry,
        signal: controller.signal,
      }),
    ).rejects.toThrow("memory embeddings query timed out after 60s");

    expect(run).toHaveBeenCalledTimes(1);
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it("aborts an in-progress retry delay without starting another provider request", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const abortReason = new Error("memory search was cancelled");
      const run = vi.fn(async () => {
        throw new Error("memory embeddings query timed out after 60s");
      });
      const waitForRetry = vi.fn(async (delayMs: number) => {
        await sleepWithAbort(delayMs, controller.signal);
      });

      const pending = runMemoryEmbeddingRetryLoop({
        profile: "index",
        run,
        waitForRetry,
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(run).toHaveBeenCalledOnce();
      expectDelayBetween(waitForRetry.mock.calls[0]?.[0], 400, 600);
      expect(vi.getTimerCount()).toBe(1);

      controller.abort(abortReason);

      await expect(pending).rejects.toMatchObject({
        message: "aborted",
        cause: abortReason,
      });
      expect(run).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    // Network/service failures retry; batch watchdog timeouts go straight to splitting.
    ["TypeError: fetch failed | other side closed", "index", 3],
    ["undici error: UND_ERR_SOCKET", "index", 3],
    ["read ECONNRESET", "index", 3],
    ["socket hang up", "index", 3],
    ["ECONNREFUSED", "index", 3],
    ["EHOSTUNREACH", "index", 3],
    ["memory embeddings batch timed out", "index", 1],
    ["HTTP 503: service unavailable", "index", 3],
    // Permanent errors never retry.
    ["worker terminated by user", "index", 1],
    ["embedding validation failed", "index", 1],
    [
      "Embeddings API input limit exceeded: max 10, got 33. Request id: fixture-000597000",
      "index",
      1,
    ],
    ["embeddings max input length is 16", "index", 1],
    ['HTTP 400: {"error":{"code":"1214","message":"input array max 64"}}', "index", 1],
    ["HTTP 400: request id fixture-000597000", "index", 1],
    ["431 request_headers_too_large", "index", 1],
    // Rate-limit errors use the profile-specific attempt budget.
    ["HTTP 429: rate limit", "index", 5],
    ["HTTP 429: rate limit", "query", 3],
    ["HTTP 503: service unavailable", "query", 3],
    ["HTTP 400: invalid input", "query", 1],
  ] as const)("retries %s (%s) for %i total attempts", async (message, profile, expectedCalls) => {
    await expectRetryAttempts(message, expectedCalls, profile);
  });

  it.each([
    Object.assign(
      new Error(
        "openai embeddings failed (model: model-500, batch size: 429): expected 429 vectors, got 500",
      ),
      { code: "INVALID_EMBEDDING_RESPONSE" },
    ),
    Object.assign(new Error("input array max 64"), { code: "INVALID_EMBEDDING_RESPONSE" }),
    ...["malformed JSON response", "JSON response exceeds 16777216 bytes"].map((condition) =>
      Object.assign(
        new Error(`openai embeddings failed (model: model-500, batch size: 429): ${condition}`),
        {
          embeddingErrorMessage: `openai embeddings failed: ${condition}`,
        },
      ),
    ),
  ])("does not retry or split malformed response diagnostics: %s", async (error) => {
    const run = vi.fn<() => Promise<number[][]>>().mockRejectedValue(error);
    const waitForRetry = vi.fn(async () => {});
    const onSuccess = vi.fn();
    await expect(
      runMemoryEmbeddingBatchRetryWithSplit({
        items: ["first", "second"],
        run,
        waitForRetry,
        onSuccess,
      }),
    ).rejects.toBe(error);
    expect(run).toHaveBeenCalledOnce();
    expect(waitForRetry).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("splits recoverable transport failures and batch watchdog timeouts", async () => {
    const splittableMessages = [
      "TypeError: fetch failed | other side closed",
      "undici error: UND_ERR_SOCKET",
      "read ECONNRESET",
      "socket hang up",
      "memory embeddings batch timed out",
    ];

    for (const message of splittableMessages) {
      await expectBatchSplit(message, true);
    }
    await expectBatchSplit("ECONNREFUSED", false);
    await expectBatchSplit("EHOSTUNREACH", false);
  });

  it("splits only provider errors with an explicit numeric embedding item limit", async () => {
    for (const message of [
      "Embeddings API input limit exceeded: max 10, got 33. Request id: fixture-000597000",
      "embeddings max input length is 16",
      'HTTP 400: {"error":{"message":"<400> InternalError.Algo.InvalidParameter: Value error, batch size is invalid, it should not be larger than 10.: input.contents","type":"InvalidParameter","code":"InvalidParameter"}}',
      // Zhipu embedding-3 caps `input` at 64 items under its generic 1214 code.
      'openai-compatible embeddings failed: HTTP 400: {"error":{"code":"1214","message":"input array max 64"}}',
      // Zhipu embedding-3 rejects batches over 64 items with a Chinese message (#136261).
      'HTTP 400: {"error":{"code":"1214","message":"input数组最大不得超过64条"}}',
      // Mistral rejects the aggregate token count of a batch and asks for more batches (#183556).
      'openai-compatible embeddings failed: HTTP 400: {"object":"error","message":"Too many tokens overall, split into more batches.","type":"invalid_request_prompt","code":"3210"}',
    ]) {
      await expectBatchSplit(message, true);
    }

    for (const message of [
      "embedding validation failed at item 4312",
      "embedding input exceeds maximum token length 4096",
      // A single input over the per-input token limit cannot be helped by splitting.
      "Too many tokens in input, max 8192 per input",
      "Too many tokens per day",
      "embeddings max input length is unknown",
      "Embeddings API input limit exceeded",
      'HTTP 400: {"code":"InvalidParameter","param":"input","message":"input must be a string"}',
      // A batch-size complaint without an explicit numeric cap is not splittable.
      "batch size is invalid",
      "batch size is invalid, it should not be larger than unknown; request id 12345",
      "batch size is invalid, it should not be smaller than 20",
      "input size is invalid, it should not be larger than 20",
      // Code 1214 alone, an item index, or a bare limit phrase without a number stay terminal.
      'HTTP 400: {"error":{"code":"1214","message":"input array element 3 must be a string"}}',
      'HTTP 400: {"error":{"code":"1214","message":"input array exceeds the maximum length"}}',
      "input array item max length 64",
      "input array max length 64",
      "input array maximum 64",
      "input array max 64 tokens",
      "input array max 64tokens",
      "input array max 64.5",
    ]) {
      await expectBatchSplit(message, false);
    }
  });

  it.each([
    { declared: undefined, requests: [33, 10, 10, 10, 3] },
    { declared: 10, requests: [10, 10, 10, 3] },
    { declared: 20, requests: [20, 10, 10, 13, 10, 3] },
  ])(
    "preserves paired inputs and persists each slice once with declared cap $declared",
    async ({ declared, requests }) => {
      const items = Array.from({ length: 33 }, (_, input) => ({
        input,
        cacheCandidate: `candidate-${input}`,
      }));
      const completed: Array<{ candidates: string[]; outputs: string[] }> = [];
      const run = vi.fn(async (batch: typeof items) => {
        if (batch.length > 10) {
          const cap = "embeddings max input length is 10";
          throw declared === undefined
            ? Object.assign(new Error("wrapped HTTP 400"), {
                status: 400,
                errorBody: JSON.stringify({ error: `${"x".repeat(260)} ${cap}` }),
              })
            : new Error(cap);
        }
        return batch.map((item) => `output-${item.input}`);
      });
      await expect(
        runMemoryEmbeddingBatchRetryWithSplit({
          items,
          maxInputsPerRequest: declared,
          run,
          onSuccess: (batch, outputs) => {
            completed.push({ candidates: batch.map((item) => item.cacheCandidate), outputs });
          },
          waitForRetry: async () => {},
        }),
      ).resolves.toEqual(items.map((item) => `output-${item.input}`));
      expect(run.mock.calls.map(([batch]) => batch.length)).toEqual(requests);
      expect(completed).toEqual(
        [items.slice(0, 10), items.slice(10, 20), items.slice(20, 30), items.slice(30)].map(
          (batch) => ({
            candidates: batch.map((item) => item.cacheCandidate),
            outputs: batch.map((item) => `output-${item.input}`),
          }),
        ),
      );
    },
  );

  it.each([
    { cap: 1, requests: [[0], [1], [2]] },
    ...[undefined, 0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((cap) => ({
      cap,
      requests: [[0, 1, 2]],
    })),
  ])("uses only positive safe integer declarations: $cap", async ({ cap, requests }) => {
    const run = vi.fn(async (items: number[]) => items);
    await expect(
      runMemoryEmbeddingBatchRetryWithSplit({
        items: [0, 1, 2],
        maxInputsPerRequest: cap,
        run,
        waitForRetry: async () => {},
      }),
    ).resolves.toEqual([0, 1, 2]);
    expect(run.mock.calls.map(([items]) => items)).toEqual(requests);
  });

  it("falls back to recursive splitting for unusable or stale limits", async () => {
    for (const [errorMessage, expectedCalls] of [
      ["embeddings max input length is 0", [4, 2, 2]],
      ["embeddings max input length is 3.5", [4, 2, 2]],
      ["embeddings max input length is 9007199254740992", [4, 2, 2]],
      [
        "embeddings max input length is 4; batch size is invalid, it should not be larger than 3",
        [4, 2, 2],
      ],
      ["embeddings max input length is 4", [4, 2, 2]],
      ["embeddings max input length is 8", [4, 2, 2]],
      ["embeddings max input length is 3", [4, 3, 2, 1, 1]],
    ] as const) {
      const run = vi.fn(async (items: number[]) => {
        if (items.length > 2) {
          throw new Error(errorMessage);
        }
        return items;
      });
      await expect(
        runMemoryEmbeddingBatchRetryWithSplit({
          items: [0, 1, 2, 3],
          run,
          waitForRetry: async () => {},
        }),
      ).resolves.toEqual([0, 1, 2, 3]);
      expect(run.mock.calls.map(([items]) => items.length)).toEqual(expectedCalls);
    }
  });

  it.each([
    {
      failure: new Error(
        "openai embeddings failed: 431 request_headers_too_large: Request Header Fields Too Large",
      ),
      requests: [4, 2, 1, 1, 2, 1, 1],
      retries: 0,
    },
    {
      failure: new TypeError("fetch failed | other side closed"),
      requests: [4, 4, 4, 2, 2, 2, 1, 1, 2, 2, 2, 1, 1],
      retries: 6,
    },
  ])("splits exhausted batches for $failure", async ({ failure, requests, retries }) => {
    const completed: string[][] = [];
    const waits: number[] = [];
    const splits: string[] = [];
    const run = vi.fn(async (items: string[]) => {
      if (items.length > 1) {
        throw failure;
      }
      return items.map((item) => [item.charCodeAt(0)]);
    });
    const result = await runMemoryEmbeddingBatchRetryWithSplit({
      items: ["a", "b", "c", "d"],
      run,
      onSuccess: (items) => {
        completed.push(items);
      },
      waitForRetry: async (delayMs) => {
        waits.push(delayMs);
      },
      onSplit: ({ itemCount, splitAt }) => {
        splits.push(`${itemCount}:${splitAt}`);
      },
    });
    expect(result).toEqual([[97], [98], [99], [100]]);
    expect(completed).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(run.mock.calls.map(([items]) => items.length)).toEqual(requests);
    expect(waits).toHaveLength(retries);
    for (const [index, wait] of waits.entries()) {
      expectDelayBetween(wait, index % 2 === 0 ? 400 : 800, index % 2 === 0 ? 600 : 1200);
    }
    expect(splits).toEqual(["4:2", "2:1", "2:1"]);
  });

  it.each([
    ["openai embeddings failed: 429 rate limit", 5],
    ["connect ECONNREFUSED 127.0.0.1:11434", 3],
  ] as const)("does not split an exhausted endpoint failure: %s", async (message, attempts) => {
    const failure = new Error(message);
    const run = vi.fn<() => Promise<never>>().mockRejectedValue(failure);
    await expect(
      runMemoryEmbeddingBatchRetryWithSplit({
        items: ["a", "b"],
        run,
        waitForRetry: async () => {},
      }),
    ).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(attempts);
  });
});
