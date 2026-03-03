import { Type } from "@sinclair/typebox";
import { createFeishuClient } from "./client.js";

export type TaskClient = ReturnType<typeof createFeishuClient>;

type TaskCreatePayload = NonNullable<Parameters<TaskClient["task"]["v2"]["task"]["create"]>[0]>;
type TaskUpdatePayload = NonNullable<Parameters<TaskClient["task"]["v2"]["task"]["patch"]>[0]>;
type TaskDeletePayload = NonNullable<Parameters<TaskClient["task"]["v2"]["task"]["delete"]>[0]>;
type TaskGetPayload = NonNullable<Parameters<TaskClient["task"]["v2"]["task"]["get"]>[0]>;
type TaskAddTasklistPayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["task"]["addTasklist"]>[0]
>;
type TaskRemoveTasklistPayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["task"]["removeTasklist"]>[0]
>;
type TaskCommentCreatePayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["comment"]["create"]>[0]
>;
type TaskCommentGetPayload = NonNullable<Parameters<TaskClient["task"]["v2"]["comment"]["get"]>[0]>;
type TaskCommentListPayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["comment"]["list"]>[0]
>;
type TaskCommentPatchPayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["comment"]["patch"]>[0]
>;
type TaskCommentDeletePayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["comment"]["delete"]>[0]
>;
type TaskAttachmentUploadPayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["attachment"]["upload"]>[0]
>;
type TaskAttachmentGetPayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["attachment"]["get"]>[0]
>;
type TaskAttachmentListPayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["attachment"]["list"]>[0]
>;
type TaskAttachmentDeletePayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["attachment"]["delete"]>[0]
>;
type TasklistCreatePayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["tasklist"]["create"]>[0]
>;
type TasklistGetPayload = NonNullable<Parameters<TaskClient["task"]["v2"]["tasklist"]["get"]>[0]>;
type TasklistListPayload = NonNullable<Parameters<TaskClient["task"]["v2"]["tasklist"]["list"]>[0]>;
type TasklistPatchPayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["tasklist"]["patch"]>[0]
>;
type TasklistDeletePayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["tasklist"]["delete"]>[0]
>;
type TasklistAddMembersPayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["tasklist"]["addMembers"]>[0]
>;
type TasklistRemoveMembersPayload = NonNullable<
  Parameters<TaskClient["task"]["v2"]["tasklist"]["removeMembers"]>[0]
>;

export type TaskCreateData = TaskCreatePayload["data"];
export type TaskUpdateData = TaskUpdatePayload["data"];
export type TaskUpdateTask = NonNullable<TaskUpdateData["task"]>;
export type TaskCommentPatchData = TaskCommentPatchPayload["data"];
export type TaskCommentPatchComment = TaskCommentPatchData["comment"];
export type TasklistCreateData = TasklistCreatePayload["data"];
export type TasklistPatchData = TasklistPatchPayload["data"];
export type TasklistPatchTasklist = NonNullable<TasklistPatchData["tasklist"]>;
export type TasklistMember = NonNullable<NonNullable<TasklistCreateData["members"]>[number]>;

export const TASK_UPDATE_FIELD_VALUES = [
  "summary",
  "description",
  "due",
  "start",
  "extra",
  "completed_at",
  "repeat_rule",
  "mode",
  "is_milestone",
] as const;
export const TASKLIST_UPDATE_FIELD_VALUES = ["name", "owner", "archive_tasklist"] as const;

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

