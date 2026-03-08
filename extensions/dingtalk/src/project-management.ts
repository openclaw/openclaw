/**
 * 钉钉项目管理 API
 *
 * 提供钉钉项目（Teambition）的管理能力:
 * - listProjectSpaces: 查询项目空间列表
 * - listProjectTasks: 查询项目任务列表
 * - getProjectTask: 获取任务详情
 * - createProjectTask: 创建项目任务
 * - updateProjectTask: 更新项目任务
 *
 * API 文档:
 * - 项目空间: https://open.dingtalk.com/document/orgapp/query-project-space
 * - 任务列表: https://open.dingtalk.com/document/orgapp/query-task-list
 * - 任务详情: https://open.dingtalk.com/document/orgapp/query-task-details
 * - 创建任务: https://open.dingtalk.com/document/orgapp/create-a-task
 * - 更新任务: https://open.dingtalk.com/document/orgapp/update-task
 */

import { getAccessToken } from "./client.js";
import { dingtalkLogger } from "./logger.js";
import type { DingtalkConfig } from "./types.js";

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

async function resolveAccessToken(cfg: DingtalkConfig): Promise<string> {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }
  return getAccessToken(cfg.clientId, cfg.clientSecret);
}

// ============================================================================
// 项目管理 API 类型
// ============================================================================

export interface ProjectSpace {
  spaceId?: string;
  name?: string;
  description?: string;
  icon?: string;
  memberCount?: number;
  creatorId?: string;
  createTime?: string;
  modifiedTime?: string;
}

export interface ListProjectSpacesResult {
  result?: {
    items?: ProjectSpace[];
    nextCursor?: string;
    hasMore?: boolean;
  };
}

export interface ProjectTask {
  taskId?: string;
  subject?: string;
  description?: string;
  executorId?: string;
  creatorId?: string;
  priority?: number;
  isDone?: boolean;
  dueDate?: string;
  createTime?: string;
  updateTime?: string;
  labels?: string[];
  spaceId?: string;
  parentTaskId?: string;
}

export interface ListProjectTasksResult {
  result?: {
    items?: ProjectTask[];
    nextCursor?: string;
    hasMore?: boolean;
  };
}

export interface CreateProjectTaskParams {
  subject: string;
  description?: string;
  executorId?: string;
  dueDate?: string;
  priority?: number;
}

export interface UpdateProjectTaskParams {
  subject?: string;
  description?: string;
  executorId?: string;
  dueDate?: string;
  priority?: number;
  isDone?: boolean;
}

// ============================================================================
// 项目管理 API
// ============================================================================

/**
 * 查询项目空间列表
 *
 * 获取用户可见的项目空间列表。
 *
 * @param cfg 钉钉配置
 * @param userId 操作者 userId
 * @param cursor 分页游标
 * @param size 每页大小
 * @returns 项目空间列表
 */
export async function listProjectSpaces(
  cfg: DingtalkConfig,
  userId: string,
  cursor?: string,
  size?: number,
): Promise<ListProjectSpacesResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Listing project spaces for user ${userId}`);

  const query: Record<string, string> = {
    userId,
  };
  if (cursor) query.nextCursor = cursor;
  if (size) query.maxResults = String(size);

  return dingtalkApiRequest<ListProjectSpacesResult>("GET", "/v1.0/project/spaces", accessToken, {
    query,
    operationLabel: "list project spaces",
  });
}

/**
 * 查询项目任务列表
 *
 * @param cfg 钉钉配置
 * @param userId 操作者 userId
 * @param spaceId 项目空间 ID
 * @param cursor 分页游标
 * @param size 每页大小
 * @returns 任务列表
 */
export async function listProjectTasks(
  cfg: DingtalkConfig,
  userId: string,
  spaceId: string,
  cursor?: string,
  size?: number,
): Promise<ListProjectTasksResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Listing tasks in project space ${spaceId} for user ${userId}`);

  const query: Record<string, string> = {
    userId,
  };
  if (cursor) query.nextCursor = cursor;
  if (size) query.maxResults = String(size);

  return dingtalkApiRequest<ListProjectTasksResult>(
    "GET",
    `/v1.0/project/spaces/${spaceId}/tasks`,
    accessToken,
    { query, operationLabel: "list project tasks" },
  );
}

/**
 * 获取项目任务详情
 *
 * @param cfg 钉钉配置
 * @param userId 操作者 userId
 * @param taskId 任务 ID
 * @returns 任务详情
 */
export async function getProjectTask(
  cfg: DingtalkConfig,
  userId: string,
  taskId: string,
): Promise<ProjectTask> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Getting project task ${taskId} for user ${userId}`);

  return dingtalkApiRequest<ProjectTask>("GET", `/v1.0/project/tasks/${taskId}`, accessToken, {
    query: { userId },
    operationLabel: "get project task",
  });
}

/**
 * 创建项目任务
 *
 * @param cfg 钉钉配置
 * @param userId 操作者 userId
 * @param spaceId 项目空间 ID
 * @param params 创建任务参数
 * @returns 创建的任务
 */
export async function createProjectTask(
  cfg: DingtalkConfig,
  userId: string,
  spaceId: string,
  params: CreateProjectTaskParams,
): Promise<ProjectTask> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(
    `Creating project task "${params.subject}" in space ${spaceId} for user ${userId}`,
  );

  const body: Record<string, unknown> = {
    subject: params.subject,
    creatorId: userId,
  };

  if (params.description) body.description = params.description;
  if (params.executorId) body.executorId = params.executorId;
  if (params.dueDate) body.dueDate = params.dueDate;
  if (params.priority !== undefined) body.priority = params.priority;

  const result = await dingtalkApiRequest<ProjectTask>(
    "POST",
    `/v1.0/project/spaces/${spaceId}/tasks`,
    accessToken,
    {
      body,
      query: { userId },
      operationLabel: "create project task",
    },
  );

  dingtalkLogger.info(`Project task created: ${result.taskId}`);
  return result;
}

/**
 * 更新项目任务
 *
 * @param cfg 钉钉配置
 * @param userId 操作者 userId
 * @param taskId 任务 ID
 * @param params 更新参数
 * @returns 更新后的任务
 */
export async function updateProjectTask(
  cfg: DingtalkConfig,
  userId: string,
  taskId: string,
  params: UpdateProjectTaskParams,
): Promise<ProjectTask> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Updating project task ${taskId} for user ${userId}`);

  const body: Record<string, unknown> = {};
  if (params.subject) body.subject = params.subject;
  if (params.description !== undefined) body.description = params.description;
  if (params.executorId) body.executorId = params.executorId;
  if (params.dueDate) body.dueDate = params.dueDate;
  if (params.priority !== undefined) body.priority = params.priority;
  if (params.isDone !== undefined) body.isDone = params.isDone;

  const result = await dingtalkApiRequest<ProjectTask>(
    "PUT",
    `/v1.0/project/tasks/${taskId}`,
    accessToken,
    {
      body,
      query: { userId },
      operationLabel: "update project task",
    },
  );

  dingtalkLogger.info(`Project task updated: ${taskId}`);
  return result;
}
