import type { TSchema } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import {
  addTaskToTasklist,
  addTasklistMembers,
  createSubtask,
  createTask,
  createTaskComment,
  createTasklist,
  deleteTask,
  deleteTaskAttachment,
  deleteTaskComment,
  deleteTasklist,
  getTask,
  getTaskAttachment,
  getTaskComment,
  getTasklist,
  listTaskAttachments,
  listTaskComments,
  listTasklistTasks,
  listTasklists,
  removeTaskFromTasklist,
  removeTasklistMembers,
  updateTask,
  updateTaskComment,
  updateTasklist,
  uploadTaskAttachment,
  BYTES_PER_MEGABYTE,
  DEFAULT_TASK_MEDIA_MAX_MB,
} from "./task-actions.js";
import {
  type TaskClient,
  AddTaskToTasklistSchema,
  type AddTaskToTasklistParams,
  AddTasklistMembersSchema,
  type AddTasklistMembersParams,
  CreateSubtaskSchema,
  type CreateSubtaskParams,
  CreateTaskCommentSchema,
  type CreateTaskCommentParams,
  CreateTaskSchema,
  type CreateTaskParams,
  CreateTasklistSchema,
  type CreateTasklistParams,
  DeleteTaskAttachmentSchema,
  type DeleteTaskAttachmentParams,
  DeleteTaskCommentSchema,
  type DeleteTaskCommentParams,
  DeleteTaskSchema,
  type DeleteTaskParams,
  DeleteTasklistSchema,
  type DeleteTasklistParams,
  GetTaskAttachmentSchema,
  type GetTaskAttachmentParams,
  GetTaskCommentSchema,
  type GetTaskCommentParams,
  GetTaskSchema,
  type GetTaskParams,
  GetTasklistSchema,
  type GetTasklistParams,
  ListTaskAttachmentsSchema,
  type ListTaskAttachmentsParams,
  ListTasklistTasksSchema,
  type ListTasklistTasksParams,
  ListTaskCommentsSchema,
  type ListTaskCommentsParams,
  ListTasklistsSchema,
  type ListTasklistsParams,
  RemoveTaskFromTasklistSchema,
  type RemoveTaskFromTasklistParams,
  RemoveTasklistMembersSchema,
  type RemoveTasklistMembersParams,
  UpdateTaskCommentSchema,
  type UpdateTaskCommentParams,
  UpdateTaskSchema,
  type UpdateTaskParams,
  UpdateTasklistSchema,
  type UpdateTasklistParams,
  UploadTaskAttachmentSchema,
  type UploadTaskAttachmentParams,
} from "./task-schema.js";
import {
  createFeishuToolClient,
  resolveAnyEnabledFeishuToolsConfig,
  resolveFeishuToolAccount,
} from "./tool-account.js";
import { resolveToolsConfig } from "./tools-config.js";
import type { ResolvedFeishuAccount } from "./types.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function errorResult(err: unknown) {
  return json({ error: err instanceof Error ? err.message : String(err) });
}

type TaskToolSpec<P> = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  run: (
    args: { client: TaskClient; account: ResolvedFeishuAccount },
    params: P,
  ) => Promise<unknown>;
};

function registerTaskTool<P>(api: OpenClawPluginApi, spec: TaskToolSpec<P>) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters,
        async execute(_toolCallId, params) {
          const p = params as P & { accountId?: string };
          try {
            const account = resolveFeishuToolAccount({
              api,
              executeParams: p,
              defaultAccountId,
            });
            if (!account.enabled) {
              throw new Error(`Feishu account "${account.accountId}" is disabled`);
            }
            if (!account.configured) {
              throw new Error(`Feishu account "${account.accountId}" is not configured`);
            }

            const toolsCfg = resolveToolsConfig(account.config.tools);
            if (!toolsCfg.task) {
              throw new Error(
                `Feishu tool "${spec.name}" is disabled for account "${account.accountId}"`,
              );
            }

            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId,
            }) as TaskClient;
            return json(await spec.run({ client, account }, p));
          } catch (err) {
            return errorResult(err);
          }
        },
      };
    },
    { name: spec.name },
  );
}

