"use client";

import { useEffect, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CronJob, CronRunLogEntry, CronRunsResponse } from "../../types/cron";
import { CronRunChat } from "./cron-run-chat";

/* ─── Helpers ─── */

function formatSchedule(schedule: CronJob["schedule"]): string {
  switch (schedule.kind) {
    case "cron":
      return schedule.expr + (schedule.tz ? ` (${schedule.tz})` : "");
    case "every": {
      const ms = schedule.everyMs;
      if (ms >= 86_400_000) {return `every ${Math.round(ms / 86_400_000)} day(s)`;}
      if (ms >= 3_600_000) {return `every ${Math.round(ms / 3_600_000)} hour(s)`;}
      if (ms >= 60_000) {return `every ${Math.round(ms / 60_000)} minute(s)`;}
      return `every ${Math.round(ms / 1000)} second(s)`;
    }
    case "at":
      return new Date(schedule.at).toLocaleString();
    default:
      return "unknown";
  }
}

function formatCountdown(ms: number): string {
  if (ms <= 0) {return "now";}
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) {return `${totalSec}s`;}
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) {return sec > 0 ? `${min}m ${sec}s` : `${min}m`;}
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {return `${ms}ms`;}
  if (ms < 60_000) {return `${(ms / 1000).toFixed(1)}s`;}
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function payloadSummary(payload: CronJob["payload"]): string {
  if (payload.kind === "systemEvent") {return payload.text.slice(0, 120);}
  return payload.message.slice(0, 120);
}

/* ─── Main component ─── */

