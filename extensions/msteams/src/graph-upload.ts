/**
 * SharePoint upload utilities for MS Teams file sending.
 *
 * For group chats and channels, files are uploaded to SharePoint and shared via a link.
 * This module provides utilities for:
 * - Uploading files to SharePoint (group/channel scope)
 * - Creating sharing links (organization-wide or per-user)
 * - Getting chat members for per-user sharing
 */

import { bufferToBlobPart } from "openclaw/plugin-sdk/blob-runtime";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import { createMSTeamsHttpError } from "./http-error.js";
import {
  resolveMSTeamsSharePointUploadTimeoutMs,
  withMSTeamsAbortableRequestTimeout,
  withMSTeamsRequestDeadline,
} from "./request-timeout.js";
import { assertMSTeamsSendHandoff, type MSTeamsSendHandoff } from "./send-handoff.js";
import { resolveTeamGroupId } from "./team-identity.js";
import { buildUserAgent } from "./user-agent.js";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";
const GRAPH_SCOPE = "https://graph.microsoft.com";

function requireMSTeamsSharePointSiteId(siteId?: string): string {
  const normalized = siteId?.trim();
  if (!normalized) {
    throw new Error(
      "No SharePoint site ID available for file upload. " +
        "Set channels.msteams.sharePointSiteId, or verify that the team's AAD group ID " +
        "is resolvable and the bot has Sites.Read.All to resolve the team site automatically.",
    );
  }
  return normalized;
}

/**
 * Resolve a SharePoint site ID for a file upload. Uses the explicit config value when set;
 * otherwise resolves a standard channel's team site dynamically. Called lazily at the
 * upload boundary so text-only messages never wait on Graph. Group chats and
 * private/shared channels still require sharePointSiteId.
 */
export async function resolveUploadSiteId(params: {
  configuredSiteId?: string;
  teamId?: string;
  channelId?: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  getTeamDetails?: (teamId: string) => Promise<{ aadGroupId?: string }>;
  fetchFn?: typeof fetch;
}): Promise<string> {
  if (params.configuredSiteId !== undefined) {
    const explicit = params.configuredSiteId.trim();
    if (!explicit) {
      throw new Error(
        "channels.msteams.sharePointSiteId is blank. Omit it to discover a standard channel's team site, or set a site ID.",
      );
    }
    return explicit;
  }
  if (!params.teamId) {
    return requireMSTeamsSharePointSiteId(undefined);
  }
  const groupId = await resolveTeamGroupId({
    conversationTeamId: params.teamId,
    getTeamDetails: params.getTeamDetails,
  });
  if (!groupId) {
    throw new Error(
      `Could not resolve AAD group ID for team ${params.teamId}. ` +
        "Set channels.msteams.sharePointSiteId as a fallback.",
    );
  }
  if (params.channelId) {
    await assertStandardChannelForAutoUpload({
      groupId,
      channelId: params.channelId,
      tokenProvider: params.tokenProvider,
      fetchFn: params.fetchFn,
    });
  }
  return await resolveTeamSiteId({
    groupId,
    tokenProvider: params.tokenProvider,
    fetchFn: params.fetchFn,
  });
}

const DEFAULT_SHAREPOINT_FOLDER = "OpenClawShared";

function resolveMSTeamsSharePointFolder(folder?: string): string {
  const trimmed = folder?.trim() || DEFAULT_SHAREPOINT_FOLDER;
  if (trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) {
    throw new Error(
      "channels.msteams.sharePointFolder must be a single folder name without path separators",
    );
  }
  return trimmed;
}

interface DriveUploadResult {
  id: string;
  webUrl: string;
  name: string;
}

interface SharingLinkResult {
  webUrl: string;
}

const SHAREPOINT_REQUEST_TIMEOUT_LABEL = "MS Teams SharePoint request";
const SHAREPOINT_UPLOAD_TIMEOUT_LABEL = "MS Teams SharePoint upload";
const GRAPH_TOKEN_TIMEOUT_LABEL = "MS Teams Graph token acquisition";

