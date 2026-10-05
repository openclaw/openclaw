import { randomUUID } from "node:crypto";
import { resolveGlobalMap, resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { XCostLimits } from "./cost-limits.js";

const X_STREAM_HEADROOM_MICRO_USD = 500_000;
const MICRO_USD = 1_000_000;
const RETENTION_MS = 70 * 24 * 60 * 60_000;

export type XSpendStatus = {
  dayUsd: number;
  cycleUsd: number;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  cycleStart: string;
  exhaustedUntil?: string;
};

// Shared owners can outlive a module copy; their errors must retain instanceof identity.
export const XBudgetExceededError = resolveGlobalSingleton(
  Symbol.for("openclaw.x.budget-exceeded-error"),
  () =>
    class extends Error {
      constructor(
        message: string,
        readonly exhaustedUntil: number,
      ) {
        super(message);
        this.name = "XBudgetExceededError";
      }
    },
);
export type XBudgetExceededError = InstanceType<typeof XBudgetExceededError>;

type SpendRuntime = {
  state: Pick<PluginRuntime["state"], "openKeyedStore" | "resolveStateDir">;
  logging?: Pick<PluginRuntime["logging"], "getChildLogger">;
};
type Period = { day: string; cycle: string; dayEnd: number; cycleEnd: number };
type Pending = { key: string; amount: number; day: string; cycle: string };
type SpendOwner = ReturnType<typeof createSpendOwner>;

// Runtime/client replacement must retain the same reservation and recovery lock.
const owners = resolveGlobalMap<string, SpendOwner>(
  Symbol.for("openclaw.x.spend"),
  async (active) => {
    await Promise.all([...active.values()].map((owner) => owner.close()));
    active.clear();
  },
  "close-and-restart",
);

function periodAt(now: number, cycleStartDay: number): Period {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const cycleMonth = date.getUTCDate() < cycleStartDay ? month - 1 : month;
  return {
    day: date.toISOString().slice(0, 10),
    cycle: new Date(Date.UTC(year, cycleMonth, cycleStartDay)).toISOString().slice(0, 10),
    dayEnd: Date.UTC(year, month, date.getUTCDate() + 1),
    cycleEnd: Date.UTC(year, cycleMonth + 1, cycleStartDay),
  };
}

function checkedAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("X spend must be a nonnegative safe integer in micro-dollars");
  }
  return value;
}