export type CreateSubtaskParams = CreateTaskParams & {
  task_guid: string;
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

export type AddTaskToTasklistParams = {
  task_guid: TaskAddTasklistPayload["path"]["task_guid"];
  tasklist_guid: NonNullable<TaskAddTasklistPayload["data"]>["tasklist_guid"];
  section_guid?: NonNullable<TaskAddTasklistPayload["data"]>["section_guid"];
  user_id_type?: NonNullable<TaskAddTasklistPayload["params"]>["user_id_type"];
};

export type RemoveTaskFromTasklistParams = {
  task_guid: TaskRemoveTasklistPayload["path"]["task_guid"];
  tasklist_guid: NonNullable<TaskRemoveTasklistPayload["data"]>["tasklist_guid"];
  user_id_type?: NonNullable<TaskRemoveTasklistPayload["params"]>["user_id_type"];
};

export type CreateTaskCommentParams = {
  task_guid: string;
  content: TaskCommentCreatePayload["data"]["content"];
  reply_to_comment_id?: TaskCommentCreatePayload["data"]["reply_to_comment_id"];
  user_id_type?: NonNullable<TaskCommentCreatePayload["params"]>["user_id_type"];
};

export type ListTaskCommentsParams = {
  task_guid: string;
  page_size?: NonNullable<TaskCommentListPayload["params"]>["page_size"];
  page_token?: NonNullable<TaskCommentListPayload["params"]>["page_token"];
  direction?: NonNullable<TaskCommentListPayload["params"]>["direction"];
  user_id_type?: NonNullable<TaskCommentListPayload["params"]>["user_id_type"];
};

export type GetTaskCommentParams = {
  comment_id: TaskCommentGetPayload["path"]["comment_id"];
  user_id_type?: NonNullable<TaskCommentGetPayload["params"]>["user_id_type"];
};

export type UpdateTaskCommentParams = {
  comment_id: TaskCommentPatchPayload["path"]["comment_id"];
  comment: TaskCommentPatchComment;
  update_fields?: TaskCommentPatchData["update_fields"];
  user_id_type?: NonNullable<TaskCommentPatchPayload["params"]>["user_id_type"];
};

export type DeleteTaskCommentParams = {
  comment_id: TaskCommentDeletePayload["path"]["comment_id"];
};

export type UploadTaskAttachmentParams = {
  task_guid: string;
  file_path?: string;
  file_url?: string;
  filename?: string;
  user_id_type?: NonNullable<TaskAttachmentUploadPayload["params"]>["user_id_type"];
};

export type ListTaskAttachmentsParams = {
  task_guid: NonNullable<TaskAttachmentListPayload["params"]>["resource_id"];
  page_size?: NonNullable<TaskAttachmentListPayload["params"]>["page_size"];
  page_token?: NonNullable<TaskAttachmentListPayload["params"]>["page_token"];
  updated_mesc?: NonNullable<TaskAttachmentListPayload["params"]>["updated_mesc"];
  user_id_type?: NonNullable<TaskAttachmentListPayload["params"]>["user_id_type"];
};

export type GetTaskAttachmentParams = {
  attachment_guid: TaskAttachmentGetPayload["path"]["attachment_guid"];
  user_id_type?: NonNullable<TaskAttachmentGetPayload["params"]>["user_id_type"];
};

export type DeleteTaskAttachmentParams = {
  attachment_guid: NonNullable<TaskAttachmentDeletePayload["path"]>["attachment_guid"];
};

export type CreateTasklistParams = {
  name: TasklistCreateData["name"];
  members?: TasklistCreateData["members"];
  archive_tasklist?: TasklistCreateData["archive_tasklist"];
  user_id_type?: NonNullable<TasklistCreatePayload["params"]>["user_id_type"];
};

export type GetTasklistParams = {
  tasklist_guid: NonNullable<TasklistGetPayload["path"]>["tasklist_guid"];
  user_id_type?: NonNullable<TasklistGetPayload["params"]>["user_id_type"];
};

export type ListTasklistTasksParams = {
  tasklist_guid: string;
  page_size?: number;
  page_token?: string;
  completed?: boolean;
  created_from?: string;
  created_to?: string;
  user_id_type?: string;
};

export type ListTasklistsParams = {
  page_size?: NonNullable<TasklistListPayload["params"]>["page_size"];
  page_token?: NonNullable<TasklistListPayload["params"]>["page_token"];
  user_id_type?: NonNullable<TasklistListPayload["params"]>["user_id_type"];
};

export type UpdateTasklistParams = {
  tasklist_guid: NonNullable<TasklistPatchPayload["path"]>["tasklist_guid"];
  tasklist: TasklistPatchTasklist;
  update_fields?: TasklistPatchData["update_fields"];
  origin_owner_to_role?: TasklistPatchData["origin_owner_to_role"];
  user_id_type?: NonNullable<TasklistPatchPayload["params"]>["user_id_type"];
};

export type DeleteTasklistParams = {
  tasklist_guid: NonNullable<TasklistDeletePayload["path"]>["tasklist_guid"];
};

export type AddTasklistMembersParams = {
  tasklist_guid: NonNullable<TasklistAddMembersPayload["path"]>["tasklist_guid"];
  members: NonNullable<NonNullable<TasklistAddMembersPayload["data"]>["members"]>;
  user_id_type?: NonNullable<TasklistAddMembersPayload["params"]>["user_id_type"];
};

export type RemoveTasklistMembersParams = {
  tasklist_guid: NonNullable<TasklistRemoveMembersPayload["path"]>["tasklist_guid"];
  members: NonNullable<NonNullable<TasklistRemoveMembersPayload["data"]>["members"]>;
  user_id_type?: NonNullable<TasklistRemoveMembersPayload["params"]>["user_id_type"];
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

const TaskUpdateFieldSchema = Type.Union(
  TASK_UPDATE_FIELD_VALUES.map((field) => Type.Literal(field)),
);

const TasklistMemberRoleSchema = Type.Union(
  [Type.Literal("owner"), Type.Literal("editor"), Type.Literal("viewer")],
  { description: "Member role (owner/editor/viewer)" },
);

const TasklistUpdateFieldSchema = Type.Union(
  TASKLIST_UPDATE_FIELD_VALUES.map((field) => Type.Literal(field)),
);

const TasklistOriginOwnerRoleSchema = Type.Union(
  [Type.Literal("editor"), Type.Literal("viewer"), Type.Literal("none")],
  { description: "Role for original owner after owner transfer" },
);

const TasklistMemberSchema = Type.Object({
  id: Type.String({ description: "Member ID (with type controlled by user_id_type)" }),
  type: Type.Optional(Type.String({ description: "Member type (user/chat/app)" })),
  role: Type.Optional(TasklistMemberRoleSchema),
  name: Type.Optional(Type.String({ description: "Optional display name" })),
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

export const CreateSubtaskSchema = Type.Object({
  task_guid: Type.String({ description: "Parent task GUID" }),
  ...CreateTaskSchema.properties,
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
    Type.Array(TaskUpdateFieldSchema, {
      description:
        "Fields to update. If omitted, this tool infers from keys in task (e.g. summary, description, due, start)",
      minItems: 1,
      uniqueItems: true,
    }),
  ),
  user_id_type: Type.Optional(
    Type.String({
      description: "User ID type when task body contains user-related fields",
    }),
  ),
});

export const CreateTaskCommentSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to comment on" }),
  content: Type.String({ description: "Comment content" }),
  reply_to_comment_id: Type.Optional(
    Type.String({ description: "Reply to a specific comment ID" }),
  ),
  user_id_type: Type.Optional(
    Type.String({ description: "User ID type when comment involves user-related fields" }),
  ),
});

export const ListTaskCommentsSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to list comments for" }),
  page_size: Type.Optional(
    Type.Number({
      description: "Page size (1-100)",
      minimum: 1,
      maximum: 100,
    }),
  ),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
  direction: Type.Optional(
    Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
      description: "Sort direction",
    }),
  ),
  user_id_type: Type.Optional(Type.String({ description: "User ID type for returned creators" })),
});

