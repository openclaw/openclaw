import { describe, expect, it, vi } from "vitest";
import { _transientRetryInternals, runWithModelFallback } from "./model-fallback.js";
import { makeModelFallbackCfg } from "./test-helpers/model-fallback-config-fixture.js";

const { isTransientLlmCallError, runFallbackAttemptWithTransientRetry } = _transientRetryInternals;

async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const settled = run().then(
      (value): { ok: true; value: T } => ({ ok: true, value }),
      (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    if (result.ok) {
      return result.value;
    }
    throw result.error;
  } finally {
    vi.useRealTimers();
  }
}

const noFallbackCfg = () =>
  makeModelFallbackCfg({
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: [],
        },
      },
    },
  });

const ZERO_DELAYS = [0, 0, 0] as const;

describe("isTransientLlmCallError", () => {
  it("treats mid-flight drop codes as transient", () => {
    for (const code of [
      "ECONNRESET",
      "ECONNABORTED",
      "EPIPE",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ]) {
      const err = Object.assign(new Error("boom"), { code });
      expect(isTransientLlmCallError(err)).toBe(true);
    }
  });

  it("does not retry provider-unreachable codes (fallback handles those)", () => {
    for (const code of [
      "ECONNREFUSED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "EAI_AGAIN",
      "ENETRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
    ]) {
      const err = Object.assign(new Error("boom"), { code });
      expect(isTransientLlmCallError(err)).toBe(false);
    }
  });

  it("treats undici-style fetch failed wrappers as transient via cause", () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" });
    const err = new Error("fetch failed", { cause });
    expect(isTransientLlmCallError(err)).toBe(true);
  });

  it("matches narrow network phrases in the error message", () => {
    expect(isTransientLlmCallError(new Error("socket hang up"))).toBe(true);
    expect(isTransientLlmCallError(new Error("connection reset by peer"))).toBe(true);
    expect(isTransientLlmCallError(new Error("other side closed"))).toBe(true);
    expect(isTransientLlmCallError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("does not retry structured API errors (rate_limit / billing / auth / format)", () => {
    expect(isTransientLlmCallError(Object.assign(new Error("429"), { status: 429 }))).toBe(false);
    expect(isTransientLlmCallError(Object.assign(new Error("402"), { status: 402 }))).toBe(false);
    expect(isTransientLlmCallError(Object.assign(new Error("401"), { status: 401 }))).toBe(false);
    expect(isTransientLlmCallError(Object.assign(new Error("403"), { status: 403 }))).toBe(false);
    expect(isTransientLlmCallError(Object.assign(new Error("400"), { status: 400 }))).toBe(false);
  });

  it("does not retry request-level timeout classifications (AbortError / 408)", () => {
    const timeoutCause = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    const aborted = Object.assign(new Error("aborted"), {
      name: "AbortError",
      cause: timeoutCause,
    });
    expect(isTransientLlmCallError(aborted)).toBe(false);
    expect(isTransientLlmCallError(Object.assign(new Error("timeout"), { status: 408 }))).toBe(
      false,
    );
  });

  it("ignores unrelated errors", () => {
    expect(isTransientLlmCallError(new Error("bad request"))).toBe(false);
    expect(isTransientLlmCallError(null)).toBe(false);
    expect(isTransientLlmCallError(undefined)).toBe(false);
    expect(isTransientLlmCallError(new Error("fetch failed"))).toBe(false);
  });
});

describe("runFallbackAttemptWithTransientRetry", () => {
  it("returns success without retrying when the first attempt succeeds", async () => {
    const run = vi.fn().mockResolvedValueOnce("ok");
    const onRetry = vi.fn();

    const result = await runFallbackAttemptWithTransientRetry({
      run,
      provider: "openai",
      model: "gpt-4.1-mini",
      attempts: [],
      delaysMs: ZERO_DELAYS,
      onTransientRetry: onRetry,
    });

    expect(result).toHaveProperty("success");
    expect(run).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries up to maxAttempts times on transient errors then returns the last error", async () => {
    const err = Object.assign(new Error("boom"), { code: "ECONNRESET" });
    const run = vi.fn().mockRejectedValue(err);
    const onRetry = vi.fn();

    const result = await runFallbackAttemptWithTransientRetry({
      run,
      provider: "openai",
      model: "gpt-4.1-mini",
      attempts: [],
      delaysMs: ZERO_DELAYS,
      onTransientRetry: onRetry,
    });

    expect(result).toEqual({ error: err });
    expect(run).toHaveBeenCalledTimes(ZERO_DELAYS.length + 1);
    expect(onRetry).toHaveBeenCalledTimes(ZERO_DELAYS.length);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({
      attempt: 1,
      maxAttempts: ZERO_DELAYS.length + 1,
      provider: "openai",
      model: "gpt-4.1-mini",
    });
  });

  it("succeeds after a transient error clears on retry", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "UND_ERR_SOCKET" }))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce("ok");

    const result = await runFallbackAttemptWithTransientRetry({
      run,
      provider: "openai",
      model: "gpt-4.1-mini",
      attempts: [],
      delaysMs: ZERO_DELAYS,
    });

    expect(result).toHaveProperty("success");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-transient errors", async () => {
    const err = Object.assign(new Error("unauthorized"), { status: 401 });
    const run = vi.fn().mockRejectedValue(err);

    const result = await runFallbackAttemptWithTransientRetry({
      run,
      provider: "openai",
      model: "gpt-4.1-mini",
      attempts: [],
      delaysMs: ZERO_DELAYS,
    });

    expect(result).toEqual({ error: err });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("uses the delay schedule to space retries", async () => {
    vi.useFakeTimers();
    try {
      const delays = [1_000, 3_000, 5_000] as const;
      const run = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "ECONNRESET" }))
        .mockResolvedValueOnce("ok");

      const promise = runFallbackAttemptWithTransientRetry({
        run,
        provider: "openai",
        model: "gpt-4.1-mini",
        attempts: [],
        delaysMs: delays,
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2);
      await promise;
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runWithModelFallback — transient retry integration", () => {
  it("retries the primary on network blip instead of immediately burning a fallback", async () => {
    const cfg = makeModelFallbackCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce("ok");

    const result = await withFakeTimers(() =>
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    );

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("openai");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]).toEqual(["openai", "gpt-4.1-mini"]);
    expect(run.mock.calls[1]).toEqual(["openai", "gpt-4.1-mini"]);
    expect(result.attempts).toHaveLength(0);
  });

  it("surfaces the transient error as a single recorded attempt when all retries fail", async () => {
    const cfg = noFallbackCfg();
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
    const run = vi.fn().mockRejectedValue(err);

    await expect(
      withFakeTimers(() =>
        runWithModelFallback({
          cfg,
          provider: "openai",
          model: "gpt-4.1-mini",
          run,
        }),
      ),
    ).rejects.toThrow(/fetch failed/);
    // 1 initial + 3 retries on the only candidate.
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("still falls back to the next candidate when the primary is permanently unauthorized", async () => {
    const cfg = makeModelFallbackCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401 }))
      .mockResolvedValueOnce("ok");

    const result = await withFakeTimers(() =>
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    );

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
  });
});
