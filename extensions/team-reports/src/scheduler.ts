import { randomUUID } from "node:crypto";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import type { TeamReportsConfig } from "./config.js";
import { DAY_MS, describePeriod } from "./periods.js";
import { REPORT_RUN_TIMEOUT_MS, type ReportRunRequest } from "./run-worker-contract.js";
import type { ResolvedTeamReportsConfig } from "./run.js";
import type { TeamReportsStore } from "./store.js";
import type { SummaryLlm } from "./summaries.js";
import type { Person, PeriodDescriptor, SourceStatus } from "./types.js";

const STOP_TIMEOUT_MS = 30_000;
const STARTUP_GRACE_MS = 5 * 60_000;
type RunKind = "closed-day" | "intraday" | "manual";
type ActiveRun = { id: string; controller: AbortController; done: Promise<void> };
export type TeamReportsHealth = Awaited<ReturnType<TeamReportsScheduler["health"]>>;

function nextClosedDayDue(nowMs: number, schedule: TeamReportsConfig["schedule"]): number {
  const random = Math.random();
  const [hours = 0, minutes = 0] = schedule.closedDayUtc.split(":").map(Number);
  const today = describePeriod("day", nowMs).sinceMs;
  const jitter = Math.floor(Math.max(0, Math.min(1, random)) * schedule.jitterMinutes * 60_000);
  const scheduled = today + hours * 3_600_000 + minutes * 60_000 + jitter;
  return scheduled > nowMs ? scheduled : scheduled + DAY_MS;
}

function nextIntradayDue(nowMs: number, everyHours: number): number | undefined {
  if (everyHours === 0) {
    return undefined;
  }
  const today = describePeriod("day", nowMs).sinceMs;
  const interval = everyHours * 3_600_000;
  return today + Math.min(DAY_MS, (Math.floor((nowMs - today) / interval) + 1) * interval);
}

function runPeriods(config: TeamReportsConfig, days: PeriodDescriptor[]): PeriodDescriptor[] {
  const periods = new Map(days.map((day) => [`day/${day.key}`, day]));
  for (const day of days) {
    for (const period of ["week", "month"] as const) {
      if (period === "week" ? config.schedule.weekly : config.schedule.monthly) {
        const descriptor = describePeriod(period, day.sinceMs);
        periods.set(`${period}/${descriptor.key}`, descriptor);
      }
    }
  }
  return [...periods.values()];
}

export class TeamReportsScheduler {
  private accepting = false;
  private active?: ActiveRun;
  private stopPromise?: Promise<void>;
  private catchUpDay?: PeriodDescriptor;
  private due: { closedDay?: number; intraday?: number } = {};
  private deferred = new Set<"closed-day" | "intraday">();
  private roster: Person[];

  constructor(
    private readonly options: {
      config: TeamReportsConfig;
      resolved: ResolvedTeamReportsConfig;
      store: TeamReportsStore;
      llm: SummaryLlm;
      context: Pick<OpenClawPluginServiceContextV2, "logger" | "serviceHealth" | "scheduler">;
      runReports: (params: ReportRunRequest) => Promise<Record<string, SourceStatus>>;
      closeRunner: () => Promise<void>;
    },
  ) {
    this.roster = options.resolved.people;
  }

  async start(): Promise<void> {
    if (this.accepting || this.stopPromise || this.options.context.scheduler.signal.aborted) {
      throw new Error("Team Reports scheduler cannot be started again");
    }
    this.accepting = true;
    const now = Date.now();
    const notBefore = now + STARTUP_GRACE_MS;
    this.catchUpDay = describePeriod("day", now - DAY_MS);
    try {
      this.armClosedDay(now, notBefore);
      this.armIntraday(notBefore);
    } catch (error) {
      this.accepting = false;
      throw error;
    }
  }

  orgs(): string[] {
    return this.options.config.github.orgs;
  }

  people(): Person[] {
    return this.roster;
  }

  async status() {
    return {
      running: this.accepting,
      activeRunId: this.active?.id,
      nextDue: { ...this.due },
      runs: await this.options.store.listRuns(),
      periods: await this.options.store.listPeriods(),
      sourceWarnings: await this.options.store.latestSourceWarnings(),
    };
  }

  async health() {
    const finished = [
      ...(await this.options.store.listRuns(1, { status: "ok" })),
      ...(await this.options.store.listRuns(1, { status: "error" })),
    ].toSorted(
      (a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0) || b.startedAtMs - a.startedAtMs,
    )[0];
    const due = Object.values(this.due).filter((value) => value !== undefined);
    return {
      running: this.accepting,
      ...(finished && finished.status !== "running" && finished.finishedAtMs !== null
        ? {
            lastRun: {
              status: finished.status,
              kind: finished.kind,
              finishedAtMs: finished.finishedAtMs,
            },
          }
        : {}),
      ...(due.length ? { nextDueMs: Math.min(...due) } : {}),
      warnings: (await this.options.store.latestSourceWarnings()).length,
    };
  }

  async generate(params: { date?: string; intraday?: boolean } = {}): Promise<string> {
    const now = Date.now();
    const day = describePeriod("day", params.date ?? now - (params.intraday ? 0 : DAY_MS));
    const today = describePeriod("day", now);
    if (day.sinceMs > today.sinceMs) {
      throw new Error("Cannot generate a future UTC day");
    }
    if (params.intraday && day.key !== today.key) {
      throw new Error("intraday generation requires today's UTC date");
    }
    return this.begin("manual", [day]);
  }

  stop(): Promise<void> {
    return (this.stopPromise ??= this.stopOnce());
  }

