"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, MoreHorizontal, CheckCircle2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TaskCard } from "./task-card";
import { EmptyColumn } from "@/components/empty-states";
import { getStatusColor } from "@/lib/shared";
import type { Task } from "@/lib/hooks/use-tasks";
import {
  validateTaskStatusTransition,
  type TaskStatus,
} from "@/lib/task-workflow";

// --- Types ---

export type ColumnId = TaskStatus;

export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "assigned", label: "Assigned" },
  { id: "in_progress", label: "In Progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

// --- Helpers ---

function getColumnDotColor(id: ColumnId): string {
  return getStatusColor(id);
}

/** Per-column accent colors for top border + heading text. */
const COLUMN_ACCENT: Record<ColumnId, { border: string; text: string }> = {
  inbox: { border: "border-t-slate-400 dark:border-t-slate-500", text: "" },
  assigned: { border: "border-t-blue-500 dark:border-t-blue-400", text: "text-blue-600 dark:text-blue-400" },
  in_progress: { border: "border-t-primary", text: "text-primary" },
  review: { border: "border-t-amber-500 dark:border-t-amber-400", text: "text-amber-600 dark:text-amber-400" },
  done: { border: "border-t-emerald-500 dark:border-t-emerald-400", text: "text-emerald-600 dark:text-emerald-400" },
};

// --- Board Props ---

interface KanbanBoardProps {
  getColumnTasks: (status: string) => Task[];
  onDeleteTask: (id: string) => void;
  onDispatchTask: (task: Task) => void;
  onViewTask: (task: Task) => void;
  onMoveTask: (taskId: string, newStatus: string) => Promise<boolean> | boolean;
  onCreateTask: () => void;
}

function canMoveTask(task: Task, nextStatus: ColumnId): { ok: boolean; reason?: string } {
  const current = task.status as TaskStatus;
  if (!["inbox", "assigned", "in_progress", "review", "done"].includes(current)) {
    return { ok: false, reason: "Task has an invalid status and cannot be moved." };
  }

  return validateTaskStatusTransition({
    current,
    next: nextStatus,
    assignedAgentId: task.assigned_agent_id,
  });
}

export function KanbanBoard({
  getColumnTasks,
  onDeleteTask,
  onDispatchTask,
  onViewTask,
  onMoveTask,
  onCreateTask,
}: KanbanBoardProps) {
  const [dragOverColumn, setDragOverColumn] = useState<ColumnId | null>(null);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [moveFeedback, setMoveFeedback] = useState<string | null>(null);
  const feedbackTimeoutRef = useRef<number | null>(null);

  const setTransientMoveFeedback = (message: string) => {
    setMoveFeedback(message);
    if (feedbackTimeoutRef.current) {
      window.clearTimeout(feedbackTimeoutRef.current);
    }
    feedbackTimeoutRef.current = window.setTimeout(() => setMoveFeedback(null), 2600);
  };

  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) {
        window.clearTimeout(feedbackTimeoutRef.current);
      }
    };
  }, []);

  const attemptMoveTask = async (task: Task, nextStatus: ColumnId) => {
    const guard = canMoveTask(task, nextStatus);
    if (!guard.ok) {
      if (guard.reason) setTransientMoveFeedback(guard.reason);
      return false;
    }

    const moved = await Promise.resolve(onMoveTask(task.id, nextStatus));
    if (!moved) {
      setTransientMoveFeedback("Task move failed. Please try again.");
      return false;
    }

    return true;
  };

  // --- Drag and Drop ---
  const handleDragStart = (task: Task) => setDraggedTask(task);
  const handleDragOver = (e: React.DragEvent, columnId: ColumnId) => {
    e.preventDefault();
    if (dragOverColumn !== columnId) {
      setDragOverColumn(columnId);
    }
  };
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    const relatedTarget = e.relatedTarget as Node | null;
    if (relatedTarget && e.currentTarget.contains(relatedTarget)) return;
    setDragOverColumn(null);
  };
  const handleDrop = async (e: React.DragEvent, columnId: ColumnId) => {
    e.preventDefault();
    setDragOverColumn(null);
    if (draggedTask && draggedTask.status !== columnId) {
      await attemptMoveTask(draggedTask, columnId);
    }
    setDraggedTask(null);
  };

  return (
    <div className="flex-1 overflow-x-auto overflow-y-auto p-6">
      {moveFeedback && (
        <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500" role="alert" aria-live="assertive">
          {moveFeedback}
        </div>
      )}
      <div className="flex min-h-full gap-4">
        {COLUMNS.map((col) => {
          const colTasks = getColumnTasks(col.id);
          const isActive = col.id === "in_progress";
          const isDragOver = dragOverColumn === col.id;
          const accent = COLUMN_ACCENT[col.id];

          return (
            <div
              key={col.id}
              role="group"
              aria-label={`${col.label} column, ${colTasks.length} ${colTasks.length === 1 ? "task" : "tasks"}`}
              className={`flex-1 flex flex-col min-w-[280px] rounded-lg border border-t-2 ${accent.border} border-x-border border-b-border ${isDragOver ? "ring-2 ring-primary/30" : ""} ${isActive ? "column-glow" : ""} bg-muted/30 backdrop-blur-sm`}
            >
              {/* Column Header */}
              <div className="p-3 border-b border-border/50 flex justify-between items-center relative z-10">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${getColumnDotColor(col.id)}`} />
                  <h3 className={`font-bold text-sm tracking-wide ${accent.text}`}>
                    {col.label}
                  </h3>
                  <span className={`text-[10px] px-1.5 rounded font-mono border ${isActive
                    ? "bg-primary/20 text-primary border-primary/20"
                    : "bg-muted text-muted-foreground border-border"
                    }`}>
                    {colTasks.length}
                  </span>
                </div>
                {col.id === "inbox" ? (
                  <button
                    onClick={onCreateTask}
                    className="text-muted-foreground hover:text-primary transition-colors"
                    aria-label="Create new task"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                ) : col.id === "done" ? (
                  <CheckCircle2 className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
                )}
              </div>

              {/* Column Body */}
              <ScrollArea className="flex-1">
                <div
                  className="p-3 flex flex-col gap-3 min-h-[120px] relative z-10"
                  onDragOver={(e) => handleDragOver(e, col.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, col.id)}
                >
                  {colTasks.length === 0 ? (
                    <EmptyColumn columnName={col.label} columnId={col.id} />
                  ) : (
                    colTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        isInProgress={isActive}
                        onDragStart={() => handleDragStart(task)}
                        onDragEnd={() => setDraggedTask(null)}
                        onDelete={() => onDeleteTask(task.id)}
                        onDispatch={() => onDispatchTask(task)}
                        onClick={() => onViewTask(task)}
                        onMoveToDone={
                          col.id === "review"
                            ? () => {
                              void attemptMoveTask(task, "done");
                            }
                            : undefined
                        }
                      />
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>
          );
        })}
      </div>
    </div>
  );
}
