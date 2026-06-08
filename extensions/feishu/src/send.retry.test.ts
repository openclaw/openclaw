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

/**
 * Build an AxiosError-shaped object for a Feishu Open API gateway HTTP 429
 * response (no Feishu business code in body — gateway short-circuits before
 * the message service).
 */
function http429Error() {
  return Object.assign(new Error("Request failed with status code 429"), {
    response: {
      status: 429,
      data: { msg: "Too Many Requests" },
      headers: { "x-ogw-ratelimit-reset": "1" },
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

describe("getFeishuSendRateLimitCode — expanded rate-limit signals", () => {
  // 11232 is the tenant-level "create message service trigger rate limit"
  // (100/min, 5/sec). Same nature as 230020 (per-chat) but at a higher scope.
  it("returns 11232 for tenant-level message rate-limit AxiosError", () => {
    expect(getFeishuSendRateLimitCode(axiosError(11232))).toBe(11232);
  });

  // HTTP 429 is the Feishu Open API gateway-level limit (app-wide quota);
  // it short-circuits before hitting the message service so the body has no
  // Feishu business code. We must detect it from response.status alone.
  it("returns 429 for gateway-level HTTP 429 with no business code in body", () => {
    expect(getFeishuSendRateLimitCode(http429Error())).toBe(429);
  });

  it("prefers HTTP 429 over body code when both are present", () => {
    const err = Object.assign(new Error("Request failed with status code 429"), {
      response: {
        status: 429,
        data: { code: 230001, msg: "ignored" },
      },
    });
    expect(getFeishuSendRateLimitCode(err)).toBe(429);
  });
});

describe("requestFeishuApi — retry on expanded rate-limit signals", () => {
  it("retries once and succeeds on second attempt (code 11232)", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(axiosError(11232))
      .mockResolvedValueOnce("ok-after-11232");

    const result = await requestFeishuApi(request, "prefix", NO_DELAY);
    expect(result).toBe("ok-after-11232");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries once and succeeds on second attempt (HTTP 429)", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(http429Error())
      .mockResolvedValueOnce("ok-after-429");

    const result = await requestFeishuApi(request, "prefix", NO_DELAY);
    expect(result).toBe("ok-after-429");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries on persistent 11232 and surfaces feishu_code", async () => {
    const request = vi.fn().mockRejectedValue(axiosError(11232));

    const err = await requestFeishuApi(request, "Feishu send failed", NO_DELAY).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/11232/);
    // 1 initial attempt + 2 retries
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("exhausts retries on persistent HTTP 429 and surfaces http_status", async () => {
    const request = vi.fn().mockRejectedValue(http429Error());

    const err = await requestFeishuApi(request, "Feishu send failed", NO_DELAY).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // The error wrapper records http_status:429 in the JSON-encoded message.
    expect((err as Error).message).toMatch(/429/);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("recovers across mixed rate-limit signals (230020 → 11232 → ok)", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(axiosError(230020))
      .mockRejectedValueOnce(axiosError(11232))
      .mockResolvedValueOnce("ok-mixed");

    const result = await requestFeishuApi(request, "prefix", NO_DELAY);
    expect(result).toBe("ok-mixed");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
