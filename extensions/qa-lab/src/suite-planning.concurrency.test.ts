import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { QaSuiteArtifactError, QaSuiteCleanupError } from "./errors.js";
import { defaultQaSuiteConcurrencyForTransport } from "./qa-transport-registry.js";
import {
  mapQaSuiteWithConcurrency,
  normalizeQaSuiteConcurrency,
  resolveQaSuiteWorkerStartStaggerMs,
} from "./suite-planning.js";

describe("qa suite concurrency", () => {
  it("normalizes suite concurrency to a bounded integer", () => {
    const previous = process.env.OPENCLAW_QA_SUITE_CONCURRENCY;
    delete process.env.OPENCLAW_QA_SUITE_CONCURRENCY;
    try {
      expect(normalizeQaSuiteConcurrency(undefined, 10)).toBe(10);
      expect(normalizeQaSuiteConcurrency(undefined, 80)).toBe(64);
      expect(
        normalizeQaSuiteConcurrency(
          undefined,
          80,
          defaultQaSuiteConcurrencyForTransport("qa-channel"),
        ),
      ).toBe(4);
      expect(normalizeQaSuiteConcurrency(2.8, 10)).toBe(2);
      expect(normalizeQaSuiteConcurrency(20, 3)).toBe(3);
      expect(normalizeQaSuiteConcurrency(0, 3)).toBe(1);

      process.env.OPENCLAW_QA_SUITE_CONCURRENCY = "3";
      expect(normalizeQaSuiteConcurrency(undefined, 10)).toBe(3);

      process.env.OPENCLAW_QA_SUITE_CONCURRENCY = "0";
      expect(normalizeQaSuiteConcurrency(undefined, 10)).toBe(1);

      for (const value of ["0x10", "1e2", "2.5"]) {
        process.env.OPENCLAW_QA_SUITE_CONCURRENCY = value;
        expect(normalizeQaSuiteConcurrency(undefined, 10)).toBe(10);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_QA_SUITE_CONCURRENCY;
      } else {
        process.env.OPENCLAW_QA_SUITE_CONCURRENCY = previous;
      }
    }
  });

  it("maps suite work with bounded concurrency while preserving order", async () => {
    let active = 0;
    let maxActive = 0;
    let releaseStartedTasks = false;
    let resolveBothStarted: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    const taskReleases: Array<() => void> = [];
    const releaseQueuedTasks = () => {
      if (!releaseStartedTasks) {
        return;
      }
      let releaseTask: (() => void) | undefined;
      while ((releaseTask = taskReleases.shift())) {
        releaseTask();
      }
    };

    const resultPromise = mapQaSuiteWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) {
        resolveBothStarted();
      }
      await new Promise<void>((resolve) => {
        taskReleases.push(resolve);
        releaseQueuedTasks();
      });
      active -= 1;
      return item * 10;
    });

    await bothStarted;
    expect(maxActive).toBe(2);
    releaseStartedTasks = true;
    releaseQueuedTasks();
    const result = await resultPromise;
    expect(result).toEqual([10, 20, 30, 40]);
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

  it.each([new Error("publication failed"), undefined])(
    "drains started workers before propagating the first rejection (%s)",
    async (failure) => {
      const rejectFirst = vi.fn<() => Promise<never>>().mockRejectedValue(failure);
      const sibling = createDeferred<void>();
      const bothStarted = createDeferred<void>();
      const started: number[] = [];
      let settled = false;
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
        () => {
          settled = true;
          return { rejected: false, error: undefined };
        },
        (error: unknown) => {
          settled = true;
          return { rejected: true, error };
        },
      );
      await bothStarted.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(started).toEqual([1, 2]);
      expect(settled).toBe(false);
      sibling.resolve();
      expect(await run).toEqual({ rejected: true, error: failure });
      expect(started).toEqual([1, 2]);
    },
  );

  it.each(
    ["cleanup", "publication"].flatMap((kind) =>
      [new Error("first worker failed"), undefined].map((firstError) => ({ kind, firstError })),
    ),
  )(
    "retains a later $kind failure after draining workers ($firstError)",
    async ({ kind, firstError }) => {
      const cause = new Error("sibling finalization failed");
      const fatalError =
        kind === "cleanup"
          ? new QaSuiteCleanupError([cause], cause.message, { cause })
          : new QaSuiteArtifactError("publication_failed", cause.message, { cause });
      const rejectFirst = vi.fn<() => Promise<never>>().mockRejectedValue(firstError);
      const bothStarted = createDeferred<void>();
      const sibling = createDeferred<void>();
      const started: number[] = [];
      let settled = false;
      const pending = mapQaSuiteWithConcurrency([1, 2, 3], 2, async (item) => {
        started.push(item);
        if (item === 1) {
          await bothStarted.promise;
          return await rejectFirst();
        }
        bothStarted.resolve();
        await sibling.promise;
        throw fatalError;
      }).catch((error: unknown) => {
        settled = true;
        return error;
      });
      await bothStarted.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(started).toEqual([1, 2]);
      expect(settled).toBe(false);
      sibling.resolve();
      const failure = await pending;
      expect(failure).toBeInstanceOf(
        kind === "cleanup" ? QaSuiteCleanupError : QaSuiteArtifactError,
      );
      const aggregate = kind === "cleanup" ? failure : (failure as QaSuiteArtifactError).cause;
      expect(aggregate).toBeInstanceOf(AggregateError);
      expect((aggregate as AggregateError).cause).toBe(firstError);
      expect((aggregate as AggregateError).errors).toHaveLength(2);
      expect((aggregate as AggregateError).errors[0]).toBe(firstError);
      expect((aggregate as AggregateError).errors[1]).toBe(fatalError);
      expect(started).toEqual([1, 2]);
    },
  );

  it("drains the stagger gate without admitting waiting workers after a rejection", async () => {
    const stagger = createDeferred<void>();
    const started = createDeferred<void>();
    const failure = new Error("first worker failed");
    const mapper = vi.fn(async () => {
      started.resolve();
      throw failure;
    });
    const sleepImpl = vi.fn(() => stagger.promise);
    let settled = false;
    const run = mapQaSuiteWithConcurrency([1, 2, 3], 3, mapper, {
      startStaggerMs: 25,
      sleepImpl,
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await started.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    expect(mapper).toHaveBeenCalledOnce();
    stagger.resolve();
    expect(await run).toBe(failure);
    expect(mapper).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledExactlyOnceWith(25);
  });

  it("staggers scenario starts without reducing mapped concurrency", async () => {
    const sleeps: number[] = [];
    const releaseSleeps: Array<() => void> = [];
    const started: number[] = [];
    const waitForStarted = async (expected: number[]) => {
      await vi.waitFor(() => {
        expect(started).toEqual(expected);
      });
    };
    const resultPromise = mapQaSuiteWithConcurrency(
      [1, 2, 3, 4],
      3,
      async (item) => {
        started.push(item);
        return item;
      },
      {
        startStaggerMs: 25,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
          await new Promise<void>((resolve) => {
            releaseSleeps.push(resolve);
          });
        },
      },
    );

    await waitForStarted([1]);
    releaseSleeps.shift()?.();
    await waitForStarted([1, 2]);
    releaseSleeps.shift()?.();
    await waitForStarted([1, 2, 3]);
    releaseSleeps.shift()?.();
    await waitForStarted([1, 2, 3, 4]);

    const result = await resultPromise;
    expect(result).toEqual([1, 2, 3, 4]);
    expect(sleeps).toEqual([25, 25, 25]);
  });

  it("resolves a default worker startup stagger for concurrent suite workers", () => {
    expect(resolveQaSuiteWorkerStartStaggerMs(1, {})).toBe(0);
    expect(resolveQaSuiteWorkerStartStaggerMs(4, {})).toBe(1500);
    expect(
      resolveQaSuiteWorkerStartStaggerMs(4, {
        OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS: "0",
      }),
    ).toBe(0);
    expect(
      resolveQaSuiteWorkerStartStaggerMs(4, {
        OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS: "25",
      }),
    ).toBe(25);
    for (const value of ["0x10", "1e3", "10.5"]) {
      expect(
        resolveQaSuiteWorkerStartStaggerMs(4, {
          OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS: value,
        }),
      ).toBe(1500);
    }
    expect(resolveQaSuiteWorkerStartStaggerMs(4, {}, 500)).toBe(500);
    expect(
      resolveQaSuiteWorkerStartStaggerMs(
        4,
        {
          OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS: "25",
        },
        500,
      ),
    ).toBe(25);
  });
});
