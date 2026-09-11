import { randomUUID } from "node:crypto";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { TeamReportsConfig } from "./config.js";
import { DAY_MS, describePeriod } from "./periods.js";
import {
  createReportSources,
  generateReportPeriods,
  runPeriods,
  type ReportSourceFactory,
  type ResolvedTeamReportsConfig,
} from "./run.js";
import type { TeamReportsStore } from "./store.js";
import type { Person, PeriodDescriptor, SourceStatus } from "./types.js";

const RUN_DEADLINE_MS = 45 * 60_000;
const STOP_TIMEOUT_MS = 30_000;
type RunKind = "closed-day" | "intraday" | "manual";
type ActiveRun = { id: string; controller: AbortController; done: Promise<void> };
export type TeamReportsHealth = {
  running: boolean;
  lastRun?: { status: "ok" | "error"; kind: RunKind; finishedAtMs: number };
  nextDueMs?: number;
  warnings: number;
};

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

export class TeamReportsScheduler {
  private accepting = false;
  private closed = false;
  private active?: ActiveRun;
  private stopPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private scheduledWork = new Set<Promise<void>>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private due: { closedDay?: number; intraday?: number; catchUp?: number } = {};
  private deferred = new Set<"closed-day" | "intraday">();
  private roster: Person[];

  constructor(
    private readonly options: {
      config: TeamReportsConfig;
      resolved: ResolvedTeamReportsConfig;
      store: TeamReportsStore;
      llm: OpenClawPluginApi["runtime"]["llm"];
      context: Pick<OpenClawPluginServiceContext, "logger" | "serviceHealth">;
      sources?: ReportSourceFactory;
    },
  ) {
    this.roster = options.resolved.people;
  }

  async start(): Promise<void> {
    if (this.closed || this.accepting || this.stopPromise) {
      throw new Error("Team Reports scheduler cannot be started again");
    }
    this.accepting = true;
    return (this.startPromise = this.startOnce().catch((error: unknown) => {
      this.accepting = false;
      throw error;
    }));
  }

  private async startOnce(): Promise<void> {
    const yesterday = describePeriod("day", Date.now() - DAY_MS);
    const completed = await this.closedDayCompleted(yesterday.key);
    if (!this.accepting) {
      return;
    }
    this.armClosedDay();
    this.armIntraday();
    if (!completed) {
      this.due.catchUp = Date.now() + 60_000;
      this.schedule(this.due.catchUp, () => {
        delete this.due.catchUp;
        return this.tick("closed-day", true);
      });
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
      sourceWarnings: await this.sourceWarnings(),
    };
  }

  async health(): Promise<TeamReportsHealth> {
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
      warnings: (await this.sourceWarnings()).length,
    };
  }

  private async sourceWarnings(): Promise<string[]> {
    const latest = (await this.options.store.listPeriods({ period: "day", limit: 1 }))[0];
    const stored = latest ? await this.options.store.getPeriod("day", latest.key) : undefined;
    return stored
      ? stored.report.sources.github.warnings.concat(
          stored.report.sources.discord?.warnings ?? [],
          stored.summary?.warnings ?? [],
        )
      : [];
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
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.deferred.clear();
    const active = this.active;
    const timeout = active
      ? setTimeout(
          () => active.controller.abort(new Error("Team Reports stopped after 30 seconds")),
          STOP_TIMEOUT_MS,
        )
      : undefined;
    try {
      await this.startPromise?.catch(() => undefined);
      await Promise.all(this.scheduledWork);
      await active?.done;
    } finally {
      clearTimeout(timeout);
      this.closed = true;
      await this.options.store.close();
    }
  }

  private schedule(atMs: number, callback: () => void | Promise<void>): void {
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        if (this.accepting) {
          const work = Promise.resolve()
            .then(callback)
            .catch((error: unknown) => {
              this.options.context.logger.error(`team-reports: ${this.safeError(error)}`);
            });
          this.scheduledWork.add(work);
          void work.finally(() => this.scheduledWork.delete(work));
        }
      },
      Math.max(0, atMs - Date.now()),
    );
    timer.unref?.();
    this.timers.add(timer);
  }

  private armClosedDay(afterMs = Date.now()): void {
    const due = nextClosedDayDue(afterMs, this.options.config.schedule);
    this.due.closedDay = due;
    this.schedule(due, async () => {
      await this.tick("closed-day");
      if (!this.accepting) {
        return;
      }
      this.armClosedDay(describePeriod("day", due).untilMs - 1);
    });
  }

  private armIntraday(): void {
    this.due.intraday = nextIntradayDue(
      Date.now(),
      this.options.config.schedule.intradayEveryHours,
    );
    if (this.due.intraday !== undefined) {
      this.schedule(this.due.intraday, async () => {
        await this.tick("intraday");
        if (this.accepting) {
          this.armIntraday();
        }
      });
    }
  }

  private async tick(kind: "closed-day" | "intraday", catchUp = false): Promise<void> {
    if (
      catchUp &&
      (await this.closedDayCompleted(describePeriod("day", Date.now() - DAY_MS).key))
    ) {
      return;
    }
    if (!this.accepting) {
      return;
    }
    if (this.active) {
      if (!this.deferred.has(kind)) {
        this.deferred.add(kind);
        this.schedule(Date.now() + 60_000, () => {
          this.deferred.delete(kind);
          return this.tick(kind, catchUp);
        });
      }
      return;
    }
    const now = Date.now();
    const days =
      kind === "closed-day"
        ? [describePeriod("day", now - DAY_MS), describePeriod("day", now)]
        : [describePeriod("day", now)];
    await this.begin(kind, days);
  }

  private async closedDayCompleted(key: string): Promise<boolean> {
    const untilMs = describePeriod("day", key).untilMs;
    // Include older completions even when newer successful runs cover other days.
    return (await this.options.store.listRuns(-1, { status: "ok" })).some(
      (run) =>
        run.startedAtMs >= untilMs &&
        run.periods.some((period) => period.period === "day" && period.key === key),
    );
  }

  private async begin(kind: RunKind, days: PeriodDescriptor[]): Promise<string> {
    if (!this.accepting) {
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
      RUN_DEADLINE_MS,
    );
    const done = Promise.resolve().then(async () => {
      let stats: Record<string, SourceStatus> | undefined;
      let recorded = false;
      try {
        await started;
        recorded = true;
        controller.signal.throwIfAborted();
        stats = await generateReportPeriods({
          ...this.options,
          periods,
          sources:
            this.options.sources ??
            ((runtime) => createReportSources(runtime, Boolean(this.options.resolved.discord))),
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
        const failed = Object.values(stats).some((source) => !source.ok);
        if (failed) {
          throw new Error(
            "An activity source failed; inspect report source warnings and check access",
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
