import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, getJsonNoStore } from "./http.js";

/**
 * Evidence tests for PR #109985 — QA Lab HTTP body cancel
 *
 * Verifies that response.body is cancelled before throwing on HTTP error.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("QA Lab HTTP body cancel on HTTP error", () => {
  it("getJson 400: body cancelled", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.resolve({
          ok: false,
          status: 400,
          statusText: "Bad Request",
          body: { cancel },
          json: () => Promise.reject(new Error("body cancelled")),
        } as unknown as Response),
      ),
    );

    await expect(getJson("/test")).rejects.toThrow("400 Bad Request");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("getJson 403: body cancelled", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.resolve({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          body: { cancel },
          json: () => Promise.reject(new Error("body cancelled")),
        } as unknown as Response),
      ),
    );

    await expect(getJson("/test")).rejects.toThrow("403 Forbidden");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("getJson 500: body cancelled", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          body: { cancel },
          json: () => Promise.reject(new Error("body cancelled")),
        } as unknown as Response),
      ),
    );

    await expect(getJson("/test")).rejects.toThrow("500 Internal Server Error");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("getJsonNoStore 429: body cancelled", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.resolve({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          body: { cancel },
          json: () => Promise.reject(new Error("body cancelled")),
        } as unknown as Response),
      ),
    );

    await expect(getJsonNoStore("/test")).rejects.toThrow("429 Too Many Requests");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("getJsonNoStore 503: body cancelled", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.resolve({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          body: { cancel },
          json: () => Promise.reject(new Error("body cancelled")),
        } as unknown as Response),
      ),
    );

    await expect(getJsonNoStore("/test")).rejects.toThrow("503 Service Unavailable");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("Null body: safe (no error on missing body)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.resolve({
          ok: false,
          status: 400,
          statusText: "Bad Request",
          body: null,
          json: () => Promise.reject(new Error("body cancelled")),
        } as unknown as Response),
      ),
    );

    // Should not throw from cancel on null body
    await expect(getJson("/test")).rejects.toThrow("400 Bad Request");
  });

  it("Cancel rejection: suppressed", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.resolve({
          ok: false,
          status: 400,
          statusText: "Bad Request",
          body: { cancel },
          json: () => Promise.reject(new Error("body cancelled")),
        } as unknown as Response),
      ),
    );

    // Should NOT propagate the cancel rejection
    await expect(getJson("/test")).rejects.toThrow("400 Bad Request");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
