/**
 * Unit tests for requestFeishuApi retry logic and getFeishuSendRateLimitCode.
 *
 * Tests the retry behaviour directly via requestFeishuApi with retryDelayMs:0
 * so no fake timers are needed. Related: issue #70879.
 */

import { describe, expect, it, vi } from "vitest";
import { getFeishuSendRateLimitCode, requestFeishuApi } from "./comment-shared.js";

/** Build an AxiosError-shaped object for a given Feishu body error code (HTTP 400). */
function axiosError(code: number) {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: {
      status: 400,
      data: { code, msg: "feishu error" },
    },
  });
}

// Use retryDelayMs: 0 throughout to keep tests fast with no real delays.
const NO_DELAY = { retryDelayMs: 0 };

describe("getFeishuSendRateLimitCode", () => {
  it("returns 230020 for per-chat rate-limit AxiosError", () => {
    expect(getFeishuSendRateLimitCode(axiosError(230020))).toBe(230020);
  });

  it("returns undefined for 230006 (not a transient rate limit)", () => {
    expect(getFeishuSendRateLimitCode(axiosError(230006))).toBeUndefined();
  });

  it("returns undefined for a non-rate-limit code", () => {
    expect(getFeishuSendRateLimitCode(axiosError(230001))).toBeUndefined();
  });

  it("returns undefined for a plain Error (no response shape)", () => {
    expect(getFeishuSendRateLimitCode(new Error("boom"))).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(getFeishuSendRateLimitCode(null)).toBeUndefined();
  });
});

describe("requestFeishuApi — success path", () => {
  it("resolves immediately on first attempt", async () => {
    const request = vi.fn().mockResolvedValue("ok");
    const result = await requestFeishuApi(request, "prefix", NO_DELAY);
    expect(result).toBe("ok");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("requestFeishuApi — retry on rate-limit", () => {
  it("retries once and succeeds on second attempt (code 230020)", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(axiosError(230020))
      .mockResolvedValueOnce("ok-retry");

    const result = await requestFeishuApi(request, "prefix", NO_DELAY);
    expect(result).toBe("ok-retry");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry on code 230006", async () => {
    const request = vi.fn().mockRejectedValue(axiosError(230006));

    await expect(requestFeishuApi(request, "prefix", NO_DELAY)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("exhausts all retries and throws after 3 total attempts", async () => {
    const request = vi.fn().mockRejectedValue(axiosError(230020));

    await expect(requestFeishuApi(request, "Feishu send failed", NO_DELAY)).rejects.toThrow(
      /Feishu send failed/,
    );
    // 1 initial attempt + 2 retries
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("wraps the final error with feishu_code in the message", async () => {
    const request = vi.fn().mockRejectedValue(axiosError(230020));

    const err = await requestFeishuApi(request, "Feishu send failed", NO_DELAY).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/230020/);
  });

  it("recovers on the third attempt after two rate-limit failures", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(axiosError(230020))
      .mockRejectedValueOnce(axiosError(230020))
      .mockResolvedValueOnce("ok-third");

    const result = await requestFeishuApi(request, "prefix", NO_DELAY);
    expect(result).toBe("ok-third");
    expect(request).toHaveBeenCalledTimes(3);
  });
});

describe("requestFeishuApi — no retry for non-rate-limit errors", () => {
  it("throws immediately without retry for a non-rate-limit Feishu code", async () => {
    const request = vi.fn().mockRejectedValue(axiosError(230001));

    await expect(requestFeishuApi(request, "prefix", NO_DELAY)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("throws immediately without retry for a plain Error", async () => {
    const request = vi.fn().mockRejectedValue(new Error("network failure"));

    await expect(requestFeishuApi(request, "prefix", NO_DELAY)).rejects.toThrow(/network failure/);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
