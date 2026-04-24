import { describe, expect, it, vi } from "vitest";
import { isRetryableSendMessageError } from "./network-errors.js";
import { SEND_MESSAGE_RETRY_BACKOFF_MS, withSendMessageRetry } from "./send-message-retry.js";

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

const telegramError = (errorCode: number, description: string) =>
  Object.assign(new Error(`${errorCode}: ${description}`), {
    error_code: errorCode,
    description,
  });

describe("isRetryableSendMessageError", () => {
  it("matches ECONNRESET and ETIMEDOUT", () => {
    expect(isRetryableSendMessageError(withCode("connection reset", "ECONNRESET"))).toBe(true);
    expect(isRetryableSendMessageError(withCode("request timed out", "ETIMEDOUT"))).toBe(true);
  });

  it("matches the grammY 'Network request for <method> failed' message", () => {
    expect(
      isRetryableSendMessageError(new Error("Network request for 'sendMessage' failed!")),
    ).toBe(true);
  });

  it("does not match the 'failed after N attempts' envelope (grammY already retried)", () => {
    expect(
      isRetryableSendMessageError(
        new Error("Network request for 'sendMessage' failed after 1 attempts."),
      ),
    ).toBe(false);
  });

  it.each([400, 403, 429])("rejects Telegram %s client rejections", (code) => {
    expect(isRetryableSendMessageError(telegramError(code, "not retryable"))).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isRetryableSendMessageError(new Error("some application bug"))).toBe(false);
    expect(isRetryableSendMessageError(null)).toBe(false);
  });
});

describe("withSendMessageRetry", () => {
  const expectedBackoffs = SEND_MESSAGE_RETRY_BACKOFF_MS;

  const setup = () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const random = vi.fn(() => 0.5); // Zero-jitter midpoint for deterministic assertions.
    const log = vi.fn((_message: string) => {});
    return { sleep, random, log };
  };

  it("returns the first-attempt result without sleeping", async () => {
    const { sleep, random } = setup();
    const fn = vi.fn(async () => "ok");
    const result = await withSendMessageRetry(fn, { sleep, random });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient errors using the 500 → 2000 → 8000ms backoff schedule", async () => {
    const { sleep, random, log } = setup();
    const transient = withCode("ECONNRESET", "ECONNRESET");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce("ok");

    const result = await withSendMessageRetry(fn, { sleep, random, log });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    // random()==0.5 → symmetric jitter term is zero, so the delays equal the base backoffs.
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([...expectedBackoffs]);
    expect(log).toHaveBeenCalledTimes(3);
  });

  it("applies ±25% jitter around each base backoff", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const log = vi.fn((_message: string) => {});
    // Alternating extremes: fully negative jitter, then fully positive jitter, then midpoint.
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(0.5);
    const transient = withCode("ECONNRESET", "ECONNRESET");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce("ok");
    await withSendMessageRetry(fn, { sleep, random, log });
    const delays = sleep.mock.calls.map((call) => call[0]);
    const [first = 0, second = 0, third = 0] = delays;
    expect(first).toBe(Math.round(expectedBackoffs[0] * 0.75));
    expect(second).toBe(Math.round(expectedBackoffs[1] * 1.25));
    expect(third).toBe(expectedBackoffs[2]);
    const observed = [first, second, third];
    expectedBackoffs.forEach((base, i) => {
      const delay = observed[i] ?? 0;
      expect(delay).toBeGreaterThanOrEqual(Math.round(base * 0.75));
      expect(delay).toBeLessThanOrEqual(Math.round(base * 1.25));
    });
  });

  it("does not retry permanent Telegram client rejections", async () => {
    const { sleep, random } = setup();
    const permanent = telegramError(400, "Bad Request: chat not found");
    const fn = vi.fn(async () => {
      throw permanent;
    });
    await expect(withSendMessageRetry(fn, { sleep, random })).rejects.toBe(permanent);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the attempt limit and surfaces the last error", async () => {
    const { sleep, random } = setup();
    const transient = withCode("ECONNRESET", "ECONNRESET");
    const fn = vi.fn(async () => {
      throw transient;
    });
    await expect(withSendMessageRetry(fn, { sleep, random })).rejects.toBe(transient);
    expect(fn).toHaveBeenCalledTimes(expectedBackoffs.length + 1);
    expect(sleep).toHaveBeenCalledTimes(expectedBackoffs.length);
  });

  it("honors an injected retry predicate", async () => {
    const { sleep, random } = setup();
    const err = new Error("custom");
    const isRetryable = vi.fn(() => false);
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withSendMessageRetry(fn, { sleep, random, isRetryable })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isRetryable).toHaveBeenCalledWith(err);
    expect(sleep).not.toHaveBeenCalled();
  });
});
