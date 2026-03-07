/**
 * 钉钉项目管理 Agent Tool Schema
 *
 * 遵循 tool schema guardrails：使用 stringEnum 代替 Type.Union
 */

import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, optionalStringEnum } from "openclaw/plugin-sdk/dingtalk";

const PROJECT_ACTIONS = [
  "list_spaces",
  "list_tasks",
  "get_task",
  "create_task",
  "update_task",
] as const;

const TASK_PRIORITIES = ["0", "1", "2", "3"] as const;

export const DingtalkProjectSchema = Type.Object({
  action: stringEnum(PROJECT_ACTIONS, {
    description:
      "Action to perform: list_spaces (list project spaces), list_tasks (tasks in a project), get_task (task details), create_task (new task), update_task (modify task)",
  }),
  user_id: Type.Optional(
    Type.String({
      description:
        "Operator's DingTalk userId. Optional if operatorUserId is configured in dingtalk config.",
    }),
  ),
  space_id: Type.Optional(
    Type.String({
      description: "Project space ID (required for list_tasks, create_task)",
    }),
  ),
  task_id: Type.Optional(
    Type.String({
      description: "Task ID (required for get_task, update_task)",
    }),
  ),
  subject: Type.Optional(
    Type.String({ description: "Task title/subject (required for create_task)" }),
  ),
  description: Type.Optional(Type.String({ description: "Task description" })),
  executor_id: Type.Optional(Type.String({ description: "Executor userId for the task" })),
  due_date: Type.Optional(
    Type.String({
      description: "Due date in ISO 8601 format, e.g. 2024-12-31T18:00:00+08:00",
    }),
  ),
  priority: optionalStringEnum(TASK_PRIORITIES, {
    description: "Task priority: 0=none, 1=urgent, 2=high, 3=normal",
  }),
  done: Type.Optional(Type.Boolean({ description: "Whether the task is done (for update_task)" })),
  cursor: Type.Optional(Type.String({ description: "Pagination cursor for list operations" })),
  size: Type.Optional(
    Type.Number({ description: "Page size for list operations (default 20, max 100)" }),
  ),
});

export type DingtalkProjectParams = Static<typeof DingtalkProjectSchema>;