export const GetTaskCommentSchema = Type.Object({
  comment_id: Type.String({ description: "Comment ID to retrieve" }),
  user_id_type: Type.Optional(Type.String({ description: "User ID type for returned creators" })),
});

const TaskCommentUpdateContentSchema = Type.Object(
  {
    content: Type.Optional(Type.String({ description: "Updated comment content" })),
  },
  { minProperties: 1 },
);

export const UpdateTaskCommentSchema = Type.Object({
  comment_id: Type.String({ description: "Comment ID to update" }),
  comment: TaskCommentUpdateContentSchema,
  update_fields: Type.Optional(
    Type.Array(Type.String(), {
      description: "Fields to update. If omitted, this tool infers from keys in comment (content)",
      minItems: 1,
    }),
  ),
  user_id_type: Type.Optional(Type.String({ description: "User ID type for returned creators" })),
});

export const DeleteTaskCommentSchema = Type.Object({
  comment_id: Type.String({ description: "Comment ID to delete" }),
});

const TasklistUpdateContentSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ description: "Updated tasklist name" })),
    owner: Type.Optional(TasklistMemberSchema),
    archive_tasklist: Type.Optional(Type.Boolean({ description: "Archive/unarchive tasklist" })),
  },
  { minProperties: 1 },
);

export const AddTaskToTasklistSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to move" }),
  tasklist_guid: Type.String({ description: "Tasklist GUID to add the task into" }),
  section_guid: Type.Optional(Type.String({ description: "Tasklist section GUID" })),
  user_id_type: Type.Optional(
    Type.String({ description: "User ID type when task body contains user-related fields" }),
  ),
});

export const RemoveTaskFromTasklistSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to move" }),
  tasklist_guid: Type.String({ description: "Tasklist GUID to remove the task from" }),
  user_id_type: Type.Optional(
    Type.String({ description: "User ID type when task body contains user-related fields" }),
  ),
});

export const CreateTasklistSchema = Type.Object({
  name: Type.String({ description: "Tasklist name" }),
  members: Type.Optional(Type.Array(TasklistMemberSchema, { description: "Initial members" })),
  archive_tasklist: Type.Optional(
    Type.Boolean({ description: "Whether to create as archived tasklist" }),
  ),
  user_id_type: Type.Optional(
    Type.String({ description: "User ID type for member IDs, e.g. open_id/user_id/union_id" }),
  ),
});

