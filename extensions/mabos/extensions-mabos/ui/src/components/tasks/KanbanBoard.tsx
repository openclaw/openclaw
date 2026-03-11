import { useMemo } from "react";
import { KanbanColumn, type ColumnStatus } from "@/components/tasks/KanbanColumn";
import { Skeleton } from "@/components/ui/skeleton";
import type { Task, KanbanColumnConfig } from "@/lib/types";

const DEFAULT_COLUMN_ORDER: ColumnStatus[] = ["backlog", "todo", "in_progress", "review", "done"];

interface KanbanBoardProps {
  tasks: Task[];
  isLoading: boolean;
  onTaskClick: (task: Task) => void;
  columns?: KanbanColumnConfig[];
}

function ColumnSkeleton() {
  return (
    <div className="flex flex-col min-w-[280px] max-w-[320px] w-full shrink-0">
      <div className="flex items-center gap-2 mb-3 px-1">
        <Skeleton className="w-2 h-2 rounded-full" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-5 w-5 rounded-full" />
      </div>
      <div className="rounded-lg bg-[var(--bg-secondary)]/50 border border-[var(--border-mabos)] p-2 space-y-2 min-h-[200px]">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-[var(--border-mabos)] bg-[var(--bg-card)] p-3 space-y-2"
          >
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-3 w-2/3" />
            <div className="flex items-center justify-between pt-1">
              <div className="flex -space-x-1.5">
                <Skeleton className="w-6 h-6 rounded-full" />
                <Skeleton className="w-6 h-6 rounded-full" />
              </div>
              <Skeleton className="h-3 w-12" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function KanbanBoard({ tasks, isLoading, onTaskClick, columns }: KanbanBoardProps) {
  // Group tasks by configurable columns or by default status columns
  const columnData = useMemo(() => {
    if (columns) {
      // Group by perspective columns
      return columns.map((col) => ({
        config: col,
        tasks: tasks.filter((task) => col.statuses.includes(task.status)),
      }));
    }

    // Default: group by status
    const map: Record<ColumnStatus, Task[]> = {
      backlog: [],
      todo: [],
      in_progress: [],
      review: [],
      done: [],
    };
    for (const task of tasks) {
      if (map[task.status]) {
        map[task.status].push(task);
      }
    }
    return DEFAULT_COLUMN_ORDER.map((status) => ({
      status,
      tasks: map[status],
    }));
  }, [tasks, columns]);

  if (isLoading) {
    const skeletonCount = columns?.length || DEFAULT_COLUMN_ORDER.length;
    return (
      <div className="flex gap-4 overflow-x-auto pb-4">
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <ColumnSkeleton key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columnData.map((col) => {
        if ("config" in col) {
          return (
            <KanbanColumn
              key={col.config.id}
              tasks={col.tasks}
              onTaskClick={onTaskClick}
              columnConfig={col.config}
            />
          );
        }
        return (
          <KanbanColumn
            key={col.status}
            status={col.status}
            tasks={col.tasks}
            onTaskClick={onTaskClick}
          />
        );
      })}
    </div>
  );
}
