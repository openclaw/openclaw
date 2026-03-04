import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuToolClient, resolveFeishuToolAccount } from "./tool-account.js";
import { resolveToolsConfig } from "./tools-config.js";
import type { FeishuConfig } from "./types.js";
import { buildToolAuthUrl, getUserAccessToken } from "./user-auth.js";

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

type LarkApiResponse = {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
};

/**
 * Shared request helper for Feishu Task v2 API.
 *
 * Bypasses `client.request()` to avoid the SDK's internal `.catch(e => logger.error(e))`
 * which dumps full AxiosError objects to the terminal on HTTP errors.
 * Instead, we call `formatPayload` (to obtain the auth token) and then
 * `httpInstance.request` directly, giving us clean error handling.
 */
async function taskRequest(
  client: Lark.Client,
  opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    data?: Record<string, unknown>;
    query?: Record<string, string>;
    userToken?: string;
  },
): Promise<LarkApiResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- access SDK internals
  const c = client as any;
  const domain: string = c.domain ?? "https://open.feishu.cn";
  const { headers } = await c.formatPayload({}, {});

  // Override authorization with user_access_token when provided
  if (opts.userToken) {
    headers.Authorization = `Bearer ${opts.userToken}`;
  }

  const url = opts.url.startsWith("http") ? opts.url : `${domain}/${opts.url.replace(/^\//, "")}`;
  const requestData = opts.method === "GET" ? undefined : opts.data;

  let res: LarkApiResponse;
  try {
    const raw = await c.httpInstance.request({
      method: opts.method,
      url,
      headers,
      data: requestData,
      params: opts.query,
    });
    res = raw as LarkApiResponse;
  } catch (err: unknown) {
    const resp = (err as { response?: { status?: number; data?: { code?: number; msg?: string } } })
      ?.response;
    const data = resp?.data;
    if (data && typeof data.msg === "string") {
      throw new Error(
        `Feishu task API: ${data.msg}${data.code != null ? ` (code=${data.code})` : ""}`,
      );
    }
    if (resp?.status) {
      throw new Error(`Feishu task API: HTTP ${resp.status} ${opts.method} ${opts.url}`);
    }
    throw err;
  }

  if (res.code !== 0) {
    throw new Error(res.msg ?? `Feishu task API error: code=${res.code}`);
  }

  return res;
}

// ============ Schema ============

const TASK_ACTION_VALUES = [
  "create",
  "get",
  "list",
  "update",
  "complete",
  "delete",
  "add_members",
  "add_comment",
] as const;
const USER_ID_TYPE_VALUES = ["open_id", "user_id", "union_id"] as const;
const MEMBER_ROLE_VALUES = ["assignee", "follower"] as const;

export const FeishuTaskSchema = Type.Object({
  action: Type.Unsafe<(typeof TASK_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...TASK_ACTION_VALUES],
    description:
      "Action: create | get | list | update | complete | delete | add_members | add_comment",
  }),
  task_id: Type.Optional(
    Type.String({
      description: "Task GUID (required for get/update/complete/delete/add_members/add_comment)",
    }),
  ),
  summary: Type.Optional(
    Type.String({
      description: "Task title (required for create, optional for update). Max 256 chars.",
      maxLength: 256,
    }),
  ),
  description: Type.Optional(
    Type.String({ description: "Task description. Max 65536 characters." }),
  ),
  due: Type.Optional(
    Type.String({
      description:
        'Due time as Unix timestamp string (seconds, e.g. "1675742789", or milliseconds, e.g. "1675742789470")',
    }),
  ),
  members: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({
          description: "User ID (open_id, user_id, or union_id per user_id_type)",
        }),
        role: Type.Optional(
          Type.Unsafe<(typeof MEMBER_ROLE_VALUES)[number]>({
            type: "string",
            enum: [...MEMBER_ROLE_VALUES],
            description: "Role: assignee or follower",
          }),
        ),
      }),
      { description: "Task members (for create/add_members)" },
    ),
  ),
  comment: Type.Optional(
    Type.String({ description: "Comment content (required for add_comment)" }),
  ),
  completed: Type.Optional(Type.Boolean({ description: "Filter completed tasks (for list)" })),
  page_size: Type.Optional(Type.Number({ description: "Page size for list (1-100, default 50)" })),
  page_token: Type.Optional(Type.String({ description: "Pagination token (for list)" })),
  user_id_type: Type.Optional(
    Type.Unsafe<(typeof USER_ID_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...USER_ID_TYPE_VALUES],
      description: "User ID type for members (default: open_id)",
    }),
  ),
  accountId: Type.Optional(
    Type.String({ description: "Feishu account ID when multiple configured" }),
  ),
});

export type FeishuTaskParams = Static<typeof FeishuTaskSchema>;

// ============ Action Implementations ============

