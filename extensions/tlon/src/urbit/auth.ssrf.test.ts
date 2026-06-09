// Tlon tests cover auth.ssrf plugin behavior.
import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-policy";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-policy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./auth.js";

describe("tlon urbit auth ssrf", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks private IPs by default", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await expect(authenticate("http://127.0.0.1:8080", "code")).rejects.toBeInstanceOf(
      SsrFBlockedError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("allows private IPs when allowPrivateNetwork is enabled", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
      headers: new Headers({
        "set-cookie": "urbauth-~zod=123; Path=/; HttpOnly",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const lookupFn = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

    const cookie = await authenticate("http://127.0.0.1:8080", "code", {
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn,
      fetchImpl: mockFetch as typeof fetch,
    });
    expect(cookie).toContain("urbauth-~zod=123");
    expect(mockFetch).toHaveBeenCalled();
  });

  it("blocks redirect targets that resolve to private IPs", async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://metadata.example.test/latest" },
        }),
    );
    const lookupFn = (async (hostname: string) => {
      if (hostname === "metadata.example.test") {
        return [{ address: "169.254.169.254", family: 4 }];
      }
      return [{ address: "93.184.216.34", family: 4 }];
    }) as unknown as LookupFn;

    await expect(
      authenticate("https://public-ship.example.test", "code", {
        lookupFn,
        fetchImpl: mockFetch as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
