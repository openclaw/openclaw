import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function readReplayedTaskId(
  message: Record<string, unknown>,
  submittedInputUuids: ReadonlySet<string>,
): string | undefined {
  if (
    message.type !== "user" ||
    message.isReplay !== true ||
    message.parent_tool_use_id !== null ||
    (typeof message.uuid === "string" && submittedInputUuids.has(message.uuid)) ||
    !isRecord(message.message)
  ) {
    return undefined;
  }
  // Before Claude Code 2.1.274, inline notification receipts omitted origin.
  if (
    message.origin !== undefined &&
    (!isRecord(message.origin) ||
      message.origin.kind !== "task-notification" ||
      message.origin.subkind !== undefined)
  ) {
    return undefined;
  }
  const content = message.message.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  const text =
    typeof content === "string"
      ? content
      : isRecord(first) && first.type === "text" && typeof first.text === "string"
        ? first.text
        : "";
  return /^<task-notification>\s*<task-id>([^<]+)<\/task-id>/u.exec(text)?.[1];
}

export function recordTaskOwnership(
  session: { taskOwners: Map<string, string | false>; taskRuns: Map<string, string> },
  task: Record<string, unknown>,
  inputUuid: string,
): string | undefined {
  const taskId = task.task_id;
  if (typeof taskId !== "string" || !taskId) {
    return undefined;
  }
  const previous = session.taskOwners.get(taskId);
  // Native marks subagent Bash explicitly. Nested Agents and workflows can
  // forward their completion to the parent input after their launcher ends.
  const owner = task.owned_by_subagent === true ? false : (previous ?? inputUuid);
  if (owner !== previous) {
    session.taskOwners.set(taskId, owner);
  }
  if (typeof task.run_id === "string" && task.run_id) {
    session.taskRuns.set(task.run_id, taskId);
  }
  return owner === false ? undefined : taskId;
}

/** Agents and workflows make their own tool calls; subagent-owned work can resume its Agent. */
function isDescendantTask(task: Record<string, unknown>): boolean {
  return (
    task.task_type === "local_agent" ||
    task.task_type === "local_workflow" ||
    task.owned_by_subagent === true ||
    typeof task.parent_task_id === "string"
  );
}

export function recordRunningDescendants(
  running: Map<string, string | undefined>,
  message: Record<string, unknown>,
): boolean {
  const startedTasks =
    message.subtype === "task_started"
      ? [message]
      : message.subtype === "background_tasks_changed" && Array.isArray(message.tasks)
        ? message.tasks.filter(isRecord)
        : [];
  for (const task of startedTasks) {
    if (typeof task.task_id === "string" && isDescendantTask(task)) {
      running.set(
        task.task_id,
        typeof task.parent_task_id === "string" ? task.parent_task_id : running.get(task.task_id),
      );
    }
  }
  if (message.subtype === "task_notification" && typeof message.task_id === "string") {
    const parentTaskId = running.get(message.task_id);
    running.delete(message.task_id);
    return parentTaskId !== undefined && running.has(parentTaskId);
  }
  return false;
}
