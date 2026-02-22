"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Link2,
  MessageSquare,
  Rocket,
  Search,
  Server,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActivityEntry, GatewayStatus, Task } from "@/lib/hooks/use-tasks";

type GatewayConnectionState = "connecting" | "connected" | "disconnected";

interface OverviewCommandCenterProps {
  tasks: Task[];
  activity: ActivityEntry[];
  gatewayStatus: GatewayStatus;
  gatewayConnectionState: GatewayConnectionState;
  onCreateTask: () => void;
  onNavigate: (view: string) => void;
}

interface ServicesSnapshot {
  modelCount: number;
  integrationCount: number;
  searchProviders: string[];
  aiChecks: {
    gateway: boolean;
    models: boolean;
    usage: boolean;
    usageCost: boolean;
  };
  fetchedAt: string | null;
}

function formatRelativeTime(ts: string | null | undefined): string {
  if (!ts) {return "n/a";}
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) {return "n/a";}
  const diffSec = Math.max(0, Math.floor((Date.now() - at.getTime()) / 1000));
  if (diffSec < 60) {return `${diffSec}s ago`;}
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {return `${diffMin}m ago`;}
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {return `${diffHr}h ago`;}
  return `${Math.floor(diffHr / 24)}d ago`;
}

function statusClass(ok: boolean): string {
  return ok
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
    : "border-destructive/40 bg-destructive/10 text-destructive";
}

