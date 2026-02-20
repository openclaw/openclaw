"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Clock,
  Plus,
  Play,
  Pause,
  RotateCcw,
  Trash2,
  Loader2,
  Calendar,
  Bot,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useGatewayConnectionState,
  useGatewayEvents,
  type GatewayConnectionState,
  type GatewayEvent,
} from "@/lib/hooks/use-gateway-events";

interface ScheduleObject {
  kind?: string;
  everyMs?: number;
  cron?: string;
  expr?: string;
  tz?: string;
  anchorMs?: number;
}

interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: string;
  lastDurationMs?: number;
}

interface CronJobPayload {
  kind?: string;
  message?: string;
  [key: string]: unknown;
}

interface CronJob {
  id: string;
  name?: string;
  prompt?: string;
  schedule: string | ScheduleObject;
  enabled: boolean;
  agentId?: string;
  lastRun?: string;
  nextRun?: string;
  state?: CronJobState;
  payload?: CronJobPayload;
}

interface CronRun {
  id?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  error?: string;
  [key: string]: unknown;
}

// Human-friendly schedule presets
const SCHEDULE_PRESETS = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 9:00 AM", cron: "0 9 * * *" },
  { label: "Every day at 6:00 PM", cron: "0 18 * * *" },
  { label: "Every weekday at 9:00 AM", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 9:00 AM", cron: "0 9 * * 1" },
  { label: "Every Sunday at 2:00 AM", cron: "0 2 * * 0" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every 30 minutes", cron: "*/30 * * * *" },
  { label: "Twice a day (9 AM & 6 PM)", cron: "0 9,18 * * *" },
  { label: "First day of month", cron: "0 9 1 * *" },
];

function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} minutes`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} hours`;
  return `${Math.round(ms / 86_400_000)} days`;
}

function scheduleToHuman(schedule: string | ScheduleObject): string {
  if (typeof schedule === "object" && schedule !== null) {
    if (schedule.kind === "every" && schedule.everyMs) {
      return `Every ${formatMs(schedule.everyMs)}`;
    }
    if (schedule.kind === "cron" && (schedule.expr || schedule.cron)) {
      return cronToHuman(schedule.expr || schedule.cron!);
    }
    if (schedule.everyMs) {
      return `Every ${formatMs(schedule.everyMs)}`;
    }
    return "Custom schedule";
  }
  if (typeof schedule !== "string") return "Custom schedule";
  return cronToHuman(schedule);
}

function cronToHuman(cron: string): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.cron === cron);
  if (preset) return preset.label;

  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;

  const [min, hour, dom, , dow] = parts;

  if (min === "0" && hour !== "*" && dom === "*" && dow === "*") {
    const h = parseInt(hour);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `Every day at ${h12}:00 ${ampm}`;
  }
  if (min.startsWith("*/")) return `Every ${min.slice(2)} minutes`;
  if (hour.startsWith("*/")) return `Every ${hour.slice(2)} hours`;
  return cron;
}