async function requestSharePointJson<T>(
  params: {
    tokenProvider: MSTeamsAccessTokenProvider;
    fetchFn?: typeof fetch;
  } & MSTeamsSendHandoff,
  request: {
    url: string;
    init?: () => Pick<RequestInit, "method" | "body"> & { headers?: Record<string, string> };
    label: string;
    error: string | ((response: Response) => string);
    timeoutMs?: number;
  },
): Promise<T> {
  return await withMSTeamsAbortableRequestTimeout({
    label:
      request.timeoutMs !== undefined
        ? SHAREPOINT_UPLOAD_TIMEOUT_LABEL
        : SHAREPOINT_REQUEST_TIMEOUT_LABEL,
    timeoutMs: request.timeoutMs,
    work: async (signal) => {
      assertMSTeamsSendHandoff(params);
      const token = await withMSTeamsRequestDeadline({
        label: GRAPH_TOKEN_TIMEOUT_LABEL,
        work: () => params.tokenProvider.getAccessToken(GRAPH_SCOPE),
      });
      assertMSTeamsSendHandoff(params);
      const init = request.init?.();
      const { response, release } = await fetchWithSsrFGuard({
        url: request.url,
        init: {
          ...init,
          headers: {
            "User-Agent": buildUserAgent(),
            Authorization: `Bearer ${token}`,
            ...init?.headers,
          },
          signal,
        },
        fetchImpl: params.fetchFn,
        mode: "trusted_env_proxy",
        beforeRequest: () => assertMSTeamsSendHandoff(params),
        maxRedirects: 20,
        allowCrossOriginUnsafeRedirectReplay: true,
        auditContext: "msteams.graph-upload",
      });
      const res = responseWithRelease(response, release);
      if (!res.ok) {
        throw await createMSTeamsHttpError(
          res,
          typeof request.error === "string" ? request.error : request.error(res),
        );
      }
      return await readProviderJsonResponse<T>(res, request.label, {
        chunkTimeoutMs: request.timeoutMs,
      });
    },
  });
}

const teamSiteIdCache = new Map<string, string>();
const TEAM_SITE_ID_CACHE_MAX_ENTRIES = 200;

async function resolveTeamSiteId(
  params: {
    groupId: string;
    tokenProvider: MSTeamsAccessTokenProvider;
    fetchFn?: typeof fetch;
  } & MSTeamsSendHandoff,
): Promise<string> {
  const cached = teamSiteIdCache.get(params.groupId);
  if (cached) {
    return cached;
  }
  const data = await requestSharePointJson<{ id?: string }>(params, {
    url: `${GRAPH_ROOT}/groups/${params.groupId}/sites/root?$select=id`,
    label: "msteams.graph-upload.resolveTeamSiteId",
    error: `Resolve team SharePoint site failed for group ${params.groupId}`,
  });
  const siteId = data.id?.trim();
  if (!siteId) {
    throw new Error(`Graph returned no site ID for group ${params.groupId}`);
  }
  teamSiteIdCache.set(params.groupId, siteId);
  pruneMapToMaxSize(teamSiteIdCache, TEAM_SITE_ID_CACHE_MAX_ENTRIES);
  return siteId;
}

async function assertStandardChannelForAutoUpload(
  params: {
    groupId: string;
    channelId: string;
    tokenProvider: MSTeamsAccessTokenProvider;
    fetchFn?: typeof fetch;
  } & MSTeamsSendHandoff,
): Promise<void> {
  const data = await requestSharePointJson<{ membershipType?: string }>(params, {
    url: `${GRAPH_ROOT}/teams/${encodeURIComponent(params.groupId)}/channels/${encodeURIComponent(params.channelId)}?$select=membershipType`,
    label: "msteams.graph-upload.resolveChannelMembershipType",
    error: "Resolve channel membership type failed",
  });
  const membershipType = data.membershipType?.trim().toLowerCase();
  if (membershipType !== "standard") {
    throw new Error(
      "Automatic SharePoint site discovery supports standard channels only. " +
        "Set channels.msteams.sharePointSiteId to upload to a specific site.",
    );
  }
}

// ============================================================================
// SharePoint upload functions for group chats and channels
// ============================================================================

/**
 * Upload a file to a SharePoint site.
 * This is used for group chats and channels where /me/drive doesn't work for bots.
 *
 * @param params.siteId - SharePoint site ID (e.g., "contoso.sharepoint.com,guid1,guid2")
 */
