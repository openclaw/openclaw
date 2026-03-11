import { useState, useMemo } from "react";
import { AlertCircle, ClipboardList } from "lucide-react";
import { useTasks } from "@/hooks/useTasks";
import { KanbanBoard } from "@/components/tasks/KanbanBoard";
import { TaskDetail } from "@/components/tasks/TaskDetail";
import type { Task } from "@/lib/types";

const BUSINESS_ID = "vividwalls";

const statusLabels: Record<Task["status"], string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

const statusColors: Record<Task["status"], string> = {
  backlog: "var(--text-muted)",
  todo: "var(--accent-blue)",
  in_progress: "var(--accent-orange)",
  review: "var(--accent-purple)",
  done: "var(--accent-green)",
};

export function TasksPage() {
  const { data: tasksRaw, isLoading, error } = useTasks(BUSINESS_ID);
  const tasks = (tasksRaw as Task[] | undefined) ?? [];

  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // Count per status
  const statusCounts = useMemo(() => {
    const counts: Record<Task["status"], number> = {
      backlog: 0,
      todo: 0,
      in_progress: 0,
      review: 0,
      done: 0,
    };
    for (const task of tasks) {
      if (counts[task.status] !== undefined) {
        counts[task.status]++;
      }
    }
    return counts;
  }, [tasks]);

  function handleTaskClick(task: Task) {
    setSelectedTask(task);
    setDetailOpen(true);
  }

  function handleDetailOpenChange(open: boolean) {
    setDetailOpen(open);
    if (!open) {
      // Delay clearing selection so the close animation can play
      setTimeout(() => setSelectedTask(null), 300);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-lg"
          style={{
            backgroundColor: `color-mix(in srgb, var(--accent-orange) 15%, transparent)`,
          }}
        >
          <ClipboardList className="w-5 h-5 text-[var(--accent-orange)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">
            Task Management
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">
            {isLoading
              ? "Loading tasks..."
              : `${tasks.length} tasks across all departments`}
          </p>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-[color-mix(in_srgb,var(--accent-red)_10%,var(--bg-card))] border border-[var(--accent-red)]/20">
          <AlertCircle className="w-5 h-5 text-[var(--accent-red)] shrink-0" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Failed to load tasks
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Unable to fetch task data from the API. Please try again later.
            </p>
          </div>
        </div>
      )}

      {/* Status summary row */}
      {!isLoading && tasks.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          {(Object.keys(statusLabels) as Task["status"][]).map((status) => (
            <div
              key={status}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)]"
            >
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: statusColors[status] }}
              />
              <span className="text-xs text-[var(--text-secondary)]">
                {statusLabels[status]}
              </span>
              <span
                className="text-xs font-semibold"
                style={{ color: statusColors[status] }}
              >
                {statusCounts[status]}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Kanban Board */}
      <KanbanBoard
        tasks={tasks}
        isLoading={isLoading}
        onTaskClick={handleTaskClick}
      />

      {/* Task Detail Sheet */}
      <TaskDetail
        task={selectedTask}
        open={detailOpen}
        onOpenChange={handleDetailOpenChange}
      />
    </div>
  );
}
