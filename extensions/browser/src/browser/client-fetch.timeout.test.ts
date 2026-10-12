// Browser tests cover control-client timeoutMs forwarding into fetchWithSsrFGuard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  getBridgeAuthForPort: vi.fn(() => undefined),
}));

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const browserControlUrl = "http://127.0.0.1:18791/ok";

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return { ...actual, getRuntimeConfig: authMocks.loadConfig, loadConfig: authMocks.loadConfig };
});
vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: authMocks.resolveBrowserControlAuth,
}));
vi.mock("./bridge-auth-registry.js", () => ({
  getBridgeAuthForPort: authMocks.getBridgeAuthForPort,
}));
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
    const init = { timeoutMs: 1_500 };
    const expectedTimeoutMs = 1_500;
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      finalUrl: browserControlUrl,
      release: async () => {},
    });

    await fetchBrowserJson(browserControlUrl, init);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: browserControlUrl,
        timeoutMs: expectedTimeoutMs,
        signal: expect.any(AbortSignal),
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
