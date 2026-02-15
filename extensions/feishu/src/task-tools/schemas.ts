import { Type } from "@sinclair/typebox";
import type { TaskClient } from "./common.js";

type TaskCreatePayload = NonNullable<Parameters<TaskClient["task"]["v2"]["task"]["create"]>[0]>;
type TaskUpdatePayload = NonNullable<Parameters<TaskClient["task"]["v2"]["task"]["patch"]>[0]>;
type TaskDeletePayload = NonNullable<Parameters<TaskClient["task"]["v2"]["task"]["delete"]>[0]>;
type TaskGetPayload = NonNullable<Parameters<TaskClient["task"]["v2"]["task"]["get"]>[0]>;

export type TaskCreateData = TaskCreatePayload["data"];
export type TaskUpdateData = TaskUpdatePayload["data"];
export type TaskUpdateTask = NonNullable<TaskUpdateData["task"]>;

export type CreateTaskParams = {
  summary: TaskCreateData["summary"];
  description?: TaskCreateData["description"];
  due?: TaskCreateData["due"];
  start?: TaskCreateData["start"];
  extra?: TaskCreateData["extra"];
  completed_at?: TaskCreateData["completed_at"];
  members?: TaskCreateData["members"];
  repeat_rule?: TaskCreateData["repeat_rule"];
  tasklists?: TaskCreateData["tasklists"];
  mode?: TaskCreateData["mode"];
  is_milestone?: TaskCreateData["is_milestone"];
  user_id_type?: NonNullable<TaskCreatePayload["params"]>["user_id_type"];
};

export type DeleteTaskParams = {
  task_guid: TaskDeletePayload["path"]["task_guid"];
};

export type GetTaskParams = {
  task_guid: TaskGetPayload["path"]["task_guid"];
  user_id_type?: NonNullable<TaskGetPayload["params"]>["user_id_type"];
};

export type UpdateTaskParams = {
  task_guid: TaskUpdatePayload["path"]["task_guid"];
  task: TaskUpdateTask;
  update_fields?: TaskUpdateData["update_fields"];
  user_id_type?: NonNullable<TaskUpdatePayload["params"]>["user_id_type"];
};

const TaskDateSchema = Type.Object({
  timestamp: Type.Optional(
    Type.String({
      description: 'Unix timestamp in milliseconds (string), e.g. "1735689600000" (13-digit ms)',
    }),
  ),
  is_all_day: Type.Optional(Type.Boolean({ description: "Whether this is an all-day date" })),
});

const TaskMemberSchema = Type.Object({
  id: Type.String({ description: "Member ID (with type controlled by user_id_type)" }),
  type: Type.Optional(Type.String({ description: 'Member type (usually "user")' })),
  role: Type.String({ description: 'Member role, e.g. "assignee"' }),
  name: Type.Optional(Type.String({ description: "Optional display name" })),
});

const TasklistRefSchema = Type.Object({
  tasklist_guid: Type.Optional(Type.String({ description: "Tasklist GUID" })),
  section_guid: Type.Optional(Type.String({ description: "Section GUID in tasklist" })),
});

export const CreateTaskSchema = Type.Object({
  summary: Type.String({ description: "Task title/summary" }),
  description: Type.Optional(Type.String({ description: "Task description" })),
  due: Type.Optional(TaskDateSchema),
  start: Type.Optional(TaskDateSchema),
  extra: Type.Optional(Type.String({ description: "Custom opaque metadata string" })),
  completed_at: Type.Optional(
    Type.String({
      description: "Completion time as Unix timestamp in milliseconds (string, 13-digit ms)",
    }),
  ),
  members: Type.Optional(Type.Array(TaskMemberSchema, { description: "Initial task members" })),
  repeat_rule: Type.Optional(Type.String({ description: "Task repeat rule" })),
  tasklists: Type.Optional(
    Type.Array(TasklistRefSchema, { description: "Attach the task to tasklists/sections" }),
  ),
  mode: Type.Optional(Type.Number({ description: "Task mode value from Feishu Task API" })),
  is_milestone: Type.Optional(Type.Boolean({ description: "Whether task is a milestone" })),
  user_id_type: Type.Optional(
    Type.String({
      description: "User ID type for member IDs, e.g. open_id/user_id/union_id",
    }),
  ),
});

export const DeleteTaskSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to delete" }),
});

export const GetTaskSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to retrieve" }),
  user_id_type: Type.Optional(
    Type.String({
      description: "User ID type in returned members, e.g. open_id/user_id/union_id",
    }),
  ),
});

const TaskUpdateContentSchema = Type.Object(
  {
    summary: Type.Optional(Type.String({ description: "Updated summary" })),
    description: Type.Optional(Type.String({ description: "Updated description" })),
    due: Type.Optional(TaskDateSchema),
    start: Type.Optional(TaskDateSchema),
    extra: Type.Optional(Type.String({ description: "Updated extra metadata" })),
    completed_at: Type.Optional(
      Type.String({
        description:
          "Updated completion time (Unix timestamp in milliseconds, string, 13-digit ms)",
      }),
    ),
    repeat_rule: Type.Optional(Type.String({ description: "Updated repeat rule" })),
    mode: Type.Optional(Type.Number({ description: "Updated task mode" })),
    is_milestone: Type.Optional(Type.Boolean({ description: "Updated milestone flag" })),
  },
  { minProperties: 1 },
);

export const UpdateTaskSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to update" }),
  task: TaskUpdateContentSchema,
  update_fields: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Fields to update. If omitted, this tool infers from keys in task (e.g. summary, description, due, start)",
      minItems: 1,
    }),
  ),
  user_id_type: Type.Optional(
    Type.String({
      description: "User ID type when task body contains user-related fields",
    }),
  ),
});
