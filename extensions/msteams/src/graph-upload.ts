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

const SHAREPOINT_REQUEST_TIMEOUT_LABEL = "MS Teams SharePoint request";
const SHAREPOINT_UPLOAD_TIMEOUT_LABEL = "MS Teams SharePoint upload";
const GRAPH_TOKEN_TIMEOUT_LABEL = "MS Teams Graph token acquisition";

async function requestSharePointJson<T>(
  params: {
    tokenProvider: MSTeamsAccessTokenProvider;
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
  } & MSTeamsSendHandoff,
) {
  const uploadPath = `/OpenClawShared/${encodeURIComponent(params.filename)}`;
  // Graph's default conflictBehavior=replace overwrites a same-named file in place. Bot assets
  // reuse names (image-1.png each generation) and Teams caches file cards by driveItem URL, so
  // replace clobbers history and shows stale images; "rename" mints a unique driveItem instead.
  const uploadUrl = `${GRAPH_ROOT}/sites/${params.siteId}/drive/root:${uploadPath}:/content?@microsoft.graph.conflictBehavior=rename`;
  const timeoutMs = resolveMSTeamsSharePointUploadTimeoutMs(params.buffer.length);
  const data = await requestSharePointJson<{ id?: string }>(params, {
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
  if (!data.id) {
    throw new Error("SharePoint upload response missing required fields");
  }
  const itemId = data.id;

  let recipientObjectIds: string[] | undefined;

  if (params.usePerUserSharing && params.chatId) {
    const members = await requestSharePointJson<{ value?: Array<{ userId?: string }> }>(params, {
      url: `${GRAPH_ROOT}/chats/${params.chatId}/members`,
      // Graph 403 covers permissions, licensing, and conditional access. RSC
      // grants are not token roles, so no local signal can safely widen access.
      error: (res) =>
        res.status === 403
          ? "Get chat members failed; verify Graph chat-member permissions and tenant access policies"
          : "Get chat members failed",
      label: "msteams.graph-upload.getChatMembers",
    });
    recipientObjectIds = (members.value ?? []).flatMap((member) =>
      member.userId ? [member.userId] : [],
    );
    if (recipientObjectIds.length === 0) {
      throw new Error("MS Teams chat member lookup returned no recipients");
    }
  }

  // Per-user links use the beta API with AAD recipients; organization links use v1.0.
  const apiRoot = recipientObjectIds ? GRAPH_BETA : GRAPH_ROOT;
  const body: Record<string, unknown> = {
    type: "view",
    scope: recipientObjectIds ? "users" : "organization",
  };
  if (recipientObjectIds) {
    body.recipients = recipientObjectIds.map((id) => ({ objectId: id }));
  }
  await requestSharePointJson<unknown>(params, {
    url: `${apiRoot}/sites/${params.siteId}/drive/items/${itemId}/createLink`,
    init: () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    error: "Create SharePoint sharing link failed",
    label: "msteams.graph-upload.createSharePointSharingLink",
  });

  return { itemId };
}