async function createTask(client: Lark.Client, params: FeishuTaskParams) {
  const body: Record<string, unknown> = { summary: params.summary };
  if (params.description) {
    body.description = params.description;
  }
  if (params.due) {
    body.due = { timestamp: params.due, is_all_day: false };
  }
  if (params.members && params.members.length > 0) {
    body.members = params.members.map((m) => ({
      id: m.id,
      type: "user",
      role: m.role ?? "assignee",
    }));
  }

  const query: Record<string, string> = {};
  if (params.user_id_type) {
    query.user_id_type = params.user_id_type;
  }

  const res = await taskRequest(client, {
    method: "POST",
    url: "/open-apis/task/v2/tasks",
    data: body,
    query,
  });

  const task = res.data?.task as
    | { guid?: string; summary?: string; description?: string; due?: unknown }
    | undefined;
  if (!task?.guid) {
    throw new Error("Feishu task API returned no task guid");
  }

  return {
    task_id: task.guid,
    summary: task.summary,
    description: task.description,
    due: task.due,
  };
}

async function getTask(client: Lark.Client, taskId: string, userIdType?: string) {
  const query: Record<string, string> = {};
  if (userIdType) {
    query.user_id_type = userIdType;
  }

  const res = await taskRequest(client, {
    method: "GET",
    url: `/open-apis/task/v2/tasks/${taskId}`,
    query,
  });

  return res.data?.task ?? res.data;
}

async function listTasks(
  client: Lark.Client,
  opts: {
    pageSize?: number;
    pageToken?: string;
    completed?: boolean;
    userIdType?: string;
    userToken?: string;
  },
) {
  const query: Record<string, string> = {};
  const pageSize = opts.pageSize ? Math.max(1, Math.min(100, opts.pageSize)) : 50;
  query.page_size = String(pageSize);
  if (opts.pageToken) {
    query.page_token = opts.pageToken;
  }
  if (opts.completed !== undefined) {
    query.completed = String(opts.completed);
  }
  if (opts.userIdType) {
    query.user_id_type = opts.userIdType;
  }

  const res = await taskRequest(client, {
    method: "GET",
    url: "/open-apis/task/v2/tasks",
    query,
    userToken: opts.userToken,
  });

  return {
    items: res.data?.items ?? [],
    has_more: res.data?.has_more,
    page_token: res.data?.page_token,
  };
}

async function updateTask(
  client: Lark.Client,
  taskId: string,
  params: FeishuTaskParams,
  opts?: { userToken?: string },
) {
  // Per API docs, members/reminders/tasklists cannot be updated via PATCH;
  // use add_members/remove_members endpoints instead.
  const body: Record<string, unknown> = {};
  const updateFields: string[] = [];

  if (params.summary !== undefined) {
    body.summary = params.summary;
    updateFields.push("summary");
  }
  if (params.description !== undefined) {
    body.description = params.description;
    updateFields.push("description");
  }
  if (params.due !== undefined) {
    if (params.due) {
      body.due = { timestamp: params.due, is_all_day: false };
    }
    // Setting update_fields without the field in body clears it
    updateFields.push("due");
  }

  if (updateFields.length === 0) {
    throw new Error("No fields to update. Provide at least one of: summary, description, due.");
  }

  const query: Record<string, string> = {};
  if (params.user_id_type) {
    query.user_id_type = params.user_id_type;
  }

  const res = await taskRequest(client, {
    method: "PATCH",
    url: `/open-apis/task/v2/tasks/${taskId}`,
    data: { task: body, update_fields: updateFields },
    query,
    userToken: opts?.userToken,
  });

  return res.data?.task ?? res.data;
}

async function completeTask(client: Lark.Client, taskId: string) {
  await taskRequest(client, {
    method: "POST",
    url: `/open-apis/task/v2/tasks/${taskId}/complete`,
  });
  return { task_id: taskId, completed: true };
}

async function deleteTask(client: Lark.Client, taskId: string) {
  await taskRequest(client, {
    method: "DELETE",
    url: `/open-apis/task/v2/tasks/${taskId}`,
  });
  return { task_id: taskId, deleted: true };
}

async function addMembers(
  client: Lark.Client,
  taskId: string,
  members: { id: string; role?: string }[],
  userIdType?: string,
) {
  const query: Record<string, string> = {};
  if (userIdType) {
    query.user_id_type = userIdType;
  }

  const normalizedMembers = members.map((m) => ({
    id: m.id,
    type: "user",
    role: m.role ?? "assignee",
  }));

  const res = await taskRequest(client, {
    method: "POST",
    url: `/open-apis/task/v2/tasks/${taskId}/add_members`,
    data: { members: normalizedMembers },
    query,
  });

  return res.data?.task ?? { task_id: taskId, members_added: members.length };
}

async function addComment(client: Lark.Client, taskId: string, content: string) {
  const res = await taskRequest(client, {
    method: "POST",
    url: `/open-apis/task/v2/tasks/${taskId}/comments`,
    data: { content },
  });

  return res.data?.comment ?? res.data;
}

