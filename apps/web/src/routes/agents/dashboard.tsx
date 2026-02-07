import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  Calendar,
  RefreshCw,
  Users,
  Pause,
  Zap,
  XCircle,
  MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CardSkeleton , RouteErrorFallback } from "@/components/composed";
import { StatusBadge } from "@/components/composed/StatusBadge";
import { cn } from "@/lib/utils";
import { useAgentDashboardData, type AgentDashboardEntry } from "@/hooks/queries/useAgentDashboard";
import type { AgentHealthStatus } from "@/hooks/queries/useAgentStatus";

export const Route = createFileRoute("/agents/dashboard")({
  component: AgentsDashboardPage,
  errorComponent: RouteErrorFallback,
});

const HEALTH_ORDER: Record<AgentHealthStatus, number> = {
  active: 0,
  errored: 1,
  stalled: 2,
  idle: 3,
};

const HEALTH_LABELS: Record<AgentHealthStatus, string> = {
  active: "Active",
  stalled: "Stalled",
  idle: "Idle",
  errored: "Errored",
};

function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatRelativeTime(timestampMs: number | null): string {
  if (!timestampMs) return "—";
  const delta = Date.now() - timestampMs;
  if (delta < 5_000) return "Just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function shortenSessionKey(key: string): string {
  const parts = key.split(":");
  if (parts.length > 2 && parts[0] === "agent") {
    return parts.slice(2).join(":");
  }
  return key;
}

function healthToStatusBadge(health: AgentHealthStatus) {
  switch (health) {
    case "active":
      return { status: "online" as const, label: "Active" };
    case "stalled":
      return { status: "busy" as const, label: "Stalled" };
    case "idle":
      return { status: "paused" as const, label: "Idle" };
    case "errored":
      return { status: "error" as const, label: "Errored" };
    default:
      return { status: "offline" as const, label: "Unknown" };
  }
}

interface SummaryCardProps {
  label: string;
  value: string | number;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
}

