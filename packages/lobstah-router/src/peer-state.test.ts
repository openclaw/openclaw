import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPACITY_TTL_MS,
  FAILURE_COOLDOWN_MS,
  MAX_CONSECUTIVE_FAILURES,
  getCapacity,
  isHealthy,
  markFailed,
  markSucceeded,
  resetPeerState,
} from "./peer-state.js";

const peer = (pubkey: string, url = "http://example.invalid:1") => ({ pubkey, url });

const okFetch = (body: unknown) =>
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  } as unknown as Response);

const errorFetch = (status = 500) =>
  vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => "",
  } as unknown as Response);

const throwingFetch = () => vi.fn().mockRejectedValue(new Error("network down"));

describe("peer-state", () => {
  beforeEach(() => {
    resetPeerState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("isHealthy", () => {
    it("is healthy by default for an unknown peer", () => {
      expect(isHealthy("lob1unknown")).toBe(true);
    });

    it("stays healthy below the failure threshold", () => {
      const pk = "lob1a";
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) markFailed(pk);
      expect(isHealthy(pk)).toBe(true);
    });

    it("becomes unhealthy at the failure threshold", () => {
      const pk = "lob1b";
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) markFailed(pk);
      expect(isHealthy(pk)).toBe(false);
    });

    it("recovers after the cooldown elapses", () => {
      vi.useFakeTimers();
      const pk = "lob1c";
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) markFailed(pk);
      expect(isHealthy(pk)).toBe(false);
      vi.advanceTimersByTime(FAILURE_COOLDOWN_MS + 1);
      expect(isHealthy(pk)).toBe(true);
    });

    it("markSucceeded clears failures", () => {
      const pk = "lob1d";
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) markFailed(pk);
      expect(isHealthy(pk)).toBe(false);
      markSucceeded(pk);
      expect(isHealthy(pk)).toBe(true);
    });
  });

  describe("getCapacity", () => {
    it("fetches and caches on first call", async () => {
      const mock = okFetch({ pubkey: "lob1e", models: ["llama3.1:8b"], queueDepth: 0 });
      vi.stubGlobal("fetch", mock);
      const cap = await getCapacity(peer("lob1e"));
      expect(cap?.models).toEqual(["llama3.1:8b"]);
      // Second call within TTL should not re-fetch
      const cap2 = await getCapacity(peer("lob1e"));
      expect(cap2?.models).toEqual(["llama3.1:8b"]);
      expect(mock).toHaveBeenCalledTimes(1);
    });

    it("re-fetches after the cache TTL", async () => {
      vi.useFakeTimers();
      const mock = okFetch({ pubkey: "lob1f", models: ["m1"], queueDepth: 0 });
      vi.stubGlobal("fetch", mock);
      await getCapacity(peer("lob1f"));
      vi.advanceTimersByTime(CAPACITY_TTL_MS + 1);
      await getCapacity(peer("lob1f"));
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it("returns null and marks failed on HTTP error", async () => {
      vi.stubGlobal("fetch", errorFetch(503));
      const cap = await getCapacity(peer("lob1g"));
      expect(cap).toBeNull();
      // first failure does not yet trip threshold (MAX=2)
      const cap2 = await getCapacity(peer("lob1g"));
      expect(cap2).toBeNull();
      expect(isHealthy("lob1g")).toBe(false);
    });

    it("returns null and marks failed on network exception", async () => {
      vi.stubGlobal("fetch", throwingFetch());
      const cap = await getCapacity(peer("lob1h"));
      expect(cap).toBeNull();
      await getCapacity(peer("lob1h"));
      expect(isHealthy("lob1h")).toBe(false);
    });
  });
});