async function uploadToSharePoint(
  params: {
    buffer: Buffer;
    filename: string;
    contentType?: string;
    tokenProvider: MSTeamsAccessTokenProvider;
    siteId: string;
    folderName?: string;
    fetchFn?: typeof fetch;
  } & MSTeamsSendHandoff,
): Promise<DriveUploadResult> {
  const folder = encodeURIComponent(resolveMSTeamsSharePointFolder(params.folderName));
  const uploadPath = `/${folder}/${encodeURIComponent(params.filename)}`;
  // Graph's default conflictBehavior=replace overwrites a same-named file in place. Bot assets
  // reuse names (image-1.png each generation) and Teams caches file cards by driveItem URL, so
  // replace clobbers history and shows stale images; "rename" mints a unique driveItem instead.
  const uploadUrl = `${GRAPH_ROOT}/sites/${params.siteId}/drive/root:${uploadPath}:/content?@microsoft.graph.conflictBehavior=rename`;
  const timeoutMs = resolveMSTeamsSharePointUploadTimeoutMs(params.buffer.length);

  const data = await requestSharePointJson<Partial<DriveUploadResult>>(params, {
    url: uploadUrl,
    timeoutMs,
    init: () => ({
      method: "PUT",
      headers: { "Content-Type": params.contentType ?? "application/octet-stream" },
      body: new Blob([bufferToBlobPart(params.buffer)]),
    }),
    error: "SharePoint upload failed",
    label: "msteams.graph-upload.uploadSharePointFile",
  });

  if (!data.id || !data.webUrl || !data.name) {
    throw new Error("SharePoint upload response missing required fields");
  }

  return {
    id: data.id,
    webUrl: data.webUrl,
    name: data.name,
  };
}

interface ChatMember {
  aadObjectId: string;
}

/**
 * Properties needed for native Teams file card attachments.
 * The eTag is used as the attachment ID and webDavUrl as the contentUrl.
 */
export interface DriveItemProperties {
  /** The eTag of the driveItem (used as attachment ID) */
  eTag: string;
  /** The WebDAV URL of the driveItem (used as contentUrl for reference attachment) */
  webDavUrl: string;
  /** The filename */
  name: string;
}

/**
 * Get driveItem properties needed for native Teams file card attachments.
 * This fetches the eTag and webDavUrl which are required for "reference" type attachments.
 *
 * @param params.siteId - SharePoint site ID
 * @param params.itemId - The driveItem ID (returned from upload)
 */
export async function getDriveItemProperties(
  params: {
    siteId: string;
    itemId: string;
    tokenProvider: MSTeamsAccessTokenProvider;
    fetchFn?: typeof fetch;
  } & MSTeamsSendHandoff,
): Promise<DriveItemProperties> {
  const data = await requestSharePointJson<Partial<DriveItemProperties>>(params, {
    url: `${GRAPH_ROOT}/sites/${params.siteId}/drive/items/${params.itemId}?$select=eTag,webDavUrl,name`,
    error: "Get driveItem properties failed",
    label: "msteams.graph-upload.getDriveItemProperties",
  });

  if (!data.eTag || !data.webDavUrl || !data.name) {
    throw new Error("DriveItem response missing required properties (eTag, webDavUrl, or name)");
  }

  return {
    eTag: data.eTag,
    webDavUrl: data.webDavUrl,
    name: data.name,
  };
}

/**
 * Get members of a Teams chat for per-user sharing.
 * Used to create sharing links scoped to only the chat participants.
 */
async function getChatMembers(
  params: {
    chatId: string;
    tokenProvider: MSTeamsAccessTokenProvider;
    fetchFn?: typeof fetch;
  } & MSTeamsSendHandoff,
): Promise<ChatMember[]> {
  const data = await requestSharePointJson<{ value?: Array<{ userId?: string }> }>(params, {
    url: `${GRAPH_ROOT}/chats/${params.chatId}/members`,
    // Graph 403 covers permissions, licensing, and conditional access. RSC
    // grants are not token roles, so no local signal can safely widen access.
    error: (res) =>
      res.status === 403
        ? "Get chat members failed; verify Graph chat-member permissions and tenant access policies"
        : "Get chat members failed",
    label: "msteams.graph-upload.getChatMembers",
  });
  return (data.value ?? [])
    .map((member) => ({ aadObjectId: member.userId ?? "" }))
    .filter((member) => member.aadObjectId);
}