function createSpendOwner(runtime: SpendRuntime, accountId: string, getLimits: () => XCostLimits) {
  const prefix = `${encodeURIComponent(accountId)}:`;
  const openStore = (current: SpendRuntime) =>
    current.state.openKeyedStore<number>({
      namespace: "x.spend",
      maxEntries: 200_000,
      overflowPolicy: "reject-new",
      defaultTtlMs: RETENTION_MS,
    });
  let store = openStore(runtime);
  let state = runtime.state;
  let logger = runtime.logging?.getChildLogger({ channel: "x", accountId });
  let limits = getLimits;
  let tail: Promise<unknown> = Promise.resolve();
  let initialized = false;
  let failure: Error | undefined;
  let refusedAmount = 0;
  let warnedUntil: number | undefined;
  let reconciledCycle: string | undefined;
  const pending = new Map<string, Pending>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(async () => {
      if (failure) {
        throw failure;
      }
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof XBudgetExceededError)) {
          failure = new Error("X spend accounting unavailable; paid requests paused", {
            cause: error,
          });
          notify();
        }
        throw error;
      }
    });
    tail = result.catch(() => undefined);
    return result;
  };
  const bucketKey = (kind: "day" | "cycle", date: string) => `${prefix}${kind}:${date}`;
  const read = async (kind: "day" | "cycle", date: string) =>
    checkedAmount((await store.lookup(bucketKey(kind, date))) ?? 0);
  const add = async (kind: "day" | "cycle", date: string, amount: number) => {
    if (amount) {
      await store.register(bucketKey(kind, date), checkedAmount((await read(kind, date)) + amount));
    }
  };
  const finish = async (reservation: Pending, actual: number) => {
    const current = periodAt(Date.now(), limits().cycleStartDay);
    // Keep the durable reservation until every charge commits. Interrupted settlement
    // may overcount, but cannot release capacity after an uncertain write or restart.
    for (const day of new Set([reservation.day, current.day])) {
      await add("day", day, actual);
    }
    for (const cycle of new Set([reservation.cycle, current.cycle])) {
      await add("cycle", cycle, actual);
    }
    if (reservation.day !== current.day && actual) {
      // Credit the duplicated daily charge only after all positive charges commit.
      const key = `${prefix}overlap:${reservation.day}:${current.day}`;
      await store.register(
        key,
        checkedAmount(checkedAmount((await store.lookup(key)) ?? 0) + actual),
      );
    }
    await store.delete(reservation.key);
    pending.delete(reservation.key);
  };
  const initialize = async () => {
    if (initialized) {
      return;
    }
    const pendingPrefix = `${prefix}pending:`;
    for (const entry of await store.entries()) {
      if (!entry.key.startsWith(pendingPrefix)) {
        continue;
      }
      const [day, cycle] = entry.key.slice(pendingPrefix.length).split(":");
      if (
        !day ||
        !cycle ||
        !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(cycle)
      ) {
        throw new Error("Invalid persisted X spend reservation");
      }
      const reservation = { key: entry.key, amount: checkedAmount(entry.value), day, cycle };
      await finish(reservation, reservation.amount);
    }
    initialized = true;
  };
  const snapshot = async () => {
    await initialize();
    const config = limits();
    const period = periodAt(Date.now(), config.cycleStartDay);
    if (reconciledCycle !== period.cycle) {
      const dayPrefix = `${prefix}day:`;
      const overlapPrefix = `${prefix}overlap:`;
      const inCycle = (day: string) => day >= period.cycle && day <= period.day;
      let dayTotal = 0;
      let overlaps = 0;
      for (const entry of await store.entries()) {
        if (entry.key.startsWith(dayPrefix)) {
          const day = entry.key.slice(dayPrefix.length);
          if (inCycle(day)) {
            dayTotal = checkedAmount(dayTotal + checkedAmount(entry.value));
          }
        } else if (entry.key.startsWith(overlapPrefix)) {
          const [startDay, completionDay] = entry.key.slice(overlapPrefix.length).split(":");
          if (startDay && completionDay && inCycle(startDay) && inCycle(completionDay)) {
            overlaps = checkedAmount(overlaps + checkedAmount(entry.value));
          }
        }
      }
      const cycleFromDays = checkedAmount(dayTotal - overlaps);
      // Moving the configured cycle boundary must not forget already charged days.
      if (cycleFromDays > (await read("cycle", period.cycle))) {
        await store.register(bucketKey("cycle", period.cycle), cycleFromDays);
      }
      reconciledCycle = period.cycle;
    }
    const held = [...pending.values()].reduce(
      (total, item) => checkedAmount(total + item.amount),
      0,
    );
    return {
      config,
      period,
      held,
      day: checkedAmount((await read("day", period.day)) + held),
      cycle: checkedAmount((await read("cycle", period.cycle)) + held),
      dailyLimit: Math.floor(config.dailyUsd * MICRO_USD),
      monthlyLimit: Math.floor(config.monthlyUsd * MICRO_USD),
    };
  };
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;
  const refusal = (view: Snapshot, amount: number, inclusive = false) => {
    const dayExceeded = inclusive
      ? view.day + amount > view.dailyLimit
      : view.day + amount >= view.dailyLimit;
    const cycleExceeded = inclusive
      ? view.cycle + amount > view.monthlyLimit
      : view.cycle + amount >= view.monthlyLimit;
    if (!dayExceeded && !cycleExceeded) {
      return undefined;
    }
    const until = Math.max(
      dayExceeded ? view.period.dayEnd : 0,
      cycleExceeded ? view.period.cycleEnd : 0,
    );
    const reason = cycleExceeded
      ? `billing-cycle budget of $${view.config.monthlyUsd}`
      : `daily budget of $${view.config.dailyUsd}`;
    return new XBudgetExceededError(
      `X API ${reason} reached; resumes at ${new Date(until).toISOString().replace(":00.000Z", "Z")}`,
      until,
    );
  };
  const updateNotice = (view: Snapshot) => {
    const error = refusal(view, refusedAmount, refusedAmount > 0);
    const notice = refusedAmount
      ? error
      : refusal({ ...view, day: view.day - view.held, cycle: view.cycle - view.held }, 0);
    if (warnedUntil !== undefined && (Date.now() >= warnedUntil || !notice)) {
      logger?.info("X API budget reset; paid requests may resume");
      warnedUntil = undefined;
    }
    if (!error) {
      refusedAmount = 0;
    } else if (notice && logger && warnedUntil === undefined) {
      warnedUntil = notice.exhaustedUntil;
      logger?.warn(notice.message);
    }
    return error;
  };
  const reserve = async (amount: number, enforce: boolean, receivedAt?: number) => {
    checkedAmount(amount);
    const view = await snapshot();
    updateNotice(view);
    const error = amount ? refusal(view, amount, true) : undefined;
    if (enforce && error) {
      refusedAmount = Math.max(refusedAmount, amount);
      updateNotice(view);
      throw error;
    }
    const period =
      receivedAt === undefined ? view.period : periodAt(receivedAt, view.config.cycleStartDay);
    const reservation: Pending = {
      key: `${prefix}pending:${period.day}:${period.cycle}:${randomUUID()}`,
      amount,
      day: period.day,
      cycle: period.cycle,
    };
    await store.register(reservation.key, amount);
    pending.set(reservation.key, reservation);
    notify();
    return reservation;
  };
  const api = {
    async reserve(microUsd: number) {
      const reservation = await serialized(() => reserve(microUsd, true));
      let settled = false;
      return {
        settle: (actualMicroUsd: number) =>
          serialized(async () => {
            if (settled) {
              return;
            }
            checkedAmount(actualMicroUsd);
            settled = true;
            await finish(reservation, actualMicroUsd);
            updateNotice(await snapshot());
            notify();
          }),
      };
    },
    charge: (microUsd: number) => {
      const receivedAt = Date.now();
      return serialized(async () => {
        const reservation = await reserve(microUsd, false, receivedAt);
        await finish(reservation, microUsd);
        updateNotice(await snapshot());
        notify();
      });
    },
    status: () =>
      serialized(async (): Promise<XSpendStatus> => {
        const view = await snapshot();
        const exhausted = updateNotice(view);
        const dollars = (amount: number) => Math.round(amount / 10_000) / 100;
        return {
          dayUsd: dollars(view.day),
          cycleUsd: dollars(view.cycle),
          dailyLimitUsd: dollars(view.dailyLimit),
          monthlyLimitUsd: dollars(view.monthlyLimit),
          cycleStart: view.period.cycle,
          ...(exhausted
            ? { exhaustedUntil: new Date(exhausted.exhaustedUntil).toISOString() }
            : {}),
        };
      }),
    streamResumeAt: () =>
      serialized(async () => {
        const view = await snapshot();
        updateNotice(view);
        return refusal(view, X_STREAM_HEADROOM_MICRO_USD, true)?.exhaustedUntil;
      }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    api,
    update(nextRuntime: SpendRuntime, nextLimits: () => XCostLimits) {
      limits = nextLimits;
      logger = nextRuntime.logging?.getChildLogger({ channel: "x", accountId }) ?? logger;
      if (state !== nextRuntime.state) {
        store = openStore(nextRuntime);
        state = nextRuntime.state;
      }
    },
    async close() {
      failure = new Error("X spend owner closed; pending reservations retained for recovery");
      await tail;
    },
  };
}

export function openXSpend(runtime: SpendRuntime, accountId: string, getLimits: () => XCostLimits) {
  const key = JSON.stringify([runtime.state.resolveStateDir(), accountId]);
  let owner = owners.get(key);
  if (!owner) {
    owner = createSpendOwner(runtime, accountId, getLimits);
    owners.set(key, owner);
  } else {
    owner.update(runtime, getLimits);
  }
  return owner.api;
}

export type XSpend = ReturnType<typeof openXSpend>;
