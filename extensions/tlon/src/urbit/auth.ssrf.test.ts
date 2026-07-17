// Tlon tests cover auth.ssrf plugin behavior.
import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
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

  it("bounds successful login response body draining before returning the cookie", async () => {
    let cancelled = false;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(16 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          "set-cookie": "urbauth-~zod=123; Path=/; HttpOnly",
        },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);
    const lookupFn = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

    const cookie = await authenticate("http://127.0.0.1:8080", "code", {
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn,
      fetchImpl: mockFetch as typeof fetch,
    });

    expect(cookie).toContain("urbauth-~zod=123");
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThanOrEqual(5);
  });
});