export function OverviewCommandCenter({
  tasks,
  activity,
  gatewayStatus,
  gatewayConnectionState,
  onCreateTask,
  onNavigate,
}: OverviewCommandCenterProps) {
  const [servicesSnapshot, setServicesSnapshot] = useState<ServicesSnapshot>({
    modelCount: 0,
    integrationCount: 0,
    searchProviders: [],
    aiChecks: {
      gateway: false,
      models: false,
      usage: false,
      usageCost: false,
    },
    fetchedAt: null,
  });

  const loadServicesSnapshot = useCallback(async () => {
    try {
      const [modelsRes, integrationsRes, searchRes] = await Promise.all([
        fetch("/api/models"),
        fetch("/api/integrations"),
        fetch("/api/search"),
      ]);
      const connectivityRes = await fetch("/api/openclaw/connectivity");

      const modelsJson = modelsRes.ok
        ? ((await modelsRes.json()) as { models?: unknown[] })
        : null;
      const integrationsJson = integrationsRes.ok
        ? ((await integrationsRes.json()) as {
            integrations?: Record<string, { configured?: boolean }>;
          })
        : null;
      const searchJson = searchRes.ok
        ? ((await searchRes.json()) as {
            providers?: Record<string, string>;
          })
        : null;
      const connectivityJson = connectivityRes.ok
        ? ((await connectivityRes.json()) as {
            connected?: boolean;
            checks?: Record<string, { ok?: boolean }>;
          })
        : null;

      const integrationCount = Object.values(integrationsJson?.integrations || {}).filter(
        (entry) => !!entry?.configured
      ).length;
      const searchProviders = Object.entries(searchJson?.providers || {})
        .filter(([, state]) => state === "available" || state.includes("available"))
        .map(([provider]) => provider);

      setServicesSnapshot({
        modelCount: modelsJson?.models?.length || 0,
        integrationCount,
        searchProviders,
        aiChecks: {
          gateway: !!connectivityJson?.connected,
          models: !!connectivityJson?.checks?.models?.ok,
          usage: !!connectivityJson?.checks?.usage?.ok,
          usageCost: !!connectivityJson?.checks?.usageCost?.ok,
        },
        fetchedAt: new Date().toISOString(),
      });
    } catch {
      // Keep the previous snapshot on transient failures.
    }
  }, []);

  useEffect(() => {
    const initialLoadId = setTimeout(() => {
      void loadServicesSnapshot();
    }, 0);
    const id = setInterval(loadServicesSnapshot, 60_000);
    return () => {
      clearTimeout(initialLoadId);
      clearInterval(id);
    };
  }, [loadServicesSnapshot]);

  const queueSummary = useMemo(() => {
    const summary = {
      inbox: 0,
      assigned: 0,
      in_progress: 0,
      review: 0,
      done: 0,
    };
    for (const task of tasks) {
      if (task.status in summary) {
        summary[task.status as keyof typeof summary] += 1;
      }
    }
    return summary;
  }, [tasks]);

  const recentActivity = useMemo(() => activity.slice(0, 6), [activity]);

  const recentResults = useMemo(() => {
    return tasks
      .filter((task) => task.status === "review" || task.status === "done")
      .toSorted((a, b) => {
        return (
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
      })
      .slice(0, 6);
  }, [tasks]);

  const connected =
    gatewayConnectionState === "connected" && gatewayStatus.connected;

  return (
    <section className="space-y-4">
      <div className="bg-card/70 border border-border rounded-xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary" />
              Command Center Overview
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Ported from the legacy dashboard: services, queue, activity, and results in one place.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Last sync {formatRelativeTime(servicesSnapshot.fetchedAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onCreateTask}>
              Create Task
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNavigate("chat")}>
              <MessageSquare className="w-4 h-4 mr-1.5" />
              Chat
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNavigate("orchestrate")}>
              <Rocket className="w-4 h-4 mr-1.5" />
              Orchestrate
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNavigate("integrations")}>
              <Link2 className="w-4 h-4 mr-1.5" />
              Integrations
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="bg-card/70 border border-border rounded-xl p-4 space-y-3">
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
            Services
          </h3>

          <div className={`rounded-lg border px-3 py-2 text-sm ${statusClass(connected)}`}>
            <div className="font-medium flex items-center gap-2">
              <Server className="w-4 h-4" />
              Gateway
            </div>
            <div className="text-xs mt-1">
              {connected ? "Connected and healthy" : "Disconnected"}
            </div>
          </div>

          <div className="rounded-lg border border-border px-3 py-2 text-sm">
            <div className="font-medium flex items-center gap-2">
              <Bot className="w-4 h-4 text-primary" />
              Agents
            </div>
            <div className="text-xs mt-1 text-muted-foreground">
              {gatewayStatus.agentCount} active
            </div>
          </div>

          <div className="rounded-lg border border-border px-3 py-2 text-sm">
            <div className="font-medium flex items-center gap-2">
              <BrainCircuit className="w-4 h-4 text-primary" />
              Models
            </div>
            <div className="text-xs mt-1 text-muted-foreground">
              {servicesSnapshot.modelCount} available
            </div>
          </div>

          <div className="rounded-lg border border-border px-3 py-2 text-sm">
            <div className="font-medium flex items-center gap-2">
              <Link2 className="w-4 h-4 text-primary" />
              Integrations
            </div>
            <div className="text-xs mt-1 text-muted-foreground">
              {servicesSnapshot.integrationCount} configured
            </div>
          </div>

          <div className="rounded-lg border border-border px-3 py-2 text-sm">
            <div className="font-medium flex items-center gap-2">
              <Search className="w-4 h-4 text-primary" />
              Search Providers
            </div>
            <div className="text-xs mt-1 text-muted-foreground">
              {servicesSnapshot.searchProviders.length > 0
                ? servicesSnapshot.searchProviders.join(", ")
                : "None configured"}
            </div>
          </div>

          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              servicesSnapshot.aiChecks.gateway &&
              servicesSnapshot.aiChecks.models &&
              (servicesSnapshot.aiChecks.usage || servicesSnapshot.aiChecks.usageCost)
                ? "border-emerald-500/40 bg-emerald-500/10"
                : "border-amber-500/40 bg-amber-500/10"
            }`}
          >
            <div className="font-medium flex items-center gap-2">
              <BrainCircuit className="w-4 h-4 text-primary" />
              AI APIs
            </div>
            <div className="text-xs mt-1 text-muted-foreground">
              Gateway {servicesSnapshot.aiChecks.gateway ? "ok" : "down"} · Models{" "}
              {servicesSnapshot.aiChecks.models ? "ok" : "fail"} · Usage{" "}
              {servicesSnapshot.aiChecks.usage || servicesSnapshot.aiChecks.usageCost ? "ok" : "fail"}
            </div>
          </div>
        </div>

        <div className="bg-card/70 border border-border rounded-xl p-4 space-y-3">
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
            Task Queue
          </h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg border border-border px-3 py-2">
              <div className="text-xs text-muted-foreground">Inbox</div>
              <div className="font-semibold">{queueSummary.inbox}</div>
            </div>
            <div className="rounded-lg border border-border px-3 py-2">
              <div className="text-xs text-muted-foreground">Assigned</div>
              <div className="font-semibold">{queueSummary.assigned}</div>
            </div>
            <div className="rounded-lg border border-border px-3 py-2">
              <div className="text-xs text-muted-foreground">In Progress</div>
              <div className="font-semibold">{queueSummary.in_progress}</div>
            </div>
            <div className="rounded-lg border border-border px-3 py-2">
              <div className="text-xs text-muted-foreground">Review</div>
              <div className="font-semibold">{queueSummary.review}</div>
            </div>
          </div>
          <div className="rounded-lg border border-border px-3 py-2 text-sm">
            <div className="text-xs text-muted-foreground">Done</div>
            <div className="font-semibold">{queueSummary.done}</div>
          </div>
        </div>

        <div className="bg-card/70 border border-border rounded-xl p-4 space-y-3">
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
            Recent Activity
          </h3>
          {recentActivity.length === 0 ? (
            <div className="text-sm text-muted-foreground">No activity yet.</div>
          ) : (
            <div className="space-y-2">
              {recentActivity.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border px-3 py-2">
                  <div className="text-sm leading-tight">{entry.message}</div>
                  <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                    <Clock3 className="w-3.5 h-3.5" />
                    {formatRelativeTime(entry.created_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-card/70 border border-border rounded-xl p-4 space-y-3">
        <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
          Results
        </h3>
        {recentResults.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No completed or review-ready tasks yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {recentResults.map((task) => (
              <div key={task.id} className="rounded-lg border border-border px-3 py-2">
                <div className="text-sm font-medium">{task.title}</div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                  {task.status === "done" ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Activity className="w-3.5 h-3.5 text-amber-400" />
                  )}
                  {task.status === "done" ? "Done" : "In Review"} •{" "}
                  {formatRelativeTime(task.updated_at)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
