/**
 * OneDrive/SharePoint upload utilities for MS Teams file sending.
 *
 * For group chats and channels, files are uploaded to SharePoint and shared via a link.
 * This module provides utilities for:
 * - Uploading files to OneDrive (personal scope - now deprecated for bot use)
 * - Uploading files to SharePoint (group/channel scope)
 * - Creating sharing links (organization-wide or per-user)
 * - Getting chat members for per-user sharing
 */

import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";
const GRAPH_SCOPE = "https://graph.microsoft.com";
const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
// Graph requires chunks to be multiples of 320 KiB (except final chunk). 5 MiB = 16 * 320 KiB.
const RESUMABLE_UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_INITIAL_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 503, 504]);

type DriveUploadScope = { kind: "onedrive" } | { kind: "sharepoint"; siteId: string };

export interface OneDriveUploadResult {
  id: string;
  webUrl: string;
  name: string;
}

function buildUploadPath(filename: string): string {
  return `/OpenClawShared/${encodeURIComponent(filename)}`;
}

function resolveDriveRoot(scope: DriveUploadScope): string {
  if (scope.kind === "onedrive") {
    return `${GRAPH_ROOT}/me/drive`;
  }
  return `${GRAPH_ROOT}/sites/${scope.siteId}/drive`;
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) {
    return null;
  }

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const at = Date.parse(headerValue);
  if (!Number.isNaN(at)) {
    return Math.max(at - Date.now(), 0);
  }
  return null;
}

function resolveRetryDelayMs(params: { attempt: number; retryAfterHeader: string | null }): number {
  const fromHeader = parseRetryAfterMs(params.retryAfterHeader);
  if (fromHeader !== null) {
    return fromHeader;
  }
  return RETRY_INITIAL_DELAY_MS * 2 ** params.attempt;
}

function shouldRetryFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // AbortError usually means caller cancellation, so avoid retry loops.
  if (error.name === "AbortError") {
    return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(params: {
  fetchFn: typeof fetch;
  url: string;
  requestName: string;
  init?: RequestInit;
}): Promise<Response> {
  let attempt = 0;
  while (true) {
    try {
      const response = await params.fetchFn(params.url, params.init);
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= MAX_RETRY_ATTEMPTS) {
        return response;
      }

      const waitMs = resolveRetryDelayMs({
        attempt,
        retryAfterHeader: response.headers.get("retry-after"),
      });
      console.warn(
        `[msteams] ${params.requestName} retry ${attempt + 1}/${MAX_RETRY_ATTEMPTS} in ${waitMs}ms (status ${response.status})`,
      );
      attempt += 1;
      await sleep(waitMs);
    } catch (error) {
      if (!shouldRetryFetchError(error) || attempt >= MAX_RETRY_ATTEMPTS) {
        throw error;
      }
      const waitMs = RETRY_INITIAL_DELAY_MS * 2 ** attempt;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[msteams] ${params.requestName} retry ${attempt + 1}/${MAX_RETRY_ATTEMPTS} in ${waitMs}ms (error: ${message})`,
      );
      attempt += 1;
      await sleep(waitMs);
    }
  }
}

async function readResponseBody(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

function parseDriveItemUploadResult(
  data: { id?: string; webUrl?: string; name?: string },
  context: string,
): OneDriveUploadResult {
  if (!data.id || !data.webUrl || !data.name) {
    throw new Error(`${context} response missing required fields`);
  }

  return {
    id: data.id,
    webUrl: data.webUrl,
    name: data.name,
  };
}

async function uploadWithSimpleEndpoint(params: {
  buffer: Buffer;
  uploadPath: string;
  contentType?: string;
  token: string;
  fetchFn: typeof fetch;
  driveRoot: string;
  requestName: string;
}): Promise<OneDriveUploadResult> {
  const response = await fetchWithRetry({
    fetchFn: params.fetchFn,
    url: `${params.driveRoot}/root:${params.uploadPath}:/content`,
    requestName: `${params.requestName} (simple upload)`,
    init: {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${params.token}`,
        "Content-Type": params.contentType ?? "application/octet-stream",
      },
      body: new Uint8Array(params.buffer),
    },
  });

  if (!response.ok) {
    const body = await readResponseBody(response);
    throw new Error(
      `${params.requestName} failed: ${response.status} ${response.statusText} - ${body}`,
    );
  }

  const data = (await response.json()) as {
    id?: string;
    webUrl?: string;
    name?: string;
  };
  return parseDriveItemUploadResult(data, params.requestName);
}

