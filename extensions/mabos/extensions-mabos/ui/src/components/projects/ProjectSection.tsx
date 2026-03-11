import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { KanbanBoard } from "@/components/tasks/KanbanBoard";
import { Badge } from "@/components/ui/badge";
import type { Project, ProjectSLA, Task, KanbanColumnConfig } from "@/lib/types";

const slaConfig: Record<ProjectSLA, { label: string; color: string; bg: string }> = {
  critical: {
    label: "Critical SLA",
    color: "var(--accent-red)",
    bg: "color-mix(in srgb, var(--accent-red) 15%, transparent)",
  },
  standard: {
    label: "Standard SLA",
    color: "var(--accent-blue)",
    bg: "color-mix(in srgb, var(--accent-blue) 15%, transparent)",
  },
  relaxed: {
    label: "Relaxed SLA",
    color: "var(--accent-green)",
    bg: "color-mix(in srgb, var(--accent-green) 15%, transparent)",
  },
};

interface ProjectSectionProps {
  project: Project;
  tasks: Task[];
  defaultOpen?: boolean;
  onTaskClick: (task: Task) => void;
  columns?: KanbanColumnConfig[];
}

export function ProjectSection({
  project,
  tasks,
  defaultOpen = false,
  onTaskClick,
  columns,
}: ProjectSectionProps) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const sla = slaConfig[project.sla];
  const progressPercent =
    project.taskCount > 0 ? Math.round((project.completedCount / project.taskCount) * 100) : 0;

  return (
    <div className="rounded-lg border border-[var(--border-mabos)] overflow-hidden">
      {/* Project header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
          ) : (
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
          )}
          <span className="text-sm font-semibold text-[var(--text-primary)]">{project.name}</span>
          <Badge
            variant="outline"
            className="text-[10px] font-semibold uppercase tracking-wider border-current"
            style={{ color: sla.color }}
          >
            {sla.label}
          </Badge>
          <span className="text-xs text-[var(--text-muted)]">
            {project.completedCount}/{project.taskCount} tasks
          </span>
        </div>

        {/* Progress bar */}
        <div className="flex items-center gap-3">
          <div className="w-24 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${progressPercent}%`,
                backgroundColor: sla.color,
              }}
            />
          </div>
          <span className="text-xs text-[var(--text-muted)] w-8 text-right">
            {progressPercent}%
          </span>
        </div>
      </button>

      {/* Kanban board for this project */}
      {expanded && (
        <div className="p-4 bg-[var(--bg-primary)]">
          <KanbanBoard
            tasks={tasks}
            isLoading={false}
            onTaskClick={onTaskClick}
            columns={columns}
          />
        </div>
      )}
    </div>
  );
}
