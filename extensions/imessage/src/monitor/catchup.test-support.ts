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

  function advance(
    lastSeenRowid: number,
    lastSeenMs: number,
    config: ReturnType<typeof resolveCatchupConfig>,
  ) {
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

  async function saveIMessageCatchupCursor(
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
      await saveIMessageCatchupCursor(42, 1_700_000_000_000, { "GIVEN-UP": 3 });

      await expect(advance(41, 1_700_000_001_000, liveConfig)).resolves.toBe(false);
      await expect(advance(50, 1_700_000_002_000, liveConfig)).resolves.toBe(true);

      await expectCursor({
        lastSeenRowid: 50,
        lastSeenMs: 1_700_000_002_000,
        failureRetries: { "GIVEN-UP": 3 },
      });
    });

    it("serializes concurrent live cursor advances so a lower row cannot overwrite a higher row", async () => {
      await saveIMessageCatchupCursor(10, 1_700_000_000_000);

      const results = await Promise.all([
        advance(50, 1_700_000_050_000, liveConfig),
        ...Array.from({ length: 24 }, (_, index) =>
          advance(11 + index, 1_700_000_011_000 + index, liveConfig),
        ),
      ]);

      expect(results[0]).toBe(true);
      expect(results.slice(1).every((advanced) => !advanced)).toBe(true);
      await expectCursor({ lastSeenRowid: 50, lastSeenMs: 1_700_000_050_000 });
    });

    it("does not advance from live rows while a catchup failure is still retrying", async () => {
      await saveIMessageCatchupCursor(42, 1_700_000_000_000, { RETRYING: 1 });

      await expect(advance(50, 1_700_000_002_000, liveConfig)).resolves.toBe(false);

      await expectCursor({ lastSeenRowid: 42, failureRetries: { RETRYING: 1 } });
    });
  });

  describe("capFailureRetriesMap", () => {
    it("is identity below the cap", () => {
      const map = { a: 1, b: 2 };
      expect(capFailureRetriesMap(map, 10)).toEqual({ a: 1, b: 2 });
    });

    it("keeps the highest counts when over the cap", () => {
      const map = { a: 1, b: 9, c: 5, d: 9 };
      const capped = capFailureRetriesMap(map, 2);
      expect(Object.keys(capped).toSorted()).toEqual(["b", "d"]);
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

    beforeEach(() => {
      vi.spyOn(Date, "now").mockReturnValue(now);
    });

    function run(
      options: Omit<Parameters<typeof performIMessageCatchup>[0], "accountId" | "config"> & {
        config?: Parameters<typeof performIMessageCatchup>[0]["config"];
      },
    ) {
      return performIMessageCatchup({ accountId: "primary", config, ...options });
    }

    function row(overrides: Partial<IMessageCatchupRow>): IMessageCatchupRow {
      return {
        guid: "GUID-X",
        rowid: 1,
        date: now - 60_000,
        isFromMe: false,
        ...overrides,
      };
    }

    function fetchOf(rows: IMessageCatchupRow[]): CatchupFetchFn {
      return vi.fn(async () => ({ resolved: true, rows }));
    }

    function alwaysOk(): CatchupDispatchFn {
      return vi.fn(async () => ({ ok: true }));
    }

    it("replays every fresh inbound row through dispatch and advances the cursor", async () => {
      const dispatch = alwaysOk();
      const fetch = fetchOf([
        row({ guid: "A", rowid: 10, date: now - 30_000 }),
        row({ guid: "B", rowid: 11, date: now - 20_000 }),
      ]);

      const summary = await run({ fetch, dispatch });

      expect(summary).toMatchObject({ querySucceeded: true, replayed: 2, failed: 0 });
      expect(summary.cursorAfter.lastSeenRowid).toBe(11);
      expect(dispatch).toHaveBeenCalledTimes(2);

      const cursor = await loadCursor();
      expect(cursor?.lastSeenRowid).toBe(11);
    });

    it("skips is_from_me rows but still advances the cursor past them", async () => {
      const dispatch = alwaysOk();
      const observeSkippedFromMe = vi.fn();
      const fetch = fetchOf([
        row({ guid: "A", rowid: 10, isFromMe: true }),
        row({ guid: "B", rowid: 11, isFromMe: false }),
      ]);

      const summary = await run({ fetch, dispatch, observeSkippedFromMe });

      expect(summary).toMatchObject({ skippedFromMe: 1, replayed: 1 });
      expect(summary.cursorAfter.lastSeenRowid).toBe(11);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(observeSkippedFromMe).toHaveBeenCalledWith(
        expect.objectContaining({ guid: "A", rowid: 10, isFromMe: true }),
      );
    });

    it("drops rows older than the maxAgeMinutes ceiling and advances past them", async () => {
      const tightConfig = resolveCatchupConfig({ enabled: true, maxAgeMinutes: 1 });
      const dispatch = alwaysOk();
      const fetch = fetchOf([
        row({ guid: "OLD", rowid: 10, date: now - 10 * 60_000 }), // 10 min old, > 1 min ceiling
        row({ guid: "NEW", rowid: 11, date: now - 30_000 }),
      ]);

      const summary = await run({ config: tightConfig, fetch, dispatch });

      expect(summary).toMatchObject({ skippedPreCursor: 1, replayed: 1 });
      expect(summary.cursorAfter.lastSeenRowid).toBe(11);
    });

    it("crosses the maxFailureRetries ceiling, gives up, and advances past the wedged row", async () => {
      const tightConfig = resolveCatchupConfig({ enabled: true, maxFailureRetries: 2 });
      const dispatch = vi.fn<CatchupDispatchFn>(async () => ({ ok: false }));
      const fetch = fetchOf([row({ guid: "A", rowid: 10 })]);

      // First failure holds the cursor below the row; the second reaches the ceiling.
      const first = await run({ config: tightConfig, fetch, dispatch });
      expect(first).toMatchObject({ failed: 1, givenUp: 0, cursorAfter: { lastSeenRowid: 9 } });
      await expectCursor({ lastSeenRowid: 9, failureRetries: { A: 1 } });

      const fetch2 = fetchOf([row({ guid: "A", rowid: 10 })]);
      const summary = await run({ config: tightConfig, fetch: fetch2, dispatch });

      expect(summary.givenUp).toBe(1);
      expect(summary.cursorAfter.lastSeenRowid).toBe(10);

      const cursor = await loadCursor();
      expect(cursor?.failureRetries?.A).toBe(2);
    });

    it("treats already-given-up rows as skippedGivenUp without dispatching", async () => {
      await saveIMessageCatchupCursor(0, now - 60_000, { "WEDGED-1": 99 });

      const dispatch = alwaysOk();
      const fetch = fetchOf([
        row({ guid: "WEDGED-1", rowid: 5 }),
        row({ guid: "FRESH", rowid: 6 }),
      ]);

      const summary = await run({ fetch, dispatch });

      expect(summary).toMatchObject({ skippedGivenUp: 1, replayed: 1 });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it("removes a guid from the retry map after a successful dispatch", async () => {
      await saveIMessageCatchupCursor(0, now - 60_000, { RETRYING: 1 });

      const dispatch = alwaysOk();
      const fetch = fetchOf([row({ guid: "RETRYING", rowid: 5 })]);

      await run({ fetch, dispatch });

      const cursor = await loadCursor();
      expect(cursor?.failureRetries).toBeUndefined();
    });

    it("does NOT leapfrog a held failure when a later row in the same batch succeeds", async () => {
      // #78649: a later success must not move the cursor past a retryable failure.
      const dispatch = vi.fn<CatchupDispatchFn>(async (rowLocal) => {
        if (rowLocal.guid === "A") {
          return { ok: false };
        }
        return { ok: true };
      });
      const fetch = fetchOf([
        row({ guid: "A", rowid: 10, date: now - 40_000 }),
        row({ guid: "B", rowid: 11, date: now - 30_000 }),
      ]);

      const summary = await run({ fetch, dispatch });

      expect(summary).toMatchObject({ failed: 1, replayed: 1, givenUp: 0 });
      expect(summary.cursorAfter.lastSeenRowid).toBe(9);
      expect(dispatch).toHaveBeenCalledTimes(2);

      await expectCursor({ lastSeenRowid: 9, failureRetries: { A: 1 } });
    });

    it("keeps held failure state when a live monitor advances the same cursor mid-pass", async () => {
      const dispatch = vi.fn<CatchupDispatchFn>(async () => {
        await advance(50, now - 10_000, config);
        return { ok: false };
      });
      const fetch = fetchOf([row({ guid: "A", rowid: 10, date: now - 40_000 })]);

      const summary = await run({ fetch, dispatch });

      expect(summary.failed).toBe(1);
      expect(summary.cursorAfter.lastSeenRowid).toBe(9);

      await expectCursor({ lastSeenRowid: 9, failureRetries: { A: 1 } });
    });

    it("advances the cursor past parser-rejected rows via the fetch high-watermark", async () => {
      // Raw fetch watermarks prevent unparseable rows from stalling catchup forever.
      const dispatch = vi.fn<CatchupDispatchFn>(async () => ({ ok: true }));
      const fetch: CatchupFetchFn = vi.fn(async () => ({
        resolved: true,
        rows: [],
        highWatermarkRowid: 42,
        highWatermarkMs: now - 5_000,
      }));

      const summary = await run({ fetch, dispatch });

      expect(summary).toMatchObject({ querySucceeded: true, replayed: 0, fetchedCount: 0 });
      expect(summary.cursorAfter.lastSeenRowid).toBe(42);
      expect(dispatch).not.toHaveBeenCalled();

      await expectCursor({ lastSeenRowid: 42, lastSeenMs: now - 5_000 });
    });

    it("does not let the high-watermark leapfrog a held failure", async () => {
      const dispatch = vi.fn<CatchupDispatchFn>(async () => ({ ok: false }));
      const fetch: CatchupFetchFn = vi.fn(async () => ({
        resolved: true,
        rows: [row({ guid: "A", rowid: 10, date: now - 40_000 })],
        highWatermarkRowid: 99,
        highWatermarkMs: now - 100,
      }));

      const summary = await run({ fetch, dispatch });

      expect(summary.failed).toBe(1);
      expect(summary.cursorAfter.lastSeenRowid).toBe(9);
    });

    it("returns querySucceeded=false and preserves the cursor on fetch failure", async () => {
      await saveIMessageCatchupCursor(7, now - 60_000);
      const dispatch = alwaysOk();
      const fetch = vi.fn<CatchupFetchFn>(async () => {
        throw new Error("imsg rpc closed");
      });
      const warn = vi.fn();

      const summary = await run({ fetch, dispatch, warn });

      expect(summary).toMatchObject({ querySucceeded: false, replayed: 0 });
      expect(dispatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("imessage catchup: fetch failed: Error: imsg rpc closed");

      const cursor = await loadCursor();
      expect(cursor?.lastSeenRowid).toBe(7);
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
      const first = advance(50, now, liveConfig).then((advanced) => {
        settled = true;
        return advanced;
      });
      await Promise.race([
        entered.promise,
        first.then(() => {
          throw new Error("Cursor advancement settled before the pending write.");
        }),
      ]);
      const second = advance(40, now, liveConfig);
      try {
        expect(settled).toBe(false);
        expect(await loadCursor()).toBeNull();
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
      }
      await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
      expect((await loadCursor())?.lastSeenRowid).toBe(50);
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
