import { ScrollArea } from "@/components/ui/scroll-area";
import { TaskCard } from "@/components/tasks/TaskCard";
import type { Task } from "@/lib/types";

export type ColumnStatus = Task["status"];

const columnConfig: Record<
  ColumnStatus,
  { title: string; color: string }
> = {
  backlog: { title: "Backlog", color: "var(--text-muted)" },
  todo: { title: "To Do", color: "var(--accent-blue)" },
  in_progress: { title: "In Progress", color: "var(--accent-orange)" },
  review: { title: "Review", color: "var(--accent-purple)" },
  done: { title: "Done", color: "var(--accent-green)" },
};

interface KanbanColumnProps {
  status: ColumnStatus;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

export function KanbanColumn({ status, tasks, onTaskClick }: KanbanColumnProps) {
  const config = columnConfig[status];

  return (
    <div className="flex flex-col min-w-[280px] max-w-[320px] w-full shrink-0">
      {/* Column header */}
      <div className="flex items-center gap-2 mb-3 px-1">
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: config.color }}
        />
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          {config.title}
        </h3>
        <span
          className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-medium"
          style={{
            backgroundColor: `color-mix(in srgb, ${config.color} 15%, transparent)`,
            color: config.color,
          }}
        >
          {tasks.length}
        </span>
      </div>

      {/* Card list */}
      <ScrollArea className="flex-1 rounded-lg bg-[var(--bg-secondary)]/50 border border-[var(--border-mabos)] p-2 min-h-[200px] max-h-[calc(100vh-280px)]">
        {tasks.length > 0 ? (
          <div className="flex flex-col gap-2">
            {tasks.map((task) => (
              <TaskCard key={task.id} task={task} onClick={onTaskClick} />
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center h-24">
            <p className="text-xs text-[var(--text-muted)]">
              No tasks
            </p>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