export function CronJobDetail({
  job,
  onBack,
}: {
  job: CronJob;
  onBack: () => void;
}) {
  const [runs, setRuns] = useState<CronRunLogEntry[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [expandedRunTs, setExpandedRunTs] = useState<number | null>(null);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch(`/api/cron/jobs/${encodeURIComponent(job.id)}/runs?limit=50`);
      const data: CronRunsResponse = await res.json();
      setRuns(data.entries ?? []);
    } catch {
      // ignore
    } finally {
      setLoadingRuns(false);
    }
  }, [job.id]);

  useEffect(() => {
    fetchRuns();
    const id = setInterval(fetchRuns, 15_000);
    return () => clearInterval(id);
  }, [fetchRuns]);

  const status = !job.enabled
    ? "disabled"
    : job.state.runningAtMs
      ? "running"
      : (job.state.lastStatus ?? "idle");

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Back button + header */}
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-sm mb-4 cursor-pointer"
        style={{ color: "var(--color-text-muted)" }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
        </svg>
        Back to Cron
      </button>

      {/* Job header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1
            className="font-instrument text-3xl tracking-tight"
            style={{ color: "var(--color-text)" }}
          >
            {job.name}
          </h1>
          <StatusBadge status={status} />
        </div>
        {job.description && (
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            {job.description}
          </p>
        )}
      </div>

      {/* Config + countdown grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {/* Next run countdown */}
        <NextRunCard job={job} />

        {/* Job config */}
        <div
          className="rounded-2xl p-4"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
          }}
        >
          <h3 className="text-xs font-medium uppercase tracking-wider mb-3" style={{ color: "var(--color-text-muted)" }}>
            Configuration
          </h3>
          <div className="space-y-2 text-sm">
            <ConfigRow label="Schedule" value={formatSchedule(job.schedule)} />
            <ConfigRow label="Target" value={job.sessionTarget} />
            <ConfigRow label="Wake mode" value={job.wakeMode} />
            <ConfigRow label="Payload" value={`${job.payload.kind}: ${payloadSummary(job.payload)}`} />
            {job.agentId && <ConfigRow label="Agent" value={job.agentId} />}
            {job.delivery && <ConfigRow label="Delivery" value={job.delivery.mode} />}
            <ConfigRow label="Created" value={new Date(job.createdAtMs).toLocaleString()} />
          </div>
        </div>
      </div>

      {/* Error streak */}
      {job.state.consecutiveErrors && job.state.consecutiveErrors > 0 && (
        <div
          className="rounded-2xl p-4 mb-6"
          style={{
            background: "color-mix(in srgb, var(--color-error, #ef4444) 6%, var(--color-surface))",
            border: "1px solid color-mix(in srgb, var(--color-error, #ef4444) 18%, transparent)",
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-error, #ef4444)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="text-sm font-medium" style={{ color: "var(--color-error, #ef4444)" }}>
              {job.state.consecutiveErrors} consecutive error{job.state.consecutiveErrors > 1 ? "s" : ""}
            </span>
          </div>
          {job.state.lastError && (
            <p className="text-xs font-mono mt-1" style={{ color: "var(--color-error, #ef4444)", opacity: 0.8 }}>
              {job.state.lastError}
            </p>
          )}
        </div>
      )}

      {/* Run history */}
      <div>
        <h2
          className="text-sm font-medium uppercase tracking-wider mb-3"
          style={{ color: "var(--color-text-muted)" }}
        >
          Run History
        </h2>

        {loadingRuns ? (
          <div className="flex items-center justify-center p-8">
            <div
              className="w-5 h-5 border-2 rounded-full animate-spin"
              style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
            />
          </div>
        ) : runs.length === 0 ? (
          <div
            className="p-8 text-center rounded-2xl"
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
            }}
          >
            <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
              No runs recorded yet.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.toReversed().map((run) => (
              <RunCard
                key={`${run.ts}-${run.jobId}`}
                run={run}
                isExpanded={expandedRunTs === run.ts}
                onToggle={() => setExpandedRunTs(expandedRunTs === run.ts ? null : run.ts)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Next run countdown card ─── */

function NextRunCard({ job }: { job: CronJob }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const nextMs = job.state.nextRunAtMs;
  const isRunning = !!job.state.runningAtMs;

  return (
    <div
      className="rounded-2xl p-4 flex flex-col justify-center"
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
      }}
    >
      <h3 className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: "var(--color-text-muted)" }}>
        {isRunning ? "Currently Running" : "Next Run"}
      </h3>
      {isRunning ? (
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full animate-pulse"
            style={{ background: "var(--color-accent)" }}
          />
          <span className="text-2xl font-semibold" style={{ color: "var(--color-accent)" }}>
            Running now
          </span>
        </div>
      ) : nextMs ? (
        <>
          <div className="text-3xl font-semibold mb-1" style={{ color: "var(--color-text)" }}>
            {nextMs > now ? formatCountdown(nextMs - now) : "overdue"}
          </div>
          <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {new Date(nextMs).toLocaleString()}
          </div>
        </>
      ) : (
        <div className="text-lg" style={{ color: "var(--color-text-muted)" }}>
          {job.enabled ? "Not scheduled" : "Disabled"}
        </div>
      )}
    </div>
  );
}

/* ─── Run card ─── */

function RunCard({
  run,
  isExpanded,
  onToggle,
}: {
  run: CronRunLogEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const statusColor = run.status === "ok"
    ? "var(--color-success, #22c55e)"
    : run.status === "error"
      ? "var(--color-error, #ef4444)"
      : "var(--color-warning, #f59e0b)";

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
      }}
    >
      {/* Run header - clickable */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer transition-colors"
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        {/* Status dot */}
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ background: statusColor }}
        />

        {/* Timestamp */}
        <span className="text-sm" style={{ color: "var(--color-text)" }}>
          {new Date(run.ts).toLocaleString()}
        </span>

        {/* Status badge */}
        <span
          className="text-xs px-2 py-0.5 rounded-full"
          style={{
            background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
            color: statusColor,
          }}
        >
          {run.status ?? "unknown"}
        </span>

        {/* Duration */}
        {run.durationMs != null && (
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {formatDuration(run.durationMs)}
          </span>
        )}

        {/* Summary */}
        {run.summary && (
          <span className="text-xs truncate flex-1 min-w-0" style={{ color: "var(--color-text-muted)" }}>
            {run.summary}
          </span>
        )}

        {/* Has session indicator */}
        {run.sessionId && (
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}>
            chat
          </span>
        )}

        {/* Chevron */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 12 12"
          fill="none"
          stroke="var(--color-text-muted)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`flex-shrink-0 transition-transform duration-200 ${isExpanded ? "" : "-rotate-90"}`}
        >
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div
          className="px-4 pb-4"
          style={{ borderTop: "1px solid var(--color-border)" }}
        >
          {/* Error message */}
          {run.error && (
            <div
              className="mt-3 text-xs font-mono rounded-lg px-3 py-2"
              style={{
                color: "var(--color-error, #ef4444)",
                background: "color-mix(in srgb, var(--color-error, #ef4444) 6%, var(--color-surface))",
              }}
            >
              {run.error}
            </div>
          )}

          {/* Session transcript (full chat) or summary fallback */}
          {run.sessionId ? (
            <div className="mt-4">
              <CronRunChat sessionId={run.sessionId} />
            </div>
          ) : run.summary ? (
            <div className="mt-3">
              <div
                className="text-[11px] uppercase tracking-wider font-medium mb-2"
                style={{ color: "var(--color-text-muted)" }}
              >
                Run Output
              </div>
              <div
                className="chat-prose text-sm"
                style={{ color: "var(--color-text)" }}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {run.summary}
                </ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="mt-3 text-xs" style={{ color: "var(--color-text-muted)" }}>
              No output recorded for this run.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Subcomponents ─── */

function StatusBadge({ status }: { status: string }) {
  const color = status === "ok"
    ? "var(--color-success, #22c55e)"
    : status === "running"
      ? "var(--color-accent)"
      : status === "error"
        ? "var(--color-error, #ef4444)"
        : "var(--color-text-muted)";

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full"
      style={{
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        color,
      }}
    >
      {status === "running" && (
        <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: color }} />
      )}
      {status}
    </span>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-xs font-medium w-20 flex-shrink-0" style={{ color: "var(--color-text-muted)" }}>
        {label}
      </span>
      <span className="text-xs break-all" style={{ color: "var(--color-text)" }}>
        {value}
      </span>
    </div>
  );
}
