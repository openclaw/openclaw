// Prove rate-limited browser-control fetches do not await a never-settling body.cancel().
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  getBridgeAuthForPort: vi.fn(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return { ...actual, getRuntimeConfig: mocks.loadConfig, loadConfig: mocks.loadConfig };
});
vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
}));
vi.mock("./bridge-auth-registry.js", () => ({
  getBridgeAuthForPort: mocks.getBridgeAuthForPort,
}));

const { fetchBrowserJson } = await import("./client-fetch.js");

afterEach(() => {
  mocks.fetchWithSsrFGuard.mockReset();
  vi.restoreAllMocks();
});

describe("fetchBrowserJson rate-limit body cancel", () => {
  it("rejects without waiting when unread 429 body cancel never settles", async () => {
    let cancelStarted = false;
    const release = vi.fn(async () => {});
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: {
        ok: false,
        status: 429,
        bodyUsed: false,
        body: {
          cancel: () => {
            cancelStarted = true;
            return new Promise(() => {});
          },
        },
      } as unknown as Response,
      release,
    });

    const startedAt = Date.now();
    await expect(
      Promise.race([
        fetchBrowserJson("http://127.0.0.1:18791/ok", { timeoutMs: 250 }),
        new Promise<never>((_, reject) => {
          AbortSignal.timeout(1_000).addEventListener("abort", () => {
            reject(new Error("fetchBrowserJson hung waiting for body.cancel"));
          });
        }),
      ]),
    ).rejects.toThrow(/rate[ -]?limit/i);
    const elapsedMs = Date.now() - startedAt;

    expect(cancelStarted).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(elapsedMs).toBeLessThan(1_000);
    console.log(
      `[browser client-fetch cancel-nofollow proof] cancel_started=${cancelStarted} release_called=${release.mock.calls.length} elapsed_ms=${elapsedMs}`,
    );
  });
});
