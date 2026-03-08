/**
 * DingTalk Group Management API
 *
 * Provides complete scene group management capabilities:
 * - createGroup: Create scene group
 * - updateGroup: Update group config (name, owner, permissions, etc.)
 * - addGroupMembers: Add group members
 * - removeGroupMembers: Remove group members
 * - listGroupMembers: Query group member list (supports pagination)
 * - listAllGroupMembers: Query all group members (auto-pagination)
 * - getGroupInfo: Query group info
 * - dismissGroup: Dismiss group
 *
 * API Docs:
 * - Scene group overview: https://open.dingtalk.com/document/group/api-overview-for-a-scene-group
 * - Create group: https://open.dingtalk.com/document/orgapp/create-scene-group-session
 * - Update group: https://open.dingtalk.com/document/orgapp/modify-a-group-session
 */

import { getAccessToken } from "./client.js";
import { dingtalkLogger } from "./logger.js";
import type {
  DingtalkConfig,
  CreateGroupParams,
  CreateGroupResult,
  UpdateGroupParams,
  AddGroupMembersParams,
  RemoveGroupMembersParams,
  ListGroupMembersParams,
  ListGroupMembersResult,
  GetGroupInfoParams,
  GroupInfo,
} from "./types.js";

/** DingTalk API base URL */
const DINGTALK_API_BASE = "https://api.dingtalk.com";

/** HTTP request timeout (milliseconds) */
const REQUEST_TIMEOUT = 30_000;

/** Default page size for pagination queries */
const DEFAULT_PAGE_SIZE = 100;

/** Maximum page size for pagination queries */
const MAX_PAGE_SIZE = 1000;

// ============================================================================
// Internal Utility Functions
// ============================================================================

/**
 * DingTalk API error response structure
 */
interface DingtalkApiErrorResponse {
  code?: string;
  message?: string;
  requestid?: string;
}

/**
 * Generic wrapper for sending DingTalk API requests
 *
 * Unified handling of authentication, timeout, error parsing, etc., avoiding
 * duplicate implementation in each API method.
 *
 * @param method HTTP method
 * @param path API path (without base URL)
 * @param accessToken Access token
 * @param options Request options
 * @returns Parsed JSON response
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

    // Some DELETE operations may return empty response
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

/**
 * Validate credentials and get Access Token
 *
 * @param cfg DingTalk config
 * @returns Access Token string
 * @throws Error if credentials not configured
 */
async function resolveAccessToken(cfg: DingtalkConfig): Promise<string> {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }
  return getAccessToken(cfg.clientId, cfg.clientSecret);
}

// ============================================================================
// Group Management API
// ============================================================================

/**
 * Create scene group
 *
 * Create a new scene group based on group template ID. Need to create group template
 * in DingTalk Open Platform first.
 *
 * @param cfg DingTalk config
 * @param params Create group parameters
 * @returns Create result (includes openConversationId and chatId)
 * @throws Error if credentials not configured or API call fails
 *
 * @example
 * ```ts
 * const result = await createGroup(cfg, {
 *   templateId: "template_xxx",
 *   ownerUserId: "user123",
 *   title: "AI Assistant Group",
 *   userIds: ["user456", "user789"],
 * });
 * console.log(result.openConversationId);
 * ```
 */
export async function createGroup(
  cfg: DingtalkConfig,
  params: CreateGroupParams,
): Promise<CreateGroupResult> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(
    `Creating group "${params.title}" with template ${params.templateId}, owner: ${params.ownerUserId}`,
  );

  const body: Record<string, unknown> = {
    templateId: params.templateId,
    ownerUserId: params.ownerUserId,
    title: params.title,
  };

  if (params.userIds?.length) body.userIds = params.userIds;
  if (params.icon) body.icon = params.icon;
  if (params.subAdminIds?.length) body.subAdminIds = params.subAdminIds;
  if (params.uuid) body.uuid = params.uuid;
  if (params.mentionAllAuthority !== undefined)
    body.mentionAllAuthority = params.mentionAllAuthority ? 1 : 0;
  if (params.managementType !== undefined) body.managementType = params.managementType;
  if (params.searchable !== undefined) body.searchable = params.searchable;
  if (params.validationType !== undefined) body.validationType = params.validationType;
  if (params.atAllPermission !== undefined) body.atAllPermission = params.atAllPermission;
  if (params.showHistoryType !== undefined) body.showHistoryType = params.showHistoryType;

  const result = await dingtalkApiRequest<{
    openConversationId?: string;
    chatId?: string;
  }>("POST", "/v1.0/im/sceneGroups", accessToken, {
    body,
    operationLabel: "create group",
  });

  if (!result.openConversationId) {
    throw new Error("DingTalk create group response missing openConversationId");
  }

  dingtalkLogger.info(
    `Group "${params.title}" created: openConversationId=${result.openConversationId}`,
  );

  return {
    openConversationId: result.openConversationId,
    chatId: result.chatId ?? "",
  };
}

