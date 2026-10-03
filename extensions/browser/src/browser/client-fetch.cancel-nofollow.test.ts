// Prove rate-limited browser-control fetches do not await a never-settling body.cancel().
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
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
  it.each(["pending", "rejected"])(
    "rejects promptly when body cancellation is %s",
    async (state) => {
      let cancelStarted = false;
      const release = vi.fn(async () => {});
      mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
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
