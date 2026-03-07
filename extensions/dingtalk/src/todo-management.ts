/**
 * 钉钉待办任务管理 API
 *
 * 提供待办任务的完整管理能力:
 * - createTodoTask: 创建待办任务
 * - getTodoTask: 获取待办任务详情
 * - updateTodoTask: 更新待办任务
 * - deleteTodoTask: 删除待办任务
 * - completeTodoTask: 完成待办任务
 * - listTodoTasks: 查询待办任务列表
 *
 * API 文档:
 * - 创建待办: https://open.dingtalk.com/document/development/add-dingtalk-to-do-task
 * - 获取详情: https://open.dingtalk.com/document/development/obtain-dingtalk-pending-tasks-details
 * - 更新待办: https://open.dingtalk.com/document/development/updates-dingtalk-to-do-tasks
 * - 删除待办: https://open.dingtalk.com/document/development/delete-dingtalk-to-do-task
 */

import { getAccessToken } from "./client.js";
import { dingtalkLogger } from "./logger.js";
import type {
  DingtalkConfig,
  CreateTodoParams,
  TodoTask,
  UpdateTodoParams,
  ListTodoParams,
  ListTodoResult,
} from "./types.js";

/** 钉钉 API 基础 URL */
const DINGTALK_API_BASE = "https://api.dingtalk.com";

/** HTTP 请求超时时间（毫秒） */
const REQUEST_TIMEOUT = 30_000;

// ============================================================================
// 内部工具函数
// ============================================================================

interface DingtalkApiErrorResponse {
  code?: string;
  message?: string;
  requestid?: string;
}

/**
 * 发送钉钉 API 请求的通用封装
 */
async function dingtalkApiRequest<ResponseType>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  accessToken: string,
  options?: {
    body?: Record<string, unknown>;
    query?: Record<string, string>;
    operationLabel?: string;
  },
): Promise<ResponseType> {
  const operationLabel = options?.operationLabel ?? `${method} ${path}`;
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    let url = `${DINGTALK_API_BASE}${path}`;

    if (options?.query) {
      const searchParams = new URLSearchParams(options.query);
      url = `${url}?${searchParams.toString()}`;
    }

    const fetchOptions: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      signal: controller.signal,
    };

    if (options?.body && method !== "GET") {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `DingTalk ${operationLabel} failed: HTTP ${response.status}`;

      try {
        const errorData = JSON.parse(errorText) as DingtalkApiErrorResponse;
        if (errorData.message) {
          errorMessage = `DingTalk ${operationLabel} failed: ${errorData.message} (code: ${errorData.code ?? "unknown"}, requestId: ${errorData.requestid ?? "unknown"})`;
        }
      } catch {
        errorMessage = `${errorMessage} - ${errorText}`;
      }

      throw new Error(errorMessage);
    }

    const responseText = await response.text();
    if (!responseText) {
      const elapsed = Date.now() - startTime;
      dingtalkLogger.info?.(`[PERF] API ${operationLabel}: ${elapsed}ms`);
      return {} as ResponseType;
    }

    const elapsed = Date.now() - startTime;
    dingtalkLogger.info?.(`[PERF] API ${operationLabel}: ${elapsed}ms`);
    return JSON.parse(responseText) as ResponseType;
  } catch (error) {
    const elapsed = Date.now() - startTime;
    dingtalkLogger.info?.(`[PERF] API ${operationLabel}: ${elapsed}ms (error)`);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`DingTalk ${operationLabel} timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 验证凭证并获取 Access Token
 */
async function resolveAccessToken(cfg: DingtalkConfig): Promise<string> {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }
  return getAccessToken(cfg.clientId, cfg.clientSecret);
}

// ============================================================================
// 待办任务 API
// ============================================================================

/**
 * 创建待办任务
 *
 * 在钉钉中为指定用户创建一个待办任务，支持设置截止时间、执行者、优先级等。
 *
 * @param cfg 钉钉配置
 * @param operatorUserId 操作者的 unionId
 * @param params 创建待办参数
 * @returns 创建的待办任务信息
 *
 * @example
 * ```ts
 * const task = await createTodoTask(cfg, "user123", {
 *   subject: "完成项目报告",
 *   dueTime: Date.now() + 86400000,
 *   executorIds: ["user456"],
 *   priority: 20,
 * });
 * ```
 */
export async function createTodoTask(
  cfg: DingtalkConfig,
  operatorUserId: string,
  params: CreateTodoParams,
): Promise<TodoTask> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Creating todo task "${params.subject}" for user ${operatorUserId}`);

  const body: Record<string, unknown> = {
    subject: params.subject,
    creatorId: operatorUserId,
  };

  if (params.description) body.description = params.description;
  if (params.dueTime) body.dueTime = params.dueTime;
  if (params.executorIds?.length) body.executorIds = params.executorIds;
  if (params.participantIds?.length) body.participantIds = params.participantIds;
  if (params.priority !== undefined) body.priority = params.priority;
  if (params.isOnlyShowExecutor !== undefined) body.isOnlyShowExecutor = params.isOnlyShowExecutor;

  // detailUrl 用于点击待办跳转的链接
  if (params.detailUrl) {
    body.detailUrl = {
      pcUrl: params.detailUrl,
      appUrl: params.detailUrl,
    };
  }

  // 自定义通知配置
  if (params.notifyConfigs) {
    body.notifyConfigs = params.notifyConfigs;
  }

  const result = await dingtalkApiRequest<TodoTask>(
    "POST",
    `/v1.0/todo/users/${operatorUserId}/tasks`,
    accessToken,
    { body, operationLabel: "create todo task" },
  );

  dingtalkLogger.info(`Todo task created: id=${result.id}, subject="${params.subject}"`);
  return result;
}