export const GetTasklistSchema = Type.Object({
  tasklist_guid: Type.String({ description: "Tasklist GUID to retrieve" }),
  user_id_type: Type.Optional(
    Type.String({ description: "User ID type in returned members, e.g. open_id/user_id/union_id" }),
  ),
});

export const ListTasklistsSchema = Type.Object({
  page_size: Type.Optional(
    Type.Number({
      description: "Page size (1-100)",
      minimum: 1,
      maximum: 100,
    }),
  ),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
  user_id_type: Type.Optional(
    Type.String({ description: "User ID type in returned members, e.g. open_id/user_id/union_id" }),
  ),
});

export const ListTasklistTasksSchema = Type.Object({
  tasklist_guid: Type.String({ description: "Tasklist GUID to enumerate tasks from" }),
  page_size: Type.Optional(
    Type.Number({
      description: "Page size for pagination",
      minimum: 1,
    }),
  ),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
  completed: Type.Optional(
    Type.Boolean({ description: "Filter by completion status when supported by the API" }),
  ),
  created_from: Type.Optional(
    Type.String({
      description:
        "Inclusive lower bound of task creation time, as Unix timestamp in milliseconds (string)",
    }),
  ),
  created_to: Type.Optional(
    Type.String({
      description:
        "Inclusive upper bound of task creation time, as Unix timestamp in milliseconds (string)",
    }),
  ),
  user_id_type: Type.Optional(
    Type.String({
      description: "User ID type in returned member/user fields, e.g. open_id/user_id/union_id",
    }),
  ),
});

export const UpdateTasklistSchema = Type.Object({
  tasklist_guid: Type.String({ description: "Tasklist GUID to update" }),
  tasklist: TasklistUpdateContentSchema,
  update_fields: Type.Optional(
    Type.Array(TasklistUpdateFieldSchema, {
      description:
        "Fields to update. If omitted, this tool infers from keys in tasklist (e.g. name, owner, archive_tasklist)",
      minItems: 1,
      uniqueItems: true,
    }),
  ),
  origin_owner_to_role: Type.Optional(TasklistOriginOwnerRoleSchema),
  user_id_type: Type.Optional(
    Type.String({ description: "User ID type when tasklist body contains user-related fields" }),
  ),
});

export const DeleteTasklistSchema = Type.Object({
  tasklist_guid: Type.String({ description: "Tasklist GUID to delete" }),
});

export const AddTasklistMembersSchema = Type.Object({
  tasklist_guid: Type.String({ description: "Tasklist GUID to add members to" }),
  members: Type.Array(TasklistMemberSchema, {
    description: "Members to add",
    minItems: 1,
  }),
  user_id_type: Type.Optional(
    Type.String({ description: "User ID type for member IDs, e.g. open_id/user_id/union_id" }),
  ),
});

export const RemoveTasklistMembersSchema = Type.Object({
  tasklist_guid: Type.String({ description: "Tasklist GUID to remove members from" }),
  members: Type.Array(TasklistMemberSchema, {
    description: "Members to remove",
    minItems: 1,
  }),
  user_id_type: Type.Optional(
    Type.String({ description: "User ID type for member IDs, e.g. open_id/user_id/union_id" }),
  ),
});

export const UploadTaskAttachmentSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to upload attachment to" }),
  file_path: Type.Optional(
    Type.String({
      description: "Local file path on the OpenClaw host (provide either file_path or file_url)",
    }),
  ),
  file_url: Type.Optional(
    Type.String({
      description: "Remote file URL to download and upload (provide either file_path or file_url)",
    }),
  ),
  filename: Type.Optional(
    Type.String({ description: "Override filename for uploaded attachment (only with file_url)" }),
  ),
  user_id_type: Type.Optional(Type.String({ description: "User ID type for returned uploader" })),
});

export const ListTaskAttachmentsSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to list attachments for" }),
  page_size: Type.Optional(
    Type.Number({
      description: "Page size (1-100)",
      minimum: 1,
      maximum: 100,
    }),
  ),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
  updated_mesc: Type.Optional(Type.String({ description: "Updated timestamp filter" })),
  user_id_type: Type.Optional(Type.String({ description: "User ID type for returned uploader" })),
});

export const GetTaskAttachmentSchema = Type.Object({
  attachment_guid: Type.String({ description: "Attachment GUID to retrieve" }),
  user_id_type: Type.Optional(Type.String({ description: "User ID type for returned uploader" })),
});

export const DeleteTaskAttachmentSchema = Type.Object({
  attachment_guid: Type.String({ description: "Attachment GUID to delete" }),
});
