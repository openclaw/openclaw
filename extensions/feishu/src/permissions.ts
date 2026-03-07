/**
 * Shared permission error handling for Feishu API operations.
 *
 * When a Feishu API call fails due to missing scopes, this module generates
 * a user-friendly error message with the exact scope name and a direct link
 * to the Feishu Open Platform permission console.
 */

import type { FeishuDomain } from "./types.js";

/** Well-known Feishu API error codes that indicate permission issues. */
const PERMISSION_ERROR_CODES = new Set([
  99991668, // No permission
  99991672, // Insufficient scope
]);

/** Known scopes and their human-readable labels. */
export const FEISHU_SCOPE_LABELS: Record<string, string> = {
  "contact:user.base:readonly": "Read user basic info",
  "contact:user.employee_id:readonly": "Read user employee ID",
  "im:chat:readonly": "Read chat/group info",
  "im:message:send_as_bot": "Send messages as bot",
  "im:resource": "Upload/download message resources",
  "calendar:calendar": "Create/modify calendar events",
  "calendar:calendar:readonly": "Read calendar info",
  "drive:drive": "Access cloud drive",
  "drive:permission": "Manage document permissions",
};

/**
 * Check whether a Feishu API error code indicates a permission issue.
 */
export function isPermissionError(code: number | undefined): boolean {
  return code !== undefined && PERMISSION_ERROR_CODES.has(code);
}

/**
 * Format a user-friendly permission error message with a link to the
 * Feishu Open Platform console to enable the required scope.
 */
export function formatPermissionError(params: {
  appId: string;
  scope: string;
  domain?: FeishuDomain;
}): string {
  const { appId, scope, domain } = params;
  const label = FEISHU_SCOPE_LABELS[scope] ?? scope;
  const base = domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";

  return [
    `Feishu bot missing permission: ${label}`,
    `  Scope: ${scope}`,
    `  Enable at: ${base}/app/${appId}/security/permission`,
  ].join("\n");
}

/**
 * Extract error code from a Feishu SDK / API response.
 * Works with both thrown errors and non-throwing responses.
 */
export function extractFeishuErrorCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: number }).code;
  return typeof code === "number" ? code : undefined;
}

/**
 * Check a Feishu API error and return a permission error message if applicable.
 * Returns undefined if the error is not permission-related.
 */
export function checkPermissionError(
  err: unknown,
  appId: string,
  scope: string,
  domain?: FeishuDomain,
): string | undefined {
  const code = extractFeishuErrorCode(err);
  if (!isPermissionError(code)) return undefined;
  return formatPermissionError({ appId, scope, domain });
}
