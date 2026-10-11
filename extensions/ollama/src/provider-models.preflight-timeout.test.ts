// Exercise the real guard: its timeout owns DNS/proxy preflight as well as fetch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOllamaModels } from "./provider-models.js";

const { lookupMock, fetchMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  fetchMock: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({ ...params, fetchImpl: fetchMock, lookupFn: lookupMock }),
  };
});

const TAGS_TIMEOUT_MS = 5000;

describe("fetchOllamaModels preflight timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fetchMock.mockReset();
    lookupMock.mockReset();
  });

  it.each([
    { opts: undefined, budget: TAGS_TIMEOUT_MS },
    { opts: { timeoutMs: 150 }, budget: 150 },
  ])("aborts stalled preflight lookup at the $budget ms deadline", async ({ opts, budget }) => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    const lookupStarted = Promise.withResolvers<void>();
    lookupMock.mockImplementation(() => {
      lookupStarted.resolve();
      return new Promise<never>(() => {});
    });
    const fetchSpy = vi.fn(async () => new Response("should not run"));

    const started = Date.now();
    let settlement:
      | { result: Awaited<ReturnType<typeof fetchOllamaModels>>; elapsedMs: number }
      | undefined;
    fetchMock.mockImplementation(fetchSpy);
    const pending = fetchOllamaModels("https://ollama.example.com", opts).then((result) => {
      settlement = { result, elapsedMs: Date.now() - started };
    });
    try {
      await lookupStarted.promise;
      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(settlement).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settlement).toEqual({
        result: { reachable: false, models: [] },
        elapsedMs: budget,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      // Drain the default deadline even when a custom-budget assertion fails.
      await vi.advanceTimersByTimeAsync(TAGS_TIMEOUT_MS);
      await pending;
    }
  });
});
