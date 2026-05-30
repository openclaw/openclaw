import { afterEach, describe, expect, it, vi } from "vitest";
import { loginMiniMaxPortalOAuth, normalizeOAuthExpires } from "./oauth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeOAuthExpires", () => {
  it("converts relative expiry seconds into an absolute millisecond timestamp", () => {
    expect(normalizeOAuthExpires(86_400, 1_700_000_000_000)).toBe(1_700_086_400_000);
  });

  it("converts Unix second timestamps into milliseconds", () => {
    expect(normalizeOAuthExpires(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("preserves absolute millisecond timestamps", () => {
    expect(normalizeOAuthExpires(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("rejects unsafe and malformed expiry values", () => {
    expect(normalizeOAuthExpires(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeOAuthExpires(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(normalizeOAuthExpires("3600s")).toBeUndefined();
  });
});

describe("loginMiniMaxPortalOAuth", () => {
  it("rejects Date-invalid authorization expiries before formatting instructions", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      return new Response(
        JSON.stringify({
          user_code: "CODE",
          verification_uri: "https://example.com/device",
          expired_in: 8_700_000_000_000_000,
          state: body.get("state"),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const note = vi.fn(async () => undefined);

    await expect(
      loginMiniMaxPortalOAuth({
        openUrl: vi.fn(async () => undefined),
        note,
        progress: { update: vi.fn(), stop: vi.fn() },
      }),
    ).rejects.toThrow("invalid expired_in");
    expect(note).not.toHaveBeenCalled();
  });
});
