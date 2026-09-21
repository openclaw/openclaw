// Exercise the real guard: its timeout owns DNS/proxy preflight as well as fetch.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeMattermost } from "./probe.js";

describe("probeMattermost preflight timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("times out when preflight lookup stalls before HTTP dispatch", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    const lookupStarted = createDeferred<void>();
    const stalledLookup: LookupFn = (() => {
      lookupStarted.resolve();
      return new Promise<never>(() => {});
    }) as LookupFn;
    const fetchSpy = vi.fn(async () => new Response("should not run"));
    const settled = vi.fn();

    const pending = probeMattermost("https://mm.example.com", "bot-token", 80, false, {
      fetchImpl: fetchSpy,
      lookupFn: stalledLookup,
    }).then((result) => {
      settled(result);
      return result;
    });
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
