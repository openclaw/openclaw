import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestFeishuApi } from "./comment-shared.js";

function axiosError(code?: number, status = 400) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { code, msg: "feishu error" } },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("requestFeishuApi", () => {
  it.each([
    Object.assign(new Error("connection lost"), { code: "ECONNRESET" }),
    Object.assign(new Error("connection lost"), { code: "EPROTO" }),
    Object.assign(new Error("connection lost"), { code: "UND_ERR_BODY_TIMEOUT" }),
    Object.assign(new Error("connection lost"), { code: "ERR_NETWORK" }),
    ...[408, 425, 500, 503, 599].map((status) => axiosError(undefined, status)),
    axiosError(230049, 200),
    { code: 230049, msg: "message is being sent" },
  ])("retries transient failures only for deduplicated requests: %j", async (failure) => {
    const fail = () =>
      "response" in failure || failure instanceof Error
        ? Promise.reject(failure)
        : Promise.resolve(failure);
    const request = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(fail)
      .mockResolvedValue({ code: 0 });
    const result = requestFeishuApi(request, "Send failed", { retryTransient: true });
    const outcome = expect(result).resolves.toEqual({ code: 0 });
    await vi.runAllTimersAsync();
    await outcome;
    expect(request).toHaveBeenCalledTimes(2);
    request.mockReset().mockImplementation(fail);
    await requestFeishuApi(request, "Upload failed").catch(() => undefined);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    axiosError(230001, 400),
    { code: 230001, msg: "invalid request" },
    Object.assign(new Error("retired sender"), { code: "ECONNRESET", retryable: false }),
  ])("does not replay permanent failures: %j", async (failure) => {
    const request = vi.fn(async () => {
      if (failure instanceof Error) {
        throw failure;
      }
      return failure;
    });
    await requestFeishuApi(request, "Send failed", { retryTransient: true }).catch(() => undefined);
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not retry a null rejection", async () => {
    const request = vi.fn().mockRejectedValue(null);
    const result = requestFeishuApi(request, "Feishu send failed");
    await expect(result).rejects.toThrow("Feishu send failed");
    await expect(result).rejects.toThrow("Retry failed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "gateway rejection",
      fail: () => Promise.reject(axiosError(undefined, 429)),
      diagnostic: '"http_status":429',
    },
    {
      name: "fulfilled tenant rate limit",
      fail: () => Promise.resolve({ code: 11232, msg: "rate limit" }),
      diagnostic: '"feishu_code":11232',
    },
  ])("exhausts the retry budget and wraps $name", async ({ fail, diagnostic }) => {
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
});
