export type TaskStatus = "inbox" | "assigned" | "in_progress" | "review" | "done";

export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ["assigned"],
  assigned: ["inbox", "in_progress"],
  in_progress: ["assigned", "review"],
  review: ["in_progress", "done"],
  done: ["review"],
};

export function humanizeTaskStatus(status: TaskStatus): string {
  return status.replace("_", " ");
}

export function validateTaskStatusTransition(params: {
  current: TaskStatus;
  next: TaskStatus;
  assignedAgentId: string | null;
}): { ok: boolean; reason?: string } {
  const { current, next, assignedAgentId } = params;
  if (current === next) {
    return { ok: true };
  }

  if (!TASK_STATUS_TRANSITIONS[current].includes(next)) {
    return {
      ok: false,
      reason: `Cannot move from ${humanizeTaskStatus(current)} to ${humanizeTaskStatus(next)}.`,
    };
  }

  if (next !== "inbox" && !assignedAgentId) {
    return {
      ok: false,
      reason: "Assign an agent before moving this task out of Inbox.",
    };
  }

  return { ok: true };
}
