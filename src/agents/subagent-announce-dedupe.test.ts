import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, runDedupedAnnounceDelivery } from "./subagent-announce-dedupe.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

afterEach(() => {
  __testing.resetAnnounceDeliveryDedupForTests();
});

const DELIVERED: SubagentAnnounceDeliveryResult = {
  delivered: true,
  path: "direct",
  phases: [{ phase: "direct-primary", delivered: true, path: "direct" }],
};

const NOT_DELIVERED: SubagentAnnounceDeliveryResult = {
  delivered: false,
  path: "none",
};

describe("runDedupedAnnounceDelivery", () => {
  it("coalesces concurrent calls for the same key to a single dispatch", async () => {
    const run = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return DELIVERED;
    });

    const key = "announce:v1:agent:main:sub:demo:run-1";
    const [first, second, third] = await Promise.all([
      runDedupedAnnounceDelivery(key, run),
      runDedupedAnnounceDelivery(key, run),
      runDedupedAnnounceDelivery(key, run),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toBe(DELIVERED);
    expect(second).toBe(DELIVERED);
    expect(third).toBe(DELIVERED);
  });

  it("returns cached delivered result without dispatching again on repeat calls", async () => {
    const run = vi.fn(async () => DELIVERED);
    const key = "announce:v1:agent:main:sub:demo:run-2";

    const first = await runDedupedAnnounceDelivery(key, run);
    const second = await runDedupedAnnounceDelivery(key, run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toBe(DELIVERED);
    expect(second).toBe(DELIVERED);
  });

  it("does not cache failed dispatches so retries can still run", async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? NOT_DELIVERED : DELIVERED;
    });
    const key = "announce:v1:agent:main:sub:demo:run-3";

    const first = await runDedupedAnnounceDelivery(key, run);
    expect(first).toEqual(NOT_DELIVERED);

    const second = await runDedupedAnnounceDelivery(key, run);
    expect(second).toBe(DELIVERED);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps different keys isolated", async () => {
    const run = vi.fn(async () => DELIVERED);
    await runDedupedAnnounceDelivery("announce:a", run);
    await runDedupedAnnounceDelivery("announce:b", run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache when no key is provided", async () => {
    const run = vi.fn(async () => DELIVERED);
    await runDedupedAnnounceDelivery(undefined, run);
    await runDedupedAnnounceDelivery(undefined, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("releases the in-flight slot when the dispatch throws", async () => {
    const error = new Error("transient gateway error");
    const run = vi
      .fn<() => Promise<SubagentAnnounceDeliveryResult>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(DELIVERED);
    const key = "announce:v1:agent:main:sub:demo:run-4";

    await expect(runDedupedAnnounceDelivery(key, run)).rejects.toBe(error);
    expect(__testing.hasInflight(key)).toBe(false);

    const result = await runDedupedAnnounceDelivery(key, run);
    expect(result).toBe(DELIVERED);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("expires cached entries after the configured TTL", async () => {
    __testing.resetAnnounceDeliveryDedupForTests(0);
    const run = vi.fn(async () => DELIVERED);
    const key = "announce:v1:agent:main:sub:demo:run-5";

    await runDedupedAnnounceDelivery(key, run);
    await runDedupedAnnounceDelivery(key, run);

    expect(run).toHaveBeenCalledTimes(2);
  });
});
