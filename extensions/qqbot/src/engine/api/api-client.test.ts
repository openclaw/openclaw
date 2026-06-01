import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../types.js";
import { ApiClient } from "./api-client.js";

describe("QQBot API client errors", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("adds troubleshooting guidance to network errors", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connect ECONNRESET");
    }) as typeof fetch;

    await expect(new ApiClient().request("token-1", "GET", "/gateway")).rejects.toMatchObject({
      name: "ApiError",
      httpStatus: 0,
      path: "/gateway",
      message: expect.stringMatching(
        /QQBot API request failed \[\/gateway\].*network connection.*server egress.*IP whitelist.*https:\/\/docs\.openclaw\.ai\/channels\/qqbot.*ECONNRESET/,
      ),
    } satisfies Partial<ApiError>);
  });
});
