/**
 * Budget manager for cost tracking and alerting.
 *
 * Supports daily, weekly, and monthly budget limits with configurable
 * alert thresholds. Can operate in soft-cap (warn) or hard-cap (block) mode.
 */

import type { CostTracker } from "./cost-tracker.js";

export type BudgetConfig = {
  /** Maximum daily spend in USD (0 = unlimited) */
  dailyBudget: number;
  /** Maximum weekly spend in USD (0 = unlimited) */
  weeklyBudget: number;
  /** Maximum monthly spend in USD (0 = unlimited) */
  monthlyBudget: number;
  /** Budget percentage thresholds for alerts */
  alertThresholds: number[];
  /** If true, block requests when budget is exceeded */
  hardCap: boolean;
};

export type BudgetStatus = {
  daily: BudgetPeriodStatus;
  weekly: BudgetPeriodStatus;
  monthly: BudgetPeriodStatus;
  alerts: BudgetAlert[];
  blocked: boolean;
};

export type BudgetPeriodStatus = {
  spent: number;
  budget: number;
  remaining: number;
  percentUsed: number;
  unlimited: boolean;
};

export type BudgetAlert = {
  period: "daily" | "weekly" | "monthly";
  threshold: number;
  percentUsed: number;
  spent: number;
  budget: number;
  severity: "info" | "warning" | "critical";
};

const DEFAULT_CONFIG: BudgetConfig = {
  dailyBudget: 0,
  weeklyBudget: 0,
  monthlyBudget: 0,
  alertThresholds: [50, 80, 100],
  hardCap: false,
};

export class BudgetManager {
  private config: BudgetConfig;
  private tracker: CostTracker;
  /** Track which thresholds have already fired to avoid duplicate alerts */
  private firedAlerts = new Set<string>();

  constructor(tracker: CostTracker, config?: Partial<BudgetConfig>) {
    this.tracker = tracker;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Update budget configuration.
   */
  updateConfig(config: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...config };
    this.firedAlerts.clear();
  }

  /**
   * Get the current budget configuration.
   */
  getConfig(): BudgetConfig {
    return { ...this.config };
  }

  /**
   * Check overall budget status.
   */
  getStatus(agentId?: string): BudgetStatus {
    const daily = this.getPeriodStatus("daily", agentId);
    const weekly = this.getPeriodStatus("weekly", agentId);
    const monthly = this.getPeriodStatus("monthly", agentId);

    const alerts = [
      ...this.checkThresholds("daily", daily),
      ...this.checkThresholds("weekly", weekly),
      ...this.checkThresholds("monthly", monthly),
    ];

    const blocked =
      this.config.hardCap &&
      ((!daily.unlimited && daily.remaining <= 0) ||
        (!weekly.unlimited && weekly.remaining <= 0) ||
        (!monthly.unlimited && monthly.remaining <= 0));

    return { daily, weekly, monthly, alerts, blocked };
  }

  /**
   * Check if a request should be blocked due to budget constraints.
   */
  isBlocked(agentId?: string): boolean {
    if (!this.config.hardCap) {
      return false;
    }
    return this.getStatus(agentId).blocked;
  }

  /**
   * Get new alerts that haven't been reported yet.
   */
  getNewAlerts(agentId?: string): BudgetAlert[] {
    const status = this.getStatus(agentId);
    const newAlerts: BudgetAlert[] = [];

    for (const alert of status.alerts) {
      const key = `${alert.period}:${alert.threshold}`;
      if (!this.firedAlerts.has(key)) {
        this.firedAlerts.add(key);
        newAlerts.push(alert);
      }
    }

    return newAlerts;
  }

  private getPeriodStatus(
    period: "daily" | "weekly" | "monthly",
    agentId?: string,
  ): BudgetPeriodStatus {
    const budget =
      period === "daily"
        ? this.config.dailyBudget
        : period === "weekly"
          ? this.config.weeklyBudget
          : this.config.monthlyBudget;

    const spent =
      period === "daily"
        ? this.tracker.getCurrentDailySpend(agentId)
        : period === "weekly"
          ? this.tracker.getCurrentWeeklySpend(agentId)
          : this.tracker.getCurrentMonthlySpend(agentId);

    const unlimited = budget <= 0;
    const remaining = unlimited ? Infinity : Math.max(0, budget - spent);
    const percentUsed = unlimited ? 0 : budget > 0 ? (spent / budget) * 100 : 0;

    return { spent, budget, remaining, percentUsed, unlimited };
  }

  private checkThresholds(
    period: "daily" | "weekly" | "monthly",
    status: BudgetPeriodStatus,
  ): BudgetAlert[] {
    if (status.unlimited) {
      return [];
    }

    const alerts: BudgetAlert[] = [];
    for (const threshold of this.config.alertThresholds) {
      if (status.percentUsed >= threshold) {
        const severity: BudgetAlert["severity"] =
          threshold >= 100 ? "critical" : threshold >= 80 ? "warning" : "info";

        alerts.push({
          period,
          threshold,
          percentUsed: status.percentUsed,
          spent: status.spent,
          budget: status.budget,
          severity,
        });
      }
    }

    return alerts;
  }
}
