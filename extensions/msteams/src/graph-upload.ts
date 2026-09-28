import { bufferToBlobPart } from "openclaw/plugin-sdk/blob-runtime";
import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import {
  createProviderHttpError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import {
  resolveMSTeamsSharePointUploadTimeoutMs,
  withMSTeamsAbortableRequestTimeout,
  withMSTeamsRequestDeadline,
} from "./request-timeout.js";
import { assertMSTeamsSendHandoff, type MSTeamsSendHandoff } from "./send-handoff.js";
import { buildUserAgent } from "./user-agent.js";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";
const GRAPH_SCOPE = "https://graph.microsoft.com";

export function requireMSTeamsSharePointSiteId(siteId?: string): string {
  const normalized = siteId?.trim();
  if (!normalized) {
    throw new Error(
      "channels.msteams.sharePointSiteId is required to send files to group chats or channels",
    );
  }
  return normalized;
}

interface DriveUploadResult {
  id: string;
  webUrl: string;
  name: string;
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
        // Preserve fetch's redirect limit, method/body replay, and cross-origin
        // credential stripping while checking authority again before each hop.
        maxRedirects: 20,
        allowCrossOriginUnsafeRedirectReplay: true,
        auditContext: "msteams.graph-upload",
      });
      const res = responseWithRelease(response, release);
      if (!res.ok) {
        throw await createProviderHttpError(
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

async function uploadToSharePoint(
  params: {
    buffer: Buffer;
    filename: string;
    contentType?: string;
    tokenProvider: MSTeamsAccessTokenProvider;
    siteId: string;
    fetchFn?: typeof fetch;
  } & MSTeamsSendHandoff,
): Promise<DriveUploadResult> {
  const uploadPath = `/OpenClawShared/${encodeURIComponent(params.filename)}`;
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

/**
 * Properties needed for native Teams file card attachments.
 * The eTag is used as the attachment ID and webDavUrl as the contentUrl.
 */
export interface DriveItemProperties {
  eTag: string;
  webDavUrl: string;
  name: string;
}

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

async function getChatMemberIds(
  params: {
    chatId: string;
    tokenProvider: MSTeamsAccessTokenProvider;
    fetchFn?: typeof fetch;
  } & MSTeamsSendHandoff,
): Promise<string[]> {
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
  return (data.value ?? []).flatMap((member) => (member.userId ? [member.userId] : []));
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
): Promise<string> {
  const scope = params.scope ?? "organization";

  const apiRoot = scope === "users" ? GRAPH_BETA : GRAPH_ROOT;

  const body: Record<string, unknown> = {
    type: "view",
    scope: scope === "users" ? "users" : "organization",
  };

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

  return data.link.webUrl;
}

/**
 * Upload a file to SharePoint and create a sharing link.
 *
 * For group chats, this creates a per-user sharing link scoped to chat members.
 * For channels, this creates an organization-wide sharing link.
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
    fetchFn?: typeof fetch;
  } & MSTeamsSendHandoff,
): Promise<{
  itemId: string;
  webUrl: string;
  shareUrl: string;
  name: string;
}> {
  const uploaded = await uploadToSharePoint(params);

  let scope: "organization" | "users" = "organization";
  let recipientObjectIds: string[] | undefined;

  if (params.usePerUserSharing && params.chatId) {
    recipientObjectIds = await getChatMemberIds({
      chatId: params.chatId,
      tokenProvider: params.tokenProvider,
      fetchFn: params.fetchFn,
      assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
    });
    if (recipientObjectIds.length === 0) {
      throw new Error("MS Teams chat member lookup returned no recipients");
    }
    scope = "users";
  }

  const shareUrl = await createSharePointSharingLink({
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
    shareUrl,
    name: uploaded.name,
  };
}