export function registerFeishuTaskTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_task: No config available, skipping task tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_task: No Feishu accounts configured, skipping task tools");
    return;
  }

  // Register if enabled on any account; account routing is resolved per execution.
  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.task) {
    api.logger.debug?.("feishu_task: task tools disabled in config");
    return;
  }

  registerTaskTool<CreateTaskParams>(api, {
    name: "feishu_task_create",
    label: "Feishu Task Create",
    description: "Create a Feishu task (task v2)",
    parameters: CreateTaskSchema,
    run: async ({ client }, params) => createTask(client, params),
  });

  registerTaskTool<CreateSubtaskParams>(api, {
    name: "feishu_task_subtask_create",
    label: "Feishu Task Subtask Create",
    description: "Create a Feishu subtask under a parent task (task v2)",
    parameters: CreateSubtaskSchema,
    run: async ({ client }, params) => createSubtask(client, params),
  });

  registerTaskTool<AddTaskToTasklistParams>(api, {
    name: "feishu_task_add_tasklist",
    label: "Feishu Task Add Tasklist",
    description: "Add a task into a tasklist (task v2)",
    parameters: AddTaskToTasklistSchema,
    run: async ({ client }, params) => addTaskToTasklist(client, params),
  });

  registerTaskTool<RemoveTaskFromTasklistParams>(api, {
    name: "feishu_task_remove_tasklist",
    label: "Feishu Task Remove Tasklist",
    description: "Remove a task from a tasklist (task v2)",
    parameters: RemoveTaskFromTasklistSchema,
    run: async ({ client }, params) => removeTaskFromTasklist(client, params),
  });

  registerTaskTool<CreateTasklistParams>(api, {
    name: "feishu_tasklist_create",
    label: "Feishu Tasklist Create",
    description: "Create a Feishu tasklist (task v2)",
    parameters: CreateTasklistSchema,
    run: async ({ client }, params) => createTasklist(client, params),
  });

  registerTaskTool<GetTasklistParams>(api, {
    name: "feishu_tasklist_get",
    label: "Feishu Tasklist Get",
    description: "Get a Feishu tasklist by tasklist_guid (task v2)",
    parameters: GetTasklistSchema,
    run: async ({ client }, params) => getTasklist(client, params),
  });

  registerTaskTool<ListTasklistTasksParams>(api, {
    name: "feishu_tasklist_get_tasks",
    label: "Feishu Tasklist Get Tasks",
    description:
      "List tasks under a specific Feishu tasklist by tasklist_guid (task v2, paginated)",
    parameters: ListTasklistTasksSchema,
    run: async ({ client }, params) => listTasklistTasks(client, params),
  });

  registerTaskTool<ListTasklistsParams>(api, {
    name: "feishu_tasklist_list",
    label: "Feishu Tasklist List",
    description: "List Feishu tasklists (task v2)",
    parameters: ListTasklistsSchema,
    run: async ({ client }, params) => listTasklists(client, params),
  });

  registerTaskTool<UpdateTasklistParams>(api, {
    name: "feishu_tasklist_update",
    label: "Feishu Tasklist Update",
    description: "Update a Feishu tasklist by tasklist_guid (task v2 patch)",
    parameters: UpdateTasklistSchema,
    run: async ({ client }, params) => updateTasklist(client, params),
  });

  registerTaskTool<DeleteTasklistParams>(api, {
    name: "feishu_tasklist_delete",
    label: "Feishu Tasklist Delete",
    description: "Delete a Feishu tasklist by tasklist_guid (task v2)",
    parameters: DeleteTasklistSchema,
    run: async ({ client }, params) => {
      if (!params.tasklist_guid) {
        throw new Error("tasklist_guid is required");
      }
      return deleteTasklist(client, params.tasklist_guid);
    },
  });

  registerTaskTool<AddTasklistMembersParams>(api, {
    name: "feishu_tasklist_add_members",
    label: "Feishu Tasklist Add Members",
    description: "Add members to a Feishu tasklist (task v2)",
    parameters: AddTasklistMembersSchema,
    run: async ({ client }, params) => addTasklistMembers(client, params),
  });

  registerTaskTool<RemoveTasklistMembersParams>(api, {
    name: "feishu_tasklist_remove_members",
    label: "Feishu Tasklist Remove Members",
    description: "Remove members from a Feishu tasklist (task v2)",
    parameters: RemoveTasklistMembersSchema,
    run: async ({ client }, params) => removeTasklistMembers(client, params),
  });

  registerTaskTool<CreateTaskCommentParams>(api, {
    name: "feishu_task_comment_create",
    label: "Feishu Task Comment Create",
    description: "Create a comment on a Feishu task (task v2)",
    parameters: CreateTaskCommentSchema,
    run: async ({ client }, params) => createTaskComment(client, params),
  });

  registerTaskTool<ListTaskCommentsParams>(api, {
    name: "feishu_task_comment_list",
    label: "Feishu Task Comment List",
    description: "List comments for a Feishu task (task v2)",
    parameters: ListTaskCommentsSchema,
    run: async ({ client }, params) => listTaskComments(client, params),
  });

  registerTaskTool<GetTaskCommentParams>(api, {
    name: "feishu_task_comment_get",
    label: "Feishu Task Comment Get",
    description: "Get a Feishu task comment by comment_id (task v2)",
    parameters: GetTaskCommentSchema,
    run: async ({ client }, params) => getTaskComment(client, params),
  });

  registerTaskTool<UpdateTaskCommentParams>(api, {
    name: "feishu_task_comment_update",
    label: "Feishu Task Comment Update",
    description: "Update a Feishu task comment by comment_id (task v2 patch)",
    parameters: UpdateTaskCommentSchema,
    run: async ({ client }, params) => updateTaskComment(client, params),
  });

  registerTaskTool<DeleteTaskCommentParams>(api, {
    name: "feishu_task_comment_delete",
    label: "Feishu Task Comment Delete",
    description: "Delete a Feishu task comment by comment_id (task v2)",
    parameters: DeleteTaskCommentSchema,
    run: async ({ client }, params) => deleteTaskComment(client, params),
  });

  registerTaskTool<UploadTaskAttachmentParams>(api, {
    name: "feishu_task_attachment_upload",
    label: "Feishu Task Attachment Upload",
    description: "Upload an attachment to a Feishu task (task v2)",
    parameters: UploadTaskAttachmentSchema,
    run: async ({ client, account }, params) => {
      const mediaMaxBytes =
        (account.config?.mediaMaxMb ?? DEFAULT_TASK_MEDIA_MAX_MB) * BYTES_PER_MEGABYTE;
      return uploadTaskAttachment(client, params, { maxBytes: mediaMaxBytes });
    },
  });

  registerTaskTool<ListTaskAttachmentsParams>(api, {
    name: "feishu_task_attachment_list",
    label: "Feishu Task Attachment List",
    description: "List attachments for a Feishu task (task v2)",
    parameters: ListTaskAttachmentsSchema,
    run: async ({ client }, params) => listTaskAttachments(client, params),
  });

  registerTaskTool<GetTaskAttachmentParams>(api, {
    name: "feishu_task_attachment_get",
    label: "Feishu Task Attachment Get",
    description: "Get a Feishu task attachment by attachment_guid (task v2)",
    parameters: GetTaskAttachmentSchema,
    run: async ({ client }, params) => getTaskAttachment(client, params),
  });

  registerTaskTool<DeleteTaskAttachmentParams>(api, {
    name: "feishu_task_attachment_delete",
    label: "Feishu Task Attachment Delete",
    description: "Delete a Feishu task attachment by attachment_guid (task v2)",
    parameters: DeleteTaskAttachmentSchema,
    run: async ({ client }, params) => deleteTaskAttachment(client, params),
  });

  registerTaskTool<DeleteTaskParams>(api, {
    name: "feishu_task_delete",
    label: "Feishu Task Delete",
    description: "Delete a Feishu task by task_guid (task v2)",
    parameters: DeleteTaskSchema,
    run: async ({ client }, { task_guid }) => deleteTask(client, task_guid),
  });

  registerTaskTool<GetTaskParams>(api, {
    name: "feishu_task_get",
    label: "Feishu Task Get",
    description: "Get Feishu task details by task_guid (task v2)",
    parameters: GetTaskSchema,
    run: async ({ client }, params) => getTask(client, params),
  });

  registerTaskTool<UpdateTaskParams>(api, {
    name: "feishu_task_update",
    label: "Feishu Task Update",
    description: "Update a Feishu task by task_guid (task v2 patch)",
    parameters: UpdateTaskSchema,
    run: async ({ client }, params) => updateTask(client, params),
  });

  api.logger.info?.(
    "feishu_task: Registered task, tasklist, tasklist-task, subtask, comment, and attachment tools",
  );
}
