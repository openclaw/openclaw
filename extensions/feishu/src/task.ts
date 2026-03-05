import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  TASK_UPDATE_FIELD_VALUES,
  TASKLIST_UPDATE_FIELD_VALUES,
  type AddTaskToTasklistParams,
  type AddTasklistMembersParams,
  type CreateSubtaskParams,
  type CreateTaskCommentParams,
  type CreateTaskParams,
  type CreateTasklistParams,
  type DeleteTaskAttachmentParams,
  type DeleteTaskCommentParams,
  type DeleteTaskParams,
  type DeleteTasklistParams,
  type GetTaskAttachmentParams,
  type GetTaskCommentParams,
  type GetTaskParams,
  type GetTasklistParams,
  type ListTaskAttachmentsParams,
  type ListTaskCommentsParams,
  type ListTasklistsParams,
  type RemoveTaskFromTasklistParams,
  type RemoveTasklistMembersParams,
  type TaskCommentPatchComment,
  type TasklistPatchTasklist,
  type TaskUpdateTask,
  type UpdateTaskCommentParams,
  type UpdateTasklistParams,
  type UpdateTaskParams,
  type UploadTaskAttachmentParams,
  AddTaskToTasklistSchema,
  AddTasklistMembersSchema,
  CreateSubtaskSchema,
  CreateTaskCommentSchema,
  CreateTaskSchema,
  CreateTasklistSchema,
  DeleteTaskAttachmentSchema,
  DeleteTaskCommentSchema,
  DeleteTaskSchema,
  DeleteTasklistSchema,
  GetTaskAttachmentSchema,
  GetTaskCommentSchema,
  GetTaskSchema,
  GetTasklistSchema,
  ListTaskAttachmentsSchema,
  ListTaskCommentsSchema,
  ListTasklistsSchema,
  RemoveTaskFromTasklistSchema,
  RemoveTasklistMembersSchema,
  UpdateTaskCommentSchema,
  UpdateTaskSchema,
  UpdateTasklistSchema,
  UploadTaskAttachmentSchema,
} from "./task-schema.js";
import {
  createFeishuToolClient,
  resolveAnyEnabledFeishuToolsConfig,
  resolveFeishuToolAccount,
} from "./tool-account.js";

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ============ Constants ============

const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_TASK_MEDIA_MAX_MB = 30;
const DEFAULT_TASK_ATTACHMENT_MAX_BYTES = DEFAULT_TASK_MEDIA_MAX_MB * BYTES_PER_MEGABYTE;
const DEFAULT_TASK_ATTACHMENT_FILENAME = "attachment";

// ============ Utilities ============

function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

const SUPPORTED_PATCH_FIELDS = new Set<string>(TASK_UPDATE_FIELD_VALUES);
const SUPPORTED_TASKLIST_PATCH_FIELDS = new Set<string>(TASKLIST_UPDATE_FIELD_VALUES);

function inferUpdateFields(task: TaskUpdateTask): string[] {
  return Object.keys(task).filter((field) => SUPPORTED_PATCH_FIELDS.has(field));
}

function inferTasklistUpdateFields(tasklist: TasklistPatchTasklist): string[] {
  return Object.keys(tasklist).filter((field) => SUPPORTED_TASKLIST_PATCH_FIELDS.has(field));
}

function ensureSupportedUpdateFields(
  updateFields: string[],
  supported: Set<string>,
  resource: "task" | "tasklist",
) {
  const invalid = updateFields.filter((field) => !supported.has(field));
  if (invalid.length > 0) {
    throw new Error(`unsupported ${resource} update_fields: ${invalid.join(", ")}`);
  }
}

// ============ Formatters ============

function formatTask(task: Record<string, unknown> | undefined) {
  if (!task) return undefined;
  return {
    guid: task.guid,
    task_id: task.task_id,
    summary: task.summary,
    description: task.description,
    status: task.status,
    url: task.url,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at,
    due: task.due,
    start: task.start,
    is_milestone: task.is_milestone,
    members: task.members,
    tasklists: task.tasklists,
  };
}

function formatTasklist(tasklist: Record<string, unknown> | undefined) {
  if (!tasklist) return undefined;
  return {
    guid: tasklist.guid,
    name: tasklist.name,
    creator: tasklist.creator,
    owner: tasklist.owner,
    members: tasklist.members,
    url: tasklist.url,
    created_at: tasklist.created_at,
    updated_at: tasklist.updated_at,
    archive_msec: tasklist.archive_msec,
  };
}

