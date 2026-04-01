import { Users } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";
import type { AgentListItem } from "@/lib/types";

type AgentActivityDiagramProps = {
  agents: AgentListItem[] | undefined;
  isLoading: boolean;
};

const statusConfig: Record<string, { color: string; label: string }> = {
  active: { color: "bg-[var(--accent-green)]", label: "Active" },
  idle: { color: "bg-[var(--accent-orange)]", label: "Idle" },
  error: { color: "bg-[var(--accent-red)]", label: "Error" },
  paused: { color: "bg-[var(--text-muted)]", label: "Paused" },
};

export function AgentActivityDiagram({ agents, isLoading }: AgentActivityDiagramProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-[var(--border-mabos)] bg-[var(--bg-card)] p-3"
          >
            <Skeleton className="h-4 w-20 mb-3" />
            <Skeleton className="h-32 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (!agents || agents.length === 0) {
    return (
      <div className="text-center py-12">
        <Users className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
        <p className="text-sm font-medium text-[var(--text-secondary)] mb-1">No agents yet</p>
        <p className="text-xs text-[var(--text-muted)]">Create your first agent to see activity</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
        {Object.entries(statusConfig).map(([key, { color, label }]) => (
          <div key={key} className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${color}`} />
            <span>{label}</span>
          </div>
        ))}
      </div>

      {/* Swimlane grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
        {agents.map((agent) => {
          const Icon = getAgentIcon(agent.id);
          const displayName = getAgentName(agent.id);
          const { color } = statusConfig[agent.status] || statusConfig.idle;

          return (
            <div
              key={agent.id}
              className="rounded-lg border border-[var(--border-mabos)] bg-[var(--bg-card)] overflow-hidden"
            >
              {/* Swimlane header */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-mabos)] bg-[var(--bg-tertiary)]">
                <Icon className="w-3.5 h-3.5 text-[var(--accent-purple)]" />
                <span className="text-[11px] font-semibold text-[var(--text-primary)] truncate">
                  {displayName}
                </span>
              </div>

              {/* Swimlane body */}
              <div className="p-3 space-y-2 min-h-[120px]">
                {/* Status indicator */}
                <div className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${color}`} />
                  <span className="text-[10px] text-[var(--text-muted)] capitalize">
                    {agent.status}
                  </span>
                </div>

                {/* BDI summary */}
                <div className="space-y-1 text-[10px] text-[var(--text-secondary)]">
                  <div className="flex justify-between">
                    <span>Beliefs</span>
                    <span className="font-medium text-[var(--text-primary)]">{agent.beliefs}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Goals</span>
                    <span className="font-medium text-[var(--text-primary)]">{agent.goals}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Intentions</span>
                    <span className="font-medium text-[var(--text-primary)]">
                      {agent.intentions}
                    </span>
                  </div>
                </div>

                {/* Activity bar (visual representation of activity level) */}
                <div className="mt-2">
                  <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                    <div
                      className={`h-full rounded-full ${color} transition-all`}
                      style={{
                        width: `${Math.min(100, ((agent.beliefs + agent.goals + agent.intentions) / 30) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
