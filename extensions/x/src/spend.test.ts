import { randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveXCostLimits, type XCostLimits } from "./cost-limits.js";
import { openXSpend, XBudgetExceededError } from "./spend.js";
import { createKeyedState } from "./test-support/monitor.js";

function fixture(config: Partial<XCostLimits> = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const openKeyedStore = createKeyedState();
  const stateDir = `synthetic-x-spend-${randomUUID()}`;
  const runtime = {
    state: { openKeyedStore, resolveStateDir: () => stateDir },
    logging: { getChildLogger: () => logger },
  };
  const limits = resolveXCostLimits(config);
  return {
    runtime,
    limits,
    logger,
    spend: openXSpend(runtime, "default", () => limits),
    store: openKeyedStore<number>({ namespace: "x.spend" }),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-10-19T23:59:00Z");
});
afterEach(() => vi.useRealTimers());

describe("X spend reservations", () => {
  it.each([
    { dailyUsd: 1, monthlyUsd: 10, reason: "daily" },
    { dailyUsd: 10, monthlyUsd: 1, reason: "billing-cycle" },
  ])("reserves and releases unused $reason capacity", async ({ reason, ...limits }) => {
    const { spend } = fixture(limits);
    const reservation = await spend.reserve(800_000);
    await expect(spend.reserve(300_000)).rejects.toThrow(`${reason} budget`);
    await reservation.settle(200_000);
    await reservation.settle(200_000);
    expect(await spend.status()).toMatchObject({ dayUsd: 0.2, cycleUsd: 0.2 });
    const next = await spend.reserve(800_000);
    await expect(spend.reserve(1)).rejects.toBeInstanceOf(XBudgetExceededError);
    await next.settle(0);
    expect(await spend.status()).not.toHaveProperty("exhaustedUntil");
  });

  it("serializes concurrent callers across replacement runtime handles before dispatch", async () => {
    const test = fixture({ dailyUsd: 1 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = test.runtime.state.openKeyedStore;
    const replacement: Pick<PluginRuntime["state"], "openKeyedStore" | "resolveStateDir"> = {
      ...test.runtime.state,
      openKeyedStore<T>(
        options: Parameters<PluginRuntime["state"]["openKeyedStore"]>[0],
      ): PluginStateKeyedStore<T> {
        const store = original<T>(options);
        return {
          ...store,
          async register(key, value, params) {
            entered.resolve();
            await release.promise;
            await store.register(key, value, params);
          },
        };
      },
    };
    const second = openXSpend({ state: replacement }, "default", () => test.limits);
    const firstCall = test.spend.reserve(600_000);
    await entered.promise;
    const secondCall = second.reserve(600_000);
    const outcomes = Promise.allSettled([firstCall, secondCall]);
    release.resolve();
    const [first, other] = await outcomes;
    expect(first.status).toBe("fulfilled");
    expect(other).toMatchObject({ status: "rejected", reason: expect.any(XBudgetExceededError) });
    expect(await second.status()).toMatchObject({ dayUsd: 0.6, cycleUsd: 0.6 });
  });

  it.each(["completion day", "cycle", "pending deletion"] as const)(
    "keeps failed %s settlement conservative and stops subsequent paid calls",
    async (failedAt) => {
      const test = fixture({ dailyUsd: 1 });
      const reservation = await test.spend.reserve(800_000);
      vi.setSystemTime("2026-10-20T00:00:00Z");
      const original = test.runtime.state.openKeyedStore;
      const rejectedKey =
        failedAt === "completion day" ? "default:day:2026-10-20" : "default:cycle:2026-10-01";
      const replacement: Pick<PluginRuntime["state"], "openKeyedStore" | "resolveStateDir"> = {
        ...test.runtime.state,
        openKeyedStore<T>(
          options: Parameters<PluginRuntime["state"]["openKeyedStore"]>[0],
        ): PluginStateKeyedStore<T> {
          const store = original<T>(options);
          return {
            ...store,
            async register(key, value, params) {
              if (failedAt !== "pending deletion" && key === rejectedKey) {
                throw new Error("synthetic disk failure");
              }
              await store.register(key, value, params);
            },
            async delete(key, params) {
              if (failedAt === "pending deletion") {
                throw new Error("synthetic disk failure");
              }
              return await store.delete(key, params);
            },
          };
        },
      };
      openXSpend({ state: replacement }, "default", () => test.limits);
      await expect(reservation.settle(100_000)).rejects.toThrow("synthetic disk failure");
      await expect(test.spend.reserve(100_000)).rejects.toThrow("accounting unavailable");
      expect(
        (await test.store.entries()).some(
          (entry) => entry.key.includes(":pending:") && entry.value === 800_000,
        ),
      ).toBe(true);
      expect(await test.store.lookup("default:overlap:2026-10-19:2026-10-20")).toBe(
        failedAt === "pending deletion" ? 100_000 : undefined,
      );
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
});

describe("X spend period boundaries", () => {
  it("retains an event's receipt periods when its charge waits across midnight", async () => {
    const test = fixture({ cycleStartDay: 20 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = test.runtime.state.openKeyedStore;
    const replacement: Pick<PluginRuntime["state"], "openKeyedStore" | "resolveStateDir"> = {
      ...test.runtime.state,
      openKeyedStore<T>(
        options: Parameters<PluginRuntime["state"]["openKeyedStore"]>[0],
      ): PluginStateKeyedStore<T> {
        const store = original<T>(options);
        return {
          ...store,
          async register(key, value, params) {
            entered.resolve();
            await release.promise;
            await store.register(key, value, params);
          },
        };
      },
    };
    openXSpend({ state: replacement }, "default", () => test.limits);
    const blocked = test.spend.reserve(0);
    await entered.promise;
    const charged = test.spend.charge(5_000);
    vi.setSystemTime("2026-10-20T00:00:00Z");
    release.resolve();
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
    limits.cycleStartDay = 20;
    expect(await spend.status()).toMatchObject({
      dayUsd: 0.2,
      cycleUsd: 0.2,
      cycleStart: "2026-10-20",
    });
    limits.cycleStartDay = 19;
    expect(await spend.status()).toMatchObject({
      dayUsd: 0.2,
      cycleUsd: 0.2,
      cycleStart: "2026-10-19",
    });
  });
});