// ============ Tool Registration ============

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

  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
  if (!toolsCfg.task) {
    api.logger.debug?.("feishu_task: task tool disabled in config (tools.task: true to enable)");
    return;
  }

  api.registerTool(
    (ctx) => ({
      name: "feishu_task",
      label: "Feishu Task",
      description:
        "Feishu task operations (Task v2). Actions: create, get, list, update, complete, delete, add_members, add_comment",
      parameters: FeishuTaskSchema,
      async execute(_toolCallId, rawParams) {
        const params = rawParams as FeishuTaskParams;
        try {
          api.logger.info(
            `feishu_task: action=${params.action} requesterSenderId=${ctx.requesterSenderId ?? "(empty)"} messageChannel=${ctx.messageChannel ?? "(empty)"}`,
          );
          const client = createFeishuToolClient({
            api,
            executeParams: { accountId: params.accountId },
            defaultAccountId: ctx.agentAccountId,
          });
          switch (params.action) {
            case "create": {
              if (!params.summary) {
                return json({ error: "summary is required for create action" });
              }
              return json(await createTask(client, params));
            }
            case "get": {
              if (!params.task_id) {
                return json({ error: "task_id is required for get action" });
              }
              return json(await getTask(client, params.task_id, params.user_id_type));
            }
            case "list": {
              const account = resolveFeishuToolAccount({
                api,
                executeParams: { accountId: params.accountId },
                defaultAccountId: ctx.agentAccountId,
              });

              // Use sender ID when available (group chat); fall back to "owner" for local/web sessions
              const userId = ctx.requesterSenderId?.trim() || "owner";

              const userToken = await getUserAccessToken(client, account.accountId, userId);

              const generateAuthResponse = (error: string, reason: string) => {
                const feishuCfg = api.config?.channels?.feishu as FeishuConfig | undefined;
                let authUrl: string | undefined;
                if (account.appId) {
                  authUrl = buildToolAuthUrl({
                    appId: account.appId,
                    accountId: account.accountId,
                    userId,
                    oauthCallbackUrl: feishuCfg?.oauthCallbackUrl,
                    domain: typeof account.domain === "string" ? account.domain : undefined,
                  });
                }
                return json({
                  error,
                  message:
                    reason +
                    (authUrl
                      ? ` Please click this link to authorize: ${authUrl} (expires in 10 minutes).`
                      : " Tell the user to type /feishu-auth in the chat to authorize.") +
                    " DO NOT fabricate any authorization URLs.",
                  auth_url: authUrl,
                });
              };

              if (!userToken) {
                return generateAuthResponse(
                  "NOT_AUTHORIZED",
                  "Feishu Task v2 list requires user OAuth authorization.",
                );
              }
              try {
                return json(
                  await listTasks(client, {
                    pageSize: params.page_size,
                    pageToken: params.page_token,
                    completed: params.completed,
                    userIdType: params.user_id_type,
                    userToken,
                  }),
                );
              } catch (listErr) {
                const msg = listErr instanceof Error ? listErr.message : String(listErr);
                if (msg.includes("99991663") || msg.includes("Invalid access token")) {
                  return generateAuthResponse(
                    "TOKEN_EXPIRED",
                    "User access token expired or invalid.",
                  );
                }
                throw listErr;
              }
            }
            case "update": {
              if (!params.task_id) {
                return json({ error: "task_id is required for update action" });
              }

              const updateAccount = resolveFeishuToolAccount({
                api,
                executeParams: { accountId: params.accountId },
                defaultAccountId: ctx.agentAccountId,
              });

              const updateUserId = ctx.requesterSenderId?.trim() || "owner";

              const updateToken =
                (await getUserAccessToken(client, updateAccount.accountId, updateUserId)) ??
                undefined;
              return json(
                await updateTask(client, params.task_id, params, { userToken: updateToken }),
              );
            }
            case "complete": {
              if (!params.task_id) {
                return json({ error: "task_id is required for complete action" });
              }
              return json(await completeTask(client, params.task_id));
            }
            case "delete": {
              if (!params.task_id) {
                return json({ error: "task_id is required for delete action" });
              }
              return json(await deleteTask(client, params.task_id));
            }
            case "add_members": {
              if (!params.task_id) {
                return json({ error: "task_id is required for add_members action" });
              }
              if (!params.members || params.members.length === 0) {
                return json({ error: "members is required for add_members action" });
              }
              return json(
                await addMembers(client, params.task_id, params.members, params.user_id_type),
              );
            }
            case "add_comment": {
              if (!params.task_id) {
                return json({ error: "task_id is required for add_comment action" });
              }
              if (!params.comment) {
                return json({ error: "comment is required for add_comment action" });
              }
              return json(await addComment(client, params.task_id, params.comment));
            }
            default:
              return json({ error: `Unknown action: ${String(params.action)}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    }),
    { name: "feishu_task" },
  );

  api.logger.info?.("feishu_task: Registered feishu_task tool");
}
