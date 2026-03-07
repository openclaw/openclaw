/**
 * DingTalk Attendance Management API
 *
 * Provides attendance data query capabilities:
 * - getAttendanceRecords: Get clock-in records
 * - getAttendanceStatus: Get attendance results (attendance status)
 * - getLeaveRecords: Get leave records
 *
 * API Docs:
 * - Clock-in records: https://open.dingtalk.com/document/orgapp/open-attendance-clock-in-data
 * - Attendance results: https://open.dingtalk.com/document/orgapp/obtain-the-attendance-update-data
 * - Leave records: https://open.dingtalk.com/document/orgapp/query-leave-records-by-time
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
// Attendance API Types
// ============================================================================

export interface AttendanceRecord {
  userId?: string;
  checkType?: string;
  timeResult?: string;
  userCheckTime?: number;
  locationResult?: string;
  sourceType?: string;
  baseCheckTime?: number;
  procInstId?: string;
  corpId?: string;
  planId?: string;
  groupId?: number;
  id?: number;
  workDate?: number;
}

export interface AttendanceRecordsResult {
  result?: {
    hasMore?: boolean;
    recordresult?: AttendanceRecord[];
  };
}

export interface AttendanceStatusRecord {
  userId?: string;
  checkType?: string;
  timeResult?: string;
  locationResult?: string;
  baseCheckTime?: number;
  userCheckTime?: number;
  sourceType?: string;
  workDate?: number;
  planId?: string;
  groupId?: number;
  id?: number;
  procInstId?: string;
  approveId?: number;
  corpId?: string;
}

export interface AttendanceStatusResult {
  result?: {
    hasMore?: boolean;
    recordresult?: AttendanceStatusRecord[];
  };
}

export interface LeaveRecord {
  userId?: string;
  durationUnit?: string;
  durationPercent?: number;
  startTime?: number;
  endTime?: number;
  leaveCode?: string;
  leaveReason?: string;
  leaveStatus?: string;
}

export interface LeaveRecordsResult {
  result?: {
    hasMore?: boolean;
    leaveRecords?: LeaveRecord[];
  };
}

// ============================================================================
// Attendance Management API
// ============================================================================

/**
 * Get clock-in records
 *
 * Query clock-in records for specified users within date range.
 *
 * @param cfg DingTalk config
 * @param userIds User userId list
 * @param startDate Start date YYYY-MM-DD
 * @param endDate End date YYYY-MM-DD
 * @returns Clock-in record list
 */
export async function getAttendanceRecords(
  cfg: DingtalkConfig,
  userIds: string[],
  startDate: string,
  endDate: string,
): Promise<AttendanceRecordsResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(
    `Getting attendance records for ${userIds.length} users from ${startDate} to ${endDate}`,
  );

  return dingtalkApiRequest<AttendanceRecordsResult>(
    "POST",
    "/v1.0/attendance/records/query",
    accessToken,
    {
      body: {
        userIds,
        checkDateFrom: `${startDate}T00:00:00+08:00`,
        checkDateTo: `${endDate}T23:59:59+08:00`,
      },
      operationLabel: "get attendance records",
    },
  );
}

/**
 * Get attendance results
 *
 * Query attendance status results for specified users within date range.
 *
 * @param cfg DingTalk config
 * @param userIds User userId list
 * @param startDate Start date YYYY-MM-DD
 * @param endDate End date YYYY-MM-DD
 * @returns Attendance status list
 */
export async function getAttendanceStatus(
  cfg: DingtalkConfig,
  userIds: string[],
  startDate: string,
  endDate: string,
): Promise<AttendanceStatusResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(
    `Getting attendance status for ${userIds.length} users from ${startDate} to ${endDate}`,
  );

  return dingtalkApiRequest<AttendanceStatusResult>(
    "POST",
    "/v1.0/attendance/results/query",
    accessToken,
    {
      body: {
        userIds,
        checkDateFrom: `${startDate}T00:00:00+08:00`,
        checkDateTo: `${endDate}T23:59:59+08:00`,
      },
      operationLabel: "get attendance status",
    },
  );
}

/**
 * Get leave records
 *
 * Query leave/time-off records within specified time range.
 *
 * @param cfg DingTalk config
 * @param startDate Start date YYYY-MM-DD
 * @param endDate End date YYYY-MM-DD
 * @param offset Pagination offset
 * @param size Page size
 * @returns Leave record list
 */
export async function getLeaveRecords(
  cfg: DingtalkConfig,
  startDate: string,
  endDate: string,
  offset?: number,
  size?: number,
): Promise<LeaveRecordsResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Getting leave records from ${startDate} to ${endDate}`);

  return dingtalkApiRequest<LeaveRecordsResult>(
    "POST",
    "/v1.0/attendance/leaves/query",
    accessToken,
    {
      body: {
        startTime: `${startDate}T00:00:00+08:00`,
        endTime: `${endDate}T23:59:59+08:00`,
        offset: offset ?? 0,
        size: size ?? 20,
      },
      operationLabel: "get leave records",
    },
  );
}
