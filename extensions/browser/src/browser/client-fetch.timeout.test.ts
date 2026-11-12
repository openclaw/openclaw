// Browser tests cover control-client timeoutMs forwarding into fetchWithSsrFGuard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./client-fetch.auth.test-support.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const browserControlUrl = "http://127.0.0.1:18791/ok";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

const { fetchBrowserJson } = await import("./client-fetch.js");

describe("fetchBrowserJson timeout forwarding", () => {
  beforeEach(() => fetchWithSsrFGuardMock.mockReset());

  it("forwards the caller-provided timeout to the guarded fetch", async () => {
    const init = { timeoutMs: 1_500, signal: new AbortController().signal };
    const expectedTimeoutMs = 1_500;
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: Response.json({ ok: true }),
      finalUrl: browserControlUrl,
      release: async () => {},
    });

    await fetchBrowserJson(browserControlUrl, init);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: browserControlUrl,
        timeoutMs: expectedTimeoutMs,
        init: expect.objectContaining({ signal: init.signal }),
        auditContext: "browser-control-client",
        policy: { allowPrivateNetwork: true },
      }),
    );
  });
});

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

describe("fetchBrowserJson rate-limit body cancel", () => {
  it.each(["pending", "rejected"])(
    "rejects promptly when body cancellation is %s",
    async (state) => {
      let cancelStarted = false;
      const release = vi.fn(async () => {});
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response(
          new ReadableStream({
            cancel: () => {
              cancelStarted = true;
              return state === "pending"
                ? new Promise<void>(() => {})
                : Promise.reject(new Error("cancellation failed"));
            },
          }),
          { status: 429 },
        ),
        release,
      });

      await expect(fetchBrowserJson("http://127.0.0.1:18791/ok")).rejects.toThrow(
        /rate[ -]?limit/i,
      );
      expect(cancelStarted).toBe(true);
      expect(release).toHaveBeenCalledOnce();
    },
  );
});