function formatAttachment(attachment: Record<string, unknown> | undefined) {
  if (!attachment) return undefined;
  return {
    guid: attachment.guid,
    file_token: attachment.file_token,
    name: attachment.name,
    size: attachment.size,
    uploader: attachment.uploader,
    is_cover: attachment.is_cover,
    uploaded_at: attachment.uploaded_at,
    url: attachment.url,
    resource: attachment.resource,
  };
}

function formatComment(comment: Record<string, unknown> | undefined) {
  if (!comment) return undefined;
  return {
    id: comment.id,
    content: comment.content,
    creator: comment.creator,
    reply_to_comment_id: comment.reply_to_comment_id,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    resource_type: comment.resource_type,
    resource_id: comment.resource_id,
  };
}

// ============ Attachment Upload Helpers ============

function sanitizeUploadFilename(input: string) {
  const base = path.basename(input.trim());
  return base.length > 0 ? base : DEFAULT_TASK_ATTACHMENT_FILENAME;
}

async function ensureUploadableLocalFile(filePath: string, maxBytes: number) {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    throw new Error(`file_path not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`file_path is not a regular file: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `file_path exceeds ${Math.round(maxBytes / BYTES_PER_MEGABYTE)}MB limit: ${filePath}`,
    );
  }
}

async function saveBufferToTempFile(buffer: Buffer, fileName: string) {
  const safeName = sanitizeUploadFilename(fileName);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "feishu-task-"));
  const tempPath = path.join(dir, safeName);
  await fs.promises.writeFile(tempPath, buffer);
  return {
    tempPath,
    cleanup: async () => {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function downloadToTempFile(fileUrl: string, filename: string | undefined, maxBytes: number) {
  const loaded = await getFeishuRuntime().media.loadWebMedia(fileUrl, {
    maxBytes,
    optimizeImages: false,
  });
  const parsedPath = (() => {
    try {
      return new URL(fileUrl).pathname;
    } catch {
      return "";
    }
  })();
  const fallbackName = path.basename(parsedPath) || DEFAULT_TASK_ATTACHMENT_FILENAME;
  const preferredName = filename?.trim() ? filename : (loaded.fileName ?? fallbackName);
  return saveBufferToTempFile(loaded.buffer, preferredName);
}

// ============ Actions ============

async function createTask(client: Lark.Client, params: CreateTaskParams) {
  const res = await client.task.v2.task.create({
    data: omitUndefined({
      summary: params.summary,
      description: params.description,
      due: params.due,
      start: params.start,
      extra: params.extra,
      completed_at: params.completed_at,
      members: params.members,
      repeat_rule: params.repeat_rule,
      tasklists: params.tasklists,
      mode: params.mode,
      is_milestone: params.is_milestone,
    }),
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined) };
}

async function createSubtask(client: Lark.Client, params: CreateSubtaskParams) {
  const res = await client.task.v2.taskSubtask.create({
    path: { task_guid: params.task_guid },
    data: omitUndefined({
      summary: params.summary,
      description: params.description,
      due: params.due,
      start: params.start,
      extra: params.extra,
      completed_at: params.completed_at,
      members: params.members,
      repeat_rule: params.repeat_rule,
      tasklists: params.tasklists,
      mode: params.mode,
      is_milestone: params.is_milestone,
    }),
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    subtask: formatTask((res.data?.subtask ?? undefined) as Record<string, unknown> | undefined),
  };
}

async function deleteTask(client: Lark.Client, taskGuid: string) {
  const res = await client.task.v2.task.delete({ path: { task_guid: taskGuid } });
  if (res.code !== 0) throw new Error(res.msg);
  return { success: true, task_guid: taskGuid };
}

async function getTask(client: Lark.Client, params: GetTaskParams) {
  const res = await client.task.v2.task.get({
    path: { task_guid: params.task_guid },
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined) };
}

async function updateTask(client: Lark.Client, params: UpdateTaskParams) {
  const task = omitUndefined(params.task as Record<string, unknown>) as TaskUpdateTask;
  const updateFields = params.update_fields?.length
    ? params.update_fields
    : inferUpdateFields(task);

  if (params.update_fields?.length) {
    ensureSupportedUpdateFields(updateFields, SUPPORTED_PATCH_FIELDS, "task");
  }
  if (Object.keys(task).length === 0) {
    throw new Error("task update payload is empty");
  }
  if (updateFields.length === 0) {
    throw new Error("no valid update_fields provided or inferred from task payload");
  }

  const res = await client.task.v2.task.patch({
    path: { task_guid: params.task_guid },
    data: { task, update_fields: updateFields },
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined),
    update_fields: updateFields,
  };
}

async function addTaskToTasklist(client: Lark.Client, params: AddTaskToTasklistParams) {
  const res = await client.task.v2.task.addTasklist({
    path: { task_guid: params.task_guid },
    data: omitUndefined({
      tasklist_guid: params.tasklist_guid,
      section_guid: params.section_guid,
    }),
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined) };
}

async function removeTaskFromTasklist(client: Lark.Client, params: RemoveTaskFromTasklistParams) {
  const res = await client.task.v2.task.removeTasklist({
    path: { task_guid: params.task_guid },
    data: omitUndefined({ tasklist_guid: params.tasklist_guid }),
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined) };
}

async function createTasklist(client: Lark.Client, params: CreateTasklistParams) {
  const res = await client.task.v2.tasklist.create({
    data: omitUndefined({
      name: params.name,
      members: params.members,
      archive_tasklist: params.archive_tasklist,
    }),
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

async function getTasklist(client: Lark.Client, params: GetTasklistParams) {
  const res = await client.task.v2.tasklist.get({
    path: { tasklist_guid: params.tasklist_guid },
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

async function listTasklists(client: Lark.Client, params: ListTasklistsParams) {
  const res = await client.task.v2.tasklist.list({
    params: omitUndefined({
      page_size: params.page_size,
      page_token: params.page_token,
      user_id_type: params.user_id_type,
    }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  const items = (res.data?.items ?? []) as Record<string, unknown>[];
  return {
    items: items.map((item) => formatTasklist(item)),
    page_token: res.data?.page_token,
    has_more: res.data?.has_more,
  };
}

async function updateTasklist(client: Lark.Client, params: UpdateTasklistParams) {
  const tasklist = omitUndefined(
    params.tasklist as Record<string, unknown>,
  ) as TasklistPatchTasklist;
  const updateFields = params.update_fields?.length
    ? params.update_fields
    : inferTasklistUpdateFields(tasklist);

  if (params.update_fields?.length) {
    ensureSupportedUpdateFields(updateFields, SUPPORTED_TASKLIST_PATCH_FIELDS, "tasklist");
  }
  if (Object.keys(tasklist).length === 0) {
    throw new Error("tasklist update payload is empty");
  }
  if (updateFields.length === 0) {
    throw new Error("no valid update_fields provided or inferred from tasklist payload");
  }

  const res = await client.task.v2.tasklist.patch({
    path: { tasklist_guid: params.tasklist_guid },
    data: omitUndefined({
      tasklist,
      update_fields: updateFields,
      origin_owner_to_role: params.origin_owner_to_role,
    }),
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
    update_fields: updateFields,
  };
}

async function deleteTasklist(client: Lark.Client, tasklistGuid: string) {
  const res = await client.task.v2.tasklist.delete({ path: { tasklist_guid: tasklistGuid } });
  if (res.code !== 0) throw new Error(res.msg);
  return { success: true, tasklist_guid: tasklistGuid };
}

async function addTasklistMembers(client: Lark.Client, params: AddTasklistMembersParams) {
  const res = await client.task.v2.tasklist.addMembers({
    path: { tasklist_guid: params.tasklist_guid },
    data: { members: params.members },
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

async function removeTasklistMembers(client: Lark.Client, params: RemoveTasklistMembersParams) {
  const res = await client.task.v2.tasklist.removeMembers({
    path: { tasklist_guid: params.tasklist_guid },
    data: { members: params.members },
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

async function getTaskAttachment(client: Lark.Client, params: GetTaskAttachmentParams) {
  const res = await client.task.v2.attachment.get({
    path: { attachment_guid: params.attachment_guid },
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    attachment: formatAttachment(
      (res.data?.attachment ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

async function listTaskAttachments(client: Lark.Client, params: ListTaskAttachmentsParams) {
  const res = await client.task.v2.attachment.list({
    params: omitUndefined({
      resource_type: "task",
      resource_id: params.task_guid as string,
      page_size: params.page_size,
      page_token: params.page_token,
      updated_mesc: params.updated_mesc,
      user_id_type: params.user_id_type,
    }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  const items = (res.data?.items ?? []) as Record<string, unknown>[];
  return {
    items: items.map((item) => formatAttachment(item)),
    page_token: res.data?.page_token,
    has_more: res.data?.has_more,
  };
}

async function deleteTaskAttachment(client: Lark.Client, params: DeleteTaskAttachmentParams) {
  const res = await client.task.v2.attachment.delete({
    path: { attachment_guid: params.attachment_guid },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { success: true, attachment_guid: params.attachment_guid };
}

async function uploadTaskAttachment(
  client: Lark.Client,
  params: UploadTaskAttachmentParams,
  options?: { maxBytes?: number },
) {
  const maxBytes =
    typeof options?.maxBytes === "number" && options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_TASK_ATTACHMENT_MAX_BYTES;

  let tempCleanup: (() => Promise<void>) | undefined;
  let filePath: string;

  if (params.file_path) {
    filePath = params.file_path;
    await ensureUploadableLocalFile(filePath, maxBytes);
  } else if (params.file_url) {
    const download = await downloadToTempFile(params.file_url, params.filename, maxBytes);
    filePath = download.tempPath;
    tempCleanup = download.cleanup;
  } else {
    throw new Error("Either file_path or file_url is required");
  }

  try {
    const data = await client.task.v2.attachment.upload({
      data: {
        resource_type: "task",
        resource_id: params.task_guid,
        file: fs.createReadStream(filePath),
      },
      params: omitUndefined({ user_id_type: params.user_id_type }),
    });
    const items = (data?.items ?? []) as Record<string, unknown>[];
    return { items: items.map((item) => formatAttachment(item)) };
  } finally {
    if (tempCleanup) {
      await tempCleanup();
    }
  }
}

async function createTaskComment(client: Lark.Client, params: CreateTaskCommentParams) {
  const res = await client.task.v2.comment.create({
    data: omitUndefined({
      resource_type: "task" as const,
      resource_id: params.task_guid,
      content: params.content,
      reply_to_comment_id: params.reply_to_comment_id,
    }),
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    comment: formatComment((res.data?.comment ?? undefined) as Record<string, unknown> | undefined),
  };
}

async function listTaskComments(client: Lark.Client, params: ListTaskCommentsParams) {
  const res = await client.task.v2.comment.list({
    params: omitUndefined({
      resource_type: "task" as const,
      resource_id: params.task_guid,
      page_size: params.page_size,
      page_token: params.page_token,
      direction: params.direction,
      user_id_type: params.user_id_type,
    }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  const items = (res.data?.items ?? []) as Record<string, unknown>[];
  return {
    items: items.map((item) => formatComment(item)),
    page_token: res.data?.page_token,
    has_more: res.data?.has_more,
  };
}

async function getTaskComment(client: Lark.Client, params: GetTaskCommentParams) {
  const res = await client.task.v2.comment.get({
    path: { comment_id: params.comment_id },
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    comment: formatComment((res.data?.comment ?? undefined) as Record<string, unknown> | undefined),
  };
}

async function updateTaskComment(client: Lark.Client, params: UpdateTaskCommentParams) {
  const comment = omitUndefined(
    params.comment as Record<string, unknown>,
  ) as TaskCommentPatchComment;
  const updateFields = params.update_fields?.length
    ? params.update_fields
    : Object.keys(comment).filter((k) => k === "content");

  if (Object.keys(comment).length === 0) {
    throw new Error("comment update payload is empty");
  }
  if (updateFields.length === 0) {
    throw new Error("no valid update_fields provided or inferred from comment payload");
  }

  const res = await client.task.v2.comment.patch({
    path: { comment_id: params.comment_id },
    data: { comment, update_fields: updateFields },
    params: omitUndefined({ user_id_type: params.user_id_type }),
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    comment: formatComment((res.data?.comment ?? undefined) as Record<string, unknown> | undefined),
    update_fields: updateFields,
  };
}

async function deleteTaskComment(client: Lark.Client, commentId: string) {
  const res = await client.task.v2.comment.delete({ path: { comment_id: commentId } });
  if (res.code !== 0) throw new Error(res.msg);
  return { success: true, comment_id: commentId };
}

// ============ Registration ============

export function registerFeishuTaskTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_task: No config available, skipping task tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.task) {
    api.logger.debug?.("feishu_task: task tools disabled in config");
    return;
  }

  function registerTaskTool<P>(spec: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    run: (client: Lark.Client, params: P) => Promise<unknown>;
  }) {
    api.registerTool(
      (ctx) => ({
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters,
        async execute(_toolCallId, params) {
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: params as { accountId?: string },
              defaultAccountId: ctx.agentAccountId,
            });
            return json(await spec.run(client, params as P));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      }),
      { name: spec.name },
    );
  }

  registerTaskTool<CreateTaskParams>({
    name: "feishu_task_create",
    label: "Feishu Task Create",
    description: "Create a Feishu task (task v2)",
    parameters: CreateTaskSchema,
    run: (client, params) => createTask(client, params),
  });

  registerTaskTool<CreateSubtaskParams>({
    name: "feishu_task_subtask_create",
    label: "Feishu Task Subtask Create",
    description: "Create a Feishu subtask under a parent task (task v2)",
    parameters: CreateSubtaskSchema,
    run: (client, params) => createSubtask(client, params),
  });

  registerTaskTool<AddTaskToTasklistParams>({
    name: "feishu_task_add_tasklist",
    label: "Feishu Task Add Tasklist",
    description: "Add a task into a tasklist (task v2)",
    parameters: AddTaskToTasklistSchema,
    run: (client, params) => addTaskToTasklist(client, params),
  });

  registerTaskTool<RemoveTaskFromTasklistParams>({
    name: "feishu_task_remove_tasklist",
    label: "Feishu Task Remove Tasklist",
    description: "Remove a task from a tasklist (task v2)",
    parameters: RemoveTaskFromTasklistSchema,
    run: (client, params) => removeTaskFromTasklist(client, params),
  });

  registerTaskTool<CreateTasklistParams>({
    name: "feishu_tasklist_create",
    label: "Feishu Tasklist Create",
    description: "Create a Feishu tasklist (task v2)",
    parameters: CreateTasklistSchema,
    run: (client, params) => createTasklist(client, params),
  });

  registerTaskTool<GetTasklistParams>({
    name: "feishu_tasklist_get",
    label: "Feishu Tasklist Get",
    description: "Get a Feishu tasklist by tasklist_guid (task v2)",
    parameters: GetTasklistSchema,
    run: (client, params) => getTasklist(client, params),
  });

  registerTaskTool<ListTasklistsParams>({
    name: "feishu_tasklist_list",
    label: "Feishu Tasklist List",
    description: "List Feishu tasklists (task v2)",
    parameters: ListTasklistsSchema,
    run: (client, params) => listTasklists(client, params),
  });

  registerTaskTool<UpdateTasklistParams>({
    name: "feishu_tasklist_update",
    label: "Feishu Tasklist Update",
    description: "Update a Feishu tasklist by tasklist_guid (task v2 patch)",
    parameters: UpdateTasklistSchema,
    run: (client, params) => updateTasklist(client, params),
  });

  registerTaskTool<DeleteTasklistParams>({
    name: "feishu_tasklist_delete",
    label: "Feishu Tasklist Delete",
    description: "Delete a Feishu tasklist by tasklist_guid (task v2)",
    parameters: DeleteTasklistSchema,
    run: (client, { tasklist_guid }) => deleteTasklist(client, tasklist_guid as string),
  });

  registerTaskTool<AddTasklistMembersParams>({
    name: "feishu_tasklist_add_members",
    label: "Feishu Tasklist Add Members",
    description: "Add members to a Feishu tasklist (task v2)",
    parameters: AddTasklistMembersSchema,
    run: (client, params) => addTasklistMembers(client, params),
  });

  registerTaskTool<RemoveTasklistMembersParams>({
    name: "feishu_tasklist_remove_members",
    label: "Feishu Tasklist Remove Members",
    description: "Remove members from a Feishu tasklist (task v2)",
    parameters: RemoveTasklistMembersSchema,
    run: (client, params) => removeTasklistMembers(client, params),
  });

  registerTaskTool<ListTaskAttachmentsParams>({
    name: "feishu_task_attachment_list",
    label: "Feishu Task Attachment List",
    description: "List attachments for a Feishu task (task v2)",
    parameters: ListTaskAttachmentsSchema,
    run: (client, params) => listTaskAttachments(client, params),
  });

  registerTaskTool<GetTaskAttachmentParams>({
    name: "feishu_task_attachment_get",
    label: "Feishu Task Attachment Get",
    description: "Get a Feishu task attachment by attachment_guid (task v2)",
    parameters: GetTaskAttachmentSchema,
    run: (client, params) => getTaskAttachment(client, params),
  });

  registerTaskTool<DeleteTaskAttachmentParams>({
    name: "feishu_task_attachment_delete",
    label: "Feishu Task Attachment Delete",
    description: "Delete a Feishu task attachment by attachment_guid (task v2)",
    parameters: DeleteTaskAttachmentSchema,
    run: (client, params) => deleteTaskAttachment(client, params),
  });

  registerTaskTool<DeleteTaskParams>({
    name: "feishu_task_delete",
    label: "Feishu Task Delete",
    description: "Delete a Feishu task by task_guid (task v2)",
    parameters: DeleteTaskSchema,
    run: (client, { task_guid }) => deleteTask(client, task_guid),
  });

  registerTaskTool<GetTaskParams>({
    name: "feishu_task_get",
    label: "Feishu Task Get",
    description: "Get Feishu task details by task_guid (task v2)",
    parameters: GetTaskSchema,
    run: (client, params) => getTask(client, params),
  });

  registerTaskTool<UpdateTaskParams>({
    name: "feishu_task_update",
    label: "Feishu Task Update",
    description: "Update a Feishu task by task_guid (task v2 patch)",
    parameters: UpdateTaskSchema,
    run: (client, params) => updateTask(client, params),
  });

  // Attachment upload needs account config for mediaMaxMb limit.
  api.registerTool(
    (ctx) => ({
      name: "feishu_task_attachment_upload",
      label: "Feishu Task Attachment Upload",
      description:
        "Upload an attachment to a Feishu task from a local file path or remote URL (task v2)",
      parameters: UploadTaskAttachmentSchema,
      async execute(_toolCallId, params) {
        try {
          const p = params as UploadTaskAttachmentParams;
          const account = resolveFeishuToolAccount({
            api,
            executeParams: p as { accountId?: string },
            defaultAccountId: ctx.agentAccountId,
          });
          const client = createFeishuClient(account);
          const mediaMaxBytes =
            (account.config?.mediaMaxMb ?? DEFAULT_TASK_MEDIA_MAX_MB) * BYTES_PER_MEGABYTE;
          return json(await uploadTaskAttachment(client, p, { maxBytes: mediaMaxBytes }));
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    }),
    { name: "feishu_task_attachment_upload" },
  );

  registerTaskTool<CreateTaskCommentParams>({
    name: "feishu_task_comment_create",
    label: "Feishu Task Comment Create",
    description: "Add a comment to a Feishu task (task v2)",
    parameters: CreateTaskCommentSchema,
    run: (client, params) => createTaskComment(client, params),
  });

  registerTaskTool<ListTaskCommentsParams>({
    name: "feishu_task_comment_list",
    label: "Feishu Task Comment List",
    description: "List comments on a Feishu task (task v2)",
    parameters: ListTaskCommentsSchema,
    run: (client, params) => listTaskComments(client, params),
  });

  registerTaskTool<GetTaskCommentParams>({
    name: "feishu_task_comment_get",
    label: "Feishu Task Comment Get",
    description: "Get a specific comment on a Feishu task by comment_id (task v2)",
    parameters: GetTaskCommentSchema,
    run: (client, params) => getTaskComment(client, params),
  });

  registerTaskTool<UpdateTaskCommentParams>({
    name: "feishu_task_comment_update",
    label: "Feishu Task Comment Update",
    description: "Update a comment on a Feishu task by comment_id (task v2 patch)",
    parameters: UpdateTaskCommentSchema,
    run: (client, params) => updateTaskComment(client, params),
  });

  registerTaskTool<DeleteTaskCommentParams>({
    name: "feishu_task_comment_delete",
    label: "Feishu Task Comment Delete",
    description: "Delete a comment on a Feishu task by comment_id (task v2)",
    parameters: DeleteTaskCommentSchema,
    run: (client, { comment_id }) => deleteTaskComment(client, comment_id),
  });

  api.logger.debug?.(
    "feishu_task: Registered task, tasklist, subtask, attachment, and comment tools",
  );
}
