import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, postJson } from "./http.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockResponse(text: string, init: ResponseInit) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => new Response(text, init)),
  );
}

describe("QA Lab dashboard HTTP", () => {
  it("gives every API request a fresh 30 second deadline", async () => {
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
      expect(timeoutMs).toBe(30_000);
      const controller = controllers.shift();
      if (!controller) {
        throw new Error("unexpected timeout signal request");
      }
      return controller.signal;
    });
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await getJson("/api/bootstrap");
    await getJson("/api/ui-version", "no-store");
    await postJson("/api/runner/start", { scenario: "baseline" });

    expect(timeout).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/bootstrap",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/ui-version",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/runner/start",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });

  it("fails closed on non-JSON success responses", async () => {
    mockResponse("not json", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });

    await expect(getJson("/api/bootstrap")).rejects.toThrow(
      /\/api\/bootstrap: expected JSON response/,
    );
  });

  it("fails closed on empty JSON success responses", async () => {
    mockResponse("", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(getJson("/api/ui-version", "no-store")).rejects.toThrow(
      /\/api\/ui-version: empty JSON response/,
    );
  });

  it("labels malformed JSON success responses", async () => {
    mockResponse("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(getJson("/api/state")).rejects.toThrow(/\/api\/state: malformed JSON response/);
  });

  it("keeps JSON API error messages readable", async () => {
    mockResponse(JSON.stringify({ error: "boom" }), {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "content-type": "application/json" },
    });

    await expect(postJson("/api/runner/start", { scenario: "baseline" })).rejects.toThrow("boom");
  });
});