async function createUploadSession(params: {
  uploadPath: string;
  token: string;
  fetchFn: typeof fetch;
  driveRoot: string;
  requestName: string;
}): Promise<string> {
  const response = await fetchWithRetry({
    fetchFn: params.fetchFn,
    url: `${params.driveRoot}/root:${params.uploadPath}:/createUploadSession`,
    requestName: `${params.requestName} (create upload session)`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": "replace",
        },
      }),
    },
  });

  if (!response.ok) {
    const body = await readResponseBody(response);
    throw new Error(
      `${params.requestName} create upload session failed: ${response.status} ${response.statusText} - ${body}`,
    );
  }

  const data = (await response.json()) as { uploadUrl?: string };
  if (!data.uploadUrl) {
    throw new Error(`${params.requestName} upload session response missing uploadUrl`);
  }
  return data.uploadUrl;
}

async function uploadWithResumableSession(params: {
  buffer: Buffer;
  contentType?: string;
  uploadUrl: string;
  fetchFn: typeof fetch;
  requestName: string;
}): Promise<OneDriveUploadResult> {
  const bytes = new Uint8Array(params.buffer);
  let start = 0;

  while (start < bytes.byteLength) {
    const endExclusive = Math.min(start + RESUMABLE_UPLOAD_CHUNK_BYTES, bytes.byteLength);
    const chunk = bytes.subarray(start, endExclusive);
    const endInclusive = endExclusive - 1;
    const response = await fetchWithRetry({
      fetchFn: params.fetchFn,
      url: params.uploadUrl,
      requestName: `${params.requestName} (chunk ${start}-${endInclusive})`,
      init: {
        method: "PUT",
        headers: {
          "Content-Type": params.contentType ?? "application/octet-stream",
          "Content-Length": String(chunk.byteLength),
          "Content-Range": `bytes ${start}-${endInclusive}/${bytes.byteLength}`,
        },
        body: chunk,
      },
    });

    if (response.status === 202) {
      start = endExclusive;
      continue;
    }

    if (!response.ok) {
      const body = await readResponseBody(response);
      throw new Error(
        `${params.requestName} resumable upload failed: ${response.status} ${response.statusText} - ${body}`,
      );
    }

    const data = (await response.json()) as {
      id?: string;
      webUrl?: string;
      name?: string;
    };
    return parseDriveItemUploadResult(data, params.requestName);
  }

  throw new Error(`${params.requestName} resumable upload did not produce a final response`);
}

async function uploadToDrive(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  scope: DriveUploadScope;
  fetchFn?: typeof fetch;
}): Promise<OneDriveUploadResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
  const uploadPath = buildUploadPath(params.filename);
  const driveRoot = resolveDriveRoot(params.scope);
  const requestName =
    params.scope.kind === "onedrive"
      ? "OneDrive upload"
      : `SharePoint upload (${params.scope.siteId})`;

  if (params.buffer.byteLength <= SIMPLE_UPLOAD_MAX_BYTES) {
    return await uploadWithSimpleEndpoint({
      buffer: params.buffer,
      uploadPath,
      contentType: params.contentType,
      token,
      fetchFn,
      driveRoot,
      requestName,
    });
  }

  const uploadUrl = await createUploadSession({
    uploadPath,
    token,
    fetchFn,
    driveRoot,
    requestName,
  });

  return await uploadWithResumableSession({
    buffer: params.buffer,
    contentType: params.contentType,
    uploadUrl,
    fetchFn,
    requestName,
  });
}

/**
 * Upload a file to the user's OneDrive root folder.
 * Uses simple upload for <=4MB and resumable upload session for larger files.
 */
export async function uploadToOneDrive(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
}): Promise<OneDriveUploadResult> {
  return await uploadToDrive({
    buffer: params.buffer,
    filename: params.filename,
    contentType: params.contentType,
    tokenProvider: params.tokenProvider,
    scope: { kind: "onedrive" },
    fetchFn: params.fetchFn,
  });
}

export interface OneDriveSharingLink {
  webUrl: string;
}

/**
 * Create a sharing link for a OneDrive file.
 * The link allows organization members to view the file.
 */
