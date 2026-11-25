import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY as channelConcurrency } from "./qa-channel-transport.js";
import { mapQaSuiteWithConcurrency, normalizeQaSuiteConcurrency } from "./suite-planning.js";

describe("qa suite concurrency", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("normalizes suite concurrency to a bounded integer", () => {
    vi.stubEnv("OPENCLAW_QA_SUITE_CONCURRENCY", undefined);
    expect(normalizeQaSuiteConcurrency(undefined, 10)).toBe(10);
    expect(normalizeQaSuiteConcurrency(undefined, 80)).toBe(64);
    expect(normalizeQaSuiteConcurrency(undefined, 80, channelConcurrency)).toBe(4);
    expect(normalizeQaSuiteConcurrency(2.8, 10)).toBe(2);
    expect(normalizeQaSuiteConcurrency(20, 3)).toBe(3);
    expect(normalizeQaSuiteConcurrency(0, 3)).toBe(1);

    const envValues = { "3": 3, "0": 1, "0x10": 10, "1e2": 10, "2.5": 10 };
    for (const [value, expected] of Object.entries(envValues)) {
      vi.stubEnv("OPENCLAW_QA_SUITE_CONCURRENCY", value);
      expect(normalizeQaSuiteConcurrency(undefined, 10)).toBe(expected);
    }
  });

  it("maps suite work with bounded concurrency while preserving order", async () => {
    let active = 0;
    let maxActive = 0;
    const bothStarted = createDeferred<void>();
    const release = createDeferred<void>();

    const resultPromise = mapQaSuiteWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) {
        bothStarted.resolve();
      }
      await release.promise;
      active -= 1;
      return item * 10;
    });

    await bothStarted.promise;
    expect(maxActive).toBe(2);
    release.resolve();
    expect(await resultPromise).toEqual([10, 20, 30, 40]);
  });

  it("stops sequential suite work after the first matching result", async () => {
    const started: number[] = [];
    const result = await mapQaSuiteWithConcurrency(
      [1, 2, 3, 4],
      1,
      async (item) => {
        started.push(item);
        return { item, failed: item === 2 };
      },
      { shouldStop: (entry) => entry.failed },
    );

    expect(started).toEqual([1, 2]);
    expect(result).toEqual([
      { item: 1, failed: false },
      { item: 2, failed: true },
    ]);
  });

  it("drains started workers before propagating an undefined first rejection", async () => {
    const rejectFirst = vi.fn<() => Promise<never>>().mockRejectedValue(undefined);
    const sibling = createDeferred<void>();
    const bothStarted = createDeferred<void>();
    const started: number[] = [];
    const settled = vi.fn((outcome: { rejected: boolean; error: unknown }) => outcome);
    const run = mapQaSuiteWithConcurrency([1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 1) {
        await bothStarted.promise;
        return await rejectFirst();
      }
      bothStarted.resolve();
      await sibling.promise;
      throw new Error("later sibling failure");
    }).then(
      () => settled({ rejected: false, error: undefined }),
      (error: unknown) => settled({ rejected: true, error }),
    );
    await bothStarted.promise;
    await nextTurn();
    expect(started).toEqual([1, 2]);
    expect(settled).not.toHaveBeenCalled();
    sibling.resolve();
    expect(await run).toEqual({ rejected: true, error: undefined });
    expect(started).toEqual([1, 2]);
  });

  it("drains the stagger gate without admitting waiting workers after a rejection", async () => {
    const stagger = createDeferred<void>();
    const started = createDeferred<void>();
    const failure = new Error("first worker failed");
    const mapper = vi.fn(async () => {
      started.resolve();
      throw failure;
    });
    const sleepImpl = vi.fn(() => stagger.promise);
    const settled = vi.fn((error: unknown) => error);
    const run = mapQaSuiteWithConcurrency([1, 2, 3], 3, mapper, {
      startStaggerMs: 25,
      sleepImpl,
    }).catch(settled);
    await started.promise;
    await nextTurn();
    expect(settled).not.toHaveBeenCalled();
    expect(mapper).toHaveBeenCalledOnce();
    stagger.resolve();
    expect(await run).toBe(failure);
    expect(mapper).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledExactlyOnceWith(25);
  });

  it("staggers scenario starts without reducing mapped concurrency", async () => {
    const sleeps: number[] = [];
    const releaseSleeps = Array.from({ length: 3 }, () => createDeferred<void>());
    const started: number[] = [];
    const waitForStarted = (expected: number[]) =>
      vi.waitFor(() => expect(started).toEqual(expected));
    const resultPromise = mapQaSuiteWithConcurrency(
      [1, 2, 3, 4],
      3,
      async (item) => {
        started.push(item);
        return item;
      },
      {
        startStaggerMs: 25,
        sleepImpl: (ms) => {
          sleeps.push(ms);
          return releaseSleeps[sleeps.length - 1]!.promise;
        },
      },
    );

    await waitForStarted([1]);
    releaseSleeps[0]!.resolve();
    await waitForStarted([1, 2]);
    releaseSleeps[1]!.resolve();
    await waitForStarted([1, 2, 3]);
    releaseSleeps[2]!.resolve();
    await waitForStarted([1, 2, 3, 4]);

    expect(await resultPromise).toEqual([1, 2, 3, 4]);
    expect(sleeps).toEqual([25, 25, 25]);
  });
});
