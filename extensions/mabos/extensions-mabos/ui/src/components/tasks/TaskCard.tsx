import { Badge } from "@/components/ui/badge";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";
import type { Task } from "@/lib/types";

const priorityConfig = {
  high: {
    color: "var(--accent-red)",
    label: "High",
  },
  medium: {
    color: "var(--accent-orange)",
    label: "Medium",
  },
  low: {
    color: "var(--accent-blue)",
    label: "Low",
  },
} as const;

interface TaskCardProps {
  task: Task;
  onClick: (task: Task) => void;
}

export function TaskCard({ task, onClick }: TaskCardProps) {
  const priority = priorityConfig[task.priority];

  return (
    <button
      type="button"
      onClick={() => onClick(task)}
      className="w-full text-left rounded-lg border border-[var(--border-mabos)] bg-[var(--bg-card)] p-3 transition-colors hover:border-[var(--border-hover)] hover:bg-[var(--bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-purple)]/50"
    >
      {/* Priority badge */}
      <Badge
        variant="outline"
        className="mb-2 text-[10px] font-semibold uppercase tracking-wider border-current"
        style={{ color: priority.color }}
      >
        {priority.label}
      </Badge>

      {/* Title */}
      <p className="text-sm font-medium text-[var(--text-primary)] leading-snug mb-3">
        {task.title}
      </p>

      {/* Footer: agents + department */}
      <div className="flex items-center justify-between">
        {/* Assigned agent icons */}
        <div className="flex -space-x-1.5">
          {task.assignedAgents.slice(0, 4).map((agentId) => {
            const Icon = getAgentIcon(agentId);
            const name = getAgentName(agentId);
            return (
              <div
                key={agentId}
                title={name}
                className="flex items-center justify-center w-6 h-6 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-mabos)]"
              >
                <Icon className="w-3 h-3 text-[var(--text-secondary)]" />
              </div>
            );
          })}
          {task.assignedAgents.length > 4 && (
            <div className="flex items-center justify-center w-6 h-6 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-mabos)]">
              <span className="text-[10px] text-[var(--text-muted)]">
                +{task.assignedAgents.length - 4}
              </span>
            </div>
          )}
        </div>

        {/* Department tag */}
        <span className="text-[10px] text-[var(--text-muted)] font-medium uppercase tracking-wide">
          {task.department}
        </span>
      </div>
    </button>
  );
}