export async function createSharingLink(params: {
  itemId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  /** Sharing scope: "organization" (default) or "anonymous" */
  scope?: "organization" | "anonymous";
  fetchFn?: typeof fetch;
}): Promise<OneDriveSharingLink> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);

  const res = await fetchFn(`${GRAPH_ROOT}/me/drive/items/${params.itemId}/createLink`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "view",
      scope: params.scope ?? "organization",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Create sharing link failed: ${res.status} ${res.statusText} - ${body}`);
  }

  const data = (await res.json()) as {
    link?: { webUrl?: string };
  };

  if (!data.link?.webUrl) {
    throw new Error("Create sharing link response missing webUrl");
  }

  return {
    webUrl: data.link.webUrl,
  };
}

/**
 * Upload a file to OneDrive and create a sharing link.
 * Convenience function for the common case.
 */
export async function uploadAndShareOneDrive(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  scope?: "organization" | "anonymous";
  fetchFn?: typeof fetch;
}): Promise<{
  itemId: string;
  webUrl: string;
  shareUrl: string;
  name: string;
}> {
  const uploaded = await uploadToOneDrive({
    buffer: params.buffer,
    filename: params.filename,
    contentType: params.contentType,
    tokenProvider: params.tokenProvider,
    fetchFn: params.fetchFn,
  });

  const shareLink = await createSharingLink({
    itemId: uploaded.id,
    tokenProvider: params.tokenProvider,
    scope: params.scope,
    fetchFn: params.fetchFn,
  });

  return {
    itemId: uploaded.id,
    webUrl: uploaded.webUrl,
    shareUrl: shareLink.webUrl,
    name: uploaded.name,
  };
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
export async function uploadToSharePoint(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  siteId: string;
  fetchFn?: typeof fetch;
}): Promise<OneDriveUploadResult> {
  return await uploadToDrive({
    buffer: params.buffer,
    filename: params.filename,
    contentType: params.contentType,
    tokenProvider: params.tokenProvider,
    scope: { kind: "sharepoint", siteId: params.siteId },
    fetchFn: params.fetchFn,
  });
}

export interface ChatMember {
  aadObjectId: string;
  displayName?: string;
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
export async function getDriveItemProperties(params: {
  siteId: string;
  itemId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
}): Promise<DriveItemProperties> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);

  const res = await fetchFn(
    `${GRAPH_ROOT}/sites/${params.siteId}/drive/items/${params.itemId}?$select=eTag,webDavUrl,name`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Get driveItem properties failed: ${res.status} ${res.statusText} - ${body}`);
  }

  const data = (await res.json()) as {
    eTag?: string;
    webDavUrl?: string;
    name?: string;
  };

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
export async function getChatMembers(params: {
  chatId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
}): Promise<ChatMember[]> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);

  const res = await fetchFn(`${GRAPH_ROOT}/chats/${params.chatId}/members`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Get chat members failed: ${res.status} ${res.statusText} - ${body}`);
  }

  const data = (await res.json()) as {
    value?: Array<{
      userId?: string;
      displayName?: string;
    }>;
  };

  return (data.value ?? [])
    .map((m) => ({
      aadObjectId: m.userId ?? "",
      displayName: m.displayName,
    }))
    .filter((m) => m.aadObjectId);
}

/**
 * Create a sharing link for a SharePoint drive item.
 * For organization scope (default), uses v1.0 API.
 * For per-user scope, uses beta API with recipients.
 */
export async function createSharePointSharingLink(params: {
  siteId: string;
  itemId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  /** Sharing scope: "organization" (default) or "users" (per-user with recipients) */
  scope?: "organization" | "users";
  /** Required when scope is "users": AAD object IDs of recipients */
  recipientObjectIds?: string[];
  fetchFn?: typeof fetch;
}): Promise<OneDriveSharingLink> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
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

  const res = await fetchFn(
    `${apiRoot}/sites/${params.siteId}/drive/items/${params.itemId}/createLink`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const respBody = await res.text().catch(() => "");
    throw new Error(
      `Create SharePoint sharing link failed: ${res.status} ${res.statusText} - ${respBody}`,
    );
  }

  const data = (await res.json()) as {
    link?: { webUrl?: string };
  };

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
 * @param params.usePerUserSharing - Whether to use per-user sharing (requires beta API + Chat.Read.All)
 */
export async function uploadAndShareSharePoint(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  siteId: string;
  chatId?: string;
  usePerUserSharing?: boolean;
  fetchFn?: typeof fetch;
}): Promise<{
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
    fetchFn: params.fetchFn,
  });

  // 2. Determine sharing scope
  let scope: "organization" | "users" = "organization";
  let recipientObjectIds: string[] | undefined;

  if (params.usePerUserSharing && params.chatId) {
    try {
      const members = await getChatMembers({
        chatId: params.chatId,
        tokenProvider: params.tokenProvider,
        fetchFn: params.fetchFn,
      });

      if (members.length > 0) {
        scope = "users";
        recipientObjectIds = members.map((m) => m.aadObjectId);
      }
    } catch {
      // Fall back to organization scope if we can't get chat members
      // (e.g., missing Chat.Read.All permission)
    }
  }

  // 3. Create sharing link
  const shareLink = await createSharePointSharingLink({
    siteId: params.siteId,
    itemId: uploaded.id,
    tokenProvider: params.tokenProvider,
    scope,
    recipientObjectIds,
    fetchFn: params.fetchFn,
  });

  return {
    itemId: uploaded.id,
    webUrl: uploaded.webUrl,
    shareUrl: shareLink.webUrl,
    name: uploaded.name,
  };
}
