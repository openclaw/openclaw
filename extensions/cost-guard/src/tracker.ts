/**
 * In-memory cost accumulator.
 *
 * Tracks API spend per provider, per day, and per month.
 * Entries older than 31 days are pruned automatically.
 */

import type { CostGuardConfig, ProviderLimit } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CostEntry = {
  provider: string;
  model: string;
  costUsd: number;
  ts: number;
};

export type BudgetStatus = {
  level: "ok" | "warning" | "exceeded";
  dailyUsed: number;
  dailyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  dailyPercent: number;
  monthlyPercent: number;
  /** Provider that triggered the exceeded/warning status, if any. */
  exceededProvider?: string;
};

export type CostSummary = {
  todayUsd: number;
  monthUsd: number;
  todayByProvider: Map<string, number>;
  monthByProvider: Map<string, number>;
  entryCount: number;
};

export type CostTracker = {
  record(entry: CostEntry): void;
  todayTotal(): number;
  monthTotal(): number;
  todayByProvider(): Map<string, number>;
  monthByProvider(): Map<string, number>;
  checkBudget(config: CostGuardConfig): BudgetStatus;
  summary(): CostSummary;
  pruneOldEntries(): void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** YYYY-MM-DD in local time. */
function toDateKey(ts: number): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** YYYY-MM in local time. */
function toMonthKey(ts: number): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

const MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000; // 31 days

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCostTracker(): CostTracker {
  const entries: CostEntry[] = [];

  function todayKey(): string {
    return toDateKey(Date.now());
  }

  function currentMonthKey(): string {
    return toMonthKey(Date.now());
  }

  function todayEntries(): CostEntry[] {
    const key = todayKey();
    return entries.filter((e) => toDateKey(e.ts) === key);
  }

  function monthEntries(): CostEntry[] {
    const key = currentMonthKey();
    return entries.filter((e) => toMonthKey(e.ts) === key);
  }

  function sumByProvider(list: CostEntry[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const e of list) {
      map.set(e.provider, (map.get(e.provider) ?? 0) + e.costUsd);
    }
    return map;
  }

  function sumTotal(list: CostEntry[]): number {
    let total = 0;
    for (const e of list) {
      total += e.costUsd;
    }
    return total;
  }

  /** Check a single provider against its limits. */
  function checkProviderLimit(
    provider: string,
    limit: ProviderLimit,
    todayProviders: Map<string, number>,
    monthProviders: Map<string, number>,
  ): "exceeded" | "ok" {
    const todayAmount = todayProviders.get(provider) ?? 0;
    const monthAmount = monthProviders.get(provider) ?? 0;
    if (limit.dailyUsd !== undefined && todayAmount >= limit.dailyUsd) {
      return "exceeded";
    }
    if (limit.monthlyUsd !== undefined && monthAmount >= limit.monthlyUsd) {
      return "exceeded";
    }
    return "ok";
  }

  return {
    record(entry: CostEntry): void {
      entries.push(entry);
    },

    todayTotal(): number {
      return sumTotal(todayEntries());
    },

    monthTotal(): number {
      return sumTotal(monthEntries());
    },

    todayByProvider(): Map<string, number> {
      return sumByProvider(todayEntries());
    },

    monthByProvider(): Map<string, number> {
      return sumByProvider(monthEntries());
    },

    checkBudget(config: CostGuardConfig): BudgetStatus {
      const today = todayEntries();
      const month = monthEntries();
      const dailyUsed = sumTotal(today);
      const monthlyUsed = sumTotal(month);
      const todayProviders = sumByProvider(today);
      const monthProviders = sumByProvider(month);

      const dailyPercent = config.dailyBudgetUsd > 0 ? dailyUsed / config.dailyBudgetUsd : 0;
      const monthlyPercent =
        config.monthlyBudgetUsd > 0 ? monthlyUsed / config.monthlyBudgetUsd : 0;

      // Check per-provider limits first.
      for (const [provider, limit] of Object.entries(config.providerLimits)) {
        if (checkProviderLimit(provider, limit, todayProviders, monthProviders) === "exceeded") {
          return {
            level: "exceeded",
            dailyUsed,
            dailyLimit: config.dailyBudgetUsd,
            monthlyUsed,
            monthlyLimit: config.monthlyBudgetUsd,
            dailyPercent,
            monthlyPercent,
            exceededProvider: provider,
          };
        }
      }

      // Check global limits.
      if (dailyUsed >= config.dailyBudgetUsd || monthlyUsed >= config.monthlyBudgetUsd) {
        return {
          level: "exceeded",
          dailyUsed,
          dailyLimit: config.dailyBudgetUsd,
          monthlyUsed,
          monthlyLimit: config.monthlyBudgetUsd,
          dailyPercent,
          monthlyPercent,
        };
      }

      if (dailyPercent >= config.warningThreshold || monthlyPercent >= config.warningThreshold) {
        return {
          level: "warning",
          dailyUsed,
          dailyLimit: config.dailyBudgetUsd,
          monthlyUsed,
          monthlyLimit: config.monthlyBudgetUsd,
          dailyPercent,
          monthlyPercent,
        };
      }

      return {
        level: "ok",
        dailyUsed,
        dailyLimit: config.dailyBudgetUsd,
        monthlyUsed,
        monthlyLimit: config.monthlyBudgetUsd,
        dailyPercent,
        monthlyPercent,
      };
    },

    summary(): CostSummary {
      const today = todayEntries();
      const month = monthEntries();
      return {
        todayUsd: sumTotal(today),
        monthUsd: sumTotal(month),
        todayByProvider: sumByProvider(today),
        monthByProvider: sumByProvider(month),
        entryCount: entries.length,
      };
    },

    pruneOldEntries(): void {
      const cutoff = Date.now() - MAX_AGE_MS;
      let writeIdx = 0;
      for (let i = 0; i < entries.length; i++) {
        if (entries[i]!.ts >= cutoff) {
          entries[writeIdx] = entries[i]!;
          writeIdx++;
        }
      }
      entries.length = writeIdx;
    },
  };
}
