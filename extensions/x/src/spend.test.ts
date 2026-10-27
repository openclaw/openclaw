import { randomUUID } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveXCostLimits, type XCostLimits } from "./cost-limits.js";
import { openXSpend, XBudgetExceededError } from "./spend.js";
import { createKeyedState } from "./test-support/monitor.js";

type WriteHook = (operation: "register" | "delete", key: string) => void | Promise<void>;

function fixture(config: Partial<XCostLimits> = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const openKeyedStore = createKeyedState();
  const stateDir = `synthetic-x-spend-${randomUUID()}`;
  const state = { openKeyedStore, resolveStateDir: () => stateDir };
  const runtime = { state, logging: { getChildLogger: () => logger } };
  const limits = resolveXCostLimits(config);
  const spend = openXSpend(runtime, "default", () => limits);
  const store = openKeyedStore<number>({ namespace: "x.spend" });
  function replaceStore(beforeWrite: WriteHook) {
    const replacement = {
      ...state,
      openKeyedStore<T>(options: Parameters<typeof openKeyedStore>[0]): PluginStateKeyedStore<T> {
        const original = openKeyedStore<T>(options);
        return {
          ...original,
          async register(key, value, params) {
            await beforeWrite("register", key);
            await original.register(key, value, params);
          },
          async delete(key, params) {
            await beforeWrite("delete", key);
            return await original.delete(key, params);
          },
        };
      },
    };
    return openXSpend({ ...runtime, state: replacement }, "default", () => limits);
  }
  return { limits, logger, spend, store, replaceStore };
}

function blockWrites(test: ReturnType<typeof fixture>) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const spend = test.replaceStore(async (operation) => {
    if (operation === "register") {
      entered.resolve();
      await release.promise;
    }
  });
  return { entered: entered.promise, release: release.resolve, spend };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-10-19T23:59:00Z");
});
afterEach(() => vi.useRealTimers());

