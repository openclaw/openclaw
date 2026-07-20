// Exercise the real guard: its timeout owns DNS/proxy preflight as well as fetch.
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";
import { probeMattermost } from "./probe.js";

describe("probeMattermost preflight timeout", () => {
  it("times out when preflight lookup stalls before HTTP dispatch", async () => {
    const stalledLookup: LookupFn = (() => new Promise<never>(() => {})) as LookupFn;
    const fetchSpy = vi.fn(async () => new Response("should not run"));

    const started = Date.now();
    const result = await probeMattermost("https://mm.example.com", "bot-token", 80, false, {
      fetchImpl: fetchSpy,
      lookupFn: stalledLookup,
    });
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe("request timed out");
    expect(elapsedMs).toBeGreaterThanOrEqual(60);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
