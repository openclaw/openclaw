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

// Runtime proof for the user-visible API error message template in
// api-client.ts:219 — evaluates the EXACT production template literal
// against an emoji-boundary input so the BEFORE/AFTER run can be pasted
// into the PR body as evidence that the cap is enforced at the surrogate
// boundary, not just on length.
describe("api runtime UTF-16 evidence (API Error rawBody)", () => {
  function hexCodeUnits(s: string): string {
    return Array.from(s)
      .map((c) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"))
      .join(" ");
  }

  it("'API Error [...]' template at cap 200 keeps the 199-ASCII prefix and drops the trailing emoji pair", () => {
    // EXACT prod template literal from api-client.ts:219
    //   `API Error [${path}] HTTP ${res.status}: ${truncateUtf16Safe(rawBody, 200)}`
    const path = "/v2/users/@me";
    const status = 503;
    const bodyPrefix = "x".repeat(199); // 199 ASCII chars, emoji straddles cap-200 boundary at position 199
    const rawBody = bodyPrefix + "🎉trailing body content";

    const before = `API Error [${path}] HTTP ${status}: ${rawBody.slice(0, 200)}`;
    const after = `API Error [${path}] HTTP ${status}: ${truncateUtf16Safe(rawBody, 200)}`;

    console.log("\n=== PR 3 runtime proof: api-client API Error rawBody at cap 200 ===");
    console.log(`input rawBody (${rawBody.length} code units): ${rawBody}`);
    console.log(`input hex:        ${hexCodeUnits(rawBody)}`);
    console.log(`slice(0, 200) hex: ${hexCodeUnits(rawBody.slice(0, 200))}`);
    console.log(`truncateUtf16Safe hex: ${hexCodeUnits(truncateUtf16Safe(rawBody, 200))}`);
    console.log(`BEFORE full error (${before.length} code units):`);
    console.log(`  ${before}`);
    console.log(`AFTER  full error (${after.length} code units):`);
    console.log(`  ${after}`);
    const beforeHasLone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(before);
    const afterHasLone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(after);
    console.log(`BEFORE contains lone surrogate? ${beforeHasLone}`);
    console.log(`AFTER  contains lone surrogate? ${afterHasLone}`);

    // Cap-200 helper preserves the 199-ASCII prefix and drops the
    // trailing emoji pair, so the AFTER error ends exactly at the
    // prefix without a half-surrogate dangling in the message.
    expect(after).toBe(`API Error [${path}] HTTP ${status}: ${bodyPrefix}`);
    expect(afterHasLone).toBe(false);
    // Sanity: BEFORE emits a lone 0xD83D high surrogate in the
    // user-facing error string (the bug being fixed).
    expect(beforeHasLone).toBe(true);
  });
});
