/**
 * DingTalk Contact Management API
 *
 * Provides contact directory query capabilities:
 * - listDepartments: Query sub-department list
 * - getDepartment: Get department details
 * - listDepartmentUsers: Query department user list
 * - getUserInfo: Get user details
 *
 * API Docs:
 * - Department list: https://open.dingtalk.com/document/orgapp/obtain-the-department-list-v2
 * - Department details: https://open.dingtalk.com/document/orgapp/query-department-details0-v2
 * - Department users: https://open.dingtalk.com/document/orgapp/queries-the-complete-information-of-a-department-user
 * - User details: https://open.dingtalk.com/document/orgapp/query-user-details
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
// Contact API Types
// ============================================================================

export interface DepartmentInfo {
  deptId?: number;
  name?: string;
  parentId?: number;
  createDeptGroup?: boolean;
  autoAddUser?: boolean;
}

export interface DepartmentDetail {
  deptId?: number;
  name?: string;
  parentId?: number;
  sourceIdentifier?: string;
  createDeptGroup?: boolean;
  autoAddUser?: boolean;
  deptGroupChatId?: string;
  brief?: string;
  order?: number;
  deptManagerUseridList?: string[];
}

export interface UserInfo {
  userid?: string;
  unionid?: string;
  name?: string;
  avatar?: string;
  mobile?: string;
  email?: string;
  orgEmail?: string;
  title?: string;
  workPlace?: string;
  deptIdList?: number[];
  deptOrderList?: Array<{ deptId: number; order: number }>;
  hiredDate?: number;
  jobNumber?: string;
  active?: boolean;
  admin?: boolean;
  boss?: boolean;
  leader?: boolean;
}

export interface ListDepartmentsResult {
  result?: DepartmentInfo[];
}

export interface ListDepartmentUsersResult {
  result?: {
    hasMore?: boolean;
    nextCursor?: number;
    list?: UserInfo[];
  };
}

// ============================================================================
// Contact Management API
// ============================================================================

/**
 * Query sub-department list
 *
 * @param cfg DingTalk config
 * @param departmentId Parent department ID, pass 1 for root department
 * @returns Sub-department list
 */
export async function listDepartments(
  cfg: DingtalkConfig,
  departmentId: string,
): Promise<ListDepartmentsResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Listing sub-departments of department ${departmentId}`);

  return dingtalkApiRequest<ListDepartmentsResult>(
    "POST",
    "/v1.0/contact/departments/listSubDepartmentIds",
    accessToken,
    {
      body: { deptId: Number(departmentId) },
      operationLabel: "list departments",
    },
  );
}

/**
 * Get department details
 *
 * @param cfg DingTalk config
 * @param departmentId Department ID
 * @returns Department details
 */
export async function getDepartment(
  cfg: DingtalkConfig,
  departmentId: string,
): Promise<DepartmentDetail> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Getting department details for ${departmentId}`);

  return dingtalkApiRequest<DepartmentDetail>(
    "GET",
    `/v1.0/contact/departments/${departmentId}`,
    accessToken,
    { operationLabel: "get department" },
  );
}

/**
 * Query department user details list
 *
 * @param cfg DingTalk config
 * @param departmentId Department ID
 * @param cursor Pagination cursor
 * @param size Page size
 * @returns User list
 */
export async function listDepartmentUsers(
  cfg: DingtalkConfig,
  departmentId: string,
  cursor?: string,
  size?: number,
): Promise<ListDepartmentUsersResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Listing users in department ${departmentId}`);

  return dingtalkApiRequest<ListDepartmentUsersResult>(
    "POST",
    "/v1.0/contact/users/listByDepartment",
    accessToken,
    {
      body: {
        deptId: Number(departmentId),
        cursor: cursor ? Number(cursor) : 0,
        size: size ?? 20,
      },
      operationLabel: "list department users",
    },
  );
}

/**
 * Get user details
 *
 * @param cfg DingTalk config
 * @param userId User userId
 * @returns User details
 */
export async function getUserInfo(cfg: DingtalkConfig, userId: string): Promise<UserInfo> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Getting user info for ${userId}`);

  return dingtalkApiRequest<UserInfo>("GET", `/v1.0/contact/users/${userId}`, accessToken, {
    operationLabel: "get user info",
  });
}

// ============================================================================
// Query User Details by staffId (Legacy API)
// ============================================================================

/** Legacy API base URL */
const DINGTALK_OAPI_BASE = "https://oapi.dingtalk.com";

interface OapiUserGetResponse {
  errcode?: number;
  errmsg?: string;
  result?: UserInfo;
  request_id?: string;
}

/**
 * Query user details by staffId (userid)
 *
 * Uses legacy API POST /topapi/v2/user/get, accepts staffId/userid as parameter.
 * New version GET /v1.0/contact/users/{id} path parameter actually requires unionId,
 * while Stream SDK's senderId is staffId, so this function is needed for conversion.
 *
 * @param cfg DingTalk config
 * @param staffId User's staffId (i.e., userid, e.g., 024555303506893180657)
 * @returns User details (includes unionid)
 *
 * @see https://open.dingtalk.com/document/orgapp/query-user-details
 */
export async function getUserInfoByStaffId(
  cfg: DingtalkConfig,
  staffId: string,
): Promise<UserInfo> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Getting user info by staffId for ${staffId}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const url = `${DINGTALK_OAPI_BASE}/topapi/v2/user/get?access_token=${accessToken}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userid: staffId }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`DingTalk get user by staffId failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as OapiUserGetResponse;

    if (data.errcode !== 0) {
      throw new Error(
        `DingTalk get user by staffId failed: ${data.errmsg ?? "unknown error"} (code: ${data.errcode}, requestId: ${data.request_id ?? "unknown"})`,
      );
    }

    if (!data.result) {
      throw new Error("DingTalk get user by staffId returned empty result");
    }

    return data.result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`DingTalk get user by staffId timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Get User Info by Auth Code
// ============================================================================

/**
 * Response for getting user info by auth code
 *
 * API: POST /v1.0/contact/users/me
 * Docs: https://open.dingtalk.com/document/development/obtain-the-userid-of-a-user-by-using-the-log-free
 */
export interface AuthCodeUserInfo {
  /** User's userId */
  userid?: string;
  /** User's unionId */
  unionId?: string;
  /** User name */
  name?: string;
  /** User avatar URL */
  avatarUrl?: string;
  /** Mobile number */
  mobile?: string;
  /** Email */
  email?: string;
  /** Device ID */
  deviceId?: string;
  /** Whether is admin */
  admin?: boolean;
  /** Whether is super admin */
  superAdmin?: boolean;
  /** Associated organization ID */
  associatedUnionId?: string;
}

/**
 * Get user info by auth code
 *
 * Inside DingTalk app (H5 micro-app, mini program, etc.), frontend gets auth code via JSAPI,
 * backend uses this function to exchange authCode for user's userId and other info.
 *
 * @param cfg DingTalk config
 * @param authCode Auth code obtained from frontend
 * @returns User info (includes userid, unionId, name, etc.)
 *
 * @see https://open.dingtalk.com/document/development/obtain-the-userid-of-a-user-by-using-the-log-free
 */
export async function getUserByAuthCode(
  cfg: DingtalkConfig,
  authCode: string,
): Promise<AuthCodeUserInfo> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info("Getting user info by auth code");

  return dingtalkApiRequest<AuthCodeUserInfo>("POST", "/v1.0/contact/users/me", accessToken, {
    body: { code: authCode },
    operationLabel: "get user by auth code",
  });
}
