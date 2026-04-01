import { Users, ClipboardList, Activity, Cpu } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { SystemStatus, Task } from "@/lib/types";

type StatusCardsProps = {
  status: SystemStatus | undefined;
  tasks: Task[] | undefined;
  isLoading: boolean;
};

// Agents come as an array from the API. Derive summary stats.
function getAgentSummary(status: SystemStatus) {
  const agents = status.agents ?? [];
  return { total: agents.length, active: agents.length, idle: 0, error: 0 };
}

const statusCards = [
  {
    key: "total-agents",
    label: "Total Agents",
    icon: Users,
    color: "var(--accent-blue)",
    getValue: (s: SystemStatus) => getAgentSummary(s).total,
    getSubtitle: (s: SystemStatus) => `${getAgentSummary(s).active} active`,
  },
  {
    key: "active-tasks",
    label: "Active Tasks",
    icon: ClipboardList,
    color: "var(--accent-purple)",
    getValue: (_s: SystemStatus, tasks?: Task[]) =>
      tasks?.filter((t) => t.status === "in_progress").length ?? 0,
    getSubtitle: (_s: SystemStatus, tasks?: Task[]) => {
      const total = tasks?.length ?? 0;
      return `${total} total tasks`;
    },
  },
  {
    key: "health-score",
    label: "Health Score",
    icon: Activity,
    color: "var(--accent-green)",
    getValue: (s: SystemStatus) => {
      const summary = getAgentSummary(s);
      const total = summary.total || 1;
      const healthy = summary.active + summary.idle;
      return `${Math.round((healthy / total) * 100)}%`;
    },
    getSubtitle: (s: SystemStatus) => {
      const summary = getAgentSummary(s);
      return summary.error > 0
        ? `${summary.error} agent${summary.error > 1 ? "s" : ""} with errors`
        : "All systems nominal";
    },
  },
  {
    key: "bdi-cycles",
    label: "BDI Cycles",
    icon: Cpu,
    color: "var(--accent-orange)",
    getValue: (s: SystemStatus) => {
      const cycles = s.agents?.length ?? 0;
      return cycles.toLocaleString();
    },
    getSubtitle: () => "Belief-Desire-Intention",
  },
] as const;

export function StatusCards({ status, tasks, isLoading }: StatusCardsProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-4">
            <CardContent className="flex items-center gap-4">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-12" />
                <Skeleton className="h-3 w-24" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!status) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {statusCards.map((card) => {
        const Icon = card.icon;
        return (
          <Card
            key={card.key}
            className="bg-[var(--bg-card)] border-[var(--border-mabos)] hover:border-[var(--border-hover)] transition-colors py-4"
          >
            <CardContent className="flex items-center gap-4">
              <div
                className="flex items-center justify-center w-10 h-10 rounded-lg"
                style={{ backgroundColor: `color-mix(in srgb, ${card.color} 15%, transparent)` }}
              >
                <Icon className="w-5 h-5" style={{ color: card.color }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                  {card.label}
                </p>
                <p className="text-2xl font-bold text-[var(--text-primary)] mt-0.5">
                  {card.getValue(status, tasks as Task[] | undefined)}
                </p>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5 truncate">
                  {card.getSubtitle(status, tasks as Task[] | undefined)}
                </p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