function SummaryCard({ label, value, icon: Icon, iconColor, iconBg }: SummaryCardProps) {
  return (
    <Card className="border-border/50 bg-card/50">
      <CardContent className="flex items-center gap-3 p-4">
        <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg", iconBg)}>
          <Icon className={cn("h-5 w-5", iconColor)} />
        </div>
        <div>
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function AgentCard({ entry, onClick }: { entry: AgentDashboardEntry; onClick: () => void }) {
  const badge = healthToStatusBadge(entry.health);
  const recentSessions = [...entry.sessions]
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
    .slice(0, 3);

  return (
    <Card
      className={cn(
        "group border-border/50 bg-card/60 transition hover:border-primary/40 hover:shadow-sm cursor-pointer",
        entry.health === "errored" && "border-red-500/30",
        entry.health === "active" && "border-green-500/30"
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-lg font-semibold text-primary">
              {(entry.name?.[0] ?? entry.id[0]).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold truncate">{entry.name}</h3>
                {entry.label && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {entry.label}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">{entry.id}</p>
            </div>
          </div>
          <StatusBadge status={badge.status} label={badge.label} size="sm" />
        </div>

        {entry.currentTask && (
          <div className="rounded-md border border-border/50 bg-muted/30 p-3">
            <p className="text-xs uppercase text-muted-foreground">Current activity</p>
            <p className="text-sm text-foreground mt-1 line-clamp-2">
              {entry.currentTask}
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Active sessions</p>
            <p className="font-semibold">{entry.activeSessions}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Total sessions</p>
            <p className="font-semibold">{entry.sessionCount}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Tokens</p>
            <p className="font-semibold">{formatTokenCount(entry.tokensUsed)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Cron jobs</p>
            <p className="font-semibold">{entry.cronJobs.length}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Last active</p>
            <p className="font-semibold">{formatRelativeTime(entry.lastActivityAt)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Health</p>
            <p className="font-semibold">{HEALTH_LABELS[entry.health]}</p>
          </div>
        </div>

        <div className="border-t border-border/60 pt-3">
          <p className="text-xs uppercase text-muted-foreground">Recent sessions</p>
          {recentSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground mt-2">No recent sessions</p>
          ) : (
            <div className="mt-2 space-y-2">
              {recentSessions.map((session) => {
                const isActive = session.lastMessageAt
                  ? Date.now() - session.lastMessageAt < 5 * 60 * 1000
                  : false;
                const label = session.derivedTitle || session.label || shortenSessionKey(session.key);
                return (
                  <div key={session.key} className="flex items-center gap-2 text-sm">
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        isActive ? "bg-green-500" : "bg-muted-foreground"
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{label}</p>
                      {session.lastMessageAt && (
                        <p className="text-xs text-muted-foreground">
                          {formatRelativeTime(session.lastMessageAt)}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AgentsDashboardPage() {
  const navigate = useNavigate();
  const {
    entries,
    summary,
    lastUpdated,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useAgentDashboardData();

  const sortedEntries = React.useMemo(() => {
    return [...entries].sort((a, b) => {
      const healthDiff = HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health];
      if (healthDiff !== 0) return healthDiff;
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
    });
  }, [entries]);

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agent Status Dashboard</h1>
          <p className="mt-1 text-muted-foreground">
            Real-time overview of agent health, sessions, and cron coverage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isFetching && !isLoading && (
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            >
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
            </motion.div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </motion.div>

      {error ? (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="p-6 text-center">
            <p className="text-destructive">Failed to load dashboard data</p>
            <p className="text-sm text-muted-foreground mt-1">
              Please check your gateway connection and try again.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => refetch()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[...Array(8)].map((_, index) => (
            <CardSkeleton key={index} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            label="Agents"
            value={summary.total}
            icon={Users}
            iconColor="text-primary"
            iconBg="bg-primary/10"
          />
          <SummaryCard
            label="Active"
            value={summary.active}
            icon={Zap}
            iconColor="text-green-500"
            iconBg="bg-green-500/10"
          />
          <SummaryCard
            label="Idle"
            value={summary.idle}
            icon={Pause}
            iconColor="text-gray-500"
            iconBg="bg-gray-500/10"
          />
          <SummaryCard
            label="Stalled"
            value={summary.stalled}
            icon={AlertTriangle}
            iconColor="text-yellow-500"
            iconBg="bg-yellow-500/10"
          />
          <SummaryCard
            label="Errored"
            value={summary.errored}
            icon={XCircle}
            iconColor="text-red-500"
            iconBg="bg-red-500/10"
          />
          <SummaryCard
            label="Sessions"
            value={summary.totalSessions}
            icon={MessageSquare}
            iconColor="text-blue-500"
            iconBg="bg-blue-500/10"
          />
          <SummaryCard
            label="Total Tokens"
            value={formatTokenCount(summary.totalTokens)}
            icon={Activity}
            iconColor="text-indigo-500"
            iconBg="bg-indigo-500/10"
          />
          <SummaryCard
            label="Cron Jobs"
            value={summary.totalCronJobs}
            icon={Calendar}
            iconColor="text-purple-500"
            iconBg="bg-purple-500/10"
          />
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : sortedEntries.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <Users className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-lg font-medium">No agents found</h3>
            <p className="mt-1 text-sm text-muted-foreground max-w-sm">
              Once agents start running, their health, sessions, and cron jobs will show here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
          className="grid gap-6 lg:grid-cols-2"
        >
          {sortedEntries.map((entry) => (
            <AgentCard
              key={entry.id}
              entry={entry}
              onClick={() =>
                navigate({
                  to: "/agents/$agentId",
                  params: { agentId: entry.id },
                  search: { tab: "overview" },
                })
              }
            />
          ))}
        </motion.div>
      )}

      {lastUpdated && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-xs text-muted-foreground text-center"
        >
          Last updated: {new Date(lastUpdated).toLocaleTimeString()}
          {isFetching && " · Refreshing..."}
        </motion.p>
      )}
    </div>
  );
}
