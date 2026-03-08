/**
 * 钉钉待办 Agent Tool Schema
 *
 * 遵循 tool schema guardrails：使用 stringEnum 代替 Type.Union
 */

import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, optionalStringEnum } from "openclaw/plugin-sdk/dingtalk";

const TODO_ACTIONS = ["create", "list", "get", "complete", "update", "delete"] as const;

const TODO_PRIORITIES = ["10", "20", "30", "40"] as const;

export const DingtalkTodoSchema = Type.Object({
  action: stringEnum(TODO_ACTIONS, {
    description:
      "Action to perform: create (new task), list (all tasks), get (task details), complete (mark done), update, delete",
  }),
  user_id: Type.Optional(
    Type.String({
      description:
        "Operator's DingTalk unionId. Optional if operatorUserId is configured in dingtalk config.",
    }),
  ),
  subject: Type.Optional(Type.String({ description: "Task title/subject (required for create)" })),
  description: Type.Optional(Type.String({ description: "Task description" })),
  due_time: Type.Optional(
    Type.String({
      description:
        "Due date/time in ISO 8601 format, e.g. 2024-12-31T18:00:00+08:00 (for create/update)",
    }),
  ),
  priority: optionalStringEnum(TODO_PRIORITIES, {
    description: "Priority: 10=low, 20=normal, 30=important, 40=urgent",
  }),
  executor_ids: Type.Optional(
    Type.Array(Type.String(), { description: "Executor unionIds (who should do the task)" }),
  ),
  task_id: Type.Optional(
    Type.String({ description: "Task ID (required for get/complete/update/delete)" }),
  ),
  done: Type.Optional(Type.Boolean({ description: "Whether the task is done (for update)" })),
});

export type DingtalkTodoParams = Static<typeof DingtalkTodoSchema>;