/**
 * 获取待办任务详情
 *
 * @param cfg 钉钉配置
 * @param operatorUserId 操作者的 unionId
 * @param taskId 待办任务 ID
 * @returns 待办任务详情
 */
export async function getTodoTask(
  cfg: DingtalkConfig,
  operatorUserId: string,
  taskId: string,
): Promise<TodoTask> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Getting todo task ${taskId} for user ${operatorUserId}`);

  return dingtalkApiRequest<TodoTask>(
    "GET",
    `/v1.0/todo/users/${operatorUserId}/tasks/${taskId}`,
    accessToken,
    { operationLabel: "get todo task" },
  );
}

/**
 * 更新待办任务
 *
 * @param cfg 钉钉配置
 * @param operatorUserId 操作者的 unionId
 * @param taskId 待办任务 ID
 * @param params 更新参数
 * @returns 更新后的待办任务
 */
export async function updateTodoTask(
  cfg: DingtalkConfig,
  operatorUserId: string,
  taskId: string,
  params: UpdateTodoParams,
): Promise<TodoTask> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Updating todo task ${taskId} for user ${operatorUserId}`);

  const body: Record<string, unknown> = {};
  if (params.subject) body.subject = params.subject;
  if (params.description !== undefined) body.description = params.description;
  if (params.dueTime !== undefined) body.dueTime = params.dueTime;
  if (params.done !== undefined) body.done = params.done;
  if (params.executorIds) body.executorIds = params.executorIds;
  if (params.participantIds) body.participantIds = params.participantIds;
  if (params.priority !== undefined) body.priority = params.priority;

  return dingtalkApiRequest<TodoTask>(
    "PUT",
    `/v1.0/todo/users/${operatorUserId}/tasks/${taskId}`,
    accessToken,
    { body, operationLabel: "update todo task" },
  );
}

/**
 * 删除待办任务
 *
 * @param cfg 钉钉配置
 * @param operatorUserId 操作者的 unionId
 * @param taskId 待办任务 ID
 */
export async function deleteTodoTask(
  cfg: DingtalkConfig,
  operatorUserId: string,
  taskId: string,
): Promise<void> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Deleting todo task ${taskId} for user ${operatorUserId}`);

  await dingtalkApiRequest<Record<string, unknown>>(
    "DELETE",
    `/v1.0/todo/users/${operatorUserId}/tasks/${taskId}`,
    accessToken,
    { operationLabel: "delete todo task" },
  );

  dingtalkLogger.info(`Todo task ${taskId} deleted`);
}

/**
 * 完成/取消完成待办任务
 *
 * 更新待办任务执行者的完成状态。
 *
 * @param cfg 钉钉配置
 * @param operatorUserId 操作者的 unionId
 * @param taskId 待办任务 ID
 * @param executorStatusList 执行者状态列表
 */
export async function updateTodoExecutorStatus(
  cfg: DingtalkConfig,
  operatorUserId: string,
  taskId: string,
  executorStatusList: Array<{ id: string; isDone: boolean }>,
): Promise<void> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Updating executor status for todo task ${taskId}`);

  const executorStatusMap: Record<string, string> = {};
  for (const executor of executorStatusList) {
    executorStatusMap[executor.id] = executor.isDone ? "done" : "todo";
  }

  await dingtalkApiRequest<Record<string, unknown>>(
    "PUT",
    `/v1.0/todo/users/${operatorUserId}/tasks/${taskId}/executorStatus`,
    accessToken,
    {
      body: { executorStatusMap },
      operationLabel: "update todo executor status",
    },
  );
}

/**
 * 查询待办任务列表
 *
 * @param cfg 钉钉配置
 * @param operatorUserId 操作者的 unionId
 * @param params 查询参数
 * @returns 待办任务列表（含分页信息）
 */
export async function listTodoTasks(
  cfg: DingtalkConfig,
  operatorUserId: string,
  params?: ListTodoParams,
): Promise<ListTodoResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Listing todo tasks for user ${operatorUserId}`);

  const body: Record<string, unknown> = {};
  if (params?.nextToken) body.nextToken = params.nextToken;
  if (params?.isDone !== undefined) body.isDone = params.isDone;
  if (params?.orderBy) body.orderBy = params.orderBy;
  if (params?.orderDirection) body.orderDirection = params.orderDirection;

  // 待办列表使用 POST 查询
  return dingtalkApiRequest<ListTodoResult>(
    "POST",
    `/v1.0/todo/users/${operatorUserId}/tasks/query`,
    accessToken,
    { body, operationLabel: "list todo tasks" },
  );
}
