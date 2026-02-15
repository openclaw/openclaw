/**
 * Manus Credit Tracker
 *
 * Tracks Manus AI task completions and credit usage with budget awareness.
 */

export type ManusTaskEntry = {
  taskId: string;
  credits: number;
  timestamp: number;
  status?: "completed" | "error" | "running";
  description?: string;
};

export type ManusUsageSummary = {
  tasksToday: number;
  tasksThisMonth: number;
  tasksTotal: number;
  creditsToday: number;
  creditsThisMonth: number;
  creditsTotal: number;
  monthlyBudget: number;
  monthlyBudgetPercent: number;
  lastTask?: ManusTaskEntry;
  alerts: string[];
};

export type ManusBudgetContext = {
  budget: string;
  alerts: string[];
  summary: ManusUsageSummary;
};

export class ManusTracker {
  private tasks: ManusTaskEntry[] = [];
  private monthlyBudget = 500; // Default 500 credits/month

  setMonthlyBudget(credits: number): void {
    this.monthlyBudget = credits;
  }

  getMonthlyBudget(): number {
    return this.monthlyBudget;
  }

  recordTask(entry: Omit<ManusTaskEntry, "timestamp">): void {
    this.tasks.push({
      ...entry,
      timestamp: Date.now(),
    });

    // Keep only last 500 tasks
    if (this.tasks.length > 500) {
      this.tasks = this.tasks.slice(-500);
    }
  }

  getSummary(): ManusUsageSummary {
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

    const todayTasks = this.tasks.filter((t) => t.timestamp >= todayStart);
    const monthTasks = this.tasks.filter((t) => t.timestamp >= monthStart);
    const lastTask = this.tasks.length > 0 ? this.tasks[this.tasks.length - 1] : undefined;

    const creditsToday = todayTasks.reduce((sum, t) => sum + t.credits, 0);
    const creditsThisMonth = monthTasks.reduce((sum, t) => sum + t.credits, 0);
    const creditsTotal = this.tasks.reduce((sum, t) => sum + t.credits, 0);

    const monthlyBudgetPercent =
      this.monthlyBudget > 0 ? (creditsThisMonth / this.monthlyBudget) * 100 : 0;

    const alerts: string[] = [];

    // Budget alerts
    if (monthlyBudgetPercent >= 100) {
      alerts.push(
        `🔴 CRITICAL: Manus credits at ${monthlyBudgetPercent.toFixed(0)}% of monthly budget`,
      );
    } else if (monthlyBudgetPercent >= 80) {
      alerts.push(`🟠 Manus credits at ${monthlyBudgetPercent.toFixed(0)}% of monthly budget`);
    } else if (monthlyBudgetPercent >= 50) {
      alerts.push(`🟡 Manus credits at ${monthlyBudgetPercent.toFixed(0)}% of monthly budget`);
    }

    // Daily usage spike alert
    const dailyPercent = this.monthlyBudget > 0 ? (creditsToday / this.monthlyBudget) * 100 : 0;
    if (dailyPercent > 10) {
      alerts.push(
        `⚡ High Manus usage today: ${creditsToday} credits (${dailyPercent.toFixed(0)}% of monthly)`,
      );
    }

    return {
      tasksToday: todayTasks.length,
      tasksThisMonth: monthTasks.length,
      tasksTotal: this.tasks.length,
      creditsToday,
      creditsThisMonth,
      creditsTotal,
      monthlyBudget: this.monthlyBudget,
      monthlyBudgetPercent,
      lastTask,
      alerts,
    };
  }

  getBudgetContext(): ManusBudgetContext {
    const summary = this.getSummary();
    const remaining = Math.max(0, this.monthlyBudget - summary.creditsThisMonth);

    let budget: string;
    if (summary.monthlyBudgetPercent >= 100) {
      budget = "🔴critical";
    } else if (summary.monthlyBudgetPercent >= 80) {
      budget = "🟠low";
    } else if (summary.monthlyBudgetPercent >= 50) {
      budget = "🟡moderate";
    } else {
      budget = "🟢healthy";
    }

    return {
      budget: `${budget} | month=${summary.monthlyBudgetPercent.toFixed(0)}% | remaining=${remaining} credits`,
      alerts: summary.alerts,
      summary,
    };
  }
}
