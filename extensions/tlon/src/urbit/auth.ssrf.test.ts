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
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("ok", {
        status: 200,
        headers: { "set-cookie": "urbauth-~zod=123; Path=/; HttpOnly" },
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
    expect(mockFetch).toHaveBeenCalled();
  });

  it("drains login response body up to 64KB and cancels oversized bodies", async () => {
    // Use a response body larger than the 64KB drain limit to prove the
    // stream is cancelled rather than buffered in memory.
    const largeBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(1024);
        // Enqueue 65 chunks = 65KB > 64KB limit
        for (let i = 0; i < 65; i++) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    const response = new Response(largeBody, {
      status: 200,
      headers: { "set-cookie": "urbauth-~zod=456; Path=/; HttpOnly" },
    });
    // Intercept getReader so we can spy on the reader's cancel call.
    const originalGetReader = response.body!.getReader.bind(response.body);
    let readerCancelSpy: ReturnType<typeof vi.fn>;
    vi.spyOn(response.body!, "getReader").mockImplementation(
      function (this: ReadableStream, options) {
        const reader = originalGetReader(options);
        readerCancelSpy = vi.spyOn(reader, "cancel");
        return reader;
      },
    );
    const mockFetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", mockFetch);
    const lookupFn = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

    const cookie = await authenticate("http://127.0.0.1:8080", "code", {
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn,
      fetchImpl: mockFetch as typeof fetch,
    });

    expect(cookie).toContain("urbauth-~zod=456");
    // Oversized body must be cancelled so the reader doesn't keep buffering.
    expect(readerCancelSpy!).toHaveBeenCalled();
  });
});
