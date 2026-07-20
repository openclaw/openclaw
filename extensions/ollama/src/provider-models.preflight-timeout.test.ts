// Exercise the real guard: its timeout owns DNS/proxy preflight as well as fetch.
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOllamaModels } from "./provider-models.js";

const stalledLookup: LookupFn = (() => new Promise<never>(() => {})) as LookupFn;

const resolvingLookup: LookupFn = (async () => [
  { address: "127.0.0.1", family: 4 },
]) as unknown as LookupFn;

describe("fetchOllamaModels preflight timeout", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("times out when preflight lookup stalls before HTTP dispatch", async () => {
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    const fetchSpy = vi.fn(async () => new Response("should not run"));

    const started = Date.now();
    const result = await fetchOllamaModels("https://ollama.example.com", undefined, {
      fetchImpl: fetchSpy,
      lookupFn: stalledLookup,
    });
    const elapsedMs = Date.now() - started;

    expect(result).toEqual({ reachable: false, models: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(30_000);
  });

  it("still dispatches the fetch when preflight lookup resolves", async () => {
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
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

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ reachable: true, models: [{ name: "qwen3:32b" }] });
  });
});