  private async stopOnce(): Promise<void> {
    this.accepting = false;
    this.due = {};
    this.options.context.scheduler.beginClose();
    this.deferred.clear();
    const active = this.active;
    const timeout = active
      ? setTimeout(
          () => active.controller.abort(new Error("Team Reports stopped after 30 seconds")),
          STOP_TIMEOUT_MS,
        )
      : undefined;
    try {
      await this.options.context.scheduler.stop();
      await active?.done;
    } finally {
      clearTimeout(timeout);
      await this.options.closeRunner();
      await this.options.store.close();
    }
  }

  private schedule(id: string, atMs: number, callback: () => void | Promise<void>): void {
    if (this.options.context.scheduler.signal.aborted) {
      return;
    }
    this.options.context.scheduler.schedule({
      id,
      atMs,
      run: async () => {
        try {
          await callback();
        } catch (error) {
          this.options.context.logger.error(`team-reports: ${this.safeError(error)}`);
        }
      },
    });
  }

  private armClosedDay(afterMs = Date.now(), notBeforeMs = afterMs): void {
    const scheduled = nextClosedDayDue(afterMs, this.options.config.schedule);
    const due = Math.max(scheduled, notBeforeMs);
    this.due.closedDay = due;
    this.schedule("closed-day", due, async () => {
      await this.tick("closed-day");
      if (!this.accepting) {
        return;
      }
      this.armClosedDay(describePeriod("day", scheduled).untilMs - 1);
    });
  }

  private armIntraday(afterMs = Date.now()): void {
    this.due.intraday = nextIntradayDue(afterMs, this.options.config.schedule.intradayEveryHours);
    if (this.due.intraday !== undefined) {
      this.schedule("intraday", this.due.intraday, async () => {
        await this.tick("intraday");
        if (this.accepting) {
          this.armIntraday();
        }
      });
    }
  }

  private async tick(kind: "closed-day" | "intraday"): Promise<void> {
    if (!this.accepting) {
      return;
    }
    if (this.active) {
      if (!this.deferred.has(kind)) {
        this.deferred.add(kind);
        this.schedule(`deferred:${kind}`, Date.now() + 60_000, () => {
          this.deferred.delete(kind);
          return this.tick(kind);
        });
      }
      return;
    }
    // Recover yesterday in the first scheduled run, using the worker's accepted-day reuse.
    const catchUpDay = this.catchUpDay;
    this.catchUpDay = undefined;
    const runKind = catchUpDay ? "closed-day" : kind;
    const now = Date.now();
    const days =
      runKind === "closed-day"
        ? [describePeriod("day", now - DAY_MS), describePeriod("day", now)]
        : [describePeriod("day", now)];
    if (catchUpDay && !days.some((day) => day.key === catchUpDay.key)) {
      days.unshift(catchUpDay);
    }
    await this.begin(runKind, days, catchUpDay !== undefined);
  }

  private async begin(
    kind: RunKind,
    days: PeriodDescriptor[],
    reuseCollectedDays = false,
  ): Promise<string> {
    if (!this.accepting || this.options.context.scheduler.signal.aborted) {
      throw new Error("Team Reports service is not running");
    }
    if (this.active) {
      throw new Error("A Team Reports run is already in progress");
    }
    const id = randomUUID();
    const periods = runPeriods(this.options.config, days);
    const controller = new AbortController();
    const started = this.options.store.startRun({
      id,
      kind,
      startedAtMs: Date.now(),
      periods: periods.map(({ period, key }) => ({ period, key })),
    });
    const deadline = setTimeout(
      () => controller.abort(new Error("Team Reports run exceeded its 45-minute deadline")),
      REPORT_RUN_TIMEOUT_MS,
    );
    const done = Promise.resolve().then(async () => {
      let stats: Record<string, SourceStatus> | undefined;
      let recorded = false;
      try {
        await started;
        recorded = true;
        controller.signal.throwIfAborted();
        stats = await this.options.runReports({
          ...this.options,
          periods,
          reuseCollectedDays,
          runtime: { logger: this.options.context.logger, signal: controller.signal },
          onRoster: (people) => {
            this.roster = people;
          },
        });
        controller.signal.throwIfAborted();
        if (kind === "closed-day") {
          await this.options.store.prune(this.options.config.retention.days);
          controller.signal.throwIfAborted();
        }
        const failed = Object.entries(stats)
          .filter(([, source]) => !source.ok)
          .map(([sourceId]) => sourceId);
        if (failed.length > 0) {
          throw new Error(
            `Activity sources failed (${failed.join(", ")}); inspect run source warnings and check access`,
          );
        }
        await this.options.store.finishRun(id, { status: "ok", finishedAtMs: Date.now(), stats });
        this.options.context.serviceHealth?.clearFailure();
      } catch (error) {
        const message = this.safeError(error);
        try {
          if (recorded) {
            await this.options.store.finishRun(id, {
              status: "error",
              finishedAtMs: Date.now(),
              error: message,
              stats,
            });
          }
        } catch {
          this.options.context.logger.error(
            "team-reports: failed to record run outcome; check database access and disk space",
          );
        }
        this.options.context.serviceHealth?.reportFailure(new Error(message));
        this.options.context.logger.error(`team-reports: ${message}`);
      } finally {
        clearTimeout(deadline);
        if (this.active?.id === id) {
          this.active = undefined;
        }
      }
    });
    this.active = { id, controller, done };
    await started;
    return id;
  }

  private safeError(error: unknown): string {
    let message = error instanceof Error ? error.message : "Team Reports run failed";
    for (const token of [
      this.options.resolved.github.token,
      this.options.resolved.discord?.token,
    ]) {
      if (token) {
        message = message.replaceAll(token, "[redacted]");
      }
    }
    return message.slice(0, 2000);
  }
}
