import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestFeishuApi } from "./comment-shared.js";

function axiosError(code?: number, status = 400) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { code, msg: "feishu error" } },
  });
}

const rateLimits = [
  {
    name: "per-chat rejection",
    fail: () => Promise.reject(axiosError(230020)),
    diagnostic: '"feishu_code":230020',
  },
  {
    name: "tenant rejection",
    fail: () => Promise.reject(axiosError(11232)),
    diagnostic: '"feishu_code":11232',
  },
  {
    name: "gateway rejection",
    fail: () => Promise.reject(axiosError(undefined, 429)),
    diagnostic: '"http_status":429',
  },
  {
    name: "gateway rejection with a non-retryable body",
    fail: () => Promise.reject(axiosError(230001, 429)),
    diagnostic: '"http_status":429',
  },
  {
    name: "fulfilled per-chat rate limit",
    fail: () => Promise.resolve({ code: 230020, msg: "rate limit" }),
    diagnostic: '"feishu_code":230020',
  },
  {
    name: "fulfilled tenant rate limit",
    fail: () => Promise.resolve({ code: 11232, msg: "rate limit" }),
    diagnostic: '"feishu_code":11232',
  },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("requestFeishuApi", () => {
  it.each([
    null,
    { code: 0, data: { message_id: "om_first" } },
    { code: 230001, msg: "permission error" },
  ])("returns a non-rate-limited response unchanged: %j", async (response) => {
    const request = vi.fn().mockResolvedValue(response);
    await expect(requestFeishuApi(request, "Feishu send failed")).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { error: axiosError(230006), diagnostic: "230006" },
    { error: new Error("network failure"), diagnostic: "network failure" },
    { error: null, diagnostic: "Retry failed" },
  ])("does not retry a non-rate-limit rejection: $diagnostic", async ({ error, diagnostic }) => {
    const request = vi.fn().mockRejectedValue(error);
    const result = requestFeishuApi(request, "Feishu send failed");
    await expect(result).rejects.toThrow("Feishu send failed");
    await expect(result).rejects.toThrow(diagnostic);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries after the default backoff and returns the successful response", async () => {
    const response = { code: 0, data: { message_id: "om_retry" } };
    const request = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(response)
      .mockRejectedValueOnce(axiosError(230020));
    const result = requestFeishuApi(request, "Feishu send failed");

    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(rateLimits)("exhausts the retry budget and wraps $name", async ({ fail, diagnostic }) => {
    const request = vi.fn(fail);
    // Fulfilled rate-limit bodies must also reject on exhaustion, never escape as success.
    const result = requestFeishuApi(request, "Feishu send failed").catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1499);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", expect.stringContaining("Feishu send failed"));
    expect(error).toHaveProperty("message", expect.stringContaining(diagnostic));
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("recovers on the third attempt after rejected then fulfilled rate limits", async () => {
    const response = { code: 0, data: { message_id: "om_recovered" } };
    const request = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(axiosError(230020))
      .mockResolvedValueOnce({ code: 11232, msg: "rate limit" })
      .mockResolvedValueOnce(response);
    const result = requestFeishuApi(request, "Feishu send failed");

    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
