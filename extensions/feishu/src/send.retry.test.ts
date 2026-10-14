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