function timeAgo(dateStr: string | undefined): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) {
    const future = Math.abs(seconds);
    if (future < 3600) return `in ${Math.floor(future / 60)}m`;
    if (future < 86400) return `in ${Math.floor(future / 3600)}h`;
    return `in ${Math.floor(future / 86400)}d`;
  }
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function CronScheduler() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; prompt: string } | null>(null);
  const [runHistory, setRunHistory] = useState<Record<string, CronRun[]>>({});
  const [loadingRuns, setLoadingRuns] = useState<string | null>(null);

  // Create form state
  const [newPrompt, setNewPrompt] = useState("");
  const [newSchedule, setNewSchedule] = useState(SCHEDULE_PRESETS[1].cron);
  const [newAgent, setNewAgent] = useState("main");
  const [creating, setCreating] = useState(false);
  const [connectionState, setConnectionState] =
    useState<GatewayConnectionState>("connecting");
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/openclaw/cron");
      const data = await res.json();
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch {
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRunHistory = useCallback(async (jobId: string) => {
    setLoadingRuns(jobId);
    try {
      const res = await fetch(`/api/openclaw/cron?runs=${encodeURIComponent(jobId)}`);
      const data = await res.json();
      const runs = Array.isArray(data.runs) ? data.runs : [];
      setRunHistory(prev => ({ ...prev, [jobId]: runs }));
    } catch {
      // Ignore fetch errors
    } finally {
      setLoadingRuns(null);
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      fetchJobs().catch(() => {
        // Ignore transient refresh failures.
      });
    }, 220);
  }, [fetchJobs]);

  const handleConnectionState = useCallback((state: GatewayConnectionState) => {
    setConnectionState(state);
  }, []);

  const handleGatewayEvent = useCallback(
    (event: GatewayEvent) => {
      if (event.type !== "gateway_event") return;
      const eventName = (event.event || "").toLowerCase();
      if (eventName.includes("cron.") || eventName.includes("status")) {
        scheduleRefresh();
      }
    },
    [scheduleRefresh]
  );

  useGatewayConnectionState(handleConnectionState);
  useGatewayEvents(handleGatewayEvent);

  useEffect(() => {
    fetchJobs().catch(() => {
      // Ignore initial load errors.
    });
  }, [fetchJobs]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      if (connectionState !== "connected") {
        fetchJobs().catch(() => {
          // Ignore fallback refresh failures.
        });
      }
    }, 20_000);
    return () => clearInterval(intervalId);
  }, [connectionState, fetchJobs]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  const createJob = async () => {
    if (!newPrompt.trim()) return;
    setCreating(true);
    try {
      await fetch("/api/openclaw/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          prompt: newPrompt,
          schedule: newSchedule,
          agentId: newAgent,
          enabled: true,
        }),
      });
      setNewPrompt("");
      setShowCreate(false);
      await fetchJobs();
    } finally {
      setCreating(false);
    }
  };

  const toggleJob = async (id: string, enabled: boolean) => {
    setActionLoading(id);
    try {
      await fetch("/api/openclaw/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", id, enabled: !enabled }),
      });
      await fetchJobs();
    } finally {
      setActionLoading(null);
    }
  };

  const runNow = async (id: string) => {
    setActionLoading(id);
    try {
      await fetch("/api/openclaw/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run", id, mode: "force" }),
      });
      await fetchJobs();
    } finally {
      setActionLoading(null);
    }
  };

  const removeJob = async (id: string) => {
    setActionLoading(id);
    try {
      await fetch("/api/openclaw/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", id }),
      });
      await fetchJobs();
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="p-6 border-b border-border bg-card/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center">
              <Calendar className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Scheduled Tasks</h2>
              <p className="text-sm text-muted-foreground">
                Set up recurring AI tasks — they run automatically on schedule
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="font-mono">
              {jobs.filter((j) => j.enabled).length} active
            </Badge>
            <Button onClick={() => setShowCreate(true)} className="gap-1.5">
              <Plus className="w-4 h-4" />
              New Task
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="text-center py-16">
            <Clock className="w-14 h-14 mx-auto mb-3 text-muted-foreground opacity-30" />
            <p className="text-lg font-medium mb-1">No Scheduled Tasks</p>
            <p className="text-sm text-muted-foreground mb-4">
              Create your first recurring AI task
            </p>
            <Button onClick={() => setShowCreate(true)} className="gap-1.5">
              <Plus className="w-4 h-4" />
              Create Task
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => {
              const isExpanded = expandedJob === job.id;
              const isLoading = actionLoading === job.id;
              return (
                <div
                  key={job.id}
                  className={`glass-panel rounded-lg overflow-hidden transition-all ${
                    job.enabled
                      ? "border-l-4 border-l-green-500/50"
                      : "border-l-4 border-l-muted/50 opacity-70"
                  }`}
                >
                  <div className="p-4 flex items-center gap-4">
                    {/* Status indicator */}
                    <div
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        job.enabled ? "bg-green-500" : "bg-muted-foreground"
                      }`}
                    />

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">
                        {job.name || job.prompt || "Unnamed task"}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {scheduleToHuman(job.schedule)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Bot className="w-3 h-3" />
                          {job.agentId || "main"}
                        </span>
                        {(job.state?.nextRunAtMs || job.nextRun) && (
                          <span>Next: {timeAgo(job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : job.nextRun)}</span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => runNow(job.id)}
                        disabled={isLoading}
                        className="gap-1 text-xs h-8"
                        title="Run Now"
                      >
                        {isLoading ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Play className="w-3.5 h-3.5" />
                        )}
                        Run
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleJob(job.id, job.enabled)}
                        disabled={isLoading}
                        className="gap-1 text-xs h-8"
                        title={job.enabled ? "Pause" : "Resume"}
                      >
                        {job.enabled ? (
                          <Pause className="w-3.5 h-3.5" />
                        ) : (
                          <RotateCcw className="w-3.5 h-3.5" />
                        )}
                        {job.enabled ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const willExpand = !isExpanded;
                          setExpandedJob(willExpand ? job.id : null);
                          if (willExpand) {
                            fetchRunHistory(job.id);
                          }
                        }}
                        className="h-8 w-8 p-0"
                      >
                        {isExpanded ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-0 border-t border-border ml-6">
                      <div className="grid grid-cols-2 gap-3 py-3 text-xs">
                        <div>
                          <span className="text-muted-foreground">Schedule:</span>{" "}
                          <span className="font-mono">{scheduleToHuman(job.schedule)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Agent:</span>{" "}
                          {job.agentId || "main"}
                        </div>
                        <div>
                          <span className="text-muted-foreground">Last run:</span>{" "}
                          {timeAgo(job.state?.lastRunAtMs ? new Date(job.state.lastRunAtMs).toISOString() : job.lastRun)}
                          {job.state?.lastStatus && (
                            <span className={`ml-1.5 ${job.state.lastStatus === "ok" ? "text-green-500" : "text-red-400"}`}>
                              ({job.state.lastStatus})
                            </span>
                          )}
                        </div>
                        <div>
                          <span className="text-muted-foreground">Next run:</span>{" "}
                          {timeAgo(job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : job.nextRun)}
                        </div>
                      </div>
                      {job.payload?.message && (
                        <div className="text-xs text-muted-foreground mt-1 mb-2 p-2 bg-muted/50 rounded font-mono line-clamp-3">
                          {job.payload.message}
                        </div>
                      )}

                      {/* Recent Runs */}
                      <div className="mt-3 pt-3 border-t border-border">
                        <p className="text-xs font-medium text-muted-foreground mb-2">📜 Recent Runs</p>
                        {loadingRuns === job.id ? (
                          <p className="text-xs text-muted-foreground">Loading runs...</p>
                        ) : (runHistory[job.id] || []).length === 0 ? (
                          <p className="text-xs text-muted-foreground">No runs recorded yet</p>
                        ) : (
                          <div className="space-y-1.5">
                            {(runHistory[job.id] || []).slice(0, 5).map((run, i) => (
                              <div key={run.id || i} className="flex items-center gap-2 text-xs">
                                <span className={`w-2 h-2 rounded-full ${
                                  run.status === "success" ? "bg-green-500" :
                                  run.status === "failed" ? "bg-red-500" :
                                  "bg-amber-500"
                                }`} />
                                <span className="font-medium">{run.status || "unknown"}</span>
                                <span className="text-muted-foreground">{run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}</span>
                                {run.duration != null && <span className="text-muted-foreground">({run.duration}ms)</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex gap-2 pt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setDeleteConfirm({ id: job.id, prompt: job.name || job.prompt || "Unnamed task" })}
                          disabled={isLoading}
                          className="gap-1 text-xs text-red-400 border-red-400/20 hover:bg-red-400/10"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" />
              Delete Scheduled Task?
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the scheduled task &quot;{deleteConfirm?.prompt}&quot;? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (deleteConfirm) {
                  await removeJob(deleteConfirm.id);
                  setDeleteConfirm(null);
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Schedule a New Task</DialogTitle>
            <DialogDescription>
              Tell your AI agent what to do, and how often.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Prompt */}
            <div>
              <label className="block text-sm font-medium mb-1.5">
                What should the AI do?
              </label>
              <textarea
                value={newPrompt}
                onChange={(e) => setNewPrompt(e.target.value)}
                placeholder="Summarize my unread emails and send a brief to Slack"
                rows={3}
                maxLength={2000}
                className="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none"
              />
            </div>

            {/* Schedule */}
            <div>
              <label className="block text-sm font-medium mb-1.5">
                How often?
              </label>
              <Select value={newSchedule} onValueChange={setNewSchedule}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a schedule" />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_PRESETS.map((p) => (
                    <SelectItem key={p.cron} value={p.cron}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Agent */}
            <div>
              <label className="block text-sm font-medium mb-1.5">
                Which agent?
              </label>
              <input
                type="text"
                value={newAgent}
                onChange={(e) => setNewAgent(e.target.value)}
                placeholder="main"
                maxLength={200}
                className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={createJob}
              disabled={creating || !newPrompt.trim()}
              className="gap-1.5"
            >
              {creating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              Create Task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
