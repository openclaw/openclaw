// Exercise the real guard: its timeout owns DNS/proxy preflight as well as fetch.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeMattermost } from "./probe.js";

const { lookupMock, fetchSpy } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  fetchSpy: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({ ...params, fetchImpl: fetchSpy, lookupFn: lookupMock }),
  };
});

describe("probeMattermost preflight timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    lookupMock.mockReset();
    fetchSpy.mockReset();
  });

  it("times out when preflight lookup stalls before HTTP dispatch", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    const lookupStarted = createDeferred<void>();
    lookupMock.mockImplementation(() => {
      lookupStarted.resolve();
      return new Promise<never>(() => {});
    });
    fetchSpy.mockResolvedValue(new Response("should not run"));
    const settled = vi.fn();

    const pending = probeMattermost("https://mm.example.com", "bot-token", 80, false).then(
      (result) => {
        settled(result);
        return result;
      },
    );
    await lookupStarted.promise;
    await vi.advanceTimersByTimeAsync(79);
    expect(settled).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe("request timed out");
    expect(result.elapsedMs).toBe(80);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