describe("X spend", () => {
  it.each([
    [1, 10, "daily", false],
    [10, 1, "billing-cycle", false],
    [1, 1, "billing-cycle", true],
  ] as const)(
    "reserves and releases capacity (daily=%s monthly=%s reason=%s midnight=%s)",
    async (dailyUsd, monthlyUsd, reason, midnight) => {
      const limits = { dailyUsd, monthlyUsd, cycleStartDay: midnight ? 20 : 1 };
      const { spend } = fixture(limits);
      const reservation = await spend.reserve(800_000);
      if (midnight) {
        vi.setSystemTime("2026-10-20T00:00:00Z");
      }
      const denied = spend.reserve(300_000);
      await expect(denied).rejects.toThrow(`${reason} budget`);
      await expect(denied).rejects.toBeInstanceOf(XBudgetExceededError);
      await reservation.settle(200_000);
      await reservation.settle(200_000);
      expect(await spend.status()).toMatchObject({ dayUsd: 0.2, cycleUsd: 0.2 });
      const next = await spend.reserve(800_000);
      expect(next).toHaveProperty("settle");
      await expect(spend.reserve(1)).rejects.toBeInstanceOf(XBudgetExceededError);
      await next.settle(0);
      expect(await spend.status()).not.toHaveProperty("exhaustedUntil");
    },
  );

  it("serializes concurrent callers across replacement runtime handles before dispatch", async () => {
    const test = fixture({ dailyUsd: 1 });
    const { entered, release, spend: second } = blockWrites(test);
    const firstCall = test.spend.reserve(600_000);
    await entered;
    const secondCall = second.reserve(600_000);
    const outcomes = Promise.allSettled([firstCall, secondCall]);
    release();
    const [first, other] = await outcomes;
    expect(first.status).toBe("fulfilled");
    expect(other).toMatchObject({ status: "rejected", reason: expect.any(XBudgetExceededError) });
    expect(await second.status()).toMatchObject({ dayUsd: 0.6, cycleUsd: 0.6 });
  });

  it.each([
    ["completion day", "register", "default:day:2026-10-20", undefined],
    ["cycle", "register", "default:cycle:2026-10-01", undefined],
    ["pending deletion", "delete", null, 100_000],
  ] as const)(
    "keeps failed %s settlement conservative and stops subsequent paid calls",
    async (_failedAt, rejectedOperation, rejectedKey, overlap) => {
      const test = fixture({ dailyUsd: 1 });
      const reservation = await test.spend.reserve(800_000);
      vi.setSystemTime("2026-10-20T00:00:00Z");
      test.replaceStore((operation, key) => {
        if (operation === rejectedOperation && (rejectedKey === null || key === rejectedKey)) {
          throw new Error("synthetic disk failure");
        }
      });
      await expect(reservation.settle(100_000)).rejects.toThrow("synthetic disk failure");
      await expect(test.spend.reserve(100_000)).rejects.toThrow("accounting unavailable");
      expect(
        (await test.store.entries()).some(
          (entry) => entry.key.includes(":pending:") && entry.value === 800_000,
        ),
      ).toBe(true);
      expect(await test.store.lookup("default:overlap:2026-10-19:2026-10-20")).toBe(overlap);
    },
  );

  it("recovers an interrupted dispatched reservation at full cost", async () => {
    const test = fixture({ dailyUsd: 1 });
    await test.store.register("default:pending:2026-10-19:2026-10-01:interrupted", 800_000);
    expect(await test.spend.status()).toMatchObject({ dayUsd: 0.8, cycleUsd: 0.8 });
    await expect(test.spend.reserve(300_000)).rejects.toBeInstanceOf(XBudgetExceededError);
    expect((await test.store.entries()).some((entry) => entry.key.includes(":pending:"))).toBe(
      false,
    );
  });

  it("charges every delivered event past the limit and signals the fixed stream headroom", async () => {
    const { spend } = fixture({ dailyUsd: 1 });
    const changed = vi.fn();
    const unsubscribe = spend.subscribe(changed);
    await spend.charge(500_000);
    expect(await spend.streamResumeAt()).toBeUndefined();
    await spend.charge(5_000);
    expect(await spend.streamResumeAt()).toBe(Date.parse("2026-10-20T00:00:00Z"));
    await spend.charge(600_000);
    expect(await spend.status()).toMatchObject({ dayUsd: 1.11, cycleUsd: 1.11 });
    await expect(spend.reserve(5_000)).rejects.toBeInstanceOf(XBudgetExceededError);
    expect(changed).toHaveBeenCalled();
    unsubscribe();
  });

  it("blocks paid calls with zero limits but admits zero-cost work", async () => {
    const { spend } = fixture({ dailyUsd: 0, monthlyUsd: 0 });
    await expect(spend.reserve(1)).rejects.toBeInstanceOf(XBudgetExceededError);
    await (await spend.reserve(0)).settle(0);
    expect(await spend.status()).toMatchObject({ dayUsd: 0, cycleUsd: 0 });
  });
  it("retains an event's receipt periods when its charge waits across midnight", async () => {
    const test = fixture({ cycleStartDay: 20 });
    const { entered, release } = blockWrites(test);
    const blocked = test.spend.reserve(0);
    await entered;
    const charged = test.spend.charge(5_000);
    vi.setSystemTime("2026-10-20T00:00:00Z");
    release();
    await (await blocked).settle(0);
    await charged;
    for (const period of [
      "day:2026-10-19",
      "cycle:2026-09-20",
      "day:2026-10-20",
      "cycle:2026-10-20",
    ]) {
      expect(await test.store.lookup(`default:${period}`)).toBe(5_000);
    }
  });

  it("does not log exhaustion for an empty poll that temporarily reserves the remaining budget", async () => {
    const { spend, logger } = fixture({ dailyUsd: 1 });
    for (let index = 0; index < 3; index++) {
      const reservation = await spend.reserve(1_000_000);
      await spend.status();
      await spend.streamResumeAt();
      await reservation.settle(0);
    }
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("resets the UTC day independently and emits one reached/reset notice", async () => {
    const { spend, logger } = fixture({ dailyUsd: 1 });
    await (await spend.reserve(1_000_000)).settle(1_000_000);
    await expect(spend.reserve(1)).rejects.toBeInstanceOf(XBudgetExceededError);
    await expect(spend.reserve(1)).rejects.toBeInstanceOf(XBudgetExceededError);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime("2026-10-20T00:00:00Z");
    expect(await spend.status()).toMatchObject({ dayUsd: 0, cycleUsd: 1 });
    await spend.status();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("resets the billing cycle on the configured UTC date", async () => {
    const { spend } = fixture({ cycleStartDay: 20, monthlyUsd: 1 });
    await (await spend.reserve(1_000_000)).settle(1_000_000);
    expect(await spend.status()).toMatchObject({ cycleStart: "2026-09-20", cycleUsd: 1 });
    vi.setSystemTime("2026-10-20T00:00:00Z");
    expect(await spend.status()).toMatchObject({
      dayUsd: 0,
      cycleUsd: 0,
      cycleStart: "2026-10-20",
    });
    await expect(spend.reserve(1_000_000)).resolves.toHaveProperty("settle");
  });

  it("holds in-flight reservations across midnight and settles against both periods", async () => {
    const { spend } = fixture({ dailyUsd: 1, monthlyUsd: 1, cycleStartDay: 20 });
    const reservation = await spend.reserve(800_000);
    vi.setSystemTime("2026-10-20T00:00:00Z");
    await expect(spend.reserve(300_000)).rejects.toBeInstanceOf(XBudgetExceededError);
    await reservation.settle(200_000);
    expect(await spend.status()).toMatchObject({ dayUsd: 0.2, cycleUsd: 0.2 });
    await expect(spend.reserve(800_000)).resolves.toHaveProperty("settle");
  });

  it("preserves the settled cycle spend across a restart after a request crosses midnight", async () => {
    const test = fixture({ monthlyUsd: 0.15 });
    const reservation = await test.spend.reserve(100_000);
    vi.setSystemTime("2026-10-20T00:00:00Z");
    await reservation.settle(100_000);
    expect(await test.spend.status()).toMatchObject({ dayUsd: 0.1, cycleUsd: 0.1 });
    const restarted = fixture(test.limits);
    for (const entry of await test.store.entries()) {
      await restarted.store.register(entry.key, entry.value);
    }
    expect(await restarted.spend.status()).toMatchObject({ dayUsd: 0.1, cycleUsd: 0.1 });
    await expect(restarted.spend.reserve(50_000)).resolves.toHaveProperty("settle");
  });

  it("preserves charged days when the configured cycle boundary splits an overlap", async () => {
    const { spend, limits } = fixture();
    const reservation = await spend.reserve(200_000);
    vi.setSystemTime("2026-10-20T00:00:00Z");
    await reservation.settle(200_000);
    for (const day of [20, 19]) {
      limits.cycleStartDay = day;
      expect(await spend.status()).toMatchObject({
        dayUsd: 0.2,
        cycleUsd: 0.2,
        cycleStart: `2026-10-${day}`,
      });
    }
  });
});
