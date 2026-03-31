/**
 * In-memory cost tracker with time-bucketed aggregation.
 *
 * Tracks per-interaction costs and aggregates by:
 *   - Agent ID
 *   - Model (provider/model key)
 *   - Time bucket (day, week, month)
 *
 * Design: lightweight in-memory store that persists summaries to the
 * plugin's state directory when available. No SQLite dependency — keeps
 * the plugin footprint minimal and portable.
 */

import { calculateCost, lookupPricing } from "./pricing-db.js";

export type CostEvent = {
  timestamp: number;
  agentId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
};

export type CostSummary = {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  eventCount: number;
  byModel: Map<string, { cost: number; events: number }>;
  byAgent: Map<string, { cost: number; events: number }>;
};

export type TimePeriod = "today" | "week" | "month" | "all";

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function weekKey(ts: number): string {
  const d = new Date(ts);
  const startOfYear = new Date(d.getFullYear(), 0, 1);
  const weekNumber = Math.ceil(
    ((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7,
  );
  return `${d.getFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export class CostTracker {
  private events: CostEvent[] = [];
  private maxEvents: number;

  constructor(options?: { maxEvents?: number }) {
    this.maxEvents = options?.maxEvents ?? 10_000;
  }

  /**
   * Record a usage event, automatically looking up pricing and calculating cost.
   * Returns the computed cost, or undefined if pricing data is unavailable.
   */
  recordUsage(params: {
    agentId: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): CostEvent | undefined {
    const pricing = lookupPricing(params.provider, params.model);
    if (!pricing) {
      return undefined;
    }

    const cost = calculateCost({
      pricing,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cacheReadTokens: params.cacheReadTokens,
      cacheWriteTokens: params.cacheWriteTokens,
    });

    const event: CostEvent = {
      timestamp: Date.now(),
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cacheReadTokens: params.cacheReadTokens ?? 0,
      cacheWriteTokens: params.cacheWriteTokens ?? 0,
      inputCost: cost.inputCost,
      outputCost: cost.outputCost,
      cacheReadCost: cost.cacheReadCost,
      cacheWriteCost: cost.cacheWriteCost,
      totalCost: cost.totalCost,
    };

    this.events.push(event);

    // Evict oldest events if we exceed the limit.
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    return event;
  }

  /**
   * Get a cost summary for a given time period.
   */
  getSummary(period: TimePeriod = "today", agentId?: string): CostSummary {
    const now = Date.now();
    const filtered = this.events.filter((e) => {
      if (agentId && e.agentId !== agentId) {
        return false;
      }
      switch (period) {
        case "today":
          return dayKey(e.timestamp) === dayKey(now);
        case "week":
          return weekKey(e.timestamp) === weekKey(now);
        case "month":
          return monthKey(e.timestamp) === monthKey(now);
        case "all":
          return true;
      }
    });

    const summary: CostSummary = {
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      eventCount: filtered.length,
      byModel: new Map(),
      byAgent: new Map(),
    };

    for (const event of filtered) {
      summary.totalCost += event.totalCost;
      summary.totalInputTokens += event.inputTokens;
      summary.totalOutputTokens += event.outputTokens;
      summary.totalCacheReadTokens += event.cacheReadTokens;
      summary.totalCacheWriteTokens += event.cacheWriteTokens;

      const modelKey = `${event.provider}/${event.model}`;
      const modelEntry = summary.byModel.get(modelKey) ?? { cost: 0, events: 0 };
      modelEntry.cost += event.totalCost;
      modelEntry.events += 1;
      summary.byModel.set(modelKey, modelEntry);

      const agentEntry = summary.byAgent.get(event.agentId) ?? { cost: 0, events: 0 };
      agentEntry.cost += event.totalCost;
      agentEntry.events += 1;
      summary.byAgent.set(event.agentId, agentEntry);
    }

    return summary;
  }

  /**
   * Get daily cost totals for the last N days.
   */
  getDailyTotals(days: number = 7): Array<{ date: string; cost: number; events: number }> {
    const now = Date.now();
    const cutoff = now - days * 86400000;
    const byDay = new Map<string, { cost: number; events: number }>();

    for (const event of this.events) {
      if (event.timestamp < cutoff) {
        continue;
      }
      const key = dayKey(event.timestamp);
      const entry = byDay.get(key) ?? { cost: 0, events: 0 };
      entry.cost += event.totalCost;
      entry.events += 1;
      byDay.set(key, entry);
    }

    return [...byDay.entries()]
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Get the current daily spend.
   */
  getCurrentDailySpend(agentId?: string): number {
    return this.getSummary("today", agentId).totalCost;
  }

  /**
   * Get the current weekly spend.
   */
  getCurrentWeeklySpend(agentId?: string): number {
    return this.getSummary("week", agentId).totalCost;
  }

  /**
   * Get the current monthly spend.
   */
  getCurrentMonthlySpend(agentId?: string): number {
    return this.getSummary("month", agentId).totalCost;
  }

  /**
   * Export all events for persistence (e.g., writing to the plugin state dir).
   */
  exportEvents(): CostEvent[] {
    return [...this.events];
  }

  /**
   * Import previously persisted events.
   */
  importEvents(events: CostEvent[]): void {
    this.events.push(...events);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  /**
   * Clear all recorded events.
   */
  clear(): void {
    this.events = [];
  }
}
