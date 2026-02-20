import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";
import { api } from "@/lib/api";
import type { Task } from "@/lib/types";

const BUSINESS_ID = "vividwalls";

const statusOrder: Task["status"][] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
];

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

const priorityColors: Record<Task["priority"], string> = {
  high: "var(--accent-red)",
  medium: "var(--accent-orange)",
  low: "var(--accent-blue)",
};

interface TaskDetailProps {
  task: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TaskDetail({ task, open, onOpenChange }: TaskDetailProps) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (newStatus: Task["status"]) =>
      api.updateTask(BUSINESS_ID, task!.id, { status: newStatus }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", BUSINESS_ID] });
    },
  });

  if (!task) return null;

  const currentIndex = statusOrder.indexOf(task.status);
  const nextStatus =
    currentIndex < statusOrder.length - 1
      ? statusOrder[currentIndex + 1]
      : null;
  const prevStatus = currentIndex > 0 ? statusOrder[currentIndex - 1] : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md bg-[var(--bg-primary)] border-l border-[var(--border-mabos)] overflow-y-auto"
      >
        <SheetHeader className="pb-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge
              variant="outline"
              className="text-[10px] font-semibold uppercase tracking-wider border-current"
              style={{ color: priorityColors[task.priority] }}
            >
              {task.priority}
            </Badge>
            <Badge
              variant="outline"
              className="text-[10px] font-semibold uppercase tracking-wider border-current"
              style={{ color: statusColors[task.status] }}
            >
              {statusLabels[task.status]}
            </Badge>
          </div>
          <SheetTitle className="text-lg text-[var(--text-primary)]">
            {task.title}
          </SheetTitle>
          <SheetDescription className="text-[var(--text-secondary)]">
            {task.department} department
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 space-y-6 pb-6">
          {/* Description */}
          {task.description && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                Description
              </h4>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                {task.description}
              </p>
            </div>
          )}

          <Separator className="bg-[var(--border-mabos)]" />

          {/* Status flow */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
              Status
            </h4>
            <div className="flex items-center gap-1 flex-wrap">
              {statusOrder.map((s, i) => (
                <div key={s} className="flex items-center gap-1">
                  <div
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium"
                    style={{
                      backgroundColor:
                        s === task.status
                          ? `color-mix(in srgb, ${statusColors[s]} 20%, transparent)`
                          : "transparent",
                      color:
                        s === task.status
                          ? statusColors[s]
                          : "var(--text-muted)",
                      border:
                        s === task.status
                          ? `1px solid color-mix(in srgb, ${statusColors[s]} 30%, transparent)`
                          : "1px solid transparent",
                    }}
                  >
                    {statusLabels[s]}
                  </div>
                  {i < statusOrder.length - 1 && (
                    <ArrowRight className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                  )}
                </div>
              ))}
            </div>
          </div>

          <Separator className="bg-[var(--border-mabos)]" />

          {/* Assigned agents */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
              Assigned Agents
            </h4>
            <div className="flex flex-col gap-2">
              {task.assignedAgents.length > 0 ? (
                task.assignedAgents.map((agentId) => {
                  const Icon = getAgentIcon(agentId);
                  const name = getAgentName(agentId);
                  return (
                    <div
                      key={agentId}
                      className="flex items-center gap-2.5 p-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)]"
                    >
                      <div className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--bg-tertiary)]">
                        <Icon className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                      </div>
                      <span className="text-sm text-[var(--text-primary)]">
                        {name}
                      </span>
                    </div>
                  );
                })
              ) : (
                <p className="text-xs text-[var(--text-muted)]">
                  No agents assigned
                </p>
              )}
            </div>
          </div>

          <Separator className="bg-[var(--border-mabos)]" />

          {/* Department */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
              Department
            </h4>
            <Badge
              variant="outline"
              className="text-xs border-[var(--border-mabos)] text-[var(--text-secondary)]"
            >
              {task.department}
            </Badge>
          </div>

          <Separator className="bg-[var(--border-mabos)]" />

          {/* Actions */}
          <div className="flex flex-col gap-2">
            {nextStatus && (
              <Button
                onClick={() => mutation.mutate(nextStatus)}
                disabled={mutation.isPending}
                className="w-full"
                style={{
                  backgroundColor: statusColors[nextStatus],
                  color: "#000",
                }}
              >
                {mutation.isPending
                  ? "Updating..."
                  : `Move to ${statusLabels[nextStatus]}`}
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {prevStatus && (
              <Button
                variant="outline"
                onClick={() => mutation.mutate(prevStatus)}
                disabled={mutation.isPending}
                className="w-full border-[var(--border-mabos)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                Move back to {statusLabels[prevStatus]}
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
