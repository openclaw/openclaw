/**
 * DingTalk OA Approval Management API
 *
 * Provides approval process management capabilities:
 * - listApprovalTemplates: Query approval template list
 * - createApprovalInstance: Initiate approval instance
 * - getApprovalInstance: Get approval instance details
 * - listApprovalInstances: Query approval instance list
 *
 * API Docs:
 * - Approval templates: https://open.dingtalk.com/document/orgapp/obtain-the-form-schema
 * - Create approval: https://open.dingtalk.com/document/orgapp/create-an-approval-instance
 * - Approval details: https://open.dingtalk.com/document/orgapp/obtains-the-details-of-a-single-approval-instance
 * - Approval list: https://open.dingtalk.com/document/orgapp/list-of-approval-instance-ids
 */

import { getAccessToken } from "./client.js";
import { dingtalkLogger } from "./logger.js";
import type { DingtalkConfig } from "./types.js";

/** DingTalk API base URL */
const DINGTALK_API_BASE = "https://api.dingtalk.com";

/** HTTP request timeout (milliseconds) */
const REQUEST_TIMEOUT = 30_000;

// ============================================================================
// Internal Utility Functions
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
      return {} as ResponseType;
    }

    return JSON.parse(responseText) as ResponseType;
  } catch (error) {
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
// Approval API Types
// ============================================================================

export interface ApprovalTemplate {
  name?: string;
  processCode?: string;
  iconUrl?: string;
  url?: string;
}

export interface ListApprovalTemplatesResult {
  result?: {
    processList?: ApprovalTemplate[];
    nextCursor?: number;
    hasMore?: boolean;
  };
}

export interface ApprovalFormValue {
  name: string;
  value: string;
}

export interface ApprovalInstance {
  title?: string;
  createTime?: string;
  finishTime?: string;
  originatorUserId?: string;
  originatorDeptId?: string;
  originatorDeptName?: string;
  status?: string;
  result?: string;
  businessId?: string;
  operationRecords?: Array<{
    userId?: string;
    date?: string;
    type?: string;
    result?: string;
    remark?: string;
  }>;
  tasks?: Array<{
    taskId?: number;
    userId?: string;
    status?: string;
    result?: string;
    createTime?: string;
    finishTime?: string;
  }>;
  formComponentValues?: Array<{
    name?: string;
    value?: string;
    componentType?: string;
    id?: string;
  }>;
}

export interface GetApprovalInstanceResult {
  result?: ApprovalInstance;
}

export interface ListApprovalInstancesResult {
  result?: {
    list?: string[];
    nextCursor?: number;
    hasMore?: boolean;
  };
}

// ============================================================================
// Approval Management API
// ============================================================================

/**
 * Query approval template list
 *
 * Get list of available approval templates for the enterprise.
 *
 * @param cfg DingTalk config
 * @param userId Operator userId
 * @param cursor Pagination cursor
 * @param size Page size
 * @returns Approval template list
 */
export async function listApprovalTemplates(
  cfg: DingtalkConfig,
  userId: string,
  cursor?: string,
  size?: number,
): Promise<ListApprovalTemplatesResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Listing approval templates for user ${userId}`);

  return dingtalkApiRequest<ListApprovalTemplatesResult>(
    "POST",
    "/v1.0/workflow/processes/managements/templates",
    accessToken,
    {
      body: {
        userId,
        offset: cursor ? Number(cursor) : 0,
        size: size ?? 100,
      },
      operationLabel: "list approval templates",
    },
  );
}

/**
 * Create approval instance
 *
 * Initiate an approval process on behalf of specified user.
 *
 * @param cfg DingTalk config
 * @param userId Initiator userId
 * @param processCode Approval template processCode
 * @param departmentId Initiator department ID
 * @param formValues Form field values
 * @param approvers Approver userId list
 * @returns Approval instance ID
 */
export async function createApprovalInstance(
  cfg: DingtalkConfig,
  userId: string,
  processCode: string,
  departmentId: string,
  formValues: ApprovalFormValue[],
  approvers?: string[],
): Promise<{ instanceId: string }> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Creating approval instance with template ${processCode} for user ${userId}`);

  const body: Record<string, unknown> = {
    originatorUserId: userId,
    processCode,
    deptId: Number(departmentId),
    formComponentValues: formValues.map((field) => ({
      name: field.name,
      value: field.value,
    })),
  };

  if (approvers?.length) {
    body.approvers = approvers.map((approverId) => ({
      actionType: "NONE",
      userIds: [approverId],
    }));
  }

  const result = await dingtalkApiRequest<{ result?: { instanceId?: string } }>(
    "POST",
    "/v1.0/workflow/processInstances",
    accessToken,
    { body, operationLabel: "create approval instance" },
  );

  const instanceId = result.result?.instanceId;
  if (!instanceId) {
    throw new Error("DingTalk create approval response missing instanceId");
  }

  dingtalkLogger.info(`Approval instance created: ${instanceId}`);
  return { instanceId };
}

/**
 * Get approval instance details
 *
 * @param cfg DingTalk config
 * @param instanceId Approval instance ID
 * @returns Approval instance details
 */
export async function getApprovalInstance(
  cfg: DingtalkConfig,
  instanceId: string,
): Promise<GetApprovalInstanceResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Getting approval instance ${instanceId}`);

  return dingtalkApiRequest<GetApprovalInstanceResult>(
    "GET",
    `/v1.0/workflow/processInstances/${instanceId}`,
    accessToken,
    { operationLabel: "get approval instance" },
  );
}

/**
 * Query approval instance ID list
 *
 * Query approval instance ID list by template and time range.
 *
 * @param cfg DingTalk config
 * @param processCode Approval template processCode
 * @param startTime Start time ISO 8601
 * @param endTime End time ISO 8601
 * @param cursor Pagination cursor
 * @param size Page size
 * @returns Approval instance ID list
 */
export async function listApprovalInstances(
  cfg: DingtalkConfig,
  processCode: string,
  startTime: string,
  endTime: string,
  cursor?: string,
  size?: number,
): Promise<ListApprovalInstancesResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(
    `Listing approval instances for template ${processCode} from ${startTime} to ${endTime}`,
  );

  return dingtalkApiRequest<ListApprovalInstancesResult>(
    "POST",
    "/v1.0/workflow/processInstances/ids/query",
    accessToken,
    {
      body: {
        processCode,
        startTime: new Date(startTime).getTime(),
        endTime: new Date(endTime).getTime(),
        nextCursor: cursor ? Number(cursor) : 0,
        size: size ?? 10,
      },
      operationLabel: "list approval instances",
    },
  );
}
