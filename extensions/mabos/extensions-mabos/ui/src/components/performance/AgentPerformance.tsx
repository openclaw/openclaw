import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";

type AgentEfficiencyEntry = {
  agentId: string;
  tasksCompleted: number;
  avgDuration: number;
};

type AgentPerformanceProps = {
  agentMetrics: AgentEfficiencyEntry[] | undefined;
  isLoading: boolean;
};

const defaultMetrics: AgentEfficiencyEntry[] = [
  { agentId: "coo", tasksCompleted: 51, avgDuration: 2.1 },
  { agentId: "cto", tasksCompleted: 46, avgDuration: 3.5 },
  { agentId: "ceo", tasksCompleted: 42, avgDuration: 3.2 },
  { agentId: "cfo", tasksCompleted: 38, avgDuration: 4.1 },
  { agentId: "cmo", tasksCompleted: 35, avgDuration: 2.8 },
  { agentId: "hr", tasksCompleted: 28, avgDuration: 4.5 },
  { agentId: "strategy", tasksCompleted: 24, avgDuration: 5.2 },
  { agentId: "legal", tasksCompleted: 18, avgDuration: 6.0 },
];

function getEfficiencyLabel(avgDuration: number): {
  label: string;
  color: string;
} {
  if (avgDuration <= 2.5)
    return { label: "Excellent", color: "var(--accent-green)" };
  if (avgDuration <= 4.0)
    return { label: "Good", color: "var(--accent-blue)" };
  if (avgDuration <= 5.5)
    return { label: "Average", color: "var(--accent-orange)" };
  return { label: "Slow", color: "var(--accent-red)" };
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="w-8 h-8 rounded-lg bg-[var(--bg-secondary)]" />
          <Skeleton className="h-4 flex-1 bg-[var(--bg-secondary)]" />
          <Skeleton className="h-4 w-16 bg-[var(--bg-secondary)]" />
          <Skeleton className="h-5 w-20 rounded-full bg-[var(--bg-secondary)]" />
        </div>
      ))}
    </div>
  );
}

export function AgentPerformance({
  agentMetrics,
  isLoading,
}: AgentPerformanceProps) {
  const metrics = useMemo(() => {
    const data = agentMetrics ?? defaultMetrics;
    return [...data].sort((a, b) => b.tasksCompleted - a.tasksCompleted);
  }, [agentMetrics]);

  // Find max tasks for relative bar widths
  const maxTasks = useMemo(
    () => Math.max(...metrics.map((m) => m.tasksCompleted), 1),
    [metrics]
  );

  return (
    <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
      <CardHeader>
        <CardTitle className="text-base font-semibold text-[var(--text-primary)]">
          Agent Performance
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingSkeleton />
        ) : (
          <div className="space-y-1">
            {/* Table header */}
            <div className="flex items-center gap-4 px-2 py-2 text-xs font-medium text-[var(--text-muted)]">
              <div className="w-8" />
              <div className="flex-1">Agent</div>
              <div className="w-28 text-right">Tasks Completed</div>
              <div className="w-24 text-right">Avg Duration</div>
              <div className="w-24 text-center">Efficiency</div>
            </div>
            <Separator className="bg-[var(--border-mabos)]" />

            {metrics.map((entry, index) => {
              const Icon = getAgentIcon(entry.agentId);
              const name = getAgentName(entry.agentId);
              const { label, color } = getEfficiencyLabel(entry.avgDuration);
              const barWidth = (entry.tasksCompleted / maxTasks) * 100;

              return (
                <div key={entry.agentId}>
                  <div className="flex items-center gap-4 px-2 py-3 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors">
                    {/* Agent Icon */}
                    <div
                      className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
                      style={{
                        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
                      }}
                    >
                      <Icon className="w-4 h-4" style={{ color }} />
                    </div>

                    {/* Name + relative bar */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {name}
                      </p>
                      <div className="mt-1 h-1.5 rounded-full bg-[var(--bg-secondary)] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${barWidth}%`,
                            backgroundColor: color,
                            opacity: 0.6,
                          }}
                        />
                      </div>
                    </div>

                    {/* Tasks completed */}
                    <div className="w-28 text-right">
                      <span className="text-sm font-semibold text-[var(--text-primary)]">
                        {entry.tasksCompleted}
                      </span>
                    </div>

                    {/* Avg duration */}
                    <div className="w-24 text-right">
                      <span className="text-sm text-[var(--text-secondary)]">
                        {entry.avgDuration.toFixed(1)}s
                      </span>
                    </div>

                    {/* Efficiency badge */}
                    <div className="w-24 flex justify-center">
                      <Badge
                        variant="outline"
                        className="text-xs border-0"
                        style={{
                          backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
                          color,
                        }}
                      >
                        {label}
                      </Badge>
                    </div>
                  </div>
                  {index < metrics.length - 1 && (
                    <Separator className="bg-[var(--border-mabos)] opacity-50" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
