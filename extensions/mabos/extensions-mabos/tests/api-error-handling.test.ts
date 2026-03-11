import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { httpRequest } from "../src/tools/common.js";

describe("httpRequest", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns data on successful JSON response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    });

    const result = await httpRequest("http://example.com/api", "GET", {}, undefined, 5000, 0);
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ ok: true });
  });

  it("returns status 0 with error on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await httpRequest("http://example.com/api", "GET", {}, undefined, 5000, 0);
    expect(result.status).toBe(0);
    expect((result.data as Record<string, unknown>).error).toContain("Network error");
  });

  it("returns status 0 on timeout", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const result = await httpRequest("http://example.com/api", "GET", {}, undefined, 50, 0);
    expect(result.status).toBe(0);
    expect((result.data as Record<string, unknown>).error).toContain("timed out");
  });

  it("retries on 503 and succeeds on second attempt", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 503,
          json: () => Promise.resolve({ error: "Service Unavailable" }),
        });
      }
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });
    });

    const result = await httpRequest("http://example.com/api", "GET", {}, undefined, 5000, 1);
    expect(result.status).toBe(200);
    expect(callCount).toBe(2);
  });

  it("retries on network error and succeeds on second attempt", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Connection refused"));
      }
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });
    });

    const result = await httpRequest("http://example.com/api", "GET", {}, undefined, 5000, 1);
    expect(result.status).toBe(200);
    expect(callCount).toBe(2);
  });

  it("does not retry on 4xx errors", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        status: 400,
        json: () => Promise.resolve({ error: "Bad Request" }),
      });
    });

    const result = await httpRequest("http://example.com/api", "GET", {}, undefined, 5000, 2);
    expect(result.status).toBe(400);
    expect(callCount).toBe(1);
  });

  it("includes url and method in error data", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const result = await httpRequest(
      "http://example.com/api/test",
      "POST",
      {},
      { data: 1 },
      5000,
      0,
    );
    expect(result.status).toBe(0);
    const data = result.data as Record<string, unknown>;
    expect(data.url).toBe("http://example.com/api/test");
    expect(data.method).toBe("POST");
  });

  it("sends JSON body when provided", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });
    });

    await httpRequest("http://example.com/api", "POST", {}, { key: "value" }, 5000, 0);
    expect(capturedBody).toBe(JSON.stringify({ key: "value" }));
  });
});