/**
 * Update group config
 *
 * Modify group name, owner, permission settings, etc. Only pass fields to be modified.
 *
 * @param cfg DingTalk config
 * @param params Update group parameters
 * @throws Error if credentials not configured or API call fails
 *
 * @example
 * ```ts
 * await updateGroup(cfg, {
 *   openConversationId: "cid_xxx",
 *   title: "New Group Name",
 *   ownerUserId: "newOwner123",
 * });
 * ```
 */
export async function updateGroup(cfg: DingtalkConfig, params: UpdateGroupParams): Promise<void> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Updating group ${params.openConversationId}`);

  const body: Record<string, unknown> = {
    openConversationId: params.openConversationId,
  };

  if (params.title !== undefined) body.title = params.title;
  if (params.ownerUserId !== undefined) body.ownerUserId = params.ownerUserId;
  if (params.icon !== undefined) body.icon = params.icon;
  if (params.mentionAllAuthority !== undefined)
    body.mentionAllAuthority = params.mentionAllAuthority;
  if (params.managementType !== undefined) body.managementType = params.managementType;
  if (params.searchable !== undefined) body.searchable = params.searchable;
  if (params.validationType !== undefined) body.validationType = params.validationType;
  if (params.atAllPermission !== undefined) body.atAllPermission = params.atAllPermission;
  if (params.showHistoryType !== undefined) body.showHistoryType = params.showHistoryType;

  await dingtalkApiRequest<Record<string, unknown>>("PUT", "/v1.0/im/sceneGroups", accessToken, {
    body,
    operationLabel: "update group",
  });

  dingtalkLogger.info(`Group ${params.openConversationId} updated`);
}

/**
 * Add group members
 *
 * Add one or more members to specified group.
 *
 * @param cfg DingTalk config
 * @param params Add members parameters
 * @throws Error if credentials not configured or API call fails
 *
 * @example
 * ```ts
 * await addGroupMembers(cfg, {
 *   openConversationId: "cid_xxx",
 *   userIds: ["user123", "user456"],
 * });
 * ```
 */
export async function addGroupMembers(
  cfg: DingtalkConfig,
  params: AddGroupMembersParams,
): Promise<void> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(
    `Adding ${params.userIds.length} member(s) to group ${params.openConversationId}`,
  );

  await dingtalkApiRequest<Record<string, unknown>>(
    "POST",
    "/v1.0/im/sceneGroups/members",
    accessToken,
    {
      body: {
        openConversationId: params.openConversationId,
        userIds: params.userIds,
      },
      operationLabel: "add group members",
    },
  );

  dingtalkLogger.info(
    `Added ${params.userIds.length} member(s) to group ${params.openConversationId}`,
  );
}

/**
 * Remove group members
 *
 * Remove one or more members from specified group.
 *
 * @param cfg DingTalk config
 * @param params Remove members parameters
 * @throws Error if credentials not configured or API call fails
 *
 * @example
 * ```ts
 * await removeGroupMembers(cfg, {
 *   openConversationId: "cid_xxx",
 *   userIds: ["user123"],
 * });
 * ```
 */
export async function removeGroupMembers(
  cfg: DingtalkConfig,
  params: RemoveGroupMembersParams,
): Promise<void> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(
    `Removing ${params.userIds.length} member(s) from group ${params.openConversationId}`,
  );

  await dingtalkApiRequest<Record<string, unknown>>(
    "DELETE",
    "/v1.0/im/sceneGroups/members",
    accessToken,
    {
      body: {
        openConversationId: params.openConversationId,
        userIds: params.userIds,
      },
      operationLabel: "remove group members",
    },
  );

  dingtalkLogger.info(
    `Removed ${params.userIds.length} member(s) from group ${params.openConversationId}`,
  );
}

/**
 * Query group member list (single page)
 *
 * Return member list for specified group, supports pagination. Use listAllGroupMembers
 * to get all members.
 *
 * @param cfg DingTalk config
 * @param params Query parameters
 * @returns Member list and pagination info
 * @throws Error if credentials not configured or API call fails
 *
 * @example
 * ```ts
 * const result = await listGroupMembers(cfg, {
 *   openConversationId: "cid_xxx",
 *   cursor: "",
 *   size: 100,
 * });
 * console.log(result.memberUserIds);
 * if (result.hasMore) {
 *   // Continue querying next page
 * }
 * ```
 */
export async function listGroupMembers(
  cfg: DingtalkConfig,
  params: ListGroupMembersParams,
): Promise<ListGroupMembersResult> {
  const accessToken = await resolveAccessToken(cfg);
  const pageSize = Math.min(params.size ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const query: Record<string, string> = {
    openConversationId: params.openConversationId,
    size: String(pageSize),
  };

  if (params.cursor) {
    query.cursor = params.cursor;
  }

  const result = await dingtalkApiRequest<{
    memberUserIds?: string[];
    hasMore?: boolean;
    nextCursor?: string;
  }>("GET", "/v1.0/im/sceneGroups/members", accessToken, {
    query,
    operationLabel: "list group members",
  });

  return {
    memberUserIds: result.memberUserIds ?? [],
    hasMore: result.hasMore ?? false,
    nextCursor: result.nextCursor,
  };
}

/**
 * Query all group members (auto-pagination)
 *
 * Automatically handles pagination logic, returns list of all member userIds in group.
 * Suitable for scenarios with uncertain member count.
 *
 * @param cfg DingTalk config
 * @param openConversationId Group conversation ID
 * @returns List of all member userIds
 * @throws Error if credentials not configured or API call fails
 *
 * @example
 * ```ts
 * const allMembers = await listAllGroupMembers(cfg, "cid_xxx");
 * console.log(`Total members: ${allMembers.length}`);
 * ```
 */
export async function listAllGroupMembers(
  cfg: DingtalkConfig,
  openConversationId: string,
): Promise<string[]> {
  const allMembers: string[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  dingtalkLogger.info(`Fetching all members for group ${openConversationId}`);

  while (hasMore) {
    const result = await listGroupMembers(cfg, {
      openConversationId,
      cursor: cursor ?? "",
      size: MAX_PAGE_SIZE,
    });

    allMembers.push(...result.memberUserIds);
    hasMore = result.hasMore;
    cursor = result.nextCursor;
  }

  dingtalkLogger.info(`Fetched ${allMembers.length} member(s) for group ${openConversationId}`);

  return allMembers;
}

/**
 * Query group info
 *
 * Get detailed group information, including name, owner, member count, etc.
 *
 * @param cfg DingTalk config
 * @param params Query parameters
 * @returns Group info
 * @throws Error if credentials not configured or API call fails
 *
 * @example
 * ```ts
 * const info = await getGroupInfo(cfg, {
 *   openConversationId: "cid_xxx",
 * });
 * console.log(`Group: ${info.title}, Owner: ${info.ownerUserId}`);
 * ```
 */
export async function getGroupInfo(
  cfg: DingtalkConfig,
  params: GetGroupInfoParams,
): Promise<GroupInfo> {
  const accessToken = await resolveAccessToken(cfg);

  const result = await dingtalkApiRequest<{
    openConversationId?: string;
    title?: string;
    ownerUserId?: string;
    icon?: string;
    templateId?: string;
    memberCount?: number;
    status?: number;
  }>("GET", "/v1.0/im/sceneGroups", accessToken, {
    query: {
      openConversationId: params.openConversationId,
    },
    operationLabel: "get group info",
  });

  return {
    openConversationId: result.openConversationId ?? params.openConversationId,
    title: result.title ?? "",
    ownerUserId: result.ownerUserId ?? "",
    icon: result.icon,
    templateId: result.templateId,
    memberCount: result.memberCount,
    status: result.status,
  };
}

/**
 * Dismiss group
 *
 * Dismiss specified scene group. This operation is irreversible.
 *
 * @param cfg DingTalk config
 * @param openConversationId Group conversation ID
 * @throws Error if credentials not configured or API call fails
 *
 * @example
 * ```ts
 * await dismissGroup(cfg, "cid_xxx");
 * ```
 */
export async function dismissGroup(cfg: DingtalkConfig, openConversationId: string): Promise<void> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(`Dismissing group ${openConversationId}`);

  await dingtalkApiRequest<Record<string, unknown>>(
    "POST",
    "/v1.0/im/sceneGroups/dismiss",
    accessToken,
    {
      body: { openConversationId },
      operationLabel: "dismiss group",
    },
  );

  dingtalkLogger.info(`Group ${openConversationId} dismissed`);
}
