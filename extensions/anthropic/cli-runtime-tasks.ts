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
  const owner =
    task.owned_by_subagent === true
      ? false
      : (previous ??
        (typeof task.parent_task_id === "string"
          ? session.taskOwners.get(task.parent_task_id)
          : undefined) ??
        inputUuid);
  if (owner !== previous) {
    session.taskOwners.set(taskId, owner);
  }
  if (typeof task.run_id === "string" && task.run_id) {
    session.taskRuns.set(task.run_id, taskId);
  }
  return owner === false ? undefined : taskId;
}
