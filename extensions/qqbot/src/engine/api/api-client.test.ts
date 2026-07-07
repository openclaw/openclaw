// Qqbot tests cover api-client plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createStreamingResponse } from "../../../../test-support/streaming-error-response.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

import { ApiError } from "../types.js";
import { ApiClient } from "./api-client.js";

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("ApiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fetchWithSsrFGuardMock.mockReset();
  });

  it("bounds error bodies without using response.text()", async () => {
    const release = vi.fn(async () => {});
    const tracked = cancelTrackedResponse(`${"qqbot api unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: tracked.response,
      release,
    });

    const client = new ApiClient({ baseUrl: "https://qqbot.test" });

    let error: unknown;
    try {
      await client.request("token-1", "GET", "/v2/users/@me");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(String(error)).toContain("API Error [/v2/users/@me] HTTP 503");
    expect(String(error)).toContain("qqbot api unavailable");
    expect(String(error)).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://qqbot.test/v2/users/@me",
      init: {
        method: "GET",
        headers: {
          Authorization: "QQBot token-1",
          "Content-Type": "application/json",
          "User-Agent": "QQBotPlugin/unknown",
        },
        signal: expect.any(AbortSignal),
      },
      auditContext: "qqbot-api",
      policy: {
        hostnameAllowlist: ["qqbot.test"],
        allowRfc2544BenchmarkRange: true,
      },
    });
  });

  it("bounds successful response bodies without using response.text()", async () => {
    const release = vi.fn(async () => {});
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "x",
      headers: { "content-type": "application/json" },
    });
    const textSpy = vi.spyOn(streamed.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: streamed.response,
      release,
    });

    const client = new ApiClient({ baseUrl: "https://qqbot.test" });

    let error: unknown;
    try {
      await client.request("token-1", "GET", "/v2/users/@me");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(String(error)).toContain("QQBot API response: text response exceeds 16777216 bytes");
    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

// Cap-precise regression for the inline `truncateUtf16Safe` sites touched
// by this branch: API error rawBody at api-client.ts:218 (cap 200), COS
// PUT body preview at media-chunked.ts:583 (cap 120), retry attempt
// error message at retry.ts:91 (cap 100). Each test pins the exact
// code-unit output for one cap value, so the "safe truncation" claim is
// enforced at the boundary, not just on length.
describe("api UTF-16 truncation cap boundary", () => {
  it("cap 200 keeps a 199-char ASCII prefix and drops the trailing emoji pair", () => {
    // Mirrors the call shape at api-client.ts:218
    //   `API Error [${path}] HTTP ${res.status}: ${truncateUtf16Safe(rawBody, 200)}`
    const safePrefix = "x".repeat(199);
    expect(truncateUtf16Safe(safePrefix + "🎉 trailing body", 200)).toBe(safePrefix);
  });

  it("cap 120 keeps a 119-char ASCII prefix and drops the trailing emoji pair", () => {
    // Mirrors the call shape at media-chunked.ts:583
    //   `COS PUT failed: ${response.status} ${response.statusText} - ${truncateUtf16Safe(body, 120)}`
    const safePrefix = "x".repeat(119);
    expect(truncateUtf16Safe(safePrefix + "🎉 trailing body", 120)).toBe(safePrefix);
  });
});
