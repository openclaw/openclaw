import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
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
  it("gives every API request an independent 30 second deadline", async (context) => {
    const controllers = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ] as const;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    for (const controller of controllers) {
      timeout.mockReturnValueOnce(controller.signal);
    }
    const pending: Array<{ signal: AbortSignal; settled: boolean; release: () => void }> = [];
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            throw new Error("request is missing its deadline signal");
          }
          const entry = {
            signal,
            settled: false,
            release: () => {
              signal.removeEventListener("abort", onAbort);
              entry.settled = true;
              resolve(Response.json({ ok: true }));
            },
          };
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            entry.settled = true;
            reject(signal.reason as Error);
          };
          pending.push(entry);
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const requests = [
      getJson("/api/bootstrap"),
      getJson("/api/ui-version", "no-store"),
      postJson("/api/runner/start", { scenario: "baseline" }),
    ];
    const settled = requests.map(() => false);
    const joined = Promise.allSettled(
      requests.map((request, index) =>
        request.finally(() => {
          settled[index] = true;
        }),
      ),
    );
    try {
      expect(pending).toHaveLength(3);
      expect(settled).toEqual([false, false, false]);
      expect(pending.map((request) => request.settled)).toEqual([false, false, false]);
      expect(timeout.mock.calls).toEqual([[30_000], [30_000], [30_000]]);
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

      const cancellation = new Error("request deadline reached");
      controllers[1].abort(cancellation);
      expect(pending.map((request) => request.signal.aborted)).toEqual([false, true, false]);
      expect(pending.map((request) => request.settled)).toEqual([false, true, false]);
      await withinTest(expect(requests[1]).rejects.toBe(cancellation), context.signal);
      expect(settled).toEqual([false, true, false]);
      for (const request of pending) {
        request.release();
      }
      await withinTest(expect(requests[0]).resolves.toEqual({ ok: true }), context.signal);
      await withinTest(expect(requests[2]).resolves.toEqual({ ok: true }), context.signal);
    } finally {
      for (const request of pending) {
        request.release();
      }
      await joined;
    }
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