/**
 * Create a sharing link for a SharePoint drive item.
 * For organization scope (default), uses v1.0 API.
 * For per-user scope, uses beta API with recipients.
 */
async function createSharePointSharingLink(
  params: {
    siteId: string;
    itemId: string;
    tokenProvider: MSTeamsAccessTokenProvider;
    /** Sharing scope: "organization" (default) or "users" (per-user with recipients) */
    scope?: "organization" | "users";
    /** Required when scope is "users": AAD object IDs of recipients */
    recipientObjectIds?: string[];
    fetchFn?: typeof fetch;
  } & MSTeamsSendHandoff,
): Promise<SharingLinkResult> {
  const scope = params.scope ?? "organization";

  // Per-user sharing requires beta API
  const apiRoot = scope === "users" ? GRAPH_BETA : GRAPH_ROOT;

  const body: Record<string, unknown> = {
    type: "view",
    scope: scope === "users" ? "users" : "organization",
  };

  // Add recipients for per-user sharing
  if (scope === "users" && params.recipientObjectIds?.length) {
    body.recipients = params.recipientObjectIds.map((id) => ({ objectId: id }));
  }

  const data = await requestSharePointJson<{ link?: { webUrl?: string } }>(params, {
    url: `${apiRoot}/sites/${params.siteId}/drive/items/${params.itemId}/createLink`,
    init: () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    error: "Create SharePoint sharing link failed",
    label: "msteams.graph-upload.createSharePointSharingLink",
  });

  if (!data.link?.webUrl) {
    throw new Error("Create SharePoint sharing link response missing webUrl");
  }

  return {
    webUrl: data.link.webUrl,
  };
}

/**
 * Upload a file to SharePoint and create a sharing link.
 *
 * For group chats, this creates a per-user sharing link scoped to chat members.
 * For channels, this creates an organization-wide sharing link.
 *
 * @param params.siteId - SharePoint site ID
 * @param params.chatId - Optional chat ID for per-user sharing (group chats)
 * @param params.usePerUserSharing - Whether to use per-user sharing (requires beta API + chat-member read access)
 */
export async function uploadAndShareSharePoint(
  params: {
    buffer: Buffer;
    filename: string;
    contentType?: string;
    tokenProvider: MSTeamsAccessTokenProvider;
    siteId: string;
    chatId?: string;
    usePerUserSharing?: boolean;
    folderName?: string;
    fetchFn?: typeof fetch;
  } & MSTeamsSendHandoff,
): Promise<{
  itemId: string;
  webUrl: string;
  shareUrl: string;
  name: string;
}> {
  // 1. Upload file to SharePoint
  const uploaded = await uploadToSharePoint({
    buffer: params.buffer,
    filename: params.filename,
    contentType: params.contentType,
    tokenProvider: params.tokenProvider,
    siteId: params.siteId,
    folderName: params.folderName,
    fetchFn: params.fetchFn,
    assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
  });

  // 2. Determine sharing scope
  let scope: "organization" | "users" = "organization";
  let recipientObjectIds: string[] | undefined;

  if (params.usePerUserSharing && params.chatId) {
    const members = await getChatMembers({
      chatId: params.chatId,
      tokenProvider: params.tokenProvider,
      fetchFn: params.fetchFn,
      assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
    });
    if (members.length === 0) {
      throw new Error("MS Teams chat member lookup returned no recipients");
    }
    scope = "users";
    recipientObjectIds = members.map((member) => member.aadObjectId);
  }

  // 3. Create sharing link
  const shareLink = await createSharePointSharingLink({
    siteId: params.siteId,
    itemId: uploaded.id,
    tokenProvider: params.tokenProvider,
    scope,
    recipientObjectIds,
    fetchFn: params.fetchFn,
    assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
  });

  return {
    itemId: uploaded.id,
    webUrl: uploaded.webUrl,
    shareUrl: shareLink.webUrl,
    name: uploaded.name,
  };
}
