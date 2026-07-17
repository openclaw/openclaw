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
});

describe("tlon urbit auth body drain", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drains a streamed response body and extracts the set-cookie header", async () => {
    const cookieValue = "urbauth-~zod=456; Path=/; HttpOnly";
    const body = new TextEncoder().encode("login ok");
    const response = new Response(new Blob([body]).stream(), {
      status: 200,
      headers: { "set-cookie": cookieValue },
    });

    const mockFetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", mockFetch);
    const lookupFn = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

    const cookie = await authenticate("http://127.0.0.1:8080", "code", {
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn,
      fetchImpl: mockFetch as typeof fetch,
    });
    expect(cookie).toContain("urbauth-~zod=456");
  });

  it("cancels the body stream after the drain cap for an oversized response", async () => {
    const cookieValue = "urbauth-~zod=789; Path=/; HttpOnly";
    const largeBody = new Uint8Array(256 * 1024).fill(0x78);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(largeBody);
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "set-cookie": cookieValue },
    });

    const mockFetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", mockFetch);
    const lookupFn = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

    const cookie = await authenticate("http://127.0.0.1:8080", "code", {
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn,
      fetchImpl: mockFetch as typeof fetch,
    });
    expect(cookie).toContain("urbauth-~zod=789");
  });

  it("handles a body-less response fallback via text() without failing", async () => {
    const cookieValue = "urbauth-~zod=nobody; Path=/; HttpOnly";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      text: async () => "small body",
      headers: new Headers({ "set-cookie": cookieValue }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const lookupFn = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

    const cookie = await authenticate("http://127.0.0.1:8080", "code", {
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn,
      fetchImpl: mockFetch as typeof fetch,
    });
    expect(cookie).toContain("urbauth-~zod=nobody");
  });
});
