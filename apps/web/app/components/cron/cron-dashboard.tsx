"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import type {
  CronJob,
  CronRunLogEntry,
  HeartbeatInfo,
  CronStatusInfo,
  CronJobsResponse,
  CronRunsResponse,
} from "../../types/cron";
import type { CronDashboardView } from "@/lib/workspace-links";
import type { CalendarMode } from "@/lib/object-filters";

/* ─── Helpers ─── */

function formatSchedule(schedule: CronJob["schedule"]): string {
  switch (schedule.kind) {
    case "cron":
      return `cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ""}`;
    case "every": {
      const ms = schedule.everyMs;
      if (ms >= 86_400_000) return `every ${Math.round(ms / 86_400_000)}d`;
      if (ms >= 3_600_000) return `every ${Math.round(ms / 3_600_000)}h`;
      if (ms >= 60_000) return `every ${Math.round(ms / 60_000)}m`;
      return `every ${Math.round(ms / 1000)}s`;
    }
    case "at":
      return `at ${schedule.at}`;
    default:
      return "unknown";
  }
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function formatTimeAgo(ms: number): string {
  const ago = Date.now() - ms;
  if (ago < 60_000) return "just now";
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
  return `${Math.floor(ago / 86_400_000)}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function jobStatusLabel(job: CronJob): string {
  if (!job.enabled) return "disabled";
  if (job.state.runningAtMs) return "running";
  return job.state.lastStatus ?? "idle";
}

function jobStatusColor(status: string): string {
  switch (status) {
    case "ok": return "var(--color-success, #22c55e)";
    case "running": return "var(--color-accent)";
    case "error": return "var(--color-error, #ef4444)";
    case "disabled": return "var(--color-text-muted)";
    case "skipped": return "var(--color-warning, #f59e0b)";
    default: return "var(--color-text-muted)";
  }
}

function useCountdown(targetMs: number | null | undefined): string | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!targetMs) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [targetMs]);
  if (!targetMs) return null;
  return formatCountdown(targetMs - now);
}

const TABS: { id: CronDashboardView; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "calendar", label: "Calendar" },
  { id: "insights", label: "Insights" },
];

/* ─── Main component ─── */

export function CronDashboard({
  onSelectJob,
  onSendCommand,
  activeView = "overview",
  onViewChange,
  calendarMode = "month",
  onCalendarModeChange,
  calendarDate,
  onCalendarDateChange,
}: {
  onSelectJob: (jobId: string) => void;
  onSendCommand?: (message: string) => void;
  activeView?: CronDashboardView;
  onViewChange?: (view: CronDashboardView) => void;
  calendarMode?: CalendarMode;
  onCalendarModeChange?: (mode: CalendarMode) => void;
  calendarDate?: string | null;
  onCalendarDateChange?: (date: string | null) => void;
}) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [heartbeat, setHeartbeat] = useState<HeartbeatInfo>({ intervalMs: 30 * 60_000, nextDueEstimateMs: null });
  const [cronStatus, setCronStatus] = useState<CronStatusInfo>({ enabled: false, nextWakeAtMs: null });
  const [loading, setLoading] = useState(true);
  const [allRuns, setAllRuns] = useState<CronRunLogEntry[]>([]);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/cron/jobs");
      const data: CronJobsResponse = await res.json();
      setJobs(data.jobs ?? []);
      setHeartbeat(data.heartbeat ?? { intervalMs: 30 * 60_000, nextDueEstimateMs: null });
      setCronStatus(data.cronStatus ?? { enabled: false, nextWakeAtMs: null });

      const jobIds = (data.jobs ?? []).map((j) => j.id);
      const runPromises = jobIds.map(async (id) => {
        try {
          const r = await fetch(`/api/cron/jobs/${encodeURIComponent(id)}/runs?limit=50`);
          const d: CronRunsResponse = await r.json();
          return d.entries ?? [];
        } catch { return []; }
      });
      const runArrays = await Promise.all(runPromises);
      setAllRuns(runArrays.flat().toSorted((a, b) => b.ts - a.ts));
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const id = setInterval(() => void fetchData(), 15_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const heartbeatCountdown = useCountdown(heartbeat.nextDueEstimateMs);
  const cronWakeCountdown = useCountdown(cronStatus.nextWakeAtMs);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div
          className="w-6 h-6 border-2 rounded-full animate-spin"
          style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
        />
      </div>
    );
  }

  const enabledJobs = jobs.filter((j) => j.enabled);
  const disabledJobs = jobs.filter((j) => !j.enabled);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header + tabs */}
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1
            className="font-instrument text-3xl tracking-tight mb-1"
            style={{ color: "var(--color-text)" }}
          >
            Cron
          </h1>
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            {enabledJobs.length} active job{enabledJobs.length !== 1 ? "s" : ""}
            {disabledJobs.length > 0 && ` / ${disabledJobs.length} disabled`}
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div
        className="flex items-center gap-1 mb-6 rounded-xl p-1"
        style={{ background: "var(--color-surface-hover)" }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onViewChange?.(tab.id)}
            className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer"
            style={{
              background: activeView === tab.id ? "var(--color-surface)" : "transparent",
              color: activeView === tab.id ? "var(--color-text)" : "var(--color-text-muted)",
              boxShadow: activeView === tab.id ? "var(--shadow-sm)" : "none",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeView === "overview" && (
        <OverviewTab
          jobs={jobs}
          enabledJobs={enabledJobs}
          disabledJobs={disabledJobs}
          heartbeatCountdown={heartbeatCountdown}
          heartbeat={heartbeat}
          cronWakeCountdown={cronWakeCountdown}
          onSelectJob={onSelectJob}
          onSendCommand={onSendCommand}
        />
      )}
      {activeView === "calendar" && (
        <CalendarTab
          jobs={jobs}
          allRuns={allRuns}
          mode={calendarMode}
          onModeChange={onCalendarModeChange}
          dateAnchor={calendarDate}
          onDateChange={onCalendarDateChange}
          onSelectJob={onSelectJob}
        />
      )}
      {activeView === "insights" && (
        <InsightsTab jobs={jobs} allRuns={allRuns} onSelectJob={onSelectJob} />
      )}
    </div>
  );
}

/* ─── Overview tab ─── */

function OverviewTab({
  jobs,
  enabledJobs,
  disabledJobs,
  heartbeatCountdown,
  heartbeat,
  cronWakeCountdown,
  onSelectJob,
  onSendCommand,
}: {
  jobs: CronJob[];
  enabledJobs: CronJob[];
  disabledJobs: CronJob[];
  heartbeatCountdown: string | null;
  heartbeat: HeartbeatInfo;
  cronWakeCountdown: string | null;
  onSelectJob: (jobId: string) => void;
  onSendCommand?: (message: string) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <StatusCard
          title="Heartbeat"
          icon={<HeartbeatIcon />}
          value={heartbeatCountdown ? `in ${heartbeatCountdown}` : "unknown"}
          subtitle={`Interval: ${formatCountdown(heartbeat.intervalMs)}`}
        />
        <StatusCard
          title="Cron Scheduler"
          icon={<ClockIcon />}
          value={cronWakeCountdown ? `next in ${cronWakeCountdown}` : jobs.length === 0 ? "no jobs" : "idle"}
          subtitle={`${enabledJobs.length} active / ${jobs.length} total jobs`}
        />
        <StatusCard
          title="Active Runs"
          icon={<RunningIcon />}
          value={`${jobs.filter((j) => j.state.runningAtMs).length}`}
          subtitle={(() => {
            const running = jobs.filter((j) => j.state.runningAtMs);
            const errorCount = jobs.filter((j) => j.state.lastStatus === "error").length;
            if (running.length > 0) return running.map((j) => j.name).join(", ");
            return errorCount > 0 ? `${errorCount} with errors` : "All clear";
          })()}
        />
      </div>

      <TimelineSection jobs={enabledJobs} />

      <JobsTable jobs={[...enabledJobs, ...disabledJobs]} onSelectJob={onSelectJob} onSendCommand={onSendCommand} />
    </>
  );
}

/* ─── Calendar tab ─── */

type DayEvent =
  | { kind: "run"; run: CronRunLogEntry; job?: CronJob; at: number }
  | { kind: "scheduled"; job: CronJob; at: number };

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfLocalWeek(date: Date): Date {
  const start = startOfLocalDay(date);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function addLocalDays(date: Date, days: number): Date {
  const next = startOfLocalDay(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addLocalMonths(date: Date, months: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), 1);
  next.setMonth(next.getMonth() + months);
  const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(date.getDate(), maxDay));
  return next;
}

function addLocalYears(date: Date, years: number): Date {
  const next = new Date(date.getFullYear() + years, date.getMonth(), 1);
  const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(date.getDate(), maxDay));
  return next;
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseLocalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : startOfLocalDay(parsed);
}

function dayKey(d: Date) {
  return formatLocalDate(d);
}

/* ─── Schedule occurrence projection ─── */

function parseCronField(field: string, min: number, max: number): number[] {
  const values: Set<number> = new Set();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      for (let i = a; i <= b; i += step) values.add(i);
    } else {
      values.add(parseInt(range, 10));
    }
  }
  return [...values].filter((v) => v >= min && v <= max).sort((a, b) => a - b);
}

function projectCronExpr(expr: string, from: number, to: number, _tz?: string): number[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return [];

  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const daysOfMonth = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const daysOfWeek = parseCronField(parts[4], 0, 6);
  const domWildcard = parts[2] === "*";
  const dowWildcard = parts[4] === "*";

  const results: number[] = [];
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);

  const MAX_ITERATIONS = 50_000;
  let iter = 0;

  while (cursor.getTime() < to && iter++ < MAX_ITERATIONS) {
    if (!months.includes(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    const domMatch = domWildcard || daysOfMonth.includes(cursor.getDate());
    const dowMatch = dowWildcard || daysOfWeek.includes(cursor.getDay());
    const dayMatch = (domWildcard && dowWildcard) || (!domWildcard && !dowWildcard ? domMatch || dowMatch : domMatch && dowMatch);

    if (!dayMatch) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    for (const h of hours) {
      for (const m of minutes) {
        const ts = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), h, m, 0, 0).getTime();
        if (ts >= from && ts < to) results.push(ts);
      }
    }

    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }

  return results;
}

function projectSchedule(job: CronJob, from: number, to: number): number[] {
  if (!job.enabled) return [];
  const schedule = job.schedule;

  switch (schedule.kind) {
    case "at": {
      const ts = new Date(schedule.at).getTime();
      return (ts >= from && ts < to) ? [ts] : [];
    }
    case "every": {
      const interval = schedule.everyMs;
      if (interval <= 0) return [];
      const anchor = schedule.anchorMs ?? job.createdAtMs ?? from;
      const results: number[] = [];
      let t = anchor;
      if (t < from) {
        const skip = Math.floor((from - t) / interval);
        t += skip * interval;
      }
      while (t < to && results.length < 5000) {
        if (t >= from) results.push(t);
        t += interval;
      }
      return results;
    }
    case "cron":
      return projectCronExpr(schedule.expr, from, to, schedule.tz);
    default:
      return [];
  }
}

function buildEventsByDay(
  allRuns: CronRunLogEntry[],
  jobs: CronJob[],
  jobMap: Map<string, CronJob>,
  rangeFrom: number,
  rangeTo: number,
) {
  const map = new Map<string, DayEvent[]>();
  const now = Date.now();

  for (const run of allRuns) {
    const at = run.runAtMs ?? run.ts;
    if (at < rangeFrom || at >= rangeTo) continue;
    const k = dayKey(new Date(at));
    const arr = map.get(k) ?? [];
    arr.push({ kind: "run", run, job: jobMap.get(run.jobId), at });
    map.set(k, arr);
  }

  for (const job of jobs) {
    if (!job.enabled) continue;
    const occurrences = projectSchedule(job, rangeFrom, rangeTo);
    for (const ts of occurrences) {
      // Historical slots should be represented by real runs, not duplicated
      // by a projected schedule entry layered on top.
      if (ts < now) continue;
      const k = dayKey(new Date(ts));
      const arr = map.get(k) ?? [];
      arr.push({ kind: "scheduled", job, at: ts });
      map.set(k, arr);
    }
  }

  for (const events of map.values()) {
    events.sort((a, b) => {
      if (a.at !== b.at) return a.at - b.at;
      const aLabel = a.kind === "run" ? (a.job?.name ?? a.run.jobId) : a.job.name;
      const bLabel = b.kind === "run" ? (b.job?.name ?? b.run.jobId) : b.job.name;
      return aLabel.localeCompare(bLabel);
    });
  }

  return map;
}

function EventChip({ ev, onSelectJob }: { ev: DayEvent; onSelectJob: (id: string) => void }) {
  const time = new Date(ev.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (ev.kind === "scheduled") {
    return (
      <button type="button" onClick={() => onSelectJob(ev.job.id)}
        className="w-full text-left text-[10px] px-1.5 py-0.5 rounded truncate cursor-pointer"
        style={{ background: "color-mix(in srgb, var(--color-accent) 15%, transparent)", color: "var(--color-accent)" }}
        title={`Scheduled: ${ev.job.name} at ${time}`}
      >{time} {ev.job.name}</button>
    );
  }
  const c = ev.run.status === "ok" ? "var(--color-success, #22c55e)" : ev.run.status === "error" ? "var(--color-error, #ef4444)" : "var(--color-text-muted)";
  return (
    <button type="button" onClick={() => ev.job && onSelectJob(ev.job.id)}
      className="w-full text-left text-[10px] px-1.5 py-0.5 rounded truncate flex items-center gap-1 cursor-pointer"
      style={{ background: `color-mix(in srgb, ${c} 10%, transparent)`, color: c }}
      title={`${ev.run.status ?? "finished"}: ${ev.job?.name ?? ev.run.jobId} at ${time}`}
    >
      <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: c }} />
      <span className="truncate">{time} {ev.job?.name ?? ev.run.jobId.slice(0, 8)}</span>
    </button>
  );
}

function CalendarTab({
  jobs,
  allRuns,
  mode = "month",
  onModeChange,
  dateAnchor,
  onDateChange,
  onSelectJob,
}: {
  jobs: CronJob[];
  allRuns: CronRunLogEntry[];
  mode?: CalendarMode;
  onModeChange?: (mode: CalendarMode) => void;
  dateAnchor?: string | null;
  onDateChange?: (date: string | null) => void;
  onSelectJob: (jobId: string) => void;
}) {
  const anchor = parseLocalDate(dateAnchor) ?? startOfLocalDay(new Date());

  const navigate = (delta: number) => {
    const d = mode === "month"
      ? addLocalMonths(anchor, delta)
      : mode === "week"
        ? addLocalDays(anchor, delta * 7)
        : mode === "day"
          ? addLocalDays(anchor, delta)
          : addLocalYears(anchor, delta);
    onDateChange?.(formatLocalDate(d));
  };

  const jobMap = useMemo(() => {
    const m = new Map<string, CronJob>();
    for (const j of jobs) m.set(j.id, j);
    return m;
  }, [jobs]);

  const { rangeFrom, rangeTo } = useMemo(() => {
    const y = anchor.getFullYear();
    const m = anchor.getMonth();
    if (mode === "day") {
      const start = new Date(y, m, anchor.getDate());
      return { rangeFrom: start.getTime(), rangeTo: addLocalDays(start, 1).getTime() };
    }
    if (mode === "week") {
      const start = startOfLocalWeek(anchor);
      return { rangeFrom: start.getTime(), rangeTo: addLocalDays(start, 7).getTime() };
    }
    if (mode === "year") {
      return { rangeFrom: new Date(y, 0, 1).getTime(), rangeTo: new Date(y + 1, 0, 1).getTime() };
    }
    // month: include overflow days (6 weeks)
    const first = new Date(y, m, 1);
    const start = startOfLocalWeek(first);
    return { rangeFrom: start.getTime(), rangeTo: addLocalDays(start, 42).getTime() };
  }, [anchor, mode]);

  const eventsByDay = useMemo(
    () => buildEventsByDay(allRuns, jobs, jobMap, rangeFrom, rangeTo),
    [allRuns, jobs, jobMap, rangeFrom, rangeTo],
  );

  const headerTitle = useMemo(() => {
    if (mode === "day") return anchor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    if (mode === "week") {
      const start = startOfLocalWeek(anchor);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      const sameMonth = start.getMonth() === end.getMonth();
      if (sameMonth) return `${start.toLocaleDateString(undefined, { month: "long" })} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
      return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
    }
    if (mode === "year") return String(anchor.getFullYear());
    return anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }, [anchor, mode]);

  const todayStr = dayKey(new Date());

  return (
    <div>
      {/* Calendar header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => navigate(-1)} className="p-1.5 rounded-lg cursor-pointer" style={{ color: "var(--color-text-muted)" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>{headerTitle}</h2>
          <button type="button" onClick={() => navigate(1)} className="p-1.5 rounded-lg cursor-pointer" style={{ color: "var(--color-text-muted)" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
          </button>
          <button type="button" onClick={() => onDateChange?.(formatLocalDate(new Date()))}
            className="text-xs px-2.5 py-1 rounded-lg ml-2 cursor-pointer"
            style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
          >Today</button>
        </div>
        <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: "var(--color-surface-hover)" }}>
          {(["day", "week", "month", "year"] as CalendarMode[]).map((m) => (
            <button key={m} type="button" onClick={() => onModeChange?.(m)}
              className="px-3 py-1 rounded-md text-xs font-medium cursor-pointer"
              style={{ background: mode === m ? "var(--color-surface)" : "transparent", color: mode === m ? "var(--color-text)" : "var(--color-text-muted)" }}
            >{m.charAt(0).toUpperCase() + m.slice(1)}</button>
          ))}
        </div>
      </div>

      {mode === "day" && <DayView anchor={anchor} eventsByDay={eventsByDay} todayStr={todayStr} onSelectJob={onSelectJob} />}
      {mode === "week" && <WeekView anchor={anchor} eventsByDay={eventsByDay} todayStr={todayStr} onSelectJob={onSelectJob} onDateChange={onDateChange} onModeChange={onModeChange} />}
      {mode === "month" && <MonthView anchor={anchor} eventsByDay={eventsByDay} todayStr={todayStr} onSelectJob={onSelectJob} />}
      {mode === "year" && <YearView anchor={anchor} eventsByDay={eventsByDay} todayStr={todayStr} onDateChange={onDateChange} onModeChange={onModeChange} />}
    </div>
  );
}

/* ─── Day view ─── */

function DayView({ anchor, eventsByDay, todayStr, onSelectJob }: {
  anchor: Date; eventsByDay: Map<string, DayEvent[]>; todayStr: string; onSelectJob: (id: string) => void;
}) {
  const dk = dayKey(anchor);
  const events = eventsByDay.get(dk) ?? [];
  const isToday = dk === todayStr;
  const hours = Array.from({ length: 24 }, (_, i) => i);

  const eventsByHour = useMemo(() => {
    const map = new Map<number, DayEvent[]>();
    for (const ev of events) {
      const h = new Date(ev.at).getHours();
      const arr = map.get(h) ?? [];
      arr.push(ev);
      map.set(h, arr);
    }
    return map;
  }, [events]);

  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--color-surface)" }}>
      {hours.map((h) => {
        const hourEvents = eventsByHour.get(h) ?? [];
        const nowHour = new Date().getHours();
        const isCurrentHour = isToday && h === nowHour;
        return (
          <div key={h} className="flex" style={{ borderBottom: h < 23 ? "1px solid var(--color-border)" : undefined, background: isCurrentHour ? "color-mix(in srgb, var(--color-accent) 4%, transparent)" : undefined }}>
            <div className="w-16 flex-shrink-0 px-3 py-2 text-right text-[11px] font-medium" style={{ color: "var(--color-text-muted)", borderRight: "1px solid var(--color-border)" }}>
              {h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`}
            </div>
            <div className="flex-1 min-h-[36px] px-2 py-1 flex flex-wrap gap-1 items-start">
              {hourEvents.map((ev, i) => <EventChip key={i} ev={ev} onSelectJob={onSelectJob} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Week view ─── */

function WeekView({ anchor, eventsByDay, todayStr, onSelectJob, onDateChange, onModeChange }: {
  anchor: Date; eventsByDay: Map<string, DayEvent[]>; todayStr: string; onSelectJob: (id: string) => void;
  onDateChange?: (d: string | null) => void; onModeChange?: (m: CalendarMode) => void;
}) {
  const weekStart = startOfLocalWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--color-surface)" }}>
      <div className="grid grid-cols-7" style={{ borderBottom: "1px solid var(--color-border)" }}>
        {days.map((d) => {
          const dk = dayKey(d);
          const isToday = dk === todayStr;
          return (
            <button key={dk} type="button"
              onClick={() => { onDateChange?.(dk); onModeChange?.("day"); }}
              className="px-2 py-2 text-center cursor-pointer"
              style={{ borderRight: d.getDay() < 6 ? "1px solid var(--color-border)" : undefined }}
            >
              <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>
                {d.toLocaleDateString(undefined, { weekday: "short" })}
              </div>
              <div className="text-sm font-semibold" style={{ color: isToday ? "var(--color-accent)" : "var(--color-text)" }}>
                {d.getDate()}
              </div>
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const dk = dayKey(d);
          const events = eventsByDay.get(dk) ?? [];
          const isToday = dk === todayStr;
          return (
            <div key={dk} className="min-h-[200px] p-1.5"
              style={{ borderRight: d.getDay() < 6 ? "1px solid var(--color-border)" : undefined, background: isToday ? "color-mix(in srgb, var(--color-accent) 4%, transparent)" : undefined }}
            >
              <div className="space-y-0.5">
                {events.slice(0, 8).map((ev, i) => <EventChip key={i} ev={ev} onSelectJob={onSelectJob} />)}
                {events.length > 8 && <div className="text-[9px] px-1" style={{ color: "var(--color-text-muted)" }}>+{events.length - 8} more</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Month view ─── */

function MonthView({ anchor, eventsByDay, todayStr, onSelectJob }: {
  anchor: Date; eventsByDay: Map<string, DayEvent[]>; todayStr: string; onSelectJob: (id: string) => void;
}) {
  const weeks = useMemo(() => {
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    const firstOfMonth = new Date(year, month, 1);
    const start = startOfLocalWeek(firstOfMonth);
    const weeksArr: Date[][] = [];
    for (let w = 0; w < 6; w++) {
      const week: Date[] = [];
      for (let d = 0; d < 7; d++) {
        const dt = new Date(start);
        dt.setDate(dt.getDate() + w * 7 + d);
        week.push(dt);
      }
      weeksArr.push(week);
    }
    return weeksArr;
  }, [anchor]);

  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--color-surface)" }}>
      <div className="grid grid-cols-7" style={{ borderBottom: "1px solid var(--color-border)" }}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="px-2 py-2 text-center text-[11px] font-medium uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>{d}</div>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} className="grid grid-cols-7" style={{ borderBottom: wi < 5 ? "1px solid var(--color-border)" : undefined }}>
          {week.map((day) => {
            const dk = dayKey(day);
            const events = eventsByDay.get(dk) ?? [];
            const isCurrentMonth = day.getMonth() === anchor.getMonth();
            const isToday = dk === todayStr;
            return (
              <div key={dk} className="min-h-[80px] p-1.5" style={{
                borderRight: day.getDay() < 6 ? "1px solid var(--color-border)" : undefined,
                opacity: isCurrentMonth ? 1 : 0.4,
                background: isToday ? "color-mix(in srgb, var(--color-accent) 5%, transparent)" : undefined,
              }}>
                <div className="text-xs font-medium mb-1" style={{ color: isToday ? "var(--color-accent)" : "var(--color-text-muted)" }}>{day.getDate()}</div>
                <div className="space-y-0.5">
                  {events.slice(0, 3).map((ev, i) => <EventChip key={i} ev={ev} onSelectJob={onSelectJob} />)}
                  {events.length > 3 && <div className="text-[9px] px-1" style={{ color: "var(--color-text-muted)" }}>+{events.length - 3} more</div>}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ─── Year view ─── */

function YearView({ anchor, eventsByDay, todayStr, onDateChange, onModeChange }: {
  anchor: Date; eventsByDay: Map<string, DayEvent[]>; todayStr: string;
  onDateChange?: (d: string | null) => void; onModeChange?: (m: CalendarMode) => void;
}) {
  const year = anchor.getFullYear();
  const months = Array.from({ length: 12 }, (_, i) => i);

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 gap-4">
      {months.map((month) => {
        const firstOfMonth = new Date(year, month, 1);
        const startDow = firstOfMonth.getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const cells: (number | null)[] = [];
        for (let i = 0; i < startDow; i++) cells.push(null);
        for (let d = 1; d <= daysInMonth; d++) cells.push(d);

        return (
          <button key={month} type="button"
            onClick={() => { onDateChange?.(formatLocalDate(firstOfMonth)); onModeChange?.("month"); }}
            className="rounded-xl p-3 text-left cursor-pointer transition-colors"
            style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface)"; }}
          >
            <div className="text-xs font-semibold mb-2" style={{ color: "var(--color-text)" }}>
              {firstOfMonth.toLocaleDateString(undefined, { month: "short" })}
            </div>
            <div className="grid grid-cols-7 gap-px">
              {["S","M","T","W","T","F","S"].map((d, i) => (
                <div key={i} className="text-[8px] text-center font-medium" style={{ color: "var(--color-text-muted)" }}>{d}</div>
              ))}
              {cells.map((d, i) => {
                if (d === null) return <div key={`e-${i}`} />;
                const dk = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                const events = eventsByDay.get(dk) ?? [];
                const isToday = dk === todayStr;
                const hasEvents = events.length > 0;
                const hasError = events.some((e) => e.kind === "run" && e.run.status === "error");
                return (
                  <div key={dk} className="text-[9px] text-center rounded-sm leading-[16px]" style={{
                    color: isToday ? "var(--color-accent)" : hasEvents ? "var(--color-text)" : "var(--color-text-muted)",
                    fontWeight: isToday || hasEvents ? 600 : 400,
                    background: hasError
                      ? "color-mix(in srgb, var(--color-error, #ef4444) 15%, transparent)"
                      : hasEvents
                        ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
                        : undefined,
                  }}>{d}</div>
                );
              })}
            </div>
            {/* Event count badge */}
            {(() => {
              let count = 0;
              for (let d = 1; d <= daysInMonth; d++) {
                const dk = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                count += (eventsByDay.get(dk) ?? []).length;
              }
              return count > 0 ? (
                <div className="text-[9px] mt-1.5" style={{ color: "var(--color-text-muted)" }}>{count} event{count !== 1 ? "s" : ""}</div>
              ) : null;
            })()}
          </button>
        );
      })}
    </div>
  );
}

/* ─── Insights tab ─── */

function InsightsTab({ jobs, allRuns, onSelectJob }: {
  jobs: CronJob[];
  allRuns: CronRunLogEntry[];
  onSelectJob: (jobId: string) => void;
}) {
  const stats = useMemo(() => {
    const total = allRuns.length;
    const ok = allRuns.filter((r) => r.status === "ok").length;
    const errors = allRuns.filter((r) => r.status === "error").length;
    const avgDuration = total > 0
      ? allRuns.filter((r) => r.durationMs != null).reduce((s, r) => s + (r.durationMs ?? 0), 0) /
        Math.max(1, allRuns.filter((r) => r.durationMs != null).length)
      : 0;
    const successRate = total > 0 ? Math.round((ok / total) * 100) : 0;

    // Runs by day (last 14 days)
    const now = Date.now();
    const dayMs = 86_400_000;
    const runsByDay: { day: string; ok: number; error: number; other: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const dayStart = now - i * dayMs;
      const dayEnd = dayStart + dayMs;
      const dayRuns = allRuns.filter((r) => r.ts >= dayStart && r.ts < dayEnd);
      const d = new Date(dayStart);
      runsByDay.push({
        day: `${d.getMonth() + 1}/${d.getDate()}`,
        ok: dayRuns.filter((r) => r.status === "ok").length,
        error: dayRuns.filter((r) => r.status === "error").length,
        other: dayRuns.filter((r) => r.status !== "ok" && r.status !== "error").length,
      });
    }

    // Per-job stats
    const jobStats = jobs.map((job) => {
      const jobRuns = allRuns.filter((r) => r.jobId === job.id);
      const jobOk = jobRuns.filter((r) => r.status === "ok").length;
      const jobErrors = jobRuns.filter((r) => r.status === "error").length;
      const jobAvgDur = jobRuns.filter((r) => r.durationMs != null).length > 0
        ? jobRuns.filter((r) => r.durationMs != null).reduce((s, r) => s + (r.durationMs ?? 0), 0) /
          jobRuns.filter((r) => r.durationMs != null).length
        : 0;
      return { job, runs: jobRuns.length, ok: jobOk, errors: jobErrors, avgDuration: jobAvgDur };
    }).toSorted((a, b) => b.runs - a.runs);

    return { total, ok, errors, avgDuration, successRate, runsByDay, jobStats };
  }, [allRuns, jobs]);

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard label="Total Runs" value={String(stats.total)} />
        <MetricCard label="Success Rate" value={`${stats.successRate}%`} accent={stats.successRate >= 90 ? "var(--color-success, #22c55e)" : stats.successRate >= 70 ? "var(--color-warning, #f59e0b)" : "var(--color-error, #ef4444)"} />
        <MetricCard label="Errors" value={String(stats.errors)} accent={stats.errors > 0 ? "var(--color-error, #ef4444)" : undefined} />
        <MetricCard label="Avg Duration" value={formatDuration(stats.avgDuration)} />
      </div>

      {/* Runs chart (last 14 days) */}
      <div
        className="rounded-2xl p-4"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
      >
        <h3 className="text-xs font-medium uppercase tracking-wider mb-4" style={{ color: "var(--color-text-muted)" }}>
          Runs (Last 14 Days)
        </h3>
        <div className="flex items-end gap-1 h-32">
          {stats.runsByDay.map((day) => {
            const maxVal = Math.max(...stats.runsByDay.map((d) => d.ok + d.error + d.other), 1);
            const total = day.ok + day.error + day.other;
            const height = Math.max(2, (total / maxVal) * 100);
            const okPct = total > 0 ? (day.ok / total) * 100 : 100;
            return (
              <div key={day.day} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full flex flex-col justify-end" style={{ height: "100%" }}>
                  <div
                    className="w-full rounded-t-sm"
                    style={{
                      height: `${height}%`,
                      background: total === 0
                        ? "var(--color-surface-hover)"
                        : okPct === 100
                          ? "var(--color-success, #22c55e)"
                          : okPct > 50
                            ? "color-mix(in srgb, var(--color-success, #22c55e) 60%, var(--color-error, #ef4444))"
                            : "var(--color-error, #ef4444)",
                      opacity: total === 0 ? 0.3 : 0.7,
                    }}
                    title={`${day.day}: ${day.ok} ok, ${day.error} errors`}
                  />
                </div>
                <span className="text-[9px]" style={{ color: "var(--color-text-muted)" }}>{day.day}</span>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 mt-3">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ background: "var(--color-success, #22c55e)", opacity: 0.7 }} />
            <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>Success</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ background: "var(--color-error, #ef4444)", opacity: 0.7 }} />
            <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>Error</span>
          </div>
        </div>
      </div>

      {/* Per-job breakdown */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{ border: "1px solid var(--color-border)", background: "var(--color-surface)" }}
      >
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--color-border)" }}>
          <h3 className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>
            Per-Job Breakdown
          </h3>
        </div>
        {stats.jobStats.map((js) => {
          const rate = js.runs > 0 ? Math.round((js.ok / js.runs) * 100) : 0;
          return (
            <button
              key={js.job.id}
              type="button"
              onClick={() => onSelectJob(js.job.id)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer transition-colors"
              style={{ borderBottom: "1px solid var(--color-border)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate" style={{ color: "var(--color-text)" }}>{js.job.name}</div>
                <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  {js.runs} runs / {rate}% success / avg {formatDuration(js.avgDuration)}
                </div>
              </div>
              {/* Mini bar */}
              <div className="w-24 h-2 rounded-full overflow-hidden flex-shrink-0" style={{ background: "var(--color-surface-hover)" }}>
                <div className="h-full rounded-full" style={{
                  width: `${rate}%`,
                  background: rate >= 90 ? "var(--color-success, #22c55e)" : rate >= 70 ? "var(--color-warning, #f59e0b)" : "var(--color-error, #ef4444)",
                }} />
              </div>
              {js.job.state.consecutiveErrors != null && js.job.state.consecutiveErrors > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
                  style={{ background: "color-mix(in srgb, var(--color-error, #ef4444) 12%, transparent)", color: "var(--color-error, #ef4444)" }}>
                  {js.job.state.consecutiveErrors} err
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Shared subcomponents ─── */

function MetricCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl p-3" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
      <div className="text-[11px] font-medium uppercase tracking-wider mb-1" style={{ color: "var(--color-text-muted)" }}>{label}</div>
      <div className="text-xl font-semibold" style={{ color: accent ?? "var(--color-text)" }}>{value}</div>
    </div>
  );
}

function StatusCard({ title, icon, value, subtitle }: { title: string; icon: React.ReactNode; value: string; subtitle: string }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color: "var(--color-accent)" }}>{icon}</span>
        <span className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>{title}</span>
      </div>
      <div className="text-lg font-semibold mb-0.5" style={{ color: "var(--color-text)" }}>{value}</div>
      <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>{subtitle}</div>
    </div>
  );
}

function TimelineSection({ jobs }: { jobs: CronJob[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  const upcoming = jobs
    .filter((j) => j.state.nextRunAtMs && j.state.nextRunAtMs > now && j.state.nextRunAtMs < now + 86_400_000)
    .toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));

  if (upcoming.length === 0) return null;

  return (
    <div className="mb-8">
      <h2 className="text-sm font-medium uppercase tracking-wider mb-3" style={{ color: "var(--color-text-muted)" }}>
        Upcoming (next 24h)
      </h2>
      <div className="rounded-2xl p-4" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
        <div className="relative">
          <div className="absolute top-0 left-3 bottom-0 w-px" style={{ background: "var(--color-border)" }} />
          <div className="space-y-3">
            {upcoming.map((job) => (
              <div key={job.id} className="flex items-center gap-3 pl-1">
                <div className="relative z-10 w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "var(--color-accent)", opacity: 0.8 }}>
                  <div className="w-2 h-2 rounded-full" style={{ background: "var(--color-bg)" }} />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium" style={{ color: "var(--color-text)" }}>{job.name}</span>
                  <span className="text-xs ml-2" style={{ color: "var(--color-text-muted)" }}>in {formatCountdown((job.state.nextRunAtMs ?? 0) - now)}</span>
                </div>
                <span className="text-[11px] flex-shrink-0" style={{ color: "var(--color-text-muted)" }}>
                  {new Date(job.state.nextRunAtMs!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function JobsTable({ jobs, onSelectJob, onSendCommand }: { jobs: CronJob[]; onSelectJob: (jobId: string) => void; onSendCommand?: (msg: string) => void }) {
  return (
    <div className="mb-6">
      <h2 className="text-sm font-medium uppercase tracking-wider mb-3" style={{ color: "var(--color-text-muted)" }}>Jobs</h2>
      {jobs.length === 0 ? (
        <div className="p-8 text-center rounded-2xl" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            No cron jobs configured.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--color-surface)" }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)", color: "var(--color-text-muted)" }}>
                <th className="text-left px-4 py-2.5 font-medium text-xs uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-2.5 font-medium text-xs uppercase tracking-wider">Schedule</th>
                <th className="text-left px-4 py-2.5 font-medium text-xs uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-2.5 font-medium text-xs uppercase tracking-wider">Next Run</th>
                <th className="text-left px-4 py-2.5 font-medium text-xs uppercase tracking-wider">Last Run</th>
                <th className="text-left px-4 py-2.5 font-medium text-xs uppercase tracking-wider w-20"></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => <JobRow key={job.id} job={job} onClick={() => onSelectJob(job.id)} onSendCommand={onSendCommand} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function JobRow({ job, onClick, onSendCommand }: { job: CronJob; onClick: () => void; onSendCommand?: (msg: string) => void }) {
  const status = jobStatusLabel(job);
  const statusColor = jobStatusColor(status);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <tr
      className="cursor-pointer transition-colors group"
      style={{ borderBottom: "1px solid var(--color-border)" }}
      onClick={onClick}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="font-medium" style={{ color: "var(--color-text)" }}>{job.name}</div>
          {job.state.consecutiveErrors != null && job.state.consecutiveErrors > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "color-mix(in srgb, var(--color-error, #ef4444) 12%, transparent)", color: "var(--color-error, #ef4444)" }}>
              {job.state.consecutiveErrors} err
            </span>
          )}
        </div>
        {job.description && <div className="text-xs truncate max-w-[200px]" style={{ color: "var(--color-text-muted)" }}>{job.description}</div>}
      </td>
      <td className="px-4 py-3 text-xs" style={{ color: "var(--color-text-muted)" }}>{formatSchedule(job.schedule)}</td>
      <td className="px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full" style={{ background: `color-mix(in srgb, ${statusColor} 12%, transparent)`, color: statusColor }}>
          {status === "running" && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: statusColor }} />}
          {status}
        </span>
      </td>
      <td className="px-4 py-3 text-xs" style={{ color: "var(--color-text-muted)" }}>
        {job.state.nextRunAtMs ? (job.state.nextRunAtMs > now ? `in ${formatCountdown(job.state.nextRunAtMs - now)}` : "overdue") : "-"}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          {job.state.lastStatus && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: jobStatusColor(job.state.lastStatus) }} />}
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {job.state.lastRunAtMs ? `${formatTimeAgo(job.state.lastRunAtMs)}${job.state.lastDurationMs ? ` (${formatDuration(job.state.lastDurationMs)})` : ""}` : "-"}
          </span>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          {!job.state.runningAtMs && job.enabled && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onSendCommand?.(`Run cron job "${job.name}" (${job.id}) now with --force`); }}
              className="p-1 rounded cursor-pointer" style={{ color: "var(--color-accent)" }} title="Run now">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="6 3 20 12 6 21 6 3" /></svg>
            </button>
          )}
          <button type="button" onClick={(e) => { e.stopPropagation(); onSendCommand?.(`${job.enabled ? "Disable" : "Enable"} cron job "${job.name}" (${job.id})`); }}
            className="p-1 rounded cursor-pointer" style={{ color: job.enabled ? "var(--color-text-muted)" : "var(--color-success, #22c55e)" }} title={job.enabled ? "Disable" : "Enable"}>
            {job.enabled ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="m4.93 4.93 14.14 14.14" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            )}
          </button>
        </div>
      </td>
    </tr>
  );
}

/* ─── Icons ─── */

function HeartbeatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function RunningIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}
