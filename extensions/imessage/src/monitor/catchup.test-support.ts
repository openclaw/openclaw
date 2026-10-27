import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getIMessageRuntime } from "../runtime.js";
import {
  capFailureRetriesMap,
  IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
  IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
  resolveIMessageCatchupCursorKey,
  type IMessageCatchupCursor,
} from "../state-contract.js";
import { installIMessageStateRuntimeForTest } from "../test-support/runtime.js";
import {
  advanceIMessageCatchupCursor,
  performIMessageCatchup,
  resolveCatchupConfig,
  type CatchupDispatchFn,
  type CatchupFetchFn,
  type IMessageCatchupRow,
} from "./catchup.js";

describe("catchup", () => {
  const liveConfig = resolveCatchupConfig({ enabled: true, maxFailureRetries: 3 });
  beforeEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    installIMessageStateRuntimeForTest();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
  });

  function advance(lastSeenRowid: number, lastSeenMs: number, config = liveConfig) {
    return advanceIMessageCatchupCursor("primary", { lastSeenMs, lastSeenRowid }, config);
  }

  function openCatchupCursorStore() {
    return getIMessageRuntime().state.openKeyedStoreV2<IMessageCatchupCursor>({
      namespace: IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
      maxEntries: IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
    });
  }

  async function loadCursor(): Promise<IMessageCatchupCursor | null> {
    return (
      (await openCatchupCursorStore().lookup(resolveIMessageCatchupCursorKey("primary"))) ?? null
    );
  }

  async function expectCursor(expected: Partial<IMessageCatchupCursor>) {
    const cursor = await loadCursor();
    expect(cursor).toMatchObject(expected);
    if (expected.failureRetries) {
      expect(cursor?.failureRetries).toEqual(expected.failureRetries);
    }
  }

  async function seedCursor(
    lastSeenRowid: number,
    lastSeenMs: number,
    failureRetries?: Record<string, number>,
  ): Promise<void> {
    await openCatchupCursorStore().register(resolveIMessageCatchupCursorKey("primary"), {
      lastSeenRowid,
      lastSeenMs,
      ...(failureRetries ? { failureRetries } : {}),
      updatedAt: Date.now(),
    });
  }

  describe("resolveCatchupConfig", () => {
    it("falls back to defaults when raw is undefined", () => {
      expect(resolveCatchupConfig(undefined)).toEqual({
        enabled: false,
        maxAgeMinutes: 120,
        perRunLimit: 50,
        firstRunLookbackMinutes: 30,
        maxFailureRetries: 10,
      });
    });

    it.each([
      [
        "ceiling",
        { enabled: true, maxAgeMinutes: 99_999, perRunLimit: 10_000, maxFailureRetries: 50_000 },
        { enabled: true, maxAgeMinutes: 720, perRunLimit: 500, maxFailureRetries: 1000 },
      ],
      [
        "floor",
        { maxAgeMinutes: 0, perRunLimit: -10, firstRunLookbackMinutes: -1, maxFailureRetries: 0 },
        { maxAgeMinutes: 1, perRunLimit: 1, firstRunLookbackMinutes: 1, maxFailureRetries: 1 },
      ],
    ] as const)("clamps input to the documented %s", (_, input, expected) => {
      expect(resolveCatchupConfig(input)).toMatchObject(expected);
    });
  });

  describe("advanceIMessageCatchupCursor", () => {
    it("advances monotonically from a live-handled row and preserves given-up retry state", async () => {
      await seedCursor(42, 1_700_000_000_000, { "GIVEN-UP": 3 });

      await expect(advance(41, 1_700_000_001_000)).resolves.toBe(false);
      await expect(advance(50, 1_700_000_002_000)).resolves.toBe(true);

      await expectCursor({
        lastSeenRowid: 50,
        lastSeenMs: 1_700_000_002_000,
        failureRetries: { "GIVEN-UP": 3 },
      });
    });

    it("does not advance from live rows while a catchup failure is still retrying", async () => {
      await seedCursor(42, 1_700_000_000_000, { RETRYING: 1 });

      await expect(advance(50, 1_700_000_002_000)).resolves.toBe(false);

      await expectCursor({ lastSeenRowid: 42, failureRetries: { RETRYING: 1 } });
    });
  });

  describe("capFailureRetriesMap", () => {
    it.each([
      [{ a: 1, b: 2 }, 10, { a: 1, b: 2 }],
      [{ a: 1, b: 9, c: 5, d: 9 }, 2, { b: 9, d: 9 }],
    ] as const)("retains the highest retry counts within cap: %j / %i", (map, cap, expected) => {
      expect(capFailureRetriesMap(map, cap)).toEqual(expected);
    });

    it("keeps the persisted retry map under the plugin-state value budget", () => {
      const map = Object.fromEntries(
        Array.from({ length: 800 }, (_, index) => [`GUID-${index}-${"x".repeat(120)}`, index + 1]),
      );

      const capped = capFailureRetriesMap(map);

      expect(Object.keys(capped).length).toBeLessThanOrEqual(512);
      expect(new TextEncoder().encode(JSON.stringify(capped)).byteLength).toBeLessThanOrEqual(
        48_000,
      );
    });
  });

  describe("performIMessageCatchup", () => {
    const config = resolveCatchupConfig({ enabled: true });
    const now = 1_700_001_000_000;
    const row = (
      guid: string,
      rowid: number,
      overrides: Partial<IMessageCatchupRow> = {},
    ): IMessageCatchupRow => ({ guid, rowid, date: now - 60_000, isFromMe: false, ...overrides });
    type RunOptions = Partial<Omit<Parameters<typeof performIMessageCatchup>[0], "accountId">> &
      Partial<Pick<Awaited<ReturnType<CatchupFetchFn>>, "highWatermarkRowid" | "highWatermarkMs">>;
    function run(rows: IMessageCatchupRow[], options: RunOptions = {}) {
      const { highWatermarkRowid, highWatermarkMs, ...params } = options;
      const fetch =
        options.fetch ??
        vi.fn<CatchupFetchFn>(async () => ({
          resolved: true,
          rows,
          highWatermarkRowid,
          highWatermarkMs,
        }));
      const dispatch = options.dispatch ?? vi.fn<CatchupDispatchFn>(async () => ({ ok: true }));
      return {
        dispatch,
        result: performIMessageCatchup({
          accountId: "primary",
          config,
          ...params,
          fetch,
          dispatch,
        }),
      };
    }

    beforeEach(() => {
      vi.spyOn(Date, "now").mockReturnValue(now);
    });

    it("skips is_from_me rows but still advances the cursor past them", async () => {
      const observeSkippedFromMe = vi.fn();
      const { result, dispatch } = run([row("A", 10, { isFromMe: true }), row("B", 11)], {
        observeSkippedFromMe,
      });
      expect(await result).toMatchObject({ skippedFromMe: 1, replayed: 1 });
      await expectCursor({ lastSeenRowid: 11 });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(observeSkippedFromMe).toHaveBeenCalledWith(
        expect.objectContaining({ guid: "A", rowid: 10, isFromMe: true }),
      );
    });

    it("drops rows older than the maxAgeMinutes ceiling and advances past them", async () => {
      const { result, dispatch } = run(
        [row("OLD", 10, { date: now - 10 * 60_000 }), row("NEW", 11, { date: now - 30_000 })],
        { config: resolveCatchupConfig({ enabled: true, maxAgeMinutes: 1 }) },
      );
      expect((await result).replayed).toBe(1);
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ guid: "NEW" }));
      await expectCursor({ lastSeenRowid: 11 });
    });

    it("crosses the retry ceiling, holds the first failure, then gives up", async () => {
      const options = {
        config: resolveCatchupConfig({ enabled: true, maxFailureRetries: 2 }),
        dispatch: vi.fn<CatchupDispatchFn>(async () => ({ ok: false })),
      };
      expect(await run([row("A", 10)], options).result).toMatchObject({ failed: 1, givenUp: 0 });
      await expectCursor({ lastSeenRowid: 9, failureRetries: { A: 1 } });
      expect((await run([row("A", 10)], options).result).givenUp).toBe(1);
      await expectCursor({ lastSeenRowid: 10, failureRetries: { A: 2 } });
    });

    it("treats already-given-up rows as skippedGivenUp without dispatching", async () => {
      await seedCursor(0, now - 60_000, { "WEDGED-1": 99 });
      const { result, dispatch } = run([row("WEDGED-1", 5), row("FRESH", 6)]);
      expect(await result).toMatchObject({ skippedGivenUp: 1, replayed: 1 });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it("removes a guid from the retry map after a successful dispatch", async () => {
      await seedCursor(0, now - 60_000, { RETRYING: 1 });
      await run([row("RETRYING", 5)]).result;
      expect((await loadCursor())?.failureRetries).toBeUndefined();
    });

    it("does NOT leapfrog a held failure when a later row in the same batch succeeds", async () => {
      // #78649: a later success must not move the cursor past a retryable failure.
      const { result } = run(
        [row("A", 10, { date: now - 40_000 }), row("B", 11, { date: now - 30_000 })],
        {
          highWatermarkRowid: 99,
          highWatermarkMs: now - 100,
          dispatch: vi.fn<CatchupDispatchFn>(async (entry) => ({ ok: entry.guid !== "A" })),
        },
      );
      expect(await result).toMatchObject({ failed: 1, replayed: 1, givenUp: 0 });
      await expectCursor({ lastSeenRowid: 9, failureRetries: { A: 1 } });
    });

    it("keeps held failure state when a live monitor advances the same cursor mid-pass", async () => {
      const { result } = run([row("A", 10, { date: now - 40_000 })], {
        dispatch: vi.fn<CatchupDispatchFn>(async () => {
          await advance(50, now - 10_000, config);
          return { ok: false };
        }),
      });
      expect((await result).failed).toBe(1);
      await expectCursor({ lastSeenRowid: 9, failureRetries: { A: 1 } });
    });

    it("returns querySucceeded=false and preserves the cursor on fetch failure", async () => {
      await seedCursor(7, now - 60_000);
      const warn = vi.fn();
      const { result, dispatch } = run([], {
        warn,
        fetch: vi.fn<CatchupFetchFn>(async () => {
          throw new Error("imsg rpc closed");
        }),
      });
      expect(await result).toMatchObject({ querySucceeded: false, replayed: 0 });
      expect(dispatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("imessage catchup: fetch failed: Error: imsg rpc closed");
      await expectCursor({ lastSeenRowid: 7 });
    });
  });

  describe("iMessage catchup cursor writes", () => {
    const now = 1_700_001_000_000;
    beforeEach(() => {
      vi.spyOn(Date, "now").mockReturnValue(now);
    });

    function interceptCursorStore() {
      const state = getIMessageRuntime().state;
      const store = state.openKeyedStoreV2<unknown>({
        namespace: IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
        maxEntries: IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
      });
      vi.spyOn(state, "openKeyedStoreV2").mockReturnValue(store);
      return { store, register: store.register.bind(store) };
    }

    it("holds the live cursor queue until its write settles", async () => {
      const { store, register } = interceptCursorStore();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      vi.spyOn(store, "register").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return await register(...args);
      });
      let settled = false;
      const first = advance(50, now).then((advanced) => {
        settled = true;
        return advanced;
      });
      await Promise.race([
        entered.promise,
        first.then(() => {
          throw new Error("Cursor advancement settled before the pending write.");
        }),
      ]);
      const second = advance(40, now);
      try {
        expect(settled).toBe(false);
        expect(await loadCursor()).toBeNull();
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
      }
      await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
      await expectCursor({ lastSeenRowid: 50, lastSeenMs: now });
    });

    it("propagates uncertain persistence without retrying a dispatched catchup pass", async () => {
      const { store } = interceptCursorStore();
      const failure = new Error("SQLite worker outcome unknown");
      const write = vi.spyOn(store, "register").mockRejectedValue(failure);
      const fetch = vi.fn<CatchupFetchFn>(async () => ({
        resolved: true,
        rows: [{ guid: "A", rowid: 10, date: now - 1000 }],
      }));
      const dispatch = vi.fn<CatchupDispatchFn>(async () => ({ ok: true }));

      await expect(
        performIMessageCatchup({ accountId: "primary", config: liveConfig, fetch, dispatch }),
      ).rejects.toBe(failure);
      expect(write).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });
});
