// Exercise the real guard: its timeout owns DNS/proxy preflight as well as fetch.
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOllamaModels } from "./provider-models.js";

const TAGS_TIMEOUT_MS = 5000;

describe("fetchOllamaModels preflight timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    { opts: undefined, budget: TAGS_TIMEOUT_MS },
    { opts: { timeoutMs: 150 }, budget: 150 },
  ])("aborts stalled preflight lookup at the $budget ms deadline", async ({ opts, budget }) => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    const lookupStarted = Promise.withResolvers<void>();
    const stalledLookup: LookupFn = (() => {
      lookupStarted.resolve();
      return new Promise<never>(() => {});
    }) as LookupFn;
    const fetchSpy = vi.fn(async () => new Response("should not run"));

    const started = Date.now();
    let settlement:
      | { result: Awaited<ReturnType<typeof fetchOllamaModels>>; elapsedMs: number }
      | undefined;
    const pending = fetchOllamaModels("https://ollama.example.com", opts, {
      fetchImpl: fetchSpy,
      lookupFn: stalledLookup,
    }).then((result) => {
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

  it("still dispatches the fetch when preflight lookup resolves", async () => {
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    let lookupCalls = 0;
    const resolvingLookup: LookupFn = (async () => {
      lookupCalls += 1;
      return [{ address: "127.0.0.1", family: 4 }];
    }) as unknown as LookupFn;
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ models: [{ name: "qwen3:32b" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await fetchOllamaModels("https://ollama.example.com", undefined, {
      fetchImpl: fetchSpy,
      lookupFn: resolvingLookup,
    });

    expect(lookupCalls).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ reachable: true, models: [{ name: "qwen3:32b" }] });
  });
});
