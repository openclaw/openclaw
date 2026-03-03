import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getFeishuRuntime } from "./runtime.js";
import {
  TASKLIST_UPDATE_FIELD_VALUES,
  TASK_UPDATE_FIELD_VALUES,
  type TaskClient,
  type AddTaskToTasklistParams,
  type AddTasklistMembersParams,
  type CreateTasklistParams,
  type CreateTaskCommentParams,
  type DeleteTaskCommentParams,
  CreateSubtaskParams,
  CreateTaskParams,
  DeleteTaskAttachmentParams,
  GetTaskAttachmentParams,
  GetTaskParams,
  type GetTaskCommentParams,
  type GetTasklistParams,
  type ListTasklistTasksParams,
  ListTaskAttachmentsParams,
  type ListTaskCommentsParams,
  type ListTasklistsParams,
  type RemoveTaskFromTasklistParams,
  type RemoveTasklistMembersParams,
  TaskUpdateTask,
  type UpdateTaskCommentParams,
  type TasklistPatchTasklist,
  UploadTaskAttachmentParams,
  type UpdateTasklistParams,
  UpdateTaskParams,
} from "./task-schema.js";

const SUPPORTED_PATCH_FIELDS = new Set<string>(TASK_UPDATE_FIELD_VALUES);
const SUPPORTED_TASKLIST_PATCH_FIELDS = new Set<string>(TASKLIST_UPDATE_FIELD_VALUES);
const SUPPORTED_COMMENT_PATCH_FIELDS = new Set<string>(["content"]);

export const BYTES_PER_MEGABYTE = 1024 * 1024;
export const DEFAULT_TASK_MEDIA_MAX_MB = 30;
const DEFAULT_TASK_ATTACHMENT_MAX_BYTES = DEFAULT_TASK_MEDIA_MAX_MB * BYTES_PER_MEGABYTE;
const DEFAULT_TASK_ATTACHMENT_FILENAME = "attachment";
const SIZE_DISPLAY_FRACTION_DIGITS = 0;

type FeishuApiResponse = {
  code?: number;
  msg?: string;
  log_id?: string;
  logId?: string;
};

function ensureFeishuOk<T extends FeishuApiResponse>(context: string, response: T): T {
  if (response.code === undefined || response.code === 0) {
    return response;
  }
  const logId = response.log_id ?? response.logId;
  if (logId) {
    throw new Error(`${context} failed: ${response.msg}, code=${response.code}, log_id=${logId}`);
  }
  throw new Error(`${context} failed: ${response.msg}, code=${response.code}`);
}

async function runTaskApiCall<T extends FeishuApiResponse>(
  context: string,
  fn: () => Promise<T>,
): Promise<T> {
  return ensureFeishuOk(context, await fn());
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

function inferUpdateFields(task: TaskUpdateTask): string[] {
  return Object.keys(task).filter((field) => SUPPORTED_PATCH_FIELDS.has(field));
}

function ensureSupportedUpdateFields(
  updateFields: string[],
  supported: Set<string>,
  resource: "task" | "tasklist" | "comment",
) {
  const invalid = updateFields.filter((field) => !supported.has(field));
  if (invalid.length > 0) {
    throw new Error(`unsupported ${resource} update_fields: ${invalid.join(", ")}`);
  }
}

function inferCommentUpdateFields(comment: Record<string, unknown>): string[] {
  return Object.keys(comment).filter((field) => SUPPORTED_COMMENT_PATCH_FIELDS.has(field));
}

function inferTasklistUpdateFields(tasklist: TasklistPatchTasklist): string[] {
  return Object.keys(tasklist).filter((field) => SUPPORTED_TASKLIST_PATCH_FIELDS.has(field));
}

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
  // The exact response shape can vary by endpoint; normalize common fields.
  return {
    comment_id: comment.comment_id ?? comment.id,
    task_guid: comment.task_guid,
    content: comment.content,
    creator: comment.creator,
    reply_to_comment_id: comment.reply_to_comment_id,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

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
      `file_path exceeds ${(maxBytes / BYTES_PER_MEGABYTE).toFixed(SIZE_DISPLAY_FRACTION_DIGITS)}MB limit: ${filePath}`,
    );
  }
}

async function saveBufferToTempFile(buffer: Buffer, fileName: string) {
  const safeName = sanitizeUploadFilename(fileName);
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "feishu-task-attachment-"));
  const tempPath = path.join(tempDir, safeName);

  await fs.promises.writeFile(tempPath, buffer);

  return {
    tempPath,
    cleanup: async () => {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
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

export async function createTask(client: TaskClient, params: CreateTaskParams) {
  const res = await runTaskApiCall("task.v2.task.create", () =>
    client.task.v2.task.create({
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
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined),
  };
}

export async function createSubtask(client: TaskClient, params: CreateSubtaskParams) {
  const res = await runTaskApiCall("task.v2.taskSubtask.create", () =>
    client.task.v2.taskSubtask.create({
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
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    subtask: formatTask((res.data?.subtask ?? undefined) as Record<string, unknown> | undefined),
  };
}

export async function createTaskComment(client: TaskClient, params: CreateTaskCommentParams) {
  const res = await runTaskApiCall("task.v2.comment.create", () =>
    client.task.v2.comment.create({
      data: omitUndefined({
        resource_type: "task",
        resource_id: params.task_guid,
        content: params.content,
        reply_to_comment_id: params.reply_to_comment_id,
      }),
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  const data = (res.data ?? undefined) as Record<string, unknown> | undefined;
  const comment = (data?.comment ?? data) as Record<string, unknown> | undefined;
  return {
    comment: formatComment(comment),
  };
}

export async function listTaskComments(client: TaskClient, params: ListTaskCommentsParams) {
  const res = await runTaskApiCall("task.v2.comment.list", () =>
    client.task.v2.comment.list({
      params: omitUndefined({
        resource_type: "task",
        resource_id: params.task_guid,
        page_size: params.page_size,
        page_token: params.page_token,
        direction: params.direction,
        user_id_type: params.user_id_type,
      }),
    }),
  );

  const data = (res.data ?? undefined) as Record<string, unknown> | undefined;
  const items = ((data?.items ?? data?.comments ?? []) as Record<string, unknown>[]).map((i) =>
    formatComment(i),
  );

  return {
    task_guid: params.task_guid,
    has_more: (data?.has_more as boolean | undefined) ?? undefined,
    page_token: (data?.page_token as string | undefined) ?? undefined,
    items,
  };
}

export async function getTaskComment(client: TaskClient, params: GetTaskCommentParams) {
  const res = await runTaskApiCall("task.v2.comment.get", () =>
    client.task.v2.comment.get({
      path: { comment_id: params.comment_id },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  const data = (res.data ?? undefined) as Record<string, unknown> | undefined;
  const comment = (data?.comment ?? data) as Record<string, unknown> | undefined;
  return {
    comment: formatComment(comment),
  };
}

export async function updateTaskComment(client: TaskClient, params: UpdateTaskCommentParams) {
  const inferred = inferCommentUpdateFields(params.comment as unknown as Record<string, unknown>);
  const updateFields = (params.update_fields ?? inferred) as string[];
  if (updateFields.length === 0) {
    throw new Error("update_fields is required (or provide comment fields to infer)");
  }
  ensureSupportedUpdateFields(updateFields, SUPPORTED_COMMENT_PATCH_FIELDS, "comment");

  const res = await runTaskApiCall("task.v2.comment.patch", () =>
    client.task.v2.comment.patch({
      path: { comment_id: params.comment_id },
      data: {
        comment: params.comment,
        update_fields: updateFields,
      },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  const data = (res.data ?? undefined) as Record<string, unknown> | undefined;
  const comment = (data?.comment ?? data) as Record<string, unknown> | undefined;
  return {
    comment: formatComment(comment),
  };
}

export async function deleteTaskComment(client: TaskClient, params: DeleteTaskCommentParams) {
  await runTaskApiCall("task.v2.comment.delete", () =>
    client.task.v2.comment.delete({
      path: { comment_id: params.comment_id },
    }),
  );

  return {
    success: true,
    comment_id: params.comment_id,
  };
}

export async function createTasklist(client: TaskClient, params: CreateTasklistParams) {
  const res = await runTaskApiCall("task.v2.tasklist.create", () =>
    client.task.v2.tasklist.create({
      data: omitUndefined({
        name: params.name,
        members: params.members,
        archive_tasklist: params.archive_tasklist,
      }),
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

export async function deleteTaskAttachment(client: TaskClient, params: DeleteTaskAttachmentParams) {
  await runTaskApiCall("task.v2.attachment.delete", () =>
    client.task.v2.attachment.delete({
      path: { attachment_guid: params.attachment_guid },
    }),
  );

  return {
    success: true,
    attachment_guid: params.attachment_guid,
  };
}

export async function deleteTask(client: TaskClient, taskGuid: string) {
  await runTaskApiCall("task.v2.task.delete", () =>
    client.task.v2.task.delete({
      path: { task_guid: taskGuid },
    }),
  );

  return {
    success: true,
    task_guid: taskGuid,
  };
}

export async function deleteTasklist(client: TaskClient, tasklistGuid: string) {
  await runTaskApiCall("task.v2.tasklist.delete", () =>
    client.task.v2.tasklist.delete({
      path: { tasklist_guid: tasklistGuid },
    }),
  );

  return {
    success: true,
    tasklist_guid: tasklistGuid,
  };
}

export async function getTask(client: TaskClient, params: GetTaskParams) {
  const res = await runTaskApiCall("task.v2.task.get", () =>
    client.task.v2.task.get({
      path: { task_guid: params.task_guid },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined),
  };
}

export async function getTasklist(client: TaskClient, params: GetTasklistParams) {
  const res = await runTaskApiCall("task.v2.tasklist.get", () =>
    client.task.v2.tasklist.get({
      path: { tasklist_guid: params.tasklist_guid },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

export async function listTasklistTasks(client: TaskClient, params: ListTasklistTasksParams) {
  const res = await runTaskApiCall(
    "task.v2.tasklist.tasks",
    () =>
      client.request({
        method: "GET",
        url: `/open-apis/task/v2/tasklists/${encodeURIComponent(params.tasklist_guid)}/tasks`,
        params: omitUndefined({
          page_size: params.page_size,
          page_token: params.page_token,
          completed: params.completed,
          created_from: params.created_from,
          created_to: params.created_to,
          user_id_type: params.user_id_type,
        }),
      }) as Promise<{
        code?: number;
        msg?: string;
        log_id?: string;
        data?: {
          items?: Record<string, unknown>[];
          page_token?: string;
          has_more?: boolean;
        };
      }>,
  );

  const items = (res.data?.items ?? []) as Record<string, unknown>[];

  return {
    tasklist_guid: params.tasklist_guid,
    items: items.map((item) => formatTask(item)),
    page_token: res.data?.page_token,
    has_more: res.data?.has_more,
  };
}

export async function listTasklists(client: TaskClient, params: ListTasklistsParams) {
  const res = await runTaskApiCall("task.v2.tasklist.list", () =>
    client.task.v2.tasklist.list({
      params: omitUndefined({
        page_size: params.page_size,
        page_token: params.page_token,
        user_id_type: params.user_id_type,
      }),
    }),
  );

  const items = (res.data?.items ?? []) as Record<string, unknown>[];

  return {
    items: items.map((item) => formatTasklist(item)),
    page_token: res.data?.page_token,
    has_more: res.data?.has_more,
  };
}

export async function getTaskAttachment(client: TaskClient, params: GetTaskAttachmentParams) {
  const res = await runTaskApiCall("task.v2.attachment.get", () =>
    client.task.v2.attachment.get({
      path: { attachment_guid: params.attachment_guid },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    attachment: formatAttachment(
      (res.data?.attachment ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

export async function listTaskAttachments(client: TaskClient, params: ListTaskAttachmentsParams) {
  const res = await runTaskApiCall("task.v2.attachment.list", () =>
    client.task.v2.attachment.list({
      params: omitUndefined({
        resource_type: "task",
        resource_id: params.task_guid,
        page_size: params.page_size,
        page_token: params.page_token,
        updated_mesc: params.updated_mesc,
        user_id_type: params.user_id_type,
      }),
    }),
  );

  const items = (res.data?.items ?? []) as Record<string, unknown>[];

  return {
    items: items.map((item) => formatAttachment(item)),
    page_token: res.data?.page_token,
    has_more: res.data?.has_more,
  };
}

export async function updateTask(client: TaskClient, params: UpdateTaskParams) {
  const task = omitUndefined(params.task as Record<string, unknown>) as TaskUpdateTask;
  const updateFields = params.update_fields?.length
    ? params.update_fields
    : inferUpdateFields(task);
  ensureSupportedUpdateFields(updateFields, SUPPORTED_PATCH_FIELDS, "task");

  if (Object.keys(task).length === 0) {
    throw new Error("task update payload is empty");
  }
  if (updateFields.length === 0) {
    throw new Error("no valid update_fields provided or inferred from task payload");
  }

  const res = await runTaskApiCall("task.v2.task.patch", () =>
    client.task.v2.task.patch({
      path: { task_guid: params.task_guid },
      data: {
        task,
        update_fields: updateFields,
      },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined),
    update_fields: updateFields,
  };
}

export async function addTaskToTasklist(client: TaskClient, params: AddTaskToTasklistParams) {
  const res = await runTaskApiCall("task.v2.task.add_tasklist", () =>
    client.task.v2.task.addTasklist({
      path: { task_guid: params.task_guid },
      data: omitUndefined({
        tasklist_guid: params.tasklist_guid,
        section_guid: params.section_guid,
      }),
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined),
  };
}

export async function removeTaskFromTasklist(
  client: TaskClient,
  params: RemoveTaskFromTasklistParams,
) {
  const res = await runTaskApiCall("task.v2.task.remove_tasklist", () =>
    client.task.v2.task.removeTasklist({
      path: { task_guid: params.task_guid },
      data: omitUndefined({
        tasklist_guid: params.tasklist_guid,
      }),
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined),
  };
}

export async function updateTasklist(client: TaskClient, params: UpdateTasklistParams) {
  const tasklist = omitUndefined(
    params.tasklist as Record<string, unknown>,
  ) as TasklistPatchTasklist;
  const updateFields = params.update_fields?.length
    ? params.update_fields
    : inferTasklistUpdateFields(tasklist);
  ensureSupportedUpdateFields(updateFields, SUPPORTED_TASKLIST_PATCH_FIELDS, "tasklist");

  if (Object.keys(tasklist).length === 0) {
    throw new Error("tasklist update payload is empty");
  }
  if (updateFields.length === 0) {
    throw new Error("no valid update_fields provided or inferred from tasklist payload");
  }

  const res = await runTaskApiCall("task.v2.tasklist.patch", () =>
    client.task.v2.tasklist.patch({
      path: { tasklist_guid: params.tasklist_guid },
      data: omitUndefined({
        tasklist,
        update_fields: updateFields,
        origin_owner_to_role: params.origin_owner_to_role,
      }),
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
    update_fields: updateFields,
  };
}

export async function addTasklistMembers(client: TaskClient, params: AddTasklistMembersParams) {
  const res = await runTaskApiCall("task.v2.tasklist.addMembers", () =>
    client.task.v2.tasklist.addMembers({
      path: { tasklist_guid: params.tasklist_guid },
      data: {
        members: params.members,
      },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

export async function removeTasklistMembers(
  client: TaskClient,
  params: RemoveTasklistMembersParams,
) {
  const res = await runTaskApiCall("task.v2.tasklist.removeMembers", () =>
    client.task.v2.tasklist.removeMembers({
      path: { tasklist_guid: params.tasklist_guid },
      data: {
        members: params.members,
      },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

export async function uploadTaskAttachment(
  client: TaskClient,
  params: UploadTaskAttachmentParams,
  options?: { maxBytes?: number },
) {
  const maxBytes =
    typeof options?.maxBytes === "number" && options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_TASK_ATTACHMENT_MAX_BYTES;

  let tempCleanup: (() => Promise<void>) | undefined;
  let filePath: string;

  if (params.file_path && params.file_url) {
    throw new Error("Provide exactly one of file_path or file_url");
  }

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
    const res = await runTaskApiCall("task.v2.attachment.upload", async () => {
      const uploadResponse = await client.task.v2.attachment.upload({
        data: {
          resource_type: "task",
          resource_id: params.task_guid,
          file: fs.createReadStream(filePath),
        },
        params: omitUndefined({
          user_id_type: params.user_id_type,
        }),
      });

      // Task attachment upload in the Feishu SDK returns `res.data` directly
      // (not the usual `{ code, msg, data }` envelope). Some SDK versions may still
      // expose `{ code, msg }` on failure, so normalize that shape.
      const raw = uploadResponse as {
        code?: number;
        msg?: string;
        log_id?: string;
        logId?: string;
        data?: { items?: Record<string, unknown>[] };
        items?: Record<string, unknown>[];
      } | null;

      return {
        code: raw?.code ?? 0,
        msg: raw?.msg,
        log_id: raw?.log_id ?? raw?.logId,
        data: raw?.data ?? raw,
      };
    });

    const responseData = res.data as
      | {
          items?: Record<string, unknown>[];
          data?: { items?: Record<string, unknown>[] };
        }
      | undefined;
    const items = (responseData?.items ?? responseData?.data?.items ?? []) as Record<
      string,
      unknown
    >[];
    if (items.length === 0) {
      throw new Error("task.v2.attachment.upload failed: no attachment items returned");
    }

    return {
      items: items.map((item) => formatAttachment(item)),
    };
  } finally {
    if (tempCleanup) {
      await tempCleanup();
    }
  }
}
